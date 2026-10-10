"""Exact enumeration of the lattice points LAMMPS `create_atoms ... region` would create.

Rules reproduced from the manual (lattice, create_atoms):
  * point = ((i,j,k) + basis + origin) * a0 in lattice coords, then rotated: x_box = M @ p,
    M rows = normalised `orient` vectors (must be integer, mutually orthogonal, right-handed).
  * lattice spacings = extent of the rotated unit cell (used to turn nm sizes into whole cells).
  * points on the box/region boundary are inside, except the upper boundary of a periodic dimension.
"""
import numpy as np
from .materials import BASIS

EPS = 1e-6


def orient_matrix(ox, oy, oz):
    o = np.array([ox, oy, oz], dtype=float)
    if not np.allclose(o, np.round(o)):
        raise ValueError("orient vectors must be integers")
    if abs(np.dot(o[0], o[1])) > 1e-9 or abs(np.dot(o[1], o[2])) > 1e-9 or abs(np.dot(o[0], o[2])) > 1e-9:
        raise ValueError("orient vectors must be mutually orthogonal")
    if np.dot(np.cross(o[0], o[1]), o[2]) <= 0:
        raise ValueError("orient vectors must form a right-handed system")
    return o / np.linalg.norm(o, axis=1)[:, None]


def spacings(a0, M):
    """LAMMPS lattice spacing rule: bounding extent of the rotated conventional cell."""
    corners = np.array([[i, j, k] for i in (0, 1) for j in (0, 1) for k in (0, 1)], float) * a0
    rot = corners @ M.T
    return rot.max(axis=0) - rot.min(axis=0)


def lattice_points(style, a0, M, origin, lo, hi, periodic=(False, False, True)):
    """All lattice points of `style` inside the box [lo, hi] (Å, box coords). Returns (N,3) array."""
    lo = np.asarray(lo, float)
    hi = np.asarray(hi, float)
    basis = np.array(BASIS[style], float) + np.asarray(origin, float)
    # candidate integer cells: map box corners to lattice coords
    corners = np.array([[x, y, z] for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])])
    lat = (corners @ M) / a0          # M orthonormal: inverse = transpose; x_box = M p  ->  p = M^T x
    imin = np.floor(lat.min(axis=0)).astype(int) - 2
    imax = np.ceil(lat.max(axis=0)).astype(int) + 2
    I, J, K = np.mgrid[imin[0]:imax[0] + 1, imin[1]:imax[1] + 1, imin[2]:imax[2] + 1]
    cells = np.stack([I.ravel(), J.ravel(), K.ravel()], axis=1).astype(float)
    pts = []
    for b in basis:
        p = (cells + b) * a0
        x = p @ M.T
        keep = np.ones(len(x), bool)
        for d in range(3):
            keep &= x[:, d] >= lo[d] - EPS
            keep &= (x[:, d] < hi[d] - EPS) if periodic[d] else (x[:, d] <= hi[d] + EPS)
        pts.append(x[keep])
    return np.concatenate(pts) if pts else np.zeros((0, 3))


def inside_block(x, xlo, xhi, ylo, yhi, zlo=-1e20, zhi=1e20):
    return ((x[:, 0] >= xlo - EPS) & (x[:, 0] <= xhi + EPS) & (x[:, 1] >= ylo - EPS) & (x[:, 1] <= yhi + EPS)
            & (x[:, 2] >= zlo - EPS) & (x[:, 2] <= zhi + EPS))
