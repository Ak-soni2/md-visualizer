// AtomViewer: the Visualizer's viewport. Atoms are drawn on the GPU by the Studio's renderer (studio/render.js:
// shaded sphere impostors with per-pixel depth, so overlapping atoms intersect correctly); overlays, picking and the
// camera stay on a 2D canvas on top. Orthographic camera: yaw/pitch about the scene centre, zoom, pan in pixels.
// Interface used by views/visualizer.js: setAtoms(), setColors(), setVisible(), setOverlays(), setOptions(),
// setView(), fit(), onHover, onViewChange, destroy().
import { AtomRenderer } from "./studio/render.js";

const DEG = Math.PI / 180;
const ATOM_RADIUS = 0.75;                                            // Å, drawn radius at atom size 1

export class AtomViewer {
  constructor(canvas, { background = "#0a0c0e" } = {}) {
    this.canvas = canvas;                                            // overlays + input
    this.gl = document.createElement("canvas");                      // atoms, behind it
    this.gl.setAttribute("aria-hidden", "true");
    canvas.before(this.gl);
    this.R = new AtomRenderer(this.gl);
    this.ctx = canvas.getContext("2d");
    this.bg = background;
    this.bgRgb = background.match(/\w\w/g).map(h => parseInt(h, 16) / 255);
    this.n = 0;
    this.cam = { yaw: 0, pitch: 0, zoom: 1, panX: 0, panY: 0 };
    this.opts = { pointScale: 1, axes: true, scale: true, surface: true, laser: true, outline: true, depthLine: true };
    this.overlays = {};
    this.onHover = null;
    this.onViewChange = null;
    this._dirty = false;
    this._bindInput();
    this.ro = new ResizeObserver(() => this.request());
    this.ro.observe(canvas);
  }

  /** x,y,z: number arrays; rgb: Uint8ClampedArray (3n); visible: Uint8Array (n) */
  setAtoms({ x, y, z, rgb, visible }, { keepView = true } = {}) {
    const n = x.length, firstData = !this.n;
    this.n = n;
    this.x = Float32Array.from(x); this.y = Float32Array.from(y); this.z = Float32Array.from(z);
    const p = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { p[3 * i] = this.x[i]; p[3 * i + 1] = this.y[i]; p[3 * i + 2] = this.z[i]; }
    this.R.setPositions(p);
    this.R.setRadii(new Float32Array(n).fill(ATOM_RADIUS));
    this.setColors(rgb);
    this.setVisible(visible || new Uint8Array(n).fill(1));
    if (firstData || !keepView) this.fit();
  }
  setColors(rgb) { this.rgb = rgb; this.R.setColors(rgb); this.request(); }
  setVisible(vis) {
    this.visible = vis;
    let m = 0;
    for (let i = 0; i < this.n; i++) if (vis[i]) m++;
    const idx = new Uint32Array(m);
    for (let i = 0, k = 0; i < this.n; i++) if (vis[i]) idx[k++] = i;
    this.R.setIndices(idx);
    this._bounds = null;
    this.request();
  }
  setOverlays(o) { this.overlays = o || {}; this.request(); }
  setOptions(o) { Object.assign(this.opts, o); this.request(); }

  bounds() {
    if (this._bounds) return this._bounds;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < this.n; i++) {
      if (!this.visible[i]) continue;
      const a = this.x[i], b = this.y[i], c = this.z[i];
      if (a < x0) x0 = a; if (a > x1) x1 = a; if (b < y0) y0 = b; if (b > y1) y1 = b; if (c < z0) z0 = c; if (c > z1) z1 = c;
    }
    this._bounds = Number.isFinite(x0) ? { x0, x1, y0, y1, z0, z1 } : { x0: 0, x1: 1, y0: 0, y1: 1, z0: 0, z1: 1 };
    return this._bounds;
  }
  fit() {
    const b = this.bounds();
    this.center = [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2];
    this.extent = Math.max(b.x1 - b.x0, b.y1 - b.y0, b.z1 - b.z0, 1);
    this.cam.zoom = 1; this.cam.panX = 0; this.cam.panY = 0;
    this.request(); this.onViewChange?.(this.cam);
  }
  setView(name) {
    const v = { front: [0, 0], top: [0, 90], side: [90, 0], iso: [-32, 24] }[name];
    if (!v) return;
    this.cam.yaw = v[0] * DEG; this.cam.pitch = v[1] * DEG;
    this.fit();
  }

  request() { if (!this._dirty) { this._dirty = true; requestAnimationFrame(() => { this._dirty = false; this.render(); }); } }

  /** pixels per Å: fits the projected extent of the current view */
  _scale(W, H) {
    const b = this.bounds();
    const cy = Math.cos(this.cam.yaw), sy = Math.sin(this.cam.yaw), cp = Math.cos(this.cam.pitch), sp = Math.sin(this.cam.pitch);
    const dx = b.x1 - b.x0, dy = b.y1 - b.y0, dz = b.z1 - b.z0;
    const w = Math.abs(cy) * dx + Math.abs(sy) * dz;
    const h = Math.abs(cp) * dy + Math.abs(sp) * (Math.abs(sy) * dx + Math.abs(cy) * dz);
    const fitView = 0.9 * Math.min(W / Math.max(w, 1), H / Math.max(h, 1));
    return (Number.isFinite(fitView) ? fitView : 0.9 * Math.min(W, H) / (this.extent || 1)) * this.cam.zoom;
  }
  /** rows of the camera rotation: screen right (x1), screen up (y2), towards the viewer (z2) */
  _axes() {
    const cy = Math.cos(this.cam.yaw), sy = Math.sin(this.cam.yaw), cp = Math.cos(this.cam.pitch), sp = Math.sin(this.cam.pitch);
    return [[cy, 0, sy], [sp * sy, cp, -sp * cy], [-cp * sy, sp, cp * cy]];
  }
  project(px, py, pz, W, H, s) {
    const [r, u, f] = this._axes(), X = px - this.center[0], Y = py - this.center[1], Z = pz - this.center[2];
    return [W / 2 + this.cam.panX + (r[0] * X + r[1] * Y + r[2] * Z) * s, H / 2 + this.cam.panY - (u[0] * X + u[1] * Y + u[2] * Z) * s, f[0] * X + f[1] * Y + f[2] * Z];
  }

  render() {
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(this.canvas.clientWidth * dpr)), H = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    for (const c of [this.canvas, this.gl]) if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const g = this.ctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    const bg = [...this.bgRgb, 1];
    if (!this.n) { this.R.setIndices(new Uint32Array(0)); this.R.draw({ view: new Float32Array(16), proj: new Float32Array(16), bg }); return; }
    const s = this._scale(W, H);
    this._s = s; this._W = W; this._H = H; this._dpr = dpr;
    // view: rotate about the centre and push the scene in front of the camera; projection: orthographic, s px per Å
    const [r, u, f] = this._axes(), c = this.center, b = this.bounds();
    const dc = Math.hypot(Math.max(Math.abs(b.x0 - c[0]), Math.abs(b.x1 - c[0])), Math.max(Math.abs(b.y0 - c[1]), Math.abs(b.y1 - c[1])), Math.max(Math.abs(b.z0 - c[2]), Math.abs(b.z1 - c[2])));
    const D = dc + 10, dot = (a, v) => a[0] * v[0] + a[1] * v[1] + a[2] * v[2];
    const view = new Float32Array([r[0], u[0], f[0], 0, r[1], u[1], f[1], 0, r[2], u[2], f[2], 0, -dot(r, c), -dot(u, c), -dot(f, c) - D, 1]);
    const hw = W / (2 * s), hh = H / (2 * s), near = 0.1, far = 2 * D;
    const proj = new Float32Array([1 / hw, 0, 0, 0, 0, 1 / hh, 0, 0, 0, 0, -2 / (far - near), 0,
      this.cam.panX / (W / 2), -this.cam.panY / (H / 2), -(far + near) / (far - near), 1]);
    this.R.draw({ view, proj, bg, rscale: this.opts.pointScale });
    this._drawOverlays(W, H, s, dpr);
  }

  _drawOverlays(W, H, s, dpr) {
    const g = this.ctx, o = this.overlays, b = this.bounds();
    const zc = this.center[2];
    const P = (x, y, z = zc) => this.project(x, y, z, W, H, s);
    g.lineWidth = 1.2 * dpr;
    const line = (pts, color, dash) => {
      g.strokeStyle = color; g.setLineDash(dash ? dash.map(d => d * dpr) : []);
      g.beginPath(); pts.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.stroke(); g.setLineDash([]);
    };
    if (this.opts.surface && Number.isFinite(o.ySurface)) {
      const a = P(b.x0 - 20, o.ySurface), c = P(b.x1 + 20, o.ySurface);
      line([a, c], "rgba(233,230,223,0.55)", [5, 4]);
      label(g, "undeformed surface", a[0] + 6 * dpr, a[1] - 6 * dpr, dpr, "rgba(233,230,223,0.7)");
    }
    if (this.opts.depthLine && Number.isFinite(o.depthLine)) {
      const a = P(b.x0 - 20, o.depthLine), c = P(b.x1 + 20, o.depthLine);
      line([a, c], "rgba(223,107,93,0.7)", [3, 4]);
      label(g, "depth of cut", a[0] + 6 * dpr, a[1] + 14 * dpr, dpr, "rgba(223,107,93,0.85)");
    }
    if (this.opts.outline && o.outline?.length) {
      line(o.outline.map(([x, y]) => P(x, y)).concat([P(o.outline[0][0], o.outline[0][1])]), "rgba(223,107,93,0.9)");
    }
    if (this.opts.laser && o.laser && Number.isFinite(o.laser.r)) {
      const pts = [];
      for (let k = 0; k <= 64; k++) { const t = k / 64 * 2 * Math.PI; pts.push(P(o.laser.x + o.laser.r * Math.cos(t), o.laser.y + o.laser.r * Math.sin(t))); }
      g.fillStyle = "rgba(240,180,83,0.10)"; g.beginPath(); pts.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.fill();
      line(pts, "rgba(240,180,83,0.9)");
      const c = P(o.laser.x, o.laser.y + o.laser.r);
      label(g, "laser zone", c[0] - 26 * dpr, c[1] - 6 * dpr, dpr, "rgba(240,180,83,0.95)");
    }
    if (this.opts.axes) this._triad(W, H, dpr);
    if (this.opts.scale) this._scalebar(W, H, s, dpr);
  }
  _triad(W, H, dpr) {
    const g = this.ctx, L = 26 * dpr, ox = 30 * dpr, oy = H - 64 * dpr, [r, u] = this._axes();
    g.font = `${11 * dpr}px ${getComputedStyle(document.body).fontFamily}`;
    for (const [n, k, c] of [["x", 0, "#df6b5d"], ["y", 1, "#93b26a"], ["z", 2, "#6f9fd6"]]) {
      const x1 = r[k], y2 = u[k];
      if (Math.hypot(x1, y2) < 0.08) { g.fillStyle = c; g.fillText(n + "·", ox - 3 * dpr, oy + 4 * dpr); continue; }
      g.strokeStyle = c; g.lineWidth = 1.6 * dpr; g.beginPath(); g.moveTo(ox, oy); g.lineTo(ox + x1 * L, oy - y2 * L); g.stroke();
      g.fillStyle = c; g.fillText(n, ox + x1 * (L + 8 * dpr) - 3 * dpr, oy - y2 * (L + 8 * dpr) + 4 * dpr);
    }
  }
  _scalebar(W, H, s, dpr) {
    const g = this.ctx, target = 120 * dpr / s;                            // Å for ~120 px
    const p = 10 ** Math.floor(Math.log10(target)), f = target / p, nice = (f < 2 ? 1 : f < 5 ? 2 : 5) * p;
    const px = nice * s, x1 = W - 20 * dpr, x0 = x1 - px, y = H - 22 * dpr;
    g.strokeStyle = "rgba(233,230,223,0.8)"; g.lineWidth = 2 * dpr; g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y);
    g.moveTo(x0, y - 4 * dpr); g.lineTo(x0, y + 4 * dpr); g.moveTo(x1, y - 4 * dpr); g.lineTo(x1, y + 4 * dpr); g.stroke();
    label(g, nice >= 10 ? `${nice / 10} nm` : `${nice} Å`, x0 + px / 2 - 14 * dpr, y - 8 * dpr, dpr, "rgba(233,230,223,0.85)");
  }

  /** index of the front-most visible atom whose drawn disc contains the cursor, or -1 */
  pick(clientX, clientY) {
    if (!this.n || !this._W) return -1;
    const rc = this.canvas.getBoundingClientRect(), dpr = this._dpr, W = this._W, H = this._H, s = this._s;
    const px = (clientX - rc.left) * dpr, py = (clientY - rc.top) * dpr;
    const rad = Math.max(4 * dpr, ATOM_RADIUS * s * this.opts.pointScale);
    const [r, u, f] = this._axes(), [ox, oy, oz] = this.center, hw = W / 2 + this.cam.panX, hh = H / 2 + this.cam.panY;
    let best = -1, bestDepth = -Infinity;
    for (let i = 0; i < this.n; i++) {
      if (!this.visible[i]) continue;
      const X = this.x[i] - ox, Y = this.y[i] - oy, Z = this.z[i] - oz;
      const dx = hw + (r[0] * X + r[1] * Y + r[2] * Z) * s - px, dy = hh - (u[0] * X + u[1] * Y + u[2] * Z) * s - py;
      if (dx * dx + dy * dy > rad * rad) continue;
      const d = f[0] * X + f[1] * Y + f[2] * Z;
      if (d > bestDepth) { best = i; bestDepth = d; }
    }
    return best;
  }

  _bindInput() {
    const c = this.canvas;
    c.tabIndex = 0;
    let drag = null, hoverRaf = 0;
    c.addEventListener("contextmenu", e => e.preventDefault());
    c.addEventListener("pointerdown", e => { c.setPointerCapture(e.pointerId); drag = { x: e.clientX, y: e.clientY, pan: e.shiftKey || e.button !== 0 }; });
    c.addEventListener("pointerup", e => { drag = null; c.releasePointerCapture?.(e.pointerId); });
    c.addEventListener("pointermove", e => {
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
        const dpr = window.devicePixelRatio || 1;
        if (drag.pan) { this.cam.panX += dx * dpr; this.cam.panY += dy * dpr; }
        else { this.cam.yaw += dx * 0.4 * DEG; this.cam.pitch = Math.max(-90 * DEG, Math.min(90 * DEG, this.cam.pitch + dy * 0.4 * DEG)); }
        this.request(); this.onViewChange?.(this.cam);
        return;
      }
      if (this.onHover && !hoverRaf) {
        hoverRaf = requestAnimationFrame(() => { hoverRaf = 0; this.onHover(this.pick(e.clientX, e.clientY)); });
      }
    });
    c.addEventListener("pointerleave", () => this.onHover?.(-1));
    c.addEventListener("wheel", e => {
      e.preventDefault();
      const r = c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
      const mx = (e.clientX - r.left) * dpr - c.width / 2, my = (e.clientY - r.top) * dpr - c.height / 2;
      const k = Math.exp(-e.deltaY * 0.0015), z0 = this.cam.zoom, z1 = Math.max(0.2, Math.min(80, z0 * k)), f = z1 / z0;
      this.cam.panX = mx - (mx - this.cam.panX) * f; this.cam.panY = my - (my - this.cam.panY) * f; this.cam.zoom = z1;
      this.request(); this.onViewChange?.(this.cam);
    }, { passive: false });
    c.addEventListener("dblclick", () => this.fit());
    c.addEventListener("keydown", e => {
      const st = 5 * DEG, dpr = window.devicePixelRatio || 1;
      const map = {
        ArrowLeft: () => e.shiftKey ? (this.cam.panX -= 30 * dpr) : (this.cam.yaw -= st),
        ArrowRight: () => e.shiftKey ? (this.cam.panX += 30 * dpr) : (this.cam.yaw += st),
        ArrowUp: () => e.shiftKey ? (this.cam.panY -= 30 * dpr) : (this.cam.pitch = Math.max(-90 * DEG, this.cam.pitch - st)),
        ArrowDown: () => e.shiftKey ? (this.cam.panY += 30 * dpr) : (this.cam.pitch = Math.min(90 * DEG, this.cam.pitch + st)),
        "+": () => (this.cam.zoom = Math.min(80, this.cam.zoom * 1.2)), "=": () => (this.cam.zoom = Math.min(80, this.cam.zoom * 1.2)),
        "-": () => (this.cam.zoom = Math.max(0.2, this.cam.zoom / 1.2)), "0": () => this.fit(),
      };
      if (map[e.key]) { e.preventDefault(); e.stopPropagation(); map[e.key](); this.request(); this.onViewChange?.(this.cam); }
    });
  }
  destroy() { this.ro.disconnect(); this.gl.remove(); this.R.gl.getExtension("WEBGL_lose_context")?.loseContext(); }
}

function label(g, text, x, y, dpr, color) {
  g.font = `${11 * dpr}px ${getComputedStyle(document.body).fontFamily}`;
  g.fillStyle = color; g.fillText(text, x, y);
}
