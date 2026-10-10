"""Parameter inspection with provenance.

provenance:
  file      - read from a deck line (source = path + line number, raw line shown)
  computed  - derived by NanoCut (unit conversion, model geometry, atom counts); 'basis' says from what
  editable  - an input of the NanoCut experiment (params.json for runs, nanocut/presets.py for presets)
  missing   - expected for a cutting deck but not found
"""
import json
import re
from pathlib import Path

from .settings import PROJECT_ROOT, rel

# (category, key, label, deck, regex, value-builder, unit, multi)
RULES = [
    ("System", "units", "units", "A", r"^units\s+(\S+)", lambda m: m.group(1), "", False),
    ("System", "dimension", "dimension", "A", r"^dimension\s+(\S+)", lambda m: m.group(1), "", False),
    ("System", "boundary_A", "boundary (deck A)", "A", r"^boundary\s+(\S+)\s+(\S+)\s+(\S+)", lambda m: " ".join(m.groups()), "x y z", False),
    ("System", "boundary_B", "boundary (deck B)", "B", r"^boundary\s+(\S+)\s+(\S+)\s+(\S+)", lambda m: " ".join(m.groups()), "x y z", False),
    ("System", "atom_style", "atom_style", "A", r"^atom_style\s+(\S+)", lambda m: m.group(1), "", False),
    ("System", "create_box", "atom types (create_box)", "A", r"^create_box\s+(\d+)", lambda m: m.group(1), "", False),
    ("Workpiece & tool lattices", "lattice", "lattice", "A", r"^lattice\s+(\S+)\s+(\S+)(.*)$", lambda m: f"{m.group(1)} a = {m.group(2)}{(' ' + m.group(3).strip()) if m.group(3).strip() else ''}", "Å", True),
    ("Workpiece & tool lattices", "region_workpiece", "region workpiece", "A", r"^region\s+workpiece\s+(.+)$", lambda m: m.group(1), "", False),
    ("Workpiece & tool lattices", "region_tool", "tool regions", "A", r"^region\s+(tool_edge|cut_toolR|cut_toolB|tool_block|cut_tool)\s+(.+)$", lambda m: f"{m.group(1)}: {m.group(2)}", "", True),
    ("Workpiece & tool lattices", "mass", "mass", "A", r"^mass\s+(\d+)\s+(\S+)", lambda m: f"type {m.group(1)}: {m.group(2)}", "g/mol", True),
    ("Force field", "pair_style", "pair_style", "AB", r"^pair_style\s+(.+)$", lambda m: m.group(1), "", True),
    ("Force field", "pair_coeff", "pair_coeff", "AB", r"^pair_coeff\s+(.+)$", lambda m: m.group(1), "", True),
    ("Force field", "potential_variable", "potential selector (variable)", "B", r"^variable\s+potential\s+string\s+(\S+)", lambda m: m.group(1), "", False),
    ("Thermostat & integration", "timestep_A", "timestep (deck A)", "A", r"^timestep\s+(\S+)", lambda m: m.group(1), "ps", False),
    ("Thermostat & integration", "timestep_B", "timestep (deck B)", "B", r"^timestep\s+(\S+)", lambda m: m.group(1), "ps", False),
    ("Thermostat & integration", "velocity_create", "initial velocities", "A", r"^velocity\s+(\S+)\s+create\s+(\S+)\s+(\d+)(.*)$", lambda m: f"group {m.group(1)}: T = {m.group(2)} K, seed {m.group(3)}{m.group(4).rstrip()}", "", True),
    ("Thermostat & integration", "nvt", "Nose-Hoover thermostats", "AB", r"^fix\s+(\S+)\s+(\S+)\s+nvt\s+temp\s+(\S+)\s+(\S+)\s+(\S+)", lambda m: f"fix {m.group(1)} on {m.group(2)}: {m.group(3)} -> {m.group(4)} K, Tdamp {m.group(5)} ps", "", True),
    ("Thermostat & integration", "temp_compute", "temperature computes", "AB", r"^compute\s+(\S+)\s+(\S+)\s+(temp\S*)(.*)$", lambda m: f"{m.group(1)} on {m.group(2)}: {m.group(3)}{m.group(4).split('#')[0].rstrip()}", "", True),
    ("Thermostat & integration", "minimize", "minimize", "AB", r"^minimize\s+(.+)$", lambda m: m.group(1), "", True),
    ("Process (cutting)", "move", "prescribed motion (fix move)", "AB", r"^fix\s+(\S+)\s+(\S+)\s+move\s+linear\s+(\S+)\s+(\S+)\s+(\S+)", lambda m: f"fix {m.group(1)} on {m.group(2)}: v = ({m.group(3)}, {m.group(4)}, {m.group(5)})", "Å/ps", True),
    ("Process (cutting)", "run_A", "run (deck A)", "A", r"^run\s+(\S+)", lambda m: m.group(1), "steps", True),
    ("Process (cutting)", "run_B", "run (deck B)", "B", r"^run\s+(\S+)", lambda m: m.group(1), "steps", True),
    ("Process (cutting)", "var_v", "speed variable v", "B", r"^variable\s+v\s+equal\s+(\S+)", lambda m: m.group(1), "Å/ps", False),
    ("Process (cutting)", "var_Nstep", "step count variable", "B", r"^variable\s+Nstep\s+equal\s+(.+)$", lambda m: m.group(1), "", False),
    ("Laser", "laser_region", "laser zone region", "B", r"^region\s+laser\s+(.+)$", lambda m: m.group(1), "", False),
    ("Laser", "laser_fix", "laser heat source fix", "B", r"^fix\s+laser\s+(.+)$", lambda m: m.group(1), "", False),
    ("Output & restart", "thermo", "thermo interval", "AB", r"^thermo\s+(\d+)", lambda m: m.group(1), "steps", True),
    ("Output & restart", "dump", "dumps", "AB", r"^dump\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\S+)(.*)$", lambda m: f"{m.group(1)}: every {m.group(4)} steps -> {m.group(5)}", "", True),
    ("Output & restart", "restart", "periodic restart", "AB", r"^restart\s+(\d+)\s+(.+)$", lambda m: f"every {m.group(1)} steps -> {m.group(2)}", "", True),
    ("Output & restart", "write_restart", "write_restart", "AB", r"^write_restart\s+(\S+)", lambda m: m.group(1), "", True),
    ("Output & restart", "read_restart", "read_restart", "B", r"^read_restart\s+(\S+)", lambda m: m.group(1), "", False),
    ("Output & restart", "forces_out", "force / temperature output", "B", r"^fix\s+(\S+)\s+\S+\s+ave/time\s+(.+)$", lambda m: f"fix {m.group(1)}: {m.group(2)[:120]}", "", True),
    ("Deck variables", "variable", "variables", "AB", r"^variable\s+(\w+)\s+(equal|string)\s+(.+)$", lambda m: f"{m.group(1)} = {m.group(3).split('#')[0].strip()}", "", True),
]

EXPECTED = ["units", "boundary_A", "pair_coeff", "timestep_A", "timestep_B", "velocity_create", "run_A", "run_B", "move",
            "read_restart", "dump", "forces_out"]
MISSING_NOTES = {
    "forces_out": "No force/temperature time series is written by this deck (cutting/thrust forces cannot be plotted from it).",
    "read_restart": "Deck B does not read a restart file from deck A.",
    "velocity_create": "No initial velocities are assigned.",
}


def find_decks(sim):
    a = next((f for f in sim["files"] if f["role"] == "deck_A"), None)
    b = next((f for f in sim["files"] if f["role"] == "deck_B"), None)
    return a, b


def _abs(path):
    p = Path(path)
    return p if p.is_absolute() else PROJECT_ROOT / p


def parse_deck(path, which):
    out = []
    try:
        lines = _abs(path).read_text(errors="replace").splitlines()
    except Exception as e:
        return [], str(e)
    for i, raw in enumerate(lines, start=1):
        code = raw.split("#", 1)[0].strip()
        if not code:
            continue
        code = re.sub(r"\s+", " ", code)
        for cat, key, label, deck, rx, build, unit, multi in RULES:
            if which not in deck:
                continue
            m = re.match(rx, code)
            if m:
                k = key if key not in ("timestep_A", "timestep_B", "run_A", "run_B", "boundary_A", "boundary_B") else key
                out.append(dict(category=cat, key=k, label=label, value=build(m), unit=unit, provenance="file",
                                source=dict(path=path, line=i), raw=raw.strip(), deck=which))
    return out, None if lines else "empty file"


def _json_line(text_lines, section, key):
    sec = None
    for i, l in enumerate(text_lines, start=1):
        if sec is None and re.match(rf'\s*"{re.escape(section)}"\s*:\s*\{{', l):
            sec = i
        elif sec is not None and re.match(rf'\s*"{re.escape(key)}"\s*:', l):
            return i
    return None


EDITABLE_GROUPS = {
    "workpiece": "Workpiece & tool lattices", "tool": "Tool", "process": "Process (cutting)",
    "potential": "Force field", "thermo": "Thermostat & integration", "laser": "Laser",
    "output": "Output & restart", "compute": "Compute resources",
}
UNITS = {"a0": "Å", "length_nm": "nm", "height_nm": "nm", "width_nm": "nm", "fixed_nm": "nm", "thermo_nm": "nm",
         "edge_radius_nm": "nm", "sphere_radius_nm": "nm", "depth_nm": "nm", "gap_nm": "nm", "speed_ms": "m/s",
         "cut_length_nm": "nm", "rake_deg": "deg", "clearance_deg": "deg", "temperature_K": "K", "equil_ps": "ps",
         "equil_dt_fs": "fs", "cut_dt_fs": "fs", "tdamp_ps": "ps", "preheat_K": "K", "spot_K": "K",
         "spot_radius_nm": "nm", "lead_nm": "nm", "spot_power_eV_ps": "eV/ps", "spot_damp_ps": "ps",
         "spot_depth_nm": "nm", "contact_zone_radius_nm": "nm", "morse_rc": "Å"}


def editable_params(sim, experiment):
    out = []
    if not experiment:
        return out
    if sim["kind"] == "run":
        pj = f"{sim['path']}/params.json"
        lines = (PROJECT_ROOT / pj).read_text().splitlines()
    else:
        pj, lines = "nanocut/presets.py", None
    for sec, fields in experiment.items():
        if not isinstance(fields, dict):
            continue
        for k, v in fields.items():
            line = _json_line(lines, sec, k) if lines else None
            src = dict(path=pj, line=line)
            note = "input of the NanoCut experiment" + (" (built-in preset)" if lines is None else "")
            if lines is not None and line is None:
                src, note = None, "not recorded in this params.json (older NanoCut); schema default shown"
            out.append(dict(category=EDITABLE_GROUPS.get(sec, sec), key=f"{sec}.{k}", label=f"{sec}.{k}",
                            value=v if not isinstance(v, (list, tuple)) else " ".join(str(x) for x in v),
                            unit=UNITS.get(k, ""), provenance="editable", source=src, note=note))
    return out


def computed_params(sim, experiment, model):
    out = []

    def add(cat, key, label, value, unit, basis):
        out.append(dict(category=cat, key=key, label=label, value=value, unit=unit, provenance="computed", source=None, note=basis))

    if experiment:
        p, th = experiment["process"], experiment["thermo"]
        add("Process (cutting)", "speed_A_ps", "cutting speed", round(p["speed_ms"] * 0.01, 6), "Å/ps", "speed_ms x 0.01 (1 m/s = 0.01 Å/ps)")
        import math
        steps = int(math.ceil(p["cut_length_nm"] * 10 / (p["speed_ms"] * 0.01 * th["cut_dt_fs"] * 1e-3)))
        add("Process (cutting)", "cut_steps", "cutting steps", steps, "steps", "cut_length / (speed x dt)")
        add("Process (cutting)", "cut_time", "simulated cutting time", round(steps * th["cut_dt_fs"] * 1e-3, 3), "ps", "steps x dt")
        add("Thermostat & integration", "equil_steps", "equilibration steps", int(round(th["equil_ps"] / (th["equil_dt_fs"] * 1e-3))), "steps", "equil_ps / dt")
    if model:
        c = model.get("counts", {})
        add("Model (computed geometry)", "box", "workpiece size Lx x Ly x Lz",
            f"{model['Lx_A'] / 10:.3f} x {model['Ly_A'] / 10:.3f} x {model['Lz_A'] / 10:.4f}", "nm", "whole lattice cells (geometry.Model)")
        add("Model (computed geometry)", "cells", "lattice cells", " x ".join(str(x) for x in model.get("cells", [])), "", "length / lattice spacing, rounded")
        add("Model (computed geometry)", "y_surface", "undeformed surface y", round(model["y_surface_A"], 4), "Å", "max y of enumerated workpiece atoms")
        add("Model (computed geometry)", "edge_center", "tool edge centre (x, y)", ", ".join(f"{v:.3f}" for v in model["edge_center_A"]), "Å", "geometry.Model")
        for k, lab in [("total", "atoms total"), ("workpiece", "workpiece atoms"), ("tool", "tool atoms"),
                       ("wp_mob", "workpiece Newtonian"), ("wp_ts", "workpiece thermostat"), ("wp_bd", "workpiece fixed"),
                       ("ct_mob", "tool Newtonian"), ("ct_ts", "tool thermostat"), ("ct_bd", "tool fixed")]:
            if k in c:
                add("Model (computed geometry)", f"count_{k}", lab, c[k], "atoms", "exact lattice enumeration (verified = LAMMPS create_atoms)")
    return out


def reference_params(sim):
    """Physical values of an original deck pair, converted from lattice units by tools/verify_decks.parse_ref."""
    from verify_decks import parse_ref
    a, b = find_decks(sim)
    if not a or not b:
        return [], "deck A or B missing"
    a_txt = _abs(a["path"]).read_text(errors="replace")
    b_txt = _abs(b["path"]).read_text(errors="replace")
    if not a_txt.strip():
        return [], f"{a['name']} is empty in the reference folder"
    try:
        r = parse_ref(a_txt, b_txt)
    except Exception as e:
        return [], f"could not convert lattice-unit values: {e}"
    out = []

    def add(key, label, value, unit, basis):
        out.append(dict(category="Converted from lattice units", key=key, label=label, value=value, unit=unit,
                        provenance="computed", source=None, note=basis))
    add("depth", "depth of cut", round(r["depth_A"] / 10, 5), "nm", "(workpiece height - dy) x a")
    add("gap", "tool-workpiece gap", round(r["gap_A"] / 10, 5), "nm", "(dx - workpiece length) x a")
    add("edge_radius", "edge radius", round(r["edge_radius_A"] / 10, 5), "nm", "lr x b")
    add("tool_block", "tool block size", round(r["tool_block_A"] / 10, 5), "nm", "lx x b")
    add("wp_size", "workpiece size", f"{r['x_end_A'] / 10:.4f} x {r['y_surface_A'] / 10:.4f} x {r['wp_nz'] * r['a'] / 10:.4f}", "nm", "block bounds x a")
    add("speed", "cutting speed", f"{r['v_Aps']} Å/ps = {r['v_Aps'] * 100:.0f}", "m/s", "variable v")
    add("cut_steps", "cutting steps", r["cut_steps"], "steps", "ceil(N / v)")
    add("cut_length", "cutting length", round(r["cut_length_A"] / 10, 4), "nm", "steps x dt x v")
    add("dt_A", "time step A", r["equil_dt_ps"] * 1000, "fs", "timestep x 1000")
    add("dt_B", "time step B", r["cut_dt_ps"] * 1000, "fs", "timestep x 1000")
    add("potential_B", "potential used for cutting", r["potential_B"], "", "variable potential (y94 -> SiC_1994.tersoff)")
    return out, None


def inspect(sim, experiment, model):
    params, notes = [], []
    a, b = find_decks(sim)
    files = {}
    for f, which in ((a, "A"), (b, "B")):
        if f:
            files[which] = f["path"]
            ps, err = parse_deck(f["path"], which)
            params += ps
            if err:
                notes.append(f"deck {which} ({f['name']}): {err}")
        elif sim["kind"] != "preset":
            notes.append(f"deck {which} not found in this folder")
    if sim["kind"] == "reference":
        ps, err = reference_params(sim)
        params += ps
        if err:
            notes.append(err)
    if sim["kind"] != "reference":                      # an original deck has no NanoCut inputs of its own
        params += editable_params(sim, experiment)
    params += computed_params(sim, experiment if sim["kind"] != "reference" else None, model)
    if sim["kind"] != "preset":
        found = {p["key"] for p in params if p["provenance"] == "file"}
        for k in EXPECTED:
            if k not in found:
                rule = next(r for r in RULES if r[1] == k)
                params.append(dict(category=rule[0], key=k, label=rule[2], value=None, unit=rule[6], provenance="missing",
                                   source=None, note=MISSING_NOTES.get(k, "not found in the decks")))
    order = ["System", "Workpiece & tool lattices", "Tool", "Process (cutting)", "Converted from lattice units", "Force field",
             "Thermostat & integration", "Laser", "Output & restart", "Model (computed geometry)", "Compute resources", "Deck variables"]
    groups = {}
    for p in params:
        groups.setdefault(p["category"], []).append(p)
    gl = [dict(name=k, params=groups[k]) for k in order if k in groups] + \
         [dict(name=k, params=v) for k, v in groups.items() if k not in order]
    counts = {}
    for p in params:
        counts[p["provenance"]] = counts.get(p["provenance"], 0) + 1
    return dict(groups=gl, files=files, notes=notes, counts=counts)
