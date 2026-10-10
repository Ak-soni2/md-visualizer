"""LAMMPS deck writers: A (build + equilibrate -> restart) and B (read_restart -> cut).

Structure and naming follow C:/BTP/Cutting/10-10/{A,B}.txt. Every command is documented in
reference/lammps_setup_commands.md and reference/lammps_fix_compute_output.md (manual 30Sep2026).
Deviations from the reference decks are deliberate and listed in PLAN.md section 0.2.
"""
import datetime
import json
import os
import shutil
from . import __version__
from .materials import MATERIALS, TOOL_MATERIALS, MASS, sublattices, cna_lattice
from .potentials import pair_block, POTENTIALS
from .geometry import Model, MOL
from .schema import validate, A_PER_NM

EV_PER_A_TO_NN = 1.602176634   # 1 eV/A = 1.602 nN
POT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "potentials")


def f6(v):
    return f"{v:.6f}"


def _orient(o):
    return f"orient x {o[0][0]} {o[0][1]} {o[0][2]} orient y {o[1][0]} {o[1][1]} {o[1][2]} orient z {o[2][0]} {o[2][1]} {o[2][2]}"


def _block(name, r):
    return f"region {name} block {f6(r[0])} {f6(r[1])} {f6(r[2])} {f6(r[3])} INF INF units box"


def _union(name, members):
    if len(members) == 1:
        return f"region {name} union 2 {members[0]} {members[0]}"
    return f"region {name} union {len(members)} {' '.join(members)}"


def _header(exp, m, which):
    w, t, p = exp.workpiece, exp.tool, exp.process
    c = m.counts()
    return [
        f"# ================================================================================",
        f"#  NanoCut v{__version__}  -  deck {which}  -  generated {datetime.date.today().isoformat()}",
        f"#  experiment : {exp.name}",
        f"#  workpiece  : {MATERIALS[w.material]['label']}, a0 = {w.a0} A, {m.n_cells[0]}x{m.n_cells[1]}x{m.n_cells[2]} cells"
        f" = {m.Lx/10:.2f} x {m.Ly/10:.2f} x {m.Lz/10:.3f} nm ({c['workpiece']} atoms)",
        f"#  tool       : {TOOL_MATERIALS[t.material]['label']}, {t.shape}, "
        + (f"rake {t.rake_deg} deg, clearance {t.clearance_deg} deg, edge radius {t.edge_radius_nm} nm, "
           f"{t.length_nm} x {t.height_nm} nm" if t.shape == "wedge" else f"radius {t.sphere_radius_nm} nm")
        + f", {'deformable' if t.deformable else 'rigid'} ({c['tool']} atoms)",
        f"#  process    : depth {p.depth_nm} nm, gap {p.gap_nm} nm, speed {p.speed_ms} m/s = {exp.speed_aps:.4f} A/ps,"
        f" cut length {p.cut_length_nm} nm -> {exp.cut_steps} steps of {exp.thermo.cut_dt_fs} fs",
        f"#  potential  : {POTENTIALS[exp.potential.key]['label']}  [{POTENTIALS[exp.potential.key]['citation']}]",
        f"#  laser      : {_laser_desc(exp)}",
        f"#  units metal: A, ps, eV, K, g/mol, bar; velocity A/ps; force eV/A (x1.602 = nN)",
        f"#  layers via mol tag: 1 tool mobile, 2 tool thermostat, 3 tool fixed, 4 wp mobile, 5 wp thermostat, 6 wp fixed",
        f"# ================================================================================",
        "",
    ]


def _laser_desc(exp):
    l = exp.laser
    if l.mode == "preheat":
        return f"uniform preheating of the workpiece to {l.preheat_K} K (tool stays at {exp.thermo.temperature_K} K)"
    if l.mode == "spot":
        return f"moving hot spot {l.spot_radius_nm} nm radius, {l.lead_nm} nm ahead of the tool, Langevin at {l.spot_K} K"
    if l.mode == "power":
        return f"moving heated zone {l.spot_radius_nm} nm radius, {l.lead_nm} nm ahead of the tool, {l.spot_power_eV_ps} eV/ps (fix heat)"
    return "none"


def _common_setup(exp):
    w = exp.workpiece
    desc = {"s": "free (shrink-wrapped)", "f": "fixed box face", "p": "periodic"}
    return ["units           metal", "dimension       3",
            f"boundary        {w.boundary_x} {w.boundary_y} {w.boundary_z}    # x {desc[w.boundary_x]}; y {desc[w.boundary_y]}; z {desc[w.boundary_z]}"
            + (" = infinitely wide workpiece" if w.boundary_z == "p" else ""),
            "atom_style      atomic", ""]


def _masses(m):
    return [f"mass            {i} {MASS[e]}    # {e}" for i, e in enumerate(m.types, 1)] + [""]


def _potential(exp, m):
    pot = exp.potential
    cross = dict(style=pot.cross_style, D=pot.morse_D, alpha=pot.morse_alpha, r0=pot.morse_r0, rc=pot.morse_rc,
                 eps=pot.lj_eps, sigma=pot.lj_sigma)
    lines, files, warns = pair_block(m.tool_elem, m.wp_elems, pot.key, exp.tool.deformable, cross)
    return ["# ---------------- force field ----------------"] + lines + [""], files, warns


def _groups_from_mol(exp, m):
    """Group definitions in deck B from the mol tag (groups are also restored by read_restart; this is explicit)."""
    L = ["# ---------------- groups (from mol tags written in deck A) ----------------",
         "group           gpCTall type 1",
         f"group           gpCTbd molecule {MOL['ct_bd']}"]
    if exp.tool.deformable:
        L += [f"group           gpCTtsbd molecule {MOL['ct_ts']}", f"group           gpCTmob molecule {MOL['ct_mob']}"]
    wtypes = " ".join(str(i) for i in range(2, len(m.types) + 1))
    L += [f"group           gpWPall type {wtypes}", f"group           gpWPbd molecule {MOL['wp_bd']}",
          f"group           gpWPtsbd molecule {MOL['wp_ts']}", f"group           gpWPmob molecule {MOL['wp_mob']}"]
    L += ["group           mobile union gpWPmob gpCTmob" if exp.tool.deformable else "group           mobile union gpWPmob gpWPmob", ""]
    return L


def _thermostat(fid, group, style, T, tdamp, seed, temp_compute=None):
    """Return fix lines for a thermostat on `group` (nvt | langevin | berendsen)."""
    if style == "nvt":
        L = [f"fix             {fid} {group} nvt temp {T} {T} {tdamp}"]
        if temp_compute:
            L.append(f"fix_modify      {fid} temp {temp_compute}")
    elif style == "langevin":
        L = [f"fix             {fid} {group} langevin {T} {T} {tdamp} {seed}", f"fix             {fid}i {group} nve"]
        if temp_compute:
            L.append(f"fix_modify      {fid} temp {temp_compute}")
    elif style == "berendsen":
        L = [f"fix             {fid} {group} temp/berendsen {T} {T} {tdamp}", f"fix             {fid}i {group} nve"]
        if temp_compute:
            L.append(f"fix_modify      {fid} temp {temp_compute}")
    else:
        raise ValueError(f"unknown thermostat {style}")
    return L


def deck_a(exp, model=None, dry_run=False):
    """Deck A: build tool + workpiece, assign layers, equilibrate, write restart."""
    m = model or Model(exp)
    w, t, p, th, o = exp.workpiece, exp.tool, exp.process, exp.thermo, exp.output
    tm, mat = TOOL_MATERIALS[t.material], MATERIALS[w.material]
    L = _header(exp, m, "A (build + equilibrate)") + _common_setup(exp)
    b = m.box
    L += ["# ---------------- simulation box (shrink-wrapped faces follow the atoms; periodic faces are exact lattice periods) ----------------",
          f"region          whole block {f6(b[0])} {f6(b[1])} {f6(b[2])} {f6(b[3])} {f6(b[4])} {f6(b[5])} units box",
          f"create_box      {len(m.types)} whole", ""]
    # ---- tool ----
    L += [f"# ---------------- tool: {tm['label']} (type 1) ----------------",
          f"lattice         {tm['structure']} {t.a0} {_orient((t.orient_x, t.orient_y, t.orient_z))} "
          f"origin {t.origin_shift[0]} {t.origin_shift[1]} {t.origin_shift[2]}"]
    L += m.tool.regions()
    L += ["create_atoms    1 region cut_tool", "group           gpCTall region cut_tool"]
    if t.deformable:
        regs = m.ct_layer_regions()
        for n, r in regs.items():
            L.append(_block(n, r))
        bd = [n for n in regs if not n.startswith("ctTS")]
        ts = [n for n in regs if n.startswith("ctTS")]
        L += [_union("ctbound", bd), _union("ctTSbound", ts),
              "group           gpCTbd region ctbound",
              "group           gpCTts0 region ctTSbound",
              "group           gpCTtsbd subtract gpCTts0 gpCTbd    # disjoint from the fixed layer",
              "group           gpCTts0 delete",
              "group           gpCTmob subtract gpCTall gpCTbd gpCTtsbd"]
    else:
        L += ["group           gpCTbd region cut_tool    # rigid tool: all tool atoms follow the prescribed motion"]
    L += ['print           "tool created"', ""]
    # ---- workpiece ----
    L += [f"# ---------------- workpiece: {mat['label']} (types {', '.join(f'{i+2}={e}' for i, e in enumerate(m.wp_elems))}) ----------------",
          f"region          workpiece block 0.0 {f6(m.Lx)} 0.0 {f6(m.Ly)} INF INF units box"]
    for style, origin, ei in sublattices(mat["structure"]):
        L += [f"lattice         {style} {w.a0} {_orient((w.orient_x, w.orient_y, w.orient_z))} origin {origin[0]} {origin[1]} {origin[2]}",
              f"create_atoms    {2 + ei} region workpiece"]
    regs = m.wp_layer_regions()
    for n, r in regs.items():
        L.append(_block(n, r))
    bd = [n for n in regs if not n.startswith("wpTS")]
    ts = [n for n in regs if n.startswith("wpTS")]
    L += [_union("wpbound", bd), _union("wpTSbound", ts),
          "group           gpWPall region workpiece",
          "group           gpWPbd region wpbound",
          "group           gpWPts0 region wpTSbound",
          "group           gpWPtsbd subtract gpWPts0 gpWPbd    # disjoint from the fixed layer",
          "group           gpWPts0 delete",
          "group           gpWPmob subtract gpWPall gpWPbd gpWPtsbd",
          'print           "workpiece created"', ""]
    L += _masses(m)
    pot_lines, files, warns = _potential(exp, m)
    L += pot_lines
    # ---- layer tags ----
    L += ["# ---------------- layer tags (survive the restart) ----------------", "fix             13 all property/atom mol"]
    if t.deformable:
        L += [f"set             group gpCTmob mol {MOL['ct_mob']}", f"set             group gpCTtsbd mol {MOL['ct_ts']}"]
    L += [f"set             group gpCTbd mol {MOL['ct_bd']}", f"set             group gpWPmob mol {MOL['wp_mob']}",
          f"set             group gpWPtsbd mol {MOL['wp_ts']}", f"set             group gpWPbd mol {MOL['wp_bd']}", ""]
    # ---- equilibration ----
    T, seed = th.temperature_K, th.seed
    L += ["# ---------------- equilibration ----------------",
          "group           gpWPeq union gpWPmob gpWPtsbd"]
    if t.deformable:
        L += ["group           gpCTeq union gpCTmob gpCTtsbd", "group           mobile_eq union gpWPeq gpCTeq"]
    else:
        L += ["group           mobile_eq union gpWPeq gpWPeq"]
    if th.minimize_before_equil and not dry_run:
        L += ["min_style       cg", "minimize        1.0e-4 1.0e-6 100 1000    # relax lattice/surfaces before giving velocities"]
    Twp_target = float(exp.laser.preheat_K) if exp.laser.mode == "preheat" else float(T)
    if exp.laser.mode == "preheat":
        L += [f"velocity        gpWPeq create {Twp_target} {seed} dist {th.velocity_dist} mom yes rot yes    # laser preheating: workpiece at {Twp_target} K"]
        if t.deformable:
            L += [f"velocity        gpCTeq create {T} {seed + 7} dist {th.velocity_dist} mom yes rot yes"]
    else:
        L += [f"velocity        mobile_eq create {T} {seed} dist {th.velocity_dist} mom yes rot yes"]
    L += ["compute         Twp gpWPmob temp"]
    if t.deformable:
        L += ["compute         Tct gpCTmob temp"]
    L += ["fix             holdWP gpWPbd move linear 0.0 0.0 0.0 units box    # fixed boundary layer",
          "fix             holdCT gpCTbd move linear 0.0 0.0 0.0 units box"]
    L += _thermostat("eqWP", "gpWPeq", th.equil_thermostat, Twp_target, th.tdamp_ps, seed)
    if t.deformable:
        L += _thermostat("eqCT", "gpCTeq", th.equil_thermostat, T, th.tdamp_ps, seed + 1)
    L += ["reset_timestep  0", f"timestep        {th.equil_dt_fs * 1e-3}    # ps ({th.equil_dt_fs} fs)",
          "fix             bal all balance 100 0.9 shift xy 10 1.05", ""]
    tcols = "step time temp c_Twp" + (" c_Tct" if t.deformable else "") + " pe ke press cpuremain"
    L += [f"thermo_style    custom {tcols}", f"thermo          {o.thermo_every}", "thermo_modify   flush yes", ""]
    if dry_run:
        L += ["run             0", 'print           "A dry run done"', ""]
        return "\n".join(L), files, warns
    elem = " ".join(m.types)
    L += [f"dump            eq all custom {o.dump_every_equil} {exp.name}_equil.*.lammpstrj id type mol x y z vx vy vz",
          f"dump_modify     eq element {elem}",
          f"restart         {o.restart_every_equil} {exp.name}_equil.*.restart",
          f"run             {exp.equil_steps}    # {th.equil_ps} ps",
          f"write_restart   {exp.name}_A.restart", 'print           "A done"', ""]
    return "\n".join(L), files, warns


def deck_b(exp, model=None, run_steps=None):
    """Deck B: read restart, re-specify force field/fixes, cut at constant speed, record forces & temperatures."""
    m = model or Model(exp)
    w, t, p, th, o = exp.workpiece, exp.tool, exp.process, exp.thermo, exp.output
    mat = MATERIALS[w.material]
    v = exp.speed_aps
    T, seed = th.temperature_K, th.seed
    steps = exp.cut_steps if run_steps is None else run_steps
    L = _header(exp, m, "B (cut)") + _common_setup(exp)
    L += ["# ---------------- restart (restores box, atoms, groups, masses; NOT pair_coeff/fixes/computes) ----------------",
          f"read_restart    {exp.name}_A.restart", "reset_timestep  0",
          "fix             13 all property/atom mol    # same ID as in deck A re-enables the stored tags", ""]
    L += _groups_from_mol(exp, m)
    L += _masses(m)
    pot_lines, files, warns = _potential(exp, m)
    L += pot_lines
    if th.minimize_before_cut:
        L += ["min_style       cg", "minimize        1.0e-4 1.0e-6 100 1000", ""]
    # ---- temperatures ----
    wtc = th.wp_temp_compute if th.wp_temp_compute != "temp/partial" else "temp/partial 0 1 1"
    L += ["# ---------------- temperature computes ----------------",
          f"compute         Twp gpWPmob {wtc}    # workpiece Newtonian zone",
          f"compute         TwpTS gpWPtsbd {wtc}"]
    if t.deformable:
        L += ["compute         Tct gpCTmob temp/com    # tool, streaming velocity removed",
              "compute         TctTS gpCTtsbd temp/com"]
    L += ["", "# ---------------- integration ----------------", f"timestep        {th.cut_dt_fs * 1e-3}    # ps ({th.cut_dt_fs} fs)"]
    Twp_target = float(exp.laser.preheat_K) if exp.laser.mode == "preheat" else float(T)
    L += _thermostat("thWP", "gpWPtsbd", th.cut_thermostat, Twp_target, th.tdamp_ps, seed + 2, "TwpTS")
    if t.deformable:
        L += _thermostat("thCT", "gpCTtsbd", th.cut_thermostat, T, th.tdamp_ps, seed + 3, "TctTS")
    L += ["fix             holdWP gpWPbd move linear 0.0 0.0 0.0 units box",
          f"fix             cut gpCTbd move linear {-v:.6f} 0.0 0.0 units box    # cutting speed {p.speed_ms} m/s along -x",
          "fix             intg mobile nve",
          "fix             bal all balance 30 1.05 shift xy 10 1.05", ""]
    # ---- forces, contact-zone temperature ----
    cx, cy = m.contact_point          # foremost tool point at mid-depth at t = 0 (chip-root / interaction zone)
    rc = o.contact_zone_radius_nm * A_PER_NM
    ne = 10
    nr = max(1, o.forces_every // ne)
    L += ["# ---------------- cutting forces (sum of per-atom forces on the tool; group/group is invalid for many-body styles) ----------------",
          "compute         fsum gpCTall reduce sum fx fy fz",
          f"variable        Fc equal c_fsum[1]*{EV_PER_A_TO_NN}    # nN, +x = resistance to cutting (tool moves -x)",
          f"variable        Ft equal c_fsum[2]*{EV_PER_A_TO_NN}    # nN, thrust (+y pushes the tool up)",
          f"variable        Fz equal c_fsum[3]*{EV_PER_A_TO_NN}    # nN, lateral",
          f"variable        xdisp equal -{v:.6f}*time    # tool displacement (A) since the start of this run",
          f"region          czone cylinder z {f6(cx)} {f6(cy)} {f6(rc)} INF INF units box move v_xdisp NULL NULL",
          "compute         Tcz gpWPmob temp/region czone    # workpiece atoms within the contact zone (follows the edge)",
          ""]

    # ---- laser-assisted machining: moving heated zone ahead of the tool ----
    las = exp.laser
    extra_t = ""
    if las.mode in ("spot", "power"):
        lx0, ly0 = m.laser_center
        L += ["# ---------------- laser heat source: cylinder moving with the tool (dynamic group of workpiece Newtonian atoms) ----------------",
              f"region          laser cylinder z {f6(lx0)} {f6(ly0)} {f6(m.laser_radius)} INF INF units box move v_xdisp NULL NULL",
              "group           laserzone dynamic gpWPmob region laser every 10",
              "compute         Tlaser laserzone temp",
              "compute_modify  Tlaser dynamic/dof yes"]
        if las.mode == "spot":
            L += [f"fix             laser laserzone langevin {las.spot_K} {las.spot_K} {las.spot_damp_ps} {seed + 11}    # holds the spot at {las.spot_K} K (atoms are integrated by fix intg)",
                  "fix_modify      laser temp Tlaser"]
        else:
            L += [f"fix             laser gpWPmob heat 10 {las.spot_power_eV_ps} region laser    # constant energy input (eV/ps) into the atoms inside the moving zone"]
        L += ["variable        inlaser atom rmask(laser)    # 1 = atom is inside the moving laser zone (written to the dump, selectable in OVITO)", ""]
        extra_t = " c_Tlaser"
    L += [f"fix             fout all ave/time {ne} {nr} {o.forces_every} v_Fc v_Ft v_Fz c_Twp c_Tcz c_TwpTS"
          + (" c_Tct c_TctTS" if t.deformable else "")
          + (" c_Tlaser" if exp.laser.mode in ("spot", "power") else "")
          + f" file {exp.name}_forces_temps.txt title2 \"# step Fc_nN Ft_nN Fz_nN Twp_K Tcz_K TwpTS_K"
          + (" Tct_K TctTS_K" if t.deformable else "")
          + (" Tlaser_K" if exp.laser.mode in ("spot", "power") else "") + "\"", ""]
    # ---- per-atom quantities ----
    cols = ["id", "type", "mol", "x", "y", "z"]
    L += ["# ---------------- per-atom quantities for OVITO / post-processing ----------------"]
    if o.dump_velocities:
        cols += ["vx", "vy", "vz"]
    if o.dump_forces:
        cols += ["fx", "fy", "fz"]
    if o.dump_ke:
        L += ["compute         ke all ke/atom",
              f"fix             keav all ave/atom {ne} {o.dump_every_cut // ne} {o.dump_every_cut} c_ke    # time-averaged KE -> local temperature"]
        cols += ["c_ke", "f_keav"]
    if o.dump_pe:
        L += ["compute         pe all pe/atom"]
        cols += ["c_pe"]
    if o.dump_stress:
        L += ["compute         s all stress/atom NULL    # bar*A^3; divide by atomic volume and 1e4 -> GPa"]
        cols += [f"c_s[{i}]" for i in range(1, 7)]
    if o.dump_coord:
        L += [f"compute         cn all coord/atom cutoff {mat['coord_cutoff']}    # coordination number"]
        cols += ["c_cn"]
    if exp.laser.mode in ("spot", "power"):
        cols += ["v_inlaser"]
    if o.dump_cna and cna_lattice(mat["structure"]):
        rc_cna = (0.854 if mat["structure"] == "fcc" else 1.207) * w.a0
        L += [f"compute         cna all cna/atom {rc_cna:.4f}"]
        cols += ["c_cna"]
    tcols = "step time temp c_Twp" + (" c_Tct" if t.deformable else "") + " c_Tcz pe ke v_Fc v_Ft cpuremain"
    L += ["", f"thermo_style    custom {tcols}", f"thermo          {o.thermo_every}", "thermo_modify   flush yes",
          f"dump            cut all custom {o.dump_every_cut} {exp.name}_cut.*.lammpstrj {' '.join(cols)}",
          f"dump_modify     cut element {' '.join(m.types)}",
          f"restart         {o.restart_every_cut} {exp.name}_cut.*.restart", "",
          f"run             {steps}    # {p.cut_length_nm} nm at {p.speed_ms} m/s",
          f"write_restart   {exp.name}_B.restart", 'print           "B done"', ""]
    return "\n".join(L), files, warns


RUN_SH = """#!/bin/bash
# NanoCut run script - usage: ./run.sh [MPI ranks]
set -e
NP=${1:-%(np)d}
LMP=${LMP:-%(lmp)s}
export OMP_NUM_THREADS=%(omp)d
mpirun -np $NP $LMP -in A.in -log A.log
mpirun -np $NP $LMP -in B.in -log B.log
"""

RUN_BAT = """@echo off
rem NanoCut run script (Windows, MS-MPI + lmp.exe on PATH)
set NP=%(np)d
mpiexec -np %%NP%% lmp.exe -in A.in -log A.log
mpiexec -np %%NP%% lmp.exe -in B.in -log B.log
"""


def write_run_folder(exp, outdir):
    """Write A.in, B.in, potentials, run scripts, params.json, README.md into outdir. Returns dict of paths/warnings."""
    errs = validate(exp)
    if errs:
        raise ValueError("; ".join(errs))
    m = Model(exp)
    a, files_a, wa = deck_a(exp, m)
    b, files_b, wb = deck_b(exp, m)
    os.makedirs(outdir, exist_ok=True)
    open(os.path.join(outdir, "A.in"), "w", newline="\n").write(a)
    open(os.path.join(outdir, "B.in"), "w", newline="\n").write(b)
    for f in set(files_a + files_b):
        shutil.copy(os.path.join(POT_DIR, f), outdir)
    c = exp.compute
    open(os.path.join(outdir, "run.sh"), "w", newline="\n").write(RUN_SH % dict(np=c.mpi_ranks, lmp=c.lammps_cmd, omp=c.omp_threads))
    open(os.path.join(outdir, "run.bat"), "w").write(RUN_BAT % dict(np=c.mpi_ranks))
    meta = dict(nanocut_version=__version__, experiment=exp.to_dict(), model=model_summary(m),
                potential=POTENTIALS[exp.potential.key])
    meta["potential"] = {k: (sorted(v) if isinstance(v, set) else v) for k, v in meta["potential"].items()}
    open(os.path.join(outdir, "params.json"), "w").write(json.dumps(meta, indent=2))
    open(os.path.join(outdir, "README.md"), "w").write(readme(exp, m, wa + wb))
    return dict(dir=outdir, warnings=sorted(set(wa + wb)), counts=m.counts())


def model_summary(m):
    c = m.counts()
    return dict(Lx_A=m.Lx, Ly_A=m.Ly, Lz_A=m.Lz, cells=[int(x) for x in m.n_cells], y_surface_A=m.y_surface,
                x_end_A=m.x_end, edge_center_A=list(m.edge_center), contact_point_A=list(m.contact_point),
                tool_xmin_A=m.tool_xmin, tool_xmax_A=m.tool_xmax,
                tool_top_A=m.tool_top, box_A=list(m.box), counts=c, types=m.types,
                speed_A_per_ps=m.exp.speed_aps, cut_steps=m.exp.cut_steps, equil_steps=m.exp.equil_steps,
                periodic_mismatch_A=m.periodic_mismatch())


def readme(exp, m, warnings):
    p = POTENTIALS[exp.potential.key]
    c = m.counts()
    lines = [f"# {exp.name} - NanoCut run folder", "",
             "Generated by NanoCut v" + __version__ + ". Run `./run.sh [ranks]` (Linux/cluster) or `run.bat` (Windows).",
             "A.in builds and equilibrates the model and writes `" + exp.name + "_A.restart`; B.in reads it and cuts.", "",
             "## Model", f"- Workpiece {MATERIALS[exp.workpiece.material]['label']}: {m.Lx/10:.2f} x {m.Ly/10:.2f} x {m.Lz/10:.3f} nm, "
             f"{c['workpiece']} atoms (fixed {c['wp_bd']}, thermostat {c['wp_ts']}, Newtonian {c['wp_mob']})",
             f"- Tool: {c['tool']} atoms ({'deformable' if exp.tool.deformable else 'rigid'}); depth of cut {exp.process.depth_nm} nm; "
             f"speed {exp.process.speed_ms} m/s; cutting length {exp.process.cut_length_nm} nm ({exp.cut_steps} steps)",
             f"- Potential: {p['label']} - cite: {p['citation']}", "",
             "## Outputs of B", f"- `{exp.name}_forces_temps.txt`: step, cutting force Fc, thrust Ft, lateral Fz (nN, time-averaged), "
             "temperatures (K) of the workpiece Newtonian zone, contact zone, thermostat layers (and tool).",
             f"- `{exp.name}_cut.*.lammpstrj`: per-atom dumps for OVITO (columns listed in the dump line of B.in).",
             "- Local temperature from the dump: T_i = 2*f_keav/(3*k_B), k_B = 8.617e-5 eV/K.",
             "- Stress in GPa: c_s[i] / (atomic volume in A^3) / 1e4; von Mises from the six components.", ""]
    if warnings:
        lines += ["## Warnings"] + [f"- {w}" for w in warnings] + [""]
    return "\n".join(lines)
