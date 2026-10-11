r"""Ductile/brittle indicators (ovito_worker.op_regime) on synthetic 3C-SiC frames with known defects:
intact, enclosed void, crack, two chip fragments, disordered region. A tool block (type 3) sits on the surface with
forces giving Ft/Fc = 2 exactly.

    .venv\Scripts\python webapp\tools\check_regime.py
"""
import json
import os
import sys
import time

import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
sys.path.insert(0, ROOT)
os.chdir(ROOT)
A = 4.3667
import tempfile
OUT = tempfile.mkdtemp(prefix="nanocut_regime_")
os.makedirs(OUT, exist_ok=True)


def slab(nx=24, ny=10, nz=4):
    base = np.array([[0, 0, 0], [0, .5, .5], [.5, 0, .5], [.5, .5, 0]])
    cells = np.array([[i, j, k] for i in range(nx) for j in range(ny) for k in range(nz)], float)
    si = (cells[:, None, :] + base[None]).reshape(-1, 3) * A
    return np.vstack([si, si + 0.25 * A]), np.r_[np.full(len(si), 1), np.full(len(si), 2)], np.array([nx, ny, nz]) * A


pos, typ, L = slab()
ys = pos[:, 1].max()
# tool: a block of type-3 atoms sitting on the surface (cutting edge at x = 60 A, moving towards -x), bottom at ys - 6
g = np.mgrid[60:80:2.0, ys - 6:ys + 14:2.0, 0:L[2]:2.0].reshape(3, -1).T
tool = g + [0.3, 0, 0.3]
wp_keep = ~((pos[:, 0] > 59) & (pos[:, 1] > ys - 7.5))       # workpiece material removed where the tool is


def frame(step, mod):
    p, t = pos[wp_keep], typ[wp_keep]
    p, t = mod(p, t)
    P = np.vstack([p, tool]); T = np.r_[t, np.full(len(tool), 3)]
    F = np.zeros_like(P); F[T == 3] = [-0.01, -0.02, 0.0]
    with open(os.path.join(OUT, f"dump.syn.{step}.lammpstrj"), "w") as f:
        f.write(f"ITEM: TIMESTEP\n{step}\nITEM: NUMBER OF ATOMS\n{len(P)}\nITEM: BOX BOUNDS ss ss pp\n-20 {L[0] + 20}\n-20 {L[1] + 40}\n0 {L[2]}\nITEM: ATOMS id type x y z fx fy fz\n")
        for i in range(len(P)):
            f.write(f"{i + 1} {T[i]} {P[i, 0]:.4f} {P[i, 1]:.4f} {P[i, 2]:.4f} {F[i, 0]} {F[i, 1]} {F[i, 2]}\n")


c = np.array([75.0, ys - 18, L[2] / 2])
frame(0, lambda p, t: (p, t))
frame(1, lambda p, t: (p[(np.linalg.norm((p - c)[:, :2], axis=1) > 6) | (np.abs(p[:, 2] - c[2]) > 4)], t[(np.linalg.norm((p - c)[:, :2], axis=1) > 6) | (np.abs(p[:, 2] - c[2]) > 4)]))
crack = lambda p: (np.abs(p[:, 0] - 75) < 1.6) & (p[:, 1] > ys - 30)
frame(2, lambda p, t: (p[~crack(p)], t[~crack(p)]))
blob = lambda o: (np.mgrid[0:8:2.0, 0:8:2.0, 0:L[2]:2.2].reshape(3, -1).T + o)
def chips(p, t):
    b1, b2 = blob([40, ys + 6, 0]), blob([20, ys + 20, 0])                  # two separate fragments above the surface
    return np.vstack([p, b1, b2]), np.r_[t, np.full(len(b1) + len(b2), 1)]
frame(3, chips)
def amorph(p, t):
    rng = np.random.default_rng(3); q = p.copy()
    m = (q[:, 0] > 62) & (q[:, 0] < 92) & (q[:, 1] > ys - 20) & (q[:, 1] < ys - 9)
    q[m] += rng.normal(0, 0.45, (m.sum(), 3)); return q, t
frame(4, amorph)

from fastapi.testclient import TestClient
from webapp.backend.app.main import app
cl = TestClient(app)
spec = {"source": {"path": OUT, "pattern": "dump.syn.*.lammpstrj"}, "frame": 0, "types": {}, "cell": False, "modifiers": []}
j = cl.post("/api/ovito/regime", json={"spec": spec, "frames": [0, 1, 2, 3, 4], "params": {"tool_types": [3], "direction": "-x"}}).json()
while j.get("status") in ("queued", "running"):
    time.sleep(0.3); j = cl.get(f"/api/jobs/{j['id']}").json()
assert j["status"] == "done", j
for r in j["result"]["rows"]:
    print(f"frame {r['frame']}: voids {r['voids']} ({r['void_volume']:.0f} A3), deep surface atoms {r['deep_surface_atoms']}, chip fragments {r['chip_fragments']} {r['chip_sizes']}, "
          f"disordered {r['disordered_fraction']:.3f}, Ft/Fc {r.get('force_ratio')}, depth of cut {r['depth_of_cut']:.2f} A, damage depth {r['damage_depth']:.1f} A")

R = {r["frame"]: r for r in j["result"]["rows"]}
checks = [("intact: no void, no crack face, no fragment, no damage", R[0]["voids"] == 0 and R[0]["deep_surface_atoms"] == 0 and R[0]["chip_fragments"] == 0 and R[0]["damage_depth"] == 0),
          ("enclosed void found", R[1]["voids"] == 1 and R[1]["void_volume"] > 500),
          ("crack faces found", R[2]["deep_surface_atoms"] > 50 and R[2]["voids"] == 0),
          ("two chip fragments", R[3]["chip_fragments"] == 2 and R[3]["chip_sizes"] == [128, 128]),
          ("disordered region: damage depth 14 A below the tool, no crack", 13.5 < R[4]["damage_depth"] < 16 and R[4]["deep_surface_atoms"] == 0),
          ("Ft/Fc = 2 and depth of cut 6 A", all(abs(r["force_ratio"] - 2) < 1e-9 and abs(r["depth_of_cut"] - 6) < 1e-6 for r in R.values()))]
for name, ok in checks:
    print(("PASS " if ok else "FAIL ") + name)
import shutil
shutil.rmtree(OUT, ignore_errors=True)
print("\nALL CHECKS PASSED" if all(ok for _, ok in checks) else "\nSOME CHECKS FAILED")
sys.exit(0 if all(ok for _, ok in checks) else 1)
