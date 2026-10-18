// Background tasks: long OVITO jobs (research analysis, ductile–brittle, pile-up, frame statistics) keep running when
// you switch tabs — they belong to the app, not to the page that started them. A page that is opened again finds its
// task here (still running with progress, or finished with the result). A small indicator in the top bar lists them.
import { bus } from "./state.js";
import { el, clear, toast } from "./ui.js";

const tasks = new Map();

/** Start (or return the running) task `key`. fn(update) -> Promise(result); update({progress, message}). */
export function start(key, label, fn, { href = null, onDone = null } = {}) {
  const cur = tasks.get(key);
  if (cur && cur.status === "running") return cur;
  const t = { key, label, href, status: "running", progress: 0, message: "starting…", result: null, error: null, started: Date.now(), cancel: null };
  tasks.set(key, t);
  const update = rec => { t.progress = rec.progress ?? t.progress; t.message = rec.message ?? t.message; bus.emit("tasks", t); };
  t.promise = Promise.resolve().then(() => fn(update, t)).then(
    r => { t.status = "done"; t.result = r; t.progress = 1; t.finished = Date.now(); bus.emit("tasks", t); try { onDone?.(r, t); } catch (e) { console.error(e); }
      toast(`${label}: finished.`, "ok"); },
    e => { t.status = "error"; t.error = e; t.finished = Date.now(); bus.emit("tasks", t); if (!/cancel/i.test(e?.message || "")) toast(`${label}: ${e.message}`, "err", 8000); });
  bus.emit("tasks", t);
  return t;
}
export const get = key => tasks.get(key);
export const list = () => [...tasks.values()];
export const running = () => list().filter(t => t.status === "running");
export function forget(key) { tasks.delete(key); bus.emit("tasks", null); }

/** A live progress box bound to a task (re-attach after the page was rebuilt). */
export function progressBox(t, { onCancel } = {}) {
  const bar = el("div", { class: "progress" }, el("i")), msg = el("span", { class: "msg small" });
  const box = el("div", { class: "state task-box", role: "status", "aria-live": "polite" }, el("div", { class: "spinner" }), el("b", {}, t.label), bar, msg,
    onCancel ? el("button", { class: "btn ghost sm", type: "button", onclick: onCancel }, "Cancel") : null,
    el("span", { class: "muted small" }, "Runs in the background: you can switch tabs and come back."));
  const paint = () => { bar.firstChild.style.width = `${Math.round((t.progress || 0) * 100)}%`; msg.textContent = t.message || ""; };
  paint();
  const off = bus.on("tasks", x => { if (x === t) { paint(); if (t.status !== "running") off(); } });
  return box;
}

// ---------------------------------------------------------------- top-bar indicator
export function mountIndicator(host) {
  const btn = el("button", { class: "btn task-ind", type: "button", hidden: true, "aria-haspopup": "true" });
  const pop = el("div", { class: "task-pop", hidden: true, role: "dialog", "aria-label": "Background tasks" });
  host.prepend(el("div", { class: "task-wrap" }, btn, pop));
  btn.onclick = () => { pop.hidden = !pop.hidden; paint(); };
  document.addEventListener("click", e => { if (!btn.parentElement.contains(e.target)) pop.hidden = true; });
  function paint() {
    const all = list().sort((a, b) => b.started - a.started).slice(0, 12), run = running();
    btn.hidden = !all.length;
    btn.textContent = run.length ? `⏳ ${run.length} running` : `✓ ${all.length} task${all.length > 1 ? "s" : ""}`;
    btn.classList.toggle("busy", !!run.length);
    if (pop.hidden) return;
    clear(pop).append(el("b", {}, "Background tasks"), ...all.map(t => el("div", { class: "task-row" },
      el("div", {}, el("span", {}, t.label), el("span", { class: `muted small` }, t.status === "running" ? ` ${Math.round(t.progress * 100)} % · ${t.message || ""}` : t.status === "done" ? " — done" : ` — ${t.error?.message || "failed"}`)),
      t.href ? el("a", { class: "btn ghost sm", href: t.href, onclick: () => { pop.hidden = true; } }, "Open") : null)));
  }
  bus.on("tasks", paint);
}
