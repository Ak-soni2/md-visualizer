// OVITO page: a live 3D viewport over the official OVITO Python module (pip package `ovito`).
// OVITO does all the science on the server: it reads the dump, runs the modifiers of this page and decides every
// particle's position, colour and radius (its ParticlesVis rules). The browser only draws that result in 3D on the GPU,
// so you can rotate, zoom, scrub and play frames like in OVITO's own viewport; any change of the pipeline is
// re-evaluated by OVITO at once. "Render with OVITO" hands the exact camera of the viewport to OVITO's renderers
// (OpenGL or Tachyon) for the final image or movie, and the generated OVITO script reproduces every result.
// Files come from a path the server can read, or are uploaded from this computer to the server.
import * as api from "../api.js";
import { state } from "../state.js";
import { el, clear, num, bytes, toast, loading, errorState, download, svg, tabs } from "../ui.js";
import { AtomRenderer, VIEWS, matrices, V } from "../studio/render.js";
import { browserSource } from "../studio/source.js";
import { pickCodec, mp4Writer } from "../studio/movie.js";
import { buildFramesPanel, exportDefaults } from "./ovito_frames.js";
import { openHpc } from "./ovito_hpc.js";
import { buildDbtPanel, dbtDefaults } from "./ovito_dbt.js";
import { buildMeasurePanel, drawMeasures } from "./ovito_measure.js";
import { buildResearchPanel } from "./ovito_research.js";

const KEY = "nanocut.ovito.v2";
const MODS = [
  ["select_type", "Select type"], ["expression_selection", "Expression selection"], ["invert_selection", "Invert selection"],
  ["clear_selection", "Clear selection"], ["delete_selected", "Delete selected"], ["slice", "Slice"],
  ["displacements", "Displacement vectors"], ["coordination", "Coordination analysis"], ["identify_diamond", "Identify diamond structure"],
  ["cna", "Common neighbor analysis"], ["dxa", "Dislocation analysis (DXA)"], ["compute_property", "Compute property"],
  ["color_coding", "Color coding"], ["assign_color", "Assign color"],
];
const MOD_LABEL = Object.fromEntries(MODS);
const MOD_HELP = {
  select_type: "Selects all particles of the chosen types (OVITO SelectTypeModifier).",
  expression_selection: "OVITO expression, e.g.  Position.Y > 437.27 && ParticleType != 1 . The number of selected particles appears in the results (ExpressionSelection.count).",
  delete_selected: "Removes the selected particles (e.g. the tool) from the view and from all later modifiers.",
  slice: "OVITO SliceModifier: plane n·r = distance; slab width 0 cuts the structure at the plane, a positive width keeps a slab. Invert keeps the other side; Select only selects instead of deleting.",
  displacements: "OVITO CalculateDisplacementsModifier: Displacement (x, y, z) and Displacement Magnitude relative to the reference frame, minimum image convention across periodic boundaries.",
  coordination: "OVITO CoordinationAnalysisModifier: Coordination per particle within the cutoff (Å) and the radial distribution function.",
  identify_diamond: "OVITO IdentifyDiamondModifier: cubic/hexagonal diamond and their neighbours, other = disordered (suits 3C-SiC zinc-blende). Colours atoms by Structure Type; counts appear in the results.",
  cna: "OVITO CommonNeighborAnalysisModifier (adaptive): FCC/HCP/BCC/ICO/other, for metals.",
  dxa: "OVITO DislocationAnalysisModifier: dislocation lines (drawn in green) and their total length for the chosen crystal lattice.",
  compute_property: "OVITO ComputePropertyModifier: new per-particle property from OVITO expressions (one expression per component).",
  color_coding: "OVITO ColorCodingModifier. Empty Start/End: OVITO adjusts the range to every frame; set both to keep one scale for all frames (movies, comparisons).",
  assign_color: "Gives the selected particles one colour.",
  invert_selection: "Inverts the current selection.", clear_selection: "Clears the selection.",
};
const GRADIENTS = ["Rainbow", "Jet", "Hot", "Grayscale", "BlueWhiteRed", "Viridis", "Magma", "CyclicRainbow"];
const ALIGNS = ["top-left", "top", "top-right", "left", "right", "bottom-left", "bottom", "bottom-right"];
const DXA = ["CubicDiamond", "HexagonalDiamond", "FCC", "BCC", "HCP"];
const OUTPUTS = { displacements: ["Displacement.X", "Displacement.Y", "Displacement.Z", "Displacement Magnitude"], coordination: ["Coordination"],
  identify_diamond: ["Structure Type"], cna: ["Structure Type"], dxa: ["Structure Type", "Cluster"] };
const VIEW_TIP = {
  Top: "Top: looking down −z; x right, y up (side view of a NanoCut workpiece)", Bottom: "Bottom: looking up +z", Front: "Front: looking along +y; x right, z up",
  Back: "Back: looking along −y", Left: "Left: looking along +x", Right: "Right: looking along −x", Ortho: "Oblique view from (1, 1, 1)",
  Surface: "Looking down −y onto a NanoCut surface (normal y); x right",
};
const CHUNK = 8 << 20;                                                 // upload chunk (bytes)

const defaults = () => ({
  last: null, recent: [], frame: 0, types: {}, cell: true, live: true, fps: 10, export: exportDefaults(), dbt: dbtDefaults(),
  modifiers: [],
  viewport: { proj: "ortho", view: "Top", preview: false },
  render: { w: 1600, h: 1000, bg: "#ffffff", alpha: false, renderer: "tachyon", aa_gl: 3, aa: 12, ao: true, shadows: false,
    anim: { start: 0, end: null, every: 1, fps: 10 } },
  overlays: { legend: { enabled: true, orientation: "vertical", align: "right", title: "", format: "%.2f Å", font_size: 0.1, size: 0.3, color: "#000000", ox: 0, oy: 0 },
    tripod: { enabled: true, align: "bottom-left", size: 0.07, ox: 0, oy: 0 }, labels: [] },
});
function load(raw) {
  const d = defaults();
  let s = raw;
  if (!s) try { s = JSON.parse(localStorage.getItem(KEY) || "null"); } catch { s = null; }
  if (!s || typeof s !== "object") return d;
  for (const k of ["viewport", "render"]) d[k] = { ...d[k], ...(s[k] || {}) };
  d.render.anim = { ...defaults().render.anim, ...(s.render?.anim || {}) };
  d.overlays = { legend: { ...d.overlays.legend, ...(s.overlays?.legend || {}) }, tripod: { ...d.overlays.tripod, ...(s.overlays?.tripod || {}) }, labels: s.overlays?.labels || [] };
  for (const k of ["last", "recent", "frame", "types", "cell", "modifiers", "live", "fps", "export", "dbt", "measures", "measureSet", "sideTab", "lastDir"]) if (s[k] !== undefined) d[k] = s[k];
  d.modifiers = (d.modifiers || []).filter(m => MOD_LABEL[m.type]);
  return d;
}

// small form helpers
const numIn = (v, on, a = {}) => el("input", { class: "input num", type: "number", step: "any", value: v ?? "", onchange: e => on(e.target.value === "" ? null : +e.target.value), ...a });
const txtIn = (v, on, a = {}) => el("input", { class: "input", type: "text", value: v ?? "", onchange: e => on(e.target.value), ...a });
const colIn = (v, on, label) => el("input", { class: "color", type: "color", value: v, "aria-label": label, oninput: e => on(e.target.value) });
const sel = (opts, v, on, label) => el("select", { class: "select", "aria-label": label, onchange: e => on(e.target.value) },
  opts.map(o => { const [val, lab] = Array.isArray(o) ? o : [o, o]; return el("option", { value: val, selected: String(val) === String(v) }, lab); }));
const chk = (label, v, on, tip) => el("label", { class: "check", "data-tip": tip }, el("input", { type: "checkbox", checked: !!v, onchange: e => on(e.target.checked) }), label);
const row = (label, ...c) => el("label", { class: "frow" }, el("span", {}, label), el("div", { class: "fctl" }, ...c));
const sec = (title, ...kids) => el("section", { class: "st-sec" }, el("h4", {}, title), ...kids);
const safeName = s => s.replace(/[^\w.\-*]/g, "_").replace(/^\.+/, "_");
const randHex = () => [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, "0")).join("");

export async function render(root) {
  if (api.apiMode() !== "live") {
    root.append(el("div", { class: "view" }, el("div", { class: "state" }, el("b", {}, "The OVITO page needs the Python backend"),
      el("span", {}, "OVITO runs on the server. Start webapp\\run_web.bat and open http://127.0.0.1:8600."))));
    return;
  }
  let st;
  try { st = await api.get("/api/ovito/status"); } catch (e) { root.append(errorState(e)); return; }
  if (!st.available) {
    root.append(el("div", { class: "view" }, el("div", { class: "state err" }, el("b", {}, "OVITO is not available on this server"), el("span", {}, st.error),
      st.hosted ? null : el("span", {}, "Install it into the project environment: ", el("code", {}, st.install)))));
    return;
  }

  const S = load();
  let saveT = 0, liveT = 0;
  const save = () => { clearTimeout(saveT); saveT = setTimeout(() => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch { /* not remembered */ } }, 300); };
  /** settings that change what OVITO computes: save, and re-evaluate the current frame (debounced) */
  const changed = () => { save(); if (!S.live || !src) return; clearTimeout(liveT); liveT = setTimeout(() => { cache.clear(); loadFrame(fi); }, 350); };

  // ---------------------------------------------------------------------------------------------- layout
  const pickFiles = el("input", { type: "file", multiple: true, hidden: true, onchange: e => { uploadPicked(e.target.files); e.target.value = ""; } });
  const pickDir = el("input", { type: "file", webkitdirectory: "", multiple: true, hidden: true, onchange: e => { uploadPicked(e.target.files); e.target.value = ""; } });
  const pathIn = el("input", { class: "input path", type: "text", list: "ov-paths", placeholder: "Or a folder / dump file on the server, e.g. D:\\Akshay\\Cutting_20_30\\AE", "aria-label": "Folder or dump file on the server", value: S.last?.path || "" });
  const pathList = el("datalist", { id: "ov-paths" });
  const seqSel = el("select", { class: "select seq", "aria-label": "Trajectory", hidden: true });
  const srcInfo = el("span", { class: "st-src muted" });
  const hosted = api.apiHosted();
  // local backend: files are read where they are (the backend shows the system dialog and gets the real path, so
  // nothing is copied); hosted: files are uploaded to the server's private store
  const openButtons = hosted ? [
    el("button", { class: "btn primary", type: "button", "data-tip": "Upload dump files from this computer to the OVITO server (kept 24 h)", onclick: () => pickFiles.click() }, "Upload files…"),
    el("button", { class: "btn", type: "button", "data-tip": "Upload a folder of dumps (searched two levels deep)", onclick: () => pickDir.click() }, "Upload folder…")] : [
    el("button", { class: "btn primary", type: "button", "data-tip": "Choose a folder on this computer; OVITO reads the dumps in place (nothing is copied)", onclick: () => localPick("folder") }, "Open folder…"),
    el("button", { class: "btn", type: "button", "data-tip": "Choose one multi-frame dump or several frame files; read in place", onclick: () => localPick("files") }, "Open file(s)…"),
    el("button", { class: "btn ghost", type: "button", "data-tip": "Browse the folders of this computer inside the page (if no dialog appears)", onclick: () => browseLocal(S.lastDir || "") }, "Browse…")];
  const bar = el("div", { class: "st-bar" }, svg("folder"), ...openButtons,
    api.apiHosted() ? null : el("button", { class: "btn", type: "button", "data-tip": "Connect to an HPC cluster over SSH and open dumps that stay there", onclick: () => openHpc((source, label) => open(source, { ...source, label })) }, "HPC…"),
    pickFiles, pickDir, pathIn, pathList, el("button", { class: "btn", type: "button", onclick: () => scan(pathIn.value) }, "Open path"), seqSel, srcInfo);
  const glc = el("canvas", { class: "gl", "aria-hidden": "true" });
  const ovc = el("canvas", { class: "ov", tabindex: "0", role: "img", "aria-label": "OVITO viewport. Drag to rotate, right-drag or Shift-drag to pan, wheel to zoom, double-click to zoom all, click a particle to inspect it." });
  const hud = el("div", { class: "st-hud", hidden: true }), pickHud = el("div", { class: "st-pick", hidden: true });
  const tools = el("div", { class: "st-tools" }), overlayState = el("div", { class: "st-state" });
  const stage = el("div", { class: "st-stage" }, glc, ovc, hud, pickHud, tools, overlayState);
  const side = el("aside", { class: "st-side", "aria-label": "OVITO panels" });
  const time = el("div", { class: "st-time" });
  root.append(el("div", { class: "studio" }, bar, stage, side, time));
  const runs = state.sims.filter(s => s.kind === "run" && s.n_frames).map(s => s.path);
  [...new Set([...S.recent, ...runs])].forEach(p => pathList.append(el("option", { value: p })));
  pathIn.addEventListener("keydown", e => { if (e.key === "Enter") scan(pathIn.value); });

  let R;
  try { R = new AtomRenderer(glc); } catch (e) { clear(stage).append(errorState(e)); return; }

  // ---------------------------------------------------------------------------------------------- state
  let src = null, info = null, fi = 0, frame = null, cam = null, scene = { center: [0, 0, 0], radius: 100 }, regimeMap = null;
  let measureMode = null, measureA = null, measureDone = null;            // two-point measurement in the viewport
  const srcKey = () => (src ? JSON.stringify([src.path, src.dir, src.pattern, src.remote, src.upload, src.blob?.[0]?.pathname]) : "");
  function startMeasure(axis, done) {
    if (!frame) { toast("Open a trajectory first.", "warn"); return; }
    measureMode = axis; measureA = null; measureDone = done; stage.classList.add("measuring");
    setHud("Measure: click the first particle (Esc cancels)");
  }
  function endMeasure() { measureMode = null; measureA = null; stage.classList.remove("measuring"); setHud(); requestDraw(); }
  let playing = false, loadTok = 0, alive = true, raf = 0, picked = null;
  const cache = new Map();                                             // frame -> promise of {meta, pos, col, rad, lines}

  function showState(node) { clear(overlayState).append(node); overlayState.hidden = false; }
  let busyNode = null;
  function busy(msg) { busyNode = loading(msg, true); showState(busyNode); }
  function idle() { overlayState.hidden = true; clear(overlayState); busyNode = null; }

  // ---------------------------------------------------------------------------------------------- sources
  /** local backend: the system dialog runs on this computer and returns real paths, which are opened in place */
  async function localPick(kind) {
    let r;
    try { r = (await api.post("/api/local/pick", { kind, start: S.lastDir || "" }, 1800000)).body; }
    catch (e) { if (e.status === 501) { toast("No system dialog available here: browse inside the page instead.", "warn"); browseLocal(S.lastDir || ""); } else toast(e.message, "err"); return; }
    const paths = kind === "folder" ? (r.path ? [r.path] : []) : r.paths || [];
    if (!paths.length) return;                                         // cancelled
    const dir = kind === "folder" ? paths[0] : paths[0].replace(/[\\/][^\\/]*$/, "");
    S.lastDir = dir; save();
    if (kind === "folder" || paths.length > 1) { pathIn.value = dir; return scan(dir, paths.length > 1 ? paths.map(p => p.split(/[\\/]/).pop()) : null); }
    pathIn.value = paths[0]; scan(paths[0]);
  }
  /** fallback: folders of this computer listed by the local backend */
  async function browseLocal(path) {
    const body = el("div", { class: "panel-body grid1", style: { maxHeight: "70vh", overflow: "auto" } });
    const back = el("div", { class: "modal-backdrop open", role: "dialog", "aria-modal": "true", "aria-label": "Folders on this computer" },
      el("div", { class: "modal wide" }, el("div", { class: "panel-head" }, el("h3", {}, "Folders on this computer"), el("span", { class: "sub" }, "dumps are read in place, nothing is copied"),
        el("div", { class: "actions" }, el("button", { class: "btn", type: "button", onclick: () => back.remove() }, "Close"))), body));
    document.body.append(back);
    const go = async p => {
      clear(body).append(loading("Listing…"));
      let L;
      try { L = await api.get(`/api/local/list?path=${encodeURIComponent(p)}`); } catch (e) { clear(body).append(errorState(e)); return; }
      clear(body).append(
        el("div", { class: "field-row" }, el("b", { class: "mono" }, L.path || "This computer"),
          L.parent != null ? el("button", { class: "btn", type: "button", onclick: () => go(L.parent) }, "Up") : null,
          L.path ? el("button", { class: "btn primary", type: "button", onclick: () => { back.remove(); S.lastDir = L.path; save(); pathIn.value = L.path; scan(L.path); } }, "Open this folder") : null),
        L.files.length ? el("p", { class: "muted small" }, `${num(L.files.length)} dump-like files here (${bytes(L.files.reduce((t, f) => t + f.bytes, 0))})`) : null,
        el("div", { class: "chips" }, L.dirs.map(d => el("button", { class: "chip", type: "button", onclick: () => go(L.path ? `${L.path.replace(/[\\/]$/, "")}\\${d}` : d) }, L.path ? `${d}\\` : d))));
    };
    go(path);
  }

  async function scan(path, names) {
    path = (path || "").trim().replace(/^"|"$/g, "");
    if (!path) { toast("Enter a folder or dump file the server can read, or upload files.", "warn"); return; }
    busy("Looking for LAMMPS dump files…");
    let r;
    try { r = await api.get(`/api/studio/scan?path=${encodeURIComponent(path)}`); }
    catch (e) { idle(); return showState(errorState(e)); }
    if (!r.sequences.length) { idle(); return showState(el("div", { class: "state err" }, el("b", {}, "No LAMMPS dump found"), el("span", {}, r.path))); }
    let seqs = r.sequences;
    if (names?.length) {                                                // files picked in a folder: their sequence first
      const hit = seqs.filter(q => names.some(n => new RegExp("^" + q.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("\\*", "\\d+") + "$").test(n)));
      seqs = [...hit, ...seqs.filter(q => !hit.includes(q))];
    }
    pickSeq(seqs, seq => open({ path: seq.dir, pattern: seq.pattern }, { path, dir: seq.dir, pattern: seq.pattern }));
  }
  function pickSeq(seqs, go) {
    clear(seqSel);
    seqs.forEach((s, i) => seqSel.append(el("option", { value: i }, `${s.dir.split(/[\\/]/).pop()}/${s.pattern} · ${s.count} file${s.count > 1 ? "s" : ""} · ${bytes(s.bytes)}`)));
    seqSel.hidden = seqs.length < 2;
    seqSel.onchange = () => go(seqs[+seqSel.value]);
    go(seqs[0]);
  }

  async function uploadPicked(list) {
    if (!list?.length) return;
    busy("Looking for LAMMPS dump files…");
    let r;
    try { r = await browserSource.scan(list); } catch (e) { idle(); return showState(errorState(e)); }
    if (!r.sequences.length) { idle(); return showState(el("div", { class: "state err" }, el("b", {}, "No LAMMPS dump among the picked files"), el("span", {}, "Files must start with 'ITEM: TIMESTEP'."))); }
    pickSeq(r.sequences, seq => upload(seq, r.path));
  }
  /** hosted: one file straight to the private Blob store with a client token from the backend (single PUT, or 8 MB
   *  parts above 64 MB); nothing passes through the backend function. */
  async function blobUpload(f, name, session, onPart) {
    const tr = await fetch(api.apiUrl("/api/ovito/upload-token"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, size: f.size, session }) });
    const t = await tr.json();
    if (!tr.ok) throw new Error(t.detail || tr.statusText);
    const H = { authorization: `Bearer ${t.token}`, "x-api-version": t.version, "x-vercel-blob-store-id": t.store, "x-vercel-blob-access": "private" };   // (x-allow-overwrite is refused by the CORS preflight; paths are unique)
    const url = (path) => `${t.api}${path}?pathname=${encodeURIComponent(t.pathname)}`;
    const ok = async r => { const b = await r.json().catch(() => ({})); if (!r.ok) throw new Error(b.error?.message || r.statusText); return b; };
    if (!t.multipart) { await ok(await fetch(url("/"), { method: "PUT", headers: H, body: f })); onPart(f.size); return { name, pathname: t.pathname, size: f.size }; }
    const up = await ok(await fetch(url("/mpu"), { method: "POST", headers: { ...H, "x-mpu-action": "create" } }));
    const parts = [];
    for (let off = 0, n = 1; off < f.size; off += t.part_size, n++) {
      if (!alive) throw new Error("cancelled");
      const body = f.slice(off, Math.min(f.size, off + t.part_size));
      const r = await ok(await fetch(url("/mpu"), { method: "POST", body, headers: { ...H, "x-mpu-action": "upload", "x-mpu-key": encodeURIComponent(up.key), "x-mpu-upload-id": up.uploadId, "x-mpu-part-number": String(n) } }));
      parts.push({ etag: r.etag, partNumber: n });
      onPart(body.size);
    }
    await ok(await fetch(url("/mpu"), { method: "POST", body: JSON.stringify(parts), headers: { ...H, "content-type": "application/json", "x-mpu-action": "complete", "x-mpu-key": encodeURIComponent(up.key), "x-mpu-upload-id": up.uploadId } }));
    return { name, pathname: t.pathname, size: f.size };
  }
  async function upload(seq, label) {
    const sid = randHex(), files = seq._files, total = files.reduce((s, f) => s + f.size, 0), hosted = api.apiHosted();
    let sent = 0, cancel = false;
    const bar = el("i", {}), msg = el("span", { class: "muted" }, "");
    showState(el("div", { class: "state" }, el("b", {}, `Uploading ${num(files.length)} file${files.length > 1 ? "s" : ""} (${bytes(total)}) to the OVITO server`),
      el("div", { class: "progress", style: { width: "320px" } }, bar), msg,
      el("button", { class: "btn", type: "button", onclick: () => { cancel = true; } }, "Cancel")));
    const t0 = performance.now(), uploaded = [];
    const tick = (n, f) => {
      sent += n;
      const rate = sent / Math.max(0.001, (performance.now() - t0) / 1000);
      bar.style.width = `${(100 * sent) / total}%`;
      msg.textContent = `${bytes(sent)} of ${bytes(total)} · ${bytes(rate)}/s · ${f.name}${hosted ? " · private upload store" : ""}`;
    };
    try {
      for (const f of files) {
        const name = safeName(f.name);
        if (hosted) {
          if (cancel || !alive) throw new Error("cancelled");
          uploaded.push(await blobUpload(f, name, sid, n => tick(n, f)));
          continue;
        }
        for (let off = 0; off < f.size || off === 0; off += CHUNK) {
          if (cancel || !alive) throw new Error("cancelled");
          const body = f.slice(off, Math.min(f.size, off + CHUNK));
          const r = await fetch(api.apiUrl(`/api/ovito/upload/${sid}/${encodeURIComponent(name)}?offset=${off}`), { method: "POST", body });
          if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
          sent += body.size;
          const rate = sent / Math.max(0.001, (performance.now() - t0) / 1000);
          bar.style.width = `${(100 * sent) / total}%`;
          msg.textContent = `${bytes(sent)} of ${bytes(total)} · ${bytes(rate)}/s · ${f.name}`;
          if (f.size === 0) break;
        }
      }
    } catch (e) {
      idle();
      return e.message === "cancelled" ? toast("Upload cancelled.", "warn") : showState(errorState(e));
    }
    const pattern = safeName(seq.pattern);
    if (hosted) open({ blob: uploaded, pattern }, { blob: uploaded, pattern, label: `${label} (uploaded)` });
    else open({ upload: sid, pattern }, { upload: sid, pattern, label: `${label} (uploaded)` });
  }

  async function open(source, last) {
    stop();
    const same = S.last && JSON.stringify([S.last.upload, S.last.remote, S.last.blob?.[0]?.pathname, S.last.dir, S.last.pattern]) === JSON.stringify([last.upload, last.remote, last.blob?.[0]?.pathname, last.dir, last.pattern]);
    busy("OVITO reads the trajectory…");
    let inf;
    try { inf = await api.job("/api/ovito/info", { method: "POST", data: { ...source, frame: 0 }, pollMs: 200 }); }
    catch (e) { idle(); return showState(errorState(e, () => open(source, last))); }
    src = source; info = inf;
    if (!same) { S.frame = 0; S.types = {}; cam = null; }
    S.last = last;
    if (last.path) { S.recent = [last.path, ...S.recent.filter(p => p !== last.path)].slice(0, 8); pathIn.value = last.path; }
    for (const t of info.types) if (!S.types[t.id]) S.types[t.id] = { color: t.color, radius: t.radius };   // OVITO's own defaults (0: default radius)
    S.frame = Math.min(S.frame, info.num_frames - 1);
    S.render.anim.end = S.render.anim.end == null ? null : Math.min(S.render.anim.end, info.num_frames - 1);
    save();
    srcInfo.textContent = `OVITO: ${num(info.num_frames)} frames · ${num(info.count)} particles`;
    cache.clear(); frame = null;
    buildTimeline(); buildSide();
    await loadFrame(S.frame, true);
  }

  // ---------------------------------------------------------------------------------------------- frames
  const spec = (i = fi) => ({ source: src, frame: i, types: S.types, cell: S.cell, modifiers: S.modifiers });
  function fetchFrame(i) {
    if (!cache.has(i)) {
      const p = (async () => {
        const r = await fetch(api.apiUrl("/api/ovito/live"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ spec: spec(i) }) });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
        return decodeLive(await r.arrayBuffer());
      })();
      cache.set(i, p);
      p.catch(() => cache.delete(i));
      while (cache.size > 4) cache.delete(cache.keys().next().value);
    }
    return cache.get(i);
  }
  /** uint32 header length, JSON header (OVITO's numbers + layout), then the particles (see ovito_worker._encode) */
  function decodeLive(buf) {
    const hl = new DataView(buf).getUint32(0, true), meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hl)));
    const L = meta.layout, n = L.n, al = x => x + ((4 - (x % 4)) % 4);
    let off = 4 + hl, pos, col, rad, idx = null;
    if (L.encoding === "f32") {
      pos = new Float32Array(buf, off, n * 3); off += n * 12;
      col = new Uint8Array(buf, off, n * 3); off += al(n * 3);
      rad = new Float32Array(buf, off, n); off += n * 4;
    } else {                                                            // hosted, frame larger than the response limit
      const q = new Uint16Array(buf, off, n * 3); off += al(n * 6);
      col = new Uint8Array(buf, off, n * 3); off += al(n * 3);
      const ri = new Uint8Array(buf, off, n); off += al(n);
      if (L.index_map) { idx = new Uint32Array(buf, off, n); off += n * 4; }
      pos = new Float32Array(n * 3);
      for (let k = 0; k < n; k++) for (let d = 0; d < 3; d++) pos[3 * k + d] = L.lo[d] + q[3 * k + d] * L.scale[d];
      rad = Float32Array.from(ri, x => L.radii[x]);
    }
    return { meta, pos, col, rad, idx, lines: new Float32Array(buf, off, L.lines * 3) };
  }
  async function loadFrame(i, fit = false) {
    const tok = ++loadTok;
    if (!frame) busy(`OVITO computes frame ${i}…`); else setHud(`OVITO computes frame ${i}…`);
    try {
      const f = await fetchFrame(i);
      if (tok !== loadTok || !alive) return;
      frame = f; fi = i; S.frame = i; picked = null; pickHud.hidden = true; save();
      const n = f.meta.layout.n;
      R.setPositions(f.pos); R.setColors(f.col); R.setRadii(f.rad);
      const idx = new Uint32Array(n); for (let k = 0; k < n; k++) idx[k] = k;
      R.setIndices(idx);
      R.setLines(f.lines);
      const c = f.meta.cell;                                               // OVITO cell matrix: columns a, b, c, origin
      R.setCell({ origin: [c[0][3], c[1][3], c[2][3]], a: [c[0][0], c[1][0], c[2][0]], b: [c[0][1], c[1][1], c[2][1]], c: [c[0][2], c[1][2], c[2][2]] });
      bounds();
      if (fit || !cam) { cam = cam || { proj: S.viewport.proj, fov: 0.6, halfH: 50, target: scene.center, dir: [...VIEWS.Top.dir], up: [...VIEWS.Top.up] }; setView(S.viewport.view || "Top", false); zoomAll(); }
      idle(); setHud(); updateTimeline(); refreshSide("results"); requestDraw();
      if (playing && fi + 1 < info.num_frames) fetchFrame(fi + 1).catch(() => {});   // OVITO computes the next frame meanwhile
    } catch (e) {
      if (tok !== loadTok) return;
      stop(); idle();
      if (!frame) showState(errorState(e, () => loadFrame(i, fit))); else toast(`Frame ${i}: ${e.message}`, "err");
    }
  }
  function bounds() {
    const p = frame.pos, n = frame.meta.layout.n, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < n; k++) for (let d = 0; d < 3; d++) { const v = p[3 * k + d]; if (v < lo[d]) lo[d] = v; if (v > hi[d]) hi[d] = v; }
    if (!n) { scene = { center: [0, 0, 0], radius: 10 }; return; }
    scene = { center: lo.map((v, d) => (v + hi[d]) / 2), radius: V.len(V.sub(hi, lo)) / 2 + 5 };
  }

  // ---------------------------------------------------------------------------------------------- camera
  function layout() {
    const W = glc.width, H = glc.height, full = { x: 0, y: 0, w: W, h: H };
    if (!S.viewport.preview) return { full, frame: null, k: 1 };
    const a = S.render.w / S.render.h, m = 0.9;
    let fw = W * m, fh = fw / a;
    if (fh > H * m) { fh = H * m; fw = fh * a; }
    return { full, frame: { x: (W - fw) / 2, y: (H - fh) / 2, w: fw, h: fh }, k: H / fh };
  }
  function setView(name, fit = true) {
    const v = VIEWS[name] || VIEWS.Top;
    cam.dir = [...v.dir]; cam.up = [...v.up]; S.viewport.view = name; save();
    tools.querySelectorAll("[data-view]").forEach(b => b.setAttribute("aria-pressed", b.dataset.view === name));
    if (fit) zoomAll();
  }
  function zoomAll() {
    if (!frame || !cam) return;
    const m = matrices(cam, 1, scene), p = frame.pos, n = frame.meta.layout.n;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    let rmax = 0;
    for (let k = 0; k < n; k++) {
      const q = [p[3 * k], p[3 * k + 1], p[3 * k + 2]], s = [V.dot(q, m.right), V.dot(q, m.up), V.dot(q, m.dir)];
      for (let d = 0; d < 3; d++) { if (s[d] < lo[d]) lo[d] = s[d]; if (s[d] > hi[d]) hi[d] = s[d]; }
      if (frame.rad[k] > rmax) rmax = frame.rad[k];
    }
    if (!(lo[0] <= hi[0])) { requestDraw(); return; }
    const c = lo.map((v, d) => (v + hi[d]) / 2);
    cam.target = V.add(V.add(V.mul(m.right, c[0]), V.mul(m.up, c[1])), V.mul(m.dir, c[2]));
    const L = layout(), aspect = L.frame ? L.frame.w / L.frame.h : glc.width / Math.max(1, glc.height);
    cam.halfH = Math.max((hi[1] - lo[1]) / 2, (hi[0] - lo[0]) / 2 / aspect) * 1.04 + rmax;
    requestDraw();
  }
  /** the viewport camera in OVITO's terms (ortho fov = half the visible height in Å; perspective fov = vertical angle) */
  function ovitoCamera() {
    const d = V.norm(cam.dir), m = matrices(cam, 1, scene);
    if (cam.proj === "persp") {
      const dist = cam.halfH / Math.tan(cam.fov / 2);
      return { perspective: true, pos: V.sub(cam.target, V.mul(d, dist)), dir: d, up: m.up, fov: cam.fov };
    }
    return { perspective: false, pos: V.sub(cam.target, V.mul(d, scene.radius + V.len(V.sub(cam.target, scene.center)) + 10)), dir: d, up: m.up, fov: cam.halfH };
  }

  // ---------------------------------------------------------------------------------------------- drawing
  function requestDraw() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); }
  function resize() {
    const r = stage.getBoundingClientRect(), d = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.max(1, Math.round(r.width * d)), H = Math.max(1, Math.round(r.height * d));
    if (glc.width !== W || glc.height !== H) { glc.width = ovc.width = W; glc.height = ovc.height = H; }
    requestDraw();
  }
  const bgRgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  function draw() {
    const c = ovc.getContext("2d"), W = glc.width, H = glc.height;
    c.clearRect(0, 0, W, H);
    if (!cam || !frame) { R.draw({ view: new Float32Array(16), proj: new Float32Array(16), bg: [0.04, 0.047, 0.055, 1] }); return; }
    const L = layout(), mv = matrices(cam, W / H, scene, L.k), bg = L.frame ? bgRgb(S.render.bg) : [0.04, 0.047, 0.055];
    R.draw({ view: mv.view, proj: mv.proj, bg: [...bg, 1], rscale: 1, flat: false, cellColor: S.cell ? (bg[0] > 0.5 ? [0.1, 0.1, 0.1] : [0.6, 0.62, 0.66]) : null });
    if (L.frame) {
      const f = L.frame;
      c.fillStyle = "rgba(10,12,14,0.62)";
      c.fillRect(0, 0, W, f.y); c.fillRect(0, f.y + f.h, W, H - f.y - f.h); c.fillRect(0, f.y, f.x, f.h); c.fillRect(f.x + f.w, f.y, W - f.x - f.w, f.h);
      c.strokeStyle = "#e2a23a"; c.lineWidth = 1; c.strokeRect(f.x + 0.5, f.y + 0.5, f.w - 1, f.h - 1);
    }
    const rect = L.frame || L.full, dark = !L.frame || bg[0] < 0.5, ink = dark ? "#e9e6df" : "#111111";
    tripod(c, rect, mv, ink);
    if (frame.meta.legend) legend(c, rect, frame.meta.legend, ink);
    const ms = (S.measures || []).filter(m => m.src === srcKey());
    if (ms.length) drawMeasures(c, mv, W, H, ms, ink);
    if (picked != null) {
      const p = [frame.pos[3 * picked], frame.pos[3 * picked + 1], frame.pos[3 * picked + 2]], v = mv.vp;
      const w = v[3] * p[0] + v[7] * p[1] + v[11] * p[2] + v[15];
      const x = ((v[0] * p[0] + v[4] * p[1] + v[8] * p[2] + v[12]) / w + 1) / 2 * W, y = (1 - (v[1] * p[0] + v[5] * p[1] + v[9] * p[2] + v[13]) / w) / 2 * H;
      c.strokeStyle = "#e2a23a"; c.lineWidth = 2; c.beginPath(); c.arc(x, y, 9, 0, 7); c.stroke();
    }
  }
  function tripod(c, rect, m, ink) {
    const s = Math.min(rect.w, rect.h) * 0.07, ox = rect.x + s * 1.6, oy = rect.y + rect.h - s * 1.6;
    c.lineWidth = 2; c.font = `${Math.round(s * 0.42)}px system-ui, sans-serif`; c.textAlign = "center"; c.textBaseline = "middle";
    [["x", [1, 0, 0], "#df6b5d"], ["y", [0, 1, 0], "#93b26a"], ["z", [0, 0, 1], "#6f9fd6"]].forEach(([n, a, col]) => {
      const dx = V.dot(a, m.right), dy = V.dot(a, m.up);
      c.strokeStyle = c.fillStyle = col; c.beginPath(); c.moveTo(ox, oy); c.lineTo(ox + dx * s, oy - dy * s); c.stroke();
      c.fillText(n, ox + dx * s * 1.3, oy - dy * s * 1.3);
    });
    void ink;
  }
  function legend(c, rect, lg, ink) {                                     // OVITO's own gradient colours and range
    const h = rect.h * 0.4, w = Math.max(10, rect.w * 0.016), x = rect.x + rect.w - w - rect.w * 0.07, y = rect.y + (rect.h - h) / 2;
    lg.colors.forEach((col, i) => { c.fillStyle = `rgb(${col})`; c.fillRect(x, y + h - (i + 1) * h / lg.colors.length, w, h / lg.colors.length + 0.5); });
    c.strokeStyle = ink; c.lineWidth = 1; c.strokeRect(x, y, w, h);
    const fs = Math.max(11, rect.h * 0.022);
    c.fillStyle = ink; c.font = `${fs}px system-ui, sans-serif`; c.textAlign = "left"; c.textBaseline = "middle";
    c.fillText(num(lg.end, 4), x + w + 6, y); c.fillText(num(lg.start, 4), x + w + 6, y + h);
    c.textAlign = "center"; c.fillText(lg.property, x + w / 2, y - fs * 1.2);
  }

  // ---------------------------------------------------------------------------------------------- picking
  function pick(px, py) {
    if (!frame) return null;
    const L = layout(), m = matrices(cam, glc.width / glc.height, scene, L.k), v = m.vp, H = glc.height, P11 = m.proj[5], p = frame.pos, n = frame.meta.layout.n;
    let best = null, bz = Infinity;
    for (let i = 0; i < n; i++) {
      const a = p[3 * i], b = p[3 * i + 1], cz = p[3 * i + 2], w = v[3] * a + v[7] * b + v[11] * cz + v[15];
      const sx = ((v[0] * a + v[4] * b + v[8] * cz + v[12]) / w + 1) / 2 * glc.width - px, sy = (1 - (v[1] * a + v[5] * b + v[9] * cz + v[13]) / w) / 2 * H - py;
      const r = frame.rad[i] * H * P11 / (2 * w);
      if (sx * sx + sy * sy > r * r) continue;
      const d = (v[2] * a + v[6] * b + v[10] * cz + v[14]) / w;
      if (d < bz) { bz = d; best = i; }
    }
    return best;
  }
  async function onClick(px, py) {
    if (measureMode) {
      const k = pick(px, py);
      if (k == null) return;
      try {
        const v = (await api.post("/api/ovito/atom", { spec: spec(fi), index: frame.idx ? frame.idx[k] : k })).body.values;   // OVITO's exact position
        const P = { id: v["Particle Identifier"] ?? null, x: v["Position.X"], y: v["Position.Y"], z: v["Position.Z"] };
        if (!measureA) { measureA = P; setHud("Measure: click the second particle (Esc cancels)"); return; }
        S.measures = S.measures || [];
        S.measures.push({ src: srcKey(), frame: fi, axis: measureMode, a: measureA, b: P });
        save(); const done = measureDone; endMeasure(); done?.(); refreshSide("measure");
      } catch (e) { toast(e.message, "err"); }
      return;
    }
    const i = pick(px, py);
    picked = i; requestDraw();
    if (i == null) { pickHud.hidden = true; frame.pickedRow = null; refreshSide("results"); return; }
    try {
      const r = await api.post("/api/ovito/atom", { spec: spec(fi), index: frame.idx ? frame.idx[i] : i });
      const v = r.body.values;
      frame.pickedRow = v;
      pickHud.hidden = false;
      pickHud.replaceChildren(el("b", {}, `Particle ${v["Particle Identifier"] ?? i} · type ${v["Particle Type"] ?? "—"}`),
        el("span", {}, `x ${num(v["Position.X"], 3)}  y ${num(v["Position.Y"], 3)}  z ${num(v["Position.Z"], 3)} Å`), el("span", { class: "muted" }, "All OVITO properties: Results tab"));
      refreshSide("results");
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
      let dir = V.rot(cam.dir, m.up, -dx * 0.006), up = m.up;
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
  const onKey = e => {
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || e.altKey || e.ctrlKey || e.metaKey || !src) return;
    if (e.key === "Escape" && measureMode) { endMeasure(); return; }
    if (e.key === " ") { e.preventDefault(); playing ? stop() : play(); }
    if (e.key === ",") step(-1);
    if (e.key === ".") step(1);
  };
  document.addEventListener("keydown", onKey);
  const ro = new ResizeObserver(resize); ro.observe(stage);

  function buildTools() {
    clear(tools);
    const proj = el("div", { class: "btn-group", role: "group", "aria-label": "Projection" },
      [["ortho", "Ortho"], ["persp", "Persp"]].map(([v, l]) => el("button", { class: "btn", type: "button", "data-proj": v, "aria-pressed": S.viewport.proj === v,
        onclick: () => { S.viewport.proj = v; if (cam) cam.proj = v; proj.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", b.dataset.proj === v)); save(); requestDraw(); } }, l)));
    tools.append(el("div", { class: "btn-group", role: "group", "aria-label": "Standard views" },
      Object.keys(VIEWS).map(n => el("button", { class: "btn", type: "button", "data-view": n, "aria-pressed": n === S.viewport.view, "data-tip": VIEW_TIP[n], onclick: () => cam && setView(n) }, n))),
      proj,
      el("button", { class: "btn", type: "button", "data-tip": "Zoom to all particles (double-click)", onclick: zoomAll }, "Zoom all"),
      el("button", { class: "btn", type: "button", "aria-pressed": S.viewport.preview, "data-tip": "Show the frame of the rendered image (size from the Render tab)", onclick: e => { S.viewport.preview = !S.viewport.preview; e.currentTarget.setAttribute("aria-pressed", S.viewport.preview); save(); requestDraw(); } }, "Preview"),
      el("button", { class: "btn primary", type: "button", "data-tip": "OVITO renders this exact view (Render tab: renderer, size, overlays)", onclick: () => renderOvito(false) }, svg("download"), "Render with OVITO"));
  }
  buildTools();

  function setHud(msg) {
    clear(hud);
    if (!frame) { hud.hidden = true; return; }
    hud.hidden = false;
    const s = frame.meta.seconds;
    hud.append(...[el("b", {}, S.last?.label || `${S.last?.dir?.split(/[\\/]/).pop() || ""}/${S.last?.pattern || ""}`),
      el("span", {}, `Frame ${fi} · step ${num(frame.meta.step)} · ${num(frame.meta.layout.n_total)} particles after the OVITO pipeline · OVITO ${s.compute} s`),
      regimeMap?.has(fi) ? el("span", { class: `dbt-badge ${regimeMap.get(fi).regime}` }, regimeMap.get(fi).regime === "brittle" ? `BRITTLE · ${regimeMap.get(fi).why.join("; ")}` : "DUCTILE · no crack, void or chip fragmentation")
        : regimeMap ? el("span", { class: "muted" }, "regime: frame not analysed") : null,
      frame.meta.layout.encoding === "q16" ? el("span", { class: "acc" }, `Hosted display: positions to ±${frame.meta.layout.precision_A.toFixed(3)} Å${frame.meta.layout.stride > 1 ? `, 1 in ${frame.meta.layout.stride} particles shown (${num(frame.meta.layout.n)})` : ""}; all numbers, picking and renders use OVITO's full data.`) : null,
      ...(msg ? [el("span", { class: "acc" }, msg)] : [])].filter(Boolean));   // (append() would print null)
  }

  // ---------------------------------------------------------------------------------------------- timeline
  const slider = el("input", { type: "range", min: 0, max: 0, value: 0, "aria-label": "Frame" });
  const frameNum = el("input", { class: "input num fnum", type: "number", min: 0, value: 0, "aria-label": "Frame number" });
  const readout = el("span", { class: "readout" });
  const playBtn = el("button", { class: "btn icon", type: "button", "aria-label": "Play", "data-tip": "Play / pause (Space)" }, svg("play"));
  function buildTimeline() {
    clear(time);
    const n = info.num_frames;
    slider.max = n - 1; frameNum.max = n - 1;
    const b = (ic, lab, fn) => el("button", { class: "btn icon", type: "button", "aria-label": lab, "data-tip": lab, onclick: fn }, svg(ic));
    time.append(b("first", "First frame", () => go(0)), b("prev", "Previous frame (,)", () => step(-1)), playBtn, b("next", "Next frame (.)", () => step(1)), b("last", "Last frame", () => go(n - 1)),
      slider, frameNum, sel([[2, "2 fps"], [5, "5 fps"], [10, "10 fps"], [20, "20 fps"], [30, "30 fps"]], S.fps, v => { S.fps = +v; save(); }, "Playback speed (upper limit)"), readout);
  }
  playBtn.onclick = () => (playing ? stop() : play());
  slider.oninput = () => { readout.textContent = `frame ${slider.value} / ${info.num_frames - 1}`; };
  slider.onchange = () => go(+slider.value);
  frameNum.onchange = () => go(Math.max(0, Math.min(info.num_frames - 1, Math.round(+frameNum.value || 0))));
  function updateTimeline() { slider.value = fi; frameNum.value = fi; readout.textContent = `step ${num(frame.meta.step)} · frame ${fi} / ${info.num_frames - 1}`; }
  function go(i) { if (src && i !== fi) loadFrame(i); }
  function step(d) { if (src) go(Math.max(0, Math.min(info.num_frames - 1, fi + d))); }
  async function play() {
    if (!src || playing) return;
    playing = true; playBtn.replaceChildren(svg("pause")); playBtn.setAttribute("aria-label", "Pause");
    if (fi >= info.num_frames - 1) await loadFrame(0);
    while (playing && alive && fi < info.num_frames - 1) {
      const t0 = performance.now();
      await loadFrame(fi + 1);
      const wait = 1000 / S.fps - (performance.now() - t0);
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
    }
    stop();
  }
  function stop() { playing = false; playBtn.replaceChildren(svg("play")); playBtn.setAttribute("aria-label", "Play"); }

  // ---------------------------------------------------------------------------------------------- side panels
  const T = tabs([{ id: "pipeline", label: "Pipeline" }, { id: "render", label: "Render" }, { id: "frames", label: "Export" }, { id: "dbt", label: "Ductile–brittle" }, { id: "measure", label: "Measure" }, { id: "research", label: "Research" }, { id: "results", label: "Results" }, { id: "more", label: "More" }],
    id => { S.sideTab = id; save(); refreshSide(id); });                  // the open tab is remembered
  side.append(T.bar, ...Object.values(T.panels));
  const builders = { pipeline: buildPipeline, render: buildRender, results: buildResults, more: buildMore,
    frames: p => buildFramesPanel(p, { S, save, info: () => info, spec: () => spec(fi), frameMeta: () => frame?.meta }),
    research: p => buildResearchPanel(p, { S, save, info: () => info, spec: () => spec(fi) }),
    measure: p => buildMeasurePanel(p, { S, save, info: () => info, spec: () => spec(fi), frameIndex: () => fi, srcKey, startMeasure, redraw: requestDraw }),
    dbt: p => buildDbtPanel(p, { S, save, info: () => info, spec: () => spec(fi), setRegime: m => { regimeMap = m; setHud(); },
      showDamage: types => {                                            // tool removed, structure types coloured: damage visible while playing
        S.modifiers = [{ type: "select_type", types: [...types], enabled: true }, { type: "delete_selected", enabled: true }, { type: "identify_diamond", enabled: true }];
        refreshSide("pipeline"); cache.clear(); changed(); if (!S.live) loadFrame(fi);
      } }) };
  function buildSide() {
    if (S.sideTab && builders[S.sideTab]) T.select(S.sideTab);            // reopen the tab used last
    for (const id of Object.keys(builders)) refreshSide(id, true);
  }
  function refreshSide(id, force) {
    for (const k of id ? [id] : Object.keys(builders)) { const p = T.panels[k]; if (force || !p.hidden) { clear(p); builders[k](p); } }
  }
  const propOptions = () => {
    const s = new Set(info ? info.properties.flatMap(p => p === "Position" ? ["Position.X", "Position.Y", "Position.Z"] : p === "Velocity" ? ["Velocity.X", "Velocity.Y", "Velocity.Z"] : p === "Force" ? ["Force.X", "Force.Y", "Force.Z"] : [p]) : []);
    for (const m of S.modifiers) if (m.enabled !== false) { (OUTPUTS[m.type] || []).forEach(x => s.add(x)); if (m.type === "compute_property" && m.output_property) s.add(m.output_property); }
    if (frame) Object.keys(frame.meta.stats).forEach(k => s.add(k));
    return [...s];
  };
  const propList = el("datalist", { id: "ov-props" });
  function refreshProps() { clear(propList); propOptions().forEach(p => propList.append(el("option", { value: p }))); }

  function buildPipeline(p) {
    if (!info) { p.append(el("p", { class: "muted" }, "Upload dump files or open a path first.")); return; }
    refreshProps(); p.append(propList);
    const where = src.remote ? "streamed from the HPC over SSH into memory (no copy on disk)" : src.blob ? "private upload store" : src.upload ? "uploaded copy on this server" : "read in place (no copy)";
    p.append(el("section", { class: "st-sec" }, el("h4", {}, "Data source"),
      el("dl", { class: "kv" }, el("dt", {}, "Files"), el("dd", { class: "mono" }, src.pattern || ""), el("dt", {}, "Folder"), el("dd", { class: "mono" }, src.dir || src.path || (src.remote ? "HPC" : "—")),
        el("dt", {}, "Frames"), el("dd", {}, `${num(info.num_frames)} (timeline 0 … ${num(info.num_frames - 1)})`), el("dt", {}, "Particles"), el("dd", {}, num(info.count)),
        el("dt", {}, "Storage"), el("dd", {}, where))));
    p.append(sec("Live update",
      chk("Re-evaluate with OVITO on every change", S.live, v => { S.live = v; save(); refreshSide("pipeline"); }, "Off: change several settings, then press Apply"),
      S.live ? null : el("button", { class: "btn primary", type: "button", onclick: () => { cache.clear(); loadFrame(fi); } }, "Apply")));
    p.append(sec("Particle types (colour, radius)", el("table", { class: "data compact" }, el("tbody", {}, info.types.map(t => el("tr", {},
      el("td", {}, `Type ${t.id}${t.name ? ` (${t.name})` : ""}`),
      el("td", {}, colIn(S.types[t.id].color, v => { S.types[t.id].color = v; changed(); }, `Colour of type ${t.id}`)),
      el("td", {}, numIn(S.types[t.id].radius || null, v => { S.types[t.id].radius = Math.max(0, v || 0); changed(); }, { min: 0, step: 0.05, placeholder: `${info.default_radius}`, "aria-label": `Radius of type ${t.id}` })),
      el("td", { class: "num muted" }, num(t.count)))))),
      el("p", { class: "muted small" }, `Defaults are OVITO's own type colours; an empty radius uses OVITO's default particle radius (${info.default_radius} Å).`),
      chk("Show simulation cell", S.cell, v => { S.cell = v; save(); requestDraw(); })));
    const add = sel([["", "Add OVITO modifier…"], ...MODS], "", v => {
      if (!v) return;
      const m = { type: v, enabled: true };
      if (v === "select_type") m.types = [];
      if (v === "expression_selection") m.expression = "Position.Y > 0";
      if (v === "slice") Object.assign(m, { normal: [0, 0, 1], distance: 0, slab_width: 0, inverse: false, select: false });
      if (v === "displacements") Object.assign(m, { reference_frame: 0, minimum_image: true });
      if (v === "coordination") m.cutoff = 2.6;
      if (v === "dxa") m.lattice = "CubicDiamond";
      if (v === "compute_property") Object.assign(m, { output_property: "Height", expressions: ["Position.Y"], only_selected: false });
      if (v === "color_coding") Object.assign(m, { property: "Position.Y", gradient: "Rainbow", start: null, end: null, only_selected: false });
      if (v === "assign_color") m.color = "#35b6e0";
      S.modifiers.push(m); refreshSide("pipeline"); changed();
    }, "Add OVITO modifier");
    const list = el("div", { class: "mods" });
    S.modifiers.forEach((m, k) => list.append(modCard(m, k)));
    p.append(sec("OVITO modifiers (applied top to bottom)", add, S.modifiers.length ? list : el("p", { class: "muted small" }, "None yet. Example: Select type (tool) → Delete selected → Displacement vectors → Color coding by Displacement.Y.")));
  }
  function modCard(m, k) {
    const upd = (key, v) => { m[key] = v; changed(); };
    const move = d => () => { const j = k + d; if (j < 0 || j >= S.modifiers.length) return; [S.modifiers[k], S.modifiers[j]] = [S.modifiers[j], S.modifiers[k]]; refreshSide("pipeline"); changed(); };
    const body = el("div", { class: "mod-body" });
    const propIn = (key, label) => row(label, el("input", { class: "input", type: "text", list: "ov-props", value: m[key] ?? "", onchange: e => upd(key, e.target.value.trim()) }));
    switch (m.type) {
      case "select_type": body.append(el("div", { class: "chips" }, info.types.map(t => el("button", { class: "chip", type: "button", "aria-pressed": m.types.includes(t.id),
        onclick: e => { m.types = m.types.includes(t.id) ? m.types.filter(x => x !== t.id) : [...m.types, t.id]; e.currentTarget.setAttribute("aria-pressed", m.types.includes(t.id)); changed(); } },
        el("span", { class: "swatch", style: { background: S.types[t.id]?.color } }), `Type ${t.id}`, el("span", { class: "n" }, num(t.count)))))); break;
      case "expression_selection": body.append(row("Expression", txtIn(m.expression, v => upd("expression", v), { class: "input mono", placeholder: "Position.Y > 437.3" }))); break;
      case "slice": body.append(row("Normal (x y z)", el("div", { class: "trio" }, [0, 1, 2].map(i => numIn(m.normal[i], v => { m.normal[i] = v || 0; changed(); }, { "aria-label": `Normal ${"xyz"[i]}` })))),
        row("Distance (Å)", numIn(m.distance, v => upd("distance", v || 0))), row("Slab width (Å)", numIn(m.slab_width, v => upd("slab_width", Math.abs(v || 0)), { min: 0 })),
        el("div", { class: "field-row" }, chk("Invert", m.inverse, v => upd("inverse", v)), chk("Select only", m.select, v => upd("select", v)))); break;
      case "displacements": body.append(row("Reference frame", numIn(m.reference_frame, v => upd("reference_frame", Math.max(0, Math.round(v || 0))), { min: 0, step: 1 })),
        chk("Minimum image convention", m.minimum_image !== false, v => upd("minimum_image", v))); break;
      case "coordination": body.append(row("Cutoff (Å)", numIn(m.cutoff, v => upd("cutoff", v || 2.6), { min: 0.1, step: 0.1 }))); break;
      case "dxa": body.append(row("Crystal lattice", sel(DXA, m.lattice, v => upd("lattice", v), "DXA lattice"))); break;
      case "compute_property": body.append(propIn("output_property", "Output property"),
        row("Expression(s)", txtIn((m.expressions || []).join(" ; "), v => upd("expressions", v.split(";").map(s => s.trim()).filter(Boolean)), { class: "input mono", placeholder: "Position.Y - 437.27" })),
        chk("Only selected", m.only_selected, v => upd("only_selected", v))); break;
      case "color_coding": body.append(propIn("property", "Property"), row("Gradient", sel(GRADIENTS, m.gradient, v => upd("gradient", v), "Gradient")),
        row("Start / end", el("div", { class: "duo" }, numIn(m.start, v => upd("start", v), { placeholder: "auto" }), numIn(m.end, v => upd("end", v), { placeholder: "auto" }))),
        chk("Only selected", m.only_selected, v => upd("only_selected", v)),
        frame?.meta.legend ? el("div", { class: "field-row" }, el("span", { class: "muted small" }, `OVITO range this frame: ${num(frame.meta.legend.start, 5)} … ${num(frame.meta.legend.end, 5)}`),
          el("button", { class: "btn ghost", type: "button", "data-tip": "Fix this range for all frames", onclick: () => { m.start = +frame.meta.legend.start.toPrecision(6); m.end = +frame.meta.legend.end.toPrecision(6); refreshSide("pipeline"); changed(); } }, "Fix range")) : null); break;
      case "assign_color": body.append(row("Colour", colIn(m.color, v => upd("color", v), "Colour"))); break;
      default: break;
    }
    const card = el("div", { class: `mod-card${m.enabled === false ? " off" : ""}` },
      el("div", { class: "mod-head" },
        el("input", { type: "checkbox", checked: m.enabled !== false, "aria-label": `Enable ${MOD_LABEL[m.type]}`, onchange: e => { m.enabled = e.target.checked; card.classList.toggle("off", !m.enabled); changed(); } }),
        el("span", { class: "name", "data-tip": MOD_HELP[m.type] }, MOD_LABEL[m.type]),
        el("button", { class: "btn ghost icon", type: "button", "aria-label": "Move up", disabled: k === 0, onclick: move(-1) }, "↑"),
        el("button", { class: "btn ghost icon", type: "button", "aria-label": "Move down", disabled: k === S.modifiers.length - 1, onclick: move(1) }, "↓"),
        el("button", { class: "btn ghost icon", type: "button", "aria-label": `Remove ${MOD_LABEL[m.type]}`, onclick: () => { S.modifiers.splice(k, 1); refreshSide("pipeline"); changed(); } }, "✕")),
      el("p", { class: "mod-status" }, MOD_HELP[m.type] || ""));
    if (body.childNodes.length) card.append(body);
    return card;
  }

  // -- render (OVITO's renderers, the viewport's camera)
  function buildRender(p) {
    const R_ = S.render, Lg = S.overlays.legend, Tr = S.overlays.tripod, A = R_.anim, last = info ? info.num_frames - 1 : 0;
    p.append(sec("Image (rendered by OVITO from the current view)",
      row("Width / height (px)", el("div", { class: "duo" }, numIn(R_.w, v => { R_.w = Math.round(Math.max(64, Math.min(8000, v || 1600))); save(); requestDraw(); }, { min: 64, max: 8000, step: 1 }),
        numIn(R_.h, v => { R_.h = Math.round(Math.max(64, Math.min(8000, v || 1000))); save(); requestDraw(); }, { min: 64, max: 8000, step: 1 }))),
      row("Background", colIn(R_.bg, v => { R_.bg = v; save(); requestDraw(); }, "Background")), chk("Transparent background", R_.alpha, v => { R_.alpha = v; save(); }),
      row("Renderer", sel([["tachyon", "Tachyon (ray-traced, publication)"], ["opengl", "OpenGL (fast)"]], R_.renderer, v => { R_.renderer = v; save(); refreshSide("render"); }, "Renderer")),
      R_.renderer === "tachyon" ? el("div", { class: "grid1" }, row("Antialiasing samples", numIn(R_.aa, v => { R_.aa = Math.round(Math.max(1, Math.min(64, v || 12))); save(); }, { min: 1, max: 64, step: 1 })),
        el("div", { class: "field-row" }, chk("Ambient occlusion", R_.ao, v => { R_.ao = v; save(); }), chk("Shadows", R_.shadows, v => { R_.shadows = v; save(); })))
        : row("Antialiasing level", numIn(R_.aa_gl, v => { R_.aa_gl = Math.round(Math.max(1, Math.min(6, v || 3))); save(); }, { min: 1, max: 6, step: 1 })),
      el("div", { class: "field-row" }, el("button", { class: "btn primary", type: "button", onclick: () => renderOvito(false) }, "Render image with OVITO"),
        el("button", { class: "btn", type: "button", onclick: showScript }, "Show script")),
      el("p", { class: "muted small" }, "OVITO renders exactly the camera of the viewport (switch on Preview to see the image frame).")));
    p.append(sec("Movie (rendered by OVITO, MP4)",
      row("Frames from / to", el("div", { class: "duo" }, numIn(A.start, v => { A.start = Math.max(0, Math.round(v || 0)); save(); }, { min: 0, max: last, step: 1 }),
        numIn(A.end, v => { A.end = v == null ? null : Math.max(0, Math.round(v)); save(); }, { min: 0, max: last, step: 1, placeholder: `${last} (last)` }))),
      row("Every n-th / fps", el("div", { class: "duo" }, numIn(A.every, v => { A.every = Math.max(1, Math.round(v || 1)); save(); }, { min: 1, step: 1 }), numIn(A.fps, v => { A.fps = Math.max(1, Math.min(120, Math.round(v || 10))); save(); }, { min: 1, max: 120, step: 1 }))),
      el("button", { class: "btn primary", type: "button", onclick: () => renderOvito(true) }, svg("play"), "Render movie with OVITO"),
      el("p", { class: "muted small" }, "OVITO's render_anim with the settings above; text labels like Step [Timestep] update every frame. Colour-coding ranges left on auto change per frame: fix them in the modifier for a movie.")));
    p.append(sec("Color legend (OVITO ColorLegendOverlay, in renders)",
      chk("Show (needs a Color coding modifier)", Lg.enabled, v => { Lg.enabled = v; save(); }),
      row("Position", sel(ALIGNS, Lg.align, v => { Lg.align = v; save(); }, "Legend position")),
      row("Orientation", sel([["vertical", "Vertical"], ["horizontal", "Horizontal"]], Lg.orientation, v => { Lg.orientation = v; save(); }, "Orientation")),
      row("Title", txtIn(Lg.title, v => { Lg.title = v; save(); }, { placeholder: "property name" })),
      row("Number format", txtIn(Lg.format, v => { Lg.format = v; save(); }, { class: "input mono" })),
      row("Size / text size", el("div", { class: "duo" }, numIn(Lg.size, v => { Lg.size = v || 0.3; save(); }, { step: 0.05 }), numIn(Lg.font_size, v => { Lg.font_size = v || 0.1; save(); }, { step: 0.01 }))),
      row("Offset x / y", el("div", { class: "duo" }, numIn(Lg.ox, v => { Lg.ox = v ?? 0; save(); }, { step: 0.01 }), numIn(Lg.oy, v => { Lg.oy = v ?? 0; save(); }, { step: 0.01 }))),
      row("Text colour", colIn(Lg.color, v => { Lg.color = v; save(); }, "Legend text colour"))));
    p.append(sec("Coordinate tripod (OVITO CoordinateTripodOverlay, in renders)",
      chk("Show", Tr.enabled, v => { Tr.enabled = v; save(); }),
      row("Position", sel(ALIGNS, Tr.align, v => { Tr.align = v; save(); }, "Tripod position")),
      row("Size", numIn(Tr.size, v => { Tr.size = v || 0.07; save(); }, { step: 0.01 }))));
    const labs = el("div", { class: "grid1" });
    S.overlays.labels.forEach((t, j) => labs.append(el("div", { class: "mod-card" }, el("div", { class: "mod-body" },
      row("Text", txtIn(t.text, v => { t.text = v; save(); })),
      row("Position", sel(ALIGNS, t.align, v => { t.align = v; save(); }, "Label position")),
      row("Size / colour", el("div", { class: "duo" }, numIn(t.font_size, v => { t.font_size = v || 0.06; save(); }, { step: 0.01 }), colIn(t.color, v => { t.color = v; save(); }, "Label colour"))),
      row("Offset x / y", el("div", { class: "duo" }, numIn(t.ox, v => { t.ox = v ?? 0; save(); }, { step: 0.01 }), numIn(t.oy, v => { t.oy = v ?? 0; save(); }, { step: 0.01 }))),
      el("button", { class: "btn ghost", type: "button", onclick: () => { S.overlays.labels.splice(j, 1); save(); refreshSide("render"); } }, "Remove")))));
    p.append(sec("Text labels (OVITO TextLabelOverlay, in renders)", el("p", { class: "muted small" }, "OVITO fills in [Timestep] or any [attribute], e.g.  (a1)  or  Step [Timestep]  or  [ExpressionSelection.count] burr atoms."),
      labs, el("button", { class: "btn", type: "button", onclick: () => { S.overlays.labels.push({ text: "(a1)", align: "top-left", font_size: 0.06, color: "#000000", ox: 0, oy: 0 }); save(); refreshSide("render"); } }, "+ Text label")));
    const file = el("input", { type: "file", accept: ".json", hidden: true, onchange: async e => {
      const f = e.target.files[0]; e.target.value = ""; if (!f) return;
      try { const keep = { last: S.last, recent: S.recent }; Object.assign(S, load(JSON.parse(await f.text())), keep); save(); buildSide(); buildTools(); changed(); toast("Settings loaded.", "ok"); }
      catch (err) { toast(`Not a settings file: ${err.message}`, "err"); }
    } });
    p.append(sec("Settings", el("div", { class: "field-row" },
      el("button", { class: "btn", type: "button", onclick: () => download("nanocut-ovito-settings.json", JSON.stringify(S, null, 2), "application/json") }, "Save settings"),
      el("button", { class: "btn", type: "button", onclick: () => file.click() }, "Load settings"), file)));
  }
  const fullSpec = (movie) => ({ ...spec(fi), view: { camera: ovitoCamera() }, overlays: S.overlays,
    render: { ...S.render, anim: movie ? { ...S.render.anim, end: S.render.anim.end ?? info.num_frames - 1 } : null } });
  async function renderOvito(movie) {
    if (!frame || !cam) { toast("Open a trajectory first.", "warn"); return; }
    const box = loading(movie ? "OVITO renders the movie…" : "OVITO renders the image…", true);
    const dlg = el("div", { class: "modal-backdrop open", role: "dialog", "aria-modal": "true", "aria-label": "OVITO rendering" },
      el("div", { class: "modal wide" }, el("div", { class: "panel-head" }, el("h3", {}, movie ? "Movie rendered by OVITO" : "Image rendered by OVITO"),
        el("div", { class: "actions" }, el("button", { class: "btn", type: "button", onclick: () => dlg.remove() }, "Close"))), el("div", { class: "panel-body st-render" }, box)));
    document.body.append(dlg);
    try {
      const r = movie ? await encodeMovie(box) : await api.job("/api/ovito/render", { method: "POST", data: { spec: fullSpec(false) }, onProgress: x => box.update(x), pollMs: 300 });
      const url = movie ? URL.createObjectURL(r.blob) : api.resultUrl(r.url);
      const base = `${(S.last?.pattern || "ovito").replace(/\*.*$/, "").replace(/[^\w.-]+/g, "_").replace(/[._]+$/, "")}`;
      const name = movie ? `${base}_frames${S.render.anim.start}-${S.render.anim.end ?? info.num_frames - 1}_ovito.mp4` : `${base}_frame${fi}_ovito.png`;
      const body = dlg.querySelector(".panel-body");
      clear(body).append(movie ? el("video", { src: url, controls: true, autoplay: true, loop: true, style: { maxWidth: "100%" } }) : el("img", { src: url, alt: `OVITO rendering of frame ${fi}` }));
      dlg.querySelector(".panel-head").insertBefore(el("span", { class: "sub" }, `${S.render.w} × ${S.render.h} px · ${bytes(r.bytes)} · ${S.render.renderer} · OVITO ${r.seconds} s`), dlg.querySelector(".actions"));
      dlg.querySelector(".actions").prepend(el("a", { class: "btn primary", href: url, download: name }, svg("download"), movie ? "MP4" : "PNG"),
        el("button", { class: "btn", type: "button", onclick: () => scriptModal(r.script) }, "Script"));
    } catch (e) { clear(dlg.querySelector(".panel-body")).append(errorState(e)); }
  }
  /** Movie: OVITO renders every frame (same camera, overlays, renderer as the image; [Timestep] labels update), the
   *  browser encodes H.264 MP4 (OVITO's own MP4 is MPEG-4 part 2, which browsers and PowerPoint do not play).
   *  Each frame lasts exactly 1/fps; the pixels are OVITO's. One request per frame, so it also works hosted. */
  async function encodeMovie(box) {
    const A = S.render.anim, fps = A.fps, w = S.render.w + S.render.w % 2, h = S.render.h + S.render.h % 2;
    const end = Math.min(A.end ?? info.num_frames - 1, info.num_frames - 1), list = [];
    for (let f = Math.max(0, A.start || 0); f <= end; f += Math.max(1, A.every || 1)) list.push(f);
    if (!list.length) throw new Error("no frames in the movie range");
    const codec = await pickCodec(w, h, fps, Math.round(Math.min(80e6, Math.max(1e6, w * h * fps * 0.15))));
    if (!codec) throw new Error("this browser cannot encode H.264 video at this size (WebCodecs); try Chrome or Edge, or a smaller size");
    const writer = mp4Writer(codec, fps), cv = el("canvas", { width: w, height: h }), c = cv.getContext("2d"), t0 = performance.now();
    let first = null;
    try {
      for (let k = 0; k < list.length; k++) {
        const eta = k ? (performance.now() - t0) / k * (list.length - k) / 1000 : null;
        box.update({ progress: k / list.length, message: `OVITO renders frame ${list[k]} (${k + 1} of ${list.length})${eta ? `, about ${eta < 90 ? Math.ceil(eta) + " s" : Math.ceil(eta / 60) + " min"} left` : ""}` });
        const r = await api.job("/api/ovito/render", { method: "POST", data: { spec: { ...fullSpec(false), frame: list[k] } }, pollMs: 300 });
        first = first || r;
        const bmp = await createImageBitmap(await (await fetch(api.resultUrl(r.url))).blob());
        c.fillStyle = S.render.bg; c.fillRect(0, 0, w, h); c.drawImage(bmp, 0, 0, w, h); bmp.close();
        await writer.add(cv);
      }
      const blob = await writer.finish();
      return { blob, bytes: blob.size, seconds: ((performance.now() - t0) / 1000).toFixed(1), script: first.script };
    } catch (e) { writer.abort(); throw e; }
  }
  async function showScript() {
    if (!frame) { toast("Open a trajectory first.", "warn"); return; }
    try { scriptModal((await api.post("/api/ovito/script", { spec: fullSpec(false) })).body.script); } catch (e) { toast(e.message, "err"); }
  }
  function scriptModal(text) {
    const close = () => back.remove();
    const back = el("div", { class: "modal-backdrop open", role: "dialog", "aria-modal": "true", "aria-label": "OVITO script", onclick: e => { if (e.target === back) close(); } },
      el("div", { class: "modal wide" }, el("div", { class: "panel-head" }, el("h3", {}, "OVITO Python script"), el("span", { class: "sub" }, "what the OVITO worker runs; runs on its own with pip install ovito"),
        el("div", { class: "actions" }, el("button", { class: "btn", type: "button", onclick: () => download("nanocut_ovito.py", text, "text/x-python") }, svg("download"), ".py"),
          el("button", { class: "btn", type: "button", onclick: async () => { try { await navigator.clipboard.writeText(text); toast("Script copied.", "ok"); } catch { toast("Clipboard not available.", "err"); } } }, svg("copy"), "Copy"),
          el("button", { class: "btn", type: "button", onclick: close }, "Close"))),
        el("pre", { class: "code code-pane" }, ...text.split("\n").map((l, i) => el("div", { class: "ln" }, el("i", {}, String(i + 1)), el("span", {}, l))))));
    document.body.append(back);
  }

  // -- results of the current frame (all computed by OVITO)
  function buildResults(p) {
    if (!frame) { p.append(el("p", { class: "muted" }, "No frame yet.")); return; }
    const m = frame.meta, attrs = Object.entries(m.attributes).filter(([k]) => k !== "SourceFrame");
    const r = frame.pickedRow;
    p.append(sec("Picked particle", r ? el("table", { class: "data compact" }, el("tbody", {}, Object.entries(r).map(([k, v]) => el("tr", {}, el("td", { class: "mono" }, k), el("td", { class: "num" }, typeof v === "number" ? num(v, 6) : String(v))))))
      : el("p", { class: "muted small" }, "Click a particle in the viewport.")));
    p.append(sec(`OVITO attributes (frame ${fi})`, el("div", { class: "table-wrap ov-table" }, el("table", { class: "data compact" },
      el("tbody", {}, attrs.map(([k, v]) => el("tr", {}, el("td", { class: "mono" }, k), el("td", { class: "num" }, typeof v === "number" ? num(v, 6) : String(v)))))))));
    p.append(sec("Particle properties after the pipeline", el("div", { class: "table-wrap ov-table" }, el("table", { class: "data compact" },
      el("thead", {}, el("tr", {}, el("th", {}, "Property"), el("th", { class: "num" }, "Min"), el("th", { class: "num" }, "Max"), el("th", { class: "num" }, "Mean"))),
      el("tbody", {}, Object.entries(m.stats).map(([k, [lo, hi, mean]]) => el("tr", {}, el("td", { class: "mono" }, k), el("td", { class: "num" }, num(lo, 5)), el("td", { class: "num" }, num(hi, 5)), el("td", { class: "num" }, num(mean, 5))))))),
      el("p", { class: "muted small" }, `${num(m.count)} particles · ${m.layout.lines ? `${num(m.layout.lines / 2)} dislocation segments drawn · ` : ""}OVITO compute ${m.seconds.compute} s.`)));
  }
  function buildMore(p) {
    if (!frame) { p.append(el("p", { class: "muted" }, "No frame yet.")); return; }
    const cols = new Set(["Particle Identifier", "Particle Type", "Position.X", "Position.Y", "Position.Z"]);
    let fmt = "lammps/dump";
    const res = el("div", {});
    p.append(sec("Export with OVITO",
      el("p", { class: "muted small" }, "OVITO writes this frame after the pipeline (e.g. with displacements, structure types) with its own exporter."),
      row("Format", sel([["lammps/dump", "LAMMPS dump"], ["xyz", "XYZ"], ["lammps/data", "LAMMPS data"], ["vasp", "POSCAR"]], fmt, v => { fmt = v; }, "Export format")),
      el("div", { class: "chips" }, Object.keys(frame.meta.stats).map(c => el("button", { class: "chip", type: "button", "aria-pressed": cols.has(c),
        onclick: e => { cols.has(c) ? cols.delete(c) : cols.add(c); e.currentTarget.setAttribute("aria-pressed", cols.has(c)); } }, c))),
      el("button", { class: "btn", type: "button", onclick: async () => {
        clear(res).append(loading("OVITO exports…"));
        try {
          const r = await api.job("/api/ovito/export", { method: "POST", data: { spec: fullSpec(false), format: fmt, columns: [...cols] }, pollMs: 300 });
          clear(res).append(el("a", { class: "btn primary", href: api.resultUrl(r.url), download: r.file }, svg("download"), `${r.file} (${bytes(r.bytes)})`));
        } catch (e) { clear(res).append(errorState(e)); }
      } }, "Export with OVITO"), res));
    let ref = 0;
    const vres = el("div", {});
    p.append(sec("Cross-check: OVITO vs NanoCut's reader",
      el("p", { class: "muted small" }, "Atom ids, positions and displacements of this frame relative to a reference frame, read by OVITO and by NanoCut's own parser (the Studio). Differences around 1e-5 Å are float32 rounding."),
      row("Reference frame", numIn(ref, v => { ref = Math.max(0, Math.round(v || 0)); }, { min: 0, step: 1 })),
      el("button", { class: "btn", type: "button", disabled: !!src.upload, "data-tip": src.upload ? "Available for server paths" : "", onclick: async () => {
        clear(vres).append(loading("OVITO and NanoCut read the frames…"));
        try {
          const r = await api.job("/api/ovito/verify", { method: "POST", data: { ...src, frame: fi, reference: ref }, pollMs: 300 });
          const maxd = Math.max(...["x", "y", "z"].map(a => r[`max_diff_position_${a}_A`] ?? Infinity), ...["dx", "dy", "dz"].map(a => r[`max_diff_${a}_A`] ?? Infinity));
          const ok = r.same_atom_ids && r.step_ovito === r.step_nanocut && maxd < 1e-3;
          clear(vres).append(el("div", { class: `banner ${ok ? "" : "err"}` }, el("b", {}, ok ? "Agree. " : "Differ. "), ok ? `Largest difference ${maxd.toExponential(2)} Å.` : "See the table."),
            el("table", { class: "data compact" }, el("tbody", {}, Object.entries(r).map(([k, v]) => el("tr", {}, el("td", { class: "mono" }, k), el("td", { class: "num" }, Array.isArray(v) ? v.map(x => num(x, 5)).join(" … ") : typeof v === "number" ? (Math.abs(v) < 1e-3 && v !== 0 ? v.toExponential(2) : num(v, 6)) : String(v)))))));
        } catch (e) { clear(vres).append(errorState(e)); }
      } }, "Run cross-check"), vres));
  }

  // ---------------------------------------------------------------------------------------------- start
  buildSide();
  resize();
  showState(el("div", { class: "state st-start" }, el("b", {}, `OVITO ${st.ovito} · live 3D`),
    el("span", {}, hosted ? "Upload dump files from this computer to the OVITO server (private, deleted after a day). OVITO then computes every frame; rotate, zoom and play it here, and let OVITO render the final image or movie."
      : "Open a folder or dump files on this computer: OVITO reads them where they are, nothing is copied. OVITO then computes every frame; rotate, zoom and play it here, and let OVITO render the final image or movie."),
    el("div", { class: "field-row" }, ...(hosted ? [el("button", { class: "btn primary", type: "button", onclick: () => pickFiles.click() }, "Upload files…"), el("button", { class: "btn", type: "button", onclick: () => pickDir.click() }, "Upload folder…")]
      : [el("button", { class: "btn primary", type: "button", onclick: () => localPick("folder") }, "Open folder…"), el("button", { class: "btn", type: "button", onclick: () => localPick("files") }, "Open file(s)…")])),
    runs.length ? el("div", { class: "chips" }, runs.map(path => el("button", { class: "chip", type: "button", onclick: () => { pathIn.value = path; scan(path); } }, path))) : null));
  if (S.last?.path) scan(S.last.path);
  else if (S.last?.upload && !api.apiHosted()) open({ upload: S.last.upload, pattern: S.last.pattern }, S.last).catch(() => {});
  else if (S.last?.blob && api.apiHosted()) open({ blob: S.last.blob, pattern: S.last.pattern }, S.last).catch(() => {});

  return () => { alive = false; playing = false; ro.disconnect(); document.removeEventListener("keydown", onKey); cancelAnimationFrame(raf); };
}
