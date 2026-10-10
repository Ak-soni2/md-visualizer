"""Paths and limits. Everything the API may read lives under ALLOWED_ROOTS; nothing is ever written there."""
import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(os.environ.get("NANOCUT_PROJECT_ROOT", Path(__file__).resolve().parents[3]))
REFERENCE_ROOT = Path(os.environ.get("NANOCUT_REFERENCE_ROOT", r"C:\BTP\Cutting"))
FRONTEND_DIR = Path(__file__).resolve().parents[2] / "frontend"

# reuse the existing scientific engine without copying it
for p in (PROJECT_ROOT, PROJECT_ROOT / "tools"):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

ALLOWED_ROOTS = [PROJECT_ROOT.resolve()] + ([REFERENCE_ROOT.resolve()] if REFERENCE_ROOT.exists() else [])
HIDDEN_NAMES = {".git", ".venv", "__pycache__", ".claude", "node_modules", "backups"}
RUN_SEARCH_DIRS = [PROJECT_ROOT / "runs", PROJECT_ROOT / "examples"]

TEXT_SUFFIXES = {".in", ".txt", ".md", ".json", ".log", ".sh", ".bat", ".py", ".tersoff", ".sw", ".csv"}
IMAGE_SUFFIXES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml"}
MAX_TEXT_BYTES = 2_000_000          # source viewer limit; dumps and trajectories are never sent as text
MAX_DUMP_BYTES = 800_000_000        # refuse to parse a single dump frame larger than this in a request
DEFAULT_MAX_ATOMS = 60_000          # atoms sent to the browser per frame unless asked otherwise

CORS_ORIGINS = [o.strip() for o in os.environ.get("NANOCUT_CORS_ORIGINS", "http://localhost:8600,http://127.0.0.1:8600").split(",") if o.strip()]


def safe_path(path_str):
    """Resolve a user-supplied path and refuse anything outside ALLOWED_ROOTS or inside hidden folders."""
    p = Path(path_str)
    if not p.is_absolute():
        p = PROJECT_ROOT / p
    p = p.resolve()
    if not any(p == r or r in p.parents for r in ALLOWED_ROOTS):
        raise PermissionError("path outside the project and reference folders")
    if any(part in HIDDEN_NAMES for part in p.parts):
        raise PermissionError("hidden folder")
    return p


def rel(p):
    """Display path: relative to the project root when possible, else absolute with forward slashes."""
    p = Path(p).resolve()
    try:
        return p.relative_to(PROJECT_ROOT.resolve()).as_posix()
    except ValueError:
        return p.as_posix()
