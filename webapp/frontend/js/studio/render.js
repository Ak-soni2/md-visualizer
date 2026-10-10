// WebGL2 renderer for the Studio: every atom is a shaded sphere impostor (a point sprite that writes its own
// per-pixel depth, so overlapping spheres intersect correctly), plus the simulation cell as lines.
// The same draw path renders the interactive viewport and off-screen images at any resolution for export.

const ATOM_VS = `#version 300 es
in vec3 a_pos; in vec3 a_col; in float a_rad;
uniform mat4 u_view, u_proj; uniform float u_vh, u_rscale;
out vec3 v_col; out float v_r; out float v_ze;
void main() {
  vec4 e = u_view * vec4(a_pos, 1.0);
  gl_Position = u_proj * e;
  float r = a_rad * u_rscale;
  gl_PointSize = max(1.0, r * u_vh * u_proj[1][1] / gl_Position.w);   // sphere diameter in pixels
  v_col = a_col; v_r = r; v_ze = e.z;
}`;
const ATOM_FS = `#version 300 es
precision highp float;
in vec3 v_col; in float v_r; in float v_ze;
uniform mat4 u_proj; uniform int u_flat;
out vec4 o;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0; c.y = -c.y;
  float d2 = dot(c, c);
  if (d2 > 1.0) discard;
  float nz = sqrt(1.0 - d2);
  float z = v_ze + nz * v_r;                                          // sphere surface, eye space
  float cz = u_proj[2][2] * z + u_proj[3][2], cw = u_proj[2][3] * z + u_proj[3][3];
  gl_FragDepth = 0.5 * (cz / cw) + 0.5;
  vec3 col = v_col;
  if (u_flat == 0) {
    vec3 n = vec3(c, nz), L = normalize(vec3(-0.35, 0.45, 1.0)), h = normalize(L + vec3(0.0, 0.0, 1.0));
    col = col * (0.32 + 0.68 * max(dot(n, L), 0.0)) + vec3(0.25 * pow(max(dot(n, h), 0.0), 40.0));
  }
  o = vec4(col, 1.0);
}`;
const LINE_VS = `#version 300 es
in vec3 a_pos; uniform mat4 u_view, u_proj;
void main() { gl_Position = u_proj * u_view * vec4(a_pos, 1.0); }`;
const LINE_FS = `#version 300 es
precision mediump float; uniform vec3 u_col; out vec4 o;
void main() { o = vec4(u_col, 1.0); }`;

// ------------------------------------------------------------------------------------------------ math
export const V = {
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: a => Math.hypot(a[0], a[1], a[2]),
  norm: a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
  rot(v, axis, ang) {                                                  // Rodrigues rotation
    const k = V.norm(axis), c = Math.cos(ang), s = Math.sin(ang), kv = V.cross(k, v), kd = V.dot(k, v);
    return [0, 1, 2].map(i => v[i] * c + kv[i] * s + k[i] * kd * (1 - c));
  },
};

function lookAt(eye, dir, up) {
  const f = V.norm(dir), s = V.norm(V.cross(f, up)), u = V.cross(s, f);
  return new Float32Array([s[0], u[0], -f[0], 0, s[1], u[1], -f[1], 0, s[2], u[2], -f[2], 0,
    -V.dot(s, eye), -V.dot(u, eye), V.dot(f, eye), 1]);
}
function ortho(hw, hh, n, f) {
  return new Float32Array([1 / hw, 0, 0, 0, 0, 1 / hh, 0, 0, 0, 0, -2 / (f - n), 0, 0, 0, -(f + n) / (f - n), 1]);
}
function persp(hh, aspect, n, f) {                                     // hh = tan(fovy/2)
  return new Float32Array([1 / (hh * aspect), 0, 0, 0, 0, 1 / hh, 0, 0, 0, 0, (f + n) / (n - f), -1, 0, 0, 2 * f * n / (n - f), 0]);
}
function mulVec(m, p) {                                                // column-major 4x4 * (p,1)
  return [0, 1, 2, 3].map(r => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
}

/** OVITO's standard viewports: view direction and up vector. */
export const VIEWS = {
  Top: { dir: [0, 0, -1], up: [0, 1, 0] }, Bottom: { dir: [0, 0, 1], up: [0, 1, 0] },
  Front: { dir: [0, 1, 0], up: [0, 0, 1] }, Back: { dir: [0, -1, 0], up: [0, 0, 1] },
  Left: { dir: [1, 0, 0], up: [0, 0, 1] }, Right: { dir: [-1, 0, 0], up: [0, 0, 1] },
  Ortho: { dir: V.norm([-1, -1, -1]), up: [0, 0, 1] },
  Surface: { dir: [0, -1, 0], up: [0, 0, -1] },          // not an OVITO view: onto a y-normal surface, x to the right
};

/** View + projection for a camera, an aspect ratio and the scene bounds. zoomK > 1 widens the view (preview frame). */
export function matrices(cam, aspect, scene, zoomK = 1) {
  const dir = V.norm(cam.dir), up = cam.up;
  const R = Math.max(scene.radius, 1), off = V.len(V.sub(cam.target, scene.center));
  let view, proj, eye;
  if (cam.proj === "persp") {
    const dist = cam.halfH / Math.tan(cam.fov / 2);
    eye = V.sub(cam.target, V.mul(dir, dist));
    const near = Math.max(dist * 0.01, dist - R - off), far = dist + R + off + 1;
    view = lookAt(eye, dir, up);
    proj = persp(Math.tan(cam.fov / 2) * zoomK, aspect, near, far);
  } else {
    const D = R + off + 10;
    eye = V.sub(cam.target, V.mul(dir, D));
    view = lookAt(eye, dir, up);
    const hh = cam.halfH * zoomK;
    proj = ortho(hh * aspect, hh, 0.5, 2 * D + R);
  }
  const vp = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0; for (let k = 0; k < 4; k++) s += proj[k * 4 + r] * view[c * 4 + k];
    vp[c * 4 + r] = s;
  }
  const right = V.norm(V.cross(dir, up)), trueUp = V.cross(right, dir);
  return { view, proj, vp, right, up: trueUp, dir };
}

/** World point -> pixel coordinates inside rect (x, y, w, h), plus clip w (for size) and NDC depth. */
export function project(vp, p, rect) {
  const c = mulVec(vp, p);
  return { x: rect.x + (c[0] / c[3] + 1) / 2 * rect.w, y: rect.y + (1 - c[1] / c[3]) / 2 * rect.h, w: c[3], z: c[2] / c[3] };
}

// ------------------------------------------------------------------------------------------------ renderer
function program(gl, vs, fs) {
  const mk = (type, src) => {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}

export class AtomRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", { antialias: true, preserveDrawingBuffer: false });
    if (!gl) throw new Error("WebGL2 is not available in this browser; the Studio needs it to draw atoms on the GPU.");
    this.gl = gl;
    this.atomProg = program(gl, ATOM_VS, ATOM_FS);
    this.lineProg = program(gl, LINE_VS, LINE_FS);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const buf = (loc, size, type, norm) => {
      const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
      const l = gl.getAttribLocation(this.atomProg, loc); gl.enableVertexAttribArray(l);
      gl.vertexAttribPointer(l, size, type, norm, 0, 0); return b;
    };
    this.bPos = buf("a_pos", 3, gl.FLOAT, false);
    this.bCol = buf("a_col", 3, gl.UNSIGNED_BYTE, true);
    this.bRad = buf("a_rad", 1, gl.FLOAT, false);
    this.bIdx = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.bIdx);
    gl.bindVertexArray(null);
    this.lineVao = gl.createVertexArray(); gl.bindVertexArray(this.lineVao);
    this.bLine = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.bLine);
    const ll = gl.getAttribLocation(this.lineProg, "a_pos"); gl.enableVertexAttribArray(ll); gl.vertexAttribPointer(ll, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.count = 0; this.cellVerts = 0;
    this.maxPoint = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1];
    this.maxImage = Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), ...gl.getParameter(gl.MAX_VIEWPORT_DIMS));
  }
  setPositions(xyz) { const gl = this.gl; gl.bindBuffer(gl.ARRAY_BUFFER, this.bPos); gl.bufferData(gl.ARRAY_BUFFER, xyz, gl.STATIC_DRAW); }
  setColors(rgb) { const gl = this.gl; gl.bindBuffer(gl.ARRAY_BUFFER, this.bCol); gl.bufferData(gl.ARRAY_BUFFER, rgb, gl.DYNAMIC_DRAW); }
  setRadii(r) { const gl = this.gl; gl.bindBuffer(gl.ARRAY_BUFFER, this.bRad); gl.bufferData(gl.ARRAY_BUFFER, r, gl.DYNAMIC_DRAW); }
  setIndices(idx) {
    const gl = this.gl; gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.bIdx); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.DYNAMIC_DRAW);
    gl.bindVertexArray(null); this.count = idx.length;
  }
  setCell(cell) {
    if (!cell) { this.cellVerts = 0; return; }
    const o = cell.origin, a = cell.a, b = cell.b, c = cell.c;
    const P = (i, j, k) => [0, 1, 2].map(d => o[d] + i * a[d] + j * b[d] + k * c[d]);
    const e = [];
    for (const [p, q] of [[[0, 0, 0], [1, 0, 0]], [[0, 1, 0], [1, 1, 0]], [[0, 0, 1], [1, 0, 1]], [[0, 1, 1], [1, 1, 1]],
      [[0, 0, 0], [0, 1, 0]], [[1, 0, 0], [1, 1, 0]], [[0, 0, 1], [0, 1, 1]], [[1, 0, 1], [1, 1, 1]],
      [[0, 0, 0], [0, 0, 1]], [[1, 0, 0], [1, 0, 1]], [[0, 1, 0], [0, 1, 1]], [[1, 1, 0], [1, 1, 1]]]) e.push(...P(...p), ...P(...q));
    const gl = this.gl; gl.bindBuffer(gl.ARRAY_BUFFER, this.bLine); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(e), gl.STATIC_DRAW);
    this.cellVerts = 24;
  }
  /** Draw into the bound framebuffer of size w x h. o: {view, proj, bg:[r,g,b,a], rscale, flat, cellColor|null} */
  _draw(w, h, o) {
    const gl = this.gl;
    gl.viewport(0, 0, w, h);
    gl.clearColor(...o.bg); gl.clearDepth(1); gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (this.count) {
      gl.useProgram(this.atomProg);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.atomProg, "u_view"), false, o.view);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.atomProg, "u_proj"), false, o.proj);
      gl.uniform1f(gl.getUniformLocation(this.atomProg, "u_vh"), h);
      gl.uniform1f(gl.getUniformLocation(this.atomProg, "u_rscale"), o.rscale ?? 1);
      gl.uniform1i(gl.getUniformLocation(this.atomProg, "u_flat"), o.flat ? 1 : 0);
      gl.bindVertexArray(this.vao);
      gl.drawElements(gl.POINTS, this.count, gl.UNSIGNED_INT, 0);
      gl.bindVertexArray(null);
    }
    if (this.cellVerts && o.cellColor) {
      gl.useProgram(this.lineProg);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.lineProg, "u_view"), false, o.view);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.lineProg, "u_proj"), false, o.proj);
      gl.uniform3fv(gl.getUniformLocation(this.lineProg, "u_col"), o.cellColor);
      gl.bindVertexArray(this.lineVao); gl.drawArrays(gl.LINES, 0, this.cellVerts); gl.bindVertexArray(null);
    }
  }
  draw(o) {
    const gl = this.gl; gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this._draw(this.canvas.width, this.canvas.height, o);
  }
  /** Off-screen render at W x H; returns a 2D canvas with the pixels (top row first). */
  renderImage(W, H, o) {
    if (W > this.maxImage || H > this.maxImage) throw new Error(`image larger than this GPU allows (${this.maxImage} px per side)`);
    const gl = this.gl;
    const fb = gl.createFramebuffer(), cb = gl.createRenderbuffer(), db = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, cb); gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, W, H);
    gl.bindRenderbuffer(gl.RENDERBUFFER, db); gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, W, H);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, cb);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, db);
    try {
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("off-screen framebuffer not available");
      this._draw(W, H, o);
      const px = new Uint8Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
      const c2 = cv.getContext("2d"), img = c2.createImageData(W, H), row = W * 4;
      for (let y = 0; y < H; y++) img.data.set(px.subarray((H - 1 - y) * row, (H - y) * row), y * row);
      c2.putImageData(img, 0, 0);
      return cv;
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fb); gl.deleteRenderbuffer(cb); gl.deleteRenderbuffer(db);
    }
  }
}
