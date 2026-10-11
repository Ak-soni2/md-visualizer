r"""Assemble the Vercel deployment in build/vercel, then deploy it:

    .venv\Scripts\python webapp\tools\stage_vercel.py
    cd build\vercel && npx vercel deploy --prod

The whole application runs in one container (Vercel container runtime, Dockerfile.vercel): the FastAPI backend with
the official OVITO module (and the system libraries its Qt/Vulkan renderer needs, with Mesa's CPU Vulkan driver since
there is no GPU), the frontend it serves at /app, and the bundled data. Vercel builds the image; nothing is built here.
Project settings it relies on: VERCEL_SUPPORT_LARGE_FUNCTIONS=1 (image > 500 MB) and the private Blob store
(BLOB_READ_WRITE_TOKEN) for uploads and results.

Only copies are made; nothing in the project or in C:\BTP\Cutting is changed. Bundled: engine, potentials, reference
notes, run folders with their dumps (except runs/smoke3, 413 MB, and restart files), the reference decks' text files.
"""
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
REFERENCE = Path(r"C:\BTP\Cutting")
OUT = ROOT / "build" / "vercel"
SKIP_RUNS = {"smoke3"}
IGNORE = shutil.ignore_patterns("__pycache__", "*.pyc", "*.restart", ".vercel", ".gitignore", ".vercelignore", "backups", ".env*")

DOCKERFILE = """FROM python:3.12-slim
# libraries OVITO's Qt-based binaries load; Mesa's lavapipe provides the Vulkan device OVITO renders with (no GPU here)
RUN apt-get update && apt-get install -y --no-install-recommends \\
      libgl1 libegl1 libopengl0 libglib2.0-0 libfontconfig1 libfreetype6 libxkbcommon0 libdbus-1-3 \\
      libgssapi-krb5-2 libgomp1 libx11-6 libx11-xcb1 libxcb1 libxext6 libxrender1 libsm6 libice6 \\
      libvulkan1 mesa-vulkan-drivers libgl1-mesa-dri libegl-mesa0 \\
      libxcb-cursor0 libxcb-icccm4 libxcb-image0 libxcb-keysyms1 libxcb-randr0 libxcb-render-util0 libxcb-shape0 libxcb-xinerama0 libxcb-xkb1 libxkbcommon-x11-0 \\
    && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir ovito==3.16.0 "fastapi>=0.115,<1" "uvicorn>=0.30" "numpy>=2" "pandas>=2.2" "openpyxl>=3.1" "paramiko>=3.4"
# fail the build (not the first request) if OVITO cannot be imported
RUN python -c "import ovito; from ovito.vis import TachyonRenderer; print('OVITO', ovito.version_string)"
WORKDIR /app
COPY . /app
ENV NANOCUT_PROJECT_ROOT=/app NANOCUT_REFERENCE_ROOT=/app/data/Cutting NANOCUT_STUDIO_ROOTS=/app NANOCUT_HOSTED=1 NANOCUT_CORS_ORIGINS=*
CMD ["sh", "-c", "uvicorn webapp.backend.app.main:app --host 0.0.0.0 --port ${PORT:-80} --proxy-headers --forwarded-allow-ips='*'"]
"""

VERCEL_JSON = {
    "$schema": "https://openapi.vercel.sh/vercel.json",
    "services": {"app": {"root": ".", "entrypoint": "Dockerfile.vercel"}},
    "rewrites": [{"source": "/(.*)", "destination": {"service": "app"}}],
}


def copy(src, dst):
    dst.parent.mkdir(parents=True, exist_ok=True)
    (shutil.copytree(src, dst, ignore=IGNORE) if src.is_dir() else shutil.copy2(src, dst))


def main():
    link = OUT / ".vercel" / "project.json"
    keep = link.read_text() if link.exists() else None
    OUT.mkdir(parents=True, exist_ok=True)
    for p in OUT.iterdir():                       # empty it (the folder itself may be a shell's working directory)
        shutil.rmtree(p) if p.is_dir() else p.unlink()
    copy(ROOT / "webapp", OUT / "webapp")
    for name in ("nanocut", "tools", "potentials", "reference", "examples", "ui"):
        copy(ROOT / name, OUT / name)
    for f in ROOT.glob("*"):                      # documents shown in the explorer (not requirements.txt: the image has its own)
        if f.is_file() and f.suffix in (".md", ".py"):
            copy(f, OUT / f.name)
    for run in (ROOT / "runs").iterdir():
        if run.is_dir() and run.name not in SKIP_RUNS:
            copy(run, OUT / "runs" / run.name)
    if REFERENCE.exists():
        for case in sorted(p for p in REFERENCE.iterdir() if p.is_dir()):
            for f in case.iterdir():
                if f.is_file() and f.suffix == ".txt":
                    copy(f, OUT / "data" / "Cutting" / case.name / f.name)
    (OUT / "Dockerfile.vercel").write_text(DOCKERFILE, newline="\n")
    (OUT / "vercel.json").write_text(json.dumps(VERCEL_JSON, indent=2))
    proj = keep or ((ROOT / "webapp" / "frontend" / ".vercel" / "project.json").read_text()
                    if (ROOT / "webapp" / "frontend" / ".vercel" / "project.json").exists() else None)
    if proj:
        link.parent.mkdir(exist_ok=True)
        link.write_text(proj)
    size = sum(p.stat().st_size for p in OUT.rglob("*") if p.is_file())
    print(f"staged {OUT}  ({size / 1e6:.0f} MB of application and data; Vercel builds the image)")


if __name__ == "__main__":
    main()
