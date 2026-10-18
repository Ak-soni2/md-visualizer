"""Research analysis of one dump frame (PLAN_PHASE3.md §2): every per-region average a nano-cutting paper reports.

Pure NumPy. The OVITO worker supplies the arrays (and OVITO's neighbour finder / structure / strain results); the
tests supply synthetic frames with known answers.

Frame dict `fr`: frame, step, ids (N,), types (N,), pos (N,3), cell (3,4: three cell vectors as columns + origin),
pbc (3,), cols {dump column: (N,)}, type_names {tid: name}; optional structure (N,) + structure_names, coordination
(N,), shear_strain, vol_strain, voronoi_volume (N,), ws {vacancies, interstitials}, dxa {length}.
Reference dict from `reference(fr0, cfg)`: frame-0 positions by id, original surface height, tool COM.
`neighbors(indices, cutoff)` -> (pairs (M,2) [centre, neighbour], vectors (M,3)), grouped by centre in `indices` order.

Axes: cutting along x (tool moving towards -x by default), surface normal +y, width z (NanoCut decks).
"""
import re
import numpy as np
from . import stress as st
from .materials import MASS

EV_A_TO_NN = 1.602176634
KB = 8.617333262e-5
MVV2E = 1.0364269e-4
APS_TO_MS = 100.0
ATOMS_PER_CELL = {"zincblende": 8, "diamond": 8, "fcc": 4, "bcc": 2, "sc": 1}

DEFAULTS = dict(
    tool_types=[1], direction="-x", dt_ps=None, rake_deg=0.0, types={}, volume_mode="nominal",
    contact_radius=20.0, chip_threshold=1.0, subsurface_depth=30.0, surface_cell=10.0, column_cell=5.0,
    strain_threshold=0.2, stress_prefix=None,
    rdf=True, rdf_rmax=6.0, rdf_bins=150, max_centers=20000, rdf_regions=["workpiece", "contact", "chip", "subsurface"],
    bad=True, bond_cutoff=None, bad_bins=90,
    hist=True, hist_bins=60, profiles=True, profile_bin=2.0, profile_half_width=15.0, maps=True, map_bin=4.0,
)

REGION_LABEL = {"all": "all atoms", "tool": "tool", "workpiece": "workpiece", "contact": "contact zone", "chip": "chip",
                "subsurface": "subsurface", "mol1": "tool Newtonian (mol 1)", "mol2": "tool thermostat (mol 2)",
                "mol3": "tool fixed (mol 3)", "mol4": "workpiece Newtonian (mol 4)", "mol5": "workpiece thermostat (mol 5)",
                "mol6": "workpiece fixed (mol 6)"}
MAIN = ("von_mises", "pressure", "hydro", "s1", "s3", "tau_max", "tau_oct")
STATS_MAIN = ("mean", "std", "min", "max", "p95", "p99")
# quantity id -> (label, unit, category)
Q = {
    "contact_x": ("contact point x", "Å", "tool"), "contact_y": ("contact point y", "Å", "tool"),
    "frame": ("frame", "", "time"), "step": ("timestep", "", "time"), "time_ps": ("time", "ps", "time"),
    "cut_distance": ("cutting distance (tool displacement)", "Å", "time"), "cut_distance_nm": ("cutting distance", "nm", "time"),
    "tool_tip_x": ("tool leading edge x", "Å", "tool"), "tool_bottom_y": ("tool bottom y", "Å", "tool"),
    "tool_com_x": ("tool COM x", "Å", "tool"), "tool_com_y": ("tool COM y", "Å", "tool"),
    "tool_speed_vel": ("tool speed (from velocities)", "m/s", "tool"), "tool_speed_frames": ("tool speed (between frames)", "m/s", "tool"),
    "surface_y": ("original surface y", "Å", "geometry"), "depth_of_cut": ("depth of cut", "Å", "geometry"), "width_z": ("width (z)", "Å", "geometry"),
    "Fc": ("cutting force Fc = |ΣFx|", "nN", "force"), "Ft": ("thrust force Ft = |ΣFy|", "nN", "force"), "Fz": ("lateral force |ΣFz|", "nN", "force"),
    "F_res": ("resultant force |ΣF|", "nN", "force"), "Ft_over_Fc": ("force ratio Ft/Fc", "", "force"), "mu": ("friction coefficient μ = Fc/Ft", "", "force"),
    "friction_angle": ("friction angle β = α + atan(Ft/Fc)", "deg", "force"), "specific_energy": ("specific cutting energy Fc/(d·w)", "GPa", "force"),
    "work_cum": ("cumulative cutting work ∫Fc dx", "eV", "force"),
    "pileup_max": ("pile-up height (highest atom)", "Å", "surface"), "pileup_ahead": ("pile-up ahead of edge (chip)", "Å", "surface"),
    "pileup_behind": ("pile-up behind edge (burr)", "Å", "surface"), "atoms_above_surface": ("atoms above surface", "", "surface"),
    "chip_atoms": ("chip atoms", "", "surface"), "chip_volume": ("chip volume", "nm³", "surface"),
    "Ra": ("machined surface roughness Ra", "Å", "surface"), "Rq": ("machined surface roughness Rq", "Å", "surface"),
    "Rz": ("machined surface peak-to-valley Rz", "Å", "surface"), "machined_level": ("machined surface level − original", "Å", "surface"),
    "damage_depth": ("subsurface damage depth", "Å", "structure"), "ws_vacancies": ("vacancies (Wigner–Seitz)", "", "defects"),
    "ws_interstitials": ("interstitials (Wigner–Seitz)", "", "defects"), "dxa_length": ("dislocation line length", "Å", "defects"),
    "dxa_density": ("dislocation density", "m⁻²", "defects"),
    # regional
    "n": ("atoms", "", "count"), "T_com": ("temperature (COM removed)", "K", "temperature"),
    "T_local.mean": ("mean local temperature", "K", "temperature"), "T_local.max": ("max local temperature", "K", "temperature"),
    "T_local.std": ("std of local temperature", "K", "temperature"),
    "ke.mean": ("mean kinetic energy per atom", "eV", "energy"), "pe.mean": ("mean potential energy per atom", "eV", "energy"),
    "pe.sum": ("total potential energy", "eV", "energy"),
    "Fx_sum": ("ΣFx", "nN", "force"), "Fy_sum": ("ΣFy", "nN", "force"), "Fz_sum": ("ΣFz", "nN", "force"), "F_abs.mean": ("mean |F| per atom", "nN", "force"),
    "vx_com": ("COM velocity x", "m/s", "velocity"), "vy_com": ("COM velocity y", "m/s", "velocity"), "vz_com": ("COM velocity z", "m/s", "velocity"),
    "disp.mean": ("mean displacement |u|", "Å", "displacement"), "disp.max": ("max displacement |u|", "Å", "displacement"),
    "msd": ("mean squared displacement", "Å²", "displacement"), "ux.mean": ("mean ux", "Å", "displacement"),
    "uy.mean": ("mean uy", "Å", "displacement"), "uz.mean": ("mean uz", "Å", "displacement"),
    "cn.mean": ("mean coordination number", "", "structure"), "disordered_n": ("disordered atoms", "", "structure"),
    "disordered_frac": ("disordered fraction", "", "structure"),
    "shear_strain.mean": ("mean von Mises shear strain", "", "strain"), "shear_strain.max": ("max von Mises shear strain", "", "strain"),
    "shear_strain.p95": ("95th percentile shear strain", "", "strain"), "vol_strain.mean": ("mean volumetric strain", "", "strain"),
    "plastic_n": ("atoms above shear-strain threshold", "", "strain"), "plastic_frac": ("plastic (strained) fraction", "", "strain"),
    "atomic_volume.mean": ("mean atomic volume", "Å³", "geometry"),
    "rdf_peak_r": ("RDF first peak position", "Å", "rdf"), "rdf_peak_g": ("RDF first peak height", "", "rdf"),
    "rdf_min_r": ("RDF first minimum", "Å", "rdf"), "rdf_cn": ("coordination from RDF (to first minimum)", "", "rdf"),
    "bad_peak": ("bond-angle distribution peak", "deg", "rdf"), "bad_mean": ("mean bond angle", "deg", "rdf"),
}
STAT_LABEL = {"mean": "mean", "std": "std", "min": "min", "max": "max", "p95": "95th pct", "p99": "99th pct"}


def cfg_with_defaults(cfg):
    out = dict(DEFAULTS)
    out.update({k: v for k, v in (cfg or {}).items() if v is not None})
    out["tool_types"] = [int(t) for t in out.get("tool_types") or []]
    out["types"] = {int(k): dict(v) for k, v in (out.get("types") or {}).items()}
    return out


def describe(key):
    """{label, unit, category, region} of a scalar key ("<quantity>@<region>" or a global quantity)."""
    q, _, reg = key.partition("@")
    lab, unit, cat = Q.get(q, (None, "", "other"))
    if lab is None:
        m = re.match(r"^(vir\.)?(\w+?)(?:\.(mean|std|min|max|p95|p99))?_GPa$", q)
        if m and m.group(2) in st.MEASURES:
            sl, unit = st.MEASURES[m.group(2)]
            lab = (f"virial-average {sl}" if m.group(1) else f"{STAT_LABEL.get(m.group(3), '')} {sl}").strip()
            cat = "stress"
        elif q.startswith("cn_frac_"):
            lab, cat = f"fraction with CN = {q[8:].replace('ge', '≥ ')}", "structure"
        elif q.startswith("struct_frac_"):
            lab, cat = f"fraction {q[12:].replace('_', ' ')}", "structure"
        else:
            lab = q
    return dict(label=f"{lab} ({REGION_LABEL.get(reg, reg)})" if reg else lab, unit=unit, category=cat, region=reg or None, quantity=q)


def nominal_volume(structure, a0):
    return a0 ** 3 / ATOMS_PER_CELL[structure]


def type_table_from_experiment(exp):
    """Suggested {type: {name, mass, volume, role}} for a NanoCut run (type 1 = tool, then the workpiece elements)."""
    from .materials import MATERIALS, TOOL_MATERIALS
    w, t = exp["workpiece"], exp["tool"]
    mat, tm = MATERIALS[w["material"]], TOOL_MATERIALS.get(t.get("material", "diamond"), TOOL_MATERIALS["diamond"])
    out = {1: dict(name=tm["elements"][0], mass=MASS[tm["elements"][0]], volume=round(nominal_volume(tm["structure"], t.get("a0", tm["a0"])), 4), role="tool")}
    for i, e in enumerate(mat["elements"]):
        out[i + 2] = dict(name=e, mass=MASS[e], volume=round(nominal_volume(mat["structure"], w.get("a0", mat["a0"])), 4), role="workpiece")
    return out


# ---------------------------------------------------------------------------------------------- helpers
def _top_median(x, z, y, cell):
    if not len(y):
        return None
    key = np.floor(x / cell).astype(np.int64) * 1_000_003 + np.floor(z / cell).astype(np.int64)
    order = np.lexsort((-y, key))
    first = np.r_[True, key[order][1:] != key[order][:-1]]
    return float(np.median(y[order][first]))


def _column_top(x, z, y, cell):
    """Highest y per (x, z) column: (column key per atom, top per atom, column centres x, column tops)."""
    ix, iz = np.floor(x / cell).astype(np.int64), np.floor(z / cell).astype(np.int64)
    key = ix * 1_000_003 + iz
    uk, inv = np.unique(key, return_inverse=True)
    top = np.full(len(uk), -np.inf)
    np.maximum.at(top, inv, y)
    cx = (np.floor_divide(uk, 1_000_003) + 0.5) * cell
    return inv, top[inv], cx, top


def _stats(a, which=("mean", "std", "min", "max")):
    a = np.asarray(a, dtype=np.float64)
    a = a[np.isfinite(a)]
    if not len(a):
        return {}
    f = {"mean": np.mean, "std": np.std, "min": np.min, "max": np.max, "sum": np.sum,
         "p95": lambda v: np.percentile(v, 95), "p99": lambda v: np.percentile(v, 99)}
    return {s: float(f[s](a)) for s in which}


def _col(cols, *names):
    for n in names:
        if n in cols:
            return np.asarray(cols[n], dtype=np.float64)
    return None


def stress_prefix(cols, prefer=None):
    """Prefix P of a 6-component per-atom stress (P[1] … P[6], e.g. c_s), or None."""
    cands = [m.group(1) for c in cols for m in [re.match(r"^(c_\w+)\[1\]$", c)] if m and all(f"{m.group(1)}[{i}]" in cols for i in range(1, 7))]
    if prefer and prefer in cands:
        return prefer
    for p in ("c_s", "c_stress", "c_st", "c_peratom", "c_sa"):
        if p in cands:
            return p
    return cands[0] if cands else None


def _min_image(d, cell, pbc):
    H = np.asarray(cell, dtype=np.float64)[:, :3]
    if not np.any(pbc) or abs(np.linalg.det(H)) < 1e-12:
        return d
    f = d @ np.linalg.inv(H).T
    for k in range(3):
        if pbc[k]:
            f[:, k] -= np.round(f[:, k])
    return f @ H.T


def _r(a, digits=6):
    """Array -> JSON list (NaN -> None), rounded to `digits` significant digits."""
    a = np.asarray(a, dtype=np.float64)
    return [None if not np.isfinite(v) else float(f"{v:.{digits}g}") for v in a.ravel()]


# ---------------------------------------------------------------------------------------------- reference frame
def reference(fr0, cfg):
    cfg = cfg_with_defaults(cfg)
    ids, pos, typ = np.asarray(fr0["ids"]), np.asarray(fr0["pos"], dtype=np.float64), np.asarray(fr0["types"])
    tool = np.isin(typ, cfg["tool_types"])
    wp = ~tool
    order = np.argsort(ids)
    ref = dict(ids=ids[order], pos=pos[order], surface_y=_top_median(pos[wp, 0], pos[wp, 2], pos[wp, 1], cfg["surface_cell"]),
               tool_com=pos[tool].mean(0) if tool.any() else None, wp_x=(float(pos[wp, 0].min()), float(pos[wp, 0].max())) if wp.any() else None)
    vol = [cfg["types"].get(int(t), {}).get("volume") for t in typ[wp]] if wp.any() else []
    if vol and all(v for v in vol):
        ref["density"], ref["density_source"] = 1.0 / float(np.mean(vol)), "1 / mean nominal atomic volume of the workpiece"
    elif wp.any():
        span = np.ptp(pos[wp], axis=0)
        ref["density"], ref["density_source"] = float(wp.sum() / max(np.prod(span), 1e-9)), "workpiece atoms / bounding-box volume (frame 0)"
    tw = typ[wp]
    ref["composition"] = {int(t): float((tw == t).mean()) for t in np.unique(tw)} if wp.any() else {}
    return ref


# ---------------------------------------------------------------------------------------------- the analysis
def analyze_frame(fr, ref, cfg, neighbors=None):
    cfg = cfg_with_defaults(cfg)
    notes = []
    ids, typ = np.asarray(fr["ids"]), np.asarray(fr["types"]).astype(int)
    pos = np.asarray(fr["pos"], dtype=np.float64)
    cols = fr.get("cols") or {}
    N = len(ids)
    x, y, z = pos.T
    names = {int(k): v for k, v in (fr.get("type_names") or {}).items() if v}
    ttab = cfg["types"]
    sgn = -1.0 if cfg["direction"] == "-x" else 1.0
    S = {"frame": fr.get("frame"), "step": fr.get("step")}
    if cfg["dt_ps"] and fr.get("step") is not None:
        S["time_ps"] = fr["step"] * cfg["dt_ps"]

    # --- per-atom inputs
    mass = _col(cols, "mass")
    if mass is None:
        tm = {t: ttab.get(t, {}).get("mass") or MASS.get(names.get(t, ""), None) for t in np.unique(typ)}
        if all(tm.values()):
            mass = np.array([tm[t] for t in typ], dtype=np.float64)
        else:
            notes.append(f"masses unknown for type(s) {[t for t, m in tm.items() if not m]}: temperatures from velocities skipped")
    vel = np.stack([cols[c] for c in ("vx", "vy", "vz")], 1).astype(np.float64) if all(c in cols for c in ("vx", "vy", "vz")) else None
    frc = np.stack([cols[c] for c in ("fx", "fy", "fz")], 1).astype(np.float64) if all(c in cols for c in ("fx", "fy", "fz")) else None
    ke = _col(cols, "f_keav", "c_ke")
    if ke is None and vel is not None and mass is not None:
        ke = 0.5 * mass * (vel ** 2).sum(1) * MVV2E
    T_local = 2.0 * ke / (3.0 * KB) if ke is not None else None
    pe = _col(cols, "c_pe", "c_pe_atom", "c_epot")
    if vel is None:
        notes.append("no vx vy vz: COM-removed temperatures and velocities skipped")
    if frc is None:
        notes.append("no fx fy fz: forces skipped")

    # atomic volume
    vol = None
    if cfg["volume_mode"] == "voronoi" and fr.get("voronoi_volume") is not None:
        vol = np.asarray(fr["voronoi_volume"], dtype=np.float64)
    else:
        tv = {t: ttab.get(t, {}).get("volume") for t in np.unique(typ)}
        if all(tv.values()):
            vol = np.array([tv[t] for t in typ], dtype=np.float64)
        elif any(tv.values()):
            vol = np.array([tv[t] or np.nan for t in typ], dtype=np.float64)
            notes.append(f"atomic volume unknown for type(s) {[t for t, v in tv.items() if not v]}: their stress is missing")
        else:
            notes.append("no atomic volumes: stresses need a volume per type (or Voronoi)")
    pref = stress_prefix(cols, cfg.get("stress_prefix"))
    s6 = sm = S6raw = None
    if pref and vol is not None:
        S6raw = np.stack([np.asarray(cols[f"{pref}[{i}]"], dtype=np.float64) for i in range(1, 7)], 1)
        s6 = st.to_gpa(S6raw, vol)
        sm = st.measures(s6)
    elif not pref:
        notes.append("no per-atom stress columns (c_s[1..6]): stresses skipped")

    disp = None
    if ref is not None and len(ref["ids"]):
        k = np.searchsorted(ref["ids"], ids)
        k = np.clip(k, 0, len(ref["ids"]) - 1)
        ok = ref["ids"][k] == ids
        disp = np.full((N, 3), np.nan)
        disp[ok] = _min_image(pos[ok] - ref["pos"][k[ok]], fr.get("cell", np.eye(3, 4)), fr.get("pbc", (False,) * 3))
    cn = fr.get("coordination")
    cn = np.asarray(cn) if cn is not None else _col(cols, "c_cn", "c_coord", "c_cn1")
    struct = np.asarray(fr["structure"]) if fr.get("structure") is not None else None
    snames = fr.get("structure_names") or []
    shear = np.asarray(fr["shear_strain"], dtype=np.float64) if fr.get("shear_strain") is not None else None
    volstrain = np.asarray(fr["vol_strain"], dtype=np.float64) if fr.get("vol_strain") is not None else None

    # --- regions
    tool = np.isin(typ, cfg["tool_types"])
    wp = ~tool
    R = {"all": np.ones(N, bool), "tool": tool, "workpiece": wp}
    mol = _col(cols, "mol")
    if mol is not None:
        for m in range(1, 7):
            mm = mol == m
            if mm.any():
                R[f"mol{m}"] = mm
    for t in np.unique(typ):
        R[f"type{t}"] = typ == t
        REGION_LABEL.setdefault(f"type{t}", f"type {t}" + (f" ({names.get(t) or ttab.get(t, {}).get('name')})" if names.get(t) or ttab.get(t, {}).get("name") else ""))
    ys = ref.get("surface_y") if ref else None
    S["surface_y"] = ys
    pbc = fr.get("pbc", (False, False, True))
    cell = np.asarray(fr.get("cell", np.eye(3, 4)), dtype=np.float64)
    S["width_z"] = float(np.linalg.norm(cell[:, 2])) if pbc[2] else (float(np.ptp(z[wp])) if wp.any() else None)
    geo = {}
    if tool.any():
        tip = float(x[tool].min() if sgn < 0 else x[tool].max())
        bottom = float(y[tool].min())
        low = tool & (y < bottom + 1.0)
        xlow = float(x[low].mean())
        com = (pos[tool] * mass[tool, None]).sum(0) / mass[tool].sum() if mass is not None else pos[tool].mean(0)
        # contact point: leading tool atom below the original surface, at mid-height of the uncut chip thickness
        below = tool & (y < ys) if ys is not None else tool
        xc = float((x[below].min() if sgn < 0 else x[below].max()) if below.any() else tip)
        yc = 0.5 * (bottom + ys) if ys is not None and ys > bottom else bottom
        geo = dict(tip=tip, bottom=bottom, xlow=xlow, xc=xc, yc=yc)
        S.update(contact_x=xc, contact_y=yc)
        S.update(tool_tip_x=tip, tool_bottom_y=bottom, tool_com_x=float(com[0]), tool_com_y=float(com[1]))
        if ref is not None and ref.get("tool_com") is not None:
            S["cut_distance"] = float(abs(com[0] - ref["tool_com"][0]))
            S["cut_distance_nm"] = S["cut_distance"] / 10.0
        if ys is not None:
            S["depth_of_cut"] = ys - bottom
        R["contact"] = wp & ((x - xc) ** 2 + (y - yc) ** 2 <= cfg["contact_radius"] ** 2)
        ahead = (x - tip) * sgn > 0
        if ys is not None:
            R["chip"] = wp & ahead & (y > ys + cfg["chip_threshold"])
        R["subsurface"] = wp & ((x - xlow) * sgn < 0) & (y <= bottom) & (y >= bottom - cfg["subsurface_depth"])
        if vel is not None and mass is not None:
            vt = (vel[tool] * mass[tool, None]).sum(0) / mass[tool].sum()
            S["tool_speed_vel"] = float(vt[0] * sgn * APS_TO_MS)
    else:
        notes.append("no tool atoms (tool types): tool, zone, force and surface quantities skipped")

    # --- per-region scalars
    for rn, mk in R.items():
        n = int(mk.sum())
        S[f"n@{rn}"] = n
        if not n:
            continue
        if vel is not None and mass is not None and n >= 2:
            m, v = mass[mk], vel[mk]
            vc = (m[:, None] * v).sum(0) / m.sum()
            S[f"T_com@{rn}"] = float((m * ((v - vc) ** 2).sum(1)).sum() * MVV2E / (3.0 * n * KB))
            S[f"vx_com@{rn}"], S[f"vy_com@{rn}"], S[f"vz_com@{rn}"] = (float(c * APS_TO_MS) for c in vc)
        if T_local is not None:
            for s_, v_ in _stats(T_local[mk], ("mean", "max", "std")).items():
                S[f"T_local.{s_}@{rn}"] = v_
        if ke is not None:
            S[f"ke.mean@{rn}"] = float(np.nanmean(ke[mk]))
        if pe is not None:
            S[f"pe.mean@{rn}"], S[f"pe.sum@{rn}"] = float(np.nanmean(pe[mk])), float(np.nansum(pe[mk]))
        if frc is not None:
            f = frc[mk]
            f = f[np.isfinite(f).all(1)]
            tot = f.sum(0) * EV_A_TO_NN
            S[f"Fx_sum@{rn}"], S[f"Fy_sum@{rn}"], S[f"Fz_sum@{rn}"] = (float(c) for c in tot)
            S[f"F_abs.mean@{rn}"] = float(np.sqrt((f ** 2).sum(1)).mean() * EV_A_TO_NN) if len(f) else None
        if sm is not None:
            for name, arr in sm.items():
                for s_, v_ in _stats(arr[mk], STATS_MAIN if name in MAIN else ("mean", "std")).items():
                    S[f"{name}.{s_}_GPa@{rn}"] = v_
            vt = st.virial_average(S6raw, vol, mk & np.isfinite(vol))
            if vt is not None:
                for name, v_ in st.measures(vt[None, :], ["von_mises", "pressure", "hydro", "s1", "s2", "s3", "tau_max",
                                                          "sxx", "syy", "szz", "sxy", "sxz", "syz"]).items():
                    S[f"vir.{name}_GPa@{rn}"] = float(v_[0])
        if vol is not None:
            S[f"atomic_volume.mean@{rn}"] = float(np.nanmean(vol[mk]))
        if disp is not None:
            d = disp[mk]
            d = d[np.isfinite(d).all(1)]
            if len(d):
                dm = np.sqrt((d ** 2).sum(1))
                S[f"disp.mean@{rn}"], S[f"disp.max@{rn}"], S[f"msd@{rn}"] = float(dm.mean()), float(dm.max()), float((dm ** 2).mean())
                S[f"ux.mean@{rn}"], S[f"uy.mean@{rn}"], S[f"uz.mean@{rn}"] = (float(c) for c in d.mean(0))
        if cn is not None:
            c = np.asarray(cn[mk]).astype(int)
            S[f"cn.mean@{rn}"] = float(c.mean())
            for v_ in range(0, 9):
                if (c == v_).any():
                    S[f"cn_frac_{v_}@{rn}"] = float((c == v_).mean())
            if (c >= 9).any():
                S[f"cn_frac_ge9@{rn}"] = float((c >= 9).mean())
        if struct is not None:
            sv = struct[mk]
            for i in np.unique(sv):
                lab = snames[i] if i < len(snames) else str(i)
                S[f"struct_frac_{re.sub(r'[^0-9A-Za-z]+', '_', lab).strip('_')}@{rn}"] = float((sv == i).mean())
            S[f"disordered_n@{rn}"] = int((sv == 0).sum())
            S[f"disordered_frac@{rn}"] = float((sv == 0).mean())
        if shear is not None:
            for s_, v_ in _stats(shear[mk], ("mean", "max", "p95")).items():
                S[f"shear_strain.{s_}@{rn}"] = v_
            S[f"plastic_n@{rn}"] = int((shear[mk] > cfg["strain_threshold"]).sum())
            S[f"plastic_frac@{rn}"] = float((shear[mk] > cfg["strain_threshold"]).mean())
        if volstrain is not None:
            S[f"vol_strain.mean@{rn}"] = float(np.nanmean(volstrain[mk]))

    # --- cutting mechanics
    if tool.any() and frc is not None:
        fx, fy, fz = S["Fx_sum@tool"], S["Fy_sum@tool"], S["Fz_sum@tool"]
        Fc, Ft = abs(fx), abs(fy)
        S.update(Fc=Fc, Ft=Ft, Fz=abs(fz), F_res=float(np.sqrt(fx * fx + fy * fy + fz * fz)))
        if Fc > 0:
            S["Ft_over_Fc"] = Ft / Fc
            S["friction_angle"] = float(cfg["rake_deg"] + np.degrees(np.arctan2(Ft, Fc)))
        if Ft > 0:
            S["mu"] = Fc / Ft
        d, w = S.get("depth_of_cut"), S.get("width_z")
        if d and w and d > 0:
            S["specific_energy"] = Fc / (d / 10.0 * w / 10.0)

    # --- surface: pile-up, chip, roughness, damage
    if tool.any() and ys is not None and wp.any():
        tip, xlow, bottom = geo["tip"], geo["xlow"], geo["bottom"]
        ahead = wp & ((x - tip) * sgn > 0)
        S["pileup_max"] = float(y[wp].max() - ys)
        S["pileup_ahead"] = float(y[ahead].max() - ys) if ahead.any() else None
        beh = wp & ~ahead
        S["pileup_behind"] = float(y[beh].max() - ys) if beh.any() else None
        S["atoms_above_surface"] = int((wp & (y > ys + cfg["chip_threshold"])).sum())
        ch = R.get("chip")
        S["chip_atoms"] = int(ch.sum())
        if vol is not None:
            S["chip_volume"] = float(np.nansum(vol[ch]) / 1000.0)
        inv, ctop, cx, tops = _column_top(x[wp], z[wp], y[wp], cfg["column_cell"])
        x0, x1 = ref["wp_x"] if ref.get("wp_x") else (x[wp].min(), x[wp].max())
        lo, hi = (xlow + 5.0, x1 - 10.0) if sgn < 0 else (x0 + 10.0, xlow - 5.0)
        mach = (cx >= lo) & (cx <= hi)
        if mach.sum() >= 3:
            h = tops[mach]
            S["Ra"], S["Rq"], S["Rz"] = float(np.abs(h - h.mean()).mean()), float(h.std()), float(h.max() - h.min())
            S["machined_level"] = float(h.mean() - ys)
        if struct is not None or cn is not None:
            if struct is not None:
                dis = struct[wp] == 0
            else:
                c = np.asarray(cn[wp]).astype(int)
                dis = c != np.bincount(c[c >= 0]).argmax()
            xw, yw = x[wp], y[wp]
            interior = (yw < ctop - 3.0) & (yw > y[wp].min() + 10.0) & (xw > x0 + 10.0) & (xw < x1 - 10.0)
            dmg = dis & interior & ((xw - xlow) * sgn < 0) & (yw < bottom)
            S["damage_depth"] = float(bottom - yw[dmg].min()) if dmg.any() else 0.0
    if fr.get("ws"):
        S["ws_vacancies"], S["ws_interstitials"] = fr["ws"].get("vacancies"), fr["ws"].get("interstitials")
    if fr.get("dxa") and fr["dxa"].get("length") is not None:
        S["dxa_length"] = float(fr["dxa"]["length"])
        if vol is not None and wp.any():
            S["dxa_density"] = float(fr["dxa"]["length"] * 1e-10 / (np.nansum(vol[wp]) * 1e-30))

    curves, maps = {}, {}
    names_of = lambda t: names.get(t) or ttab.get(t, {}).get("name") or f"type {t}"

    # --- RDF and bond angles from neighbour pairs
    bond_cut = cfg["bond_cutoff"]
    if neighbors is not None and (cfg["rdf"] or cfg["bad"]) and wp.any() and ref is not None:
        rho = ref.get("density")
        comp = ref.get("composition", {})
        wtypes = sorted(comp)
        rmax = float(cfg["rdf_rmax"]) if cfg["rdf"] else float(bond_cut or 2.4)
        edges = np.linspace(0.0, rmax, int(cfg["rdf_bins"]) + 1)
        shell = 4.0 / 3.0 * np.pi * (edges[1:] ** 3 - edges[:-1] ** 3)
        rc = 0.5 * (edges[1:] + edges[:-1])
        for rn in cfg["rdf_regions"]:
            mk = R.get(rn)
            if mk is None or not mk.any():
                continue
            cidx = np.nonzero(mk)[0]
            if len(cidx) > cfg["max_centers"]:
                cidx = cidx[np.argsort(ids[cidx])][:: int(np.ceil(len(cidx) / cfg["max_centers"]))]
            hist = {(a, b): np.zeros(len(rc)) for a in wtypes for b in wtypes}
            ncent = {a: int((typ[cidx] == a).sum()) for a in wtypes}
            angles = []
            for a0 in range(0, len(cidx), 5000):
                chunk = cidx[a0:a0 + 5000]
                pairs, vec = neighbors(chunk, rmax)
                pairs, vec = np.asarray(pairs), np.asarray(vec, dtype=np.float64)
                keep = wp[pairs[:, 1]]
                pairs, vec = pairs[keep], vec[keep]
                r = np.sqrt((vec ** 2).sum(1))
                if cfg["rdf"]:
                    bi = np.clip(np.searchsorted(edges, r, side="right") - 1, 0, len(rc) - 1)
                    ta, tb = typ[pairs[:, 0]], typ[pairs[:, 1]]
                    for (a, b), hh in hist.items():
                        sel = (ta == a) & (tb == b) & (r < rmax)
                        hh += np.bincount(bi[sel], minlength=len(rc))[: len(rc)]
                if cfg["bad"]:
                    angles.append((pairs, vec, r))
            if cfg["rdf"] and rho:
                ntot = sum(ncent.values())
                tot = sum(hist.values())
                g = tot / (max(ntot, 1) * rho * shell)
                series = {"total": g}
                for (a, b), hh in hist.items():
                    if a <= b and ncent[a] and comp.get(b):
                        series[f"{names_of(a)}–{names_of(b)}"] = hh / (ncent[a] * comp[b] * rho * shell)
                curves[f"rdf@{rn}"] = dict(x=_r(rc), xlabel="r (Å)", ylabel="g(r)", series={k: _r(v) for k, v in series.items()},
                                           note=f"centres: {ntot} {REGION_LABEL.get(rn, rn)} atoms; neighbours: workpiece; ρ = {rho:.5g} Å⁻³ ({ref.get('density_source')})")
                gs = np.convolve(g, np.ones(3) / 3, mode="same")
                lo_ = rc > 0.8
                # first peak = first local maximum of the smoothed g(r) above 1 (in a crystal the 2nd shell can be higher)
                ip = next((i for i in range(1, len(rc) - 1) if lo_[i] and gs[i] > 1.0 and gs[i] >= gs[i - 1] and gs[i] > gs[i + 1]), None)
                if ip is not None:
                    ip = max(range(max(ip - 2, 0), min(ip + 3, len(rc))), key=lambda i: g[i])   # exact bin of the raw peak
                    S[f"rdf_peak_r@{rn}"], S[f"rdf_peak_g@{rn}"] = float(rc[ip]), float(g[ip])
                    im = next((i for i in range(ip + 2, len(rc) - 1) if gs[i] <= gs[i - 1] and gs[i] <= gs[i + 1]), None)
                    if im is not None:
                        S[f"rdf_min_r@{rn}"] = float(rc[im])
                        S[f"rdf_cn@{rn}"] = float(tot[: im + 1].sum() / max(ntot, 1))
                        if rn == "workpiece" and bond_cut is None:
                            bond_cut = float(np.clip(edges[im + 1], 1.2, 3.5))
            if cfg["bad"]:
                rb = float(bond_cut or 2.4)
                acc = []
                for pairs, vec, r in angles:
                    sel = r < rb
                    p, v, rr = pairs[sel], vec[sel], r[sel]
                    if not len(p):
                        continue
                    u = v / rr[:, None]
                    cen, start, cnt = np.unique(p[:, 0], return_index=True, return_counts=True)
                    order = np.argsort(p[:, 0], kind="stable")
                    u = u[order]
                    start = np.r_[0, np.cumsum(cnt)[:-1]]
                    for k in np.unique(cnt):
                        if k < 2 or k > 16:
                            continue
                        s0 = start[cnt == k]
                        blk = u[s0[:, None] + np.arange(k)]                  # (m, k, 3)
                        dots = np.einsum("mik,mjk->mij", blk, blk)
                        iu = np.triu_indices(k, 1)
                        acc.append(np.degrees(np.arccos(np.clip(dots[:, iu[0], iu[1]].ravel(), -1, 1))))
                if acc:
                    th = np.concatenate(acc)
                    e = np.linspace(0, 180, int(cfg["bad_bins"]) + 1)
                    h, _ = np.histogram(th, e)
                    pdf = h / (h.sum() * np.diff(e))
                    c = 0.5 * (e[1:] + e[:-1])
                    curves[f"bad@{rn}"] = dict(x=_r(c), xlabel="bond angle θ (deg)", ylabel="P(θ) (1/deg)", series={"P(θ)": _r(pdf)},
                                               note=f"bonds shorter than {rb:.3g} Å; {len(th)} angles")
                    S[f"bad_peak@{rn}"], S[f"bad_mean@{rn}"] = float(c[np.argmax(pdf)]), float(th.mean())

    # --- coordination histograms
    if cn is not None:
        for rn in ("workpiece", "contact", "chip", "subsurface"):
            mk = R.get(rn)
            if mk is not None and mk.any():
                c = np.asarray(cn[mk]).astype(int)
                b = np.bincount(np.clip(c, 0, 12), minlength=13)
                curves[f"cn_hist@{rn}"] = dict(x=list(range(13)), xlabel="coordination number", ylabel="fraction of atoms",
                                               series={"fraction": _r(b / b.sum())}, kind="bar")

    # --- per-atom fields for histograms, profiles, maps
    fields = {}
    if sm is not None:
        fields.update(von_mises=("von Mises stress (GPa)", sm["von_mises"]), pressure=("pressure (GPa)", sm["pressure"]),
                      s1=("σ1 (GPa)", sm["s1"]), tau_max=("max shear stress (GPa)", sm["tau_max"]))
    if T_local is not None:
        fields["T_local"] = ("local temperature (K)", T_local)
    if pe is not None:
        fields["pe"] = ("potential energy (eV/atom)", pe)
    if shear is not None:
        fields["shear_strain"] = ("von Mises shear strain", shear)
    if struct is not None:
        fields["disordered"] = ("disordered fraction", (struct == 0).astype(float))
    if disp is not None:
        fields["uy"] = ("displacement uy (Å)", disp[:, 1])
    if cfg["hist"]:
        for q, (lab, arr) in fields.items():
            if q in ("disordered",):
                continue
            for rn in ("workpiece", "contact"):
                mk = R.get(rn)
                if mk is None or not mk.any():
                    continue
                a = arr[mk]
                a = a[np.isfinite(a)]
                if len(a) < 2:
                    continue
                lo_, hi_ = np.percentile(a, [0.1, 99.9])
                if hi_ <= lo_:
                    continue
                h, e = np.histogram(a, np.linspace(lo_, hi_, int(cfg["hist_bins"]) + 1))
                curves[f"hist.{q}@{rn}"] = dict(x=_r(0.5 * (e[1:] + e[:-1])), xlabel=lab, ylabel="fraction of atoms", series={"fraction": _r(h / len(a))})
    if cfg["profiles"] and geo and ys is not None:
        xlow, bottom, xc = geo["xlow"], geo["bottom"], geo["xc"]
        slab = wp & (np.abs(x - xc) <= cfg["profile_half_width"])
        if slab.any():
            depth = ys - y
            pb = cfg["profile_bin"]
            e = np.arange(np.floor(depth[slab].min() / pb) * pb, max(depth[slab].max(), 1.0) + pb, pb)   # negative = above (chip)
            bi = np.clip(np.digitize(depth[slab], e) - 1, 0, len(e) - 1)
            cnt = np.bincount(bi, minlength=len(e))
            for q, (lab, arr) in fields.items():
                a = arr[slab]
                ok = np.isfinite(a)
                s_ = np.bincount(bi[ok], weights=a[ok], minlength=len(e))
                c_ = np.bincount(bi[ok], minlength=len(e))
                with np.errstate(invalid="ignore", divide="ignore"):
                    m_ = np.where(c_ >= 2, s_ / np.maximum(c_, 1), np.nan)
                curves[f"depth.{q}"] = dict(x=_r(e[:-1] + cfg["profile_bin"] / 2), xlabel="depth below original surface (Å)", ylabel=lab,
                                            series={"mean": _r(m_[:-1])}, note=f"workpiece atoms within ±{cfg['profile_half_width']} Å of the contact point (x = {xc:.1f} Å)")
        band = wp & (y <= bottom) & (y >= bottom - cfg["subsurface_depth"])
        if band.any():
            e = np.arange(x[band].min(), x[band].max() + cfg["profile_bin"] * 2, cfg["profile_bin"] * 2)
            bi = np.clip(np.digitize(x[band], e) - 1, 0, len(e) - 1)
            for q, (lab, arr) in fields.items():
                a = arr[band]
                ok = np.isfinite(a)
                s_ = np.bincount(bi[ok], weights=a[ok], minlength=len(e))
                c_ = np.bincount(bi[ok], minlength=len(e))
                with np.errstate(invalid="ignore", divide="ignore"):
                    m_ = np.where(c_ >= 2, s_ / np.maximum(c_, 1), np.nan)
                curves[f"length.{q}"] = dict(x=_r(e + cfg["profile_bin"]), xlabel="x (Å)", ylabel=lab, series={"mean": _r(m_)},
                                             note=f"band {cfg['subsurface_depth']} Å below the tool bottom")
        if wp.any():
            e = np.arange(x[wp].min(), x[wp].max() + 5.0, 5.0)
            bi = np.clip(np.digitize(x[wp], e) - 1, 0, len(e) - 1)
            top = np.full(len(e), -np.inf)
            np.maximum.at(top, bi, y[wp])
            top[~np.isfinite(top)] = np.nan
            curves["surface_profile"] = dict(x=_r(e + 2.5), xlabel="x (Å)", ylabel="height above original surface (Å)", series={"surface": _r(top - ys)})
    if cfg["maps"] and wp.any():
        b = float(cfg["map_bin"])
        x0, y0 = float(np.floor(x[wp].min())), float(np.floor(y[wp].min()))
        nx, ny = int(np.ceil((x[wp].max() - x0) / b)) + 1, int(np.ceil((y[wp].max() - y0) / b)) + 1
        if nx * ny <= 250_000:
            ix, iy = ((x[wp] - x0) // b).astype(int), ((y[wp] - y0) // b).astype(int)
            flat = iy * nx + ix
            for q, (lab, arr) in fields.items():
                a = arr[wp]
                ok = np.isfinite(a)
                s_ = np.bincount(flat[ok], weights=a[ok], minlength=nx * ny)
                c_ = np.bincount(flat[ok], minlength=nx * ny)
                with np.errstate(invalid="ignore", divide="ignore"):
                    m_ = np.where(c_ >= 2, s_ / np.maximum(c_, 1), np.nan)
                maps[q] = dict(x0=x0, y0=y0, dx=b, dy=b, nx=nx, ny=ny, label=lab, v=_r(m_, 5),
                               note="workpiece, averaged over z")
    S = {k: (None if isinstance(v, float) and not np.isfinite(v) else v) for k, v in S.items()}
    return dict(frame=fr.get("frame"), step=fr.get("step"), scalars=S, curves=curves, maps=maps, notes=notes,
                regions={k: REGION_LABEL.get(k, k) for k in R}, stress_columns=pref, volume_mode=cfg["volume_mode"])


def finalize(rows, cfg=None):
    """Quantities that need several frames: cutting work ∫Fc dx and the tool speed between frames."""
    cfg = cfg_with_defaults(cfg)
    rows = sorted(rows, key=lambda r: r["frame"])
    work, prev = 0.0, None
    for r in rows:
        s = r["scalars"]
        if prev is not None:
            p = prev["scalars"]
            if None not in (s.get("Fc"), p.get("Fc"), s.get("cut_distance"), p.get("cut_distance")):
                work += 0.5 * (s["Fc"] + p["Fc"]) / EV_A_TO_NN * (s["cut_distance"] - p["cut_distance"])
            if cfg["dt_ps"] and None not in (s.get("step"), p.get("step"), s.get("tool_com_x"), p.get("tool_com_x")) and s["step"] != p["step"]:
                s["tool_speed_frames"] = abs(s["tool_com_x"] - p["tool_com_x"]) / ((s["step"] - p["step"]) * cfg["dt_ps"]) * APS_TO_MS
        if s.get("Fc") is not None and s.get("cut_distance") is not None:
            s["work_cum"] = work
        prev = r
    return rows


def catalogue(rows):
    keys = []
    seen = set()
    for r in rows:
        for k in r["scalars"]:
            if k not in seen:
                seen.add(k)
                keys.append(k)
    return {k: describe(k) for k in keys}
