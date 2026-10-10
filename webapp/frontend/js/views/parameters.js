// Parameter inspection: every value with its provenance (file line / computed / editable input / missing).
// Read-only by design; edits happen as drafts on the Decks page and never touch the original files.
import * as api from "../api.js";
import { el, clear, num, provBadge, loading, empty, errorState, openSource, svg } from "../ui.js";
import { enc } from "../data.js";

export async function render(root, { sim, navigate }) {
  if (!sim) { root.append(empty("No simulation selected", "Pick one in the top bar.")); return; }
  root.append(el("div", { class: "view-head" }, el("div", { class: "title" }, el("h1", {}, "Parameters"),
    el("p", {}, `${sim.label} · every value with where it comes from. Original files are opened read-only.`)),
    el("button", { class: "btn", onclick: () => navigate("decks", sim.id), disabled: sim.kind === "reference" }, "Edit as draft on the Decks page")));
  const body = el("div", {}, loading("Parsing input decks…"));
  root.append(body);
  let data;
  try { data = await api.get(`/api/simulations/${enc(sim.id)}/parameters`); } catch (e) { clear(body).append(errorState(e)); return; }
  clear(body);

  if (data.model_job && data.model_job.status !== "done") body.append(el("div", { class: "banner" }, "The geometry model of this simulation is being computed in the background; computed atom counts appear when you reopen this page."));
  if (data.notes?.length) body.append(el("div", { class: "banner warn" }, el("b", {}, "Notes: "), data.notes.join(" · ")));
  const files = el("div", { class: "legend-row", style: { marginBottom: "12px" } }, el("span", {}, "Decks:"),
    ...Object.entries(data.files).map(([k, p]) => el("button", { class: "src-link", onclick: () => openSource(p) }, `${k}: ${p}`)));
  if (Object.keys(data.files).length) body.append(files);

  const prov = new Set(["file", "computed", "editable", "missing"]);
  const chips = el("div", { class: "chips", role: "group", "aria-label": "Filter by provenance" },
    ...["file", "computed", "editable", "missing"].map(p => el("button", { class: "chip", "aria-pressed": "true", "data-p": p }, provBadge(p), el("span", { class: "n" }, data.counts[p] || 0))));
  const search = el("input", { class: "input", placeholder: "Search parameters…", "aria-label": "Search parameters", "data-search": "" });
  body.append(el("div", { class: "param-toolbar" }, search, chips));
  const groupsBox = el("div", {});
  body.append(groupsBox);
  chips.addEventListener("click", e => {
    const b = e.target.closest(".chip"); if (!b) return;
    const p = b.dataset.p; prov.has(p) ? prov.delete(p) : prov.add(p);
    b.setAttribute("aria-pressed", String(prov.has(p))); draw();
  });
  search.addEventListener("input", draw);

  function draw() {
    clear(groupsBox);
    const q = search.value.trim().toLowerCase();
    let shown = 0;
    for (const g of data.groups) {
      const rows = g.params.filter(p => prov.has(p.provenance) && (!q || `${p.label} ${p.key} ${p.value ?? ""} ${p.raw ?? ""} ${p.note ?? ""}`.toLowerCase().includes(q)));
      if (!rows.length) continue;
      shown += rows.length;
      const tbody = el("tbody");
      rows.forEach(p => tbody.append(el("tr", {},
        el("td", { style: { width: "26%" } }, p.label, p.raw && p.provenance === "file" ? el("span", { class: "raw" }, p.raw) : null),
        el("td", { class: "mono", style: { width: "26%" } }, p.value === null || p.value === undefined ? el("span", { class: "muted" }, "—") : (typeof p.value === "number" ? num(p.value, 6) : String(p.value)),
          p.unit ? el("span", { class: "muted", style: { marginLeft: "6px", fontFamily: "var(--font-sans)" } }, p.unit) : null),
        el("td", {}, provBadge(p.provenance)),
        el("td", {}, p.source?.path ? el("button", { class: "src-link", onclick: () => openSource(p.source.path, p.source.line), "data-tip": "Open the file read-only at this line" },
          `${p.source.path.split("/").pop()}${p.source.line ? ":" + p.source.line : ""}`) : el("span", { class: "muted" }, p.provenance === "computed" ? "NanoCut" : "—")),
        el("td", { class: "muted" }, p.note || ""))));
      groupsBox.append(el("details", { class: "panel param-group", open: true },
        el("summary", { class: "panel-head" }, el("span", { class: "chev", html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="11" height="11"><path d="M9 6l6 6-6 6"/></svg>' }), el("h3", {}, g.name), el("span", { class: "sub" }, `${rows.length}`)),
        el("div", { class: "table-wrap" }, el("table", { class: "data" }, el("thead", {}, el("tr", {}, el("th", {}, "Parameter"), el("th", {}, "Value"), el("th", {}, "Provenance"), el("th", {}, "Source"), el("th", {}, "Note"))), tbody))));
    }
    if (!shown) groupsBox.append(empty("No parameters match", "Change the search text or the provenance filter."));
  }
  draw();
}
