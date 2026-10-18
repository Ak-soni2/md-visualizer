"""Stress measures from LAMMPS `compute stress/atom` output (PLAN_PHASE3.md §2.1).

`c_s[1..6]` = S_xx, S_yy, S_zz, S_xy, S_xz, S_yz in bar*Å^3 (units metal). LAMMPS defines S as the negative per-atom
pressure tensor times volume, so the stress (tension positive) is sigma_ij = S_ij / Omega_i and the pressure is
p = -(sigma_xx + sigma_yy + sigma_zz) / 3. 1 bar = 1e-4 GPa.

Every function works on arrays of tensors in Voigt order (xx, yy, zz, xy, xz, yz), shape (N, 6), in GPa.
"""
import numpy as np

BAR_TO_GPA = 1e-4
VOIGT = ("xx", "yy", "zz", "xy", "xz", "yz")
TINY = 1e-12                                   # GPa; below this von Mises is treated as zero (ratios undefined)

# name -> (label, unit); the order is the order of the tables and exports
MEASURES = {
    "sxx": ("σxx", "GPa"), "syy": ("σyy", "GPa"), "szz": ("σzz", "GPa"),
    "sxy": ("τxy", "GPa"), "sxz": ("τxz", "GPa"), "syz": ("τyz", "GPa"),
    "hydro": ("hydrostatic stress σh", "GPa"), "pressure": ("pressure p = −σh", "GPa"),
    "von_mises": ("von Mises stress", "GPa"), "s1": ("principal stress σ1 (max)", "GPa"),
    "s2": ("principal stress σ2", "GPa"), "s3": ("principal stress σ3 (min)", "GPa"),
    "tau_max": ("max shear stress (σ1−σ3)/2", "GPa"), "tresca": ("Tresca stress σ1−σ3", "GPa"),
    "tau_oct": ("octahedral shear stress", "GPa"), "j2": ("J2 (2nd deviatoric invariant)", "GPa²"),
    "j3": ("J3 (3rd deviatoric invariant)", "GPa³"), "triaxiality": ("stress triaxiality σh/σvM", ""),
    "lode": ("Lode parameter 27J3/(2σvM³)", ""),
}


def to_gpa(S6, volume):
    """(N, 6) bar*Å^3 and atomic volume (scalar or (N,) Å^3) -> (N, 6) stress in GPa (tension positive)."""
    S6 = np.asarray(S6, dtype=np.float64)
    V = np.asarray(volume, dtype=np.float64)
    return S6 / (V[..., None] if V.ndim else V) * BAR_TO_GPA


def principal(s6, chunk=500_000):
    """Principal stresses sorted descending: (N, 3) = sigma1 >= sigma2 >= sigma3."""
    s6 = np.asarray(s6, dtype=np.float64)
    out = np.empty((len(s6), 3))
    for a in range(0, len(s6), chunk):
        t = s6[a:a + chunk]
        m = np.empty((len(t), 3, 3))
        m[:, 0, 0], m[:, 1, 1], m[:, 2, 2] = t[:, 0], t[:, 1], t[:, 2]
        m[:, 0, 1] = m[:, 1, 0] = t[:, 3]
        m[:, 0, 2] = m[:, 2, 0] = t[:, 4]
        m[:, 1, 2] = m[:, 2, 1] = t[:, 5]
        out[a:a + chunk] = np.linalg.eigvalsh(m)[:, ::-1]          # eigvalsh: ascending
    return out


def measures(s6, which=None):
    """All stress measures of MEASURES for (N, 6) tensors in GPa; `which` limits the output (principal stresses are the
    expensive part)."""
    s6 = np.atleast_2d(np.asarray(s6, dtype=np.float64))
    want = set(which or MEASURES)
    sxx, syy, szz, sxy, sxz, syz = s6.T
    h = (sxx + syy + szz) / 3.0
    dx, dy, dz = sxx - h, syy - h, szz - h                         # deviatoric diagonal
    j2 = 0.5 * (dx * dx + dy * dy + dz * dz) + sxy * sxy + sxz * sxz + syz * syz
    vm = np.sqrt(3.0 * np.maximum(j2, 0.0))
    out = {"sxx": sxx, "syy": syy, "szz": szz, "sxy": sxy, "sxz": sxz, "syz": syz, "hydro": h, "pressure": -h,
           "von_mises": vm, "j2": j2, "tau_oct": np.sqrt(2.0 * np.maximum(j2, 0.0) / 3.0)}
    if want & {"j3", "lode"}:
        j3 = dx * (dy * dz - syz * syz) - sxy * (sxy * dz - syz * sxz) + sxz * (sxy * syz - dy * sxz)
        out["j3"] = j3
        with np.errstate(divide="ignore", invalid="ignore"):
            out["lode"] = np.where(vm > TINY, np.clip(13.5 * j3 / vm ** 3, -1.0, 1.0), np.nan)
    if "triaxiality" in want:
        with np.errstate(divide="ignore", invalid="ignore"):
            out["triaxiality"] = np.where(vm > TINY, h / vm, np.nan)
    if want & {"s1", "s2", "s3", "tau_max", "tresca"}:
        p = principal(s6)
        out.update(s1=p[:, 0], s2=p[:, 1], s3=p[:, 2], tresca=p[:, 0] - p[:, 2], tau_max=0.5 * (p[:, 0] - p[:, 2]))
    return {k: v for k, v in out.items() if k in want}


def virial_average(S6, volume, mask=None):
    """Volume-averaged stress tensor of a region, sum(S_i) / sum(Omega_i), in GPa (Voigt (6,)); None if empty."""
    S6 = np.asarray(S6, dtype=np.float64)
    V = np.broadcast_to(np.asarray(volume, dtype=np.float64), (len(S6),))
    if mask is not None:
        S6, V = S6[mask], V[mask]
    if not len(S6) or V.sum() <= 0:
        return None
    return S6.sum(0) / V.sum() * BAR_TO_GPA


def von_mises(s6):
    return measures(s6, ["von_mises"])["von_mises"]
