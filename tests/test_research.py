"""Known-answer checks for nanocut.stress and nanocut.research. Run:  python -m tests.test_research  (project root)"""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from nanocut import stress as st, research as rs   # noqa: E402

A = 4.3667


def close(a, b, tol=1e-9):
    assert abs(a - b) <= tol * max(1.0, abs(b)), (a, b)


def test_stress_known_tensors():
    m = st.measures(np.array([[1.0, 0, 0, 0, 0, 0]]))                      # uniaxial tension 1 GPa
    close(m["von_mises"][0], 1.0); close(m["pressure"][0], -1 / 3); close(m["s1"][0], 1.0); close(m["s3"][0], 0.0)
    close(m["tau_max"][0], 0.5); close(m["triaxiality"][0], 1 / 3); close(m["lode"][0], 1.0); close(m["tau_oct"][0], np.sqrt(2) / 3)
    m = st.measures(np.array([[0, 0, 0, 2.0, 0, 0]]))                      # pure shear 2 GPa
    close(m["von_mises"][0], 2 * np.sqrt(3)); close(m["s1"][0], 2.0); close(m["s3"][0], -2.0); close(m["tau_max"][0], 2.0)
    assert abs(m["lode"][0]) < 1e-9
    m = st.measures(np.array([[-5.0, -5.0, -5.0, 0, 0, 0]]))               # hydrostatic compression
    close(m["von_mises"][0], 0.0); close(m["pressure"][0], 5.0); assert np.isnan(m["triaxiality"][0])
    close(st.to_gpa(np.array([[1e4, 0, 0, 0, 0, 0]]), 1.0)[0, 0], 1.0)     # 1e4 bar*Å^3 / 1 Å^3 = 1 GPa


def test_stress_rotation_invariance():
    rng = np.random.default_rng(1)
    t = rng.normal(size=(50, 6))
    Q, _ = np.linalg.qr(rng.normal(size=(3, 3)))
    M = np.zeros((50, 3, 3))
    M[:, 0, 0], M[:, 1, 1], M[:, 2, 2] = t[:, 0], t[:, 1], t[:, 2]
    M[:, 0, 1] = M[:, 1, 0] = t[:, 3]; M[:, 0, 2] = M[:, 2, 0] = t[:, 4]; M[:, 1, 2] = M[:, 2, 1] = t[:, 5]
    R = Q @ M @ Q.T
    t2 = np.stack([R[:, 0, 0], R[:, 1, 1], R[:, 2, 2], R[:, 0, 1], R[:, 0, 2], R[:, 1, 2]], 1)
    a, b = st.measures(t), st.measures(t2)
    for k in ("von_mises", "pressure", "s1", "s2", "s3", "tau_max", "j3", "lode"):
        assert np.allclose(a[k], b[k], atol=1e-9), k
    assert np.allclose(a["s1"] + a["s2"] + a["s3"], t[:, :3].sum(1))


def zincblende(nx, ny, nz):
    fcc = np.array([(0, 0, 0), (0.5, 0.5, 0), (0.5, 0, 0.5), (0, 0.5, 0.5)])
    cells = np.array([(i, j, k) for i in range(nx) for j in range(ny) for k in range(nz)], float)
    si = (cells[:, None, :] + fcc[None]).reshape(-1, 3) * A
    c = (cells[:, None, :] + fcc[None] + 0.25).reshape(-1, 3) * A
    return np.vstack([si, c]), np.r_[np.full(len(si), 2), np.full(len(c), 3)]


def brute_neighbors(pos, Lz):
    def nb(idx, rc):
        P, V = [], []
        for i in idx:
            d = pos - pos[i]
            d[:, 2] -= Lz * np.round(d[:, 2] / Lz)
            r = np.sqrt((d ** 2).sum(1))
            j = np.nonzero((r < rc) & (r > 1e-9))[0]
            P.append(np.stack([np.full(len(j), i), j], 1)); V.append(d[j])
        return np.concatenate(P), np.concatenate(V)
    return nb


def make_frame(shift=0.0, T=300.0, seed=3):
    wp, wt = zincblende(8, 6, 3)
    tool = np.array([(x, y, z) for x in np.arange(0, 12, 1.8) for y in np.arange(0, 10, 1.8) for z in np.arange(0, 3 * A, 1.8)]) + [8 * A - 2.0, 6 * A - 4.0, 0]
    pos = np.vstack([tool, wp]) + [shift, 0, 0]
    typ = np.r_[np.ones(len(tool), int), wt]
    N = len(pos)
    rng = np.random.default_rng(seed)
    mass = np.where(typ == 2, 28.0855, 12.011)
    sig = np.sqrt(rs.KB * T / (mass * rs.MVV2E))                         # Å/ps per component
    v = rng.normal(size=(N, 3)) * sig[:, None]
    f = np.zeros((N, 3)); f[typ == 1] = [0.1, 0.05, 0.0]                  # eV/Å per tool atom
    S = np.zeros((N, 6)); S[:, 0] = 1e4 * 10.41                           # sigma_xx = 1 GPa for the workpiece volume
    cols = dict(vx=v[:, 0], vy=v[:, 1], vz=v[:, 2], fx=f[:, 0], fy=f[:, 1], fz=f[:, 2], **{f"c_s[{i + 1}]": S[:, i] for i in range(6)})
    cell = np.zeros((3, 4)); cell[0, 0], cell[1, 1], cell[2, 2] = 100.0, 100.0, 3 * A
    return dict(frame=0, step=0, ids=np.arange(1, N + 1), types=typ, pos=pos, cell=cell, pbc=(False, False, True), cols=cols,
                type_names={1: "C", 2: "Si", 3: "C"}), tool


CFG = dict(tool_types=[1], types={1: dict(mass=12.011, volume=5.67), 2: dict(mass=28.0855, volume=10.41), 3: dict(mass=12.011, volume=10.41)},
           dt_ps=0.0005, max_centers=300, rdf_regions=["workpiece"], maps=True, hist=True, profiles=True)


def test_research_known_answers():
    fr, tool = make_frame()
    ref = rs.reference(fr, CFG)
    out = rs.analyze_frame(fr, ref, CFG, neighbors=brute_neighbors(fr["pos"], 3 * A))
    S = out["scalars"]
    nt = len(tool)
    close(S["Fc"], nt * 0.1 * rs.EV_A_TO_NN, 1e-9); close(S["Ft"], nt * 0.05 * rs.EV_A_TO_NN, 1e-9)
    close(S["mu"], 2.0); close(S["friction_angle"], np.degrees(np.arctan(0.5)))
    assert abs(S["T_com@workpiece"] - 300) < 15, S["T_com@workpiece"]
    close(S["von_mises.mean_GPa@workpiece"], 1.0, 1e-9); close(S["vir.von_mises_GPa@workpiece"], 1.0, 1e-9)
    close(S["pressure.mean_GPa@workpiece"], -1 / 3, 1e-9)
    close(S["rdf_peak_r@workpiece"], A * np.sqrt(3) / 4, 0.03)           # Si–C bond 1.891 Å (bin width 0.04 Å)
    close(S["rdf_cn@workpiece"], 4.0, 0.15)                               # surface centres have fewer neighbours
    assert abs(S["bad_peak@workpiece"] - 109.47) < 2.5, S["bad_peak@workpiece"]
    close(S["surface_y"], 5.75 * A, 1e-9)
    assert "rdf@workpiece" in out["curves"] and "von_mises" in out["maps"], (list(out["curves"]), list(out["maps"]))
    fr2, _ = make_frame(shift=0.5)
    out2 = rs.analyze_frame(fr2, ref, CFG)
    close(out2["scalars"]["disp.mean@workpiece"], 0.5, 1e-9); close(out2["scalars"]["cut_distance"], 0.5, 1e-9)
    rows = rs.finalize([out, dict(out2, frame=1, scalars=dict(out2["scalars"], step=1000))], CFG)
    close(rows[1]["scalars"]["tool_speed_frames"], 0.5 / 0.5 * 100, 1e-9)
    close(rows[1]["scalars"]["work_cum"], S["Fc"] / rs.EV_A_TO_NN * 0.5, 1e-9)
    cat = rs.catalogue(rows)
    assert cat["von_mises.p95_GPa@contact"]["unit"] == "GPa" if "von_mises.p95_GPa@contact" in cat else True
    assert cat["vir.von_mises_GPa@workpiece"]["category"] == "stress"


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
