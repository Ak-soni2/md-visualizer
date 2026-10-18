// Background research analysis of a trajectory (PLAN_PHASE3.md §2) with the run's own defaults: started automatically
// when the OVITO page opens a folder/file (local backend), or from Graph Studio → "Analyse dumps…". Runs as a background
// task (js/tasks.js) on its own OVITO worker, so the viewport stays responsive and tab switches do not stop it. The
// result — plus the LAMMPS force/temperature/log files found next to the dumps — appears in Graph Studio.
import * as api from "./api.js";
import * as tasks from "./tasks.js";
import * as store from "./research_store.js";

export const AUTO_MAX_FRAMES = 60;
export const taskKey = source => `research:${JSON.stringify([source.path, source.dir, source.pattern, source.upload, source.remote])}`;

function evenly(n, k) {
  if (n <= k) return [...Array(n).keys()];
  return [...new Set(Array.from({ length: k }, (_, i) => Math.round(i * (n - 1) / (k - 1))))];
}

/** source: the OVITO page's source body ({path, pattern} …). Returns the task (an existing one when it runs already). */
export function startResearch({ source, label, numFrames = null, frames = null, maxFrames = AUTO_MAX_FRAMES, cfg: extra = {} }) {
  return tasks.start(taskKey(source), `Research analysis · ${label}`, async (update, t) => {
    const spec = { source, frame: 0, modifiers: [] };
    update({ progress: 0, message: "reading the run settings" });
    const d = (await api.post("/api/ovito/research/defaults", { spec }, 600000)).body;
    const n = numFrames ?? (await api.job("/api/ovito/info", { method: "POST", data: { ...source, frame: 0 } })).num_frames;
    const fr = frames || evenly(n, maxFrames);
    const cfg = { types: d.types, tool_types: d.tool_types?.length ? d.tool_types : [1], dt_ps: d.dt_ps ?? 0.0005, structure: d.structure || "diamond",
      direction: d.direction || "-x", rake_deg: d.rake_deg ?? 0, strain: true, ...extra };
    const token = Math.random().toString(16).slice(2);
    t.cancel = () => api.post(`/api/ovito/frames/cancel/${token}`).catch(() => {});
    const res = await api.job("/api/ovito/research", { method: "POST", pollMs: 800, timeoutMs: 72 * 3600e3, onProgress: x => update({ progress: x.progress, message: x.message }),
      data: { spec, frames: fr, cfg, token } });
    store.finalizeRows(res.rows, cfg.dt_ps);
    await store.ready;
    store.removeSource(res.import_path);
    const ds = store.addResearch(res, label);
    let side = [];
    try { side = (await api.post("/api/ovito/research/sidefiles", { spec })).body.datasets || []; store.addImported(side, { source: res.import_path }); } catch { /* none */ }
    return { dataset: ds.id, frames: fr.length, of: n, side: side.length };
  }, { href: "#/graphs" });
}

/** Analyse automatically unless this trajectory was analysed already (kept in the browser) or is running. */
export async function autoResearch(source, label, info) {
  if (api.apiHosted()) return null;
  await store.ready;
  const t = tasks.get(taskKey(source));
  if (t && t.status !== "error") return t;
  if (store.list().some(d => d.kind === "research" && d.import_path === info.source?.import_path)) return null;
  return startResearch({ source, label, numFrames: info.num_frames });
}
