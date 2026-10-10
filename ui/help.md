# How to use NanoCut (no MD background needed)

**What you get.** Two LAMMPS input files. **A** builds the crystal workpiece and the diamond tool, assigns the three
layers (fixed / thermostat / Newtonian) and equilibrates everything at the chosen temperature, then writes a *restart*
file. **B** reads that restart, moves the tool at the cutting speed through the workpiece and records cutting force,
thrust force, temperatures and per-atom dumps for OVITO. A must finish before B starts.

**Steps.**
1. *Setup*: pick a preset (the `ref_*` presets are your reference decks from `C:\BTP\Cutting`) and change what you want.
   Every box has a `?` with the meaning and the reference value.
2. *Geometry preview*: check the picture, the exact atom count, the run length and the warnings.
3. *Decks A / B*: download `A_<name>.txt`, `B_<name>.txt`, the potential file (or the whole zip with run scripts).
4. Run on your cluster: `mpirun -np 10 lmp -in A.in -log A.log` then the same for B, in one folder.
5. *Results visualizer*: point it at the run folder to get force curves, friction coefficient, contact-zone temperature,
   chip/pile-up height and OVITO-style coloured atoms.

**Layers.** *Fixed* atoms never move (they anchor the block / carry the tool motion). *Thermostat* atoms are coupled to a
heat bath at the set temperature (the heat sink the surrounding bulk would provide). *Newtonian* atoms obey Newton's law
only, so the heating of the cutting zone is a result, not an input. Layer ids are stored in the `mol` column of every dump
(1 tool Newtonian, 2 tool thermostat, 3 tool fixed, 4 workpiece Newtonian, 5 workpiece thermostat, 6 workpiece fixed).

**Units.** LAMMPS `metal`: Å, ps, eV, K, g/mol, bar. 1 Å/ps = 100 m/s. 1 eV/Å = 1.602 nN (the force file is already in nN).

**Accuracy notes.**
- Atom counts are obtained by enumerating the lattice exactly as `create_atoms` does; *Validate* reruns the build in
  LAMMPS to prove it.
- Cutting force = sum of the per-atom forces on the tool (`compute reduce sum`), which is valid for Tersoff/EAM;
  `compute group/group` is not (manual restriction).
- Temperatures exclude the streaming velocity of the tool (`temp/com`) and, for the workpiece, the x-component
  (`temp/partial 0 1 1`, as in the reference decks) — switchable.
- Everything written to the decks is cross-referenced to the LAMMPS manual (release 30 Sep 2026) in `reference/`.
