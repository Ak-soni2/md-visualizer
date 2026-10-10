# Phase 1: inspection of the existing project (findings)

Date: 2026-10-11. Everything below was inspected on disk, not assumed. Nothing was modified during the inspection.

## 1. What exists

| Area | Location | Role |
|---|---|---|
| Scientific engine | `nanocut/` (schema, materials, potentials, lattice, geometry, deck, analysis, mock, runner, presets) | Builds the model, writes LAMMPS decks A/B, reads dumps / force files, computes metrics. Pure Python + NumPy/pandas. |
| Current UI | `ui/app.py` (Streamlit, 1 file) | Setup forms, geometry preview, deck download, WSL validation, results tab. **Kept unchanged.** |
| CLI | `make_decks.py`, `tools/verify_*.py`, `tools/dump_to_csv.py`, `tools/check_csv_frames.py` | Batch generation and verification scripts. |
| Original inputs (read-only) | `C:\BTP\Cutting\<R>-<d>\A*.txt, B*.txt` (9 cases, `10-10\log.txt`), `potentials/` (LAMMPS-distributed), `Manual.pdf`, `reference/*.md` | Reference decks and sources of truth. |
| Generated data | `runs/` (6 folders with `params.json`), `examples/sample_run/`, `VERIFICATION_REPORT.md`, `reference/*_checks.json` | NanoCut output and runs of its decks. |
| Environment | `.venv` (Python 3.12.10; numpy 2.5.3, pandas 3.0.6, plotly, streamlit, uvicorn) | FastAPI and httpx were missing; installed into the same `.venv`. |

## 2. Local data available to a UI

| Run folder | Frames | Force file | Atoms | Notes |
|---|---|---|---|---|
| `examples/sample_run` | 3 (16 MB each) | yes (50 rows) | 97,815 | reduced-scale 10-10 case, LAMMPS 22 Jul 2025 |
| `runs/smoke3` | 25 | yes | 97,815 | same case, killed before the end (log unfinished) |
| `runs/laser_dump`, `runs/laser_smoke` | 3 each | yes | 97,853 | 300-step laser tests (spot / power) |
| `runs/ref_10_10`, `runs/preview_cut_SiC_R10_d10` | 0 | no | 1,992,061 / 159,863 | decks only |

Full-size production dumps live on the cluster and on `D:\Akshay` (external disk, ~300 MB per frame); they are not part of this project folder. The API is built to read them one frame at a time if a run folder points at them.

## 3. Findings that shaped the design

1. **The engine can be reused as-is.** Every view maps to an existing function: `geometry.Model` + `deck.model_summary` (overview, counts), `deck.deck_a/deck_b` (decks), `analysis.read_avetime/force_summary/metrics/Frame` (analysis), `mock.mock_frames` (schematic). Only thin adapters were written (`webapp/backend/app/`).
2. **`ui/app.py` cannot be imported** (Streamlit runs on import), so `soft_warnings()` was restated in `webapp/backend/app/advice.py` against a model summary instead of moving it; `ui/app.py` stays untouched.
3. **Older run folders were generated with an earlier tool-gap convention.** Recomputing their geometry today gives 38–88 atoms more or fewer (e.g. 97,853 vs 97,815 stored). Their decks and dumps agree with each other, so the API uses the *stored* model of a run and marks recomputed previews and validation with a warning.
4. **Older `params.json` files lack newer inputs** (`laser`, `boundary_*`). The API fills them with schema defaults and the Parameters view labels them "not recorded in this params.json".
5. **LAMMPS dumps change atom order between frames**; the frame endpoint sorts by atom id and sub-samples by id, so playback shows the same atoms every frame.
6. **Reference decks use lattice units and `if/elif` potential selection**; the parser converts them with the existing `tools/verify_decks.parse_ref` and reads the selected potential from `variable potential`.
7. **Validation must separate parsing from science.** Example: reference 10-10 parses fine but equilibrates with Erhart–Albe and cuts with Tersoff-1994; its B deck declares `s p s` while A uses `s s p`. Reference 10-20 has an empty `A.txt` (parsing error).
8. **Expensive operations** (2-million-atom model enumeration, schematic animation, per-frame metrics, deck generation, validation of everything) take 1–60 s; they run as background jobs with progress, never inside a request.

## 4. Decisions

- FastAPI backend in `webapp/backend`, vanilla ES-module frontend in `webapp/frontend` (no build step, no CDN, works offline).
- Own canvas renderers (atoms and plots) instead of external libraries: no downloads, fully themable, and the viewer exposes a small interface (`setAtoms/setOverlays/setView/fit/onHover`) so the existing MD renderer or a WebGL engine can replace it later.
- Strictly read-only towards existing data; deck generation returns text to the browser.
- Offline demo fixtures (snapshot of real API responses for the sample run) for a frontend deployed without backend, labelled as such.
