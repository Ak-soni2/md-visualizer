"""NanoCut UI (Streamlit). Run from the project root:  streamlit run ui/app.py"""
import io
import json
import os
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import numpy as np
import pandas as pd  # pre-import: plotly imports pandas lazily, which can race with Streamlit reruns
import plotly.graph_objects as go
import plotly.express as px
import streamlit as st

from nanocut import __version__
from nanocut.schema import Experiment, validate, A_PER_NM
from nanocut.materials import MATERIALS, TOOL_MATERIALS
from nanocut.potentials import POTENTIALS, potentials_for, MORSE, _morse_key
from nanocut.presets import PRESETS
from nanocut.geometry import Model, MOL
from nanocut.deck import deck_a, deck_b, write_run_folder, POT_DIR, model_summary
from nanocut import runner, analysis
from nanocut.mock import mock_frames

st.set_page_config(page_title="NanoCut", layout="wide")
RUNS = os.path.join(ROOT, "runs")

LAYER_NAMES = {1: "tool Newtonian", 2: "tool thermostat", 3: "tool fixed", 4: "workpiece Newtonian",
               5: "workpiece thermostat", 6: "workpiece fixed"}
# Streamlit's chart frontend string-replaces the placeholder colours #000001..#000010 in the figure JSON;
# Inferno's first stop is #000004, so it must be avoided (it would render as a categorical colour).
INFERNO = [c if c.lower() != "#000004" else "#050004" for c in px.colors.sequential.Inferno]
LAYER_COLORS = {1: "#7f7f7f", 2: "#ff7f0e", 3: "#1f1f1f", 4: "#1f77b4", 5: "#2ca02c", 6: "#9467bd"}

# ------------------------------------------------------------------ state
if "exp" not in st.session_state:
    st.session_state.exp = next(iter(PRESETS.values())).to_dict()
E = st.session_state.exp     # nested dict edited in place by the widgets


def num(section, attr, label, help, step=None, fmt=None, minv=None, maxv=None, integer=False):
    key = f"{section}.{attr}"
    cur = E[section][attr]
    kw = dict(value=int(cur) if integer else float(cur), help=help, key=key)
    if step is not None:
        kw["step"] = int(step) if integer else float(step)
    if fmt:
        kw["format"] = fmt
    if minv is not None:
        kw["min_value"] = int(minv) if integer else float(minv)
    if maxv is not None:
        kw["max_value"] = int(maxv) if integer else float(maxv)
    v = st.number_input(label, **kw)
    E[section][attr] = int(v) if integer else float(v)


def boolean(section, attr, label, help):
    E[section][attr] = bool(st.checkbox(label, value=bool(E[section][attr]), help=help, key=f"{section}.{attr}"))


def choice(section, attr, label, options, help, labels=None):
    cur = E[section][attr]
    idx = options.index(cur) if cur in options else 0
    v = st.selectbox(label, options, index=idx, help=help, key=f"{section}.{attr}",
                     format_func=(lambda o: labels.get(o, o)) if labels else (lambda o: o))
    E[section][attr] = v


def vec(section, attr, label, help):
    cur = " ".join(str(int(v)) for v in E[section][attr])
    s = st.text_input(label, value=cur, help=help, key=f"{section}.{attr}")
    try:
        E[section][attr] = tuple(int(x) for x in s.split())
    except ValueError:
        st.error("three integers expected")


def load_preset(name):
    st.session_state.exp = PRESETS[name].to_dict()
    for k in list(st.session_state.keys()):
        if "." in k:
            del st.session_state[k]


@st.cache_data(show_spinner=False)
def build_model(exp_json):
    exp = Experiment.from_json(exp_json)
    m = Model(exp)
    xyz, typ, mol = m.all_atoms()
    sm = model_summary(m)
    sm["laser_center_A"] = list(m.laser_center)
    sm["laser_radius_A"] = m.laser_radius
    return dict(summary=sm, xyz=xyz, typ=typ, mol=mol, outline=m.tool_outline(),
                sp_wp=m.sp_wp.tolist(), warnings=soft_warnings(exp, m))


@st.cache_data(show_spinner=False)
def build_decks(exp_json):
    exp = Experiment.from_json(exp_json)
    m = Model(exp)
    a, fa, wa = deck_a(exp, m)
    b, fb, wb = deck_b(exp, m)
    return a, b, sorted(set(fa + fb)), sorted(set(wa + wb))


def soft_warnings(exp, m):
    """Physics/numerics advice (not errors). Sources: reference/nanocutting_md_literature.md."""
    w, t, p, th, o = exp.workpiece, exp.tool, exp.process, exp.thermo, exp.output
    mat = MATERIALS[w.material]
    pot = POTENTIALS[exp.potential.key]
    out = []
    if th.cut_dt_fs > pot["dt_fs"] + 1e-9 or th.equil_dt_fs > pot["dt_fs"] + 1e-9:
        out.append(f"Time step {max(th.cut_dt_fs, th.equil_dt_fs)} fs is above the usual {pot['dt_fs']} fs for {pot['label']}.")
    if t.deformable and t.material == "diamond" and th.cut_dt_fs > 0.3 + 1e-9:
        out.append("Deformable Tersoff diamond tool: literature uses 0.3 fs (C-C vibration ~25 fs period); 0.5 fs is the reference-deck choice.")
    if w.thermo_nm * A_PER_NM < 6.0:
        out.append("Thermostat layer thinner than ~6 Å (two potential cutoffs): heat extraction may be insufficient.")
    if t.shape == "wedge" and t.edge_radius_nm > 0 and p.depth_nm / t.edge_radius_nm < 0.25:
        out.append(f"d/r_edge = {p.depth_nm / t.edge_radius_nm:.2f} < 0.25: rubbing/ploughing regime, little chip formation expected.")
    if p.gap_nm < 0.5:
        out.append("Tool starts within 0.5 nm of the workpiece end face: first contact happens during equilibration (reference decks use 0).")
    if th.equil_ps < 10:
        out.append(f"Equilibration {th.equil_ps} ps is short; 10-30 ps is typical (reference decks: 5 ps).")
    if p.cut_length_nm < 15:
        out.append("Cutting length < 15 nm: steady-state forces are usually reached only after 15-25 nm of travel.")
    if not th.minimize_before_equil:
        out.append("No minimisation before velocities: lattice/potential mismatch converts to heat at the start (seen in the reference deck).")
    pm = m.periodic_mismatch()
    if pm is not None and pm < 1.0:
        out.append(f"Tool lattice is not commensurate with the periodic width: image spacing {pm:.2f} Å at the z boundary (stacking defect plane). Adjust tool origin shift z or workpiece width.")
    if (m.tool_xmax - m.x_end) < p.cut_length_nm * 0 + 0:
        pass
    if m.Lz < 2 * 2.6:
        out.append("Width smaller than two cutoff radii: periodic images interact directly.")
    if mat.get("brittle") and mat.get("E_GPa"):
        dc = 0.15 * (mat["E_GPa"] / mat["H_GPa"]) * (mat["Kc"] / mat["H_GPa"]) ** 2 * 1000  # nm (Kc in MPa m^0.5 -> µm -> nm)
        if p.depth_nm > dc:
            out.append(f"Depth {p.depth_nm} nm exceeds the Bifano critical depth estimate {dc:.0f} nm for {w.material} (brittle regime likely).")
    if o.forces_every % 10:
        out.append("forces_every must be a multiple of 10 (averaging window); it will be floored.")
    return out


# ------------------------------------------------------------------ sidebar
with st.sidebar:
    st.title("NanoCut")
    st.caption(f"v{__version__} · LAMMPS deck generator & visualizer for nanometric cutting")
    preset = st.selectbox("Preset", list(PRESETS.keys()), help="ref_* presets reproduce C:/BTP/Cutting/<R>-<d> exactly.")
    if st.button("Load preset", use_container_width=True):
        load_preset(preset)
        st.rerun()
    up = st.file_uploader("Load params.json", type=["json"])
    if up is not None and st.button("Apply uploaded parameters"):
        d = json.load(up)
        st.session_state.exp = d.get("experiment", d)
        for k in list(st.session_state.keys()):
            if "." in k:
                del st.session_state[k]
        st.rerun()
    st.download_button("Download params.json", Experiment.from_dict(E).to_json(), file_name="params.json", use_container_width=True)
    st.markdown("---")
    st.markdown("**Workflow**: 1 Setup → 2 Preview → 3 Download A/B → run with LAMMPS → 5 Results")

tabs = st.tabs(["Overview", "1 · Setup", "2 · Geometry preview", "3 · Mock animation", "4 · Decks A / B", "5 · Validate & preview run", "6 · Results visualizer", "Help"])

# ------------------------------------------------------------------ overview
with tabs[0]:
    st.title("NanoCut - nanometric cutting MD without the pain")
    st.markdown(
        "Set the parameters (tab 1) -> look at the model and the numbers (tab 2) -> watch the schematic animation of the cut (tab 3) -> "
        "download the two LAMMPS input files A and B (tab 4) -> run them on your cluster -> load the results (tab 6). "
        "Nothing has to be installed on this computer except Python.")
    c1, c2 = st.columns([1.2, 1])
    with c1:
        st.markdown(
            "**What A and B are.** `A` builds the diamond tool and the crystal workpiece atom by atom, marks the fixed / thermostat / Newtonian "
            "layers, equilibrates everything at the chosen temperature and writes a *restart file* (`<name>_A.restart`). `B` starts with "
            "`read_restart <name>_A.restart`, re-specifies the force field (restart files do not store Tersoff coefficients), moves the tool at the "
            "cutting speed and records cutting/thrust forces, temperatures and per-atom dumps. Exactly the structure of the reference decks in `C:/BTP/Cutting`.\n\n"
            "**What was verified** (see `VERIFICATION_REPORT.md`): every potential file reproduces its authors' lattice constant and cohesive "
            "energy in LAMMPS; for all nine reference cases every geometric/thermodynamic/numerical parameter of the generated decks equals the "
            "reference; the full-size 10-10 model built in LAMMPS has exactly the atom counts shown in tab 2.")
    with c2:
        for img, cap in [("sample_temperature.png", "Real reduced-scale run of the 10-10 case (97 815 atoms): local temperature after 0.1 / 1.3 / 2.5 A of cut"),
                         ("sample_forces.png", "Forces and zone temperatures recorded by deck B (same run)"),
                         ("sample_layers.png", "Layer tags stored in the dumps")]:
            pth = os.path.join(ROOT, "examples", "sample_run", img)
            if os.path.exists(pth):
                st.image(pth, caption=cap, use_container_width=True)

# ------------------------------------------------------------------ 1 setup
with tabs[1]:
    E["name"] = st.text_input("Experiment name (used in file names)", value=E["name"])
    c1, c2 = st.columns(2)
    with c1:
        with st.expander("Workpiece", expanded=True):
            prev = E["workpiece"]["material"]
            choice("workpiece", "material", "Material", list(MATERIALS.keys()), "Crystal cut by the tool.",
                   {k: v["label"] for k, v in MATERIALS.items()})
            if E["workpiece"]["material"] != prev:
                mat = MATERIALS[E["workpiece"]["material"]]
                E["workpiece"]["a0"] = mat["a0"]
                E["potential"]["key"] = mat["default_potential"]
                E["thermo"]["cut_dt_fs"] = E["thermo"]["equil_dt_fs"] = mat["dt_fs"]
                st.rerun()
            mat = MATERIALS[E["workpiece"]["material"]]
            st.caption(f"{mat['label']}: {mat['structure']}, {mat['a0_note']}")
            num("workpiece", "a0", "Lattice constant a0 (Å)", "Conventional cubic cell edge. Should match the potential's equilibrium value.", 0.0001, "%.4f", 1.0, 10.0)
            num("workpiece", "length_nm", "Length along cutting direction x (nm)", "Snapped to whole lattice cells. Reference: 220 a0 = 96.07 nm.", 0.5, "%.4f", 1.0)
            num("workpiece", "height_nm", "Height y (nm)", "Depth direction. Reference: 100 a0 = 43.67 nm.", 0.5, "%.4f", 1.0)
            num("workpiece", "width_nm", "Width z (nm, periodic)", "Periodic ⇒ 'infinitely wide'. Must be ≥ 2 cutoffs (~6 Å). Reference: 9 a0 = 3.93 nm.", 0.1, "%.4f", 0.3)
            num("workpiece", "fixed_nm", "Fixed (boundary) layer thickness (nm)", "Atoms held in place (bottom and back end): anchors the block. Reference: 5 a0.", 0.1, "%.4f", 0.0)
            num("workpiece", "thermo_nm", "Thermostat layer thickness (nm)", "Nosé-Hoover layer next to the fixed one: the heat sink. Reference: 5 a0.", 0.1, "%.4f", 0.0)
            boolean("workpiece", "anchor_far_end", "Also fix/thermostat the tool-entry end (+x)", "Reference decks leave the entry end free so the chip can form.")
            st.markdown("**Boundary conditions** (what happens at the edges of the simulation box)")
            choice("workpiece", "boundary_z", "Width direction z", ["p", "s"],
                   "p = periodic: the slab repeats forever along z, i.e. an INFINITELY WIDE workpiece and tool (the reference decks). s = finite slab with free side faces.",
                   {"p": "p - periodic = infinitely wide (reference)", "s": "s - finite width, free faces"})
            choice("workpiece", "boundary_x", "Cutting direction x", ["s", "f", "p"],
                   "s = free ends (box follows the atoms; the chip can leave). p = periodic = infinitely long workpiece: the tool re-enters from the other side (rarely wanted). f = fixed box face (atoms leaving are lost).",
                   {"s": "s - free ends (reference)", "f": "f - fixed box face", "p": "p - periodic = infinitely long"})
            choice("workpiece", "boundary_y", "Depth direction y", ["s", "f"], "s = free surface above and below (reference). f = fixed box faces.",
                   {"s": "s - free (reference)", "f": "f - fixed box faces"})
            vec("workpiece", "orient_x", "Crystal direction along x [h k l]", "Integers; x,y,z directions must be orthogonal and right-handed. (001)[−100] cutting: x=1 0 0, y=0 1 0, z=0 0 1.")
            vec("workpiece", "orient_y", "Crystal direction along y", "Surface normal.")
            vec("workpiece", "orient_z", "Crystal direction along z", "Width (periodic) direction.")
        with st.expander("Process", expanded=True):
            num("process", "depth_nm", "Depth of cut d (nm)", "Undeformed surface to the lowest tool point. Reference: 3/5/7 a0 = 1.31/2.18/3.06 nm.", 0.05, "%.4f", 0.01)
            num("process", "speed_ms", "Cutting speed (m/s)", "MD speeds are 10–1000 m/s (time-step limited). 200 m/s = 2 Å/ps.", 10.0, "%.1f", 1.0)
            num("process", "cut_length_nm", "Cutting length (nm)", "Tool travel in B. Reference: 20 or 30 nm.", 1.0, "%.2f", 0.1)
            num("process", "gap_nm", "Initial tool–workpiece gap (nm)", "Horizontal clearance before contact. Reference: 0 or 2 a0.", 0.1, "%.4f", 0.0)
        with st.expander("Potential (force field)", expanded=True):
            elems = MATERIALS[E["workpiece"]["material"]]["elements"]
            opts = potentials_for(elems)
            choice("potential", "key", "Interatomic potential", opts, "Files bundled with LAMMPS; citation shown below.",
                   {k: POTENTIALS[k]["label"] for k in opts})
            p = POTENTIALS[E["potential"]["key"]]
            st.caption(f"**Cite:** {p['citation']}. {p['note']}")
            telem = TOOL_MATERIALS[E["tool"]["material"]]["elements"][0]
            needs_cross = not all(e in p["tokens"] and (e, telem) not in p.get("excluded_pairs", set()) and (telem, e) not in p.get("excluded_pairs", set()) for e in [telem])
            needs_cross = needs_cross or any((e, telem) in p.get("excluded_pairs", set()) or (telem, e) in p.get("excluded_pairs", set()) for e in elems)
            if needs_cross:
                choice("potential", "cross_style", "Tool–workpiece cross interaction", ["auto", "morse", "zbl", "lj"],
                       "auto = Morse if a literature set exists, else ZBL repulsion.")
                for e in elems:
                    mk = _morse_key(telem, e)
                    if mk:
                        D, a, r0, rc, src, ok = MORSE[mk]
                        st.caption(f"Morse {telem}-{e}: D0={D} eV, α={a} 1/Å, r0={r0} Å — {src} {'' if ok else '(PARTIALLY VERIFIED)'}")
                    else:
                        st.warning(f"No verified Morse set for {telem}-{e}: enter parameters or use ZBL (repulsive only).")
                if E["potential"]["cross_style"] == "morse":
                    for attr, lab in [("morse_D", "D0 (eV)"), ("morse_alpha", "alpha (1/Å)"), ("morse_r0", "r0 (Å)")]:
                        v = st.text_input(f"Morse {lab} (blank = literature default)", value="" if E["potential"][attr] is None else str(E["potential"][attr]), key="potential." + attr)
                        E["potential"][attr] = float(v) if v.strip() else None
                if E["potential"]["cross_style"] == "lj":
                    for attr, lab in [("lj_eps", "epsilon (eV)"), ("lj_sigma", "sigma (Å)")]:
                        v = st.text_input(f"LJ {lab}", value="" if E["potential"][attr] is None else str(E["potential"][attr]), key="potential." + attr)
                        E["potential"][attr] = float(v) if v.strip() else None
    with c2:
        with st.expander("Tool", expanded=True):
            choice("tool", "material", "Tool material", list(TOOL_MATERIALS.keys()), "Diamond single crystal.", {k: v["label"] for k, v in TOOL_MATERIALS.items()})
            num("tool", "a0", "Tool lattice constant (Å)", "Reference: 3.571 Å.", 0.001, "%.4f", 1.0, 10.0)
            choice("tool", "shape", "Shape", ["wedge", "sphere"], "wedge = orthogonal cutting tool with rake/clearance faces and rounded edge; sphere = abrasive grit (scratching).")
            boolean("tool", "deformable", "Deformable tool (own fixed/thermostat/Newtonian layers)", "Reference decks: deformable. Rigid = all tool atoms move together (cheaper, no tool wear).")
            if E["tool"]["shape"] == "wedge":
                num("tool", "rake_deg", "Rake angle (deg)", "0 = vertical rake face (reference). Negative = face leans over the workpiece (common for brittle materials).", 1.0, "%.1f", -80.0, 60.0)
                num("tool", "clearance_deg", "Clearance angle (deg)", "Flank inclination behind the edge. Reference: 10°.", 1.0, "%.1f", 0.0, 60.0)
                num("tool", "edge_radius_nm", "Edge radius (nm)", "Rounded cutting edge. Reference: 5/10/20 diamond cells = 1.79/3.57/7.14 nm.", 0.1, "%.4f", 0.0)
                num("tool", "length_nm", "Tool length x (nm)", "Reference: 70 cells = 25 nm.", 0.5, "%.3f", 0.5)
                num("tool", "height_nm", "Tool height y (nm)", "Reference: 70 cells = 25 nm.", 0.5, "%.3f", 0.5)
            else:
                num("tool", "sphere_radius_nm", "Sphere radius (nm)", "Abrasive grit radius.", 0.5, "%.2f", 0.5)
            if E["tool"]["deformable"]:
                num("tool", "fixed_nm", "Tool fixed layer (nm)", "Top/back layers that carry the prescribed motion. Reference: 3 cells = 1.07 nm.", 0.1, "%.4f", 0.0)
                num("tool", "thermo_nm", "Tool thermostat layer (nm)", "Reference: 3 cells.", 0.1, "%.4f", 0.0)
            osz = st.number_input("Tool lattice origin shift z (fraction of cell)", value=float(E["tool"]["origin_shift"][2]), min_value=0.0, max_value=1.0, step=0.05,
                                  help="Reference: 0.4. Shifts the tool lattice along the periodic width to avoid overlapping images.")
            E["tool"]["origin_shift"] = (0.0, 0.0, float(osz))
        with st.expander("Laser / thermal assistance (LAM)", expanded=False):
            choice("laser", "mode", "Heat source", ["none", "preheat", "spot", "power"],
                   "none: conventional cutting. preheat: whole workpiece equilibrated/thermostatted at a higher temperature (how most MD laser-assisted-machining papers model the laser, e.g. Chu et al. 2025, Liu et al. 2024). "
                   "spot: a cylindrical zone ahead of the tool, moving with it, held at a set temperature by a Langevin thermostat (local hot spot). power: same moving zone with a constant energy input (fix heat).",
                   {"none": "none (conventional cutting)", "preheat": "preheat - uniform workpiece temperature", "spot": "spot - moving hot zone at set temperature", "power": "power - moving zone with constant heat input"})
            lm = E["laser"]["mode"]
            if lm == "preheat":
                num("laser", "preheat_K", "Workpiece temperature (K)", "Literature range 600-1200 K for Si/SiC (tool stays at the base temperature).", 50.0, "%.0f", 1.0)
            if lm in ("spot", "power"):
                num("laser", "spot_radius_nm", "Spot radius (nm)", "Cylinder radius (through the width); its centre sits on the surface so half of it is inside the material.", 0.5, "%.2f", 0.2)
                num("laser", "lead_nm", "Lead distance ahead of the tool (nm)", "Distance between the tool front and the spot centre.", 0.5, "%.2f", 0.0)
                num("laser", "spot_depth_nm", "Spot centre below the surface (nm)", "0 = centre on the surface.", 0.5, "%.2f", 0.0)
            if lm == "spot":
                num("laser", "spot_K", "Spot temperature (K)", "Target temperature held by the Langevin thermostat in the zone.", 50.0, "%.0f", 1.0)
                num("laser", "spot_damp_ps", "Spot coupling time (ps)", "Langevin damping; smaller = stronger coupling.", 0.01, "%.3f", 0.001)
            if lm == "power":
                num("laser", "spot_power_eV_ps", "Heat input (eV/ps)", "Energy added per ps to all atoms currently in the zone (fix heat). 1 eV/ps = 0.16 nW.", 5.0, "%.1f", 0.1)
            if lm != "none":
                mat_ = MATERIALS[E["workpiece"]["material"]]
                if mat_.get("brittle") and mat_.get("E_GPa"):
                    dc = 0.15 * (mat_["E_GPa"] / mat_["H_GPa"]) * (mat_["Kc"] / mat_["H_GPa"]) ** 2 * 1000
                    st.info(f"Ductile-brittle guidance: Bifano's room-temperature critical depth for {E['workpiece']['material']} is about {dc:.0f} nm "
                            f"(d_c = 0.15 (E/H)(K_c/H)^2). Heating lowers H faster than K_c and raises d_c - e.g. the measured DBT depth in 4H-SiC scratching rose from 105 nm to 240 nm with laser heating. "
                            "The simulation itself decides the regime; compare chip morphology, subsurface damage and force ratio with and without the heat source.")
        with st.expander("Thermodynamics & integration", expanded=False):
            num("thermo", "temperature_K", "Temperature (K)", "Initial and thermostat temperature.", 10.0, "%.1f", 1.0)
            num("thermo", "seed", "Random seed", "Change for repeat runs (error bars).", 1, None, 1, None, integer=True)
            choice("thermo", "velocity_dist", "Initial velocity distribution", ["uniform", "gaussian"], "Reference: uniform.")
            boolean("thermo", "minimize_before_equil", "Minimise energy before equilibration (A)", "Recommended; reference decks skip it.")
            num("thermo", "equil_ps", "Equilibration time (ps)", "Reference: 5 ps; typical 10-30 ps.", 1.0, "%.2f", 0.01)
            num("thermo", "equil_dt_fs", "Time step in A (fs)", "0.5 fs for Tersoff/SiC, 1 fs for EAM metals.", 0.1, "%.2f", 0.05, 5.0)
            choice("thermo", "equil_thermostat", "Thermostat in A", ["nvt", "langevin", "berendsen"], "Nosé-Hoover (reference), Langevin, Berendsen.")
            num("thermo", "tdamp_ps", "Thermostat damping (ps)", "Reference: 0.05 ps (= 100 steps of 0.5 fs).", 0.01, "%.3f", 0.001)
            boolean("thermo", "minimize_before_cut", "Minimise after reading the restart (B)", "Reference: yes.")
            num("thermo", "cut_dt_fs", "Time step in B (fs)", "", 0.1, "%.2f", 0.05, 5.0)
            choice("thermo", "cut_thermostat", "Thermostat on the thermostat layers in B", ["nvt", "langevin", "berendsen"], "")
            choice("thermo", "wp_temp_compute", "Workpiece temperature compute", ["temp/partial", "temp"], "temp/partial 0 1 1 (reference) ignores x-velocities (removes streaming along the cut); temp = plain kinetic temperature.")
        with st.expander("Output", expanded=False):
            num("output", "thermo_every", "Thermo output every (steps)", "", 50, None, 1, None, integer=True)
            num("output", "dump_every_equil", "Dump every (steps) in A", "", 500, None, 1, None, integer=True)
            num("output", "dump_every_cut", "Dump every (steps) in B", "Multiple of 10.", 100, None, 10, None, integer=True)
            num("output", "restart_every_equil", "Restart every (steps) in A", "", 500, None, 1, None, integer=True)
            num("output", "restart_every_cut", "Restart every (steps) in B", "", 1000, None, 1, None, integer=True)
            num("output", "forces_every", "Force/temperature record every (steps)", "Multiple of 10.", 10, None, 10, None, integer=True)
            num("output", "contact_zone_radius_nm", "Contact-zone radius for temperature (nm)", "Cylinder around the moving edge used for the contact-zone temperature.", 0.5, "%.2f", 0.2)
            for attr, lab in [("dump_velocities", "velocities"), ("dump_forces", "forces"), ("dump_ke", "kinetic energy (+time average → local T)"),
                              ("dump_pe", "potential energy"), ("dump_stress", "stress tensor"), ("dump_coord", "coordination number"), ("dump_cna", "CNA (fcc/bcc metals)")]:
                boolean("output", attr, f"Dump {lab}", "")
        with st.expander("Compute resources", expanded=False):
            num("compute", "mpi_ranks", "MPI ranks", "Reference run: 10.", 1, None, 1, None, integer=True)
            num("compute", "omp_threads", "OpenMP threads per rank", "", 1, None, 1, None, integer=True)
            E["compute"]["lammps_cmd"] = st.text_input("LAMMPS executable", value=E["compute"]["lammps_cmd"])
    errs = validate(Experiment.from_dict(E))
    if errs:
        st.error("Fix before generating: " + "; ".join(errs))

exp = Experiment.from_dict(E)
exp_json = exp.to_json()
errs = validate(exp)

# ------------------------------------------------------------------ 2 preview
with tabs[2]:
    if errs:
        st.error("; ".join(errs))
    else:
        with st.spinner("Enumerating atoms exactly as LAMMPS will create them..."):
            M = build_model(exp_json)
        s = M["summary"]
        c = s["counts"]
        k1, k2, k3, k4, k5 = st.columns(5)
        k1.metric("Atoms (exact)", f"{c['total']:,}")
        k2.metric("Workpiece / tool", f"{c['workpiece']:,} / {c['tool']:,}")
        k3.metric("Cut steps", f"{s['cut_steps']:,}")
        k4.metric("Simulated time", f"{exp.equil_steps * exp.thermo.equil_dt_fs / 1000:.1f} + {s['cut_steps'] * exp.thermo.cut_dt_fs / 1000:.1f} ps")
        thr = st.number_input("Throughput per core (katom-steps/s)", value=440.0, help="Measured on this laptop for Tersoff: 441 katom-step/s per core. Cluster values differ.")
        wall_h = c["total"] * (s["cut_steps"] + s["equil_steps"]) / (thr * 1e3 * max(1, exp.compute.mpi_ranks)) / 3600
        k5.metric("Wall-time estimate", f"{wall_h:.1f} h on {exp.compute.mpi_ranks} ranks")
        st.markdown(f"**Model** (Å): workpiece {s['Lx_A']:.1f} × {s['Ly_A']:.1f} × {s['Lz_A']:.2f} ({s['cells'][0]}×{s['cells'][1]}×{s['cells'][2]} cells, "
                    f"lattice spacings {M['sp_wp'][0]:.3f}/{M['sp_wp'][1]:.3f}/{M['sp_wp'][2]:.3f}); surface y = {s['y_surface_A']:.2f}; "
                    f"tool edge centre ({s['edge_center_A'][0]:.1f}, {s['edge_center_A'][1]:.1f}); tool x-range {s['tool_xmin_A']:.1f}–{s['tool_xmax_A']:.1f}; "
                    f"layers: wp fixed {c['wp_bd']:,}, wp thermostat {c['wp_ts']:,}, wp Newtonian {c['wp_mob']:,}, "
                    f"tool fixed {c['ct_bd']:,}, tool thermostat {c['ct_ts']:,}, tool Newtonian {c['ct_mob']:,}")
        d, R = exp.process.depth_nm, exp.tool.edge_radius_nm if exp.tool.shape == "wedge" else exp.tool.sphere_radius_nm
        st.markdown(f"**Derived**: strain-rate scale v/d ≈ {exp.process.speed_ms / (d * 1e-9):.1e} 1/s; d/R = {d / R if R else float('inf'):.2f}; "
                    f"tool image spacing at the periodic boundary {s['periodic_mismatch_A']:.2f} Å")
        for wmsg in M["warnings"]:
            st.warning(wmsg)
        xyz, typ, mol = M["xyz"], M["typ"], M["mol"]
        zs = M["sp_wp"][2]
        sl = xyz[:, 2] < zs * 0.5 + 1e-6          # half a lattice period: one or two atomic planes
        ol = np.array(M["outline"] + [M["outline"][0]])
        ex, ey = s["edge_center_A"]
        ys, dA = s["y_surface_A"], exp.process.depth_nm * A_PER_NM

        def section(xr, yr, title, size):
            fig = go.Figure()
            win = sl & (xyz[:, 0] >= xr[0]) & (xyz[:, 0] <= xr[1]) & (xyz[:, 1] >= yr[0]) & (xyz[:, 1] <= yr[1])
            for mid in sorted(set(mol[win].tolist())):
                mm = win & (mol == mid)
                fig.add_trace(go.Scattergl(x=xyz[mm, 0], y=xyz[mm, 1], mode="markers", name=LAYER_NAMES[mid],
                                           marker=dict(size=size, color=LAYER_COLORS[mid])))
            fig.add_trace(go.Scatter(x=ol[:, 0], y=ol[:, 1], mode="lines", name="tool outline", line=dict(color="red", width=2)))
            fig.add_shape(type="line", x0=xr[0], x1=xr[1], y0=ys, y1=ys, line=dict(color="black", dash="dot"))
            fig.add_shape(type="line", x0=xr[0], x1=xr[1], y0=ys - dA, y1=ys - dA, line=dict(color="red", dash="dot"))
            fig.add_annotation(x=xr[0], y=ys, text="undeformed surface", showarrow=False, xanchor="left", yanchor="bottom")
            fig.add_annotation(x=xr[0], y=ys - dA, text=f"depth of cut {exp.process.depth_nm:.3f} nm", showarrow=False, xanchor="left", yanchor="top", font=dict(color="red"))
            fig.add_annotation(x=ex, y=ey, text="edge centre", showarrow=True, arrowhead=2)
            if exp.laser.mode in ("spot", "power"):
                (lx0, ly0), lr = s["laser_center_A"], s["laser_radius_A"]
                fig.add_shape(type="circle", x0=lx0 - lr, x1=lx0 + lr, y0=ly0 - lr, y1=ly0 + lr, line=dict(color="orange", width=2), fillcolor="rgba(255,165,0,0.25)")
                fig.add_annotation(x=lx0, y=ly0 + lr, text="laser zone", showarrow=False, font=dict(color="orange"), yanchor="bottom")
            fig.update_layout(height=520, title=title, xaxis=dict(title="x (Å) — tool moves toward −x", range=list(xr)),
                              yaxis=dict(title="y (Å)", range=list(yr), scaleanchor="x"), legend=dict(orientation="h"), margin=dict(l=40, r=20, t=50, b=40))
            return fig

        st.subheader("Cross-section (x-y) of the atoms LAMMPS will create (one atomic plane in z)")
        st.caption(("Width direction z is periodic: what you see repeats forever along z - the model is an infinitely wide slab. " if exp.workpiece.boundary_z == "p" else "Width direction z is finite (free faces). ")
                   + "The tool moves toward -x. Atoms are drawn exactly where create_atoms will put them.")
        st.plotly_chart(section((s["box_A"][0], s["box_A"][1]), (s["box_A"][2], s["box_A"][3]), "whole model", 2.0), use_container_width=True, theme=None)
        zoom = st.slider("Zoom window around the cutting edge (nm)", 2.0, 40.0, 12.0, 1.0)
        zA = zoom * A_PER_NM
        st.plotly_chart(section((ex - zA, ex + zA), (ey - zA, ey + zA), "cutting-edge region", 4.0), use_container_width=True, theme=None)
        colB = st.container()
        with colB:
            st.subheader("3-D (subsampled)")
            maxp = st.slider("Max atoms drawn", 10000, 300000, 60000, 10000)
            n = len(xyz)
            idx = np.random.default_rng(0).choice(n, size=min(maxp, n), replace=False)
            fig3 = go.Figure()
            for mid in sorted(set(mol.tolist())):
                mm = idx[mol[idx] == mid]
                fig3.add_trace(go.Scatter3d(x=xyz[mm, 0], y=xyz[mm, 1], z=xyz[mm, 2], mode="markers", name=LAYER_NAMES[mid],
                                            marker=dict(size=1.5, color=LAYER_COLORS[mid])))
            fig3.update_layout(height=600, scene=dict(aspectmode="data", xaxis_title="x (Å)", yaxis_title="y (Å)", zaxis_title="z (Å)"))
            st.plotly_chart(fig3, use_container_width=True, theme=None)

# ------------------------------------------------------------------ 3 mock animation
with tabs[3]:
    st.warning("MOCK - a kinematic schematic built from the real tool geometry and the real lattice, NOT a simulation. It shows the "
               "sequence of events (tool approach, chip forming on the rake face along a Merchant shear plane, groove, heated zone, laser spot). "
               "Chip shape and the colours are illustrative; use the real run (tab 5/6) for any number.")
    if errs:
        st.error("; ".join(errs))
    else:
        cm1, cm2, cm3 = st.columns(3)
        n_frames = cm1.slider("Frames", 8, 60, 24, 4)
        chip_ratio = cm2.slider("Chip ratio r = uncut thickness / chip thickness (schematic)", 0.2, 1.0, 0.5, 0.05,
                                help="MD of brittle materials in the ductile regime typically shows thick, slow chips (r = 0.3-0.6).")
        max_atoms = cm3.slider("Atoms drawn", 3000, 30000, 10000, 1000)
        with st.spinner("Building the animation..."):
            MK = mock_frames(exp, n_frames=n_frames, chip_ratio=chip_ratio, max_atoms=max_atoms)
        meta = MK["meta"]
        colour_by = st.radio("Colour", ["region (workpiece / chip / damaged / tool)", "illustrative heat (distance from the contact + laser)"], horizontal=True)
        KIND_COL = {0: ("tool", "#8c8c8c"), 1: ("workpiece", "#1f77b4"), 2: ("chip", "#d62728"), 3: ("damaged layer (illustrative)", "#ff7f0e")}
        frames = []
        for i, fr in enumerate(MK["frames"]):
            ol = MK["outlines"][i]
            data = []
            if colour_by.startswith("region"):
                for k, (nm, col) in KIND_COL.items():
                    mm = fr["kind"] == k
                    data.append(go.Scattergl(x=fr["xyz"][mm, 0], y=fr["xyz"][mm, 1], mode="markers", name=nm, marker=dict(size=3, color=col)))
            else:
                data.append(go.Scattergl(x=fr["xyz"][:, 0], y=fr["xyz"][:, 1], mode="markers", name="atoms",
                                         marker=dict(size=3, color=fr["hot"], colorscale=INFERNO, cmin=0, cmax=1, showscale=True, colorbar=dict(title="illustrative heat"))))
            data.append(go.Scatter(x=np.r_[ol[:, 0], ol[0, 0]], y=np.r_[ol[:, 1], ol[0, 1]], mode="lines", name="tool outline", line=dict(color="red", width=2)))
            if meta["laser"]:
                (lx0, ly0), lr = meta["laser"]
                th = np.linspace(0, 2 * np.pi, 60)
                data.append(go.Scatter(x=lx0 - fr["travel_A"] + lr * np.cos(th), y=ly0 + lr * np.sin(th), mode="lines", name="laser zone", line=dict(color="orange", width=2)))
            frames.append(go.Frame(data=data, name=str(i), layout=go.Layout(title=f"tool travel {fr['travel_A'] / 10:.2f} nm of {exp.process.cut_length_nm} nm")))
        figm = go.Figure(data=frames[0].data, frames=frames)
        xr = (meta["x_front0"] - exp.process.cut_length_nm * A_PER_NM - 40, meta["x_front0"] + 60)
        yr = (meta["y_cut"] - 60, meta["y_surface"] + 80)
        figm.add_shape(type="line", x0=xr[0], x1=xr[1], y0=meta["y_surface"], y1=meta["y_surface"], line=dict(color="black", dash="dot"))
        figm.add_shape(type="line", x0=xr[0], x1=xr[1], y0=meta["y_cut"], y1=meta["y_cut"], line=dict(color="red", dash="dot"))
        figm.update_layout(height=620, xaxis=dict(title="x (A) - tool moves toward -x", range=list(xr)), yaxis=dict(title="y (A)", range=list(yr), scaleanchor="x"),
                           legend=dict(orientation="h"), title=frames[0].layout.title,
                           updatemenus=[dict(type="buttons", showactive=False, y=1.12, x=0, xanchor="left",
                                             buttons=[dict(label="Play", method="animate", args=[None, dict(frame=dict(duration=250, redraw=True), fromcurrent=True, transition=dict(duration=0))]),
                                                      dict(label="Pause", method="animate", args=[[None], dict(frame=dict(duration=0, redraw=False), mode="immediate")])])],
                           sliders=[dict(steps=[dict(method="animate", args=[[f.name], dict(mode="immediate", frame=dict(duration=0, redraw=True), transition=dict(duration=0))], label=f"{MK['frames'][i]['travel_A'] / 10:.1f}") for i, f in enumerate(frames)],
                                         currentvalue=dict(prefix="travel (nm): "), x=0, len=1.0)])
        st.plotly_chart(figm, use_container_width=True, theme=None)
        st.markdown(f"Schematic assumptions: shear angle phi = {meta['shear_angle_deg']:.1f} deg from Merchant's relation with rake angle {exp.tool.rake_deg} deg and chip ratio {chip_ratio}; "
                    f"chip thickness {meta['chip_thickness_A'] / 10:.2f} nm for a depth of cut {meta['depth_A'] / 10:.2f} nm; the 'damaged layer' band is one depth of cut below the groove. "
                    "In the real MD the chip may be continuous, segmented or absent (rubbing), and the subsurface damage depth is an output (see tab 6).")

# ------------------------------------------------------------------ 4 decks
with tabs[4]:
    if errs:
        st.error("; ".join(errs))
    else:
        a_txt, b_txt, files, warns = build_decks(exp_json)
        for wmsg in warns:
            st.warning(wmsg)
        name = exp.name
        c1, c2, c3, c4 = st.columns(4)
        c1.download_button(f"⬇ A_{name}.txt", a_txt, file_name=f"A_{name}.txt", use_container_width=True)
        c2.download_button(f"⬇ B_{name}.txt", b_txt, file_name=f"B_{name}.txt", use_container_width=True)
        for f in files:
            c3.download_button(f"⬇ {f}", open(os.path.join(POT_DIR, f), "rb").read(), file_name=f, use_container_width=True)
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("A.in", a_txt)
            z.writestr("B.in", b_txt)
            for f in files:
                z.write(os.path.join(POT_DIR, f), f)
            from nanocut.deck import RUN_SH, RUN_BAT, readme
            cc = exp.compute
            z.writestr("run.sh", RUN_SH % dict(np=cc.mpi_ranks, lmp=cc.lammps_cmd, omp=cc.omp_threads))
            z.writestr("run.bat", RUN_BAT % dict(np=cc.mpi_ranks))
            z.writestr("params.json", json.dumps(dict(nanocut_version=__version__, experiment=exp.to_dict(), model=build_model(exp_json)["summary"]), indent=2))
            z.writestr("README.md", readme(exp, Model(exp), warns))
        c4.download_button("⬇ complete run folder (zip)", buf.getvalue(), file_name=f"{name}_run.zip", use_container_width=True)
        st.info("Run on your machine/cluster: `mpirun -np N lmp -in A.in` then `mpirun -np N lmp -in B.in` (the zip contains run.sh/run.bat). "
                "A writes the restart file that B reads — both must be run in the same folder with the potential file present.")
        ca, cb = st.columns(2)
        ca.subheader("A — build + equilibrate")
        ca.code(a_txt, language="bash")
        cb.subheader("B — cut")
        cb.code(b_txt, language="bash")

# ------------------------------------------------------------------ 5 validate / preview run
with tabs[5]:
    st.markdown("Both actions execute the generated decks with the real LAMMPS (22 Jul 2025) inside WSL. "
                "**Validate** builds the full-size model and performs `run 0` (syntax + exact atom counts). "
                "**Preview run** runs a reduced-scale copy (same depth, speed, edge radius, potential) to produce real dumps for tab 5.")
    avail = runner.available()
    st.write("LAMMPS runtime in WSL: " + ("✅ available" if avail else "❌ not found (~/lmpval/bin/lmp)"))
    ranks = st.number_input("MPI ranks for local runs", value=4, min_value=1, max_value=16)
    if errs:
        st.error("; ".join(errs))
    elif avail:
        c1, c2 = st.columns(2)
        with c1:
            if st.button("Validate in LAMMPS (full size, run 0)", use_container_width=True):
                wd = os.path.join(RUNS, "validate_" + exp.name)
                with st.spinner("Building the full model in LAMMPS..."):
                    res = runner.validate_in_lammps(exp, wd, np=int(ranks))
                st.session_state.validate = res
            if "validate" in st.session_state:
                res = st.session_state.validate
                st.write("Result: " + ("✅ deck runs; counts below" if res["ok"] else "❌ failed"))
                for e in res.get("errors", []):
                    st.error(e)
                rows = []
                exp_c = res.get("expected", {})
                g2k = dict(gpCTall="tool", gpWPall="workpiece", gpCTbd="ct_bd", gpCTtsbd="ct_ts", gpCTmob="ct_mob", gpWPbd="wp_bd", gpWPtsbd="wp_ts", gpWPmob="wp_mob")
                for g, k in g2k.items():
                    if g in res.get("groups", {}):
                        rows.append(dict(group=g, LAMMPS=res["groups"][g], NanoCut=exp_c.get(k), match=res["groups"][g] == exp_c.get(k)))
                if rows:
                    st.table(rows)
                if res.get("natoms"):
                    st.write(f"LAMMPS total atoms: {res['natoms']:,} (NanoCut: {exp_c.get('total'):,})")
                st.text_area("LAMMPS output (tail)", res.get("stdout", ""), height=200)
        with c2:
            scale = st.slider("Preview scale factor (workpiece & tool block sizes)", 0.05, 1.0, 0.15, 0.05)
            pcut = st.number_input("Preview cutting length (nm)", value=3.0, min_value=0.2, step=0.5)
            peq = st.number_input("Preview equilibration (ps)", value=1.0, min_value=0.1, step=0.5)
            sexp = runner.scaled_experiment(exp, scale=scale, cut_length_nm=pcut, equil_ps=peq)
            sexp.output.dump_every_cut = max(10, (sexp.cut_steps // 20) // 10 * 10)
            sexp.output.forces_every = max(10, (sexp.cut_steps // 50) // 10 * 10)
            sexp.output.thermo_every = sexp.output.forces_every
            sm = Model(sexp)
            sc = sm.counts()
            st.caption(f"Preview model: {sc['total']:,} atoms, {sexp.cut_steps:,} cutting steps (+{sexp.equil_steps:,} equilibration). "
                       f"≈ {sc['total'] * (sexp.cut_steps + sexp.equil_steps) / 600e3 / 60:.0f} min on this laptop "
                       f"(measured ≈ 600 katom-steps/s total for Tersoff in WSL; communication-bound for small models).")
            if st.button("Run reduced-scale preview (real MD)", use_container_width=True):
                wd = os.path.join(RUNS, "preview_" + exp.name)
                box = st.empty()
                with st.spinner("Running LAMMPS in WSL..."):
                    res = runner.preview_run(sexp, wd, np=int(ranks), progress=lambda s: box.info(s))
                st.session_state.preview = res
                if res["ok"]:
                    st.session_state.result_dir = wd
                    st.success("Preview run finished — open tab 5 (Results visualizer).")
                else:
                    st.error(f"Preview failed in stage {res['stage']}")
                st.text_area("LAMMPS output (tail)", res.get("stdout", ""), height=250)

# ------------------------------------------------------------------ 6 results
with tabs[6]:
    st.markdown("Loads a run folder written by the generated decks (dumps `*_cut.*.lammpstrj`, `*_forces_temps.txt`, `params.json`). "
                "Colours and quantities follow what you would compute in OVITO (per-atom temperature from time-averaged KE, coordination number, von Mises stress).")
    default_dir = st.session_state.get("result_dir", os.path.join(ROOT, "examples", "sample_run"))
    rdir = st.text_input("Run folder", value=default_dir, help="Default: the shipped example (a real reduced-scale run of the 10-10 reference case, 97 815 atoms, 3 frames).")
    if rdir and os.path.isdir(rdir):
        files = analysis.dump_series(rdir)
        prm = None
        pj = os.path.join(rdir, "params.json")
        if os.path.exists(pj):
            prm = json.load(open(pj))
        if prm:
            ms = prm["model"]
            y_surf, edge, v_aps, types = ms["y_surface_A"], ms.get("contact_point_A", ms["edge_center_A"]), ms["speed_A_per_ps"], ms["types"]
            dt_ps = prm["experiment"]["thermo"]["cut_dt_fs"] * 1e-3
            rc = prm["experiment"]["output"]["contact_zone_radius_nm"] * A_PER_NM
        else:
            st.warning("No params.json: enter the surface height and tool edge position manually.")
            y_surf = st.number_input("Undeformed surface y (Å)", value=0.0)
            edge = (st.number_input("Interaction-zone x at t=0 (Å) = workpiece end + gap", value=0.0), st.number_input("Interaction-zone y (Å) = surface - depth/2", value=0.0))
            v_aps = st.number_input("Speed (Å/ps)", value=2.0)
            dt_ps = st.number_input("Time step (ps)", value=0.0005, format="%.5f")
            types = ["C", "Si", "C"]
            rc = 20.0
        # forces
        ff = [f for f in os.listdir(rdir) if f.endswith("_forces_temps.txt")]
        if ff:
            names, arr = analysis.read_avetime(os.path.join(rdir, ff[0]))
            if len(arr):
                fs = analysis.force_summary(names, arr, v_aps, dt_ps)
                st.subheader("Cutting forces and temperatures")
                m1, m2, m3, m4 = st.columns(4)
                m1.metric("Fc steady mean (nN)", f"{fs.get('Fc_nN_steady_mean', float('nan')):.2f} ± {fs.get('Fc_nN_steady_std', 0):.2f}")
                m2.metric("Ft steady mean (nN)", f"{fs.get('Ft_nN_steady_mean', float('nan')):.2f} ± {fs.get('Ft_nN_steady_std', 0):.2f}")
                m3.metric("Friction coefficient Fc/Ft", f"{fs.get('friction_coefficient', float('nan')):.3f}")
                m4.metric("Contact-zone T steady (K)", f"{fs.get('Tcz_K_steady_mean', float('nan')):.0f}")
                figf = go.Figure()
                for k in ("Fc_nN", "Ft_nN", "Fz_nN"):
                    if k in fs:
                        figf.add_trace(go.Scatter(x=fs["cut_distance_A"] / 10, y=fs[k], name=k))
                figf.update_layout(height=320, xaxis_title="cutting distance (nm)", yaxis_title="force (nN)")
                figt = go.Figure()
                for k in names[1:]:
                    if k.endswith("_K"):
                        figt.add_trace(go.Scatter(x=fs["cut_distance_A"] / 10, y=fs[k], name=k))
                figt.update_layout(height=320, xaxis_title="cutting distance (nm)", yaxis_title="temperature (K)")
                c1, c2 = st.columns(2)
                c1.plotly_chart(figf, use_container_width=True, theme=None)
                c2.plotly_chart(figt, use_container_width=True, theme=None)
        if files:
            st.subheader("Atomic configuration")
            fi = st.slider("Frame", 0, len(files) - 1, len(files) - 1) if len(files) > 1 else 0
            fr = analysis.Frame(analysis.read_dump(files[fi])[0], types)
            met = analysis.metrics(fr, y_surf, edge, v_aps, dt_ps, rc=rc)
            k1, k2, k3, k4 = st.columns(4)
            k1.metric("Cut distance (nm)", f"{met['cut_distance_A'] / 10:.2f}")
            k2.metric("Max height above surface (Å)", f"{met['max_height_above_surface_A']:.2f}" if met["max_height_above_surface_A"] is not None else "–")
            k3.metric("Atoms above surface", f"{met['atoms_above_surface']:,}")
            k4.metric("Contact-zone T (K, COM removed)", f"{met['contact_zone_T_K']:.0f}" if met.get("contact_zone_T_K") else "–")
            props = ["layer (mol)", "type"]
            if fr.local_temperature() is not None:
                props.append("local temperature (K)")
            if fr.col("c_cn") is not None:
                props.append("coordination number")
            if fr.col("c_s[1]") is not None:
                props += ["von Mises stress (GPa)", "hydrostatic stress (GPa)"]
            if fr.col("c_pe") is not None:
                props.append("potential energy (eV)")
            if fr.col("vx") is not None:
                props.append("speed |v| (Å/ps)")
            if fr.col("v_inlaser") is not None:
                props.append("laser zone (1 = inside the moving heated zone)")
            prop = st.selectbox("Colour atoms by", props)
            wp_only = st.checkbox("Workpiece only", value=False)
            atom_vol = st.number_input("Atomic volume for stress (Å³)", value=float(np.prod([ms_ for ms_ in [1.0]]) * (prm["experiment"]["workpiece"]["a0"] ** 3 / 8 if prm else 10.4)),
                                       help="3C-SiC: a0³/8 = 10.4 Å³; Cu: 11.8; Si: 20.0.")
            xyz = fr.xyz
            mol = fr.col("mol")
            typ = fr.col("type")
            if prop == "layer (mol)":
                val, cmap, cat = mol, None, True
            elif prop == "type":
                val, cmap, cat = typ, None, True
            elif prop.startswith("local temperature"):
                val, cmap, cat = fr.local_temperature(), INFERNO, False
            elif prop.startswith("coordination"):
                val, cmap, cat = fr.col("c_cn"), None, True
            elif prop.startswith("von Mises"):
                val, cmap, cat = fr.von_mises(atom_vol), "Viridis", False
            elif prop.startswith("hydrostatic"):
                val, cmap, cat = fr.hydrostatic(atom_vol), "RdBu", False
            elif prop.startswith("potential"):
                val, cmap, cat = fr.col("c_pe"), "Viridis", False
            elif prop.startswith("laser zone"):
                val, cmap, cat = fr.col("v_inlaser").astype(int), None, True
            else:
                val, cmap, cat = np.sqrt(fr.col("vx") ** 2 + fr.col("vy") ** 2 + fr.col("vz") ** 2), "Plasma", False
            sel = np.ones(len(xyz), bool)
            if wp_only and mol is not None:
                sel &= np.isin(mol, [4, 5, 6])
            zmin, zmax = xyz[:, 2].min(), xyz[:, 2].max()
            zsl = st.slider("z-slab for the section view (Å)", float(zmin), float(zmax), (float(zmin), float(min(zmax, zmin + 5.0))))
            c1, c2 = st.container(), st.container()
            with c1:
                ss = sel & (xyz[:, 2] >= zsl[0]) & (xyz[:, 2] <= zsl[1])
                fig = go.Figure()
                if cat:
                    for u in np.unique(val[ss]):
                        mm = ss & (val == u)
                        lab = LAYER_NAMES.get(int(u), str(int(u))) if prop.startswith("layer") else (types[int(u) - 1] if prop == "type" and int(u) <= len(types) else str(int(u)))
                        fig.add_trace(go.Scattergl(x=xyz[mm, 0], y=xyz[mm, 1], mode="markers", name=lab, marker=dict(size=3)))
                else:
                    fig.add_trace(go.Scattergl(x=xyz[ss, 0], y=xyz[ss, 1], mode="markers", marker=dict(size=3, color=val[ss], colorscale=cmap, colorbar=dict(title=prop), showscale=True)))
                fig.add_hline(y=y_surf, line=dict(color="black", dash="dot"))
                xr = (float(xyz[ss, 0].min()) - 5, float(xyz[ss, 0].max()) + 5) if ss.any() else (0, 1)
                yr = (float(xyz[ss, 1].min()) - 5, float(xyz[ss, 1].max()) + 5) if ss.any() else (0, 1)
                fig.update_layout(height=560, xaxis=dict(title="x (Å)", range=list(xr)), yaxis=dict(title="y (Å)", range=list(yr), scaleanchor="x"),
                                  title=f"section view, step {fr.step}", legend=dict(orientation="h"), margin=dict(l=40, r=20, t=50, b=40))
                st.plotly_chart(fig, use_container_width=True, theme=None)
            with c2:
                maxp = st.slider("Max atoms in 3-D", 10000, 300000, 60000, 10000, key="res3d")
                idx = np.where(sel)[0]
                idx = np.random.default_rng(0).choice(idx, size=min(maxp, len(idx)), replace=False)
                fig3 = go.Figure()
                if cat:
                    for u in np.unique(val[idx]):
                        mm = idx[val[idx] == u]
                        fig3.add_trace(go.Scatter3d(x=xyz[mm, 0], y=xyz[mm, 1], z=xyz[mm, 2], mode="markers", name=str(int(u)), marker=dict(size=1.5)))
                else:
                    fig3.add_trace(go.Scatter3d(x=xyz[idx, 0], y=xyz[idx, 1], z=xyz[idx, 2], mode="markers", marker=dict(size=1.5, color=val[idx], colorscale=cmap, showscale=True)))
                fig3.update_layout(height=600, scene=dict(aspectmode="data"))
                st.plotly_chart(fig3, use_container_width=True, theme=None)
            if "profile_x_A" in met:
                figp = go.Figure(go.Scatter(x=met["profile_x_A"] / 10, y=met["profile_y_A"], mode="lines+markers"))
                figp.update_layout(height=280, xaxis_title="x (nm)", yaxis_title="surface height above undeformed surface (Å)", title="Surface profile (max y per 5 Å bin): chip / pile-up / groove")
                st.plotly_chart(figp, use_container_width=True, theme=None)
            if "coordination_histogram" in met:
                st.write("Workpiece coordination histogram (4 = perfect sp³ for SiC/Si):", met["coordination_histogram"])
        elif not ff:
            st.info("No dumps or force files found in that folder.")

# ------------------------------------------------------------------ help
with tabs[7]:
    st.markdown(open(os.path.join(ROOT, "ui", "help.md"), encoding="utf-8").read())
