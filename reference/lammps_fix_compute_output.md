# LAMMPS fix / compute / output reference for nano-cutting decks

Source: LAMMPS manual, release 30 Sep 2026. Syntax is exact; `[...]` = optional, `|` = alternatives.
Target workflow: `units metal` (Å, ps, eV, K, bar). Tool moved at constant velocity into a workpiece;
workpiece = boundary layer (frozen) + thermostat layer (NVT or velocity-rescale) + Newtonian zone (NVE).

Conventions used below:
- `c_ID` / `f_ID` / `v_name` = compute / fix / variable reference. One bracket `[I]` drops one dimension
  (vector -> element, array -> column); two brackets `[I][J]` = one element of an array.
- "global" values can go to `thermo_style custom`, `fix ave/time`, equal-style variables.
  "per-atom" values can go to `dump custom`, `fix ave/atom`, `fix ave/chunk`, `compute reduce`, atom-style variables.
  thermo_style can NOT take per-atom data; dump custom can NOT take global data.
- Thermostat fixes that do NOT integrate (langevin, temp/berendsen, temp/rescale, temp/csvr) need `fix nve` on the same atoms.
  `fix nvt`, `fix npt`, `fix rigid/*`, `fix move` DO integrate: never stack them with `fix nve` on the same atoms.
- Fix IDs and compute IDs: alphanumeric + underscore, must be unique per kind. Group IDs likewise (max 32 groups incl. `all`).
- Package tags: [core] = always built; otherwise the package that must be compiled in.

---------------------------------------------------------------------------------------------------

## 0. Cutting-deck skeleton (every command below is documented further down)

```
units           metal
# ... box, atoms, groups: tool, work, boundary, thermo_layer, newton, mobile (= thermo_layer+newton)
velocity        mobile create 300.0 4928459 rot yes dist gaussian
velocity        boundary set 0.0 0.0 0.0
velocity        tool set -0.5 0.0 0.0 units box          # 0.5 Å/ps = 50 m/s, cutting in -x

fix             frz  boundary setforce 0.0 0.0 0.0        # rigid layer: zero force, zero velocity
fix             tstat thermo_layer nvt temp 300.0 300.0 $(100.0*dt)
fix             nwt  newton nve
fix             tmv  tool move linear -0.5 0.0 0.0 units box   # tool: prescribed motion, NOT in any nve/nvt group

compute         Ttool tool temp/com                       # thermal T of tool w/o its streaming velocity
compute         Twork mobile temp
thermo_modify   temp Twork                                # default thermo_temp includes frozen+moving atoms: wrong
compute         Fcut tool group/group work                # force on tool due to workpiece (pairwise potentials only)
compute         Fsum tool reduce sum fx fy fz             # force on tool, any potential (valid: no setforce on tool)
compute         pe_at all pe/atom
compute         s_at all stress/atom NULL
compute         cna  work cna/atom 3.08                   # 0.854*a for fcc (Cu a=3.615 -> 3.086)
compute         keat newton ke/atom
compute         KEmax newton reduce max c_keat                 # hottest atom; T_atom = KE/(1.5*8.617333e-5) K
thermo          100
thermo_style    custom step time temp c_Ttool pe ke c_Fcut[1] c_Fcut[2] c_Fcut[3] c_Fsum[1] c_Fsum[2] c_Fsum[3]
thermo_modify   temp Twork flush yes
fix             fav all ave/time 10 10 100 c_Fsum[1] c_Fsum[2] c_Fsum[3] file forces.dat
dump            d1 all custom 1000 dump.*.lammpstrj id type x y z vx vy vz c_pe_at c_cna c_s_at[1] c_s_at[2] c_s_at[3] c_s_at[4] c_s_at[5] c_s_at[6]
dump_modify     d1 sort id format float %.6g
restart         50000 restart.*.bin
timestep        0.001
run             200000
write_restart   final.restart
```

---------------------------------------------------------------------------------------------------

## 1. FIXES

General: `fix ID group-ID style args ...`. Fixes act in the order defined. `unfix ID` removes.

### fix nve  [core]
```
fix ID group-ID nve
fix 1 newton nve
```
Velocity-Verlet integration of positions/velocities of the group. No thermostat. No output values. No restart info.
Use for the Newtonian zone and for atoms thermostatted by non-integrating fixes (langevin, berendsen, rescale, csvr).

### fix nvt  [core]  (Nose-Hoover)
```
fix ID group-ID nvt temp Tstart Tstop Tdamp [tchain N] [tloop M] [drag Df]
fix 1 thermo_layer nvt temp 300.0 300.0 $(100.0*dt)
```
- `temp` keyword is REQUIRED. Tdamp in TIME units (metal: ps). Manual guidance: Tdamp ~ 100 timesteps, i.e. `$(100.0*dt)`
  (dt = 0.001 ps -> Tdamp = 0.1). Too small -> wild T fluctuation; too large -> slow equilibration.
- Tstop must not be 0.0. Thermostats translational DOF only. Integrates: do NOT add fix nve on the same atoms.
- Creates its own compute `ID_temp` with the fix group (`compute ID_temp group-ID temp`). This is NOT `thermo_temp`.
- `fix_modify ID temp cID` : use a custom temperature compute (temp/com, temp/partial, temp/region, temp/profile, temp/chunk ...).
  Bias is removed, thermostatting done on thermal part, bias added back. Group of the compute should equal the fix group.
  Needed whenever the thermostatted atoms have a net streaming velocity (moving tool, chip flow).
- Output: global scalar = cumulative energy change (extensive), also in thermo `ecouple`/`econserve`;
  global vector of Nose-Hoover state (eta, eta_dot, ...) — intensive. Writes state to restart files.
- Defaults: tchain=3, tloop=1, drag=0.0.
- Warning in manual: fix nvt should not be used on atoms also thermostatted by another fix (langevin, temp/rescale).
- Caveat: `compute temp/region` bias with varying DOF should not be used with Nose-Hoover (nvt/npt); use with temp/rescale or langevin.

### fix npt / fix nph  [core]  (only if barostatting a periodic workpiece before cutting)
```
fix ID group-ID npt temp Tstart Tstop Tdamp iso|aniso|tri Pstart Pstop Pdamp [x|y|z Pstart Pstop Pdamp] [couple none|xyz|xy|yz|xz] [dilate group] ...
fix 1 all npt temp 300.0 300.0 0.1 iso 0.0 0.0 1.0
fix 1 all npt temp 300.0 300.0 0.1 x 0.0 0.0 1.0 z 0.0 0.0 1.0 couple none      # only periodic dims
```
Pdamp guidance ~ 1000 timesteps (metal: 1.0). A dimension can be barostatted only if it is periodic. Creates computes
`ID_temp` (group all) and `ID_press`. `fix_modify ID temp cID press cID` supported (specify `press` before `temp`).
Not for the cutting phase (free surface, non-periodic y).

### fix langevin  [core]  (needs fix nve)
```
fix ID group-ID langevin Tstart Tstop damp seed [scale type ratio] [tally yes|no] [zero yes|no] [angmom ...] [omega ...]
fix 2 thermo_layer langevin 300.0 300.0 0.1 48279 zero yes
fix 3 thermo_layer nve
```
- damp in time units (metal ps; 0.1 ps typical); seed = positive integer. Tstart can be `v_name` (equal or atom style).
- Only modifies forces (F = Fc - m/damp v + Fr). MUST be paired with fix nve on the same group. Do not stack with nvt.
- `fix_modify ID temp cID` supported (bias removal). `zero yes` removes net random force (no COM drift).
- Output: global scalar = cumulative energy change only if `tally yes` (extensive). Not exactly restartable (RNG state not saved).
- Defaults: angmom no, omega no, scale 1.0, tally no, zero no.

### fix temp/berendsen  [core]  (needs fix nve)
```
fix ID group-ID temp/berendsen Tstart Tstop Tdamp
fix 1 thermo_layer temp/berendsen 300.0 300.0 0.1
```
Rescales velocities every step toward T with time constant Tdamp (time units). Tstart may be `v_name` (equal-style).
Errors if current T is exactly 0. Needs fix nve. Creates `ID_temp`. `fix_modify ID temp cID` supported.
Output: global scalar cumulative energy change (extensive). Writes energy to restart.

### fix temp/rescale  [core]  (needs fix nve)
```
fix ID group-ID temp/rescale N Tstart Tstop window fraction
fix 1 thermo_layer temp/rescale 10 300.0 300.0 10.0 1.0
```
Every N steps, if |T - Ttarget| > window (temperature units), rescale velocities by `fraction` (0-1) of the difference;
fraction 1.0 = reset exactly. Errors on T == 0. Needs fix nve. Creates `ID_temp`; `fix_modify ID temp cID` supported.
Output: global scalar cumulative energy change (extensive).

### fix temp/csvr  [EXTRA-FIX]  (needs fix nve)  (also temp/csld, same syntax)
```
fix ID group-ID temp/csvr Tstart Tstop Tdamp seed
fix 1 thermo_layer temp/csvr 300.0 300.0 0.1 54324
```
Bussi canonical-sampling velocity rescaling; Tdamp time units; seed positive int. Needs fix nve. Creates `ID_temp`;
`fix_modify ID temp cID` supported. Output: global scalar cumulative energy change (extensive). Writes energy + RNG state to restart.
temp/csld not compatible with fix shake; temp/csld/kk cannot use a bias compute.

### fix setforce  [core]
```
fix ID group-ID setforce fx fy fz [region region-ID]
fix frz boundary setforce 0.0 0.0 0.0
fix 2 edge setforce NULL 0.0 0.0
```
- Sets force components to fx,fy,fz each step (erases previously computed force). `NULL` = leave that component alone.
  Each of fx,fy,fz may be `v_name` (equal- or atom-style).
- Freezing atoms for dynamics: also give them zero velocity (`velocity boundary set 0.0 0.0 0.0`); if they are in an
  integration group they then stay put. Simplest: exclude boundary atoms from every nve/nvt group AND setforce 0 0 0.
- Output: global 3-vector = total force on the group BEFORE forces were changed (extensive). `f_frz[1]`, `f_frz[2]`, `f_frz[3]`.
  This is the cleanest "reaction force on the frozen layer" and, if applied to a tool held by setforce, the force on the tool.
- During minimization only 0.0 values allowed. `fix_modify ID respa` supported.
- IMPORTANT: after setforce runs, the per-atom fx,fy,fz of the group ARE the set values. `compute reduce sum fx` on that
  group therefore returns 0 (or the set value*N). Use `f_ID[1..3]` instead.

### fix aveforce  [core]
```
fix ID group-ID aveforce fx fy fz [region region-ID]
fix pressdown tool aveforce NULL -1.0 0.0
```
Averages existing force over the group component-wise, sets every atom's force to that average + (fx,fy,fz) (so the group
moves as a rigid-ish block under its mean force). `NULL` = component not changed (differs from 0.0, which still averages).
fx,fy,fz may be equal-style `v_name`. Output: global 3-vector = total force on group before modification (extensive).
Group still needs an integrator (fix nve).

### fix addforce  [core]
```
fix ID group-ID addforce fx fy fz [every Nevery] [region region-ID] [energy v_name]
fix kick flow addforce 1.0 0.0 0.0
fix ff boundary addforce 0.0 0.0 v_push energy v_espace
```
Adds (fx,fy,fz) (force units; metal eV/Å) to each atom in the group. Components may be equal- or atom-style `v_name`.
`energy v_name` (atom-style) required only if variables used AND minimizing. Output: global scalar (potential energy of
added force, extensive) and global 3-vector = total force on group before modification. `fix_modify ID energy yes|no`,
`virial yes|no`, `respa` supported (defaults no).

### fix move  [core]  (prescribed tool motion)
```
fix ID group-ID move style args [units box|lattice] [update dipole]
style = linear   Vx Vy Vz                          (velocity units; any component NULL -> that component integrated like nve)
      | wiggle   Ax Ay Az period                   (X = X0 + A sin(2*pi*t/period); NULL allowed)
      | rotate   Px Py Pz Rx Ry Rz period          (axis through P along R, right-hand rule)
      | transrot Vx Vy Vz Px Py Pz Rx Ry Rz period (translation + rotation; no NULL)
      | variable v_dx v_dy v_dz v_vx v_vy v_vz     (equal- or atom-style; NULL allowed; displacement from X0 and velocity)
fix tmv tool move linear -0.5 0.0 0.0 units box
fix tmv tool move wiggle 0.0 0.0 2.0 5.0 units box
fix tmv tool move rotate 10.0 10.0 10.0 0.0 0.0 1.0 20.0 units box
```
- Updates position AND velocity each step ignoring forces. Sets v = V for linear. X(t) = X0 + V*(t - t_fix_defined).
- DEFAULT `units lattice` -> Vx in lattice spacings per time unit. ALWAYS write `units box` for Å/ps values
  (unless a `lattice` command was issued and lattice units are intended). `units` ignored for style variable.
- Atoms moved by fix move must NOT be in a fix nve / nvt / npt / rigid group ("positions and velocities updated twice").
- Forces on moved atoms are still computed (and not zeroed) -> `compute reduce sum fx fy fz` over the tool group gives
  the total force on the tool (intra-tool pair forces cancel). Prefer this or `compute group/group` for cutting forces.
- Moved atoms carry velocity V -> exclude the tool from thermo temperature / use `compute temp/com` for its temperature.
- Writes original coords + initial timestep to restart; do not `reset_timestep` after read_restart if continuing a fix move.
- Output: per-atom array, 3 columns = original unwrapped x,y,z. Atoms are remapped across periodic boundaries.
- Equivalent to style variable with `vdisplace(0.0,V)` / `swiggle()` / `cwiggle()` equal-style functions.
- Alternative constant-velocity tool without fix move: `velocity tool set vx vy vz units box` + `fix s tool setforce 0 0 0` + tool
  inside a `fix nve` group (manual: "assign initial velocity, set force to 0.0, integrate as usual"). Then force on tool = `f_s[1..3]`.

### fix rigid / rigid/nve / rigid/nvt (/small variants)  [RIGID]
```
fix ID group-ID style bodystyle args keyword values ...
style     = rigid | rigid/nve | rigid/nvt | rigid/npt | rigid/nph | rigid/small | rigid/nve/small | rigid/nvt/small | ...
bodystyle = single            (whole fix group = one body; rigid styles only, not /small)
          | molecule          (one body per molecule ID; mol ID 0 atoms form one body — keep them out of the group)
          | group N g1 g2 ... (N groups -> N bodies; rigid styles only)
          | custom i_name | v_name
keywords  = langevin Tstart Tstop Tdamp seed   (4 NVE rigid styles only)
          | temp Tstart Tstop Tdamp            (rigid/nvt, rigid/nvt/small only; Nose-Hoover on translation+rotation)
          | tparam Tchain Titer Torder | pchain N | reinit yes|no | force M xflag yflag zflag | torque M xflag yflag zflag
          | infile file | mol template-ID | dilate group | iso/aniso/x/y/z/couple (npt/nph) | gravity fix-ID
fix rt tool rigid single reinit yes
fix rt tool rigid single force * off off off torque * off off off      # body ignores external force/torque
fix rt tool rigid/nve single langevin 300.0 300.0 0.1 428984
fix rt tool rigid/nvt single temp 300.0 300.0 0.1
```
- rigid/rigid/nve/rigid/small/rigid/nve/small = NVE on bodies; rigid/nvt = Nose-Hoover; `temp` keyword only with nvt styles,
  `langevin` only with NVE styles. Each body >= 2 atoms; an atom in at most one body. Image flags must be consistent.
- Integrates the body atoms: do NOT include them in fix nve/nvt/npt/move groups. Non-rigid atoms need their own integrator.
- `force M xflag yflag zflag` / `torque ...`: M = body index 1..Nbody or wildcard `*`, `*n`, `n*`, `m*n`; `off` turns off that
  component of the COM force/torque. Body with force off keeps whatever COM velocity it has at run start.
- Constant-velocity rigid tool: `velocity tool set -0.5 0.0 0.0 units box` then `fix rt tool rigid single force * off off off torque * off off off`
  (reinit yes default rebuilds body properties, incl. COM velocity, at every `run`). Or hold the tool with fix move instead of fix rigid
  (manual: fix rigid is "overkill" to hold atoms stationary or move at constant velocity).
- fix move must not be combined with fix rigid on the same atoms. fix wall/reflect should not be used on rigid bodies.
- Output (rigid styles, not /small): global array, rows = bodies, 15 columns per body:
  1-3 COM xyz, 4-6 COM velocity, 7-9 force on COM, 10-12 torque on COM, 13-15 COM image flags. Force/torque are the
  values BEFORE the `force`/`torque` keywords are applied -> `f_rt[1][7]` = x-force on tool body = cutting force. Values are intensive.
  rigid/nve and rigid: global scalar = rigid-body temperature (intensive). NVT/NPT/NPH styles: global scalar = cumulative
  energy change (extensive); state written to restart.
- `fix_modify ID bodyforces early|late` (default late), `virial yes` default. Temperature computes on groups containing a whole
  body subtract the constrained DOF automatically. After `velocity create` on rigid systems do `run 0` then `velocity ... scale T`.
- For efficiency: `neigh_modify exclude group tool tool` to skip intra-tool pairs (valid only for true rigid bodies).

### fix momentum  [core]  (momentum/chunk is EXTRA-FIX)
```
fix ID group-ID momentum N linear xflag yflag zflag [angular] [rescale]
fix 1 work momentum 100 linear 1 1 1
fix 1 work momentum 100 linear 1 1 1 angular rescale
```
Every N steps subtract COM velocity (flags 1 = include dim) and/or angular momentum of the group. `rescale` conserves KE.
No output. Do not apply to the group that must stream (tool, chip).

### fix recenter  [core]
```
fix ID group-ID recenter x y z [shift group-ID] [units box|lattice|fraction]
fix 1 all recenter INIT INIT NULL units box
```
Shifts coordinates each step so the group COM stays at x,y,z (`NULL` = skip dim, `INIT` = initial COM). Define last among
integration fixes. Default units lattice. Output: global scalar (distance moved) + global 3-vector (shift). Avoid large initial shifts.

### fix ave/time  [core]
```
fix ID group-ID ave/time Nevery Nrepeat Nfreq value1 value2 ... [keyword args ...]
value   = c_ID | c_ID[I] | f_ID | f_ID[I] | v_name | v_name[I]          (GLOBAL quantities only; I may be wildcard *, *n, m*, m*n)
keyword = mode scalar|vector | ave one|running|window M | start Nstart | off M | file fname | append fname | overwrite
        | format "%g" | title1 "..." | title2 "..." | title3 "..."
fix fav all ave/time 10 10 100 c_Fsum[1] c_Fsum[2] c_Fsum[3] file forces.dat
fix fav all ave/time 1 1 100 c_Fcut[*] c_Ttool file forces.dat          # no averaging, just write every 100
fix fchunk all ave/time 100 1 100 c_Tchunk[1] file Tchunk.dat mode vector
```
- Nfreq must be a multiple of Nevery; Nevery*Nrepeat <= Nfreq; Nevery > 0 even if Nrepeat = 1. Averages are produced on
  steps that are multiples of Nfreq, over the Nrepeat samples taken every Nevery steps preceding it (e.g. 2 6 100 -> 90..100).
- Group-ID is ignored. Inputs must be global: compute global scalar/vector (mode scalar needs scalar or `[I]` element;
  mode vector needs vector or `[I]` column of global array), fix global values, equal-style or vector-style variables
  (atom-style NOT allowed). Fix inputs must produce values on steps compatible with Nevery.
- `mode scalar` (default): output one line per Nfreq: `TimeStep v1 v2 ...`. `mode vector`: block per Nfreq with
  `TimeStep Nrows` then `Row v1 v2 ...`. All vectors must have same length.
- `file` overwrites, `append` appends. `.yaml`/`.yml` suffix -> YAML. `overwrite` only with `ave running`.
- Output: global scalar (1 input, scalar mode), global vector (several inputs scalar mode, or 1 vector input), global array
  (several vector inputs). Values accessible only on multiples of Nfreq -> if used in thermo, thermo N must hit multiples of Nfreq.
  Extensive/intensive follows the inputs; variable values treated as intensive.
- Defaults: mode scalar, ave one, start 0, no file, format " %g".

### fix ave/atom  [core]
```
fix ID group-ID ave/atom Nevery Nrepeat Nfreq value1 value2 ...
value = x|y|z|vx|vy|vz|fx|fy|fz | c_ID | c_ID[I] | f_ID | f_ID[I] | v_name      (PER-ATOM quantities, I may be wildcard)
fix sav all ave/atom 10 100 1000 c_s_at[*]
dump d2 all custom 1000 dump.avestress.* id type x y z f_sav[1] f_sav[2] f_sav[3] f_sav[4] f_sav[5] f_sav[6]
```
Same Nevery/Nrepeat/Nfreq rules. Atoms outside group get 0.0. x,y,z are wrapped (use `compute property/atom xu yu zu` for
unwrapped). Output: per-atom vector (1 value) or array (several), valid only on multiples of Nfreq -> dump frequency must be
a multiple of Nfreq. Typical use: time-averaged per-atom stress / KE for smoother stress and temperature maps.

### fix ave/chunk  [core]
```
fix ID group-ID ave/chunk Nevery Nrepeat Nfreq chunkID value1 value2 ... [keyword args ...]
value   = vx|vy|vz|fx|fy|fz|density/number|density/mass|mass|temp | c_ID | c_ID[I] | f_ID | f_ID[I] | v_name   (per-atom)
keyword = norm all|sample|none | ave one|running|window M | bias bias-ID | adof N | cdof N | file fname | append fname
        | overwrite | format str | title1/2/3 str
compute cc1 work chunk/atom bin/2d x lower 5.0 y lower 5.0 units box
fix tprof work ave/chunk 10 10 1000 cc1 temp density/number file temp_map.dat
fix vprof work ave/chunk 10 10 1000 cc1 vx vy c_pe_at file profile.dat
```
- Sums per-atom values over atoms in each chunk and averages in time. Only atoms in the fix group AND with chunk ID != 0 count.
- `temp` = chunk temperature with DOF = N*adof + cdof (adof default = dimension, cdof 0); no streaming-velocity removal
  unless `bias bias-ID` (a temperature compute with bias, e.g. temp/profile). For per-chunk T with COM velocity removed per
  chunk use `compute temp/chunk ... com yes` + fix ave/time instead.
- File format per Nfreq: line `Timestep Nchunks`, then per chunk: `Chunk [OrigID] [Coord1 Coord2 Coord3] Ncount v1 v2 ...`
  (Coord columns appear for bin styles = bin centers, in distance units for `units box`).
- Output: global array, rows = Nchunk, columns = [OrigID] [coords] Ncount values. Accessible on multiples of Nfreq.
- Nchunk is held constant by this fix inside each Nfreq window (forever for ave running/window).
- Defaults: norm all, ave one, no bias, adof = dim, cdof 0.

### fix ave/histo  [core]  (ave/histo/weight: exactly 2 inputs, second = weight)
```
fix ID group-ID ave/histo Nevery Nrepeat Nfreq lo hi Nbin value1 value2 ... [keyword args ...]
value   = x|y|z|vx|vy|vz|fx|fy|fz | c_ID | c_ID[I] | f_ID | f_ID[I] | v_name | v_name[I]
keyword = mode scalar|vector | kind global|peratom|local | file f | append f | ave one|running|window M | start N
        | beyond ignore|end|extra | overwrite | title1/2/3 str
fix h1 work ave/histo 10 100 1000 0.0 50.0 50 c_pe_at file pe_histo.dat mode vector
fix h2 work ave/histo 1 1 1000 -2.0 2.0 100 vx vy vz mode vector ave running beyond extra
```
One histogram for all inputs combined. Inputs all global, or all per-atom (group applies), or all local; `kind` disambiguates.
Output file per Nfreq: `TimeStep Nbins Total-count Missing-count Min Max` then `Bin Coord Count Count/Total`.
Output: global vector (4: total count, missing, min, max) and global array (Nbin rows: coord, count, count/total).

### fix balance  [core]
```
fix ID group-ID balance Nfreq thresh style args [weight ...] [out fname]
style = shift dimstr Niter stopthresh | rcb | report
fix lb all balance 1000 1.05 shift x 10 1.05
fix lb all balance 1000 1.1 rcb
```
Dynamic load balancing every Nfreq steps when imbalance > thresh. `shift` (orthogonal boxes, 1d/2d/3d planes along
`x`,`xy`,`xyz`), `rcb` requires `comm_style tiled`. Useful because cutting leaves a vacuum above the workpiece.
Output: global scalar = imbalance factor after the last re-balance; global vector (3): max #particles per proc, #iterations, imbalance factor before the last re-balance.

### fix property/atom  [core]
```
fix ID group-ID property/atom name1 name2 ... [ghost yes|no]
name = mol | q | rmass | temperature | heatflow | i_name | d_name | i2_name N | d2_name N
fix pmol all property/atom mol ghost yes
fix pflag all property/atom i_layer d_sxx
```
- Adds per-atom properties missing from the atom style (e.g. molecule IDs for `atom_style atomic`) or custom
  integer/float vectors/arrays. Group-ID ignored. May be defined BEFORE the box exists so `read_data ... fix ID NULL Section`
  can fill it. Values migrate with atoms and ARE written to restart files -> a convenient way to tag tool/boundary/thermostat
  atoms persistently (`set group boundary mol 1`, `set group thermo_layer mol 2`, ...) and rebuild groups after
  `read_restart` with `group boundary molecule 1`.
- `ghost yes` recommended for mol/q/rmass (warning otherwise). Custom props readable by dump custom (`i_name`, `d_name`),
  compute property/atom, compute reduce, atom-style variables; set with `set atom * i_name v_var`.
- Values are written to binary restart files. To recover them, re-specify the fix AFTER `read_restart`, with exactly the
  same ID, names and data types as in the original script (LAMMPS only checks style/ID; mismatched names corrupt data).

### fix store/state  [core]
```
fix ID group-ID store/state N input1 input2 ... [com yes|no] [history Nevery Nrepeat Nfreq] [thresh v_name op value]
input = id|mol|type|mass|x|y|z|xs|ys|zs|xu|yu|zu|ix|iy|iz|vx|vy|vz|fx|fy|fz|q|...| c_ID | c_ID[I] | f_ID | f_ID[I] | v_name | d_name | i_name
fix ref work store/state 0 xu yu zu            # archive initial unwrapped coords once
fix cur work store/state 100 vx vy vz
```
N = 0 store once when fix is defined (atom attributes immediately; compute/fix/variable inputs at the start of the next run);
N > 0 re-store every N steps. Output: per-atom vector (1 input) or array. Example: pile-up/displacement maps with
`variable dy atom y-f_ref[2]`.

### fix deform  [core]  (box straining; not usually needed for cutting)
```
fix ID group-ID deform N parameter style args ... [remap x|v|none] [flip yes|no] [units lattice|box]
parameter = x|y|z   style = final lo hi | delta dlo dhi | scale f | vel V | erate R | trate R | volume | wiggle A Tp | variable v1 v2 | pressure ...
parameter = xy|xz|yz style = final t | delta dt | vel V | erate R | erate/rescale R | trate R | wiggle A Tp | variable v1 v2
fix 1 all deform 1 x erate 1e-4 units box remap x
```
Defaults: remap x, flip yes, units lattice (write `units box`). Changes box every N steps; `remap x` affinely remaps group atoms.
Dimension must be periodic (or shrink-wrapped where allowed). Incompatible with fix npt on the same dimension.

### fix viscous  [core]
```
fix ID group-ID viscous gamma [scale type ratio]
fix damp thermo_layer viscous 0.1
```
Adds F = -gamma*v (gamma in force/velocity units: metal eV·ps/Å^2). No thermostat; drains KE (e.g. damped relaxation
before cutting, with fix nve). No output. gamma relates to langevin damp but is NOT mass/time.

### fix enforce2d  [core]
```
fix ID group-ID enforce2d
fix 5 all enforce2d
```
Zeros z velocity and force every step (2d simulations with `dimension 2`). Define it AFTER any force-adding fixes (addforce, walls).

### fix print  [core]
```
fix ID group-ID print N "string with $v or ${v} or $(expr)" [file fname] [append fname] [screen yes|no] [title "..."]
fix fp all print 100 "step $(step) Fx $(c_Fsum[1]) Fy $(c_Fsum[2]) T $(c_Twork)" file forces.txt screen no title "# step Fx Fy T"
```
Prints every N steps (N may be `v_name` equal-style returning next step). Enclose in double quotes so variables are
evaluated at print time. Equal/vector-style variables and `$(formula)` immediate expressions (optionally `$(expr:%.4f)`).
Group ignored. Default screen yes. Vector variables print as `[a,b,c]`.

### fix halt  [core]
```
fix ID group-ID halt N attribute operator avalue [error hard|soft|continue] [message yes|no] [path "..."] [universe yes|no]
attribute = bondmax | tlimit | diskfree | v_name       operator = < <= > >= == != |^
fix stop all halt 100 v_Fx > 50.0 error soft
fix stop all halt 10 v_pe > 1.7e308 error soft            # catch inf/nan
fix stop all halt 100 tlimit > 86000
```
Checks every N (>= 1) steps; `error soft` ends the run but continues the script (subsequent run/minimize skipped unless
`timer timeout unlimited`); `continue` continues runs; `hard` = error exit. Group ignored. `unfix` before the next run.

### fix dt/reset  [core]
```
fix ID group-ID dt/reset N Tmin Tmax Xmax [emax Emax] [units lattice|box]
fix dtr all dt/reset 10 1.0e-5 0.001 0.05 units box
```
Every N steps picks dt so no atom moves more than Xmax (distance) per step, clamped to [Tmin,Tmax] (NULL = no bound).
Overrides `timestep`. Default units lattice -> write `units box`. Use `thermo_style custom ... time` and
`dump_modify every/time` when dt varies. Output: global scalar = last step dt was reset.

### fix wall/reflect  [core]
```
fix ID group-ID wall/reflect face arg [face arg ...] [units lattice|box]
face = xlo|xhi|ylo|yhi|zlo|zhi    arg = EDGE | constant | v_name (equal-style)
fix wr all wall/reflect ylo EDGE
fix wr all wall/reflect zlo 0.0 zhi 100.0 units box
```
Reflects atoms crossing the plane (position put back, velocity component flipped). Dimension must be NON-periodic.
Not for rigid bodies (warning). Default units lattice. No output; not in restart.

### fix wall/harmonic (and wall/lj93, wall/lj126, wall/morse ...)  [core]
```
fix ID group-ID wall/harmonic face coord epsilon sigma cutoff [face ...] [units lattice|box] [pbc yes|no] [fld yes|no]
coord = EDGE | constant | v_name ;  epsilon = spring constant K (energy/distance^2), sigma ignored, cutoff = range
fix wh all wall/harmonic ylo EDGE 10.0 0.0 4.0 units box
fix wl all wall/lj93 zhi EDGE 1.0 1.0 2.5 units box
```
E = eps*(r - rc)^2 for r < rc, repulsive only, zero at cutoff. Atoms must stay on the correct side (r > 0) else error.
Wall dimension must be non-periodic unless `pbc yes`. epsilon/sigma may be `v_name`. Default units lattice.
`fix_modify ID energy yes` to include wall energy in pe (default no); `virial yes|no` (default no).
Output: global scalar = wall energy; global vector = force on each wall (one per face) — extensive.

### fix_modify  [core]
```
fix_modify fix-ID keyword value ...
keyword = temp cID | press cID | energy yes|no | virial yes|no | respa N | dynamic/dof yes|no | bodyforces early|late | pad N
fix_modify tstat temp Twork
fix_modify npt1 press myP temp myT        # press first, then temp, so temp also overrides the pressure's temperature compute
```
`temp` works with nvt, npt, nph, langevin, temp/berendsen, temp/rescale, temp/csvr (compute must be a temperature style).
`energy yes` needed for addforce/wall fixes to contribute to pe and to minimization.

---------------------------------------------------------------------------------------------------

## 2. COMPUTES

General: `compute ID group-ID style args`. Computes are evaluated only when some output command (thermo, dump, fix ave/*,
variable) needs them. `uncompute ID` removes. Per-atom computes return 0 for atoms outside the group (unless noted).

### Temperature computes (all return global scalar T [intensive, K] + global 6-vector KE tensor [extensive, energy units],
indices 1-6 = xx yy zz xy xz yz, tensor lacks the 1/2 factor). All can be used by thermo_modify temp / fix_modify temp /
velocity ... temp / compute pressure.

| style | syntax | semantics |
|---|---|---|
| temp [core] | `compute ID group temp` | T = 2 KE / (Ndof kB); Ndof = dim*N - dim - fix constraints (fix rigid/shake subtracted). `thermo_temp` = `compute thermo_temp all temp` is created automatically. N assumed constant (`compute_modify ID dynamic/dof yes` otherwise). |
| temp/com [core] | `compute ID group temp/com` | subtracts group COM velocity first (bias). Use for the moving tool, a translating chip, or any group with net drift. |
| temp/partial [core] | `compute ID group temp/partial xflag yflag zflag` (0/1) | excludes velocity components with flag 0; DOF adjusted. E.g. `1 1 0` ignores vz; `0 1 1` ignores cutting-direction vx. Bias-capable. |
| temp/region [core] | `compute ID group temp/region region-ID` | only atoms currently inside region; DOF recomputed each call; NO fix-constraint DOF subtraction. Thermostat via fix_modify acts only on atoms in region (ok for temp/rescale, langevin; avoid with nvt/npt). |
| temp/chunk [core] | `compute ID group temp/chunk chunkID [temp] [kecom] [internal] [com yes|no] [bias bID] [adof N] [cdof N]` | global T of chunked atoms; with values -> global array (rows = chunks, cols = values, temperature/energy units, intensive). `com yes` subtracts each chunk's COM velocity (per-chunk streaming removal). com and bias are exclusive. |
| temp/profile [core] | `compute ID group temp/profile xflag yflag zflag binstyle args [out tensor|bin]`  binstyle = x Nx | y Ny | z Nz | xy Nx Ny | yz | xz | xyz Nx Ny Nz | subtracts spatially binned COM velocity (profile-unbiased thermostat); DOF reduced by Ns*Nx*Ny*Nz. `out bin` -> global array (rows = bins: count, T). |

Examples:
```
compute Ttool  tool   temp/com
compute Tcut   newton temp/partial 0 1 1
compute Tregion work temp/region near_tip
compute cbin   work   chunk/atom bin/2d x lower 5.0 y lower 5.0 units box
compute Tbin   work   temp/chunk cbin temp com yes          # per-bin thermal temperature map
fix     Tout   work   ave/time 100 1 100 c_Tbin[1] file Tbin.dat mode vector
compute Tprof  work   temp/profile 1 1 1 x 20
fix_modify tstat temp Tprof
```
Streaming-velocity rule (Howto thermostat / Calculate temperature): thermostats and thermo temperature should use a compute
that removes the advective bias (temp/com, temp/partial, temp/profile, temp/chunk com yes, temp/region) whenever the group
has non-thermal collective motion; otherwise the streaming KE is counted as heat and the thermostat drains it.
The default thermo temp (`thermo_temp`, group all) counts frozen boundary atoms (v = 0, lowering T) and moving tool atoms;
always `thermo_modify temp <compute on mobile group>`.

### compute chunk/atom  [core]
```
compute ID group-ID chunk/atom style args [keyword values ...]
style = bin/1d dim origin delta
      | bin/2d dim origin delta dim origin delta
      | bin/3d dim origin delta dim origin delta dim origin delta
      | bin/sphere xorig yorig zorig rmin rmax nsbin | bin/cylinder dim origin delta c1 c2 rmin rmax ncbin
      | type | molecule | c_ID | c_ID[I] | f_ID | f_ID[I] | v_name
dim = x|y|z ; origin = lower|center|upper|coordinate ; delta = bin width (distance units, or 0-1 fraction with units reduced)
keyword = region rID | nchunk once|every | limit 0|Nc max|Nc exact | ids once|nfreq|every | compress yes|no
        | discard yes|no|mixed | bound x|y|z lo hi | pbc yes|no | units box|lattice|reduced
compute cb1 work chunk/atom bin/1d y lower 2.0 units box
compute cb2 work chunk/atom bin/2d x lower 5.0 y lower 5.0 units box
compute cb3 all  chunk/atom bin/3d x lower 0.05 y lower 0.05 z lower 0.05 units reduced
compute ct  all  chunk/atom type
compute cm  all  chunk/atom molecule compress yes
```
Per-atom vector = chunk ID (1..Nchunk, 0 = no chunk). Bins are numbered fastest in the last listed dim. Bins span the box
(or `bound`) starting at origin. `units` default lattice -> write `units box` (or reduced). Triclinic boxes need units reduced.
`type`: Nchunk = ntypes. `molecule`: chunk = molecule ID (mol 0 atoms discarded or put in Nchunk per `discard`).
Used by fix ave/chunk, compute temp/chunk, com/chunk, msd/chunk, reduce/chunk, property/chunk.

### compute ke / ke/atom  [core]
```
compute ID group-ID ke          # global scalar, sum 1/2 m v^2 (extensive, energy)
compute ID group-ID ke/atom     # per-atom vector 1/2 m v^2 (energy)
compute keat all ke/atom
variable Tat atom c_keat/(1.5*8.617333e-5)      # per-atom "temperature" in K for metal units (kB = 8.617333e-5 eV/K); includes streaming KE
```
Thermo `ke` keyword is inferred from the thermo temperature (DOF-based), compute ke is the plain sum.

### compute pe / pe/atom  [core]
```
compute ID all pe [pair] [bond] [angle] [dihedral] [improper] [kspace] [fix]      # group must be all; global scalar (extensive)
compute ID group-ID pe/atom [pair] [bond] ... [fix]                                 # per-atom vector (energy)
compute pe_at all pe/atom
compute pe_sum all reduce sum c_pe_at                                               # == thermo pe
```
Default = all terms. Many-body (Tersoff/EAM) energy is shared equally among the atoms of each interaction. Fix energies need
`fix_modify ID energy yes`. `thermo_pe` = `compute thermo_pe all pe` created automatically.
Example: potential-energy map of the chip, or `variable dpe atom c_pe_at-v_pe_bulk` to highlight defects.

### compute stress/atom and centroid/stress/atom  [core]
```
compute ID group-ID stress/atom temp-ID [ke] [pair] [bond] [angle] [dihedral] [improper] [kspace] [fix] [virial]
compute ID group-ID centroid/stress/atom temp-ID [keywords]
compute s_at all stress/atom NULL
compute s_vir all stress/atom NULL virial            # exclude kinetic term
compute s_th all stress/atom Tcom                    # kinetic term with COM-velocity bias removed (Tcom = compute temp/com)
```
- temp-ID = temperature compute whose bias is removed from velocities in the kinetic term, or `NULL` (use raw velocities;
  also NULL if `ke` excluded). `virial` = everything except ke. Default = all terms.
- Output: per-atom array, 6 columns xx yy zz xy xz yz (centroid: 9 columns xx yy zz xy xz yz yx zx zy).
- UNITS = pressure*volume (metal: bar*Å^3). Formula S_ab = -m v_a v_b - W_ab, i.e. per-atom stress is the NEGATIVE of the
  per-atom pressure tensor: compression -> negative diagonal values, tension -> positive. Sum of diagonals over all atoms
  divided by (3V) = -P.
- Convert to GPa: sigma_ab [GPa] = c_s_at[k] / V_atom [Å^3] * 1.0e-4   (1 bar = 1e-4 GPa). V_atom = Voronoi volume
  (`compute voronoi/atom`, c_vor[1]) or the mean atomic volume a^3/4 (fcc, e.g. Cu: 11.81 Å^3; Al: 16.6 Å^3; Si diamond a^3/8 = 20.0 Å^3).
  ```
  variable Vat   equal 3.615^3/4.0
  variable sxx   atom  c_s_at[1]/v_Vat*1.0e-4
  variable hydro atom -(c_s_at[1]+c_s_at[2]+c_s_at[3])/(3.0*v_Vat)*1.0e-4      # hydrostatic PRESSURE in GPa (positive = compressive)
  variable vm    atom  sqrt(0.5*((c_s_at[1]-c_s_at[2])^2+(c_s_at[2]-c_s_at[3])^2+(c_s_at[3]-c_s_at[1])^2)+3.0*(c_s_at[4]^2+c_s_at[5]^2+c_s_at[6]^2))/v_Vat*1.0e-4
  variable tau   atom  c_s_at[4]/v_Vat*1.0e-4                                 # shear stress xy in GPa
  dump d1 all custom 1000 dump.stress.* id type x y z v_sxx v_hydro v_vm
  ```
  von Mises: sigma_vM = sqrt( 1/2[(sxx-syy)^2+(syy-szz)^2+(szz-sxx)^2] + 3(sxy^2+sxz^2+syz^2) ) with components in the same units;
  index map: [1]=xx [2]=yy [3]=zz [4]=xy [5]=xz [6]=yz.
- Per-atom stress is noisy: time-average with `fix ave/atom` (then dump `f_ID[1..6]`) or spatially average with fix ave/chunk.
- Sanity check from manual (3d): `compute p all reduce sum c_s_at[1] c_s_at[2] c_s_at[3]`; `variable press equal -(c_p[1]+c_p[2]+c_p[3])/(3*vol)` equals thermo `press`.
- centroid/stress/atom: not supported for many-body pair styles (EAM is the exception), nor kspace, nor fix rigid/*. Error if used.

### compute pressure  [core]
```
compute ID all pressure temp-ID [ke] [pair] [bond] [angle] [dihedral] [improper] [kspace] [fix] [virial] [pair/hybrid substyle]
compute myP all pressure Twork
compute pvir all pressure NULL virial
```
Group must be all. P = N kB T / V + virial/(dV). Global scalar (pressure units, bar) + global 6-vector pxx pyy pzz pxy pxz pyz
(intensive). temp-ID gives the kinetic term (NULL if ke excluded). `thermo_press` = `compute thermo_press all pressure thermo_temp`.
For a workpiece with a free surface the box volume includes vacuum -> absolute values are only meaningful relative to a reference.

### compute centro/atom  [core]
```
compute ID group-ID centro/atom lattice [axes yes|no]      lattice = fcc | bcc | N (even # of neighbors)
compute csp work centro/atom fcc
```
Centrosymmetry parameter (Kelchner), per-atom vector (unitless, >= 0, not normalized by a^2). Typical fcc values:
bulk 0, dislocation core ~1 (0.5-1.25), stacking fault ~5 (4-6), free surface ~23. Atoms with < N neighbors inside the
pair cutoff get 0. `axes yes` -> per-atom array 10 columns. Neighbor list rebuilt at each evaluation (dump only when needed).

### compute cna/atom  [core]
```
compute ID group-ID cna/atom cutoff
compute cna work cna/atom 3.086
```
Common neighbor analysis, per-atom vector: 1 fcc, 2 hcp, 3 bcc, 4 icosahedral, 5 unknown, 0 not in group.
Cutoff (midpoint between 1st and 2nd neighbor shells): fcc r_c = 0.8536 a; bcc r_c = 1.207 a; hcp r_c = 0.5(1+sqrt((4+2x^2)/3)) a, x = (c/a)/1.633.
Cu a=3.615 -> 3.086; Al a=4.05 -> 3.457; Ni a=3.52 -> 3.005; Fe bcc a=2.866 -> 3.459. Mono-component systems only.
Require pair cutoff + neighbor skin > 2*cutoff (else warning). Neighbor list built each evaluation.

### compute ptm/atom  [PTM]
```
compute ID group-ID ptm/atom structures threshold [group2-ID]
structures = default (fcc-hcp-bcc-ico) | all | hyphen list of fcc hcp bcc ico sc dcub dhex graphene
compute ptm work ptm/atom default 0.1 all
compute ptm work ptm/atom fcc-hcp-bcc-dcub-dhex 0.15 all      # Si/SiC: diamond cubic/hex
```
Polyhedral template matching, per-atom array 7 columns: 1 type (0 unknown, -1 outside group, 1 fcc 2 hcp 3 bcc 4 ico 5 sc
6 dcub 7 dhex 8 graphene), 2 rmsd, 3 interatomic distance, 4-7 quaternion qw qx qy qz. threshold 0.1-0.15 typical; 0 = no limit.
More robust than CNA at high T; no cutoff needed. Dump `c_ptm[1]`.

### compute coord/atom  [core]
```
compute ID group-ID coord/atom cutoff cutoff [group group2-ID] [type1 type2 ...]
compute ID group-ID coord/atom orientorder orientorderID threshold
compute cn work coord/atom cutoff 2.9                   # Si: 1st-neighbor shell 2.35 Å, 2nd 3.84 Å -> cutoff ~2.9-3.0
compute cn work coord/atom cutoff 2.4 1 2               # SiC: coordination counted separately for type 1 and type 2 neighbors
```
Coordination number(s) = neighbors (optionally of given types / in group2) within cutoff. One typeN -> per-atom vector; several
-> per-atom array (one column per typeN; typeN may be `*`, `*n`, `m*`, `m*n`). Compute group selects central atoms only.
Use for Si/SiC phase change: 4 = diamond, 5-6 = beta-tin/amorphous high-density. Cutoff must be < pair cutoff + skin.

### compute displace/atom  [core]
```
compute ID group-ID displace/atom [refresh v_name]
compute dsp work displace/atom
```
Per-atom array 4 columns: dx dy dz |d| (distance units) from the position when the compute was defined (unwrapped via image
flags). Keep the same ID across restarts for continuity. Pile-up / subsurface deformation map: dump `c_dsp[2]` (dy).

### compute msd  [core]
```
compute ID group-ID msd [com yes|no] [average yes|no]
compute msd1 chip msd com yes
```
Global 4-vector: <dx^2> <dy^2> <dz^2> <dr^2> averaged over group (distance^2, intensive). No dynamic groups.

### compute reduce / reduce/region  [core]
```
compute ID group-ID reduce mode input1 input2 ... [replace vec1 vec2] [inputs peratom|local]
compute ID group-ID reduce/region region-ID mode input1 ... [replace ...]
mode  = sum | min | max | ave | sumsq | avesq | sumabs | aveabs | minabs | maxabs
input = x|y|z|vx|vy|vz|fx|fy|fz | c_ID | c_ID[I] | f_ID | f_ID[I] | v_name      (per-atom, or local with "inputs local"; I may be wildcard)
compute Fsum   tool  reduce sum fx fy fz                 # total force on tool (3-vector: c_Fsum[1..3]); valid if tool forces are not overwritten by setforce
compute Ymax   work  reduce max y                        # pile-up height = highest workpiece atom (compare to initial surface)
compute Tmax   work  reduce max c_keat                   # hottest atom (KE); convert to K via variable
compute Nfcc   work  reduce sum v_isfcc                  # count atoms with cna == 1 (variable isfcc atom c_cna==1)
compute pmin   work  reduce min c_s_at[*]
compute Ytip   all   reduce/region tipbox max y
compute ymaxid work  reduce max id y replace 1 2         # id of the highest atom (replace: take id at index of max y)
```
Reduces per-atom vectors to global scalars (1 input -> global scalar; several -> global vector of that length). Only group
atoms (and region atoms for reduce/region) contribute; per-atom inputs from other computes are 0 outside THEIR group (affects min).
sum/sumsq/sumabs are extensive (normalized by thermo_modify norm yes); others intensive. `replace a b` only with min/max:
output a = value of input a at the index where input b is min/max. `inputs local` required for local-only computes
(bond/local, pair/local, voronoi neighbors). Units = units of the reduced quantity.
Thermo column naming: `c_Fsum[1]` etc.

### compute group/group  [core]
```
compute ID group-ID group/group group2-ID [pair yes|no] [kspace yes|no] [boundary yes|no] [molecule off|inter|intra]
compute Fcut tool group/group work
compute Ewt  tool group/group work pair yes kspace no
```
Interaction between the compute group and group2: global scalar = interaction ENERGY (energy units, extensive), global
3-vector = FORCE ON THE COMPUTE GROUP due to group2 (force units, extensive): `c_Fcut[1]` = Fx on tool (cutting direction),
`c_Fcut[2]` = Fy (thrust), `c_Fcut[3]` = Fz. Cutting force reported positive opposite to tool motion if tool moves in -x, etc.
Defaults pair yes, kspace no, boundary yes, molecule off. No bond/angle terms. Uses the neighbor list (pair cutoff).
RESTRICTIONS: three-body / many-body potentials (Tersoff, Stillinger-Weber, ...) CANNOT be used; EAM reuses stored embedding
terms (results valid only when evaluated on the step forces were computed, i.e. normal use in thermo output is fine;
not valid after moving atoms). For Tersoff/SW (Si, SiC, diamond tool) use `compute reduce sum fx fy fz` on the tool group
or `f_setforceID[1..3]` / `f_rigid[1][7..9]` instead. Cost ~ pair computation per evaluation; keep thermo frequency moderate.
Energy in metal units eV; force eV/Å (1 eV/Å = 1.602 nN).

### compute com  [core]
```
compute ID group-ID com
compute ctool tool com
```
Global 3-vector = unwrapped COM x,y,z (distance units, intensive). `c_ctool[1]` = current tool x-position (cutting length).

### compute property/atom  [core]
```
compute ID group-ID property/atom input1 input2 ...
input = id mol proc type mass x y z xs ys zs xu yu zu ix iy iz vx vy vz fx fy fz q radius diameter omegax ... i_name d_name i2_name[I] d2_name[I] ...
compute xu_at all property/atom xu yu zu
compute layer all property/atom i_layer
```
Per-atom vector (1 input) or array. Makes any atom attribute usable by fix ave/atom, fix ave/chunk, compute reduce,
atom-style variables (e.g. unwrapped coords for averaging, `mol` for persistent tags).

### compute voronoi/atom  [VORONOI, needs Voro++]
```
compute ID group-ID voronoi/atom [only_group] [occupation] [surface sgroup] [radius v_r] [edge_histo N] [edge_threshold l] [face_threshold a] [neighbors yes|no]
compute vor all voronoi/atom
variable sxxGPa atom c_s_at[1]/c_vor[1]*1.0e-4
```
Per-atom array: [1] Voronoi cell volume (distance^3), [2] number of faces (neighbors). Surface atoms: cells extend to the
communication cutoff -> volumes of surface/chip atoms are overestimated; use with care (or use a fixed atomic volume).
`occupation`: [1] = atoms currently in the initial cell (vacancies 0, interstitials 2), [2] = own-cell occupation.

### compute ackland/atom  [EXTRA-COMPUTE]
```
compute ID group-ID ackland/atom [legacy yes|no]
compute ack work ackland/atom
```
Per-atom vector: 0 unknown, 1 bcc, 2 fcc, 3 hcp, 4 ico. Angle-based; more temperature-tolerant than CSP. No cutoff argument.

### compute cluster/atom  [core]
```
compute ID group-ID cluster/atom cutoff
compute cl chip cluster/atom 3.5
```
Per-atom vector = cluster ID (smallest atom ID in the connected cluster within cutoff). Use to identify detached chip fragments
/ wear debris (count distinct IDs via post-processing or `compute reduce max`). Neighbor-list based; cutoff <= pair cutoff.

### compute count/type  [core]
```
compute ID group-ID count/type atom|bond|angle|dihedral|improper
compute nt all count/type atom
thermo_style custom step c_nt[1] c_nt[2]
```
Global vector (length = ntypes) of atom counts per type in the group (mode atom). Useful with dynamic groups (atoms lost, chip removed).

### compute pair  [core]
```
compute ID group-ID pair pstyle [nsub] [epair|evdwl|ecoul]
compute ep all pair eam/alloy
compute ep2 all pair tersoff 2 epair          # 2nd instance of tersoff in a pair_style hybrid
```
Global scalar = energy of that pair (sub)style (extensive); global vector if the style tallies extra values. Group ignored.
With `pair_style hybrid` (e.g. tersoff for Si + lj/cut for tool-work) gives the tool-work interaction energy of the lj sub-style.

### compute reduce with 'inputs' (summary)
`inputs peratom` (default) for atom attributes, per-atom computes/fixes/atom-style variables; `inputs local` for local data
(compute bond/local, pair/local, property/local, voronoi/atom neighbors yes). All inputs of one compute reduce must be the same kind.
Example from manual: `compute bmax all reduce max c_bdist inputs local`.

---------------------------------------------------------------------------------------------------

## 3. OUTPUT

### thermo  [core]
```
thermo N                       # N = 0 -> only first/last step; N may be v_name (equal-style returning next timestep)
thermo 100
```

### thermo_style  [core]
```
thermo_style one | multi | yaml | custom keyword1 keyword2 ...
keywords: step elapsed elaplong dt time cpu tpcpu spcpu cpuuse cpuremain part timeremain
          atoms temp press pe ke etotal evdwl ecoul epair ebond eangle edihed eimp emol elong etail
          enthalpy ecouple econserve vol density xlo xhi ylo yhi zlo zhi xy xz yz lx ly lz xlat ylat zlat
          cella cellb cellc cellalpha cellbeta cellgamma pxx pyy pzz pxy pxz pyz bonds angles dihedrals impropers
          fmax fnorm nbuild ndanger
          c_ID c_ID[I] c_ID[I][J] f_ID f_ID[I] f_ID[I][J] v_name v_name[I]        (I may be wildcard *, *n, n*, m*n)
thermo_style custom step time temp c_Ttool pe ke etotal press c_Fcut[1] c_Fcut[2] c_Fcut[3] c_Ymax v_Fx_nN cpuremain spcpu
```
- Only GLOBAL compute/fix values. `c_ID` scalar; `c_ID[I]` element of global vector; `c_ID[I][J]` element of global array
  (e.g. `f_rt[1][7]`). `v_name` must be equal-style (or vector-style with `[I]`; vector wildcards need an upper bound `*n`).
  Per-atom data only via an equal-style variable, e.g. `variable y5 equal c_dsp[5][2]` (atom ID 5).
- `one` = `custom step temp epair emol etotal press`. `vol` auto-appended to one/multi/yaml if the box changes.
- `time` = cumulative simulation time (ps) — correct with fix dt/reset; `cpuremain` = estimated CPU seconds left;
  `spcpu` = timesteps per CPU second; `tpcpu` = sim time per CPU second; `cpu` = elapsed CPU s this run.
- `temp`, `press`, `ke`, `etotal`, `enthalpy`, `pxx..` use `thermo_temp` / `thermo_press` unless `thermo_modify temp/press`.
- `ecouple` / `econserve` include energy exchanged by nvt/langevin(tally yes)/berendsen/rescale/csvr.
- Must come after the box is defined. ISSUING thermo_style RESETS all thermo_modify settings -> thermo_modify after it.
- Extensive values (pe, ke, compute reduce sum, group/group) are divided by natoms if `thermo_modify norm yes` (default no for metal/real, yes for lj).

### thermo_modify  [core]
```
thermo_modify keyword value ...
keyword = lost error|warn|ignore | lost/bond error|warn|ignore | warn ignore|reset|default|N | norm yes|no | flush yes|no
        | line one|multi|yaml | colname ID string | colname auto | colname default
        | format line "str" | format int "str" | format float "str" | format ID "str" | format none
        | temp compute-ID | press compute-ID | triclinic/general yes|no
thermo_modify temp Twork flush yes lost warn
thermo_modify format float %14.6g format 1 %8d
thermo_modify colname c_Fcut[1] Fx colname c_Fcut[2] Fy
thermo_modify press myP temp Twork             # press BEFORE temp if both
```
`lost warn|ignore` prevents an error when chip atoms fly out of a non-periodic box (default lost error). Default `norm no` for metal.
Defaults: line one, int %10d, float %14.8g (custom/one).

### dump  [core; gz/zstd need COMPRESS; image/movie: core, JPG/PNG/FFmpeg need build options]
```
dump ID group-ID style N file [attributes ...]
style = atom | atom/gz | atom/zstd | custom | custom/gz | custom/zstd | cfg | cfg/gz | xyz | xyz/gz | dcd | xtc | extxyz | yaml | local | image | movie | ...
custom/cfg/yaml attributes:
  id mol proc procp1 type typelabel element mass x y z xs ys zs xu yu zu xsu ysu zsu ix iy iz vx vy vz fx fy fz q
  mux muy muz mu radius diameter omegax omegay omegaz angmomx angmomy angmomz tqx tqy tqz
  c_ID c_ID[I] f_ID f_ID[I] v_name i_name d_name i2_name[I] d2_name[I]      (per-atom only; I may be wildcard)
dump d1 all atom 1000 dump.atom                                       # id type xs ys zs (scaled coords by default)
dump d2 all custom 1000 dump.*.lammpstrj id type x y z vx vy vz fx fy fz c_pe_at c_cna c_csp c_s_at[*]
dump d3 all custom 1000 dump.all.lammpstrj id type element xu yu zu c_ptm[1] v_vm
dump d4 all xyz 1000 traj.xyz
dump d5 all cfg 1000 dump.*.cfg mass type xs ys zs id c_cna                # cfg attributes MUST start with "mass type xs ys zs" (or xsu ysu zsu); needs * in filename
dump d6 all image 5000 img.*.jpg type type size 1024 768 view 90 0 zoom 1.5 box yes 0.01
dump d7 all movie 1000 cut.mp4 c_cna type size 1024 768 view 90 0
```
- N = dump every N steps (snapshots at multiples of N incl. step 0, not on the first step of a run unless it is a multiple or
  `dump_modify first yes`). Change with `dump_modify ID every N|v_name`.
- Filename `*` -> one file per snapshot, `*` replaced by timestep (`dump_modify pad N` zero-pads). `%` -> one file per
  processor (not for xyz/dcd/xtc/yaml). `.bin`/`.lammpsbin` suffix -> binary (atom, custom). `.gz` suffix with /gz styles.
  cfg and image REQUIRE `*`.
- x y z = unscaled (Å) and wrapped; xs ys zs = scaled 0-1; xu yu zu = unwrapped by image flags; ix iy iz = image flags.
  `element` requires `dump_modify ID element ...`. Per-atom lines are in indeterminate order unless `dump_modify sort id`;
  OVITO/VMD need `id` or sorting. Quantities from computes/fixes/variables are per-atom and written as floats.
- Dumps occur at the END of a timestep (after fixes). Values from fix ave/atom only on multiples of its Nfreq.
- image: `dump ID group image N file color diameter keywords`; color/diameter = `type` | `element` | per-atom attribute
  (c_ID, v_name, x, vx ...); keywords `size w h`, `view theta phi`, `zoom z`, `center s|d cx cy cz`, `up ux uy uz`,
  `box yes|no diam`, `axes ...`, `adiam d`, `shiny`, `ssao yes seed d`. Color map for attributes via `dump_modify ID amap`.
  movie: same args, writes via FFmpeg (`dump_modify ID framerate N bitrate kbit`).
- xyz: `type x y z` per line; `dump_modify element` replaces type by names (OVITO-friendly).

### dump_modify  [core]
```
dump_modify dump-ID keyword values ...
keyword = append yes|no | buffer yes|no | colname ID str | delay Dstep | element E1 E2 ... EN (one per atom type)
        | every N|v_name | every/time Delta|v_name | fileper Np | nfile Nf | first yes|no | flush yes|no
        | format line "str" | format int "str" | format float "str" | format M "str" | format none
        | header yes|no | image yes|no (atom style) | label str (local) | maxfiles Fmax | pad Nchar | pbc yes|no
        | precision N (xtc) | region rID|none | refresh c_ID | scale yes|no (atom style) | skip v_name
        | sort off|id|N|-N | thermo yes|no (yaml) | thresh attribute op value | thresh none | time yes|no | units yes|no | unwrap yes|no (dcd/xtc)
        | image/movie: acolor adiam amap backcolor bcolor bdiam boxcolor color bitrate framerate
dump_modify d2 sort id first yes flush yes format float %.5g
dump_modify d3 element Cu C                     # one name per atom type, in type order
dump_modify d2 thresh c_cna != 1                 # dump only non-fcc atoms (defects); also "thresh c_csp > 4.0"
dump_modify d2 thresh c_cna != 1 thresh y > 20.0 # multiple thresh = AND
dump_modify d2 region chipbox
dump_modify d2 every 500
dump_modify d2 every v_s first yes               # variable s equal logfreq(10,3,10) etc.
dump_modify d2 append yes
dump_modify d2 pbc yes                           # wrap atoms into box before writing
dump_modify d2 delay 10000                       # no snapshots before step 10000
dump_modify d6 amap -1.0 1.0 ca 0.0 2 min blue max red   # color map for attribute colouring in image/movie
```
- `thresh attr op val`: attr = any dump custom attribute (x, fy, c_ID[I], v_name ...; the attribute need not be in the dump
  list); op = < <= > >= == != |^; several thresh are ANDed; `thresh none` clears. Only custom/cfg/image/movie.
- `region` only custom/cfg/image/movie. `element` only cfg/xyz/image (and dump custom `element` attribute).
- `format`: `line` whole line (quotes), `int`/`float` all ints/floats, `M` = M-th column; atom/xyz styles only line/none.
  Compute/fix values are floats; use `%0.0f` style if they are integers (e.g. cna id).
- `every` not for dcd/xtc. With a variable, snapshots only on returned steps; `first yes` needed for an initial snapshot.
- `every/time Delta` dumps by simulation time (fix dt/reset). `sort id` on by default only for dcd/xtc/xyz/extxyz.
- `append yes` only for text files (not cfg/xtc/dcd). `maxfiles` only with `*` filenames.

### write_dump  [core]
```
write_dump group-ID style file dump-args [modify dump_modify-args]
write_dump all custom final.lammpstrj id type x y z c_cna modify sort id
write_dump all image final.jpg type type size 1024 768 modify backcolor white
```
One immediate snapshot (no ID, no frequency). Needs a run-ready system; compute values must have been evaluated on the current
step (do a `run 0` first if computes have not been invoked). No `*` needed for image.

### undump / uncompute / unfix  [core]
```
undump ID        # closes the file and stops that dump
uncompute ID     # also discards compute_modify settings
unfix ID         # also discards fix_modify settings
```

### log  [core]
```
log file [append]
log log.cutting
log none
```
Closes current log and opens a new one (default log.lammps or `-log` switch).

### restart  [core]
```
restart 0
restart N root                      # files root.N  (or root with "*" replaced by timestep, e.g. restart.*.bin)
restart N file1 file2 [nfile Nf | fileper Np]      # toggle between two files (no * expansion)
restart 50000 restart.*.bin
restart 10000 tmp.a.restart tmp.b.restart
```
N may be `v_name`. Written on multiples of N, NOT on the first step of a run; last step only if a multiple of N. Writing a
restart forces a neighbor rebuild on that step (can slightly change the trajectory; use `neigh_modify every M check no` with M
dividing N for identical trajectories). `%` in the name = per-processor files. Both forms may be active at once.

### write_restart  [core]
```
write_restart file [nfile Nf | fileper Np]
write_restart final.restart
write_restart restart.*.bin
```
Immediate single restart file (system must be run-ready). `*` -> timestep, `%` -> per-processor.

### Howto restart (what a restart file contains)
Stored: units, atom_style, box, atoms (coords, velocities, images, molecule IDs, custom fix property/atom vectors), groups,
pair_style and coefficients for most styles (exception: many-body potentials read from files, e.g. eam/alloy, tersoff, sw —
re-issue `pair_style` + `pair_coeff`), special_bonds, timestep number. NOT stored: fixes, computes, dumps, thermo settings,
`timestep` size, `neighbor`/`neigh_modify`, velocity command effects beyond stored v, variables, regions.
Restart script pattern:
```
read_restart   restart.100000.bin
pair_style     eam/alloy
pair_coeff     * * Cu01.eam.alloy Cu Cu
neighbor       2.0 bin
neigh_modify   every 5 delay 0 check yes
timestep       0.001
# groups are restored from the restart file; re-create regions if needed
fix frz boundary setforce 0.0 0.0 0.0
fix tstat thermo_layer nvt temp 300.0 300.0 0.1         # Nose-Hoover state restored only if same fix ID
fix nwt newton nve
fix tmv tool move linear -0.5 0.0 0.0 units box         # continues smoothly if same ID and timestep not reset
compute ... thermo_style ... dump ...
run 100000
```
Fixes that store state (nvt, npt, rigid/nvt, move, store/state, property/atom, temp/berendsen, temp/rescale, temp/csvr)
continue only if re-specified with the SAME ID (and compatible args); fix ave/time, ave/atom, ave/chunk, nve, langevin,
setforce store nothing. fix langevin/temp/csvr RNG streams are not exactly reproducible. Alternatively convert:
`lmp -r restart.bin data.restart` then `read_data` + `reset_timestep N`.

---------------------------------------------------------------------------------------------------

## 4. HOWTO summaries

### Howto thermostat
- Thermostat fixes: nvt (integrates), temp/berendsen, temp/csvr, temp/rescale, langevin (do NOT integrate -> add fix nve).
  Never apply two thermostats to the same atoms. nvt/npt create compute `fixID_temp`; thermo output uses `thermo_temp`,
  not the fix's compute — print the fix compute explicitly (`c_tstat_temp`) or use thermo_modify temp.
- Any thermostat accepts a bias-removing temperature compute via `fix_modify ID temp cID` (temp/com, temp/partial,
  temp/profile, temp/region, temp/chunk, temp/ramp, temp/deform ...): T is computed on thermal velocities, only the thermal
  component is scaled, the bias is added back. Thermostat only a region: `compute t1 all temp/region r1` + `fix_modify`.

### Howto barostat
- npt/nph integrate (do not add nve); press/berendsen does not (pair with nve or nvt). Barostats use compute pressure
  with a compute temp for the kinetic part; `fix_modify ID press cID temp cID` to override. Only periodic dimensions.

### Howto walls
- Rough walls = atoms, held by: not integrating them, `fix setforce 0 0 0`, `fix aveforce`, `fix freeze` (granular),
  `fix nve/noforce`, or prescribed motion `fix move` (most general). `neigh_modify exclude group wall wall` to skip
  intra-wall pair computations. Ideal walls: wall/reflect, wall/lj93, wall/lj126, wall/lj1043, wall/colloid, wall/harmonic,
  wall/morse, wall/table, wall/lepton, wall/region (region surface as wall, can be moving), wall/gran (frictional granular).
  Flat walls can move via a variable position (ramp(), vdisplace(), swiggle(), cwiggle()).

### Howto output (data flow)
- Styles: global / per-atom / local / per-grid; kinds: scalar / vector / array. `c_ID` whole, `c_ID[I]` one dim less, `c_ID[I][J]`.
- thermo_style custom <- global values (computes/fixes/equal- or vector-style variables); per-atom only through an equal-style variable
  indexing one atom (`c_ID[atomID][col]`).
- dump custom <- per-atom values; dump local <- local; dump grid <- per-grid.
- Fixes that write files: ave/time (global in), ave/chunk (per-atom in -> global out), ave/histo, ave/correlate, print.
- Processing: compute reduce (per-atom/local -> global), compute property/atom (atom attributes -> per-atom), compute slice,
  fix ave/atom (time-averaged per-atom), fix store/state (archive per-atom), fix vector (global scalars -> growing vector).
- Extensive vs intensive governs `thermo_modify norm`. Variables: equal -> global scalar, vector -> global vector, atom -> per-atom.

### Howto temperature (calculate temperature / remove streaming velocity)
- T = KE / DOF: distinguish advective (streaming) and thermal velocity. Computes: temp, temp/com, temp/partial, temp/profile,
  temp/region, temp/ramp, temp/deform (plus sphere/asphere for rotational DOF). All but temp/sphere/asphere compute a bias
  that thermostats and compute pressure / stress/atom (via temp-ID) can subtract.
- Cutting deck: tool -> temp/com; chip region -> temp/chunk with `com yes` on spatial bins or temp/profile; frozen atoms must be
  excluded from any temperature group (they add DOF with zero KE).

### Howto couple / library (brief)
- Coupling options: (1) new fix/compute calling the other code as a library (LAMMPS drives); (2) new command called between
  runs (`run N every M "cmd"`); (3) LAMMPS as a library (C API in src/library.h: `lammps_open`, `lammps_command`,
  `lammps_extract_compute/fix/variable`, `lammps_gather_atoms`, `lammps_scatter_atoms`), Python module `lammps`
  (`from lammps import lammps; L = lammps(); L.file("in.cut"); L.extract_compute("Fcut", LMP_STYLE_GLOBAL, LMP_TYPE_VECTOR)`),
  Fortran and SWIG wrappers; (4) MDI protocol (`fix mdi/qm`). Examples in examples/COUPLE and python/examples.

---------------------------------------------------------------------------------------------------

## 5. Package map (must be enabled at build time)

| Package | Commands used here |
|---|---|
| core (always) | fix nve nvt npt nph langevin temp/berendsen temp/rescale setforce aveforce addforce move momentum recenter ave/time ave/atom ave/chunk ave/histo balance property/atom store/state deform viscous enforce2d print halt dt/reset wall/reflect wall/harmonic wall/lj93; compute temp temp/com temp/partial temp/region temp/chunk temp/profile chunk/atom ke ke/atom pe pe/atom stress/atom centroid/stress/atom pressure centro/atom cna/atom coord/atom displace/atom msd reduce reduce/region group/group com property/atom cluster/atom count/type pair; thermo* dump atom/custom/xyz/cfg/image/movie dump_modify write_dump restart write_restart log |
| EXTRA-FIX | fix temp/csvr, temp/csld, momentum/chunk |
| EXTRA-COMPUTE | compute ackland/atom, cnp/atom |
| RIGID | fix rigid, rigid/nve, rigid/nvt, rigid/npt, rigid/nph, rigid/small and variants |
| VORONOI (+ Voro++ lib) | compute voronoi/atom |
| PTM | compute ptm/atom |
| MANYBODY | pair_style eam/alloy, eam/fs, tersoff, sw, airebo, meam (MEAM pkg), bop, comb |
| COMPRESS | dump */gz, */zstd |
| build options | dump image jpg/png (-DWITH_JPEG/-DWITH_PNG), dump movie (-DWITH_FFMPEG); dump image/movie commands themselves are core |
| KOKKOS/GPU/OPENMP/INTEL | accelerator variants (/kk /gpu /omp /intel) — same syntax, optional |

---------------------------------------------------------------------------------------------------

## 6. Error-avoidance checklist for generated decks

1. Every mobile atom in exactly ONE integrator (nve | nvt | npt | rigid/* | move). Frozen atoms in none (+ setforce 0 0 0, v = 0).
2. Non-integrating thermostats (langevin, temp/berendsen, temp/rescale, temp/csvr) + fix nve on the same group.
3. fix nvt needs `temp Tstart Tstop Tdamp`; Tdamp in ps (`$(100.0*dt)`); Tstop > 0.
4. `units box` on fix move, fix recenter, fix wall/*, fix dt/reset, compute chunk/atom, velocity set with numbers, fix deform
   (defaults are lattice units; lattice spacing may be undefined -> error "Use of fix move with undefined lattice").
5. thermo_style custom: only global values; `c_ID[I]` for vectors; `f_ID[I][J]` for arrays; define computes/fixes BEFORE
   thermo_style references them and after the box exists. thermo_modify AFTER thermo_style.
6. dump custom: only per-atom values; `c_ID[I]` for per-atom arrays (stress/atom 1-6, displace/atom 1-4, ptm 1-7, voronoi 1-2).
   `element` attribute or cfg/xyz element names require `dump_modify ID element ...` with exactly ntypes names.
7. fix ave/time: Nfreq % Nevery == 0, Nevery*Nrepeat <= Nfreq; thermo output of `f_ID` only on multiples of Nfreq.
   fix ave/atom / ave/chunk outputs likewise only on multiples of Nfreq (dump N must be a multiple).
8. compute group/group: not with Tersoff/SW/other many-body (error); for EAM fine in normal thermo use.
9. compute reduce sum fx over a group whose forces are overwritten by fix setforce gives zeros; use `f_setforceID[1..3]`.
10. compute pe / pressure require group `all`. compute temp/region: no fix-DOF subtraction; prefer with rescale/langevin.
11. Non-periodic directions: chip atoms may leave the box -> `thermo_modify lost ignore|warn` or `boundary p s p`/`m`; wall/reflect only on non-periodic dims.
12. cna/atom, centro/atom, coord/atom, ptm/atom, cluster/atom rebuild a neighbor list each evaluation: reference them only in dumps at modest frequency.
    cna cutoff must satisfy pair cutoff + skin > 2*cutoff.
13. Many-body potentials with fix move/rigid: forces on tool atoms are still computed; intra-tool contributions cancel in the sum.
14. restart files: re-specify pair_style/pair_coeff for file-based potentials, timestep, neighbor settings, all fixes/computes/dumps.
15. Variable names used in `$(...)` inside fix print must be in double quotes; `${name}` immediate substitution happens at read time.
16. IDs: `fix 1 ...` and `compute 1 ...` may share the numeral (different namespaces); but two fixes with the same ID redefine (allowed only if same style).
