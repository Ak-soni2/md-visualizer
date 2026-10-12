# NanoCut web workstation (Phase 2)

A scientific web interface for the NanoCut project: HTML5 + CSS3 + vanilla JavaScript frontend, Python (FastAPI)
backend that reuses the existing `nanocut` engine through thin adapters. The Streamlit app (`ui/app.py`) is unchanged
and still available.

## Run it (any computer)

Copy the whole `md-visulaizer` folder, then double-click **`START.bat`** (Windows) or run `bash start.sh`
(Linux/macOS). It finds Python 3.12 (Windows: installs it with winget if missing), rebuilds `.venv` when it was copied
from another computer, installs the packages of `requirements.txt` + `webapp/backend/requirements.txt` (first start: a
few minutes, ~1 GB with OVITO; afterwards only when those files change), starts the server and opens
http://127.0.0.1:8600/app/ . API docs: http://127.0.0.1:8600/docs . `set PORT=8700` before START.bat changes the port.

Hosted version: https://md-simulator.vercel.app (see *Deployment*).

Checks (all against real or synthetic data with known answers):
```bat
.venv\Scripts\python webapp\backend\selfcheck.py          :: 54 API checks on the project data
.venv\Scripts\python webapp\tools\check_dump_reader.py    :: browser dump reader = backend reader (needs Node.js)
.venv\Scripts\python webapp\tools\check_regime.py         :: ductile/brittle indicators on synthetic defects
.venv\Scripts\python webapp\tools\check_remote.py         :: HPC connection against a test SFTP server
```

## Where the dump files are (storage)

| How you open dumps | Where they are read from | Extra disk used |
|---|---|---|
| OVITO page, local: **Open folder… / Open file(s)… / Browse… / Open path** | where they are on your disk (the local backend shows the system dialog and uses the real path) | none |
| Studio page: **Open folder… / Open files…** | read by the browser directly from your disk | none |
| OVITO page, **HPC…** | stay on the cluster; each frame is streamed over SSH into memory when OVITO computes it (`backend/memdump.py`) | none on disk (one frame in RAM at a time) |
| Hosted site: **Upload files…** | private Vercel Blob store of the project | in the cloud, deleted after 24 h; nothing on your PC |

Results: images/exports go to `%TEMP%\nanocut_ovito` (latest 60 kept). The frame-export ZIP is written directly to the
file you choose in the Save dialog (no temporary copy). Uploading to the local server (`/api/ovito/upload`) still
exists for scripts but the page no longer uses it.

## What the interface does

| View | Content | Data source |
|---|---|---|
| **Workspace** | Project explorer (verified directory tree with origin badges), simulation catalogue with filters, selected run's files | disk scan |
| **Overview** | Workpiece/material, tool, process, integration, laser, output, model atom counts per layer, trajectory statistics, warnings and missing data | `params.json` / preset, `geometry.Model`, dump headers |
| **Visualizer** | Atom viewport drawn on the GPU (WebGL2 spheres; rotate, pan, zoom, hover pick), playback with timeline, colour by temperature / coordination / stress / energy / speed / layer / type / laser zone, layer and type filters, thin z-section, overlays (surface, laser zone, tool outline, depth line, axes, scale bar) | three labelled sources: **Trajectory** (LAMMPS dumps, simulation output), **Initial configuration** (computed by NanoCut, not output), **Schematic** (mock) |
| **Analysis** | Force and temperature series vs cutting distance with steady-state window, summary (means, std, Fc/Ft), per-frame metrics job (pile-up height, contact-zone T, coordination), run comparison with parameter diff, saved figures | `*_forces_temps.txt`, dumps, PNGs in run folders |
| **Parameters** | Every value with provenance: **file** (deck line, opens the read-only source viewer at that line), **computed**, **editable** (inputs), **missing** | decks, `params.json`, presets, model |
| **Decks** | Every NanoCut parameter (same set, choices and help as the Streamlit setup tab: material, a0, sizes, layers, boundaries x/y/z, crystal orientations, potential and tool-workpiece cross term (Morse/ZBL/LJ), tool shape and angles, laser, thermostats, time steps, output, MPI); start from a run, preset or params.json; live validation; generate and download A/B and params.json; nothing is written on the server | `nanocut.schema`, `nanocut.deck` |
| **Validation** | Parsing vs scientific validation per simulation, archived verification (potential files, decks vs reference), last inspection time, re-run | files + `reference/*_checks.json` |
| **Studio** | A small OVITO-style workstation for any LAMMPS dump, with PNG and MP4 export (details below) | dump folders or files on your computer (read in the browser), or paths the backend can read |
| **OVITO** | Analysis and images made by the official OVITO Python module (details below) | any dump folder or file, read by OVITO |

Keyboard: `Alt+1…8` views, `?` help, `/` search, `Esc` close; visualizer `Space` play, `,`/`.` frames, arrows/`+`/`-`/`0` in the viewport.

## Studio (OVITO-style viewer for publication images)

**Open folder…** (searched two levels deep) or **Open files…** (one multi-frame dump, or several frame files, also
`.gz`) reads the dumps on your computer directly in the browser, in a Web Worker: nothing is uploaded, so this works on
the hosted version for the 2-million-atom production runs. **Open path** asks the backend instead (the run folders it can
see; on Vercel, the bundled ones). Files are recognised by content (`ITEM: TIMESTEP`), grouped into wildcard sequences
such as `dump.cutsic.*.lammpstrj` and sorted by the number in the file name; one file with many frames is indexed frame
by frame. Nothing is ever written.

The browser reader (`frontend/js/studio/dumpparse.js`) is a port of `backend/app/studio.py` with the same rules (atoms
sorted by id; positions from `x`, `xu`, `xs` or `xsu`; triclinic cells recovered from the bounding box; `|v|`;
displacements with the minimum image along periodic directions). `tools/check_dump_reader.py` runs both on the same
files: ids, types, steps, cells and column lists are identical, values agree within 2 float32 ulps. Where they differ
the browser is the more precise one (it parses in float64 and rounds once; the backend subtracts float32 positions).

- **Viewport:** every atom of the frame (2 million atoms tested) drawn on the GPU (WebGL2) as shaded spheres with correct
  intersections; OVITO's standard views (Top, Bottom, Front, Back, Left, Right, Ortho) plus *Surface* (looking down −y
  with x to the right, for NanoCut's y-normal surfaces); orthographic or perspective; drag to rotate, right-drag or
  Shift-drag to pan, wheel to zoom, double-click to zoom all, click an atom to see all its values.
  With NanoCut decks (surface normal y): **Top** = side view (x right, y up), **Surface** = top view.
- **Pipeline** (top to bottom, each step can be switched off, reordered, removed): Displacement vectors (from a
  reference frame, minimum image along periodic directions), Slice, Select type, Expression selection
  (conditions on any dump column), Invert/Clear selection, Delete selected, Assign color, Color coding (Rainbow, Jet,
  Hot, Grayscale, Blue-White-Red, Viridis, Inferno; start/end, adjust range, reverse, only selected).
  Atom types: colour and radius. Selected atoms show red, as in OVITO.
- **Overlays:** colour legend (vertical/horizontal, position, title, unit, decimals, serif/bold), coordinate tripod,
  text labels such as "(a1)", dimension lines ("H = 28.23 Å" style) between two picked atoms, measuring the distance or
  only Δx/Δy/Δz.
- **Render:** PNG at any size (GPU limit), white/any/transparent background, 2× or 3× supersampling; the *Preview* frame
  shows exactly what the image contains. Download or copy to the clipboard.
- **Movie:** a frame range (every n-th frame) rendered exactly like *Render image*, overlays included, each frame shown
  for exactly 1/fps s. MP4 (H.264, encoded in the browser with WebCodecs; plays in PowerPoint) or a lossless PNG
  sequence written into a folder (Chrome/Edge). Colour-coding ranges stay fixed for all frames. Text labels accept
  `[Timestep]`, `[Frame]` and `[Time]` (from the MD time step entered in the Render tab).
- **Pile-up tab:** surface level (detected on frame 0 with the tool removed: median over 10 Å × 10 Å cells of the
  highest atom per cell), then per frame: height of the highest atom above the surface (H), number of atoms higher than
  surface + threshold (burr/pile-up atoms), and their lateral span (D). H and D can be added to the image as dimension
  lines. Computed from the atoms shown after the pipeline.
- **Data tab:** frame file and step, cell and boundaries, min/max of every column, the picked atom's values.
- **Session:** settings are remembered in the browser; *Save session* writes them to a JSON file so the same look can be
  applied to every case (a1 … c3).

Recipe for figures like "exit burr / surface burr / z-displacement": Select type (tool type) → Delete selected →
Color coding by `y` (height) with a narrow range around the surface, or add Displacement vectors (frame 0) and colour
by `dy`; view **Top** (side) or **Surface** (top); legend horizontal at the bottom or vertical at the right; Render.

Speed (this PC, dumps on the external disk): opening a 600-file folder under 10 s; parsing one 2-million-atom frame (325 MB)
~13–22 s (disk-bound, in a background job; the server keeps the last 3 frames, `NANOCUT_STUDIO_CACHE`); re-evaluating
the pipeline 0.15 s; a 1600 × 1000 image with 2× supersampling 0.4 s. A 97,815-atom run plays at under 1 s per frame.

## OVITO page (official OVITO Python module)

Everything on this page is computed and rendered by OVITO itself (`pip install ovito`, version 3.16.0 in the project
`.venv`), not by NanoCut code:

- The page settings become an **OVITO Python script** (`backend/app/ovito_script.py`). One long-lived OVITO worker
  process (`backend/ovito_worker.py`) runs exactly that script, keeping the loaded frame cached between renders.
  *Show script* displays it, and the result's Script tab offers it as a `.py` download. Running it with OVITO reproduces
  the image and numbers. User values enter the script only as Python literals; OVITO expressions stay strings that OVITO
  evaluates.
- **Modifiers** (OVITO's own): Select type, Expression selection (OVITO expression syntax), Invert/Clear selection,
  Delete selected, Slice, Displacement vectors, Coordination analysis, Identify diamond structure (3C-SiC), Common
  neighbor analysis, Dislocation analysis (DXA), Compute property, Color coding (OVITO gradients), Assign color.
- **Rendering:** OVITO Viewport (Top/Bottom/Front/Back/Left/Right/Ortho/Perspective, zoom), OpenGL renderer or Tachyon
  ray tracer (antialiasing, ambient occlusion, shadows), OVITO's ColorLegendOverlay, CoordinateTripodOverlay and
  TextLabelOverlay (text such as `[Timestep]` or `[ExpressionSelection.count]` is filled in by OVITO).
- **Results:** OVITO's rendered PNG, all OVITO global attributes (e.g. `ExpressionSelection.count`,
  `IdentifyDiamond.counts.*`, `ColorCoding.RangeMin/Max`), min/max/mean of every particle property, and data export with
  OVITO's exporter (LAMMPS dump, XYZ, LAMMPS data, POSCAR).
- **Cross-check:** for any frame and reference frame it compares OVITO with NanoCut's own dump reader (the Studio). On the
  20-30 run, frame 599 (1,995,185 atoms), the atom ids are identical, positions agree within 3e-5 Å and displacements
  within 9e-5 Å (float32 rounding). OVITO's selection of the 2,390 atoms above the surface and its dy range
  −22.711 … 32.751 Å match the Studio's numbers exactly.

Speed on this PC (2-million-atom frame from the external disk, with displacements): 29 s for an OpenGL image including
loading two frames; 64 s for a 1600 × 1000 Tachyon image with ambient occlusion; renders of the sample run take 1–3 s.
Images and exports go to the system temporary folder (`%TEMP%\nanocut_ovito`, latest 60 kept), never into the project or
data folders. If `ovito` is missing, the page shows the install command.

## Frames & export (OVITO page, "Export" tab)

Frames by interval (0, k, 2k …), range (start, end, step) or a list (`0, 7, 20-600:30`), validated against the
loaded trajectory, duplicates removed, sorted. **Download CSVs as ZIP**: one CSV per frame with every particle column
under its dump name (`id, type, x, y, z, fx, fy, fz, c_pe …`), values exactly as read (checked against pandas); columns
OVITO derives (e.g. Velocity Magnitude) only on request; with *Apply the OVITO pipeline* the data after the modifiers.
**Calculate statistics & forces**: per frame count/mean/std/min/max of every numeric column, mean Fx/Fy/Fz, mean |F|,
|mean F| and ΣF, for all atoms and per particle type (the tool's ΣF is the cutting force; over all atoms ΣF ≈ 0),
table, chart, and an **Excel** workbook (Frame Statistics, Export Metadata, Force by particle type, one sheet per column
group: c_ computes, f_ fixes, v_ variables, displacement, positions/velocities/forces, others) with the chosen columns
and statistics.

## Measure (OVITO page, "Measure" tab)

- **Pile-up height, automatic:** tool type(s) removed; original surface = median over 10 Å × 10 Å columns of the highest
  workpiece atom in frame 0; H = highest workpiece atom of the frame above it, overall, ahead of the cutting edge
  (chip / front pile-up) and behind it (burr / side pile-up), with the atom's id and position, atoms above surface +
  threshold and their width; for this frame or every n-th frame (chart, CSV). *Show H in viewport* draws it.
- **Between two particles:** *Pick two particles*, click two atoms: height Δy, Δx, Δz or distance from OVITO's exact
  positions, drawn as a dimension line; kept per trajectory (CSV).

Opening one file of a numbered series (e.g. the last `dump.cutsic.600.lammpstrj`) opens the whole series with its
timeline, as OVITO does; the single file stays selectable. The open side tab, the trajectory, the frame, measurements
and settings are remembered and restored on reload (OVITO page and Studio). The Studio has the same **Export** tab
(when its files are read by the local backend: Open folder… / Open file(s)…, read in place). Exports include every
column by default (also columns OVITO derives, e.g. Velocity Magnitude) and all statistics; the Excel file adds a
"Columns by particle type" sheet with every column per type.

## Ductile–brittle regime (OVITO page, "Ductile–brittle" tab)

Per selected frame, in a zone from `ahead` Å in front of the cutting edge to `behind` Å behind it (tool = chosen particle
type, cutting along x towards −x by default, surface normal y), OVITO computes (`ovito_worker.op_regime`):

- **crack faces**: atoms on OVITO's surface mesh (ConstructSurfaceModifier, probe radius 3 Å) more than 4 Å below the
  tool's lowest atom, excluding the workpiece's own bottom and x-end faces;
- **voids**: enclosed empty regions of that mesh (≥ 30 Å³);
- **chip**: workpiece atoms above the original surface (frame 0, median of the highest atom per 10 Å column), split by
  cluster analysis (3 Å); fragments = pieces ≥ 20 atoms;
- **disordered fraction**: interior zone atoms classed "other" by Identify diamond structure (surface atoms excluded);
  **damage depth**: deepest such atom behind the cutting edge, below the tool;
- **forces**: Fc = |ΣFx|, Ft = |ΣFy| over the tool's atoms, Ft/Fc; **depth of cut** = original surface − tool bottom.

A frame is **brittle** when any criterion holds (crack-face atoms ≥ 20, voids ≥ 1, chip fragments ≥ 2, optionally a
cutting-force drop ≥ 30 % between analysed frames), otherwise **ductile**; the summary names the first brittle frame and
its evidence. All thresholds are editable; the indicators are always shown (table, charts, CSV). *Play with regime*
shows DUCTILE/BRITTLE in the viewport while playing; *Show damage in viewport* sets the pipeline to Select type (tool) →
Delete selected → Identify diamond structure, so amorphised material and crack faces are visible.

Calibration (`tools/check_regime.py`, synthetic 3C-SiC): an intact slab gives 0 crack faces / voids / fragments; an
enclosed void (975 Å³), a 3 Å wide crack, two chip fragments and a disordered region reaching 14 Å below the tool
(measured 14.6 Å) are found; Ft/Fc and depth of cut are exact. A 4 Å probe misses a 3 Å crack: the probe must be smaller
than the crack opening. These are indicators, not proof: confirm brittle frames visually.

## HPC connection (OVITO page, "HPC…", local backend only)

Host/IP, port, username and password (keyboard-interactive and one-time codes supported) or a private key. The
credentials are used once to open the SSH connection and are never stored or logged; unknown host keys must be
confirmed by fingerprint (kept in `~/.nanocut/known_hosts`), changed keys are refused. Browse the cluster, open a dump
sequence: each frame is streamed over SFTP into memory when OVITO computes it and built into OVITO data there
(`backend/memdump.py`, identical to OVITO's reader); nothing is written to disk. Results are identical to reading the
same files locally and no file is created (`tools/check_remote.py`). The OVITO-vs-NanoCut cross-check (it reads files)
is not available for HPC trajectories.

## Architecture

```
webapp/
  backend/app/
    main.py        FastAPI routes; serves the frontend at /app; CORS from NANOCUT_CORS_ORIGINS
    settings.py    paths (PROJECT_ROOT, REFERENCE_ROOT), read-only path guard, limits
    catalog.py     discovers reference decks / run folders / presets; directory tree with origin classes
    dumps.py       dump headers, one-frame-at-a-time loading (cached), per-atom properties, id-based sub-sampling
    params.py      deck parser with line numbers, provenance, lattice-unit conversion (tools/verify_decks.parse_ref)
    models.py      model summaries (stored for runs, background job for presets/references)
    validation.py  parsing checks vs scientific checks
    advice.py      physics advice rules (same as ui/app.py soft_warnings)
    jobs.py        small thread-pool job runner with progress (no queue/database)
    studio.py      Studio: dump discovery, frame index, frame parsing into a small LRU cache, displacements, binary columns
  backend/selfcheck.py   47 end-to-end checks with FastAPI's TestClient
  frontend/
    index.html, css/ (tokens, base, components, views)
    js/ app.js (shell, routing), api.js (client + job polling + offline fixtures), viewer.js (atom renderer),
       plot.js (line plots), colormaps.js, ui.js, views/*.js
       studio/render.js (WebGL2 sphere renderer, cameras), studio/pipeline.js (modifiers, gradients),
       studio/overlays.js (legend, tripod, labels, dimension lines)
    fixtures/      offline demo snapshot (generated by tools/make_fixtures.py)
    vercel.json
  tools/make_fixtures.py
  run_web.bat / run_web.sh
```

### API (all GET unless noted; read-only)

| Endpoint | Purpose |
|---|---|
| `/api/health`, `/api/health/lammps` | status, versions; WSL LAMMPS availability (cached, slow) |
| `/api/simulations` | catalogue (runs, reference decks, presets) |
| `/api/simulations/{id}` | overview: experiment, model (or pending job), trajectory summary, warnings, missing data |
| `/api/simulations/{id}/parameters` | grouped parameters with provenance and source lines |
| `/api/simulations/{id}/trajectory` | frame list (step, size, time, cut distance) without loading frames |
| `/api/simulations/{id}/frames/{i}?props=&max_atoms=&slab=` | one frame, sub-sampled by atom id, requested properties + statistics |
| `/api/simulations/{id}/initial`, `/schematic`, `/model` | background jobs (202 + job record, then 200) |
| `/api/simulations/{id}/series`, `/plots`, `/validation` | force/temperature series and summary; figure list; checks |
| `POST /api/simulations/{id}/metrics` | background job: per-frame metrics |
| `/api/jobs/{job_id}` | job status and result |
| `/api/validation`, `POST /api/validation/run` | validation of all simulations (job) |
| `/api/tree`, `/api/files/text`, `/api/files/raw` | directory tree; read-only text (≤ 2 MB, no dumps); images |
| `GET /api/deck-options` | materials, potentials, Morse cross terms and defaults for the deck editor |
| `POST /api/decks/check` | `{experiment}` → hard errors and step counts (instant) |
| `POST /api/decks` | `{experiment}` (full set) or `{base, overrides}` → decks A/B as text (job); nothing written |
| `/api/ovito/status` | OVITO version (starts the OVITO worker) |
| `POST /api/ovito/info`, `/render`, `/export`, `/verify` | OVITO reads a trajectory; renders with the page settings; exports data; cross-checks with NanoCut's parser (jobs) |
| `POST /api/ovito/script` | the OVITO Python script for the current settings |
| `/api/ovito/file/{name}` | rendered PNG or exported file |
| `/api/studio/scan?path=` | dump sequences in a folder (two levels deep) or the given dump file; names and sizes only |
| `POST /api/studio/open` | `{path, pattern?, refresh?}` → frame index of a sequence or file (job) |
| `POST /api/studio/sources/{id}/frames/{i}/load?ref=` | parse a frame (and the displacement reference) into the cache (job) |
| `/api/studio/sources/{id}/frames/{i}/data?cols=&ref=` | requested columns as raw float32 (id: uint32), atoms sorted by id |
| `/api/studio/sources/{id}/frames/{i}/atom/{k}` | all values of one atom |

## Data safety

- The API never writes into the project, the run folders or `C:\BTP\Cutting`. File endpoints resolve paths and refuse
  anything outside those roots or inside `.git`, `.venv`, `.claude`, `backups`.
- Dumps and restart files are never sent as text; frames are parsed one at a time with a size limit and sent sub-sampled.
- No simulation output is generated or regenerated; deck generation returns text only.
- The Studio reads dump files anywhere on this computer (so `D:\Akshay\...` works), but only files whose content is a
  LAMMPS dump, and it lists only such files. Restrict it with `NANOCUT_STUDIO_ROOTS` (paths separated by `;`) whenever
  the backend is reachable by others.
- Values shown are read from files, computed by NanoCut (labelled "computed"), or are clearly labelled mock/demo data.

## Deployment (Vercel: one container with OVITO)

```bat
.venv\Scripts\python webapp\tools\stage_vercel.py
cd build\vercel && npx vercel deploy --prod
```
`stage_vercel.py` writes `build/vercel`: the application, the bundled data (run folders except `runs/smoke3`, reference
decks) and `Dockerfile.vercel` (python 3.12 + OVITO 3.16 + the Qt/Mesa libraries; Mesa's lavapipe provides the Vulkan
device OVITO needs, there is no GPU). Vercel builds the image and runs it as one function (1 vCPU, 2 GB, 300 s).
Project settings: `VERCEL_SUPPORT_LARGE_FUNCTIONS=1`, private Blob store `nanocut-data` (`BLOB_READ_WRITE_TOKEN`).

Hosted behaviour (`NANOCUT_HOSTED=1`): jobs run inside the request; uploads go from the browser straight to Blob
(client token, multipart above 64 MB) and instances fetch frames on demand; renders, exports and CSVs come back as
presigned Blob URLs (1 h); live frames are one response, compact-encoded when above the 4.5 MB limit (labelled, picking
uses full data); frame exports and regime analyses run in batches; HPC and local file dialogs are refused.

## Known limits

- The Visualizer draws up to 400,000 sub-sampled atoms per frame (server limit); full 2-million-atom frames belong in
  the Studio, which draws every atom. On Vercel, frames near 400k atoms can exceed the response limit even compressed.
- Full-size production dumps (~300 MB per frame) take a few seconds to parse per frame; playback is then frame by frame.
- Per-frame metrics and structural analysis beyond coordination (CNA, DXA) remain in OVITO/Python scripts.
- Studio: no CNA/DXA/cluster analysis, no bonds, no ambient-occlusion renderer; gzip dumps are read as one frame per
  file; values are float32 (≈1e-4 Å at 1000 Å). In the browser a 2-million-atom frame takes ~1 GB of memory while parsed
  (2 frames are cached instead of 3). It covers the OVITO features
  used for burr, pile-up and displacement figures.
- Self-check: 54 checks; plus check_dump_reader, check_regime, check_remote.
- Authentication is not implemented: the hosted API is public (read-only, serves only the bundled files).
  Locally, bind to 127.0.0.1 (default) unless deployed behind access control.
