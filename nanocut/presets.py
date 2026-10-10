"""Presets. The ref_* entries reproduce the parameters of C:/BTP/Cutting/<R>-<d> decks exactly
(lattice units of those decks: a = 4.3667 Å SiC, b = 3.571 Å diamond; depth = (100 - dy) a; gap = (dx - 220) a;
edge radius = lr b; cutting length = Nstep * 0.5 fs * 2 Å/ps).
"""
from .schema import Experiment, Workpiece, Tool, Process, Potential, Thermo, Output, Compute

A = 4.3667
B = 3.571


def _ref(name, lr, dy, dx, nstep_over_v, note):
    e = Experiment(name=name)
    e.tool.edge_radius_nm = lr * B / 10
    e.process.depth_nm = (100 - dy) * A / 10
    e.process.gap_nm = (dx - 220) * A / 10
    e.process.cut_length_nm = nstep_over_v / 2 * 0.0005 * 2.0 / 10   # Nstep = nstep_over_v / v, v = 2 Å/ps
    e.process.speed_ms = 200.0
    e.__dict__["note"] = note
    return e


PRESETS = {
    "ref_10_10 (Cutting/10-10)": _ref("cut_SiC_R10_d10", 10, 97, 220, 600000, "edge radius 10 b = 3.571 nm, depth 3 a = 1.31 nm, 30 nm cut"),
    "ref_10_20 (Cutting/10-20)": _ref("cut_SiC_R10_d20", 10, 95, 220, 600000, "A file of 10-20 is empty in the reference folder; parameters inferred from the 5-20/20-20 pattern"),
    "ref_10_30 (Cutting/10-30)": _ref("cut_SiC_R10_d30", 10, 93, 222, 400000, "gap 2 a, 20 nm cut"),
    "ref_5_10 (Cutting/5-10)": _ref("cut_SiC_R5_d10", 5, 97, 222, 400000, ""),
    "ref_5_20 (Cutting/5-20)": _ref("cut_SiC_R5_d20", 5, 95, 220, 600000, ""),
    "ref_5_30 (Cutting/5-30)": _ref("cut_SiC_R5_d30", 5, 93, 220, 600000, ""),
    "ref_20_10 (Cutting/20-10)": _ref("cut_SiC_R20_d10", 20, 97, 222, 400000, ""),
    "ref_20_20 (Cutting/20-20)": _ref("cut_SiC_R20_d20", 20, 95, 220, 600000, ""),
    "ref_20_30 (Cutting/20-30)": _ref("cut_SiC_R20_d30", 20, 93, 222, 600000, ""),
}


def _cu():
    e = Experiment(name="cut_Cu_rigid_R2_d2")
    e.workpiece = Workpiece(material="Cu", a0=3.615, length_nm=40.0, height_nm=20.0, width_nm=3.615, fixed_nm=1.0845, thermo_nm=1.0845)
    e.tool = Tool(shape="wedge", rake_deg=0.0, clearance_deg=10.0, edge_radius_nm=2.0, length_nm=10.0, height_nm=10.0, deformable=False)
    e.process = Process(depth_nm=2.0, gap_nm=1.0, speed_ms=100.0, cut_length_nm=20.0)
    e.potential = Potential(key="Cu_mishin1.eam.alloy", cross_style="morse")
    e.thermo = Thermo(equil_ps=20.0, equil_dt_fs=1.0, cut_dt_fs=1.0, tdamp_ps=0.1, minimize_before_equil=True, wp_temp_compute="temp")
    e.output = Output(dump_cna=True, dump_coord=False)
    e.compute = Compute(mpi_ranks=4)
    return e


def _si():
    e = Experiment(name="cut_Si_R2_d2")
    e.workpiece = Workpiece(material="Si", a0=5.431, length_nm=43.45, height_nm=21.72, width_nm=2.1724, fixed_nm=1.0862, thermo_nm=1.0862)
    e.tool = Tool(shape="wedge", rake_deg=0.0, clearance_deg=10.0, edge_radius_nm=2.0, length_nm=10.0, height_nm=10.0, deformable=True)
    e.process = Process(depth_nm=2.0, gap_nm=1.0, speed_ms=100.0, cut_length_nm=20.0)
    e.potential = Potential(key="SiC.tersoff")
    e.thermo = Thermo(equil_ps=20.0, minimize_before_equil=True)
    e.compute = Compute(mpi_ranks=4)
    return e


def _sphere():
    e = Experiment(name="scratch_SiC_R8_d1")
    e.workpiece = Workpiece(material="3C-SiC", a0=4.3667, length_nm=37.1, height_nm=21.8, width_nm=13.1, fixed_nm=2.18335, thermo_nm=2.18335)
    e.tool = Tool(shape="sphere", sphere_radius_nm=8.0, deformable=False)
    e.process = Process(depth_nm=1.0, gap_nm=1.0, speed_ms=100.0, cut_length_nm=20.0)
    e.potential = Potential(key="SiC_1994")
    e.thermo = Thermo(equil_ps=20.0, minimize_before_equil=True)
    e.compute = Compute(mpi_ranks=4)
    return e


PRESETS["Cu + rigid diamond (EAM + Morse)"] = _cu()
PRESETS["Si + deformable diamond (Tersoff)"] = _si()
PRESETS["3C-SiC spherical-grit scratching (rigid sphere)"] = _sphere()
