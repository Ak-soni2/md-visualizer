// OVITO page, "Ductile–brittle" tab: indicators of ductile vs brittle material removal, frame by frame, all computed
// by OVITO in a zone around the tool (backend/ovito_worker.py, op_regime), and a regime per frame decided by explicit,
// adjustable criteria. Brittle evidence: enclosed voids, crack faces (free surfaces below the tool that are not the
// workpiece's outer faces), a chip broken into fragments, and optionally sudden drops of the cutting force. Ductile
// evidence (shown, not required): disordered (amorphised) material, a continuous chip, thrust/cutting force ratio.
import * as api from "../api.js";
import { el, clear, num, toast, loading, errorState, download } from "../ui.js";
import { LinePlot } from "../plot.js";
import { selectFrames } from "./ovito_frames.js";

export const dbtDefaults = () => ({
  tool_types: null, direction: "-x", ahead: 30, behind: 60, probe_radius: 3, crack_margin: 4, bottom_margin: 10, side_margin: 10,
  chip_threshold: 1, cluster_cutoff: 3, min_fragment: 20, void_min_volume: 30,
  crit: { deep: 20, voids: 1, fragments: 2, drop: 0.3, useDrop: false },
  sel: { mode: "interval", interval: 10, start: 0, end: null, step: 10, list: "" },
});
const HELP = {
  ahead: "Zone in front of the cutting edge along the cutting direction (Å).", behind: "Zone behind the cutting edge: the freshly machined surface (Å).",
  probe_radius: "Probe sphere of OVITO's surface mesh (Å). It must be smaller than the crack opening: a 3 Å probe finds a 3 Å slit, a 4 Å probe misses it. A perfect SiC crystal shows no false crack at 3 Å.",
  crack_margin: "A free surface counts as a crack face only this far below the tool's lowest atom (Å).",
  bottom_margin: "Free surfaces closer than this to the workpiece bottom are its outer face, not cracks (Å).",
  side_margin: "Free surfaces closer than this to the workpiece's x ends are its outer faces, not cracks (Å).",
  chip_threshold: "Workpiece atoms higher than the original surface plus this belong to the chip / pile-up (Å).",
  cluster_cutoff: "Neighbour distance that connects chip atoms into one piece (Å).", min_fragment: "Pieces smaller than this are debris, not fragments (atoms).",
  void_min_volume: "Enclosed empty regions smaller than this are ignored (Å³).",
};

/** regime of every analysed frame from the indicator rows and the criteria */
export function classify(rows, crit) {
  const out = new Map();
  let prev = null;
  for (const r of rows) {
    const why = [];
    if (r.voids >= crit.voids) why.push(`${r.voids} enclosed void${r.voids > 1 ? "s" : ""} (${num(r.void_volume, 0)} Å³)`);
    if (r.deep_surface_atoms >= crit.deep) why.push(`crack faces: ${num(r.deep_surface_atoms)} free-surface atoms below the tool`);
    if (r.chip_fragments >= crit.fragments) why.push(`chip in ${r.chip_fragments} fragments (${r.chip_sizes.join(", ")} atoms)`);
    let drop = null;
    if (prev?.force_cutting > 0 && r.force_cutting != null) drop = (prev.force_cutting - r.force_cutting) / prev.force_cutting;
    if (crit.useDrop && drop != null && drop >= crit.drop) why.push(`cutting force dropped ${(drop * 100).toFixed(0)} %`);
    out.set(r.frame, { regime: why.length ? "brittle" : "ductile", why, drop });
    prev = r;
  }
  return out;
}

/** p: tab panel; ctx: {S, save, info(), spec(), setRegime(map | null), showDamage()} */
export function buildDbtPanel(p, ctx) {
  const info = ctx.info();
  if (!info) { p.append(el("p", { class: "muted" }, "Open a trajectory first.")); return; }
  const D = ctx.S.dbt = { ...dbtDefaults(), ...(ctx.S.dbt || {}) };
  D.crit = { ...dbtDefaults().crit, ...(D.crit || {}) };
  D.sel = { ...dbtDefaults().sel, ...(D.sel || {}) };
  if (!D.tool_types) D.tool_types = info.types.some(t => t.id === 1) ? [1] : [info.types[0].id];
  const n = info.num_frames, save = ctx.save;
  const row = (label, c, tip) => el("label", { class: "frow", "data-tip": tip }, el("span", {}, label), el("div", { class: "fctl" }, c));
  const numIn = (obj, k, a = {}) => el("input", { class: "input num", type: "number", step: "any", value: obj[k] ?? "", onchange: e => { obj[k] = e.target.value === "" ? null : +e.target.value; save(); upd(); }, ...a });
  const summary = el("div", { class: "fx-summary" });
  const modeBox = el("div", {});
  function buildMode() {
    clear(modeBox);
    const S2 = D.sel;
    if (S2.mode === "interval") modeBox.append(row("Every n-th frame", numIn(S2, "interval", { min: 1, step: 1 })));
    else if (S2.mode === "range") modeBox.append(row("Start / end", el("div", { class: "duo" }, numIn(S2, "start", { min: 0, step: 1 }), numIn(S2, "end", { min: 0, step: 1, placeholder: `${n - 1}` }))), row("Step", numIn(S2, "step", { min: 1, step: 1 })));
    else modeBox.append(el("input", { class: "input mono", type: "text", value: S2.list, placeholder: "0, 50, 100-600:50", oninput: e => { S2.list = e.target.value; save(); upd(); } }));
  }
  let sel = { frames: [], errors: [] };
  function upd() {
    sel = selectFrames(D.sel, n);
    clear(summary).append(el("b", {}, `${num(sel.frames.length)} frames`), ...sel.errors.map(m => el("div", { class: "status error small" }, m)));
    btn.disabled = !!sel.errors.length || running || !D.tool_types.length;
  }
  let running = false, last = null;
  const btn = el("button", { class: "btn primary", type: "button", onclick: run }, "Analyse ductile / brittle");
  const status = el("div", {});
  p.append(
    el("section", { class: "st-sec" }, el("h4", {}, "What is measured"),
      el("p", { class: "muted small" }, "Per frame, in a zone around the cutting edge, OVITO measures: crack faces (free surfaces below the tool), enclosed voids, chip fragments, disordered (amorphised) atoms, subsurface damage depth, and the tool's cutting and thrust forces. A frame is brittle when any brittle criterion below is met, otherwise ductile; the transition is the first change. All indicators are shown, so the decision can be checked.")),
    el("section", { class: "st-sec" }, el("h4", {}, "Tool and zone"),
      row("Tool particle type(s)", el("div", { class: "chips" }, info.types.map(t => el("button", { class: "chip", type: "button", "aria-pressed": D.tool_types.includes(t.id),
        onclick: e => { D.tool_types = D.tool_types.includes(t.id) ? D.tool_types.filter(x => x !== t.id) : [...D.tool_types, t.id]; e.currentTarget.setAttribute("aria-pressed", D.tool_types.includes(t.id)); save(); upd(); } },
        `Type ${t.id}${t.name ? ` ${t.name}` : ""}`, el("span", { class: "n" }, num(t.count))))), "NanoCut decks: type 1 is the tool."),
      row("Tool moves towards", el("select", { class: "select", onchange: e => { D.direction = e.target.value; save(); } },
        [["-x", "−x (NanoCut)"], ["+x", "+x"]].map(([v, l]) => el("option", { value: v, selected: D.direction === v }, l))), "Cutting along x, surface normal y."),
      ...["ahead", "behind", "probe_radius", "crack_margin", "bottom_margin", "side_margin", "chip_threshold", "cluster_cutoff", "min_fragment", "void_min_volume"].map(k =>
        row(k.replace(/_/g, " "), numIn(D, k), HELP[k]))),
    el("section", { class: "st-sec" }, el("h4", {}, "Brittle criteria (any one makes a frame brittle)"),
      row("Crack-face atoms ≥", numIn(D.crit, "deep", { min: 1, step: 1 })), row("Enclosed voids ≥", numIn(D.crit, "voids", { min: 1, step: 1 })),
      row("Chip fragments ≥", numIn(D.crit, "fragments", { min: 2, step: 1 })),
      el("label", { class: "check" }, el("input", { type: "checkbox", checked: D.crit.useDrop, onchange: e => { D.crit.useDrop = e.target.checked; save(); } }), "Also: cutting force drop between analysed frames ≥"),
      row("Force drop (fraction)", numIn(D.crit, "drop", { min: 0, max: 1, step: 0.05 })),
      el("p", { class: "muted small" }, "Criteria only change the classification; the measured indicators stay the same. Changing them after an analysis re-classifies at once.")),
    el("section", { class: "st-sec" }, el("h4", {}, "Frames"),
      row("Mode", el("select", { class: "select", onchange: e => { D.sel.mode = e.target.value; save(); buildMode(); upd(); } },
        [["interval", "Every n-th frame"], ["range", "Range"], ["specific", "List"]].map(([v, l]) => el("option", { value: v, selected: D.sel.mode === v }, l)))),
      modeBox, summary, el("div", { class: "field-row" }, btn), status));
  buildMode(); upd();

  async function run() {
    if (running) return;
    running = true; upd();
    const token = Math.random().toString(16).slice(2);
    const box = loading(`OVITO analyses ${sel.frames.length} frames…`, true);
    let cancelled = false;
    clear(status).append(box, el("button", { class: "btn ghost", type: "button", onclick: () => { cancelled = true; api.post(`/api/ovito/frames/cancel/${token}`).catch(() => {}); } }, "Cancel"));
    const params = Object.fromEntries(Object.keys(dbtDefaults()).filter(k => !["crit", "sel"].includes(k)).map(k => [k, D[k]]));
    try {
      let rows = [], seconds = 0;
      const per = api.apiHosted() ? 3 : sel.frames.length;              // hosted: each request stays under 300 s
      for (let k = 0; k < sel.frames.length; k += per) {
        if (cancelled) throw new Error("cancelled");
        const r = await api.job("/api/ovito/regime", { method: "POST", pollMs: 400, onProgress: x => box.update(x), timeoutMs: 24 * 3600e3,
          data: { spec: ctx.spec(), frames: sel.frames.slice(k, k + per), params, token } });
        rows = rows.concat(r.rows); seconds += r.seconds;
        box.update({ progress: (k + per) / sel.frames.length, message: `${Math.min(sel.frames.length, k + per)} of ${sel.frames.length} frames` });
      }
      last = { rows, params, seconds };
      clear(status).append(el("button", { class: "btn primary", type: "button", onclick: () => results(last) }, "Show results"));
      results(last);
    } catch (e) { clear(status).append(errorState(e)); }
    finally { running = false; upd(); }
  }

  function results(R) {
    const rows = R.rows, x = rows.map(r => r.frame);
    let C = classify(rows, D.crit);
    const strip = el("canvas", { class: "dbt-strip", height: 26, style: { width: "100%", height: "26px", display: "block" } });
    const sumBox = el("div", {}), tableBox = el("div", { class: "table-wrap", style: { maxHeight: "30vh" } });
    const plots = [];
    function render() {
      C = classify(rows, D.crit);
      ctx.setRegime(C);
      const reg = rows.map(r => C.get(r.frame).regime), firstB = rows.findIndex((r, i) => reg[i] === "brittle");
      const trans = rows.filter((r, i) => i > 0 && reg[i] !== reg[i - 1]).map(r => r.frame);
      clear(sumBox).append(el("div", { class: `banner ${firstB >= 0 ? "warn" : ""}` },
        firstB < 0 ? el("span", {}, el("b", {}, "Ductile in every analysed frame. "), `No crack face, enclosed void or chip fragmentation met the criteria in frames ${x[0]} … ${x.at(-1)}.`)
          : el("span", {}, el("b", {}, firstB === 0 ? `Brittle from the first analysed frame (${x[0]}). ` : `Ductile until frame ${x[firstB - 1]}, brittle from frame ${x[firstB]} (step ${num(rows[firstB].step)}). `),
            `Evidence: ${C.get(x[firstB]).why.join("; ")}.`, trans.length > 1 ? ` Regime changes at frames ${trans.join(", ")}.` : "")));
      const c = strip.getContext("2d"), W = strip.width = strip.clientWidth * (window.devicePixelRatio || 1), H = strip.height;
      rows.forEach((r, i) => { c.fillStyle = reg[i] === "brittle" ? "#df6b5d" : "#5fae8b"; c.fillRect(Math.floor(i * W / rows.length), 0, Math.ceil(W / rows.length), H); });
      clear(tableBox).append(el("table", { class: "data compact" },
        el("thead", {}, el("tr", {}, ["Frame", "Step", "Regime", "Crack-face atoms", "Voids (Å³)", "Chip fragments", "Disordered %", "Damage depth Å", "Depth of cut Å", "Fc", "Ft", "Ft/Fc", "Reasons"].map(h => el("th", {}, h)))),
        el("tbody", {}, rows.map(r => { const k = C.get(r.frame); return el("tr", { class: k.regime === "brittle" ? "dbt-brittle" : "" },
          el("td", {}, String(r.frame)), el("td", { class: "num" }, num(r.step)), el("td", {}, k.regime), el("td", { class: "num" }, num(r.deep_surface_atoms)),
          el("td", { class: "num" }, `${r.voids} (${num(r.void_volume, 0)})`), el("td", { class: "num" }, String(r.chip_fragments)),
          el("td", { class: "num" }, r.disordered_fraction == null ? "—" : (100 * r.disordered_fraction).toFixed(2)), el("td", { class: "num" }, num(r.damage_depth, 2)),
          el("td", { class: "num" }, num(r.depth_of_cut, 2)), el("td", { class: "num" }, num(r.force_cutting, 3)), el("td", { class: "num" }, num(r.force_thrust, 3)),
          el("td", { class: "num" }, r.force_ratio == null ? "—" : r.force_ratio.toFixed(3)), el("td", { class: "small" }, k.why.join("; ") || "—")); }))));
    }
    const plotDefs = [["Crack faces and voids", [["deep_surface_atoms", "crack-face atoms"], ["voids", "enclosed voids"], ["chip_fragments", "chip fragments"]]],
      ["Amorphisation and damage", [["disordered_pct", "disordered interior atoms (%)"], ["damage_depth", "subsurface damage depth (Å)"]]],
      ["Tool forces (eV/Å)", [["force_cutting", "Fc (cutting, |ΣFx|)"], ["force_thrust", "Ft (thrust, |ΣFy|)"], ["force_ratio", "Ft/Fc"]]]];
    const hosts = plotDefs.map(() => el("div", { class: "plot", style: { height: "190px" } }));
    const back = el("div", { class: "modal-backdrop open", role: "dialog", "aria-modal": "true", "aria-label": "Ductile–brittle analysis" },
      el("div", { class: "modal wide" },
        el("div", { class: "panel-head" }, el("h3", {}, "Ductile–brittle regime (indicators computed by OVITO)"),
          el("span", { class: "sub" }, `${rows.length} frames · OVITO ${R.seconds.toFixed(1)} s`),
          el("div", { class: "actions" },
            el("button", { class: "btn", type: "button", "data-tip": "Select tool → Delete → Identify diamond structure in the Pipeline tab: disordered material shows in the viewport", onclick: () => { ctx.showDamage(D.tool_types); toast("Pipeline set: tool removed, structure types coloured (white = disordered).", "ok"); } }, "Show damage in viewport"),
            el("button", { class: "btn", type: "button", onclick: () => csv(rows, C) }, "CSV"),
            el("button", { class: "btn primary", type: "button", onclick: () => { back.remove(); toast("The regime of each analysed frame now shows in the viewport while you play.", "ok"); } }, "Play with regime"),
            el("button", { class: "btn", type: "button", onclick: () => { plots.forEach(q => q.destroy()); back.remove(); } }, "Close"))),
        el("div", { class: "panel-body grid1", style: { maxHeight: "80vh", overflow: "auto" } }, sumBox,
          el("div", {}, el("span", { class: "muted small" }, "Regime per analysed frame: "), el("span", { class: "small", style: { color: "#5fae8b" } }, "■ ductile "), el("span", { class: "small", style: { color: "#df6b5d" } }, "■ brittle"), strip),
          ...hosts, tableBox,
          el("p", { class: "muted small" }, "Definitions: crack-face atoms = atoms on OVITO's surface mesh (probe radius above) inside the zone, more than the crack margin below the tool and away from the workpiece's bottom and x ends; voids = enclosed empty regions of the mesh; chip = workpiece atoms above the original surface (frame 0, median of the highest atom per 10 Å column), split by cluster analysis; disordered = interior zone atoms that OVITO's Identify diamond structure classes as 'other'; damage depth = deepest such atom behind the cutting edge, below the tool; Fc, Ft = |ΣFx|, |ΣFy| over the tool's atoms (dump forces). These are indicators: confirm a brittle frame by looking at it (Show damage in viewport, then play)."))));
    document.body.append(back);
    render();
    requestAnimationFrame(() => plotDefs.forEach(([title, ser], i) => {
      const pl = new LinePlot(hosts[i], { xLabel: "frame", title });
      pl.setData(ser.map(([k, l]) => ({ name: l, x, y: rows.map(r => k === "disordered_pct" ? (r.disordered_fraction ?? NaN) * 100 : (r[k] ?? NaN)), points: rows.length < 80 })));
      plots.push(pl);
    }));
  }
  function csv(rows, C) {
    const cols = ["frame", "step", "regime", "deep_surface_atoms", "voids", "void_volume", "chip_fragments", "chip_atoms", "disordered_fraction", "damage_depth", "depth_of_cut",
      "force_cutting", "force_thrust", "force_ratio", "tip_x", "tool_bottom_y", "surface_y", "zone_atoms", "interior_atoms", "reasons"];
    const val = (r, k) => k === "regime" ? C.get(r.frame).regime : k === "reasons" ? `"${C.get(r.frame).why.join("; ")}"` : r[k] ?? "";
    download("ductile_brittle_indicators.csv", [cols.join(","), ...rows.map(r => cols.map(k => val(r, k)).join(","))].join("\n"), "text/csv");
  }
}
