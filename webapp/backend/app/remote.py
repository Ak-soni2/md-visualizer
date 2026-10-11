"""SSH/SFTP connection to an HPC cluster, so the OVITO page reads dumps that stay on the cluster.

The password (or private key) is used once to open the SSH connection and is never stored or logged; the open
connection lives in this process until it is closed or the backend stops. Unknown host keys are refused until the user
confirms the fingerprint (trust on first use, kept in ~/.nanocut/known_hosts; the user's own ~/.ssh/known_hosts is
read, never written).

Frames are fetched on demand: a local mirror folder holds an empty placeholder for every remote file of the
trajectory (OVITO only needs the names to number the frames) and the files of the frames being computed; older
frames are emptied again, so at most NANOCUT_REMOTE_CACHE frames (default 4, plus frame 0) occupy local disk.
Only for a local backend: a hosted backend refuses these routes (credentials would leave this computer).
"""
import base64
import hashlib
import os
import re
import shutil
import stat
import tempfile
import threading
import time
import uuid
from pathlib import Path, PurePosixPath

from fastapi import APIRouter, Body, HTTPException

from . import studio

router = APIRouter(prefix="/api/remote", tags=["remote"])
MIRROR = Path(tempfile.gettempdir()) / "nanocut_ovito" / "remote"
KNOWN = Path.home() / ".nanocut" / "known_hosts"
CACHE_FRAMES = int(os.environ.get("NANOCUT_REMOTE_CACHE", "4"))
_sessions = {}                                   # id -> session dict (no credentials)


def _local_only():
    if os.environ.get("VERCEL"):
        raise HTTPException(403, "HPC connections work only with a local backend (webapp\\run_web.bat): the password would otherwise be sent to a hosted server")


def fingerprint(key):
    return "SHA256:" + base64.b64encode(hashlib.sha256(key.asbytes()).digest()).decode().rstrip("=")


def _host_keys():
    import paramiko
    hk = paramiko.HostKeys()
    for f in (Path.home() / ".ssh" / "known_hosts", KNOWN):
        if f.exists():
            try:
                hk.load(str(f))
            except Exception:
                pass
    return hk


def _pkey(text, passphrase=None):
    import io
    import paramiko
    for cls in (paramiko.Ed25519Key, paramiko.ECDSAKey, paramiko.RSAKey):
        try:
            return cls.from_private_key(io.StringIO(text), password=passphrase or None)
        except Exception:
            continue
    raise HTTPException(422, "private key not recognised (OpenSSH Ed25519, ECDSA or RSA)")


@router.post("/connect")
def connect(body: dict = Body(...)):
    """{host, port, username, password?, otp?, private_key?, passphrase?, trust_fingerprint?} -> session.
    409 with the fingerprint when the host key is unknown: confirm it with the cluster's documentation, then resend
    with trust_fingerprint."""
    _local_only()
    import paramiko
    host, user = str(body.get("host") or "").strip(), str(body.get("username") or "").strip()
    port = int(body.get("port") or 22)
    if not host or not user or not re.fullmatch(r"[\w.\-:\[\]]+", host):
        raise HTTPException(422, "host and username are required")
    password, otp = body.get("password") or None, body.get("otp") or None
    t = paramiko.Transport((host, port))
    try:
        t.start_client(timeout=20)
        key = t.get_remote_server_key()
        fp, name = fingerprint(key), host if port == 22 else f"[{host}]:{port}"
        known = _host_keys().lookup(name)
        if known and key.get_name() in known:
            if known[key.get_name()].asbytes() != key.asbytes():
                raise HTTPException(409, dict(error="host key CHANGED: refusing to connect (possible man-in-the-middle). Check with your HPC support.", fingerprint=fp, changed=True))
        elif body.get("trust_fingerprint") != fp:
            raise HTTPException(409, dict(error="unknown host key: confirm the fingerprint", fingerprint=fp, key_type=key.get_name(), host=name))
        else:
            KNOWN.parent.mkdir(parents=True, exist_ok=True)
            with open(KNOWN, "a") as f:
                f.write(f"{name} {key.get_name()} {key.get_base64()}\n")
        if body.get("private_key"):
            t.auth_publickey(user, _pkey(body["private_key"], body.get("passphrase")))
        else:
            try:
                t.auth_password(user, password or "")
            except (paramiko.BadAuthenticationType, paramiko.AuthenticationException) as first:
                def answer(title, instructions, prompts):     # keyboard-interactive: password and one-time code
                    return [otp or "" if re.search(r"otp|code|token|verif|pin|duo|2fa|factor", p, re.I) else password or "" for p, _ in prompts]
                try:
                    t.auth_interactive(user, answer)
                except paramiko.BadAuthenticationType:       # the server offers no keyboard-interactive login
                    raise HTTPException(401, "authentication failed: wrong username or password" if isinstance(first, paramiko.AuthenticationException)
                                        and not isinstance(first, paramiko.BadAuthenticationType) else f"authentication failed: {first}")
        if not t.is_authenticated():
            raise HTTPException(401, "authentication failed")
        t.set_keepalive(30)
        sftp = paramiko.SFTPClient.from_transport(t)
    except HTTPException:
        t.close()
        raise
    except paramiko.AuthenticationException as e:
        t.close()
        raise HTTPException(401, f"authentication failed: {e}")
    except Exception as e:
        t.close()
        raise HTTPException(502, f"could not connect to {host}:{port}: {e}")
    sid = uuid.uuid4().hex[:16]
    _sessions[sid] = dict(id=sid, host=host, port=port, user=user, fingerprint=fp, transport=t, sftp=sftp, lock=threading.RLock(),
                          home=sftp.normalize("."), created=time.time(), listings={}, used={})
    return public(_sessions[sid])


def public(s):
    return {k: s[k] for k in ("id", "host", "port", "user", "fingerprint", "home", "created")} | dict(alive=s["transport"].is_active())


def get(sid):
    s = _sessions.get(str(sid))
    if not s or not s["transport"].is_active():
        raise HTTPException(404, "HPC connection closed; connect again")
    return s


@router.get("/sessions")
def sessions():
    return [public(s) for s in _sessions.values() if s["transport"].is_active()]


@router.post("/{sid}/disconnect")
def disconnect(sid: str):
    s = _sessions.pop(sid, None)
    if s:
        s["transport"].close()
        shutil.rmtree(MIRROR / sid, ignore_errors=True)
    return dict(closed=bool(s))


def _sequences(s, path, names_sizes):
    """Dump sequences in one remote folder, grouped like studio.scan (by name; content checked on the first file)."""
    groups = {}
    for name, size in names_sizes:
        if not studio._candidate(name):
            continue
        m = studio.NUM_RE.match(name)
        groups.setdefault(f"{m.group(1)}*{m.group(3)}" if m else name, []).append((int(m.group(2)) if m else 0, name, size))
    out = []
    for pattern, items in groups.items():
        items.sort()
        try:
            with s["sftp"].open(str(PurePosixPath(path) / items[0][1]), "rb") as f:
                head = f.read(64)
            if not (head[:2] == b"\x1f\x8b" or head.lstrip().startswith(b"ITEM: TIMESTEP")):   # text dump or gzip
                continue
        except OSError:
            continue
        out.append(dict(dir=path, pattern=pattern if len(items) > 1 else items[0][1], count=len(items), bytes=sum(i[2] for i in items),
                        first=items[0][1], last=items[-1][1], single=len(items) == 1))
    return sorted(out, key=lambda q: (-q["count"], q["pattern"]))


@router.get("/{sid}/list")
def listing(sid: str, path: str = None):
    """Folders and files of a remote folder, and the LAMMPS dump sequences in it."""
    _local_only()
    s = get(sid)
    with s["lock"]:
        try:
            p = s["sftp"].normalize(path or s["home"])
            attrs = s["sftp"].listdir_attr(p)
        except (OSError, IOError) as e:
            raise HTTPException(404, f"{path}: {e}")
        entries = sorted(({"name": a.filename, "dir": stat.S_ISDIR(a.st_mode or 0), "size": a.st_size, "mtime": a.st_mtime}
                          for a in attrs if not a.filename.startswith(".")), key=lambda e: (not e["dir"], e["name"]))
        seqs = _sequences(s, p, [(e["name"], e["size"] or 0) for e in entries if not e["dir"]])
    return dict(path=p, parent=str(PurePosixPath(p).parent), entries=entries[:5000], sequences=seqs)


# ------------------------------------------------------------------------------------------------ mirror for OVITO
def _files(s, rdir, pattern):
    """Remote files of the sequence in frame order (number in the name, as OVITO sorts a wildcard sequence)."""
    key = (rdir, pattern)
    hit = s["listings"].get(key)
    if hit and time.time() - hit[0] < 30:
        return hit[1]
    with s["lock"]:
        names = s["sftp"].listdir_attr(rdir)
    if "*" in pattern:
        rx = re.compile("^" + re.escape(pattern).replace(r"\*", r"(\d+)") + "$")
        found = sorted((int(m.group(1)), a.filename, a.st_size) for a in names if (m := rx.match(a.filename)))
    else:
        found = [(0, a.filename, a.st_size) for a in names if a.filename == pattern]
    if not found:
        raise HTTPException(404, f"no files match {pattern} in {rdir} on {s['host']}")
    files = [(n, size) for _, n, size in found]
    s["listings"][key] = (time.time(), files)
    return files


def mirror(source):
    """{remote, dir, pattern} -> local folder with a placeholder per remote file. Returns (folder, files)."""
    s = get(source["remote"])
    rdir, pattern = str(source.get("dir") or ""), str(source.get("pattern") or "")
    if not rdir or not pattern or "/" in pattern:
        raise HTTPException(422, "remote folder and file pattern required")
    files = _files(s, rdir, pattern)
    folder = MIRROR / s["id"] / hashlib.sha1(f"{rdir}|{pattern}".encode()).hexdigest()[:12]
    folder.mkdir(parents=True, exist_ok=True)
    for name, _ in files:
        p = folder / name
        if not p.exists():
            p.touch()
    return s, folder, files


def prepare(source, frames, progress=None):
    """Make sure the files of these frames (and frame 0, which OVITO reads when it opens the trajectory) are on local
    disk; empty the least recently used others beyond the cache size."""
    if not source or not source.get("remote"):
        return
    s, folder, files = mirror(source)
    need = sorted({0, *[int(f) for f in frames if f is not None]} & set(range(len(files)))) if len(files) > 1 else [0]
    used = s["used"]
    for k, f in enumerate(need):
        name, size = files[f]
        local = folder / name
        used[str(local)] = time.time()
        if local.stat().st_size == size and size:
            continue
        tmp = local.with_suffix(local.suffix + ".part")
        t0 = time.time()

        def cb(done, total, name=name):
            if progress:
                rate = done / max(1e-3, time.time() - t0)
                progress(min(0.95, 0.05 + 0.9 * (k + done / max(total, 1)) / len(need)), f"fetching {name} from {s['host']}: {done / 1e6:.0f}/{total / 1e6:.0f} MB, {rate / 1e6:.1f} MB/s")
        with s["lock"]:
            s["sftp"].get(f"{source['dir'].rstrip('/')}/{name}", str(tmp), callback=cb)
        os.replace(tmp, local)
    keep = {str(folder / files[f][0]) for f in need}
    cached = sorted((t, p) for p, t in used.items() if p not in keep and Path(p).exists() and Path(p).stat().st_size)
    for _, p in cached[:max(0, len(cached) - CACHE_FRAMES)]:
        open(p, "wb").close()                                     # back to an empty placeholder
        used.pop(p, None)


def label(source):
    s = get(source["remote"])
    return f"{s['user']}@{s['host']}:{source['dir'].rstrip('/')}/{source['pattern']}"
