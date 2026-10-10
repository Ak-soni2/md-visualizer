# NanoCut BIBLE — everything about this project in one file

Last update: 2026-10-10. Owner: Akshay Pratap Singh Verma (B.Tech ME, IIT Jodhpur). Project folder `C:\BTP\md-visulaizer`.

## 0. The one-paragraph version

NanoCut turns a parameter sheet (material, potential, box, layers, tool shape, depth, speed, temperature, laser, outputs) into
the two LAMMPS input decks that nanometric-cutting MD uses — **A** (build + equilibrate → restart file) and **B** (read
restart → cut) — in the exact structure of the reference decks `C:\BTP\Cutting\<R>-<d>\A*.txt, B*.txt`. It shows the model
before any CPU time is spent (exact atom counts, cross-sections, 3-D), animates a schematic of the cut, and reads real
results back (forces, temperatures, pile-up, OVITO-style atom colouring). Accuracy is the design priority: every emitted
command is traceable to the LAMMPS manual (release 30 Sep 2026), every potential file is the official LAMMPS copy verified
by recomputing the authors' lattice constant and cohesive energy, and the generated decks were compared parameter by
parameter with all nine reference cases (`VERIFICATION_REPORT.md`).

## 1. The physics being modelled

Orthogonal nano-cutting (or sphere scratching) of a single crystal by a diamond tool. Coordinates: **x** = cutting
direction (the tool moves toward −x), **y** = depth (surface on top), **z** = width. The workpiece is a block
`[0,Lx]×[0,Ly]×[0,Lz]`; the tool sits beyond `x = Lx` and is driven into the material at the depth of cut *d*.

Three kinds of atoms (stored in the `mol` tag so they survive the restart and colour nicely in OVITO):

| mol | group | what happens to them |
|---|---|---|
| 6 | workpiece fixed (`gpWPbd`) | bottom and back (x = 0) layers, 5 a₀ thick in the reference: `fix move linear 0 0 0` — they never move; they anchor the block |
| 5 | workpiece thermostat (`gpWPtsbd`) | next 5 a₀: Nosé–Hoover at the set temperature; the heat sink the surrounding bulk would provide |
| 4 | workpiece Newtonian (`gpWPmob`) | everything else: plain Newton's law — the cutting-zone heating is an *output* |
| 3 | tool fixed (`gpCTbd`) | top and back of the tool, 3 b thick: `fix move linear −v 0 0` — this is what drives the tool |
| 2 | tool thermostat (`gpCTtsbd`) | next 3 b: Nosé–Hoover |
| 1 | tool Newtonian (`gpCTmob`) | the cutting edge region, free to deform (wear/graphitisation possible) |

Boundaries: `s s p` — free in x and y, **periodic in z** = the slab repeats forever along the width, i.e. an infinitely wide
workpiece and tool. (UI tab 1 → Workpiece → Boundary conditions lets you change this.)

Units are LAMMPS `metal`: Å, ps, eV, K, g/mol, bar. 1 Å/ps = 100 m/s; 1 eV/Å = 1.602 nN; 1 bar·Å³ = 6.24 × 10⁻⁷ eV.

## 2. The reference decks, line by line (what they do and what NanoCut keeps)

`A.txt` (10-10 case): `units metal / boundary s s p / atom_style atomic` → variables in lattice units (a = 4.3667 Å SiC,
b = 3.571 Å diamond, c = a/b) → `lattice fcc a; region whole …; create_box 3` → **tool**: `lattice diamond b origin 0 0 0.4`,
a 70b × 70b block whose lower-left corner is rounded by a cylinder of radius lr·b (`cut_toolB`, `cut_toolR`, `trimbox1`,
union) and whose flank is cut by a 10° prism (`trimbox2`); `create_atoms 1`; boundary/thermostat regions `ctTop/ctxEnd`
(3b) and `ctTSbottom/ctTSxEnd` (next 3b); groups → **workpiece**: two `lattice fcc a` commands (Si at origin 0, C at
origin ¼¼¼ = zinc-blende), `region workpiece block 0 220 0 100`, layers `wpbottom/wpxEnd` (5a) and `wpTSbottom/wpTSxEnd`
→ masses → `pair_style tersoff; pair_coeff * * SiC_Erhart-Albe.tersoff C Si C` → `velocity all create 300`, `fix nvt` on
tool and workpiece, `timestep 0.0005`, `fix move 0` on boundary layers, `fix balance`, `fix property/atom mol` + `set …
mol 1..6`, thermo/dump, `restart 1000 cut_sic_eq.restart`, `run 10000` (5 ps).

`B.txt`: `read_restart cut_sic_eq.restart.10000`, `reset_timestep 0`, `fix 13 all property/atom mol` (same ID re-enables the
tags), groups by `molecule`, masses, `pair_coeff * * SiC_1994.tersoff C Si C` (variable `potential = y94`), `minimize`,
temperature computes (`temp/partial 0 1 1`), `fix nvt` on the thermostat layers with `fix_modify temp`, `fix move 0` on
workpiece boundary, **`fix 4 gpCTbd move linear -$v 0 0 units box`** (v = 2 Å/ps = 200 m/s), `fix nve` on mobile, `fix balance`,
`ke/atom` averaging, dump with stress, `restart`, `run ceil(600000/v)` = 300 000 steps × 0.5 fs = 150 ps → 30 nm of cut.

Parameters of the nine folders (R-d): edge radius lr = 5/10/20 b = 1.79/3.57/7.14 nm; depth (100 − dy) a = 3/5/7 a =
1.31/2.18/3.06 nm; gap (dx − 220) a = 0 or 0.87 nm; cut length 20 or 30 nm. These are the `ref_*` presets.

**What NanoCut keeps identical:** every number above (verified for all nine cases), the A/B split, the layer scheme, the
`mol` tags, the thermostat/timestep/run choices, `fix move` on the tool boundary, `temp/partial 0 1 1`, the dump content.

**What NanoCut changes on purpose** (each is a toggle or documented in `PLAN.md` §0.2): one potential for A and B (the
reference equilibrates with Erhart–Albe and cuts with Tersoff-1994); fixed and thermostat groups made disjoint (the
reference has 5 589 workpiece atoms in both groups → integrated twice); **cutting/thrust/lateral forces recorded**
(`compute reduce sum fx fy fz` on the tool — `compute group/group` is invalid for Tersoff per the manual); contact-zone
temperature (`temp/region` in a cylinder moving with the tool); time-averaged per-atom KE dumped (→ local temperature);
velocities created only for mobile atoms; regions written in Å (`units box`) from Python so that preview = deck; optional
minimisation before velocities; ASCII-only comments; explicit `write_restart <name>_A.restart` / `read_restart <name>_A.restart`.

## 3. Potentials — source of truth and verification

Files in `potentials/` are byte copies from the official LAMMPS distribution (`potentials/` directory of release
22 Jul 2025, inside the `lammps==2025.7.22.4.0` PyPI wheel). Their headers carry `DATE:`/`CITATION:` lines.
`tools/verify_potentials.py` builds a crystal with each file in LAMMPS and relaxes it; the resulting a₀ and E_coh match the
published values (table in `VERIFICATION_REPORT.md`). Key facts:

| file | what it is | a₀ (Å) / E_coh (eV/atom) from LAMMPS | published |
|---|---|---|---|
| SiC_Erhart-Albe.tersoff | ABOP Si–C, Erhart & Albe PRB 71, 035211 (2005) | 4.3593 / 6.339 | 4.359 / 6.340 |
| SiC_1994.tersoff | Tersoff PRB 49, 16349 (1994) (B-stage potential of the reference) | 4.280 / 6.434 | known 1–2 % small a₀ |
| SiC.tersoff, SiC_1989 | Tersoff PRB 39, 5566 (1989) | 4.321 / 6.164 | 4.32 (Tersoff) |
| SiC.vashishta | Vashishta et al. JAP 101, 103515 (2007) — rigid tool only | 4.358 / 6.340 | 4.36 |
| Si.sw / Si.tersoff / Si.tersoff.mod | SW 1985 / Tersoff 1988 / Kumagai 2007 | 5.431 / 4.337; 5.431 / 4.630; 5.429 / 4.630 | same |
| Cu_mishin1, Cu_zhou, Cu_u3 | Mishin 2001 / Zhou 2004 / Foiles 1986 | 3.615 / 3.540 | 3.615 / 3.54 |
| Al_zhou, Al_mm | Zhou 2004 / Mendelev 2008 | 4.082 / 3.580; 4.045 / 3.411 | Zhou fit 3.58; expt 3.36 |
| Ni_u3, Au_u3, Ag_u3 | Foiles, Baskes, Daw 1986 | 3.520/4.450; 4.080/3.930; 4.090/2.850 | same |
| Fe_mm, W_zhou | Mendelev 2003 / Zhou 2004 | 2.8553/4.122; 3.165/8.760 | 2.8553/4.122; 3.165/8.89 |

Tool–workpiece cross terms when the workpiece potential has no carbon: Morse Cu–C (0.087 eV, 5.14 Å⁻¹, 2.05 Å),
Si–C (0.435, 4.6487, 1.9475), Ge–C (0.125778, 2.58219, 2.2324), Ni–C (0.100, 2.2, 2.4; partially verified); otherwise ZBL
repulsion, flagged. Deformable tool C–C from the Tersoff-1989 carbon entry.

## 4. Laser / thermal assistance (what the literature does and what NanoCut offers)

Most MD "laser-assisted machining" papers represent the laser as **uniform preheating** of the workpiece
(Chu et al., *Micromachines* 16(12) 1411 (2025): 300–1200 K for Si; Liu et al., *Int. J. Mach. Tools Manuf.* 2024 for RB-SiC).
A **local moving heated zone** is done with a Langevin thermostat on a dynamic group inside a region that moves with the tool
(LAMMPS forum "Moving laser as a heat source"; spherical heat-source precedent in *J. Manuf. Mater. Process.* 2(3) 51 (2018)).
NanoCut: `laser.mode = preheat | spot | power`. `spot` = `region laser cylinder … move v_xdisp` + `group laserzone dynamic
gpWPmob region laser every 10` + `fix langevin` at `spot_K`; `power` = `fix heat 10 P` on the same zone. The zone temperature is
written to the force/temperature file (`Tlaser_K`). Ductile–brittle guidance shown in the UI uses Bifano's
d_c = 0.15 (E/H)(K_c/H)² at room temperature and the experimental observation that laser heating raises the DBT depth
(4H-SiC scratching: 105 → 240 nm). The simulation decides the regime; the UI only frames the comparison.

## 5. Outputs of a run and how they are computed

- `<name>_forces_temps.txt` (fix ave/time): step, F_c, F_t, F_z in nN (time-averaged sums of per-atom forces on the tool;
  +x = resistance), temperatures of the workpiece Newtonian zone, contact zone, thermostat layers, tool (COM-corrected), laser zone.
- `<name>_cut.*.lammpstrj`: id type mol x y z vx vy vz fx fy fz c_ke f_keav c_pe c_s[1..6] c_cn (+ c_cna for metals).
  Local temperature T_i = 2⟨KE_i⟩/(3k_B); von Mises from c_s/Ω/10⁴ (Ω = atomic volume, 10.4 Å³ for 3C-SiC); coordination 4 = sp³.
- Results tab: friction coefficient F_c/F_t (steady part), chip/pile-up height (max y above the undeformed surface), surface
  profile, contact-zone temperature with COM velocity removed, coordination histogram.

## 6. Files

| path | role |
|---|---|
| `ui/app.py` | the visualiser (Overview, Setup, Preview, Mock animation, Decks, Validate/preview run, Results, Help) |
| `make_decks.py` | generate A/B from a preset or params.json on the command line |
| `nanocut/schema.py` | all parameters + hard validation |
| `nanocut/materials.py`, `nanocut/potentials.py` | databases |
| `nanocut/lattice.py`, `nanocut/geometry.py` | exact atom enumeration; tool/workpiece/layer/laser geometry |
| `nanocut/deck.py` | deck writers A/B, run scripts, provenance |
| `nanocut/mock.py` | schematic animation |
| `nanocut/runner.py` | WSL LAMMPS runner (optional) |
| `nanocut/analysis.py` | dump/log/force parsers, metrics |
| `tools/verify_*.py`, `tools/make_report.py` | verification scripts → `VERIFICATION_REPORT.md` |
| `examples/sample_run/` | three frames + force file + images from a real reduced-scale run |
| `reference/` | condensed manual sections, potential catalogue, literature survey |
| `PLAN.md`, `SETUP.md`, `README.md` | plan + reference-deck issues; setup; overview |

## 7. Known limits

No faked predictions (the mock is labelled as such). Morse sets for Al/Fe/Au/Ag/W–C unverified → ZBL fallback. hcp
lattices (Ti, 4H-SiC) not implemented. Multi-pass cutting and DoE sweep generation pending. Sub-agent verification panel
(independent re-check of every file by 20+ agents) could not run on 2026-10-10 because the account's weekly agent quota was
exhausted; the same checks were done by scripts instead.

### 4b. Making the heat source visible in OVITO
Regions are not atoms, so B writes `v_inlaser` (= `rmask(laser)`, 1 inside the moving zone) as a dump column; colour or
select by it in OVITO, and colour by `f_keav` to see the heat. The zone's own temperature is in `Tlaser_K` of the force file.
