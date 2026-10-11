"""Long-lived OVITO worker process for the NanoCut OVITO page.

Started by webapp/backend/app/ovito_lab.py with the project's Python. Reads one JSON request per line on stdin and
answers one JSON line on the original stdout (OVITO's own console output goes to stderr). Keeping the process alive
lets OVITO keep a loaded trajectory frame cached between renders. Read-only: it only reads dump files and writes
images/exports into the output folder given by the backend.

ops: hello | info {import_path, multiple_frames, frame} | run {spec, image_path} | export {spec, path, format, columns}
     | displacements {import_path, multiple_frames, frame, reference, out} (for the Studio cross-check)
"""
import hashlib
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

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
from webapp.backend.app import ovito_script  # noqa: E402

_cache = {}                                  # (path, multi) -> pipeline


def cached_pipeline(path, multiple_frames=False):
    key = (path, bool(multiple_frames))
    if key not in _cache:
        if len(_cache) >= 2:
            _cache.pop(next(iter(_cache)))
        _cache[key] = import_file(path, multiple_frames=True) if multiple_frames else import_file(path)
    return _cache[key]


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
    parts = [pos.tobytes(), col.tobytes(), b"\0" * ((-col.nbytes) % 4), rad.tobytes()]
    lines = np.zeros((0, 3), np.float32)
    if data.dislocations is not None and len(data.dislocations.segments):
        segs = []
        for s in data.dislocations.segments:                      # polyline -> pairs of vertices (GL lines)
            pts = np.asarray(s.points, dtype=np.float32)
            if len(pts) > 1:
                segs.append(np.repeat(pts, 2, axis=0)[1:-1])
        lines = np.concatenate(segs) if segs else lines
    parts.append(lines.tobytes())
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
               layout=dict(n=int(P.count), lines=int(len(lines))), seconds=dict(compute=round(t1 - t0, 3), total=round(time.time() - t0, 3)))
    return out


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


OPS = {"hello": lambda r: dict(ovito=ovito.version_string, pid=os.getpid()), "info": op_info, "run": op_run,
       "export": op_export, "displacements": op_displacements, "live": op_live, "atom": op_atom}

for line in sys.stdin:
    try:
        req = json.loads(line)
        res = dict(ok=True, result=OPS[req["op"]](req))
    except Exception as e:                                               # report, keep serving
        res = dict(ok=False, error=f"{type(e).__name__}: {e}", trace=traceback.format_exc(limit=6))
    OUT.write(json.dumps(res) + "\n")
    OUT.flush()
