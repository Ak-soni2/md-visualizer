// Simulation overview: inputs, model geometry, trajectory statistics, warnings. Values are only shown when they
// come from project data (params.json, decks, dumps) or from NanoCut's geometry model; their source is labelled.
import { el, clear, num, bytes, kindBadge, originBadge, loading, empty, errorState, statusDot, when } from "../ui.js";
import { overview, model as loadModel } from "../data.js";
import { LAYERS } from "../colormaps.js";

const val = (v, u, digits = 4) => (v === null || v === undefined) ? el("dd", { class: "na" }, "not available") : el("dd", {}, typeof v === "number" ? num(v, digits) : String(v), u ? el("span", { class: "u" }, u) : null);

function kvPanel(title, rows, src) {
  const dl = el("dl", { class: "kv" });
  rows.forEach(([k, v, u, d]) => dl.append(el("dt", {}, k), val(v, u, d)));
  return el("section", { class: "panel" }, el("div", { class: "panel-head" }, el("h3", {}, title), src ? el("span", { class: "sub", style: { marginLeft: "auto" } }, src) : null), el("div", { class: "panel-body" }, dl));
}

export async function render(root, { sim, navigate }) {
  if (!sim) { root.append(empty("No simulation selected", "Pick one in the top bar or on the Workspace page.")); return; }
  const head = el("div", { class: "view-head" },
    el("div", { class: "title" }, el("div", { class: "ov-head" }, el("h1", {}, sim.label), kindBadge(sim.kind), originBadge(sim.origin)),
      el("p", { class: "path mono" }, sim.path || "built-in preset · nanocut/presets.py")),
    el("div", { class: "btn-group" },
      el("button", { class: "btn", onclick: () => navigate("visualizer", sim.id) }, "Visualize"),
      el("button", { class: "btn", onclick: () => navigate("parameters", sim.id) }, "All parameters"),
      el("button", { class: "btn", onclick: () => navigate("validation", sim.id) }, "Validation")));
  const body = el("div", {}, loading("Reading simulation…"));
  root.append(head, body);
  let ov;
  try { ov = await overview(sim.id); } catch (e) { clear(body).append(errorState(e)); return; }
  clear(body);

  const exp = ov.experiment;
  if (sim.kind === "reference") body.append(el("div", { class: "banner" }, el("b", {}, "Original reference deck. "),
    "The A/B files are shown as written on the Parameters page. The values below come from the matching NanoCut preset ",
    el("code", {}, sim.preset || "—"), ", which the archived verification found equal to this deck (see Validation)."));
  if (!exp) { body.append(empty("No experiment parameters", "This folder has no params.json and no matching preset.")); return; }

  const w = exp.workpiece, t = exp.tool, p = exp.process, th = exp.thermo, las = exp.laser, o = exp.output;
  const src = ov.sources.experiment;
  const speedAps = p.speed_ms * 0.01;
  const steps = Math.ceil(p.cut_length_nm * 10 / (speedAps * th.cut_dt_fs * 1e-3));

  // key metrics row
  const tiles = el("section", { class: "panel", style: { marginBottom: "12px" } }, el("div", { class: "metrics" },
    tile("Depth of cut", p.depth_nm, "nm"), tile("Cutting speed", p.speed_ms, "m/s", `${num(speedAps)} Å/ps`),
    tile("Cutting length", p.cut_length_nm, "nm", `${num(steps)} steps`), tile("Temperature", th.temperature_K, "K"),
    tile(t.shape === "sphere" ? "Sphere radius" : "Edge radius", t.shape === "sphere" ? t.sphere_radius_nm : t.edge_radius_nm, "nm"),
    tile("Time step (cut)", th.cut_dt_fs, "fs")));
  body.append(tiles);

  const grid = el("div", { class: "grid c3" });
  body.append(grid);
  grid.append(
    kvPanel("Workpiece & material", [["material", w.material], ["lattice constant a₀", w.a0, "Å", 5], ["orientation x / y / z", `[${w.orient_x}] [${w.orient_y}] [${w.orient_z}]`],
      ["size (input)", `${num(w.length_nm)} × ${num(w.height_nm)} × ${num(w.width_nm)}`, "nm"], ["fixed layer", w.fixed_nm, "nm"], ["thermostat layer", w.thermo_nm, "nm"],
      ["boundary x y z", `${w.boundary_x ?? "s"} ${w.boundary_y ?? "s"} ${w.boundary_z ?? "p"}`]], src),
    kvPanel("Tool", [["material", t.material], ["shape", t.shape], ["deformable", t.deformable ? "yes (own layers)" : "no (rigid)"],
      ...(t.shape === "wedge" ? [["rake angle", t.rake_deg, "°"], ["clearance angle", t.clearance_deg, "°"], ["edge radius", t.edge_radius_nm, "nm"], ["block", `${num(t.length_nm)} × ${num(t.height_nm)}`, "nm"]]
        : [["sphere radius", t.sphere_radius_nm, "nm"]]), ["lattice constant", t.a0, "Å"]], src),
    kvPanel("Process & integration", [["depth of cut", p.depth_nm, "nm"], ["gap to workpiece", p.gap_nm, "nm"], ["speed", `${num(p.speed_ms)} m/s = ${num(speedAps)} Å/ps`],
      ["cutting steps", steps, "", 0], ["simulated cutting time", steps * th.cut_dt_fs * 1e-3, "ps"], ["equilibration", `${num(th.equil_ps)} ps × dt ${num(th.equil_dt_fs)} fs`],
      ["thermostats A / B", `${th.equil_thermostat} / ${th.cut_thermostat}, Tdamp ${num(th.tdamp_ps)} ps`], ["potential", exp.potential.key]], src),
    kvPanel("Laser / thermal assistance", las.mode === "none" ? [["mode", "none (conventional cutting)"]] :
      [["mode", las.mode], ...(las.mode === "preheat" ? [["workpiece temperature", las.preheat_K, "K"]] : [["spot radius", las.spot_radius_nm, "nm"], ["lead ahead of tool", las.lead_nm, "nm"],
        las.mode === "spot" ? ["spot temperature", las.spot_K, "K"] : ["heat input", las.spot_power_eV_ps, "eV/ps"]])], src),
    kvPanel("Output", [["thermo every", o.thermo_every, "steps", 0], ["dump every (B)", o.dump_every_cut, "steps", 0], ["force record every", o.forces_every, "steps", 0],
      ["restart every (B)", o.restart_every_cut, "steps", 0], ["contact-zone radius", o.contact_zone_radius_nm, "nm"]], src));

  // model (may be a background job for presets/references)
  const modelPanel = el("section", { class: "panel" }, el("div", { class: "panel-head" }, el("h3", {}, "Model (atom counts)"), el("span", { class: "sub", style: { marginLeft: "auto" } }, ov.sources.model)), el("div", { class: "panel-body" }, loading("Building model…", true)));
  grid.append(modelPanel);
  // trajectory
  const tr = ov.trajectory || {};
  grid.append(kvPanel("Trajectory (simulation output)", tr.natoms ? [["frames", sim.n_frames, "", 0], ["atoms per frame", tr.natoms, "", 0], ["total size", bytes(tr.total_bytes)],
    ["boundary flags", (tr.boundary || []).join(" ")], ["per-atom columns", (tr.columns || []).join(" ")]] : [["dump files", null]], "dump headers"));
  // warnings
  const issues = el("ul", { class: "issue-list" });
  (ov.schema_errors || []).forEach(m => issues.append(el("li", {}, statusDot("error"), m)));
  (ov.warnings || []).forEach(m => issues.append(el("li", {}, statusDot("warn"), m)));
  (ov.missing || []).forEach(m => issues.append(el("li", {}, statusDot("info"), `missing: ${m}`)));
  grid.append(el("section", { class: "panel", style: { gridColumn: "span 1" } }, el("div", { class: "panel-head" }, el("h3", {}, "Warnings & missing data"), el("span", { class: "sub", style: { marginLeft: "auto" } }, "advice rules · file scan")),
    el("div", { class: "panel-body" }, issues.children.length ? issues : empty("Nothing to report"))));

  const mbody = modelPanel.querySelector(".panel-body");
  const spinner = mbody.firstChild;
  try {
    const { model } = await loadModel(sim.id, rec => spinner.update?.(rec));
    if (!model) { clear(mbody).append(empty("Model not available")); return; }
    const c = model.counts || {};
    const bars = el("div", { class: "layer-bars" });
    const total = c.total || 1;
    [["wp_mob", 4], ["wp_ts", 5], ["wp_bd", 6], ["ct_mob", 1], ["ct_ts", 2], ["ct_bd", 3]].forEach(([k, mol]) => {
      if (c[k] === undefined) return;
      bars.append(el("div", { class: "layer-bar" }, el("span", {}, LAYERS[mol].name),
        el("span", { class: "track" }, el("span", { class: "fill", style: { width: `${(100 * c[k] / total).toFixed(2)}%`, background: LAYERS[mol].color, display: "block" } })),
        el("span", { class: "n" }, num(c[k]))));
    });
    clear(mbody).append(
      el("dl", { class: "kv", style: { marginBottom: "10px" } },
        el("dt", {}, "total atoms"), val(c.total, "", 0), el("dt", {}, "workpiece / tool"), el("dd", {}, `${num(c.workpiece)} / ${num(c.tool)}`),
        el("dt", {}, "box (Å)"), el("dd", {}, `${num(model.Lx_A, 2)} × ${num(model.Ly_A, 2)} × ${num(model.Lz_A, 3)}`),
        el("dt", {}, "lattice cells"), el("dd", {}, (model.cells || []).join(" × ")),
        el("dt", {}, "surface y"), val(model.y_surface_A, "Å"),
        el("dt", {}, "edge centre"), el("dd", {}, (model.edge_center_A || []).map(v => num(v, 3)).join(", "), el("span", { class: "u" }, "Å"))),
      bars);
  } catch (e) { clear(mbody).append(errorState(e)); }
}

function tile(k, v, u, d) {
  return el("div", { class: "metric" }, el("div", { class: "k" }, k), el("div", { class: "v" }, v === null || v === undefined ? "—" : num(v, 4), el("span", { class: "u" }, u)), d ? el("div", { class: "d" }, d) : null);
}
