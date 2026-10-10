"""Generate the LAMMPS input files (A + B + potential + run scripts) from a parameter file, without the UI.

Usage (from the project root, inside the virtual environment):
    python make_decks.py --preset "ref_10_10 (Cutting/10-10)" --out runs/my_case
    python make_decks.py --params my_params.json --out runs/my_case
    python make_decks.py --list                      # show preset names
    python make_decks.py --preset "..." --set process.depth_nm=2.0 --set process.speed_ms=100 --out runs/d2_v100

--set overrides any field of the experiment (dotted path = value). The run folder contains A.in, B.in, the potential
file, run.sh / run.bat, params.json (full provenance) and README.md.
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nanocut.presets import PRESETS
from nanocut.schema import Experiment, validate
from nanocut.deck import write_run_folder


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--preset", help="preset name (see --list)")
    ap.add_argument("--params", help="params.json written by the UI or by an earlier run")
    ap.add_argument("--set", action="append", default=[], help="override, e.g. process.depth_nm=2.0")
    ap.add_argument("--out", default="runs/case", help="output folder")
    ap.add_argument("--list", action="store_true")
    a = ap.parse_args()
    if a.list:
        for k in PRESETS:
            print(k)
        return
    if a.params:
        d = json.load(open(a.params))
        exp = Experiment.from_dict(d.get("experiment", d))
    else:
        exp = PRESETS[a.preset or next(iter(PRESETS))]
    for s in a.set:
        path, val = s.split("=", 1)
        obj = exp
        parts = path.split(".")
        for p in parts[:-1]:
            obj = getattr(obj, p)
        cur = getattr(obj, parts[-1])
        if isinstance(cur, bool):
            val = val.lower() in ("1", "true", "yes")
        elif isinstance(cur, int) and not isinstance(cur, bool):
            val = int(float(val))
        elif isinstance(cur, float):
            val = float(val)
        elif isinstance(cur, tuple):
            val = tuple(int(x) for x in val.replace(",", " ").split())
        setattr(obj, parts[-1], val)
    errs = validate(exp)
    if errs:
        sys.exit("invalid parameters: " + "; ".join(errs))
    r = write_run_folder(exp, a.out)
    print(f"written to {r['dir']}: A.in, B.in, potential file(s), run.sh, run.bat, params.json, README.md")
    print("atoms:", r["counts"])
    for w in r["warnings"]:
        print("warning:", w)


if __name__ == "__main__":
    main()
