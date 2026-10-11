"""Assemble a Vercel deployment (frontend + FastAPI backend in one project) in build/vercel, then deploy it:

    .venv\\Scripts\\python webapp\\tools\\stage_vercel.py
    cd build\\vercel && npx vercel deploy --prod

The frontend is served from the CDN (public/), the API runs as one Python function (app.py). Only copies are made;
nothing in the project or in C:\\BTP\\Cutting is changed. What is bundled (Vercel functions have no access to this PC):
the engine, potentials, reference notes, the run folders with their dumps (except runs/smoke3, 413 MB, and restart
files) and the text files of the reference decks (not the 45 GB of dumps in Cutting/5-30).
"""
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
REFERENCE = Path(r"C:\BTP\Cutting")
OUT = ROOT / "build" / "vercel"
SKIP_RUNS = {"smoke3"}
IGNORE = shutil.ignore_patterns("__pycache__", "*.pyc", "*.restart", ".vercel", ".gitignore", ".vercelignore")

APP_PY = '''"""Vercel entrypoint: the NanoCut API with the bundled data folders."""
import os
from pathlib import Path

HERE = Path(__file__).resolve().parent
os.environ.setdefault("NANOCUT_PROJECT_ROOT", str(HERE))
os.environ.setdefault("NANOCUT_REFERENCE_ROOT", str(HERE / "data" / "Cutting"))
os.environ.setdefault("NANOCUT_STUDIO_ROOTS", str(HERE))      # the Studio may only read the bundled dumps
os.environ.setdefault("NANOCUT_CORS_ORIGINS", "*")

from webapp.backend.app.main import app  # noqa: E402,F401
'''

REQUIREMENTS = "fastapi>=0.115\nnumpy>=2.0\npandas>=2.2\n"

VERCEL_JSON = {
    "$schema": "https://openapi.vercel.sh/vercel.json",
    "framework": "fastapi",
    "functions": {"app.py": {"maxDuration": 300, "memory": 2048,
                             "excludeFiles": "{public/**,**/*.png,**/*.pdf,**/__pycache__/**}"}},
    "headers": [
        {"source": "/(.*)\\.(js|css|html)", "headers": [{"key": "Cache-Control", "value": "no-cache"}]},
        {"source": "/fixtures/(.*)", "headers": [{"key": "Cache-Control", "value": "public, max-age=300"}]},
    ],
}


def copy(src, dst):
    dst.parent.mkdir(parents=True, exist_ok=True)
    (shutil.copytree(src, dst, ignore=IGNORE) if src.is_dir() else shutil.copy2(src, dst))


def main():
    link = OUT / ".vercel"
    keep = (link / "project.json").read_text() if (link / "project.json").exists() else None
    OUT.mkdir(parents=True, exist_ok=True)
    for p in OUT.iterdir():                       # empty it (the folder itself may be a shell's working directory)
        shutil.rmtree(p) if p.is_dir() else p.unlink()
    # frontend -> CDN
    copy(ROOT / "webapp" / "frontend", OUT / "public")
    # backend package (the frontend is not bundled into the function)
    for f in ("__init__.py",):
        copy(ROOT / "webapp" / f, OUT / "webapp" / f)
    copy(ROOT / "webapp" / "backend", OUT / "webapp" / "backend")
    # engine, data and documents the API reads
    for name in ("nanocut", "tools", "potentials", "reference", "examples", "ui"):
        copy(ROOT / name, OUT / name)
    for f in ROOT.glob("*"):
        if f.is_file() and f.suffix in (".md", ".py", ".txt"):
            copy(f, OUT / f.name)
    for run in (ROOT / "runs").iterdir():
        if run.is_dir() and run.name not in SKIP_RUNS:
            copy(run, OUT / "runs" / run.name)
    # reference decks: top-level text files of each case only
    if REFERENCE.exists():
        for case in sorted(p for p in REFERENCE.iterdir() if p.is_dir()):
            for f in case.iterdir():
                if f.is_file() and f.suffix == ".txt":
                    copy(f, OUT / "data" / "Cutting" / case.name / f.name)
    (OUT / "app.py").write_text(APP_PY)
    (OUT / "requirements.txt").write_text(REQUIREMENTS)
    (OUT / ".python-version").write_text("3.12\n")
    (OUT / "vercel.json").write_text(json.dumps(VERCEL_JSON, indent=2))
    # same Vercel project as the frontend-only deployment, so the URL stays the same
    proj = keep or ((ROOT / "webapp" / "frontend" / ".vercel" / "project.json").read_text()
                    if (ROOT / "webapp" / "frontend" / ".vercel" / "project.json").exists() else None)
    if proj:
        link.mkdir()
        (link / "project.json").write_text(proj)
    size = sum(p.stat().st_size for p in OUT.rglob("*") if p.is_file() and "public" not in p.relative_to(OUT).parts[:1])
    print(f"staged {OUT}  (function data {size / 1e6:.0f} MB + Python packages)")


if __name__ == "__main__":
    main()
