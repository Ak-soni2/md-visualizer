# NanoCut — LAMMPS deck generator & visualizer for nanometric cutting / nano-scratching MD

Working plan, 2026-10-10. Project folder: `C:\BTP\md-visulaizer`.
Priority stated by Akshay: **accuracy and precision over appearance**. Every design choice below follows from that.

---

## 0. What we already have (ground truth)

### 0.1 Your existing decks (`C:\BTP\Cutting\<R>-<d>\`)

Nine orthogonal-cutting decks (3 edge radii × 3 depths) + the 10-10 log. They all share one structure, which the generator will reproduce exactly:

| Item | Value in your decks | In Å / nm |
|---|---|---|
| units / atom_style / boundary (A) | `metal`, `atomic`, `s s p` | x,y shrink-wrapped; z (width) periodic |
| Workpiece | 3C-SiC, `lattice fcc 4.3667` ×2 (Si at origin 0, C at ¼¼¼) | zinc-blende |
| Workpiece size | `block 0 220 0 100 INF INF` (lattice units) | 96.1 × 43.7 × 3.9 nm |
| Boundary layer (fixed) | bottom 0–5 a, x-end 0–5 a | 2.2 nm |
| Thermostat layer | 5–10 a bottom and x-end | 2.2 nm |
| Tool | diamond, `lattice diamond 3.571`, block 70 × 70 b | 25 × 25 nm, through-width |
| Tool edge radius `lr` | 5 / 10 / 20 b | 1.79 / 3.57 / 7.14 nm |
| Rake angle | 0° (vertical rake face at x = dx) | — |
| Clearance angle | 10° (prism `trimbox2`, `tan(10/180*PI)`) | — |
| Depth of cut | top of workpiece 100 a minus tool bottom `dy` = 97 / 95 / 93 a | 13.1 / 21.8 / 30.6 Å |
| Tool start | x = dx = 220 a or 222 a (end face of workpiece) | gap 0 or 2 a |
| Layers stored as | `fix property/atom mol`, mol 1-3 tool (mob/TS/bd), 4-6 workpiece | survives restart (so do group definitions — manual §read_restart — so the mol tag is mainly useful for colouring layers in dumps) |
| Equilibration (A) | NVT 300 K, Tdamp 0.05 ps, 10 000 × 0.5 fs = 5 ps, `write_restart` | |
| Cutting (B) | `read_restart`, minimize, TS layers NVT (temp/partial 0 1 1), mobile NVE, `fix move linear -v 0 0 units box` on tool boundary layer | v = 2 Å/ps = 200 m/s |
| Cutting length | `Nstep = ceil(600000/v)` or `400000/v` | 30 nm / 20 nm |
| Atoms (10-10) | 1 993 337 (tool 403 568, workpiece 1 589 769), 10 MPI ranks | |
| Potentials | A: `SiC_Erhart-Albe.tersoff`; B: `SiC_1994.tersoff` via `variable potential` | mapping `C Si C` |

Verified today: a scaled-down copy of `10-10/A.txt` runs to completion in the LAMMPS build we will use for validation (47 722 atoms, 20 steps, 3 s) — the validation path works end to end.

### 0.2 Issues in the current decks the generator must not inherit

1. `boundary s p s` in B vs `s s p` in A — ignored by `read_restart` (warning in log) but wrong on paper.
2. Equilibration potential (Erhart-Albe) ≠ cutting potential (Tersoff 1994) unless the variable is changed — the generator will use **one** potential for both decks and name it in the output folder.
3. `timestep 0.0005 # set 1 femtosecond` — comment wrong (0.5 fs). Generator writes correct comments with units.
4. A.txt has a dead "DEFORMATION" block (`fix 1 all nve` with no `run`) — generator writes nothing that doesn't run.
5. **Cutting and thrust forces are never recorded.** Nothing in thermo or files gives F on the tool. Generator adds `compute reduce sum` of per-atom fx/fy/fz over the whole tool group (net force on the tool = force from the workpiece, since tool-internal forces cancel), written every N steps via `fix ave/time` to `forces.txt`. (`compute group/group` is **not** usable here — the manual restricts it to pairwise-evaluable styles; Tersoff/SW are excluded, EAM only approximately. For a rigid tool under `fix setforce` the forces are read from `f_ID[1..3]` instead, because setforce zeroes the per-atom values.)
6. No temperature of the contact zone, no pile-up height, no CNA/coordination in the output — currently all done by hand in OVITO. Generator adds optional per-atom computes (`coord/atom`, `cna/atom`/`centro`, `stress/atom`, `pe/atom`, averaged `ke/atom`) and a region-based contact-zone temperature (`temp/region` following the tool).
7. `velocity all create 300` before any minimization — with a = 4.3667 Å vs the Erhart-Albe equilibrium ≈ 4.36 Å the system heats from 300 K to >700 K in 20 steps (seen in the smoke run). Generator does `minimize` → `velocity create` → NVT.
8. `fix 4 gpCTbd move linear 0 0 0` in A: harmless, but `fix move` + a tool that is also in the NVT group means the boundary layer is integrated twice in spirit (nvt on `gpCTall` includes `gpCTbd`). Generator never time-integrates an atom that is under `fix move` / `setforce`.
9. `fix 12 all ave/atom 10 50 500 c_ke` is computed but never dumped. Generator either dumps it or drops it.
10. Tool starts touching the end face (gap 0). Generator parameterises the gap (default 1 nm) so the first contact is clean.
11. `compute temp/partial 0 1 1` removes the whole x kinetic energy of the workpiece (not just streaming). Generator uses `temp/com` for the tool and a chunk/COM-removed temperature for the contact zone, with the choice exposed.
12. `mass 2 28`/`mass 1 12` truncated — generator uses 28.0855 / 12.011.
13. **Fixed and thermostat groups overlap** in the workpiece: the log gives gpWPbd 119 169 + gpWPtsbd 115 389 + gpWPmob 1 360 800 = 1 595 358, but the workpiece has 1 589 769 atoms, so **5 589 atoms** (the lattice planes at y = 5 a₀ and x = 5 a₀) are in both groups and receive `fix move` *and* `fix nvt` at the same time. The generator defines the thermostat group with `group ... subtract`, so the groups are disjoint (NanoCut: 119 169 / 109 800 / 1 360 800 — fixed and Newtonian counts match the log exactly).

### 0.3 Reference material gathered in this session (`reference/`)

- `Manual.pdf` = LAMMPS manual, release 30 Sep 2026 (3274 pp; text-extracted for grepping).
- Condensed, command-exact references written from it (done): `lammps_setup_commands.md` (34 commands, parsing rules, version-change table), `lammps_fix_compute_output.md` (all fixes/computes/dumps we emit + 16-point error checklist), `potentials_catalogue.md` (~45 bundled files with header-verified element order/units/citations; SiC Tersoff variant differences; ready pair_style/pair_coeff blocks; Morse cross terms with provenance flags), `lammps_python_api.md` (validator recipe; wheel-vs-manual API delta), `nanocutting_md_literature.md` (parameter ranges, output definitions, DOE practice, 15 pitfalls; every number tagged verified/abstract/unverified).
- Literature defaults the schema will carry: fixed layer 2–3 atomic layers, thermostat layer 3–6 (or ≥ cutoff); tool gap ≥ 1 nm; d/r_edge ≤ 0.25 ⇒ rubbing regime warning; dt 1 fs EAM metals, 0.5 fs Tersoff/ABOP SiC, 0.3 fs for a *deformable* Tersoff diamond tool (your decks use 0.5 fs — flagged in the validator, not changed silently); equilibration 25–30 ps typical (yours is 5 ps); steady-state cutting force needs 15–25 nm of travel.
- Open accuracy flags from the catalogue: Si–C Morse D has a factor-10 discrepancy across sources (0.435 vs 4.35 eV); no verified Fe–C/Al–C Morse set; Cu–C has two competing sets. The tool will present these with their sources and refuse to pick silently.
- Validation runtime: LAMMPS 22 Jul 2025 Python wheel in WSL (`~/lmpval`) with MANYBODY, MEAM, EXTRA-COMPUTE/FIX, VORONOI, RIGID, OPENMP. Potential files bundled (SiC_1989/1990/1994/Erhart-Albe/SiC.tersoff/.zbl, SiC.vashishta, SiC.meam, SiC.edip, SiC.gw, Si.sw, Si.tersoff(.mod), Ge.tersoff, SiCGe.tersoff, CH.airebo, C.lcbop, EAM files for Cu/Al/Ni/Fe/…).
- Analysis runtime: OVITO Python module (CNA, DXA, coordination, IdentifyDiamond) installs cleanly in the Windows venv.

---

## 1. Goal and non-goals

**Goal.** A researcher fills in *every* physical and numerical parameter of a nano-cutting / nano-scratching MD experiment (or picks a preset and changes one thing), sees the model geometry and the derived numbers before spending CPU, and downloads a self-contained run folder: `A.in` (build + equilibrate → restart), `B.in` (restart → cut), potential file(s), `run.sh`/`run.bat`, `params.json`, `README`. After the run, the same tool reads the log/dumps and produces the standard quantities (forces, μ, specific energy, temperatures, pile-up height, chip/SSD, CNA/coordination fractions, stress maps) and factorial/sweep summaries.

**Non-goals.** Running production simulations inside the tool (they run on your cluster); replacing OVITO's interactive 3D viewer; predicting results without running (we only compute what is computable analytically — contact mechanics estimates, strain rate, Péclet number, critical depth — and label them as estimates).

---

## 2. Architecture (small, boring, testable)

```
md-visulaizer/
  nanocut/                 Python package (the product)
    schema.py              Experiment dataclass tree + validation + unit conversion (nm↔Å↔lattice units, m/s↔Å/ps)
    materials.py           lattice database: 3C-SiC, Si, Ge, diamond, Cu, Al, Ni, Fe(bcc), W, Au, Ag, Ti(hcp), Mg, 4H/6H-SiC (custom basis)
    potentials.py          catalogue: style, file, element order, cutoff, units, citation, which materials it covers, pair_coeff writer (incl. hybrid/overlay, Morse/LJ cross terms, rigid-tool "no C-C" option)
    geometry.py            tool shapes → LAMMPS region/lattice commands AND the same shape as a mesh/point cloud for preview (single source of truth)
    deck_a.py, deck_b.py   deck writers (pure functions: Experiment → str)
    estimate.py            atom counts (exact, by lattice counting), steps, wall-time (calibrated katom-steps/s per style), memory, strain rate, Péclet, Hertz, Bifano d_c, min. chip thickness
    validate.py            runs the generated A→B pair at reduced scale through the LAMMPS Python module; checks: no error, no lost atoms, atom counts match estimate, forces finite, T stable
    analysis/              log.py (thermo parser), forces.py, dump.py (lammpstrj reader, numpy), metrics.py (pile-up H, contact-zone T, chip & SSD, μ, u_s), ovito_bridge.py (CNA/DXA/coord), doe.py (sweeps, 2^k main effects + interaction, as in the COPEN paper)
    cli.py                 `nanocut gen params.json`, `nanocut validate`, `nanocut analyse run_dir`, `nanocut sweep`
  ui/app.py                Streamlit app: forms, presets, 3D preview (plotly WebGL), estimates panel, warnings, download zip, analysis page
  presets/*.json           your SiC baseline (10-10, 5-20, …), Cu-EAM orthogonal, Si-Tersoff, SiC sphere scratching (COPEN paper), Al, Ni
  potentials/              copies of the potential files we ship (with header citations kept)
  tests/                   golden tests vs C:\BTP\Cutting decks; LAMMPS smoke tests; unit-conversion tests; analysis tests on a tiny run
  reference/               the condensed LAMMPS/literature references (above)
  PLAN.md                  this file
```

Why Python + Streamlit: the core *must* be Python (LAMMPS Python module for validation, OVITO Python for analysis, numpy for dumps). Streamlit gives a parameter-heavy UI in one file; plotly renders 10^5 atoms in WebGL for the preview. Nothing custom is written where a library already does it. (If you later want a prettier standalone web UI, the core package is untouched — only `ui/` changes.)

---

## 3. Parameter schema — everything a researcher can set

Every parameter has: default, unit, allowed range, and a one-line "why/what it controls" tooltip taken from the literature reference. Nothing is hidden; presets just fill defaults.

### 3.1 System
- `units` = metal (fixed; all conversions done for the user), `dimension` = 3, `atom_style` = atomic.
- Boundary per axis: cutting direction x: `s` (shrink) or `f`/`p`; depth y: `s`; width z: `p` (default, "infinite width") or `s`.
- Random seed(s) for velocities (repeat runs → error bars).

### 3.2 Workpiece
- Material (database) → lattice style, constant a₀ (editable), basis, masses, default potential, default CNA/coord cutoffs, elastic constants E, ν, H, K_c (for the estimates).
- Crystal orientation: lattice `orient x/y/z` Miller indices with presets (001)[−100], (001)[−110], (110)[−110], (111)[−110]; integer/orthogonality/right-handedness checked.
- Size Lx, Ly, Lz in nm *or* lattice units (both shown live).
- Layer scheme: boundary-layer thickness, thermostat-layer thickness; which faces carry them (bottom, −x end, +x end, z faces); minimum thickness enforced ≥ potential cutoff.
- Surface preparation: minimize (tolerances), equilibration ensemble/time, optional free-surface relaxation.

### 3.3 Tool
- Material: diamond (default) / other; **rigid** (atoms under `fix move`/`setforce`, no tool-tool potential needed) or **deformable** (own boundary/thermostat/mobile layers like yours, tool–tool potential required).
- Shape (all generated as LAMMPS regions and as preview geometry from the same code):
  - **Wedge (orthogonal cutting)**: rake angle α (−45…+15°), clearance angle γ (0…20°), edge radius r (0…10 nm), rake-face length, flank length, tool height/length; through-width or finite width.
  - **Sphere / hemisphere (scratching, your COPEN model)**: radius R; optional flattened tip.
  - **Cone / pyramid (indenter)**: half-angle, tip radius.
  - **Cylinder (axis ∥ width)** and **flat punch** for completeness.
- Tool lattice orientation and sub-lattice origin offset (your `origin 0 0 0.4`).
- Placement: depth of cut d (surface to lowest tool point), horizontal gap g to the workpiece (default 1 nm), lateral centring in z.
- For scratching: optional **plunge phase** (indent at v_plunge to depth d, dwell, then scratch).

### 3.4 Process
- Cutting speed v (m/s ↔ Å/ps shown together), direction (−x default), cutting length L (nm) ↔ number of steps ↔ simulated time (all three shown; any one editable).
- Multi-pass / feed (phase 2 of the tool; generates B2, B3… from the last restart).
- Time step for A and for B separately (defaults per potential: 0.5 fs Tersoff/SiC/diamond, 1 fs EAM metals), with the "fastest vibration" check.

### 3.5 Potentials
- Workpiece potential from the catalogue filtered by the workpiece elements (Tersoff 1989/1990/1994/Erhart-Albe, Vashishta, SW, EDIP, MEAM, EAM/alloy/fs, AIREBO, LCBOP, Tersoff/ZBL, …).
- Tool potential (if deformable) and **cross interaction**: same many-body file when it covers both (SiC + C), else Morse (D, α, r₀ with literature defaults e.g. Cu–C, Si–C, Al–C, Ni–C, Fe–C) or LJ, via `pair_style hybrid`. Element-to-type mapping written automatically and checked against the file header.
- Potential file copied into the run folder; citation printed in README.

### 3.6 Thermodynamics & integrators
- Initial temperature, velocity distribution (gaussian/uniform), `mom yes rot yes`.
- A (equilibration): minimize on/off; ensemble NVT (Nosé–Hoover, Tdamp), Langevin, Berendsen, velocity-rescale; duration (ps); write_restart name & interval.
- B (cutting): thermostat on thermostat layers only (NVT / Langevin / Berendsen, Tdamp), Newtonian region NVE, boundary layer `fix move` (workpiece: 0 velocity; tool: v) or `setforce 0 0 0` + `velocity set`; temperature compute used by the thermostat (`temp/com` or `temp/partial`) — exposed because it changes the answer.
- Neighbor list settings (`neighbor 2.0 bin`, `neigh_modify delay/every/check`), `comm_modify`, `fix balance`.

### 3.7 Outputs & on-the-fly analysis
- Thermo interval + keywords (step, time, temp of each region, pe, ke, press, Fx/Fy/Fz on tool, cpuremain).
- `forces.txt` via `fix ave/time` (tool force components from `compute group/group` and `compute reduce`), `temps.txt` (workpiece mobile T, tool T, contact-zone T, thermostat-layer T), both at a chosen interval.
- Dump interval and columns: id type mol x y z (vx vy vz) (fx fy fz) c_ke_ave c_pe c_stress[1-6] c_coord c_cna/c_csym c_disp; dump file naming; optional `write_dump` snapshots at fixed cutting distances.
- Per-atom analysis computes switchable (coord/atom with material cutoff; cna/atom for fcc/bcc; centro/atom; stress/atom; displace/atom; chunk-binned temperature/stress fields).
- Restart interval, log file layout, folder naming scheme (`R{r}nm_d{d}nm_v{v}ms_{potential}_{orient}_seed{n}`).

### 3.8 Compute budget (shown live)
- Exact atom count (lattice counting of each region, not an estimate), box size, memory estimate, steps, wall-time estimate from calibrated throughput (we measured Tersoff ≈ 0.44 M atom-steps/s/core on this laptop; cluster value editable), MPI ranks/OpenMP threads → `run.sh` with `mpirun -np N lmp -in A.in` then B.

### 3.9 Design of experiments
- For any parameter: fixed value or list. Full-factorial or one-factor-at-a-time; repeats with different seeds. Generates the folder matrix, `run_all.sh`, `matrix.csv`; after runs, `nanocut sweep-analyse` produces the response table, 2^k main effects + interactions (exactly the formulas of your COPEN paper), and plots.

---

## 4. Phases

| Phase | Deliverable | Acceptance test |
|---|---|---|
| **0 Research** (now) | `reference/*.md`: command-exact LAMMPS syntax for everything we emit, verified potential catalogue, literature parameter ranges & output definitions | Reviewed; every command we emit has a citation line in the reference |
| **1 Schema & databases** | `schema.py`, `materials.py`, `potentials.py`, unit conversions, presets | Unit tests; every material builds a 2×2×2 cell in LAMMPS with the right atom count; every potential file's element list matches the catalogue |
| **2 Geometry & deck A** | `geometry.py`, `deck_a.py`; wedge/sphere/cone tools; layer regions; preview geometry | **Golden test:** parameters of `Cutting/10-10` → generated A reproduces the same regions/atom counts (run both at reduced scale, compare natoms per group exactly); all 9 of your decks reproduced the same way |
| **3 Deck B & run scripts** | `deck_b.py`, run scripts, folder layout, force/temperature outputs | Golden test vs your B decks; A→B chain executes in the WSL runtime at reduced scale; `forces.txt` non-empty and finite |
| **4 Validation & estimates** | `validate.py`, `estimate.py`, physics warnings (overlap, cutoff vs layer thickness, timestep vs potential, tool inside workpiece, box too small vs tool, shrink-wrap with moving tool, thermostat on cutting zone) | Each warning has a unit test that triggers it; estimate.natoms == LAMMPS natoms |
| **5 UI** | `ui/app.py`: presets, all forms, live 3D preview, estimates panel, warnings, zip download, params import/export | Manual walkthrough: rebuild your 10-10 case from the preset, change d and v, download, run smoke |
| **6 Analysis** | `analysis/*`: log/forces/temps parsers, dump reader, pile-up height, contact-zone T, chip & SSD depth, μ, specific energy, CNA/coord/stress maps, OVITO bridge (DXA), plots, report (md/pdf) | Tested on a real short run produced in phase 3; H and T definitions match the COPEN paper; cross-check one case against your OVITO numbers |
| **7 DoE, docs, packaging** | `doe.py`, sweep analysis (main effects/interaction), README, user guide, `pip install -e .` | Regenerate your 2×2 (d, v) matrix and the 3×3 (R, d) matrix from one spec; tutorial run end to end |

Order is strict: 1 → 2 → 3 → 4 are the accuracy core and come before any UI. Each phase ends with its tests green and a short note of what was deliberately left out.

---

## 5. Accuracy guardrails (how we keep this research-grade)

1. **Every emitted command is traceable** to a line in `reference/` taken from the manual of the exact LAMMPS version you run. Styles that need a package (MANYBODY, EXTRA-COMPUTE, RIGID, VORONOI…) are listed in README.
1b. **Restart contract (verified in manual):** the restart keeps box, boundary, groups, masses, pair_style and per-atom data, but **not** Tersoff/SW/EAM coefficients (file-based many-body), fixes, computes, thermo/dump settings, or `newton pair`. Deck B therefore always re-issues `pair_coeff`, every fix/compute, thermo and dumps, and never re-declares `boundary`/`units` differently from A.
2. **Nothing ships untested in LAMMPS**: the UI only offers a download after the reduced-scale A→B dry run passed in the embedded runtime (or, if unavailable, says so explicitly).
3. **Geometry single source of truth**: the region commands and the preview come from the same function, so what you see is what LAMMPS builds; atom counts are exact.
4. **Golden files**: your nine decks are regression anchors.
5. **Units shown everywhere twice** (SI and LAMMPS metal), conversions unit-tested (e.g. 200 m/s = 2 Å/ps; 1 bar·Å³ → eV; stress/atom ÷ atomic volume → GPa).
6. **Physics warnings, not silent fixes**: the tool explains and lets the researcher decide.
7. **Provenance**: `params.json` + git hash of nanocut + LAMMPS version + potential citations are written in every run folder, so any figure can be regenerated.

---

## 6. Decisions I need from you (defaults in bold)

1. UI: **Streamlit (fast, one file, Python-native)** vs custom HTML/JS web app (prettier, 3× the work, same core).
2. Tool default: **deformable diamond with its own layers (as in your decks)** vs rigid.
3. Keep **`mol` tag convention (1-6)** for layers through restarts — yes/no.
4. Default potential for 3C-SiC: **Erhart-Albe 2005 (ABOP)** vs Tersoff 1994 — currently A and B use different ones.
5. Should the first version also cover spherical-grit scratching (COPEN model) — **yes, same code path** — and indentation?
6. WSL runtime: can I use `sudo apt` there if a system library is needed, or stay pip-only (**pip-only works today**)?

---

## 7b. Update (2026-10-10, later)

Added: boundary-condition controls (periodic z = infinitely wide), laser/thermal assistance (`preheat` / `spot` Langevin
moving zone / `power` fix heat in a moving region — all three executed in LAMMPS at reduced scale), mock kinematic
animation tab, Overview tab with images from a real reduced-scale run (`examples/sample_run`), `BIBLE.md`, `SETUP.md`,
`run_ui.bat/.sh`, `make_decks.py`, and the script-based verification (`tools/verify_potentials.py`, `tools/verify_decks.py`,
`tools/make_report.py` → `VERIFICATION_REPORT.md`): 26/26 potential-file checks reproduce the published a₀/E_coh; 9/9 reference
cases PASS with zero unintended differences; one-at-a-time sensitivity diffs change only the expected lines. The gap
convention was aligned with the reference (tool foremost point at x_end + gap). The 22-agent independent verification panel
could not run (weekly agent quota); rerun it after the reset if independent eyes are wanted.

## 7. Status (2026-10-10, v0.1.0)

Built: Phases 1–6 in a first working version (`nanocut/`, `ui/app.py`, `tests/`). Phase 7 (DoE sweeps, docs polish) pending.

Verified against LAMMPS (22 Jul 2025, WSL):
- Full-size `ref_10_10` deck A, `run 0`: 1 992 061 atoms; all 8 group counts identical to NanoCut's lattice enumeration; workpiece fixed/Newtonian counts identical to the reference log (119 169 / 1 360 800); tool 402 292 vs reference 403 568 (−0.3 %, tangent-plane flank construction vs the reference's prism offset).
- Reduced-scale A → B chain executes end to end (minimise, thermostats with `fix_modify temp`, `fix move` tool, `compute reduce` forces, `fix ave/time` force file, moving `temp/region` contact zone, per-atom dumps with averaged KE / stress / coordination).

Design decisions taken (defaults; all switchable in the UI): Streamlit UI; deformable diamond tool with layers; `mol` 1–6 layer tags; Tersoff 1994 (the reference's cutting-stage potential) for 3C-SiC; wedge + sphere tools; regions written in `units box` (Å) computed in Python so preview = deck; thermostat and fixed groups disjoint (reference issue #13); forces by `compute reduce sum` on the tool.

Not done / honest limits: no faked "predicted result" — the only post-run picture offered is from a real reduced-scale MD run or from the user's own dumps; Morse cross terms for Al/Fe/Au/Ag/W are not in the literature we could verify (ZBL fallback flagged); hcp (Ti, 4H-SiC) lattices not implemented; multi-pass cutting and DoE sweep generation pending.
