// Deck editor: every NanoCut parameter (the same set, choices and help texts as the Streamlit "1 · Setup" tab).
// Start from a run, preset or params.json, edit, check live, generate A/B in the backend and download.
// Nothing is written on the server; original files are never touched.
import * as api from "../api.js";
import { state } from "../state.js";
import { el, clear, num, loading, empty, errorState, download, toast, tabs, statusDot, svg } from "../ui.js";
import { overview } from "../data.js";

// ------------------------------------------------------------------------------------------------ parameter spec
// type: num | int | bool | choice | vec | text | optnum (blank = literature default) | shiftz (tool origin shift z)
const L = (o, labels) => o.map(v => [v, labels?.[v] ?? v]);
let OPT = null;                                     // catalogues from /api/deck-options

const elemsOf = d => OPT.materials[d.workpiece.material]?.elements || [];
const toolElem = d => OPT.tool_materials[d.tool.material]?.elements?.[0] || "C";
const excluded = (p, a, b) => (p.excluded_pairs || []).some(([x, y]) => (x === a && y === b) || (x === b && y === a));
function needsCross(d) {
  const p = OPT.potentials[d.potential.key]; if (!p) return false;
  const t = toolElem(d);
  return !(p.elements.includes(t) && !excluded(p, t, t)) || elemsOf(d).some(e => excluded(p, e, t));
}
const morseFor = (a, b) => OPT.morse.find(m => (m.pair[0] === a && m.pair[1] === b) || (m.pair[0] === b && m.pair[1] === a));

const SPEC = [
  { title: "Workpiece", col: 0, fields: [
    { k: "workpiece.material", label: "Material", type: "choice", help: "Crystal cut by the tool. Changing it also sets a0, the default potential and the time steps.",
      opts: () => Object.entries(OPT.materials).map(([k, v]) => [k, v.label]) },
    { info: d => { const m = OPT.materials[d.workpiece.material]; return m ? `${m.label}: ${m.structure}, ${m.a0_note}` : ""; } },
    { k: "workpiece.a0", label: "Lattice constant a0", unit: "Å", type: "num", step: 0.0001, min: 1, max: 10, help: "Conventional cubic cell edge. Should match the potential's equilibrium value." },
    { k: "workpiece.length_nm", label: "Length along cutting direction x", unit: "nm", type: "num", step: 0.5, min: 1, help: "Snapped to whole lattice cells. Reference: 220 a0 = 96.07 nm." },
    { k: "workpiece.height_nm", label: "Height y", unit: "nm", type: "num", step: 0.5, min: 1, help: "Depth direction. Reference: 100 a0 = 43.67 nm." },
    { k: "workpiece.width_nm", label: "Width z", unit: "nm", type: "num", step: 0.1, min: 0.3, help: "Periodic ⇒ 'infinitely wide'. Must be ≥ 2 cutoffs (~6 Å). Reference: 9 a0 = 3.93 nm." },
    { k: "workpiece.fixed_nm", label: "Fixed (boundary) layer thickness", unit: "nm", type: "num", step: 0.1, min: 0, help: "Atoms held in place (bottom and back end): anchors the block. Reference: 5 a0." },
    { k: "workpiece.thermo_nm", label: "Thermostat layer thickness", unit: "nm", type: "num", step: 0.1, min: 0, help: "Nosé-Hoover layer next to the fixed one: the heat sink. Reference: 5 a0." },
    { k: "workpiece.anchor_far_end", label: "Also fix/thermostat the tool-entry end (+x)", type: "bool", help: "Reference decks leave the entry end free so the chip can form." },
    { sub: "Boundary conditions (what happens at the edges of the simulation box)" },
    { k: "workpiece.boundary_z", label: "Width direction z", type: "choice", help: "p = periodic: the slab repeats forever along z, i.e. an INFINITELY WIDE workpiece and tool (the reference decks). s = finite slab with free side faces.",
      opts: () => L(["p", "s"], { p: "p - periodic = infinitely wide (reference)", s: "s - finite width, free faces" }) },
    { k: "workpiece.boundary_x", label: "Cutting direction x", type: "choice", help: "s = free ends (box follows the atoms; the chip can leave). p = periodic = infinitely long workpiece: the tool re-enters from the other side (rarely wanted). f = fixed box face (atoms leaving are lost).",
      opts: () => L(["s", "f", "p"], { s: "s - free ends (reference)", f: "f - fixed box face", p: "p - periodic = infinitely long" }) },
    { k: "workpiece.boundary_y", label: "Depth direction y", type: "choice", help: "s = free surface above and below (reference). f = fixed box faces.",
      opts: () => L(["s", "f"], { s: "s - free (reference)", f: "f - fixed box faces" }) },
    { sub: "Crystal orientation" },
    { k: "workpiece.orient_x", label: "Crystal direction along x [h k l]", type: "vec", help: "Integers; x, y, z directions must be orthogonal and right-handed. (001)[−100] cutting: x = 1 0 0, y = 0 1 0, z = 0 0 1." },
    { k: "workpiece.orient_y", label: "Crystal direction along y", type: "vec", help: "Surface normal." },
    { k: "workpiece.orient_z", label: "Crystal direction along z", type: "vec", help: "Width (periodic) direction." },
  ] },
  { title: "Process", col: 0, fields: [
    { k: "process.depth_nm", label: "Depth of cut d", unit: "nm", type: "num", step: 0.05, min: 0.01, help: "Undeformed surface to the lowest tool point. Reference: 3/5/7 a0 = 1.31/2.18/3.06 nm." },
    { k: "process.speed_ms", label: "Cutting speed", unit: "m/s", type: "num", step: 10, min: 1, help: "MD speeds are 10–1000 m/s (time-step limited). 200 m/s = 2 Å/ps." },
    { k: "process.cut_length_nm", label: "Cutting length", unit: "nm", type: "num", step: 1, min: 0.1, help: "Tool travel in B. Reference: 20 or 30 nm." },
    { k: "process.gap_nm", label: "Initial tool–workpiece gap", unit: "nm", type: "num", step: 0.1, min: 0, help: "Horizontal clearance before contact. Reference: 0 or 2 a0." },
  ] },
  { title: "Potential (force field)", col: 0, fields: [
    { k: "potential.key", label: "Interatomic potential", type: "choice", help: "Files bundled with LAMMPS; only potentials that cover every workpiece element are listed. Citation below.",
      opts: d => Object.entries(OPT.potentials).filter(([, p]) => elemsOf(d).every(e => p.elements.includes(e))).map(([k, p]) => [k, p.label]) },
    { info: d => { const p = OPT.potentials[d.potential.key]; return p ? `File ${p.file} (pair_style ${p.style}). Cite: ${p.citation}. ${p.note}` : "unknown potential"; } },
    { info: d => (OPT.potentials[d.potential.key]?.rigid_tool_only && d.tool.deformable) ? "⚠ This potential cannot describe a deformable diamond tool: switch the tool to rigid or choose another potential." : "", warn: true },
    { k: "potential.cross_style", label: "Tool–workpiece cross interaction", type: "choice", show: needsCross, help: "auto = Morse if a literature set exists, else ZBL repulsion.",
      opts: () => L(["auto", "morse", "zbl", "lj"]) },
    { info: d => needsCross(d) ? elemsOf(d).map(e => { const m = morseFor(toolElem(d), e); return m ? `Morse ${toolElem(d)}-${e}: D0 = ${m.D} eV, α = ${m.alpha} 1/Å, r0 = ${m.r0} Å — ${m.source}${m.verified ? "" : " (PARTIALLY VERIFIED)"}` : `No verified Morse set for ${toolElem(d)}-${e}: enter parameters or use ZBL (repulsive only).`; }).join("\n") : "" },
    { k: "potential.morse_D", label: "Morse D0", unit: "eV", type: "optnum", show: d => needsCross(d) && d.potential.cross_style === "morse", help: "Blank = literature default." },
    { k: "potential.morse_alpha", label: "Morse alpha", unit: "1/Å", type: "optnum", show: d => needsCross(d) && d.potential.cross_style === "morse", help: "Blank = literature default." },
    { k: "potential.morse_r0", label: "Morse r0", unit: "Å", type: "optnum", show: d => needsCross(d) && d.potential.cross_style === "morse", help: "Blank = literature default." },
    { k: "potential.morse_rc", label: "Morse cutoff", unit: "Å", type: "num", step: 0.1, min: 1, show: d => needsCross(d) && ["auto", "morse"].includes(d.potential.cross_style), help: "Cutoff of the Morse cross term." },
    { k: "potential.lj_eps", label: "LJ epsilon", unit: "eV", type: "optnum", show: d => needsCross(d) && d.potential.cross_style === "lj", help: "Lennard-Jones well depth." },
    { k: "potential.lj_sigma", label: "LJ sigma", unit: "Å", type: "optnum", show: d => needsCross(d) && d.potential.cross_style === "lj", help: "Lennard-Jones zero-crossing distance." },
  ] },
  { title: "Tool", col: 1, fields: [
    { k: "tool.material", label: "Tool material", type: "choice", help: "Diamond single crystal.", opts: () => Object.entries(OPT.tool_materials).map(([k, v]) => [k, v.label]) },
    { k: "tool.a0", label: "Tool lattice constant", unit: "Å", type: "num", step: 0.001, min: 1, max: 10, help: "Reference: 3.571 Å." },
    { k: "tool.shape", label: "Shape", type: "choice", help: "wedge = orthogonal cutting tool with rake/clearance faces and rounded edge; sphere = abrasive grit (scratching).", opts: () => L(["wedge", "sphere"]) },
    { k: "tool.deformable", label: "Deformable tool (own fixed/thermostat/Newtonian layers)", type: "bool", help: "Reference decks: deformable. Rigid = all tool atoms move together (cheaper, no tool wear)." },
    { k: "tool.rake_deg", label: "Rake angle", unit: "°", type: "num", step: 1, min: -80, max: 60, show: d => d.tool.shape === "wedge", help: "0 = vertical rake face (reference). Negative = face leans over the workpiece (common for brittle materials)." },
    { k: "tool.clearance_deg", label: "Clearance angle", unit: "°", type: "num", step: 1, min: 0, max: 60, show: d => d.tool.shape === "wedge", help: "Flank inclination behind the edge. Reference: 10°." },
    { k: "tool.edge_radius_nm", label: "Edge radius", unit: "nm", type: "num", step: 0.1, min: 0, show: d => d.tool.shape === "wedge", help: "Rounded cutting edge. Reference: 5/10/20 diamond cells = 1.79/3.57/7.14 nm." },
    { k: "tool.length_nm", label: "Tool length x", unit: "nm", type: "num", step: 0.5, min: 0.5, show: d => d.tool.shape === "wedge", help: "Reference: 70 cells = 25 nm." },
    { k: "tool.height_nm", label: "Tool height y", unit: "nm", type: "num", step: 0.5, min: 0.5, show: d => d.tool.shape === "wedge", help: "Reference: 70 cells = 25 nm." },
    { k: "tool.sphere_radius_nm", label: "Sphere radius", unit: "nm", type: "num", step: 0.5, min: 0.5, show: d => d.tool.shape === "sphere", help: "Abrasive grit radius." },
    { k: "tool.fixed_nm", label: "Tool fixed layer", unit: "nm", type: "num", step: 0.1, min: 0, show: d => d.tool.deformable, help: "Top/back layers that carry the prescribed motion. Reference: 3 cells = 1.07 nm." },
    { k: "tool.thermo_nm", label: "Tool thermostat layer", unit: "nm", type: "num", step: 0.1, min: 0, show: d => d.tool.deformable, help: "Reference: 3 cells." },
    { k: "tool.origin_shift", label: "Tool lattice origin shift z", unit: "cell", type: "shiftz", step: 0.05, min: 0, max: 1, help: "Reference: 0.4. Shifts the tool lattice along the periodic width to avoid overlapping images." },
    { k: "tool.orient_x", label: "Tool crystal direction along x", type: "vec", help: "Integers, orthogonal and right-handed (reference 1 0 0)." },
    { k: "tool.orient_y", label: "Tool crystal direction along y", type: "vec", help: "Reference 0 1 0." },
    { k: "tool.orient_z", label: "Tool crystal direction along z", type: "vec", help: "Reference 0 0 1." },
  ] },
  { title: "Laser / thermal assistance (LAM)", col: 1, fields: [
    { k: "laser.mode", label: "Heat source", type: "choice", help: "none: conventional cutting. preheat: whole workpiece equilibrated/thermostatted at a higher temperature (how most MD laser-assisted-machining papers model the laser). spot: a cylindrical zone ahead of the tool, moving with it, held at a set temperature by a Langevin thermostat. power: same moving zone with a constant energy input (fix heat).",
      opts: () => L(["none", "preheat", "spot", "power"], { none: "none (conventional cutting)", preheat: "preheat - uniform workpiece temperature", spot: "spot - moving hot zone at set temperature", power: "power - moving zone with constant heat input" }) },
    { k: "laser.preheat_K", label: "Workpiece temperature", unit: "K", type: "num", step: 50, min: 1, show: d => d.laser.mode === "preheat", help: "Literature range 600-1200 K for Si/SiC (tool stays at the base temperature)." },
    { k: "laser.spot_radius_nm", label: "Spot radius", unit: "nm", type: "num", step: 0.5, min: 0.2, show: d => ["spot", "power"].includes(d.laser.mode), help: "Cylinder radius (through the width); its centre sits on the surface so half of it is inside the material." },
    { k: "laser.lead_nm", label: "Lead distance ahead of the tool", unit: "nm", type: "num", step: 0.5, min: 0, show: d => ["spot", "power"].includes(d.laser.mode), help: "Distance between the tool front and the spot centre." },
    { k: "laser.spot_depth_nm", label: "Spot centre below the surface", unit: "nm", type: "num", step: 0.5, min: 0, show: d => ["spot", "power"].includes(d.laser.mode), help: "0 = centre on the surface." },
    { k: "laser.spot_K", label: "Spot temperature", unit: "K", type: "num", step: 50, min: 1, show: d => d.laser.mode === "spot", help: "Target temperature held by the Langevin thermostat in the zone." },
    { k: "laser.spot_damp_ps", label: "Spot coupling time", unit: "ps", type: "num", step: 0.01, min: 0.001, show: d => d.laser.mode === "spot", help: "Langevin damping; smaller = stronger coupling." },
    { k: "laser.spot_power_eV_ps", label: "Heat input", unit: "eV/ps", type: "num", step: 5, min: 0.1, show: d => d.laser.mode === "power", help: "Energy added per ps to all atoms currently in the zone (fix heat). 1 eV/ps = 0.16 nW." },
    { info: d => { if (d.laser.mode === "none") return ""; const m = OPT.materials[d.workpiece.material]; if (!m?.brittle || !m.E_GPa) return ""; const dc = 0.15 * (m.E_GPa / m.H_GPa) * (m.Kc / m.H_GPa) ** 2 * 1000; return `Ductile-brittle guidance: Bifano's room-temperature critical depth for ${d.workpiece.material} is about ${dc.toFixed(0)} nm (d_c = 0.15 (E/H)(K_c/H)²). Heating lowers H faster than K_c and raises d_c. The simulation itself decides the regime.`; } },
  ] },
  { title: "Thermodynamics & integration", col: 1, fields: [
    { k: "thermo.temperature_K", label: "Temperature", unit: "K", type: "num", step: 10, min: 1, help: "Initial and thermostat temperature." },
    { k: "thermo.seed", label: "Random seed", type: "int", step: 1, min: 1, help: "Change for repeat runs (error bars)." },
    { k: "thermo.velocity_dist", label: "Initial velocity distribution", type: "choice", help: "Reference: uniform.", opts: () => L(["uniform", "gaussian"]) },
    { k: "thermo.minimize_before_equil", label: "Minimise energy before equilibration (A)", type: "bool", help: "Recommended; reference decks skip it." },
    { k: "thermo.equil_ps", label: "Equilibration time", unit: "ps", type: "num", step: 1, min: 0.01, help: "Reference: 5 ps; typical 10-30 ps." },
    { k: "thermo.equil_dt_fs", label: "Time step in A", unit: "fs", type: "num", step: 0.1, min: 0.05, max: 5, help: "0.5 fs for Tersoff/SiC, 1 fs for EAM metals." },
    { k: "thermo.equil_thermostat", label: "Thermostat in A", type: "choice", help: "Nosé-Hoover (reference), Langevin, Berendsen.", opts: () => L(["nvt", "langevin", "berendsen"]) },
    { k: "thermo.tdamp_ps", label: "Thermostat damping", unit: "ps", type: "num", step: 0.01, min: 0.001, help: "Reference: 0.05 ps (= 100 steps of 0.5 fs)." },
    { k: "thermo.minimize_before_cut", label: "Minimise after reading the restart (B)", type: "bool", help: "Reference: yes." },
    { k: "thermo.cut_dt_fs", label: "Time step in B", unit: "fs", type: "num", step: 0.1, min: 0.05, max: 5, help: "Time step of the cutting stage." },
    { k: "thermo.cut_thermostat", label: "Thermostat on the thermostat layers in B", type: "choice", help: "Thermostat applied in deck B.", opts: () => L(["nvt", "langevin", "berendsen"]) },
    { k: "thermo.wp_temp_compute", label: "Workpiece temperature compute", type: "choice", help: "temp/partial 0 1 1 (reference) ignores x-velocities (removes streaming along the cut); temp = plain kinetic temperature.", opts: () => L(["temp/partial", "temp"]) },
  ] },
  { title: "Output", col: 1, fields: [
    { k: "output.thermo_every", label: "Thermo output every", unit: "steps", type: "int", step: 50, min: 1, help: "Thermo line interval." },
    { k: "output.dump_every_equil", label: "Dump every in A", unit: "steps", type: "int", step: 500, min: 1, help: "Per-atom dump interval in deck A." },
    { k: "output.dump_every_cut", label: "Dump every in B", unit: "steps", type: "int", step: 100, min: 10, help: "Multiple of 10." },
    { k: "output.restart_every_equil", label: "Restart every in A", unit: "steps", type: "int", step: 500, min: 1, help: "Restart file interval in deck A." },
    { k: "output.restart_every_cut", label: "Restart every in B", unit: "steps", type: "int", step: 1000, min: 1, help: "Restart file interval in deck B." },
    { k: "output.forces_every", label: "Force/temperature record every", unit: "steps", type: "int", step: 10, min: 10, help: "Multiple of 10." },
    { k: "output.contact_zone_radius_nm", label: "Contact-zone radius for temperature", unit: "nm", type: "num", step: 0.5, min: 0.2, help: "Cylinder around the moving edge used for the contact-zone temperature." },
    { k: "output.dump_velocities", label: "Dump velocities", type: "bool" },
    { k: "output.dump_forces", label: "Dump forces", type: "bool" },
    { k: "output.dump_ke", label: "Dump kinetic energy (+time average → local T)", type: "bool" },
    { k: "output.dump_pe", label: "Dump potential energy", type: "bool" },
    { k: "output.dump_stress", label: "Dump stress tensor", type: "bool" },
    { k: "output.dump_coord", label: "Dump coordination number", type: "bool" },
    { k: "output.dump_cna", label: "Dump CNA (fcc/bcc metals)", type: "bool" },
  ] },
  { title: "Compute resources", col: 1, fields: [
    { k: "compute.mpi_ranks", label: "MPI ranks", type: "int", step: 1, min: 1, help: "Reference run: 10." },
    { k: "compute.omp_threads", label: "OpenMP threads per rank", type: "int", step: 1, min: 1, help: "Threads per MPI rank." },
    { k: "compute.lammps_cmd", label: "LAMMPS executable", type: "text", help: "Command used in the run scripts." },
  ] },
];

const getK = (d, k) => k.split(".").reduce((o, p) => o?.[p], d);
const setK = (d, k, v) => { const p = k.split("."), last = p.pop(); p.reduce((o, q) => o[q], d)[last] = v; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clone = o => JSON.parse(JSON.stringify(o));

export async function render(root, { sim }) {
  const live = api.apiMode() === "live";
  root.append(el("div", { class: "view-head" }, el("div", { class: "title" }, el("h1", {}, "Decks"),
    el("p", {}, "Every NanoCut parameter, as in the Streamlit setup tab: start from a run, a preset or a params.json, change anything, and generate the two LAMMPS decks (A: build and equilibrate; B: read restart and cut). Changed values are marked in amber; hover a label for its explanation. Nothing is written on the server."))));
  if (!live) { root.append(el("div", { class: "banner warn" }, el("b", {}, "Backend offline. "), "The deck editor needs the Python backend (start webapp\\run_web.bat).")); return; }
  try { OPT = OPT || await api.get("/api/deck-options"); }
  catch (e) { root.append(errorState(e)); return; }

  const bases = state.sims.filter(s => s.kind === "run" || s.kind === "preset");
  const baseSel = el("select", { class: "select deck-base", "aria-label": "Start from" },
    el("optgroup", { label: "Presets" }, ...bases.filter(b => b.kind === "preset").map(b => el("option", { value: b.id }, b.label))),
    el("optgroup", { label: "Run folders (their params.json)" }, ...bases.filter(b => b.kind === "run").map(b => el("option", { value: b.id }, b.path))));
  baseSel.value = sim && bases.find(b => b.id === sim.id) ? sim.id : (bases.find(b => b.kind === "preset")?.id ?? "");
  const fileIn = el("input", { type: "file", accept: ".json,application/json", hidden: true });
  const genBtn = el("button", { class: "btn primary", type: "button" }, "Generate decks A + B");
  const modCount = el("span", { class: "muted" });
  const checkBox = el("div", { class: "deck-check", role: "status", "aria-live": "polite" });
  const toolbar = el("div", { class: "panel deck-toolbar" }, el("div", { class: "panel-body field-row", style: { flexWrap: "wrap" } },
    el("label", { class: "field-row" }, el("span", { class: "muted" }, "Start from"), baseSel),
    el("button", { class: "btn", type: "button", onclick: () => fileIn.click(), "data-tip": "Load a params.json written by NanoCut (run folder) or by the Streamlit app" }, "Load params.json"), fileIn,
    el("button", { class: "btn", type: "button", onclick: () => download("params.json", JSON.stringify(draft, null, 2), "application/json"), "data-tip": "Save the current parameters (reload them later here or in Streamlit)" }, svg("download"), "params.json"),
    el("button", { class: "btn", type: "button", onclick: () => { draft = clone(base); buildForm(); check(); } }, "Reset all changes"),
    modCount, el("span", { style: { flex: 1 } }), genBtn));
  const nameRow = el("div", { class: "deck-field wide" });
  const cols = [el("div", { class: "deck-col" }), el("div", { class: "deck-col" })];
  const out = el("section", { class: "panel", id: "deck-output" }, el("div", { class: "panel-body" }, empty("No decks generated yet", "Edit the parameters and press Generate decks A + B.")));
  root.append(toolbar, checkBox, el("div", { class: "panel deck-name" }, el("div", { class: "panel-body" }, nameRow)), el("div", { class: "deck-grid" }, ...cols), out);

  let base = null, draft = null, baseLabel = "";

  async function loadBase() {
    cols.forEach(c => clear(c)); cols[0].append(loading("Reading base parameters…"));
    try {
      const ov = await overview(baseSel.value);
      base = clone(ov.experiment); draft = clone(base); baseLabel = baseSel.selectedOptions[0]?.textContent || "";
      buildForm(); check();
    } catch (e) { clear(cols[0]).append(errorState(e, loadBase)); }
  }
  fileIn.onchange = async () => {
    const f = fileIn.files[0]; fileIn.value = ""; if (!f) return;
    try {
      const d = JSON.parse(await f.text()), e = d.experiment || d;
      const r = await api.post("/api/decks/check", { experiment: e });          // also normalises through the schema
      base = clone(OPT.defaults); deepMerge(base, e); draft = clone(base); baseLabel = f.name;
      buildForm(); showCheck(r.body); toast(`Loaded ${f.name}.`, "ok");
    } catch (err) { toast(`Not a NanoCut params.json: ${err.message}`, "err"); }
  };
  const deepMerge = (t, s) => { for (const [k, v] of Object.entries(s || {})) { if (v && typeof v === "object" && !Array.isArray(v) && t[k] && typeof t[k] === "object") deepMerge(t[k], v); else if (k in t) t[k] = v; } };

  // ---------------------------------------------------------------------------------------------- form
  function field(f) {
    const cur = getK(draft, f.k), orig = getK(base, f.k), id = "d-" + f.k.replace(/\./g, "-");
    let input;
    const commit = v => { setK(draft, f.k, v); onChange(f); };
    if (f.type === "choice") {
      let opts = f.opts(draft);
      if (!opts.some(([v]) => v === cur)) opts = [[cur, `${cur} (not offered for this material)`], ...opts];
      input = el("select", { class: "select", id, onchange: e => commit(e.target.value) }, opts.map(([v, l]) => el("option", { value: v, selected: v === cur }, l)));
    } else if (f.type === "bool") {
      input = el("input", { type: "checkbox", id, checked: !!cur, onchange: e => commit(e.target.checked) });
    } else if (f.type === "vec") {
      input = el("div", { class: "vec3" }, [0, 1, 2].map(i => el("input", { class: "input num", type: "number", step: 1, value: cur[i], id: i ? null : id, "aria-label": `${f.label} ${"hkl"[i]}`,
        onchange: e => { const v = [...getK(draft, f.k)]; v[i] = Math.round(+e.target.value || 0); commit(v); } })));
    } else if (f.type === "shiftz") {
      input = el("input", { class: "input num", type: "number", id, step: f.step, min: f.min, max: f.max, value: cur[2], onchange: e => { const v = [...getK(draft, f.k)]; v[2] = +e.target.value || 0; commit(v); } });
    } else if (f.type === "text") {
      input = el("input", { class: "input", type: "text", id, value: cur ?? "", onchange: e => commit(e.target.value) });
    } else {
      input = el("input", { class: "input num", type: "number", id, step: f.step ?? "any", min: f.min, max: f.max, value: cur ?? "", placeholder: f.type === "optnum" ? "default" : null,
        onchange: e => {
          const s = e.target.value.trim();
          if (s === "") { if (f.type === "optnum") commit(null); else e.target.value = getK(draft, f.k); return; }
          const v = f.type === "int" ? Math.round(+s) : +s;
          if (!Number.isFinite(v)) { e.target.value = getK(draft, f.k); return; }
          commit(v);
        } });
    }
    const changed = !same(cur, orig);
    return el("div", { class: `deck-field${changed ? " mod" : ""}${f.type === "bool" ? " bool" : ""}` },
      el("label", { class: "lbl", for: id, "data-tip": f.help || null }, f.label, f.unit ? el("small", {}, f.unit) : null), input,
      el("button", { class: "btn icon ghost", type: "button", "aria-label": `Reset ${f.label}`, "data-tip": `Base value: ${Array.isArray(orig) ? orig.join(" ") : orig ?? "default"}`, disabled: !changed,
        onclick: () => { setK(draft, f.k, clone(orig)); onChange(f, true); } }, "↺"));
  }
  function buildForm() {
    const focus = document.activeElement?.id;
    cols.forEach(c => clear(c));
    clear(nameRow).append(el("label", { class: "lbl", for: "d-name", "data-tip": "Used in file names (restart, dumps, force file)." }, "Experiment name"),
      el("input", { class: "input", id: "d-name", value: draft.name, onchange: e => { draft.name = e.target.value.trim() || base.name; buildForm(); check(); } }),
      el("span", { class: "muted small" }, `Base: ${baseLabel}`));
    nameRow.classList.toggle("mod", draft.name !== base.name);
    for (const s of SPEC) {
      const fs = el("fieldset", {}, el("legend", {}, s.title));
      let n = 0;
      for (const f of s.fields) {
        if (f.sub) { fs.append(el("div", { class: "deck-sub" }, f.sub)); continue; }
        if (f.info) { const t = f.info(draft); if (t) fs.append(el("p", { class: `deck-info${f.warn ? " warn" : ""}` }, t)); continue; }
        if (f.show && !f.show(draft)) continue;
        fs.append(field(f)); if (!same(getK(draft, f.k), getK(base, f.k))) n++;
      }
      if (n) fs.querySelector("legend").append(el("span", { class: "deck-count" }, ` · ${n} changed`));
      cols[s.col].append(fs);
    }
    const total = countChanges();
    modCount.textContent = total ? `${total} parameter${total > 1 ? "s" : ""} changed from the base` : "no changes";
    if (focus) document.getElementById(focus)?.focus();
  }
  function countChanges() {
    let n = draft.name !== base.name ? 1 : 0;
    for (const sec of Object.keys(base)) if (base[sec] && typeof base[sec] === "object") for (const k of Object.keys(base[sec])) if (!same(draft[sec][k], base[sec][k])) n++;
    return n;
  }
  function onChange(f, isReset = false) {
    if (!isReset && f.k === "workpiece.material") {          // same as Streamlit: material sets a0, default potential and time steps
      const m = OPT.materials[draft.workpiece.material];
      if (m) { draft.workpiece.a0 = m.a0; draft.potential.key = m.default_potential; draft.thermo.cut_dt_fs = draft.thermo.equil_dt_fs = m.dt_fs; }
      toast(`Material ${draft.workpiece.material}: a0, potential and time steps set to its defaults.`, "info");
    }
    if (!isReset && f.k === "tool.material") { const t = OPT.tool_materials[draft.tool.material]; if (t) draft.tool.a0 = t.a0; }
    buildForm(); check();
  }

  // ---------------------------------------------------------------------------------------------- live check
  let checkT = 0, checkTok = 0;
  function check() {
    clearTimeout(checkT);
    checkT = setTimeout(async () => {
      const tok = ++checkTok;
      try { const r = await api.post("/api/decks/check", { experiment: draft }); if (tok === checkTok) showCheck(r.body); }
      catch (e) { if (tok === checkTok) showCheck({ errors: [e.message] }); }
    }, 250);
  }
  function showCheck(r) {
    clear(checkBox);
    genBtn.disabled = !!r.errors?.length;
    if (r.errors?.length) checkBox.append(el("div", { class: "banner err" }, el("b", {}, "Fix before generating: "), r.errors.join("; ")));
    else checkBox.append(el("div", { class: "banner" }, statusDot("ok"), el("span", {}, `Parameters valid. Deck A: ${num(r.equil_steps)} equilibration steps; deck B: ${num(r.cut_steps)} cutting steps. Atom counts, warnings and advice appear after generation.`)));
  }

  // ---------------------------------------------------------------------------------------------- generate
  genBtn.onclick = async () => {
    clear(out).append(loading("Generating decks (building the model)…", true));
    out.scrollIntoView({ behavior: "smooth", block: "start" });
    genBtn.disabled = true;
    try {
      const st = out.querySelector(".state");
      const res = await api.job("/api/decks", { method: "POST", data: { experiment: draft }, onProgress: r => st?.update?.(r) });
      showResult(res);
    } catch (e) { clear(out).append(errorState(e)); }
    genBtn.disabled = false;
  };
  function showResult(res) {
    clear(out);
    if (res.errors?.length) { out.append(el("div", { class: "panel-body" }, el("div", { class: "banner err" }, el("b", {}, "Invalid inputs: "), res.errors.join("; ")))); return; }
    const c = res.counts || {};
    const issues = [...(res.warnings || []), ...(res.advice || [])];
    const safe = String(res.name).replace(/[^\w.-]+/g, "_"), fA = `${safe}_A.txt`, fB = `${safe}_B.txt`;               // deck file names: <experiment>_A.txt / _B.txt
    const T = tabs([{ id: "deckA", label: `${fA} · build + equilibrate` }, { id: "deckB", label: `${fB} · cut` }]);
    const pane = txt => el("pre", { class: "code code-pane" }, ...txt.split("\n").map((l, i) => el("div", { class: "ln" }, el("i", {}, String(i + 1)), el("span", {}, l))));
    T.panels.deckA.append(pane(res.A)); T.panels.deckB.append(pane(res.B));
    out.append(
      el("div", { class: "panel-head" }, el("h3", {}, res.name), el("span", { class: "sub" }, `${num(c.total)} atoms (workpiece ${num(c.workpiece)}, tool ${num(c.tool)})`),
        el("div", { class: "actions" },
          el("button", { class: "btn primary", type: "button", onclick: () => { download(fA, res.A); download(fB, res.B); } }, svg("download"), "Both decks"),
          el("button", { class: "btn", type: "button", onclick: () => download(fA, res.A) }, fA),
          el("button", { class: "btn", type: "button", onclick: () => download(fB, res.B) }, fB),
          el("button", { class: "btn", type: "button", onclick: () => download("params.json", JSON.stringify(draft, null, 2), "application/json") }, "params.json"),
          el("button", { class: "btn ghost", type: "button", onclick: async () => { try { await navigator.clipboard.writeText(res.A + "\n\n" + res.B); toast("Both decks copied.", "ok"); } catch { toast("Clipboard not available.", "err"); } } }, svg("copy"), "Copy"))),
      el("div", { class: "panel-body" },
        el("p", {}, "Potential file(s) to place next to the decks: ", ...res.potential_files.map(f => el("code", { style: { marginRight: "8px" } }, f)), el("span", { class: "muted" }, " (in the project's potentials/ folder)")),
        issues.length ? el("ul", { class: "issue-list", style: { margin: "8px 0" } }, ...issues.map(m => el("li", {}, statusDot("warn"), m))) : el("p", { class: "muted" }, "No warnings."),
        T.bar, ...Object.values(T.panels)));
  }

  baseSel.onchange = loadBase;
  await loadBase();
}
