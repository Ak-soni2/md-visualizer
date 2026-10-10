"""Read-only integrity check of the CSVs written by dump_to_csv.py.
For every csv_data/<case>_frame_K.csv: header line, CRLF, rows == atoms in the source dump header, no .part files,
and 5 random atoms compared value-by-value (as numbers) against the raw dump line of the same particle id."""
import glob
import os
import random
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dump_to_csv import find_dump_dir, dump_files_sorted

HEADER = ("Particle Identifier,Particle Type,Position X,Position Y,Position Z,Velocity X,Velocity Y,Velocity Z,"
          "Force X,Force Y,Force Z,c_s[1],c_s[2],c_s[3],c_s[4],c_s[5],c_s[6],Velocity Magnitude")


def count_lines(path):
    n = 0
    with open(path, "rb") as f:
        last = b""
        while True:
            b = f.read(1 << 26)
            if not b:
                break
            n += b.count(b"\n")
            last = b[-2:]
    return n, last


def main(cases):
    random.seed(1)
    bad = 0
    for case in cases:
        files = dump_files_sorted(find_dump_dir(case))
        out = os.path.join(r"D:\Akshay", case, "csv_data")
        parts = glob.glob(os.path.join(out, "*.part"))
        csvs = sorted(glob.glob(os.path.join(out, f"{case}_frame_*.csv")), key=lambda p: int(re.search(r"_frame_(\d+)\.csv", p).group(1)))
        print(f"== {case}: {len(csvs)} CSVs, {len(parts)} .part files")
        for p in csvs:
            k = int(re.search(r"_frame_(\d+)\.csv", p).group(1))
            step, dump = files[k]
            with open(dump, "rb") as f:
                for _ in range(3):
                    f.readline()
                natoms = int(f.readline())
            with open(p, "rb") as f:
                head = f.readline()
            lines, tail = count_lines(p)
            ok = head.rstrip(b"\r\n").decode() == HEADER and head.endswith(b"\r\n") and tail == b"\r\n" and lines == natoms + 1
            # spot check 5 random atoms against the raw dump (numeric equality of the 17 shared values)
            sample = random.sample(range(1, natoms + 1), 5)
            want = set(sample)
            with open(p, "rb") as f:
                f.readline()
                rows = {}
                for i, line in enumerate(f, start=1):
                    if i in want:
                        rows[i] = line.decode().rstrip("\r\n").split(",")
                    if len(rows) == 5:
                        break
            with open(dump, "rb") as f:
                for _ in range(8):
                    f.readline()
                cols = f.readline().decode().split()[2:]
                dl = {}
                for i, line in enumerate(f, start=1):
                    if i in want:
                        dl[i] = line.decode().split()
                    if len(dl) == 5:
                        break
            idx = {c: j for j, c in enumerate(cols)}
            src = ["id", "type", "x", "y", "z", "vx", "vy", "vz", "fx", "fy", "fz", "c_s[1]", "c_s[2]", "c_s[3]", "c_s[4]", "c_s[5]", "c_s[6]"]
            same = all(abs(float(rows[i][j]) - float(dl[i][idx[c]])) <= 1e-12 * max(1.0, abs(float(dl[i][idx[c]]))) for i in sample for j, c in enumerate(src))
            flag = "ok " if (ok and same) else "BAD"
            if flag == "BAD":
                bad += 1
            print(f" {flag} frame {k:4d} (dump step {step:6d}): {lines - 1:,} rows / {natoms:,} atoms, header+CRLF {'ok' if ok else 'WRONG'}, 5 atoms vs raw dump {'identical' if same else 'DIFFER'}", flush=True)
    print("RESULT:", "ALL FILES OK" if bad == 0 else f"{bad} FILES FAILED")


if __name__ == "__main__":
    main(sys.argv[1:] or ["Cutting_20_30", "Cutting_5_30"])
