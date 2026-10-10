"""Frame-based access to LAMMPS custom dumps: headers only for listings, one frame at a time for viewing.

Values are returned exactly as written by LAMMPS; derived per-atom quantities use the definitions of
nanocut.analysis (local T from time-averaged KE, von Mises / hydrostatic from c_s[1..6] and the atomic volume).
"""
import glob
import os
import re
from functools import lru_cache

import numpy as np
import pandas as pd

from nanocut.analysis import KB, MVV2E
from nanocut.materials import MASS, BASIS, MATERIALS

STEP_RE = re.compile(r"\.(\d+)\.lammpstrj$")


def list_dumps(folder):
    """Cutting-stage dumps (deck B: *_cut.<step>.lammpstrj) sorted by step; falls back to any *.lammpstrj."""
    files = glob.glob(os.path.join(folder, "*_cut.*.lammpstrj"))
    kind = "cut"
    if not files:
        files = glob.glob(os.path.join(folder, "*.lammpstrj"))
        kind = "any"
    out = []
    for f in files:
        m = STEP_RE.search(f)
        if m:
            out.append((int(m.group(1)), f))
    return sorted(out), kind


def read_header(path):
    """Parse the 9-line dump header: step, atom count, box bounds, boundary flags, column names."""
    with open(path, "r", errors="replace") as f:
        lines = [f.readline() for _ in range(9)]
    if not lines[0].startswith("ITEM: TIMESTEP"):
        raise ValueError("not a LAMMPS dump (first line is not 'ITEM: TIMESTEP')")
    bounds_flags = lines[4].split()[3:]
    box = [[float(v) for v in lines[i].split()[:2]] for i in (5, 6, 7)]
    return dict(step=int(lines[1]), natoms=int(lines[3]), box=box, boundary=bounds_flags,
                columns=lines[8].split()[2:], bytes=os.path.getsize(path))


@lru_cache(maxsize=6)
def _load(path, mtime):
    h = read_header(path)
    if h["bytes"] > 800_000_000:
        raise ValueError("dump frame too large to parse in a request")
    df = pd.read_csv(path, sep=r"\s+", header=None, skiprows=9, nrows=h["natoms"], engine="c", names=h["columns"])
    if len(df) != h["natoms"]:
        raise ValueError(f"truncated dump: {len(df)} of {h['natoms']} atoms")
    return h, df


def load_frame(path):
    return _load(path, os.path.getmtime(path))


def atomic_volume(experiment):
    """Volume per workpiece atom from the lattice (a0^3 / atoms per conventional cell); used for stress in GPa."""
    if not experiment:
        return None
    w = experiment.get("workpiece", {})
    mat = MATERIALS.get(w.get("material"))
    if not mat:
        return None
    n = 8 if mat["structure"] == "zincblende" else len(BASIS[mat["structure"]])
    return float(w.get("a0", mat["a0"])) ** 3 / n


PROPERTIES = {
    "type": ("Atom type", "", "categorical"),
    "mol": ("Layer (mol tag)", "", "categorical"),
    "temperature": ("Local temperature", "K", "sequential"),
    "coordination": ("Coordination number", "", "categorical"),
    "von_mises": ("von Mises stress", "GPa", "sequential"),
    "hydrostatic": ("Hydrostatic stress", "GPa", "diverging"),
    "pe": ("Potential energy", "eV", "sequential"),
    "speed": ("Speed |v|", "Å/ps", "sequential"),
    "in_laser": ("In laser zone", "", "categorical"),
}


def available_properties(columns):
    c = set(columns)
    out = ["type"]
    if "mol" in c:
        out.append("mol")
    if "f_keav" in c or "c_ke" in c or {"vx", "vy", "vz"} <= c:
        out.append("temperature")
    if "c_cn" in c:
        out.append("coordination")
    if all(f"c_s[{i}]" in c for i in range(1, 7)):
        out += ["von_mises", "hydrostatic"]
    if "c_pe" in c:
        out.append("pe")
    if {"vx", "vy", "vz"} <= c:
        out.append("speed")
    if "v_inlaser" in c:
        out.append("in_laser")
    return out


def property_values(df, name, types, vol):
    c = df.columns
    if name == "type":
        return df["type"].to_numpy()
    if name == "mol":
        return df["mol"].to_numpy()
    if name == "temperature":
        ke = df["f_keav"] if "f_keav" in c else (df["c_ke"] if "c_ke" in c else None)
        if ke is None:
            m = np.array([MASS[types[t - 1]] if types and t - 1 < len(types) else 1.0 for t in df["type"].to_numpy()])
            ke = 0.5 * m * (df["vx"] ** 2 + df["vy"] ** 2 + df["vz"] ** 2) * MVV2E
        return (2.0 * np.asarray(ke) / (3.0 * KB))
    if name == "coordination":
        return df["c_cn"].to_numpy()
    if name in ("von_mises", "hydrostatic"):
        if not vol:
            raise ValueError("atomic volume unknown (no params.json) - stress in GPa unavailable")
        s = np.stack([df[f"c_s[{i}]"].to_numpy() for i in range(1, 7)], 1) / vol * 1e-4 * -1.0
        sxx, syy, szz, sxy, sxz, syz = s.T
        if name == "hydrostatic":
            return (sxx + syy + szz) / 3.0
        return np.sqrt(0.5 * ((sxx - syy) ** 2 + (syy - szz) ** 2 + (szz - sxx) ** 2) + 3 * (sxy ** 2 + sxz ** 2 + syz ** 2))
    if name == "pe":
        return df["c_pe"].to_numpy()
    if name == "speed":
        return np.sqrt(df["vx"] ** 2 + df["vy"] ** 2 + df["vz"] ** 2).to_numpy()
    if name == "in_laser":
        return df["v_inlaser"].to_numpy()
    raise KeyError(name)


def sample_mask(ids, natoms, max_atoms, slab=None, z=None):
    """Deterministic subsample by particle id (same atoms in every frame, so playback does not flicker)."""
    keep = np.ones(len(ids), bool)
    if slab is not None and z is not None:
        keep &= (z >= slab[0]) & (z <= slab[1])
    n = int(keep.sum())
    if max_atoms and n > max_atoms:
        stride = int(np.ceil(n / max_atoms))
        keep &= (ids % stride) == 0
    return keep


def frame_payload(path, props, types, vol, max_atoms, slab=None):
    h, df = load_frame(path)
    ids = df["id"].to_numpy()
    z = df["z"].to_numpy()
    keep = sample_mask(ids, h["natoms"], max_atoms, slab, z)
    order = np.argsort(ids[keep], kind="stable")          # LAMMPS writes atoms in a different order every frame
    sub = df[keep].iloc[order]
    out = dict(step=h["step"], natoms=h["natoms"], shown=int(keep.sum()), box=h["box"], boundary=h["boundary"],
               columns=h["columns"], available=available_properties(h["columns"]),
               x=np.round(sub["x"].to_numpy(), 3).tolist(), y=np.round(sub["y"].to_numpy(), 3).tolist(),
               z=np.round(sub["z"].to_numpy(), 3).tolist(), id=sub["id"].astype(int).tolist(), props={}, stats={})
    for name in ["type"] + [p for p in props if p != "type"]:
        if name not in out["available"]:
            continue
        try:
            v = np.asarray(property_values(df, name, types, vol))
        except ValueError as e:
            out["stats"][name] = dict(error=str(e))
            continue
        vs = v[keep][order]
        out["props"][name] = np.round(vs.astype(float), 4).tolist()
        out["stats"][name] = dict(min=float(np.nanmin(v)), max=float(np.nanmax(v)), mean=float(np.nanmean(v)),
                                  p01=float(np.nanpercentile(v, 1)), p99=float(np.nanpercentile(v, 99)))
    return out
