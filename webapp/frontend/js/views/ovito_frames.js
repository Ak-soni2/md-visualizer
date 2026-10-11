// OVITO page, "Frames & export" tab: choose frames (interval, range or a list), then let OVITO
//  - write one CSV per frame with every particle column (dump column names; values exactly as read), packed in a ZIP,
//  - compute per-frame statistics of every numeric column and the force averages / sums (all atoms and per type),
// show them as a table and a chart, and export the chosen columns and statistics to an Excel workbook.
// Nothing is computed here: all numbers come from OVITO on the server (backend/ovito_worker.py, op_frame_table).
import * as api from "../api.js";
import { el, clear, num, bytes, toast, loading, errorState, download } from "../ui.js";
import { LinePlot } from "../plot.js";

const STAT_LABEL = { n: "valid count", mean: "mean", std: "std", min: "min", max: "max" };
const FORCE_COLS = [["mean_fx", "Mean Fx"], ["mean_fy", "Mean Fy"], ["mean_fz", "Mean Fz"], ["mean_magnitude", "Mean |F|"], ["magnitude_of_mean", "|Mean F|"],
  ["sum_fx", "Sum Fx"], ["sum_fy", "Sum Fy"], ["sum_fz", "Sum Fz"]];
export const exportDefaults = () => ({ mode: "interval", interval: 20, start: 0, end: null, step: 20, list: "", apply: false, derived: false, stats: ["mean"], cols: null });

/** Frames chosen by the settings E for a trajectory with n frames: {frames (sorted, unique, all valid), errors, warnings}. */
export function selectFrames(E, n) {
  const last = n - 1, errors = [], warnings = [];
  const int = (v, name) => { const x = Number(v); if (!Number.isInteger(x)) { errors.push(`${name} must be a whole number`); return null; } return x; };
  let frames = [];
  if (E.mode === "interval") {
    const k = int(E.interval, "Interval");
    if (k != null && k < 1) errors.push("Interval must be at least 1");
    else if (k != null) for (let f = 0; f <= last; f += k) frames.push(f);
  } else if (E.mode === "range") {
    const a = int(E.start ?? 0, "Start"), b = E.end == null || E.end === "" ? last : int(E.end, "End"), s = int(E.step ?? 1, "Step");
    if (a != null && b != null && s != null) {
      if (s < 1) errors.push("Step must be at least 1");
      else if (a < 0 || a > last) errors.push(`Start ${a} is outside the frames 0 … ${last}`);
      else if (b < a) errors.push(`End ${b} is before start ${a}`);
      else {
        if (b > last) warnings.push(`End ${b} is beyond the last frame ${last}; the range stops at ${last}`);
        for (let f = a; f <= Math.min(b, last); f += s) frames.push(f);
      }
    }
  } else {
    const bad = [], out = [];
    for (const tok of String(E.list || "").split(/[\s,;]+/).filter(Boolean)) {
      const m = tok.match(/^(\d+)(?:-(\d+)(?::(\d+))?)?$/);                 // 7  or 20-40  or 20-40:5
      if (!m) { bad.push(tok); continue; }
      const a = +m[1], b = m[2] != null ? +m[2] : a, s = m[3] != null ? +m[3] : 1;
      if (b < a || s < 1) { bad.push(tok); continue; }
      for (let f = a; f <= b; f += s) { if (f > last) { out.push(f); break; } frames.push(f); }
    }
    if (bad.length) errors.push(`Not understood: ${bad.join(", ")} (use e.g. 0, 7, 20-100, 20-600:30)`);
    if (out.length) warnings.push(`Outside the frames 0 … ${last}, left out: ${[...new Set(out)].join(", ")}`);
  }
  const uniq = [...new Set(frames)].sort((x, y) => x - y);
  if (uniq.length < frames.length) warnings.push(`${frames.length - uniq.length} duplicate frame(s) removed`);
  if (!uniq.length && !errors.length) errors.push("No frames selected");
  return { frames: uniq, errors, warnings };
}
const preview = f => f.length <= 12 ? f.join(", ") : `${f.slice(0, 6).join(", ")} … ${f.slice(-3).join(", ")}`;

/** p: the tab panel. ctx: {S, save, info(), spec(), label(), frameMeta()} */
export function buildFramesPanel(p, ctx) {
  const info = ctx.info();
  if (!info) { p.append(el("p", { class: "muted" }, "Upload dump files or open a path first.")); return; }
  const E = ctx.S.export = { ...exportDefaults(), ...(ctx.S.export || {}) };
  const n = info.num_frames, set = (k, v) => { E[k] = v; ctx.save(); update(); };
  const numIn = (k, a = {}) => el("input", { class: "input num", type: "number", step: 1, value: E[k] ?? "", onchange: e => set(k, e.target.value === "" ? null : +e.target.value), ...a });
  const row = (label, ...c) => el("label", { class: "frow" }, el("span", {}, label), el("div", { class: "fctl" }, ...c));
  const modeBox = el("div", {}), summary = el("div", { class: "fx-summary", role: "status", "aria-live": "polite" });
  const modeSel = el("select", { class: "select", "aria-label": "Frame selection mode", onchange: e => { E.mode = e.target.value; ctx.save(); buildMode(); update(); } },
    [["interval", "Every n-th frame from 0"], ["range", "Range: start, end, step"], ["specific", "Specific frames (list)"]].map(([v, l]) => el("option", { value: v, selected: E.mode === v }, l)));
  function buildMode() {
    clear(modeBox);
    if (E.mode === "interval") modeBox.append(row("Interval", numIn("interval", { min: 1 })), el("p", { class: "muted small" }, `Frames 0, k, 2k, … up to ${n - 1}.`));
    else if (E.mode === "range") modeBox.append(row("Start / end", el("div", { class: "duo" }, numIn("start", { min: 0, max: n - 1 }), numIn("end", { min: 0, max: n - 1, placeholder: `${n - 1} (last)` }))),
      row("Step", numIn("step", { min: 1 })), el("p", { class: "muted small" }, "e.g. start 20, end 600, step 30 → 20, 50, 80, … 590."));
    else modeBox.append(el("input", { class: "input mono", type: "text", value: E.list, placeholder: "0, 7, 20, 35, 100   or   20-600:30", "aria-label": "Frame list",
      oninput: e => { E.list = e.target.value; ctx.save(); update(); } }), el("p", { class: "muted small" }, "Numbers, ranges a-b and stepped ranges a-b:step, separated by commas or spaces."));
  }
  let sel = { frames: [], errors: [], warnings: [] };
  function update() {
    sel = selectFrames(E, n);
    clear(summary).append(
      el("div", {}, el("b", {}, `${num(sel.frames.length)} frame${sel.frames.length === 1 ? "" : "s"} selected`), sel.frames.length ? el("span", { class: "muted mono small" }, ` ${preview(sel.frames)}`) : null),
      ...sel.errors.map(m => el("div", { class: "status error small" }, m)), ...sel.warnings.map(m => el("div", { class: "muted small" }, m)));
    for (const b of [zipBtn, statBtn]) b.disabled = !!sel.errors.length || running;
  }
  let running = false, token = null;
  const status = el("div", {});
  const zipBtn = el("button", { class: "btn primary", type: "button", onclick: () => run(true) }, "Download CSVs as ZIP");
  const statBtn = el("button", { class: "btn", type: "button", onclick: () => run(false) }, "Calculate statistics & forces");
  const fm = ctx.frameMeta();
  p.append(
    el("section", { class: "st-sec" }, el("h4", {}, "Frame selection"), row("Mode", modeSel), modeBox, summary,
      el("button", { class: "btn ghost", type: "button", onclick: () => listModal(sel.frames) }, "Preview selected frames")),
    el("section", { class: "st-sec" }, el("h4", {}, "Data"),
      el("label", { class: "check", "data-tip": "Off: the columns exactly as read from the dump file" }, el("input", { type: "checkbox", checked: E.apply, onchange: e => { E.apply = e.target.checked; ctx.save(); } }),
        "Apply the OVITO pipeline (modifiers of the Pipeline tab)"),
      el("label", { class: "check", "data-tip": "Values OVITO computes while reading, which are not in the dump (e.g. Velocity Magnitude)" }, el("input", { type: "checkbox", checked: E.derived, onchange: e => { E.derived = e.target.checked; ctx.save(); } }),
        "Include columns derived by OVITO (not in the dump)"),
      el("p", { class: "muted small" }, "CSV headers are the dump's column names (x, fx, c_pe …); values are written with full precision. Nothing is filled in: a column that is not in the data is not exported."),
      fm ? el("p", { class: "muted small" }, `Per frame about ${bytes(fm.count * 22 * 14)} of CSV for ${num(fm.count)} particles; × ${num(sel.frames.length || 0)} frames before compression.`) : null),
    el("section", { class: "st-sec" }, el("h4", {}, "Export & analysis"), el("div", { class: "field-row" }, zipBtn, statBtn), status));
  buildMode(); update();

  async function run(csv) {
    if (running || sel.errors.length) return;
    running = true; update();
    token = Math.random().toString(16).slice(2) + Date.now().toString(16);
    const box = loading(csv ? `OVITO writes ${sel.frames.length} CSV files…` : `OVITO computes ${sel.frames.length} frames…`, true);
    clear(status).append(box, el("button", { class: "btn ghost", type: "button", onclick: () => api.post(`/api/ovito/frames/cancel/${token}`).catch(() => {}) }, "Cancel"));
    const selection = { mode: E.mode, ...(E.mode === "interval" ? { interval: E.interval } : E.mode === "range" ? { start: E.start, end: E.end ?? n - 1, step: E.step } : { list: E.list }) };
    try {
      const r = await api.job("/api/ovito/frames", { method: "POST", pollMs: 400, onProgress: x => box.update(x), timeoutMs: 24 * 3600e3,
        data: { spec: ctx.spec(), frames: sel.frames, apply_pipeline: E.apply, include_derived: E.derived, csv, stats: !csv, token } });
      clear(status);
      if (csv) {
        const tag = E.mode === "interval" ? `interval_${E.interval}` : E.mode === "range" ? `range_${E.start}-${E.end ?? n - 1}_step_${E.step}` : `custom_${sel.frames.length}`;
        const a = el("a", { href: api.apiUrl(`/api/ovito/file/${r.zip}`), download: `simulation_frames_${tag}.zip` });
        document.body.append(a); a.click(); a.remove();
        status.append(el("div", { class: "banner" }, `${r.rows.length} frames exported (${bytes(r.bytes)} ZIP, ${r.rows[0].columns.length} columns each, OVITO ${r.meta.seconds} s).`));
        toast(`ZIP with ${r.rows.length} CSV files is downloading.`, "ok");
      } else {
        status.append(el("button", { class: "btn primary", type: "button", onclick: () => statsModal(r, selection, E, ctx.save) }, "Show statistics table"));
        statsModal(r, selection, E, ctx.save);
      }
    } catch (e) { clear(status).append(errorState(e)); }
    finally { running = false; update(); }
  }
}

function listModal(frames) {
  const back = el("div", { class: "modal-backdrop open", role: "dialog", "aria-modal": "true", "aria-label": "Selected frames", onclick: e => { if (e.target === back) back.remove(); } },
    el("div", { class: "modal" }, el("div", { class: "panel-head" }, el("h3", {}, `${frames.length} selected frames`),
      el("div", { class: "actions" }, el("button", { class: "btn", type: "button", onclick: () => back.remove() }, "Close"))),
      el("div", { class: "panel-body" }, el("p", { class: "mono small", style: { wordBreak: "break-word", maxHeight: "50vh", overflow: "auto" } }, frames.join(", ")))));
  document.body.append(back);
}

/** The statistics of a finished job: force table, chart, column/statistic picker and Excel export. */
function statsModal(r, selection, E, save) {
  const rows = r.rows, cols = Object.keys(rows[0].stats || {}), origin = Object.fromEntries((rows[0].columns || []).map(c => [c.name, c.origin]));
  const types = Object.keys(rows[0].force_by_type || {});
  const hasForce = rows.some(x => x.force?.n_valid != null);
  if (!E.cols || !E.cols.some(c => cols.includes(c))) E.cols = cols.filter(c => !["id", "type", "mol"].includes(c));
  const chosen = new Set(E.cols.filter(c => cols.includes(c))), stats = new Set(E.stats);
  const v = x => x == null ? "—" : num(x, 6);
  const group = ["all", ...types];
  let gsel = "all";
  const fset = g => g === "all" ? (x => x.force || {}) : (x => (x.force_by_type || {})[g] || {});
  const tableBox = el("div", { class: "table-wrap", style: { maxHeight: "34vh" } });
  function table() {
    const get = fset(gsel);
    clear(tableBox).append(el("table", { class: "data compact" },
      el("thead", {}, el("tr", {}, ["Frame", "Timestep", "Particles", "Valid force", ...FORCE_COLS.map(([, l]) => l)].map(h => el("th", { class: h === "Frame" ? "" : "num" }, h)))),
      el("tbody", {}, rows.map(x => { const f = get(x); return el("tr", {}, el("td", {}, String(x.frame)), el("td", { class: "num" }, v(x.timestep)), el("td", { class: "num" }, num(gsel === "all" ? x.count : f.n)),
        el("td", { class: "num" }, f.n_valid == null ? "—" : num(f.n_valid)), ...FORCE_COLS.map(([k]) => el("td", { class: "num" }, v(f[k])))); }))));
  }
  const plotHost = el("div", { class: "plot", style: { height: "240px" } });
  const plotSel = el("select", { class: "select", "aria-label": "Quantity to plot", onchange: () => draw() },
    el("option", { value: "fmean" }, "Force means and mean |F|"), el("option", { value: "fsum" }, "Force sums (Fx, Fy, Fz)"),
    ...cols.map(c => el("option", { value: `col:${c}` }, `${c} (mean)`)));
  let plot = null;
  function draw() {
    if (!plot) plot = new LinePlot(plotHost, { xLabel: "frame", yLabel: "", title: "Frame statistics" });
    const x = rows.map(z => z.frame), get = fset(gsel), q = plotSel.value;
    const ser = q === "fmean" ? [["mean_fx", "Mean Fx"], ["mean_fy", "Mean Fy"], ["mean_fz", "Mean Fz"], ["mean_magnitude", "Mean |F|"]]
      : q === "fsum" ? [["sum_fx", "Sum Fx"], ["sum_fy", "Sum Fy"], ["sum_fz", "Sum Fz"]] : null;
    plot.setData(ser ? ser.map(([k, l]) => ({ name: `${l}${gsel === "all" ? "" : ` (type ${gsel})`}`, x, y: rows.map(z => get(z)[k] ?? NaN), points: rows.length < 60 }))
      : [{ name: `${q.slice(4)} mean`, x, y: rows.map(z => z.stats?.[q.slice(4)]?.mean ?? NaN), points: rows.length < 60 }]);
  }
  const groupSel = el("select", { class: "select", "aria-label": "Particles", onchange: e => { gsel = e.target.value; table(); draw(); } },
    group.map(g => el("option", { value: g }, g === "all" ? "All particles" : `Type ${g}${rows[0].force_by_type[g].name ? ` (${rows[0].force_by_type[g].name})` : ""}`)));
  const colBox = el("div", { class: "chips" }, cols.map(c => el("button", { class: "chip", type: "button", "aria-pressed": chosen.has(c), "data-tip": origin[c],
    onclick: e => { chosen.has(c) ? chosen.delete(c) : chosen.add(c); e.currentTarget.setAttribute("aria-pressed", chosen.has(c)); E.cols = [...chosen]; save(); } }, c)));
  const statBox = el("div", { class: "chips" }, Object.entries(STAT_LABEL).map(([k, l]) => el("button", { class: "chip", type: "button", "aria-pressed": stats.has(k),
    onclick: e => { stats.has(k) ? stats.delete(k) : stats.add(k); e.currentTarget.setAttribute("aria-pressed", stats.has(k)); E.stats = [...stats]; save(); } }, l)));
  const xbtn = el("button", { class: "btn primary", type: "button", onclick: async () => {
    if (!stats.size) { toast("Choose at least one statistic.", "warn"); return; }
    xbtn.disabled = true;
    try {
      const res = await fetch(api.apiUrl("/api/ovito/frames/xlsx"), { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows, meta: r.meta, columns: cols.filter(c => chosen.has(c)), stats: Object.keys(STAT_LABEL).filter(k => stats.has(k)), selection }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
      download(`frame_statistics_${rows.length}_frames.xlsx`, await res.blob(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      toast("Excel workbook downloaded.", "ok");
    } catch (e) { toast(`Excel export failed: ${e.message}`, "err"); }
    finally { xbtn.disabled = false; }
  } }, "Export statistics to Excel");
  const back = el("div", { class: "modal-backdrop open", role: "dialog", "aria-modal": "true", "aria-label": "Frame statistics" },
    el("div", { class: "modal wide" },
      el("div", { class: "panel-head" }, el("h3", {}, "Frame statistics (computed by OVITO)"),
        el("span", { class: "sub" }, `${rows.length} frames · ${r.meta.apply_pipeline ? "after the OVITO pipeline" : "dump data"} · OVITO ${r.meta.seconds} s`),
        el("div", { class: "actions" }, xbtn, el("button", { class: "btn", type: "button", onclick: () => { plot?.destroy(); back.remove(); } }, "Close"))),
      el("div", { class: "panel-body grid1", style: { maxHeight: "80vh", overflow: "auto" } },
        hasForce ? null : el("div", { class: "banner warn" }, `No complete force vector in this data (${(rows[0].force?.missing || []).join(", ")} missing): force statistics cannot be calculated; the column statistics below are still available.`),
        el("div", { class: "field-row" }, el("span", { class: "muted" }, "Particles"), groupSel, el("span", { class: "muted" }, "Plot"), plotSel),
        el("p", { class: "muted small" }, "Mean F = Σ F_i / N and Mean |F| = Σ |F_i| / N over the N particles whose Fx, Fy, Fz are all finite (Valid force); |Mean F| is the length of the mean vector, a different quantity. Sum F is the total force on the group — over all atoms it is ≈ 0 (Newton's third law); the cutting force is the sum over the tool's type."),
        tableBox, plotHost,
        el("section", { class: "st-sec" }, el("h4", {}, "Columns for the Excel workbook (one sheet per group: c_ computes, f_ fixes, v_ variables, displacement, positions/velocities/forces, others)"), colBox,
          el("div", { class: "field-row" }, el("button", { class: "btn ghost", type: "button", onclick: () => { cols.forEach(c => chosen.add(c)); E.cols = [...chosen]; colBox.querySelectorAll(".chip").forEach(b => b.setAttribute("aria-pressed", "true")); } }, "All"),
            el("button", { class: "btn ghost", type: "button", onclick: () => { chosen.clear(); E.cols = []; colBox.querySelectorAll(".chip").forEach(b => b.setAttribute("aria-pressed", "false")); } }, "None"))),
        el("section", { class: "st-sec" }, el("h4", {}, "Statistics per column"), statBox,
          el("p", { class: "muted small" }, "Sheet 1: force statistics per frame; sheet 2: export metadata (source, frames, selection, formulas, column origins); then force by particle type and one sheet per column group.")))));
  document.body.append(back);
  table(); requestAnimationFrame(draw);
}
