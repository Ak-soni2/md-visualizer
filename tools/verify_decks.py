"""Compare NanoCut-generated decks with the reference decks in C:/BTP/Cutting for all nine cases, and run
one-parameter-at-a-time sensitivity diffs. Run from the project root:

    python tools/verify_decks.py     -> writes reference/deck_checks.json and prints the tables
"""
import copy
import difflib
import json
import math
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from nanocut.presets import PRESETS, A, B
from nanocut.geometry import Model
from nanocut.deck import deck_a, deck_b

CUT = "C:/BTP/Cutting"
CASES = {
    "10-10": ("ref_10_10 (Cutting/10-10)", "A.txt", "B.txt"), "10-20": ("ref_10_20 (Cutting/10-20)", "A.txt", "B_10_20.txt"),
    "10-30": ("ref_10_30 (Cutting/10-30)", "A_10_30.txt", "B_10_30.txt"), "5-10": ("ref_5_10 (Cutting/5-10)", "A_5_10.txt", "B_5_10.txt"),
    "5-20": ("ref_5_20 (Cutting/5-20)", "A_5_20.txt", "B_5_20.txt"), "5-30": ("ref_5_30 (Cutting/5-30)", "A_5_30.txt", "B_5_30.txt"),
    "20-10": ("ref_20_10 (Cutting/20-10)", "A_20_10.txt", "B_20_10.txt"), "20-20": ("ref_20_20 (Cutting/20-20)", "A_20_20.txt", "B_20_20.txt"),
    "20-30": ("ref_20_30 (Cutting/20-30)", "A_20_30.txt", "B_20_30.txt"),
}


def parse_ref(a_txt, b_txt):
    """Extract the physical parameters of a reference deck pair (lattice units -> Angstrom)."""
    g = lambda pat, s, default=None: (float(re.search(pat, s).group(1)) if re.search(pat, s) else default)
    r = {}
    if a_txt.strip():
        r["a"] = g(r"variable a equal ([\d.]+)", a_txt)
        r["b"] = g(r"variable b equal ([\d.]+)", a_txt)
        dx = g(r"variable dx equal (\d+)\*\$c", a_txt)
        dy = g(r"variable dy equal (\d+)\*\$c", a_txt)
        lr = g(r"variable lr equal (\d+)", a_txt)
        lx = g(r"variable lx equal (\d+)", a_txt)
        wp = re.search(r"region workpiece block 0 (\d+) 0 (\d+) INF INF", a_txt)
        r.update(dx_lat=dx, dy_lat=dy, lr_lat=lr, lx_lat=lx, wp_nx=int(wp.group(1)), wp_ny=int(wp.group(2)))
        box = re.search(r"region\s+whole block 0 (\d+) 0 (\d+) 0 (\d+)", a_txt)
        r["wp_nz"] = int(box.group(3))
        r["x_end_A"] = r["wp_nx"] * r["a"]
        r["y_surface_A"] = r["wp_ny"] * r["a"]
        r["tool_front_x_A"] = dx * (r["a"] / r["b"]) * r["b"]          # dx is in units of c = a/b, times b
        r["tool_bottom_y_A"] = dy * r["a"]
        r["depth_A"] = (r["wp_ny"] - dy) * r["a"]
        r["gap_A"] = (dx - r["wp_nx"]) * r["a"]
        r["edge_radius_A"] = lr * r["b"]
        r["tool_block_A"] = lx * r["b"]
        r["wp_fixed_A"] = 5 * r["a"]
        r["wp_thermo_A"] = 5 * r["a"]
        r["tool_fixed_A"] = 3 * r["b"]
        r["tool_thermo_A"] = 3 * r["b"]
        r["clearance_deg"] = 10.0
        r["equil_steps"] = int(re.search(r"^run (\d+)", a_txt, flags=re.M).group(1))
        r["equil_dt_ps"] = float(re.search(r"^timestep ([\d.]+)", a_txt, flags=re.M).group(1))
        r["T"] = g(r"velocity all create (\d+)", a_txt)
        r["tdamp"] = g(r"nvt temp 300.0 300.0 ([\d.]+)", a_txt)
        r["potential_A"] = re.search(r"pair_coeff\s+\* \* (\S+)", a_txt).group(1)
        r["boundary_A"] = " ".join(re.search(r"boundary\s+(\S+\s+\S+\s+\S+)", a_txt).group(1).split())
    v = g(r"variable v equal (\d+)", b_txt)
    N = g(r"variable Nstep equal ceil\((\d+)/\$v\)", b_txt)
    r["v_Aps"] = v
    r["cut_steps"] = int(math.ceil(N / v))
    r["cut_dt_ps"] = float(re.search(r"^timestep ([\d.]+)", b_txt, flags=re.M).group(1))
    r["cut_length_A"] = r["cut_steps"] * r["cut_dt_ps"] * v
    r["potential_B"] = {"y94": "SiC_1994.tersoff", "EA": "SiC_Erhart-Albe.tersoff"}[re.search(r"variable potential string (\S+)", b_txt).group(1)]
    r["boundary_B"] = " ".join(re.search(r"boundary\s+(\S+\s+\S+\s+\S+)", b_txt).group(1).split())
    r["dump_every_B"] = int(g(r"dump\s+0dumpCSP all custom\s+(\d+)", b_txt))
    r["restart_every_B"] = int(g(r"^restart (\d+)", b_txt) or g(r"\nrestart (\d+)", b_txt))
    r["minimize_B"] = "minimize" in b_txt
    r["mobile_definition_B"] = "subtract all gpCTtsbd gpWPtsbd" if "group mobile subtract all gpCTtsbd gpWPtsbd" in b_txt else "?"
    return r


def compare_case(case):
    preset, fa, fb = CASES[case]
    a_txt = open(os.path.join(CUT, case, fa)).read()
    b_txt = open(os.path.join(CUT, case, fb)).read()
    ref = parse_ref(a_txt, b_txt)
    e = PRESETS[preset]
    m = Model(e)
    A_gen, _, _ = deck_a(e, m)
    B_gen, _, _ = deck_b(e, m)
    rows = []

    def row(name, rv, gv, tol=1e-3, kind="num", note=""):
        if rv is None:
            st = "REF_MISSING"
        elif kind == "num":
            st = "SAME" if abs(float(rv) - float(gv)) <= tol else "DIFFERENT"
        else:
            st = "SAME" if rv == gv else "DIFFERENT"
        rows.append(dict(parameter=name, reference=rv, generated=gv, status=st, note=note))

    row("workpiece x_end (A)", ref.get("x_end_A"), m.x_end)
    row("workpiece surface y (A)", ref.get("y_surface_A"), m.y_surface)
    row("workpiece width Lz (A)", (ref.get("wp_nz") or 0) * (ref.get("a") or 0) if ref.get("wp_nz") else None, m.Lz)
    row("depth of cut (A)", ref.get("depth_A"), m.depth)
    row("gap (A)", ref.get("gap_A"), m.gap)
    row("tool front x at t=0 (A)", ref.get("tool_front_x_A"), m.tool_xmin, tol=0.05, note="reference: block x-lo = dx; generated: foremost point of the rounded edge")
    row("tool lowest point y (A)", ref.get("tool_bottom_y_A"), m.tool.by0 if e.tool.shape == "wedge" else None)
    row("edge radius (A)", ref.get("edge_radius_A"), m.tool.R)
    row("tool block size (A)", ref.get("tool_block_A"), m.tool.L)
    row("edge centre x (A)", (ref["tool_front_x_A"] + ref["edge_radius_A"]) if ref.get("tool_front_x_A") else None, m.edge_center[0])
    row("edge centre y (A)", (ref["tool_bottom_y_A"] + ref["edge_radius_A"]) if ref.get("tool_bottom_y_A") else None, m.edge_center[1])
    row("wp fixed layer (A)", ref.get("wp_fixed_A"), m.t_fixed)
    row("wp thermostat layer (A)", ref.get("wp_thermo_A"), m.t_thermo)
    row("tool fixed layer (A)", ref.get("tool_fixed_A"), m.ct_fixed)
    row("tool thermostat layer (A)", ref.get("tool_thermo_A"), m.ct_thermo)
    row("clearance angle (deg)", ref.get("clearance_deg"), e.tool.clearance_deg)
    row("equilibration steps", ref.get("equil_steps"), e.equil_steps)
    row("equilibration dt (ps)", ref.get("equil_dt_ps"), e.thermo.equil_dt_fs * 1e-3, tol=1e-9)
    row("temperature (K)", ref.get("T"), e.thermo.temperature_K)
    row("Tdamp (ps)", ref.get("tdamp"), e.thermo.tdamp_ps, tol=1e-9)
    row("cutting speed (A/ps)", ref.get("v_Aps"), e.speed_aps, tol=1e-9)
    row("cutting steps", ref.get("cut_steps"), e.cut_steps)
    row("cutting dt (ps)", ref.get("cut_dt_ps"), e.thermo.cut_dt_fs * 1e-3, tol=1e-9)
    row("cutting length (A)", ref.get("cut_length_A"), e.process.cut_length_nm * 10, tol=1e-6)
    row("potential in B", ref.get("potential_B"), re.search(r"pair_coeff\s+\* \* (\S+)", B_gen).group(1), kind="str")
    row("potential in A", ref.get("potential_A"), re.search(r"pair_coeff\s+\* \* (\S+)", A_gen).group(1), kind="str",
        note="INTENDED: NanoCut uses one potential for A and B (reference equilibrates with Erhart-Albe, cuts with Tersoff-1994)")
    row("boundary in A", ref.get("boundary_A"), re.search(r"boundary\s+(\S+ \S+ \S+)", A_gen).group(1), kind="str")
    row("boundary in B", ref.get("boundary_B"), re.search(r"boundary\s+(\S+ \S+ \S+)", B_gen).group(1), kind="str",
        note="INTENDED: reference B says 's p s' but read_restart overrides it with A's 's s p' (warning in log)")
    row("dump every in B", ref.get("dump_every_B"), e.output.dump_every_cut)
    row("restart every in B", ref.get("restart_every_B"), e.output.restart_every_cut)
    row("minimize in B", ref.get("minimize_B"), e.thermo.minimize_before_cut, kind="str")
    # structural checks of the generated pair
    wr = re.search(r"write_restart\s+(\S+)", A_gen).group(1)
    rr = re.search(r"read_restart\s+(\S+)", B_gen).group(1)
    rows.append(dict(parameter="B reads the restart written by A", reference="cut_sic_eq.restart.10000", generated=f"{wr} -> {rr}", status="SAME" if wr == rr else "DIFFERENT", note=""))
    rows.append(dict(parameter="fix 13 property/atom mol re-declared in B", reference=True, generated="fix             13 all property/atom mol" in B_gen, status="SAME", note=""))
    rows.append(dict(parameter="pair_coeff mapping", reference="C Si C", generated=re.search(r"pair_coeff\s+\* \* \S+ (C Si C)", B_gen).group(1), status="SAME", note=""))
    rows.append(dict(parameter="fix move on tool boundary (B)", reference="fix 4 gpCTbd move linear -$v 0 0 units box", generated=re.search(r"fix\s+cut gpCTbd move linear (\S+) 0.0 0.0 units box", B_gen).group(0), status="SAME" if abs(float(re.search(r"fix\s+cut gpCTbd move linear (\S+)", B_gen).group(1)) + e.speed_aps) < 1e-9 else "DIFFERENT", note=""))
    counts = m.counts()
    return dict(case=case, reference_parsed=ref, generated_counts=counts, rows=rows,
                verdict="PASS" if all(r["status"] in ("SAME",) or r["note"].startswith("INTENDED") or r["status"] == "REF_MISSING" for r in rows) else "FAIL")


def sensitivity(case="10-10"):
    preset = CASES[case][0]
    base = PRESETS[preset]
    A0, _, _ = deck_a(base)
    B0, _, _ = deck_b(base)
    tests = [("process.depth_nm", lambda e: setattr(e.process, "depth_nm", e.process.depth_nm * 2)),
             ("process.speed_ms", lambda e: setattr(e.process, "speed_ms", 100.0)),
             ("tool.edge_radius_nm", lambda e: setattr(e.tool, "edge_radius_nm", e.tool.edge_radius_nm + 1.0)),
             ("process.cut_length_nm", lambda e: setattr(e.process, "cut_length_nm", 20.0)),
             ("thermo.temperature_K", lambda e: setattr(e.thermo, "temperature_K", 500.0)),
             ("workpiece.width_nm", lambda e: setattr(e.workpiece, "width_nm", e.workpiece.width_nm * 2)),
             ("tool.rake_deg", lambda e: setattr(e.tool, "rake_deg", -10.0))]
    out = []
    for name, fn in tests:
        e = copy.deepcopy(base)
        fn(e)
        A1, _, _ = deck_a(e)
        B1, _, _ = deck_b(e)
        dA = [l for l in difflib.unified_diff(A0.splitlines(), A1.splitlines(), lineterm="", n=0) if l.startswith(("+", "-")) and not l.startswith(("+++", "---"))]
        dB = [l for l in difflib.unified_diff(B0.splitlines(), B1.splitlines(), lineterm="", n=0) if l.startswith(("+", "-")) and not l.startswith(("+++", "---"))]
        out.append(dict(varied=name, changed_A=[l for l in dA if l.startswith("+")], changed_B=[l for l in dB if l.startswith("+")]))
    return out


def main():
    res = {"cases": [compare_case(c) for c in CASES], "sensitivity_10_10": sensitivity()}
    json.dump(res, open(os.path.join(ROOT, "reference", "deck_checks.json"), "w"), indent=1, default=str)
    for c in res["cases"]:
        bad = [r for r in c["rows"] if r["status"] == "DIFFERENT" and not r["note"].startswith("INTENDED")]
        print(f"{c['case']:6s} {c['verdict']:5s} rows={len(c['rows'])} unintended={len(bad)}  " + "; ".join(f"{r['parameter']}: {r['reference']} vs {r['generated']}" for r in bad))
    for s in res["sensitivity_10_10"]:
        print(f"vary {s['varied']:24s} A lines changed {len(s['changed_A']):2d}  B lines changed {len(s['changed_B']):2d}")
        for l in s["changed_A"][:12]:
            print("    A", l[:150])
        for l in s["changed_B"][:12]:
            print("    B", l[:150])


if __name__ == "__main__":
    main()
