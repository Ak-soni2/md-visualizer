// Bootstrap: navigation, routing (#/view?sim=id), simulation selector, connection status, shortcuts.
import * as api from "./api.js";
import { CONFIG } from "./config.js";
import { bus, state } from "./state.js";
import { $, el, clear, svg, icon, initTooltips, closeSource, toast, kindBadge, errorState, loading } from "./ui.js";
import { mountGuideButton } from "./guide.js";
import { mountIndicator } from "./tasks.js";

export const VIEWS = [
  { id: "workspace", label: "Workspace", load: () => import("./views/workspace.js") },
  { id: "overview", label: "Overview", load: () => import("./views/overview.js") },
  { id: "visualizer", label: "Visualizer", load: () => import("./views/visualizer.js"), full: true },
  { id: "analysis", label: "Analysis", load: () => import("./views/analysis.js") },
  { id: "parameters", label: "Parameters", load: () => import("./views/parameters.js") },
  { id: "decks", label: "Decks", load: () => import("./views/decks.js") },
  { id: "validation", label: "Validation", load: () => import("./views/validation.js") },
  { id: "studio", label: "Studio", load: () => import("./views/studio.js"), full: true },
  { id: "ovito", label: "OVITO", load: () => import("./views/ovito.js"), full: true },
  { id: "graphs", label: "Graphs", load: () => import("./views/graphs.js"), full: true },
];

let current = { view: null, cleanup: null, token: 0 };

function parseHash() {
  const h = location.hash.replace(/^#\/?/, "");
  const [path, q] = h.split("?");
  const params = new URLSearchParams(q || "");
  return { view: VIEWS.find(v => v.id === path) ? path : "workspace", sim: params.get("sim") };
}
export function navigate(view, sim = state.simId) {
  const h = `#/${view}${sim ? `?sim=${encodeURIComponent(sim)}` : ""}`;
  if (location.hash !== h) location.hash = h; else route();
}

function buildNav() {
  const nav = $("#nav");
  nav.append(el("div", { class: "nav-label" }, "Workspace"));
  VIEWS.forEach((v, i) => {
    if (i === 5) nav.append(el("div", { class: "nav-label" }, "Tools"));
    const a = el("a", { href: `#/${v.id}`, "data-view": v.id }, svg(v.id), el("span", {}, v.label), el("span", { class: "kbd", "aria-hidden": "true" }, `Alt ${(i + 1) % 10}`));
    a.addEventListener("click", e => { e.preventDefault(); navigate(v.id); });
    nav.append(a);
  });
}

function fillSimSelect() {
  const sel = $("#sim-select");
  clear(sel);
  const groups = { run: "Run folders (generated)", reference: "Reference decks (original)", preset: "Presets (configuration only)" };
  for (const [k, lab] of Object.entries(groups)) {
    const og = el("optgroup", { label: lab });
    state.sims.filter(s => s.kind === k).forEach(s => {
      const extra = s.kind === "run" ? (s.n_frames ? ` · ${s.n_frames} frames` : " · no dumps") : "";
      og.append(el("option", { value: s.id }, `${s.label}${extra}`));
    });
    if (og.children.length) sel.append(og);
  }
  if (state.simId) sel.value = state.simId;
}

function renderCurrentSim() {
  const s = state.sim(), box = $("#current-sim");
  clear(box);
  if (!s) { box.append(el("span", { class: "k" }, "Simulation"), el("span", { class: "v muted" }, "none selected")); return; }
  box.append(el("span", { class: "k" }, "Simulation"), el("span", { class: "v" }, s.label), el("span", {}, kindBadge(s.kind)), el("span", { class: "p" }, s.path || "built-in preset"));
  $("#sim-select").value = s.id;
}

function setConn({ mode, info }) {
  const c = $("#conn"), dot = c.querySelector(".dot"), t = c.querySelector(".t");
  dot.className = "dot " + (mode === "live" ? "ok" : mode === "fixtures" ? "warn" : "err");
  t.textContent = mode === "live" ? `Connected · API ${info?.api_version ?? ""}` : mode === "fixtures" ? "Offline demo · fixtures" : "Backend unreachable";
  c.setAttribute("data-tip", mode === "live" ? `Python backend at ${CONFIG.apiBase || location.origin}; NanoCut ${info?.nanocut_version}; Python ${info?.python}` :
    mode === "fixtures" ? `Snapshot generated ${info?.generated || ""} from the real API. Read-only.` : "Start the backend: webapp\\run_web.bat");
  $("#version").textContent = mode === "live" ? `API ${info?.api_version} · NanoCut ${info?.nanocut_version}` : (mode === "fixtures" ? "demo snapshot" : "");
  $("#btn-docs").setAttribute("aria-disabled", mode === "live" ? "false" : "true");
  $("#btn-docs").classList.toggle("disabled", mode !== "live");
}

let preferredSim = null;     // in the offline demo: the one simulation the snapshot contains
async function loadSims(force = false) {
  const r = await api.get(`/api/simulations${force ? "?refresh=true" : ""}`);
  state.setSims(r.simulations);
  if (preferredSim && state.simId !== preferredSim && r.simulations.some(s => s.id === preferredSim)) state.select(preferredSim);
  if (!state.sim()) {
    const pick = r.simulations.find(s => s.kind === "run" && s.n_frames) || r.simulations[0];
    if (pick) state.select(pick.id);
  }
  fillSimSelect();
  renderCurrentSim();
}

async function route() {
  const { view, sim } = parseHash();
  if (sim && sim !== state.simId && state.sims.find(s => s.id === sim)) { state.select(sim); renderCurrentSim(); }
  document.querySelectorAll("#nav a").forEach(a => a.dataset.view === view ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current"));
  const def = VIEWS.find(v => v.id === view);
  const s = state.sim();
  $("#crumb").replaceChildren(el("span", {}, def.label), s ? el("span", {}, "  /  ", el("b", {}, s.label)) : "");
  document.title = `${def.label} · NanoCut`;
  current.cleanup?.(); current.cleanup = null;
  const token = ++current.token;
  const root = $("#view");
  root.className = def.full ? "view full" : "view";
  clear(root).append(loading("Loading view…"));
  try {
    const mod = await def.load();
    if (token !== current.token) return;
    clear(root);
    current.view = view;
    current.cleanup = (await mod.render(root, { sim: s, navigate })) || null;
  } catch (e) {
    console.error(e);
    if (token === current.token) clear(root).append(errorState(e, route));
  }
}

function shortcuts() {
  document.addEventListener("keydown", e => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
    if (e.key === "Escape") { closeSource(); $("#help-modal").classList.remove("open"); return; }
    if (e.altKey && /^[0-9]$/.test(e.key) && VIEWS[(+e.key + 9) % 10]) { e.preventDefault(); navigate(VIEWS[(+e.key + 9) % 10].id); return; }
    if (typing) return;
    if (e.key === "?") { $("#help-modal").classList.add("open"); $("#help-close").focus(); }
    if (e.key === "/") { const s = document.querySelector("#view [data-search]"); if (s) { e.preventDefault(); s.focus(); } }
  });
}

async function main() {
  initTooltips();
  buildNav();
  mountGuideButton(document.querySelector(".sidebar-foot"));
  mountIndicator(document.getElementById("btn-help").parentElement);
  $("#btn-refresh").append(svg("refresh"));
  $("#btn-help").append(svg("help"));
  $("#btn-docs").href = (CONFIG.apiBase || "") + "/docs";
  $("#btn-docs").addEventListener("click", e => { if (api.apiMode() !== "live") { e.preventDefault(); toast("API docs need the running backend.", "warn"); } });
  $("#drawer-close").addEventListener("click", closeSource);
  $("#drawer-backdrop").addEventListener("click", closeSource);
  $("#btn-help").addEventListener("click", () => { $("#help-modal").classList.add("open"); $("#help-close").focus(); });
  $("#help-close").addEventListener("click", () => $("#help-modal").classList.remove("open"));
  $("#help-modal").addEventListener("click", e => { if (e.target.id === "help-modal") e.currentTarget.classList.remove("open"); });
  $("#sim-select").addEventListener("change", e => { state.select(e.target.value); renderCurrentSim(); navigate(parseHash().view, e.target.value); });
  $("#btn-refresh").addEventListener("click", async () => {
    try { await loadSims(true); bus.emit("refresh"); toast("Project folders rescanned.", "ok"); route(); }
    catch (e) { toast(`Rescan failed: ${e.message}`, "err"); }
  });
  bus.on("api-mode", setConn);
  bus.on("api-health", setConn);
  shortcuts();
  window.addEventListener("hashchange", route);

  const health = await api.checkHealth();
  if (api.apiMode() === "fixtures") preferredSim = health?.simulation || null;
  setInterval(() => api.checkHealth(), CONFIG.healthEveryMs);
  try { await loadSims(); }
  catch (e) { toast(`Could not list simulations: ${e.message}`, "err"); }
  route();
}
main();
