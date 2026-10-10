// API client. Talks to the FastAPI backend; when it is unreachable, falls back to the labelled demo fixtures
// in /fixtures (a snapshot of real API responses), and says so in the UI. Never invents data.
import { CONFIG } from "./config.js";
import { bus } from "./state.js";

let mode = "unknown";            // "live" | "fixtures" | "offline"
let fixtureIndex = null;

export const apiMode = () => mode;

function url(path) { return CONFIG.apiBase.replace(/\/$/, "") + path; }

async function fetchJSON(path, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeout ?? CONFIG.requestTimeoutMs);
  try {
    const r = await fetch(url(path), { ...opts, signal: ctrl.signal, headers: { "Content-Type": "application/json", ...(opts.headers || {}) } });
    const body = r.headers.get("content-type")?.includes("json") ? await r.json() : await r.text();
    if (!r.ok && r.status !== 202) {
      const msg = (body && body.detail) || (typeof body === "string" ? body : r.statusText);
      const e = new Error(msg); e.status = r.status; throw e;
    }
    return { status: r.status, body };
  } finally { clearTimeout(t); }
}

async function loadFixtures() {
  if (fixtureIndex) return fixtureIndex;
  const r = await fetch(CONFIG.fixturesPath + "index.json");
  if (!r.ok) throw new Error("no fixtures");
  fixtureIndex = await r.json();
  return fixtureIndex;
}

async function fromFixtures(path) {
  const idx = await loadFixtures();
  const file = idx.routes[path.split("&max_atoms")[0]] ?? idx.routes[path];
  if (!file) { const e = new Error("not available in the offline demo snapshot"); e.status = 503; e.offline = true; throw e; }
  const r = await fetch(CONFIG.fixturesPath + file);
  return r.json();
}

export async function checkHealth() {
  try {
    const { body } = await fetchJSON("/api/health", { timeout: 5000 });
    setMode("live", body);
    return body;
  } catch {
    try { const idx = await loadFixtures(); setMode("fixtures", idx.meta); return idx.meta; }
    catch { setMode("offline", null); return null; }
  }
}

function setMode(m, info) {
  const changed = m !== mode;
  mode = m;
  document.body.classList.toggle("fixture-mode", m === "fixtures");
  if (changed) bus.emit("api-mode", { mode: m, info });
  else bus.emit("api-health", { mode: m, info });
}

export async function get(path) {
  if (mode === "fixtures") return fromFixtures(path);
  if (mode === "offline") { const e = new Error("backend unreachable"); e.status = 0; throw e; }
  const { body } = await fetchJSON(path);
  return body;
}

export async function post(path, data) {
  if (mode !== "live") { const e = new Error("this action needs the Python backend (offline demo is read-only)"); e.status = 503; e.offline = true; throw e; }
  const { status, body } = await fetchJSON(path, { method: "POST", body: JSON.stringify(data ?? {}) });
  return { status, body };
}

/** Run an endpoint that may answer 202 + job record; poll until done. onProgress(job) gets each update. */
export async function job(path, { method = "GET", data, onProgress, timeoutMs = 900000, pollMs = CONFIG.jobPollMs } = {}) {
  if (mode === "fixtures") {
    const body = await fromFixtures(path);
    return body.result ?? body;
  }
  if (mode !== "live") { const e = new Error("backend unreachable"); e.status = 0; throw e; }
  const first = method === "POST" ? await post(path, data) : await fetchJSON(path);
  let rec = first.body;
  if (!(rec && rec.id && rec.status)) return rec;                                  // plain (non-job) result
  const t0 = performance.now();
  while (rec.status !== "done") {
    if (rec.status === "error") { const e = new Error(rec.error || "job failed"); e.job = rec; throw e; }
    onProgress?.(rec);
    if (performance.now() - t0 > timeoutMs) throw new Error("timed out waiting for " + (rec.label || path));
    await new Promise(r => setTimeout(r, pollMs));
    rec = (await fetchJSON(`/api/jobs/${rec.id}`)).body;
  }
  onProgress?.(rec);
  return rec.result;
}

export const apiUrl = url;

/** Raw bytes from the live backend (Studio frame columns). */
export async function getBinary(path) {
  if (mode !== "live") { const e = new Error("the Studio needs the Python backend"); e.status = 503; e.offline = true; throw e; }
  const r = await fetch(url(path));
  if (!r.ok) {
    let msg = r.statusText; try { msg = (await r.json()).detail || msg; } catch { /* not JSON */ }
    const e = new Error(msg); e.status = r.status; throw e;
  }
  return r.arrayBuffer();
}
