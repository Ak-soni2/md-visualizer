# Changes

## OVITO page (2026-10-11)

New page "OVITO" (Alt+9). It uses the official OVITO Python module for reading, analysis and rendering. The Visualizer
and Studio are unchanged; git shows no diff in their files.

- Installed `ovito 3.16.0` into the project `.venv`. It added only PySide6-Essentials 6.10.3, shiboken6 6.10.3 and
  traits 7.2.0, and changed no existing package.
- Created:
  - `backend/app/ovito_script.py`: settings to OVITO Python script, with every value validated and passed as a literal.
  - `backend/ovito_worker.py`: the long-lived OVITO process.
  - `backend/app/ovito_lab.py`: `/api/ovito/*` routes, background jobs and a temporary output folder.
  - `frontend/js/views/ovito.js`: the page.
- Modified:
  - `backend/app/main.py`: two lines that register the router.
  - `frontend/js/app.js`, `frontend/js/ui.js`, `frontend/index.html`, `frontend/css/views.css`: navigation entry, icon,
    shortcut and styles.
  - `backend/requirements.txt`, `backend/selfcheck.py` (6 OVITO checks; 47/47 pass), `README.md`.
- Verified: OVITO agrees with NanoCut's parser on the sample run and on the 2-million-atom production frame (see
  README, OVITO page).

## Deck file names (2026-10-11)

The Decks page now downloads `<experiment name>_A.txt` and `<experiment name>_B.txt` instead of `A.in` and `B.in`.
Characters other than letters, digits, `.`, `_` and `-` are replaced by `_`. The Streamlit app already used `.txt`.

## Full deck editor (2026-10-11)

The web Decks page offered only 25 of the parameters; the Streamlit setup tab (still unchanged, `run_ui.bat`) offers all.
The Decks page now has every parameter, with the same choices, help texts and dependent behaviour:
- Material sets a0, the potential and the time steps.
- Potentials are filtered by element.
- The cross term (Morse/ZBL/LJ) appears when the tool needs one, showing the literature Morse sets.
- Fields for the tool shape, deformable tool and laser mode appear only when they apply.

The page also adds live validation, Load/Save params.json and changed-value markers.
- Modified `backend/app/main.py`: added `GET /api/deck-options` and `POST /api/decks/check`, and `POST /api/decks` now
  accepts a full `{experiment}`.
- Rewrote `frontend/js/views/decks.js` and updated `frontend/css/views.css`.
- Added 4 checks to `backend/selfcheck.py` (41/41 pass), including a Cu + Morse + laser-spot + free-boundary deck.

## Studio: OVITO-style viewer for publication images (2026-10-11, after Phase 2)

Created:
- `backend/app/studio.py`: dump discovery by content, wildcard sequences and multi-frame files, frame parsing in
  background jobs with a 3-frame cache, displacement vectors (minimum image), binary column transfer.
- `frontend/js/studio/render.js` (WebGL2 sphere renderer, OVITO standard views, off-screen high-resolution render),
  `frontend/js/studio/pipeline.js` (modifiers, colour gradients), `frontend/js/studio/overlays.js` (legend, tripod,
  labels, dimension lines), `frontend/js/views/studio.js` (the Studio page, pile-up/burr measurement, data inspector).

Modified (all inside `webapp/`, none of them existing project files):
- `backend/app/main.py`: five `/api/studio/...` routes.
- `backend/selfcheck.py`: ten Studio checks (displacements compared with an independent pandas calculation).
- `frontend/js/app.js` (Studio in the navigation, Alt+8), `frontend/js/api.js` (binary download, poll interval
  option), `frontend/js/ui.js` (icon), `frontend/index.html` (shortcut help), `frontend/css/views.css` (Studio layout).
- `README.md` (Studio section, endpoints, limits), this file.

Verified:
- Self-check 37/37 pass.
- In the browser on the sample run and on the production run `D:\Akshay\Cutting_20_30\AE` (600 frames, 1,995,185
  atoms per frame, read-only):
  - The pipeline removed the tool and coloured by height and by dy displacement.
  - Exported images reproduce the chip and displacement field of the paper's Fig. 5 style.
  - An Expression selection (y > surface + 1 Å) selects the same 2,390 atoms the pile-up tab counts.
  - The surface level and H/D on the sample run match an independent Python calculation.
  - Playback, slicing, measuring and the session reset all work, with no console errors.
- Fixed during testing: the surface detection, which was replaced by a median of column maxima detected on frame 0
  (the first method picked a layer about 3 Å below the surface). Dimension lines and the surface level are now tied
  to the trajectory they were measured on.

# Changes made in Phase 1 + Phase 2 (2026-10-11)

## Modified existing files (backed up first)

| File | Change | Backup |
|---|---|---|
| `.claude/launch.json` | added dev-server entries `nanocut-web` (FastAPI, port 8600) and `nanocut-static` (frontend only, port 8700); existing `nanocut-ui` entry unchanged | `webapp/backups/2026-10-11/.claude/launch.json` (original), `launch.json.after-web-entry` (intermediate) |

No other existing file was changed. `ui/app.py`, the `nanocut` package, all run folders, reference decks, potentials,
dumps and restart files are untouched. (`BIBLE.md`, `ui/app.py`, `ui/help.md` had uncommitted edits from earlier work
before this phase started; they were not touched in this phase.)

## Environment

- Installed into the project `.venv`: `fastapi 0.143.0` (with `pydantic 2.14.0`), `httpx 0.28.1`. `uvicorn` was already present.

## Created files (all under `webapp/`)

**Documentation:** `README.md`, `PHASE1_FINDINGS.md`, `CHANGES.md`

**Backend:** `backend/app/{__init__,settings,catalog,dumps,params,models,validation,advice,jobs,main}.py`,
`backend/requirements.txt`, `backend/selfcheck.py`, `__init__.py`, `backend/__init__.py`

**Frontend:** `frontend/index.html`, `frontend/vercel.json`,
`frontend/css/{tokens,base,components,views}.css`,
`frontend/js/{app,api,config,state,data,ui,colormaps,plot,viewer}.js`,
`frontend/js/views/{workspace,overview,visualizer,analysis,parameters,decks,validation}.js`,
`frontend/fixtures/*.json` (offline demo snapshot of real API responses, 1.9 MB)

**Tools and launchers:** `tools/make_fixtures.py`, `run_web.bat`, `run_web.sh`

## Verification

- `webapp/backend/selfcheck.py`: 27/27 checks pass against the real project data (catalogue, overview, provenance,
  reference conversion, frames, deterministic sub-sampling, series, metrics/initial/schematic/deck jobs, read-only
  guards, tree, validation of all 27 simulations).
- Browser checks (in-app browser, 1440×900, 375×812): every view rendered with real data, no console errors;
  playback, hover readout, per-frame metrics job, run comparison, deck generation (speed override reflected in deck B),
  computed initial configuration, schematic, validation and the offline-fixture mode (static server, no backend).
- Bugs found and fixed during the checks: frame ordering differs between dumps (now sorted by id); older
  `params.json` without laser/boundary fields; legend overflow in plots; Generate button outside its form; exact
  integers shown in exponent notation; "null" in the sidebar; stale cached modules (frontend now served with
  `Cache-Control: no-cache`).
