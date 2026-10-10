// Studio modifier pipeline, evaluated top to bottom on typed arrays (like OVITO's data pipeline).
// Each modifier: label, defaults(), needs(params) -> columns it reads, apply(ctx, params) -> status text.
import { MAPS } from "../colormaps.js";

// ------------------------------------------------------------------------------------------------ gradients
function hsv(h, s, v) {
  const i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  return [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][((i % 6) + 6) % 6];
}
const cl = x => Math.min(1, Math.max(0, x));
const fromLut = lut => t => { const i = Math.round(cl(t) * 255) * 3; return [lut[i] / 255, lut[i + 1] / 255, lut[i + 2] / 255]; };
export const GRADIENTS = {
  Rainbow: t => hsv((1 - cl(t)) * 0.7, 1, 1),                                   // blue -> red through cyan, green, yellow
  Jet: t => [cl(1.5 - Math.abs(4 * t - 3)), cl(1.5 - Math.abs(4 * t - 2)), cl(1.5 - Math.abs(4 * t - 1))],
  Hot: t => [cl(3 * t), cl(3 * t - 1), cl(3 * t - 2)],
  Grayscale: t => [cl(t), cl(t), cl(t)],
  "Blue-White-Red": t => (t = cl(t)) < 0.5 ? [2 * t, 2 * t, 1] : [1, 2 - 2 * t, 2 - 2 * t],
  Viridis: fromLut(MAPS.viridis),
  Inferno: fromLut(MAPS.inferno),
};
const LUTS = {};
export function lut(name) {                                                     // 1024-entry RGB8 table
  if (!LUTS[name]) {
    const g = GRADIENTS[name] || GRADIENTS.Rainbow, t = new Uint8Array(1024 * 3);
    for (let i = 0; i < 1024; i++) { const c = g(i / 1023); t[i * 3] = c[0] * 255; t[i * 3 + 1] = c[1] * 255; t[i * 3 + 2] = c[2] * 255; }
    LUTS[name] = t;
  }
  return LUTS[name];
}

// ------------------------------------------------------------------------------------------------ helpers
export const hexToRgb = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
export const TYPE_PALETTE = ["#d9d9d9", "#e8b04b", "#5b8fd6", "#d65b5b", "#6fc28a", "#b07ad6", "#d6c35b", "#5bc9d6", "#d68a5b"];
const OPS = { ">": (a, b) => a > b, ">=": (a, b) => a >= b, "<": (a, b) => a < b, "<=": (a, b) => a <= b, "==": (a, b) => a === b, "!=": (a, b) => a !== b };
export const OP_LIST = Object.keys(OPS);
const fmt = n => n.toLocaleString("en-US");

function visibleRange(ctx, v, onlySel) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < ctx.n; i++) {
    if (!ctx.visible[i] || (onlySel && !ctx.sel[i])) continue;
    const x = v[i]; if (x < lo) lo = x; if (x > hi) hi = x;                     // NaN compares false: skipped
  }
  return lo <= hi ? [lo, hi] : null;
}

// ------------------------------------------------------------------------------------------------ modifiers
export const MODIFIERS = {
  displacement: {
    label: "Displacement vectors", group: "Analysis",
    help: "Per-atom displacement from a reference frame, atoms matched by id, minimum image across periodic directions. Adds dx, dy, dz and displacement (Å) for colouring and selection. Computed on the server when a frame loads.",
    defaults: () => ({ ref: 0 }),
    needs: () => [],
    apply: (ctx, p) => ctx.ref === p.ref ? `reference frame ${p.ref} · adds dx, dy, dz, displacement` : "reference frame not loaded (frame number out of range?)",
  },
  slice: {
    label: "Slice", group: "Modification",
    help: "Plane n·r = d. Width 0 removes atoms on the side the normal points to. Width > 0 keeps only the slab |n·r − d| ≤ width/2. Invert reverses which side is removed. With 'Select only', atoms are selected instead of removed.",
    defaults: () => ({ normal: [0, 0, 1], distance: 0, width: 0, invert: false, selectOnly: false }),
    needs: () => ["x", "y", "z"],
    apply(ctx, p) {
      const [nx, ny, nz] = p.normal.map(Number), L = Math.hypot(nx, ny, nz);
      if (!L) return "normal vector is zero";
      const x = ctx.col("x"), y = ctx.col("y"), z = ctx.col("z"), d = +p.distance, w = Math.abs(+p.width) / 2;
      let k = 0;
      for (let i = 0; i < ctx.n; i++) {
        if (!ctx.visible[i]) continue;
        const s = (nx * x[i] + ny * y[i] + nz * z[i]) / L - d;
        let cut = w > 0 ? Math.abs(s) > w : s > 0;
        if (p.invert) cut = !cut;
        if (cut) { k++; if (p.selectOnly) ctx.sel[i] = 1; else ctx.visible[i] = 0; }
      }
      return p.selectOnly ? `${fmt(k)} atoms selected` : `${fmt(k)} atoms removed`;
    },
  },
  select_type: {
    label: "Select type", group: "Selection",
    help: "Selects all atoms of the checked types (replaces the current selection).",
    defaults: () => ({ types: [] }),
    needs: () => ["type"],
    apply(ctx, p) {
      const t = ctx.col("type"), want = new Set(p.types.map(Number));
      let k = 0;
      for (let i = 0; i < ctx.n; i++) { const s = ctx.visible[i] && want.has(t[i]) ? 1 : 0; ctx.sel[i] = s; k += s; }
      return `${fmt(k)} atoms selected`;
    },
  },
  expression: {
    label: "Expression selection", group: "Selection",
    help: "Selects atoms meeting all (or any) of the conditions, e.g. y > 650 for atoms above the original surface. Replaces the current selection. The count is the number of selected atoms in this frame.",
    defaults: () => ({ conds: [{ prop: "y", op: ">", value: 0 }], combine: "all" }),
    needs: p => p.conds.map(c => c.prop),
    apply(ctx, p) {
      const cs = p.conds.filter(c => ctx.has(c.prop)).map(c => ({ v: ctx.col(c.prop), f: OPS[c.op], x: +c.value }));
      if (!cs.length) return "no valid condition";
      const all = p.combine !== "any";
      let k = 0;
      for (let i = 0; i < ctx.n; i++) {
        let s = 0;
        if (ctx.visible[i]) {
          s = all ? 1 : 0;
          for (const c of cs) { const r = c.f(c.v[i], c.x); if (all && !r) { s = 0; break; } if (!all && r) { s = 1; break; } }
        }
        ctx.sel[i] = s; k += s;
      }
      return `${fmt(k)} atoms selected`;
    },
  },
  invert_selection: {
    label: "Invert selection", group: "Selection", help: "Selected atoms become unselected and vice versa.",
    defaults: () => ({}), needs: () => [],
    apply(ctx) { let k = 0; for (let i = 0; i < ctx.n; i++) { ctx.sel[i] = ctx.visible[i] && !ctx.sel[i] ? 1 : 0; k += ctx.sel[i]; } return `${fmt(k)} atoms selected`; },
  },
  clear_selection: {
    label: "Clear selection", group: "Selection", help: "Unselects all atoms.",
    defaults: () => ({}), needs: () => [], apply(ctx) { ctx.sel.fill(0); return "selection cleared"; },
  },
  delete_selected: {
    label: "Delete selected", group: "Modification", help: "Removes the selected atoms from the rest of the pipeline and from the image (e.g. the tool).",
    defaults: () => ({}), needs: () => [],
    apply(ctx) { let k = 0; for (let i = 0; i < ctx.n; i++) if (ctx.sel[i]) { if (ctx.visible[i]) k++; ctx.visible[i] = 0; ctx.sel[i] = 0; } return `${fmt(k)} atoms removed`; },
  },
  assign_color: {
    label: "Assign color", group: "Coloring", help: "Gives the selected atoms one colour and clears the selection.",
    defaults: () => ({ color: "#35b6e0" }), needs: () => [],
    apply(ctx, p) {
      const [r, g, b] = hexToRgb(p.color); let k = 0;
      for (let i = 0; i < ctx.n; i++) if (ctx.sel[i]) { ctx.rgb[i * 3] = r; ctx.rgb[i * 3 + 1] = g; ctx.rgb[i * 3 + 2] = b; ctx.sel[i] = 0; k++; }
      return `${fmt(k)} atoms coloured`;
    },
  },
  color_coding: {
    label: "Color coding", group: "Coloring",
    help: "Colours atoms by a per-atom value with a colour gradient between Start and End (values outside are clamped). 'Adjust range' sets Start/End to the minimum and maximum of the atoms reaching this modifier. The colour legend overlay shows this modifier.",
    defaults: () => ({ prop: "y", map: "Rainbow", start: 0, end: 1, reverse: false, onlySelected: false, autoRange: true }),
    needs: p => [p.prop],
    apply(ctx, p) {
      if (!ctx.has(p.prop)) return `no column '${p.prop}' in this frame`;
      const v = ctx.col(p.prop), t = lut(p.map);
      p._range = visibleRange(ctx, v, p.onlySelected);
      if (p.autoRange && p._range) { [p.start, p.end] = p._range.map(x => +x.toPrecision(6)); p.autoRange = false; }
      const a = +p.start, span = (+p.end - a) || 1e-12;
      let k = 0;
      for (let i = 0; i < ctx.n; i++) {
        if (!ctx.visible[i] || (p.onlySelected && !ctx.sel[i])) continue;
        const x = v[i];
        if (x !== x) { ctx.rgb[i * 3] = ctx.rgb[i * 3 + 1] = ctx.rgb[i * 3 + 2] = 128; continue; }    // NaN: grey
        let f = (x - a) / span; if (p.reverse) f = 1 - f;
        const j = Math.round(cl(f) * 1023) * 3;
        ctx.rgb[i * 3] = t[j]; ctx.rgb[i * 3 + 1] = t[j + 1]; ctx.rgb[i * 3 + 2] = t[j + 2]; k++;
      }
      if (p.onlySelected) ctx.sel.fill(0);
      return `${fmt(k)} atoms coloured`;
    },
  },
};

export function newModifier(type) { return { type, enabled: true, ...MODIFIERS[type].defaults() }; }

/** Columns the pipeline needs (always positions and types). */
export function neededColumns(pipeline) {
  const s = new Set(["x", "y", "z", "type"]);
  for (const m of pipeline) if (m.enabled && MODIFIERS[m.type]) MODIFIERS[m.type].needs(m).forEach(c => s.add(c));
  return [...s];
}
export function displacementRef(pipeline) {
  const m = pipeline.find(m => m.enabled && m.type === "displacement");
  return m ? Math.max(0, Math.round(+m.ref || 0)) : null;
}

/** Evaluate the pipeline. frame: {n, cols}. types: {id: {color, radius}}. Returns arrays for the renderer. */
export function evaluate(frame, pipeline, types) {
  const n = frame.n, t = frame.cols.type;
  const ctx = {
    n, ref: frame.ref, visible: new Uint8Array(n).fill(1), sel: new Uint8Array(n), rgb: new Uint8Array(n * 3),
    has: c => c in frame.cols, col: c => frame.cols[c],
  };
  const radius = new Float32Array(n), cache = {};
  for (let i = 0; i < n; i++) {
    const id = t[i];
    let st = cache[id];
    if (!st) { const s = types[id] || {}; st = cache[id] = { rgb: hexToRgb(s.color || TYPE_PALETTE[(id - 1) % TYPE_PALETTE.length] || "#cccccc"), r: +s.radius || 1 }; }
    ctx.rgb[i * 3] = st.rgb[0]; ctx.rgb[i * 3 + 1] = st.rgb[1]; ctx.rgb[i * 3 + 2] = st.rgb[2]; radius[i] = st.r;
  }
  const status = pipeline.map(m => {
    if (!m.enabled) return "disabled";
    const def = MODIFIERS[m.type];
    if (!def) return "unknown modifier";
    try { return def.apply(ctx, m); } catch (e) { return `error: ${e.message}`; }
  });
  let nsel = 0;
  for (let i = 0; i < n; i++) if (ctx.sel[i] && ctx.visible[i]) { ctx.rgb[i * 3] = 255; ctx.rgb[i * 3 + 1] = 0; ctx.rgb[i * 3 + 2] = 0; nsel++; }   // selected atoms show red, as in OVITO
  let nv = 0; for (let i = 0; i < n; i++) nv += ctx.visible[i];
  const idx = new Uint32Array(nv); for (let i = 0, k = 0; i < n; i++) if (ctx.visible[i]) idx[k++] = i;
  return { idx, rgb: ctx.rgb, radius, visible: ctx.visible, sel: ctx.sel, nsel, status };
}
