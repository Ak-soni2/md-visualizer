"""Studio: OVITO-style access to any LAMMPS text dump (a folder, a file sequence, or one multi-frame file).

Read-only. Files are recognised by their content (first line 'ITEM: TIMESTEP'), never by name alone.
A wildcard sequence (dump.*.lammpstrj) is one frame per file, as OVITO assumes by default; a single file is
scanned for all frames it contains. Frames are parsed in background jobs into a small LRU cache; HTTP handlers
only slice cached arrays. Values are passed through exactly as written by LAMMPS (as float32); the only derived
quantities are positions from scaled/unwrapped coordinates, |v|, and displacements relative to a reference frame
(minimum-image convention along periodic directions, atoms matched by id).
"""
import gzip
import hashlib
import os
import re
import threading
from collections import OrderedDict
from pathlib import Path

import numpy as np
import pandas as pd

from .settings import HIDDEN_NAMES, PROJECT_ROOT, rel

STUDIO_ROOTS = [Path(p).resolve() for p in os.environ.get("NANOCUT_STUDIO_ROOTS", "").split(os.pathsep) if p.strip()]
CACHE_FRAMES = int(os.environ.get("NANOCUT_STUDIO_CACHE", "3"))
DUMP_HINT = re.compile(r"(\.lammpstrj|\.dump|\.atom|\.lammpsdump|\.trj)(\.\d+)?(\.gz)?$|^dump|\.dump\.|\.lammpstrj\.", re.I)
SKIP_SUFFIX = {".csv", ".log", ".restart", ".txt", ".in", ".py", ".sh", ".png", ".jpg", ".json", ".md", ".data", ".xyz", ".bat"}
NUM_RE = re.compile(r"^(.*?)(\d+)(\D*)$")
MAX_WALK_FILES = 50_000

_sources = {}                     # sid -> source dict
_cache = OrderedDict()            # (sid, index) -> frame dict
_lock = threading.Lock()


# ------------------------------------------------------------------------------------------------ paths
def resolve(path_str):
    """Absolute path; relative paths are taken from the project root. Optional NANOCUT_STUDIO_ROOTS restricts access."""
    if not path_str or not str(path_str).strip():
        raise ValueError("no path given")
    p = Path(str(path_str).strip().strip('"')).expanduser()
    if not p.is_absolute():
        p = PROJECT_ROOT / p
    p = p.resolve()
    if STUDIO_ROOTS and not any(p == r or r in p.parents for r in STUDIO_ROOTS):
        raise PermissionError("path outside NANOCUT_STUDIO_ROOTS")
    if not p.exists():
        raise FileNotFoundError(f"not found: {p}")
    return p


def _open(path):
    return gzip.open(path, "rb") if str(path).endswith(".gz") else open(path, "rb")


def is_dump(path):
    try:
        with _open(path) as f:
            return f.read(64).lstrip().startswith(b"ITEM: TIMESTEP")
    except OSError:
        return False


# ------------------------------------------------------------------------------------------------ discovery
def _candidate(name):
    low = name.lower()
    if Path(low.removesuffix(".gz")).suffix in SKIP_SUFFIX:
        return False
    return bool(DUMP_HINT.search(low))


def scan(path_str, max_depth=2):
    """List dump sequences under a folder (or the single file given). Cheap: names, sizes, one header per group."""
    p = resolve(path_str)
    if p.is_file():
        if not is_dump(p):
            raise ValueError("not a LAMMPS text dump (first line is not 'ITEM: TIMESTEP')")
        return dict(path=str(p), sequences=[dict(dir=str(p.parent), pattern=p.name, count=1, bytes=p.stat().st_size,
                                                 first=p.name, last=p.name, single=True)])
    groups, seen = {}, 0
    base_depth = len(p.parts)
    for root, dirs, files in os.walk(p):
        dirs[:] = sorted(d for d in dirs if d not in HIDDEN_NAMES and not d.startswith("."))
        if len(Path(root).parts) - base_depth >= max_depth:
            dirs[:] = []
        for name in files:
            seen += 1
            if seen > MAX_WALK_FILES:
                break
            if not _candidate(name):
                continue
            m = NUM_RE.match(name)
            pattern = f"{m.group(1)}*{m.group(3)}" if m else name
            g = groups.setdefault((root, pattern), [])
            g.append((int(m.group(2)) if m else 0, name))
    seqs = []
    for (root, pattern), items in groups.items():
        items.sort()
        if not is_dump(os.path.join(root, items[0][1])):
            continue
        size = sum(os.path.getsize(os.path.join(root, n)) for _, n in items)
        seqs.append(dict(dir=root, pattern=pattern, count=len(items), bytes=size, first=items[0][1], last=items[-1][1],
                         single=len(items) == 1))
    seqs.sort(key=lambda s: (-s["count"], s["dir"], s["pattern"]))
    return dict(path=str(p), sequences=seqs)


def _sequence_files(directory, pattern):
    rx = re.compile("^" + re.escape(pattern).replace(r"\*", r"(\d+)") + "$")
    out = []
    for name in os.listdir(directory):
        m = rx.match(name)
        if m:
            out.append((int(m.group(1)) if m.groups() else 0, os.path.join(directory, name)))
    return [f for _, f in sorted(out)]


def _index_file(path, progress=None):
    """Byte offsets of every frame in one (uncompressed) dump file."""
    size = os.path.getsize(path)
    key, K = b"ITEM: TIMESTEP", len(b"ITEM: TIMESTEP")
    offsets, pos, tail, before = [], 0, b"", b"\n"
    with open(path, "rb") as f:
        while True:
            chunk = f.read(16 << 20)
            if not chunk:
                break
            buf, base = tail + chunk, pos - len(tail)
            i = buf.find(key)
            while i >= 0:
                if (buf[i - 1:i] if i > 0 else before) == b"\n":     # a header starts a line
                    offsets.append(base + i)
                i = buf.find(key, i + 1)
            if len(buf) >= K:
                before, tail = buf[-K:-K + 1], buf[-(K - 1):]       # tail is too short to hold a whole match twice
            pos += len(chunk)
            if progress:
                progress(0.05 + 0.9 * pos / max(size, 1), f"indexing frames {pos / 1e6:.0f}/{size / 1e6:.0f} MB")
    return sorted(set(offsets))


def read_header(fh):
    """Parse a 9-line frame header from an open binary handle positioned at 'ITEM: TIMESTEP'."""
    lines = [fh.readline().decode("ascii", "replace") for _ in range(9)]
    if not lines[0].startswith("ITEM: TIMESTEP"):
        raise ValueError("frame does not start with 'ITEM: TIMESTEP'")
    flags = lines[4].split()[3:]
    tilt = "xy" in lines[4]
    b = [[float(v) for v in lines[i].split()] for i in (5, 6, 7)]
    xlo_b, xhi_b = b[0][:2]
    ylo_b, yhi_b = b[1][:2]
    zlo, zhi = b[2][:2]
    xy, xz, yz = (b[0][2], b[1][2], b[2][2]) if tilt else (0.0, 0.0, 0.0)
    # LAMMPS writes bounding-box bounds for triclinic cells; recover the cell (dump documentation, "triclinic")
    xlo = xlo_b - min(0.0, xy, xz, xy + xz)
    xhi = xhi_b - max(0.0, xy, xz, xy + xz)
    ylo = ylo_b - min(0.0, yz)
    yhi = yhi_b - max(0.0, yz)
    cell = dict(origin=[xlo, ylo, zlo], a=[xhi - xlo, 0.0, 0.0], b=[xy, yhi - ylo, 0.0], c=[xz, yz, zhi - zlo],
                pbc=[f.startswith("p") for f in (flags[-3:] if len(flags) >= 3 else ["pp", "pp", "pp"])],
                flags=flags[-3:], triclinic=tilt)
    return dict(step=int(lines[1].split()[0]), natoms=int(lines[3].split()[0]), cell=cell, columns=lines[8].split()[2:])


def _header_at(path, offset):
    with _open(path) as f:
        if offset:
            f.seek(offset)
        return read_header(f)


def open_source(path_str, pattern=None, progress=None):
    """Build the frame index of a folder sequence or a single file. Returns the public source record."""
    p = resolve(path_str)
    if p.is_file():
        files = [str(p)]
        directory, pattern = str(p.parent), p.name
    else:
        if not pattern:
            seqs = scan(str(p))["sequences"]
            if not seqs:
                raise FileNotFoundError("no LAMMPS dump files found in this folder (looked two levels deep)")
            directory, pattern = seqs[0]["dir"], seqs[0]["pattern"]
        else:
            directory, pattern = (str(Path(pattern).parent) if os.path.isabs(pattern) else str(p)), Path(pattern).name
            if not os.path.isdir(directory):
                raise FileNotFoundError(directory)
        files = _sequence_files(directory, pattern)
        if not files:
            raise FileNotFoundError(f"no files match {pattern} in {directory}")
    frames = []
    if len(files) == 1 and not files[0].endswith(".gz"):
        for off in _index_file(files[0], progress):
            frames.append((files[0], off))
    else:
        frames = [(f, 0) for f in files]
    steps, steps_from = [], "header"
    if len(files) > 1:
        # one frame per file: the number in the file name (dump ... *) is the step; the real header step is read and
        # reported when a frame is loaded. Opening 600 files on an external disk only for this takes ~40 s.
        steps, steps_from = [int(NUM_RE.match(Path(f).name).group(2)) for f in files], "file name"
    else:
        for k, (f, off) in enumerate(frames):
            with _open(f) as fh:
                if off:
                    fh.seek(off)
                fh.readline()
                steps.append(int(fh.readline().split()[0]))
    first = _header_at(*frames[0])
    sid = hashlib.sha1(f"{directory}|{pattern}".encode()).hexdigest()[:10]
    src = dict(id=sid, dir=directory, pattern=pattern, label=f"{Path(directory).name}/{pattern}", display=rel(directory),
               files=len(files), frames=frames, steps=steps, steps_from=steps_from, natoms=first["natoms"], columns=first["columns"],
               cell=first["cell"], bytes=sum(os.path.getsize(f) for f in files))
    with _lock:
        _sources[sid] = src
        for k in [k for k in _cache if k[0] == sid]:          # re-opened (e.g. new frames written): drop stale frames
            del _cache[k]
    return public_source(src)


def public_source(src):
    return {k: v for k, v in src.items() if k != "frames"} | dict(n_frames=len(src["frames"]))


def get_source(sid):
    s = _sources.get(sid)
    if not s:
        raise KeyError(f"unknown source '{sid}' (open it again)")
    return s


# ------------------------------------------------------------------------------------------------ frames
def _parse(path, offset):
    with _open(path) as f:
        if offset:
            f.seek(offset)
        h = read_header(f)
        cols = h["columns"]
        dtype = {c: np.float32 for c in cols if c not in ("id", "type", "mol", "element")}
        df = pd.read_csv(f, sep=r"\s+", header=None, names=cols, nrows=h["natoms"], engine="c", dtype=dtype)
    if len(df) != h["natoms"]:
        raise ValueError(f"incomplete frame: {len(df)} of {h['natoms']} atoms (file still being written?)")
    return h, df


def _cell_matrix(cell):
    return np.array([cell["a"], cell["b"], cell["c"]], dtype=np.float64)


def _build_frame(src, index, progress=None):
    path, offset = src["frames"][index]
    if progress:
        progress(0.1, f"parsing {Path(path).name}")
    h, df = _parse(path, offset)
    if progress:
        progress(0.75, "preparing columns")
    ids = df["id"].to_numpy(np.int64) if "id" in df else np.arange(1, len(df) + 1, dtype=np.int64)
    order = np.argsort(ids, kind="stable")                      # LAMMPS writes atoms in a different order every frame
    ids = ids[order]
    cols, names = {}, {}
    if "element" in df and not pd.api.types.is_numeric_dtype(df["element"]):     # object (pandas 2) or str (pandas 3)
        el = df["element"].to_numpy()[order]
        if "type" in df:
            t = df["type"].to_numpy()[order]
            u, first = np.unique(t, return_index=True)
            names = {int(k): str(el[j]) for k, j in zip(u, first)}
        else:
            codes, uniq = pd.factorize(el, sort=True)
            cols["type"] = (codes + 1).astype(np.float32)
            names = {i + 1: str(u) for i, u in enumerate(uniq)}
    for c in df.columns:
        if c in ("id", "element"):
            continue
        v = df[c].to_numpy()
        if v.dtype == object:
            continue
        cols[c] = v[order].astype(np.float32, copy=False)
    cell = h["cell"]
    H = _cell_matrix(cell)
    o = np.array(cell["origin"])
    for trio, kind in ((("x", "y", "z"), "abs"), (("xu", "yu", "zu"), "abs"), (("xs", "ys", "zs"), "scaled"), (("xsu", "ysu", "zsu"), "scaled")):
        if all(t in cols for t in trio) and not all(t in cols for t in ("x", "y", "z")):
            if kind == "abs":
                cols["x"], cols["y"], cols["z"] = (cols[t] for t in trio)
            else:
                s = np.stack([cols[t] for t in trio], 1).astype(np.float64)
                r = o + s @ H
                cols["x"], cols["y"], cols["z"] = (r[:, k].astype(np.float32) for k in range(3))
    if not all(t in cols for t in ("x", "y", "z")):
        raise ValueError("dump has no atom positions (need x y z, xu yu zu or xs ys zs)")
    if "type" not in cols:
        cols["type"] = np.ones(len(ids), np.float32)
    if all(c in cols for c in ("vx", "vy", "vz")):
        cols["v_magnitude"] = np.sqrt(cols["vx"] ** 2 + cols["vy"] ** 2 + cols["vz"] ** 2)
    types, counts = np.unique(cols["type"].astype(np.int64), return_counts=True)
    stats = {"id": dict(min=float(ids[0]), max=float(ids[-1]))} if len(ids) else {}
    for c, v in cols.items():
        stats[c] = dict(min=float(np.nanmin(v)), max=float(np.nanmax(v))) if len(v) else dict(min=0.0, max=0.0)
    meta = dict(source=src["id"], index=index, step=h["step"], natoms=int(len(ids)), cell=cell, file=path, offset=offset,
                dump_columns=h["columns"], columns=sorted(cols, key=lambda c: (c not in ("x", "y", "z", "type"), c)) + ["id"],
                types=[dict(id=int(t), count=int(n), name=names.get(int(t))) for t, n in zip(types, counts)], stats=stats)
    return dict(meta=meta, ids=ids, cols=cols, disp={})


def _cached(sid, index):
    with _lock:
        fr = _cache.get((sid, index))
        if fr is not None:
            _cache.move_to_end((sid, index))
        return fr


def _store(sid, index, fr):
    with _lock:
        _cache[(sid, index)] = fr
        _cache.move_to_end((sid, index))
        while len(_cache) > max(CACHE_FRAMES, 2):
            _cache.popitem(last=False)


def is_loaded(sid, index, ref=None):
    fr = _cached(sid, index)
    return fr is not None and (ref is None or ref in fr["disp"])


def load_frame(sid, index, ref=None, progress=None):
    """Job body: parse frame `index` (and `ref` for displacements) into the cache. Returns frame metadata."""
    src = get_source(sid)
    n = len(src["frames"])
    if not 0 <= index < n or (ref is not None and not 0 <= ref < n):
        raise IndexError(f"frame index out of range (0..{n - 1})")
    fr = _cached(sid, index)
    if fr is None:
        fr = _build_frame(src, index, progress)
        _store(sid, index, fr)
    if ref is not None and ref not in fr["disp"]:
        rf = fr if ref == index else (_cached(sid, ref) or _build_frame(src, ref, progress))
        if ref != index:
            _store(sid, ref, rf)
            _store(sid, index, fr)                              # keep the current frame the most recent
        fr["disp"][ref] = displacement(fr, rf)
    meta = dict(fr["meta"])
    if ref is not None:
        meta["reference"] = dict(index=ref, step=src["steps"][ref], **fr["disp"][ref]["info"])
        meta["columns"] = meta["columns"] + ["dx", "dy", "dz", "displacement"]
        meta["stats"] = meta["stats"] | fr["disp"][ref]["stats"]
    return meta


def displacement(fr, rf):
    """r(current) - r(reference) per atom id, minimum image along periodic cell vectors (OVITO 'Displacement vectors')."""
    pos = np.stack([fr["cols"][c] for c in ("x", "y", "z")], 1).astype(np.float64)
    rpos = np.stack([rf["cols"][c] for c in ("x", "y", "z")], 1).astype(np.float64)
    j = np.searchsorted(rf["ids"], fr["ids"])
    j = np.clip(j, 0, len(rf["ids"]) - 1)
    found = rf["ids"][j] == fr["ids"]
    d = pos - rpos[j]
    cell = fr["meta"]["cell"]
    H = _cell_matrix(cell)
    pbc = np.array(cell["pbc"], bool)
    if pbc.any():
        s = d @ np.linalg.inv(H)
        s[:, pbc] -= np.round(s[:, pbc])
        d = s @ H
    d[~found] = np.nan
    out = {k: d[:, i].astype(np.float32) for i, k in enumerate(("dx", "dy", "dz"))}
    out["displacement"] = np.sqrt((d ** 2).sum(1)).astype(np.float32)
    stats = {k: dict(min=float(np.nanmin(v)), max=float(np.nanmax(v))) for k, v in out.items()}
    return dict(cols=out, stats=stats, info=dict(missing=int((~found).sum()), minimum_image=[bool(b) for b in pbc]))


def columns_bytes(sid, index, names, ref=None):
    """Little-endian float32 blocks (id: uint32) in the requested order, from the cache only."""
    fr = _cached(sid, index)
    if fr is None or (ref is not None and ref not in fr["disp"]):
        raise LookupError("frame not loaded")
    parts = []
    for c in names:
        if c == "id":
            parts.append(fr["ids"].astype("<u4").tobytes())
        elif c in fr["cols"]:
            parts.append(fr["cols"][c].astype("<f4", copy=False).tobytes())
        elif ref is not None and c in fr["disp"][ref]["cols"]:
            parts.append(fr["disp"][ref]["cols"][c].astype("<f4", copy=False).tobytes())
        else:
            raise KeyError(f"no column '{c}' in this frame")
    return b"".join(parts)


def atom_row(sid, index, i, ref=None):
    """All values of one atom (index into the id-sorted arrays), for the picking inspector."""
    fr = _cached(sid, index)
    if fr is None:
        raise LookupError("frame not loaded")
    if not 0 <= i < len(fr["ids"]):
        raise IndexError("atom index out of range")
    row = {"id": int(fr["ids"][i])} | {c: float(v[i]) for c, v in fr["cols"].items()}
    if ref is not None and ref in fr["disp"]:
        row |= {c: float(v[i]) for c, v in fr["disp"][ref]["cols"].items()}
    return row
