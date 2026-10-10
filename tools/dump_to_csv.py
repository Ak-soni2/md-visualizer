"""Convert LAMMPS dump frames to the per-frame CSVs used by the existing Cutting_A_B cases on D:\\Akshay.

Reproduces D:\\Akshay\\Cutting_10_10\\AE\\2x100_mm_s-1_SiC_y94\\hpc_stream.py exactly:
  18 columns: Particle Identifier, Particle Type, Position X/Y/Z, Velocity X/Y/Z, Force X/Y/Z, c_s[1..6], Velocity Magnitude
  all particles (stride 1), values exactly as OVITO reads them, pandas default float formatting, CRLF line ends
  (the existing files on D: use CRLF; verified byte-for-byte, see below).
CSV frame K  <->  dump.cutsic.<500 + 500*K>.lammpstrj   (bible.md: dump 500 is frame 0, dumps are 500 steps apart).

Run with the venv that has ovito+pandas:
  D:\\Akshay\\.venv\\Scripts\\python.exe dump_to_csv.py --case Cutting_20_30 --plan
  D:\\Akshay\\.venv\\Scripts\\python.exe dump_to_csv.py --case Cutting_20_30            (writes into <case>\\csv_data)
  ... --out-dir <elsewhere> --frames 0,20 for a test run
Existing CSVs are never overwritten. Files are written as *.part and renamed when complete.
"""
import argparse
import glob
import os
import sys
import time
import warnings

warnings.filterwarnings("ignore")
import numpy as np
import pandas as pd
from ovito.io import import_file

ROOT = r"D:\Akshay"
FIRST_STEP, DUMP_EVERY = 500, 500


def find_dump_dir(case):
    for sub in (r"AE\2x100_mm_s-1_SiC_y94", "AE", ""):
        d = os.path.join(ROOT, case, sub) if sub else os.path.join(ROOT, case)
        if glob.glob(os.path.join(d, "dump.cutsic.*.lammpstrj")):
            return d
    raise SystemExit(f"no dump files found for {case}")


def step_of_frame(k):
    return FIRST_STEP + DUMP_EVERY * k


def dump_files_sorted(dump_dir):
    """All dump.cutsic.<step>.lammpstrj files, sorted by step: [(step, path), ...]. OVITO's wildcard import
    (hpc_stream.py) numbers frames the same way, so CSV frame K = element K of this list."""
    out = []
    for p in glob.glob(os.path.join(dump_dir, "dump.cutsic.*.lammpstrj")):
        base = os.path.basename(p)
        s = base[len("dump.cutsic."):-len(".lammpstrj")]
        if s.isdigit():
            out.append((int(s), p))
    return sorted(out)


def check_dump(path, expect_step):
    """Cheap integrity check without OVITO: header step, atom count, number of lines == atoms + 9."""
    with open(path, "rb") as f:
        head = [f.readline() for _ in range(9)]
        if head[0].strip() != b"ITEM: TIMESTEP" or int(head[1]) != expect_step:
            return False, f"header timestep {head[1].strip()!r} != {expect_step}"
        n = int(head[3])
        rest = 0
        while True:
            b = f.read(1 << 26)
            if not b:
                break
            rest += b.count(b"\n")
        # tail must end with newline; total lines = 9 + n
        if rest != n:
            return False, f"{rest} data lines but header says {n} atoms (truncated file?)"
    return True, n


def frame_to_df(path):
    pipeline = import_file(path)
    data = pipeline.compute(0)
    P = data.particles
    d = {
        "Particle Identifier": P.identifiers[::1],
        "Particle Type": P.particle_types[::1],
        "Position X": P.positions[::1][:, 0],
        "Position Y": P.positions[::1][:, 1],
        "Position Z": P.positions[::1][:, 2],
        "Velocity X": P["Velocity"][::1][:, 0],
        "Velocity Y": P["Velocity"][::1][:, 1],
        "Velocity Z": P["Velocity"][::1][:, 2],
        "Force X": P["Force"][::1][:, 0],
        "Force Y": P["Force"][::1][:, 1],
        "Force Z": P["Force"][::1][:, 2],
    }
    for i in range(1, 7):
        key = f"c_s[{i}]"
        if key in P:
            d[key] = P[key][::1]
    d["Velocity Magnitude"] = np.linalg.norm(P["Velocity"][::1], axis=1)
    return pd.DataFrame(d)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--case", required=True, help="e.g. Cutting_20_30")
    ap.add_argument("--frames", default="0:600:20", help="comma list or start:stop:step of CSV frame ids K")
    ap.add_argument("--out-dir", default=None, help="default: D:\\Akshay\\<case>\\csv_data")
    ap.add_argument("--mode", choices=["index", "step"], default="index",
                    help="index (default, = original workflow): frame K is the K-th existing dump file; step: frame K = dump 500+500K")
    ap.add_argument("--plan", action="store_true", help="only report which frames can be converted")
    ap.add_argument("--log", default=None)
    a = ap.parse_args()

    if ":" in a.frames:
        s, e, st = (int(x) for x in a.frames.split(":"))
        ks = list(range(s, e, st))
    else:
        ks = [int(x) for x in a.frames.split(",")]
    dump_dir = find_dump_dir(a.case)
    out_dir = a.out_dir or os.path.join(ROOT, a.case, "csv_data")
    logf = open(a.log, "a", encoding="utf-8") if a.log else None

    def say(msg):
        print(msg, flush=True)
        if logf:
            logf.write(msg + "\n")
            logf.flush()

    say(f"case {a.case}\n dumps : {dump_dir}\n output: {out_dir}\n mode  : {a.mode}")
    files = dump_files_sorted(dump_dir)
    steps_all = [s for s, _ in files]
    say(f" {len(files)} dump files, steps {steps_all[0]}..{steps_all[-1]}")
    gaps = [(a1, b1) for a1, b1 in zip(steps_all, steps_all[1:]) if b1 - a1 != DUMP_EVERY]
    if gaps or steps_all[0] != FIRST_STEP:
        say(f" NOTE: dump series is not contiguous (first step {steps_all[0]}, gaps: {gaps}); frame K = K-th existing file, "
            f"so frame ids do NOT equal (step-500)/500 here. Real steps are listed below.")
    status = []
    for k in ks:
        if a.mode == "index":
            if k >= len(files):
                status.append((k, None, None, "NO_SUCH_FRAME", f"only {len(files)} dump files"))
                continue
            step, p = files[k]
        else:                                   # "step": frame K <-> dump 500 + 500*K
            step = step_of_frame(k)
            p = os.path.join(dump_dir, f"dump.cutsic.{step}.lammpstrj")
            if not os.path.exists(p):
                status.append((k, step, p, "MISSING", None))
                continue
        ok, info = check_dump(p, step)
        status.append((k, step, p, "OK" if ok else "BAD", info))
    for k, step, p, st, info in status:
        say(f" frame {k:4d}  step {str(step):>7s}  {st:13s} {info if st != 'OK' else str(info) + ' atoms'}")
    todo = [x for x in status if x[3] == "OK"]
    bad = [x for x in status if x[3] != "OK"]
    say(f"convertible: {len(todo)}   not convertible: {len(bad)}")
    if a.plan:
        return
    os.makedirs(out_dir, exist_ok=True)
    t_all = time.time()
    for k, step, p, st, n in todo:
        final = os.path.join(out_dir, f"{a.case}_frame_{k}.csv")
        if os.path.exists(final):
            say(f" frame {k}: {os.path.basename(final)} already exists - skipped (never overwritten)")
            continue
        t = time.time()
        df = frame_to_df(p)
        if len(df) != n:
            say(f" frame {k}: ROW COUNT MISMATCH {len(df)} != {n} - not written")
            continue
        part = final + ".part"
        df.to_csv(part, index=False, lineterminator="\r\n")   # existing CSVs on D: use CRLF
        os.replace(part, final)
        say(f" frame {k:4d} step {step:7d} -> {os.path.basename(final)}  {len(df):,} rows  {os.path.getsize(final) / 1e6:.0f} MB  {time.time() - t:.0f} s")
    say(f"finished in {(time.time() - t_all) / 60:.1f} min; not converted: {[(x[0], x[3]) for x in bad]}")


if __name__ == "__main__":
    main()
