// Where the Studio's frames come from. Both sources answer the same calls and return the same records as the
// backend's /api/studio routes (see backend/app/studio.py):
//   scan -> {path, sequences}, open(seq) -> source, load(i, ref) -> frame metadata, cols(...) -> typed arrays, atom(...)
// serverSource: the Python backend reads the files (local backend, or the data bundled with the Vercel deployment).
// browserSource: files the user picked are read here, in a Web Worker; nothing leaves this computer.
import * as api from "../api.js";
import { displacement } from "./dumpparse.js";

// ------------------------------------------------------------------------------------------------ server
export const serverSource = {
  kind: "server",
  scan: path => api.get(`/api/studio/scan?path=${encodeURIComponent(path)}`),
  open: (seq, refresh, onProgress) => api.job("/api/studio/open", { method: "POST", data: { path: seq.dir, pattern: seq.pattern, refresh }, onProgress }),
  loadUrl: (src, i, ref) => `/api/studio/sources/${src.id}/frames/${i}/load${ref != null ? `?ref=${ref}` : ""}`,
  load(src, i, ref, onProgress, pollMs) { return api.job(this.loadUrl(src, i, ref), { method: "POST", pollMs, onProgress }); },
  prefetch(src, i, ref) { api.post(this.loadUrl(src, i, ref)).catch(() => {}); },
  async cols(src, f, names) {
    const get = () => api.getBinary(`/api/studio/sources/${src.id}/frames/${f.index}/data?cols=${encodeURIComponent(names.join(","))}${f.ref != null ? `&ref=${f.ref}` : ""}`);
    let buf;
    try { buf = await get(); }
    catch (e) {
      if (e.status !== 409) throw e;                          // evicted from the server cache meanwhile: load again
      await this.load(src, f.index, f.ref);
      buf = await get();
    }
    const out = {};
    names.forEach((c, k) => { const off = k * f.n * 4; out[c] = c === "id" ? new Uint32Array(buf, off, f.n) : new Float32Array(buf, off, f.n); });
    return out;
  },
  atom: (src, i, k, ref) => api.get(`/api/studio/sources/${src.id}/frames/${i}/atom/${k}${ref != null ? `?ref=${ref}` : ""}`),
};

// ------------------------------------------------------------------------------------------------ browser
const DUMP_HINT = /(\.lammpstrj|\.dump|\.atom|\.lammpsdump|\.trj)(\.\d+)?(\.gz)?$|^dump|\.dump\.|\.lammpstrj\./i;
const SKIP_SUFFIX = new Set([".csv", ".log", ".restart", ".txt", ".in", ".py", ".sh", ".png", ".jpg", ".json", ".md", ".data", ".xyz", ".bat"]);
const HIDDEN = new Set([".git", ".venv", "__pycache__", ".claude", "node_modules", "backups"]);
const NUM_RE = /^(.*?)(\d+)(\D*)$/;
const isGz = f => f.name.toLowerCase().endsWith(".gz");

function candidate(name) {
  const low = name.toLowerCase(), base = low.endsWith(".gz") ? low.slice(0, -3) : low, dot = base.lastIndexOf(".");
  if (dot > 0 && SKIP_SUFFIX.has(base.slice(dot))) return false;
  return DUMP_HINT.test(low);
}
async function isDump(file) {
  try {
    let head;
    if (isGz(file)) {
      const r = file.stream().pipeThrough(new DecompressionStream("gzip")).getReader();
      head = new TextDecoder().decode((await r.read()).value?.slice(0, 64));
      r.cancel().catch(() => {});
    } else head = await file.slice(0, 64).text();
    return head.trimStart().startsWith("ITEM: TIMESTEP");
  } catch { return false; }
}
function hash(s) {                                           // FNV-1a, a stable id for a sequence
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return "local-" + (h >>> 0).toString(16);
}

let worker = null, nextId = 1;
const pending = new Map();
function call(msg, onProgress) {
  if (!worker) {
    worker = new Worker(new URL("./dumpworker.js", import.meta.url), { type: "module" });
    worker.onmessage = e => {
      const p = pending.get(e.data.id);
      if (!p) return;
      if ("progress" in e.data) { p.onProgress?.({ progress: e.data.progress, message: e.data.message }); return; }
      pending.delete(e.data.id);
      e.data.error ? p.reject(new Error(e.data.error)) : p.resolve(e.data.result);
    };
    worker.onerror = e => { for (const p of pending.values()) p.reject(new Error(e.message || "dump reader failed")); pending.clear(); worker = null; };
  }
  const id = nextId++;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject, onProgress }); worker.postMessage({ id, ...msg }); });
}

// per-source frame cache (the backend keeps 3 frames; very large frames keep 2 to bound memory)
const cache = new Map();                                     // `${sid}:${i}` -> frame
const disp = new Map();                                      // `${sid}:${i}:${ref}` -> displacement
const inflight = new Map();
function remember(key, fr, natoms) {
  cache.delete(key); cache.set(key, fr);
  const max = natoms > 1_000_000 ? 2 : 3;
  while (cache.size > max) {
    const old = cache.keys().next().value;
    cache.delete(old);
    for (const k of [...disp.keys()]) if (k.startsWith(old + ":")) disp.delete(k);
  }
}
export const browserSource = {
  kind: "browser",
  /** files: a FileList from <input type=file> (folder or files). Same grouping as studio.scan(), two folder levels deep. */
  async scan(fileList) {
    const files = [...fileList], folder = files.some(f => f.webkitRelativePath);
    const root = folder ? files[0].webkitRelativePath.split("/")[0] : files.length === 1 ? files[0].name : `${files.length} selected files`;
    const groups = new Map();
    for (const f of files) {
      const parts = (f.webkitRelativePath || f.name).split("/"), name = parts.pop(), dir = parts.join("/");
      if (folder && (parts.length - 1 > 2 || parts.slice(1).some(p => HIDDEN.has(p) || p.startsWith(".")))) continue;
      if (folder && !candidate(name)) continue;
      const m = NUM_RE.exec(name), pattern = m ? `${m[1]}*${m[3]}` : name, key = `${dir}|${pattern}`;
      if (!groups.has(key)) groups.set(key, { dir, pattern, items: [] });
      groups.get(key).items.push([m ? parseInt(m[2], 10) : 0, f]);
    }
    const sequences = [];
    for (const g of groups.values()) {
      g.items.sort((p, q) => p[0] - q[0] || (p[1].name < q[1].name ? -1 : 1));
      if (!(await isDump(g.items[0][1]))) continue;
      sequences.push({ dir: g.dir || root, pattern: g.pattern, count: g.items.length, bytes: g.items.reduce((s, [, f]) => s + f.size, 0),
        first: g.items[0][1].name, last: g.items.at(-1)[1].name, single: g.items.length === 1, _files: g.items.map(([, f]) => f), _nums: g.items.map(([k]) => k) });
    }
    sequences.sort((p, q) => q.count - p.count || (p.dir < q.dir ? -1 : p.dir > q.dir ? 1 : p.pattern < q.pattern ? -1 : 1));
    return { path: root, sequences };
  },
  async open(seq, _refresh, onProgress) {
    const files = seq._files;
    let frames, steps, stepsFrom = "header";
    if (files.length === 1 && !isGz(files[0])) {
      const { offsets, steps: st } = await call({ op: "index", file: files[0] }, onProgress);
      if (!offsets.length) throw new Error("no 'ITEM: TIMESTEP' found in this file");
      frames = offsets.map((off, k) => ({ file: files[0], start: off, end: k + 1 < offsets.length ? offsets[k + 1] : files[0].size, gz: false }));
      steps = st;
    } else {
      frames = files.map(f => ({ file: f, start: 0, end: f.size, gz: isGz(f) }));
      // one frame per file: the number in the file name is the step (as in the backend); the header step is shown on load
      steps = seq._nums; stepsFrom = "file name";
    }
    const first = await call({ op: "head", file: frames[0].file, start: frames[0].start, gz: frames[0].gz });
    const id = hash(`${seq.dir}|${seq.pattern}|${seq.bytes}`);
    for (const k of [...cache.keys()]) if (k.startsWith(id + ":")) cache.delete(k);
    return { id, dir: seq.dir, pattern: seq.pattern, label: seq.dir === seq.pattern ? seq.pattern : `${seq.dir.split("/").pop()}/${seq.pattern}`, display: seq.dir, files: files.length,
      steps, steps_from: stepsFrom, natoms: first.natoms, columns: first.columns, cell: first.cell, bytes: seq.bytes,
      n_frames: frames.length, local: true, _frames: frames };
  },
  async frame(src, i, onProgress) {
    const key = `${src.id}:${i}`;
    if (cache.has(key)) { const fr = cache.get(key); remember(key, fr, fr.meta.natoms); return fr; }
    if (!inflight.has(key)) {
      const F = src._frames[i];
      inflight.set(key, call({ op: "parse", file: F.file, start: F.start, end: F.end, gz: F.gz }, onProgress)
        .then(fr => { fr.meta.file = F.file.webkitRelativePath || F.file.name; fr.meta.offset = F.start; fr.meta.index = i; fr.meta.source = src.id; remember(key, fr, fr.meta.natoms); return fr; })
        .finally(() => inflight.delete(key)));
    }
    return inflight.get(key);
  },
  async load(src, i, ref, onProgress) {
    const n = src.n_frames;
    if (!(i >= 0 && i < n) || (ref != null && !(ref >= 0 && ref < n))) throw new Error(`frame index out of range (0..${n - 1})`);
    const fr = await this.frame(src, i, onProgress);
    const meta = { ...fr.meta };
    if (ref != null) {
      const dk = `${src.id}:${i}:${ref}`;
      if (!disp.has(dk)) {
        const rf = ref === i ? fr : await this.frame(src, ref, onProgress);
        remember(`${src.id}:${i}`, fr, fr.meta.natoms);      // keep the current frame the most recent
        disp.set(dk, displacement(fr, rf, fr.meta.cell));
      }
      const D = disp.get(dk);
      meta.reference = { index: ref, step: src.steps[ref], ...D.info };
      meta.columns = [...meta.columns, "dx", "dy", "dz", "displacement"];
      meta.stats = { ...meta.stats, ...D.stats };
    }
    return meta;
  },
  prefetch(src, i) { this.frame(src, i).catch(() => {}); },
  async cols(src, f, names) {
    if (f.ref != null && !disp.has(`${src.id}:${f.index}:${f.ref}`)) await this.load(src, f.index, f.ref);   // evicted meanwhile
    const fr = await this.frame(src, f.index), D = f.ref != null ? disp.get(`${src.id}:${f.index}:${f.ref}`) : null;
    const out = {};
    for (const c of names) {
      const v = c === "id" ? fr.ids : fr.cols[c] ?? D?.cols[c];
      if (!v) throw new Error(`no column '${c}' in this frame`);
      out[c] = v;
    }
    return out;
  },
  async atom(src, i, k, ref) {
    const fr = await this.frame(src, i), D = ref != null ? disp.get(`${src.id}:${i}:${ref}`) : null;
    if (!(k >= 0 && k < fr.ids.length)) throw new Error("atom index out of range");
    const row = { id: fr.ids[k] };
    for (const [c, v] of Object.entries(fr.cols)) row[c] = v[k];
    if (D) for (const [c, v] of Object.entries(D.cols)) row[c] = v[k];
    return row;
  },
};
