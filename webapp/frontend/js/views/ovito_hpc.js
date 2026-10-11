// OVITO page: connect to an HPC cluster over SSH and open a trajectory that stays on the cluster.
// The password / key goes to the local backend once, to open the connection; it is not stored anywhere (not in this
// browser either). Frames are fetched from the cluster when OVITO needs them (backend/app/remote.py).
import * as api from "../api.js";
import { el, clear, num, bytes, toast, loading } from "../ui.js";

async function call(method, path, data) {
  const r = await fetch(api.apiUrl(path), { method, headers: { "Content-Type": "application/json" }, body: data ? JSON.stringify(data) : undefined });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) { const d = body.detail, e = new Error(typeof d === "string" ? d : d?.error || r.statusText); e.status = r.status; e.detail = d; throw e; }
  return body;
}
const row = (label, ...c) => el("label", { class: "frow" }, el("span", {}, label), el("div", { class: "fctl" }, ...c));

/** onOpen({remote, dir, pattern}, label) opens the chosen sequence in OVITO. */
export function openHpc(onOpen) {
  const body = el("div", { class: "panel-body grid1", style: { maxHeight: "75vh", overflow: "auto" } });
  const back = el("div", { class: "modal-backdrop open", role: "dialog", "aria-modal": "true", "aria-label": "HPC connection" },
    el("div", { class: "modal wide" }, el("div", { class: "panel-head" }, el("h3", {}, "HPC cluster (SSH / SFTP)"),
      el("span", { class: "sub" }, "dumps stay on the cluster; OVITO fetches the frames it needs"),
      el("div", { class: "actions" }, el("button", { class: "btn", type: "button", onclick: () => back.remove() }, "Close"))), body));
  document.body.append(back);
  start();

  async function start() {
    clear(body).append(loading("Checking open connections…"));
    let open = [];
    try { open = await call("GET", "/api/remote/sessions"); } catch { /* none */ }
    clear(body);
    if (open.length) body.append(el("section", { class: "st-sec" }, el("h4", {}, "Open connections"),
      ...open.map(s => el("div", { class: "field-row" }, el("b", { class: "mono" }, `${s.user}@${s.host}:${s.port}`),
        el("button", { class: "btn primary", type: "button", onclick: () => browse(s, s.home) }, "Browse"),
        el("button", { class: "btn ghost", type: "button", onclick: async () => { await call("POST", `/api/remote/${s.id}/disconnect`); toast("Disconnected; the local frame cache was deleted.", "ok"); start(); } }, "Disconnect")))));
    form();
  }

  function form() {
    const f = { host: el("input", { class: "input mono", type: "text", placeholder: "hpc.example.ac.in or 10.0.0.5", autocomplete: "off" }),
      port: el("input", { class: "input num", type: "number", value: 22, min: 1, max: 65535 }),
      user: el("input", { class: "input mono", type: "text", placeholder: "username", autocomplete: "username" }),
      pass: el("input", { class: "input", type: "password", autocomplete: "current-password", placeholder: "password" }),
      otp: el("input", { class: "input mono", type: "text", autocomplete: "one-time-code", placeholder: "only if the cluster asks for a one-time code" }),
      key: el("textarea", { class: "input mono", rows: 4, placeholder: "-----BEGIN OPENSSH PRIVATE KEY----- … (optional, instead of the password)" }),
      phrase: el("input", { class: "input", type: "password", placeholder: "key passphrase (if any)" }) };
    const msg = el("div", {}), btn = el("button", { class: "btn primary", type: "button" }, "Connect");
    const go = async trust => {
      btn.disabled = true; clear(msg).append(loading(`Connecting to ${f.host.value}…`));
      const data = { host: f.host.value.trim(), port: +f.port.value || 22, username: f.user.value.trim(), password: f.pass.value, otp: f.otp.value.trim() || undefined,
        private_key: f.key.value.trim() || undefined, passphrase: f.phrase.value || undefined, trust_fingerprint: trust };
      try {
        const s = await call("POST", "/api/remote/connect", data);
        f.pass.value = f.otp.value = f.key.value = f.phrase.value = "";        // not kept in the page either
        toast(`Connected to ${s.user}@${s.host}.`, "ok");
        browse(s, s.home);
      } catch (e) {
        clear(msg);
        if (e.status === 409 && e.detail?.fingerprint && !e.detail.changed) {
          msg.append(el("div", { class: "banner warn" }, el("b", {}, "First connection to this host. "),
            `Its ${e.detail.key_type} key fingerprint is `, el("code", {}, e.detail.fingerprint),
            el("br"), "Compare it with the fingerprint your HPC centre publishes (or that ", el("code", {}, `ssh-keyscan ${data.host} | ssh-keygen -lf -`), " prints on a trusted machine) before trusting it."),
            el("button", { class: "btn primary", type: "button", onclick: () => go(e.detail.fingerprint) }, "The fingerprint matches: trust and connect"));
        } else msg.append(el("div", { class: "banner err" }, e.message));
      } finally { btn.disabled = false; }
    };
    btn.onclick = () => {
      if (!f.host.value.trim() || !f.user.value.trim()) { toast("Host and username are required.", "warn"); return; }
      go(undefined);
    };
    body.append(el("section", { class: "st-sec" }, el("h4", {}, "New connection"),
      row("Host / IP", f.host), row("Port", f.port), row("Username", f.user), row("Password", f.pass), row("One-time code", f.otp),
      el("details", {}, el("summary", { class: "muted" }, "Use a private key instead"), row("Private key", f.key), row("Passphrase", f.phrase)),
      el("p", { class: "muted small" }, "The password or key is sent to this computer's backend only, used once to open the SSH connection, and never stored or logged. Works with the local backend (webapp\\run_web.bat), not the hosted site."),
      el("div", { class: "field-row" }, btn), msg));
    f.host.focus();
  }

  async function browse(s, path) {
    clear(body).append(loading(`Listing ${path} on ${s.host}…`));
    let L;
    try { L = await call("GET", `/api/remote/${s.id}/list?path=${encodeURIComponent(path)}`); }
    catch (e) { clear(body).append(el("div", { class: "banner err" }, e.message), el("button", { class: "btn", type: "button", onclick: start }, "Back")); return; }
    const pathIn = el("input", { class: "input mono", type: "text", value: L.path, "aria-label": "Remote folder", onkeydown: e => { if (e.key === "Enter") browse(s, pathIn.value); } });
    clear(body).append(
      el("div", { class: "field-row" }, el("b", { class: "mono" }, `${s.user}@${s.host}`), pathIn,
        el("button", { class: "btn", type: "button", onclick: () => browse(s, pathIn.value) }, "Go"),
        el("button", { class: "btn", type: "button", onclick: () => browse(s, L.parent) }, "Up"),
        el("button", { class: "btn ghost", type: "button", onclick: start }, "Connections")),
      el("section", { class: "st-sec" }, el("h4", {}, L.sequences.length ? "LAMMPS dumps in this folder" : "No LAMMPS dumps in this folder"),
        ...L.sequences.map(q => el("div", { class: "field-row" },
          el("button", { class: "btn primary", type: "button", onclick: () => { back.remove(); onOpen({ remote: s.id, dir: L.path, pattern: q.pattern }, `${s.user}@${s.host}:${L.path}/${q.pattern}`); } }, "Open in OVITO"),
          el("span", { class: "mono" }, q.pattern), el("span", { class: "muted small" }, `${num(q.count)} file${q.count > 1 ? "s" : ""} · ${bytes(q.bytes)}`)))),
      el("section", { class: "st-sec" }, el("h4", {}, "Folders"),
        el("div", { class: "chips" }, L.entries.filter(e => e.dir).slice(0, 400).map(e => el("button", { class: "chip", type: "button", onclick: () => browse(s, `${L.path.replace(/\/$/, "")}/${e.name}`) }, `${e.name}/`)))),
      el("p", { class: "muted small" }, `${num(L.entries.filter(e => !e.dir).length)} files here. Each frame is downloaded only when OVITO computes it (a few frames are cached locally and replaced as you move on); nothing is changed on the cluster.`));
  }
}
