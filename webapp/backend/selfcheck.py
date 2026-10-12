"""Self-check of the API against the real project data (read-only). Run from the project root:

    .venv\\Scripts\\python webapp\\backend\\selfcheck.py
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
from fastapi.testclient import TestClient

from webapp.backend.app.main import app

c = TestClient(app)
fails = []


def check(name, cond, info=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{info}]" if info else ""), flush=True)
    if not cond:
        fails.append(name)


def wait(url, method="get", timeout=300, **kw):
    t0 = time.time()
    while True:
        r = getattr(c, method)(url, **kw)
        method = "get" if method == "post" and r.status_code == 202 and "/jobs/" not in url else method
        if r.status_code != 202:
            body = r.json() if "json" in r.headers.get("content-type", "") else None
            return body if isinstance(body, dict) and "id" in body and "status" in body else r   # job finished inline
        jid = r.json()["id"]
        while time.time() - t0 < timeout:
            j = c.get(f"/api/jobs/{jid}").json()
            if j["status"] in ("done", "error"):
                return j
            time.sleep(0.5)
        raise TimeoutError(url)


h = c.get("/api/health").json()
check("health", h["status"] == "ok", f"api {h['api_version']}, nanocut {h['nanocut_version']}, refs found {h['reference_root_found']}")

sims = c.get("/api/simulations").json()["simulations"]
kinds = {k: sum(s["kind"] == k for s in sims) for k in ("run", "reference", "preset")}
check("catalog lists runs, references and presets", all(kinds.values()), str(kinds))
ex = next(s for s in sims if s["id"] == "example-sample-run")
check("sample run has 3 frames and a force series", ex["n_frames"] == 3 and ex["has_series"])

ov = c.get("/api/simulations/example-sample-run").json()
check("overview: model from params.json", ov["model"]["counts"]["total"] == 97815, str(ov["model"]["counts"]["total"]))
check("overview: trajectory header", ov["trajectory"]["natoms"] == 97815 and "f_keav" in ov["trajectory"]["columns"])

pr = c.get("/api/simulations/example-sample-run/parameters").json()
prov = pr["counts"]
check("parameters have all provenance kinds", {"file", "computed", "editable"} <= set(prov), str(prov))
ts = [p for g in pr["groups"] for p in g["params"] if p["key"] == "timestep_B"]
check("timestep of deck B read with source line", ts and ts[0]["value"] == "0.0005" and ts[0]["source"]["line"] > 0,
      str(ts[0]["source"]) if ts else "missing")

ref = next(s for s in sims if s["id"] == "ref-10-10")
rp = c.get("/api/simulations/ref-10-10/parameters").json()
conv = {p["key"]: p["value"] for g in rp["groups"] for p in g["params"] if p["category"] == "Converted from lattice units"}
check("reference deck converted from lattice units", abs(conv.get("depth", 0) - 1.31001) < 1e-4 and conv.get("cut_steps") == 300000, str(conv.get("depth")))
miss = [p["key"] for g in rp["groups"] for p in g["params"] if p["provenance"] == "missing"]
check("reference deck: missing force output flagged", "forces_out" in miss, str(miss))

fr = c.get("/api/simulations/example-sample-run/frames/2?props=temperature,mol,von_mises,coordination&max_atoms=20000").json()
check("frame payload", fr["natoms"] == 97815 and 0 < fr["shown"] <= 20000 and len(fr["x"]) == fr["shown"]
      and set(fr["props"]) >= {"type", "mol", "temperature", "von_mises", "coordination"}, f"shown {fr['shown']} step {fr['step']}")
fr0 = c.get("/api/simulations/example-sample-run/frames/0?props=mol&max_atoms=20000").json()
check("same atoms in every frame (deterministic subsample)", fr0["id"] == fr["id"])
check("frame 404 beyond range", c.get("/api/simulations/example-sample-run/frames/99").status_code == 404)

se = c.get("/api/simulations/example-sample-run/series").json()
check("force series", se["available"] and "Fc_nN" in se["series"] and len(se["cut_distance_nm"]) == len(se["step"]),
      f"{len(se['step'])} rows, mu={se.get('summary', {}).get('friction_coefficient')}")

mj = wait("/api/simulations/example-sample-run/metrics", method="post")
check("per-frame metrics job", mj["status"] == "done" and len(mj["result"]["rows"]) == 3, mj.get("error") or "")

ij = wait("/api/simulations/example-sample-run/initial?max_atoms=20000")
check("initial configuration job", ij["status"] == "done" and ij["result"]["natoms"] > 90000, ij.get("error") or "")
check("old-geometry run flagged in the recomputed preview", ij["result"]["consistency"]["matches"] is False,
      str(ij["result"]["consistency"]["stored_total"]) + " vs " + str(ij["result"]["consistency"]["computed_total"]))

sj = wait("/api/simulations/example-sample-run/schematic?frames=6&max_atoms=3000")
check("schematic job", sj["status"] == "done" and len(sj["result"]["frames"]) == 7, sj.get("error") or "")

dj = wait("/api/decks", method="post", json={"base": "example-sample-run", "overrides": {"process.speed_ms": 100}})
check("deck generation with override", dj["status"] == "done" and "move linear -1.000000" in dj["result"]["B"], dj.get("error") or "")
check("deck override rejects unknown key", c.post("/api/decks", json={"base": "example-sample-run", "overrides": {"process.bogus": 1}}).status_code == 422)

t = c.get("/api/files/text", params={"path": "examples/sample_run/B.in"}).json()
check("source viewer", t["lines"][0].startswith("#"), f"{len(t['lines'])} lines")
check("source viewer refuses paths outside project", c.get("/api/files/text", params={"path": "C:/Windows/win.ini"}).status_code == 403)
check("source viewer refuses hidden folders", c.get("/api/files/text", params={"path": ".venv/pyvenv.cfg"}).status_code == 403)
check("dumps are never sent as text", c.get("/api/files/text", params={"path": "examples/sample_run/cut_SiC_R10_d10_preview_cut.100.lammpstrj"}).status_code == 415)
check("image served", c.get("/api/files/raw", params={"path": "examples/sample_run/sample_forces.png"}).status_code == 200)

tr = c.get("/api/tree?depth=2").json()
check("project tree", tr["type"] == "dir" and any(ch["name"] == "nanocut" for ch in tr["children"]))

vj = wait("/api/validation", timeout=900)
res = vj["result"] if vj.get("status") == "done" else {}
check("validation of all simulations", vj.get("status") == "done" and len(res.get("simulations", [])) == len(sims),
      f"{len(res.get('simulations', []))} validated, global {[g['status'] for g in res.get('global_checks', [])]}")
r1010 = next((v for v in res.get("simulations", []) if v["id"] == "ref-10-10"), None)
if r1010:
    names = {x["name"]: x["status"] for x in r1010["scientific"]}
    check("reference 10-10: potential A vs B flagged", names.get("same potential in A and B") == "warn", str(names))

# ---------------------------------------------------------------- full deck editor
opt = c.get("/api/deck-options").json()
check("deck editor options: every material, potential and Morse set", len(opt["materials"]) == 11 and len(opt["potentials"]) == 21 and len(opt["morse"]) == 4)
e = opt["defaults"]
e["workpiece"].update(material="Cu", a0=3.615, boundary_z="s", width_nm=2.0)
e["potential"].update(key="Cu_mishin1.eam.alloy", cross_style="morse")
e["thermo"].update(cut_dt_fs=1.0, equil_dt_fs=1.0)
e["process"].update(cut_length_nm=1.0)
e["laser"].update(mode="spot")
ck = c.post("/api/decks/check", json={"experiment": e}).json()
check("deck editor live check", ck["errors"] == [] and ck["cut_steps"] == 5000, str(ck))
dj2 = wait("/api/decks", "post", json={"experiment": e})
dB = dj2.get("result", {}).get("B", "") if isinstance(dj2, dict) else ""
check("deck from a full edited parameter set", "boundary        s s s" in dB and "morse 0.087 5.14 2.05" in dB and "langevin 1200" in dB and "timestep        0.001" in dB,
      dj2.get("error") if isinstance(dj2, dict) else "")
check("deck editor rejects invalid values", c.post("/api/decks/check", json={"experiment": dict(e, process=dict(e["process"], depth_nm=-1))}).json()["errors"] == ["depth of cut must be > 0"])

# ---------------------------------------------------------------- studio (any dump folder / file)
import shutil
import tempfile

import numpy as np
import pandas as pd


def job_result(r):
    return r.json()["result"] if hasattr(r, "json") else r.get("result", r)


sc = c.get("/api/studio/scan", params={"path": "examples/sample_run"}).json()
check("studio scan finds the dump sequence", len(sc["sequences"]) == 1 and sc["sequences"][0]["count"] == 3
      and sc["sequences"][0]["pattern"] == "cut_SiC_R10_d10_preview_cut.*.lammpstrj", str(sc["sequences"]))
check("studio scan refuses a non-dump file", c.get("/api/studio/scan", params={"path": "examples/sample_run/A.in"}).status_code == 422)
check("studio scan 404 for a missing path", c.get("/api/studio/scan", params={"path": "examples/no_such_folder"}).status_code == 404)
seq = sc["sequences"][0]
src = job_result(wait("/api/studio/open", "post", json={"path": seq["dir"], "pattern": seq["pattern"]}))
check("studio open: frames ordered by step", src["n_frames"] == 3 and src["steps"] == [100, 1300, 2500], str(src.get("steps")))
sid = src["id"]
meta = job_result(wait(f"/api/studio/sources/{sid}/frames/2/load?ref=0", "post"))
check("studio frame load with displacement reference", meta["natoms"] == 97815 and meta["step"] == 2500 and "displacement" in meta["columns"]
      and meta["reference"]["missing"] == 0, str(meta.get("reference")))
raw = c.get(f"/api/studio/sources/{sid}/frames/2/data", params={"cols": "id,x,dz", "ref": 0})
n = meta["natoms"]
ids = np.frombuffer(raw.content[:4 * n], "<u4")
check("studio binary columns: size and id order", len(raw.content) == 12 * n and np.all(np.diff(ids.astype(np.int64)) > 0), f"{len(raw.content)} bytes")
names = meta["dump_columns"]
a = pd.read_csv("examples/sample_run/cut_SiC_R10_d10_preview_cut.100.lammpstrj", sep=r"\s+", skiprows=9, header=None, names=names).set_index("id").sort_index()
b = pd.read_csv("examples/sample_run/cut_SiC_R10_d10_preview_cut.2500.lammpstrj", sep=r"\s+", skiprows=9, header=None, names=names).set_index("id").sort_index()
Lz = meta["cell"]["c"][2]
dz = (b.z - a.z).to_numpy().copy()
dz -= Lz * np.round(dz / Lz)                                        # z periodic: minimum image
got = np.frombuffer(raw.content[8 * n:], "<f4")
xs = np.frombuffer(raw.content[4 * n:8 * n], "<f4")
check("studio displacement equals independent calculation", np.nanmax(np.abs(got - dz)) < 1e-3 and np.allclose(xs, b.x.to_numpy(), atol=1e-3),
      f"max |diff| {np.nanmax(np.abs(got - dz)):.2e} Å")
check("studio data refuses a frame that is not loaded", c.get(f"/api/studio/sources/{sid}/frames/1/data", params={"cols": "x"}).status_code == 409)
row = c.get(f"/api/studio/sources/{sid}/frames/2/atom/0", params={"ref": 0}).json()
check("studio picked-atom row", row["id"] == int(ids[0]) and abs(row["x"] - float(b.x.iloc[0])) < 1e-3 and "displacement" in row)
tmp = tempfile.mkdtemp(prefix="nanocut_selfcheck_")
try:
    multi = os.path.join(tmp, "all.lammpstrj")
    with open(multi, "wb") as out:
        for f in ("cut_SiC_R10_d10_preview_cut.100.lammpstrj", "cut_SiC_R10_d10_preview_cut.1300.lammpstrj"):
            with open(os.path.join("examples", "sample_run", f), "rb") as inp:
                shutil.copyfileobj(inp, out)
    ms = job_result(wait("/api/studio/open", "post", json={"path": multi}))
    m1 = job_result(wait(f"/api/studio/sources/{ms['id']}/frames/1/load", "post"))
    check("studio multi-frame file indexed", ms["n_frames"] == 2 and ms["steps"] == [100, 1300] and m1["step"] == 1300 and m1["natoms"] == 97815,
          str(ms.get("steps")))
finally:
    shutil.rmtree(tmp, ignore_errors=True)

# ---------------------------------------------------------------- OVITO page (official OVITO Python module)
ost = c.get("/api/ovito/status").json()
check("OVITO module available", ost.get("available") is True, ost.get("ovito") or ost.get("error", ""))
if ost.get("available"):
    osrc = {"path": "examples/sample_run", "pattern": "cut_SiC_R10_d10_preview_cut.*.lammpstrj"}
    ospec = {"source": osrc, "frame": 2, "modifiers": [{"type": "select_type", "types": [1]}, {"type": "delete_selected"},
             {"type": "displacements", "reference_frame": 0}, {"type": "expression_selection", "expression": "Position.Y > 179.089"},
             {"type": "color_coding", "property": "Displacement.Y", "gradient": "Rainbow"}],
             "view": {"type": "Top"}, "render": {"w": 320, "h": 200}, "overlays": {"legend": {"enabled": True}}}
    orr = job_result(wait("/api/ovito/render", "post", json={"spec": ospec}))
    oa = orr.get("attributes", {})
    check("OVITO render: image and attributes", orr.get("bytes", 0) > 1000 and c.get(orr.get('url', '/none')).status_code == 200
          and oa.get("SelectType.num_selected") == 43363, str({k: oa.get(k) for k in ("Timestep", "SelectType.num_selected")}))
    check("OVITO agrees with NanoCut: dy range and burr count", abs(oa.get("ColorCoding.RangeMin", 0) + 2.905) < 1e-3 and abs(oa.get("ColorCoding.RangeMax", 0) - 0.643) < 1e-3
          and oa.get("ExpressionSelection.count") == 1, str({k: oa.get(k) for k in ("ColorCoding.RangeMin", "ColorCoding.RangeMax", "ExpressionSelection.count")}))
    ov = job_result(wait("/api/ovito/verify", "post", json=dict(osrc, frame=2, reference=0)))
    check("OVITO vs NanoCut parser: ids, positions, displacements", ov.get("same_atom_ids") and max(ov.get(f"max_diff_{k}_A", 1) for k in ("dx", "dy", "dz")) < 1e-3
          and max(ov.get(f"max_diff_position_{k}_A", 1) for k in "xyz") < 1e-3, f"max |d disp| {max(ov.get(f'max_diff_{k}_A', 1) for k in ('dx', 'dy', 'dz')):.1e} Å")
    check("OVITO script: user text stays a string literal", "expression=\"'); import os #\"" in c.post("/api/ovito/script", json={"spec": dict(ospec, modifiers=[
          {"type": "expression_selection", "expression": "'); import os #"}])}).json()["script"])
    check("OVITO file endpoint refuses other paths", c.get("/api/ovito/file/..%2F..%2Fsettings.py").status_code == 404)
    # live 3D viewport: OVITO's particles after the pipeline, as binary; selected particles in OVITO's selection colour
    lspec = {"source": osrc, "frame": 2, "types": {}, "cell": False, "modifiers": [{"type": "select_type", "types": [1], "enabled": True}]}
    resp = c.post("/api/ovito/live", json={"spec": lspec}).content          # uint32 header length, JSON header, binary
    hl = int.from_bytes(resp[:4], "little")
    lv, raw = json.loads(resp[4:4 + hl]), resp[4 + hl:]
    n = lv.get("layout", {}).get("n", 0)
    col = np.frombuffer(raw, np.uint8, n * 3, n * 12).reshape(-1, 3) if n else np.zeros((0, 3), np.uint8)
    pos = np.frombuffer(raw, np.float32, n * 3).reshape(-1, 3) if n else col
    ost3 = lv.get("stats", {})
    check("OVITO live frame: particles, positions, binary layout", n == 97815 and len(raw) == n * 12 + n * 3 + (-n * 3) % 4 + n * 4
          and abs(float(pos[:, 1].max()) - ost3.get("Position.Y", [0, 0])[1]) < 1e-3, f"{n} particles, {len(raw)} bytes")
    # frame export: the CSV is the dump, column by column; force averages and per-type sums equal pandas on the dump
    import io as _io
    import zipfile as _zf
    fx = job_result(wait("/api/ovito/frames", "post", json={"spec": dict(lspec, frame=0, modifiers=[]), "frames": [2, 2, 0], "csv": True, "stats": True}))
    z = _zf.ZipFile(_io.BytesIO(c.get(f"/api/ovito/file/{fx.get('zip')}").content))
    dpath = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "examples", "sample_run", "cut_SiC_R10_d10_preview_cut.2500.lammpstrj")
    with open(dpath) as fh:
        head = [next(fh) for _ in range(9)]
    dcols = head[8].split()[2:]
    dump = pd.read_csv(dpath, sep=r"\s+", skiprows=9, header=None, names=dcols)
    csv2 = pd.read_csv(z.open("frame_2.csv"))
    r2 = next(r for r in fx.get("rows", []) if r["frame"] == 2)
    F = dump[["fx", "fy", "fz"]].to_numpy()
    tool = dump[dump["type"] == 1][["fx", "fy", "fz"]].sum().to_numpy()
    check("frame export: CSV equals the dump, frames sorted and unique", [r["frame"] for r in fx.get("rows", [])] == [0, 2] and sorted(z.namelist()) == ["frame_0.csv", "frame_2.csv"]
          and list(csv2.columns) == dcols and all(np.array_equal(csv2[k].to_numpy(float), dump[k].to_numpy(float)) for k in dcols), f"{len(dcols)} columns x {len(dump)} rows")
    check("frame export: force averages and tool force sum equal pandas", abs(r2["force"]["mean_magnitude"] - np.sqrt((F ** 2).sum(1)).mean()) < 1e-9
          and abs(r2["force"]["mean_fx"] - F[:, 0].mean()) < 1e-12 and np.allclose([r2["force_by_type"]["1"][k] for k in ("sum_fx", "sum_fy", "sum_fz")], tool, rtol=1e-12),
          f"tool sum F = {np.round(tool, 4)}")
    xl = c.post("/api/ovito/frames/xlsx", json={"rows": fx["rows"], "meta": fx["meta"], "columns": ["c_pe", "fx"], "stats": ["mean"]})
    check("frame statistics Excel workbook", xl.status_code == 200 and xl.content[:2] == b"PK", f"{len(xl.content)} bytes")
    # one file picked -> its numbered series (like OVITO); pile-up height = highest workpiece atom above the frame-0 surface
    sq = c.get("/api/studio/scan", params={"path": "examples/sample_run/cut_SiC_R10_d10_preview_cut.2500.lammpstrj"}).json()["sequences"]
    check("last file of a series opens the whole series", sq[0]["pattern"] == "cut_SiC_R10_d10_preview_cut.*.lammpstrj" and sq[0]["count"] == 3 and sq[1]["count"] == 1)
    pu = job_result(wait("/api/ovito/pileup", "post", json={"spec": dict(lspec, frame=0, modifiers=[]), "frames": [2], "params": {"tool_types": [1]}}))["rows"][0]
    w0 = pd.read_csv(dpath.replace("2500", "100"), sep=r"\s+", skiprows=9, header=None, names=dcols)
    w0 = w0[w0["type"] != 1]
    ysurf = float(np.median(w0.groupby(np.floor(w0.x / 10).astype(int) * 1_000_003 + np.floor(w0.z / 10).astype(int)).y.max()))
    w2 = dump[dump["type"] != 1]
    check("pile-up height equals pandas", abs(pu["surface_y"] - ysurf) < 1e-9 and abs(pu["highest"]["height"] - (w2.y.max() - ysurf)) < 1e-9,
          f"H = {pu['highest']['height']:.4f} Å")
    check("OVITO live colours: 43,363 selected (tool) drawn in OVITO's selection colour", int((col == [255, 0, 0]).all(1).sum()) == 43363,
          f"{int((col == [255, 0, 0]).all(1).sum())} red")

print("\n" + ("ALL CHECKS PASSED" if not fails else f"{len(fails)} FAILED: {fails}"))
sys.exit(1 if fails else 0)
