"""LAMMPS text dump frame (bytes in memory) -> OVITO DataCollection, without any file on disk.

Used by the OVITO worker for trajectories on an HPC cluster: the frame is streamed over SSH into memory, turned into
exactly the data OVITO's own LAMMPS dump reader would produce, handed to OVITO's pipeline, and freed. The mapping
follows OVITO's reader: id/type/mol and the standard per-atom columns become OVITO's standard properties (x y z ->
Position, xs ys zs -> absolute Position through the cell, vx.. -> Velocity, fx.. -> Force, ...), other columns become
float64 properties with the column name, Velocity Magnitude is added when vx vy vz exist, the cell is recovered from the
(triclinic) bounding box, particle types get OVITO's defaults. webapp/tools/check_memdump.py compares every property,
the cell and the types with import_file on the same frames.
"""
import io

import numpy as np
import pandas as pd

VECTORS = {"Position": (("x", "y", "z"), ("xu", "yu", "zu")), "Velocity": (("vx", "vy", "vz"),), "Force": (("fx", "fy", "fz"),),
           "Periodic Image": (("ix", "iy", "iz"),), "Angular Velocity": (("omegax", "omegay", "omegaz"),),
           "Angular Momentum": (("angmomx", "angmomy", "angmomz"),), "Torque": (("tqx", "tqy", "tqz"),),
           "Dipole Orientation": (("mux", "muy", "muz"),)}
SCALARS = {"id": ("Particle Identifier", np.int64), "mol": ("Molecule Identifier", np.int64), "q": ("Charge", np.float64),
           "mass": ("Mass", np.float64), "radius": ("Radius", np.float64), "mu": ("Dipole Magnitude", np.float64)}
INT_VECTORS = {"Periodic Image"}


def header(lines):
    """The 9 header lines of a frame -> step, natoms, OVITO cell matrix (3x4: a, b, c, origin as columns), pbc, columns."""
    if not lines[0].startswith("ITEM: TIMESTEP"):
        raise ValueError("frame does not start with 'ITEM: TIMESTEP'")
    flags = lines[4].split()[3:]
    tilt = "xy" in lines[4]
    b = [[float(v) for v in lines[i].split()] for i in (5, 6, 7)]
    xy, xz, yz = (b[0][2], b[1][2], b[2][2]) if tilt else (0.0, 0.0, 0.0)
    xlo = b[0][0] - min(0.0, xy, xz, xy + xz)                         # LAMMPS writes the bounding box of a triclinic cell
    xhi = b[0][1] - max(0.0, xy, xz, xy + xz)
    ylo, yhi = b[1][0] - min(0.0, yz), b[1][1] - max(0.0, yz)
    zlo, zhi = b[2][0], b[2][1]
    cell = np.array([[xhi - xlo, xy, xz, xlo], [0.0, yhi - ylo, yz, ylo], [0.0, 0.0, zhi - zlo, zlo]])
    f3 = flags[-3:] if len(flags) >= 3 else ["pp", "pp", "pp"]
    return dict(step=int(lines[1].split()[0]), natoms=int(lines[3].split()[0]), cell=cell, pbc=tuple(f.startswith("p") for f in f3),
                columns=lines[8].split()[2:])


def fill(data, raw, source_file="", frame=0):
    """Populate an (empty) OVITO DataCollection from the bytes of one dump frame."""
    buf = io.BytesIO(raw)
    lines = [buf.readline().decode("ascii", "replace") for _ in range(9)]
    h = header(lines)
    cols, n = h["columns"], h["natoms"]
    dtypes = {c: (str if c == "element" else np.int64 if c in ("id", "type", "mol", "ix", "iy", "iz") else np.float64) for c in cols}
    df = pd.read_csv(buf, sep=r"\s+", header=None, names=cols, nrows=n, engine="c", dtype=dtypes, float_precision="round_trip")
    if len(df) != n:
        raise ValueError(f"incomplete frame: {len(df)} of {n} atoms")
    data.create_cell(h["cell"], pbc=h["pbc"])
    P = data.create_particles(count=n)
    used = set()
    if "id" in df:
        P.create_property("Particle Identifier", data=df["id"].to_numpy(np.int64))
        used.add("id")
    if "type" in df or "element" in df:
        if "type" in df:
            t = df["type"].to_numpy(np.int32)
            used.add("type")
            names = {}
            if "element" in df:
                el = df["element"].to_numpy()
                u, first = np.unique(t, return_index=True)
                names = {int(k): str(el[j]) for k, j in zip(u, first)}
        else:                                                             # element only: types numbered by name
            u, inv = np.unique(df["element"].to_numpy(), return_inverse=True)
            t = (inv + 1).astype(np.int32)
            names = {i + 1: str(v) for i, v in enumerate(u)}
        used.add("element")
        prop = P.create_property("Particle Type", data=t)
        for tid in np.unique(t):
            ptype = prop.add_type_id(int(tid), P, name=names.get(int(tid))) if names.get(int(tid)) else prop.add_type_id(int(tid), P)
    for c in ("mol", "q", "mass", "radius", "mu"):
        if c in df:
            name, dt = SCALARS[c]
            P.create_property(name, data=df[c].to_numpy(dt))
            used.add(c)
    if "diameter" in df and "radius" not in df:
        P.create_property("Radius", data=df["diameter"].to_numpy(np.float64) / 2)
        used.add("diameter")
    for name, alternatives in VECTORS.items():
        for trio in alternatives:
            if all(c in df for c in trio):
                arr = np.column_stack([df[c].to_numpy() for c in trio])
                P.create_property(name, data=arr.astype(np.int32 if name in INT_VECTORS else np.float64))
                used.update(trio)
                break
    if "Position" not in P:
        for trio in (("xs", "ys", "zs"), ("xsu", "ysu", "zsu")):          # reduced coordinates -> absolute
            if all(c in df for c in trio):
                s = np.column_stack([df[c].to_numpy(np.float64) for c in trio])
                M = h["cell"]
                P.create_property("Position", data=M[:, 3] + s @ M[:, :3].T)
                used.update(trio)
                break
    for c in cols:                                                        # everything else: same name, float64
        if c not in used and c not in ("xu", "yu", "zu"):
            if df[c].dtype == object:
                continue
            P.create_property(c, data=df[c].to_numpy(np.float64))
    if "Velocity" in P:
        v = np.asarray(P["Velocity"])
        P.create_property("Velocity Magnitude", data=np.sqrt((v * v).sum(1)))
    data.attributes["SourceFrame"] = frame
    data.attributes["SourceFile"] = source_file
    data.attributes["Timestep"] = h["step"]
    return h


def frame_offsets(chunks):
    """Byte offsets of every 'ITEM: TIMESTEP' that starts a line, from an iterator of byte chunks (one pass)."""
    key, K = b"ITEM: TIMESTEP", len(b"ITEM: TIMESTEP")
    out, pos, tail, before = [], 0, b"", b"\n"
    for chunk in chunks:
        buf, base = tail + chunk, pos - len(tail)
        i = buf.find(key)
        while i >= 0:
            if (buf[i - 1:i] if i > 0 else before) == b"\n":
                out.append(base + i)
            i = buf.find(key, i + 1)
        if len(buf) >= K:
            before, tail = buf[-K:-K + 1], buf[-(K - 1):]
        pos += len(chunk)
    return sorted(set(out))
