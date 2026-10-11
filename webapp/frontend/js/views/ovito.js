// OVITO page: analysis and images made by the official OVITO Python module (pip package `ovito`), not by NanoCut.
// The page collects settings; the backend turns them into an OVITO Python script, runs it in an OVITO worker process,
// and returns OVITO's rendered image, OVITO's global attributes and per-property statistics. The exact script is shown
// and can be downloaded, so every result can be reproduced in OVITO itself.
import * as api from "../api.js";
import { state } from "../state.js";
import { el, clear, num, bytes, toast, loading, errorState, download, svg, tabs } from "../ui.js";

const KEY = "nanocut.ovito.v1";
const MODS = [
  ["select_type", "Select type"], ["expression_selection", "Expression selection"], ["invert_selection", "Invert selection"],
  ["clear_selection", "Clear selection"], ["delete_selected", "Delete selected"], ["slice", "Slice"],
  ["displacements", "Displacement vectors"], ["coordination", "Coordination analysis"], ["identify_diamond", "Identify diamond structure"],
  ["cna", "Common neighbor analysis"], ["dxa", "Dislocation analysis (DXA)"], ["compute_property", "Compute property"],
  ["color_coding", "Color coding"], ["assign_color", "Assign color"],
];
const MOD_LABEL = Object.fromEntries(MODS);
const MOD_HELP = {
  select_type: "Selects all particles of the chosen types (OVITO SelectTypeModifier).",
  expression_selection: "OVITO expression, e.g.  Position.Y > 437.27 && ParticleType != 1 . The number of selected particles appears in the results (ExpressionSelection.count).",
  delete_selected: "Removes the selected particles (e.g. the tool) from the image and from all later modifiers.",
  slice: "OVITO SliceModifier: plane n·r = distance; slab width 0 cuts the structure at the plane, a positive width works with a slab. Use Invert if OVITO removes the other side; Select only selects instead of deleting.",
  displacements: "OVITO CalculateDisplacementsModifier: Displacement (x, y, z) and Displacement Magnitude relative to the reference frame, minimum image convention across periodic boundaries.",
  coordination: "OVITO CoordinationAnalysisModifier: Coordination per particle within the cutoff (Å) and the radial distribution function.",
  identify_diamond: "OVITO IdentifyDiamondModifier: cubic/hexagonal diamond and their neighbours, other = disordered (suits 3C-SiC zinc-blende). Adds Structure Type; counts appear in the results.",
  cna: "OVITO CommonNeighborAnalysisModifier (adaptive): FCC/HCP/BCC/ICO/other, for metals.",
  dxa: "OVITO DislocationAnalysisModifier: extracts dislocation lines (drawn in the image) and their total length for the chosen crystal lattice.",
  compute_property: "OVITO ComputePropertyModifier: new per-particle property from OVITO expressions (one expression per component).",
  color_coding: "OVITO ColorCodingModifier. Leave Start/End empty to let OVITO adjust the range automatically.",
  assign_color: "Gives the selected particles one colour.",
  invert_selection: "Inverts the current selection.", clear_selection: "Clears the selection.",
};
const GRADIENTS = ["Rainbow", "Jet", "Hot", "Grayscale", "BlueWhiteRed", "Viridis", "Magma", "CyclicRainbow"];
const VIEWS = ["Top", "Bottom", "Front", "Back", "Left", "Right", "Ortho", "Perspective"];
const ALIGNS = ["top-left", "top", "top-right", "left", "right", "bottom-left", "bottom", "bottom-right"];
const DXA = ["CubicDiamond", "HexagonalDiamond", "FCC", "BCC", "HCP"];
const OUTPUTS = { displacements: ["Displacement.X", "Displacement.Y", "Displacement.Z", "Displacement Magnitude"], coordination: ["Coordination"],
  identify_diamond: ["Structure Type"], cna: ["Structure Type"], dxa: ["Structure Type", "Cluster"] };

const defaults = () => ({
  last: null, recent: [], frame: 0, types: {}, cell: false,
  modifiers: [],
  view: { type: "Top", zoom: 1, camera_dir: [-1, -1, -1] },
  render: { w: 1600, h: 1000, bg: "#ffffff", alpha: false, renderer: "opengl", aa_gl: 3, aa: 12, ao: true, shadows: false },
  overlays: { legend: { enabled: true, orientation: "vertical", align: "right", title: "", format: "%.2f Å", font_size: 0.1, size: 0.3, color: "#000000", ox: 0, oy: 0 },
    tripod: { enabled: true, align: "bottom-left", size: 0.07, ox: 0, oy: 0 }, labels: [] },
});
function load(raw) {
  const d = defaults();
  let s = raw;
  if (!s) try { s = JSON.parse(localStorage.getItem(KEY) || "null"); } catch { s = null; }
  if (!s || typeof s !== "object") return d;
  for (const k of ["view", "render"]) d[k] = { ...d[k], ...(s[k] || {}) };
  d.overlays = { legend: { ...d.overlays.legend, ...(s.overlays?.legend || {}) }, tripod: { ...d.overlays.tripod, ...(s.overlays?.tripod || {}) }, labels: s.overlays?.labels || [] };
  for (const k of ["last", "recent", "frame", "types", "cell", "modifiers"]) if (s[k] !== undefined) d[k] = s[k];
  d.modifiers = (d.modifiers || []).filter(m => MOD_LABEL[m.type]);
  return d;
}

// small form helpers
const numIn = (v, on, a = {}) => el("input", { class: "input num", type: "number", step: "any", value: v ?? "", onchange: e => on(e.target.value === "" ? null : +e.target.value), ...a });
const txtIn = (v, on, a = {}) => el("input", { class: "input", type: "text", value: v ?? "", onchange: e => on(e.target.value), ...a });
const colIn = (v, on, label) => el("input", { class: "color", type: "color", value: v, "aria-label": label, oninput: e => on(e.target.value) });
const sel = (opts, v, on, label) => el("select", { class: "select", "aria-label": label, onchange: e => on(e.target.value) },
  opts.map(o => { const [val, lab] = Array.isArray(o) ? o : [o, o]; return el("option", { value: val, selected: String(val) === String(v) }, lab); }));
const chk = (label, v, on, tip) => el("label", { class: "check", "data-tip": tip }, el("input", { type: "checkbox", checked: !!v, onchange: e => on(e.target.checked) }), label);
const row = (label, ...c) => el("label", { class: "frow" }, el("span", {}, label), el("div", { class: "fctl" }, ...c));
const sec = (title, ...kids) => el("section", { class: "st-sec" }, el("h4", {}, title), ...kids);

export async function render(root) {
  root.append(el("div", { class: "view-head" }, el("div", { class: "title" }, el("h1", {}, "OVITO"),
    el("p", {}, "Analysis and images made by the official OVITO Python module (ovito 3.x, installed in the project environment), not by NanoCut. Your settings become an OVITO Python script; OVITO reads the dump, runs its modifiers and renders the image. The exact script is shown, so every result can be reproduced in OVITO. Dump files are only read."))));
  if (api.apiMode() !== "live") { root.append(el("div", { class: "banner warn" }, "This page needs the Python backend (webapp\\run_web.bat).")); return; }
  const statusBox = el("div", {}, loading("Starting OVITO…"));
  root.append(statusBox);
  let st;
  try { st = await api.get("/api/ovito/status"); } catch (e) { clear(statusBox).append(errorState(e)); return; }
  if (!st.available) {
    clear(statusBox).append(el("div", { class: "banner err" }, el("b", {}, "OVITO is not available: "), st.error, el("br"), "Install it into the project environment: ", el("code", {}, st.install)));
    return;
  }
  clear(statusBox).append(el("div", { class: "banner" }, el("b", {}, `OVITO ${st.ovito}`), ` · Python ${st.python} · running in a separate worker process`));

  const S = load();
  let saveT = 0;
  const save = () => { clearTimeout(saveT); saveT = setTimeout(() => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch { /* not remembered */ } }, 300); };
  let src = null, info = null, result = null;

  // ---------------------------------------------------------------------------------------------- layout
  const pathIn = el("input", { class: "input path", type: "text", list: "ov-paths", placeholder: "Folder or dump file, e.g. D:\\Akshay\\Cutting_20_30\\AE", "aria-label": "Folder or dump file", value: S.last?.path || "" });
  const pathList = el("datalist", { id: "ov-paths" });
  const seqSel = el("select", { class: "select", "aria-label": "Trajectory", hidden: true });
  const srcInfo = el("span", { class: "muted mono small" });
  const bar = el("div", { class: "panel ov-bar" }, el("div", { class: "panel-body field-row", style: { flexWrap: "wrap" } },
    svg("folder"), pathIn, pathList, el("button", { class: "btn", type: "button", onclick: () => scan(pathIn.value) }, "Open"), seqSel, srcInfo));
  const left = el("div", { class: "panel ov-left" });
  const right = el("div", { class: "ov-right" });
  root.append(bar, el("div", { class: "ov-grid" }, left, right));
  const runs = state.sims.filter(s => s.kind === "run" && s.n_frames).map(s => s.path);
  [...new Set([...S.recent, ...runs])].forEach(p => pathList.append(el("option", { value: p })));
  pathIn.addEventListener("keydown", e => { if (e.key === "Enter") scan(pathIn.value); });

  // ---------------------------------------------------------------------------------------------- source
  async function scan(path) {
    path = (path || "").trim().replace(/^"|"$/g, "");
    if (!path) { toast("Enter a folder or dump file.", "warn"); return; }
    clear(right).append(loading("Looking for LAMMPS dump files…"));
    let r;
    try { r = await api.get(`/api/studio/scan?path=${encodeURIComponent(path)}`); }
    catch (e) { clear(right).append(errorState(e)); return; }
    if (!r.sequences.length) { clear(right).append(el("div", { class: "state err" }, el("b", {}, "No LAMMPS dump found"), el("span", {}, r.path))); return; }
    clear(seqSel);
    r.sequences.forEach((s, i) => seqSel.append(el("option", { value: i }, `${s.dir.split(/[\\/]/).pop()}/${s.pattern} · ${s.count} file${s.count > 1 ? "s" : ""} · ${bytes(s.bytes)}`)));
    seqSel.hidden = r.sequences.length < 2;
    const prev = S.last?.path === path ? r.sequences.findIndex(s => s.dir === S.last.dir && s.pattern === S.last.pattern) : -1;
    seqSel.value = String(Math.max(0, prev));
    seqSel.onchange = () => open(path, r.sequences[+seqSel.value]);
    await open(path, r.sequences[Math.max(0, prev)]);
  }
  async function open(path, seq) {
    const same = S.last && S.last.dir === seq.dir && S.last.pattern === seq.pattern;
    src = { path: seq.dir, pattern: seq.pattern };
    clear(right).append(loading("OVITO reads the trajectory…"));
    try {
      info = await api.job("/api/ovito/info", { method: "POST", data: { ...src, frame: 0 } });
    } catch (e) { clear(right).append(errorState(e)); return; }
    if (!same) { S.frame = 0; S.types = {}; }
    S.last = { path, dir: seq.dir, pattern: seq.pattern };
    S.recent = [path, ...S.recent.filter(p => p !== path)].slice(0, 8);
    for (const t of info.types) if (!S.types[t.id]) S.types[t.id] = { color: t.color, radius: t.radius || 0.5 };   // OVITO's own defaults
    S.frame = Math.min(S.frame, info.num_frames - 1);
    save();
    srcInfo.textContent = `OVITO: ${num(info.num_frames)} frames · ${num(info.count)} particles · ${info.properties.length} properties`;
    buildLeft();
    clear(right).append(el("div", { class: "state" }, el("b", {}, "Ready"), el("span", {}, "Set up the pipeline on the left and press Render with OVITO.")));
  }

  // ---------------------------------------------------------------------------------------------- left panel
  const T = tabs([{ id: "ovp", label: "Pipeline" }, { id: "ovv", label: "View & render" }, { id: "ovo", label: "Overlays" }]);
  function buildLeft() {
    clear(left).append(el("div", { class: "panel-body" }, T.bar, ...Object.values(T.panels),
      el("div", { class: "ov-actions" },
        el("button", { class: "btn primary", type: "button", onclick: renderNow }, "Render with OVITO"),
        el("button", { class: "btn", type: "button", onclick: showScript }, "Show script"),
        el("button", { class: "btn ghost", type: "button", onclick: () => download("nanocut-ovito-settings.json", JSON.stringify(S, null, 2), "application/json") }, "Save settings"),
        el("button", { class: "btn ghost", type: "button", onclick: () => fileIn.click() }, "Load settings"), fileIn)));
    buildPipeline(); buildView(); buildOverlays();
  }
  const fileIn = el("input", { type: "file", accept: ".json", hidden: true, onchange: async () => {
    const f = fileIn.files[0]; fileIn.value = ""; if (!f) return;
    try { const keep = { last: S.last, recent: S.recent }; Object.assign(S, load(JSON.parse(await f.text())), keep); save(); buildLeft(); toast("Settings loaded.", "ok"); }
    catch (e) { toast(`Not a settings file: ${e.message}`, "err"); }
  } });
  const propOptions = () => {
    const s = new Set(info ? info.properties.flatMap(p => p === "Position" ? ["Position.X", "Position.Y", "Position.Z"] : p === "Velocity" ? ["Velocity.X", "Velocity.Y", "Velocity.Z"] : p === "Force" ? ["Force.X", "Force.Y", "Force.Z"] : [p]) : []);
    for (const m of S.modifiers) if (m.enabled !== false) { (OUTPUTS[m.type] || []).forEach(x => s.add(x)); if (m.type === "compute_property" && m.output_property) s.add(m.output_property); }
    if (result) Object.keys(result.stats).forEach(k => s.add(k));
    return [...s];
  };
  const propList = el("datalist", { id: "ov-props" });
  function refreshProps() { clear(propList); propOptions().forEach(p => propList.append(el("option", { value: p }))); }

  function buildPipeline() {
    const p = T.panels.ovp; clear(p);
    refreshProps(); p.append(propList);
    p.append(sec("Frame", row("Frame", el("div", { class: "duo" },
      numIn(S.frame, v => { S.frame = Math.max(0, Math.min(info.num_frames - 1, Math.round(v || 0))); save(); buildPipeline(); }, { min: 0, max: info.num_frames - 1, step: 1 }),
      el("span", { class: "muted small" }, `0 … ${info.num_frames - 1}`)))));
    p.append(sec("Particle types (colour, radius)", el("table", { class: "data compact" }, el("tbody", {}, info.types.map(t => el("tr", {},
      el("td", {}, `Type ${t.id}${t.name ? ` (${t.name})` : ""}`),
      el("td", {}, colIn(S.types[t.id].color, v => { S.types[t.id].color = v; save(); }, `Colour of type ${t.id}`)),
      el("td", {}, numIn(S.types[t.id].radius, v => { S.types[t.id].radius = Math.max(0.01, v || 0.5); save(); }, { min: 0.01, step: 0.05, "aria-label": `Radius of type ${t.id}` })),
      el("td", { class: "num muted" }, num(t.count)))))),
      el("p", { class: "muted small" }, "Defaults are OVITO's own type colours; radius 0.5 Å is OVITO's default particle radius."),
      chk("Show simulation cell", S.cell, v => { S.cell = v; save(); })));
    const add = sel([["", "Add OVITO modifier…"], ...MODS], "", v => {
      if (!v) return;
      const m = { type: v, enabled: true };
      if (v === "select_type") m.types = [];
      if (v === "expression_selection") m.expression = "Position.Y > 0";
      if (v === "slice") Object.assign(m, { normal: [0, 0, 1], distance: 0, slab_width: 0, inverse: false, select: false });
      if (v === "displacements") Object.assign(m, { reference_frame: 0, minimum_image: true });
      if (v === "coordination") m.cutoff = 2.6;
      if (v === "dxa") m.lattice = "CubicDiamond";
      if (v === "compute_property") Object.assign(m, { output_property: "Height", expressions: ["Position.Y"], only_selected: false });
      if (v === "color_coding") Object.assign(m, { property: "Position.Y", gradient: "Rainbow", start: null, end: null, only_selected: false });
      if (v === "assign_color") m.color = "#35b6e0";
      S.modifiers.push(m); save(); buildPipeline();
    }, "Add OVITO modifier");
    const list = el("div", { class: "mods" });
    S.modifiers.forEach((m, k) => list.append(modCard(m, k)));
    p.append(sec("OVITO modifiers (applied top to bottom)", add, S.modifiers.length ? list : el("p", { class: "muted small" }, "None yet. Example: Select type (tool) → Delete selected → Displacement vectors → Color coding by Displacement.Y.")));
  }
  function modCard(m, k) {
    const upd = (key, v) => { m[key] = v; save(); };
    const move = d => () => { const j = k + d; if (j < 0 || j >= S.modifiers.length) return; [S.modifiers[k], S.modifiers[j]] = [S.modifiers[j], S.modifiers[k]]; save(); buildPipeline(); };
    const body = el("div", { class: "mod-body" });
    const propIn = (key, label) => row(label, el("input", { class: "input", type: "text", list: "ov-props", value: m[key] ?? "", onchange: e => upd(key, e.target.value.trim()) }));
    switch (m.type) {
      case "select_type": body.append(el("div", { class: "chips" }, info.types.map(t => el("button", { class: "chip", type: "button", "aria-pressed": m.types.includes(t.id),
        onclick: e => { m.types = m.types.includes(t.id) ? m.types.filter(x => x !== t.id) : [...m.types, t.id]; e.currentTarget.setAttribute("aria-pressed", m.types.includes(t.id)); save(); } },
        el("span", { class: "swatch", style: { background: S.types[t.id]?.color } }), `Type ${t.id}`, el("span", { class: "n" }, num(t.count)))))); break;
      case "expression_selection": body.append(row("Expression", txtIn(m.expression, v => upd("expression", v), { class: "input mono", placeholder: "Position.Y > 437.3" }))); break;
      case "slice": body.append(row("Normal (x y z)", el("div", { class: "trio" }, [0, 1, 2].map(i => numIn(m.normal[i], v => { m.normal[i] = v || 0; save(); }, { "aria-label": `Normal ${"xyz"[i]}` })))),
        row("Distance (Å)", numIn(m.distance, v => upd("distance", v || 0))), row("Slab width (Å)", numIn(m.slab_width, v => upd("slab_width", Math.abs(v || 0)), { min: 0 })),
        el("div", { class: "field-row" }, chk("Invert", m.inverse, v => upd("inverse", v)), chk("Select only", m.select, v => upd("select", v)))); break;
      case "displacements": body.append(row("Reference frame", numIn(m.reference_frame, v => upd("reference_frame", Math.max(0, Math.round(v || 0))), { min: 0, step: 1 })),
        chk("Minimum image convention", m.minimum_image !== false, v => upd("minimum_image", v))); break;
      case "coordination": body.append(row("Cutoff (Å)", numIn(m.cutoff, v => upd("cutoff", v || 2.6), { min: 0.1, step: 0.1 }))); break;
      case "dxa": body.append(row("Crystal lattice", sel(DXA, m.lattice, v => upd("lattice", v), "DXA lattice"))); break;
      case "compute_property": body.append(propIn("output_property", "Output property"),
        row("Expression(s)", txtIn((m.expressions || []).join(" ; "), v => upd("expressions", v.split(";").map(s => s.trim()).filter(Boolean)), { class: "input mono", placeholder: "Position.Y - 437.27" })),
        chk("Only selected", m.only_selected, v => upd("only_selected", v))); break;
      case "color_coding": body.append(propIn("property", "Property"), row("Gradient", sel(GRADIENTS, m.gradient, v => upd("gradient", v), "Gradient")),
        row("Start / end", el("div", { class: "duo" }, numIn(m.start, v => upd("start", v), { placeholder: "auto" }), numIn(m.end, v => upd("end", v), { placeholder: "auto" }))),
        chk("Only selected", m.only_selected, v => upd("only_selected", v)),
        result?.attributes?.["ColorCoding.RangeMin"] !== undefined ? el("p", { class: "muted small" }, `Last OVITO range: ${num(result.attributes["ColorCoding.RangeMin"], 5)} … ${num(result.attributes["ColorCoding.RangeMax"], 5)}`) : null); break;
      case "assign_color": body.append(row("Colour", colIn(m.color, v => upd("color", v), "Colour"))); break;
      default: break;
    }
    const card = el("div", { class: `mod-card${m.enabled === false ? " off" : ""}` },
      el("div", { class: "mod-head" },
        el("input", { type: "checkbox", checked: m.enabled !== false, "aria-label": `Enable ${MOD_LABEL[m.type]}`, onchange: e => { m.enabled = e.target.checked; card.classList.toggle("off", !m.enabled); save(); } }),
        el("span", { class: "name", "data-tip": MOD_HELP[m.type] }, MOD_LABEL[m.type]),
        el("button", { class: "btn ghost icon", type: "button", "aria-label": "Move up", disabled: k === 0, onclick: move(-1) }, "↑"),
        el("button", { class: "btn ghost icon", type: "button", "aria-label": "Move down", disabled: k === S.modifiers.length - 1, onclick: move(1) }, "↓"),
        el("button", { class: "btn ghost icon", type: "button", "aria-label": `Remove ${MOD_LABEL[m.type]}`, onclick: () => { S.modifiers.splice(k, 1); save(); buildPipeline(); } }, "✕")),
      el("p", { class: "mod-status" }, MOD_HELP[m.type] || ""));
    if (body.childNodes.length) card.append(body);
    return card;
  }
  function buildView() {
    const p = T.panels.ovv, V = S.view, R = S.render; clear(p);
    p.append(sec("Viewport (OVITO Viewport)",
      row("View", sel(VIEWS, V.type, v => { V.type = v; save(); buildView(); }, "Viewport type")),
      ["Ortho", "Perspective"].includes(V.type) ? row("Camera direction", el("div", { class: "trio" }, [0, 1, 2].map(i => numIn(V.camera_dir[i], v => { V.camera_dir[i] = v ?? 0; save(); }, { "aria-label": `Camera direction ${"xyz"[i]}` })))) : null,
      row("Zoom factor", numIn(V.zoom, v => { V.zoom = Math.max(0.05, v || 1); save(); }, { min: 0.05, step: 0.1 })),
      el("p", { class: "muted small" }, "OVITO's zoom_all fits the scene; the zoom factor then narrows the field of view. With NanoCut decks (surface normal y), Top shows the side view (x right, y up).")));
    p.append(sec("Image",
      row("Width / height (px)", el("div", { class: "duo" }, numIn(R.w, v => { R.w = Math.round(Math.max(64, Math.min(8000, v || 1600))); save(); }, { min: 64, max: 8000, step: 1 }),
        numIn(R.h, v => { R.h = Math.round(Math.max(64, Math.min(8000, v || 1000))); save(); }, { min: 64, max: 8000, step: 1 }))),
      row("Background", colIn(R.bg, v => { R.bg = v; save(); }, "Background")), chk("Transparent background", R.alpha, v => { R.alpha = v; save(); }),
      row("Renderer", sel([["opengl", "OpenGL (fast)"], ["tachyon", "Tachyon (ray-traced, publication)"]], R.renderer, v => { R.renderer = v; save(); buildView(); }, "Renderer")),
      R.renderer === "tachyon" ? el("div", { class: "grid1" }, row("Antialiasing samples", numIn(R.aa, v => { R.aa = Math.round(Math.max(1, Math.min(64, v || 12))); save(); }, { min: 1, max: 64, step: 1 })),
        el("div", { class: "field-row" }, chk("Ambient occlusion", R.ao, v => { R.ao = v; save(); }), chk("Shadows", R.shadows, v => { R.shadows = v; save(); })))
        : row("Antialiasing level", numIn(R.aa_gl, v => { R.aa_gl = Math.round(Math.max(1, Math.min(6, v || 3))); save(); }, { min: 1, max: 6, step: 1 }))));
  }
  function buildOverlays() {
    const p = T.panels.ovo, Lg = S.overlays.legend, Tr = S.overlays.tripod; clear(p);
    p.append(sec("Color legend (OVITO ColorLegendOverlay)",
      chk("Show (needs a Color coding modifier)", Lg.enabled, v => { Lg.enabled = v; save(); }),
      row("Position", sel(ALIGNS, Lg.align, v => { Lg.align = v; save(); }, "Legend position")),
      row("Orientation", sel([["vertical", "Vertical"], ["horizontal", "Horizontal"]], Lg.orientation, v => { Lg.orientation = v; save(); }, "Orientation")),
      row("Title", txtIn(Lg.title, v => { Lg.title = v; save(); }, { placeholder: "property name" })),
      row("Number format", txtIn(Lg.format, v => { Lg.format = v; save(); }, { class: "input mono" })),
      row("Size / text size", el("div", { class: "duo" }, numIn(Lg.size, v => { Lg.size = v || 0.3; save(); }, { step: 0.05 }), numIn(Lg.font_size, v => { Lg.font_size = v || 0.1; save(); }, { step: 0.01 }))),
      row("Offset x / y", el("div", { class: "duo" }, numIn(Lg.ox, v => { Lg.ox = v ?? 0; save(); }, { step: 0.01 }), numIn(Lg.oy, v => { Lg.oy = v ?? 0; save(); }, { step: 0.01 }))),
      row("Text colour", colIn(Lg.color, v => { Lg.color = v; save(); }, "Legend text colour"))));
    p.append(sec("Coordinate tripod (OVITO CoordinateTripodOverlay)",
      chk("Show", Tr.enabled, v => { Tr.enabled = v; save(); }),
      row("Position", sel(ALIGNS, Tr.align, v => { Tr.align = v; save(); }, "Tripod position")),
      row("Size", numIn(Tr.size, v => { Tr.size = v || 0.07; save(); }, { step: 0.01 })),
      row("Offset x / y", el("div", { class: "duo" }, numIn(Tr.ox, v => { Tr.ox = v ?? 0; save(); }, { step: 0.01 }), numIn(Tr.oy, v => { Tr.oy = v ?? 0; save(); }, { step: 0.01 })))));
    const labs = el("div", { class: "grid1" });
    S.overlays.labels.forEach((t, j) => labs.append(el("div", { class: "mod-card" }, el("div", { class: "mod-body" },
      row("Text", txtIn(t.text, v => { t.text = v; save(); })),
      row("Position", sel(ALIGNS, t.align, v => { t.align = v; save(); }, "Label position")),
      row("Size / colour", el("div", { class: "duo" }, numIn(t.font_size, v => { t.font_size = v || 0.06; save(); }, { step: 0.01 }), colIn(t.color, v => { t.color = v; save(); }, "Label colour"))),
      row("Offset x / y", el("div", { class: "duo" }, numIn(t.ox, v => { t.ox = v ?? 0; save(); }, { step: 0.01 }), numIn(t.oy, v => { t.oy = v ?? 0; save(); }, { step: 0.01 }))),
      el("button", { class: "btn ghost", type: "button", onclick: () => { S.overlays.labels.splice(j, 1); save(); buildOverlays(); } }, "Remove")))));
    p.append(sec("Text labels (OVITO TextLabelOverlay)", el("p", { class: "muted small" }, "OVITO replaces [Timestep] or any [attribute] with its value, e.g.  (a1)  or  Step [Timestep]  or  [ExpressionSelection.count] burr atoms."),
      labs, el("button", { class: "btn", type: "button", onclick: () => { S.overlays.labels.push({ text: "(a1)", align: "top-left", font_size: 0.06, color: "#000000", ox: 0, oy: 0 }); save(); buildOverlays(); } }, "+ Text label")));
  }

  // ---------------------------------------------------------------------------------------------- run
  const spec = () => ({ source: src, frame: S.frame, types: S.types, cell: S.cell, modifiers: S.modifiers, view: S.view, render: S.render, overlays: S.overlays });
  async function renderNow() {
    if (!src) { toast("Open a trajectory first.", "warn"); return; }
    const box = loading("OVITO is loading the frame, running the modifiers and rendering…", true);
    clear(right).append(box);
    const t0 = performance.now();
    try {
      result = await api.job("/api/ovito/render", { method: "POST", data: { spec: spec() }, onProgress: r => box.update(r), pollMs: 300 });
      result.wall = (performance.now() - t0) / 1000;
      showResult(); refreshProps(); buildPipeline();
    } catch (e) { clear(right).append(errorState(e)); }
  }
  async function showScript() {
    if (!src) { toast("Open a trajectory first.", "warn"); return; }
    try {
      const r = await api.post("/api/ovito/script", { spec: spec() });
      scriptModal(r.body.script);
    } catch (e) { toast(e.message, "err"); }
  }
  function scriptModal(text) {
    const close = () => back.remove();
    const back = el("div", { class: "modal-backdrop open", role: "dialog", "aria-modal": "true", "aria-label": "OVITO script", onclick: e => { if (e.target === back) close(); } },
      el("div", { class: "modal wide" }, el("div", { class: "panel-head" }, el("h3", {}, "OVITO Python script"), el("span", { class: "sub" }, "exactly what the OVITO worker runs (it reuses an already loaded file instead of import_file)"),
        el("div", { class: "actions" }, el("button", { class: "btn", type: "button", onclick: () => download("nanocut_ovito.py", text, "text/x-python") }, svg("download"), ".py"),
          el("button", { class: "btn", type: "button", onclick: async () => { try { await navigator.clipboard.writeText(text); toast("Script copied.", "ok"); } catch { toast("Clipboard not available.", "err"); } } }, svg("copy"), "Copy"),
          el("button", { class: "btn", type: "button", onclick: close }, "Close"))),
        el("pre", { class: "code code-pane" }, ...text.split("\n").map((l, i) => el("div", { class: "ln" }, el("i", {}, String(i + 1)), el("span", {}, l))))));
    document.body.append(back);
  }
  function showResult() {
    const r = result, url = api.apiUrl(`/api/ovito/file/${r.image}`);
    const attrs = Object.entries(r.attributes).filter(([k]) => k !== "SourceFrame");
    const RT = tabs([{ id: "ovr-attr", label: "OVITO attributes", count: attrs.length }, { id: "ovr-prop", label: "Particle properties", count: Object.keys(r.stats).length },
      { id: "ovr-exp", label: "Export data" }, { id: "ovr-ver", label: "Cross-check" }, { id: "ovr-scr", label: "Script" }]);
    RT.panels["ovr-attr"].append(el("div", { class: "table-wrap ov-table" }, el("table", { class: "data compact" },
      el("thead", {}, el("tr", {}, el("th", {}, "Attribute (computed by OVITO)"), el("th", { class: "num" }, "Value"))),
      el("tbody", {}, attrs.map(([k, v]) => el("tr", {}, el("td", { class: "mono" }, k), el("td", { class: "num" }, typeof v === "number" ? num(v, 6) : String(v))))))));
    RT.panels["ovr-prop"].append(el("div", { class: "table-wrap ov-table" }, el("table", { class: "data compact" },
      el("thead", {}, el("tr", {}, el("th", {}, "Property"), el("th", { class: "num" }, "Min"), el("th", { class: "num" }, "Max"), el("th", { class: "num" }, "Mean"))),
      el("tbody", {}, Object.entries(r.stats).map(([k, [lo, hi, mean]]) => el("tr", {}, el("td", { class: "mono" }, k), el("td", { class: "num" }, num(lo, 5)), el("td", { class: "num" }, num(hi, 5)), el("td", { class: "num" }, num(mean, 5))))))),
      el("p", { class: "muted small" }, `${num(r.count)} particles after the pipeline (frame ${S.frame}). Statistics computed with NumPy on the arrays OVITO produced.`));
    buildExport(RT.panels["ovr-exp"]);
    buildVerify(RT.panels["ovr-ver"]);
    RT.panels["ovr-scr"].append(el("div", { class: "field-row", style: { marginBottom: "8px" } }, el("button", { class: "btn", type: "button", onclick: () => download("nanocut_ovito.py", r.script.replace(r.image, "nanocut_ovito.png"), "text/x-python") }, svg("download"), "Download .py")),
      el("pre", { class: "code code-pane" }, ...r.script.split("\n").map((l, i) => el("div", { class: "ln" }, el("i", {}, String(i + 1)), el("span", {}, l)))));
    clear(right).append(
      el("div", { class: "panel" }, el("div", { class: "panel-head" }, el("h3", {}, "Rendered by OVITO"),
        el("span", { class: "sub" }, `frame ${S.frame} · step ${num(r.attributes.Timestep)} · ${S.render.w} × ${S.render.h} px · ${bytes(r.bytes)} · OVITO ${r.seconds} s`),
        el("div", { class: "actions" }, el("a", { class: "btn primary", href: url, download: `${(src.pattern || "ovito").replace(/\*.*$/, "").replace(/[^\w.-]+/g, "_").replace(/[._]+$/, "")}_frame${S.frame}_ovito.png` }, svg("download"), "PNG"))),
        el("div", { class: "panel-body ov-img" }, el("img", { src: url, alt: `OVITO rendering of frame ${S.frame}` }))),
      el("div", { class: "panel" }, el("div", { class: "panel-body" }, RT.bar, ...Object.values(RT.panels))));
  }
  function buildExport(p) {
    const cols = new Set(["Particle Identifier", "Particle Type", "Position.X", "Position.Y", "Position.Z"]);
    let fmt = "lammps/dump";
    const opts = Object.keys(result.stats);
    const listBox = el("div", { class: "chips" }, opts.map(c => el("button", { class: "chip", type: "button", "aria-pressed": cols.has(c),
      onclick: e => { cols.has(c) ? cols.delete(c) : cols.add(c); e.currentTarget.setAttribute("aria-pressed", cols.has(c)); } }, c)));
    const res = el("div", {});
    p.append(el("p", { class: "muted small" }, "OVITO writes the particles after the pipeline (e.g. with displacements, structure types) with its own exporter (ovito.io.export_file). The file goes to a temporary folder and is downloaded by your browser."),
      row("Format", sel([["lammps/dump", "LAMMPS dump"], ["xyz", "XYZ"], ["lammps/data", "LAMMPS data"], ["vasp", "POSCAR"]], fmt, v => { fmt = v; }, "Export format")),
      el("div", { class: "muted small" }, "Columns (LAMMPS dump / XYZ):"), listBox,
      el("button", { class: "btn", type: "button", onclick: async () => {
        clear(res).append(loading("OVITO exports…"));
        try {
          const r = await api.job("/api/ovito/export", { method: "POST", data: { spec: spec(), format: fmt, columns: [...cols] }, pollMs: 300 });
          clear(res).append(el("a", { class: "btn primary", href: api.apiUrl(`/api/ovito/file/${r.file}`), download: r.file }, svg("download"), `${r.file} (${bytes(r.bytes)})`));
        } catch (e) { clear(res).append(errorState(e)); }
      } }, "Export with OVITO"), res);
  }
  function buildVerify(p) {
    let frame = S.frame, ref = 0;
    const res = el("div", {});
    p.append(el("p", { class: "muted small" }, "Compares OVITO with NanoCut's own dump reader (used by the Studio) for the same frame: atom ids, positions, and displacements relative to the reference frame (OVITO's Displacement vectors vs NanoCut's). Differences around 1e-5 Å are float32 storage rounding."),
      row("Frame / reference", el("div", { class: "duo" }, numIn(frame, v => { frame = Math.max(0, Math.round(v || 0)); }, { min: 0, step: 1 }), numIn(ref, v => { ref = Math.max(0, Math.round(v || 0)); }, { min: 0, step: 1 }))),
      el("button", { class: "btn", type: "button", onclick: async () => {
        clear(res).append(loading("OVITO and NanoCut read the frames…"));
        try {
          const r = await api.job("/api/ovito/verify", { method: "POST", data: { ...src, frame, reference: ref }, pollMs: 300 });
          const maxd = Math.max(...["x", "y", "z"].map(a => r[`max_diff_position_${a}_A`] ?? Infinity), ...["dx", "dy", "dz"].map(a => r[`max_diff_${a}_A`] ?? Infinity));
          const ok = r.same_atom_ids && r.step_ovito === r.step_nanocut && maxd < 1e-3;
          clear(res).append(el("div", { class: `banner ${ok ? "" : "err"}` }, el("b", {}, ok ? "Agree. " : "Differ. "), ok ? `Largest difference ${maxd.toExponential(2)} Å.` : "See the table."),
            el("table", { class: "data compact" }, el("tbody", {}, Object.entries(r).map(([k, v]) => el("tr", {}, el("td", { class: "mono" }, k), el("td", { class: "num" }, Array.isArray(v) ? v.map(x => num(x, 5)).join(" … ") : typeof v === "number" ? (Math.abs(v) < 1e-3 && v !== 0 ? v.toExponential(2) : num(v, 6)) : String(v)))))));
        } catch (e) { clear(res).append(errorState(e)); }
      } }, "Run cross-check"), res);
  }

  if (S.last?.path) { pathIn.value = S.last.path; scan(S.last.path); }
  else clear(right).append(el("div", { class: "state" }, el("b", {}, "Open a trajectory"), el("span", {}, "Paste a folder or dump file above and press Open. OVITO reads it directly.")));
}
