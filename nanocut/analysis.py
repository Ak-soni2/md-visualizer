"""Post-processing of LAMMPS output: dumps (lammpstrj custom), fix ave/time files, log thermo tables, metrics.

All quantities are computed from the raw per-atom data with the standard definitions
(see reference/nanocutting_md_literature.md §5):
  local temperature  T_i = 2 <KE_i> / (3 k_B)           (per-atom, from time-averaged KE)
  zone temperature   T = 2 Σ ½ m |v - v_com|² / (3 N k_B)  (streaming velocity removed)
  pile-up / chip height = max y of workpiece atoms above the undeformed surface.
"""
import glob
import os
import re
import numpy as np
from .materials import MASS

KB = 8.617333262e-5          # eV/K
MVV2E = 1.0364269e-4         # (g/mol)(Å/ps)^2 -> eV  (LAMMPS metal units)


def read_dump(path):
    """Read one lammpstrj file (may contain several frames). Returns list of dict(step, box, cols, data)."""
    frames = []
    with open(path) as f:
        while True:
            line = f.readline()
            if not line:
                break
            if not line.startswith("ITEM: TIMESTEP"):
                continue
            step = int(f.readline())
            f.readline()                    # ITEM: NUMBER OF ATOMS
            n = int(f.readline())
            f.readline()                    # ITEM: BOX BOUNDS
            box = [list(map(float, f.readline().split()[:2])) for _ in range(3)]
            cols = f.readline().split()[2:]  # ITEM: ATOMS ...
            data = np.loadtxt(f, max_rows=n)
            if data.ndim == 1:
                data = data[None, :]
            frames.append(dict(step=step, box=box, cols=cols, data=data))
    return frames


def dump_series(folder, pattern="*_cut.*.lammpstrj"):
    files = glob.glob(os.path.join(folder, pattern))
    files.sort(key=lambda p: int(re.search(r"\.(\d+)\.lammpstrj$", p).group(1)))
    return files


def read_avetime(path):
    """fix ave/time output: returns (names, array)."""
    names = None
    rows = []
    with open(path) as f:
        for line in f:
            if line.startswith("#"):
                toks = line[1:].split()
                if toks and toks[0].lower() == "step":
                    names = toks
                continue
            if line.strip():
                rows.append([float(x) for x in line.split()])
    arr = np.array(rows)
    if names is None and len(arr):
        names = ["step"] + [f"v{i}" for i in range(1, arr.shape[1])]
    return names, arr


def read_log_thermo(path):
    """All thermo tables from a LAMMPS log as list of (names, array)."""
    tables = []
    names, rows = None, []
    with open(path, errors="replace") as f:
        for line in f:
            s = line.split()
            if s and s[0] == "Step":
                if names and rows:
                    tables.append((names, np.array(rows)))
                names, rows = s, []
                continue
            if names is not None:
                if s and (line.startswith("Loop time") or s[0] in ("WARNING:", "ERROR:")):
                    tables.append((names, np.array(rows)))
                    names, rows = None, []
                    continue
                try:
                    rows.append([float(x) for x in s])
                except ValueError:
                    pass
    if names and rows:
        tables.append((names, np.array(rows)))
    return tables


class Frame:
    """Convenience accessor around one dump frame."""

    def __init__(self, fr, types=None):
        self.step = fr["step"]
        self.cols = fr["cols"]
        self.d = fr["data"]
        self.types = types or []
        self.ix = {c: i for i, c in enumerate(self.cols)}

    def col(self, name):
        return self.d[:, self.ix[name]] if name in self.ix else None

    @property
    def xyz(self):
        return self.d[:, [self.ix["x"], self.ix["y"], self.ix["z"]]]

    def mass(self):
        t = self.col("type").astype(int)
        if not self.types:
            return np.ones(len(t))
        return np.array([MASS[self.types[i - 1]] for i in t])

    def local_temperature(self):
        """Per-atom temperature (K) from time-averaged KE (f_keav) or instantaneous KE (c_ke) or velocities."""
        ke = self.col("f_keav")
        if ke is None:
            ke = self.col("c_ke")
        if ke is None and self.col("vx") is not None:
            v2 = self.col("vx") ** 2 + self.col("vy") ** 2 + self.col("vz") ** 2
            ke = 0.5 * self.mass() * v2 * MVV2E
        if ke is None:
            return None
        return 2.0 * ke / (3.0 * KB)

    def zone_temperature(self, mask):
        """Temperature of the atoms in `mask` with the centre-of-mass velocity removed (needs vx vy vz)."""
        if self.col("vx") is None or mask.sum() < 2:
            return None
        v = self.d[np.ix_(mask, [self.ix["vx"], self.ix["vy"], self.ix["vz"]])]
        m = self.mass()[mask]
        vcom = (m[:, None] * v).sum(0) / m.sum()
        ke = 0.5 * (m * ((v - vcom) ** 2).sum(1)).sum() * MVV2E
        return 2.0 * ke / (3.0 * mask.sum() * KB)

    def von_mises(self, atomic_volume):
        """Per-atom von Mises stress (GPa) from c_s[1..6] (bar*Å^3) and the atomic volume (Å^3)."""
        if "c_s[1]" not in self.ix:
            return None
        s = np.stack([self.col(f"c_s[{i}]") for i in range(1, 7)], 1) / atomic_volume * 1e-4 * -1.0
        sxx, syy, szz, sxy, sxz, syz = s.T
        return np.sqrt(0.5 * ((sxx - syy) ** 2 + (syy - szz) ** 2 + (szz - sxx) ** 2) + 3 * (sxy ** 2 + sxz ** 2 + syz ** 2))

    def hydrostatic(self, atomic_volume):
        if "c_s[1]" not in self.ix:
            return None
        return -(self.col("c_s[1]") + self.col("c_s[2]") + self.col("c_s[3]")) / 3.0 / atomic_volume * 1e-4


def metrics(frame, y_surface, edge_center, speed_aps, dt_ps, rc=20.0, workpiece_mol=(4, 5, 6)):
    """Standard quantities for one frame of deck B output. `edge_center` = contact point (x_edge, y_surface - depth) at t = 0."""
    fr = frame
    mol = fr.col("mol")
    typ = fr.col("type")
    wp = np.isin(mol, workpiece_mol) if mol is not None else typ > 1
    xyz = fr.xyz
    t_ps = fr.step * dt_ps
    x_edge = edge_center[0] - speed_aps * t_ps
    out = dict(step=fr.step, time_ps=t_ps, cut_distance_A=speed_aps * t_ps, tool_edge_x_A=x_edge)
    ywp = xyz[wp, 1]
    out["max_height_above_surface_A"] = float(ywp.max() - y_surface) if wp.any() else None
    above = wp & (xyz[:, 1] > y_surface + 1.0)
    out["atoms_above_surface"] = int(above.sum())
    # surface profile: max y per 5 Å bin along x
    if wp.any():
        xs = xyz[wp, 0]
        bins = np.arange(xs.min(), xs.max() + 5.0, 5.0)
        idx = np.digitize(xs, bins)
        prof = np.full(len(bins), np.nan)
        for i in np.unique(idx):
            prof[min(i, len(bins) - 1)] = ywp[idx == i].max()
        out["profile_x_A"] = bins
        out["profile_y_A"] = prof - y_surface
    # contact zone: workpiece atoms within rc of the (moving) edge centre in the x-y plane
    d2 = (xyz[:, 0] - x_edge) ** 2 + (xyz[:, 1] - edge_center[1]) ** 2
    cz = wp & (d2 <= rc ** 2)
    out["contact_zone_atoms"] = int(cz.sum())
    out["contact_zone_T_K"] = fr.zone_temperature(cz)
    Tloc = fr.local_temperature()
    if Tloc is not None and cz.any():
        out["contact_zone_T_local_mean_K"] = float(Tloc[cz].mean())
        out["max_local_T_K"] = float(Tloc[wp].max())
    cn = fr.col("c_cn")
    if cn is not None and wp.any():
        vals, cnt = np.unique(cn[wp].astype(int), return_counts=True)
        out["coordination_histogram"] = dict(zip(vals.tolist(), cnt.tolist()))
    return out


def force_summary(names, arr, speed_aps, dt_ps, steady_from_frac=0.5):
    """Mean forces over the steady-state part (last fraction of the cut) + friction coefficient."""
    d = {n: arr[:, i] for i, n in enumerate(names)}
    step = d["step"]
    dist = step * dt_ps * speed_aps
    sel = dist >= dist.max() * steady_from_frac
    out = dict(cut_distance_A=dist)
    for k in names[1:]:
        out[k] = d[k]
        out[k + "_steady_mean"] = float(d[k][sel].mean())
        out[k + "_steady_std"] = float(d[k][sel].std())
    if "Fc_nN" in d and "Ft_nN" in d and d["Ft_nN"][sel].mean() != 0:
        out["friction_coefficient"] = float(d["Fc_nN"][sel].mean() / d["Ft_nN"][sel].mean())
    return out
