// Lightweight canvas line plot for scientific series: labelled axes with units, nice ticks, legend,
// optional shaded band (e.g. the steady-state window used for averages), hover readout, PNG/CSV export.
import { SERIES_COLORS } from "./colormaps.js";

function niceStep(range, count) {
  const raw = range / Math.max(1, count), mag = 10 ** Math.floor(Math.log10(raw)), f = raw / mag;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
}
function ticks(lo, hi, count) {
  if (!(hi > lo)) { hi = lo + 1; lo = lo - 1; }
  const st = niceStep(hi - lo, count), out = [];
  for (let v = Math.ceil(lo / st) * st; v <= hi + st * 1e-9; v += st) out.push(+v.toPrecision(12));
  return { out, st };
}
const fmt = (v, st) => { const d = Math.max(0, Math.min(6, -Math.floor(Math.log10(st || 1)))); return Math.abs(v) >= 1e5 ? v.toExponential(1) : v.toFixed(d); };

export class LinePlot {
  constructor(container, { xLabel = "", yLabel = "", title = "" } = {}) {
    this.c = container; this.opts = { xLabel, yLabel, title };
    this.canvas = document.createElement("canvas");
    this.canvas.setAttribute("role", "img");
    this.tip = document.createElement("div"); this.tip.className = "plot-tip";
    container.append(this.canvas, this.tip);
    this.series = []; this.band = null;
    const cs = getComputedStyle(document.documentElement);
    this.col = { grid: cs.getPropertyValue("--line").trim(), axis: cs.getPropertyValue("--line-3").trim(), text: cs.getPropertyValue("--text-2").trim(), text0: cs.getPropertyValue("--text-1").trim(), band: "rgba(226,162,58,0.07)", bandLine: "rgba(226,162,58,0.35)" };
    this.ro = new ResizeObserver(() => this.draw()); this.ro.observe(container);
    this.canvas.addEventListener("pointermove", e => this.hover(e));
    this.canvas.addEventListener("pointerleave", () => { this.hoverX = null; this.tip.style.display = "none"; this.draw(); });
  }
  setData(series, { band = null, bandLabel = "" } = {}) {
    this.series = series.map((s, i) => ({ color: SERIES_COLORS[i % SERIES_COLORS.length], width: 1.6, ...s }));
    this.band = band; this.bandLabel = bandLabel;
    this.canvas.setAttribute("aria-label", `${this.opts.title || "plot"}: ${this.series.map(s => s.name).join(", ")} versus ${this.opts.xLabel}`);
    this.draw();
  }
  extents() {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const s of this.series) for (let i = 0; i < s.x.length; i++) {
      const x = s.x[i], y = s.y[i];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (!Number.isFinite(x0)) return null;
    const py = (y1 - y0) * 0.06 || Math.abs(y0) * 0.1 || 1;
    return { x0, x1, y0: y0 - py, y1: y1 + py };
  }
  draw() {
    const dpr = window.devicePixelRatio || 1, W = this.c.clientWidth, H = this.c.clientHeight;
    if (!W || !H) return;
    this.canvas.width = W * dpr; this.canvas.height = H * dpr;
    const g = this.canvas.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const e = this.extents();
    g.font = "11px " + getComputedStyle(document.body).fontFamily;
    if (!e) { g.fillStyle = this.col.text; g.textAlign = "center"; g.fillText("no data", W / 2, H / 2); return; }
    // legend layout first: wrap onto as many rows as needed, then reserve that height at the top
    const items = []; let row = 0, lx0 = 66;
    for (const s of this.series) {
      const w = g.measureText(s.name).width + 32;
      if (lx0 + w > W - 14 && lx0 > 66) { row++; lx0 = 66; }
      items.push({ s, x: lx0, y: 12 + row * 16 }); lx0 += w;
    }
    this._legend = items;
    const m = { l: 62, r: 14, t: 26 + row * 16, b: 40 }, pw = W - m.l - m.r, ph = H - m.t - m.b;
    const X = v => m.l + (v - e.x0) / (e.x1 - e.x0 || 1) * pw, Y = v => m.t + ph - (v - e.y0) / (e.y1 - e.y0 || 1) * ph;
    this.map = { X, Y, m, pw, ph, e };
    const tx = ticks(e.x0, e.x1, Math.max(3, pw / 90)), ty = ticks(e.y0, e.y1, Math.max(3, ph / 50));
    // band
    if (this.band) {
      const a = X(Math.max(this.band[0], e.x0)), b = X(Math.min(this.band[1], e.x1));
      g.fillStyle = this.col.band; g.fillRect(a, m.t, b - a, ph);
      g.strokeStyle = this.col.bandLine; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(a + 0.5, m.t); g.lineTo(a + 0.5, m.t + ph); g.stroke(); g.setLineDash([]);
      if (this.bandLabel) { g.fillStyle = this.col.text; g.textAlign = "left"; g.fillText(this.bandLabel, a + 5, m.t + 12); }
    }
    // grid + ticks
    g.strokeStyle = this.col.grid; g.lineWidth = 1; g.fillStyle = this.col.text;
    g.textAlign = "center"; g.textBaseline = "top";
    for (const v of tx.out) { const x = Math.round(X(v)) + 0.5; g.beginPath(); g.moveTo(x, m.t); g.lineTo(x, m.t + ph); g.stroke(); g.fillText(fmt(v, tx.st), x, m.t + ph + 6); }
    g.textAlign = "right"; g.textBaseline = "middle";
    for (const v of ty.out) { const y = Math.round(Y(v)) + 0.5; g.beginPath(); g.moveTo(m.l, y); g.lineTo(m.l + pw, y); g.stroke(); g.fillText(fmt(v, ty.st), m.l - 6, y); }
    if (e.y0 < 0 && e.y1 > 0) { g.strokeStyle = this.col.axis; g.beginPath(); g.moveTo(m.l, Math.round(Y(0)) + 0.5); g.lineTo(m.l + pw, Math.round(Y(0)) + 0.5); g.stroke(); }
    g.strokeStyle = this.col.axis; g.strokeRect(m.l + 0.5, m.t + 0.5, pw, ph);
    // axis labels
    g.fillStyle = this.col.text0; g.textAlign = "center"; g.textBaseline = "alphabetic";
    g.fillText(this.opts.xLabel, m.l + pw / 2, H - 6);
    g.save(); g.translate(13, m.t + ph / 2); g.rotate(-Math.PI / 2); g.fillText(this.opts.yLabel, 0, 0); g.restore();
    // series
    g.save(); g.beginPath(); g.rect(m.l, m.t, pw, ph); g.clip();
    for (const s of this.series) {
      g.strokeStyle = s.color; g.lineWidth = s.width; g.setLineDash(s.dash || []); g.beginPath();
      let pen = false;
      for (let i = 0; i < s.x.length; i++) {
        if (!Number.isFinite(s.y[i])) { pen = false; continue; }
        const x = X(s.x[i]), y = Y(s.y[i]);
        pen ? g.lineTo(x, y) : g.moveTo(x, y); pen = true;
      }
      g.stroke();
      if (s.points) { g.fillStyle = s.color; for (let i = 0; i < s.x.length; i++) if (Number.isFinite(s.y[i])) { g.beginPath(); g.arc(X(s.x[i]), Y(s.y[i]), 2.6, 0, 7); g.fill(); } }
    }
    g.setLineDash([]); g.restore();
    // legend
    g.textBaseline = "middle"; g.textAlign = "left";
    for (const { s, x: lx, y: ly } of this._legend) {
      g.strokeStyle = s.color; g.lineWidth = 2; g.setLineDash(s.dash || []); g.beginPath(); g.moveTo(lx, ly); g.lineTo(lx + 14, ly); g.stroke(); g.setLineDash([]);
      g.fillStyle = this.col.text0; g.fillText(s.name, lx + 18, ly);
    }
    // hover crosshair
    if (this.hoverX !== null && this.hoverX !== undefined) {
      const x = X(this.hoverX); g.strokeStyle = this.col.axis; g.setLineDash([2, 3]); g.beginPath(); g.moveTo(x, m.t); g.lineTo(x, m.t + ph); g.stroke(); g.setLineDash([]);
    }
  }
  hover(ev) {
    if (!this.map) return;
    const r = this.canvas.getBoundingClientRect(), px = ev.clientX - r.left, { m, pw, e } = this.map;
    if (px < m.l || px > m.l + pw) { this.tip.style.display = "none"; return; }
    const xv = e.x0 + (px - m.l) / pw * (e.x1 - e.x0);
    const rows = [];
    let snapped = xv;
    for (const s of this.series) {
      let lo = 0, hi = s.x.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; s.x[mid] < xv ? lo = mid : hi = mid; }
      const i = Math.abs(s.x[lo] - xv) < Math.abs(s.x[hi] - xv) ? lo : hi;
      if (i >= 0 && Number.isFinite(s.y[i])) { rows.push([s, s.y[i]]); snapped = s.x[i]; }
    }
    this.hoverX = snapped; this.draw();
    this.tip.innerHTML = `<div>${this.opts.xLabel}: ${snapped.toPrecision(5)}</div>` + rows.map(([s, v]) => `<div class="s"><span class="swatch" style="background:${s.color}"></span>${s.name}: ${v.toPrecision(5)}</div>`).join("");
    this.tip.style.display = "block";
    const tw = this.tip.offsetWidth;
    this.tip.style.left = `${px + 14 + tw > r.width ? px - tw - 10 : px + 14}px`;
    this.tip.style.top = `${Math.max(4, ev.clientY - r.top - 20)}px`;
  }
  toPNG(name) {
    const a = document.createElement("a"); a.download = name; a.href = this.canvas.toDataURL("image/png"); a.click();
  }
  toCSV(name) {
    const head = ["series", this.opts.xLabel, this.opts.yLabel].map(h => `"${h}"`).join(",");
    const rows = this.series.flatMap(s => s.x.map((x, i) => `"${s.name}",${x},${s.y[i]}`));
    const a = document.createElement("a"); a.download = name;
    a.href = URL.createObjectURL(new Blob([head + "\n" + rows.join("\n")], { type: "text/csv" })); a.click();
  }
  destroy() { this.ro.disconnect(); }
}
