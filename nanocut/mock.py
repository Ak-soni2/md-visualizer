"""MOCK cutting animation — a kinematic schematic, NOT a simulation.

It moves the real tool geometry across the real lattice (same atoms deck A creates) and displaces the
atoms in the cut layer into a chip with a classical shear-plane picture (Merchant: tan(phi) = r cos(a)/(1 - r sin(a)),
chip ratio r = uncut thickness / chip thickness). Everything below the cut line stays; a shaded band below the groove
indicates where subsurface damage typically appears. Colours marked "illustrative" encode distance from the cutting
edge, not a computed temperature. Use it to understand the geometry and the sequence of events, never for numbers.
"""
import math
import numpy as np
from .geometry import Model, MOL
from .schema import A_PER_NM


def mock_frames(exp, n_frames=24, chip_ratio=0.5, max_atoms=12000, slab_periods=1.0, seed=0):
    """Return dict(frames=[{xyz, kind, hot}], outline_frames, meta). Atoms limited to one z-slab and subsampled."""
    m = Model(exp)
    p = exp.process
    xyz, typ, mol = m.all_atoms()
    zs = m.sp_wp[2] * slab_periods
    sl = xyz[:, 2] < zs * 0.5 + 1e-6
    xyz, typ, mol = xyz[sl], typ[sl], mol[sl]
    rng = np.random.default_rng(seed)
    if len(xyz) > max_atoms:
        keep = np.zeros(len(xyz), bool)
        # keep every atom near the cut layer, subsample the rest
        near = (mol >= 4) & (xyz[:, 1] > m.y_surface - 3 * m.depth - 15.0)
        keep |= near
        rest = np.where(~near)[0]
        keep[rng.choice(rest, size=min(len(rest), max(0, max_atoms - near.sum())), replace=False)] = True
        xyz, typ, mol = xyz[keep], typ[keep], mol[keep]
    wp = mol >= 4
    L = p.cut_length_nm * A_PER_NM
    d = m.depth
    ys = m.y_surface
    ycut = ys - d
    alpha = math.radians(exp.tool.rake_deg) if exp.tool.shape == "wedge" else 0.0
    r = max(0.05, min(1.0, chip_ratio))
    phi = math.atan2(r * math.cos(alpha), 1.0 - r * math.sin(alpha))          # shear angle
    x_front0 = m.x_end + m.gap                                               # tool front at the cut depth, t = 0
    if exp.tool.shape == "wedge":
        T_r = m.tool.T_r
        u_r = m.tool.u_r
    else:
        T_r = np.array([m.tool.cx - m.tool.R, ycut])
        u_r = np.array([0.0, 1.0])
    outline0 = np.array(m.tool_outline())
    frames = []
    cut_layer = wp & (xyz[:, 1] > ycut + 1e-6)
    for k in range(n_frames + 1):
        s = L * k / n_frames                      # tool travel
        x_front = x_front0 - s
        pos = xyz.copy()
        kind = np.where(wp, 1, 0)                 # 0 tool, 1 workpiece, 2 chip, 3 damaged
        # atoms of the cut layer that the tool has passed: move into the chip
        passed = cut_layer & (xyz[:, 0] >= x_front)
        if passed.any():
            dist = xyz[passed, 0] - x_front                 # how long ago (in length) the atom entered the chip
            h = (xyz[passed, 1] - ycut) / d                  # 0 bottom of cut layer ... 1 free surface
            tc = d / r                                       # chip thickness
            along = dist * r                                 # chip is shorter by the chip ratio
            # chip sits on the rake face: base point = rake tangent point shifted with the tool, then along u_r
            base = np.array([T_r[0] - s, T_r[1]])
            n_r = np.array([-u_r[1], u_r[0]])                # normal pointing away from the tool (towards -x)
            curl = 0.004 * along ** 2                        # gentle curl away from the rake face
            pos[passed, 0] = base[0] + along * u_r[0] - (h * tc) * n_r[0] * -1 - curl
            pos[passed, 1] = base[1] + along * u_r[1] - (h * tc) * n_r[1] * -1
            kind[passed] = 2
        # shear zone ahead of the tool: tilt atoms in the primary shear band (purely visual)
        band = cut_layer & (xyz[:, 0] < x_front) & (xyz[:, 0] > x_front - d / math.tan(phi))
        if band.any():
            frac = (xyz[band, 0] - (x_front - d / math.tan(phi))) / (d / math.tan(phi))
            pos[band, 1] = xyz[band, 1] + frac * (xyz[band, 1] - ycut) * 0.5 * r
            pos[band, 0] = xyz[band, 0] - frac * 0.3 * d
        # damaged band: workpiece atoms within ~d below the groove behind the tool (visual flag only)
        dam = wp & (xyz[:, 1] <= ycut) & (xyz[:, 1] > ycut - 1.0 * d) & (xyz[:, 0] >= x_front) & (xyz[:, 0] <= x_front0)
        kind[dam & (kind == 1)] = 3
        # tool atoms translate rigidly
        tool = ~wp
        pos[tool, 0] = xyz[tool, 0] - s
        # illustrative "hotness": exp(-dist^2) from the moving contact point, only for workpiece/chip atoms
        cx, cy = x_front, ycut + 0.5 * d
        dd2 = (pos[:, 0] - cx) ** 2 + (pos[:, 1] - cy) ** 2
        hot = np.where(wp, np.exp(-dd2 / (2 * (2.5 * d + 10.0) ** 2)), 0.0)
        if exp.laser.mode in ("spot", "power"):          # laser spot moving with the tool (illustrative glow)
            lx, ly = m.laser_center[0] - s, m.laser_center[1]
            dl2 = (pos[:, 0] - lx) ** 2 + (pos[:, 1] - ly) ** 2
            hot = np.maximum(hot, np.where(wp, np.exp(-dl2 / (2 * m.laser_radius ** 2)), 0.0))
        elif exp.laser.mode == "preheat":
            hot = np.maximum(hot, np.where(wp, 0.35, 0.0))
        frames.append(dict(xyz=pos, kind=kind, hot=hot, travel_A=s, tool_front_x=x_front))
    outlines = [outline0 - np.array([L * k / n_frames, 0.0]) for k in range(n_frames + 1)]
    meta = dict(y_surface=ys, y_cut=ycut, shear_angle_deg=math.degrees(phi), chip_thickness_A=d / r, depth_A=d,
                x_front0=x_front0, Lx=m.Lx, Ly=m.Ly, box=m.box, mol=mol,
                laser=(list(m.laser_center), m.laser_radius) if exp.laser.mode in ("spot", "power") else None)
    return dict(frames=frames, outlines=outlines, meta=meta)
