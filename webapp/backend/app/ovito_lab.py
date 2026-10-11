"""OVITO page API: runs the official OVITO Python module (pip package `ovito`) in one long-lived worker process.

All analysis and rendering on this page is done by OVITO itself; this module only starts the worker, passes it the
page settings, and serves the images and exports it writes into a temporary folder (never into the project or the
data folders). Long operations run as background jobs.
"""
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path

import numpy as np
from fastapi import APIRouter, Body, HTTPException
from fastapi.responses import FileResponse

from . import jobs, ovito_script, studio

router = APIRouter(prefix="/api/ovito", tags=["ovito"])
WORKER = Path(__file__).resolve().parents[1] / "ovito_worker.py"
OUT_DIR = Path(tempfile.gettempdir()) / "nanocut_ovito"
OUT_DIR.mkdir(exist_ok=True)
KEEP_FILES = 60
TIMEOUT_S = float(os.environ.get("NANOCUT_OVITO_TIMEOUT", "1800"))
EXPORT_FORMATS = {"lammps/dump": ".dump", "xyz": ".xyz", "lammps/data": ".data", "vasp": ".poscar"}


class _Worker:
    """One OVITO process; requests are serialised (OVITO keeps the loaded frame cached between them)."""

    def __init__(self):
        self.proc, self.lock, self.info = None, threading.Lock(), None

    def _start(self):
        self.proc = subprocess.Popen([sys.executable, str(WORKER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.DEVNULL, text=True, encoding="utf-8",
                                     creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        self.info = self._send({"op": "hello"}, 120)

    def _send(self, req, timeout):
        self.proc.stdin.write(json.dumps(req) + "\n")
        self.proc.stdin.flush()
        box = {}
        t = threading.Thread(target=lambda: box.setdefault("line", self.proc.stdout.readline()), daemon=True)
        t.start()
        t.join(timeout)
        if "line" not in box or not box["line"]:
            self.stop()
            raise RuntimeError("the OVITO worker did not answer (timed out or crashed); it will be restarted on the next request")
        res = json.loads(box["line"])
        if not res.get("ok"):
            raise RuntimeError(res.get("error", "OVITO error"))
        return res["result"]

    def ask(self, req, timeout=TIMEOUT_S):
        with self.lock:
            if self.proc is None or self.proc.poll() is not None:
                self._start()
            return self._send(req, timeout)

    def stop(self):
        if self.proc and self.proc.poll() is None:
            self.proc.kill()
        self.proc = None


worker = _Worker()


def _prune():
    files = sorted(OUT_DIR.glob("*"), key=lambda p: p.stat().st_mtime)
    for p in files[:-KEEP_FILES]:
        try:
            p.unlink()
        except OSError:
            pass


def _source(body):
    """{path, pattern?} -> OVITO import path (wildcard sequence or one file scanned for all its frames)."""
    try:
        p = studio.resolve(body.get("path"))
    except Exception as e:
        raise HTTPException(404 if isinstance(e, FileNotFoundError) else 403 if isinstance(e, PermissionError) else 422, str(e))
    pattern = body.get("pattern")
    if p.is_file():
        if not studio.is_dump(p):
            raise HTTPException(422, "not a LAMMPS text dump")
        return dict(import_path=str(p), multiple_frames=True, label=p.name)
    if not pattern or "/" in pattern or "\\" in pattern:
        raise HTTPException(422, "pattern (file name or wildcard) required for a folder")
    full = p / pattern
    single = "*" not in pattern
    return dict(import_path=str(full), multiple_frames=single, label=f"{p.name}/{pattern}")


@router.get("/status")
def status():
    """Starts the OVITO worker if needed and reports the OVITO version (the first call takes a few seconds)."""
    if os.environ.get("VERCEL"):
        return dict(available=False, hosted=True, error="OVITO (about 400 MB with its Qt libraries) does not fit a Vercel "
                    "function; this page works when the backend runs on a computer with OVITO installed.",
                    install=r".venv\Scripts\python -m pip install ovito")
    try:
        info = worker.ask({"op": "hello"}, 120)
        return dict(available=True, ovito=info["ovito"], python=sys.version.split()[0])
    except Exception as e:
        return dict(available=False, error=str(e), install=r".venv\Scripts\python -m pip install ovito")


@router.post("/info")
def info(body: dict = Body(...)):
    src = _source(body)
    frame = int(body.get("frame", 0))
    key = f"ovito-info:{src['import_path']}:{frame}:{body.get('refresh', 0)}"
    return _job(key, "OVITO reads the trajectory", lambda progress=None: dict(source=src, **worker.ask({"op": "info", "frame": frame, **src})))


def _spec(body):
    spec = body.get("spec") or {}
    src = _source(spec.get("source") or {})
    spec = dict(spec, source=src)
    ovito_script.build(spec)                     # validates every value; raises ValueError with a readable message
    return spec


@router.post("/script")
def script(body: dict = Body(...)):
    """The OVITO Python script for the current settings (as run by the worker, with import_file instead of the cache)."""
    try:
        spec = _spec(body)
        return dict(script=ovito_script.build(spec, image_path="nanocut_ovito.png"))
    except ValueError as e:
        raise HTTPException(422, str(e))


@router.post("/render")
def render(body: dict = Body(...)):
    try:
        spec = _spec(body)
    except ValueError as e:
        raise HTTPException(422, str(e))
    digest = hashlib.sha1(json.dumps(spec, sort_keys=True).encode()).hexdigest()[:16]
    image = OUT_DIR / f"render_{digest}.png"
    key = f"ovito-render:{digest}"
    rec = jobs.by_key(key)
    if rec and rec["status"] == "done" and not image.exists():
        jobs.forget(key)

    def run(progress=None):
        res = worker.ask({"op": "run", "spec": spec, "image_path": str(image)})
        _prune()
        return dict(image=image.name, bytes=image.stat().st_size, script=ovito_script.build(spec, image_path=image.name), **res)
    return _job(key, "OVITO renders the image", run)


@router.post("/export")
def export(body: dict = Body(...)):
    try:
        spec = _spec(body)
    except ValueError as e:
        raise HTTPException(422, str(e))
    fmt = body.get("format", "lammps/dump")
    if fmt not in EXPORT_FORMATS:
        raise HTTPException(422, f"format must be one of {', '.join(EXPORT_FORMATS)}")
    cols = [c for c in body.get("columns") or [] if isinstance(c, str) and ovito_script.PROPERTY_RE.match(c)]
    if fmt in ("lammps/dump", "xyz") and not cols:
        raise HTTPException(422, "choose at least one column to export")
    name = f"export_{uuid.uuid4().hex[:10]}{EXPORT_FORMATS[fmt]}"

    def run(progress=None):
        res = worker.ask({"op": "export", "spec": spec, "path": str(OUT_DIR / name), "format": fmt, "columns": cols})
        _prune()
        return dict(file=name, bytes=res["bytes"])
    return _job(f"ovito-export:{name}", "OVITO exports the data", run)


@router.post("/verify")
def verify(body: dict = Body(...)):
    """Cross-check: OVITO's Displacement vectors vs NanoCut's own dump parser (the Studio) for one frame."""
    src = _source(body)
    frame, ref = int(body.get("frame", 0)), int(body.get("reference", 0))

    def run(progress=None):
        npz = OUT_DIR / f"verify_{uuid.uuid4().hex[:8]}.npz"
        o = worker.ask({"op": "displacements", "frame": frame, "reference": ref, "out": str(npz), **src})
        with np.load(npz) as f:
            z = {k: f[k] for k in f.files}          # copy, so the file can be deleted (Windows)
        directory, pattern = (str(Path(src["import_path"]).parent), Path(src["import_path"]).name)
        s = studio.open_source(directory, pattern)
        meta = studio.load_frame(s["id"], frame, ref)
        n = meta["natoms"]
        raw = np.frombuffer(studio.columns_bytes(s["id"], frame, ["id", "x", "y", "z", "dx", "dy", "dz"], ref), dtype="<f4")
        ids = np.frombuffer(raw[:n].tobytes(), "<u4").astype(np.int64)
        cols = raw[n:].reshape(6, n)
        npz.unlink(missing_ok=True)
        same_ids = len(ids) == len(z["ids"]) and np.array_equal(ids, z["ids"])
        out = dict(frame=frame, reference=ref, step_ovito=o["step"], step_nanocut=meta["step"], atoms_ovito=int(len(z["ids"])),
                   atoms_nanocut=int(n), same_atom_ids=bool(same_ids))
        if same_ids:
            for k, name in enumerate(("x", "y", "z")):
                out[f"max_diff_position_{name}_A"] = float(np.max(np.abs(cols[k] - z["pos"][:, k])))
            for k, name in enumerate(("dx", "dy", "dz")):
                out[f"max_diff_{name}_A"] = float(np.nanmax(np.abs(cols[3 + k] - z["disp"][:, k])))
                out[f"range_{name}_ovito"] = [float(z["disp"][:, k].min()), float(z["disp"][:, k].max())]
        return out
    return _job(f"ovito-verify:{src['import_path']}:{frame}:{ref}:{time.time():.0f}", "OVITO vs NanoCut cross-check", run)


@router.get("/file/{name}")
def file(name: str):
    p = (OUT_DIR / name).resolve()
    if p.parent != OUT_DIR.resolve() or not p.is_file():
        raise HTTPException(404, "file not found (renders are kept for the latest 60 results)")
    media = "image/png" if p.suffix == ".png" else "application/octet-stream"
    return FileResponse(p, media_type=media, filename=p.name)


def _job(key, label, fn):
    from fastapi.responses import JSONResponse
    rec = jobs.submit(key, label, fn)
    return JSONResponse(jobs.public(rec), status_code=200 if rec["status"] == "done" else 202)
