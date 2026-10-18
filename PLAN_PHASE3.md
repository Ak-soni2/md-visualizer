# NanoCut Phase 3 — research analysis, Graph Studio, Windows desktop app

Plan written 2026-10-18, before any code of this phase was changed. It is kept up to date while the work is done: each
item carries a status (`[ ]` open, `[~]` in progress, `[x]` done and verified, `[-]` dropped, with the reason).
Read together with `BIBLE.md` (physics, decks, potentials), `PLAN.md` (phases 0–7) and `webapp/README.md` (web workstation).

---

## 0. Where the project stands (read from the repository on 2026-10-18)

| Area | State | Source |
|---|---|---|
| Deck generator (`nanocut/`) | Phases 1–6 of `PLAN.md` done: schema, materials, potentials, exact geometry, decks A/B, 9/9 reference cases reproduced | `PLAN.md` §7, `VERIFICATION_REPORT.md` |
| Streamlit UI (`ui/app.py`) | working, unchanged since 2026-10-10 | `BIBLE.md` §6 |
| Web workstation (`webapp/`) | Workspace, Overview, Visualizer, Analysis, Parameters, Decks, Validation, Studio, **OVITO page** | `webapp/README.md` |
| OVITO page tabs | Pipeline, Render, Export (CSV ZIP, frame statistics, Excel), Ductile–brittle, Measure (pile-up, two-point), Results, More; HPC over SSH; hosted (Vercel) mode | last commit `2fc88ea` |
| Stress | only per-atom von Mises and hydrostatic in `nanocut/analysis.py` (`Frame.von_mises`, `Frame.hydrostatic`), not exposed in the web app | code |
| Plots | `webapp/frontend/js/plot.js`: one canvas line plot, PNG/CSV only, no styling options | code |
| Desktop app | none: `START.bat` creates a venv and installs packages from the internet on first start | `START.bat` |
| Open items from earlier plans | DoE sweep generation + sweep analysis, multi-pass cutting, hcp lattices (Ti, 4H/6H-SiC), Morse sets for Al/Fe/Au/Ag/W–C, independent verification panel | `PLAN.md` §7, `BIBLE.md` §7 |

**Where this phase starts:** the OVITO page reads any dump (local, upload, HPC) and already measures pile-up, regime,
frame statistics. What is missing is the *research layer*: every stress measure, every temperature/force/energy/structure
quantity per frame and per region, the distributions papers show (RDF, bond angles, coordination, histograms, depth
profiles, maps), and a figure tool that plots any quantity against any other with full styling and exports
publication files. Then a Windows installer so the whole workstation runs on any PC without setup.

---

## 1. What was asked (2026-10-18) and how each point is answered

| # | Request | Answer in this plan |
|---|---|---|
| 1 | Calculate von Mises stress and **every type of stress** | §2.1: full per-atom stress tensor in GPa, hydrostatic/pressure, von Mises, Tresca, max shear, principal stresses σ1 ≥ σ2 ≥ σ3, octahedral shear, J2/J3, triaxiality, Lode parameter; per atom, per region and as the region's volume-averaged (virial) tensor |
| 2 | Extract temperature, every force, every stress, averages of everything | §2.2–2.6: per frame and per region: temperatures (COM-removed and local), forces (Fc, Ft, Fz, resultant, μ, friction angle, specific cutting energy, cutting work), energies, displacements/MSD, coordination, structure fractions, atomic strain, defects, pile-up, chip, roughness, damage depth |
| 3 | Research on the internet every relation that can be extracted from OVITO data (RDF and others) for a research paper | §3: catalogue of quantities and relations with formulas and literature use; §10 sources |
| 4 | Plot every type of graph: force vs step, temperature vs speed, temperature vs step, every correlation of the averaged quantities, including steps/displacement | §4: Graph Studio — any X vs any Y (time series), correlation scatter with fits, correlation matrix, distributions (RDF, bond angle, CN, histograms), depth/length profiles, 2-D maps, structure fractions, **across-run plots** (e.g. temperature vs cutting speed from several runs) |
| 5 | Every graph customisable (grids on/off, title, everything) | §4.3: full style editor per figure |
| 6 | Download graphs as PNG, "TTF" and every available format; ZIP of all graphs | §4.4: PNG, JPEG, TIFF, WebP, SVG, PDF, EPS, PS; fonts embedded as TrueType (Type 42) in PDF/EPS/PS (if "TTF" meant the font) and TIFF (if it meant the image format); ZIP with every figure in every chosen format + data CSV + figure spec + all results |
| 7 | Update everything on git | §8: commit + push to `origin/main` (the branch all earlier work went to) after the checks pass |
| 8 | Plan file first, kept updated | this file |
| 9 | Windows application, shareable `.exe` that installs on any other computer | §5: self-contained installer `NanoCut-Setup-<version>.exe` (bundled Python + OVITO + all packages, no internet, no admin rights), Start-menu/desktop shortcuts, app window, uninstaller |
| 10 | Plan includes the rest of the things | §7 backlog |

---

## 2. Physics: what is computed and exactly how

Units of the dumps: LAMMPS `metal` (Å, ps, eV, eV/Å, bar·Å³ for `compute stress/atom`). Conversions used everywhere:
1 eV/Å = 1.602176634 nN; 1 bar = 1e-4 GPa; 1 Å/ps = 100 m/s; k_B = 8.617333262e-5 eV/K;
m v² in (g/mol)(Å/ps)² × 1.0364269e-4 = eV.

### 2.1 Stress (per atom → per region)  `nanocut/stress.py`

Input: `c_s[1..6]` = S_xx, S_yy, S_zz, S_xy, S_xz, S_yz from `compute stress/atom` (bar·Å³). LAMMPS defines this as the
*negative* per-atom pressure tensor times volume, so the stress (tension positive) is **σ_ij = S_ij / Ω_i**, and the
pressure is p = −(σ_xx + σ_yy + σ_zz)/3 (LAMMPS manual, compute stress/atom). In GPa: σ = S / Ω × 1e-4.

Atomic volume Ω_i (choice shown with every result):
- **nominal per type** (default): Ω = a0³ / atoms-per-cell of that type's crystal (3C-SiC 4.3667³/8 = 10.41 Å³,
  diamond 3.567³/8 = 5.67 Å³, Si 20.02 Å³, Cu 11.81 Å³ …); prefilled from `params.json` next to the dumps, else from the
  type names, else entered;
- **Voronoi** (OVITO `VoronoiAnalysisModifier`, per atom; unreliable at free surfaces and in the chip — warned);
- **custom** value per type.

Per atom (all in GPa unless noted):

| Quantity | Formula |
|---|---|
| components | σ_xx, σ_yy, σ_zz, τ_xy, τ_xz, τ_yz |
| hydrostatic (mean) stress | σ_h = (σ_xx + σ_yy + σ_zz)/3 (negative = compression) |
| pressure | p = −σ_h (positive = compression) |
| deviatoric tensor | s_ij = σ_ij − σ_h δ_ij |
| invariants | I1 = tr σ; J2 = ½ s_ij s_ij; J3 = det s |
| von Mises | σ_vM = √(3 J2) = √(½[(σ_xx−σ_yy)² + (σ_yy−σ_zz)² + (σ_zz−σ_xx)²] + 3(τ_xy² + τ_xz² + τ_yz²)) |
| principal stresses | σ1 ≥ σ2 ≥ σ3 = eigenvalues of σ (vectorised `numpy.linalg.eigvalsh`, in chunks) |
| maximum shear (Tresca) | τ_max = (σ1 − σ3)/2; Tresca equivalent σ_T = σ1 − σ3 |
| octahedral shear | τ_oct = √(2 J2 / 3) = (√2/3) σ_vM |
| stress triaxiality | η = σ_h / σ_vM (undefined where σ_vM ≈ 0) |
| Lode angle parameter | ξ = (27/2) J3 / σ_vM³ ∈ [−1, 1] |
| max tensile / compressive | σ1 (crack opening in brittle SiC), σ3 |

Per region: mean, std, min, max, 95th/99th percentile of every per-atom measure **and** the region's volume-averaged
(virial) stress tensor σ̄ = Σ S_i / Σ Ω_i with *its* invariants (σ̄_vM, p̄, principal values). The two differ (mean of
von Mises ≠ von Mises of the mean); both are labelled. Checks: uniaxial, pure shear, hydrostatic and random tensors
against hand formulas and `numpy.linalg.eigvalsh`; invariance under rotation.

### 2.2 Regions (groups) used for every average

- all atoms; **tool** (chosen particle types; NanoCut: type 1 = tool carbon); **workpiece** (the rest);
- NanoCut layers when `mol` is dumped: tool Newtonian/thermostat/fixed (mol 1/2/3), workpiece Newtonian/thermostat/fixed
  (mol 4/5/6);
- every particle type;
- zones that move with the tool (cutting along −x, surface normal +y; direction selectable):
  - **contact (cutting) zone**: workpiece atoms within R (default 20 Å) of the cutting edge point (leading tool atom x,
    tool bottom y) in the x–y plane;
  - **chip**: workpiece atoms higher than surface + threshold and ahead of the cutting edge;
  - **subsurface**: workpiece atoms behind the edge (machined part), from the tool bottom down to depth D (default 30 Å);
  - **machined surface** (for roughness): highest workpiece atom per column behind the edge.
- Original surface height: frame 0, tool removed, median over 10 Å × 10 Å columns of the highest atom (same rule as the
  existing Measure and Ductile–brittle tabs).

### 2.3 Temperature

- **T_COM** = Σ m_i |v_i − v_com|² / (3 N k_B) per region (streaming velocity removed; needs vx vy vz and masses per type);
- **T_local** per atom = 2⟨KE_i⟩ / (3 k_B) from `f_keav` (time-averaged KE) or `c_ke`; region mean and max;
- tool temperature always with the tool's COM velocity removed (BIBLE §5).

### 2.4 Forces, cutting mechanics

- Force on the tool = Σ F_i over tool atoms (fx fy fz; eV/Å and nN): **Fc** = |ΣFx| (cutting), **Ft** = |ΣFy| (thrust,
  normal), **Fz** (lateral), resultant |ΣF|; Ft/Fc; **μ = Fc/Ft** (scratching convention used in this project) and Ft/Fc
  (rake-face convention for a 0° rake tool), friction angle β = α + atan(Ft/Fc) (rake α entered, default 0°).
- Depth of cut d = original surface − tool bottom (measured per frame); width w = periodic cell length in z.
- **Specific cutting energy** u = Fc / (d·w) (nN/nm² = GPa) and the cumulative **cutting work** W = ∫ Fc dx (trapezoid over
  the analysed frames, eV and aJ); energy per removed volume W / V_chip.
- Tool displacement (= cutting distance) from the tool COM relative to frame 0, **measured tool speed** from Δx/Δt between
  frames and from the mean vx of the tool's driven layer (m/s).
- Per-region force statistics (ΣF, mean F, mean |F|) as in the Export tab.

### 2.5 Energy, displacement, strain, defects

- PE per atom (`c_pe`) mean/total per region, KE per atom; ΔPE relative to frame 0.
- Displacement u_i = r_i(t) − r_i(0) by atom id (minimum image along periodic axes): mean |u|, max |u|, **MSD**, mean
  u_x/u_y/u_z per region.
- **Atomic strain** (OVITO `AtomicStrainModifier`, reference frame 0, cutoff entered): von Mises shear strain η_vM
  mean/max, volumetric strain, number and volume of atoms with η_vM > threshold (plastic zone size).
- **Wigner–Seitz** (OVITO, tool removed upstream, reference frame 0): vacancies, interstitials.
- **Dislocations** (OVITO DXA, metals and diamond lattices): total line length, density = length / volume.

### 2.6 Structure

- Coordination number per atom (`c_cn` from the dump, else OVITO `CoordinationAnalysisModifier` with a cutoff):
  histogram and fractions CN = 3, 4, 5, ≥ 6 per region (CN 4 = sp³ / crystalline for SiC, Si; CN 6 = β-Sn Si-II).
- Structure type per atom: OVITO **Identify diamond structure** (SiC, Si, Ge, diamond), **CNA** (fcc/bcc/hcp metals) or
  **PTM**: fractions per region; **amorphous (other) fraction**; number of disordered atoms; **subsurface damage depth** =
  deepest disordered interior atom below the machined surface.
- **RDF g(r)** total and partial (Si–Si, Si–C, C–C …) for the workpiece (sample of centres), the contact zone, the chip and
  the subsurface: neighbours from OVITO's `CutoffNeighborFinder`, normalised with the bulk number density ρ = 1/Ω̄ and the
  partial densities ρ_b = x_b ρ (OVITO's own RDF modifier normalises with the simulation-cell volume, which for a
  shrink-wrapped cutting box includes empty space; both are offered, labelled). Derived: first-peak position and height,
  coordination from ∫ 4π r² ρ g(r) dr up to the first minimum.
- **Bond-angle distribution** P(θ) per region (pairs of neighbours within the bond cutoff; tetrahedral 109.47° for sp³),
  **bond-length distribution**.
- Optional: **structure factor S(q)** (OVITO; slow, ~6 min for 98k atoms on this PC — opt-in only).

### 2.7 Surface and chip

- Pile-up height (overall / ahead / behind), atoms above surface, lateral extent (as Measure tab).
- Chip atoms, chip volume (atoms × Ω), chip fragments (cluster analysis, as Ductile–brittle tab).
- Machined surface **roughness** behind the tool: Ra, Rq, Rz (= max − min) of the column-height map.
- Surface height profile along x.

### 2.8 Spatial distributions (per frame)

- 1-D **depth profiles** below the cutting edge (bins in y, in a slab from the edge to the subsurface zone) and **length
  profiles** along x: σ_vM, p, σ1, T_local, PE, disordered fraction, η_vM.
- 2-D **maps** in the x–y plane averaged over z (bins of 4 Å default): σ_vM, p, σ1, τ_max, T_local, PE, η_vM,
  displacement u_y — shown as heat maps with colour bar.
- **Histograms** of the per-atom σ_vM, p, T_local, PE, η_vM (region selectable).

---

## 3. Catalogue: relations used in MD nano-cutting papers (what the literature extracts from OVITO/LAMMPS data)

Collected from the project survey (`reference/nanocutting_md_literature.md` §5) and the web research of 2026-10-18 (§10).
"Graph" = how Graph Studio shows it.

| Relation / quantity | Typical use in papers | Graph |
|---|---|---|
| Fc, Ft, Fz vs cutting distance (or step/time) | machining forces, steady-state average after 15–25 nm | series with steady-state window and mean ± std |
| μ (Fc/Ft), Ft/Fc, friction angle vs distance; vs depth / speed / T (across runs) | friction at the rake face; size effect | series; across-run |
| specific cutting energy vs depth of cut | size effect (rises as depth falls) | across-run; series |
| T (contact zone, chip, workpiece, tool) vs distance/time | cutting-zone heating | series |
| T vs cutting speed, T vs depth (across runs) | parameter studies (DoE) | across-run |
| von Mises, hydrostatic pressure, principal stresses, τ_max vs distance (contact zone, subsurface) | yielding, phase transformation (Si-I → Si-II at 10–13 GPa hydrostatic), crack driving σ1 | series |
| von Mises vs temperature (correlation) | thermal softening (−49 % yield stress 300 → 3000 K for 3C-SiC) | correlation scatter + fit |
| stress / temperature maps around the tool | location of the shear zone, high-pressure zone | 2-D map |
| depth profiles of σ, T, disorder below the tool | subsurface damage layer | profile |
| RDF g(r) (total, partials) at selected frames vs pristine | amorphisation (peak broadening, loss of 2nd/3rd peaks), Si–C vs C–C bonding | distribution, overlay of frames |
| bond-angle distribution | sp³ (109.5°) → sp² (120°) / disorder | distribution |
| coordination histogram, CN fractions vs distance | sp³–sp² conversion, β-Sn (CN 6), amorphous | distribution; stacked area |
| structure fractions (diamond / hex / other; fcc / hcp / bcc / other) vs distance | crystallinity, stacking faults, phase change | stacked area / series |
| amorphous (disordered) atom count, damage depth vs distance; vs depth of cut | subsurface damage | series; across-run |
| dislocation length / density vs distance (metals) | plasticity mechanism | series |
| atomic shear strain η_vM maps and plastic-zone size | shear band, primary/secondary shear zones | map; series |
| vacancies / interstitials (Wigner–Seitz) vs distance | point-defect generation | series |
| pile-up height, chip atoms/volume, chip ratio vs distance | material removal, burr | series |
| surface roughness Ra/Rq of the machined surface | surface quality | series; across-run |
| MSD, mean displacement | atom flow in the chip / sticking | series |
| PE per atom vs distance, ΔPE | stored energy of defects | series |
| any averaged quantity vs any other | the user's correlations | correlation scatter; correlation matrix |

---

## 4. Graph Studio  (`webapp/frontend/js/views/ovito_research.js`, `webapp/frontend/js/graphstudio.js`, `webapp/backend/app/figures.py`)

### 4.1 Data sources

1. **Research analysis** of the OVITO page (new "Research" tab): every frame chosen (interval/range/list, as the Export
   tab) → scalars per frame and region (§2), curves (RDF, bond angles, CN, histograms, profiles), maps.
2. **LAMMPS text output**: `fix ave/time` files (e.g. `*_forces_temps.txt`), log thermo tables, any CSV/TSV with a header
   (parsed in the browser; local files or uploads).
3. **Saved datasets** (`.nanocut-results.json`) from earlier analyses, with run parameters (speed, depth, edge radius,
   temperature, potential…) editable → across-run plots.

### 4.2 Figure types

| Type | X | Y |
|---|---|---|
| Series | step, time, frame, cutting distance, or any scalar | one or more scalars (each with optional ±std band), optional right axis |
| Correlation | any scalar | any scalar; points coloured by distance/time; fit (linear, quadratic, power, exponential) with equation, R², Pearson r, Spearman ρ |
| Correlation matrix | — | Pearson r of all chosen scalars (heat map, values written in the cells) |
| Distribution | r (Å), θ (deg), CN, value | g(r), P(θ), fraction, counts, for chosen frames and regions (overlay) |
| Profile | depth y or position x | binned mean of a per-atom quantity, chosen frames overlaid |
| Map | x | y; colour = binned per-atom quantity, colour bar, colormap |
| Stacked fractions | distance/time | structure or coordination fractions |
| Across runs | a run parameter (speed, depth, …) | steady-state mean ± std of any scalar per run |
| Bar | category (region / type / run) | any scalar at a frame or steady-state mean |

"Generate all graphs" builds the standard set (§3) for whatever data is present and skips what is missing (with the reason).

### 4.3 Customisation (every figure)

Title (text, size, bold), axis labels and units, font family (serif/Times, sans/Arial/Helvetica, DejaVu, monospace),
base/tick/legend font sizes, **major grid on/off, minor grid on/off**, grid style/width/alpha, minor ticks, tick
direction (in/out/both), ticks on all four sides, axes frame (full box / open L), line width, axis limits (auto or fixed)
per axis, log axes, invert axes, legend on/off, position, frame, columns, per-series colour, label, line style, marker,
marker size, line/markers visibility, palette (default, colour-blind safe Okabe–Ito, greyscale, viridis), moving-average
smoothing, steady-state band and its mean annotation, fit line, ±std bands, colormap / colour limits / colour-bar label for
maps, figure width × height (mm or inches; presets 90 mm single column, 140 mm, 190 mm double column), DPI (150, 300,
600, 1200), background (white / transparent), free-text annotation. Styles can be saved and applied to all figures.

### 4.4 Export

- Renderer: **matplotlib** on the server for preview *and* export, from one JSON figure spec, so the preview is exactly
  the exported figure (WYSIWYG).
- Formats: **PNG, JPEG, TIFF, WebP** (raster, at the chosen DPI), **SVG, PDF, EPS, PS** (vector; TrueType fonts embedded
  as Type 42 so text stays editable in Illustrator/Inkscape and journals accept it); plus the figure's data as **CSV** and
  its spec as **JSON** (re-loadable).
- **ZIP of everything**: `figures/<name>.<fmt>` for every figure and every chosen format, `data/<name>.csv`,
  `specs/<name>.json`, `results/all_scalars.csv` (every quantity, every frame, every region), `results/curves/*.csv`,
  `results/analysis.json`, `README.txt` (definitions, units, volumes, settings, OVITO version).

---

## 5. Windows desktop application and installer  (`desktop/`)

Goal: one file `NanoCut-Setup-<version>.exe` that installs and runs on any Windows 10/11 x64 PC: no Python, no internet,
no administrator rights.

- **Runtime**: a copy of the CPython 3.12 that the project venv uses (relocatable Windows layout: `python.exe`,
  `pythonw.exe`, `python312.dll`, `DLLs\`, `Lib\`) with the packages of the venv copied into `Lib\site-packages`
  (Streamlit stack and pip left out to save space), the Visual C++ runtime DLLs copied next to `python.exe` (app-local
  deployment), `PYTHONHOME`/`PYTHONNOUSERSITE` set by the launcher so nothing on the target PC interferes.
- **App files**: `nanocut/`, `webapp/` (without backups), `potentials/`, `reference/`, `examples/`, `tools/`, docs.
- **Launcher `NanoCut.exe`** (C#, compiled with the .NET Framework `csc.exe` that every Windows has): starts the backend
  hidden on a free local port, waits until it answers, opens the workstation in its own app window (Microsoft Edge in app
  mode with a private profile, falling back to the default browser), stops the backend when the window is closed; one
  instance at a time; log in `%LOCALAPPDATA%\NanoCut\logs`.
- **Installer `NanoCut-Setup.exe`** (C#): self-extracting (payload ZIP appended to the executable), per-user install to
  `%LOCALAPPDATA%\Programs\NanoCut`, progress window, Start-menu and desktop shortcuts, entry in *Apps & features* with an
  uninstaller; silent mode `/S` and `/D=<folder>` for testing.
- **Build**: `python desktop\build_windows.py` → `dist\NanoCut-Setup-<version>.exe` and `dist\NanoCut-portable-<version>.zip`
  (unzip and run `NanoCut.exe`). Offline, reproducible, uses only what is on the build PC.
- The installer is ~0.5 GB (OVITO + Qt + NumPy/pandas/matplotlib): too large for git (100 MB limit), so it is built
  locally into `dist/` (ignored by git); it can be attached to a GitHub Release (asset limit 2 GB) when wanted.
- Test: silent install into a scratch folder without shortcuts/registry, start the installed launcher headless, check the
  API and the OVITO worker answer, uninstall.

---

## 6. Implementation checklist

| # | Item | Files | Status |
|---|---|---|---|
| 6.1 | This plan | `PLAN_PHASE3.md` | [x] |
| 6.2 | Stress module + unit tests (known tensors) | `nanocut/stress.py`, `tests/test_stress.py` | [ ] |
| 6.3 | Research analysis core (regions, temperatures, forces, energy, displacement, structure stats, RDF/BAD from neighbour pairs, profiles, maps, histograms, roughness) | `nanocut/research.py`, `tests/test_research.py` | [ ] |
| 6.4 | OVITO worker op `research` (structure/strain/Voronoi/WS modifiers, neighbour finder) | `webapp/backend/ovito_worker.py` | [ ] |
| 6.5 | API `/api/ovito/research` (job over frames, cancel, defaults from `params.json`) | `webapp/backend/app/ovito_lab.py` | [ ] |
| 6.6 | Figure renderer (matplotlib) + API `/api/figures/render`, `/api/figures/zip` | `webapp/backend/app/figures.py`, `main.py` | [ ] |
| 6.7 | OVITO page "Research" tab (settings, run, results table) | `webapp/frontend/js/views/ovito_research.js`, `ovito.js` | [ ] |
| 6.8 | Graph Studio (data sources, figure list, editor, gallery, exports, ZIP, datasets, across-run) | `webapp/frontend/js/graphstudio.js`, CSS | [ ] |
| 6.9 | Self-check additions (stress, research op, figures in every format, ZIP) | `webapp/backend/selfcheck.py` | [ ] |
| 6.10 | Browser verification on the sample run (every figure type, every format, styles, ZIP) | — | [ ] |
| 6.11 | Desktop launcher, installer, build script, icon | `desktop/` | [ ] |
| 6.12 | Build and test the installer (silent install, start, API, uninstall) | `dist/` | [ ] |
| 6.13 | Docs: BIBLE, README, webapp README/CHANGES, requirements (matplotlib) | docs | [ ] |
| 6.14 | Commit and push | git | [ ] |

---

## 7. Backlog (the rest of the project, after this phase)

1. **DoE sweeps** (`PLAN.md` phase 7): parameter lists → folder matrix, `run_all.sh`, `matrix.csv`; after the runs, the
   across-run graphs of Graph Studio read the matrix directly; 2^k main effects + interactions (COPEN paper formulas).
2. **Multi-pass cutting / feed** (B2, B3 … from the last restart).
3. **hcp lattices** (Ti, Mg, 4H/6H-SiC custom basis) in `nanocut/lattice.py`.
4. **Morse cross terms** for Al/Fe/Au/Ag/W–C from verified sources (now ZBL fallback, flagged).
5. **Independent verification panel** (the 22-agent re-check of every file that could not run on 2026-10-10).
6. **Spatial time averaging** of maps over several frames (OVITO `TimeAveragingModifier`) to reduce thermal noise.
7. **Virtual XRD / SAED** patterns (literature uses them for amorphisation) — not in OVITO; would need a Debye-equation
   implementation (cost N²) or LAMMPS `compute xrd`.
8. **Code signing** of the installer (needs a certificate; unsigned installers trigger SmartScreen "unknown publisher").
9. **macOS/Linux packages** (the same build idea with the platform's Python).
10. Streamlit UI parity or retirement (the web workstation now covers everything it does).

---

## 8. Git

All work of this phase lands on `main` (the repository's history is linear on `main`, pushed to
`origin = github.com/Ak-soni2/md-visualizer`). Commit after the checks pass; `dist/` and `build/` stay out of git.

---

## 9. Honest limits (known before starting)

- Per-atom stress depends on the atomic volume definition; values at free surfaces/chip are approximate whichever is
  used (nominal: density changes ignored; Voronoi: open cells at surfaces). The region virial average is the most
  robust number; this is stated next to every stress result.
- T_COM needs velocities and masses; T_local needs `f_keav`/`c_ke`; quantities whose columns are missing are reported as
  missing, never filled in.
- RDF of a small zone is noisy and truncated at large r by free surfaces; peak positions and shapes are reliable, the
  tail is not.
- Across-run plots need several analysed runs; one run gives one point.
- The installer is unsigned (SmartScreen warning on first start) and Windows-only.

---

## 10. Sources (web research 2026-10-18, plus the project's own reference files)

- LAMMPS manual (release 30 Sep 2026, `Manual.pdf`): `compute stress/atom` sign convention and units; `reference/lammps_fix_compute_output.md`.
- Project survey: `reference/nanocutting_md_literature.md` §5 (forces, μ, specific energy, temperature, stress, chip,
  damage, continuum numbers).
- Chavoshi & Luo, MSEA 654 (2016) 400–417, 3C-SiC nanometric cutting 300–3000 K: RDF and virtual XRD for amorphisation,
  von Mises yield stress −49 % at 3000 K: https://strathprints.strath.ac.uk/56331/
- Hot nanometric cutting of silicon (RDF, coordination, von Mises and hydrostatic stress): https://strathprints.strath.ac.uk/58765/
- GaAs nanoscratch MD + AFM (specific scratch energy, friction coefficient, pile-up): https://strathprints.strath.ac.uk/76686
- OVITO Python reference (modifiers: RDF, coordination, bond-angle distribution, atomic strain, Wigner–Seitz, PTM, CNA,
  Identify diamond, Voronoi, spatial binning, structure factor): https://ovito.org/manual/python/modules/ovito_modifiers.html
- Qt for Python & PyInstaller (why the installer bundles a plain Python instead of freezing): https://doc.qt.io/qtforpython-6/deployment/deployment-pyinstaller.html
- All 16 OVITO modifiers listed above were run on the sample run with OVITO 3.16.0 in the project `.venv` on 2026-10-18
  (all work; structure factor 382 s for 97,815 atoms).
