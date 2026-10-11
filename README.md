# NanoCut — LAMMPS deck generator & visualizer for nanometric cutting / nano-scratching MD

Enter the physical and numerical parameters of a nano-cutting experiment (material, potential, box, layers, tool
geometry, depth, speed, ...) and get the two LAMMPS input decks **A** (build + equilibrate → restart) and **B**
(restart → cut) that follow the structure of the reference decks in `C:\BTP\Cutting`, plus a geometry preview with exact
atom counts, an in-LAMMPS validation, an optional reduced-scale real MD preview, and an OVITO-style results visualizer.

## Start everything (any computer)

Double-click **`START.bat`** (Windows) or run `bash start.sh` (Linux/macOS): it installs what is needed into `.venv` and
opens the web workstation at http://127.0.0.1:8600/app/ (details: `webapp/README.md`).

## Run the Streamlit UI

```bash
pip install -r requirements.txt
streamlit run ui/app.py
```

## Command line

```python
from nanocut.presets import PRESETS
from nanocut.deck import write_run_folder
write_run_folder(PRESETS["ref_10_10 (Cutting/10-10)"], "runs/ref_10_10")   # A.in, B.in, potential, run.sh, params.json, README
```

## Layout

- `nanocut/schema.py` — every parameter (dataclasses, JSON), hard validation
- `nanocut/materials.py`, `nanocut/potentials.py` — material and potential databases (file names, element tokens, citations)
- `nanocut/lattice.py`, `nanocut/geometry.py` — exact atom enumeration and tool/workpiece/layer geometry (single source for decks and preview)
- `nanocut/deck.py` — deck writers A and B, run scripts, README/params provenance
- `nanocut/runner.py` — WSL LAMMPS runner (validate with `run 0`, reduced-scale preview run)
- `nanocut/analysis.py` — dump/log/force-file parsers, temperatures, stresses, pile-up metrics
- `ui/app.py` — Streamlit UI
- `potentials/` — potential files shipped with LAMMPS 22 Jul 2025 (headers carry the citations)
- `reference/` — condensed LAMMPS manual (30 Sep 2026) sections and literature survey used to write every command
- `tests/test_nanocut.py` — golden checks against the reference log (`python -m tests.test_nanocut`)
- `PLAN.md` — phased plan and the list of issues found in the reference decks

## Validation runtime (optional)

Windows `pip install lammps` wheels need MS-MPI; a working runtime lives in WSL Ubuntu: `~/lmpval` (pip `lammps`
wheel + `impi-rt`). The UI uses it automatically when present.
