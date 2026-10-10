// Analysis workspace: force/temperature series, per-frame metrics (background job), run comparison, plot gallery.
import * as api from "../api.js";
import { state } from "../state.js";
import { el, clear, num, loading, empty, errorState, tabs, toast, svg } from "../ui.js";
import { overview, enc } from "../data.js";
import { LinePlot } from "../plot.js";
import { SERIES_COLORS, COORD } from "../colormaps.js";

const LABEL = { Fc_nN: "Fc (cutting, x)", Ft_nN: "Ft (thrust, y)", Fz_nN: "Fz (lateral, z)", Twp_K: "Workpiece Newtonian", Tcz_K: "Contact zone", TwpTS_K: "Workpiece thermostat layer",
  Tct_K: "Tool Newtonian", TctTS_K: "Tool thermostat layer", Tlaser_K: "Laser zone" };

function plotPanel(title, sub, xLabel, yLabel, fileBase) {
  const host = el("div", { class: "plot" });
  const plot = new LinePlot(host, { xLabel, yLabel, title });
  const panel = el("section", { class: "panel" },
    el("div", { class: "panel-head" }, el("h3", {}, title), el("span", { class: "sub" }, sub),
      el("div", { class: "actions" },
        el("button", { class: "btn ghost", onclick: () => plot.toPNG(`${fileBase}.png`), "data-tip": "Save this plot as PNG" }, svg("download"), "PNG"),
        el("button", { class: "btn ghost", onclick: () => plot.toCSV(`${fileBase}.csv`), "data-tip": "Save the plotted data as CSV" }, svg("download"), "CSV"))),
    el("div", { class: "panel-body" }, host));
  return { panel, plot };
}

export async function render(root, { sim, navigate }) {
  if (!sim) { root.append(empty("No simulation selected", "Pick one in the top bar.")); return; }
  root.append(el("div", { class: "view-head" }, el("div", { class: "title" }, el("h1", {}, "Analysis"),
    el("p", {}, `${sim.label} · values read from the run's own output files (fix ave/time force file, dump frames). Nothing is extrapolated.`))));
  const runsWithSeries = state.sims.filter(s => s.has_series);
  const T = tabs([{ id: "series", label: "Time series" }, { id: "metrics", label: "Per-frame metrics" }, { id: "compare", label: "Run comparison", count: runsWithSeries.length }, { id: "gallery", label: "Plot gallery" }]);
  root.append(T.bar, ...Object.values(T.panels));
  const plots = [];

  // ---------------------------------------------------------------- time series
  (async () => {
    const p = T.panels.series;
    p.append(loading("Reading force / temperature file…"));
    try {
      const se = await api.get(`/api/simulations/${enc(sim.id)}/series`);
      clear(p);
      if (!se.available) { p.append(empty("No force / temperature series", se.reason + (sim.kind === "reference" ? " The original reference decks do not record tool forces." : ""))); return; }
      const x = se.cut_distance_nm || se.step, xl = se.cut_distance_nm ? "cutting distance (nm)" : "step";
      const xs = se.cut_distance_nm ? se.cut_distance_nm : se.step;
      const band = xs.length ? [xs[xs.length - 1] * 0.5, xs[xs.length - 1]] : null;
      const F = plotPanel("Forces on the tool", "time-averaged sum of per-atom forces on all tool atoms", xl, "force (nN)", `${sim.id}_forces`);
      F.plot.setData(["Fc_nN", "Ft_nN", "Fz_nN"].filter(k => se.series[k]).map(k => ({ name: LABEL[k], x, y: se.series[k] })), { band, bandLabel: "steady-state window (last 50 %)" });
      const tk = Object.keys(se.series).filter(k => k.endsWith("_K"));
      const Tp = plotPanel("Temperatures", "Twp: x-velocity excluded (temp/partial 0 1 1); tool: centre-of-mass removed", xl, "temperature (K)", `${sim.id}_temperatures`);
      Tp.plot.setData(tk.map(k => ({ name: LABEL[k] || k, x, y: se.series[k] })), { band, bandLabel: "" });
      plots.push(F.plot, Tp.plot);
      const s = se.summary || {};
      const tbody = el("tbody");
      Object.keys(se.series).forEach(k => tbody.append(el("tr", {}, el("td", {}, LABEL[k] || k), el("td", { class: "mono" }, k),
        el("td", { class: "num" }, num(s[`${k}_steady_mean`], 4)), el("td", { class: "num" }, num(s[`${k}_steady_std`], 3)), el("td", {}, k.endsWith("_nN") ? "nN" : "K"))));
      const mu = s.friction_coefficient;
      const summary = el("section", { class: "panel" },
        el("div", { class: "panel-head" }, el("h3", {}, "Steady-state summary"), el("span", { class: "sub" }, se.summary_basis || "")),
        el("div", { class: "metrics", style: { borderBottom: "1px solid var(--line)" } },
          el("div", { class: "metric" }, el("div", { class: "k" }, "Fc mean"), el("div", { class: "v" }, num(s.Fc_nN_steady_mean, 4), el("span", { class: "u" }, "nN"))),
          el("div", { class: "metric" }, el("div", { class: "k" }, "Ft mean"), el("div", { class: "v" }, num(s.Ft_nN_steady_mean, 4), el("span", { class: "u" }, "nN"))),
          el("div", { class: "metric", "data-tip": "Ratio of mean cutting to mean thrust force over the steady window. Meaningful only once the cut has reached steady state." },
            el("div", { class: "k" }, "Fc / Ft"), el("div", { class: "v" }, num(mu, 3)), el("div", { class: "d" }, "apparent friction coefficient")),
          el("div", { class: "metric" }, el("div", { class: "k" }, "rows"), el("div", { class: "v" }, num(se.step.length)), el("div", { class: "d" }, se.file))),
        el("div", { class: "table-wrap" }, el("table", { class: "data" }, el("thead", {}, el("tr", {}, el("th", {}, "Quantity"), el("th", {}, "Column"), el("th", { class: "num" }, "Mean"), el("th", { class: "num" }, "Std"), el("th", {}, "Unit"))), tbody)));
      if (xs.length && xs[xs.length - 1] < 1.5) p.append(el("div", { class: "banner warn" }, el("b", {}, "Short run: "), `only ${num(xs[xs.length - 1], 3)} nm of cutting is recorded, so the "steady-state" averages describe the initial transient, not a steady cut.`));
      p.append(el("div", { class: "grid c2" }, F.panel, Tp.panel), el("div", { style: { height: "12px" } }), summary);
    } catch (e) { clear(p).append(errorState(e)); }
  })();

  // ---------------------------------------------------------------- per-frame metrics (job)
  (() => {
    const p = T.panels.metrics;
    const out = el("div", {});
    const can = sim.kind === "run" && sim.n_frames;
    const btn = el("button", { class: "btn primary", disabled: !can || api.apiMode() !== "live" }, "Compute per-frame metrics");
    p.append(el("div", { class: "banner" }, "Reads every dump frame of the run and computes the chip / pile-up height, atoms above the surface, contact-zone temperature (centre-of-mass velocity removed) and the coordination histogram. Runs as a background job; frames are processed one at a time.", el("div", { style: { marginLeft: "auto" } }, btn)), out);
    if (!can) out.append(empty("Not available for this simulation", "Per-frame metrics need a run folder with dump frames and params.json."));
    else if (api.apiMode() !== "live") out.append(empty("Needs the Python backend", "The offline demo cannot run jobs."));
    btn.onclick = async () => {
      btn.disabled = true;
      const st = loading("Computing…", true); clear(out).append(st);
      try {
        const res = await api.job(`/api/simulations/${enc(sim.id)}/metrics`, { method: "POST", onProgress: r => st.update(r) });
        showMetrics(out, res);
      } catch (e) { clear(out).append(errorState(e)); }
      btn.disabled = false;
    };
  })();

  function showMetrics(out, res) {
    clear(out);
    const rows = res.rows;
    const x = rows.map(r => r.cut_distance_A / 10);
    const H = plotPanel("Chip / pile-up height", "max y of workpiece atoms above the undeformed surface", "cutting distance (nm)", "height (Å)", `${sim.id}_height`);
    H.plot.setData([{ name: "max height above surface", x, y: rows.map(r => r.max_height_above_surface_A), points: true }]);
    const Tz = plotPanel("Contact-zone temperature", "workpiece atoms near the moving contact point", "cutting distance (nm)", "temperature (K)", `${sim.id}_contactT`);
    Tz.plot.setData([{ name: "COM removed", x, y: rows.map(r => r.contact_zone_T_K), points: true }, { name: "mean local T", x, y: rows.map(r => r.contact_zone_T_local_mean_K), points: true, dash: [4, 3] }]);
    plots.push(H.plot, Tz.plot);
    const tbody = el("tbody");
    rows.forEach(r => {
      const cn = r.coordination || {}, tot = Object.values(cn).reduce((a, b) => a + b, 0) || 1;
      const bar = el("div", { style: { display: "flex", height: "8px", width: "160px", borderRadius: "2px", overflow: "hidden", background: "var(--bg-inset)" }, "data-tip": Object.entries(cn).map(([k, v]) => `CN ${k}: ${num(v)} (${num(100 * v / tot, 3)} %)`).join("  ·  ") },
        ...Object.entries(cn).map(([k, v]) => el("span", { style: { width: `${100 * v / tot}%`, background: COORD[Math.min(8, +k)] } })));
      tbody.append(el("tr", {}, el("td", { class: "num" }, r.index), el("td", { class: "num" }, num(r.step)), el("td", { class: "num" }, num(r.cut_distance_A / 10, 4)),
        el("td", { class: "num" }, num(r.max_height_above_surface_A, 4)), el("td", { class: "num" }, num(r.atoms_above_surface)), el("td", { class: "num" }, num(r.contact_zone_atoms)),
        el("td", { class: "num" }, num(r.contact_zone_T_K, 4)), el("td", { class: "num" }, num(r.contact_zone_T_local_mean_K, 4)), el("td", { class: "num" }, num(r.max_local_T_K, 4)), el("td", {}, bar)));
    });
    const defs = el("dl", { class: "kv" }, ...Object.entries(res.definitions).flatMap(([k, v]) => [el("dt", { class: "mono" }, k), el("dd", { style: { fontFamily: "var(--font-sans)" } }, v)]));
    out.append(el("div", { class: "grid c2" }, H.panel, Tz.panel), el("div", { style: { height: "12px" } }),
      el("section", { class: "panel" }, el("div", { class: "panel-head" }, el("h3", {}, "Per-frame values"), el("span", { class: "sub" }, `${rows.length} frames`)),
        el("div", { class: "table-wrap" }, el("table", { class: "data" }, el("thead", {}, el("tr", {}, ...["#", "step", "distance (nm)", "height (Å)", "atoms above", "zone atoms", "zone T (K)", "mean local T (K)", "max local T (K)", "coordination"].map((h, i) => el("th", { class: i < 9 ? "num" : "" }, h)))), tbody)),
        el("div", { class: "panel-body" }, el("h4", { style: { marginBottom: "6px" } }, "Definitions"), defs)));
  }

  // ---------------------------------------------------------------- comparison
  (() => {
    const p = T.panels.compare;
    if (runsWithSeries.length < 2) { p.append(empty("Comparison needs at least two runs with a force file", `${runsWithSeries.length} found.`)); return; }
    const chosen = new Set(runsWithSeries.filter(s => s.id === sim.id).map(s => s.id).concat(runsWithSeries.slice(0, 2).map(s => s.id)));
    const qty = el("select", { class: "select", "aria-label": "Quantity" }, ...["Fc_nN", "Ft_nN", "Fz_nN", "Twp_K", "Tcz_K", "Tct_K", "Tlaser_K"].map(k => el("option", { value: k }, LABEL[k] + (k.endsWith("_nN") ? " (nN)" : " (K)"))));
    const list = el("div", { class: "cmp-list" });
    runsWithSeries.forEach(s => {
      const c = el("input", { type: "checkbox", checked: chosen.has(s.id), onchange: () => { c.checked ? chosen.add(s.id) : chosen.delete(s.id); update(); } });
      list.append(el("label", { class: "check" }, c, el("span", {}, s.label, el("span", { class: "muted mono", style: { marginLeft: "6px", fontSize: "11px" } }, s.path))));
    });
    const C = plotPanel("Run comparison", "same quantity, several runs", "cutting distance (nm)", "value", "comparison");
    const params = el("div", { class: "table-wrap" });
    plots.push(C.plot);
    p.append(el("div", { class: "grid", style: { gridTemplateColumns: "minmax(260px, 320px) minmax(0, 1fr)" } },
      el("section", { class: "panel" }, el("div", { class: "panel-head" }, el("h3", {}, "Runs")), el("div", { class: "panel-body" }, el("label", { class: "field", style: { marginBottom: "10px" } }, el("span", {}, "Quantity"), qty), list)),
      el("div", { style: { display: "grid", gap: "12px" } }, C.panel, el("section", { class: "panel" }, el("div", { class: "panel-head" }, el("h3", {}, "Parameters of the compared runs"), el("span", { class: "sub" }, "from params.json")), params))));
    qty.onchange = update;
    const cache = {};
    async function update() {
      const ids = [...chosen];
      try {
        const data = await Promise.all(ids.map(id => (cache[id] ??= api.get(`/api/simulations/${enc(id)}/series`))));
        const ovs = await Promise.all(ids.map(id => overview(id)));
        C.plot.opts.yLabel = qty.value.endsWith("_nN") ? "force (nN)" : "temperature (K)";
        C.plot.setData(data.map((d, i) => ({ name: state.sims.find(s => s.id === ids[i])?.path || ids[i], x: d.cut_distance_nm || d.step, y: d.series?.[qty.value] || [], color: SERIES_COLORS[i % SERIES_COLORS.length] })).filter(s => s.y.length));
        const keys = [["depth (nm)", e => e.process.depth_nm], ["speed (m/s)", e => e.process.speed_ms], ["cut length (nm)", e => e.process.cut_length_nm], ["edge radius (nm)", e => e.tool.edge_radius_nm],
          ["T (K)", e => e.thermo.temperature_K], ["potential", e => e.potential.key], ["laser", e => e.laser?.mode], ["dt cut (fs)", e => e.thermo.cut_dt_fs]];
        clear(params).append(el("table", { class: "data" }, el("thead", {}, el("tr", {}, el("th", {}, "parameter"), ...ids.map((id, i) => el("th", {}, el("span", { class: "swatch", style: { background: SERIES_COLORS[i % 8], marginRight: "6px" } }), state.sims.find(s => s.id === id)?.path || id)))),
          el("tbody", {}, ...keys.map(([k, f]) => { const vals = ovs.map(o => o.experiment ? f(o.experiment) : null); const diff = new Set(vals.map(String)).size > 1;
            return el("tr", {}, el("td", {}, k, diff ? el("span", { class: "badge", style: { marginLeft: "6px" } }, "differs") : null), ...vals.map(v => el("td", { class: "mono" }, v ?? "—"))); }))));
      } catch (e) { toast(`Comparison failed: ${e.message}`, "err"); }
    }
    update();
  })();

  // ---------------------------------------------------------------- gallery
  (async () => {
    const p = T.panels.gallery;
    if (api.apiMode() !== "live") { p.append(empty("Figures need the Python backend", "The offline demo snapshot does not include image files.")); return; }
    try {
      const imgs = await api.get(`/api/simulations/${enc(sim.id)}/plots`);
      if (!imgs.length) { p.append(empty("No saved figures in this folder", "Figures (PNG/SVG) placed in the run folder appear here.")); return; }
      p.append(el("div", { class: "banner" }, "Existing figures saved in the run folder (generated earlier, e.g. by tools/make_sample_images.py). Shown as files; not recomputed."),
        el("div", { class: "gallery" }, ...imgs.map(f => el("figure", {}, el("a", { href: api.apiUrl(`/api/files/raw?path=${enc(f.path)}`), target: "_blank", rel: "noopener" },
          el("img", { src: api.apiUrl(`/api/files/raw?path=${enc(f.path)}`), alt: f.name, loading: "lazy" })), el("figcaption", {}, f.name, el("span", { class: "muted mono", style: { marginLeft: "8px" } }, f.path))))));
    } catch (e) { p.append(errorState(e)); }
  })();

  return () => plots.forEach(pl => pl.destroy());
}
