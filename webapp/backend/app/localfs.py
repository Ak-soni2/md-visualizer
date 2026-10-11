"""Files on this computer, used where they are (local backend only).

A browser never reveals the path of a file it opens, so "uploading" would copy every dump. Because the local backend
runs on the user's own computer, it can instead show the operating system's file/folder dialog itself (tkinter, in a
short-lived subprocess so it never blocks the server) and return the chosen path; OVITO then reads the dumps in place
and nothing is copied. The same dialog picks where a ZIP export is written, so it is not built in a temporary folder
first. A plain folder lister is the fallback when no dialog can be shown. Refused when hosted.
"""
import json
import os
import string
import subprocess
import sys
from pathlib import Path

from fastapi import APIRouter, Body, HTTPException, Request

from .settings import HOSTED

router = APIRouter(prefix="/api/local", tags=["local files"])

DIALOG = r"""
import json, sys, tkinter as tk
from tkinter import filedialog
kind, title, start, name = sys.argv[1:5]
root = tk.Tk(); root.withdraw(); root.attributes("-topmost", True); root.update()
opts = dict(parent=root, title=title, initialdir=start or None)
if kind == "folder":
    r = filedialog.askdirectory(mustexist=True, **opts)
elif kind == "files":
    r = list(filedialog.askopenfilenames(filetypes=[("LAMMPS dumps", "*.lammpstrj *.dump *.lammpstrj.gz *.dump.gz *.atom"), ("All files", "*.*")], **opts))
else:
    r = filedialog.asksaveasfilename(initialfile=name, defaultextension=".zip", filetypes=[("ZIP archive", "*.zip")], **opts)
root.destroy()
print(json.dumps(r))
"""


def _guard(request):
    if HOSTED:
        raise HTTPException(403, "only with a local backend (START.bat)")
    host = request.client.host if request.client else ""
    if host not in ("127.0.0.1", "::1", "localhost", "testclient"):
        raise HTTPException(403, "file dialogs are shown only to the computer the backend runs on")


@router.post("/pick")
def pick(request: Request, body: dict = Body(...)):
    """{kind: folder | files | save, start?, name?} -> {path | paths | null}. Opens the system dialog on this computer."""
    _guard(request)
    kind = body.get("kind")
    if kind not in ("folder", "files", "save"):
        raise HTTPException(422, "kind must be folder, files or save")
    start = str(body.get("start") or "")
    start = start if start and os.path.isdir(start) else str(Path.home())
    title = {"folder": "Folder with LAMMPS dump files", "files": "LAMMPS dump file(s)", "save": "Save the ZIP as"}[kind]
    try:
        p = subprocess.run([sys.executable, "-c", DIALOG, kind, title, start, str(body.get("name") or "export.zip")],
                           capture_output=True, text=True, timeout=1800, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        res = json.loads(p.stdout.strip() or "null")
    except Exception as e:
        raise HTTPException(501, f"no file dialog available ({e}); type or paste the path instead")
    if p.returncode:
        raise HTTPException(501, f"no file dialog available: {p.stderr.strip()[-300:]}")
    if kind == "files":
        return dict(paths=[str(Path(x)) for x in res or []])
    return dict(path=str(Path(res)) if res else None)


@router.get("/list")
def listing(request: Request, path: str = ""):
    """Folders (and dump-looking files) of a folder on this computer; drives when no path is given."""
    _guard(request)
    if not path:
        drives = [f"{d}:\\" for d in string.ascii_uppercase if os.path.exists(f"{d}:\\")] if os.name == "nt" else ["/"]
        return dict(path="", parent=None, dirs=drives, files=[])
    p = Path(path)
    if not p.is_dir():
        raise HTTPException(404, f"not a folder: {path}")
    dirs, files = [], []
    try:
        for e in sorted(os.scandir(p), key=lambda e: e.name.lower()):
            if e.name.startswith("."):
                continue
            if e.is_dir(follow_symlinks=False):
                dirs.append(e.name)
            elif e.is_file() and any(x in e.name.lower() for x in (".lammpstrj", ".dump", "dump.", ".atom")):
                files.append(dict(name=e.name, bytes=e.stat().st_size))
    except PermissionError:
        raise HTTPException(403, f"no permission to read {path}")
    parent = str(p.parent) if p.parent != p else ""
    return dict(path=str(p), parent=parent, dirs=dirs[:3000], files=files[:3000])
