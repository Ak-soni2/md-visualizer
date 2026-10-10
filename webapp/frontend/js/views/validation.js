// Data integrity and validation. Keeps "could the files be parsed" separate from "are the values scientifically
// consistent", shows archived verification results, and the time of the last inspection.
import * as api from "../api.js";
import { state } from "../state.js";
import { el, clear, num, loading, empty, errorState, statusLabel, statusDot, kindBadge, when, ago, toast, svg } from "../ui.js";

export async function render(root, { sim }) {
  const runBtn = el("button", { class: "btn", disabled: api.apiMode() !== "live", "data-tip": "Re-inspect every simulation folder now (background job)" }, svg("refresh"), "Re-run inspection");
  const stamp = el("span", { class: "muted" }, "");
  root.append(el("div", { class: "view-head" }, el("div", { class: "title" }, el("h1", {}, "Validation"),
    el("p", {}, "Two separate layers: parsing (could each file be read?) and scientific validation (are the values consistent and plausible?). A file can parse perfectly and still fail a scientific check.")),
    el("div", { class: "field-row" }, stamp, runBtn)));
  const body = el("div", {});
  root.append(body);

  async function load(force) {
    const st = loading(force ? "Re-inspecting all folders…" : "Inspecting all folders…", true);
    clear(body).append(st);
    try {
      const res = await api.job(force ? "/api/validation/run" : "/api/validation", { method: force ? "POST" : "GET", onProgress: r => st.update(r) });
      show(res);
    } catch (e) { clear(body).append(errorState(e, () => load(false))); }
  }
  runBtn.onclick = () => load(true);

  function show(res) {
    clear(body);
    stamp.textContent = `last inspection ${ago(res.inspected)} (${when(res.inspected)})`;
    const sims = res.simulations;
    const tally = (layer) => sims.reduce((a, s) => { const st = s[`${layer}_summary`].state; a[st] = (a[st] || 0) + 1; return a; }, {});
    const tp = tally("parsing"), ts = tally("scientific");
    body.append(el("section", { class: "panel", style: { marginBottom: "12px" } }, el("div", { class: "metrics" },
      el("div", { class: "metric" }, el("div", { class: "k" }, "Parsing · OK"), el("div", { class: "v" }, num(tp.ok || 0)), el("div", { class: "d" }, `${tp.warn || 0} warnings · ${tp.error || 0} errors · ${tp["n/a"] || 0} n/a`)),
      el("div", { class: "metric" }, el("div", { class: "k" }, "Scientific · OK"), el("div", { class: "v" }, num(ts.ok || 0)), el("div", { class: "d" }, `${ts.warn || 0} with warnings · ${ts.error || 0} with errors`)),
      ...res.global_checks.map(g => el("div", { class: "metric", "data-tip": g.detail },
        el("div", { class: "k" }, g.name), el("div", { class: "v", style: { fontSize: "var(--fs-lg)" } }, statusLabel(g.status)), el("div", { class: "d" }, `archived ${when(g.checked)} · ${g.source}`))))));

    // global detail
    const gbox = el("div", { class: "grid c2", style: { marginBottom: "12px" } });
    res.global_checks.forEach(g => {
      const rows = g.rows || [];
      const table = rows.length && rows[0].file ? el("table", { class: "data" }, el("thead", {}, el("tr", {}, ...["file", "structure", "a₀ (Å)", "ref", "dev %", "E_coh (eV)", "ref", "dev %"].map((h, i) => el("th", { class: i > 1 ? "num" : "" }, h)))),
        el("tbody", {}, ...rows.map(r => el("tr", {}, el("td", { class: "mono" }, r.file), el("td", {}, `${r.structure} ${r.elements.join("/")}`), el("td", { class: "num" }, num(r.a0, 5)), el("td", { class: "num" }, num(r.ref_a0, 5)),
          el("td", { class: "num" }, num(r.a0_dev_pct, 3)), el("td", { class: "num" }, num(r.Ecoh, 5)), el("td", { class: "num" }, num(r.ref_Ecoh, 5)), el("td", { class: "num" }, num(r.Ecoh_dev_pct, 3))))))
        : el("table", { class: "data" }, el("thead", {}, el("tr", {}, el("th", {}, "reference case"), el("th", {}, "verdict"))), el("tbody", {}, ...rows.map(r => el("tr", {}, el("td", {}, r.case), el("td", {}, statusLabel(r.verdict === "PASS" ? "ok" : "error", r.verdict))))));
      gbox.append(el("details", { class: "panel" }, el("summary", { class: "panel-head" }, el("span", { class: "chev", html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="11" height="11"><path d="M9 6l6 6-6 6"/></svg>' }),
        el("h3", {}, g.name), el("div", { class: "actions" }, statusLabel(g.status))), el("div", { class: "panel-body" }, el("p", {}, g.detail)), el("div", { class: "table-wrap", style: { maxHeight: "320px" } }, table)));
    });
    body.append(el("h4", { style: { margin: "4px 0 8px" } }, "Archived scientific verification (scripts in tools/, rerun them to refresh)"), gbox);

    // per simulation
    const filt = { q: "", state: "all" };
    const search = el("input", { class: "input", placeholder: "Filter…", "aria-label": "Filter simulations", "data-search": "", style: { width: "200px" } });
    const stateSel = el("select", { class: "select", "aria-label": "Status filter" }, ...[["all", "all"], ["error", "with errors"], ["warn", "with warnings"], ["ok", "all OK"]].map(([v, l]) => el("option", { value: v }, l)));
    const tbody = el("tbody");
    const detail = el("div", {});
    body.append(el("section", { class: "panel" },
      el("div", { class: "panel-head" }, el("h3", {}, "Simulations"), el("span", { class: "sub" }, `${sims.length} inspected`), el("div", { class: "actions" }, search, stateSel)),
      el("div", { class: "table-wrap", style: { maxHeight: "360px" } }, el("table", { class: "data" }, el("thead", {}, el("tr", {}, el("th", {}, "Simulation"), el("th", {}, "Kind"), el("th", {}, "Parsing"), el("th", {}, "Scientific"), el("th", { class: "num" }, "Issues"))), tbody))),
      el("div", { style: { height: "12px" } }), detail);
    const worst = s => ["error", "warn", "ok", "n/a"].find(x => s.parsing_summary.state === x || s.scientific_summary.state === x);
    function fill() {
      clear(tbody);
      sims.filter(s => (!filt.q || s.label.toLowerCase().includes(filt.q)) && (filt.state === "all" || worst(s) === filt.state)).forEach(s => {
        const issues = s.parsing.concat(s.scientific).filter(c => c.status !== "ok").length;
        const tr = el("tr", { class: "selectable", tabindex: "0", "aria-selected": "false" }, el("td", {}, s.label), el("td", {}, kindBadge(s.kind)),
          el("td", {}, statusLabel(s.parsing_summary.state)), el("td", {}, statusLabel(s.scientific_summary.state)), el("td", { class: "num" }, issues || "—"));
        const pick = () => { tbody.querySelectorAll("tr").forEach(r => r.setAttribute("aria-selected", "false")); tr.setAttribute("aria-selected", "true"); showDetail(s); };
        tr.onclick = pick; tr.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } };
        tbody.append(tr);
        if (sim && s.id === sim.id) pick();
      });
    }
    search.oninput = () => { filt.q = search.value.toLowerCase(); fill(); };
    stateSel.onchange = () => { filt.state = stateSel.value; fill(); };
    function list(checks) {
      if (!checks.length) return empty("No checks apply", "e.g. presets have no files to parse.");
      return el("ul", { class: "check-list" }, ...checks.map(c => el("li", {}, statusDot(c.status), el("div", {}, el("div", { class: "n" }, c.name), el("div", { class: "d" }, c.detail)))));
    }
    function showDetail(s) {
      clear(detail).append(el("section", { class: "panel" }, el("div", { class: "panel-head" }, el("h3", {}, s.label), kindBadge(s.kind), el("span", { class: "sub" }, `inspected ${when(s.inspected)}`)),
        el("div", { class: "panel-body val-detail" },
          el("div", {}, el("h4", { style: { marginBottom: "6px" } }, "Parsing"), list(s.parsing)),
          el("div", {}, el("h4", { style: { marginBottom: "6px" } }, "Scientific validation"), list(s.scientific)))));
    }
    fill();
    if (!detail.firstChild && sims.length) detail.append(empty("Select a simulation", "Its parsing and scientific checks appear here."));
  }
  load(false);
}
