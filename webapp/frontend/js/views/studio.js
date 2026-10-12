// Studio: a small OVITO-style workstation for any LAMMPS dump. Open a folder or dump files from this computer (read in
// the browser, never uploaded) or a path the backend can see; frames are parsed one at a time (studio/source.js).
// Everything below (pipeline, colouring, slicing, selection, overlays, picking, measuring, image export) runs here.
import * as api from "../api.js";
import { state } from "../state.js";
import { el, clear, tabs, toast, num, bytes, svg, download, loading, errorState } from "../ui.js";
import { AtomRenderer, VIEWS, matrices, V } from "../studio/render.js";
import { MODIFIERS, newModifier, evaluate, neededColumns, displacementRef, GRADIENTS, OP_LIST, TYPE_PALETTE, hexToRgb } from "../studio/pipeline.js";
import { drawOverlays, defaultOverlays, ALIGNS, measureValue, fmtVal } from "../studio/overlays.js";
import { serverSource, browserSource } from "../studio/source.js";
import { canEncode, canWriteFolder, pickCodec, mp4Writer, pngFolderWriter } from "../studio/movie.js";
import { buildFramesPanel, exportDefaults } from "./ovito_frames.js";

const KEY = "nanocut.studio.v1";
const defaults = () => ({
  pipeline: [], types: {}, overlays: defaultOverlays(),
  render: { w: 1600, h: 1000, bg: "#ffffff", transparent: false, ss: 2, preview: true, name: "", dt_fs: null,
    movie: { from: 0, to: null, every: 1, fps: 10, format: "mp4", quality: "high" } },
  viewport: { proj: "ortho", rscale: 1, flat: false, cell: false, view: "Top" },
  analysis: { normal: "y", width: "z", surface: null, thr: 1 },
  measureAxis: "y", recent: [], last: null, sideTab: "pipeline", lastDir: "", export: exportDefaults(),
});
function loadSession(raw) {
  const d = defaults();
  let s = raw;
  if (!s) try { s = JSON.parse(localStorage.getItem(KEY) || "null"); } catch { s = null; }
  if (!s || typeof s !== "object") return d;
  for (const k of ["render", "viewport", "analysis"]) d[k] = { ...d[k], ...(s[k] || {}) };
  d.render.movie = { ...defaults().render.movie, ...(s.render?.movie || {}) };
  d.overlays = { ...d.overlays, ...(s.overlays || {}) };
  d.overlays.legend = { ...defaultOverlays().legend, ...(s.overlays?.legend || {}) };
  d.overlays.tripod = { ...defaultOverlays().tripod, ...(s.overlays?.tripod || {}) };
  for (const k of ["pipeline", "recent"]) if (Array.isArray(s[k])) d[k] = s[k];
  d.pipeline = d.pipeline.filter(m => MODIFIERS[m.type]);
  d.overlays.measures = (d.overlays.measures || []).filter(m => m.source);   // lines from before they were tied to a trajectory
  d.types = s.types || {}; d.measureAxis = s.measureAxis || "y"; d.last = s.last || null;
  for (const k of ["sideTab", "lastDir"]) if (typeof s[k] === "string") d[k] = s[k];
  d.export = { ...exportDefaults(), ...(s.export || {}) };
  return d;
}
const strip = (k, v) => (k.startsWith("_") ? undefined : v);

// ------------------------------------------------------------------------------------------------ small form helpers
const numIn = (val, on, attrs = {}) => el("input", { class: "input num", type: "number", step: "any", value: val ?? "", onchange: e => on(e.target.value === "" ? null : +e.target.value), ...attrs });
const txtIn = (val, on, attrs = {}) => el("input", { class: "input", type: "text", value: val ?? "", onchange: e => on(e.target.value), ...attrs });
const colIn = (val, on, label) => el("input", { class: "color", type: "color", value: val, "aria-label": label, oninput: e => on(e.target.value) });
const sel = (opts, val, on, label) => el("select", { class: "select", "aria-label": label, onchange: e => on(e.target.value) },
  opts.map(o => { const [v, l] = Array.isArray(o) ? o : [o, o]; return el("option", { value: v, selected: String(v) === String(val) }, l); }));
const chk = (label, val, on, tip) => el("label", { class: "check", "data-tip": tip }, el("input", { type: "checkbox", checked: !!val, onchange: e => on(e.target.checked) }), label);
const row = (label, ...c) => el("label", { class: "frow" }, el("span", {}, label), el("div", { class: "fctl" }, ...c));   // label names its first control
const sec = (title, ...kids) => el("section", { class: "st-sec" }, el("h4", {}, title), ...kids);
const VIEW_TIP = {
  Top: "Top: looking down −z; x right, y up (side view of a NanoCut workpiece, surface normal y)",
  Bottom: "Bottom: looking up +z; −x right, y up",
  Front: "Front: looking along +y; x right, z up (from below a NanoCut surface)",
  Back: "Back: looking along −y; −x right, z up",
  Left: "Left: looking along +x; −y right, z up",
  Right: "Right: looking along −x; y right, z up",
  Ortho: "Oblique orthographic view from (1, 1, 1)",
  Surface: "Looking down −y onto a NanoCut surface (normal y); x right, −z up. Not an OVITO standard view.",
};
const COL_LABEL = { x: "x (Å)", y: "y (Å)", z: "z (Å)", dx: "dx (Å)", dy: "dy (Å)", dz: "dz (Å)", displacement: "|displacement| (Å)", v_magnitude: "|v| (velocity units)" };

export async function render(root) {
  const live = api.apiMode() === "live";
  const S = loadSession();
  let saveT = 0;
  const save = () => { clearTimeout(saveT); saveT = setTimeout(() => { try { localStorage.setItem(KEY, JSON.stringify(S, strip)); } catch { /* storage unavailable: settings live for this visit only */ } }, 300); };

  // ---------------------------------------------------------------------------------------------- layout
  const pathIn = el("input", { class: "input path", type: "text", list: "st-paths", placeholder: "Folder or dump file, e.g. D:\\Akshay\\Cutting_20_30\\AE", "aria-label": "Folder or dump file", value: S.last?.path || "" });
  const pathList = el("datalist", { id: "st-paths" });
  const seqSel = el("select", { class: "select seq", "aria-label": "Trajectory found in the folder", hidden: true });
  const openBtn = el("button", { class: "btn", type: "button", "data-tip": "Folder or file the backend can read (the bundled runs on the hosted version)" }, "Open path");
  const pickDir = el("input", { type: "file", webkitdirectory: "", multiple: true, hidden: true, onchange: e => { scanFiles(e.target.files); e.target.value = ""; } });
  const pickFiles = el("input", { type: "file", multiple: true, hidden: true, onchange: e => { scanFiles(e.target.files); e.target.value = ""; } });
  const localDlg = live && !api.apiHosted();
  const openFolder = () => (localDlg ? localPick("folder") : pickDir.click());
  const openFiles = () => (localDlg ? localPick("files") : pickFiles.click());
  const dirBtn = el("button", { class: "btn primary", type: "button", "data-tip": localDlg ? "Choose a folder on this computer; read in place, nothing is copied" : "Read a folder of dumps from this computer in the browser. Nothing is uploaded.", onclick: openFolder }, "Open folder…");
  const filesBtn = el("button", { class: "btn", type: "button", "data-tip": localDlg ? "Choose one file (its numbered series is detected, like OVITO) or several; read in place" : "One multi-frame dump, or several frame files (also .gz). Read in the browser.", onclick: openFiles }, localDlg ? "Open file(s)…" : "Open files…");
  if (!live) { pathIn.hidden = true; openBtn.hidden = true; }
  const bar = el("div", { class: "st-bar" }, svg("folder"), dirBtn, filesBtn, pickDir, pickFiles, pathIn, pathList, openBtn, seqSel, el("span", { class: "st-src muted" }));
  const glc = el("canvas", { class: "gl", "aria-hidden": "true" });
  const ovc = el("canvas", { class: "ov", tabindex: "0", role: "img", "aria-label": "Atom viewport. Drag to rotate, right-drag or Shift-drag to pan, wheel to zoom, double-click to zoom all, click an atom to inspect it." });
  const hud = el("div", { class: "st-hud" });
  const pickHud = el("div", { class: "st-pick", hidden: true });
  const tools = el("div", { class: "st-tools" });
  const overlayState = el("div", { class: "st-state" });
  const stage = el("div", { class: "st-stage" }, glc, ovc, hud, pickHud, tools, overlayState);
  const side = el("aside", { class: "st-side", "aria-label": "Studio panels" });
  const time = el("div", { class: "st-time" });
  root.append(el("div", { class: "studio" }, bar, stage, side, time));

  let R;
  try { R = new AtomRenderer(glc); }
  catch (e) { clear(stage).append(errorState(e)); return; }

  // ---------------------------------------------------------------------------------------------- state
  let SRC = serverSource, src = null, fi = 0, frame = null, out = null, cam = null, scene = { center: [0, 0, 0], radius: 100 };
  let picked = null, measureA = null, measuring = false, playing = false, loadTok = 0, alive = true, raf = 0;
  const modStatus = new Map();

  // ---------------------------------------------------------------------------------------------- source
  function fillPaths() {
    clear(pathList);
    const runs = state.sims.filter(s => s.kind === "run" && s.n_frames).map(s => s.path);
    [...new Set([...S.recent, ...runs])].forEach(p => pathList.append(el("option", { value: p })));
  }
  fillPaths();

  /** local backend: system dialog -> real path -> the backend reads the dumps in place */
  async function localPick(kind) {
    let r;
    try { r = (await api.post("/api/local/pick", { kind, start: S.lastDir || "" }, 1800000)).body; }
    catch (e) { if (e.status === 501) { toast("No system dialog here: reading in the browser instead.", "warn"); (kind === "folder" ? pickDir : pickFiles).click(); } else toast(e.message, "err"); return; }
    const paths = kind === "folder" ? (r.path ? [r.path] : []) : r.paths || [];
    if (!paths.length) return;
    const dir = kind === "folder" ? paths[0] : paths[0].replace(/[\\/][^\\/]*$/, "");
    S.lastDir = dir; save();
    const target = kind === "folder" || paths.length > 1 ? dir : paths[0];   // one file: its whole numbered series is offered first
    pathIn.value = target; scanAndOpen(target);
  }
  async function scanAndOpen(path) {
    path = (path || "").trim().replace(/^"|"$/g, "");
    if (!path) { toast("Enter a folder or a dump file path.", "warn"); pathIn.focus(); return; }
    busy("Looking for LAMMPS dump files…");
    let r;
    try { r = await serverSource.scan(path); }
    catch (e) { idle(); return showState(errorState(e)); }
    SRC = serverSource;
    await showSequences(path, r);
  }

  async function scanFiles(list) {
    if (!list?.length) return;
    busy(`Looking for LAMMPS dump files in ${num(list.length)} file${list.length > 1 ? "s" : ""}…`);
    let r;
    try { r = await browserSource.scan(list); }
    catch (e) { idle(); return showState(errorState(e)); }
    SRC = browserSource;
    await showSequences(r.path, r);
  }

  async function showSequences(path, r) {
    if (!r.sequences.length) { idle(); return showState(el("div", { class: "state err" }, el("b", {}, "No LAMMPS dump found"), el("span", {}, `Nothing starting with 'ITEM: TIMESTEP' in ${r.path} or the two folder levels below it.`))); }
    clear(seqSel);
    r.sequences.forEach((s, i) => seqSel.append(el("option", { value: i }, `${s.dir.split(/[\\/]/).slice(-1)[0]}/${s.pattern} · ${s.count} file${s.count > 1 ? "s" : ""} · ${bytes(s.bytes)}`)));
    seqSel.hidden = r.sequences.length < 2;
    seqSel.onchange = () => openSeq(path, r.sequences[+seqSel.value]);
    const prev = S.last && S.last.path === path ? r.sequences.findIndex(s => s.dir === S.last.dir && s.pattern === S.last.pattern) : -1;
    seqSel.value = String(Math.max(0, prev));
    await openSeq(path, r.sequences[Math.max(0, prev)]);
  }

  async function openSeq(path, seq, refresh = false) {
    stop();
    busy(`Indexing ${seq.pattern}…`);
    try {
      src = await SRC.open(seq, refresh, progress);
    } catch (e) { idle(); return showState(errorState(e)); }
    const local = SRC === browserSource;
    if (!local) S.recent = [path, ...S.recent.filter(p => p !== path)].slice(0, 8);
    const sameSource = S.last && S.last.dir === seq.dir && S.last.pattern === seq.pattern;
    S.last = { path, dir: seq.dir, pattern: seq.pattern, frame: sameSource ? S.last.frame : 0, local };
    if (S.analysis.surfaceFrom?.source !== src.id) { S.analysis.surface = null; S.analysis.surfaceFrom = null; }   // belongs to another trajectory
    lastPile = null;
    save(); fillPaths();
    bar.querySelector(".st-src").textContent = `${num(src.n_frames)} frames · ${num(src.natoms)} atoms · ${bytes(src.bytes)}`;
    frame = null; picked = null; cam = null;
    buildTimeline(); buildSide();
    await loadFrame(Math.min(S.last.frame || 0, src.n_frames - 1), true);
  }

  // ---------------------------------------------------------------------------------------------- frames
  async function ensureCols(f) {
    const want = neededColumns(S.pipeline).filter(c => f.meta.columns.includes(c) && !(c in f.cols));
    if (want.length) Object.assign(f.cols, await SRC.cols(src, f, want));
  }

  async function loadFrame(i, fit = false) {
    const tok = ++loadTok, ref = displacementRef(S.pipeline);
    if (ref != null && ref >= src.n_frames) { toast(`Reference frame ${ref} does not exist (0…${src.n_frames - 1}).`, "warn"); }
    const refOk = ref != null && ref < src.n_frames ? ref : null;
    if (!frame) busy(`Loading frame ${i}…`); else setHud(`Loading frame ${i}…`);
    try {
      const meta = await SRC.load(src, i, refOk, frame ? (r => setHud(`Loading frame ${i}… ${Math.round(r.progress * 100)}%`)) : progress, 120);
      if (tok !== loadTok || !alive) return;
      const f = { meta, index: i, ref: refOk, n: meta.natoms, cols: {} };
      await ensureCols(f);
      if (tok !== loadTok || !alive) return;
      frame = f; fi = i; picked = null; pickHud.hidden = true;
      S.last.frame = i; save();
      for (const t of meta.types) if (!S.types[t.id]) S.types[t.id] = { color: TYPE_PALETTE[(t.id - 1) % TYPE_PALETTE.length], radius: 1.0 };
      uploadPositions();
      if (fit || !cam) { cam = cam || { proj: S.viewport.proj, fov: 0.6, halfH: 50, target: scene.center, dir: [...VIEWS.Front.dir], up: [...VIEWS.Front.up] }; setView(S.viewport.view || "Front", false); }
      runPipeline();
      if (fit || !cam.fitted) { zoomAll(); cam.fitted = true; }
      idle(); updateTimeline(); refreshSide();
      if (playing && fi + 1 < src.n_frames) SRC.prefetch(src, fi + 1, refOk);   // prefetch the next frame
    } catch (e) {
      if (tok !== loadTok) return;
      stop(); idle();
      if (!frame) showState(errorState(e, () => loadFrame(i, fit))); else toast(`Frame ${i}: ${e.message}`, "err");
    }
  }

  function uploadPositions() {
    const { x, y, z } = frame.cols, n = frame.n, p = new Float32Array(n * 3);
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n; i++) {
      const a = x[i], b = y[i], c = z[i]; p[i * 3] = a; p[i * 3 + 1] = b; p[i * 3 + 2] = c;
      if (a < lo[0]) lo[0] = a; if (a > hi[0]) hi[0] = a; if (b < lo[1]) lo[1] = b; if (b > hi[1]) hi[1] = b; if (c < lo[2]) lo[2] = c; if (c > hi[2]) hi[2] = c;
    }
    R.setPositions(p); R.setCell(frame.meta.cell);
    scene = { center: lo.map((v, k) => (v + hi[k]) / 2), radius: V.len(V.sub(hi, lo)) / 2 + 5 };
  }

  function runPipeline() {
    if (!frame) return;
    out = evaluate(frame, S.pipeline, S.types);
    R.setColors(out.rgb); R.setRadii(out.radius); R.setIndices(out.idx);
    S.pipeline.forEach((m, k) => { const n = modStatus.get(m); if (n) { n.textContent = out.status[k]; n.classList.toggle("bad", /^error|^no /.test(out.status[k])); } });
    setHud(); requestDraw();
  }

  /** Something in the pipeline changed: reload for a new reference frame, fetch new columns, re-evaluate. */
  async function changed() {
    save();
    if (!frame) return;
    const ref = displacementRef(S.pipeline);
    if ((ref != null && ref < src.n_frames ? ref : null) !== frame.ref) return loadFrame(fi);
    try { await ensureCols(frame); } catch (e) { toast(e.message, "err"); }
    runPipeline();
  }

  // ---------------------------------------------------------------------------------------------- camera
  function layout() {
    const W = glc.width, H = glc.height, full = { x: 0, y: 0, w: W, h: H };
    if (!S.render.preview) return { full, frame: null, k: 1 };
    const a = S.render.w / S.render.h, m = 0.9;
    let fw = W * m, fh = fw / a;
    if (fh > H * m) { fh = H * m; fw = fh * a; }
    return { full, frame: { x: (W - fw) / 2, y: (H - fh) / 2, w: fw, h: fh }, k: H / fh };
  }
  function setView(name, fit = true) {
    const v = VIEWS[name] || VIEWS.Front;
    cam.dir = [...v.dir]; cam.up = [...v.up]; S.viewport.view = name; save();
    tools.querySelectorAll("[data-view]").forEach(b => b.setAttribute("aria-pressed", b.dataset.view === name));
    if (fit) zoomAll();
  }
  function zoomAll() {
    if (!frame || !out) return;
    const m = matrices(cam, 1, scene), { x, y, z } = frame.cols;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    let rmax = 0;
    for (const i of out.idx) {
      const p = [x[i], y[i], z[i]], q = [V.dot(p, m.right), V.dot(p, m.up), V.dot(p, m.dir)];
      for (let k = 0; k < 3; k++) { if (q[k] < lo[k]) lo[k] = q[k]; if (q[k] > hi[k]) hi[k] = q[k]; }
      if (out.radius[i] > rmax) rmax = out.radius[i];
    }
    if (!(lo[0] <= hi[0])) { requestDraw(); return; }
    const c = lo.map((v, k) => (v + hi[k]) / 2);
    cam.target = V.add(V.add(V.mul(m.right, c[0]), V.mul(m.up, c[1])), V.mul(m.dir, c[2]));
    const L = layout(), aspect = L.frame ? L.frame.w / L.frame.h : glc.width / Math.max(1, glc.height);
    cam.halfH = Math.max((hi[1] - lo[1]) / 2, (hi[0] - lo[0]) / 2 / aspect) * 1.04 + rmax * S.viewport.rscale;
    requestDraw();
  }
  const bgRgb = () => hexToRgb(S.render.bg).map(v => v / 255);
  const lum = c => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
  // dimension lines are positions in one trajectory: show only those measured on the open one
  const overlaysHere = () => ({ ...S.overlays, measures: S.overlays.measures.filter(M => src && M.source === src.id) });
  // values for [Timestep] [Frame] [Time] in text labels; Time needs the MD time step (Render tab)
  const labelVars = () => frame ? { Timestep: String(frame.meta.step), Frame: String(fi),
    Time: S.render.dt_fs > 0 ? `${+(frame.meta.step * S.render.dt_fs / 1000).toFixed(3)} ps` : undefined } : {};
  const coloring = () => [...S.pipeline].reverse().find(m => m.enabled && m.type === "color_coding" && frame && m.prop in frame.cols) || null;

  // ---------------------------------------------------------------------------------------------- drawing
  function requestDraw() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); }
  function resize() {
    const r = stage.getBoundingClientRect(), d = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.max(1, Math.round(r.width * d)), H = Math.max(1, Math.round(r.height * d));
    if (glc.width !== W || glc.height !== H) { glc.width = ovc.width = W; glc.height = ovc.height = H; }
    requestDraw();
  }
  function draw() {
    const c = ovc.getContext("2d");
    c.clearRect(0, 0, ovc.width, ovc.height);
    if (!cam || !frame) { R.draw({ view: new Float32Array(16), proj: new Float32Array(16), bg: [0.04, 0.047, 0.055, 1] }); return; }
    const L = layout(), W = glc.width, H = glc.height;
    const mv = matrices(cam, W / H, scene, L.k), bg = L.frame ? bgRgb() : [0.04, 0.047, 0.055];
    R.draw({ view: mv.view, proj: mv.proj, bg: [...bg, 1], rscale: S.viewport.rscale, flat: S.viewport.flat, cellColor: S.viewport.cell ? (lum(bg) > 0.5 ? [0.1, 0.1, 0.1] : [0.6, 0.62, 0.66]) : null });
    if (L.frame) {
      const f = L.frame;
      c.fillStyle = "rgba(10,12,14,0.62)";
      c.fillRect(0, 0, W, f.y); c.fillRect(0, f.y + f.h, W, H - f.y - f.h); c.fillRect(0, f.y, f.x, f.h); c.fillRect(f.x + f.w, f.y, W - f.x - f.w, f.h);
      c.strokeStyle = "#e2a23a"; c.lineWidth = 1; c.strokeRect(f.x + 0.5, f.y + 0.5, f.w - 1, f.h - 1);
    }
    const rect = L.frame || L.full, mr = L.frame ? matrices(cam, rect.w / rect.h, scene, 1) : mv;
    drawOverlays(c, rect, overlaysHere(), mr, coloring(), labelVars());
    const ring = (p, col) => {
      const q = projectPx(mv, p);
      c.strokeStyle = col; c.lineWidth = 2; c.beginPath(); c.arc(q[0], q[1], 9, 0, 7); c.stroke();
    };
    if (picked != null) ring([frame.cols.x[picked], frame.cols.y[picked], frame.cols.z[picked]], "#e2a23a");
    if (measureA) ring(measureA, "#6f9fd6");
  }
  function projectPx(m, p) {
    const v = m.vp, cw = v[3] * p[0] + v[7] * p[1] + v[11] * p[2] + v[15];
    return [((v[0] * p[0] + v[4] * p[1] + v[8] * p[2] + v[12]) / cw + 1) / 2 * glc.width, (1 - (v[1] * p[0] + v[5] * p[1] + v[9] * p[2] + v[13]) / cw) / 2 * glc.height];
  }

  // ---------------------------------------------------------------------------------------------- picking
  function pick(px, py) {
    if (!frame || !out) return null;
    const L = layout(), m = matrices(cam, glc.width / glc.height, scene, L.k), v = m.vp, H = glc.height, P11 = m.proj[5];
    const { x, y, z } = frame.cols, rs = S.viewport.rscale;
    let best = null, bz = Infinity;
    for (const i of out.idx) {
      const a = x[i], b = y[i], cz = z[i], w = v[3] * a + v[7] * b + v[11] * cz + v[15];
      const sx = ((v[0] * a + v[4] * b + v[8] * cz + v[12]) / w + 1) / 2 * glc.width - px;
      const sy = (1 - (v[1] * a + v[5] * b + v[9] * cz + v[13]) / w) / 2 * H - py;
      const r = out.radius[i] * rs * H * P11 / (2 * w);
      if (sx * sx + sy * sy > r * r) continue;
      const d = (v[2] * a + v[6] * b + v[10] * cz + v[14]) / w;
      if (d < bz) { bz = d; best = i; }
    }
    return best;
  }
  async function onClick(px, py) {
    const i = pick(px, py);
    if (measuring) {
      if (i == null) return;
      const p = [frame.cols.x[i], frame.cols.y[i], frame.cols.z[i]].map(Number);
      if (!measureA) { measureA = p; setHud("Measure: click the second atom (Esc cancels)"); requestDraw(); return; }
      S.overlays.measures.push({ source: src.id, a: measureA, b: p, axis: S.measureAxis, prefix: S.measureAxis === "xyz" ? "d = " : `Δ${S.measureAxis} = `, color: "#000000", size: 0.04, decimals: 2, side: "right", serif: true, bold: true });
      measureA = null; save(); requestDraw(); setHud(); refreshSide("overlays");
      return;
    }
    picked = i; requestDraw();
    if (i == null) { pickHud.hidden = true; refreshSide("data"); return; }
    try {
      const rowv = await SRC.atom(src, fi, i, frame.ref);
      frame.pickedRow = rowv;
      pickHud.hidden = false;
      pickHud.replaceChildren(el("b", {}, `Atom id ${rowv.id} · type ${rowv.type}`), el("span", {}, `x ${num(rowv.x, 3)}  y ${num(rowv.y, 3)}  z ${num(rowv.z, 3)} Å`),
        el("span", { class: "muted" }, "All values: Data tab"));
      refreshSide("data");
    } catch (e) { toast(e.message, "err"); }
  }

  // ---------------------------------------------------------------------------------------------- viewport input
  let drag = null;
  ovc.addEventListener("contextmenu", e => e.preventDefault());
  ovc.addEventListener("pointerdown", e => { ovc.setPointerCapture(e.pointerId); drag = { x: e.clientX, y: e.clientY, b: e.button, shift: e.shiftKey, moved: false }; });
  ovc.addEventListener("pointermove", e => {
    if (!drag || !cam) return;
    const d = Math.min(2, window.devicePixelRatio || 1), dx = (e.clientX - drag.x) * d, dy = (e.clientY - drag.y) * d;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true; drag.x = e.clientX; drag.y = e.clientY;
    const m = matrices(cam, 1, scene);
    if (drag.b === 2 || drag.b === 1 || drag.shift) {
      const wpp = 2 * cam.halfH * layout().k / glc.height;
      cam.target = V.add(cam.target, V.add(V.mul(m.right, -dx * wpp), V.mul(m.up, dy * wpp)));
    } else {
      let dir = V.rot(cam.dir, m.up, -dx * 0.006), up = V.rot(m.up, m.up, 0);
      const right = V.norm(V.cross(dir, up));
      dir = V.rot(dir, right, -dy * 0.006); up = V.rot(up, right, -dy * 0.006);
      cam.dir = V.norm(dir); cam.up = V.norm(up);
      if (S.viewport.view !== "Ortho") { S.viewport.view = "Ortho"; tools.querySelectorAll("[data-view]").forEach(b => b.setAttribute("aria-pressed", "false")); }
    }
    requestDraw();
  });
  ovc.addEventListener("pointerup", e => {
    const d = drag; drag = null;
    if (d && !d.moved && d.b === 0) { const r = ovc.getBoundingClientRect(), k = glc.width / r.width; onClick((e.clientX - r.left) * k, (e.clientY - r.top) * k); }
  });
  ovc.addEventListener("wheel", e => { if (!cam) return; e.preventDefault(); cam.halfH *= Math.exp(e.deltaY * 0.0012); requestDraw(); }, { passive: false });
  ovc.addEventListener("dblclick", () => zoomAll());
  ovc.addEventListener("keydown", e => {
    if (!cam) return;
    const m = matrices(cam, 1, scene), a = 0.08;
    const rotH = s => { cam.dir = V.rot(cam.dir, m.up, s); requestDraw(); };
    const rotV = s => { cam.dir = V.norm(V.rot(cam.dir, m.right, s)); cam.up = V.norm(V.rot(m.up, m.right, s)); requestDraw(); };
    const k = { ArrowLeft: () => rotH(a), ArrowRight: () => rotH(-a), ArrowUp: () => rotV(a), ArrowDown: () => rotV(-a),
      "+": () => { cam.halfH /= 1.15; requestDraw(); }, "=": () => { cam.halfH /= 1.15; requestDraw(); }, "-": () => { cam.halfH *= 1.15; requestDraw(); }, "0": zoomAll }[e.key];
    if (k) { e.preventDefault(); k(); }
  });
  const onKey = e => {
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === "Escape" && (measureA || measuring)) { measureA = null; setMeasuring(false); return; }
    if (!src) return;
    if (e.key === " " && document.activeElement !== ovc) { e.preventDefault(); playing ? stop() : play(); }
    if (e.key === " " && document.activeElement === ovc) { e.preventDefault(); playing ? stop() : play(); }
    if (e.key === ",") step(-1);
    if (e.key === ".") step(1);
  };
  document.addEventListener("keydown", onKey);
  const ro = new ResizeObserver(resize); ro.observe(stage);

  // ---------------------------------------------------------------------------------------------- toolbar
  function setMeasuring(on) {
    measuring = on; measureA = null;
    stage.classList.toggle("measuring", on);
    tools.querySelector("[data-act=measure]")?.setAttribute("aria-pressed", on);
    setHud(on ? "Measure: click the first atom (Esc cancels)" : undefined); requestDraw();
  }
  function buildTools() {
    const views = el("div", { class: "btn-group", role: "group", "aria-label": "Standard views" },
      Object.keys(VIEWS).map(n => el("button", { class: "btn", type: "button", "data-view": n, "aria-pressed": n === S.viewport.view, "data-tip": VIEW_TIP[n], onclick: () => cam && setView(n) }, n)));
    const proj = el("div", { class: "btn-group", role: "group", "aria-label": "Projection" },
      [["ortho", "Ortho"], ["persp", "Persp"]].map(([v, l]) => el("button", { class: "btn", type: "button", "data-proj": v, "aria-pressed": S.viewport.proj === v,
        "data-tip": v === "ortho" ? "Parallel projection (as in paper figures)" : "Perspective projection",
        onclick: () => { S.viewport.proj = v; if (cam) cam.proj = v; proj.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", b.dataset.proj === v)); save(); requestDraw(); } }, l)));
    tools.append(views, proj,
      el("button", { class: "btn", type: "button", "data-tip": "Zoom to all visible atoms (double-click, 0)", onclick: zoomAll }, "Zoom all"),
      el("button", { class: "btn", type: "button", "data-act": "preview", "aria-pressed": S.render.preview, "data-tip": "Show the render frame: what the exported image contains, on its background", onclick: e => { S.render.preview = !S.render.preview; e.currentTarget.setAttribute("aria-pressed", S.render.preview); save(); requestDraw(); refreshSide("render"); } }, "Preview"),
      el("button", { class: "btn", type: "button", "data-act": "measure", "aria-pressed": "false", "data-tip": "Click two atoms to add a dimension line (Overlays tab)", onclick: () => setMeasuring(!measuring) }, "Measure"),
      el("button", { class: "btn primary", type: "button", onclick: renderImage }, svg("download"), "Render"));
  }
  buildTools();

  // ---------------------------------------------------------------------------------------------- HUD and states
  function setHud(msg) {
    clear(hud);
    if (!frame) { hud.hidden = true; return; }
    hud.hidden = false;
    hud.append(el("b", {}, src.label),
      el("span", {}, `Frame ${fi} · step ${num(frame.meta.step)} · ${num(out?.idx.length ?? 0)} of ${num(frame.n)} atoms shown${out?.nsel ? ` · ${num(out.nsel)} selected` : ""}`),
      ...(msg ? [el("span", { class: "acc" }, msg)] : []));
  }
  function showState(node) { clear(overlayState).append(node); overlayState.hidden = false; }
  let busyNode = null;
  function busy(msg) { busyNode = loading(msg, true); showState(busyNode); }
  function progress(rec) { busyNode?.update(rec); }
  function idle() { overlayState.hidden = true; clear(overlayState); busyNode = null; }
  function startState() {
    const runs = live ? state.sims.filter(s => s.kind === "run" && s.n_frames) : [];
    const pick = p => () => { pathIn.value = p; scanAndOpen(p); };
    showState(el("div", { class: "state st-start" },
      el("b", {}, "Open a trajectory"),
      el("span", {}, "Open folder… reads the LAMMPS dumps of a folder on this computer (searched two levels deep) directly in the browser: nothing is uploaded and files are only read. Open files… takes one multi-frame dump or several frame files, also .gz."),
      el("div", { class: "field-row" }, el("button", { class: "btn primary", type: "button", onclick: openFolder }, "Open folder…"), el("button", { class: "btn", type: "button", onclick: openFiles }, localDlg ? "Open file(s)…" : "Open files…")),
      live && S.last && !S.last.local ? el("button", { class: "btn", type: "button", onclick: pick(S.last.path) }, `Reopen ${S.last.path}`) : null,
      runs.length ? el("span", { class: "muted small" }, "Or a run the backend can read:") : null,
      runs.length ? el("div", { class: "chips" }, runs.map(s => el("button", { class: "chip", type: "button", onclick: pick(s.path) }, s.label, el("span", { class: "n" }, `${s.n_frames} frames`)))) : null));
  }

  // ---------------------------------------------------------------------------------------------- timeline
  const slider = el("input", { type: "range", min: 0, max: 0, value: 0, "aria-label": "Frame" });
  const frameNum = el("input", { class: "input num fnum", type: "number", min: 0, value: 0, "aria-label": "Frame number" });
  const readout = el("span", { class: "readout" });
  const playBtn = el("button", { class: "btn icon", type: "button", "aria-label": "Play", "data-tip": "Play / pause (Space)" }, svg("play"));
  function buildTimeline() {
    clear(time);
    slider.max = src.n_frames - 1; frameNum.max = src.n_frames - 1;
    const b = (ic, lab, fn) => el("button", { class: "btn icon", type: "button", "aria-label": lab, "data-tip": lab, onclick: fn }, svg(ic));
    time.append(b("first", "First frame", () => go(0)), b("prev", "Previous frame (,)", () => step(-1)), playBtn, b("next", "Next frame (.)", () => step(1)), b("last", "Last frame", () => go(src.n_frames - 1)), slider, frameNum, readout);
  }
  playBtn.onclick = () => (playing ? stop() : play());
  slider.oninput = () => { readout.textContent = stepText(+slider.value); };
  slider.onchange = () => go(+slider.value);
  frameNum.onchange = () => go(Math.max(0, Math.min(src.n_frames - 1, Math.round(+frameNum.value || 0))));
  const stepText = i => `step ${num(src.steps[i])}${src.steps_from === "file name" ? " (file name)" : ""} · ${i + 1} / ${src.n_frames}`;
  function updateTimeline() { slider.value = fi; frameNum.value = fi; readout.textContent = `step ${num(frame.meta.step)} · ${fi + 1} / ${src.n_frames}`; }
  function go(i) { if (src && i !== fi) loadFrame(i); else if (src) updateTimeline(); }
  function step(d) { if (src) go(Math.max(0, Math.min(src.n_frames - 1, fi + d))); }
  async function play() {
    if (!src || playing) return;
    playing = true; playBtn.replaceChildren(svg("pause")); playBtn.setAttribute("aria-label", "Pause");
    if (fi >= src.n_frames - 1) await loadFrame(0);
    while (playing && alive && fi < src.n_frames - 1) await loadFrame(fi + 1);
    stop();
  }
  function stop() { playing = false; playBtn.replaceChildren(svg("play")); playBtn.setAttribute("aria-label", "Play"); }

  // ---------------------------------------------------------------------------------------------- side panels
  const T = tabs([{ id: "pipeline", label: "Pipeline" }, { id: "overlays", label: "Overlays" }, { id: "render", label: "Render" }, { id: "analysis", label: "Pile-up" },
    { id: "export", label: "Export" }, { id: "data", label: "Data" }], id => { S.sideTab = id; save(); refreshSide(id); });   // the open tab is remembered
  side.append(T.bar, ...Object.values(T.panels));
  const builders = { pipeline: buildPipeline, overlays: buildOverlays, render: buildRender, analysis: buildAnalysis, export: buildExport, data: buildData };
  function buildSide() {
    if (S.sideTab && builders[S.sideTab]) T.select(S.sideTab);
    for (const id of Object.keys(builders)) refreshSide(id, true);
  }
  // -- export: frames through OVITO from the files on disk (exact values, all columns); needs a path the backend reads
  function buildExport(p) {
    if (!src) { p.append(el("p", { class: "muted" }, "Open a trajectory first.")); return; }
    if (SRC !== serverSource || !live) {
      p.append(el("p", { class: "muted" }, localDlg ? "This trajectory was read inside the browser. Open it with Open folder… / Open file(s)… (read in place by the backend) to export it."
        : "Exports run on the backend: open the files on the OVITO page (Upload) to export them from the hosted site."));
      return;
    }
    buildFramesPanel(p, { S, save, info: () => ({ num_frames: src.n_frames, count: src.natoms }), spec: () => ({ source: { path: src.dir, pattern: src.pattern }, frame: fi, types: {}, cell: false, modifiers: [] }),
      frameMeta: () => (frame ? { count: frame.n } : null), noPipeline: true });   // the dump's own columns
  }
  function refreshSide(id, force) {
    const ids = id ? [id] : Object.keys(builders);
    for (const k of ids) { const p = T.panels[k]; if (force || !p.hidden) { clear(p); builders[k](p); } }
  }

  // -- pipeline
  function buildPipeline(p) {
    if (!src) { p.append(el("p", { class: "muted" }, "Open a trajectory first.")); return; }
    p.append(sec("Data source",
      el("dl", { class: "kv" }, el("dt", {}, "Folder"), el("dd", {}, src.dir), el("dt", {}, "Files"), el("dd", {}, `${src.pattern} (${num(src.files)} file${src.files > 1 ? "s" : ""})`),
        el("dt", {}, "Frames"), el("dd", {}, num(src.n_frames)), el("dt", {}, "Atoms"), el("dd", {}, num(frame?.n ?? src.natoms))),
      src.local ? el("p", { class: "muted small" }, "Read in this browser from the files you picked; nothing was uploaded. Pick the folder again to see new frames.")
        : el("button", { class: "btn", type: "button", "data-tip": "Index the folder again (new frames written by a running job)", onclick: () => openSeq(S.last.path, { dir: src.dir, pattern: src.pattern }, true) }, svg("refresh"), "Re-scan files")));
    const types = frame?.meta.types || [];
    p.append(sec("Atom types",
      el("table", { class: "data compact" }, el("thead", {}, el("tr", {}, el("th", {}, "Type"), el("th", {}, "Colour"), el("th", { class: "num" }, "Radius Å"), el("th", { class: "num" }, "Atoms"))),
        el("tbody", {}, types.map(t => el("tr", {}, el("td", {}, `${t.id}${t.name ? ` (${t.name})` : ""}`),
          el("td", {}, colIn(S.types[t.id]?.color || "#cccccc", v => { S.types[t.id].color = v; changed(); }, `Colour of type ${t.id}`)),
          el("td", { class: "num" }, numIn(S.types[t.id]?.radius ?? 1, v => { S.types[t.id].radius = Math.max(0.05, v || 1); changed(); }, { min: 0.05, step: 0.05, "aria-label": `Radius of type ${t.id}` })),
          el("td", { class: "num" }, num(t.count)))))),
      row("Radius scale", el("input", { type: "range", min: 0.2, max: 2.5, step: 0.05, value: S.viewport.rscale, "aria-label": "Radius scale", oninput: e => { S.viewport.rscale = +e.target.value; save(); requestDraw(); } })),
      el("div", { class: "field-row" }, chk("Flat shading", S.viewport.flat, v => { S.viewport.flat = v; save(); requestDraw(); }, "Uniform discs instead of shaded spheres"),
        chk("Simulation cell", S.viewport.cell, v => { S.viewport.cell = v; save(); requestDraw(); }, "Draw the box edges"))));
    const add = sel([["", "Add modification…"], ...Object.entries(MODIFIERS).map(([k, d]) => [k, `${d.group}: ${d.label}`])], "", v => {
      if (!v) return;
      S.pipeline.push(newModifier(v)); refreshSide("pipeline"); changed();
    }, "Add modification");
    const list = el("div", { class: "mods" });
    modStatus.clear();
    S.pipeline.forEach((m, k) => list.append(modCard(m, k)));
    p.append(sec("Modifications (applied top to bottom)", add, S.pipeline.length ? list : el("p", { class: "muted" }, "None yet. Typical figure: Select type (tool) → Delete selected → Color coding by y.")));
    if (out) S.pipeline.forEach((m, k) => { const n = modStatus.get(m); if (n) n.textContent = out.status[k]; });
  }
  function modCard(m, k) {
    const d = MODIFIERS[m.type], status = el("div", { class: "mod-status" });
    modStatus.set(m, status);
    const move = dlt => () => { const j = k + dlt; if (j < 0 || j >= S.pipeline.length) return; [S.pipeline[k], S.pipeline[j]] = [S.pipeline[j], S.pipeline[k]]; refreshSide("pipeline"); changed(); };
    const card = el("div", { class: `mod-card${m.enabled ? "" : " off"}` },
      el("div", { class: "mod-head" },
        el("input", { type: "checkbox", checked: m.enabled, "aria-label": `Enable ${d.label}`, onchange: e => { m.enabled = e.target.checked; card.classList.toggle("off", !m.enabled); changed(); } }),
        el("span", { class: "name", "data-tip": d.help }, d.label),
        el("button", { class: "btn ghost icon", type: "button", "aria-label": "Move up", onclick: move(-1), disabled: k === 0 }, "↑"),
        el("button", { class: "btn ghost icon", type: "button", "aria-label": "Move down", onclick: move(1), disabled: k === S.pipeline.length - 1 }, "↓"),
        el("button", { class: "btn ghost icon", type: "button", "aria-label": `Remove ${d.label}`, onclick: () => { S.pipeline.splice(k, 1); refreshSide("pipeline"); changed(); } }, "✕")),
      status);
    const body = editor(m);
    if (body) card.append(el("div", { class: "mod-body" }, body));
    return card;
  }
  const colOptions = (cur) => {
    const cols = frame ? frame.meta.columns : ["x", "y", "z", "type"];
    const extra = displacementRef(S.pipeline) != null && !cols.includes("dx") ? ["dx", "dy", "dz", "displacement"] : [];
    const all = [...cols, ...extra];
    if (cur && !all.includes(cur)) all.push(cur);
    return all.map(c => [c, COL_LABEL[c] || c]);
  };
  function editor(m) {
    const set = (key, v) => { m[key] = v; changed(); };
    switch (m.type) {
      case "displacement": return el("div", { class: "grid1" },
        row("Reference frame", numIn(m.ref, v => set("ref", Math.max(0, Math.round(v || 0))), { min: 0, max: src ? src.n_frames - 1 : 0, step: 1 })),
        el("p", { class: "muted small" }, `Step ${src ? num(src.steps[Math.min(src.n_frames - 1, m.ref || 0)]) : "—"}. ${MODIFIERS.displacement.help}`));
      case "slice": {
        const nrm = el("div", { class: "trio" }, [0, 1, 2].map(i => numIn(m.normal[i], v => { m.normal[i] = v || 0; changed(); }, { "aria-label": `Normal ${"xyz"[i]}` })));
        const center = () => {
          const [nx, ny, nz] = m.normal, L = Math.hypot(nx, ny, nz) || 1, c = scene.center;
          m.distance = +((nx * c[0] + ny * c[1] + nz * c[2]) / L).toFixed(3); refreshSide("pipeline"); changed();
        };
        return el("div", { class: "grid1" },
          row("Normal (x y z)", nrm),
          el("div", { class: "field-row" }, ["x", "y", "z"].map((a, i) => el("button", { class: "btn", type: "button", onclick: () => { m.normal = [0, 0, 0].map((_, j) => (j === i ? 1 : 0)); refreshSide("pipeline"); changed(); } }, `${a} axis`)),
            el("button", { class: "btn", type: "button", onclick: center, "data-tip": "Put the plane through the centre of the atoms" }, "Centre")),
          row("Distance d (Å)", numIn(m.distance, v => set("distance", v || 0))),
          row("Slab width (Å)", numIn(m.width, v => set("width", Math.abs(v || 0)), { min: 0 })),
          el("div", { class: "field-row" }, chk("Invert", m.invert, v => set("invert", v)), chk("Select only", m.selectOnly, v => set("selectOnly", v))),
          el("p", { class: "muted small" }, MODIFIERS.slice.help));
      }
      case "select_type": {
        const types = frame?.meta.types || [];
        return el("div", { class: "chips" }, types.map(t => el("button", { class: "chip", type: "button", "aria-pressed": m.types.includes(t.id),
          onclick: e => { m.types = m.types.includes(t.id) ? m.types.filter(x => x !== t.id) : [...m.types, t.id]; e.currentTarget.setAttribute("aria-pressed", m.types.includes(t.id)); changed(); } },
          el("span", { class: "swatch", style: { background: S.types[t.id]?.color } }), `Type ${t.id}${t.name ? ` ${t.name}` : ""}`, el("span", { class: "n" }, num(t.count)))));
      }
      case "expression": return el("div", { class: "grid1" },
        m.conds.map((c, j) => el("div", { class: "cond" },
          sel(colOptions(c.prop), c.prop, v => { c.prop = v; changed(); }, "Property"),
          sel(OP_LIST, c.op, v => { c.op = v; changed(); }, "Operator"),
          numIn(c.value, v => { c.value = v ?? 0; changed(); }, { "aria-label": "Value" }),
          el("button", { class: "btn ghost icon", type: "button", "aria-label": "Remove condition", onclick: () => { m.conds.splice(j, 1); refreshSide("pipeline"); changed(); } }, "✕"))),
        el("div", { class: "field-row" },
          el("button", { class: "btn", type: "button", onclick: () => { m.conds.push({ prop: "y", op: ">", value: 0 }); refreshSide("pipeline"); changed(); } }, "+ Condition"),
          sel([["all", "all must hold (AND)"], ["any", "any may hold (OR)"]], m.combine, v => set("combine", v), "Combine conditions")));
      case "assign_color": return row("Colour", colIn(m.color, v => set("color", v), "Colour"));
      case "color_coding": {
        const grad = el("canvas", { class: "grad", width: 256, height: 10 });
        const g = grad.getContext("2d");
        for (let i = 0; i < 256; i++) { let f = i / 255; if (m.reverse) f = 1 - f; g.fillStyle = `rgb(${GRADIENTS[m.map](f).map(v => Math.round(v * 255))})`; g.fillRect(i, 0, 1, 10); }
        return el("div", { class: "grid1" },
          row("Property", sel(colOptions(m.prop), m.prop, v => { m.prop = v; m.autoRange = true; changed().then(() => refreshSide("pipeline")); }, "Colour by")),
          row("Gradient", sel(Object.keys(GRADIENTS), m.map, v => { m.map = v; refreshSide("pipeline"); changed(); }, "Colour gradient")), grad,
          row("End (top)", numIn(m.end, v => set("end", v ?? 0))),
          row("Start (bottom)", numIn(m.start, v => set("start", v ?? 0))),
          el("div", { class: "field-row" },
            el("button", { class: "btn", type: "button", "data-tip": "Minimum and maximum of the atoms reaching this modifier in this frame", onclick: () => { if (m._range) { [m.start, m.end] = m._range.map(x => +x.toPrecision(6)); refreshSide("pipeline"); changed(); } } }, "Adjust range"),
            el("button", { class: "btn", type: "button", onclick: () => { [m.start, m.end] = [m.end, m.start]; refreshSide("pipeline"); changed(); } }, "Swap")),
          el("div", { class: "field-row" }, chk("Reverse", m.reverse, v => { m.reverse = v; refreshSide("pipeline"); changed(); }), chk("Only selected", m.onlySelected, v => set("onlySelected", v), "Colour only the selected atoms, keep the others' colours")),
          m._range ? el("p", { class: "muted small" }, `Range of input values: ${num(m._range[0], 4)} … ${num(m._range[1], 4)}`) : null);
      }
      default: return el("p", { class: "muted small" }, MODIFIERS[m.type].help);
    }
  }

  // -- overlays
  function buildOverlays(p) {
    const L = S.overlays.legend, Tr = S.overlays.tripod, upd = () => { save(); requestDraw(); };
    const cc = coloring();
    p.append(sec("Color legend",
      chk("Show legend", L.enabled, v => { L.enabled = v; upd(); }),
      cc ? null : el("p", { class: "muted small" }, "Shown when the pipeline has an enabled Color coding modification."),
      row("Orientation", sel([["vertical", "Vertical"], ["horizontal", "Horizontal"]], L.orientation, v => { L.orientation = v; upd(); }, "Orientation")),
      row("Position", sel(ALIGNS, L.align, v => { L.align = v; upd(); }, "Legend position")),
      row("Offset x / y", el("div", { class: "duo" }, numIn(L.ox, v => { L.ox = v ?? 0; upd(); }, { step: 0.01 }), numIn(L.oy, v => { L.oy = v ?? 0; upd(); }, { step: 0.01 }))),
      row("Title", txtIn(L.title ?? "", v => { L.title = v; upd(); }, { placeholder: cc ? cc.prop : "property name" })),
      row("Unit", txtIn(L.unit, v => { L.unit = v; upd(); })),
      row("Decimals", numIn(L.decimals, v => { L.decimals = Math.max(0, Math.min(6, Math.round(v ?? 2))); upd(); }, { min: 0, max: 6, step: 1 })),
      row("Length / width", el("div", { class: "duo" }, numIn(L.length, v => { L.length = v || 0.4; upd(); }, { step: 0.05, min: 0.05 }), numIn(L.thickness, v => { L.thickness = v || 0.03; upd(); }, { step: 0.005, min: 0.005 }))),
      row("Text size", numIn(L.font, v => { L.font = v || 0.04; upd(); }, { step: 0.005, min: 0.01 })),
      row("Text colour", colIn(L.color, v => { L.color = v; upd(); }, "Legend text colour")),
      el("div", { class: "field-row" }, chk("Serif font", L.serif, v => { L.serif = v; upd(); }), chk("Bold", L.bold, v => { L.bold = v; upd(); }))));
    p.append(sec("Coordinate tripod",
      chk("Show tripod", Tr.enabled, v => { Tr.enabled = v; upd(); }),
      row("Position", sel(ALIGNS, Tr.align, v => { Tr.align = v; upd(); }, "Tripod position")),
      row("Offset x / y", el("div", { class: "duo" }, numIn(Tr.ox, v => { Tr.ox = v ?? 0; upd(); }, { step: 0.01 }), numIn(Tr.oy, v => { Tr.oy = v ?? 0; upd(); }, { step: 0.01 }))),
      row("Size / text", el("div", { class: "duo" }, numIn(Tr.size, v => { Tr.size = v || 0.08; upd(); }, { step: 0.01, min: 0.02 }), numIn(Tr.font, v => { Tr.font = v || 0.035; upd(); }, { step: 0.005, min: 0.01 })))));
    const labels = el("div", { class: "grid1" });
    S.overlays.labels.forEach((t, j) => labels.append(el("div", { class: "mod-card" }, el("div", { class: "mod-body" },
      row("Text", txtIn(t.text, v => { t.text = v; upd(); })),
      row("Position", sel(ALIGNS, t.align, v => { t.align = v; upd(); }, "Label position")),
      row("Offset x / y", el("div", { class: "duo" }, numIn(t.ox, v => { t.ox = v ?? 0; upd(); }, { step: 0.01 }), numIn(t.oy, v => { t.oy = v ?? 0; upd(); }, { step: 0.01 }))),
      row("Size / colour", el("div", { class: "duo" }, numIn(t.size, v => { t.size = v || 0.05; upd(); }, { step: 0.005 }), colIn(t.color, v => { t.color = v; upd(); }, "Label colour"))),
      el("div", { class: "field-row" }, chk("Serif", t.serif, v => { t.serif = v; upd(); }), chk("Bold", t.bold, v => { t.bold = v; upd(); }),
        el("button", { class: "btn ghost", type: "button", onclick: () => { S.overlays.labels.splice(j, 1); upd(); refreshSide("overlays"); } }, "Remove"))))));
    p.append(sec("Text labels", labels, el("button", { class: "btn", type: "button", onclick: () => { S.overlays.labels.push({ text: "(a1)", align: "top-left", ox: 0.02, oy: 0.02, size: 0.055, color: "#000000", serif: true, bold: true }); upd(); refreshSide("overlays"); } }, "+ Text label")));
    const ms = el("div", { class: "grid1" });
    overlaysHere().measures.forEach(M => ms.append(el("div", { class: "mod-card" }, el("div", { class: "mod-body" },
      el("div", { class: "mono small" }, `${M.prefix}${fmtVal(measureValue(M), M.decimals, "Å")}`),
      row("Label prefix", txtIn(M.prefix, v => { M.prefix = v; upd(); refreshSide("overlays"); })),
      row("Measures", sel([["xyz", "Distance"], ["x", "Δx only"], ["y", "Δy only"], ["z", "Δz only"]], M.axis, v => { M.axis = v; upd(); refreshSide("overlays"); }, "Measured component")),
      row("Label side", sel([["right", "Right / above"], ["left", "Left / below"]], M.side, v => { M.side = v; upd(); }, "Label side")),
      row("Size / colour", el("div", { class: "duo" }, numIn(M.size, v => { M.size = v || 0.04; upd(); }, { step: 0.005 }), colIn(M.color, v => { M.color = v; upd(); }, "Line colour"))),
      row("Decimals", numIn(M.decimals, v => { M.decimals = Math.max(0, Math.min(4, Math.round(v ?? 2))); upd(); refreshSide("overlays"); }, { step: 1, min: 0, max: 4 })),
      el("div", { class: "field-row" }, chk("Show", M.visible !== false, v => { M.visible = v; upd(); }),
        el("button", { class: "btn ghost", type: "button", onclick: () => { S.overlays.measures.splice(S.overlays.measures.indexOf(M), 1); upd(); refreshSide("overlays"); } }, "Remove"))))));
    p.append(sec("Dimension lines",
      el("p", { class: "muted small" }, "Press Measure (viewport toolbar), then click two atoms. 'Δy only' measures the height difference, as for H in a side view. Positions are fixed in space, so the line stays valid when you change frames only if the atoms did not move."),
      row("New lines measure", sel([["xyz", "Distance"], ["x", "Δx only"], ["y", "Δy only"], ["z", "Δz only"]], S.measureAxis, v => { S.measureAxis = v; save(); }, "Default measured component")),
      ms));
  }

  // -- render
  function buildRender(p) {
    const r = S.render, upd = () => { save(); requestDraw(); };
    const presets = [["", "Size preset…"], ["1600x1000", "1600 × 1000"], ["1920x1080", "1920 × 1080 (16:9)"], ["2400x1800", "2400 × 1800 (4:3)"], ["2000x2000", "2000 × 2000 (square)"], ["3000x1200", "3000 × 1200 (wide)"]];
    p.append(sec("Output image",
      row("Width / height (px)", el("div", { class: "duo" }, numIn(r.w, v => { r.w = Math.max(64, Math.round(v || 1600)); upd(); }, { min: 64, step: 1 }), numIn(r.h, v => { r.h = Math.max(64, Math.round(v || 1000)); upd(); }, { min: 64, step: 1 }))),
      sel(presets, "", v => { if (!v) return; [r.w, r.h] = v.split("x").map(Number); upd(); refreshSide("render"); }, "Image size preset"),
      row("Background", colIn(r.bg, v => { r.bg = v; upd(); }, "Background colour")),
      el("div", { class: "field-row" }, chk("Transparent background", r.transparent, v => { r.transparent = v; save(); }), chk("Preview frame", r.preview, v => { r.preview = v; tools.querySelector("[data-act=preview]").setAttribute("aria-pressed", v); upd(); })),
      row("Antialiasing", sel([[1, "Off"], [2, "2× supersampling"], [3, "3× supersampling"]], r.ss, v => { r.ss = +v; save(); }, "Antialiasing")),
      row("File name", txtIn(r.name, v => { r.name = v; save(); }, { placeholder: defaultName() })),
      el("button", { class: "btn primary", type: "button", onclick: renderImage }, svg("download"), "Render image"),
      el("p", { class: "muted small" }, "The image contains exactly what is inside the preview frame, at the size above, with the overlays. Sizes of text and legends are relative to the image height.")));
    const M = r.movie, last = src ? src.n_frames - 1 : 0, cc = coloring();
    p.append(sec("Movie",
      row("Frames from / to", el("div", { class: "duo" }, numIn(M.from, v => { M.from = v == null ? 0 : Math.max(0, Math.round(v)); save(); }, { min: 0, max: last, step: 1 }),
        numIn(M.to, v => { M.to = v == null ? null : Math.max(0, Math.round(v)); save(); }, { min: 0, max: last, step: 1, placeholder: `${last} (last)` }))),
      row("Every n-th frame", numIn(M.every, v => { M.every = Math.max(1, Math.round(v || 1)); save(); }, { min: 1, step: 1 })),
      row("Frames per second", numIn(M.fps, v => { M.fps = Math.max(1, Math.min(120, v || 10)); save(); }, { min: 1, max: 120, step: 1 })),
      row("Format", sel([["mp4", "MP4 video (H.264)"], ["png", "PNG sequence into a folder (lossless)"]], M.format, v => { M.format = v; save(); refreshSide("render"); }, "Movie format")),
      M.format === "mp4" ? row("Quality", sel([["standard", "Standard"], ["high", "High"], ["max", "Maximum"]], M.quality, v => { M.quality = v; save(); }, "Video quality")) : null,
      row("MD time step (fs)", numIn(r.dt_fs, v => { r.dt_fs = v > 0 ? v : null; save(); requestDraw(); }, { min: 0, step: "any", placeholder: "for [Time] in labels" })),
      M.format === "mp4" && !canEncode() ? el("div", { class: "banner warn" }, "This browser has no video encoder (WebCodecs). Use Chrome, Edge or Firefox, or the PNG sequence.") : null,
      M.format === "png" && !canWriteFolder() ? el("div", { class: "banner warn" }, "Saving into a folder needs Chrome or Edge.") : null,
      el("button", { class: "btn primary", type: "button", onclick: renderMovie, disabled: !src }, svg("play"), "Render movie"),
      el("p", { class: "muted small" }, `Each frame is rendered like Render image (size, background, antialiasing, overlays) and shown for exactly 1/fps s. Text labels can show [Timestep], [Frame] and [Time]. ${cc ? `The colour range stays fixed at ${num(cc.start, 4)} … ${num(cc.end, 4)} for every frame. ` : ""}MP4 sizes are rounded up to even numbers.`)));
    const file = el("input", { type: "file", accept: ".json,application/json", hidden: true, onchange: async e => {
      const f = e.target.files[0]; if (!f) return;
      try { Object.assign(S, loadSession(JSON.parse(await f.text()))); save(); refreshSide(); buildToolsAgain(); await changed(); toast("Session loaded.", "ok"); }
      catch (err) { toast(`Not a Studio session file: ${err.message}`, "err"); }
    } });
    p.append(sec("Session",
      el("p", { class: "muted small" }, "Pipeline, colours, overlays and render settings are remembered in this browser. Save them to a file to reuse the same look for every case (a1…c3)."),
      el("div", { class: "field-row" },
        el("button", { class: "btn", type: "button", onclick: () => download("nanocut-studio-session.json", JSON.stringify(S, strip, 2), "application/json") }, "Save session"),
        el("button", { class: "btn", type: "button", onclick: () => file.click() }, "Load session"), file,
        el("button", { class: "btn ghost", type: "button", onclick: () => { const keep = { recent: S.recent, last: S.last }; Object.assign(S, defaults(), keep); save(); refreshSide(); buildToolsAgain(); changed(); toast("Settings reset.", "ok"); } }, "Reset"))));
  }
  function buildToolsAgain() { clear(tools); buildTools(); if (cam) cam.proj = S.viewport.proj; }
  const defaultName = () => src ? `${src.pattern.replace(/\*.*$/, "").replace(/[^\w.-]+/g, "_").replace(/[._]+$/, "")}_step${frame ? frame.meta.step : 0}.png` : "nanocut.png";

  /** The current frame as the exported image: w x h, supersampled, with overlays. Returns {canvas, big} or throws. */
  function compose(w, h, transparent, cv) {
    const ss = Math.max(1, Math.min(3, S.render.ss | 0));
    let k = ss;
    while (k > 1 && (w * k > R.maxImage || h * k > R.maxImage)) k--;
    if (w * k > R.maxImage || h * k > R.maxImage) throw new Error(`image too large for this GPU (max ${R.maxImage} px per side)`);
    const m = matrices(cam, w / h, scene, 1);
    const big = Math.max(...Object.values(S.types).map(t => +t.radius || 1)) * S.viewport.rscale * h * k * m.proj[5] > R.maxPoint;
    const bg = transparent ? [0, 0, 0, 0] : [...bgRgb(), 1];
    const img = R.renderImage(w * k, h * k, { view: m.view, proj: m.proj, bg, rscale: S.viewport.rscale, flat: S.viewport.flat, cellColor: S.viewport.cell ? (lum(bgRgb()) > 0.5 ? [0.1, 0.1, 0.1] : [0.6, 0.62, 0.66]) : null });
    cv = cv || el("canvas", { width: w, height: h });
    const c = cv.getContext("2d");
    c.clearRect(0, 0, w, h);
    c.imageSmoothingEnabled = true; c.imageSmoothingQuality = "high";
    c.drawImage(img, 0, 0, w, h);
    drawOverlays(c, { x: 0, y: 0, w, h }, overlaysHere(), m, coloring(), labelVars());
    return { canvas: cv, big };
  }
  async function renderImage() {
    if (!frame || !cam) { toast("Open a trajectory first.", "warn"); return; }
    const { w, h } = S.render;
    try {
      const { canvas, big } = compose(w, h, S.render.transparent);
      requestDraw();
      const blob = await new Promise(r => canvas.toBlob(r, "image/png"));
      showImage(blob, S.render.name || defaultName(), w, h, big ? `Atoms larger than ${R.maxPoint} px are drawn at that size by this GPU; zoom out or lower the image size.` : null);
    } catch (e) { toast(`Render failed: ${e.message}`, "err"); requestDraw(); }
  }
  let movieCancel = false;
  async function renderMovie() {
    if (!frame || !cam) { toast("Open a trajectory first.", "warn"); return; }
    const M = S.render.movie, n = src.n_frames, clampF = v => Math.max(0, Math.min(n - 1, v));
    const a = clampF(M.from ?? 0), b = clampF(M.to ?? n - 1), every = Math.max(1, M.every | 0), fps = Math.max(1, Math.min(120, +M.fps || 10));
    if (b < a) { toast("The last frame is before the first.", "warn"); return; }
    const list = [];
    for (let i = a; i <= b; i += every) list.push(i);
    let w = S.render.w, h = S.render.h, writer, what;
    const prefix = src.pattern.replace(/\*.*$/, "").replace(/[^\w.-]+/g, "_").replace(/[._]+$/, "") || "frame";
    stop();
    if (M.format === "png") {
      if (!canWriteFolder()) { toast("Saving a PNG sequence needs Chrome or Edge (folder access).", "err"); return; }
      try { writer = await pngFolderWriter(prefix); } catch (e) { if (e.name !== "AbortError") toast(e.message, "err"); return; }
      what = `PNG frames into “${writer.folder}”`;
    } else {
      w += w % 2; h += h % 2;
      const bpp = { standard: 0.08, high: 0.15, max: 0.3 }[M.quality] ?? 0.15;
      const codec = await pickCodec(w, h, fps, Math.round(Math.min(80e6, Math.max(1e6, w * h * fps * bpp))));
      if (!codec) { toast("This browser cannot encode video at this size. Try a smaller image or the PNG sequence.", "err"); return; }
      writer = mp4Writer(codec, fps);
      what = `${codec.label} MP4, ${w} × ${h}, ${fps} fps`;
    }
    movieCancel = false;
    const bar = el("i", {}), msg = el("span", { class: "muted" }, "Starting…");
    const dlg = el("div", { class: "modal-backdrop open", role: "dialog", "aria-modal": "true", "aria-label": "Rendering movie" },
      el("div", { class: "modal" }, el("div", { class: "panel-head" }, el("h3", {}, "Rendering movie"), el("span", { class: "sub" }, `${list.length} frames · ${what}`)),
        el("div", { class: "panel-body grid1" }, el("div", { class: "progress", style: { width: "100%" } }, bar), msg,
          el("div", { class: "field-row" }, el("button", { class: "btn", type: "button", onclick: () => { movieCancel = true; msg.textContent = "Stopping…"; } }, "Cancel")))));
    document.body.append(dlg);
    const home = fi, cv = el("canvas", { width: w, height: h }), t0 = performance.now();
    try {
      for (let k = 0; k < list.length; k++) {
        if (movieCancel || !alive) throw new Error("cancelled");
        await loadFrame(list[k]);
        if (fi !== list[k] || !frame) throw new Error(`frame ${list[k]} could not be loaded`);
        compose(w, h, M.format === "png" && S.render.transparent, cv);
        await writer.add(cv, String(list[k]).padStart(String(n - 1).length, "0"));
        bar.style.width = `${(100 * (k + 1)) / list.length}%`;
        const eta = (performance.now() - t0) / (k + 1) * (list.length - k - 1) / 1000;
        msg.textContent = `Frame ${list[k]} · ${k + 1} of ${list.length}${k + 1 < list.length ? ` · about ${eta < 90 ? `${Math.ceil(eta)} s` : `${Math.ceil(eta / 60)} min`} left` : ""}`;
      }
      if (M.format === "png") toast(`${list.length} PNG frames saved to “${writer.folder}”.`, "ok");
      else {
        msg.textContent = "Finishing the MP4 file…";
        const blob = await writer.finish(), name = `${prefix}_${list[0]}-${list.at(-1)}.mp4`;
        download(name, blob, "video/mp4");
        toast(`${name} · ${bytes(blob.size)} · ${(list.length / fps).toFixed(1)} s`, "ok");
      }
    } catch (e) {
      writer.abort?.();
      e.message === "cancelled" ? toast("Movie cancelled.", "warn") : toast(`Movie stopped: ${e.message}`, "err");
    } finally {
      dlg.remove();
      if (alive && fi !== home) await loadFrame(home);
      requestDraw();
    }
  }
  function showImage(blob, name, w, h, warn) {
    const url = URL.createObjectURL(blob);
    const close = () => { URL.revokeObjectURL(url); back.remove(); document.removeEventListener("keydown", esc); };
    const esc = e => { if (e.key === "Escape") close(); };
    const save = () => { const a = el("a", { href: url, download: name.endsWith(".png") ? name : name + ".png" }); document.body.append(a); a.click(); a.remove(); };
    const copy = async () => {
      try { await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]); toast("Image copied to the clipboard.", "ok"); }
      catch (e) { toast(`Clipboard not available: ${e.message}`, "err"); }
    };
    const back = el("div", { class: "modal-backdrop open", role: "dialog", "aria-modal": "true", "aria-label": "Rendered image", onclick: e => { if (e.target === back) close(); } },
      el("div", { class: "modal wide" },
        el("div", { class: "panel-head" }, el("h3", {}, "Rendered image"), el("span", { class: "sub" }, `${w} × ${h} px · ${bytes(blob.size)}`),
          el("div", { class: "actions" }, el("button", { class: "btn primary", type: "button", onclick: save }, svg("download"), "Download PNG"),
            el("button", { class: "btn", type: "button", onclick: copy }, svg("copy"), "Copy"), el("button", { class: "btn", type: "button", onclick: close }, "Close"))),
        el("div", { class: "panel-body st-render" }, warn ? el("div", { class: "banner warn" }, warn) : null, el("img", { src: url, alt: `Rendered image ${name}` }))));
    document.body.append(back); document.addEventListener("keydown", esc);
    back.querySelector(".btn.primary").focus();
  }

  // -- pile-up analysis
  let lastPile = null;
  function buildAnalysis(p) {
    const A = S.analysis;
    const res = el("div", {});
    p.append(sec("Pile-up and burr measurement",
      el("p", { class: "muted small" }, "Uses the atoms shown after the pipeline (remove the tool first: Select type → Delete selected). Height is measured along the surface normal, width across the scratch. All lengths in Å."),
      row("Surface normal", sel(["x", "y", "z"], A.normal, v => { A.normal = v; save(); }, "Surface normal axis")),
      row("Width axis", sel(["x", "y", "z"], A.width, v => { A.width = v; save(); }, "Width axis")),
      row("Surface level (Å)", numIn(A.surface, v => { A.surface = v; A.surfaceFrom = v == null ? null : { source: src?.id, manual: true }; save(); refreshSide("analysis"); }, { placeholder: "not set" })),
      el("div", { class: "field-row" },
        el("button", { class: "btn", type: "button", "data-tip": "Original surface: loads frame 0, applies the pipeline (tool removed), takes the median over 10 Å × 10 Å surface cells of the highest atom per cell, then returns to this frame.", onclick: detectOnFirst }, "Detect on frame 0"),
        el("button", { class: "btn ghost", type: "button", "data-tip": "Same method on the current frame. Unreliable once the groove covers more than half of the surface (narrow periodic boxes).", onclick: () => setSurface(detectSurface(), fi) }, "This frame")),
      A.surfaceFrom ? el("p", { class: "muted small" }, A.surfaceFrom.manual ? "Surface level typed in." : `Detected on frame ${A.surfaceFrom.frame} (step ${num(A.surfaceFrom.step)}).`) : null,
      row("Threshold above surface", numIn(A.thr, v => { A.thr = Math.max(0, v ?? 1); save(); }, { min: 0, step: 0.1 })),
      el("button", { class: "btn primary", type: "button", onclick: () => { lastPile = pileUp(); refreshSide("analysis"); } }, "Measure this frame"), res));
    if (lastPile && lastPile.frame === fi) {
      const r = lastPile;
      res.append(r.error ? el("p", { class: "status error" }, r.error) : el("div", { class: "grid1" },
        el("table", { class: "data compact" }, el("tbody", {},
          [["Surface level", fmtVal(r.S, 3, "Å")], ["Highest atom above surface (H)", fmtVal(r.H, 2, "Å")], [`Atoms higher than surface + ${r.thr} Å`, num(r.count)],
            [`Width of those atoms along ${r.wAxis} (D)`, r.count ? fmtVal(r.D, 2, "Å") : "—"], [`Their extent along x`, r.count ? `${num(r.xr[0], 2)} … ${num(r.xr[1], 2)} Å` : "—"]]
            .map(([k, v]) => el("tr", {}, el("td", {}, k), el("td", { class: "num" }, v))))),
        el("div", { class: "field-row" },
          el("button", { class: "btn", type: "button", onclick: () => addDim("H = ", r.hA, r.hB, r.nAxis) }, "Add H to image"),
          r.count ? el("button", { class: "btn", type: "button", onclick: () => addDim("D = ", r.dA, r.dB, r.wAxis) }, "Add D to image") : null),
        el("p", { class: "muted small" }, `Frame ${fi}, step ${num(frame.meta.step)}; ${num(r.n)} atoms evaluated. H is the height of the topmost atom; D is the full lateral span (min to max) of all atoms above the threshold, including both pile-up ridges.`)));
    }
  }
  function axisCols(a) { return frame?.cols[a]; }
  function setSurface(s, at) {
    if (s == null) return;
    S.analysis.surface = +s.toFixed(3);
    S.analysis.surfaceFrom = { source: src.id, frame: at, step: frame.meta.step };
    save(); refreshSide("analysis");
  }
  async function detectOnFirst() {
    if (!src) return;
    const back = fi;
    if (fi !== 0) await loadFrame(0);
    if (fi !== 0) return;                                  // loading failed (already reported)
    setSurface(detectSurface(), 0);
    if (back !== 0) await loadFrame(back);
  }
  function detectSurface() {
    if (!out) { toast("Open a trajectory first.", "warn"); return null; }
    // median over 10 Å x 10 Å surface cells of the highest atom in each cell: groove and pile-up cells are a minority
    const k = "xyz".indexOf(S.analysis.normal), [a, b] = ["x", "y", "z"].filter((_, j) => j !== k).map(c => frame.cols[c]);
    const v = axisCols(S.analysis.normal), top = new Map();
    for (const i of out.idx) {
      const key = Math.floor(a[i] / 10) * 1e6 + Math.floor(b[i] / 10), t = top.get(key);
      if (t === undefined || v[i] > t) top.set(key, v[i]);
    }
    if (!top.size) return null;
    const m = [...top.values()].sort((p, q) => p - q);
    return m[Math.floor(m.length / 2)];
  }
  function pileUp() {
    if (!out) return { frame: fi, error: "No frame loaded." };
    const A = S.analysis, S0 = A.surface;
    if (S0 == null) return { frame: fi, error: "Set the surface level first (Detect on frame 0, or type it)." };
    const nv = axisCols(A.normal), wv = axisCols(A.width), x = frame.cols.x, y = frame.cols.y, z = frame.cols.z;
    let top = -1, H = -Infinity, count = 0, wmin = Infinity, wmax = -Infinity, imin = -1, imax = -1, x0 = Infinity, x1 = -Infinity;
    for (const i of out.idx) {
      const h = nv[i] - S0;
      if (h > H) { H = h; top = i; }
      if (h > A.thr) {
        count++;
        if (wv[i] < wmin) { wmin = wv[i]; imin = i; } if (wv[i] > wmax) { wmax = wv[i]; imax = i; }
        if (x[i] < x0) x0 = x[i]; if (x[i] > x1) x1 = x[i];
      }
    }
    const P = i => [x[i], y[i], z[i]].map(Number), k = "xyz".indexOf(A.normal);
    const hB = P(top), hA = hB.map((v, j) => (j === k ? S0 : v));
    const dA = imin >= 0 ? P(imin) : null, dB = imax >= 0 ? P(imax) : null;
    if (dA && dB) { const lvl = Math.max(dA[k], dB[k]); dA[k] = lvl; dB[k] = lvl; }
    return { frame: fi, S: S0, H, count, D: wmax - wmin, xr: [x0, x1], thr: A.thr, n: out.idx.length, nAxis: A.normal, wAxis: A.width, hA, hB, dA, dB };
  }
  function addDim(prefix, a, b, axis) {
    S.overlays.measures.push({ source: src.id, a, b, axis, prefix, color: "#000000", size: 0.045, decimals: 2, side: "left", serif: true, bold: true });
    save(); requestDraw(); toast(`${prefix.trim()} line added (Overlays tab to style it).`, "ok");
  }

  // -- data inspector
  function buildData(p) {
    if (!frame) { p.append(el("p", { class: "muted" }, "Open a trajectory first.")); return; }
    const m = frame.meta, c = m.cell;
    p.append(sec("Frame",
      el("dl", { class: "kv" }, el("dt", {}, "File"), el("dd", {}, m.file), el("dt", {}, "Step (header)"), el("dd", {}, num(m.step)),
        el("dt", {}, "Atoms"), el("dd", {}, num(m.natoms)), el("dt", {}, "Shown / selected"), el("dd", {}, `${num(out?.idx.length ?? 0)} / ${num(out?.nsel ?? 0)}`),
        el("dt", {}, "Cell origin"), el("dd", {}, c.origin.map(v => num(v, 3)).join("  ")),
        el("dt", {}, "Cell lengths"), el("dd", {}, [c.a[0], c.b[1], c.c[2]].map(v => num(v, 3)).join("  ") + " Å"),
        el("dt", {}, "Boundaries"), el("dd", {}, c.flags.join(" ") + (c.triclinic ? " · triclinic" : "")),
        m.reference ? el("dt", {}, "Displacement ref.") : null, m.reference ? el("dd", {}, `frame ${m.reference.index}, step ${num(m.reference.step)}; minimum image along ${["x", "y", "z"].filter((_, k) => m.reference.minimum_image[k]).join(", ") || "none"}${m.reference.missing ? `; ${num(m.reference.missing)} atoms missing in the reference` : ""}`) : null)));
    p.append(sec("Columns (all atoms of this frame)", el("div", { class: "table-wrap" }, el("table", { class: "data compact" },
      el("thead", {}, el("tr", {}, el("th", {}, "Column"), el("th", { class: "num" }, "Min"), el("th", { class: "num" }, "Max"))),
      el("tbody", {}, m.columns.map(k => el("tr", {}, el("td", { class: "mono" }, k), el("td", { class: "num" }, num(m.stats[k]?.min, 4)), el("td", { class: "num" }, num(m.stats[k]?.max, 4)))))))));
    const r = frame.pickedRow;
    p.append(sec("Picked atom", r && picked != null ? el("table", { class: "data compact" }, el("tbody", {}, Object.entries(r).map(([k, v]) => el("tr", {}, el("td", { class: "mono" }, k), el("td", { class: "num" }, num(v, 6))))))
      : el("p", { class: "muted small" }, "Click an atom in the viewport.")));
  }

  // ---------------------------------------------------------------------------------------------- start
  openBtn.onclick = () => scanAndOpen(pathIn.value);
  pathIn.addEventListener("keydown", e => { if (e.key === "Enter") scanAndOpen(pathIn.value); });
  buildSide();
  resize();
  startState();
  if (localDlg && S.last?.path && !S.last.local) { pathIn.value = S.last.path; scanAndOpen(S.last.path); }   // reopen where you left off

  return () => { alive = false; playing = false; ro.disconnect(); document.removeEventListener("keydown", onKey); cancelAnimationFrame(raf); };
}
