# Changes

## NanoCut Studio: help guide, CI/CD installer, updates (2026-10-18)

- Sidebar "Help — what each tab does" (`js/guide.js`, mounted in `js/app.js`, styles in `css/base.css`); brand name
  NanoCut Studio (`index.html`).
- `.github/workflows/windows-installer.yml`: build, test and release the Windows installer on every push to main.
- Launcher update check and installer `/launch`; installer file `NanoCut-Studio-Setup.exe`; versions
  `<app>.<UTC yyyymmddHHMM>` in a generated `BuildInfo.cs` (`desktop/`).

## Research analysis, Graph Studio, Windows installer (2026-10-18, PLAN_PHASE3.md)

- Created `nanocut/stress.py` (all stress measures), `nanocut/research.py` (per-region quantities, RDF/bond angles from
  neighbour pairs, histograms, profiles, maps, roughness, damage depth), `tests/test_research.py` (known answers).
- `backend/ovito_worker.py`: ops `research` and `volumes`; `backend/app/ovito_lab.py`: `/api/ovito/research`,
  `/research/defaults`, `/research/volumes`; `backend/app/figures.py` (matplotlib renderer, `/api/figures/render`, `/zip`),
  registered in `main.py`; `matplotlib` added to `backend/requirements.txt`.
- Frontend: OVITO page "Research" tab (`js/views/ovito_research.js`), Graph Studio view (`js/views/graphs.js`, Alt+0),
  dataset store with IndexedDB persistence (`js/research_store.js`), styles in `css/views.css`, icon in `js/ui.js`.
- `desktop/`: launcher, installer, `build_windows.py`.
- Self-check: research numbers vs pandas (Fc, virial von Mises, RDF peak), figures in every format, ZIP layout.
- Verified in the browser on the sample run: analysis of 3 frames, all 88 generated figures draw, datasets survive a reload.

## Hosting on Vercel, Studio in the browser, movies, WebGL Visualizer (2026-10-11)

- **Vercel hosting (frontend + API):** `tools/stage_vercel.py` assembles `build/vercel` (frontend in `public/`, FastAPI as
  one Python function, engine and bundled data); deployed to https://md-visualizer-mauve.vercel.app. On Vercel jobs run
  inside the request (`jobs.INLINE`), OVITO reports itself unavailable, responses are gzip compressed.
- **Studio reads local dumps in the browser:** `js/studio/dumpparse.js` (port of `studio.py`), `dumpworker.js`,
  `source.js` (browser and server sources behind one interface). `tools/check_dump_reader.py` compares it with
  `studio.py` on the sample run and on synthetic triclinic/scaled/element/multi-frame/gzip dumps: identical ids, types,
  steps and cells; values within 2 float32 ulps.
- **Movie export:** `js/studio/movie.js`; MP4 (H.264 via WebCodecs, `js/vendor/mp4-muxer.mjs`, MIT) or PNG sequence
  into a folder; label placeholders `[Timestep]`, `[Frame]`, `[Time]`.
- **Visualizer on the GPU:** `js/viewer.js` now draws with the Studio's WebGL2 sphere renderer (same interface, same
  camera, overlays and picking); up to 400,000 atoms per frame.
- **Fixed:** element names (`element` column) were dropped by `studio.py` under pandas 3 (the column dtype is no longer
  `object`); the `hidden` attribute did not hide buttons (`.btn` display rule); `selfcheck.py` now also accepts jobs
  that finish inside the request (47/47 pass in both modes).

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
