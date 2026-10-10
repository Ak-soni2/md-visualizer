"""Render PNG images from the shipped sample run (examples/sample_run) for the UI overview.
Run from the project root: python tools/make_sample_images.py"""
import glob
import json
import os
import sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from nanocut import analysis

D = os.path.join(ROOT, "examples", "sample_run")
prm = json.load(open(os.path.join(D, "params.json")))
ms = prm["model"]
types = ms["types"]
y_s = ms["y_surface_A"]
files = analysis.dump_series(D)
LAY = {1: ("tool Newtonian", "#7f7f7f"), 2: ("tool thermostat", "#ff7f0e"), 3: ("tool fixed", "#1f1f1f"),
       4: ("workpiece Newtonian", "#1f77b4"), 5: ("workpiece thermostat", "#2ca02c"), 6: ("workpiece fixed", "#9467bd")}

fig, axes = plt.subplots(1, len(files), figsize=(5 * len(files), 4.5), sharey=True)
for ax, f in zip(np.atleast_1d(axes), files):
    fr = analysis.Frame(analysis.read_dump(f)[0], types)
    xyz, mol = fr.xyz, fr.col("mol")
    sl = xyz[:, 2] < 2.5
    T = fr.local_temperature()
    sc = ax.scatter(xyz[sl, 0], xyz[sl, 1], c=T[sl], s=2, cmap="inferno", vmin=0, vmax=2500)
    ax.axhline(y_s, color="w", ls=":", lw=0.8)
    ax.set_title(f"step {fr.step}: {fr.step * prm['experiment']['thermo']['cut_dt_fs'] * 1e-3 * ms['speed_A_per_ps'] / 10:.2f} nm of cut")
    ax.set_xlabel("x (Å)")
    ax.set_aspect("equal")
axes[0].set_ylabel("y (Å)")
fig.colorbar(sc, ax=axes, label="local temperature (K) from time-averaged KE")
fig.suptitle("Real reduced-scale run (3C-SiC, Tersoff-1994, R = 3.57 nm, d = 1.31 nm, 200 m/s): one atomic plane")
fig.savefig(os.path.join(D, "sample_temperature.png"), dpi=130, bbox_inches="tight")

fig, ax = plt.subplots(figsize=(6, 4.5))
fr = analysis.Frame(analysis.read_dump(files[-1])[0], types)
xyz, mol = fr.xyz, fr.col("mol")
sl = xyz[:, 2] < 2.5
for k, (name, col) in LAY.items():
    m = sl & (mol == k)
    ax.scatter(xyz[m, 0], xyz[m, 1], s=2, c=col, label=name)
ax.axhline(y_s, color="k", ls=":", lw=0.8)
ax.set_aspect("equal")
ax.legend(fontsize=7, markerscale=4, loc="lower right")
ax.set_title(f"Layers (mol tag), step {fr.step}")
fig.savefig(os.path.join(D, "sample_layers.png"), dpi=130, bbox_inches="tight")

names, arr = analysis.read_avetime(glob.glob(os.path.join(D, "*_forces_temps.txt"))[0])
dt = prm["experiment"]["thermo"]["cut_dt_fs"] * 1e-3
dist = arr[:, 0] * dt * ms["speed_A_per_ps"] / 10
fig, (a1, a2) = plt.subplots(1, 2, figsize=(11, 4))
for i, n in enumerate(names):
    if n.endswith("_nN"):
        a1.plot(dist, arr[:, i], label=n)
    elif n.endswith("_K"):
        a2.plot(dist, arr[:, i], label=n)
a1.set_xlabel("cutting distance (nm)"); a1.set_ylabel("force on tool (nN)"); a1.legend(fontsize=8); a1.set_title("Cutting / thrust / lateral force")
a2.set_xlabel("cutting distance (nm)"); a2.set_ylabel("temperature (K)"); a2.legend(fontsize=8); a2.set_title("Temperatures (zones)")
fig.savefig(os.path.join(D, "sample_forces.png"), dpi=130, bbox_inches="tight")
print("images written")
