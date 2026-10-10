# Nanometric cutting / nano-scratching MD (LAMMPS): literature survey for a deck-generator parameter schema

Compiled 2026-10-10. Scope: how published nano-cutting and nano-scratching MD models are built and analysed, with
numbers and citations, so that a LAMMPS deck generator exposes the right knobs with the right defaults and ranges.

Conventions used below:
- **[V]** = value read directly from the primary source (full text or publisher table) during this survey.
- **[A]** = value taken from an abstract, a citing paper, or a secondary summary; the primary text was not opened.
- **[U]** = unverified: commonly repeated in the field or recalled from memory, but not confirmed against a source here.
  Treat [U] numbers as "schema defaults to be confirmed", not facts.
- Axis convention used throughout: **x = cutting direction, y = width (periodic), z = depth / surface normal**
  (many papers swap y and z; the generator should name axes by role, not letter).

---

## 1. Model geometry conventions

### 1.1 Workpiece size (nm, atom counts)

| Study | Material / potential | Workpiece (L x H x W) | Atoms | Notes |
|---|---|---|---|---|
| Chavoshi & Luo 2016, RSC Adv. [V] | 3C-SiC, ABOP | 34.8 x 19.6 x 4.4 nm | not stated (deformable tool) | "plane-stress" quasi-2D slab, width 4.4 nm, 3 orientations |
| Ameli Kalkhoran, Vahdati & Yan 2019, JOM [V] | Si, Tersoff | 38.0 x 19.0 x 5.43 nm | 198,110 (26,590 fixed, 25,030 thermostat) + 27,839 tool | rigid tool, L/H = 2 |
| Liu, Xu, Hartmaier, Luo et al. 2019, Ind. Lubr. Tribol. [V] | 3C-SiC, ABOP | not tabulated | - | (001)[-100], periodic along width, DOC 5 and 10 nm |
| Tanaka & Shimada 2011 (euspen) [V] | SiC, Tersoff 1989 + Morse | 17.3 x 2.2 x 5.4 nm | - | "moving control volume" (see 1.5) |
| Lai, Zhang, Fang et al. 2013, Nanoscale Res. Lett. [A] | Ge, Tersoff + Morse Ge-C | 45 x 27 x 12 nm | - | full 3D, edge radius 10 nm |
| Pei, Lu, Lee & Zhang 2009, Nanoscale Res. Lett. [A] | Cu, EAM + Morse | models of ~2, ~4 and ~10 million atoms | up to 10 M | 4 M model "large enough to eliminate boundary effect"; size needed depends on speed and depth |
| Oluwajobi & Chen 2011/2014 [V] | Cu, EAM + Morse; deformable Tersoff diamond | small | 43,240 Cu + 10,992 C = 54,232 | multi-pass study |
| Gunkelmann, Alhafez, Urbassek et al. 2017 (arXiv 1702.00457, scratching) [V] | bcc Fe, Mendelev | 56.1 x 66.2 x 24.3 nm and 56.5 x 67.1 x 26.2 nm | 7.80 M and 8.60 M | spherical tip R = 10 nm, depth 4 nm |
| Goel, Stukowski, Luo et al. 2013, MSMSE [A] | 3C-SiC | not stated in abstract | - | 9 orientation/direction combinations |

Working ranges for the schema (from the table): **length 15-60 nm, height 10-30 nm, width 2-15 nm (quasi-2D) or
20-70 nm (full 3D scratching)**; atom counts **5 x 10^4 (teaching/quick) to 2 x 10^5 (typical 2D-like cutting) to
10^6-10^7 (3D scratching / convergence studies)**. Lattice units: Cu a = 3.615 Å, Al 4.05 Å, Fe 2.866 Å, Si 5.431 Å,
3C-SiC 4.36 Å (ABOP gives 4.3623 Å at 300 K vs 4.3581 Å experiment [V], Chavoshi & Luo 2016 Table 1), Ge 5.657 Å [A],
diamond 3.567 Å. So a 38 x 19 x 5.4 nm Si slab is 70 x 35 x 10 unit cells.

Rules of thumb stated in the literature:
- Workpiece height should be several times the DOC and the tool edge radius; length should allow a steady-state force
  plateau. Chavoshi & Luo report steady state only after 15-25 nm of travel for 3C-SiC [V]; Kalkhoran et al. use 20 nm
  cutting distance "so the process gets stable" [V]. The generator should default cutting distance >= 20 nm and
  length >= cutting distance + tool length + 2 x (tool-side margin ~5 nm).
- Pei et al. 2009 [A] is the only explicit size-convergence study found: forces from 2 M vs 4 M vs 10 M atom Cu models;
  4 M was sufficient at DOC 4 nm, v = 100 m/s.

### 1.2 Three-layer (boundary / thermostat / Newtonian) scheme

Universal since Komanduri & Raff (2001 review, Proc. IMechE B 215:1639) [A] and the Belak/Stowers Livermore models
cited therein. Specific thicknesses actually reported:

- Kalkhoran et al. 2019 (Si) [V]: **3 fixed atomic layers** at the bottom and at the left (tool-entry-side) face;
  **3 thermostat atomic layers** immediately inside them; remainder Newtonian. For Si(001), 3 atomic layers =
  3 x a/4 = ~4.1 Å; counts: 26,590 fixed, 25,030 thermostat of 198,110.
- Gunkelmann et al. 2017 (Fe scratching) [V]: bottom **2 atomic layers and the lateral sides fixed**; the **next 4
  layers** velocity-scaling thermostat (T < 1 K or 300 K).
- Chavoshi & Luo 2016 (SiC) [V]: three zones applied to **both workpiece and tool** (tool deformable); thicknesses not
  tabulated.
- Liu et al. 2019 (SiC) [V]: "boundary layer / thermostatic layer / Newton layer", thicknesses not given.
- Oluwajobi & Chen [V]: boundary atoms fixed "to reduce edge effects"; thermostat via velocity scaling of the
  thermostat group.

Typical schema defaults: **boundary = 2-3 atomic layers (~5-10 Å)**, **thermostat = 3-6 atomic layers (~10-20 Å)**;
some groups use thicker thermostat shells of 1-2 nm [U]. The thermostat shell must be far from the cutting zone
(see Section 7).

### 1.3 Boundary conditions

- **Width direction: periodic** in essentially all cutting studies (Kalkhoran [V], Liu [V], Tanaka & Shimada [V],
  Chavoshi [V] implied by "plane stress"), so the tool must span the full width (orthogonal cutting) and the width
  must exceed the potential cutoff twice (> 2 r_c, i.e. > ~1.3 nm for Tersoff/ABOP, > ~1.3 nm for EAM Cu) and be large
  enough that dislocations do not interact with their own images (Si/SiC: 4-5 nm used; Cu: 5-10 nm [U]).
- **Cutting direction and depth direction: non-periodic.** LAMMPS `boundary p p s`-style choices appear in forum
  scripts; the rigorous choice is **`f` (fixed) in x and z with explicit vacuum above the surface**, or `s`
  (shrink-wrap) only if the tool never approaches a box face (see pitfall 7.9).
- Fixed atoms on the entry-side face (Kalkhoran) or on both lateral faces (Urbassek scratching) replace periodicity
  along x.

### 1.4 2D-like vs full 3D

- "2D-like" / plane-stress: width 2-6 nm, periodic, tool spans width: Chavoshi & Luo 4.4 nm [V], Kalkhoran 5.4 nm [V],
  Tanaka & Shimada 2.2 nm [V]. Cheap; captures orthogonal cutting forces per unit width; cannot capture side flow,
  pile-up at groove edges, or 3D dislocation loops properly.
- Full 3D: tool narrower than workpiece (Pei 2009 tool thickness 3.2 nm in a wider workpiece [A]; Lai 2013 width 12 nm
  [A]); mandatory for scratching with spherical/conical tips (Urbassek group: 56-67 nm lateral extents [V]).

### 1.5 "Infinite length" tricks

- **Moving control volume** (Cheong, Zhang & Tanaka 2001, Key Eng. Mater. 196:31-42 [A]; used by Tanaka & Shimada
  2011 [V]): atoms are added ahead of the tool and removed behind it so steady-state chip formation is reached in a
  short box.
- **Workpiece moves, tool fixed**: equivalent to tool motion; sometimes used so that the thermostat frame is the tool
  frame. Either way the streaming velocity must be removed from any temperature (Section 5, 7.5).
- Multi-pass models re-use the machined surface with a lateral feed (Oluwajobi & Chen: feed 0.5-1.5 nm, DOC
  0.5-2.5 nm, 3 passes [V]).

---

## 2. Tool models

### 2.1 Rigid vs deformable diamond

- **Rigid** (most common): Kalkhoran 2019 [V] ("resistance of diamond is much higher than that of silicon"; C-C
  interactions ignored), Liu 2019 [V], Urbassek scratch tips [V], Lai 2013 [A]. Implementation: `fix move linear` on the
  tool group, or `velocity set` + `fix setforce 0 0 0` under `fix nve`, or `fix rigid` (slower, see Section 7.10).
  With a rigid tool, `neigh_modify exclude type <tool> <tool>` removes the useless intra-tool pair work.
- **Deformable**: needed for tool wear / graphitisation / chipping studies. Chavoshi & Luo 2016 [V] (ABOP, three-zone
  tool), Goel et al. 2012 Wear 284-285:65 [A] and Goel, Luo & Reuben 2013 Tribol. Int. 57:272 [A] (SiC formation at the
  Si/diamond interface, sp3->sp2 disorder), Oluwajobi & Chen (Tersoff diamond, needed 0.3 fs [V]), Tanaka & Shimada
  2011 [V] (rigid tool: chip removal; dynamic tool: severe wear, edge chipping, no chip on SiC).
- Repulsive-only idealised tips (no adhesion): Urbassek group uses a hollow rigid diamond-lattice sphere (R = 10 nm,
  125,082 C atoms, wall ~0.6 nm) with a purely repulsive LJ-derived C-Fe potential cut at 4.2 Å [V]; `fix indent`
  (sphere/cylinder/cone/plane with F = -K (r-R)^2) is the LAMMPS-native equivalent and reports the force on the
  indenter directly.

### 2.2 Shapes and angles (literature values)

| Study | Rake angle | Clearance | Edge radius r | DOC d | d/r |
|---|---|---|---|---|---|
| Chavoshi & Luo 2016 [V] | -25 deg | 10 deg | 3.5 nm | 3 nm | 0.86 |
| Kalkhoran et al. 2019 [V] | -10 deg | 15 deg | 1, 3, 5 nm | 0-5 nm | 0, 0.1, 0.25, 0.5, 0.75, 1 |
| Liu et al. 2019 [V] | 0 deg | 10 deg | 5 nm | 5, 10 nm | 1, 2 |
| Tanaka & Shimada 2011 [V] | -45 deg | - | 4 nm | 2.5 nm | 0.63 |
| Goel et al. 2013 MSMSE [A] | -25 deg / -30 deg | - | - | d/r = 0.57 / 1.0 | - |
| Pei et al. 2009 [A] | +12 deg | 12 deg | 6 nm | 0.8, 2, 4 nm | 0.13-0.67 |
| Lai et al. 2013 Ge [A] | - | 15 deg | 10 nm | 1-3 nm | 0.1-0.3 |
| Oluwajobi & Chen [V] | 0 deg | - | - | 0.5-2.5 nm | - |
| Olaniyan et al. 2025 (Si) [A] | 0 to -55 deg | - | - | - | -45 deg best surface, 0 deg least damage |
| Alhafez & Urbassek 2020 Crystals (Fe) [A] | range incl. strongly negative | - | - | - | shear angle fixed at 54.7 deg by edge dislocations |

Schema ranges: **rake -45 to +15 deg (allow down to -75 deg for "critical rake" studies)**, **clearance 5-15 deg**,
**edge radius 0.5-10 nm**, **spherical/hemispherical abrasive R = 2-20 nm** (Urbassek 10 nm [V]; RB-SiC grinding
study 5-10 nm [A]; Gao & Urbassek varied tip diameter [A]). Conical tips give depth-independent friction coefficient
(Alhafez, Kopnarski & Urbassek 2023, Tribol. Lett. [A]). Pyramidal (Berkovich/cube-corner) tips are AFM-scratch
models: rake is "always negative" for conical/pyramidal tips (Fang et al. 2022 review [V]).

Critical rake angle for chip formation: **-60 to -75 deg** regardless of sharp or round edge (Lai, Zhang & Fang 2012,
Appl. Phys. A 108, cited as ref. 29 in Fang et al. 2022 [V]); Xie & Fang 2020 J. Manuf. Process.: Cu(111) critical
rake -70 to -65 deg at the edge, -17 to -14 deg for the lowest tool atoms [A]. The effective rake angle of a round
edge is alpha_eff = -asin(1 - d/r) (Kalkhoran eq. 3 [V]; i.e. alpha_eff -> -90 deg as d -> 0).

### 2.3 Tool size, orientation, initial gap

- Tool height/length: a few nm larger than DOC + chip height; Chavoshi: "length and height ... selected adequately
  large" [V]. Pei 2009 tool thickness (width) 3.2 nm [A]. Kalkhoran tool 27,839 atoms [V].
- Diamond orientation: usually cube-oriented with rake face (100) or (110) and cutting edge along <110>; rarely stated
  explicitly. For rigid tools it only matters for surface atomic roughness; for deformable tools it controls
  graphitisation and wear anisotropy (Goel 2012 Wear [A]). Schema: expose `tool_orient` with default (100)/[010].
- **Initial gap**: Chavoshi & Luo place the tool **1 nm (10 Å)** above/ahead of the surface "to avoid interaction at
  the beginning" [V]; Gunkelmann et al. **4.6 Å** (beyond the 4.2 Å repulsive cutoff) [V]. Rule: gap > pair cutoff of
  the tool-work potential (Morse cutoffs 6.4-9 Å: see Section 4). Kalkhoran instead minimise, move the tool to depth,
  minimise again, then equilibrate [V] (tool starts engaged after minimisation; see pitfall 7.3).

---

## 3. Process parameters and literature ranges

### 3.1 Depth of cut / uncut chip thickness

0-5 nm (Kalkhoran [V]), 3 nm (Chavoshi [V]), 5-10 nm (Liu [V]), 0.8-4 nm (Pei [A]), 1-3 nm (Lai Ge [A]), 0.5-2.5 nm
(Oluwajobi [V]); Fang et al. 2022: Cu MD studies use UCT 0.1-14 nm with 3.6-5 nm edge radii [V]. Scratch depth 4 nm
(Gunkelmann [V]); 2 nm steps in multi-cycle scratching (Alhafez 2023 [A]). Schema range **0.5-10 nm**; also expose
d/r (relative tool sharpness) since the regime is set by it: RTS <= 0.25 rubbing/ploughing, RTS ~0.25 minimum DOC
for removal on Si (Kalkhoran [V]); experiments give 0.13-0.4 (cited in Kalkhoran [V]); theory 0.05-0.1 and "1-10 %
of r" (Fang et al. 2022 [V]); a/r = 0.5 critical for Cu (Sharma 2020 [A]).

### 3.2 Cutting speed

- Reported MD range: **1-10^2 m/s** typical (Fang et al. 2022 Table [V]); 4 and 10 m/s (Goel 2013 [A]); 20 m/s
  (Gunkelmann scratch [V]); 50 m/s (Chavoshi [V], Liu [V]); 100 m/s (Kalkhoran [V], Pei [A], Goel APL 2012 [A]);
  150 m/s (Oluwajobi [V]); 200 m/s and 10 m/s (Tanaka & Shimada [V]); 400 m/s (Lai Ge [A]); 500 m/s (early Komanduri-era
  work cited by Oluwajobi [V]).
- Why so high: Chavoshi & Luo state it plainly: "employed primarily due to limitation of computational power since
  ... realistic cutting speeds (~1-2 m/s) would require very long computation times" [V]. 20 nm of travel at 50 m/s is
  0.4 ns = 4 x 10^5 steps at 1 fs; at 1 m/s it would be 2 x 10^7 steps.
- Consequences documented: higher speed -> more lattice defects and higher forces in Cu (Pei, Lu, Lee 2006/2007 [A]);
  deformation mechanism changes when speed exceeds the plastic (shear) wave speed (Zhang, Zhao, Zhang & Shi 2013,
  J. Comput. Theor. Nanosci. 10:2462 [A]); for SiC higher speed raises removal rate but worsens surface and subsurface
  damage (2022 Materials study [A]); in 3C-SiC scratching the amorphous zone grows with speed while scratch hardness
  and friction coefficient fall (Noreyan & Amar 2008 Wear [A]); tool wear rate on SiC falls 20 % from 200 to 10 m/s
  (Tanaka & Shimada [V]). Kalkhoran chose 100 m/s "to avoid shock wave entrance" [V]: v must stay well below the
  material's longitudinal sound speed (Si ~8.4 km/s, Cu ~4.7 km/s, SiC ~12 km/s) and below the shear-wave speed if
  dislocation-mediated plasticity is to be realistic (Cu shear wave ~2.3 km/s [U]).
- Schema: **10-500 m/s, default 50-100 m/s**; warn above 200 m/s; derived quantity "steps required".

### 3.3 Cutting distance, feed, multi-pass

Cutting distance 15-25 nm for steady state (Chavoshi [V]), 20 nm (Kalkhoran [V], Tanaka & Shimada [V]), 10 nm for
tool-wear snapshots [V]. Schema **10-40 nm, default 20 nm**. Multi-pass: feed 0.5-1.5 nm, DOC 0.5-2.5 nm, up to 3
passes (Oluwajobi & Chen [V]); multi-cycle scratching with 2 nm depth increments (Alhafez 2023 [A]).

### 3.4 Crystal orientation / cutting direction

Literature notation "(hkl)[uvw]" = surface plane normal (hkl), cutting direction [uvw]. Examples:
Chavoshi: (010)<100>, (110)<001>, (111)<110> [V]; Liu: (001)[-100] [V]; Kalkhoran: (001)[010] [V]; Gunkelmann:
(100)[0-1-1], (110)[001] [V]; Gao 2015: (100), (110), (111) with two directions each [A]; Goel 2013: nine
combinations [A]; Lai Ge: (111) vs (010) [A]. Anisotropy magnitude: 3C-SiC thrust force varies up to 45 %, resultant
37 % across orientations (Goel 2013 [A]); specific cutting energy anisotropy ~30 % at 300 K for 3C-SiC (Chavoshi [V]).

LAMMPS `lattice ... orient x i j k orient y i j k orient z i j k` requires integer Miller indices that are mutually
orthogonal and right-handed (x cross y = z) [V, docs]. With x = cutting direction, z = surface normal, y = width:

| Case | orient x | orient y | orient z |
|---|---|---|---|
| (001)[100] (cut along +x; use negative tool velocity for [-100]) | 1 0 0 | 0 1 0 | 0 0 1 |
| (001)[-100] literally | -1 0 0 | 0 -1 0 | 0 0 1 |
| (001)[110] | 1 1 0 | -1 1 0 | 0 0 1 |
| (110)[001] | 0 0 1 | 1 -1 0 | 1 1 0 |
| (110)[-110] | -1 1 0 | 0 0 -1 | 1 1 0 |
| (111)[-110] | -1 1 0 | -1 -1 2 | 1 1 1 |
| (111)[11-2] | 1 1 -2 | -1 1 0 | 1 1 1 |

Checks: (0,0,1)x(1,-1,0) = (1,1,0); (-1,1,0)x(-1,-1,2) = (2,2,2) || [111]. For rotated lattices LAMMPS computes
lattice spacings as the extent of the rotated unit cell, so `units lattice` box lengths are no longer integer
multiples of the lattice period and periodic faces can end up with overlapping atoms [V, docs]: define the box in
`units box` using lengths that are integer multiples of the true repeat distance along each axis
(e.g. a*sqrt(2)/2 along [110], a*sqrt(3) along [111], a*sqrt(6)/2 along [112]) or use `delete_atoms overlap`.

### 3.5 Initial temperature

293 K (Liu [V], Tanaka & Shimada [V], Lai [A], Kalkhoran equilibration [V]), 298 K (Kalkhoran thermostat [V]),
300 K (Chavoshi [V], Gunkelmann [V]). Hot-cutting studies: 300-3000 K (Chavoshi & Luo 2016 [V]), 300-1500 K Si
(Chavoshi, Goel & Luo 2016 J. Manuf. Process. [A]). Schema default **300 K**, range 0.1-3000 K.

### 3.6 Timestep

1 fs: Chavoshi (ABOP SiC + deformable diamond, 300-3000 K) [V], Kalkhoran (Tersoff Si, rigid tool) [V], Gunkelmann
(Mendelev Fe) [V]. 0.5 fs: Liu et al. (ABOP 3C-SiC) [V]. 0.3 fs: Oluwajobi & Chen (EAM Cu + deformable Tersoff
diamond) [V]. Schema defaults: **EAM metals 1-2 fs (1 fs default); Tersoff/ABOP Si, SiC, Ge 0.5-1 fs (0.5 fs
default); deformable diamond (Tersoff C-C) 0.2-0.5 fs [U, 0.1 fs conservative]; hot cutting > 1500 K reduce by 2x**.
C-C stretching period in diamond (~25 fs, 1332 cm^-1 Raman) requires dt <= ~1 fs even in principle; 0.25-0.5 fs is
safe.

### 3.7 Equilibration

30 ps after tool placement at 1 nm gap (Chavoshi [V]); minimisation -> tool to depth -> minimisation -> 25 ps
(printed "25 ms", clearly a typo) at 293 K (Kalkhoran [V]); relaxation until all stress components < 1e-5 GPa
(Gunkelmann [V]). Schema **10-50 ps, default 20-30 ps**, preceded by `minimize`.

### 3.8 Thermostats and damping

Reported: **Berendsen** on the thermostat zone (Chavoshi & Luo [V]); **Nose-Hoover** at 293 K (Liu [V]);
**velocity rescaling every 10 steps** (Kalkhoran [V]; `fix temp/rescale`); **velocity scaling** (Oluwajobi [V],
Gunkelmann [V]); "equivalent average temperature" adjustment of thermostat atoms (Tanaka & Shimada [V], citing Tanaka,
Shimada & Anthony 2007 CIRP Ann.). Langevin is used by some groups for the thermostat shell [U]. Newtonian zone:
`fix nve` (Chavoshi: "LAMMPS NVE dynamics" [V]; Kalkhoran: NVE [V]).

Damping values (LAMMPS docs recommendations; not reported by the cutting papers): `fix nvt ... temp T T Tdamp` with
Tdamp ~ 100 timesteps = 0.1 ps; `fix temp/berendsen ... 0.1` ps; `fix langevin ... damp 0.1-1.0 ps`; `fix temp/rescale
N T T window fraction` with N = 10-100 and fraction 1.0 (Kalkhoran: every 10 steps [V]). From Howto_thermostat [V]:
Berendsen, csvr, temp/rescale and Langevin only modify velocities and must be paired with `fix nve`; `fix nvt`
integrates by itself; any thermostat can be given a bias-removing temperature compute via `fix_modify <id> temp
<compute>`.

---

## 4. Potentials by material (brief; a separate agent catalogs the files)

Workpiece potentials used in the cutting/scratching literature:

| Material | Potential (file) | Primary reference | Used by |
|---|---|---|---|
| Cu | EAM Mishin 2001 (`Cu_mishin1.eam.alloy`) | Mishin, Mehl, Papaconstantopoulos, Voter, Kress, PRB 63, 224106 (2001) | widely [U] |
| Cu | EAM Foiles-Baskes-Daw 1986 (`Cu_u3.eam`) | Foiles, Baskes, Daw, PRB 33, 7983 (1986), DOI 10.1103/PhysRevB.33.7983 | Pei 2006/2009 [A]; Oluwajobi [V] |
| Cu (comparison) | Morse Cu-Cu | Girifalco & Weizer 1959 (D 0.3429 eV, alpha 1.3588 1/Å, r0 2.866 Å [A]) | Pei 2006: Morse gives 5-70 % higher cutting force than EAM; EAM recommended [A] |
| Al | EAM Mendelev-Kramer-Becker-Asta 2008 (Phil. Mag. 88:1723) or Zope-Mishin 2003 (PRB 68, 024102) | - | Huang & Zong 2014 NRL 9:622 used "two sets of EAM" for Cu and Al [A] |
| Ni | EAM (Foiles 1986 family) | - | Ni nanocutting studies [A] |
| Fe | EAM Mendelev 2003 (Phil. Mag. 83:3977), cutoff 5.4 Å | - | Urbassek group scratching/cutting [V] |
| Si | Tersoff (1988/1989), SW (1985, PRB 31:5262), EDIP (Justo et al. PRB 58:2539, 1998; Bazant PRB 56:8542), ABOP Erhart-Albe 2005 | - | Tersoff: Kalkhoran [V], Cai-Li-Rahman [A], Cheong & Zhang 2000 [A]; ABOP: Goel 2012 Wear [A], Chavoshi 2016 [A]; SW promotes dislocations/stacking faults where Tersoff gives none (Li & Zhang 2025 [A]); EDIP not found in any cutting study |
| SiC | Tersoff 1989 (PRB 39:5566; erratum PRB 41:3248, 1990); Tersoff 1994 (PRB 49:16349, `SiC_1994.tersoff`: 1990 interactions + 1989 cutoff + heat-of-mixing correction) [A, NIST]; ABOP Erhart & Albe 2005 (PRB 71:035211) `SiC.tersoff`-format | - | Tersoff 1989: Tanaka & Shimada [V]; ABOP: Chavoshi [V], Liu [V], 2022 Materials study [A]; ABOP vs Tersoff compared in Chavoshi & Luo 2016 MSEA [A] |
| SiC | Vashishta 2007 (JAP 101:103515; `pair_style vashishta`) | - | 3C->rocksalt at ~90 GPa [A]; used in some indentation/scratch work [U] |
| Ge | Tersoff (1989 multicomponent set) | - | Lai 2013 [A] |
| GaAs | Albe et al. 2002 (PRB 66:035205) bond-order; Tersoff-Brenner + Born-Mayer tool repulsion in cutting work [A] | - | GaAs nano-cutting shows 5-coordinated intermediate phase [A] |
| Diamond tool (deformable) | Tersoff C (1989 set) or ABOP C-C | - | Chavoshi [V]; Oluwajobi [V] |

Tool-workpiece cross interactions (Morse unless noted; V(r) = D[exp(-2 alpha (r - r0)) - 2 exp(-alpha (r - r0))],
LAMMPS `pair_style morse` takes D0 alpha r0 in that order):

| Pair | D (eV) | alpha (1/Å) | r0 (Å) | cutoff | Source / status |
|---|---|---|---|---|---|
| Cu-C | 0.087 | 5.14 | 2.05 | - | Widely copied set, seen in a Cu-diamond cutting study [A]; original attribution unclear (Zhang & Tanaka / Hwang et al. are usually credited) **[U]**. alpha = 5.14 1/Å is unusually stiff; some re-prints give 5.14 1/nm. Verify before use. |
| Cu-C | 0.087 | "0.17 (nm)^-1" as printed (probably 1.7 1/Å) | 2.2 | 6.4 Å | Oluwajobi & Chen 2011/2014 [V]; unit typo in source |
| Cu-C | 0.1063 | 1.8071 | 2.3386 | 6.5 Å | Zhang et al. 2013 Nanoscale Res. Lett. 8:500 Table 2 (polycrystalline Cu) [A] |
| Si-C | 0.435 (as commonly cited) | 4.6487 (commonly cited) / 4.6417 (Mylvaganam & Zhang 2002 table) | 1.9475 | - | Developed by Zhang & Tanaka (JSME Int. J. A 42:546, 1999 [A]); Mylvaganam & Zhang 2002 Nanotechnology list D = 100.32 kcal/mol = 4.35 eV [A]. Factor-10 discrepancy in D between sources: **[U]**, resolve against the 1999 paper. |
| Ge-C | 0.125778 | 2.58219 | 2.2324 | - | Lai et al. 2013 NRL 8:13 Table 1, fitted by the authors (C cluster vs Ge layers) [A] |
| Ni-C | 0.1 | 2.2 | 2.4 | 9.025 Å | RSC Adv. 2017 citing Lin et al. (Ni nanocutting) [A] |
| Al-C | 0.28 | 2.78 | 2.2 | - | diamond-sphere-on-Al non-adhesive nanocontact study [A]; not a cutting paper **[U]** |
| Fe-C | - | - | - | - | No Morse set located. Urbassek group uses a purely repulsive LJ-derived C-Fe potential (Banerjee et al.), cut at 4.2 Å, shifted [V]. Fe-C MEAM/ML potentials exist for Fe-C alloys but not as tool-work pairs. **[U]** |

Practical notes: (i) `compute group/group` cannot be used with Tersoff/SW/ABOP and gives wrong EAM results [V, docs];
tool force is then obtained by summing per-atom forces on the tool (Section 5.1). (ii) Pei 2006 [A] and Oluwajobi &
Chen [V] both found that the choice of workpiece potential changes cutting forces by tens of percent; Morse for the
workpiece itself is deprecated. (iii) Tool-work Morse well depth sets adhesion: Chavoshi observe attractive (negative)
force at first contact followed by repulsion [V]; a "lubricated" contact was mimicked by increasing r0 by 1 Å (Tanaka
& Shimada [V]).

---

## 5. Output quantities and how they are computed

### 5.1 Cutting force Fc (tangential, along x) and thrust force Ft (normal, along z)

Definition used by all cutting papers: the resultant of forces exerted by workpiece atoms on tool atoms
(Chavoshi: "forces exerted by the carbon atoms of the cutting tool to the 3C-SiC workpiece" reported component-wise;
Oluwajobi: Fx tangential, Fy lateral, Fz normal in eV/Å [V]). Steady-state average after the transient (Chavoshi: after
15-25 nm travel [V]). 1 eV/Å = 1.602 nN.

LAMMPS routes:
- `compute group/group tool work` - pairwise potentials only (Morse/LJ tool-work with EAM workpiece is **not** valid
  because EAM embedding terms are reused; Tersoff/SW/ABOP are refused) [V, docs].
- General (any potential): `compute fx all property/atom fx` (or `c_f[1]`), then `compute Ftool tool reduce sum fx fy
  fz` on the tool group. Because the tool is rigid, the only forces on tool atoms come from the workpiece (if
  `neigh_modify exclude` removes intra-tool pairs; otherwise intra-tool forces sum to zero by Newton III anyway).
- `fix setforce 0 0 0` on the tool group stores the total force on the group **before** zeroing (global 3-vector) and
  doubles as the rigid constraint when combined with `velocity set` + `fix nve`.
- `fix indent` reports the force on the indenter directly (global 3-vector) [V, docs].
- Time-average with `fix ave/time N_every N_repeat N_freq` (e.g. every 10 steps averaged over 100 outputs = 1 ps
  blocks); write with `fix print` or thermo.

### 5.2 Friction coefficient and friction angle

mu = Fc/Ft (cutting) or F_transverse/F_normal (scratching). Chavoshi report mu at the rake face/chip interface
0.42-0.9 for 3C-SiC, minimum on (111) [V]; friction angle for a rounded edge beta = alpha_eff + atan(Ft/Fc)
(Chavoshi eq. 4 [V]). Scratch mu rises with depth for (100)<011> Fe (Gao 2015 [A]); conical tips make mu depth-
independent (Alhafez 2023 [A]); Noreyan & Amar: mu and scratch hardness increase with depth, decrease with speed [A].

### 5.3 Specific cutting energy

"Energy required to remove a unit amount of material", N/m^2 or J/m^3 (Chavoshi, citing Komanduri [V]). Two
equivalent forms: Kc = Fc * L / V_removed (needs removed-volume count) or Kc = Fc/(d * w) (nominal). In nN and nm,
nN/nm^2 = GPa directly. Chavoshi report 33-43 % reduction at 2000 K vs 300 K for 3C-SiC [V]. Size effect: Kc rises as
UCT falls (Pei 2009 [A]; Sharma 2018 [A]).

### 5.4 Temperature (COM / streaming velocity removed)

Chavoshi eq. (1)-(2) [V]: (1/2) sum m_i v_i^2 = (3/2) N k_B T, averaged in time and space ("over few timesteps",
elemental volume 1 x 1.5 x 3 nm^3 containing 442 atoms [V]); for the tool subtract v_tool: (1/2) sum m_i (v_i -
v_tool)^2, "possible to use temp/com command" [V]. LAMMPS: `compute temp/com`, `temp/partial`, `temp/profile`,
`temp/region`, `temp/chunk` remove a velocity bias before computing T (Howto_temperature [V]); `compute chunk/atom
bin/3d` + `fix ave/chunk ... temp` (with `com yes` bias handled via `fix_modify`) gives spatial temperature maps. Only
one bias compute can be attached to a thermostat, so a moving region with COM removal needs post-processing [A,
forum]. Chip and tool atoms carry the streaming velocity (50-200 m/s = 0.5-2 Å/ps); for Si this is an apparent
temperature error of order (1/2) m v^2 / (3/2 k_B) = 0.5 x 28 amu x (100 m/s)^2 / (1.5 k_B) ~ 11 K per atom, larger for
Cu (25 K); for chip atoms with partially converted KE this is not negligible.

### 5.5 Stresses (von Mises, hydrostatic) from per-atom virial

`compute stress/atom` returns -(m v v + W) in pressure x volume units (bar Å^3 in `units metal`), sign opposite to
pressure, virial split equally among atoms of each many-body interaction [V, docs]. Convert: sigma_ij = S_ij / Omega_i
with Omega_i from `compute voronoi/atom` (unreliable at free surfaces/chip) or the nominal atomic volume (Si 20.0 Å^3,
Cu 11.8 Å^3, 3C-SiC 10.4 Å^3 per atom); 1 bar = 1e-4 GPa, so GPa = S / (Omega * 1e4). Then
sigma_h = (s_xx + s_yy + s_zz)/3 (negative = compression in this sign convention) and
sigma_vM = sqrt( 1/2 [ (s_xx - s_yy)^2 + (s_yy - s_zz)^2 + (s_zz - s_xx)^2 ] + 3 (s_xy^2 + s_yz^2 + s_xz^2) )
(same form used by Gunkelmann et al. [V] and Chavoshi [V]). Average over a few hundred atoms or over time; Gunkelmann
average over disordered atoms in an 8 nm cylinder [V]. Reference values: von Mises on the diamond cutting edge
18-26 GPa while cutting Si (Chavoshi, Goel & Luo [A]); critical von Mises for 3C-SiC yielding falls 49 % from 300 K to
3000 K (Chavoshi & Luo 2016 MSEA [A]); Si-I -> Si-II at 11-12 GPa hydrostatic (Hu et al. 1986 range 11.3-12.5 GPa [A];
Fang review: 10-13 GPa [V]), lower under shear (~8.5 GPa along [111] [A]).

### 5.6 Chip, pile-up, removed volume, roughness

- Chip atoms: atoms displaced above the original surface plane ahead of the rake face; Chavoshi count "number of
  atoms in the chip" vs temperature [V]; chip ratio and shear-plane angle also reported [A].
- Pile-up: no standard metric found. Urbassek group quantify pile-up indirectly via projected normal and transverse
  contact areas (tip contact with pile-up included) [A, Gao 2015]; practical recipe: height map of atoms above the
  reference surface (2D binning, `compute chunk/atom bin/2d` + max z, or OVITO Construct Surface Mesh), pile-up
  volume = integral of height above reference, groove volume = integral below, ratio reported as "pile-up ratio".
  Scratch work ~ proportional to scratch volume (Alhafez 2023 [A]).
- Surface roughness after cut: Sa/Sq of the surface-atom height map behind the tool (Kalkhoran: measured in OVITO
  [V]).
- Chip morphology: continuous ribbon vs segmented vs no chip; extrusion vs shear dominated (Fang et al. 2022: extrusion
  dominates at small UCT/r; "minimum UCT for stable removal ~1-10 % of edge radius" [V]).

### 5.7 Subsurface damage, dislocations, phases

- Subsurface damage depth: deepest non-crystalline / defect atom below the machined surface, identified by CNA
  (`compute cna/atom`, OVITO adaptive CNA, Stukowski MSMSE 20:045021, 2012), centro-symmetry (`compute
  centro/atom`, Zhang-Zhao-Shi 2013 for Cu [A]), coordination number (`compute coord/atom`), or Identify Diamond
  Structure (Maras et al. 2016 CPC 205:13) for Si/Ge/SiC. Liu et al. 2019 compare "subsurface deformation depth" at
  1/5/10 GPa pre-stress [V].
- Dislocations: OVITO DXA (Stukowski & Albe MSMSE 18:025016, 2010; Stukowski, Bulatov & Arsenlis MSMSE 20:085007,
  2012); Gunkelmann settings: smoothing level 1, point separation 2.5 [V]; dislocation density = total line length /
  analysed volume (m^-2). D2C continuum fields (total density, GND density, curvature) in Gunkelmann et al. [V].
- Stacking faults: CNA "hcp" atoms in fcc metals (two adjacent hcp planes = intrinsic SF; one = twin boundary).
- Si phases by coordination with cutoff ~2.6 Å (Si-II has 4 neighbours at 2.42 Å + 2 at 2.585 Å; bct5 has 1 at
  2.31 Å + 4 at 2.44 Å [A]): CN 4 = Si-I (also Si-III/XII and amorphous; need second-shell/angle fingerprint),
  CN 5 = bct5, CN 6 = Si-II (beta-tin). Cheong & Zhang 2000 Nanotechnology 11:173 first showed Si-I -> bct (beta-Si)
  under indentation with Tersoff [A]; Mylvaganam & Zhang 2011 Scripta: nanotwinning tied to bct5 [A]. Test cutoff
  sensitivity 2.5-2.7 Å.
- SiC amorphisation: Tanaka & Shimada use nearest-neighbour count N_n as crystallinity index [V]; Noreyan & Amar
  partial amorphisation along the scratch [A]; Goel APL 2012: sp3->sp2 disorder, local SiC-graphene [A];
  Chavoshi & Luo MSEA 2016: initial response is solid-state amorphisation for all cases [A].

### 5.8 Derived continuum numbers

- Strain rate: eps_dot ~ v / d (speed over shear-zone thickness ~ DOC): 100 m/s / 5 nm = 2 x 10^10 s^-1;
  10-500 m/s with 1-10 nm gives 10^9-5 x 10^11 s^-1 [U, standard estimate]. Experiments are orders of magnitude lower
  (Fang et al. 2022 [V]).
- Péclet number Pe = v L / kappa (kappa = thermal diffusivity: Cu 1.1e-4 m^2/s, Si 8.8e-5, SiC ~1.6e-4 [U]): at
  v = 100 m/s, L = 10 nm, Pe ~ 0.01 - conduction dominates over advection at MD scales, i.e. MD cutting is **not**
  adiabatic and the high speed cannot be justified by Pe; it is a cost choice (Chavoshi [V]). Expose Pe as a derived
  diagnostic only.
- Bifano critical depth: d_c = lambda (E/H)(K_c/H)^2 with lambda = 0.15 (Bifano, Dow & Scattergood, J. Eng. Ind.
  113:184, 1991, DOI 10.1115/1.2899676; formula as reproduced in Fang et al. 2022 eq. 1 [V]); discrepancies vs
  experiment up to 200 % [A]. Example (Si, E 130-170 GPa, H ~12 GPa, Kc ~0.9 MPa m^0.5): d_c ~ 0.15 x 12 x (75 nm)
  ~ 100-150 nm, i.e. all MD depths are deep inside the ductile regime by this criterion.
- Hertz sphere contact: a = (3 F R / 4 E*)^(1/3); p_0 = (6 F E*^2 / (pi^3 R^2))^(1/3) (peak); p_mean = F/(pi a^2) =
  (2/3) p_0; 1/E* = (1 - nu_s^2)/E_s + (1 - nu_i^2)/E_i; valid before pop-in and for delta/R < 0.1 [A]. SiC yields at
  mean contact stress 12-13 GPa (spherical indentation expt. [A]).
- Minimum chip thickness: t_min / r ~ 0.1-0.4 (expt. 0.13-0.4 cited by Kalkhoran [V]; MD rubbing/ploughing for RTS
  <= 0.25 [V]; theory 0.05-0.1 and 1-10 % [V, Fang]; micromilling 0.293 [A]); Cu(111) needs d > ~1.1 Å for any
  removal (Xie & Fang 2019 [A]).

---

## 6. Design-of-experiments practice

- **One-factor-at-a-time dominates**: speed series (Pei 2006 [A]; Zhang-Zhao-Shi 2013 [A]), depth series (Pei 2009:
  0.8/2/4 nm [A]; Oluwajobi 0.5-2.5 nm [V]), rake-angle series (Olaniyan 0 to -55 deg [A]; Alhafez & Urbassek 2020
  [A]), temperature series (Chavoshi 7 temperatures x 3 orientations = 21 runs [V]), orientation series (Goel 2013:
  9 combinations [A]; Gao 2015: 3 planes x 2 directions [A]). Kalkhoran use a **two-factor grid**: 3 edge radii x 6
  RTS values (18 runs) [V]. No full factorial / response-surface DOE located in the MD cutting literature; the deck
  generator should support both OFAT sweeps and crossed grids, with a run-count estimator.
- **Repeat seeds**: Gunkelmann et al. average **four runs** at 300 K [V]; Papanikolaou & Salonitis 2020 "repeated in
  order to eliminate statistical errors" (count not given) [A]; Junge & Molinari 2014 Int. J. Plasticity 53:90 apply a
  statistical criterion to decide whether box size, microstructure and sliding rate significantly change the friction
  coefficient, and find mu can be size-independent while plastic activity is not [A]. Schema: `n_seeds` (default 1,
  recommend 3-4 for force statistics), using `velocity ... create T seed`.
- **Box-size convergence**: Pei 2009 (2/4/10 M atoms) [A]; Junge & Molinari (box size) [A]; Kalkhoran fix L/H = 2 [V].
  Recommend a width sweep (periodic direction) and a height sweep at the largest DOC.
- **Thermostat-layer sensitivity**: Huang & Zong 2014 (NRL 9:622) show forces and defect structures for Cu and Al with
  and without a thermostat layer at 300 K [A, figure titles]; Eder et al. 2017 (arXiv 1704.04384, nanocrystalline
  ferrite abrasion) find the thermostatting mode (phonon conduction only vs instantaneous heat removal at the
  interface) has "crucial impact" on tribological and microstructural results [A]. Recommend a sensitivity run:
  thermostat-shell thickness x2 and damping x10.
- **Steady-state window**: report mean +/- s.d. of forces over the last 50-70 % of travel (Chavoshi: after 15-25 nm
  [V]); exclude the engagement transient.

---

## 7. Known pitfalls

1. **Thermostatting the cutting zone.** Applying `fix nvt`/`temp/rescale` to the whole workpiece (or to the chip)
   erases the frictional/plastic heating that drives phase transformation, amorphisation and tool wear. All cited
   models confine thermostats to a shell 2-6 layers thick next to the fixed boundary and run the cutting zone with
   `fix nve` (Chavoshi [V], Kalkhoran [V], Gunkelmann [V]). Never include tool atoms or fixed atoms in a thermostatted
   group (forum guidance; `fix nvt` would alter prescribed velocities) [A].
2. **Too-small box / wall reflections.** Stress and phonon pulses reflect from fixed layers and periodic images; Pei
   2009 needed ~4 M atoms at DOC 4 nm, 100 m/s [A]; Kalkhoran cite 100 m/s as a limit "to avoid shock wave entrance"
   [V]. Keep the plastic zone (several x DOC, ~10 x r for scratching) away from fixed faces; check that forces do not
   drift with width/height.
3. **Tool starting inside the workpiece.** Place the tool with a gap larger than the tool-work cutoff (1 nm Chavoshi
   [V]; 4.6 Å > 4.2 Å cutoff Gunkelmann [V]) or minimise after placing it at depth (Kalkhoran [V]); otherwise the first
   step produces unphysical forces/energies ("indentation force starts high from first step" is a recurring LAMMPS
   forum report [A]).
4. **Rake-angle sign.** Positive rake = rake face leaning away from the uncut material (cutting-tool convention);
   negative = leaning into it. Most nano-cutting tools are negative (-10 to -45 deg) and the effective rake of a round
   edge is more negative still (alpha_eff = -asin(1 - d/r)). Generators that build the wedge from "angle from the
   vertical" must convert explicitly and state the convention in the deck header.
5. **`units box` vs `units lattice`.** `region`, `create_box`, `fix indent` and `fix move` default to `units lattice`;
   with rotated lattices LAMMPS's "lattice spacing" is the bounding extent of the rotated cell, not the periodic repeat
   [V, docs]. Emit all geometry in `units box` Å and compute periodic lengths from Miller indices (Section 3.4);
   `fix indent` K is in force/distance^2 and is never scaled by `units`.
6. **Temperature with streaming velocity.** Tool-frame or workpiece-frame motion adds (1/2) m v^2 per atom; use
   `compute temp/com` / `temp/partial` / `temp/profile` for any group that translates (Chavoshi eq. 2 [V]; LAMMPS
   Howto_thermostat [V]), and never thermostat a moving group with a plain `compute temp`.
7. **Timestep too large for C-C.** Deformable Tersoff diamond forced Oluwajobi & Chen to 0.3 fs [V]; 1 fs is only
   safe with rigid tools or at 300 K with ABOP SiC/diamond (Chavoshi [V]); hot cutting (> 1500 K) and tool-wear studies
   need 0.25-0.5 fs. Watch for energy drift in an NVE test run.
8. **`fix move` + double integration.** Atoms in the tool group must not also be in an `nve`/`nvt` group ("time
   integrating ... twice ... bogus dynamics" [A, forum]); build the Newtonian group with `group mobile subtract all
   tool boundary thermo`. A boundary group with `fix setforce 0 0 0` and no integrator simply never moves (which is
   intended for fixed layers but surprises users who expected the tool to move that way) [A].
9. **Shrink-wrapped boundary with a moving tool.** `boundary s` re-fits the box to the atoms each reneighbour; a tool
   leaving or entering the box changes the box and can lose atoms or trigger "atoms lost"; use `f` with enough vacuum
   (>= tool travel + cutoff) or `m` (shrink with minimum).
10. **Rigid-body choice.** `fix rigid` on the tool works but is slower and can show spurious distortion if combined
    with the wrong integrator [A, forum]; `fix move linear` (constant velocity, ignores forces) or `velocity set` +
    `fix setforce 0 0 0` + `fix nve` are simpler and give the reaction force for free.
11. **Load balance.** The vacuum above the workpiece and the chip leave most processors idle with the default brick
    decomposition; use `fix balance 1000 1.05 shift z 10 1.05` (or `rcb` with `comm_style tiled`) and/or
    `processors * * 1`-style grids with the thin direction unsplit [V, docs].
12. **Neighbour settings for many-body potentials.** Keep `neigh_modify delay 0 every 1 check yes` (defaults) for
    hot/fast runs; `neighbor 2.0 bin` for metals, `neighbor 1.0 bin` acceptable for short-cutoff Tersoff/ABOP; raise
    `neigh_modify one/page` only for genuinely dense neighbour counts ("LAMMPS can crash without an error message" if
    `page` is exceeded [V, docs]); `neigh_modify exclude type` for rigid tool-tool pairs (not allowed with dynamic
    groups).
13. **Force on tool with many-body potentials.** `compute group/group` silently invalid for EAM and refused for
    Tersoff/SW [V, docs]; sum per-atom forces on the tool group instead (Section 5.1).
14. **Speed above wave speeds.** 500 m/s-class runs change the deformation mechanism once v exceeds the plastic wave
    speed (Zhang-Zhao-Shi 2013 [A]); keep v <= 100-200 m/s for metals if dislocation plasticity is the object of
    study.
15. **Potential/temperature-dependent lattice constant.** Build the lattice at the potential's own equilibrium
    constant for the run temperature (Chavoshi: 4.3623 Å at 300 K to 4.4838 Å at 3000 K for ABOP 3C-SiC [V]);
    otherwise the equilibration carries a spurious hydrostatic stress that biases phase-transformation thresholds.

---

## 8. Schema implications (one-line summary per knob)

- geometry: `L, H, W` (nm, or cells), `boundary_layers` (default 3), `thermostat_layers` (default 3-4),
  `periodic_width` (true), `vacuum_above` (>= 3 nm + chip), `mode` = {2D-like, 3D-scratch}.
- tool: `type` = {wedge, sphere, cone, pyramid}, `rigid` (true), `rake` (-25), `clearance` (10), `edge_radius` (3 nm),
  `R_sphere` (10 nm), `tool_orient`, `gap` (>= cutoff, default 1 nm).
- process: `doc` (3 nm), `speed` (50 m/s), `distance` (20 nm), `orientation` (hkl)[uvw] -> `lattice orient`, `T0`
  (300 K), `dt` (per potential), `equil_ps` (20-30), `thermostat` = {berendsen, nvt, langevin, rescale}, `damp`.
- potentials: workpiece file, tool file (if deformable), cross-term Morse (D, alpha, r0, cutoff) with provenance
  flag.
- outputs: Fc, Ft, mu, Kc, T maps (bias-removed), sigma_vM/sigma_h (with Omega and unit conversion), CNA/coord/
  diamond-structure dumps, DXA post-processing, chip/pile-up height maps, roughness; derived eps_dot, Pe, d_c, Hertz.
- DOE: `sweep` (OFAT or grid), `n_seeds`, `size_check` flag.

---

## References (as resolved in this survey)

- Komanduri R., Raff L.M. (2001) "A review on the molecular dynamics simulation of machining at the atomic scale",
  Proc. IMechE B 215(12):1639-1672, DOI 10.1243/0954405011519484. [A]
- Komanduri R., Chandrasekaran N., Raff L.M. (1998) "Effect of tool geometry in nanometric cutting: a molecular
  dynamics simulation approach", Wear 219:84-97. [A]
- Komanduri R., Chandrasekaran N., Raff L.M. (1999) "Some aspects of machining with negative rake tools simulating
  grinding", Phil. Mag. B 79(7):955-968. [A]
- Komanduri R., Chandrasekaran N., Raff L.M. (2000) "MD simulation of indentation and scratching of single crystal
  aluminum", Wear 240:113-143; and "MD simulation of nanometric cutting of single crystal aluminum - effect of crystal
  orientation and direction of cutting", Wear 242:60-88. [A]
- Komanduri R., Chandrasekaran N., Raff L.M. (2001) "Molecular dynamics simulation of the nanometric cutting of
  silicon", Phil. Mag. B 81(12):1989-2019, DOI 10.1080/13642810108208555. [A]
- Goel S., Luo X., Agrawal A., Reuben R.L. (2015) "Diamond machining of silicon: A review of advances in molecular
  dynamics simulation", Int. J. Mach. Tools Manuf. 88:131-164, DOI 10.1016/j.ijmachtools.2014.09.013. [A]
- Goel S., Luo X., Reuben R.L. (2012) "Shear instability of nanocrystalline silicon carbide during nanometric
  cutting", Appl. Phys. Lett. 100:231902. [A]
- Goel S., Luo X., Reuben R.L. (2013) "Wear mechanism of diamond tools against single crystal silicon in single point
  diamond turning process", Tribol. Int. 57:272-281. [A]
- Goel S., Luo X., Reuben R.L., Pen H. (2012) "Influence of temperature and crystal orientation on tool wear during
  single point diamond turning of silicon", Wear 284-285:65-72. [A]
- Goel S., Stukowski A., Luo X., Agrawal A., Reuben R.L. (2013) "Anisotropy of single-crystal 3C-SiC during
  nanometric cutting", Modelling Simul. Mater. Sci. Eng. 21:065004. [A]
- Luo X., Goel S., Reuben R.L. (2012) "A quantitative assessment of nanometric machinability of major polytypes of
  single crystal silicon carbide", J. Eur. Ceram. Soc. 32:3423-3434. [A]
- Chavoshi S.Z., Luo X. (2016) "Atomic-scale characterization of occurring phenomena during hot nanometric cutting of
  single crystal 3C-SiC", RSC Adv. 6:71409, DOI 10.1039/C6RA05830B. [V, full text]
- Chavoshi S.Z., Luo X. (2016) "Molecular dynamics simulation study of deformation mechanisms in 3C-SiC during
  nanometric cutting at elevated temperatures", Mater. Sci. Eng. A 654:400-417. [A]
- Chavoshi S.Z., Goel S., Luo X. (2016) "Influence of temperature on the anisotropic cutting behaviour of single
  crystal silicon: a molecular dynamics simulation investigation", J. Manuf. Process. 23:201-210. [A]
- Liu L., Xu Z., Hartmaier A., Luo X., Zhang J., Nordlund K., Rommel M. (2019) "MD simulation of stress-assisted
  nanometric cutting mechanism of 3C silicon carbide", Ind. Lubr. Tribol. 71(5):686-691. [V, full text]
- Ameli Kalkhoran S.N., Vahdati M., Yan J. (2019) "Molecular dynamics investigation of nanometric cutting of
  single-crystal silicon using a blunt tool", JOM 71:4296, DOI 10.1007/s11837-019-03671-w. [V, full text]
- Tanaka H., Shimada S. (2011) "Guideline for ultra-precision machining of silicon carbide based on molecular dynamics
  analysis", Proc. 11th euspen Int. Conf., Como. [V, full text]
- Cheong W.C.D., Zhang L.C. (2000) "Molecular dynamics simulation of phase transformations in silicon monocrystals
  due to nano-indentation", Nanotechnology 11:173-180. [A]
- Cheong W.-D., Zhang L.C., Tanaka H. (2001) Key Eng. Mater. 196:31-42 (moving control volume). [A]
- Zhang L.C., Tanaka H. (1997) "Towards a deeper understanding of wear and friction on the atomic scale - a molecular
  dynamics analysis", Wear 211:44-53. [A]
- Zhang L.C., Tanaka H. (1998) "Atomic scale deformation in silicon monocrystals induced by two-body and three-body
  contact sliding", Tribol. Int. 31(8):425-433. [A]
- Mylvaganam K., Zhang L.C. (2002) Nanotechnology (Si-C Morse table); (2011) "Nanotwinning in monocrystalline silicon
  upon nanoscratching", Scripta Mater. [A]
- Pei Q.X., Lu C., Fang F.Z., Wu H. (2006) "Nanometric cutting of copper: A molecular dynamics study", Comput. Mater.
  Sci. 37(4):434-441. [A]
- Pei Q.X., Lu C., Lee H.P., Zhang Y.W. (2009) "Study of materials deformation in nanometric cutting by large-scale
  molecular dynamics simulations", Nanoscale Res. Lett. 4:444-451, DOI 10.1007/s11671-009-9268-z. [A]
- Lai M., Zhang X., Fang F.Z. (2012) "Study on critical rake angle in nanometric cutting", Appl. Phys. A 108. [A]
- Lai M., Zhang X., Fang F.Z. et al. (2013) "Study on nanometric cutting of germanium by molecular dynamics
  simulation", Nanoscale Res. Lett. 8:13, DOI 10.1186/1556-276X-8-13. [A]
- Xie W., Fang F.Z. (2019/2020) single-atomic-layer removal of Cu: edge-radius effect (Nanoscale Res. Lett. 2019) and
  rake-angle effect (J. Manuf. Process. 2020). [A]
- Fang F.Z., Lai M., Wang J., Luo X., Yan J., Yan Y. (2022) "Nanometric cutting: mechanisms, practices and future
  perspectives", Int. J. Mach. Tools Manuf. 178:103905, DOI 10.1016/j.ijmachtools.2022.103905. [V, full text]
- Wang J.S., Zhang X.D., Fang F.Z. et al. (2018) material removal and phase transformation in nanometric cutting of
  silicon, Appl. Surf. Sci. [A]
- Xiao G., To S., Zhang G. (2015) "Molecular dynamics modelling of brittle-ductile cutting mode transition: Case
  study on silicon carbide", Int. J. Mach. Tools Manuf. 88:214-222. [A]
- Cai M.B., Li X.P., Rahman M. (2005) Int. J. Manuf. Technol. Manage. 7(5/6):455-466 (thrust >> cutting force);
  (2007) Int. J. Comput. Appl. Technol. 28(1) (MD ductile cutting of Si, Tersoff, finite edge radius); Liu K., Li X.P.
  et al. (2007) Int. J. Adv. Manuf. Technol. 32:631-637 (critical UCT grows with edge radius). [A]
- Zhang L., Zhao H.W., Zhang P., Shi C.L. (2013) "Influences analysis of nanometric cutting single-crystal copper via
  molecular dynamics simulation", J. Comput. Theor. Nanosci. 10:2462-2472, DOI 10.1166/jctn.2013.3232. [A]
- Zhang J.J. et al. (2013) Nanoscale Res. Lett. 8:500 (polycrystalline Cu; Cu-C Morse Table 2). [A]
- Huang Y., Zong W. (2014) "Molecular dynamic simulation for nanometric cutting of single-crystal face-centered cubic
  metals", Nanoscale Res. Lett. 9:622. [A]
- Oluwajobi A.O., Chen X. (2011) ICAC 2011 "The effect of interatomic potentials on nanometric machining" and (2014)
  "Multi-pass nanometric machining simulation using MD", Current Nanoscience. [V, full text]
- Gao Y., Ruestes C.J., Urbassek H.M. (2014) "Nanoindentation and nanoscratching of iron: Atomistic simulation of
  dislocation generation and reactions", Comput. Mater. Sci. 90:232-240. [A]
- Gao Y., Brodyanski A., Kopnarski M., Urbassek H.M. (2015) "Nanoscratching of iron: A molecular dynamics study of
  the influence of surface orientation and scratching direction", Comput. Mater. Sci. 103:77-89,
  DOI 10.1016/j.commatsci.2015.03.011. [A]
- Alhafez I.A., Urbassek H.M. (2016) "Scratching of hcp metals: A molecular-dynamics study", Comput. Mater. Sci.
  113:187-197, DOI 10.1016/j.commatsci.2015.11.038. [A]
- Alhafez I.A., Urbassek H.M. (2020) "Influence of the rake angle on nanocutting of Fe single crystals: A
  molecular-dynamics study", Crystals 10:516, DOI 10.3390/cryst10060516. [A]
- Alhafez I.A., Kopnarski M., Urbassek H.M. (2023) "Multiple scratching: An atomistic study", Tribol. Lett. [A]
- Gunkelmann N., Alhafez I.A., Steinberger D., Urbassek H.M., Sandfeld S. (2017) "Nanoscratching of iron: a novel
  approach to characterize dislocation microstructures", arXiv:1702.00457 (Comput. Mater. Sci. 135:181). [V, full text]
- Junge T., Molinari J.-F. (2014) "Plastic activity in nanoscratch molecular dynamics simulations of pure aluminium",
  Int. J. Plasticity 53:90-106, DOI 10.1016/j.ijplas.2013.07.005. [A]
- Noreyan A., Amar J.G. (2008) "Molecular dynamics simulations of nanoscratching of 3C SiC", Wear 265:956-962. [A]
- Eder S.J. et al. (2017) "Thermostat influence on the structural development and material removal during abrasion
  of nanocrystalline ferrite", arXiv:1704.04384 (ACS Appl. Mater. Interfaces). [A]
- Bifano T.G., Dow T.A., Scattergood R.O. (1991) "Ductile-regime grinding: a new technology for machining brittle
  materials", J. Eng. Ind. 113(2):184-189, DOI 10.1115/1.2899676. [A]
- Tersoff J. (1989) PRB 39:5566; (1990) erratum PRB 41:3248; (1994) PRB 49:16349. Erhart P., Albe K. (2005) PRB
  71:035211. Vashishta P. et al. (2007) J. Appl. Phys. 101:103515, DOI 10.1063/1.2724570. Stillinger & Weber (1985)
  PRB 31:5262. Justo et al. (1998) PRB 58:2539 (EDIP). Albe K. et al. (2002) PRB 66:035205 (GaAs). Mishin et al.
  (2001) PRB 63:224106. Foiles, Baskes, Daw (1986) PRB 33:7983. Mendelev et al. (2003) Phil. Mag. 83:3977 (Fe);
  (2008) Phil. Mag. 88:1723 (Al/Cu). Zope & Mishin (2003) PRB 68:024102 (Al). [A]
- Stukowski A. (2012) MSMSE 20:045021 (a-CNA); Stukowski A., Albe K. (2010) MSMSE 18:025016 and Stukowski, Bulatov,
  Arsenlis (2012) MSMSE 20:085007 (DXA); Maras E. et al. (2016) Comput. Phys. Commun. 205:13-21 (diamond structure
  identification). [A]
- LAMMPS documentation (read 2026-10-10): Howto_thermostat, Howto_temperature, Howto_output, Howto_walls,
  compute_stress_atom, compute_group_group, fix_indent, fix_balance, neigh_modify, lattice. [V]
- Baidh / Jha / Ghosh, "3C-SiC nanoscratching", J. Manuf. Process. 2026: **not located** by title/author search
  (two extended searches); nearest matches are a 2024 JMP 3C-SiC nano-polishing MD paper (vol. 120) and a 2025
  Surf. Interfaces paper on nano-scratch defects in 3C-SiC fixed-abrasive processes. **[U]** - supply DOI to verify.
