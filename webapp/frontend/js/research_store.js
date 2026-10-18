// Datasets for Graph Studio (PLAN_PHASE3.md §4.1): research analyses from the OVITO page, LAMMPS text output
// (fix ave/time files, log thermo tables), CSV/TSV tables and saved result files. Kept in memory for the session;
// "Save results" writes them to a file. Every dataset exposes the same interface: keys (with label/unit/category/region)
// and series(key) -> values per row (frame or table row).
import { bus } from "./state.js";

const datasets = [];
const newId = () => `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
export const PARAMS = [["speed_ms", "cutting speed (m/s)"], ["depth_nm", "depth of cut (nm)"], ["radius_nm", "edge radius (nm)"],
  ["T0_K", "initial temperature (K)"], ["rake_deg", "rake angle (deg)"], ["potential", "potential"], ["orientation", "orientation"]];

export const list = () => datasets;
export const byId = id => datasets.find(d => d.id === id);
function changed() { bus.emit("datasets", datasets); save(); }

// datasets survive a reload: kept in IndexedDB (per browser; "Save session" writes a file to keep or share)
const DB = "nanocut-graphs", STORE = "kv";
function idb() {
  return new Promise((res, rej) => { const r = indexedDB.open(DB, 1); r.onupgradeneeded = () => r.result.createObjectStore(STORE); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try { const db = await idb(); db.transaction(STORE, "readwrite").objectStore(STORE).put(sessionJson(), "session"); } catch { /* storage blocked: datasets live for this page only */ }
  }, 300);
}
export const ready = (async () => {
  try {
    const db = await idb();
    const s = await new Promise((res, rej) => { const r = db.transaction(STORE).objectStore(STORE).get("session"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    if (s?.datasets?.length && !datasets.length) addFromJson(s, "session");
  } catch { /* no IndexedDB */ }
})();
export function remove(id) { const i = datasets.findIndex(d => d.id === id); if (i >= 0) datasets.splice(i, 1); changed(); }

/** Run parameters from a NanoCut params.json (for across-run plots). */
export function paramsFromExperiment(p) {
  const e = p?.experiment || p || {};
  const out = {};
  if (e.process?.speed_ms != null) out.speed_ms = e.process.speed_ms;
  else if (e.process?.speed_aps != null) out.speed_ms = e.process.speed_aps * 100;
  if (e.process?.depth_nm != null) out.depth_nm = e.process.depth_nm;
  if (e.tool?.edge_radius_nm != null) out.radius_nm = e.tool.edge_radius_nm;
  if (e.thermo?.T_K != null) out.T0_K = e.thermo.T_K; else if (e.thermo?.temperature_K != null) out.T0_K = e.thermo.temperature_K;
  if (e.tool?.rake_deg != null) out.rake_deg = e.tool.rake_deg;
  if (e.potential?.key) out.potential = e.potential.key;
  return out;
}

/** Quantities that need several frames (same as nanocut.research.finalize): cumulative cutting work, speed between frames. */
export function finalizeRows(rows, dt) {
  rows.sort((a, b) => a.frame - b.frame);
  let work = 0, prev = null;
  for (const r of rows) {
    const s = r.scalars;
    if (prev) {
      const p = prev.scalars;
      if ([s.Fc, p.Fc, s.cut_distance, p.cut_distance].every(v => v != null)) work += 0.5 * (s.Fc + p.Fc) / 1.602176634 * (s.cut_distance - p.cut_distance);
      if (dt && [s.step, p.step, s.tool_com_x, p.tool_com_x].every(v => v != null) && s.step !== p.step)
        s.tool_speed_frames = Math.abs(s.tool_com_x - p.tool_com_x) / ((s.step - p.step) * dt) * 100;
    }
    if (s.Fc != null && s.cut_distance != null) s.work_cum = work;
    prev = r;
  }
  return rows;
}

export function removeSource(path) {
  for (let i = datasets.length - 1; i >= 0; i--) if (datasets[i].kind === "research" && datasets[i].import_path === path) datasets.splice(i, 1);
}

function makeResearch(res, label) {
  const rows = res.rows;
  const cat = res.catalogue || {};
  for (const r of rows) for (const k of Object.keys(r.scalars)) if (!cat[k]) cat[k] = { label: k, unit: "", category: "other", region: k.includes("@") ? k.split("@")[1] : null, quantity: k.split("@")[0] };
  const keys = Object.entries(cat).map(([key, m]) => ({ key, ...m }));
  return {
    id: res.dataset_id || newId(), kind: "research", label, rows, keys, cfg: res.cfg || {}, source: res.source, import_path: res.import_path,
    params: { ...paramsFromExperiment(res.params), ...(res.run_params || {}) }, ovito: res.ovito, seconds: res.seconds,
    regions: Object.assign({}, ...rows.map(r => r.regions || {})),
    n: rows.length,
    series(key) { return rows.map(r => { const v = r.scalars[key]; return v == null ? NaN : v; }); },
    frames() { return rows.map(r => r.frame); },
    curveNames() { return [...new Set(rows.flatMap(r => Object.keys(r.curves || {})))]; },
    mapNames() { return [...new Set(rows.flatMap(r => Object.keys(r.maps || {})))]; },
    raw: res,
  };
}

export function addResearch(res, label) {
  const d = makeResearch(res, label || res.source || "analysis");
  datasets.push(d); changed();
  return d;
}

/** A table {name: number[]} from a text file (fix ave/time, log thermo, CSV/TSV/whitespace with a header). */
export function parseTable(text, name) {
  const lines = text.split(/\r?\n/);
  const tables = [];
  // LAMMPS log: "Step ..." header, rows until "Loop time"
  if (lines.some(l => /^\s*Step\s/.test(l)) && lines.some(l => /^Loop time/.test(l))) {
    let head = null, rows = [];
    for (const l of lines) {
      const t = l.trim().split(/\s+/);
      if (/^\s*Step\s/.test(l)) { if (head && rows.length) tables.push({ head, rows }); head = t; rows = []; continue; }
      if (head) {
        if (/^Loop time|^WARNING|^ERROR/.test(l)) { if (rows.length) tables.push({ head, rows }); head = null; continue; }
        const v = t.map(Number);
        if (v.length === head.length && v.every(Number.isFinite)) rows.push(v);
      }
    }
    if (head && rows.length) tables.push({ head, rows });
    if (!tables.length) throw new Error("no thermo table found in the log");
    // all runs of the log in one table when their columns agree, else the longest
    const same = tables.every(t => t.head.join() === tables[0].head.join());
    const t = same ? { head: tables[0].head, rows: tables.flatMap(t => t.rows) } : tables.reduce((a, b) => (b.rows.length > a.rows.length ? b : a));
    return { columns: Object.fromEntries(t.head.map((h, i) => [h, t.rows.map(r => r[i])])), format: `LAMMPS log (${tables.length} run${tables.length > 1 ? "s" : ""})` };
  }
  // fix ave/time: "# step name ..." header line
  let head = null, rows = [], fmt = "table";
  for (const l of lines) {
    if (!l.trim()) continue;
    if (l.startsWith("#")) { const t = l.slice(1).trim().split(/\s+/); if (t[0] && /^(step|timestep|time)$/i.test(t[0])) { head = t; fmt = "LAMMPS fix ave/time"; } continue; }
    const t = l.trim().split(/\s*[,;\t]\s*|\s+/);
    if (!head) { if (t.some(x => !Number.isFinite(Number(x)))) { head = t; continue; } head = t.map((_, i) => `col${i + 1}`); }
    const v = t.map(Number);
    if (v.length === head.length && v.every(Number.isFinite)) rows.push(v);
  }
  if (!head || !rows.length) throw new Error(`${name}: no numeric table with a header found`);
  return { columns: Object.fromEntries(head.map((h, i) => [h, rows.map(r => r[i])])), format: fmt };
}

/** A table dataset from columns ({name: values}); kind "frames" (one row per frame), "atoms" (one row per atom), "table". */
export function makeTable({ label, format = "table", columns, params = {}, kind = "table", note = "", dataset_id = null, source = null }) {
  const keys = Object.keys(columns).map(k => ({ key: k, label: k, unit: /_nN$|\[nN\]/.test(k) ? "nN" : /_K$/.test(k) ? "K" : "", category: kind === "atoms" ? "per atom" : "file", region: null, quantity: k }));
  const n = keys.length ? columns[keys[0].key].length : 0;
  return { id: dataset_id || newId(), kind: "table", subkind: kind, label, format, columns, keys, params, n, note, source,
    series(key) { return (columns[key] || []).map(v => (v == null ? NaN : v)); }, frames() { return [...Array(n).keys()]; },
    curveNames: () => [], mapNames: () => [] };
}
export function addImported(list, extra = {}) {
  const out = [];
  for (const ds of list) {
    if (!ds.columns || !Object.keys(ds.columns).length) continue;
    if (extra.source) { const old = datasets.findIndex(d => d.source === extra.source && d.label === ds.label); if (old >= 0) datasets.splice(old, 1); }
    const d = makeTable({ ...ds, ...extra });
    datasets.push(d); out.push(d);
  }
  changed();
  return out;
}

// figures asked for by other pages (OVITO charts → "Open in Graph Studio"); Graph Studio picks them up
const pending = [];
export function requestFigure(fig) { pending.push(fig); bus.emit("figreq", fig); }
export function takeFigureRequests() { return pending.splice(0); }

export function addTable(text, name) {
  const { columns, format } = parseTable(text, name);
  const keys = Object.keys(columns).map(k => ({ key: k, label: k, unit: /_nN$/.test(k) ? "nN" : /_K$/.test(k) ? "K" : "", category: "file", region: null, quantity: k }));
  const n = Object.values(columns)[0].length;
  const d = { id: newId(), kind: "table", label: name, format, columns, keys, params: {}, n,
    series(key) { return (columns[key] || []).map(v => (v == null ? NaN : v)); }, frames() { return [...Array(n).keys()]; },
    curveNames: () => [], mapNames: () => [] };
  datasets.push(d); changed();
  return d;
}

/** Load a saved results file (one analysis or a whole session). */
export function addFromJson(obj, name) {
  if (obj?.nanocut_session) { const out = []; for (const d of obj.datasets) out.push(...addFromJson(d, d.label)); return out; }
  if (obj?.rows && obj.rows[0]?.scalars) { const d = addResearch(obj, obj.label || name); d.params = { ...d.params, ...(obj.run_params || {}) }; return [d]; }
  if (obj?.columns) {                                                  // a saved table dataset
    const d = makeTable({ label: obj.label || name, format: obj.format, columns: obj.columns, params: obj.params || {}, kind: obj.subkind || "table", note: obj.note, dataset_id: obj.dataset_id, source: obj.source });
    datasets.push(d); changed(); return [d];
  }
  throw new Error(`${name}: not a NanoCut results file`);
}

export function toJson(d) {
  if (d.kind === "research") return { ...d.raw, label: d.label, run_params: d.params, dataset_id: d.id };
  return { kind_saved: "table", dataset_id: d.id, label: d.label, format: d.format, columns: d.columns, params: d.params, subkind: d.subkind, note: d.note, source: d.source };
}
export function sessionJson() { return { nanocut_session: 1, saved: new Date().toISOString(), datasets: datasets.map(toJson) }; }
