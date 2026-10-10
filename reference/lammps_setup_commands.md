# LAMMPS setup / control command reference (manual release 30 Sep 2026)

Condensed, exact syntax for generating nano-cutting / nano-scratching input decks.
Source: LAMMPS manual 30Sep2026 (Chapter 1 "Commands", Section 6.2 "Parsing rules").
Conventions below: `[...]` = optional, `a|b` = alternatives, "lattice units" = multiples of the lattice spacings printed by the last `lattice` command.

---

## 0. Input-script parsing rules (Section 6.2) — read first

1. Trailing `&` continues the command on the next line. A `#` comment after `&` breaks the continuation.
2. Everything from the first `#` onward is a comment (except inside quotes).
3. `$` substitution happens **before** the line is split into words, every time the line is read:
   - `$x` → variable named by the **single** character after `$` (`$xx` = variable `x` followed by literal `x`).
   - `${name}` → variable with multi-character name.
   - `$(formula)` → "immediate" variable: evaluated as an equal-style formula right now. Optional C format: `$(v_a*2:%.4f)` (default `%.20g`; the format must contain exactly one floating-point conversion — a second conversion like `:%.3f%d` is now rejected, changed 2Sep2026).
   - No nesting: `${b$a}` and `$($x-1.0)` are invalid; use `$(v_x-1.0)`.
   - `$` and `#` inside single/double/triple quotes are **not** substituted / not comments. Consequence: `variable r equal "${a}/${b}"` is a bug (quotes block substitution, formula later fails); write `variable r equal ${a}/${b}` or `variable r equal v_a/v_b`.
   - `v_name` references (used in formulas and in commands that accept variables such as `fix`, `region move`, `thermo_style`) are *not* substituted at parse time; they are evaluated when the consuming command runs.
4. Words are whitespace-separated. 5. First word = command name (lower-case, case sensitive).
6. Quote with `'...'`, `"..."` or `"""..."""` to make one argument containing spaces. Single/double-quoted args may span lines with `&`; triple quotes keep line breaks and ignore `&`. One level of quote nesting (needed for `if ... then "print 'x = $x'"` and `run N every M "print '...'"`).
7. Only 7-bit ASCII; non-ASCII (e.g. smart quotes, Å) is replaced with a warning when known, otherwise errors.

Script order: (1) initialization (`units dimension boundary atom_style processors newton`), (2) system definition (`lattice region create_box create_atoms` | `read_data` | `read_restart`), (3) settings (pair_style/coeff, mass, groups, velocity, fixes, computes, thermo, dump), (4) `run` / `minimize`.

---

## 1. units

```
units style          # style = lj | real | metal | si | cgs | electron | micro | nano
```
- Must precede `create_box` / `read_data`. Default `units lj`.
- `units metal` table (exact):

| quantity | metal unit |
|---|---|
| mass | grams/mole |
| distance | Angstroms |
| time | picoseconds |
| energy | eV |
| velocity | Angstroms/picosecond |
| force | eV/Angstrom |
| torque | eV |
| temperature | Kelvin |
| pressure | bars |
| dynamic viscosity | Poise |
| charge | multiple of electron charge (1.0 = proton) |
| dipole | charge*Angstroms |
| electric field | volts/Angstrom |
| density | gram/cm^dim |

- `units` also sets defaults: metal → `timestep 0.001` (ps) and `neighbor 2.0 bin`; real → 1.0 fs / 2.0 Å; lj → 0.005 τ / 0.3 σ.
- Potential files may carry a `UNITS:` tag; mismatch with `units` is an error (some combos auto-convert with a warning).
- Thermo normalization default: `thermo_modify norm yes` for lj, `norm no` for real/metal.
```
units metal
```

## 2. dimension

```
dimension N          # N = 2 | 3 (default 3)
```
Must precede `create_box`/`read_data`. For 2d, z must be periodic and the box z-bounds must straddle 0 (e.g. `-0.5 0.5`); use `fix enforce2d`. Stored in restart files.

## 3. boundary

```
boundary x y z       # each of x,y,z = one or two letters from p s f m
```
- `p` periodic (must be both faces of a dimension). `f` fixed non-periodic: an atom crossing the face is **deleted at the next reneighbor** → error unless `thermo_modify lost ignore|warn`. `s` shrink-wrap to atom extent. `m` shrink-wrap but never smaller than the initial box bound (useful to leave head-room above a surface).
- Two letters set lower then upper face: `boundary p p fm` → z lower fixed, z upper shrink-wrapped-with-minimum.
- Cannot be used after the box exists (`create_box`/`read_data`/`read_restart`); use `change_box ... boundary ...` instead. Default `p p p`. 2d requires z periodic.
- Big initial box with `s` boundaries in parallel can lose atoms on first shrink-wrap; prefer `m` or a box close to the atom extent.
```
boundary p s p
```

## 4. atom_style

```
atom_style style [args]
```
Styles: `atomic` (default: id, type, x, v, f, image, mask) · `charge` (atomic + q) · `bond`, `angle`, `molecular`, `full` (molecule-ID, topology; `full` adds q) · `sphere [0|1]` (radius, rmass, omega) · `ellipsoid`, `body ...`, `dipole`, `spin`, `peri`, `line`, `tri`, `template tID`, `hybrid sub1 sub2 ...`, plus package styles (dpd, edpd, mdpd, sph, smd, electron, dielectric, apip, oxdna, bpm/sphere, tdpd N).
- Must precede `create_box`/`read_data`/`read_restart`; cannot be changed afterwards (only augmented via `fix property/atom`).
- For metallic cutting with EAM/MEAM/Tersoff: `atom_style atomic`. `mass` is per-type for all styles except sphere/ellipsoid/peri/body/line/tri (per-atom mass).
```
atom_style atomic
```

## 5. lattice

```
lattice style scale [keyword values ...]
  style   = none | sc | bcc | fcc | hcp | diamond | sq | sq2 | hex | custom
  scale   = lattice constant in distance units (all unit styles except lj; for lj it is reduced density rho*)
  keywords:
    origin  x y z            # fractions of a unit cell, 0 <= x,y,z < 1 (z must be 0 for 2d)
    orient  dim i j k        # dim = x|y|z ; i,j,k integer Miller direction to align with that box axis
    spacing dx dy dz         # override the lattice spacings (multiplied by scale)
    a1 x y z / a2 x y z / a3 x y z   # custom only: unit-cell edge vectors
    basis x y z              # custom only: fractional coords of a basis atom (repeatable)
    triclinic/general        # custom only; for general triclinic boxes (origin/orient must be default)
```
- Unit cells: `sc` (1 basis), `bcc` (2), `fcc` (4: corner + 3 face centers), `diamond` (8), all cubic with a1=(1,0,0), a2=(0,1,0), a3=(0,0,1). `hcp`: 4 basis atoms, a1=(1,0,0), a2=(0,√3,0), a3=(0,0,√(8/3)). 2d: `sq` (1), `sq2` (2), `hex` (2, a2=(0,√3,0)). Style must match `dimension` (sc/bcc/fcc/hcp/diamond are 3d only).
- `scale` in metal units = lattice constant in Å: `lattice fcc 3.615` (Cu), `lattice diamond 5.431` (Si), `lattice bcc 2.87` (Fe).
- `orient` rules: the three direction vectors must be **mutually orthogonal**, **right-handed** (x × y = z), **integers** (need not be unit length). For 2d: orient x,y have 3rd component 0; orient z = 0 0 k. Default `orient x 1 0 0 orient y 0 1 0 orient z 0 0 1`. (For hcp/hex/custom non-orthogonal cells the three vectors act as a rotation matrix.)
- **Lattice spacings** (printed when `lattice` runs; used by every command with `units lattice`): if unrotated, spacing_x = scale*|a1| etc. If rotated via `orient`, LAMMPS uses the x/y/z extent of the rotated unit cell's 8 corners — generally NOT a periodicity of the crystal, so a periodic box that is an integer number of such spacings will usually create **overlapping atoms at the faces**. Fix with `spacing dx dy dz` (values are multiples of scale), or define regions/boxes with `units box`. Practical rule: for `orient x 1 1 0 orient y -1 1 0 orient z 0 0 1` on fcc, set `spacing 1.41421356 1.41421356 1.0` (= √2 √2 1).
- `lattice none scale` defines only a spacing (scale × 1 in each direction), no basis → cannot be used with `create_atoms`. Default: `lattice none 1.0`.
- `lattice` may be re-issued any number of times; subsequent `region`/`create_atoms` use the latest (this is how polycrystals / rotated tool & workpiece are built).
- Basis atom numbering (for `create_atoms ... basis M type`) follows the order above; diamond has 8 basis atoms, 1–8.
```
lattice fcc 3.615 orient x 1 0 0 orient y 0 1 0 orient z 0 0 1
lattice custom 3.52 a1 1.0 0.0 0.0 a2 0.5 1.0 0.0 a3 0.0 0.0 0.5 basis 0.0 0.0 0.0 basis 0.5 0.5 0.5
```

## 6. region

```
region ID style args [keyword value ...]
  delete
  block     xlo xhi ylo yhi zlo zhi
  cylinder  dim c1 c2 radius lo hi        # dim = x|y|z = axis; c1 c2 = coords in the OTHER two dims (x:y,z  y:x,z  z:x,y)
  sphere    x y z radius
  cone      dim c1 c2 radlo radhi lo hi   # one radius may be 0.0, not both
  prism     xlo xhi ylo yhi zlo zhi xy xz yz
  plane     px py pz nx ny nz             # "inside" = half-space on the normal side
  ellipsoid x y z a b c
  union     N reg1 reg2 ...   (N >= 2)
  intersect N reg1 reg2 ...   (N >= 2)
  keywords:
    side  in|out               (default in)
    units lattice|box          (default lattice!)
    move  v_x v_y v_z          # equal-style variables or NULL; displacement vs time
    rotate v_theta Px Py Pz Rx Ry Rz   # theta in radians
    open  N                    # face index, only for fix wall/region
```
- **Default `units lattice`** — every distance is multiplied by the current lattice spacing in the corresponding dimension. For `cylinder`: lo/hi scaled by spacing in `dim`; c1,c2 by the spacings of their dims; **radius scaled by the spacing of the c1 dimension**. For `sphere`: center by x,y,z spacings, radius by x spacing. Use `units box` for Å.
- `EDGE` = current box boundary in that direction; `INF` = ±1e20. Allowed for lo/hi of block/cone/cylinder/prism. Neither may be used before the box exists. With prism, a non-zero tilt forbids both bounds of the involved dims being INF.
- Points exactly on the boundary count as inside (`side in`) / outside (`side out`).
- Regions are never wrapped across periodic boundaries; they are always 3d objects (2d sims: make z span the plane).
- `union`/`intersect` cannot carry `move`/`rotate` (apply them to sub-regions); sub-regions cannot be deleted afterwards.
- Any geometric value may be an equal-style variable `v_name` (sphere/cylinder/cone/block/prism/plane/ellipsoid as listed) → evaluated every step. For `plane`, all normal components must be constants or all variables.
- Prism tilt limits for `create_box`: |xy| ≤ (xhi−xlo)/2 etc. (warning, not error).
```
region box      block 0 60 0 40 0 30 units box
region tool     sphere 30.0 20.0 42.0 8.0 units box
region cut      cylinder y 30.0 42.0 8.0 INF INF units box
region moving   sphere 30 20 42 8 units box move v_dx NULL NULL
region work     intersect 2 box tool side out      # workpiece minus tool volume
```

## 7. create_box

```
create_box N region-ID [keyword value ...]
create_box N NULL alo ahi blo bhi clo chi [...]     # general triclinic (needs lattice custom ... triclinic/general)
  N = number of atom types in the whole simulation (fixed afterwards)
  keywords: bond/types n  angle/types n  dihedral/types n  improper/types n
            extra/bond/per/atom n  extra/angle/per/atom n  extra/dihedral/per/atom n
            extra/improper/per/atom n  extra/special/per/atom n
```
- Non-prism region → axis-aligned bounding box of the region becomes the box (region given in lattice units unless `units box`). Prism region → restricted triclinic box.
- Requires `atom_style` and the region defined first. Sets timestep to 0. Also fixes the processor grid.
- Box bounds should be close to where atoms will be (non-periodic dims); huge empty `s` boxes lose atoms in parallel.
```
region simbox block 0 30 0 20 0 25          # lattice units
create_box 2 simbox                         # types 1 = workpiece, 2 = tool
```

## 8. create_atoms

```
create_atoms type style args [keyword values ...]
  box                      # fill whole box on current lattice
  region  region-ID        # fill lattice sites inside the region (and inside the box)
  single  x y z            # one atom (lattice units unless 'units box')
  random  N seed region-ID # N random points; region-ID or NULL for whole box
  mesh    STL-file         # needs units box
  keywords:
    basis M itype        # assign atom type itype to lattice basis atom M (repeatable)
    ratio frac seed | subset Nsub seed   # populate random fraction/number of lattice sites
    group gname          # add created atoms to group (created if needed)   [Added 12Jun2025]
    remap yes|no         # single style only: wrap into periodic box (default no)
    var vname set x xx set y yy set z zz   # create only where equal-style var vname != 0
    overlap D maxtry N   # random style: min distance to existing atoms (default no check / 10 tries)
    rotate theta Rx Ry Rz / mol tID seed   # molecules
    units lattice|box    # default lattice (affects single coords, random overlap D, mesh)
```
- A box must exist; a lattice (not `none`) must be defined for box/region/single-lattice.
- `basis M itype` overrides the leading `type` for basis atom M — e.g. for diamond with two species: `create_atoms 1 box basis 2 2 basis 4 2 basis 6 2 basis 8 2` (or `create_atoms C region r basis 1 Si` with type labels).
- `box` style: if periodic and box length is an exact multiple of the spacing, exactly one atom is placed at each periodic face. `region` style does NOT do this → avoid regions that coincide with periodic box faces or you get doubled atoms; shrink the region by a fraction of a spacing or use `delete_atoms overlap`.
- Atoms outside the box are silently not created (even with shrink-wrap boundaries) — enlarge with `change_box` first.
- Created atoms get velocity 0, charge 0, consecutive IDs following the current max ID (ID assignment depends on processor count).
- `porosity` style was renamed `random` (2Jun2022).
```
lattice fcc 3.615
region  work block 0 30 0 20 0 15 units lattice
create_atoms 1 region work
lattice diamond 3.567
region  tool sphere 15 10 23 6
create_atoms 2 region tool
```

## 9. delete_atoms

```
delete_atoms style args [keyword value ...]
  group    group-ID
  region   region-ID
  overlap  cutoff group1 group2     # delete one atom of each pair closer than cutoff; the group1 atom is deleted
  random   fraction f yes|no group region|NULL seed
  random   count    N yes|no group region|NULL seed
  variable vname                    # atom-style variable != 0  [Added 4May2022]
  keywords: compress yes|no  condense yes|no  bond yes|no  mol yes|no
```
- `overlap` needs a ready-to-run system (pair_style + coeffs + masses set) and pair cutoff + skin ≥ cutoff; result may differ by processor count.
- `compress yes` (default for atomic systems) renumbers IDs 1..N (order not preserved). For molecular systems default is `compress no` (changed 10Sep2025: uses `reset_atoms id` internally); `condense yes` (added 10Sep2025) preserves ID order but is slow.
```
delete_atoms region cut
delete_atoms overlap 0.5 all all
```

## 10. group

```
group ID style args
  delete | clear | empty | static
  region  region-ID
  type    t1 t2 ... | type <|<=|>|>=|==|!= t | type <> t1 t2       # values may be A:B or A:B:C ranges, or type labels
  id      ... (same forms)
  molecule ... (same forms)
  variable vname                 # atom-style variable != 0
  include molecule
  subtract g1 g2 [g3 ...]        # in g1 but not in any other
  union    g1 [g2 ...]
  intersect g1 g2 [...]
  dynamic parent-ID [region rID] [var vname] [property name] [every N] [exclude gID] [include molecule] [within cutoff]
```
- Groups are **static**: `group X region R` is a one-time assignment at that moment (atoms keep membership after leaving the region). Re-using an existing ID *adds* atoms.
- Max **32 groups** including `all`. `all` is predefined, cannot be deleted. Delete unneeded groups (`group X delete`) if you hit the limit; a group used by an active fix/compute/dump cannot be deleted.
- `dynamic` groups are re-evaluated at run start and every N steps; not every fix/compute accepts dynamic groups; parent cannot itself be dynamic. `exclude` added 30Mar2026, `include molecule`/`within` added 11Feb2026/30Mar2026.
- Variable-based groups need current compute data → do `run 0 post no` first if the variable uses a compute.
```
region  bottom block INF INF INF INF INF 2 units lattice
group   fixed   region bottom
group   thermo  region tbath
group   mobile  subtract all fixed
group   tool    type 2
group   work    subtract all tool
```

## 11. set

```
set style ID keyword values ...
  style = atom | type | mol | group | region
  ID    = atom-ID range (e.g. 100*200, *), type range or label, mol range, group-ID, region-ID
  keywords (most common): type t | type/fraction t frac seed | type/ratio t frac seed | type/subset t N seed
     mol m | charge q | mass m | x v | y v | z v | vx v | vy v | vz v | image nx ny nz
     diameter d | density d | shape sx sy sz | quat a b c theta | dipole x y z | spin/atom ... | i_name v | d_name v
```
- Most values accept an atom-style variable `v_name` (evaluated per selected atom; `type/fraction`, `type/ratio`, `type/subset`, `dipole/random`, `quat/random`, bond/angle types do not).
- Wildcard ranges: `*`, `*n`, `n*`, `m*n` (lowest is 1, or 0 for mol).
- Requires the attribute to exist in the atom_style (e.g. `charge` needs atom_style charge/full). Changed 28Mar2023: type labels allowed.
```
set group tool type 2
set region half charge 0.5
set atom * vx 0.0 vy 0.0 vz 0.0
```

## 12. mass

```
mass I value       # I = type number, type label, or wildcard * / *n / n* / m*n
```
- Must come after the box exists and before `run`/`velocity`/`fix shake`. All types need a mass > 0. EAM/BOP potential files define masses themselves (`mass` then optional but harmless; for `pair_style hybrid` with eam it is usually still required for the non-EAM types).
```
mass 1 63.546
mass 2 12.011
```

## 13. velocity

```
velocity group-ID style args [keyword value ...]
  create temp seed
  set    vx vy vz          # any = NULL to leave unchanged; may be v_name (equal- or atom-style; always box units)
  scale  temp
  ramp   vdim vlo vhi dim clo chi
  zero   linear|angular
  keywords: dist uniform|gaussian  sum no|yes  mom yes|no  rot no|yes  temp compute-ID  bias no|yes
            loop all|local|geom  rigid fix-ID  units box|lattice
```
- Defaults: `dist uniform`, `sum no`, `mom yes`, `rot no`, `bias no`, `loop all`, **`units lattice`** (affects `set` and `ramp` numbers only — velocities then are lattice-spacings/ps!). Always add `units box` to `velocity ... set`.
- `create` temperature uses an internal `compute temp` on the group (DOF of fixes like shake/rigid not yet known → `run 0` then `velocity ... scale T`).
- `loop geom` gives processor-count-independent velocities for atoms made by `create_atoms`; `loop all` is only reproducible for atoms from a data file.
- 2d: z velocities not set. Masses must be defined first.
```
velocity mobile create 300.0 4928459 dist gaussian mom yes rot yes loop geom
velocity tool   set 0.0 0.0 -0.5 units box      # Å/ps in metal units
velocity all    zero linear
```

## 14. displace_atoms

```
displace_atoms group-ID style args [units box|lattice]
  move   delx dely delz            # each may be v_name (equal or atom style; units factor applied to result)
  ramp   ddim dlo dhi dim clo chi
  random dx dy dz seed             # uniform in [-dx,dx] etc.
  rotate Px Py Pz Rx Ry Rz theta   # theta in degrees, right-hand rule
```
- Default `units lattice`. Atoms are remapped into periodic box afterwards; shrink-wrapped boxes resize. Do not move atoms on top of others. 2d: rotation axis must be z.
```
displace_atoms tool move 0.0 0.0 5.0 units box
```

## 15. neighbor / neigh_modify

```
neighbor skin style        # style = bin | nsq | multi ; default metal: 2.0 bin (Å)
neigh_modify keyword values ...
  delay N        # no rebuild until N steps after last build (default 0); if non-zero must be a multiple of every
  every M        # consider rebuilding every M steps (default 1)
  check yes|no   # yes (default): rebuild only if some atom moved > skin/2
  once yes|no    # build once per run (cold crystals only)
  one N          # max neighbors of one atom (default 2000)
  page N         # neighbors per page (default 100000); must be >= 10*one
  binsize s      # default 0.0 = half the cutoff
  exclude type M N | exclude group g1 g2 | exclude molecule/intra g | exclude molecule/inter g | exclude none
  include group-ID | cluster yes|no | collection/type ... | collection/interval ... | bin/hash yes|no  [Added 4Jul2026]
```
- Typical: `neigh_modify delay 0 every 1 check yes` (safe, what `minimize` enforces anyway) or `every 2 delay 10 check yes` for cheap MD.
- `exclude group frozen frozen` or `exclude type 2 2` skips pair computation inside a rigid/frozen tool (big speed-up for diamond tools; not valid with kspace). Type labels allowed (29Aug2024).
- Writing a restart forces a neighbor rebuild on that step (may change trajectory subtly); to keep identical trajectories use `check no` with `every` dividing the restart frequency.
- Many neighbors per atom + dense overlap can crash without message if neighbors > page; fix the geometry rather than raising `one`.
```
neighbor     2.0 bin
neigh_modify delay 0 every 1 check yes one 5000 page 100000
```

## 16. timestep

```
timestep dt      # time units: metal → ps.  Default metal 0.001 ps (1 fs)
```
```
timestep 0.001
```

## 17. run

```
run N [upto] [start N1] [stop N2] [pre yes|no] [post yes|no] [every M c1 c2 ...]
```
- `run 0` = setup + thermo only (use to initialize computes/variables before `print` or `velocity scale`).
- `upto`: run from the current step up to step N (for restart loops). `start/stop`: tell ramping fixes (`fix nvt` Tstart→Tstop, `ramp()`, `vdisplace()`, `elaplong`) the full span across several runs.
- `pre no` skips setup (only valid if nothing changed between runs — adding fixes/dumps, `set`, neighbor changes, `write_restart` require `pre yes`); `post no` skips the full timing summary.
- `every M "cmd1" "cmd2"`: run in M-step chunks and execute quoted commands between chunks (variables re-evaluated each time); must be the last keyword; `NULL` = no command. Cannot be used to `jump` out of a run — use `fix halt`.
- N < 2^31 (without `upto`). Timestep counter is 64-bit.
```
run 20000
run 100000 every 1000 "print 'step $(step) depth $(v_depth:%.3f)'"
```

## 18. minimize / min_style / min_modify

```
minimize etol ftol maxiter maxeval
  etol = relative energy change tolerance (unitless), ftol = force 2-norm tolerance (force units, eV/Å)
  maxiter = max outer iterations, maxeval = max force evaluations
min_style style        # cg (default) | sd | hftn | quickmin | fire | spin | spin/cg | spin/lbfgs
min_modify keyword values ...
  dmax max              # max per-atom move per line search / iteration (distance units, default 0.1)
  line backtrack|quadratic|forcezero   (default quadratic)
  norm two|inf|max      (default two)
  fire options: integrator eulerimplicit|verlet|leapfrog|eulerexplicit, tmax f, tmin f, delaystep n, dtgrow, dtshrink, alpha0, alphashrink, vdfmax, halfstepback, initialdelay, abcfire yes|no
```
- Stops when any criterion is met: ΔE/|E| ≤ etol, |F|₂ ≤ ftol, line search fails, iterations > maxiter, evaluations > maxeval. Either tolerance may be 0.0.
- During minimization `neigh_modify every 1 delay 0 check yes` is enforced temporarily (message printed). Iterations count as timesteps → thermo/dump/restart output triggers.
- Only certain fixes act during minimization: `addforce`, `efield`, `enforce2d`, `indent`, `lineforce`, `planeforce`, `setforce`, `spring`, `spring/self`, `viscous`, `wall*`, `box/relax` (cg/sd only). Freeze atoms with `fix setforce 0 0 0`. `fix rigid` is NOT honoured; `fix shake` substitutes stiff bonds (since 15Sep2022).
- `quickmin`/`fire` are damped dynamics and use `timestep` (fire: use the normal MD timestep; min_style fire was re-added/optimized 11Feb2026 with /kk variant).
- Use pair styles that go to 0 at the cutoff (`pair_modify shift yes`) for tight tolerances; many-body splines can prevent convergence.
```
min_style cg
min_modify dmax 0.1 line quadratic
minimize 1.0e-6 1.0e-8 5000 50000
```

## 19. write_restart / restart / read_restart

```
write_restart file [nfile Nf | fileper Np]     # '*' → timestep, '%' → per-processor pieces (+ file.base)
restart 0
restart N root [nfile|fileper ...]             # files root.N  (or root with '*' replaced by step)
restart N file1 file2                          # toggle between 2 names
restart v_name root                            # equal-style variable returning next step (stride(), logfreq(), ...)
read_restart file                              # file may contain '*' → latest matching timestep is read
```
- `restart N` writes on multiples of N, **not** on the first step of a run and not on the last step unless it is a multiple of N (but IS written at the end of a converged minimization if N>0). `write_restart` writes immediately (system must be ready to run: pair style, masses).
- Binary, platform/version specific; convert with `lmp -restart2data file data` if needed.
- **Stored** in a restart file (no need to re-specify): `units`, `dimension`, `newton bond`, `atom_style` + `atom_modify id/map/sort`, `comm_style` + `comm_modify mode/cutoff/vel`, `timestep` size and step number, box size/shape and **`boundary`**, **group definitions**, per-type `mass`, per-atom attributes (coords, velocities, image flags, group membership, topology), **force-field styles** (pair_style, bond_style, ...), force-field **coefficients for most pair styles**, `pair_modify` (except compute), `special_bonds`.
- **NOT stored** (must re-issue): `newton pair`, **all `fix` commands**, **all `compute` commands**, **`variable`s**, **`region`s**, `neighbor`/`neigh_modify`, `kspace_style`/`kspace_modify`, `thermo*`/`dump`/`restart` output settings. Many-body / tabulated / hybrid pair styles (eam, meam, tersoff, sw, hybrid ...) do NOT store coefficients → re-issue `pair_coeff` (and for hybrid also `pair_style`) after `read_restart`.
- Fixes with internal state (e.g. nvt, langevin, ave/time) are re-enabled only if the new script defines the same fix style with the **same fix-ID** before the first run; otherwise the state is discarded (list printed). `velocity`, `set`, `displace_atoms`, `delete_atoms`, `balance` before the first run also discard unused fix state.
- Exact restarts need the same processor count and newton/processors settings; `fix langevin`/`fix shake` restart only statistically.
- Since 23Jun2022 out-of-box atoms are remapped automatically (old `remap` keyword removed). `read_restart` resets `comm_modify` settings → re-issue `comm_modify` after it; also use `change_box` after `read_restart` if boundaries must change.
```
restart 10000 restart.*.bin
write_restart relaxed.restart
# --- continuation deck ---
read_restart relaxed.restart
pair_style eam/alloy
pair_coeff * * Cu_u3.eam Cu Cu
region tool sphere 30 20 42 8 units box      # regions are not restored
```

## 20. write_data / read_data

```
write_data file [nocoeff] [nofix] [nolabelmap] [triclinic/general] [types numeric|labels] [pair ii|ij]
read_data file [add append|IDoffset [MOLoffset]|merge] [offset toff boff aoff doff ioff] [shift sx sy sz]
               [extra/atom/types n] [extra/bond/types n] ... [extra/special/per/atom n] [group gID] [nocoeff] [fix fID hdr sec]
```
- Data files are text (`file.gz` works if built with gzip; write_data gz support added 11Feb2026). `*` in the write_data name → timestep.
- Data files store **no groups, no fixes**; pair coeffs only for simple styles (hybrid: none; many-body: none) → re-issue `pair_coeff`. `pair ij` writes cross terms. Lost atoms now handled per `thermo_modify lost` (4Jul2026).
- `read_data` sets timestep 0; `add` is required (and only allowed) when a box already exists; `offset/shift` need `add`. Header keywords (`atoms`, `atom types`, `xlo xhi`, `ylo yhi`, `zlo zhi`, `xy xz yz`, `Masses`, `Atoms`, ...) must be spelled exactly with single spaces. Atoms-section line for `atomic`: `atom-ID atom-type x y z [nx ny nz]`; `charge`: `atom-ID atom-type q x y z`; `full`: `atom-ID molecule-ID atom-type q x y z`.
```
write_data relaxed.data pair ij
read_data  relaxed.data extra/atom/types 1 group work
```

## 21. variable

```
variable name style args ...
  delete
  index    s1 s2 ...              # first string; advanced by 'next' (also settable with -var on command line)
  loop     N | N pad | N1 N2 | N1 N2 pad
  uloop / universe / world        # multi-partition
  string   s                      # redefinable; substitutes variables even inside quotes
  getenv   ENVNAME
  file     filename | atomfile filename
  format   vname fstr             # e.g. variable s format x "%.6g"; fstr may contain extra text (changed 2Sep2026)
  internal value                  # numeric, set by other commands (create_atoms var/set, fix controller)
  python   funcname | timer
  equal    "formula"              # scalar, evaluated each use
  vector   "formula" | [1,3,7]    # global vector
  atom     "formula"              # per-atom
```
- Name = alphanumerics + underscore. A variable **cannot be redefined** (the second definition is silently ignored) **except** styles `string getenv internal equal vector atom python`, which are redefined every time. Exhausted loop/index/file variables (after `next` runs out) and `variable x delete` free the name.
- Formulas are NOT evaluated at definition — `variable v equal vol` stores the formula; to freeze a value use `variable v0 equal $v` or `$(vol)`.
- Formula content: numbers; constants `PI version on off true false yes no`; **thermo keywords** (`step dt time vol temp press pe ke etotal atoms lx ly lz xlo xhi ... xlat ylat zlat elapsed elaplong fmax fnorm ...` — any `thermo_style custom` keyword; the atom count keyword is `atoms` (the manual's prose mentions `natoms`, but the keyword list has `atoms`; `count(all)` is the unambiguous alternative); `temp`/`press` need the thermo computes to exist/be current); operators `() -x + - * / ^ % == != < <= > >= && || |^ !` (unary minus binds tighter than `^`: `-2^2 = 4`); math functions `sqrt exp ln log(base10) abs sign sin cos tan asin acos atan atan2(y,x) random(lo,hi,seed) normal(mu,sigma,seed) ceil floor round ternary(c,a,b) ramp(x,y) stagger(x,y) logfreq(x,y,z) logfreq2 logfreq3 stride(x,y,z) stride2 vdisplace(x0,v) swiggle(x0,A,T) cwiggle(x0,A,T)`; group functions `count(g) mass(g) charge(g) xcm(g,dim) vcm(g,dim) fcm(g,dim) bound(g,xmin|xmax|...) gyration(g) ke(g) angmom(g,dim) torque(g,dim) inertia(g,xx|yy|zz|xy|yz|xz) omega(g,dim)`; region variants add a trailing region-ID `count(g,r)`; special `sum(c_ID) min max ave trap slope sort rsort gmask(g) rmask(r) grmask(g,r) next(filevar) is_file(name) is_os(regex) extract_setting(name) label2type(kind,label) is_typelabel is_timeout()`; feature `is_available(cat,name) is_active(cat,name) is_defined(cat,id)`; atom values `x[123] vx[v_i] type[I] ...` (needs an atom map: `atom_modify map yes` for atomic styles); atom vectors (atom-style only) `id mass type mol radius q x y z vx vy vz fx fy fz`; custom props `i_name d_name`.
- References: `c_ID` global scalar, `c_ID[I]` vector element, `c_ID[I][J]` array; **capital** `C_ID[I]` = per-atom value of atom I inside an equal-style variable (same for `f_ID` / `F_ID`). `v_name`, `v_name[I]`. Equal-style formulas cannot contain anything producing a vector/per-atom vector; atom-style may use per-atom vectors but not global vectors.
- `ramp(x,y)` interpolates over the run (uses `run start/stop` span; returns x between runs). `vdisplace(x0,v) = x0 + v*(step-startstep)*dt` → constant-velocity tool motion. `swiggle/cwiggle` oscillation. `stride(x,y,z)` → next step in x..y by z (use for `restart v_s`, `dump_modify every`, `thermo v_s`).
- Variable accuracy: a variable that needs a compute (incl. `temp`, `press`, `pe`) **errors if evaluated before the first `run`/`minimize`** and may be stale after `delete_atoms`/`set` between runs → insert `run 0 post no`. Resetting the timestep also invalidates compute flags.
- `random/normal` share one RNG per style; only the first seed counts.
- `atomfile` variables are deleted by `clear`; others survive. Auto-deleted exhausted variables evaluate to 0.0 with a warning (changed 4Jul2026).
```
variable a      equal 3.615
variable depth  equal 10.0
variable vcut   equal -0.5                     # Å/ps
variable ztool  equal vdisplace(42.0,v_vcut)   # tool z vs time
variable fz     equal f_toolforce[3]
variable nwork  equal count(work)
variable str    format fz "%.4f"
print "Tool z = $(v_ztool:%.3f)  Fz = ${str}"
```

## 22. if / then / elif / else

```
if "boolean" then "cmd1" "cmd2" ... [elif "boolean" "cmd" ...] [else "cmd" ...]
```
- The boolean is **one argument** (quote it if it has spaces). All `$`-variables are substituted first; operands are numbers or strings (strings start with a letter; `==`/`!=` compare strings, other operators numbers only). Operators: `== != < <= > >= && || |^ !`, parentheses OK. A bare number: 0 → FALSE, else TRUE; a bare string is an error.
- Each command is one quoted argument; nest quotes once for `print`: `then "print 'x = $x'"`. `then` is a required word. Use `&` to spread across lines. `quit` is allowed as a command. Variables referenced as `v_` inside the if-boolean are NOT substituted — use `${name}` / `$(expr)`.
```
if "${step_now} > 1000" then "timestep 0.0005" else "timestep 0.001"
if "$(v_fz > 50.0)" then "print 'Large force'" "write_restart alarm.restart"
```

## 23. shell

```
shell cd dir | mkdir d1 [d2 ...] | mv old new | rm [-f] f1 [f2 ...] | rmdir d1 ... | putenv VAR=val ... | <any command>
```
- Built-ins (cd, mkdir -p semantics, mv, rm, rmdir recursive, putenv) run without a shell; anything else goes to `system()` on rank 0 only (cd runs on all ranks). Arguments get `$` substitution.
```
shell mkdir dumps restart
shell putenv LAMMPS_POTENTIALS=../potentials
```

## 24. log

```
log file [append]       # 'none' = no log file; default log.lammps
```
```
log log.cut.lammps append
```

## 25. print

```
print "string" [file fname | append fname] [screen yes|no] [universe yes|no]
```
- String is one argument (quotes; triple quotes for multi-line). `$x`, `${name}`, `$(formula[:fmt])` are substituted; equal- and vector-style values print (vector as `[1,2,3]`; added 15Jun2023). Executes once; for periodic printing use `fix print`, `run every`, or a jump loop.
```
print "Cutting depth = ${depth} A, tool speed = $(v_vcut*100:%.1f) m/s" append run.log screen yes
```

## 26. label / jump / next — loops

```
label ID
jump file|SELF [label]
next var1 [var2 ...]       # all of the same style: index | loop | file | universe | uloop (universe+uloop may mix)
```
- `jump SELF label` re-reads the current file from `label` (SELF needs `-in file`, not stdin). `jump` to a missing label runs to EOF and exits.
- `next` advances the variable; when exhausted it sets a flag so that the **next `jump` encountered is skipped** (loop exit) and deletes the variable. Break early with `if ... then "jump SELF break"` followed by `variable a delete` after the label.
```
variable i loop 5
label loop
  variable zoff equal 2.0*$i
  displace_atoms tool move 0 0 ${zoff} units box
  run 5000
next i
jump SELF loop
```

## 27. reset_timestep

```
reset_timestep N [time atime]
```
- Sets step counter (and optionally accumulated time). Errors if fixes tracking elapsed time exist (`fix deposit`, `fix dt/reset`). Clears compute "current" flags → do `run 0` before evaluating variables. Fixes ramping between Tstart/Tstop will jump.
```
reset_timestep 0
```

## 28. thermo / thermo_style / thermo_modify

```
thermo N                 # N = 0 (start & end only, default) or every N steps, or v_name returning next step
thermo_style one | multi | yaml | custom kw1 kw2 ...
thermo_modify keyword value ...
```
`thermo_style custom` full keyword list:
`step elapsed elaplong dt time cpu tpcpu spcpu cpuuse cpuremain part timeremain atoms temp press pe ke etotal evdwl ecoul epair ebond eangle edihed eimp emol elong etail enthalpy ecouple econserve vol density xlo xhi ylo yhi zlo zhi xy xz yz avecx avecy avecz bvecx bvecy bvecz cvecx cvecy cvecz lx ly lz xlat ylat zlat cella cellb cellc cellalpha cellbeta cellgamma pxx pyy pzz pxy pxz pyz bonds angles dihedrals impropers fmax fnorm nbuild ndanger c_ID c_ID[I] c_ID[I][J] f_ID f_ID[I] f_ID[I][J] v_name v_name[I]`
- `one` = `custom step temp epair emol etotal press`; `multi` = `custom etotal ke temp pe ebond eangle edihed eimp evdwl ecoul elong press` (multi-line). `vol` auto-appended to non-custom styles if the box changes.
- `c_ID[*]`, `c_ID[2*4]`, `f_ID[*]` wildcards expand to several columns (vector variables need an upper bound `v_name[*n]`).
- `thermo_style` must come after the box is defined and **resets all `thermo_modify` settings** → put `thermo_modify` after it.
- Built-in computes: `thermo_temp` (`compute temp` on all), `thermo_press` (`compute pressure thermo_temp`), `thermo_pe`. Override with `thermo_modify temp ID` / `press ID` (temp after press if both).
- `fmax`/`fnorm` monitor minimization; `nbuild`/`ndanger` monitor neighbor settings (ndanger > 0 → reduce `delay`).

`thermo_modify` keywords:
- `lost error|warn|ignore` (default error) — needed with fixed (`f`) boundaries where atoms may leave (chips flying off): `warn` prints once and continues; `ignore` silent. Since 4Jul2026 also governs `change_box`/`write_data` lost-atom behaviour.
- `lost/bond error|warn|ignore`; `warn ignore|reset|default|N` (warning limit, default 100).
- `norm yes|no` — normalize extensive quantities (pe, ke, etotal, evdwl...) by atom count; default `no` for metal/real, `yes` for lj. Variables are never normalized.
- `flush yes|no` (default no) — flush screen/log each thermo output (recommended for long runs).
- `line one|multi|yaml`; `colname ID string | auto | default` (added 4May2022 / auto 10Dec2025).
- `format line "string" | int "%fmt" | float "%fmt" | ID "%fmt" | none`; ID may be column number (±), range `2*6`, or keyword. `%d` works for step/atoms (8-byte ints handled). Since 2Sep2026 mismatched format strings (e.g. `%d` on a float) are an **error** at setup.
- `temp compute-ID`, `press compute-ID`, `triclinic/general yes|no`.
- Defaults: one/custom → `format int %10d float %14.8g`; multi → `%14d %14.4f`; yaml → `%d %.15g`.
```
thermo 1000
thermo_style custom step temp pe ke etotal press lx ly lz f_tool[1] f_tool[3] v_ztool
thermo_modify lost ignore flush yes norm no format float %14.6g
```

## 29. comm_modify

```
comm_modify keyword value ...
  mode single|multi           (default single)
  cutoff Rcut                 # ghost cutoff (distance units); 0.0 = default = pair cutoff + skin; smaller than default → ignored with warning
  cutoff/multi collection Rcut  reduce/multi
  group group-ID
  vel yes|no                  (default no) # ghost atoms carry velocities (needed by dpd, granular, some computes/fixes e.g. fix wall/gran, compute heat/flux with some styles)
```
- Reset by `comm_style` and by `read_restart` → re-issue after them. Raise `cutoff` when a fix/compute needs ghost atoms beyond the pair cutoff (e.g. coordination analyses with larger radii) or for bonded-only systems.
```
comm_modify vel yes cutoff 8.0
```

## 30. processors

```
processors Px Py Pz [grid onelevel|twolevel Nc Cx Cy Cz|numa|custom file] [map cart|cart/reorder|xyz|xzy|yxz|yzx|zxy|zyx] [part Ps Pr multiple] [file out]
```
- `*` lets LAMMPS choose; product must equal the MPI rank count; 2d needs Pz = 1. Only affects the initial grid (before `create_box`/`read_data`/`read_restart`). Useful for cutting: `processors * * 1` when the workpiece is thin in z, or `processors * 1 *` to keep the tool path within few ranks.
```
processors * * 1
```

## 31. package / suffix (OpenMP)

```
package omp Nthreads [neigh yes|no]     # Nthreads = 0 → use OMP_NUM_THREADS; must precede create_box/read_data
suffix off | on | omp | opt | gpu | intel | kk | hybrid s1 s2
```
- `suffix omp` makes every subsequently created pair/fix/compute/kspace/run style use its `/omp` variant if it exists (silently falls back otherwise). `suffix off`/`on` toggle temporarily. Equivalent command-line: `-sf omp -pk omp 4`. KOKKOS additionally needs `run_style verlet/kk` or `-sf kk`.
- `package omp` defaults: `Nthreads = 0, neigh = yes`; only valid if built with OPENMP. Only one global thread count exists across gpu/intel/omp packages (last wins).
```
package omp 4
suffix omp
```

## 32. echo

```
echo none|screen|log|both        # default: log
```
Echo each input line as processed (debugging the last command before an error).

## 33. change_box

```
change_box group-ID parameter args ... [parameter args ...] [units lattice|box]
  x|y|z   final lo hi | delta dlo dhi | scale factor | volume
  xy|xz|yz final tilt | delta dtilt
  boundary x y z          # same letters as boundary command
  ortho | triclinic | set | remap
```
- Operations apply **sequentially**, in order given. Atoms are NOT remapped unless `remap` appears (affine remap of `group-ID` atoms from the last `set` state to the current box). Default `units lattice`.
- Shrink-wrap is re-applied at the end → cannot enlarge an `s` box to insert atoms; switch to `f`/`m` first (`boundary f s s`), create atoms, then switch back.
- Changing `p`→non-periodic resets image flags (warning). Converting to/from triclinic requires no active dumps / fix deform. Since 4Jul2026 atoms left outside non-periodic faces follow `thermo_modify lost` (default **error**).
- After `read_restart`, change_box (except ortho/triclinic) errors if the restart holds per-atom fix data → `run 0` first.
```
change_box all z final 0.0 80.0 boundary p p f units box
change_box all x scale 1.01 y volume z volume remap
```

## 34. info

```
info keyword [keyword ...] [out screen|log|append file|overwrite file] [styles all|atom|pair|fix|compute|...]
  keywords: all system memory communication computes dumps fixes groups regions variables coeffs styles time accelerator fft configuration
```
- Prints internal state; good for verifying generated decks (`info groups regions variables fixes`). Keywords may be abbreviated. Default out = screen.
```
info system groups regions fixes variables out log
```

---

## Appendix A — Cross-cutting gotchas for deck generation

1. **Default `units lattice`** on `region`, `create_atoms single`, `velocity set/ramp`, `displace_atoms`, `change_box`: always write `units box` when numbers are in Å (or ensure a `lattice` with the intended spacing is in effect). `velocity create` temperature is unaffected.
2. Order constraints: `units`, `dimension`, `boundary`, `atom_style`, `processors`, `package`, `newton` before `create_box`/`read_data`; `mass` and `thermo_style` after; `thermo_modify`/`comm_modify` after the command that resets them; `pair_coeff` and masses before `delete_atoms overlap`, `write_restart`, `write_data`, `velocity`, `run`.
3. `thermo`, `restart`, dump intervals accept `v_name` (next-step generators `stride()`, `logfreq()`, `stagger()`).
4. Variables holding compute-dependent formulas (`temp`, `pe`, `c_ID`, `f_ID`) must not be printed before the first `run`; use `run 0 post no`.
5. 32-group limit; regions are free. Restart files keep groups but lose regions/fixes/computes/variables.
6. For long-time tool motion across several `run` commands use `run N start S stop E` with `vdisplace()`/`ramp()`, or `fix move linear`.
7. `fix` boundaries + atoms escaping = fatal unless `thermo_modify lost ignore|warn`.
8. Minimization temporarily forces `neigh_modify every 1 delay 0 check yes`; `fix setforce 0 0 0` freezes atoms during minimization (fix rigid is ignored).

## Appendix B — Recently changed behaviour (flagged in 30Sep2026 manual)

| Version | Change |
|---|---|
| 2Sep2026 | `thermo_modify format` strings are validated (type mismatch = error); `$(expr:fmt)` must have exactly one float conversion; `variable ... format` accepts extra text/flags; `inertia()`/`angmom()` include finite-size particle terms. |
| 4Jul2026 | `change_box` / `write_data` lost atoms obey `thermo_modify lost`; `neigh_modify bin/hash`; warning when file/atomfile variables auto-delete. |
| 30Mar2026 / 11Feb2026 | `group dynamic` gained `exclude`, `include molecule`, `within`; `min_style fire` (optimized, `/kk`); `write_data` to compressed files. |
| 10Dec2025 | `thermo_modify colname auto`. |
| 10Sep2025 | `delete_atoms`: molecular systems default `compress no` (uses `reset_atoms id`); new `condense`. |
| 22Jul2025 | `ternary(x,y,z)` evaluates only the selected branch. |
| 12Jun2025 | `create_atoms ... group` keyword. |
| 4Feb2025 | `sign(x)` math function. |
| 29Aug2024 | `neigh_modify exclude type` accepts type labels; `is_timeout()`. |
| 27Jun2024 | `sort()`/`rsort()` special functions. |
| 7Feb2024 | `ternary()`, custom per-atom property references in variables. |
| 15Jun2023 | `print` of vector variables; `variable vector [..]` literal; `is_typelabel()`. |
| 28Mar2023 | `set` accepts type labels. |
| 8Feb2023 | `min_modify abcfire`. |
| 15Sep2022 | `fix shake` allowed with `minimize`; `set spin` → `spin/atom`. |
| 23Jun2022 | `read_restart remap` keyword removed (always remaps). |
| 2Jun2022 | `create_atoms porosity` → `random` (+ `overlap`, `maxtry`); `mesh` style. |
| 4May2022 | `region ellipsoid`; `delete_atoms variable`; `thermo_modify colname`. |
| 24Mar2022 | `thermo_style yaml`. |
