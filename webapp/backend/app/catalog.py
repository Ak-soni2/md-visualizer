"""Discover what can be shown: original reference decks, NanoCut-generated run folders, built-in presets.

Classification (shown everywhere in the UI):
  original  - files the researcher wrote / LAMMPS distributed (reference decks in C:/BTP/Cutting, potentials/,
              Manual.pdf). Read-only for the API.
  generated - written by NanoCut or by runs of its decks (runs/*, examples/*, VERIFICATION_REPORT.md, ...).
  preset    - built-in configuration in nanocut/presets.py; no files, values computed on request.
"""
import glob
import json
import os
import re
import time
from pathlib import Path

from nanocut.presets import PRESETS

from . import dumps
from .settings import PROJECT_ROOT, REFERENCE_ROOT, RUN_SEARCH_DIRS, rel

ROLE_RULES = [
    (re.compile(r"^A(_.*)?\.(in|txt)$", re.I), "deck_A"),
    (re.compile(r"^B(_.*)?\.(in|txt)$", re.I), "deck_B"),
    (re.compile(r"\.lammpstrj$"), "dump"),
    (re.compile(r"_forces_temps\.txt$"), "forces"),
    (re.compile(r"^params\.json$"), "params"),
    (re.compile(r"\.restart$"), "restart"),
    (re.compile(r"\.(log)$|^log\.txt$|^log\.lammps$"), "log"),
    (re.compile(r"\.(png|jpg|jpeg|svg)$", re.I), "image"),
    (re.compile(r"\.(tersoff|sw|eam|alloy|fs|vashishta|zbl)$"), "potential"),
    (re.compile(r"^README\.md$"), "readme"),
    (re.compile(r"\.(sh|bat)$"), "script"),
]


def role_of(name):
    for rx, role in ROLE_RULES:
        if rx.search(name):
            return role
    return "other"


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def _files(folder, origin):
    out = []
    for p in sorted(Path(folder).iterdir()):
        if p.is_file():
            out.append(dict(name=p.name, path=rel(p), bytes=p.stat().st_size, role=role_of(p.name), origin=origin,
                            modified=p.stat().st_mtime))
    return out


def _preset_for_case(case):
    for k in PRESETS:
        if k.startswith("ref_") and f"(Cutting/{case})" in k:
            return k
    return None


_cache = {"t": 0, "sims": None}


def scan(force=False):
    if _cache["sims"] is not None and not force and time.time() - _cache["t"] < 30:
        return _cache["sims"]
    sims = {}
    # 1. original reference decks
    if REFERENCE_ROOT.exists():
        for d in sorted(p for p in REFERENCE_ROOT.iterdir() if p.is_dir()):
            files = _files(d, "original")
            decks = [f for f in files if f["role"] in ("deck_A", "deck_B")]
            if not decks:
                continue
            case = d.name
            sid = "ref-" + slug(case)
            sims[sid] = dict(id=sid, kind="reference", origin="original", label=f"Reference deck {case}",
                             path=rel(d), case=case, preset=_preset_for_case(case), files=files,
                             note="Original A/B input decks (read-only). Values in lattice units are converted by the parser.")
    # 2. NanoCut-generated run folders (any folder with params.json)
    for base in RUN_SEARCH_DIRS:
        if not base.exists():
            continue
        for d in sorted(p for p in base.iterdir() if p.is_dir()):
            pj = d / "params.json"
            if not pj.exists():
                continue
            try:
                params = json.loads(pj.read_text())
            except Exception as e:
                params = {"_error": str(e)}
            files = _files(d, "generated")
            dl, _ = dumps.list_dumps(str(d))
            sid = ("example-" if base.name == "examples" else "run-") + slug(d.name)
            exp = params.get("experiment", {})
            sims[sid] = dict(id=sid, kind="run", origin="generated", label=rel(d), experiment_name=exp.get("name"), path=rel(d),
                             folder=d.name, files=files, n_frames=len(dl),
                             has_series=any(f["role"] == "forces" for f in files),
                             note="Run folder written by NanoCut (decks, params.json) plus any LAMMPS output found in it.")
    # 3. built-in presets
    for name, exp in PRESETS.items():
        sid = "preset-" + slug(name)
        sims[sid] = dict(id=sid, kind="preset", origin="preset", label=name, path=None, preset=name, files=[],
                         note=getattr(exp, "__dict__", {}).get("note", "") or "Built-in NanoCut configuration (no files).")
    _cache.update(t=time.time(), sims=sims)
    return sims


def get(sid):
    sims = scan()
    if sid not in sims:
        sims = scan(force=True)
    return sims.get(sid)


def experiment_dict(sim):
    """Experiment parameters as a dict (params.json for runs, preset for presets and references) or None."""
    if sim["kind"] == "run":
        pj = PROJECT_ROOT / sim["path"] / "params.json"
        try:
            raw = json.loads(pj.read_text()).get("experiment")
        except Exception:
            return None
        if raw is None:
            return None
        # older params.json files predate some inputs (laser, boundary): fill them with the schema defaults the
        # decks of that time used. The Parameters view labels such values as "not recorded in params.json".
        from nanocut.schema import Experiment
        return Experiment.from_dict(raw).to_dict()
    name = sim.get("preset")
    return PRESETS[name].to_dict() if name in PRESETS else None


def params_json(sim):
    if sim["kind"] != "run":
        return None
    try:
        return json.loads((PROJECT_ROOT / sim["path"] / "params.json").read_text())
    except Exception:
        return None


def tree(root=None, depth=3, max_entries=60):
    """Verified directory structure with origin classification; big folders are summarised, never listed in full."""
    from .settings import HIDDEN_NAMES, safe_path
    base = safe_path(root) if root else PROJECT_ROOT

    def classify(p):
        r = rel(p)
        if str(p).startswith(str(REFERENCE_ROOT)):
            return "original"
        top = r.split("/")[0]
        if top in ("runs", "examples") or r in ("VERIFICATION_REPORT.md",):
            return "generated"
        if top in ("potentials", "reference") or r == "Manual.pdf":
            return "original"
        if top in ("nanocut", "ui", "tools", "tests", "webapp") or p.suffix in (".py", ".bat", ".sh"):
            return "code"
        return "document"

    def walk(p, level):
        node = dict(name=p.name or str(p), path=rel(p), type="dir" if p.is_dir() else "file", origin=classify(p))
        if p.is_file():
            node["bytes"] = p.stat().st_size
            node["role"] = role_of(p.name)
            return node
        try:
            kids = sorted(p.iterdir(), key=lambda q: (not q.is_dir(), q.name.lower()))
        except PermissionError:
            node["error"] = "permission denied"
            return node
        kids = [k for k in kids if k.name not in HIDDEN_NAMES]
        node["count"] = len(kids)
        if level >= depth:
            node["truncated"] = True
            return node
        shown = kids[:max_entries]
        node["children"] = [walk(k, level + 1) for k in shown]
        if len(kids) > len(shown):
            node["more"] = len(kids) - len(shown)
        return node

    out = walk(base, 0)
    out["name"] = base.name
    return out
