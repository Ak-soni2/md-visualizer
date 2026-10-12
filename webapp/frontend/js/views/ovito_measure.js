// OVITO page, "Measure" tab.
//  - Automatic pile-up height (OVITO, backend op_pileup): original surface = median over 10 Å x 10 Å columns of the
//    highest workpiece atom in frame 0 (tool removed); pile-up height H = highest workpiece atom of the frame above it,
//    overall, ahead of the cutting edge (chip / front pile-up) and behind it (burr / side pile-up), for the current
//    frame or every n-th frame (chart, CSV); H can be drawn into the viewport as a dimension line.
//  - Two-point measurement: click two particles in the viewport; the height (Δy), Δx, Δz or the distance between them is
//    computed from OVITO's exact positions and drawn as a dimension line. Measurements are kept per trajectory.
import * as api from "../api.js";
import { el, clear, num, toast, loading, errorState, download } from "../ui.js";
import { LinePlot } from "../plot.js";
import { selectFrames } from "./ovito_frames.js";

const AXES = [["y", "Height Δy"], ["xyz", "Distance"], ["x", "Δx"], ["z", "Δz"]];
export const measureValue = M => M.axis === "xyz" ? Math.hypot(M.b.x - M.a.x, M.b.y - M.a.y, M.b.z - M.a.z) : Math.abs(M.b[M.axis] - M.a[M.axis]);
const fmt = v => (v == null ? "—" : `${v.toFixed(3)} Å`);

/** dimension lines of this trajectory into the overlay canvas (mv: camera matrices; W, H: canvas size) */
export function drawMeasures(c, mv, W, H, list, ink) {
  const v = mv.vp, P = p => { const w = v[3] * p[0] + v[7] * p[1] + v[11] * p[2] + v[15]; return [((v[0] * p[0] + v[4] * p[1] + v[8] * p[2] + v[12]) / w + 1) / 2 * W, (1 - (v[1] * p[0] + v[5] * p[1] + v[9] * p[2] + v[13]) / w) / 2 * H]; };
  const fs = Math.max(12, H * 0.018);
  c.save(); c.font = `600 ${fs}px system-ui, sans-serif`; c.lineWidth = 2;
  for (const M of list) {
    const a = [M.a.x, M.a.y, M.a.z], b = [M.b.x, M.b.y, M.b.z], k = "xyz".indexOf(M.axis);
    const tip = k >= 0 ? a.map((x, i) => (i === k ? b[i] : x)) : b;           // the measured component as its own segment
    const A = P(a), B = P(tip), Bt = P(b);
    c.strokeStyle = c.fillStyle = M.color || "#f0b453";
    if (k >= 0 && Math.hypot(Bt[0] - B[0], Bt[1] - B[1]) > 2) { c.setLineDash([4, 4]); c.beginPath(); c.moveTo(B[0], B[1]); c.lineTo(Bt[0], Bt[1]); c.stroke(); c.setLineDash([]); }
    const dx = B[0] - A[0], dy = B[1] - A[1], L = Math.hypot(dx, dy) || 1, px = -dy / L * 7, py = dx / L * 7;
    c.beginPath(); c.moveTo(A[0], A[1]); c.lineTo(B[0], B[1]);
    for (const Q of [A, B]) { c.moveTo(Q[0] - px, Q[1] - py); c.lineTo(Q[0] + px, Q[1] + py); }
    c.stroke();
    const label = `${M.label || (M.axis === "xyz" ? "d = " : `Δ${M.axis} = `)}${measureValue(M).toFixed(2)} Å`;
    c.strokeStyle = ink === "#111111" ? "rgba(255,255,255,0.85)" : "rgba(10,12,14,0.85)"; c.lineWidth = 4;
    const tx = (A[0] + B[0]) / 2 + 10, ty = (A[1] + B[1]) / 2;
    c.strokeText(label, tx, ty); c.fillText(label, tx, ty); c.lineWidth = 2;
  }
  c.restore();
}

/** p: tab panel; ctx: {S, save, info(), spec(), frameIndex(), srcKey(), startMeasure(axis), redraw()} */
export function buildMeasurePanel(p, ctx) {
  const info = ctx.info();
  if (!info) { p.append(el("p", { class: "muted" }, "Open a trajectory first.")); return; }
  const S = ctx.S;
  S.measures = S.measures || [];
  const Mset = S.measureSet = { axis: "y", threshold: 1, interval: 10, ...(S.measureSet || {}) };
  const tools = S.dbt?.tool_types?.length ? S.dbt.tool_types : (info.types.some(t => t.id === 1) ? [1] : [info.types[0].id]);
  const here = () => S.measures.filter(m => m.src === ctx.srcKey());
  const row = (label, c, tip) => el("label", { class: "frow", "data-tip": tip }, el("span", {}, label), el("div", { class: "fctl" }, c));
  const numIn = (k, a = {}) => el("input", { class: "input num", type: "number", step: "any", value: Mset[k] ?? "", onchange: e => { Mset[k] = +e.target.value; ctx.save(); }, ...a });
  const res = el("div", {}), list = el("div", { class: "grid1" });

  // ---- automatic pile-up
  async function pile(frames) {
    clear(res).append(loading(`OVITO measures ${frames.length} frame${frames.length > 1 ? "s" : ""}…`, true));
    try {
      const r = await api.job("/api/ovito/pileup", { method: "POST", pollMs: 300, timeoutMs: 24 * 3600e3, onProgress: x => res.firstChild?.update?.(x),
        data: { spec: ctx.spec(), frames, params: { tool_types: tools, threshold: Mset.threshold, direction: S.dbt?.direction || "-x" } } });
      showPile(r.rows);
    } catch (e) { clear(res).append(errorState(e)); }
  }
  function showPile(rows) {
    clear(res);
    const r0 = rows.find(r => r.frame === ctx.frameIndex()) || rows[0];
    const line = (k, lab) => r0[k] ? el("tr", {}, el("td", {}, lab), el("td", { class: "num" }, fmt(r0[k].height)), el("td", { class: "num mono small" }, `id ${r0[k].id} · x ${r0[k].x.toFixed(2)} y ${r0[k].y.toFixed(2)} z ${r0[k].z.toFixed(2)}`)) : null;
    res.append(el("table", { class: "data compact" }, el("tbody", {},
      el("tr", {}, el("td", {}, "Frame / step"), el("td", { class: "num" }, `${r0.frame} / ${num(r0.step)}`), el("td", {})),
      el("tr", {}, el("td", {}, "Original surface (frame 0)"), el("td", { class: "num" }, `y = ${r0.surface_y.toFixed(3)} Å`), el("td", {})),
      line("highest", "Pile-up height H (max)"), line("ahead", "H ahead of the edge (chip / front)"), line("behind", "H behind the edge (burr / side)"),
      el("tr", {}, el("td", {}, `Atoms above surface + ${r0.threshold} Å`), el("td", { class: "num" }, num(r0.above_count)),
        el("td", { class: "num small" }, r0.above_width_z != null ? `width (z) ${r0.above_width_z.toFixed(2)} Å, x ${r0.above_x.map(v => v.toFixed(1)).join(" … ")}` : "")),
      r0.depth_of_cut != null ? el("tr", {}, el("td", {}, "Depth of cut (surface − tool bottom)"), el("td", { class: "num" }, fmt(r0.depth_of_cut)), el("td", {})) : null)),
      el("div", { class: "field-row" },
        el("button", { class: "btn", type: "button", onclick: () => {
          const h = r0.highest; if (!h) return;
          S.measures.push({ src: ctx.srcKey(), frame: r0.frame, axis: "y", label: "H = ", a: { id: null, x: h.x, y: r0.surface_y, z: h.z }, b: { id: h.id, x: h.x, y: h.y, z: h.z } });
          ctx.save(); ctx.redraw(); buildList();
        } }, "Show H in viewport"),
        el("button", { class: "btn ghost", type: "button", onclick: () => download("pileup_height.csv",
          ["frame,step,surface_y_A,H_max_A,H_max_id,H_max_x,H_max_y,H_max_z,H_ahead_A,H_behind_A,atoms_above,width_z_A,depth_of_cut_A",
            ...rows.map(r => [r.frame, r.step, r.surface_y, r.highest?.height, r.highest?.id, r.highest?.x, r.highest?.y, r.highest?.z, r.ahead?.height ?? "", r.behind?.height ?? "", r.above_count, r.above_width_z ?? "", r.depth_of_cut ?? ""].join(","))].join("\n"), "text/csv") }, "CSV")));
    if (rows.length > 1) {
      const host = el("div", { class: "plot", style: { height: "190px" } });
      res.append(host);
      requestAnimationFrame(() => new LinePlot(host, { xLabel: "frame", title: "Pile-up height (Å)" }).setData([["highest", "H max"], ["ahead", "H ahead"], ["behind", "H behind"]]
        .map(([k, l]) => ({ name: l, x: rows.map(r => r.frame), y: rows.map(r => r[k]?.height ?? NaN), points: rows.length < 80 }))));
    }
  }

  // ---- two-point measurements
  function buildList() {
    clear(list);
    const ms = here();
    if (!ms.length) { list.append(el("p", { class: "muted small" }, "No measurements yet.")); return; }
    ms.forEach(M => list.append(el("div", { class: "field-row" },
      el("span", { class: "mono" }, `${M.label || (M.axis === "xyz" ? "d = " : `Δ${M.axis} = `)}${measureValue(M).toFixed(3)} Å`),
      el("span", { class: "muted small" }, `frame ${M.frame}${M.a.id != null ? ` · ids ${M.a.id} → ${M.b.id}` : ` · id ${M.b.id}`}`),
      el("button", { class: "btn ghost icon", type: "button", "aria-label": "Remove measurement", onclick: () => { S.measures.splice(S.measures.indexOf(M), 1); ctx.save(); ctx.redraw(); buildList(); } }, "✕"))));
    list.append(el("div", { class: "field-row" },
      el("button", { class: "btn ghost", type: "button", onclick: () => download("measurements.csv", ["label,axis,value_A,frame,id_a,xa,ya,za,id_b,xb,yb,zb",
        ...ms.map(M => [M.label || "", M.axis, measureValue(M), M.frame, M.a.id ?? "", M.a.x, M.a.y, M.a.z, M.b.id ?? "", M.b.x, M.b.y, M.b.z].join(","))].join("\n"), "text/csv") }, "CSV"),
      el("button", { class: "btn ghost", type: "button", onclick: () => { S.measures = S.measures.filter(m => m.src !== ctx.srcKey()); ctx.save(); ctx.redraw(); buildList(); } }, "Clear all")));
  }

  const sel = () => selectFrames({ mode: "interval", interval: Mset.interval }, info.num_frames).frames;
  p.append(
    el("section", { class: "st-sec" }, el("h4", {}, "Pile-up height (automatic)"),
      el("p", { class: "muted small" }, `Tool type${tools.length > 1 ? "s" : ""} ${tools.join(", ")} removed (set in the Ductile–brittle tab). Original surface: median over 10 Å × 10 Å columns of the highest workpiece atom in frame 0. H = highest workpiece atom above it.`),
      row("Threshold above surface (Å)", numIn("threshold", { min: 0, step: 0.1 }), "Atoms higher than surface + threshold are counted as pile-up / burr"),
      el("div", { class: "field-row" }, el("button", { class: "btn primary", type: "button", onclick: () => pile([ctx.frameIndex()]) }, "Measure this frame")),
      row("Every n-th frame", numIn("interval", { min: 1, step: 1 })),
      el("button", { class: "btn", type: "button", onclick: () => pile(sel()) }, "Measure over the trajectory"), res),
    el("section", { class: "st-sec" }, el("h4", {}, "Between two particles"),
      row("Measure", el("select", { class: "select", onchange: e => { Mset.axis = e.target.value; ctx.save(); } }, AXES.map(([v, l]) => el("option", { value: v, selected: Mset.axis === v }, l)))),
      el("button", { class: "btn primary", type: "button", onclick: () => ctx.startMeasure(Mset.axis, buildList) }, "Pick two particles"),
      el("p", { class: "muted small" }, "Click the first particle, then the second (Esc cancels). Positions are OVITO's exact values, not the display."),
      list));
  buildList();
}
