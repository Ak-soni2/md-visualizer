"""Physics/numerics advice for an experiment.

Same rules as soft_warnings() in ui/app.py (Streamlit), restated against a model *summary* dict so the API does
not need a live geometry.Model. ui/app.py is intentionally left unchanged; keep the two in sync.
"""
from nanocut.materials import MATERIALS
from nanocut.potentials import POTENTIALS

A_PER_NM = 10.0


def soft_warnings(exp, model):
    w, t, p, th, o = exp["workpiece"], exp["tool"], exp["process"], exp["thermo"], exp["output"]
    mat = MATERIALS.get(w["material"], {})
    pot = POTENTIALS.get(exp["potential"]["key"])
    out = []
    if pot and (th["cut_dt_fs"] > pot["dt_fs"] + 1e-9 or th["equil_dt_fs"] > pot["dt_fs"] + 1e-9):
        out.append(f"Time step {max(th['cut_dt_fs'], th['equil_dt_fs'])} fs is above the usual {pot['dt_fs']} fs for {pot['label']}.")
    if t["deformable"] and t["material"] == "diamond" and th["cut_dt_fs"] > 0.3 + 1e-9:
        out.append("Deformable Tersoff diamond tool: literature uses 0.3 fs (C-C vibration ~25 fs period); 0.5 fs is the reference-deck choice.")
    if w["thermo_nm"] * A_PER_NM < 6.0:
        out.append("Thermostat layer thinner than ~6 Å (two potential cutoffs): heat extraction may be insufficient.")
    if t["shape"] == "wedge" and t["edge_radius_nm"] > 0 and p["depth_nm"] / t["edge_radius_nm"] < 0.25:
        out.append(f"d/r_edge = {p['depth_nm'] / t['edge_radius_nm']:.2f} < 0.25: rubbing/ploughing regime, little chip formation expected.")
    if p["gap_nm"] < 0.5:
        out.append("Tool starts within 0.5 nm of the workpiece end face: first contact happens during equilibration (reference decks use 0).")
    if th["equil_ps"] < 10:
        out.append(f"Equilibration {th['equil_ps']} ps is short; 10-30 ps is typical (reference decks: 5 ps).")
    if p["cut_length_nm"] < 15:
        out.append("Cutting length < 15 nm: steady-state forces are usually reached only after 15-25 nm of travel.")
    if not th["minimize_before_equil"]:
        out.append("No minimisation before velocities: lattice/potential mismatch converts to heat at the start (seen in the reference deck).")
    if model:
        pm = model.get("periodic_mismatch_A")
        if pm is not None and pm < 1.0:
            out.append(f"Tool lattice is not commensurate with the periodic width: image spacing {pm:.2f} Å at the z boundary. "
                       "Adjust tool origin shift z or workpiece width.")
        if model.get("Lz_A", 99) < 2 * 2.6:
            out.append("Width smaller than two cutoff radii: periodic images interact directly.")
    if mat.get("brittle") and mat.get("E_GPa"):
        dc = 0.15 * (mat["E_GPa"] / mat["H_GPa"]) * (mat["Kc"] / mat["H_GPa"]) ** 2 * 1000
        if p["depth_nm"] > dc:
            out.append(f"Depth {p['depth_nm']} nm exceeds the Bifano critical depth estimate {dc:.0f} nm for {w['material']} (brittle regime likely).")
    if o["forces_every"] % 10:
        out.append("forces_every must be a multiple of 10 (averaging window); it will be floored.")
    return out
