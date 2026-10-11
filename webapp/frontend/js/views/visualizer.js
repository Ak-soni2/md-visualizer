// Molecular-dynamics visualizer. Three clearly labelled data sources:
//   trajectory - LAMMPS dump frames of a run (simulation output), loaded one frame at a time
//   initial    - the configuration NanoCut computes from the parameters (what deck A will build; not output)
//   schematic  - kinematic MOCK of the cut (illustration only)
import * as api from "../api.js";
import { el, clear, num, bytes, loading, empty, errorState, svg, toast } from "../ui.js";
import { overview, enc } from "../data.js";
import { AtomViewer } from "../viewer.js";
import { MAPS, cssGradient, LAYERS, typeLegend, coordLegend, LASER, MOCK_KIND, hex } from "../colormaps.js";

const PROP_INFO = {
  type: ["Atom type", "", "cat"], mol: ["Layer (mol tag)", "", "cat"], temperature: ["Local temperature", "K", "seq"],
  coordination: ["Coordination number", "", "cat"], von_mises: ["von Mises stress", "GPa", "seq"], hydrostatic: ["Hydrostatic stress", "GPa", "div"],
  pe: ["Potential energy", "eV", "seq"], speed: ["Speed |v|", "Å/ps", "seq"], in_laser: ["In laser zone", "", "cat"],
  kind: ["Region (schematic)", "", "cat"], hot: ["Illustrative heat (schematic)", "", "seq"],
};
const MAP_OF = { seq: "inferno", div: "diverging" };

export async function render(root, { sim, navigate }) {
  if (!sim) { root.append(empty("No simulation selected", "Pick one in the top bar.")); return; }
  const S = {
    source: sim.n_frames ? "trajectory" : "initial", frames: [], index: 0, cache: new Map(), playing: false, fps: 2,
    color: sim.n_frames ? "temperature" : "mol", range: "auto", cmin: 0, cmax: 1, layers: new Set([1, 2, 3, 4, 5, 6]), hiddenTypes: new Set(),
    maxAtoms: 60000, slab: false, zlo: 0, zhi: 5, payload: null, types: null, ov: null, initial: null, schematic: null, alive: true,
  };

  // ---------------------------------------------------------------- layout
  const left = el("aside", { class: "viz-left", "aria-label": "Visualization settings" });
  const stage = el("div", { class: "stage" });
  const canvas = el("canvas", { "aria-label": "Atom viewport. Drag to rotate, shift-drag to pan, wheel to zoom, double-click to fit." });
  const hudTL = el("div", { class: "hud tl" }), hudTR = el("div", { class: "hud tr" }), hudBL = el("div", { class: "hud bl" });
  const stageState = el("div", { class: "state" }, el("div", { class: "spinner" }), el("b", {}, "Loading…"));
  stage.append(canvas, hudTL, hudTR, hudBL, stageState);
  const timeline = el("div", { class: "timeline", role: "group", "aria-label": "Playback" });
  const right = el("aside", { class: "viz-right", "aria-label": "Frame information" });
  root.append(el("div", { class: "viz" }, left, stage, timeline, right));

  const viewer = new AtomViewer(canvas);

  // view buttons
  const viewBtns = el("div", { class: "btn-group", role: "group", "aria-label": "Camera" },
    ...[["front", "Front x–y"], ["top", "Top x–z"], ["side", "Side z–y"], ["iso", "Iso"]].map(([v, l]) =>
      el("button", { class: "btn", "aria-pressed": String(v === "front"), "data-v": v, onclick: e => { viewer.setView(v); viewBtns.querySelectorAll(".btn").forEach(b => b.setAttribute("aria-pressed", String(b === e.currentTarget))); } }, l)));
  hudTR.append(viewBtns, el("button", { class: "btn", onclick: () => viewer.fit(), "data-tip": "Fit view (double-click viewport)" }, "Fit"));

  // ---------------------------------------------------------------- left panel
  const section = (title, body, open = true) => el("details", { class: "viz-section", open }, el("summary", {}, el("span", { class: "chev", html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="11" height="11"><path d="M9 6l6 6-6 6"/></svg>' }), title), el("div", { class: "body" }, body));
  const srcBox = el("div", { role: "radiogroup", "aria-label": "Data source" });
  const srcDefs = [
    ["trajectory", "Trajectory", "LAMMPS dump frames (simulation output)"],
    ["initial", "Initial configuration", "computed by NanoCut from the parameters, not output"],
    ["schematic", "Schematic (mock)", "kinematic illustration of the cut"],
  ];
  srcDefs.forEach(([k, l, d]) => {
    const dis = k === "trajectory" && !sim.n_frames;
    srcBox.append(el("label", { class: "check", style: { alignItems: "flex-start" }, "data-tip": dis ? "This simulation has no dump files." : d },
      el("input", { type: "radio", name: "src", value: k, checked: S.source === k, disabled: dis, onchange: () => setSource(k) }),
      el("span", {}, l, el("br"), el("span", { class: "muted", style: { fontSize: "11px" } }, dis ? "no dump files here" : d))));
  });
  const colorSel = el("select", { class: "select", "aria-label": "Colour atoms by" });
  const rangeSel = el("select", { class: "select", "aria-label": "Colour range" },
    el("option", { value: "auto" }, "Auto (1st–99th percentile)"), el("option", { value: "full" }, "Full data range"), el("option", { value: "custom" }, "Custom"));
  const cmin = el("input", { class: "input num", type: "number", step: "any", "aria-label": "Colour minimum", disabled: true, style: { width: "100%" } });
  const cmax = el("input", { class: "input num", type: "number", step: "any", "aria-label": "Colour maximum", disabled: true, style: { width: "100%" } });
  const layerBox = el("div", {});
  const typeBox = el("div", {});
  const maxSel = el("select", { class: "select", "aria-label": "Atoms drawn" }, ...[20000, 60000, 120000, 250000, 400000].map(n => el("option", { value: n, selected: n === S.maxAtoms }, `${num(n)} atoms max`)));
  const slabChk = el("input", { type: "checkbox" });
  const zlo = el("input", { class: "input num", type: "number", step: "0.5", value: 0, "aria-label": "Section z minimum (Å)", style: { width: "100%" } });
  const zhi = el("input", { class: "input num", type: "number", step: "0.5", value: 5, "aria-label": "Section z maximum (Å)", style: { width: "100%" } });
  const ovl = {};
  const ovlBox = el("div", {}, ...[["surface", "Undeformed surface line", true], ["laser", "Laser zone", true], ["outline", "Tool outline (initial geometry)", true], ["depthLine", "Depth-of-cut line", true], ["axes", "Axes triad", true], ["scale", "Scale bar", true]].map(([k, l, on]) => {
    const c = el("input", { type: "checkbox", checked: on, onchange: () => viewer.setOptions({ [k]: c.checked }) }); ovl[k] = c;
    return el("label", { class: "check" }, c, l);
  }));
  const ptSize = el("input", { type: "range", min: "0.3", max: "3", step: "0.1", value: "1", "aria-label": "Atom size", oninput: () => viewer.setOptions({ pointScale: +ptSize.value }) });

  left.append(
    section("Data source", srcBox),
    section("Colour", el("div", { style: { display: "grid", gap: "8px" } },
      el("label", { class: "field" }, el("span", {}, "Colour by"), colorSel),
      el("label", { class: "field" }, el("span", {}, "Range"), rangeSel),
      el("div", { class: "field-row" }, cmin, cmax))),
    section("Atoms shown", el("div", {}, el("h4", { style: { margin: "0 0 4px" } }, "Layers"), layerBox, el("h4", { style: { margin: "10px 0 4px" } }, "Types"), typeBox)),
    section("Sampling", el("div", { style: { display: "grid", gap: "8px" } }, maxSel,
      el("label", { class: "check", "data-tip": "Show only atoms with z inside the range: a thin cross-section, like an OVITO slice." }, slabChk, "Thin z-section (slice)"),
      el("div", { class: "field-row" }, zlo, zhi),
      el("span", { class: "muted", style: { fontSize: "11px" } }, "Sub-sampling keeps the same atom ids in every frame."))),
    section("Overlays", ovlBox, false),
    section("Appearance", el("label", { class: "field" }, el("span", {}, "Atom size"), ptSize), false));

  // ---------------------------------------------------------------- right panel
  const frameInfo = el("dl", { class: "kv" });
  const statsBox = el("div", {});
  const hoverBox = el("div", { class: "hover-readout", "aria-live": "off" }, el("span", { class: "muted" }, "Hover an atom"));
  const ctxBox = el("dl", { class: "kv" });
  const rsec = (t, b) => el("section", { class: "viz-section", style: { padding: "0 12px 12px" } }, el("h4", { style: { padding: "12px 0 8px" } }, t), b);
  right.append(rsec("Frame", frameInfo), rsec("Colour statistics", statsBox), rsec("Atom under cursor", hoverBox), rsec("Context", ctxBox));

  // ---------------------------------------------------------------- timeline
  const bFirst = el("button", { class: "btn icon", "aria-label": "First frame" }, svg("first"));
  const bPrev = el("button", { class: "btn icon", "aria-label": "Previous frame (,)" }, svg("prev"));
  const bPlay = el("button", { class: "btn icon primary", "aria-label": "Play (Space)" }, svg("play"));
  const bNext = el("button", { class: "btn icon", "aria-label": "Next frame (.)" }, svg("next"));
  const bLast = el("button", { class: "btn icon", "aria-label": "Last frame" }, svg("last"));
  const slider = el("input", { type: "range", min: 0, max: 0, value: 0, step: 1, "aria-label": "Frame" });
  const speed = el("select", { class: "select", "aria-label": "Playback speed" }, ...[0.5, 1, 2, 4, 8].map(f => el("option", { value: f, selected: f === S.fps }, `${f} fps`)));
  const readout = el("div", { class: "readout", "aria-live": "polite" }, "—");
  timeline.append(bFirst, bPrev, bPlay, bNext, bLast, slider, speed, readout);
  bFirst.onclick = () => goto(0); bLast.onclick = () => goto(nFrames() - 1);
  bPrev.onclick = () => goto(S.index - 1); bNext.onclick = () => goto(S.index + 1);
  bPlay.onclick = () => (S.playing ? stop() : play());
  slider.oninput = () => goto(+slider.value);
  speed.onchange = () => (S.fps = +speed.value);

  // ---------------------------------------------------------------- context
  try {
    S.ov = await overview(sim.id);
    const e = S.ov.experiment, m = S.ov.model;
    S.types = m?.types || null;
    if (S.ov.trajectory?.frames === undefined && sim.n_frames) { /* filled by trajectory call */ }
    const rows = e ? [["material", e.workpiece.material], ["potential", e.potential.key], ["depth of cut", `${num(e.process.depth_nm)} nm`], ["speed", `${num(e.process.speed_ms)} m/s`],
      ["tool", `${e.tool.shape}, ${e.tool.shape === "sphere" ? e.tool.sphere_radius_nm : e.tool.edge_radius_nm} nm`], ["laser", e.laser.mode]] : [["parameters", "none"]];
    rows.forEach(([k, v]) => ctxBox.append(el("dt", {}, k), el("dd", {}, v)));
  } catch (e) { ctxBox.append(el("dd", { class: "na" }, e.message)); }

  // ---------------------------------------------------------------- data sources
  const nFrames = () => S.source === "trajectory" ? S.frames.length : S.source === "schematic" ? (S.schematic?.frames.length || 0) : 1;
  function showState(node) { clear(stageState).append(...(node ? [node] : [])); stageState.style.display = node ? "" : "none"; }

  async function setSource(k) {
    stop(); S.source = k; S.index = 0;
    srcBox.querySelectorAll("input").forEach(i => (i.checked = i.value === k));
    const props = k === "trajectory" ? (S.ov?.trajectory?.available_properties || ["type"]) : k === "initial" ? ["type", "mol"] : ["kind", "hot"];
    fillColorSel(props, k === "trajectory" ? (props.includes(S.color) ? S.color : (props.includes("temperature") ? "temperature" : "mol")) : (k === "initial" ? "mol" : "kind"));
    try {
      if (k === "trajectory") {
        showState(loading("Listing frames…"));
        const tr = await api.get(`/api/simulations/${enc(sim.id)}/trajectory`);
        S.frames = tr.frames;
        if (!S.frames.length) { showState(empty("No dump frames", "Choose the initial configuration or the schematic.")); return; }
      } else if (k === "initial") {
        const st = loading("Computing the initial configuration (lattice enumeration)…", true); showState(st);
        S.initial = await api.job(`/api/simulations/${enc(sim.id)}/initial?max_atoms=${S.maxAtoms}`, { onProgress: r => st.update(r) });
      } else {
        const st = loading("Building the schematic animation…", true); showState(st);
        S.schematic = await api.job(`/api/simulations/${enc(sim.id)}/schematic?frames=24&max_atoms=6000`, { onProgress: r => st.update(r) });
      }
      slider.max = Math.max(0, nFrames() - 1); slider.value = 0;
      [bFirst, bPrev, bPlay, bNext, bLast, slider, speed].forEach(b => (b.disabled = nFrames() <= 1));
      await draw(true);
    } catch (e) { showState(errorState(e, () => setSource(k))); }
  }

  function fillColorSel(props, chosen) {
    clear(colorSel);
    props.forEach(p => colorSel.append(el("option", { value: p }, `${PROP_INFO[p]?.[0] || p}${PROP_INFO[p]?.[1] ? ` (${PROP_INFO[p][1]})` : ""}`)));
    S.color = chosen; colorSel.value = chosen;
  }
  colorSel.onchange = () => { S.color = colorSel.value; S.range = "auto"; rangeSel.value = "auto"; cmin.disabled = cmax.disabled = true; draw(false); };
  rangeSel.onchange = () => { S.range = rangeSel.value; cmin.disabled = cmax.disabled = S.range !== "custom"; recolor(); };
  [cmin, cmax].forEach(i => (i.onchange = () => { S.cmin = +cmin.value; S.cmax = +cmax.value; recolor(); }));
  maxSel.onchange = () => { S.maxAtoms = +maxSel.value; S.cache.clear(); if (S.source === "initial") setSource("initial"); else draw(false); };
  slabChk.onchange = () => { S.slab = slabChk.checked; S.cache.clear(); draw(false); };
  [zlo, zhi].forEach(i => (i.onchange = () => { S.zlo = +zlo.value; S.zhi = +zhi.value; if (S.slab) { S.cache.clear(); draw(false); } }));

  async function frameData(i) {
    if (S.source === "trajectory") {
      const props = [...new Set(["mol", S.color])].join(",");
      const key = `${i}|${props}|${S.maxAtoms}|${S.slab ? S.zlo + "," + S.zhi : ""}`;
      if (!S.cache.has(key)) {
        const q = `/api/simulations/${enc(sim.id)}/frames/${i}?props=${props}&max_atoms=${S.maxAtoms}${S.slab ? `&slab=${S.zlo},${S.zhi}` : ""}`;
        S.cache.set(key, api.get(q));
        if (S.cache.size > 8) S.cache.delete(S.cache.keys().next().value);
      }
      return S.cache.get(key);
    }
    if (S.source === "initial") {
      const d = S.initial;
      return d;
    }
    const f = S.schematic.frames[i], meta = S.schematic.meta;
    return { x: f.x, y: f.y, z: f.x.map(() => 0), props: { kind: f.kind, hot: f.hot }, natoms: f.x.length, shown: f.x.length, available: ["kind", "hot"],
      travel_A: f.travel_A, overlays: { y_surface: meta.y_surface, tool_outline: S.schematic.outlines[i], laser: meta.laser ? { x: meta.laser[0][0] - f.travel_A, y: meta.laser[0][1], r: meta.laser[1] } : null, depth_line: meta.y_cut } };
  }

  let drawToken = 0;
  async function draw(refit) {
    const token = ++drawToken;
    if (S.source === "trajectory" && !S.payload) showState(loading(`Loading frame ${S.index + 1}…`));
    let d;
    try { d = await frameData(S.index); } catch (e) { showState(errorState(e, () => draw(refit))); return; }
    if (token !== drawToken || !S.alive) return;
    showState(null);
    S.payload = d;
    if (S.source === "trajectory" && d.available) {
      const want = d.available; if ([...colorSel.options].map(o => o.value).join() !== want.join()) fillColorSel(want, want.includes(S.color) ? S.color : "mol");
    }
    buildFilters(d);
    const vis = visibility(d);
    viewer.setAtoms({ x: d.x, y: d.y, z: d.z, rgb: colors(d), visible: vis }, { keepView: !refit });
    const o = d.overlays || {};
    viewer.setOverlays({ ySurface: o.y_surface, laser: o.laser, outline: o.tool_outline, depthLine: o.depth_line });
    if (refit) { viewer.setView("front"); viewBtns.querySelectorAll(".btn").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.v === "front"))); }
    updateHUD(d); updateInfo(d);
    if (S.source === "trajectory" && S.index + 1 < S.frames.length) frameData(S.index + 1).catch(() => {});   // prefetch
  }

  function values(d) {
    if (S.color === "type") return d.props.type;
    return d.props[S.color] || null;
  }
  function legendFor(prop) {
    if (prop === "mol") return LAYERS;
    if (prop === "type") return typeLegend(S.types || d0types());
    if (prop === "coordination") return coordLegend();
    if (prop === "in_laser") return LASER;
    if (prop === "kind") return MOCK_KIND;
    return null;
  }
  const d0types = () => (S.payload?.overlays?.types) || null;
  function range(d, v) {
    const info = PROP_INFO[S.color] || [];
    const st = d.stats?.[S.color];
    let lo, hi;
    if (S.range === "custom") { lo = S.cmin; hi = S.cmax; }
    else if (st && S.range === "auto") { lo = st.p01; hi = st.p99; }
    else if (st) { lo = st.min; hi = st.max; }
    else { lo = Infinity; hi = -Infinity; for (const x of v) { if (x < lo) lo = x; if (x > hi) hi = x; } }
    if (info[2] === "div") { const a = Math.max(Math.abs(lo), Math.abs(hi)); lo = -a; hi = a; }
    if (!(hi > lo)) hi = lo + 1;
    if (S.range !== "custom") { cmin.value = +lo.toPrecision(4); cmax.value = +hi.toPrecision(4); }
    return [lo, hi];
  }
  function colors(d) {
    const n = d.x.length, rgb = new Uint8ClampedArray(n * 3), v = values(d);
    const leg = legendFor(S.color);
    if (!v) { rgb.fill(150); return rgb; }
    if (leg) {
      const cache = {};
      for (let i = 0; i < n; i++) {
        let k = Math.round(v[i]); if (S.color === "coordination") k = Math.min(8, Math.max(0, k));
        const c = cache[k] ??= hex(leg[k]?.color || "#9a9a9a");
        rgb[i * 3] = c[0]; rgb[i * 3 + 1] = c[1]; rgb[i * 3 + 2] = c[2];
      }
    } else {
      const [lo, hi] = range(d, v), lut = MAPS[MAP_OF[PROP_INFO[S.color]?.[2]] || "inferno"], span = hi - lo;
      for (let i = 0; i < n; i++) {
        const t = Math.max(0, Math.min(255, Math.round(((v[i] - lo) / span) * 255))) * 3;
        rgb[i * 3] = lut[t]; rgb[i * 3 + 1] = lut[t + 1]; rgb[i * 3 + 2] = lut[t + 2];
      }
    }
    return rgb;
  }
  function recolor() { if (S.payload) { viewer.setColors(colors(S.payload)); updateHUD(S.payload); } }

  function buildFilters(d) {
    const mols = d.props.mol ? [...new Set(d.props.mol)].sort() : [];
    const types = d.props.type ? [...new Set(d.props.type)].sort() : [];
    const key = mols.join() + "|" + types.join();
    if (layerBox.dataset.key === key) return;
    layerBox.dataset.key = key;
    clear(layerBox); clear(typeBox);
    if (!mols.length) layerBox.append(el("span", { class: "muted" }, "no layer tags in this data"));
    mols.forEach(m => {
      const c = el("input", { type: "checkbox", checked: S.layers.has(m), onchange: () => { c.checked ? S.layers.add(m) : S.layers.delete(m); viewer.setVisible(visibility(S.payload)); } });
      layerBox.append(el("label", { class: "check" }, c, el("span", { class: "swatch", style: { background: LAYERS[m]?.color } }), LAYERS[m]?.name || `mol ${m}`));
    });
    const tl = typeLegend(S.types || d0types());
    if (!types.length) typeBox.append(el("span", { class: "muted" }, "—"));
    types.forEach(t => {
      const c = el("input", { type: "checkbox", checked: !S.hiddenTypes.has(t), onchange: () => { c.checked ? S.hiddenTypes.delete(t) : S.hiddenTypes.add(t); viewer.setVisible(visibility(S.payload)); } });
      typeBox.append(el("label", { class: "check" }, c, el("span", { class: "swatch", style: { background: tl[t]?.color } }), tl[t]?.name || `type ${t}`));
    });
  }
  function visibility(d) {
    const n = d.x.length, vis = new Uint8Array(n);
    const mol = d.props.mol, typ = d.props.type;
    for (let i = 0; i < n; i++) vis[i] = (!mol || S.layers.has(mol[i])) && (!typ || !S.hiddenTypes.has(typ[i])) ? 1 : 0;
    return vis;
  }

  function updateHUD(d) {
    const src = S.source;
    const badge = src === "trajectory" ? el("span", { class: "badge original" }, "Simulation output") : src === "initial" ? el("span", { class: "badge" }, "Computed · not output") : el("span", { class: "badge mock" }, "Mock · schematic");
    const sub = src === "trajectory" ? `step ${num(d.step)} · ${num(d.shown)} of ${num(d.natoms)} atoms · ${d.file}` :
      src === "initial" ? `${num(d.shown)} of ${num(d.natoms)} atoms (every ${d.stride}${d.stride > 1 ? "th" : ""}) · what deck A builds` :
        `tool travel ${num(d.travel_A / 10)} nm · illustrative chip, shear plane φ = ${num(S.schematic.meta.shear_angle_deg, 3)}°`;
    clear(hudTL).append(el("div", { class: "src" }, badge, el("span", {}, sim.label)), el("div", { class: "src-sub" }, sub));
    if (src === "initial" && d.consistency && !d.consistency.matches) hudTL.append(el("div", { class: "banner warn", style: { pointerEvents: "auto", maxWidth: "520px", marginTop: "6px" } }, d.consistency.note));
    if (src === "schematic") hudTL.append(el("div", { class: "banner mock", style: { maxWidth: "520px", marginTop: "6px" } }, el("b", {}, "Not a simulation. "), "Chip shape, damaged band and heat are illustrative; use the trajectory or a real run for any number."));
    // legend / colour bar
    clear(hudBL);
    const leg = legendFor(S.color);
    const box = el("div", { class: "colorbar" }, el("div", { class: "t" }, `${PROP_INFO[S.color]?.[0] || S.color}${PROP_INFO[S.color]?.[1] ? ` (${PROP_INFO[S.color][1]})` : ""}`));
    if (leg) {
      const v = values(d) || [], present = new Set(v.map(x => S.color === "coordination" ? Math.min(8, Math.max(0, Math.round(x))) : Math.round(x)));
      const g = el("div", { class: "legend-cats" });
      Object.entries(leg).filter(([k]) => present.has(+k)).forEach(([k, o]) => g.append(el("span", {}, el("span", { class: "swatch", style: { background: o.color } }), o.name)));
      box.append(g);
    } else if (values(d)) {
      const [lo, hi] = range(d, values(d));
      const bar = el("div", { style: { height: "8px", borderRadius: "2px", background: cssGradient(MAP_OF[PROP_INFO[S.color]?.[2]] || "inferno") } });
      box.append(bar, el("div", { class: "ticks" }, el("span", {}, num(lo, 3)), el("span", {}, num((lo + hi) / 2, 3)), el("span", {}, num(hi, 3))));
      if (S.color === "temperature") box.append(el("div", { class: "muted", style: { fontSize: "10.5px" } }, "T = 2⟨KE⟩/(3 k_B), per atom, time-averaged KE (f_keav)"));
    }
    hudBL.append(box);
  }

  function updateInfo(d) {
    clear(frameInfo);
    const rows = S.source === "trajectory" ? [["frame", `${S.index + 1} of ${S.frames.length}`], ["step", num(d.step)], ["time", d.time_ps !== undefined ? `${num(d.time_ps, 4)} ps` : "—"],
      ["cut distance", d.cut_distance_A !== undefined ? `${num(d.cut_distance_A / 10, 4)} nm` : "—"], ["atoms", `${num(d.shown)} shown of ${num(d.natoms)}`], ["file", d.file],
      ["size", bytes(S.frames[S.index]?.bytes)], ["box x", (d.box?.[0] || []).map(v => num(v, 2)).join(" … ")], ["box y", (d.box?.[1] || []).map(v => num(v, 2)).join(" … ")], ["box z", (d.box?.[2] || []).map(v => num(v, 3)).join(" … ")]]
      : S.source === "initial" ? [["source", "geometry.Model"], ["atoms", `${num(d.shown)} shown of ${num(d.natoms)}`], ["sampling", `every ${d.stride} atom(s)`]]
        : [["frame", `${S.index + 1} of ${S.schematic.frames.length}`], ["tool travel", `${num(d.travel_A / 10)} nm`], ["chip thickness", `${num(S.schematic.meta.chip_thickness_A / 10)} nm (assumed ratio)`]];
    rows.forEach(([k, v]) => frameInfo.append(el("dt", {}, k), el("dd", {}, v ?? "—")));
    clear(statsBox);
    const st = d.stats?.[S.color];
    if (st && !st.error) statsBox.append(el("dl", { class: "kv" }, ...[["min", st.min], ["mean", st.mean], ["max", st.max], ["1st pct", st.p01], ["99th pct", st.p99]].flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, num(v, 4), el("span", { class: "u" }, PROP_INFO[S.color]?.[1] || ""))])),
      el("p", { class: "muted", style: { fontSize: "11px", marginTop: "6px" } }, "over all atoms of the frame, before sub-sampling"));
    else if (st?.error) statsBox.append(el("span", { class: "muted" }, st.error));
    else statsBox.append(el("span", { class: "muted" }, "categorical or not available"));
    readout.textContent = S.source === "trajectory" ? `step ${num(d.step)} · ${d.time_ps !== undefined ? num(d.time_ps, 3) + " ps" : ""} · ${d.cut_distance_A !== undefined ? num(d.cut_distance_A / 10, 3) + " nm" : ""}` :
      S.source === "schematic" ? `mock · travel ${num(d.travel_A / 10)} nm` : "initial configuration";
    slider.value = S.index;
  }

  viewer.onHover = (i) => {
    const d = S.payload;
    if (!d || i < 0) { clear(hoverBox).append(el("span", { class: "muted" }, "Hover an atom")); return; }
    const tl = typeLegend(S.types || d0types());
    const rows = [["id", d.id ? d.id[i] : "—"], ["type", d.props.type ? (tl[d.props.type[i]]?.name || d.props.type[i]) : "—"], ["layer", d.props.mol ? (LAYERS[d.props.mol[i]]?.name || d.props.mol[i]) : "—"],
      ["x, y, z", `${num(d.x[i], 2)}, ${num(d.y[i], 2)}, ${num(d.z[i], 2)} Å`]];
    if (values(d) && !["mol", "type"].includes(S.color)) rows.push([PROP_INFO[S.color]?.[0] || S.color, `${num(values(d)[i], 4)} ${PROP_INFO[S.color]?.[1] || ""}`]);
    clear(hoverBox).append(el("dl", { class: "kv" }, ...rows.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)])));
  };

  // ---------------------------------------------------------------- playback
  async function goto(i) {
    const n = nFrames(); if (!n) return;
    S.index = Math.max(0, Math.min(n - 1, i));
    await draw(false);
  }
  async function play() {
    if (nFrames() <= 1) return;
    S.playing = true; bPlay.replaceChildren(svg("pause")); bPlay.setAttribute("aria-label", "Pause (Space)");
    while (S.playing && S.alive) {
      const t0 = performance.now();
      await goto(S.index + 1 >= nFrames() ? 0 : S.index + 1);
      const wait = 1000 / S.fps - (performance.now() - t0);
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
    }
  }
  function stop() { S.playing = false; bPlay.replaceChildren(svg("play")); bPlay.setAttribute("aria-label", "Play (Space)"); }
  const onKey = (e) => {
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) && document.activeElement.type !== "range") return;
    if (e.key === " " && document.activeElement?.tagName !== "BUTTON") { e.preventDefault(); S.playing ? stop() : play(); }
    if (e.key === ",") goto(S.index - 1);
    if (e.key === ".") goto(S.index + 1);
  };
  document.addEventListener("keydown", onKey);

  await setSource(S.source);
  return () => { S.alive = false; stop(); document.removeEventListener("keydown", onKey); viewer.destroy(); };
}
