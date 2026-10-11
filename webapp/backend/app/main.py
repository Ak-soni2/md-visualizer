"""NanoCut HTTP API (FastAPI). Run from the project root:

    .venv\\Scripts\\python -m uvicorn webapp.backend.app.main:app --port 8600

Read-only towards all existing data: the API never writes into the project, the run folders or the reference decks.
Deck generation returns text to the browser; nothing is written to disk.
"""
import hashlib
import json
import math
import os
import platform
import sys
import time
from pathlib import Path

import numpy as np
from fastapi import Body, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles

from . import __version__, advice, catalog, dumps, jobs, models, params, studio, validation
from .settings import (CORS_ORIGINS, DEFAULT_MAX_ATOMS, FRONTEND_DIR, IMAGE_SUFFIXES, MAX_TEXT_BYTES, PROJECT_ROOT,
                       REFERENCE_ROOT, TEXT_SUFFIXES, rel, safe_path)

import nanocut
from nanocut import analysis
from nanocut.presets import PRESETS
from nanocut.schema import Experiment, validate as schema_validate

app = FastAPI(title="NanoCut API", version=__version__,
              description="Read-only API over the NanoCut project: simulations, parameters, trajectories, analysis, validation.")
app.add_middleware(CORSMiddleware, allow_origins=CORS_ORIGINS, allow_methods=["GET", "POST"], allow_headers=["*"])
# frames are large JSON (~35 B per atom); compressed they also fit the 4.5 MB response limit of a Vercel function
app.add_middleware(GZipMiddleware, minimum_size=4096, compresslevel=5)
STARTED = time.time()


@app.middleware("http")
async def revalidate_frontend(request, call_next):
    """Frontend files must be revalidated (ETag) on every load, so an updated app is never mixed with cached modules."""
    resp = await call_next(request)
    if request.url.path.startswith("/app"):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


def _sim_or_404(sid):
    s = catalog.get(sid)
    if not s:
        raise HTTPException(404, f"unknown simulation '{sid}'")
    return s


def _abs(path):
    p = Path(path)
    return p if p.is_absolute() else PROJECT_ROOT / p


# ---------------------------------------------------------------------------------------------------- health
_lmp_cache = {"t": 0, "v": None}


def _lammps_available():
    if time.time() - _lmp_cache["t"] > 600:
        try:
            from nanocut import runner
            _lmp_cache.update(t=time.time(), v=bool(runner.available()))
        except Exception:
            _lmp_cache.update(t=time.time(), v=False)
    return _lmp_cache["v"]


@app.get("/api/health")
def health():
    return dict(status="ok", api_version=__version__, nanocut_version=nanocut.__version__, python=sys.version.split()[0],
                platform=platform.platform(terse=True), numpy=np.__version__, uptime_s=round(time.time() - STARTED, 1),
                project_root=str(PROJECT_ROOT), reference_root=str(REFERENCE_ROOT), reference_root_found=REFERENCE_ROOT.exists(),
                jobs_running=sum(1 for j in jobs._jobs.values() if j["status"] in ("queued", "running")))


@app.get("/api/health/lammps")
def health_lammps():
    """Slow (calls WSL); cached for 10 min. Only used by the optional validation/preview features."""
    return dict(lammps_runtime=_lammps_available())


# ---------------------------------------------------------------------------------------------------- catalog
@app.get("/api/simulations")
def simulations(refresh: bool = False):
    sims = catalog.scan(force=refresh)
    out = []
    for s in sims.values():
        out.append(dict(id=s["id"], kind=s["kind"], origin=s["origin"], label=s["label"], path=s.get("path"),
                        n_frames=s.get("n_frames", 0), has_series=s.get("has_series", False), n_files=len(s["files"]),
                        case=s.get("case"), preset=s.get("preset"), experiment_name=s.get("experiment_name"), note=s.get("note", "")))
    order = {"run": 0, "reference": 1, "preset": 2}
    out.sort(key=lambda x: (order[x["kind"]], -x["n_frames"], x["label"]))
    return dict(simulations=out, scanned=time.time())


@app.get("/api/presets")
def presets():
    return [dict(name=k, note=getattr(v, "__dict__", {}).get("note", "")) for k, v in PRESETS.items()]


def _trajectory(sim):
    if not sim.get("path") or sim["kind"] == "preset":
        return dict(frames=[], kind=None)
    dl, kind = dumps.list_dumps(str(_abs(sim["path"])))
    exp = catalog.experiment_dict(sim) if sim["kind"] == "run" else None
    dt = exp["thermo"]["cut_dt_fs"] * 1e-3 if exp else None
    v = exp["process"]["speed_ms"] * 0.01 if exp else None
    frames = []
    for i, (step, p) in enumerate(dl):
        fr = dict(index=i, step=step, bytes=os.path.getsize(p), file=os.path.basename(p))
        if dt:
            fr["time_ps"] = round(step * dt, 6)
            fr["cut_distance_A"] = round(step * dt * v, 4)
        frames.append(fr)
    out = dict(frames=frames, kind=kind, total_bytes=sum(f["bytes"] for f in frames))
    if dl:
        try:
            h = dumps.read_header(dl[0][1])
            out.update(natoms=h["natoms"], columns=h["columns"], boundary=h["boundary"],
                       available_properties=dumps.available_properties(h["columns"]))
        except Exception as e:
            out["header_error"] = str(e)
    return out


@app.get("/api/simulations/{sid}")
def simulation(sid: str):
    sim = _sim_or_404(sid)
    exp = catalog.experiment_dict(sim)
    model, rec = models.summary_for(sim)
    traj = _trajectory(sim)
    traj.pop("frames", None)
    warnings = advice.soft_warnings(exp, model) if exp and sim["kind"] != "reference" else []
    schema_errors = schema_validate(Experiment.from_dict(exp)) if exp and sim["kind"] != "reference" else []
    sources = {"experiment": "params.json" if sim["kind"] == "run" else ("nanocut/presets.py (matching preset)" if exp else None),
               "model": "params.json (written by NanoCut at generation)" if sim["kind"] == "run" else "computed by geometry.Model"}
    missing = []
    if sim["kind"] != "preset":
        roles = {f["role"] for f in sim["files"]}
        for r, msg in [("deck_A", "deck A"), ("deck_B", "deck B"), ("dump", "trajectory dumps"), ("forces", "force/temperature file"),
                       ("log", "LAMMPS log")]:
            if r not in roles:
                missing.append(msg)
    return dict(sim=sim, experiment=exp, model=model, model_job=jobs.public(rec, with_result=False), trajectory=traj,
                warnings=warnings, schema_errors=schema_errors, sources=sources, missing=missing)


@app.get("/api/simulations/{sid}/parameters")
def simulation_parameters(sid: str):
    sim = _sim_or_404(sid)
    exp = catalog.experiment_dict(sim)
    model, rec = models.summary_for(sim)
    out = params.inspect(sim, exp, model)
    out["model_job"] = jobs.public(rec, with_result=False)
    return out


@app.get("/api/simulations/{sid}/trajectory")
def simulation_trajectory(sid: str):
    return _trajectory(_sim_or_404(sid))


@app.get("/api/simulations/{sid}/frames/{index}")
def simulation_frame(sid: str, index: int, props: str = "temperature,mol", max_atoms: int = DEFAULT_MAX_ATOMS,
                     slab: str = Query(None, description="zmin,zmax in Å")):
    sim = _sim_or_404(sid)
    dl, _ = dumps.list_dumps(str(_abs(sim["path"]))) if sim.get("path") else ([], None)
    if not 0 <= index < len(dl):
        raise HTTPException(404, f"frame {index} not available ({len(dl)} frames)")
    exp = catalog.experiment_dict(sim) if sim["kind"] == "run" else None
    model, _ = models.summary_for(sim, start=False)
    types = model.get("types") if model else None
    sl = tuple(float(v) for v in slab.split(",")) if slab else None
    try:
        out = dumps.frame_payload(dl[index][1], [p for p in props.split(",") if p], types, dumps.atomic_volume(exp),
                                  max(1000, min(max_atoms, 400_000)), sl)
    except ValueError as e:
        raise HTTPException(422, str(e))
    out["index"] = index
    out["file"] = os.path.basename(dl[index][1])
    if exp:
        dt, v = exp["thermo"]["cut_dt_fs"] * 1e-3, exp["process"]["speed_ms"] * 0.01
        out["time_ps"] = out["step"] * dt
        out["cut_distance_A"] = out["step"] * dt * v
    if model:
        ov = dict(y_surface=model.get("y_surface_A"), types=model.get("types"))
        if exp and exp.get("laser", {}).get("mode") in ("spot", "power") and model.get("laser_center_A"):
            lx, ly = model["laser_center_A"]
            ov["laser"] = dict(x=lx - out.get("cut_distance_A", 0), y=ly, r=model.get("laser_radius_A"))
        out["overlays"] = ov
    return out


# ---------------------------------------------------------------------------------------------------- computed views (jobs)
def _job_response(rec):
    pub = jobs.public(rec)
    return JSONResponse(pub, status_code=200 if rec["status"] == "done" else 202)


def _initial_job(exp, max_atoms, stored=None, progress=None):
    m = models.model_object(exp)
    if progress:
        progress(0.6, "sampling atoms")
    xyz, typ, mol = m.all_atoms()
    n = len(xyz)
    stride = max(1, math.ceil(n / max_atoms))
    idx = np.arange(0, n, stride)
    consistency = None
    if stored:
        st = stored.get("counts", {}).get("total")
        consistency = dict(stored_total=st, computed_total=n, matches=st == n,
                           note=None if st == n else "this run folder was generated by an older NanoCut geometry (tool-gap convention "
                           "changed on 2026-10-10); its decks and dumps agree with each other, but this recomputed preview differs "
                           f"by {n - st:+d} atoms. Use the trajectory frames for this run.")
    return dict(source="computed", natoms=n, shown=len(idx), stride=stride, consistency=consistency,
                x=np.round(xyz[idx, 0], 3).tolist(), y=np.round(xyz[idx, 1], 3).tolist(), z=np.round(xyz[idx, 2], 3).tolist(),
                props=dict(type=typ[idx].tolist(), mol=mol[idx].tolist()), available=["type", "mol"],
                box=[[m.box[0], m.box[1]], [m.box[2], m.box[3]], [m.box[4], m.box[5]]],
                overlays=dict(y_surface=m.y_surface, tool_outline=[[round(a, 3), round(b, 3)] for a, b in m.tool_outline()],
                              laser=dict(x=m.laser_center[0], y=m.laser_center[1], r=m.laser_radius) if exp.get("laser", {}).get("mode") in ("spot", "power") else None,
                              depth_line=m.y_surface - m.depth, types=m.types))


@app.get("/api/simulations/{sid}/initial")
def simulation_initial(sid: str, max_atoms: int = 60000):
    sim = _sim_or_404(sid)
    exp = catalog.experiment_dict(sim)
    if not exp:
        raise HTTPException(404, "no experiment parameters for this simulation")
    max_atoms = max(2000, min(max_atoms, 300_000))
    key = "initial:" + hashlib.sha1((json.dumps(exp, sort_keys=True) + str(max_atoms)).encode()).hexdigest()[:16]
    stored = (catalog.params_json(sim) or {}).get("model") if sim["kind"] == "run" else None
    rec = jobs.submit(key + (":" + sim["id"] if stored else ""), f"initial configuration of {sim['label']}", _initial_job, exp, max_atoms, stored)
    return _job_response(rec)


def _schematic_job(exp, n_frames, chip_ratio, max_atoms, progress=None):
    from nanocut.mock import mock_frames
    mk = mock_frames(Experiment.from_dict(exp), n_frames=n_frames, chip_ratio=chip_ratio, max_atoms=max_atoms)
    meta = mk["meta"]
    frames = [dict(travel_A=round(f["travel_A"], 3), x=np.round(f["xyz"][:, 0], 2).tolist(), y=np.round(f["xyz"][:, 1], 2).tolist(),
                   kind=f["kind"].astype(int).tolist(), hot=np.round(f["hot"], 3).tolist()) for f in mk["frames"]]
    outlines = [np.round(o, 2).tolist() for o in mk["outlines"]]
    return dict(source="schematic", frames=frames, outlines=outlines,
                meta=dict(y_surface=meta["y_surface"], y_cut=meta["y_cut"], shear_angle_deg=meta["shear_angle_deg"],
                          chip_thickness_A=meta["chip_thickness_A"], depth_A=meta["depth_A"], x_front0=meta["x_front0"],
                          laser=meta["laser"]))


@app.get("/api/simulations/{sid}/schematic")
def simulation_schematic(sid: str, frames: int = 20, chip_ratio: float = 0.5, max_atoms: int = 6000):
    sim = _sim_or_404(sid)
    exp = catalog.experiment_dict(sim)
    if not exp:
        raise HTTPException(404, "no experiment parameters for this simulation")
    frames, max_atoms = max(4, min(frames, 60)), max(1000, min(max_atoms, 20000))
    chip_ratio = max(0.1, min(chip_ratio, 1.0))
    key = "schematic:" + hashlib.sha1(json.dumps([exp, frames, chip_ratio, max_atoms], sort_keys=True).encode()).hexdigest()[:16]
    rec = jobs.submit(key, f"schematic of {sim['label']}", _schematic_job, exp, frames, chip_ratio, max_atoms)
    return _job_response(rec)


@app.get("/api/simulations/{sid}/model")
def simulation_model(sid: str):
    sim = _sim_or_404(sid)
    model, rec = models.summary_for(sim)
    if model is not None:
        return dict(status="done", result=model, source="params.json" if sim["kind"] == "run" else "computed")
    if rec is None:
        raise HTTPException(404, "no model for this simulation")
    return _job_response(rec)


# ---------------------------------------------------------------------------------------------------- analysis
@app.get("/api/simulations/{sid}/series")
def simulation_series(sid: str):
    sim = _sim_or_404(sid)
    ff = [f for f in sim["files"] if f["role"] == "forces"]
    if not ff:
        return dict(available=False, reason="no *_forces_temps.txt in this folder (written by NanoCut deck B)")
    exp = catalog.experiment_dict(sim) if sim["kind"] == "run" else None
    names, arr = analysis.read_avetime(str(_abs(ff[0]["path"])))
    if not len(arr):
        return dict(available=False, reason="force file has no data rows yet")
    out = dict(available=True, file=ff[0]["path"], columns=names, step=arr[:, 0].tolist(),
               series={n: arr[:, i].tolist() for i, n in enumerate(names) if i > 0})
    if exp:
        dt, v = exp["thermo"]["cut_dt_fs"] * 1e-3, exp["process"]["speed_ms"] * 0.01
        out["cut_distance_nm"] = (arr[:, 0] * dt * v / 10).tolist()
        out["time_ps"] = (arr[:, 0] * dt).tolist()
        fs = analysis.force_summary(names, arr, v, dt)
        out["summary"] = {k: v for k, v in fs.items() if not isinstance(v, np.ndarray)}
        out["summary_basis"] = "mean and std over the last 50 % of the cutting distance"
    return out


def _metrics_job(sim, progress=None):
    exp = catalog.experiment_dict(sim)
    pj = catalog.params_json(sim) or {}
    model = pj.get("model")
    if not (exp and model):
        raise ValueError("params.json with experiment and model summary is required")
    dl, _ = dumps.list_dumps(str(_abs(sim["path"])))
    dt, v = exp["thermo"]["cut_dt_fs"] * 1e-3, exp["process"]["speed_ms"] * 0.01
    rc = exp["output"]["contact_zone_radius_nm"] * 10
    edge = model.get("contact_point_A", model.get("edge_center_A"))
    rows = []
    for i, (step, p) in enumerate(dl):
        progress(i / max(1, len(dl)), f"frame {i + 1}/{len(dl)} (step {step})")
        h, df = dumps.load_frame(p)
        fr = analysis.Frame(dict(step=h["step"], box=h["box"], cols=h["columns"], data=df.to_numpy()), model.get("types"))
        m = analysis.metrics(fr, model["y_surface_A"], edge, v, dt, rc=rc)
        rows.append(dict(index=i, step=step, time_ps=m["time_ps"], cut_distance_A=m["cut_distance_A"],
                         max_height_above_surface_A=m.get("max_height_above_surface_A"),
                         atoms_above_surface=m.get("atoms_above_surface"), contact_zone_atoms=m.get("contact_zone_atoms"),
                         contact_zone_T_K=m.get("contact_zone_T_K"), contact_zone_T_local_mean_K=m.get("contact_zone_T_local_mean_K"),
                         max_local_T_K=m.get("max_local_T_K"),
                         coordination=m.get("coordination_histogram")))
    return dict(rows=rows, definitions=dict(
        max_height_above_surface_A="max y of workpiece atoms minus the undeformed surface (chip / pile-up height)",
        atoms_above_surface="workpiece atoms more than 1 Å above the undeformed surface",
        contact_zone_T_K=f"temperature of workpiece atoms within {rc:.0f} Å of the moving contact point, centre-of-mass velocity removed",
        contact_zone_T_local_mean_K="mean of the per-atom temperature (time-averaged KE) in the same zone",
        coordination="histogram of the coordination number of workpiece atoms (4 = perfect sp3 for SiC/Si)"))


@app.post("/api/simulations/{sid}/metrics")
def simulation_metrics_start(sid: str, refresh: bool = False):
    sim = _sim_or_404(sid)
    if sim["kind"] != "run" or not sim.get("n_frames"):
        raise HTTPException(422, "per-frame metrics need a run folder with dumps and params.json")
    key = f"metrics:{sid}:{sum(f['modified'] for f in sim['files']):.0f}"
    if refresh:
        jobs.forget(key)
    return _job_response(jobs.submit(key, f"per-frame metrics of {sim['label']}", _metrics_job, sim))


@app.get("/api/simulations/{sid}/plots")
def simulation_plots(sid: str):
    sim = _sim_or_404(sid)
    return [dict(name=f["name"], path=f["path"], bytes=f["bytes"]) for f in sim["files"] if f["role"] == "image"]


@app.get("/api/jobs/{jid}")
def job(jid: str):
    rec = jobs.get(jid)
    if not rec:
        raise HTTPException(404, "unknown job")
    return jobs.public(rec)


# ---------------------------------------------------------------------------------------------------- validation
VALIDATION_KEY = "validation:all"


@app.get("/api/validation")
def validation_get():
    rec = jobs.by_key(VALIDATION_KEY) or jobs.submit(VALIDATION_KEY, "validation of all simulations", validation.validate_all)
    return _job_response(rec)


@app.post("/api/validation/run")
def validation_run():
    jobs.forget(VALIDATION_KEY)
    return _job_response(jobs.submit(VALIDATION_KEY, "validation of all simulations", validation.validate_all))


@app.get("/api/simulations/{sid}/validation")
def simulation_validation(sid: str):
    return validation.validate_sim(_sim_or_404(sid))


# ---------------------------------------------------------------------------------------------------- files (read-only)
@app.get("/api/tree")
def tree(path: str = None, depth: int = 3):
    try:
        return catalog.tree(path, depth=max(1, min(depth, 5)))
    except PermissionError as e:
        raise HTTPException(403, str(e))


@app.get("/api/files/text")
def file_text(path: str):
    try:
        p = safe_path(path)
    except PermissionError as e:
        raise HTTPException(403, str(e))
    if not p.is_file():
        raise HTTPException(404, "file not found")
    if p.suffix.lower() not in TEXT_SUFFIXES and not p.name.startswith("log"):
        raise HTTPException(415, f"'{p.suffix}' files are not shown as text (dumps and restarts are binary or too large)")
    size = p.stat().st_size
    with open(p, "r", errors="replace") as f:
        txt = f.read(MAX_TEXT_BYTES)
    return dict(path=rel(p), bytes=size, truncated=size > MAX_TEXT_BYTES, lines=txt.splitlines(),
                origin="original" if str(p).startswith(str(REFERENCE_ROOT)) else None, modified=p.stat().st_mtime)


@app.get("/api/files/raw")
def file_raw(path: str):
    try:
        p = safe_path(path)
    except PermissionError as e:
        raise HTTPException(403, str(e))
    mt = IMAGE_SUFFIXES.get(p.suffix.lower())
    if not p.is_file() or not mt:
        raise HTTPException(404, "image not found")
    return FileResponse(p, media_type=mt)


# ---------------------------------------------------------------------------------------------------- deck generation
def _apply_overrides(exp, overrides):
    for dotted, val in (overrides or {}).items():
        sec, key = dotted.split(".", 1)
        if sec not in exp or key not in exp[sec]:
            raise ValueError(f"unknown parameter {dotted}")
        cur = exp[sec][key]
        if isinstance(cur, bool):
            val = bool(val)
        elif isinstance(cur, int) and not isinstance(cur, bool):
            val = int(val)
        elif isinstance(cur, float) or cur is None and isinstance(val, (int, float)):
            val = float(val)
        exp[sec][key] = val
    return exp


def _decks_job(exp, progress=None):
    from nanocut.deck import deck_a, deck_b
    e = Experiment.from_dict(exp)
    errs = schema_validate(e)
    if errs:
        return dict(errors=errs)
    progress(0.2, "building model")
    m = models.model_object(exp)
    a, fa, wa = deck_a(e, m)
    b, fb, wb = deck_b(e, m)
    s = models.build_summary(exp)
    return dict(errors=[], A=a, B=b, potential_files=sorted(set(fa + fb)), warnings=sorted(set(wa + wb)),
                advice=advice.soft_warnings(exp, s), counts=s["counts"], name=e.name)


@app.get("/api/deck-options")
def deck_options():
    """Everything the deck editor offers, from the same catalogues the Streamlit app uses (nothing duplicated)."""
    from nanocut.materials import MATERIALS, TOOL_MATERIALS
    from nanocut.potentials import MORSE, POTENTIALS
    pots = {k: dict(label=p["label"], file=p["file"], style=p["style"], elements=sorted(p["tokens"]), dt_fs=p["dt_fs"],
                    citation=p["citation"], note=p["note"], rigid_tool_only=bool(p.get("rigid_tool_only")),
                    excluded_pairs=[list(x) for x in p.get("excluded_pairs", ())]) for k, p in POTENTIALS.items()}
    morse = [dict(pair=list(k), D=v[0], alpha=v[1], r0=v[2], rc=v[3], source=v[4], verified=v[5]) for k, v in MORSE.items()]
    return dict(materials=MATERIALS, tool_materials=TOOL_MATERIALS, potentials=pots, morse=morse, defaults=Experiment().to_dict())


def _coerce_experiment(d):
    """Full parameter set from the editor -> normalised dict (unknown keys dropped by the schema, tuples restored)."""
    if not isinstance(d, dict):
        raise ValueError("experiment must be an object")
    return Experiment.from_dict(d).to_dict()


@app.post("/api/decks/check")
def decks_check(body: dict = Body(...)):
    """Hard errors of a parameter set (cheap, no model build): the same rules as Streamlit's 'Fix before generating'."""
    try:
        e = Experiment.from_dict(_coerce_experiment(body.get("experiment")))
    except (ValueError, TypeError) as err:
        raise HTTPException(422, str(err))
    return dict(errors=schema_validate(e), cut_steps=e.cut_steps, equil_steps=e.equil_steps)


@app.post("/api/decks")
def decks(body: dict = Body(...)):
    if body.get("experiment") is not None:                # full parameter set from the deck editor
        try:
            exp = _coerce_experiment(body["experiment"])
        except (ValueError, TypeError) as e:
            raise HTTPException(422, str(e))
    else:
        base = body.get("base")
        sim = catalog.get(base) if base else None
        exp = catalog.experiment_dict(sim) if sim else None
        if not exp:
            raise HTTPException(422, "base must be a run or preset id with experiment parameters")
        try:
            exp = _apply_overrides(json.loads(json.dumps(exp)), body.get("overrides"))
        except (ValueError, TypeError) as e:
            raise HTTPException(422, str(e))
    key = "decks:" + hashlib.sha1(json.dumps(exp, sort_keys=True).encode()).hexdigest()[:16]
    return _job_response(jobs.submit(key, f"decks for {exp['name']}", _decks_job, exp))


# ---------------------------------------------------------------------------------------------------- studio (any dump)
def _studio_err(e):
    code = {PermissionError: 403, FileNotFoundError: 404, KeyError: 404, LookupError: 409, IndexError: 422, ValueError: 422}
    for t, c in code.items():
        if isinstance(e, t):
            return HTTPException(c, str(e).strip("'\""))
    return HTTPException(500, str(e))


@app.get("/api/studio/scan")
def studio_scan(path: str):
    """Dump sequences found in a folder (two levels deep) or the single dump file given. Names and sizes only."""
    try:
        return studio.scan(path)
    except Exception as e:
        raise _studio_err(e)


@app.post("/api/studio/open")
def studio_open(body: dict = Body(...)):
    """Index a sequence ({path, pattern}) or a file ({path}); background job, returns the source record."""
    try:
        p = str(studio.resolve(body.get("path")))
    except Exception as e:
        raise _studio_err(e)
    key = f"studio-open:{p}|{body.get('pattern') or ''}"
    if body.get("refresh"):
        jobs.forget(key)
    rec = jobs.by_key(key)
    if rec and rec["status"] == "done" and rec["result"]["id"] not in studio._sources:
        jobs.forget(key)
    return _job_response(jobs.submit(key, f"index {Path(p).name}", studio.open_source, p, body.get("pattern")))


@app.post("/api/studio/sources/{sid}/frames/{index}/load")
def studio_load(sid: str, index: int, ref: int = None):
    """Parse one frame (and the reference frame for displacements) into the server cache; background job."""
    try:
        studio.get_source(sid)
    except Exception as e:
        raise _studio_err(e)
    key = f"studio-frame:{sid}:{index}:{ref}"
    rec = jobs.by_key(key)
    if rec and rec["status"] == "done" and not studio.is_loaded(sid, index, ref):
        jobs.forget(key)                                       # evicted from the cache since: parse again
    return _job_response(jobs.submit(key, f"frame {index}", studio.load_frame, sid, index, ref))


@app.get("/api/studio/sources/{sid}/frames/{index}/data")
def studio_data(sid: str, index: int, cols: str, ref: int = None):
    """Requested per-atom columns of a loaded frame as raw little-endian float32 (id: uint32), atoms sorted by id."""
    try:
        data = studio.columns_bytes(sid, index, [c for c in cols.split(",") if c], ref)
    except Exception as e:
        raise _studio_err(e)
    return Response(content=data, media_type="application/octet-stream")


@app.get("/api/studio/sources/{sid}/frames/{index}/atom/{i}")
def studio_atom(sid: str, index: int, i: int, ref: int = None):
    try:
        return studio.atom_row(sid, index, i, ref)
    except Exception as e:
        raise _studio_err(e)


# ---------------------------------------------------------------------------------------------------- OVITO page
from . import ovito_lab, remote  # noqa: E402  (official OVITO Python module, separate worker process; HPC over SSH)
app.include_router(ovito_lab.router)
app.include_router(remote.router)


# ---------------------------------------------------------------------------------------------------- frontend
if FRONTEND_DIR.exists():                     # on Vercel the frontend is served from public/ instead
    app.mount("/app", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")

    @app.get("/")
    def root():
        return RedirectResponse("/app/")
