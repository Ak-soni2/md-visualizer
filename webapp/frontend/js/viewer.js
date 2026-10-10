// AtomViewer: CPU canvas renderer for MD snapshots (tens to hundreds of thousands of atoms).
// Orthographic camera, painter's algorithm (back to front), depth shading, hover picking, overlays.
// Kept independent of the data source so the existing MD renderer (or a WebGL engine) can replace it later
// behind the same small interface: setAtoms(), setOverlays(), setView(), fit(), onHover.

const DEG = Math.PI / 180;

export class AtomViewer {
  constructor(canvas, { background = "#0a0c0e" } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.bg = background;
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
    const n = x.length;
    const firstData = !this.n;
    this.n = n;
    this.x = Float32Array.from(x); this.y = Float32Array.from(y); this.z = Float32Array.from(z);
    this.rgb = rgb; this.visible = visible || new Uint8Array(n).fill(1);
    this.sx = new Float32Array(n); this.sy = new Float32Array(n); this.depth = new Float32Array(n);
    this.order = new Uint32Array(n);
    if (firstData || !keepView) this.fit();
    this.request();
  }
  setColors(rgb) { this.rgb = rgb; this.request(); }
  setVisible(vis) { this.visible = vis; this.request(); }
  setOverlays(o) { this.overlays = o || {}; this.request(); }
  setOptions(o) { Object.assign(this.opts, o); this.request(); }

  bounds() {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < this.n; i++) {
      if (!this.visible[i]) continue;
      const a = this.x[i], b = this.y[i], c = this.z[i];
      if (a < x0) x0 = a; if (a > x1) x1 = a; if (b < y0) y0 = b; if (b > y1) y1 = b; if (c < z0) z0 = c; if (c > z1) z1 = c;
    }
    if (!Number.isFinite(x0)) return { x0: 0, x1: 1, y0: 0, y1: 1, z0: 0, z1: 1 };
    return { x0, x1, y0, y1, z0, z1 };
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

  _scale(W, H) {
    const b = this.bounds();
    const ext = this.extent || 1;
    const fit = 0.9 * Math.min(W, H * 1.0) / ext;
    // fit the projected extent of the current view rather than the 3D diagonal
    const cy = Math.cos(this.cam.yaw), sy = Math.sin(this.cam.yaw), cp = Math.cos(this.cam.pitch), sp = Math.sin(this.cam.pitch);
    const dx = b.x1 - b.x0, dy = b.y1 - b.y0, dz = b.z1 - b.z0;
    const w = Math.abs(cy) * dx + Math.abs(sy) * dz;
    const h = Math.abs(cp) * dy + Math.abs(sp) * (Math.abs(sy) * dx + Math.abs(cy) * dz);
    const fitView = 0.9 * Math.min(W / Math.max(w, 1), H / Math.max(h, 1));
    return (Number.isFinite(fitView) ? fitView : fit) * this.cam.zoom;
  }

  project(px, py, pz, W, H, s) {
    const cy = Math.cos(this.cam.yaw), sy = Math.sin(this.cam.yaw), cp = Math.cos(this.cam.pitch), sp = Math.sin(this.cam.pitch);
    const X = px - this.center[0], Y = py - this.center[1], Z = pz - this.center[2];
    const x1 = cy * X + sy * Z, z1 = -sy * X + cy * Z;
    const y2 = cp * Y - sp * z1, z2 = sp * Y + cp * z1;
    return [W / 2 + this.cam.panX + x1 * s, H / 2 + this.cam.panY - y2 * s, z2];
  }

  render() {
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(this.canvas.clientWidth * dpr)), H = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    const g = this.ctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = this.bg; g.fillRect(0, 0, W, H);
    if (!this.n) return;
    const s = this._scale(W, H);
    this._s = s; this._W = W; this._H = H; this._dpr = dpr;
    const cy = Math.cos(this.cam.yaw), sy = Math.sin(this.cam.yaw), cp = Math.cos(this.cam.pitch), sp = Math.sin(this.cam.pitch);
    const [ox, oy, oz] = this.center, hw = W / 2 + this.cam.panX, hh = H / 2 + this.cam.panY;
    let m = 0, dmin = Infinity, dmax = -Infinity;
    for (let i = 0; i < this.n; i++) {
      if (!this.visible[i]) { this.sx[i] = -1e9; continue; }
      const X = this.x[i] - ox, Y = this.y[i] - oy, Z = this.z[i] - oz;
      const x1 = cy * X + sy * Z, z1 = -sy * X + cy * Z;
      const y2 = cp * Y - sp * z1, z2 = sp * Y + cp * z1;
      const qx = hw + x1 * s, qy = hh - y2 * s;
      this.sx[i] = qx; this.sy[i] = qy; this.depth[i] = z2;
      if (qx < -10 || qy < -10 || qx > W + 10 || qy > H + 10) continue;
      this.order[m++] = i;
      if (z2 < dmin) dmin = z2; if (z2 > dmax) dmax = z2;
    }
    const ord = this.order.subarray(0, m);
    const dep = this.depth;
    ord.sort((a, b) => dep[a] - dep[b]);                       // far first, near last (painter's algorithm)
    // point size from physical atom size (~0.75 Å radius), clamped
    const ps = Math.max(1, Math.min(14, Math.round(1.5 * s * this.opts.pointScale)));
    const disc = discMask(ps);
    const img = g.createImageData(W, H);
    const buf = new Uint32Array(img.data.buffer);
    const bgc = this.bg.match(/\w\w/g).map(h => parseInt(h, 16));
    buf.fill((255 << 24) | (bgc[2] << 16) | (bgc[1] << 8) | bgc[0]);
    const span = dmax - dmin || 1, rgb = this.rgb, half = (ps - 1) >> 1;
    for (let k = 0; k < m; k++) {
      const i = ord[k];
      const shade = 0.6 + 0.4 * ((dep[i] - dmin) / span);
      const r = rgb[i * 3] * shade, gg = rgb[i * 3 + 1] * shade, b = rgb[i * 3 + 2] * shade;
      const col = (255 << 24) | ((b & 255) << 16) | ((gg & 255) << 8) | (r & 255);
      const cx = Math.round(this.sx[i]) - half, cyy = Math.round(this.sy[i]) - half;
      for (let d = 0; d < disc.length; d += 2) {
        const px = cx + disc[d], py = cyy + disc[d + 1];
        if (px >= 0 && py >= 0 && px < W && py < H) buf[py * W + px] = col;
      }
      // a darker rim on larger atoms helps separate neighbours
      if (ps >= 5) {
        const rim = (255 << 24) | (((b * 0.55) & 255) << 16) | (((gg * 0.55) & 255) << 8) | ((r * 0.55) & 255);
        for (let d = 0; d < disc.rim.length; d += 2) {
          const px = cx + disc.rim[d], py = cyy + disc.rim[d + 1];
          if (px >= 0 && py >= 0 && px < W && py < H) buf[py * W + px] = rim;
        }
      }
    }
    g.putImageData(img, 0, 0);
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
    const g = this.ctx, L = 26 * dpr, ox = 30 * dpr, oy = H - 64 * dpr;
    const cy = Math.cos(this.cam.yaw), sy = Math.sin(this.cam.yaw), cp = Math.cos(this.cam.pitch), sp = Math.sin(this.cam.pitch);
    const axes = [["x", 1, 0, 0, "#df6b5d"], ["y", 0, 1, 0, "#93b26a"], ["z", 0, 0, 1, "#6f9fd6"]];
    g.font = `${11 * dpr}px ${getComputedStyle(document.body).fontFamily}`;
    for (const [n, X, Y, Z, c] of axes) {
      const x1 = cy * X + sy * Z, z1 = -sy * X + cy * Z, y2 = cp * Y - sp * z1;
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

  pick(clientX, clientY) {
    if (!this.n || !this._W) return -1;
    const r = this.canvas.getBoundingClientRect(), dpr = this._dpr;
    const px = (clientX - r.left) * dpr, py = (clientY - r.top) * dpr;
    const rad = Math.max(4 * dpr, 1.5 * this._s * this.opts.pointScale);
    let best = -1, bestDepth = -Infinity;
    for (let i = 0; i < this.n; i++) {
      if (!this.visible[i]) continue;
      const dx = this.sx[i] - px, dy = this.sy[i] - py;
      if (dx * dx + dy * dy <= rad * rad && this.depth[i] > bestDepth) { best = i; bestDepth = this.depth[i]; }
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
  destroy() { this.ro.disconnect(); }
}

const discCache = new Map();
function discMask(ps) {
  if (discCache.has(ps)) return discCache.get(ps);
  const pts = [], rim = [], r = ps / 2, c = (ps - 1) / 2;
  for (let j = 0; j < ps; j++) for (let i = 0; i < ps; i++) {
    const d = Math.hypot(i - c, j - c);
    if (ps <= 3 || d <= r) { pts.push(i, j); if (ps >= 5 && d > r - 1.1) rim.push(i, j); }
  }
  const out = Int16Array.from(pts); out.rim = Int16Array.from(rim);
  discCache.set(ps, out);
  return out;
}
function label(g, text, x, y, dpr, color) {
  g.font = `${11 * dpr}px ${getComputedStyle(document.body).fontFamily}`;
  g.fillStyle = color; g.fillText(text, x, y);
}
