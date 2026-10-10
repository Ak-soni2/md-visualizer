"""Experiment definition (all user-facing lengths in nm, speed in m/s, time in ps/fs).

Defaults reproduce the reference deck C:/BTP/Cutting/10-10 (see presets.py for the others).
"""
from dataclasses import dataclass, field, asdict, fields, is_dataclass
import json
from .materials import MATERIALS, TOOL_MATERIALS

A_PER_NM = 10.0
MS_TO_APS = 0.01            # 1 m/s = 0.01 Å/ps


@dataclass
class Workpiece:
    material: str = "3C-SiC"
    a0: float = 4.3667                          # Å (editable; default from MATERIALS)
    orient_x: tuple = (1, 0, 0)
    orient_y: tuple = (0, 1, 0)
    orient_z: tuple = (0, 0, 1)
    length_nm: float = 96.0674                  # x, cutting direction (220 a0)
    height_nm: float = 43.667                   # y, depth direction (100 a0)
    width_nm: float = 3.93003                   # z, periodic width (9 a0)
    fixed_nm: float = 2.18335                   # boundary (rigid) layer thickness (5 a0)
    thermo_nm: float = 2.18335                  # thermostat layer thickness (5 a0)
    anchor_far_end: bool = False                # also fix/thermostat the +x end (tool entry side)
    boundary_x: str = "s"                       # s = free (shrink-wrapped), f = fixed box face, p = periodic (infinite length)
    boundary_y: str = "s"                       # s = free surface above/below, f = fixed
    boundary_z: str = "p"                       # p = periodic = infinitely wide workpiece (reference), s = finite slab


@dataclass
class Tool:
    material: str = "diamond"
    a0: float = 3.571
    orient_x: tuple = (1, 0, 0)
    orient_y: tuple = (0, 1, 0)
    orient_z: tuple = (0, 0, 1)
    origin_shift: tuple = (0.0, 0.0, 0.4)       # fractional lattice origin (reference: origin 0 0 0.4)
    shape: str = "wedge"                        # wedge | sphere
    rake_deg: float = 0.0
    clearance_deg: float = 10.0
    edge_radius_nm: float = 3.571               # 10 diamond lattice units
    length_nm: float = 24.997                   # 70 b (x extent of the tool block)
    height_nm: float = 24.997                   # 70 b (y extent)
    sphere_radius_nm: float = 8.0
    deformable: bool = True
    fixed_nm: float = 1.0713                    # 3 b
    thermo_nm: float = 1.0713                   # 3 b


@dataclass
class Process:
    depth_nm: float = 1.310                     # 3 a0
    gap_nm: float = 0.0                         # tool-to-workpiece gap at start
    speed_ms: float = 200.0
    cut_length_nm: float = 30.0


@dataclass
class Potential:
    key: str = "SiC_1994"
    cross_style: str = "auto"                   # auto | morse | zbl | lj
    morse_D: float = None
    morse_alpha: float = None
    morse_r0: float = None
    morse_rc: float = 6.5
    lj_eps: float = None
    lj_sigma: float = None


@dataclass
class Laser:
    """Laser / thermal assistance (laser-assisted machining, LAM).

    mode = none      : no heat source
           preheat   : whole workpiece equilibrated and thermostatted at preheat_K while the tool stays at the
                       base temperature (the approach of most MD LAM papers, e.g. Chu et al. 2025, Liu et al. 2024)
           spot      : a cylindrical zone of radius spot_radius_nm centred on the surface, lead_nm ahead of the
                       tool, moving with it, held at spot_K by a Langevin thermostat (local moving hot spot)
           power     : same moving zone, but a constant heat input spot_power_eV_ps (fix heat) instead of a set temperature
    """
    mode: str = "none"
    preheat_K: float = 900.0
    spot_K: float = 1200.0
    spot_radius_nm: float = 5.0
    lead_nm: float = 5.0                        # distance from the tool front to the spot centre (ahead of the tool)
    spot_damp_ps: float = 0.1
    spot_power_eV_ps: float = 50.0
    spot_depth_nm: float = 0.0                  # 0 = spot centre on the surface (half of the cylinder is in the material)


@dataclass
class Thermo:
    temperature_K: float = 300.0
    seed: int = 102456
    velocity_dist: str = "uniform"              # uniform | gaussian
    minimize_before_equil: bool = False
    equil_ps: float = 5.0
    equil_dt_fs: float = 0.5
    tdamp_ps: float = 0.05
    equil_thermostat: str = "nvt"               # nvt | langevin | berendsen
    cut_dt_fs: float = 0.5
    minimize_before_cut: bool = True
    cut_thermostat: str = "nvt"
    wp_temp_compute: str = "temp/partial"       # temp/partial (reference) | temp


@dataclass
class Output:
    thermo_every: int = 100
    dump_every_equil: int = 1000
    dump_every_cut: int = 500
    restart_every_equil: int = 1000
    restart_every_cut: int = 10000
    forces_every: int = 100
    dump_velocities: bool = True
    dump_forces: bool = True
    dump_ke: bool = True
    dump_pe: bool = True
    dump_stress: bool = True
    dump_coord: bool = True
    dump_cna: bool = False
    contact_zone_radius_nm: float = 2.0


@dataclass
class Compute:
    mpi_ranks: int = 10
    omp_threads: int = 1
    lammps_cmd: str = "lmp"


@dataclass
class Experiment:
    name: str = "cut_SiC_R10_d10"
    workpiece: Workpiece = field(default_factory=Workpiece)
    tool: Tool = field(default_factory=Tool)
    process: Process = field(default_factory=Process)
    potential: Potential = field(default_factory=Potential)
    thermo: Thermo = field(default_factory=Thermo)
    laser: Laser = field(default_factory=Laser)
    output: Output = field(default_factory=Output)
    compute: Compute = field(default_factory=Compute)

    # ---- convenience ----
    @property
    def speed_aps(self):
        return self.process.speed_ms * MS_TO_APS

    @property
    def cut_steps(self):
        import math
        return int(math.ceil(self.process.cut_length_nm * A_PER_NM / (self.speed_aps * self.thermo.cut_dt_fs * 1e-3)))

    @property
    def equil_steps(self):
        return int(round(self.thermo.equil_ps / (self.thermo.equil_dt_fs * 1e-3)))

    def to_dict(self):
        return asdict(self)

    def to_json(self):
        return json.dumps(self.to_dict(), indent=2)

    @classmethod
    def from_dict(cls, d):
        return _from_dict(cls, d)

    @classmethod
    def from_json(cls, s):
        return cls.from_dict(json.loads(s))


def _from_dict(cls, d):
    kw = {}
    for f in fields(cls):
        if f.name not in d:
            continue
        v = d[f.name]
        if is_dataclass(f.type):
            v = _from_dict(f.type, v)
        elif isinstance(v, list):
            v = tuple(v)
        kw[f.name] = v
    return cls(**kw)


def validate(exp):
    """Hard errors only (things LAMMPS would reject or that make no physical sense). Returns list of str."""
    err = []
    w, t, p = exp.workpiece, exp.tool, exp.process
    if w.material not in MATERIALS:
        err.append(f"unknown workpiece material {w.material}")
    if t.material not in TOOL_MATERIALS:
        err.append(f"unknown tool material {t.material}")
    for v, n in [(w.length_nm, "length"), (w.height_nm, "height"), (w.width_nm, "width"), (w.a0, "a0"), (t.a0, "tool a0")]:
        if not v or v <= 0:
            err.append(f"workpiece {n} must be > 0")
    if p.depth_nm <= 0:
        err.append("depth of cut must be > 0")
    if w.boundary_x not in ("s", "f", "p") or w.boundary_y not in ("s", "f") or w.boundary_z not in ("p", "s"):
        err.append("boundary must be x: s/f/p, y: s/f, z: p/s")
    if p.depth_nm >= w.height_nm - w.fixed_nm - w.thermo_nm:
        err.append("depth of cut reaches the thermostat/boundary layers; increase workpiece height")
    if p.speed_ms <= 0 or p.cut_length_nm <= 0:
        err.append("speed and cutting length must be > 0")
    if p.cut_length_nm > w.length_nm:
        err.append("cutting length exceeds workpiece length")
    if t.shape == "wedge":
        if t.edge_radius_nm < 0 or not (-80 < t.rake_deg < 60) or not (0 <= t.clearance_deg < 60):
            err.append("tool angles/radius out of range (rake -80..60 deg, clearance 0..60 deg, radius >= 0)")
        if t.edge_radius_nm > min(t.length_nm, t.height_nm) / 2:
            err.append("edge radius larger than half the tool block")
    if t.shape == "sphere" and t.sphere_radius_nm <= p.depth_nm:
        err.append("sphere radius must exceed the depth of cut")
    if exp.thermo.cut_dt_fs <= 0 or exp.thermo.equil_dt_fs <= 0:
        err.append("time steps must be > 0")
    for n in ("thermo_every", "dump_every_equil", "dump_every_cut", "restart_every_equil", "restart_every_cut", "forces_every"):
        if getattr(exp.output, n) <= 0:
            err.append(f"output.{n} must be > 0")
    if exp.laser.mode not in ("none", "preheat", "spot", "power"):
        err.append("laser.mode must be none / preheat / spot / power")
    if exp.laser.mode in ("spot", "power") and (exp.laser.spot_radius_nm <= 0 or exp.laser.lead_nm < 0):
        err.append("laser spot radius must be > 0 and lead distance >= 0")
    if exp.output.dump_every_cut % 10:
        err.append("dump_every_cut must be a multiple of 10 (per-atom KE averaging window)")
    return err
