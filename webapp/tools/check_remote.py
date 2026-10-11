r"""HPC connection (backend/app/remote.py) against a local test SFTP server: host-key confirmation, wrong password,
browsing, OVITO results over SSH identical to the same files read locally (with displacements, live frames, ductile/brittle
indicators, a multi-frame file), and nothing from the cluster written to this computer's disk (frames stream into memory).

    .venv\Scripts\python webapp\tools\check_remote.py

The test server (paramiko, read-only, user 'tester') serves examples/ on 127.0.0.1; a temporary known_hosts is used.
"""
import json
import os
import shutil
import socket
import sys
import threading

import paramiko

HOST_KEY = paramiko.RSAKey.generate(2048)
ROOT = None


class Server(paramiko.ServerInterface):
    def check_auth_password(self, username, password):
        return paramiko.AUTH_SUCCESSFUL if (username, password) == ("tester", "pw-test") else paramiko.AUTH_FAILED

    def get_allowed_auths(self, username):
        return "password"

    def check_channel_request(self, kind, chanid):
        return paramiko.OPEN_SUCCEEDED if kind == "session" else paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED


class Handle(paramiko.SFTPHandle):
    def stat(self):
        return paramiko.SFTPAttributes.from_stat(os.fstat(self.readfile.fileno()))


class SFTP(paramiko.SFTPServerInterface):
    def _real(self, path):
        p = os.path.normpath(os.path.join(ROOT, path.lstrip("/")))
        return p if p.startswith(ROOT) else ROOT

    def canonicalize(self, path):
        rel = os.path.relpath(self._real(path), ROOT).replace("\\", "/")
        return "/" + ("" if rel == "." else rel)

    def list_folder(self, path):
        out = []
        for n in os.listdir(self._real(path)):
            a = paramiko.SFTPAttributes.from_stat(os.stat(os.path.join(self._real(path), n)))
            a.filename = n
            out.append(a)
        return out

    def stat(self, path):
        return paramiko.SFTPAttributes.from_stat(os.stat(self._real(path)))

    lstat = stat

    def open(self, path, flags, attr):
        if flags & (os.O_WRONLY | os.O_RDWR):
            return paramiko.SFTP_PERMISSION_DENIED
        h = Handle(flags)
        h.readfile = open(self._real(path), "rb")
        h.filename = self._real(path)
        return h


def serve(conn):
    t = paramiko.Transport(conn)
    t.add_server_key(HOST_KEY)
    t.set_subsystem_handler("sftp", paramiko.SFTPServer, SFTP)
    t.start_server(server=Server())
    while t.is_active():
        t.join(1)



def run_server(root):
    global ROOT
    ROOT = os.path.abspath(root)
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    s.listen(10)

    def loop():
        while True:
            c, _ = s.accept()
            threading.Thread(target=serve, args=(c,), daemon=True).start()
    threading.Thread(target=loop, daemon=True).start()
    return s.getsockname()[1]


def main():
    import tempfile
    import time
    from pathlib import Path
    here = Path(__file__).resolve().parents[2]
    sys.path.insert(0, str(here))
    from fastapi.testclient import TestClient
    from webapp.backend.app import remote
    from webapp.backend.app.main import app
    remote.KNOWN = Path(tempfile.mkdtemp()) / "known_hosts"
    served = Path(tempfile.mkdtemp(prefix="nanocut_sftp_"))       # the "cluster": sample frames + one multi-frame file
    shutil.copytree(here / "examples" / "sample_run", served / "sample_run")
    (served / "multi").mkdir()
    seq = sorted((served / "sample_run").glob("*_cut.*.lammpstrj"), key=lambda f: int(f.name.split(".")[-2]))
    with open(served / "multi" / "all.lammpstrj", "wb") as out:
        for f in seq:
            out.write(f.read_bytes())
    tmp_before = {str(f) for f in Path(tempfile.gettempdir()).rglob("*.lammpstrj")}
    port = run_server(served)
    c, fails = TestClient(app), []

    def check(name, ok, info=""):
        print(("PASS " if ok else "FAIL ") + name + (f"  [{info}]" if info else ""), flush=True)
        if not ok:
            fails.append(name)

    def job(url, data):
        j = c.post(url, json=data).json()
        while j.get("status") in ("queued", "running"):
            time.sleep(0.3)
            j = c.get(f"/api/jobs/{j['id']}").json()
        return j.get("result") if j.get("status") == "done" else j
    cred = {"host": "127.0.0.1", "port": port, "username": "tester", "password": "pw-test"}
    r = c.post("/api/remote/connect", json=cred)
    fp = (r.json().get("detail") or {}).get("fingerprint")
    check("unknown host key refused until confirmed", r.status_code == 409 and fp and fp.startswith("SHA256:"), fp)
    r = c.post("/api/remote/connect", json=dict(cred, password="wrong", trust_fingerprint=fp))
    check("wrong password refused", r.status_code == 401, r.json().get("detail"))
    r = c.post("/api/remote/connect", json=dict(cred, trust_fingerprint=fp))
    sid = r.json().get("id")
    check("connect with confirmed key", r.status_code == 200 and sid)
    L = c.get(f"/api/remote/{sid}/list", params={"path": "/sample_run"}).json()
    check("browse: dump sequence found", [(q["pattern"], q["count"]) for q in L.get("sequences", [])] == [("cut_SiC_R10_d10_preview_cut.*.lammpstrj", 3)])
    rsrc = {"remote": sid, "dir": "/sample_run", "pattern": "cut_SiC_R10_d10_preview_cut.*.lammpstrj"}
    lsrc = {"path": "examples/sample_run", "pattern": "cut_SiC_R10_d10_preview_cut.*.lammpstrj"}
    mods = [{"type": "displacements", "reference_frame": 0, "minimum_image": True, "enabled": True}]
    res = [job("/api/ovito/frames", {"spec": {"source": s, "frame": 0, "types": {}, "cell": False, "modifiers": mods}, "frames": [0, 1, 2],
                                     "stats": True, "apply_pipeline": True}) for s in (rsrc, lsrc)]
    same = all(a["stats"] == b["stats"] and a["force"] == b["force"] for a, b in zip(res[0]["rows"], res[1]["rows"]))
    check("OVITO over SSH = OVITO on the local files (3 frames, displacements)", same)
    # live frame and ductile/brittle indicators over SSH = local
    def live(src):
        b = c.post("/api/ovito/live", json={"spec": {"source": src, "frame": 2, "types": {}, "cell": False, "modifiers": mods}}).content
        n = int.from_bytes(b[:4], "little")
        return b[4 + n:], json.loads(b[4:4 + n])["stats"]
    (rb, rs), (lb, ls) = live(rsrc), live(lsrc)
    check("live 3D frame over SSH = local (positions, colours, radii, statistics)", rb == lb and rs == ls, f"{len(rb)} bytes")
    reg = [job("/api/ovito/regime", {"spec": {"source": s, "frame": 0, "types": {}, "cell": False, "modifiers": []}, "frames": [0, 2],
                                     "params": {"tool_types": [1]}})["rows"] for s in (rsrc, lsrc)]
    check("ductile/brittle indicators over SSH = local", reg[0] == reg[1])
    msrc = {"remote": sid, "dir": "/multi", "pattern": "all.lammpstrj"}
    mres = job("/api/ovito/frames", {"spec": {"source": msrc, "frame": 0, "types": {}, "cell": False, "modifiers": []}, "frames": [0, 1, 2], "stats": True})
    lres = job("/api/ovito/frames", {"spec": {"source": lsrc, "frame": 0, "types": {}, "cell": False, "modifiers": []}, "frames": [0, 1, 2], "stats": True})
    check("one multi-frame file over SSH: frames found by streaming, statistics = local",
          [r["timestep"] for r in mres["rows"]] == [100, 1300, 2500] and all(a["stats"] == b["stats"] for a, b in zip(mres["rows"], lres["rows"])))
    # zero storage: no dump data anywhere on this computer's disk from the HPC session
    written = [str(f) for f in (remote.MIRROR / sid).rglob("*") if f.is_file()] if (remote.MIRROR / sid).exists() else []
    new_dumps = [f for f in (str(x) for x in Path(tempfile.gettempdir()).rglob("*.lammpstrj")) if f not in tmp_before and "nanocut_sftp_" not in f]
    check("nothing from the cluster written to this computer's disk", not written and not new_dumps, f"{len(written)} cache files, {len(new_dumps)} new dumps")
    c.post(f"/api/remote/{sid}/disconnect")
    shutil.rmtree(served, ignore_errors=True)
    print("\n" + ("ALL CHECKS PASSED" if not fails else f"{len(fails)} FAILED: {fails}"))
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
