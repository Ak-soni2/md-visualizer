// Studio viewport layers drawn with Canvas 2D on top of the atoms, both in the viewport and in exported images:
// colour legend, coordinate tripod, text labels and dimension lines. Sizes are fractions of the image height,
// so an exported image looks like the viewport preview at any resolution.
import { GRADIENTS } from "./pipeline.js";
import { project, V } from "./render.js";

export const ALIGNS = ["top-left", "top", "top-right", "left", "right", "bottom-left", "bottom", "bottom-right"];
export const defaultOverlays = () => ({
  legend: { enabled: true, orientation: "vertical", align: "right", ox: 0.02, oy: 0, length: 0.45, thickness: 0.035, title: null, unit: "Å", decimals: 2, font: 0.04, color: "#000000", serif: true, bold: true },
  tripod: { enabled: true, align: "bottom-left", ox: 0.03, oy: 0.03, size: 0.09, font: 0.035, serif: false },
  labels: [],
  measures: [],
});

function place(align, rect, w, h, ox, oy) {
  const H = rect.h, mx = ox * H, my = oy * H;
  let x = rect.x + (rect.w - w) / 2, y = rect.y + (rect.h - h) / 2;
  if (align.includes("left")) x = rect.x + mx; else if (align.includes("right")) x = rect.x + rect.w - w - mx; else x += mx;
  if (align.startsWith("top")) y = rect.y + my; else if (align.startsWith("bottom")) y = rect.y + rect.h - h - my; else y += my;
  return [x, y];
}
const fontOf = (px, serif, bold) => `${bold ? "700 " : ""}${Math.max(6, px).toFixed(1)}px ${serif ? '"Times New Roman", Times, serif' : '"IBM Plex Sans", "Segoe UI", Arial, sans-serif'}`;
export const fmtVal = (v, d, unit) => `${(+v).toFixed(d)}${unit ? " " + unit : ""}`;

/** Colour legend for a color_coding modifier m. */
function legend(c, rect, L, m) {
  const H = rect.h, fpx = L.font * H, th = L.thickness * H, len = L.length * H;
  const g = GRADIENTS[m.map] || GRADIENTS.Rainbow;
  const lo = fmtVal(m.start, L.decimals, L.unit), hi = fmtVal(m.end, L.decimals, L.unit);
  const title = L.title ?? m.prop;
  c.font = fontOf(fpx, L.serif, L.bold); c.fillStyle = L.color; c.strokeStyle = L.color; c.textBaseline = "middle";
  const vert = L.orientation === "vertical";
  const tw = Math.max(c.measureText(lo).width, c.measureText(hi).width), ttl = title ? c.measureText(title).width : 0;
  const gap = fpx * 0.5;
  const boxW = vert ? Math.max(th, tw, ttl) : tw * 2 + len + 2 * gap;
  const boxH = vert ? len + 2 * (fpx + gap) + (title ? fpx + gap : 0) : Math.max(th, fpx) + (title ? fpx + gap : 0);
  const [x0, y0] = place(L.align, rect, boxW, boxH, L.ox, L.oy);
  const bar = (x, y, w, h, horiz) => {
    const steps = 256;
    for (let i = 0; i < steps; i++) {
      let f = i / (steps - 1); if (m.reverse) f = 1 - f;
      const col = g(f).map(v => Math.round(v * 255));
      c.fillStyle = `rgb(${col})`;
      if (horiz) c.fillRect(x + w * i / steps, y, w / steps + 1, h); else c.fillRect(x, y + h - h * (i + 1) / steps, w, h / steps + 1);
    }
    c.lineWidth = Math.max(1, H / 900); c.strokeStyle = L.color; c.strokeRect(x, y, w, h);
    c.fillStyle = L.color;
  };
  if (vert) {
    let y = y0; const cx = x0 + boxW / 2;
    c.textAlign = "center";
    if (title) { c.fillText(title, cx, y + fpx / 2); y += fpx + gap; }
    c.fillText(hi, cx, y + fpx / 2); y += fpx + gap;
    bar(cx - th / 2, y, th, len, false); y += len + gap;
    c.fillText(lo, cx, y + fpx / 2);
  } else {
    let y = y0;
    c.textAlign = "center";
    if (title) { c.fillText(title, x0 + boxW / 2, y + fpx / 2); y += fpx + gap; }
    const bh = Math.max(th, fpx);
    c.textAlign = "right"; c.fillText(lo, x0 + tw, y + bh / 2);
    bar(x0 + tw + gap, y + (bh - th) / 2, len, th, true);
    c.textAlign = "left"; c.fillText(hi, x0 + tw + 2 * gap + len, y + bh / 2);
  }
}

/** Coordinate tripod: x red, y green, z blue, drawn in the current view orientation. */
function tripod(c, rect, T, m) {
  const H = rect.h, s = T.size * H, fpx = T.font * H;
  const [x0, y0] = place(T.align, rect, s * 2.2, s * 2.2, T.ox, T.oy);
  const ox = x0 + s * 1.1, oy = y0 + s * 1.1;
  const axes = [["x", [1, 0, 0], "#d62728"], ["y", [0, 1, 0], "#2ca02c"], ["z", [0, 0, 1], "#1f5fd6"]]
    .map(([n, e, col]) => ({ n, col, sx: V.dot(e, m.right), sy: -V.dot(e, m.up), d: V.dot(e, m.dir) }))
    .sort((a, b) => b.d - a.d);                                                  // far axes first
  c.lineCap = "round"; c.font = fontOf(fpx, T.serif, true); c.textAlign = "center"; c.textBaseline = "middle";
  for (const a of axes) {
    const ex = ox + a.sx * s, ey = oy + a.sy * s, l = Math.hypot(a.sx, a.sy);
    c.strokeStyle = c.fillStyle = a.col; c.lineWidth = Math.max(1.5, H / 300);
    if (l > 0.08) {
      c.beginPath(); c.moveTo(ox, oy); c.lineTo(ex, ey); c.stroke();
      const ux = a.sx / l, uy = a.sy / l, hl = s * 0.22;
      c.beginPath(); c.moveTo(ex + ux * hl * 0.35, ey + uy * hl * 0.35);
      c.lineTo(ex - ux * hl + uy * hl * 0.45, ey - uy * hl - ux * hl * 0.45); c.lineTo(ex - ux * hl - uy * hl * 0.45, ey - uy * hl + ux * hl * 0.45); c.fill();
    } else { c.beginPath(); c.arc(ox, oy, s * 0.08, 0, 7); c.fill(); }
    c.fillText(a.n, ox + (l > 0.08 ? a.sx / l : 0.7) * (s * (l > 0.08 ? l : 0) + fpx * 0.8), oy + (l > 0.08 ? a.sy / l : -0.7) * (s * (l > 0.08 ? l : 0) + fpx * 0.8));
  }
}

function text(c, rect, T, vars) {
  const H = rect.h, fpx = T.size * H;
  const str = T.text.replace(/\[(\w+)\]/g, (m, k) => vars?.[k] ?? m);     // [Timestep], [Frame], [Time] as in OVITO
  c.font = fontOf(fpx, T.serif, T.bold);
  const w = c.measureText(str).width;
  const [x, y] = place(T.align, rect, w, fpx, T.ox, T.oy);
  c.fillStyle = T.color; c.textAlign = "left"; c.textBaseline = "middle";
  c.fillText(str, x, y + fpx / 2);
}

export const measureValue = M => M.axis === "xyz" ? V.len(V.sub(M.b, M.a)) : Math.abs(M.b["xyz".indexOf(M.axis)] - M.a["xyz".indexOf(M.axis)]);

/** Dimension line between two picked atoms. axis 'x'|'y'|'z' measures that component only (with an extension line). */
function measure(c, rect, M, m) {
  const H = rect.h, k = "xyz".indexOf(M.axis);
  const tip = k >= 0 ? M.a.map((v, i) => i === k ? M.b[i] : v) : M.b;
  const A = project(m.vp, M.a, rect), B = project(m.vp, tip, rect), Bt = project(m.vp, M.b, rect);
  const lw = Math.max(1.2, (M.width ?? 0.0025) * H), fpx = (M.size ?? 0.04) * H;
  c.strokeStyle = c.fillStyle = M.color || "#000000"; c.lineWidth = lw; c.lineCap = "butt";
  if (k >= 0 && Math.hypot(Bt.x - B.x, Bt.y - B.y) > 2) {
    c.setLineDash([lw * 3, lw * 3]); c.beginPath(); c.moveTo(B.x, B.y); c.lineTo(Bt.x, Bt.y); c.stroke(); c.setLineDash([]);
  }
  const dx = B.x - A.x, dy = B.y - A.y, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L, px = -uy, py = ux;
  const tick = fpx * 0.9, head = Math.min(fpx * 0.55, L / 3);
  c.beginPath(); c.moveTo(A.x, A.y); c.lineTo(B.x, B.y);
  for (const [P, s] of [[A, 1], [B, -1]]) {
    c.moveTo(P.x - px * tick, P.y - py * tick); c.lineTo(P.x + px * tick, P.y + py * tick);   // end bar
  }
  c.stroke();
  for (const [P, s] of [[A, 1], [B, -1]]) {                                                // arrow heads
    c.beginPath(); c.moveTo(P.x, P.y);
    c.lineTo(P.x + s * ux * head + px * head * 0.4, P.y + s * uy * head + py * head * 0.4);
    c.lineTo(P.x + s * ux * head - px * head * 0.4, P.y + s * uy * head - py * head * 0.4); c.fill();
  }
  const label = `${M.prefix ?? ""}${fmtVal(measureValue(M), M.decimals ?? 2, "Å")}`;
  c.font = fontOf(fpx, M.serif ?? true, M.bold ?? true); c.textBaseline = "middle";
  const side = M.side === "left" ? -1 : 1, mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
  const off = fpx * 0.6 + tick;
  const vertical = Math.abs(uy) > Math.abs(ux);
  if (vertical) { c.textAlign = side > 0 ? "left" : "right"; c.fillText(label, mx + side * off, my); }
  else { c.textAlign = "center"; c.fillText(label, mx, my - side * off); }
}

/** Draw all overlays into rect. m: matrices for that rect; coloring: the color_coding modifier for the legend (or null);
 *  vars: values for [Name] placeholders in text labels. */
export function drawOverlays(c, rect, ov, m, coloring, vars) {
  c.save();
  c.beginPath(); c.rect(rect.x, rect.y, rect.w, rect.h); c.clip();
  for (const M of ov.measures) if (M.visible !== false) measure(c, rect, M, m);
  if (ov.legend.enabled && coloring) legend(c, rect, ov.legend, coloring);
  if (ov.tripod.enabled) tripod(c, rect, ov.tripod, m);
  for (const T of ov.labels) if (T.text) text(c, rect, T, vars);
  c.restore();
}
