"""Long-lived OVITO worker process for the NanoCut OVITO page.

Started by webapp/backend/app/ovito_lab.py with the project's Python. Reads one JSON request per line on stdin and
answers one JSON line on the original stdout (OVITO's own console output goes to stderr). Keeping the process alive
lets OVITO keep a loaded trajectory frame cached between renders. Read-only: it only reads dump files and writes
images/exports into the output folder given by the backend.

ops: hello | info {import_path, multiple_frames, frame} | run {spec, image_path} | export {spec, path, format, columns}
     | displacements {import_path, multiple_frames, frame, reference, out} (for the Studio cross-check)
"""
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
    return dict(count=int(p.count), properties=list(p.keys()), stats=stats, types=types,
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


OPS = {"hello": lambda r: dict(ovito=ovito.version_string, pid=os.getpid()), "info": op_info, "run": op_run,
       "export": op_export, "displacements": op_displacements}

for line in sys.stdin:
    try:
        req = json.loads(line)
        res = dict(ok=True, result=OPS[req["op"]](req))
    except Exception as e:                                               # report, keep serving
        res = dict(ok=False, error=f"{type(e).__name__}: {e}", trace=traceback.format_exc(limit=6))
    OUT.write(json.dumps(res) + "\n")
    OUT.flush()
