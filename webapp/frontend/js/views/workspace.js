// Workspace: project explorer (verified directory tree), simulation catalogue, selected simulation's files.
import * as api from "../api.js";
import { state, bus } from "../state.js";
import { el, clear, bytes, num, originBadge, kindBadge, loading, empty, errorState, openSource, svg, when } from "../ui.js";
import { overview, enc } from "../data.js";

const ROLE_LABEL = { deck_A: "Deck A", deck_B: "Deck B", dump: "Dump", forces: "Forces", params: "Params", restart: "Restart", log: "Log", image: "Image", potential: "Potential", readme: "Readme", script: "Script", other: "Other" };
const TEXT_ROLES = new Set(["deck_A", "deck_B", "forces", "params", "log", "potential", "readme", "script"]);

export async function render(root, { navigate }) {
  root.append(
    el("div", { class: "view-head" },
      el("div", { class: "title" }, el("h1", {}, "Workspace"),
        el("p", {}, "Project folders as they are on disk. Original files (reference decks, LAMMPS potentials) are only ever read; generated files come from NanoCut or from runs of its decks."))),
    el("div", { class: "legend-row", style: { marginBottom: "12px" } },
      originBadge("original"), "files you or LAMMPS provided, never modified",
      originBadge("generated"), "written by NanoCut or a run",
      el("span", { class: "badge preset" }, "Preset"), "built-in configuration, no files")
  );
  const ws = el("div", { class: "ws" });
  root.append(ws);

  // ---------------------------------------------------------------- tree
  const treeBody = el("div", { class: "panel-body" }, loading("Scanning project…"));
  const treeFilter = el("input", { class: "input", placeholder: "Filter files…", "aria-label": "Filter the project tree", style: { width: "100%" } });
  ws.append(el("section", { class: "panel tree-panel", "aria-label": "Project explorer" },
    el("div", { class: "panel-head" }, el("h3", {}, "Project explorer"), el("span", { class: "sub" }, "verified on disk")),
    el("div", { class: "panel-body", style: { paddingBottom: 0 } }, treeFilter), treeBody));

  async function loadTree() {
    try {
      const t = await api.get("/api/tree?depth=2");
      const ul = el("ul", { class: "tree", role: "tree", "aria-label": "Project files" });
      ul.append(treeNode(t, 0, true));
      clear(treeBody).append(ul);
      if (state.sims.some(s => s.kind === "reference")) {
        const ref = state.sims.find(s => s.kind === "reference");
        const refRoot = ref.path.split("/").slice(0, -1).join("/");
        const rt = await api.get(`/api/tree?path=${enc(refRoot)}&depth=1`);
        const ul2 = el("ul", { class: "tree", role: "tree", "aria-label": "Reference decks", style: { marginTop: "10px" } });
        ul2.append(treeNode(rt, 0, false, refRoot));
        treeBody.append(el("h4", { style: { margin: "14px 0 4px" } }, "Reference decks (external, read-only)"), ul2);
      }
    } catch (e) { clear(treeBody).append(errorState(e, loadTree)); }
  }

  function treeNode(n, depth, open, label) {
    const li = el("li", { role: "treeitem", "aria-expanded": n.type === "dir" ? String(!!open) : null, "data-name": (n.name || "").toLowerCase() });
    const isDir = n.type === "dir";
    const meta = isDir ? (n.count !== undefined ? `${n.count}` : "") : bytes(n.bytes);
    const row = el("div", { class: `node o-${n.origin}`, tabindex: "0", "data-tip": `${n.path} · ${n.origin}` },
      el("span", { class: "twisty" }, isDir ? "▸" : ""), svg(isDir ? "folder" : "file"),
      el("span", { class: "name" }, label || n.name), el("span", { class: "meta" }, meta));
    li.append(row);
    let kids = null;
    const expand = async () => {
      if (!isDir) return;
      const ex = li.getAttribute("aria-expanded") === "true";
      if (!ex && !kids && (n.truncated || !n.children)) {
        try { const sub = await api.get(`/api/tree?path=${enc(n.path)}&depth=1`); n.children = sub.children || []; n.more = sub.more; }
        catch (e) { n.children = []; }
      }
      if (!kids) {
        kids = el("ul", { role: "group" });
        (n.children || []).forEach(c => kids.append(treeNode(c, depth + 1, false)));
        if (n.more) kids.append(el("li", {}, el("div", { class: "node muted" }, `… ${n.more} more`)));
        li.append(kids);
      }
      li.setAttribute("aria-expanded", String(!ex));
    };
    row.addEventListener("click", () => {
      if (isDir) return expand();
      if (TEXT_ROLES.has(n.role) || /\.(md|json|txt|in|py)$/i.test(n.name)) openSource(n.path);
      else if (n.role === "image") window.open(api.apiUrl(`/api/files/raw?path=${enc(n.path)}`), "_blank", "noopener");
    });
    row.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); row.click(); }
      if (e.key === "ArrowRight" && isDir && li.getAttribute("aria-expanded") === "false") expand();
      if (e.key === "ArrowLeft" && isDir && li.getAttribute("aria-expanded") === "true") li.setAttribute("aria-expanded", "false");
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const all = [...treeBody.querySelectorAll(".node")].filter(x => x.offsetParent);
        const i = all.indexOf(row); all[Math.max(0, Math.min(all.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
      }
    });
    if (open && isDir) { kids = el("ul", { role: "group" }); (n.children || []).forEach(c => kids.append(treeNode(c, depth + 1, false))); if (n.more) kids.append(el("li", {}, el("div", { class: "node muted" }, `… ${n.more} more`))); li.append(kids); }
    return li;
  }
  treeFilter.addEventListener("input", () => {
    const q = treeFilter.value.trim().toLowerCase();
    treeBody.querySelectorAll("li[role=treeitem]").forEach(li => {
      const hit = !q || li.dataset.name.includes(q) || li.querySelector(`li[data-name*="${CSS.escape(q)}"]`);
      li.style.display = hit ? "" : "none";
      if (q && hit && li.getAttribute("aria-expanded") === "false" && li.querySelector("ul")) li.setAttribute("aria-expanded", "true");
    });
  });

  // ---------------------------------------------------------------- catalogue
  const right = el("div", { class: "ws-right" });
  ws.append(right);
  const filters = { kind: "all", q: "" };
  const counts = k => state.sims.filter(s => k === "all" || s.kind === k).length;
  const chipDefs = [["all", "All"], ["run", "Run folders"], ["reference", "Reference decks"], ["preset", "Presets"]];
  const chips = el("div", { class: "chips", role: "group", "aria-label": "Filter by kind" },
    chipDefs.map(([k, l]) => el("button", { class: "chip", "aria-pressed": String(k === "all"), "data-k": k }, l, el("span", { class: "n" }, counts(k)))));
  const search = el("input", { class: "input", placeholder: "Search simulations…", "aria-label": "Search simulations", "data-search": "", style: { width: "220px" } });
  const tbody = el("tbody");
  right.append(el("section", { class: "panel", "aria-label": "Simulations" },
    el("div", { class: "panel-head" }, el("h3", {}, "Simulations"), el("span", { class: "sub" }, `${state.sims.length} found`), el("div", { class: "actions" }, search)),
    el("div", { class: "panel-body" }, chips),
    el("div", { class: "table-wrap", style: { maxHeight: "340px" } },
      el("table", { class: "data" }, el("thead", {}, el("tr", {}, el("th", {}, "Name"), el("th", {}, "Kind"), el("th", {}, "Origin"), el("th", { class: "num" }, "Frames"), el("th", {}, "Series"), el("th", { class: "num" }, "Files"), el("th", {}, "Location"))), tbody))));
  chips.addEventListener("click", e => {
    const b = e.target.closest(".chip"); if (!b) return;
    filters.kind = b.dataset.k; chips.querySelectorAll(".chip").forEach(c => c.setAttribute("aria-pressed", String(c === b))); fillTable();
  });
  search.addEventListener("input", () => { filters.q = search.value.toLowerCase(); fillTable(); });

  function fillTable() {
    clear(tbody);
    const rows = state.sims.filter(s => (filters.kind === "all" || s.kind === filters.kind) && (!filters.q || `${s.label} ${s.path || ""}`.toLowerCase().includes(filters.q)));
    if (!rows.length) { tbody.append(el("tr", {}, el("td", { colspan: 7 }, empty("No simulations match", "Change the filter or rescan the folders.")))); return; }
    rows.forEach(s => {
      const tr = el("tr", { class: "selectable", tabindex: "0", "data-id": s.id, "aria-selected": String(s.id === state.simId) },
        el("td", {}, s.label, s.experiment_name ? el("span", { class: "raw" }, s.experiment_name) : null), el("td", {}, kindBadge(s.kind)), el("td", {}, originBadge(s.origin)),
        el("td", { class: "num" }, s.n_frames || "—"), el("td", {}, s.has_series ? "yes" : el("span", { class: "muted" }, "—")),
        el("td", { class: "num" }, s.n_files || "—"), el("td", { class: "mono muted" }, s.path || "nanocut/presets.py"));
      const pick = () => { state.select(s.id); };
      tr.addEventListener("click", pick);
      tr.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
      tbody.append(tr);
    });
  }

  // ---------------------------------------------------------------- selected simulation
  const detail = el("section", { class: "panel", "aria-label": "Selected simulation", "aria-live": "polite" });
  right.append(detail);
  async function showDetail() {
    const s = state.sim();
    tbody.querySelectorAll("tr").forEach(tr => tr.setAttribute("aria-selected", "false"));
    tbody.querySelector(`tr[data-id="${CSS.escape(s?.id || "")}"]`)?.setAttribute("aria-selected", "true");
    clear(detail);
    if (!s) { detail.append(empty("No simulation selected")); return; }
    const head = el("div", { class: "panel-head" }, el("h3", {}, s.label), kindBadge(s.kind), originBadge(s.origin),
      el("div", { class: "actions" },
        el("button", { class: "btn", onclick: () => navigate("overview", s.id) }, "Overview"),
        el("button", { class: "btn", onclick: () => navigate("visualizer", s.id) }, "Visualize"),
        el("button", { class: "btn", onclick: () => navigate("analysis", s.id), disabled: !s.has_series && !s.n_frames }, "Analyse"),
        el("button", { class: "btn", onclick: () => navigate("parameters", s.id) }, "Parameters")));
    const body = el("div", { class: "panel-body" }, loading("Reading metadata…"));
    detail.append(head, body);
    try {
      const ov = await overview(s.id);
      const files = ov.sim.files || [];
      const kv = el("dl", { class: "kv" },
        el("dt", {}, "Location"), el("dd", {}, s.path || "built-in preset (nanocut/presets.py)"),
        el("dt", {}, "Note"), el("dd", { style: { fontFamily: "var(--font-sans)" } }, s.note || "—"),
        el("dt", {}, "Trajectory"), el("dd", {}, ov.trajectory?.natoms ? `${s.n_frames} frames · ${num(ov.trajectory.natoms)} atoms · ${bytes(ov.trajectory.total_bytes)}` : el("span", { class: "muted" }, "no dump files")),
        el("dt", {}, "Missing"), el("dd", {}, ov.missing?.length ? ov.missing.join(", ") : "—"));
      const byRole = {};
      files.forEach(f => (byRole[f.role] ??= []).push(f));
      const list = el("div", { class: "files-list" });
      const order = ["deck_A", "deck_B", "params", "forces", "log", "image", "potential", "readme", "script", "restart", "dump", "other"];
      for (const r of order) {
        const fs = byRole[r]; if (!fs) continue;
        const shown = r === "dump" ? [fs[0], ...(fs.length > 2 ? [] : fs.slice(1))] : fs;
        shown.forEach(f => list.append(el("div", { class: "file-row" },
          el("span", { class: "role" }, ROLE_LABEL[r]),
          TEXT_ROLES.has(r) ? el("button", { class: "src-link fname", onclick: () => openSource(f.path), "data-tip": "Open read-only" }, f.name)
            : r === "image" ? el("a", { class: "fname", href: api.apiUrl(`/api/files/raw?path=${enc(f.path)}`), target: "_blank", rel: "noopener" }, f.name)
              : el("span", { class: "fname" }, f.name),
          el("span", { class: "size" }, bytes(f.bytes)), originBadge(f.origin))));
        if (r === "dump" && fs.length > 2) list.append(el("div", { class: "file-row" }, el("span", { class: "role" }), el("span", { class: "muted" }, `… ${fs.length - 1} more dump frames (${bytes(fs.reduce((a, f) => a + f.bytes, 0))} in total)`), el("span"), el("span")));
      }
      clear(body).append(kv, el("h4", { style: { margin: "16px 0 6px" } }, `Files (${files.length})`), files.length ? list : empty("No files", "Presets are configurations only; generate decks on the Decks page."));
    } catch (e) { clear(body).append(errorState(e, showDetail)); }
  }

  fillTable(); showDetail(); loadTree();
  const offSim = bus.on("sim", showDetail);
  const offSims = bus.on("sims", () => { fillTable(); });
  return () => { offSim(); offSims(); };
}
