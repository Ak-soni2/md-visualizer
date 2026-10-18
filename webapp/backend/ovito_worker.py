"""Long-lived OVITO worker process for the NanoCut OVITO page.

Started by webapp/backend/app/ovito_lab.py with the project's Python. Reads one JSON request per line on stdin and
answers one JSON line on the original stdout (OVITO's own console output goes to stderr). Keeping the process alive
lets OVITO keep a loaded trajectory frame cached between renders. Read-only: it only reads dump files and writes
images/exports into the output folder given by the backend.

ops: hello | info {import_path, multiple_frames, frame} | run {spec, image_path} | export {spec, path, format, columns}
     | displacements {import_path, multiple_frames, frame, reference, out} (for the Studio cross-check)
"""
import hashlib
import io
import json
import os
import sys
import time
import traceback

OUT = sys.stdout
sys.stdout = sys.stderr                      # anything OVITO or user scripts print must not corrupt the protocol

import numpy as np                           # noqa: E402
import ovito                                 # noqa: E402
from ovito.io import export_file, import_file  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))          # memdump
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
from webapp.backend.app import ovito_script  # noqa: E402

_cache = {}                                  # (path, multi) -> pipeline


def cached_pipeline(path, multiple_frames=False):
    key = (path, bool(multiple_frames))
    if key not in _cache:
        if len(_cache) >= 2:
            _cache.pop(next(iter(_cache)))
        if path.startswith("remote://"):                      # HPC: frames streamed into memory, no file on disk
            from ovito.pipeline import Pipeline, PythonSource
            _cache[key] = Pipeline(source=PythonSource(delegate=_remote_source(path)))
        else:
            _cache[key] = import_file(path, multiple_frames=True) if multiple_frames else import_file(path)
    return _cache[key]


def _bridge_get(route, **q):
    """GET from the backend's loopback channel to the open SSH connection (bytes, in memory)."""
    import urllib.parse
    import urllib.request
    port, token = os.environ["NANOCUT_BRIDGE"].split(":")
    req = urllib.request.Request(f"http://127.0.0.1:{port}/{route}?{urllib.parse.urlencode(q)}", headers={"X-NanoCut-Bridge": token})
    with urllib.request.urlopen(req, timeout=3600) as r:
        return r.read()


def _remote_source(url):
    """OVITO pipeline source for remote://sid=..&dir=..&pattern=..: every frame is read over SSH into memory and
    turned into OVITO data by memdump.fill (identical to OVITO's reader); nothing is written to disk."""
    import urllib.parse
    from ovito.pipeline import PipelineSourceInterface
    import memdump
    q = {k: v[0] for k, v in urllib.parse.parse_qs(url[len("remote://"):]).items()}
    sid, rdir, pattern = q["sid"], q["dir"].rstrip("/"), q["pattern"]
    files = json.loads(_bridge_get("files", sid=sid, dir=rdir, pattern=pattern))
    if "*" in pattern:                                          # one frame per file
        frames = [(name, 0, size) for name, size in files]
    else:                                                       # one file with many frames: index it once (streamed)
        name, size = files[0]
        step, offs = 64 << 20, []
        chunks = (_bridge_get("read", sid=sid, path=f"{rdir}/{name}", offset=o, length=min(step, size - o)) for o in range(0, size, step))
        offs = memdump.frame_offsets(chunks)
        frames = [(name, o, (offs[k + 1] if k + 1 < len(offs) else size) - o) for k, o in enumerate(offs)]

    class RemoteDump(PipelineSourceInterface):
        def compute_trajectory_length(self, **kwargs):
            return len(frames)

        def create(self, data, *, frame, **kwargs):
            name, off, n = frames[frame]
            raw = _bridge_get("read", sid=sid, path=f"{rdir}/{name}", offset=off, length=n)
            memdump.fill(data, raw, f"sftp:{rdir}/{name}", frame)
            del raw
    return RemoteDump()


def _clear_scene():
    for p in list(ovito.scene.pipelines):
        p.remove_from_scene()


def _jsonable(v):
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.floating,)):
        return float(v)
    if isinstance(v, (int, float, str, bool)) or v is None:
        return v
    return str(v)


def _summary(data):
    p = data.particles
    stats = {}
    for name in p.keys():
        arr = np.asarray(p[name])
        if arr.dtype.kind not in "fiu" or arr.size == 0:
            continue
        if arr.ndim == 1:
            stats[name] = [float(np.nanmin(arr)), float(np.nanmax(arr)), float(np.nanmean(arr))]
        else:
            comps = p[name].component_names or [str(i) for i in range(arr.shape[1])]
            for i, cn in enumerate(comps):
                stats[f"{name}.{cn}"] = [float(np.nanmin(arr[:, i])), float(np.nanmax(arr[:, i])), float(np.nanmean(arr[:, i]))]
    types = []
    if p.particle_types is not None:
        ids, counts = np.unique(np.asarray(p.particle_types), return_counts=True)
        for t in p.particle_types.types:
            n = int(counts[ids == t.id][0]) if (ids == t.id).any() else 0
            types.append(dict(id=t.id, name=t.name, color="#%02x%02x%02x" % tuple(int(round(c * 255)) for c in t.color),
                              radius=float(t.radius), count=n))
    return dict(count=int(p.count), properties=list(p.keys()), stats=stats, types=types, default_radius=float(p.vis.radius),
                attributes={k: _jsonable(v) for k, v in data.attributes.items()},
                cell=[[float(x) for x in row] for row in np.asarray(data.cell)], pbc=[bool(b) for b in data.cell.pbc])


def op_info(req):
    pl = cached_pipeline(req["import_path"], req.get("multiple_frames", False))
    pl.modifiers.clear()
    n = pl.source.num_frames
    frame = min(int(req.get("frame", 0)), max(n - 1, 0))
    out = _summary(pl.compute(frame))
    out.update(num_frames=n, frame=frame)
    return out


def op_run(req):
    spec = req["spec"]
    script = ovito_script.build(spec, image_path=req["image_path"], cached=True)
    _clear_scene()
    ns = {"cached_pipeline": cached_pipeline, "__name__": "nanocut_ovito"}
    t0 = time.time()
    exec(compile(script, "<nanocut-ovito-script>", "exec"), ns)       # the generated script, nothing else
    out = _summary(ns["data"])
    out.update(seconds=round(time.time() - t0, 2), num_frames=ns["pipeline"].source.num_frames)
    _clear_scene()
    return out


def op_export(req):
    spec = dict(req["spec"], render=None, overlays=None)
    script = ovito_script.build(spec, image_path=os.devnull, cached=True)
    script = script.split("pipeline.add_to_scene()")[0]                 # pipeline + compute only, no rendering
    ns = {"cached_pipeline": cached_pipeline, "__name__": "nanocut_ovito"}
    exec(compile(script, "<nanocut-ovito-export>", "exec"), ns)
    cols = [c for c in req.get("columns") or [] if isinstance(c, str)]
    fmt = req.get("format", "lammps/dump")
    kw = dict(frame=ns["FRAME"])
    if fmt in ("lammps/dump", "xyz"):
        kw["columns"] = cols
    export_file(ns["pipeline"], req["path"], fmt, **kw)
    return dict(path=req["path"], bytes=os.path.getsize(req["path"]))


def op_displacements(req):
    from ovito.modifiers import CalculateDisplacementsModifier
    pl = import_file(req["import_path"], multiple_frames=True) if req.get("multiple_frames") else import_file(req["import_path"])
    pl.modifiers.append(CalculateDisplacementsModifier(reference_frame=int(req["reference"]), minimum_image_convention=True))
    d = pl.compute(int(req["frame"]))
    ids = np.asarray(d.particles.identifiers)
    order = np.argsort(ids)
    np.savez(req["out"], ids=ids[order], pos=np.asarray(d.particles.positions)[order],
             disp=np.asarray(d.particles["Displacement"])[order], step=d.attributes.get("Timestep", -1))
    return dict(count=int(d.particles.count), step=_jsonable(d.attributes.get("Timestep")))


# ------------------------------------------------------------------------------------------------ live 3D viewport
# The browser draws the particles in 3D; OVITO computes everything that is drawn. The pipeline of the page (built by
# the same script generator as the renders) is kept per settings, so stepping through frames only calls compute().
_live = {}                                   # settings hash -> pipeline (own Pipeline object sharing the file source)
_frames = {}                                 # (settings hash, frame) -> data collection of recent live frames (picking)


def _key(spec):
    return hashlib.sha1(json.dumps({k: spec.get(k) for k in ("source", "types", "cell", "modifiers")}, sort_keys=True).encode()).hexdigest()


def _live_pipeline(spec):
    from ovito.pipeline import Pipeline
    key = _key(spec)
    if key not in _live:
        script = ovito_script.build(dict(spec, view=None, render=None, overlays=None), image_path=os.devnull, cached=True)
        script = script.split("data = pipeline.compute(FRAME)")[0]           # the pipeline only
        ns = {"__name__": "nanocut_ovito_live",
              "cached_pipeline": lambda p, multiple_frames=False: Pipeline(source=cached_pipeline(p, multiple_frames).source)}
        exec(compile(script, "<nanocut-ovito-live>", "exec"), ns)
        if len(_live) >= 3:
            _live.pop(next(iter(_live)))
        _live[key] = ns
    return _live[key]


def display_colors_radii(particles):
    """Colour and radius of every particle exactly as OVITO's ParticlesVis chooses them: the Color property, else the
    particle type's colour, else the default colour; selected particles in the selection colour. Radius: the Radius
    property where > 0, else the type's radius where > 0, else the default radius; times the scaling factor."""
    p, vis = particles, particles.vis
    n = p.count
    types = np.asarray(p.particle_types) if p.particle_types is not None else None
    tcol, trad = {}, {}
    if p.particle_types is not None:
        for t in p.particle_types.types:
            tcol[t.id], trad[t.id] = t.color, t.radius
    if "Color" in p:
        col = np.array(p["Color"], dtype=np.float64)
    else:
        col = np.tile(np.array(vis.default_color, dtype=np.float64), (n, 1))
        for tid, c in tcol.items():
            col[types == tid] = c
    if "Selection" in p:
        col[np.asarray(p["Selection"]) != 0] = vis.selection_color
    base = float(vis.radius)
    rad = np.full(n, base, dtype=np.float64)
    if types is not None and trad:
        for tid, r in trad.items():
            if r > 0:
                rad[types == tid] = r
    if "Radius" in p:
        r = np.asarray(p["Radius"], dtype=np.float64)
        rad = np.where(r > 0, r, rad)
    rad *= float(getattr(vis, "scaling", 1.0) or 1.0)
    return (np.clip(col, 0, 1) * 255 + 0.5).astype(np.uint8), rad.astype(np.float32)


def op_live(req):
    spec = req["spec"]
    ns = _live_pipeline(spec)
    pl = ns["pipeline"]
    n_frames = pl.source.num_frames
    frame = min(int(req.get("frame", 0)), max(n_frames - 1, 0))
    t0 = time.time()
    data = pl.compute(frame)
    t1 = time.time()
    P = data.particles
    pos = np.ascontiguousarray(np.asarray(P.positions, dtype=np.float32))
    col, rad = display_colors_radii(P)
    lines = np.zeros((0, 3), np.float32)
    if data.dislocations is not None and len(data.dislocations.segments):
        segs = []
        for s in data.dislocations.segments:                      # polyline -> pairs of vertices (GL lines)
            pts = np.asarray(s.points, dtype=np.float32)
            if len(pts) > 1:
                segs.append(np.repeat(pts, 2, axis=0)[1:-1])
        lines = np.concatenate(segs) if segs else lines
    parts, layout = _encode(P, pos, col, rad, lines, int(req.get("max_bytes") or 0))
    with open(req["out"], "wb") as f:
        for b in parts:
            f.write(b)
    legend = None
    cc = [m for m in pl.modifiers if type(m).__name__ == "ColorCodingModifier" and m.enabled]
    if cc:
        m = cc[-1]
        lo = data.attributes.get("ColorCoding.RangeMin", m.start_value)
        hi = data.attributes.get("ColorCoding.RangeMax", m.end_value)
        legend = dict(property=str(m.property), start=float(lo), end=float(hi),
                      colors=[[round(c * 255) for c in m.gradient.value_to_color(i / 31)] for i in range(32)])
    _frames[(_key(spec), frame)] = data
    while len(_frames) > 4:
        _frames.pop(next(iter(_frames)))
    out = _summary(data)
    out.update(num_frames=n_frames, frame=frame, step=_jsonable(data.attributes.get("Timestep")), legend=legend,
               layout=layout, seconds=dict(compute=round(t1 - t0, 3), total=round(time.time() - t0, 3)))
    return out


def _pad(b):
    return b + b"\0" * ((-len(b)) % 4)


def _encode(P, pos, col, rad, lines, max_bytes):
    """Binary frame for the viewport. Exact float32 positions when it fits max_bytes (0 = no limit). Otherwise (the
    4.5 MB response limit of a hosted function) positions as uint16 within the bounding box, radii as an index into a
    table, and if still too large every k-th particle by identifier; the layout says what was done (display only:
    picking and all numbers always use OVITO's full data)."""
    n, lb = int(P.count), lines.astype(np.float32).tobytes()
    if not max_bytes or n * 19 + 4 + len(lb) <= max_bytes:
        return [pos.tobytes(), _pad(col.tobytes()), rad.tobytes(), lb], dict(encoding="f32", n=n, n_total=n, lines=int(len(lines)))
    sel, k = np.arange(n), 1
    if n * 10 + 12 + len(lb) > max_bytes:
        k = int(np.ceil(n * 14 / max(1, max_bytes - len(lb) - 64)))
        ids = np.asarray(P.identifiers) if P.identifiers is not None else np.arange(n)
        sel = np.nonzero(ids % k == 0)[0]
    p = pos[sel].astype(np.float64)
    lo = p.min(0) if len(p) else np.zeros(3)
    span = (p.max(0) - lo) if len(p) else np.ones(3)
    scale = np.where(span > 0, span / 65535.0, 1.0)
    q = np.clip(np.rint((p - lo) / scale), 0, 65535).astype("<u2")
    r = rad[sel]
    table = np.unique(r)
    if len(table) > 256:                                          # radius per particle (rare): 256 levels
        table = np.linspace(float(r.min()), float(r.max()), 256).astype(np.float32)
    ri = np.clip(np.searchsorted(table, r), 0, len(table) - 1).astype(np.uint8)
    parts = [_pad(q.tobytes()), _pad(col[sel].tobytes()), _pad(ri.tobytes())] + ([sel.astype("<u4").tobytes()] if k > 1 else []) + [lb]
    return parts, dict(encoding="q16", n=int(len(sel)), n_total=n, lines=int(len(lines)), lo=[float(x) for x in lo], scale=[float(x) for x in scale],
                       radii=[float(x) for x in table], stride=k, index_map=k > 1, precision_A=float(scale.max()))


def op_atom(req):
    spec, frame = req["spec"], int(req["frame"])
    data = _frames.get((_key(spec), frame))
    if data is None:                                              # evicted meanwhile: compute it again
        data = _live_pipeline(spec)["pipeline"].compute(frame)
    i = int(req["index"])
    P = data.particles
    if not 0 <= i < P.count:
        raise IndexError("particle index out of range")
    row = {}
    for name in P.keys():
        v = np.asarray(P[name])[i]
        if np.ndim(v) == 0:
            row[name] = _jsonable(v.item() if hasattr(v, "item") else v)
        else:
            comps = P[name].component_names or [str(k) for k in range(len(v))]
            for cn, x in zip(comps, v):
                row[f"{name}.{cn}"] = _jsonable(x.item() if hasattr(x, "item") else x)
    if "Particle Type" in row and P.particle_types is not None:
        t = P.particle_types.type_by_id(int(row["Particle Type"]))
        if t is not None and t.name:
            row["Particle Type"] = f"{row['Particle Type']} ({t.name})"
    return dict(frame=frame, index=i, values=row)


# ------------------------------------------------------------------------------------------------ frame export / statistics
# LAMMPS dump column -> OVITO property component, for the columns OVITO stores unchanged (values identical to the dump).
# Columns OVITO converts (xs/ys/zs -> absolute Position, diameter -> Radius) are not mapped back: they keep OVITO's name.
DUMP_TO_OVITO = {"id": "Particle Identifier", "type": "Particle Type", "mol": "Molecule Identifier", "mass": "Mass", "q": "Charge",
                 "x": "Position.X", "y": "Position.Y", "z": "Position.Z", "xu": "Position.X", "yu": "Position.Y", "zu": "Position.Z",
                 "vx": "Velocity.X", "vy": "Velocity.Y", "vz": "Velocity.Z", "fx": "Force.X", "fy": "Force.Y", "fz": "Force.Z",
                 "ix": "Periodic Image.X", "iy": "Periodic Image.Y", "iz": "Periodic Image.Z", "radius": "Radius",
                 "omegax": "Angular Velocity.X", "omegay": "Angular Velocity.Y", "omegaz": "Angular Velocity.Z",
                 "angmomx": "Angular Momentum.X", "angmomy": "Angular Momentum.Y", "angmomz": "Angular Momentum.Z",
                 "tqx": "Torque.X", "tqy": "Torque.Y", "tqz": "Torque.Z"}
_raw = {}                                    # source -> pipeline without modifiers (sharing the cached file source)


def _components(P):
    """(property, OVITO name of the component, 1-D array) in OVITO's order."""
    for name in P.keys():
        arr = np.asarray(P[name])
        if arr.ndim == 1:
            yield name, name, arr
        else:
            comps = P[name].component_names or [str(i) for i in range(arr.shape[1])]
            for i, cn in enumerate(comps):
                yield name, f"{name}.{cn}", arr[:, i]


def _stats(arr):
    a = np.asarray(arr, dtype=np.float64)
    ok = np.isfinite(a)
    n = int(ok.sum())
    if not n:
        return dict(n=0, mean=None, std=None, min=None, max=None)
    v = a[ok]
    return dict(n=n, mean=float(v.mean()), std=float(v.std()), min=float(v.min()), max=float(v.max()))


def op_frame_table(req):
    """One frame for the Frame export: OVITO computes it (raw dump data, or after the page's pipeline), optionally
    appends its CSV to a ZIP, and returns per-column statistics plus the force averages."""
    from ovito.pipeline import Pipeline
    import pandas as pd
    import zipfile
    spec, frame = req["spec"], int(req["frame"])
    if req.get("apply_pipeline"):
        pl = _live_pipeline(spec)["pipeline"]
    else:
        src = spec["source"]
        k = (src["import_path"], bool(src.get("multiple_frames")))
        if k not in _raw:
            _raw[k] = Pipeline(source=cached_pipeline(*k).source)
        pl = _raw[k]
    data = pl.compute(frame)
    P = data.particles
    dump_cols = [c for c in req.get("dump_columns") or [] if isinstance(c, str)]
    to_dump = {}
    for c in dump_cols:                                       # OVITO component -> dump column (first one wins: x before xu)
        o = DUMP_TO_OVITO.get(c, c)
        to_dump.setdefault(o, c)
    raw_props = set(req.get("raw_properties") or [])
    cols, skipped = [], []
    for prop, oname, arr in _components(P):
        if oname in to_dump:
            cols.append((to_dump[oname], oname, "dump file", arr))
        elif prop in raw_props:                                 # made by OVITO while reading (e.g. Velocity Magnitude)
            (cols.append((oname, oname, "derived by OVITO", arr)) if req.get("include_derived") else skipped.append(oname))
        else:                                                   # output of a modifier of the pipeline
            cols.append((oname, oname, "OVITO pipeline", arr))
    order = {c: i for i, c in enumerate(dump_cols)}
    cols.sort(key=lambda c: (order.get(c[0], len(order)), c[0] if c[0] not in order else ""))
    if "element" in dump_cols and P.particle_types is not None:   # element names, as in the dump
        names = {t.id: t.name for t in P.particle_types.types}
        at = sum(1 for c in cols if order.get(c[0], len(order)) < order["element"])
        cols.insert(at, ("element", "Particle Type (name)", "dump file",
                                                              np.array([names.get(int(t), "") for t in np.asarray(P.particle_types)], dtype=object)))
    out = dict(frame=frame, timestep=_jsonable(data.attributes.get("Timestep")), count=int(P.count), skipped=skipped,
               columns=[dict(name=h, ovito=o, origin=g) for h, o, g, _ in cols])
    if req.get("csv_path"):                                     # one plain CSV (hosted: published per frame)
        pd.DataFrame({h: a for h, _, _, a in cols}, copy=False).to_csv(req["csv_path"], index=False)
    if req.get("zip_path"):
        df = pd.DataFrame({h: a for h, _, _, a in cols}, copy=False)
        with zipfile.ZipFile(req["zip_path"], "a", zipfile.ZIP_DEFLATED, compresslevel=1) as zf:
            with zf.open(f"frame_{frame}.csv", "w", force_zip64=True) as f:
                df.to_csv(io.TextIOWrapper(f, encoding="utf-8", newline=""), index=False)   # floats as Python repr: exact
    if req.get("stats"):
        out["stats"] = {h: _stats(a) for h, _, _, a in cols if a.dtype != object}
        if P.particle_types is not None:                        # every column also per particle type
            tt = np.asarray(P.particle_types)
            out["stats_by_type"] = {str(int(t)): {h: _stats(a[tt == t]) for h, _, _, a in cols if a.dtype != object} for t in np.unique(tt)}
        has = "Force" in P
        F = np.asarray(P["Force"], dtype=np.float64) if has else None

        def force_stats(mask):
            fs = dict(available=["Fx", "Fy", "Fz"] if has else [], missing=[] if has else ["Fx", "Fy", "Fz"], n=int(mask.sum()))
            if not has:
                return fs
            ok = mask & np.isfinite(F).all(1)                   # particles with all three components finite
            n = int(ok.sum())
            fs.update(n_valid=n, n_invalid=int(mask.sum() - n))
            if n:
                Fv = F[ok]
                mean, tot = Fv.mean(0), Fv.sum(0)
                fs.update(mean_fx=float(mean[0]), mean_fy=float(mean[1]), mean_fz=float(mean[2]),
                          sum_fx=float(tot[0]), sum_fy=float(tot[1]), sum_fz=float(tot[2]),
                          mean_magnitude=float(np.sqrt((Fv ** 2).sum(1)).mean()), magnitude_of_mean=float(np.sqrt((mean ** 2).sum())))
            return fs
        out["force"] = force_stats(np.ones(P.count, bool))
        if P.particle_types is not None:                        # e.g. the tool's total force = the cutting force
            t = np.asarray(P.particle_types)
            names = {ty.id: ty.name for ty in P.particle_types.types}
            out["force_by_type"] = {str(int(tid)): dict(force_stats(t == tid), name=names.get(int(tid)) or "") for tid in np.unique(t)}
    return out


# ------------------------------------------------------------------------------------------------ ductile / brittle indicators
_surface_level = {}                          # source -> original surface height (frame 0, tool removed)
DIAMOND_LABEL = ["other", "cubic diamond", "cubic diamond (1st neighbour)", "cubic diamond (2nd neighbour)",
                 "hexagonal diamond", "hexagonal diamond (1st neighbour)", "hexagonal diamond (2nd neighbour)"]


def _raw_pipeline(src):
    from ovito.pipeline import Pipeline
    k = (src["import_path"], bool(src.get("multiple_frames")))
    if k not in _raw:
        _raw[k] = Pipeline(source=cached_pipeline(*k).source)
    return _raw[k]


def _top_median(x, z, y, cell=10.0):
    """Median over cell x cell columns (in x, z) of the highest atom per column: the free surface height."""
    if not len(y):
        return None
    key = np.floor(x / cell).astype(np.int64) * 1_000_003 + np.floor(z / cell).astype(np.int64)
    order = np.lexsort((-y, key))
    first = np.r_[True, key[order][1:] != key[order][:-1]]
    return float(np.median(y[order][first]))


def op_regime(req):
    """Indicators of ductile vs brittle material removal for one frame, computed by OVITO in a zone around the tool.
    Axes: cutting along x, surface normal y (NanoCut decks); the tool is the given particle type(s)."""
    from ovito.modifiers import ClusterAnalysisModifier, ConstructSurfaceModifier, IdentifyDiamondModifier
    from ovito.pipeline import Pipeline, StaticSource
    src, frame, prm = req["spec"]["source"], int(req["frame"]), req["params"]
    pl = _raw_pipeline(src)
    tool_types = [int(t) for t in prm.get("tool_types") or []]
    R, ahead, behind = float(prm.get("probe_radius", 3.0)), float(prm.get("ahead", 30)), float(prm.get("behind", 60))
    data = pl.compute(frame)
    P = data.particles
    pos = np.asarray(P.positions, dtype=np.float64)
    typ = np.asarray(P.particle_types) if P.particle_types is not None else np.ones(P.count, int)
    tool = np.isin(typ, tool_types)
    if not tool.any():
        raise ValueError(f"no particles of the tool type(s) {tool_types} in frame {frame}")
    wp = ~tool
    sign = -1.0 if prm.get("direction", "-x") == "-x" else 1.0           # tool moves towards -x (NanoCut) or +x
    tip = float(pos[tool, 0].min() if sign < 0 else pos[tool, 0].max())  # cutting edge: leading tool atom
    tool_bottom = float(pos[tool, 1].min())
    key = (src["import_path"], tuple(tool_types))
    if key not in _surface_level:                                         # original surface: frame 0, tool removed
        d0 = pl.compute(0)
        p0, t0 = np.asarray(d0.particles.positions, dtype=np.float64), np.asarray(d0.particles.particle_types)
        w0 = ~np.isin(t0, tool_types)
        _surface_level[key] = _top_median(p0[w0, 0], p0[w0, 2], p0[w0, 1])
    ys = _surface_level[key]
    # zone: from `ahead` in front of the cutting edge to `behind` it (the freshly machined surface), full height
    lo, hi = (tip - ahead, tip + behind) if sign < 0 else (tip - behind, tip + ahead)
    pad = 2 * R + 6.0                                                     # neighbours and surface mesh need a margin
    x = pos[:, 0]
    in_pad = wp & (x >= lo - pad) & (x <= hi + pad)
    dc = data.clone()
    dc.particles_.delete_elements(~in_pad)
    zpos = pos[in_pad]
    inner = (zpos[:, 0] >= lo) & (zpos[:, 0] <= hi)
    zp = Pipeline(source=StaticSource(data=dc))
    zp.modifiers.append(IdentifyDiamondModifier())
    zp.modifiers.append(ConstructSurfaceModifier(radius=R, identify_regions=True, select_surface_particles=True))
    zd = zp.compute()
    st = np.asarray(zd.particles["Structure Type"])
    surf = np.asarray(zd.particles["Selection"]) != 0
    # interior = not on a free surface: surface atoms always look disordered (incomplete neighbour shells)
    interior = inner & ~surf
    n_in = int(interior.sum())
    counts = {DIAMOND_LABEL[i] if i < len(DIAMOND_LABEL) else str(i): int(((st == i) & interior).sum()) for i in np.unique(st[interior])} if n_in else {}
    other = int(((st == 0) & interior).sum())
    wp_bottom, wp_x0, wp_x1 = float(pos[wp, 1].min()), float(pos[wp, 0].min()), float(pos[wp, 0].max())
    margin, bottom_margin, side = float(prm.get("crack_margin", 4.0)), float(prm.get("bottom_margin", 10.0)), float(prm.get("side_margin", 10.0))
    # the workpiece's own outer faces (bottom, x ends) are free surfaces at every depth: never crack faces
    body = (zpos[:, 1] > wp_bottom + bottom_margin) & (zpos[:, 0] > wp_x0 + side) & (zpos[:, 0] < wp_x1 - side)
    deep = inner & surf & body & (zpos[:, 1] < tool_bottom - margin)
    reg = zd.surfaces["surface"].regions
    filled, ext, vol = (np.asarray(reg[k]) for k in ("Filled", "Exterior", "Volume"))
    vmin = float(prm.get("void_min_volume", 30.0))
    voids = (filled == 0) & (ext == 0) & np.isfinite(vol) & (vol >= vmin)
    # behind the cutting edge, below the tool: deepest disordered ("other") atom = subsurface damage depth
    behind_edge = (zpos[:, 0] - tip) * sign < 0                           # already passed by the tool (x > tip when moving -x)
    dmg = interior & body & behind_edge & (st == 0) & (zpos[:, 1] < tool_bottom)
    damage_depth = float(tool_bottom - zpos[dmg, 1].min()) if dmg.any() else 0.0
    # chip: workpiece atoms above the original surface, split into connected clusters
    chip_thr, cut, min_frag = float(prm.get("chip_threshold", 1.0)), float(prm.get("cluster_cutoff", 3.0)), int(prm.get("min_fragment", 20))
    above = wp & (pos[:, 1] > ys + chip_thr)
    sizes = []
    if above.any():
        cd = data.clone()
        cd.particles_.delete_elements(~above)
        cp = Pipeline(source=StaticSource(data=cd))
        cp.modifiers.append(ClusterAnalysisModifier(cutoff=cut, sort_by_size=True))
        cdd = cp.compute()
        sizes = sorted(np.bincount(np.asarray(cdd.particles["Cluster"]))[1:].tolist(), reverse=True)
    frags = [s for s in sizes if s >= min_frag]
    out = dict(frame=frame, step=_jsonable(data.attributes.get("Timestep")), tip_x=tip, tool_bottom_y=tool_bottom, surface_y=ys,
               depth_of_cut=float(ys - tool_bottom) if ys is not None else None, zone=[lo, hi], zone_atoms=int(inner.sum()),
               interior_atoms=n_in, structure=counts, disordered=other, disordered_fraction=other / n_in if n_in else None,
               deep_surface_atoms=int(deep.sum()), voids=int(voids.sum()), void_volume=float(vol[voids].sum()),
               surface_area=float(zd.attributes.get("ConstructSurfaceMesh.surface_area", 0.0)),
               chip_atoms=int(above.sum()), chip_fragments=len(frags), chip_sizes=frags[:8], chip_debris=int(sum(s for s in sizes if s < min_frag)),
               damage_depth=damage_depth)
    if "Force" in P:
        F = np.asarray(P["Force"], dtype=np.float64)[tool]
        ok = np.isfinite(F).all(1)
        tot = F[ok].sum(0)
        fc, ft = abs(float(tot[0])), abs(float(tot[1]))
        out.update(force_cutting=fc, force_thrust=ft, force_ratio=ft / fc if fc > 0 else None, force_vector=[float(v) for v in tot])
    return out


def op_pileup(req):
    """Pile-up height for one frame (tool removed): the original surface is the median, over 10 Å x 10 Å columns, of the
    highest workpiece atom in frame 0; the pile-up height is how far the highest workpiece atom of this frame rises
    above it (overall, ahead of the cutting edge = chip/front pile-up, behind it = burr/side pile-up on the machined
    surface), with the atom's identifier and position; plus the atoms higher than surface + threshold and their extent."""
    src, frame, prm = req["spec"]["source"], int(req["frame"]), req["params"]
    pl = _raw_pipeline(src)
    tool_types = [int(t) for t in prm.get("tool_types") or []]
    thr = float(prm.get("threshold", 1.0))
    data = pl.compute(frame)
    P = data.particles
    pos = np.asarray(P.positions, dtype=np.float64)
    typ = np.asarray(P.particle_types) if P.particle_types is not None else np.ones(P.count, int)
    ids = np.asarray(P.identifiers) if P.identifiers is not None else np.arange(1, P.count + 1)
    tool = np.isin(typ, tool_types)
    wp = ~tool
    key = (src["import_path"], tuple(tool_types))
    if key not in _surface_level:
        d0 = pl.compute(0)
        p0, t0 = np.asarray(d0.particles.positions, dtype=np.float64), np.asarray(d0.particles.particle_types)
        w0 = ~np.isin(t0, tool_types)
        _surface_level[key] = _top_median(p0[w0, 0], p0[w0, 2], p0[w0, 1])
    ys = _surface_level[key]
    out = dict(frame=frame, step=_jsonable(data.attributes.get("Timestep")), surface_y=ys, threshold=thr, workpiece_atoms=int(wp.sum()))

    def top(mask, name):
        if not mask.any():
            out[name] = None
            return
        i = np.nonzero(mask)[0][np.argmax(pos[mask, 1])]
        out[name] = dict(height=float(pos[i, 1] - ys), id=int(ids[i]), x=float(pos[i, 0]), y=float(pos[i, 1]), z=float(pos[i, 2]))
    top(wp, "highest")
    if tool.any():
        sign = -1.0 if prm.get("direction", "-x") == "-x" else 1.0
        tip = float(pos[tool, 0].min() if sign < 0 else pos[tool, 0].max())
        ahead = wp & ((pos[:, 0] - tip) * sign > 0)
        out.update(tip_x=tip, tool_bottom_y=float(pos[tool, 1].min()), depth_of_cut=float(ys - pos[tool, 1].min()))
        top(ahead, "ahead")
        top(wp & ~ahead, "behind")
    above = wp & (pos[:, 1] > ys + thr)
    out["above_count"] = int(above.sum())
    if above.any():
        a = pos[above]
        out.update(above_x=[float(a[:, 0].min()), float(a[:, 0].max())], above_z=[float(a[:, 2].min()), float(a[:, 2].max())],
                   above_width_z=float(a[:, 2].max() - a[:, 2].min()), above_volume_atoms=int(above.sum()))
    return out


# ------------------------------------------------------------------------------------------------ research analysis
# Every per-region quantity of PLAN_PHASE3.md §2: OVITO reads the frame and computes structure types, coordination,
# atomic strain, Voronoi volumes, Wigner–Seitz defects and dislocations; nanocut.research does the arithmetic.
_research = {}                               # options hash -> pipeline (sharing the cached file source)
_research_ref = {}                           # (source, cfg hash) -> nanocut.research.reference(frame 0)
OVITO_TO_DUMP = {"Molecule Identifier": "mol", "Mass": "mass", "Charge": "q"}


def _research_pipeline(src, cfg):
    from ovito.pipeline import Pipeline
    import ovito.modifiers as M
    opts = {k: cfg.get(k) for k in ("structure", "cn_cutoff", "strain", "strain_cutoff", "volume_mode", "dxa", "dxa_lattice")}
    key = (src["import_path"], bool(src.get("multiple_frames")), json.dumps(opts, sort_keys=True))
    if key not in _research:
        pl = Pipeline(source=cached_pipeline(src["import_path"], src.get("multiple_frames")).source)
        s = cfg.get("structure") or "none"
        if s == "diamond":
            pl.modifiers.append(M.IdentifyDiamondModifier())
        elif s == "cna":
            pl.modifiers.append(M.CommonNeighborAnalysisModifier())
        elif s == "ptm":
            pl.modifiers.append(M.PolyhedralTemplateMatchingModifier())
        if cfg.get("cn_cutoff"):
            pl.modifiers.append(M.CoordinationAnalysisModifier(cutoff=float(cfg["cn_cutoff"]), number_of_bins=10))
        if cfg.get("strain"):
            pl.modifiers.append(M.AtomicStrainModifier(cutoff=float(cfg.get("strain_cutoff") or 3.5), reference_frame=0))
        if cfg.get("volume_mode") == "voronoi":
            pl.modifiers.append(M.VoronoiAnalysisModifier())
        if cfg.get("dxa"):
            L = M.DislocationAnalysisModifier.Lattice
            pl.modifiers.append(M.DislocationAnalysisModifier(input_crystal_structure=getattr(L, cfg.get("dxa_lattice") or "CubicDiamond")))
        if len(_research) >= 3:
            _research.pop(next(iter(_research)))
        _research[key] = pl
    return _research[key]


def _frame_arrays(data):
    """OVITO data -> the frame dict of nanocut.research (dump column names for the dump's own columns)."""
    P = data.particles
    cols = {}
    for name in P.keys():
        arr = np.asarray(P[name])
        if name in ("Position", "Particle Identifier", "Particle Type", "Structure Type", "Coordination", "Shear Strain",
                    "Volumetric Strain", "Atomic Volume", "Color", "Selection", "Cavity Radius", "Max Face Order", "Cluster",
                    "Per Type Coordination", "Velocity Magnitude", "Atomic Strain", "Deformation Gradient", "Rotation",
                    "Stretch Tensor", "Strain Tensor", "Nonaffine Squared Displacement", "Dislocation Index", "Voronoi Index"):
            continue
        if name == "Velocity":
            cols.update(vx=arr[:, 0], vy=arr[:, 1], vz=arr[:, 2])
        elif name == "Force":
            cols.update(fx=arr[:, 0], fy=arr[:, 1], fz=arr[:, 2])
        elif arr.ndim == 1 and arr.dtype.kind in "fiu":
            cols[OVITO_TO_DUMP.get(name, name)] = arr
    ids = np.asarray(P.identifiers) if P.identifiers is not None else np.arange(1, P.count + 1)
    typ = np.asarray(P.particle_types) if P.particle_types is not None else np.ones(P.count, int)
    fr = dict(ids=ids, types=typ, pos=np.asarray(P.positions, dtype=np.float64), cell=np.asarray(data.cell), pbc=tuple(bool(b) for b in data.cell.pbc),
              cols=cols, step=_jsonable(data.attributes.get("Timestep")),
              type_names={t.id: t.name for t in P.particle_types.types} if P.particle_types is not None else {})
    if "Structure Type" in P:
        fr["structure"] = np.asarray(P["Structure Type"])
        st = P["Structure Type"].types
        n = max([t.id for t in st] + [0]) + 1
        names = [str(i) for i in range(n)]
        for t in st:
            names[t.id] = t.name
        fr["structure_names"] = names
    if "Coordination" in P:
        fr["coordination"] = np.asarray(P["Coordination"])
    if "Shear Strain" in P:
        fr["shear_strain"], fr["vol_strain"] = np.asarray(P["Shear Strain"]), np.asarray(P["Volumetric Strain"])
    if "Atomic Volume" in P:
        fr["voronoi_volume"] = np.asarray(P["Atomic Volume"])
    if data.attributes.get("DislocationAnalysis.total_line_length") is not None:
        fr["dxa"] = dict(length=float(data.attributes["DislocationAnalysis.total_line_length"]))
    return fr


def op_research(req):
    from ovito.data import CutoffNeighborFinder
    from nanocut import research
    src, frame, cfg = req["spec"]["source"], int(req["frame"]), research.cfg_with_defaults(req["cfg"])
    rkey = (src["import_path"], json.dumps([cfg["tool_types"], {str(k): v for k, v in cfg["types"].items()}, cfg["surface_cell"]], sort_keys=True))
    if rkey not in _research_ref:
        _research_ref[rkey] = research.reference(_frame_arrays(_raw_pipeline(src).compute(0)), cfg)
    t0 = time.time()
    data = _research_pipeline(src, cfg).compute(frame)
    fr = dict(_frame_arrays(data), frame=frame)
    if cfg.get("ws") and cfg["tool_types"]:
        import ovito.modifiers as M
        from ovito.pipeline import Pipeline
        k = ("ws", src["import_path"], tuple(cfg["tool_types"]))
        if k not in _research:
            pl = Pipeline(source=cached_pipeline(src["import_path"], src.get("multiple_frames")).source)
            pl.modifiers.append(M.SelectTypeModifier(types=set(cfg["tool_types"])))
            pl.modifiers.append(M.DeleteSelectedModifier())
            pl.modifiers.append(M.WignerSeitzAnalysisModifier(reference_frame=0))
            _research[k] = pl
        a = _research[k].compute(frame).attributes
        fr["ws"] = dict(vacancies=int(a["WignerSeitz.vacancy_count"]), interstitials=int(a["WignerSeitz.interstitial_count"]))
    finder = {}

    def neighbors(idx, cutoff):
        if cutoff not in finder:
            finder.clear()
            finder[cutoff] = CutoffNeighborFinder(float(cutoff), data)
        return finder[cutoff].find_all(np.asarray(idx, dtype=np.int64), sort_by="index")
    out = research.analyze_frame(fr, _research_ref[rkey], cfg, neighbors)
    out["seconds"] = round(time.time() - t0, 2)
    out["count"] = len(fr["ids"])
    return out


def op_volumes(req):
    """Atomic volume per particle type estimated from frame 0: median Voronoi volume of that type (bulk dominates)."""
    from ovito.modifiers import VoronoiAnalysisModifier
    from ovito.pipeline import Pipeline, StaticSource
    data = _raw_pipeline(req["spec"]["source"]).compute(0)
    p = Pipeline(source=StaticSource(data=data.clone()))
    p.modifiers.append(VoronoiAnalysisModifier())
    d = p.compute()
    v, t = np.asarray(d.particles["Atomic Volume"]), np.asarray(d.particles.particle_types)
    return {str(int(k)): float(np.median(v[t == k])) for k in np.unique(t)}


OPS = {"hello": lambda r: dict(ovito=ovito.version_string, pid=os.getpid()), "info": op_info, "run": op_run, "frame_table": op_frame_table,
       "regime": op_regime, "pileup": op_pileup, "research": op_research, "volumes": op_volumes,
       "export": op_export, "displacements": op_displacements, "live": op_live, "atom": op_atom}

for line in sys.stdin:
    try:
        req = json.loads(line)
        res = dict(ok=True, result=OPS[req["op"]](req))
    except Exception as e:                                               # report, keep serving
        res = dict(ok=False, error=f"{type(e).__name__}: {e}", trace=traceback.format_exc(limit=6))
    OUT.write(json.dumps(res) + "\n")
    OUT.flush()
