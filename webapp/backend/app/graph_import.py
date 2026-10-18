"""Graph Studio import: turn whatever file the user has into plottable tables (PLAN_PHASE3.md §4.1).

- LAMMPS dump (one file with many frames, or several files): one row per frame with count, mean, std, min, max of every
  numeric column, sums of fx/fy/fz, and the means per particle type (e.g. the tool's force sum = cutting force);
- per-atom CSV (an exported frame: id, type, x, … columns): the same per-frame row, plus an "atoms" table (every atom,
  or a regular sub-sample above 20,000 atoms) for scatter plots such as stress vs depth;
- ZIP (e.g. "Download CSVs as ZIP" of the OVITO page): every frame CSV → one row per frame; other tables inside as well;
- Excel (.xlsx, e.g. the frame-statistics workbook): one table per sheet;
- LAMMPS log (thermo tables), fix ave/time files, any CSV/TSV/whitespace table with a header.
Returns {datasets: [{label, format, kind, columns: {name: [values]}, note}]}. Nothing is written to disk.
"""
import io
import os
import re
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd
from fastapi import APIRouter, Body, HTTPException, Request

from .settings import HOSTED

router = APIRouter(prefix="/api/graphs", tags=["graphs"])
MAX_BYTES = int(os.environ.get("NANOCUT_GRAPH_IMPORT_MAX", str(4 << 30)))
ATOM_SAMPLE = 20_000
FORCE = ("fx", "fy", "fz")


def _clean(v):
    a = np.asarray(v, dtype=np.float64)
    return [None if not np.isfinite(x) else float(f"{x:.7g}") for x in a]


def frame_row(df, frame, step=None):
    """One row of per-frame statistics of a per-atom table."""
    row = {"frame": frame}
    if step is not None:
        row["step"] = step
    num = df.select_dtypes(include=[np.number])
    row["atoms"] = len(df)
    for c in num.columns:
        if c in ("id", "frame", "type", "mol"):
            continue
        v = num[c].to_numpy(dtype=np.float64)
        v = v[np.isfinite(v)]
        if not len(v):
            continue
        row[f"{c} mean"], row[f"{c} std"], row[f"{c} min"], row[f"{c} max"] = v.mean(), v.std(), v.min(), v.max()
        if c in FORCE:
            row[f"{c} sum"] = v.sum()
    if "type" in num.columns:
        for t, g in num.groupby("type"):
            t = int(t)
            row[f"atoms (type {t})"] = len(g)
            for c in g.columns:
                if c in ("id", "type", "mol"):
                    continue
                v = g[c].to_numpy(dtype=np.float64)
                v = v[np.isfinite(v)]
                if len(v):
                    row[f"{c} mean (type {t})"] = v.mean()
                    if c in FORCE:
                        row[f"{c} sum (type {t})"] = v.sum()
                        row[f"{c} sum (type {t}) [nN]"] = v.sum() * 1.602176634
    return row


def _rows_to_table(rows, label, fmt, note=""):
    rows = sorted(rows, key=lambda r: r["frame"])
    cols = list(dict.fromkeys(k for r in rows for k in r))
    return dict(label=label, format=fmt, kind="frames", note=note, columns={c: _clean([r.get(c, np.nan) for r in rows]) for c in cols})


def _atoms_table(df, label):
    n = len(df)
    k = max(1, int(np.ceil(n / ATOM_SAMPLE)))
    if "id" in df.columns:
        df = df.sort_values("id")
    sub = df.iloc[::k].select_dtypes(include=[np.number])
    return dict(label=f"{label} · atoms", format="per-atom table" + (f" (every {k}th of {n:,} atoms)" if k > 1 else ""), kind="atoms",
                columns={c: _clean(sub[c]) for c in sub.columns})


def is_atom_table(df):
    cols = {c.lower() for c in df.columns}
    return {"type"} <= cols and ({"x", "xu", "xs"} & cols or "position.x" in cols) and len(df) > 50


def read_dump(text_or_bytes):
    """Every frame of a LAMMPS text dump: [(step, DataFrame)]."""
    data = text_or_bytes.decode("utf-8", "replace") if isinstance(text_or_bytes, bytes) else text_or_bytes
    out = []
    for m in re.finditer(r"ITEM: TIMESTEP\s+(\d+)\s+ITEM: NUMBER OF ATOMS\s+(\d+)\s+ITEM: BOX BOUNDS[^\n]*\n(?:[^\n]*\n){3}ITEM: ATOMS ([^\n]*)\n", data):
        step, n, cols = int(m.group(1)), int(m.group(2)), m.group(3).split()
        start = m.end()
        end = data.find("ITEM: TIMESTEP", start)
        df = pd.read_csv(io.StringIO(data[start:end if end >= 0 else len(data)]), sep=r"\s+", header=None, names=cols, nrows=n)
        out.append((step, df))
    return out


def parse(name, raw):
    """All datasets found in one file."""
    low = name.lower()
    stem = re.sub(r"\.(zip|xlsx|xls|csv|tsv|txt|dat|log|lammpstrj|dump|gz)$", "", Path(name).name, flags=re.I)
    if low.endswith(".gz"):
        import gzip
        raw = gzip.decompress(raw)
        low = low[:-3]
    if raw[:2] == b"PK" and (low.endswith((".xlsx", ".xlsm")) or b"xl/workbook" in raw[:4000]):
        return _excel(raw, stem)
    if raw[:2] == b"PK":
        return _zip(raw, stem)
    head = raw[:4000].decode("utf-8", "replace")
    if "ITEM: TIMESTEP" in head:
        frames = read_dump(raw)
        if not frames:
            raise ValueError("LAMMPS dump without a complete frame")
        rows = [frame_row(df, i, step) for i, (step, df) in enumerate(frames)]
        out = [_rows_to_table(rows, f"{stem} · per frame", f"LAMMPS dump, {len(frames)} frame(s)",
                              "Per-frame statistics of every dump column. For stresses, temperatures, RDF … use OVITO → Research (or Graphs → Analyse dumps…).")]
        out.append(_atoms_table(frames[-1][1], f"{stem} · last frame"))
        return out
    return _text(raw.decode("utf-8", "replace"), stem)


def _text(text, stem):
    from nanocut import analysis
    import tempfile
    if re.search(r"^\s*Step\s", text, re.M) and "Loop time" in text:
        with tempfile.NamedTemporaryFile("w", suffix=".log", delete=False, encoding="utf-8") as f:
            f.write(text)
        try:
            tables = analysis.read_log_thermo(f.name)
        finally:
            os.unlink(f.name)
        return [dict(label=f"{stem} · run {i + 1}" if len(tables) > 1 else stem, format="LAMMPS log thermo", kind="table",
                     columns={n: _clean(a[:, k]) for k, n in enumerate(names)}) for i, (names, a) in enumerate(tables) if len(a)]
    m = re.search(r"^#\s*(step|timestep|time)\s([^\n]*)$", text, re.M | re.I)
    if m:
        names = [m.group(1)] + m.group(2).split()
        rows = [l.split() for l in text.splitlines() if l.strip() and not l.startswith("#")]
        rows = [[float(x) for x in r] for r in rows if len(r) == len(names) and all(re.fullmatch(r"[-+0-9.eE]+|nan|inf", x, re.I) for x in r)]
        a = np.array(rows).reshape(-1, len(names))
        return [dict(label=stem, format="LAMMPS fix ave/time", kind="table", columns={n: _clean(a[:, k]) for k, n in enumerate(names)})]
    df = pd.read_csv(io.StringIO(text), sep=None, engine="python", comment=None)
    df = df.loc[:, [c for c in df.columns if not str(c).startswith("Unnamed")]]
    num = df.apply(pd.to_numeric, errors="coerce")
    keep = [c for c in num.columns if num[c].notna().mean() > 0.8]
    if not keep:
        raise ValueError("no numeric columns")
    num = num[keep]
    if is_atom_table(num):
        return [_rows_to_table([frame_row(num, 0)], f"{stem} · statistics", "per-atom CSV (one frame)"), _atoms_table(num, stem)]
    return [dict(label=stem, format="table", kind="table", columns={str(c): _clean(num[c]) for c in num.columns})]


def _zip(raw, stem):
    z = zipfile.ZipFile(io.BytesIO(raw))
    rows, out, frames_seen = [], [], 0
    last = None
    for info in sorted(z.infolist(), key=lambda i: [int(x) if x.isdigit() else x for x in re.split(r"(\d+)", i.filename)]):
        if info.is_dir():
            continue
        data = z.read(info)
        name = Path(info.filename).name
        try:
            if name.lower().endswith(".csv"):
                df = pd.read_csv(io.BytesIO(data))
                num = df.select_dtypes(include=[np.number])
                if is_atom_table(num):
                    m = re.search(r"(\d+)(?=\D*$)", name)
                    rows.append(frame_row(num, int(m.group(1)) if m else frames_seen))
                    frames_seen += 1
                    last = (num, name)
                    continue
            out += parse(name, data)
        except Exception as e:                                   # one unreadable file must not hide the rest
            out.append(dict(label=f"{stem}/{name}", format="unreadable", kind="error", columns={}, note=str(e)))
    if rows:
        out.insert(0, _rows_to_table(rows, f"{stem} · per frame", f"ZIP of {len(rows)} frame CSV(s)",
                                     "Per-frame statistics of every column of each exported frame (mean, std, min, max; force sums; per type)."))
        out.insert(1, _atoms_table(last[0], f"{stem} · {last[1]}"))
    return out


def _excel(raw, stem):
    import openpyxl
    wb = openpyxl.load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
    out = []
    for ws in wb.worksheets:
        rows = [list(r) for r in ws.iter_rows(values_only=True)]
        hdr = next((i for i, r in enumerate(rows[:20]) if sum(isinstance(c, str) and c.strip() != "" for c in r) >= 2), None)
        if hdr is None:
            continue
        names = [str(c) if c is not None else f"col{k}" for k, c in enumerate(rows[hdr])]
        body = rows[hdr + 1:]
        cols = {}
        for k, n in enumerate(names):
            vals = [r[k] if k < len(r) else None for r in body]
            nums = [v for v in vals if isinstance(v, (int, float))]
            if vals and len(nums) >= 0.8 * sum(v is not None for v in vals) and nums:
                cols[n] = _clean([v if isinstance(v, (int, float)) else np.nan for v in vals])
        if len(cols) >= 2:
            out.append(dict(label=f"{stem} · {ws.title}", format="Excel sheet", kind="table", columns=cols))
    return out


def _result(name, raw):
    try:
        ds = parse(name, raw)
    except Exception as e:
        raise HTTPException(422, f"{name}: {e}")
    ds = [d for d in ds if d.get("columns") or d.get("kind") == "error"]
    if not any(d.get("columns") for d in ds):
        raise HTTPException(422, f"{name}: no numeric table found")
    return dict(datasets=ds)


@router.post("/import")
async def import_upload(request: Request, name: str):
    """Raw file bytes in the body; `name` = file name."""
    raw = await request.body()
    if len(raw) > MAX_BYTES:
        raise HTTPException(413, "file too large")
    return _result(name, raw)


@router.post("/import-path")
def import_path(body: dict = Body(...)):
    """{path} of a file on this computer (local backend only; avoids uploading large files)."""
    if HOSTED:
        raise HTTPException(403, "only with a local backend")
    p = Path(str(body.get("path") or ""))
    if not p.is_file():
        raise HTTPException(404, f"not a file: {p}")
    if p.stat().st_size > MAX_BYTES:
        raise HTTPException(413, "file too large")
    return _result(p.name, p.read_bytes())
