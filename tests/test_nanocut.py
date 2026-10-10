"""Regression checks. Run:  python -m tests.test_nanocut   (from the project root)

Golden numbers come from C:/BTP/Cutting/10-10/log.txt (LAMMPS 2 Aug 2023, 1 993 337 atoms).
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from nanocut.schema import Experiment, validate
from nanocut.presets import PRESETS
from nanocut.geometry import Model
from nanocut.deck import deck_a, deck_b, write_run_folder
from nanocut.potentials import pair_block
from nanocut import runner

REF = dict(workpiece=1589769, wp_bd=119169, wp_mob=1360800, wp_ts_ref_overlapping=115389, overlap=5589, tool=403568)


def test_reference_counts():
    e = PRESETS["ref_10_10 (Cutting/10-10)"]
    m = Model(e)
    c = m.counts()
    assert c["workpiece"] == REF["workpiece"], c
    assert c["wp_bd"] == REF["wp_bd"], c
    assert c["wp_mob"] == REF["wp_mob"], c
    assert c["wp_ts"] == REF["wp_ts_ref_overlapping"] - REF["overlap"], c      # reference groups overlapped; ours are disjoint
    assert abs(c["tool"] - REF["tool"]) / REF["tool"] < 0.005, c                  # tangent-plane flank vs reference prism offset
    assert abs(m.x_end - 220 * 4.3667) < 1e-6 and abs(m.y_surface - 100 * 4.3667) < 1e-6
    assert abs(m.edge_center[1] - (97 * 4.3667 + 10 * 3.571)) < 1e-6              # dy + lr in reference lattice units
    assert abs(m.edge_center[0] - (220 * 4.3667 + 10 * 3.571)) < 1e-6              # dx + lr: tool front at the workpiece end (gap 0)
    assert abs(m.tool_xmin - 220 * 4.3667) < 1e-6


def test_laser_and_boundary_decks():
    import copy
    e = copy.deepcopy(PRESETS["ref_10_10 (Cutting/10-10)"])
    e.laser.mode = "spot"
    b, _, _ = deck_b(e)
    assert "group           laserzone dynamic gpWPmob region laser every 10" in b and "fix             laser laserzone langevin" in b
    assert b.index("compute         Tlaser") < b.index("fix             fout")      # compute must exist before fix ave/time uses it
    e.laser.mode = "preheat"
    e.laser.preheat_K = 900
    a, _, _ = deck_a(e)
    assert "velocity        gpWPeq create 900.0" in a and "velocity        gpCTeq create 300.0" in a
    e.workpiece.boundary_z = "s"
    a, _, _ = deck_a(e)
    assert "boundary        s s s" in a
    from nanocut.mock import mock_frames
    mk = mock_frames(e, n_frames=3, max_atoms=2000)
    assert len(mk["frames"]) == 4 and mk["meta"]["laser"] is None
    assert e.cut_steps == 300000 and e.equil_steps == 10000


def test_schema_roundtrip_and_validation():
    e = Experiment()
    e2 = Experiment.from_json(e.to_json())
    assert e2.to_dict() == e.to_dict()
    assert validate(e) == []
    bad = Experiment()
    bad.process.depth_nm = 50
    assert validate(bad)


def test_pair_blocks():
    lines, files, w = pair_block("C", ["Si", "C"], "SiC_1994", True, dict(style="auto"))
    assert lines[0].split() == ["pair_style", "tersoff"] and "SiC_1994.tersoff C Si C" in lines[1]
    lines, files, w = pair_block("C", ["Cu"], "Cu_mishin1.eam.alloy", False, dict(style="auto"))
    assert "hybrid eam/alloy morse 6.5" in lines[0] and "eam/alloy Cu_mishin1.eam.alloy NULL Cu" in lines[1]
    assert any("1 1 none" in l for l in lines) and any("1 2 morse 0.087 5.14 2.05" in l for l in lines)
    lines, files, w = pair_block("C", ["Cu"], "Cu_mishin1.eam.alloy", True, dict(style="auto"))
    assert "tersoff SiC.tersoff C NULL" in " ".join(lines)
    lines, files, w = pair_block("C", ["Ge"], "SiCGe.tersoff", True, dict(style="auto"))
    joined = " ".join(lines)
    assert "hybrid tersoff tersoff morse" in lines[0]
    assert "tersoff 1 SiCGe.tersoff NULL Ge" in joined and "tersoff 2 SiC.tersoff C NULL" in joined
    assert "1 2 morse 0.125778 2.58219 2.2324" in joined


def test_decks_text():
    e = PRESETS["ref_10_10 (Cutting/10-10)"]
    a, _, _ = deck_a(e)
    b, _, _ = deck_b(e)
    for s in ["boundary        s s p", "lattice         diamond 3.571", "origin 0.25 0.25 0.25", "pair_coeff      * * SiC_1994.tersoff C Si C",
              "fix             13 all property/atom mol", "run             10000", "write_restart   cut_SiC_R10_d10_A.restart"]:
        assert s in a, s
    for s in ["read_restart    cut_SiC_R10_d10_A.restart", "fix             cut gpCTbd move linear -2.000000 0.0 0.0 units box",
              "compute         fsum gpCTall reduce sum fx fy fz", "run             300000", "temp/partial 0 1 1"]:
        assert s in b, s
    assert all(ord(ch) < 128 for ch in a + b)


def test_lammps_smoke():
    """Reduced-scale A then B in WSL (skipped when the runtime is missing)."""
    if not runner.available():
        print("  (LAMMPS runtime not available: smoke test skipped)")
        return
    e = PRESETS["ref_10_10 (Cutting/10-10)"]
    s = runner.scaled_experiment(e, scale=0.1, cut_length_nm=0.5, equil_ps=0.2)
    s.output.dump_every_cut = 50
    s.output.forces_every = 50
    s.output.thermo_every = 50
    wd = os.path.join(tempfile.gettempdir(), "nanocut_smoke")
    r = runner.preview_run(s, wd, np=4, timeout=1800)
    assert r["ok"], r.get("stdout", "")[-2000:]
    pl = runner.parse_log(r["log"])
    assert not pl["errors"]
    assert os.path.exists(os.path.join(wd, s.name + "_forces_temps.txt"))


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            print(name, "...", end=" ")
            fn()
            print("ok")
