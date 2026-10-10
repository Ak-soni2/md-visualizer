// Shared UI helpers: element builder, formatting, badges, states, toasts, tooltips, source drawer, icons.
import * as api from "./api.js";

export function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else if (k === "style" && typeof v === "object") Object.assign(n.style, v);
    else if (v === true) n.setAttribute(k, "");
    else n.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
}
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export function clear(n) { while (n.firstChild) n.firstChild.remove(); return n; }

// ---------------------------------------------------------------- formatting
export function num(v, digits = 3) {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v !== "number") { const f = Number(v); if (!Number.isFinite(f)) return String(v); v = f; }
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (Number.isInteger(v) && a < 1e15) return v.toLocaleString("en-US");      // counts and steps: always exact
  if (a !== 0 && (a >= 1e6 || a < 1e-3)) return v.toExponential(Math.max(1, digits - 1));
  return v.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}
export function bytes(b) {
  if (b === null || b === undefined) return "—";
  const u = ["B", "kB", "MB", "GB", "TB"]; let i = 0;
  while (b >= 1000 && i < u.length - 1) { b /= 1000; i++; }
  return `${b < 10 && i ? b.toFixed(1) : Math.round(b)} ${u[i]}`;
}
export function ago(t) {
  if (!t) return "never";
  const s = Math.round(Date.now() / 1000 - t);
  if (s < 60) return `${s}s ago`; if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`; return new Date(t * 1000).toLocaleString();
}
export function when(t) { return t ? new Date(t * 1000).toLocaleString() : "—"; }

// ---------------------------------------------------------------- badges
const ORIGIN_TEXT = { original: "Original · read-only", generated: "Generated", preset: "Preset", code: "Code", document: "Document" };
const KIND_TEXT = { run: "Run folder", reference: "Reference deck", preset: "Preset" };
const PROV_TEXT = { file: "File", computed: "Computed", editable: "Editable", missing: "Missing" };
const PROV_TIP = {
  file: "Read from a line of an input deck. Click the source to see the line.",
  computed: "Derived by NanoCut (unit conversion, geometry model, exact atom counts).",
  editable: "An input of the NanoCut experiment. Change it in a draft on the Decks page; files are never edited.",
  missing: "Expected in a cutting deck but not found.",
};
export const originBadge = o => el("span", { class: `badge ${o}`, "data-tip": o === "original" ? "Source file written by you or shipped with LAMMPS. The app never modifies it." : o === "generated" ? "Written by NanoCut or by a run of its decks." : null }, ORIGIN_TEXT[o] || o);
export const kindBadge = k => el("span", { class: `badge ${k}` }, KIND_TEXT[k] || k);
export const provBadge = p => el("span", { class: `badge p-${p}`, "data-tip": PROV_TIP[p] }, PROV_TEXT[p] || p);
export const statusDot = s => el("span", { class: `dot ${s === "error" ? "err" : s}` });
export function statusLabel(s, text) { return el("span", { class: `status ${s}` }, statusDot(s), text ?? ({ ok: "OK", warn: "Warnings", error: "Errors", "n/a": "Not applicable" }[s] || s)); }

// ---------------------------------------------------------------- states
export function loading(msg = "Loading…", job) {
  const n = el("div", { class: "state", role: "status", "aria-live": "polite" }, el("div", { class: "spinner" }), el("b", {}, msg));
  if (job) { const bar = el("div", { class: "progress" }, el("i")); n.append(bar, el("span", { class: "msg" })); }
  n.update = (rec) => { const i = n.querySelector(".progress > i"); if (i) i.style.width = `${Math.round((rec.progress || 0) * 100)}%`; const m = n.querySelector(".msg"); if (m) m.textContent = rec.message || rec.status || ""; };
  return n;
}
export function empty(title, detail) { return el("div", { class: "state" }, el("b", {}, title), detail ? el("span", {}, detail) : null); }
export function errorState(err, retry) {
  const off = err && err.offline;
  return el("div", { class: "state err", role: "alert" },
    el("b", {}, off ? "Not available offline" : "Could not load"),
    el("span", {}, err?.message || String(err)),
    retry && !off ? el("button", { class: "btn", onclick: retry }, "Retry") : null);
}

// ---------------------------------------------------------------- toasts
export function toast(msg, kind = "info", ms = 4200) {
  const box = $("#toasts");
  const t = el("div", { class: `toast ${kind}`, role: kind === "err" ? "alert" : "status" }, msg);
  box.append(t);
  setTimeout(() => t.remove(), ms);
}

// ---------------------------------------------------------------- tooltips (any element with data-tip)
export function initTooltips() {
  const tip = el("div", { class: "tip", role: "tooltip", id: "tooltip" });
  document.body.append(tip);
  let cur = null;
  const show = (target) => {
    const txt = target.getAttribute("data-tip"); if (!txt) return;
    cur = target; tip.textContent = txt; tip.classList.add("show");
    const r = target.getBoundingClientRect();
    const tw = Math.min(320, tip.offsetWidth);
    tip.style.left = `${Math.max(8, Math.min(window.innerWidth - tw - 8, r.left + r.width / 2 - tw / 2))}px`;
    tip.style.top = `${r.bottom + 6 + tip.offsetHeight > window.innerHeight ? r.top - tip.offsetHeight - 6 : r.bottom + 6}px`;
    target.setAttribute("aria-describedby", "tooltip");
  };
  const hide = () => { tip.classList.remove("show"); cur?.removeAttribute("aria-describedby"); cur = null; };
  document.addEventListener("pointerover", e => { const t = e.target.closest?.("[data-tip]"); if (t && t !== cur) show(t); else if (!t && cur) hide(); });
  document.addEventListener("focusin", e => { const t = e.target.closest?.("[data-tip]"); if (t) show(t); });
  document.addEventListener("focusout", hide);
  document.addEventListener("scroll", hide, true);
}

// ---------------------------------------------------------------- source drawer (read-only)
let lastFocus = null;
export async function openSource(path, line) {
  const drawer = $("#drawer"), body = $("#drawer-body"), head = $("#drawer-path"), meta = $("#drawer-meta");
  lastFocus = document.activeElement;
  head.textContent = path; meta.textContent = "";
  clear(body).append(loading("Reading file…"));
  drawer.classList.add("open"); drawer.setAttribute("aria-hidden", "false");
  $("#drawer-backdrop").classList.add("open");
  $("#drawer-close").focus();
  try {
    const f = await api.get(`/api/files/text?path=${encodeURIComponent(path)}`);
    head.textContent = f.path;
    meta.replaceChildren(f.origin ? originBadge("original") : el("span", { class: "badge" }, "Read-only view"),
      el("span", { class: "muted" }, ` ${bytes(f.bytes)}${f.truncated ? " · truncated" : ""}`));
    const pre = el("div", { class: "code", role: "region", "aria-label": `Contents of ${f.path}` });
    const frag = document.createDocumentFragment();
    f.lines.forEach((txt, i) => {
      const row = el("div", { class: "ln" + (line && i + 1 === line ? " hl" : ""), id: `L${i + 1}` }, el("i", {}, String(i + 1)), el("span", { html: highlight(txt) }));
      frag.append(row);
    });
    pre.append(frag);
    clear(body).append(pre);
    if (line) requestAnimationFrame(() => body.querySelector(`#L${line}`)?.scrollIntoView({ block: "center" }));
  } catch (e) { clear(body).append(errorState(e)); }
}
export function closeSource() {
  $("#drawer").classList.remove("open"); $("#drawer").setAttribute("aria-hidden", "true");
  $("#drawer-backdrop").classList.remove("open");
  lastFocus?.focus?.();
}
function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
const KW = /^(\s*)(units|dimension|boundary|atom_style|lattice|region|create_box|create_atoms|group|mass|pair_style|pair_coeff|fix|unfix|compute|variable|velocity|timestep|thermo_style|thermo_modify|thermo|dump_modify|dump|restart|write_restart|read_restart|run|minimize|min_style|set|print|shell|log|if|reset_timestep|fix_modify|neighbor|neigh_modify|delete_atoms|displace_atoms|lattice|uncompute|undump|compute_modify)\b/;
function highlight(line) {
  const i = line.indexOf("#");
  const code = i >= 0 ? line.slice(0, i) : line, com = i >= 0 ? line.slice(i) : "";
  let h = esc(code).replace(KW, (m, sp, kw) => `${sp}<span class="kw">${kw}</span>`).replace(/(\$\{\w+\}|\$\w)/g, '<span class="nm">$1</span>');
  return h + (com ? `<span class="c">${esc(com)}</span>` : "");
}

// ---------------------------------------------------------------- misc
export function download(name, text, type = "text/plain") {
  const a = el("a", { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
export function tabs(defs, onChange) {
  // defs: [{id, label, count?}] -> {bar, panels: {id: panel}, select(id)}
  const bar = el("div", { class: "tabs", role: "tablist" });
  const panels = {};
  const btns = defs.map((d, i) => {
    const b = el("button", { role: "tab", id: `tab-${d.id}`, "aria-controls": `tp-${d.id}`, "aria-selected": i === 0 ? "true" : "false", tabindex: i === 0 ? "0" : "-1" },
      d.label, d.count !== undefined ? el("span", { class: "count" }, d.count) : null);
    panels[d.id] = el("div", { role: "tabpanel", id: `tp-${d.id}`, "aria-labelledby": `tab-${d.id}`, hidden: i !== 0 });
    b.addEventListener("click", () => select(d.id));
    b.addEventListener("keydown", e => {
      const k = e.key; if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(k)) return;
      e.preventDefault();
      const j = k === "Home" ? 0 : k === "End" ? defs.length - 1 : (i + (k === "ArrowRight" ? 1 : -1) + defs.length) % defs.length;
      select(defs[j].id); btns[j].focus();
    });
    bar.append(b); return b;
  });
  function select(id) {
    defs.forEach((d, i) => { const on = d.id === id; btns[i].setAttribute("aria-selected", on); btns[i].tabIndex = on ? 0 : -1; panels[d.id].hidden = !on; });
    onChange?.(id);
  }
  return { bar, panels, select };
}

export const icon = {
  workspace: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.6"><path d="M3 7h7l2 2h9v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M3 7V5a1 1 0 0 1 1-1h5l2 2"/></svg>',
  overview: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.6"><rect x="3" y="3" width="8" height="8"/><rect x="13" y="3" width="8" height="5"/><rect x="13" y="10" width="8" height="11"/><rect x="3" y="13" width="8" height="8"/></svg>',
  visualizer: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.6"><circle cx="7" cy="8" r="2.2"/><circle cx="16" cy="6" r="2.2"/><circle cx="12" cy="15" r="2.2"/><circle cx="19" cy="17" r="1.6"/><circle cx="5" cy="18" r="1.6"/><path d="M8.8 9.4l2 3.8M14.2 7l-1.4 6M14 16l3.6.8"/></svg>',
  analysis: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.6"><path d="M3 20h18"/><path d="M4 16l4-5 4 3 4-7 4 4"/></svg>',
  parameters: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.6"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/></svg>',
  decks: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.6"><path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/><path d="M10 13h6M10 17h6"/><path d="M4 7v14h12"/></svg>',
  validation: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.6"><path d="M12 3l8 3v6c0 5-3.4 8-8 9-4.6-1-8-4-8-9V6z"/><path d="M8.5 12.5l2.4 2.4 4.8-5"/></svg>',
  studio: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.6"><rect x="3" y="4" width="18" height="13" rx="1"/><circle cx="9" cy="10" r="2"/><circle cx="14" cy="12" r="2"/><circle cx="12" cy="8" r="1.6"/><path d="M8 21h8M12 17v4"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><path d="M20 11a8 8 0 0 0-14.3-4.6M4 5v4h4M4 13a8 8 0 0 0 14.3 4.6M20 19v-4h-4"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><path d="M7 5l12 7-12 7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><path d="M8 5v14M16 5v14"/></svg>',
  prev: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><path d="M15 6l-6 6 6 6"/></svg>',
  next: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><path d="M9 6l6 6-6 6"/></svg>',
  first: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><path d="M17 6l-6 6 6 6M7 6v12"/></svg>',
  last: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><path d="M7 6l6 6-6 6M17 6v12"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.6"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.6"><path d="M3 6h6l2 2h10v11H3z"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.6"><rect x="8" y="8" width="12" height="12"/><path d="M16 8V4H4v12h4"/></svg>',
  ext: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"/></svg>',
  chev: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" width="12" height="12"><path d="M9 6l6 6-6 6"/></svg>',
  help: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.8.4-1 .9-1 1.7M12 17h0"/></svg>',
};
export const svg = (name) => { const s = document.createElement("span"); s.innerHTML = icon[name]; return s.firstElementChild; };
