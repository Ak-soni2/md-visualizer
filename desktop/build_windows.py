"""Build the Windows installer of NanoCut (PLAN_PHASE3.md §5).

    .venv\\Scripts\\python desktop\\build_windows.py            -> dist\\NanoCut-Setup-<version>.exe, dist\\NanoCut-portable-<version>.zip

Offline: everything comes from this computer.
  python/   a copy of the CPython the project .venv was made from (python.exe, DLLs, Lib, tcl for the file dialogs) with the
            packages the web workstation needs copied from .venv into Lib/site-packages (the dependency closure of
            webapp/backend/requirements.txt + numpy/pandas; Streamlit and pip are left out), plus the Visual C++ runtime
            DLLs next to python.exe (app-local deployment, so a PC without the VC++ redistributable works);
  app/      nanocut/, webapp/ (no backups), potentials/, reference/ (no Manual.pdf), examples/, tools/, docs;
  NanoCut.exe  the launcher (desktop/launcher/NanoCut.cs), compiled with the .NET Framework csc.exe of Windows.
The installer stub (desktop/installer/Setup.cs) gets that folder appended as a ZIP.
"""
import argparse
import importlib.metadata as md
import os
import re
import shutil
import struct
import subprocess
import sys
import time
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "build" / "desktop"
DIST = ROOT / "dist"
CSC = Path(os.environ.get("WINDIR", r"C:\Windows")) / "Microsoft.NET" / "Framework64" / "v4.0.30319" / "csc.exe"
NEEDED = ["fastapi", "uvicorn", "numpy", "pandas", "ovito", "openpyxl", "paramiko", "matplotlib", "httpx"]
VC_DLLS = ["msvcp140.dll", "msvcp140_1.dll", "msvcp140_2.dll", "vcruntime140.dll", "vcruntime140_1.dll", "concrt140.dll"]
LIB_SKIP = {"site-packages", "test", "idlelib", "turtledemo", "ensurepip", "__pycache__", "lib2to3"}
APP_DIRS = ["nanocut", "webapp", "potentials", "reference", "examples", "tools"]
APP_FILES = ["BIBLE.md", "PLAN.md", "PLAN_PHASE3.md", "README.md", "SETUP.md", "VERIFICATION_REPORT.md", "requirements.txt", "make_decks.py"]
SKIP_PARTS = {"__pycache__", "backups", ".vercel", "node_modules", ".git"}


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def version():
    v = re.search(r'__version__ = "([^"]+)"', (ROOT / "webapp" / "backend" / "app" / "__init__.py").read_text()).group(1)
    return f"{v}.{time.strftime('%Y%m%d')}"


def closure(names):
    """Distributions needed by `names` (with their requirements, extras ignored, environment markers evaluated)."""
    from packaging.requirements import Requirement
    seen, todo = {}, list(names)
    while todo:
        n = re.split(r"[\s;\[<>=!~]", todo.pop())[0].lower().replace("_", "-")
        if n in seen:
            continue
        try:
            d = md.distribution(n)
        except md.PackageNotFoundError:
            continue
        seen[n] = d
        for r in d.requires or []:
            req = Requirement(r)
            if req.marker and not req.marker.evaluate({"extra": ""}):
                continue
            todo.append(req.name)
    return seen


def copy_tree(src, dst, skip=SKIP_PARTS):
    for p in src.rglob("*"):
        rel = p.relative_to(src)
        if any(part in skip for part in rel.parts) or p.suffix in (".pyc",):
            continue
        t = dst / rel
        if p.is_dir():
            t.mkdir(parents=True, exist_ok=True)
        else:
            t.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(p, t)


def stage():
    base = Path(sys.base_prefix)
    if BUILD.exists():
        shutil.rmtree(BUILD)
    app, py = BUILD / "NanoCut" / "app", BUILD / "NanoCut" / "python"
    py.mkdir(parents=True)
    log("python runtime from", base)
    for f in base.iterdir():
        if f.is_file() and f.suffix.lower() in (".exe", ".dll") or f.name in ("LICENSE.txt",):
            shutil.copy2(f, py / f.name)
    copy_tree(base / "DLLs", py / "DLLs")
    if (base / "tcl").is_dir():
        copy_tree(base / "tcl", py / "tcl")
    (py / "Lib").mkdir()
    for f in (base / "Lib").iterdir():
        if f.name in LIB_SKIP:
            continue
        (copy_tree(f, py / "Lib" / f.name) if f.is_dir() else shutil.copy2(f, py / "Lib" / f.name))
    sysdir = Path(os.environ.get("WINDIR", r"C:\Windows")) / "System32"
    for dll in VC_DLLS:
        if not (py / dll).exists() and (sysdir / dll).exists():
            shutil.copy2(sysdir / dll, py / dll)
    log("packages")
    sp = py / "Lib" / "site-packages"
    sp.mkdir()
    dists = closure(NEEDED)
    for name, d in sorted(dists.items()):
        for f in d.files or []:
            src = Path(d.locate_file(f))
            if not src.is_file() or "__pycache__" in f.parts or src.suffix == ".pyc":
                continue
            try:
                rel = src.resolve().relative_to(Path(sys.prefix).resolve() / "Lib" / "site-packages")
            except ValueError:
                continue                                         # console scripts in Scripts/: not needed
            t = sp / rel
            t.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, t)
    log(f"{len(dists)} distributions:", ", ".join(sorted(dists)))
    log("application")
    for d in APP_DIRS:
        copy_tree(ROOT / d, app / d)
    for f in APP_FILES:
        if (ROOT / f).exists():
            shutil.copy2(ROOT / f, app / f)
    (app / "desktop.txt").write_text(f"NanoCut desktop build {version()} (built {time.strftime('%Y-%m-%d %H:%M')})\n")
    return BUILD / "NanoCut"


def make_icon(path):
    from PIL import Image, ImageDraw
    big = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
    g = ImageDraw.Draw(big)
    g.rounded_rectangle((8, 8, 248, 248), 48, fill=(24, 32, 44, 255))
    for i, (x, y) in enumerate([(70, 170), (128, 170), (186, 170), (99, 120), (157, 120), (70, 70), (128, 70)]):
        g.ellipse((x - 22, y - 22, x + 22, y + 22), fill=(232, 182, 72, 255) if i < 5 else (90, 170, 230, 255))
    g.polygon([(150, 30), (230, 30), (230, 140), (175, 120)], fill=(220, 90, 90, 255))
    big.save(path, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])


def csc(out, src, icon, target="winexe"):
    if not CSC.exists():
        sys.exit(f"csc.exe not found at {CSC} (.NET Framework 4 is part of Windows 10/11)")
    cmd = [str(CSC), "/nologo", "/optimize+", f"/target:{target}", "/platform:anycpu", f"/out:{out}", f"/win32icon:{icon}",
           "/r:System.Windows.Forms.dll", "/r:System.Drawing.dll", "/r:System.IO.Compression.dll", "/r:System.IO.Compression.FileSystem.dll", str(src)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode:
        sys.exit(f"csc failed for {src.name}:\n{r.stdout}\n{r.stderr}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-portable", action="store_true", help="skip the portable ZIP")
    a = ap.parse_args()
    v = version()
    t0 = time.time()
    root = stage()
    icon = BUILD / "nanocut.ico"
    make_icon(icon)
    log("compile launcher and installer")
    csc(root / "NanoCut.exe", ROOT / "desktop" / "launcher" / "NanoCut.cs", icon)
    stub = BUILD / "Setup-stub.exe"
    csc(stub, ROOT / "desktop" / "installer" / "Setup.cs", icon)
    shutil.copy2(icon, root / "nanocut.ico")
    log("package (ZIP)")
    payload = BUILD / "payload.zip"
    n = 0
    with zipfile.ZipFile(payload, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for p in sorted(root.rglob("*")):
            if p.is_file():
                z.write(p, p.relative_to(root).as_posix())
                n += 1
    DIST.mkdir(exist_ok=True)
    setup = DIST / f"NanoCut-Setup-{v}.exe"
    with open(setup, "wb") as out:
        out.write(stub.read_bytes())
        off = out.tell()
        with open(payload, "rb") as f:
            shutil.copyfileobj(f, out, 16 << 20)
        ln = out.tell() - off
        out.write(b"NCPAYLD1" + struct.pack("<qq", off, ln))
    log(f"installer {setup} ({setup.stat().st_size / 1e6:.0f} MB, {n} files)")
    if not a.no_portable:
        port = DIST / f"NanoCut-portable-{v}.zip"
        with zipfile.ZipFile(port, "w", zipfile.ZIP_STORED) as z, zipfile.ZipFile(payload) as src:
            for i in src.infolist():                             # same files under a NanoCut/ folder
                z.writestr(zipfile.ZipInfo(f"NanoCut/{i.filename}", i.date_time), src.read(i), zipfile.ZIP_DEFLATED, 6)
        log(f"portable  {port} ({port.stat().st_size / 1e6:.0f} MB)")
    log(f"done in {time.time() - t0:.0f} s")


if __name__ == "__main__":
    main()
