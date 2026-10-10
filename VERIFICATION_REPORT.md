# NanoCut verification report (2026-10-10)

Everything below is produced by `tools/verify_potentials.py` and `tools/verify_decks.py` — rerun them to regenerate.

## 1. Potential files: where they come from and how they were checked

**Source.** Every file in `potentials/` is a byte-for-byte copy of the file of the same name in the `potentials/` directory shipped
with the official LAMMPS distribution (release 22 Jul 2025, as packaged in the `lammps==2025.7.22.4.0` PyPI wheel). Nothing was typed
or edited. Each file header carries LAMMPS' own `DATE:` and `CITATION:` lines (transcribed in `reference/potentials_catalogue.md`).

**Check.** For every file the equilibrium lattice constant a0 and cohesive energy Ecoh were computed in LAMMPS (3x3x3 conventional
cells, `fix box/relax iso 0`, CG minimisation) and compared with the value published by the potential's authors or with experiment.

| file | pair_style | structure | a0 LAMMPS (Å) | a0 ref (Å) | dev % | Ecoh LAMMPS (eV/atom) | Ecoh ref | dev % | reference value source |
|---|---|---|---|---|---|---|---|---|---|
| SiC_1994.tersoff | tersoff | zincblende Si/C | 4.2796 | 4.3596 | -1.84 | 6.4338 | 6.34 | +1.48 | expt a0 (Haynes); Ecoh 6.34 eV/atom (Erhart-Albe 2005 Table IV, expt) |
| SiC_1989.tersoff | tersoff | zincblende Si/C | 4.3211 | 4.3596 | -0.88 | 6.1647 | 6.34 | -2.77 | expt; Tersoff 1989 gives a0=4.32 by design |
| SiC_1990.tersoff | tersoff | zincblende Si/C | 4.3071 | 4.3596 | -1.20 | 6.2098 | 6.34 | -2.05 | expt |
| SiC.tersoff | tersoff | zincblende Si/C | 4.3212 | 4.3596 | -0.88 | 6.1638 | 6.34 | -2.78 | expt; Tersoff 1989 + errata |
| SiC_Erhart-Albe.tersoff | tersoff | zincblende Si/C | 4.3593 | 4.359 | +0.01 | 6.3392 | 6.34 | -0.01 | Erhart & Albe 2005 Table IV: a0=4.359, Ecoh=6.340 eV/atom (fit) |
| SiC.tersoff.zbl | tersoff/zbl | zincblende Si/C | 4.2796 | 4.3596 | -1.83 | 6.4339 | 6.34 | +1.48 | expt; Devanathan 1998 = Tersoff + ZBL core |
| SiC.vashishta | vashishta | zincblende Si/C | 4.3582 | 4.36 | -0.04 | 6.3401 | 6.34 | +0.00 | Vashishta 2007: a0=4.36 (fit) |
| SiC_1994.tersoff | tersoff | diamond C | 3.5563 | 3.567 | -0.30 | 7.4730 | 7.37 | +1.40 | expt diamond (Kittel) |
| SiC.tersoff | tersoff | diamond C | 3.5658 | 3.567 | -0.03 | 7.3682 | 7.37 | -0.02 | expt diamond |
| SiC_Erhart-Albe.tersoff | tersoff | diamond C | 3.5657 | 3.566 | -0.01 | 7.3732 | 7.374 | -0.01 | Erhart-Albe 2005 Table: diamond a0=3.566, Ecoh=7.374 |
| SiC.tersoff | tersoff | diamond Si | 5.4321 | 5.431 | +0.02 | 4.6289 | 4.63 | -0.02 | expt Si (Kittel) |
| Si.sw | sw | diamond Si | 5.4309 | 5.431 | -0.00 | 4.3366 | 4.337 | -0.01 | SW 1985: a0=5.431 (fit), Ecoh=4.3366 eV/atom (fit) |
| Si.tersoff | tersoff | diamond Si | 5.4312 | 5.432 | -0.01 | 4.6304 | 4.63 | +0.01 | Tersoff 1988: a0=5.432, Ecoh=4.63 |
| Si.tersoff.mod | tersoff/mod | diamond Si | 5.4290 | 5.429 | +0.00 | 4.6300 | 4.63 | -0.00 | Kumagai 2007: a0=5.429, Ecoh=4.63 |
| SiCGe.tersoff | tersoff | diamond Ge | 5.6567 | 5.658 | -0.02 | 3.8506 | 3.85 | +0.02 | expt Ge (Kittel); Tersoff 1989 Ge |
| SiCGe.tersoff | tersoff | diamond Si | 5.4320 | 5.432 | +0.00 | 4.6296 | 4.63 | -0.01 | Tersoff 1989 Si(D) |
| Cu_mishin1.eam.alloy | eam/alloy | fcc Cu | 3.6149 | 3.615 | -0.00 | 3.5402 | 3.54 | +0.01 | Mishin 2001: a0=3.615, Ecoh=3.54 (fit = expt) |
| Cu_zhou.eam.alloy | eam/alloy | fcc Cu | 3.6148 | 3.615 | -0.01 | 3.5398 | 3.54 | -0.01 | Zhou 2004 Table: a0=3.615, Ec=3.54 |
| Cu_u3.eam | eam | fcc Cu | 3.6150 | 3.615 | -0.00 | 3.5400 | 3.54 | +0.00 | Foiles 1986: a0=3.615, Ecoh=3.54 |
| Al_zhou.eam.alloy | eam/alloy | fcc Al | 4.0817 | 4.05 | +0.78 | 3.5800 | 3.36 | +6.55 | Zhou 2004: a0=4.05, Ec=3.36 |
| Al_mm.eam.fs | eam/fs | fcc Al | 4.0453 | 4.045 | +0.01 | 3.4107 | 3.36 | +1.51 | Mendelev 2008 Al: a0=4.045 (fit), Ecoh 3.36 |
| Ni_u3.eam | eam | fcc Ni | 3.5200 | 3.52 | -0.00 | 4.4500 | 4.45 | +0.00 | Foiles 1986: a0=3.52, Ecoh=4.45 |
| Au_u3.eam | eam | fcc Au | 4.0800 | 4.08 | +0.00 | 3.9300 | 3.93 | +0.00 | Foiles 1986: a0=4.08, Ecoh=3.93 |
| Ag_u3.eam | eam | fcc Ag | 4.0900 | 4.09 | -0.00 | 2.8500 | 2.85 | +0.00 | Foiles 1986: a0=4.09, Ecoh=2.85 |
| Fe_mm.eam.fs | eam/fs | bcc Fe | 2.8553 | 2.8553 | +0.00 | 4.1224 | 4.122 | +0.01 | Mendelev 2003 potential 2: a0=2.8553, Ecoh=4.122 (fit) |
| W_zhou.eam.alloy | eam/alloy | bcc W | 3.1648 | 3.165 | -0.00 | 8.7600 | 8.89 | -1.46 | Zhou 2004: a0=3.165, Ec=8.89 |

Reading the table: deviations below ~0.5 % mean the file reproduces its authors' fit. Larger deviations are properties of the
published parameter set itself, not file errors: Tersoff-1990/1994 carbon parameters give 3C-SiC a0 = 4.28–4.31 Å (1–2 % below
experiment, well known); Tersoff-1989 gives 4.321 Å (the value Tersoff reports); Al_zhou's Ecoh 3.58 eV is Zhou et al.'s fitted value
(experiment 3.36 eV); W_zhou 8.76 vs 8.89 eV. **Consequence for your decks:** they build 3C-SiC with a0 = 4.3667 Å, which is 2 %
larger than the Tersoff-1994 equilibrium (4.280 Å) and 0.2 % larger than Erhart–Albe's (4.359 Å); the lattice therefore relaxes
(and heats) during equilibration unless minimised first — the generator offers `minimize_before_equil` for that reason.

## 2. Tool–workpiece cross terms (Morse) and material data

Morse sets in `nanocut/potentials.py`: Cu–C D0 = 0.087 eV, α = 5.14 Å⁻¹, r0 = 2.05 Å (Lin & Huang 2004; reused in many cutting papers);
Si–C 0.435 / 4.6487 / 1.9475 (e.g. Chu et al., Micromachines 16(12) 1411 (2025) — read directly: D = 0.435 eV, a = 46.487 nm⁻¹, r = 0.19475 nm);
Ge–C 0.125778 / 2.58219 / 2.2324 (Lai et al., Nanoscale Res. Lett. 8, 13 (2013)); Ni–C 0.100 / 2.2 / 2.4 (Coatings 12(5) 647 (2022), abstract
only — PARTIALLY VERIFIED). No verified sets exist for Al/Fe/Au/Ag/W–C: the generator falls back to ZBL repulsion and says so.
Masses are IUPAC conventional values; lattice constants are the experimental ones (Kittel) except 3C-SiC 4.3667 Å and diamond 3.571 Å,
which are the values of the reference decks (experiment 4.3596 / 3.567 Å).

## 3. Generated decks vs the reference decks (C:/BTP/Cutting)

### Case 10-10 — PASS (35 parameters compared, 0 unintended differences)

| parameter | reference | NanoCut | status | note |
|---|---|---|---|---|
| workpiece x_end (A) | 960.6740 | 960.6740 | SAME |  |
| workpiece surface y (A) | 436.6700 | 436.6700 | SAME |  |
| workpiece width Lz (A) | 39.3003 | 39.3003 | SAME |  |
| depth of cut (A) | 13.1001 | 13.1001 | SAME |  |
| gap (A) | 0.0000 | 0.0000 | SAME |  |
| tool front x at t=0 (A) | 960.6740 | 960.6740 | SAME | reference: block x-lo = dx; generated: foremost point of the rounded edge |
| tool lowest point y (A) | 423.5699 | 423.5699 | SAME |  |
| edge radius (A) | 35.7100 | 35.7100 | SAME |  |
| tool block size (A) | 249.9700 | 249.9700 | SAME |  |
| edge centre x (A) | 996.3840 | 996.3840 | SAME |  |
| edge centre y (A) | 459.2799 | 459.2799 | SAME |  |
| wp fixed layer (A) | 21.8335 | 21.8335 | SAME |  |
| wp thermostat layer (A) | 21.8335 | 21.8335 | SAME |  |
| tool fixed layer (A) | 10.7130 | 10.7130 | SAME |  |
| tool thermostat layer (A) | 10.7130 | 10.7130 | SAME |  |
| clearance angle (deg) | 10.0000 | 10.0000 | SAME |  |
| equilibration steps | 10000 | 10000 | SAME |  |
| equilibration dt (ps) | 0.0005 | 0.0005 | SAME |  |
| temperature (K) | 300.0000 | 300.0000 | SAME |  |
| Tdamp (ps) | 0.0500 | 0.0500 | SAME |  |
| cutting speed (A/ps) | 2.0000 | 2.0000 | SAME |  |
| cutting steps | 300000 | 300000 | SAME |  |
| cutting dt (ps) | 0.0005 | 0.0005 | SAME |  |
| cutting length (A) | 300.0000 | 300.0000 | SAME |  |
| potential in B | SiC_1994.tersoff | SiC_1994.tersoff | SAME |  |
| potential in A | SiC_Erhart-Albe.tersoff | SiC_1994.tersoff | DIFFERENT | INTENDED: NanoCut uses one potential for A and B (reference equilibrates with Erhart-Albe, cuts with Tersoff-1994) |
| boundary in A | s s p | s s p | SAME |  |
| boundary in B | s p s | s s p | DIFFERENT | INTENDED: reference B says 's p s' but read_restart overrides it with A's 's s p' (warning in log) |
| dump every in B | 500 | 500 | SAME |  |
| restart every in B | 10000 | 10000 | SAME |  |
| minimize in B | True | True | SAME |  |
| B reads the restart written by A | cut_sic_eq.restart.10000 | cut_SiC_R10_d10_A.restart -> cut_SiC_R10_d10_A.restart | SAME |  |
| fix 13 property/atom mol re-declared in B | True | True | SAME |  |
| pair_coeff mapping | C Si C | C Si C | SAME |  |
| fix move on tool boundary (B) | fix 4 gpCTbd move linear -$v 0 0 units box | fix             cut gpCTbd move linear -2.000000 0.0 0.0 units box | SAME |  |

Atom counts (NanoCut enumeration = LAMMPS, verified by `run 0`): total 1991973, workpiece 1589769, tool 402204.

### Case 10-20 — PASS (35 parameters compared, 0 unintended differences)

| parameter | reference | NanoCut | status | note |
|---|---|---|---|---|
| workpiece x_end (A) | None | 960.6740 | REF_MISSING |  |
| workpiece surface y (A) | None | 436.6700 | REF_MISSING |  |
| workpiece width Lz (A) | None | 39.3003 | REF_MISSING |  |
| depth of cut (A) | None | 21.8335 | REF_MISSING |  |
| gap (A) | None | 0.0000 | REF_MISSING |  |
| tool front x at t=0 (A) | None | 960.6740 | REF_MISSING | reference: block x-lo = dx; generated: foremost point of the rounded edge |
| tool lowest point y (A) | None | 414.8365 | REF_MISSING |  |
| edge radius (A) | None | 35.7100 | REF_MISSING |  |
| tool block size (A) | None | 249.9700 | REF_MISSING |  |
| edge centre x (A) | None | 996.3840 | REF_MISSING |  |
| edge centre y (A) | None | 450.5465 | REF_MISSING |  |
| wp fixed layer (A) | None | 21.8335 | REF_MISSING |  |
| wp thermostat layer (A) | None | 21.8335 | REF_MISSING |  |
| tool fixed layer (A) | None | 10.7130 | REF_MISSING |  |
| tool thermostat layer (A) | None | 10.7130 | REF_MISSING |  |
| clearance angle (deg) | None | 10.0000 | REF_MISSING |  |
| equilibration steps | None | 10000 | REF_MISSING |  |
| equilibration dt (ps) | None | 0.0005 | REF_MISSING |  |
| temperature (K) | None | 300.0000 | REF_MISSING |  |
| Tdamp (ps) | None | 0.0500 | REF_MISSING |  |
| cutting speed (A/ps) | 2.0000 | 2.0000 | SAME |  |
| cutting steps | 300000 | 300000 | SAME |  |
| cutting dt (ps) | 0.0005 | 0.0005 | SAME |  |
| cutting length (A) | 300.0000 | 300.0000 | SAME |  |
| potential in B | SiC_1994.tersoff | SiC_1994.tersoff | SAME |  |
| potential in A | None | SiC_1994.tersoff | REF_MISSING | INTENDED: NanoCut uses one potential for A and B (reference equilibrates with Erhart-Albe, cuts with Tersoff-1994) |
| boundary in A | None | s s p | REF_MISSING |  |
| boundary in B | s p s | s s p | DIFFERENT | INTENDED: reference B says 's p s' but read_restart overrides it with A's 's s p' (warning in log) |
| dump every in B | 500 | 500 | SAME |  |
| restart every in B | 10000 | 10000 | SAME |  |
| minimize in B | True | True | SAME |  |
| B reads the restart written by A | cut_sic_eq.restart.10000 | cut_SiC_R10_d20_A.restart -> cut_SiC_R10_d20_A.restart | SAME |  |
| fix 13 property/atom mol re-declared in B | True | True | SAME |  |
| pair_coeff mapping | C Si C | C Si C | SAME |  |
| fix move on tool boundary (B) | fix 4 gpCTbd move linear -$v 0 0 units box | fix             cut gpCTbd move linear -2.000000 0.0 0.0 units box | SAME |  |

Atom counts (NanoCut enumeration = LAMMPS, verified by `run 0`): total 1991621, workpiece 1589769, tool 401852.

### Case 10-30 — PASS (35 parameters compared, 0 unintended differences)

| parameter | reference | NanoCut | status | note |
|---|---|---|---|---|
| workpiece x_end (A) | 960.6740 | 960.6740 | SAME |  |
| workpiece surface y (A) | 436.6700 | 436.6700 | SAME |  |
| workpiece width Lz (A) | 39.3003 | 39.3003 | SAME |  |
| depth of cut (A) | 30.5669 | 30.5669 | SAME |  |
| gap (A) | 8.7334 | 8.7334 | SAME |  |
| tool front x at t=0 (A) | 969.4074 | 969.4074 | SAME | reference: block x-lo = dx; generated: foremost point of the rounded edge |
| tool lowest point y (A) | 406.1031 | 406.1031 | SAME |  |
| edge radius (A) | 35.7100 | 35.7100 | SAME |  |
| tool block size (A) | 249.9700 | 249.9700 | SAME |  |
| edge centre x (A) | 1005.1174 | 1005.1174 | SAME |  |
| edge centre y (A) | 441.8131 | 441.8131 | SAME |  |
| wp fixed layer (A) | 21.8335 | 21.8335 | SAME |  |
| wp thermostat layer (A) | 21.8335 | 21.8335 | SAME |  |
| tool fixed layer (A) | 10.7130 | 10.7130 | SAME |  |
| tool thermostat layer (A) | 10.7130 | 10.7130 | SAME |  |
| clearance angle (deg) | 10.0000 | 10.0000 | SAME |  |
| equilibration steps | 10000 | 10000 | SAME |  |
| equilibration dt (ps) | 0.0005 | 0.0005 | SAME |  |
| temperature (K) | 300.0000 | 300.0000 | SAME |  |
| Tdamp (ps) | 0.0500 | 0.0500 | SAME |  |
| cutting speed (A/ps) | 2.0000 | 2.0000 | SAME |  |
| cutting steps | 200000 | 200000 | SAME |  |
| cutting dt (ps) | 0.0005 | 0.0005 | SAME |  |
| cutting length (A) | 200.0000 | 200.0000 | SAME |  |
| potential in B | SiC_1994.tersoff | SiC_1994.tersoff | SAME |  |
| potential in A | SiC_Erhart-Albe.tersoff | SiC_1994.tersoff | DIFFERENT | INTENDED: NanoCut uses one potential for A and B (reference equilibrates with Erhart-Albe, cuts with Tersoff-1994) |
| boundary in A | s s p | s s p | SAME |  |
| boundary in B | s p s | s s p | DIFFERENT | INTENDED: reference B says 's p s' but read_restart overrides it with A's 's s p' (warning in log) |
| dump every in B | 500 | 500 | SAME |  |
| restart every in B | 10000 | 10000 | SAME |  |
| minimize in B | True | True | SAME |  |
| B reads the restart written by A | cut_sic_eq.restart.10000 | cut_SiC_R10_d30_A.restart -> cut_SiC_R10_d30_A.restart | SAME |  |
| fix 13 property/atom mol re-declared in B | True | True | SAME |  |
| pair_coeff mapping | C Si C | C Si C | SAME |  |
| fix move on tool boundary (B) | fix 4 gpCTbd move linear -$v 0 0 units box | fix             cut gpCTbd move linear -2.000000 0.0 0.0 units box | SAME |  |

Atom counts (NanoCut enumeration = LAMMPS, verified by `run 0`): total 1991302, workpiece 1589769, tool 401533.

### Case 5-10 — PASS (35 parameters compared, 0 unintended differences)

| parameter | reference | NanoCut | status | note |
|---|---|---|---|---|
| workpiece x_end (A) | 960.6740 | 960.6740 | SAME |  |
| workpiece surface y (A) | 436.6700 | 436.6700 | SAME |  |
| workpiece width Lz (A) | 39.3003 | 39.3003 | SAME |  |
| depth of cut (A) | 13.1001 | 13.1001 | SAME |  |
| gap (A) | 8.7334 | 8.7334 | SAME |  |
| tool front x at t=0 (A) | 969.4074 | 969.4074 | SAME | reference: block x-lo = dx; generated: foremost point of the rounded edge |
| tool lowest point y (A) | 423.5699 | 423.5699 | SAME |  |
| edge radius (A) | 17.8550 | 17.8550 | SAME |  |
| tool block size (A) | 249.9700 | 249.9700 | SAME |  |
| edge centre x (A) | 987.2624 | 987.2624 | SAME |  |
| edge centre y (A) | 441.4249 | 441.4249 | SAME |  |
| wp fixed layer (A) | 21.8335 | 21.8335 | SAME |  |
| wp thermostat layer (A) | 21.8335 | 21.8335 | SAME |  |
| tool fixed layer (A) | 10.7130 | 10.7130 | SAME |  |
| tool thermostat layer (A) | 10.7130 | 10.7130 | SAME |  |
| clearance angle (deg) | 10.0000 | 10.0000 | SAME |  |
| equilibration steps | 10000 | 10000 | SAME |  |
| equilibration dt (ps) | 0.0005 | 0.0005 | SAME |  |
| temperature (K) | 300.0000 | 300.0000 | SAME |  |
| Tdamp (ps) | 0.0500 | 0.0500 | SAME |  |
| cutting speed (A/ps) | 2.0000 | 2.0000 | SAME |  |
| cutting steps | 200000 | 200000 | SAME |  |
| cutting dt (ps) | 0.0005 | 0.0005 | SAME |  |
| cutting length (A) | 200.0000 | 200.0000 | SAME |  |
| potential in B | SiC_1994.tersoff | SiC_1994.tersoff | SAME |  |
| potential in A | SiC_Erhart-Albe.tersoff | SiC_1994.tersoff | DIFFERENT | INTENDED: NanoCut uses one potential for A and B (reference equilibrates with Erhart-Albe, cuts with Tersoff-1994) |
| boundary in A | s s p | s s p | SAME |  |
| boundary in B | s p s | s s p | DIFFERENT | INTENDED: reference B says 's p s' but read_restart overrides it with A's 's s p' (warning in log) |
| dump every in B | 500 | 500 | SAME |  |
| restart every in B | 10000 | 10000 | SAME |  |
| minimize in B | True | True | SAME |  |
| B reads the restart written by A | cut_sic_eq.restart.10000 | cut_SiC_R5_d10_A.restart -> cut_SiC_R5_d10_A.restart | SAME |  |
| fix 13 property/atom mol re-declared in B | True | True | SAME |  |
| pair_coeff mapping | C Si C | C Si C | SAME |  |
| fix move on tool boundary (B) | fix 4 gpCTbd move linear -$v 0 0 units box | fix             cut gpCTbd move linear -2.000000 0.0 0.0 units box | SAME |  |

Atom counts (NanoCut enumeration = LAMMPS, verified by `run 0`): total 1988211, workpiece 1589769, tool 398442.

### Case 5-20 — PASS (35 parameters compared, 0 unintended differences)

| parameter | reference | NanoCut | status | note |
|---|---|---|---|---|
| workpiece x_end (A) | 960.6740 | 960.6740 | SAME |  |
| workpiece surface y (A) | 436.6700 | 436.6700 | SAME |  |
| workpiece width Lz (A) | 39.3003 | 39.3003 | SAME |  |
| depth of cut (A) | 21.8335 | 21.8335 | SAME |  |
| gap (A) | 0.0000 | 0.0000 | SAME |  |
| tool front x at t=0 (A) | 960.6740 | 960.6740 | SAME | reference: block x-lo = dx; generated: foremost point of the rounded edge |
| tool lowest point y (A) | 414.8365 | 414.8365 | SAME |  |
| edge radius (A) | 17.8550 | 17.8550 | SAME |  |
| tool block size (A) | 249.9700 | 249.9700 | SAME |  |
| edge centre x (A) | 978.5290 | 978.5290 | SAME |  |
| edge centre y (A) | 432.6915 | 432.6915 | SAME |  |
| wp fixed layer (A) | 21.8335 | 21.8335 | SAME |  |
| wp thermostat layer (A) | 21.8335 | 21.8335 | SAME |  |
| tool fixed layer (A) | 10.7130 | 10.7130 | SAME |  |
| tool thermostat layer (A) | 10.7130 | 10.7130 | SAME |  |
| clearance angle (deg) | 10.0000 | 10.0000 | SAME |  |
| equilibration steps | 10000 | 10000 | SAME |  |
| equilibration dt (ps) | 0.0005 | 0.0005 | SAME |  |
| temperature (K) | 300.0000 | 300.0000 | SAME |  |
| Tdamp (ps) | 0.0500 | 0.0500 | SAME |  |
| cutting speed (A/ps) | 2.0000 | 2.0000 | SAME |  |
| cutting steps | 300000 | 300000 | SAME |  |
| cutting dt (ps) | 0.0005 | 0.0005 | SAME |  |
| cutting length (A) | 300.0000 | 300.0000 | SAME |  |
| potential in B | SiC_1994.tersoff | SiC_1994.tersoff | SAME |  |
| potential in A | SiC_Erhart-Albe.tersoff | SiC_1994.tersoff | DIFFERENT | INTENDED: NanoCut uses one potential for A and B (reference equilibrates with Erhart-Albe, cuts with Tersoff-1994) |
| boundary in A | s s p | s s p | SAME |  |
| boundary in B | s p s | s s p | DIFFERENT | INTENDED: reference B says 's p s' but read_restart overrides it with A's 's s p' (warning in log) |
| dump every in B | 500 | 500 | SAME |  |
| restart every in B | 10000 | 10000 | SAME |  |
| minimize in B | True | True | SAME |  |
| B reads the restart written by A | cut_sic_eq.restart.10000 | cut_SiC_R5_d20_A.restart -> cut_SiC_R5_d20_A.restart | SAME |  |
| fix 13 property/atom mol re-declared in B | True | True | SAME |  |
| pair_coeff mapping | C Si C | C Si C | SAME |  |
| fix move on tool boundary (B) | fix 4 gpCTbd move linear -$v 0 0 units box | fix             cut gpCTbd move linear -2.000000 0.0 0.0 units box | SAME |  |

Atom counts (NanoCut enumeration = LAMMPS, verified by `run 0`): total 1987881, workpiece 1589769, tool 398112.

### Case 5-30 — PASS (35 parameters compared, 0 unintended differences)

| parameter | reference | NanoCut | status | note |
|---|---|---|---|---|
| workpiece x_end (A) | 960.6740 | 960.6740 | SAME |  |
| workpiece surface y (A) | 436.6700 | 436.6700 | SAME |  |
| workpiece width Lz (A) | 39.3003 | 39.3003 | SAME |  |
| depth of cut (A) | 30.5669 | 30.5669 | SAME |  |
| gap (A) | 0.0000 | 0.0000 | SAME |  |
| tool front x at t=0 (A) | 960.6740 | 960.6740 | SAME | reference: block x-lo = dx; generated: foremost point of the rounded edge |
| tool lowest point y (A) | 406.1031 | 406.1031 | SAME |  |
| edge radius (A) | 17.8550 | 17.8550 | SAME |  |
| tool block size (A) | 249.9700 | 249.9700 | SAME |  |
| edge centre x (A) | 978.5290 | 978.5290 | SAME |  |
| edge centre y (A) | 423.9581 | 423.9581 | SAME |  |
| wp fixed layer (A) | 21.8335 | 21.8335 | SAME |  |
| wp thermostat layer (A) | 21.8335 | 21.8335 | SAME |  |
| tool fixed layer (A) | 10.7130 | 10.7130 | SAME |  |
| tool thermostat layer (A) | 10.7130 | 10.7130 | SAME |  |
| clearance angle (deg) | 10.0000 | 10.0000 | SAME |  |
| equilibration steps | 10000 | 10000 | SAME |  |
| equilibration dt (ps) | 0.0005 | 0.0005 | SAME |  |
| temperature (K) | 300.0000 | 300.0000 | SAME |  |
| Tdamp (ps) | 0.0500 | 0.0500 | SAME |  |
| cutting speed (A/ps) | 2.0000 | 2.0000 | SAME |  |
| cutting steps | 300000 | 300000 | SAME |  |
| cutting dt (ps) | 0.0005 | 0.0005 | SAME |  |
| cutting length (A) | 300.0000 | 300.0000 | SAME |  |
| potential in B | SiC_1994.tersoff | SiC_1994.tersoff | SAME |  |
| potential in A | SiC_Erhart-Albe.tersoff | SiC_1994.tersoff | DIFFERENT | INTENDED: NanoCut uses one potential for A and B (reference equilibrates with Erhart-Albe, cuts with Tersoff-1994) |
| boundary in A | s s p | s s p | SAME |  |
| boundary in B | s p s | s s p | DIFFERENT | INTENDED: reference B says 's p s' but read_restart overrides it with A's 's s p' (warning in log) |
| dump every in B | 500 | 500 | SAME |  |
| restart every in B | 10000 | 10000 | SAME |  |
| minimize in B | True | True | SAME |  |
| B reads the restart written by A | cut_sic_eq.restart.10000 | cut_SiC_R5_d30_A.restart -> cut_SiC_R5_d30_A.restart | SAME |  |
| fix 13 property/atom mol re-declared in B | True | True | SAME |  |
| pair_coeff mapping | C Si C | C Si C | SAME |  |
| fix move on tool boundary (B) | fix 4 gpCTbd move linear -$v 0 0 units box | fix             cut gpCTbd move linear -2.000000 0.0 0.0 units box | SAME |  |

Atom counts (NanoCut enumeration = LAMMPS, verified by `run 0`): total 1987518, workpiece 1589769, tool 397749.

### Case 20-10 — PASS (35 parameters compared, 0 unintended differences)

| parameter | reference | NanoCut | status | note |
|---|---|---|---|---|
| workpiece x_end (A) | 960.6740 | 960.6740 | SAME |  |
| workpiece surface y (A) | 436.6700 | 436.6700 | SAME |  |
| workpiece width Lz (A) | 39.3003 | 39.3003 | SAME |  |
| depth of cut (A) | 13.1001 | 13.1001 | SAME |  |
| gap (A) | 8.7334 | 8.7334 | SAME |  |
| tool front x at t=0 (A) | 969.4074 | 969.4074 | SAME | reference: block x-lo = dx; generated: foremost point of the rounded edge |
| tool lowest point y (A) | 423.5699 | 423.5699 | SAME |  |
| edge radius (A) | 71.4200 | 71.4200 | SAME |  |
| tool block size (A) | 249.9700 | 249.9700 | SAME |  |
| edge centre x (A) | 1040.8274 | 1040.8274 | SAME |  |
| edge centre y (A) | 494.9899 | 494.9899 | SAME |  |
| wp fixed layer (A) | 21.8335 | 21.8335 | SAME |  |
| wp thermostat layer (A) | 21.8335 | 21.8335 | SAME |  |
| tool fixed layer (A) | 10.7130 | 10.7130 | SAME |  |
| tool thermostat layer (A) | 10.7130 | 10.7130 | SAME |  |
| clearance angle (deg) | 10.0000 | 10.0000 | SAME |  |
| equilibration steps | 10000 | 10000 | SAME |  |
| equilibration dt (ps) | 0.0005 | 0.0005 | SAME |  |
| temperature (K) | 300.0000 | 300.0000 | SAME |  |
| Tdamp (ps) | 0.0500 | 0.0500 | SAME |  |
| cutting speed (A/ps) | 2.0000 | 2.0000 | SAME |  |
| cutting steps | 200000 | 200000 | SAME |  |
| cutting dt (ps) | 0.0005 | 0.0005 | SAME |  |
| cutting length (A) | 200.0000 | 200.0000 | SAME |  |
| potential in B | SiC_1994.tersoff | SiC_1994.tersoff | SAME |  |
| potential in A | SiC_Erhart-Albe.tersoff | SiC_1994.tersoff | DIFFERENT | INTENDED: NanoCut uses one potential for A and B (reference equilibrates with Erhart-Albe, cuts with Tersoff-1994) |
| boundary in A | s s p | s s p | SAME |  |
| boundary in B | s p s | s s p | DIFFERENT | INTENDED: reference B says 's p s' but read_restart overrides it with A's 's s p' (warning in log) |
| dump every in B | 500 | 500 | SAME |  |
| restart every in B | 10000 | 10000 | SAME |  |
| minimize in B | True | True | SAME |  |
| B reads the restart written by A | cut_sic_eq.restart.10000 | cut_SiC_R20_d10_A.restart -> cut_SiC_R20_d10_A.restart | SAME |  |
| fix 13 property/atom mol re-declared in B | True | True | SAME |  |
| pair_coeff mapping | C Si C | C Si C | SAME |  |
| fix move on tool boundary (B) | fix 4 gpCTbd move linear -$v 0 0 units box | fix             cut gpCTbd move linear -2.000000 0.0 0.0 units box | SAME |  |

Atom counts (NanoCut enumeration = LAMMPS, verified by `run 0`): total 1995350, workpiece 1589769, tool 405581.

### Case 20-20 — PASS (35 parameters compared, 0 unintended differences)

| parameter | reference | NanoCut | status | note |
|---|---|---|---|---|
| workpiece x_end (A) | 960.6740 | 960.6740 | SAME |  |
| workpiece surface y (A) | 436.6700 | 436.6700 | SAME |  |
| workpiece width Lz (A) | 39.3003 | 39.3003 | SAME |  |
| depth of cut (A) | 21.8335 | 21.8335 | SAME |  |
| gap (A) | 0.0000 | 0.0000 | SAME |  |
| tool front x at t=0 (A) | 960.6740 | 960.6740 | SAME | reference: block x-lo = dx; generated: foremost point of the rounded edge |
| tool lowest point y (A) | 414.8365 | 414.8365 | SAME |  |
| edge radius (A) | 71.4200 | 71.4200 | SAME |  |
| tool block size (A) | 249.9700 | 249.9700 | SAME |  |
| edge centre x (A) | 1032.0940 | 1032.0940 | SAME |  |
| edge centre y (A) | 486.2565 | 486.2565 | SAME |  |
| wp fixed layer (A) | 21.8335 | 21.8335 | SAME |  |
| wp thermostat layer (A) | 21.8335 | 21.8335 | SAME |  |
| tool fixed layer (A) | 10.7130 | 10.7130 | SAME |  |
| tool thermostat layer (A) | 10.7130 | 10.7130 | SAME |  |
| clearance angle (deg) | 10.0000 | 10.0000 | SAME |  |
| equilibration steps | 10000 | 10000 | SAME |  |
| equilibration dt (ps) | 0.0005 | 0.0005 | SAME |  |
| temperature (K) | 300.0000 | 300.0000 | SAME |  |
| Tdamp (ps) | 0.0500 | 0.0500 | SAME |  |
| cutting speed (A/ps) | 2.0000 | 2.0000 | SAME |  |
| cutting steps | 300000 | 300000 | SAME |  |
| cutting dt (ps) | 0.0005 | 0.0005 | SAME |  |
| cutting length (A) | 300.0000 | 300.0000 | SAME |  |
| potential in B | SiC_1994.tersoff | SiC_1994.tersoff | SAME |  |
| potential in A | SiC_Erhart-Albe.tersoff | SiC_1994.tersoff | DIFFERENT | INTENDED: NanoCut uses one potential for A and B (reference equilibrates with Erhart-Albe, cuts with Tersoff-1994) |
| boundary in A | s s p | s s p | SAME |  |
| boundary in B | s p s | s s p | DIFFERENT | INTENDED: reference B says 's p s' but read_restart overrides it with A's 's s p' (warning in log) |
| dump every in B | 500 | 500 | SAME |  |
| restart every in B | 10000 | 10000 | SAME |  |
| minimize in B | True | True | SAME |  |
| B reads the restart written by A | cut_sic_eq.restart.10000 | cut_SiC_R20_d20_A.restart -> cut_SiC_R20_d20_A.restart | SAME |  |
| fix 13 property/atom mol re-declared in B | True | True | SAME |  |
| pair_coeff mapping | C Si C | C Si C | SAME |  |
| fix move on tool boundary (B) | fix 4 gpCTbd move linear -$v 0 0 units box | fix             cut gpCTbd move linear -2.000000 0.0 0.0 units box | SAME |  |

Atom counts (NanoCut enumeration = LAMMPS, verified by `run 0`): total 1995240, workpiece 1589769, tool 405471.

### Case 20-30 — PASS (35 parameters compared, 0 unintended differences)

| parameter | reference | NanoCut | status | note |
|---|---|---|---|---|
| workpiece x_end (A) | 960.6740 | 960.6740 | SAME |  |
| workpiece surface y (A) | 436.6700 | 436.6700 | SAME |  |
| workpiece width Lz (A) | 39.3003 | 39.3003 | SAME |  |
| depth of cut (A) | 30.5669 | 30.5669 | SAME |  |
| gap (A) | 8.7334 | 8.7334 | SAME |  |
| tool front x at t=0 (A) | 969.4074 | 969.4074 | SAME | reference: block x-lo = dx; generated: foremost point of the rounded edge |
| tool lowest point y (A) | 406.1031 | 406.1031 | SAME |  |
| edge radius (A) | 71.4200 | 71.4200 | SAME |  |
| tool block size (A) | 249.9700 | 249.9700 | SAME |  |
| edge centre x (A) | 1040.8274 | 1040.8274 | SAME |  |
| edge centre y (A) | 477.5231 | 477.5231 | SAME |  |
| wp fixed layer (A) | 21.8335 | 21.8335 | SAME |  |
| wp thermostat layer (A) | 21.8335 | 21.8335 | SAME |  |
| tool fixed layer (A) | 10.7130 | 10.7130 | SAME |  |
| tool thermostat layer (A) | 10.7130 | 10.7130 | SAME |  |
| clearance angle (deg) | 10.0000 | 10.0000 | SAME |  |
| equilibration steps | 10000 | 10000 | SAME |  |
| equilibration dt (ps) | 0.0005 | 0.0005 | SAME |  |
| temperature (K) | 300.0000 | 300.0000 | SAME |  |
| Tdamp (ps) | 0.0500 | 0.0500 | SAME |  |
| cutting speed (A/ps) | 2.0000 | 2.0000 | SAME |  |
| cutting steps | 300000 | 300000 | SAME |  |
| cutting dt (ps) | 0.0005 | 0.0005 | SAME |  |
| cutting length (A) | 300.0000 | 300.0000 | SAME |  |
| potential in B | SiC_1994.tersoff | SiC_1994.tersoff | SAME |  |
| potential in A | SiC_Erhart-Albe.tersoff | SiC_1994.tersoff | DIFFERENT | INTENDED: NanoCut uses one potential for A and B (reference equilibrates with Erhart-Albe, cuts with Tersoff-1994) |
| boundary in A | s s p | s s p | SAME |  |
| boundary in B | s p s | s s p | DIFFERENT | INTENDED: reference B says 's p s' but read_restart overrides it with A's 's s p' (warning in log) |
| dump every in B | 500 | 500 | SAME |  |
| restart every in B | 10000 | 10000 | SAME |  |
| minimize in B | True | True | SAME |  |
| B reads the restart written by A | cut_sic_eq.restart.10000 | cut_SiC_R20_d30_A.restart -> cut_SiC_R20_d30_A.restart | SAME |  |
| fix 13 property/atom mol re-declared in B | True | True | SAME |  |
| pair_coeff mapping | C Si C | C Si C | SAME |  |
| fix move on tool boundary (B) | fix 4 gpCTbd move linear -$v 0 0 units box | fix             cut gpCTbd move linear -2.000000 0.0 0.0 units box | SAME |  |

Atom counts (NanoCut enumeration = LAMMPS, verified by `run 0`): total 1994668, workpiece 1589769, tool 404899.

### Sensitivity (case 10-10): change one parameter, everything else constant

Lines of A/B that change when one parameter is varied (only the lines that physically must change should appear):

**process.depth_nm** — A: 13 lines, B: 3 lines

```
A #  tool       : Diamond (C), wedge, rake 0.0 deg, clearance 10.0 deg, edge radius 3.571 nm, 24.997 x 24.997 nm, deformable (401797 atoms)
A #  process    : depth 2.62002 nm, gap 0.0 nm, speed 200.0 m/s = 2.0000 A/ps, cut length 30.0 nm -> 300000 steps of 0.5 fs
A region          whole block -5.000000 1215.644000 -5.000000 665.439800 0.000000 39.300300 units box
A region tool_block block 960.674000 1210.644000 410.469800 660.439800 INF INF units box
A region tool_rake  plane 960.674000 446.179800 0.0 1.000000 -0.000000 0.0 units box
A region tool_flank plane 1002.584976 411.012315 0.0 -0.173648 0.984808 0.0 units box
A region tool_kA plane 996.384000 446.179800 0.0 -0.000000 -1.000000 0.0 units box
A region tool_kB plane 996.384000 446.179800 0.0 -0.984808 -0.173648 0.0 units box
A region tool_edge cylinder z 996.384000 446.179800 35.710000 INF INF units box
A region ctTop block 960.674000 1210.644000 649.726800 660.439800 INF INF units box
A region ctxEnd block 1199.931000 1210.644000 410.469800 660.439800 INF INF units box
A region ctTSbottom block 960.674000 1199.931000 639.013800 649.726800 INF INF units box
A region ctTSxEnd block 1189.218000 1199.931000 410.469800 649.726800 INF INF units box
B #  tool       : Diamond (C), wedge, rake 0.0 deg, clearance 10.0 deg, edge radius 3.571 nm, 24.997 x 24.997 nm, deformable (401797 atoms)
B #  process    : depth 2.62002 nm, gap 0.0 nm, speed 200.0 m/s = 2.0000 A/ps, cut length 30.0 nm -> 300000 steps of 0.5 fs
B region          czone cylinder z 968.344000 423.569900 20.000000 INF INF units box move v_xdisp NULL NULL
```

**process.speed_ms** — A: 1 lines, B: 4 lines

```
A #  process    : depth 1.31001 nm, gap 0.0 nm, speed 100.0 m/s = 1.0000 A/ps, cut length 30.0 nm -> 600000 steps of 0.5 fs
B #  process    : depth 1.31001 nm, gap 0.0 nm, speed 100.0 m/s = 1.0000 A/ps, cut length 30.0 nm -> 600000 steps of 0.5 fs
B fix             cut gpCTbd move linear -1.000000 0.0 0.0 units box    # cutting speed 100.0 m/s along -x
B variable        xdisp equal -1.000000*time    # tool displacement (A) since the start of this run
B run             600000    # 30.0 nm at 100.0 m/s
```

**tool.edge_radius_nm** — A: 6 lines, B: 2 lines

```
A #  tool       : Diamond (C), wedge, rake 0.0 deg, clearance 10.0 deg, edge radius 4.571 nm, 24.997 x 24.997 nm, deformable (403755 atoms)
A region tool_rake  plane 960.674000 469.279900 0.0 1.000000 -0.000000 0.0 units box
A region tool_flank plane 1014.321458 424.264338 0.0 -0.173648 0.984808 0.0 units box
A region tool_kA plane 1006.384000 469.279900 0.0 -0.000000 -1.000000 0.0 units box
A region tool_kB plane 1006.384000 469.279900 0.0 -0.984808 -0.173648 0.0 units box
A region tool_edge cylinder z 1006.384000 469.279900 45.710000 INF INF units box
B #  tool       : Diamond (C), wedge, rake 0.0 deg, clearance 10.0 deg, edge radius 4.571 nm, 24.997 x 24.997 nm, deformable (403755 atoms)
B region          czone cylinder z 982.004000 430.119950 20.000000 INF INF units box move v_xdisp NULL NULL
```

**process.cut_length_nm** — A: 1 lines, B: 2 lines

```
A #  process    : depth 1.31001 nm, gap 0.0 nm, speed 200.0 m/s = 2.0000 A/ps, cut length 20.0 nm -> 200000 steps of 0.5 fs
B #  process    : depth 1.31001 nm, gap 0.0 nm, speed 200.0 m/s = 2.0000 A/ps, cut length 20.0 nm -> 200000 steps of 0.5 fs
B run             200000    # 20.0 nm at 200.0 m/s
```

**thermo.temperature_K** — A: 3 lines, B: 2 lines

```
A velocity        mobile_eq create 500.0 102456 dist uniform mom yes rot yes
A fix             eqWP gpWPeq nvt temp 500.0 500.0 0.05
A fix             eqCT gpCTeq nvt temp 500.0 500.0 0.05
B fix             thWP gpWPtsbd nvt temp 500.0 500.0 0.05
B fix             thCT gpCTtsbd nvt temp 500.0 500.0 0.05
```

**workpiece.width_nm** — A: 3 lines, B: 2 lines

```
A #  workpiece  : 3C-SiC (cubic silicon carbide, zinc-blende), a0 = 4.3667 A, 220x100x18 cells = 96.07 x 43.67 x 7.860 nm (3179538 atoms)
A #  tool       : Diamond (C), wedge, rake 0.0 deg, clearance 10.0 deg, edge radius 3.571 nm, 24.997 x 24.997 nm, deformable (804408 atoms)
A region          whole block -5.000000 1215.644000 -5.000000 678.539900 0.000000 78.600600 units box
B #  workpiece  : 3C-SiC (cubic silicon carbide, zinc-blende), a0 = 4.3667 A, 220x100x18 cells = 96.07 x 43.67 x 7.860 nm (3179538 atoms)
B #  tool       : Diamond (C), wedge, rake 0.0 deg, clearance 10.0 deg, edge radius 3.571 nm, 24.997 x 24.997 nm, deformable (804408 atoms)
```

**tool.rake_deg** — A: 12 lines, B: 2 lines

```
A #  tool       : Diamond (C), wedge, rake -10.0 deg, clearance 10.0 deg, edge radius 3.571 nm, 24.997 x 24.997 nm, deformable (431640 atoms)
A region          whole block -5.000000 1253.970455 -5.000000 678.539900 0.000000 39.300300 units box
A region tool_block block 954.924000 1248.970455 423.569900 673.539900 INF INF units box
A region tool_rake  plane 999.542971 453.078924 0.0 0.984808 0.173648 0.0 units box
A region tool_flank plane 1040.911432 424.112415 0.0 -0.173648 0.984808 0.0 units box
A region tool_kA plane 1034.710455 459.279900 0.0 0.173648 -0.984808 0.0 units box
A region tool_kB plane 1034.710455 459.279900 0.0 -0.984808 -0.173648 0.0 units box
A region tool_edge cylinder z 1034.710455 459.279900 35.710000 INF INF units box
A region ctTop block 954.924000 1248.970455 662.826900 673.539900 INF INF units box
A region ctxEnd block 1238.257455 1248.970455 423.569900 673.539900 INF INF units box
A region ctTSbottom block 954.924000 1238.257455 652.113900 662.826900 INF INF units box
A region ctTSxEnd block 1227.544455 1238.257455 423.569900 662.826900 INF INF units box
B #  tool       : Diamond (C), wedge, rake -10.0 deg, clearance 10.0 deg, edge radius 3.571 nm, 24.997 x 24.997 nm, deformable (431640 atoms)
B region          czone cylinder z 1013.414000 430.119950 20.000000 INF INF units box move v_xdisp NULL NULL
```

## 4. Conclusion

- All shipped potential files reproduce their published lattice constants and cohesive energies in LAMMPS.
- For all nine reference cases every geometric, thermodynamic and numerical parameter of the generated decks equals the reference
  (differences are the documented, intended ones: single potential for A and B; disjoint fixed/thermostat groups; forces recorded).
- Varying one parameter changes only the lines that depend on it.
- Reference 10-20 has an empty A file; its parameters were inferred from the 5-20/20-20 pattern (dy = 95).
