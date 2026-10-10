"""Model geometry in Å: single source of truth for (a) LAMMPS region commands, (b) preview/atom counting.

Coordinate convention (reference decks): x = cutting direction (tool moves -x), y = depth (surface at the
top, y = y_surface), z = width (periodic). Workpiece occupies [0,Lx]x[0,Ly]x[0,Lz]; tool sits beyond x = Lx.

Wedge tool (orthogonal cutting): block ∩ {rake half-space} ∩ {clearance half-space} minus the sharp corner,
plus the edge cylinder of radius R tangent to both faces. Rake angle α > 0: rake face leans away from the
chip (+x going up). Clearance angle γ > 0: flank rises behind the edge. Reference decks: α = 0, γ = 10°.
"""
import math
from dataclasses import dataclass
import numpy as np
from .materials import MATERIALS, TOOL_MATERIALS, sublattices
from .lattice import orient_matrix, spacings, lattice_points, inside_block, EPS
from .schema import A_PER_NM

MOL = dict(ct_mob=1, ct_ts=2, ct_bd=3, wp_mob=4, wp_ts=5, wp_bd=6)


@dataclass
class Wedge:
    cx: float; cy: float; R: float; alpha: float; gamma: float   # radians
    L: float; H: float                                           # block size
    # derived
    def __post_init__(self):
        a, g, R = self.alpha, self.gamma, self.R
        self.u_r = np.array([math.sin(a), math.cos(a)])            # along rake face, upward
        self.n_r = np.array([-math.cos(a), math.sin(a)])           # outward normal of rake face
        self.u_f = np.array([math.cos(g), math.sin(g)])            # along flank, backward (+x)
        self.n_f = np.array([math.sin(g), -math.cos(g)])           # outward normal of flank
        C = np.array([self.cx, self.cy])
        self.T_r = C + R * self.n_r                                # tangent point rake/edge
        self.T_f = C + R * self.n_f                                # tangent point flank/edge
        self.by0 = self.cy - R                                     # tool bottom (edge lowest point)
        self.by1 = self.by0 + self.H
        self.bx0 = self.cx - R - self.H * max(0.0, -math.tan(a))   # block must contain a leaning rake face
        self.bx1 = self.cx - R + self.L

    def inside(self, x, y):
        C = np.array([self.cx, self.cy])
        d = np.stack([x - C[0], y - C[1]], axis=-1)
        in_circle = (d ** 2).sum(-1) <= self.R ** 2 + EPS
        in_block = (x >= self.bx0 - EPS) & (x <= self.bx1 + EPS) & (y >= self.by0 - EPS) & (y <= self.by1 + EPS)
        h_r = ((np.stack([x, y], -1) - self.T_r) @ self.n_r) <= EPS
        h_f = ((np.stack([x, y], -1) - self.T_f) @ self.n_f) <= EPS
        corner = ((d @ self.u_r) <= EPS) & ((d @ self.u_f) <= EPS)
        return in_circle | (in_block & h_r & h_f & ~corner)

    def front_x(self, y_lo, y_hi, n=200):
        """Foremost (minimum) x of the tool for y in [y_lo, y_hi] (numerical, 0.01 Å)."""
        ys = np.linspace(y_lo, y_hi, n)
        xs = np.arange(self.bx0 - 1.0, self.cx + self.R, 0.01)
        X, Y = np.meshgrid(xs, ys)
        m = self.inside(X, Y)
        rows = m.any(axis=1)
        if not rows.any():
            return self.bx0
        first = np.argmax(m[rows], axis=1)
        return float(xs[first].min())

    def regions(self, prefix="tool"):
        f = lambda v: f"{v:.6f}"
        C = (self.cx, self.cy)
        return [
            f"region {prefix}_block block {f(self.bx0)} {f(self.bx1)} {f(self.by0)} {f(self.by1)} INF INF units box",
            f"region {prefix}_rake  plane {f(self.T_r[0])} {f(self.T_r[1])} 0.0 {f(-self.n_r[0])} {f(-self.n_r[1])} 0.0 units box",
            f"region {prefix}_flank plane {f(self.T_f[0])} {f(self.T_f[1])} 0.0 {f(-self.n_f[0])} {f(-self.n_f[1])} 0.0 units box",
            f"region {prefix}_kA plane {f(C[0])} {f(C[1])} 0.0 {f(-self.u_r[0])} {f(-self.u_r[1])} 0.0 units box",
            f"region {prefix}_kB plane {f(C[0])} {f(C[1])} 0.0 {f(-self.u_f[0])} {f(-self.u_f[1])} 0.0 units box",
            f"region {prefix}_corner_out intersect 2 {prefix}_kA {prefix}_kB side out",
            f"region {prefix}_body intersect 4 {prefix}_block {prefix}_rake {prefix}_flank {prefix}_corner_out",
            f"region {prefix}_edge cylinder z {f(C[0])} {f(C[1])} {f(self.R)} INF INF units box",
            f"region cut_tool union 2 {prefix}_body {prefix}_edge",
        ]

    def profile(self, n=200):
        """Closed outline polygon [(x,y), ...] for 2-D drawing: rake face, edge arc, flank, block top."""
        # arc from the rake tangent (angle of n_r, ~180°) down through the lowest point to the flank tangent (~-90°)
        a_r = math.atan2(self.n_r[1], self.n_r[0])
        a_f = math.atan2(self.n_f[1], self.n_f[0])
        if a_f > a_r:
            a_f -= 2 * math.pi
        ang = np.linspace(a_r, a_f, n)
        arc = [(self.cx + self.R * math.cos(t), self.cy + self.R * math.sin(t)) for t in ang]
        top_r = self.T_r + (self.by1 - self.T_r[1]) / self.u_r[1] * self.u_r       # rake face meets block top
        back_f = self.T_f + (self.bx1 - self.T_f[0]) / self.u_f[0] * self.u_f      # flank meets block back
        if back_f[1] > self.by1:
            back_f = self.T_f + (self.by1 - self.T_f[1]) / self.u_f[1] * self.u_f  # ... or block top
        pts = [tuple(top_r)] + arc + [tuple(back_f)]
        if back_f[1] < self.by1 - EPS:
            pts.append((self.bx1, self.by1))
        pts.append((top_r[0], self.by1))
        return pts


@dataclass
class Sphere:
    cx: float; cy: float; cz: float; R: float

    def inside(self, x, y, z=None):
        d2 = (x - self.cx) ** 2 + (y - self.cy) ** 2
        if z is not None:
            d2 = d2 + (z - self.cz) ** 2
        return d2 <= self.R ** 2 + EPS

    def front_x(self, y_lo, y_hi):
        return self.cx - self.R

    def regions(self, prefix="tool"):
        f = lambda v: f"{v:.6f}"
        return [f"region cut_tool sphere {f(self.cx)} {f(self.cy)} {f(self.cz)} {f(self.R)} units box"]


class Model:
    """Everything in Å. Built from an Experiment."""

    def __init__(self, exp):
        self.exp = exp
        w, t, p = exp.workpiece, exp.tool, exp.process
        mat = MATERIALS[w.material]
        tmat = TOOL_MATERIALS[t.material]
        self.wp_elems = mat["elements"]
        self.tool_elem = tmat["elements"][0]
        self.types = [self.tool_elem] + self.wp_elems           # type 1 = tool
        self.structure = mat["structure"]
        # ---- workpiece lattice ----
        self.M_wp = orient_matrix(w.orient_x, w.orient_y, w.orient_z)
        self.a_wp = w.a0
        self.sp_wp = spacings(self.a_wp, self.M_wp)
        n = np.maximum(1, np.round(np.array([w.length_nm, w.height_nm, w.width_nm]) * A_PER_NM / self.sp_wp)).astype(int)
        self.n_cells = n
        self.Lx, self.Ly, self.Lz = (n * self.sp_wp).tolist()
        self.t_fixed = w.fixed_nm * A_PER_NM
        self.t_thermo = w.thermo_nm * A_PER_NM
        self.periodic = (w.boundary_x == "p", w.boundary_y == "p", w.boundary_z == "p")
        # exact atoms of the workpiece (for surface/end positions and counts)
        self.wp_atoms, self.wp_types = self._enumerate_workpiece()
        self.y_surface = float(self.wp_atoms[:, 1].max())
        self.x_end = float(self.wp_atoms[:, 0].max())
        # ---- tool lattice ----
        self.M_ct = orient_matrix(t.orient_x, t.orient_y, t.orient_z)
        self.a_ct = t.a0
        self.depth = p.depth_nm * A_PER_NM
        self.gap = p.gap_nm * A_PER_NM
        self.ct_fixed = t.fixed_nm * A_PER_NM
        self.ct_thermo = t.thermo_nm * A_PER_NM
        if t.shape == "wedge":
            R = t.edge_radius_nm * A_PER_NM
            cy = self.y_surface - self.depth + R
            g = Wedge(0.0, cy, R, math.radians(t.rake_deg), math.radians(t.clearance_deg),
                      t.length_nm * A_PER_NM, t.height_nm * A_PER_NM)
            # reference convention: the tool's foremost point (block/rake-face edge) sits at x_end + gap
            front = g.front_x(g.by0, g.by1)
            g = Wedge(self.x_end + self.gap - front, cy, R, g.alpha, g.gamma, g.L, g.H)
            self.tool = g
            self.tool_top = g.by1
            self.tool_xmax = g.bx1
            self.tool_xmin = g.front_x(g.by0, g.by1)
            self.edge_center = (g.cx, g.cy)
            # foremost tool point at mid-depth (where the chip root forms)
            ymid = self.y_surface - 0.5 * self.depth
            self._front_mid = g.front_x(ymid - 0.5, ymid + 0.5, n=5)
        elif t.shape == "sphere":
            R = t.sphere_radius_nm * A_PER_NM
            cy = self.y_surface - self.depth + R
            cx = self.x_end + self.gap + R
            self.tool = Sphere(cx, cy, self.Lz / 2.0, R)
            self.tool_top = cy + R
            self.tool_xmax = cx + R
            self.tool_xmin = cx - R
            self.edge_center = (cx, cy)
            self._front_mid = cx - math.sqrt(max(R ** 2 - (self.y_surface - 0.5 * self.depth - cy) ** 2, 0.0))
        else:
            raise ValueError("tool.shape must be wedge or sphere")
        # interaction zone centre at t = 0: foremost tool point within the cut depth, mid-depth
        self.contact_point = (self._front_mid, self.y_surface - 0.5 * self.depth)
        # laser spot (if any): centred lead_nm ahead of the tool front at surface level, spot_depth_nm below the surface
        las = exp.laser
        if t.shape == "wedge":
            front_surf = self.tool.front_x(self.y_surface - 0.5, self.y_surface + 0.5, n=5)
        else:
            front_surf = self.tool.cx - math.sqrt(max(self.tool.R ** 2 - (self.y_surface - self.tool.cy) ** 2, 0.0))
        self.laser_center = (front_surf - las.lead_nm * A_PER_NM, self.y_surface - las.spot_depth_nm * A_PER_NM)
        self.laser_radius = las.spot_radius_nm * A_PER_NM
        # ---- simulation box (x,y shrink-wrapped: generous; z exactly periodic) ----
        self.box = (-5.0, self.tool_xmax + 5.0, -5.0, max(self.Ly, self.tool_top) + 5.0, 0.0, self.Lz)
        self.ct_atoms = self._enumerate_tool()
        self.mol_wp = self._layers_wp(self.wp_atoms)
        self.mol_ct = self._layers_ct(self.ct_atoms)

    # ---------- enumeration ----------
    def _enumerate_workpiece(self):
        lo = (0.0, 0.0, 0.0)
        hi = (self.Lx, self.Ly, self.Lz)
        pts, typ = [], []
        for style, origin, ei in sublattices(self.structure):
            x = lattice_points(style, self.a_wp, self.M_wp, origin, lo, hi, periodic=self.periodic)
            pts.append(x)
            typ.append(np.full(len(x), 2 + ei, int))
        return np.concatenate(pts), np.concatenate(typ)

    def _enumerate_tool(self):
        t = self.exp.tool
        b = self.box
        lo = (self.tool_xmin - 1.0, (self.tool.by0 if t.shape == "wedge" else self.tool.cy - self.tool.R) - 1.0, 0.0)
        hi = (self.tool_xmax + 1.0, self.tool_top + 1.0, self.Lz)
        x = lattice_points(TOOL_MATERIALS[t.material]["structure"], self.a_ct, self.M_ct, t.origin_shift, lo, hi,
                           periodic=(False, False, self.periodic[2]))
        if t.shape == "wedge":
            m = self.tool.inside(x[:, 0], x[:, 1])
        else:
            m = self.tool.inside(x[:, 0], x[:, 1], x[:, 2])
        return x[m]

    # ---------- layer regions (Å) ----------
    def wp_layer_regions(self):
        """Return dict name -> (xlo,xhi,ylo,yhi) blocks, mirroring the reference deck."""
        tf, tt = self.t_fixed, self.t_thermo
        Lx, Ly = self.Lx, self.Ly
        r = {
            "wpbottom": (0.0, Lx, 0.0, tf),
            "wpxEnd": (0.0, tf, 0.0, Ly),
            "wpTSbottom": (tf, Lx, tf, tf + tt),
            "wpTSxEnd": (tf, tf + tt, tf, Ly),
        }
        if self.exp.workpiece.anchor_far_end:
            r["wpxFar"] = (Lx - tf, Lx, 0.0, Ly)
            r["wpTSxFar"] = (Lx - tf - tt, Lx - tf, tf, Ly)
        return r

    def _layers_wp(self, x):
        r = self.wp_layer_regions()
        bd = np.zeros(len(x), bool)
        ts = np.zeros(len(x), bool)
        for k, (a, b, c, d) in r.items():
            m = inside_block(x, a, b, c, d)
            if k.startswith("wpTS"):
                ts |= m
            else:
                bd |= m
        ts &= ~bd
        mol = np.full(len(x), MOL["wp_mob"], int)
        mol[ts] = MOL["wp_ts"]
        mol[bd] = MOL["wp_bd"]
        return mol

    def ct_layer_regions(self):
        t = self.exp.tool
        tf, tt = self.ct_fixed, self.ct_thermo
        if not t.deformable:
            return {}
        if t.shape == "wedge":
            g = self.tool
            return {
                "ctTop": (g.bx0, g.bx1, g.by1 - tf, g.by1),
                "ctxEnd": (g.bx1 - tf, g.bx1, g.by0, g.by1),
                "ctTSbottom": (g.bx0, g.bx1 - tf, g.by1 - tf - tt, g.by1 - tf),
                "ctTSxEnd": (g.bx1 - tf - tt, g.bx1 - tf, g.by0, g.by1 - tf),
            }
        s = self.tool
        return {
            "ctTop": (s.cx - s.R, s.cx + s.R, s.cy + s.R - tf, s.cy + s.R),
            "ctTSbottom": (s.cx - s.R, s.cx + s.R, s.cy + s.R - tf - tt, s.cy + s.R - tf),
        }

    def _layers_ct(self, x):
        t = self.exp.tool
        mol = np.full(len(x), MOL["ct_mob"], int)
        if not t.deformable:
            mol[:] = MOL["ct_bd"]
            return mol
        r = self.ct_layer_regions()
        bd = np.zeros(len(x), bool)
        ts = np.zeros(len(x), bool)
        for k, (a, b, c, d) in r.items():
            m = inside_block(x, a, b, c, d)
            if k.startswith("ctTS"):
                ts |= m
            else:
                bd |= m
        ts &= ~bd
        mol[ts] = MOL["ct_ts"]
        mol[bd] = MOL["ct_bd"]
        return mol

    # ---------- summaries ----------
    def counts(self):
        c = {"total": len(self.wp_atoms) + len(self.ct_atoms), "workpiece": len(self.wp_atoms), "tool": len(self.ct_atoms)}
        for k, v in MOL.items():
            arr = self.mol_ct if k.startswith("ct") else self.mol_wp
            c[k] = int((arr == v).sum())
        return c

    def all_atoms(self):
        """(xyz, type, mol) of every atom, tool first (as created in deck A)."""
        xyz = np.concatenate([self.ct_atoms, self.wp_atoms])
        typ = np.concatenate([np.ones(len(self.ct_atoms), int), self.wp_types])
        mol = np.concatenate([self.mol_ct, self.mol_wp])
        return xyz, typ, mol

    def tool_outline(self):
        if self.exp.tool.shape == "wedge":
            return self.tool.profile()
        s = self.tool
        ang = np.linspace(0, 2 * math.pi, 200)
        return [(s.cx + s.R * math.cos(a), s.cy + s.R * math.sin(a)) for a in ang]

    def periodic_mismatch(self):
        """Smallest z-separation of tool atoms across the periodic boundary (Å); <1 Å means overlapping images."""
        if len(self.ct_atoms) == 0:
            return None
        z = self.ct_atoms[:, 2]
        # plane-to-plane distance between the lowest tool plane and the periodic image of the highest one
        return float(z.min() + (self.Lz - z.max()))
