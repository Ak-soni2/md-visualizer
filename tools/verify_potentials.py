"""Verify every shipped potential file by computing the equilibrium lattice constant and cohesive energy in LAMMPS
and comparing with the published / experimental values. Run from the project root:

    python tools/verify_potentials.py        -> writes reference/potential_checks.json and prints a table

Reference values: experiment (Kittel; Haynes CRC) and the values quoted by the potential authors.
"""
import json
import os
import sys
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from nanocut.runner import run_lammps
from nanocut.deck import POT_DIR
import shutil

# (file, pair_style, structure, elements per type, a_guess, pair_coeff tokens, reference a0, reference Ecoh eV/atom, ref source)
CASES = [
    ("SiC_1994.tersoff", "tersoff", "zincblende", ["Si", "C"], 4.32, "Si C", 4.3596, 6.34, "expt a0 (Haynes); Ecoh 6.34 eV/atom (Erhart-Albe 2005 Table IV, expt)"),
    ("SiC_1989.tersoff", "tersoff", "zincblende", ["Si", "C"], 4.32, "Si C", 4.3596, 6.34, "expt; Tersoff 1989 gives a0=4.32 by design"),
    ("SiC_1990.tersoff", "tersoff", "zincblende", ["Si", "C"], 4.32, "Si C", 4.3596, 6.34, "expt"),
    ("SiC.tersoff", "tersoff", "zincblende", ["Si", "C"], 4.32, "Si C", 4.3596, 6.34, "expt; Tersoff 1989 + errata"),
    ("SiC_Erhart-Albe.tersoff", "tersoff", "zincblende", ["Si", "C"], 4.36, "Si C", 4.359, 6.340, "Erhart & Albe 2005 Table IV: a0=4.359, Ecoh=6.340 eV/atom (fit)"),
    ("SiC.tersoff.zbl", "tersoff/zbl", "zincblende", ["Si", "C"], 4.32, "Si C", 4.3596, 6.34, "expt; Devanathan 1998 = Tersoff + ZBL core"),
    ("SiC.vashishta", "vashishta", "zincblende", ["Si", "C"], 4.36, "Si C", 4.36, 6.34, "Vashishta 2007: a0=4.36 (fit)"),
    ("SiC_1994.tersoff", "tersoff", "diamond", ["C"], 3.57, "C", 3.567, 7.37, "expt diamond (Kittel)"),
    ("SiC.tersoff", "tersoff", "diamond", ["C"], 3.57, "C", 3.567, 7.37, "expt diamond"),
    ("SiC_Erhart-Albe.tersoff", "tersoff", "diamond", ["C"], 3.57, "C", 3.566, 7.374, "Erhart-Albe 2005 Table: diamond a0=3.566, Ecoh=7.374"),
    ("SiC.tersoff", "tersoff", "diamond", ["Si"], 5.43, "Si", 5.431, 4.63, "expt Si (Kittel)"),
    ("Si.sw", "sw", "diamond", ["Si"], 5.43, "Si", 5.431, 4.337, "SW 1985: a0=5.431 (fit), Ecoh=4.3366 eV/atom (fit)"),
    ("Si.tersoff", "tersoff", "diamond", ["Si"], 5.43, "Si", 5.432, 4.63, "Tersoff 1988: a0=5.432, Ecoh=4.63"),
    ("Si.tersoff.mod", "tersoff/mod", "diamond", ["Si"], 5.43, "Si", 5.429, 4.63, "Kumagai 2007: a0=5.429, Ecoh=4.63"),
    ("SiCGe.tersoff", "tersoff", "diamond", ["Ge"], 5.66, "Ge", 5.658, 3.85, "expt Ge (Kittel); Tersoff 1989 Ge"),
    ("SiCGe.tersoff", "tersoff", "diamond", ["Si"], 5.43, "Si(D)", 5.432, 4.63, "Tersoff 1989 Si(D)"),
    ("Cu_mishin1.eam.alloy", "eam/alloy", "fcc", ["Cu"], 3.62, "Cu", 3.615, 3.54, "Mishin 2001: a0=3.615, Ecoh=3.54 (fit = expt)"),
    ("Cu_zhou.eam.alloy", "eam/alloy", "fcc", ["Cu"], 3.62, "Cu", 3.615, 3.54, "Zhou 2004 Table: a0=3.615, Ec=3.54"),
    ("Cu_u3.eam", "eam", "fcc", ["Cu"], 3.62, "", 3.615, 3.54, "Foiles 1986: a0=3.615, Ecoh=3.54"),
    ("Al_zhou.eam.alloy", "eam/alloy", "fcc", ["Al"], 4.05, "Al", 4.05, 3.36, "Zhou 2004: a0=4.05, Ec=3.36"),
    ("Al_mm.eam.fs", "eam/fs", "fcc", ["Al"], 4.05, "Al", 4.045, 3.36, "Mendelev 2008 Al: a0=4.045 (fit), Ecoh 3.36"),
    ("Ni_u3.eam", "eam", "fcc", ["Ni"], 3.52, "", 3.52, 4.45, "Foiles 1986: a0=3.52, Ecoh=4.45"),
    ("Au_u3.eam", "eam", "fcc", ["Au"], 4.08, "", 4.08, 3.93, "Foiles 1986: a0=4.08, Ecoh=3.93"),
    ("Ag_u3.eam", "eam", "fcc", ["Ag"], 4.09, "", 4.09, 2.85, "Foiles 1986: a0=4.09, Ecoh=2.85"),
    ("Fe_mm.eam.fs", "eam/fs", "bcc", ["Fe"], 2.86, "Fe", 2.8553, 4.122, "Mendelev 2003 potential 2: a0=2.8553, Ecoh=4.122 (fit)"),
    ("W_zhou.eam.alloy", "eam/alloy", "bcc", ["W"], 3.165, "W", 3.165, 8.89, "Zhou 2004: a0=3.165, Ec=8.89"),
]
MASS = {"Si": 28.0855, "C": 12.011, "Ge": 72.63, "Cu": 63.546, "Al": 26.9815, "Ni": 58.6934, "Au": 196.9666, "Ag": 107.8682, "Fe": 55.845, "W": 183.84}


def deck(file, style, structure, elems, a, tokens):
    n = 3
    L = ["units metal", "atom_style atomic", "boundary p p p"]
    if structure == "zincblende":
        L += [f"lattice fcc {a}", f"region box block 0 {n} 0 {n} 0 {n}", "create_box 2 box", "create_atoms 1 box",
              f"lattice fcc {a} origin 0.25 0.25 0.25", "create_atoms 2 box"]
    else:
        L += [f"lattice {structure} {a}", f"region box block 0 {n} 0 {n} 0 {n}", f"create_box {len(elems)} box", "create_atoms 1 box"]
    for i, e in enumerate(elems, 1):
        L.append(f"mass {i} {MASS[e]}")
    L.append(f"pair_style {style}")
    if style == "eam":
        L.append(f"pair_coeff 1 1 {file}")
    else:
        L.append(f"pair_coeff * * {file} {tokens}")
    L += ["fix 1 all box/relax iso 0.0 vmax 0.001", "min_style cg", "minimize 1e-12 1e-12 10000 100000",
          f"variable a0 equal lx/{n}", "variable ec equal -pe/atoms", 'print "RESULT a0 = ${a0} Ecoh = ${ec}"']
    return "\n".join(L) + "\n"


def main():
    out = []
    base = os.path.join(ROOT, "runs", "verify_potentials")
    for i, (f, style, struct, elems, a, tok, ra, re_, src) in enumerate(CASES):
        wd = os.path.join(base, f"{i:02d}_{f}_{struct}_{'_'.join(elems)}")
        os.makedirs(wd, exist_ok=True)
        shutil.copy(os.path.join(POT_DIR, f), wd)
        open(os.path.join(wd, "in.test"), "w", newline="\n").write(deck(f, style, struct, elems, a, tok))
        rc, so, log = run_lammps(wd, "in.test", "log.test", np=1, timeout=900)
        m = re.search(r"^RESULT a0 = ([-\d.e+]+) Ecoh = ([-\d.e+]+)", log + so, flags=re.M)
        err = re.findall(r"^ERROR.*$", log + so, flags=re.M)
        rec = dict(file=f, style=style, structure=struct, elements=elems, tokens=tok, ref_a0=ra, ref_Ecoh=re_, source=src,
                   a0=float(m.group(1)) if m else None, Ecoh=float(m.group(2)) if m else None, error=err[:1])
        if m:
            rec["a0_dev_pct"] = 100 * (rec["a0"] - ra) / ra
            rec["Ecoh_dev_pct"] = 100 * (rec["Ecoh"] - re_) / re_
        out.append(rec)
        print(f"{f:26s} {struct:10s} {'/'.join(elems):6s} a0={rec['a0']}  Ecoh={rec['Ecoh']}  ref {ra}/{re_}  {err[:1]}", flush=True)
    json.dump(out, open(os.path.join(ROOT, "reference", "potential_checks.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
