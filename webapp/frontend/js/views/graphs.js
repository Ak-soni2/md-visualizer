// Graph Studio (PLAN_PHASE3.md §4): plot any analysed quantity against any other, distributions, profiles, maps,
// correlations and across-run comparisons; style every detail; export PNG, JPEG, TIFF, WebP, SVG, PDF, EPS, PS one
// by one or everything as a ZIP. Figures are drawn by matplotlib on the backend from one JSON spec, so the preview is
// exactly the exported file.
import * as api from "../api.js";
import { bus } from "../state.js";
import { el, clear, num, toast, loading, download } from "../ui.js";
import * as store from "../research_store.js";
import { scalarsCsv } from "./ovito_research.js";
import * as tasks from "../tasks.js";
import { startResearch } from "../autoresearch.js";

const KEY = "nanocut.graphs.v1";
const FORMATS = [["png", "PNG"], ["jpg", "JPEG"], ["tiff", "TIFF"], ["webp", "WebP"], ["svg", "SVG"], ["pdf", "PDF"], ["eps", "EPS"], ["ps", "PS"]];
const KINDS = [["series", "Series: quantities vs distance / time / any X"], ["scatter", "Correlation: Y vs X with fit"], ["corrmatrix", "Correlation matrix"],
  ["curve", "Distribution / profile (RDF, bond angle, CN, histogram, depth profile)"], ["map", "2-D map (x–y)"], ["stack", "Stacked fractions (structure, CN)"],
  ["bar", "Bar: one quantity across regions"], ["across", "Across runs: steady-state value vs run parameter"]];
const STYLE_FIELDS = [
  ["Text", [["title", "Title", "text"], ["xlabel", "X label (empty = automatic)", "text"], ["ylabel", "Y label (empty = automatic)", "text"], ["y2label", "Right Y label", "text"],
    ["annotation", "Annotation (bottom right)", "text"], ["font_family", "Font", "select", [["sans", "Sans (Arial/Helvetica)"], ["serif", "Serif (Times)"], ["times", "Times New Roman"], ["arial", "Arial"], ["calibri", "Calibri"], ["cambria", "Cambria"], ["dejavu", "DejaVu Sans"], ["mono", "Monospace"]]],
    ["font_size", "Font size (pt)", "number"], ["title_size", "Title size (pt, empty = auto)", "number"], ["title_bold", "Bold title", "bool"], ["tick_size", "Tick label size (pt)", "number"], ["legend_size", "Legend size (pt)", "number"]]],
  ["Grid and axes", [["grid_major", "Major grid", "bool"], ["grid_minor", "Minor grid", "bool"], ["grid_style", "Grid line", "select", [["-", "solid"], ["--", "dashed"], [":", "dotted"], ["-.", "dash-dot"]]],
    ["grid_alpha", "Grid opacity (0–1)", "number"], ["grid_width", "Grid width", "number"], ["minor_ticks", "Minor ticks", "bool"], ["tick_dir", "Tick direction", "select", [["in", "in"], ["out", "out"], ["inout", "both"]]],
    ["ticks_all_sides", "Ticks on all sides", "bool"], ["frame", "Axes frame", "select", [["box", "full box"], ["open", "open (L)"]]], ["axis_width", "Axis line width", "number"],
    ["xlim", "X range (min, max)", "range"], ["ylim", "Y range (min, max)", "range"], ["y2lim", "Right Y range", "range"], ["logx", "Log X", "bool"], ["logy", "Log Y", "bool"],
    ["invert_x", "Invert X", "bool"], ["invert_y", "Invert Y", "bool"]]],
  ["Lines and legend", [["palette", "Colours", "select", [["default", "default"], ["okabe-ito", "colour-blind safe (Okabe–Ito)"], ["tableau", "Tableau 10"], ["grayscale", "greyscale"], ["viridis", "viridis"]]],
    ["line_width", "Line width", "number"], ["marker_size", "Marker size", "number"], ["legend", "Legend", "bool"],
    ["legend_loc", "Legend position", "select", ["best", "upper right", "upper left", "lower left", "lower right", "center right", "center left", "lower center", "upper center", "center"].map(v => [v, v])],
    ["legend_frame", "Legend frame", "bool"], ["legend_cols", "Legend columns", "number"]]],
  ["Maps", [["cmap", "Colormap", "select", ["viridis", "plasma", "inferno", "magma", "cividis", "jet", "turbo", "coolwarm", "RdBu_r", "seismic", "hot", "Greys", "Blues", "Reds"].map(v => [v, v])],
    ["clim", "Colour range (min, max)", "range"], ["cbar_label", "Colour-bar label", "text"], ["show_values", "Values in matrix cells", "bool"]]],
  ["Size and output", [["width_mm", "Width (mm)", "number"], ["height_mm", "Height (mm)", "number"], ["dpi", "Resolution (DPI)", "select", [[150, "150"], [300, "300"], [600, "600"], [1200, "1200"]]],
    ["background", "Background", "select", [["white", "white"], ["transparent", "transparent"], ["#f7f7f7", "light grey"]]]]],
];
const SIZE_PRESETS = [["90 × 70 mm (single column)", 90, 70], ["140 × 100 mm", 140, 100], ["190 × 120 mm (double column)", 190, 120], ["160 × 160 mm (square)", 160, 160]];
const XPREF = ["cut_distance_nm", "cut_distance", "time_ps", "step", "frame"];

let G = loadState();
function loadState() {
  try { const s = JSON.parse(localStorage.getItem(KEY) || "null"); if (s?.figs) return { formats: ["png", "svg", "pdf"], includeData: true, ...s }; } catch { /* storage off */ }
  return { figs: [], cur: null, formats: ["png", "svg", "pdf"], includeData: true };
}
function persist() { try { localStorage.setItem(KEY, JSON.stringify(G)); } catch { /* full or blocked: figures stay for the session */ } }
const uid = () => Math.random().toString(36).slice(2, 9);

// ---------------------------------------------------------------------------------------------- data helpers
const meta = (d, k) => d?.keys.find(x => x.key === k) || { key: k, label: k, unit: "" };
const withUnit = m => (m.unit ? `${m.label} (${m.unit})` : m.label);
const shortLabel = m => m.label;
function dsOf(f) { const all = store.list(); const ds = (f.ds || []).map(store.byId).filter(Boolean); return ds.length ? ds : [all.find(d => d.kind === "research") || all[0]].filter(Boolean); }
function defaultX(d) { if (!d) return "frame"; for (const k of XPREF) if (d.keys.some(x => x.key === k) && d.series(k).some(Number.isFinite)) return k; return d.keys[0]?.key; }
function stdKey(k) { return k.replace(".mean_GPa@", ".std_GPa@").replace(/\.mean@/, ".std@").replace(/ mean( \(type \d+\))?$/, " std$1"); }
function steadyMask(d, from) {
  const xd = d.kind === "research" ? d.series("cut_distance") : null;
  const x = xd && xd.some(Number.isFinite) ? xd : d.frames();
  const lo = Math.min(...x.filter(Number.isFinite)), hi = Math.max(...x.filter(Number.isFinite));
  return x.map(v => Number.isFinite(v) && v >= lo + (from ?? 0.5) * (hi - lo));
}
const mean = a => { const v = a.filter(Number.isFinite); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN; };
const std = a => { const v = a.filter(Number.isFinite), m = mean(v); return v.length ? Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / v.length) : NaN; };
function pearson(a, b) {
  const p = a.map((x, i) => [x, b[i]]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (p.length < 3) return null;
  const mx = mean(p.map(q => q[0])), my = mean(p.map(q => q[1]));
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of p) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}
const clean = a => a.map(v => (Number.isFinite(v) ? v : null));
function pickFrames(d, how) {
  const fr = d.frames();
  if (!fr.length) return [];
  if (how === "all") return fr;
  if (how === "fml") return [...new Set([fr[0], fr[Math.floor((fr.length - 1) / 2)], fr[fr.length - 1]])];
  if (how === "first") return [fr[0]];
  if (how === "last") return [fr[fr.length - 1]];
  return String(how).split(/[\s,;]+/).map(Number).filter(v => fr.includes(v));
}
function frameName(d, f) { const r = d.rows?.find(x => x.frame === f); const c = r?.scalars?.cut_distance_nm; return c != null ? `frame ${f} (${c.toFixed(2)} nm)` : `frame ${f}`; }

/** Figure (editor state) -> server spec with the numbers. */
function buildSpec(f) {
  const ds = dsOf(f), d = ds[0];
  const st = { ...(f.style || {}) };
  const spec = { name: f.name, kind: f.kind, style: st, smooth: f.smooth || 0, fit: { type: f.fit || "none", show_eq: true } };
  const auto = (k, v) => { if (!st[k]) st[k] = v; };
  if (!d) return { ...spec, series: [] };
  if (f.kind === "series" || f.kind === "scatter") {
    const ys = f.kind === "scatter" ? (f.ys || []).slice(0, 1) : f.ys || [];
    spec.series = ds.flatMap(dd => ys.map(y => {
      const m = meta(dd, y.key), name = ds.length > 1 ? `${dd.label} · ${shortLabel(m)}` : shortLabel(m);
      const se = { name, x: clean(dd.series(f.x)), y: clean(dd.series(y.key)), axis: y.axis || "left" };
      if (y.err && dd.keys.some(k => k.key === stdKey(y.key))) se.yerr = clean(dd.series(stdKey(y.key)));
      if (f.kind === "scatter") { se.type = "scatter"; se.show_markers = true; se.show_line = false; }
      else if (f.markers) se.show_markers = true;
      return se;
    }));
    auto("xlabel", withUnit(meta(d, f.x)));
    const left = ys.filter(y => y.axis !== "right"), right = ys.filter(y => y.axis === "right");
    if (left.length) auto("ylabel", left.length === 1 ? withUnit(meta(d, left[0].key)) : [...new Set(left.map(y => meta(d, y.key).unit))].filter(Boolean).join(", ") || "value");
    if (right.length) auto("y2label", withUnit(meta(d, right[0].key)));
    if (f.band?.on && f.kind === "series") {
      const xs = clean(d.series(f.x)).filter(v => v != null);
      if (xs.length) { const lo = Math.min(...xs), hi = Math.max(...xs); spec.band = [lo + (f.band.from ?? 0.5) * (hi - lo), hi]; spec.band_label = "steady state"; }
    }
    spec.legend_single = f.kind === "series" && ds.length > 1;
  } else if (f.kind === "corrmatrix") {
    const keys = (f.keys || []).filter(k => d.keys.some(x => x.key === k));
    const cols = keys.map(k => d.series(k));
    spec.matrix = { labels: keys.map(k => shortLabel(meta(d, k))), values: cols.map(a => cols.map(b => pearson(a, b))) };
  } else if (f.kind === "curve") {
    const c = f.curve || {};
    const name = c.name;
    spec.series = [];
    for (const dd of ds) for (const fr of pickFrames(dd, c.frames || "fml")) {
      const cv = dd.rows?.find(r => r.frame === fr)?.curves?.[name];
      if (!cv) continue;
      const names = c.series === "*" ? Object.keys(cv.series) : [c.series && cv.series[c.series] ? c.series : Object.keys(cv.series)[0]];
      for (const sn of names) {
        const nm = [ds.length > 1 ? dd.label : null, frameName(dd, fr), names.length > 1 || c.series === "*" ? sn : null].filter(Boolean).join(" · ");
        spec.series.push({ name: nm, x: cv.x, y: cv.series[sn], type: cv.kind === "bar" ? "bar" : "line" });
        auto("xlabel", cv.xlabel); auto("ylabel", cv.ylabel);
      }
    }
    spec.legend_single = true;
  } else if (f.kind === "map") {
    const m = f.map || {};
    const row = d.rows?.find(r => r.frame === +m.frame) || d.rows?.[d.rows.length - 1];
    const mp = row?.maps?.[m.q];
    if (mp) { spec.kind = "heatmap"; spec.map = mp; auto("xlabel", "x (Å)"); auto("ylabel", "y (Å)"); auto("cbar_label", mp.label); auto("title", `${mp.label} · ${frameName(d, row.frame)}`); }
    else spec.kind = "line", spec.series = [];
  } else if (f.kind === "stack") {
    const s = f.stack || {};
    const keys = d.keys.filter(k => k.key.startsWith(s.prefix || "struct_frac_") && k.region === (s.region || "workpiece")).map(k => k.key);
    spec.series = keys.map(k => ({ name: meta(d, k).quantity.replace(/^struct_frac_|^cn_frac_/, s.prefix === "cn_frac_" ? "CN " : "").replace(/_/g, " ").replace("ge9", "≥ 9"), x: clean(d.series(f.x)), y: clean(d.series(k)), type: "stack" }));
    auto("xlabel", withUnit(meta(d, f.x))); auto("ylabel", "fraction of atoms");
    spec.legend_single = true;
  } else if (f.kind === "bar") {
    const b = f.bar || {};
    const regs = Object.keys(d.regions || {}).filter(r => d.keys.some(k => k.key === `${b.q}@${r}`));
    const pick = b.regions?.length ? regs.filter(r => b.regions.includes(r)) : regs;
    const mask = steadyMask(d, b.from);
    const val = r => (b.frame === "steady" ? mean(d.series(`${b.q}@${r}`).filter((_, i) => mask[i])) : d.series(`${b.q}@${r}`)[d.frames().indexOf(+b.frame)] ?? d.series(`${b.q}@${r}`).slice(-1)[0]);
    const err = r => (b.frame === "steady" ? std(d.series(`${b.q}@${r}`).filter((_, i) => mask[i])) : null);
    spec.kind = "bar";
    spec.series = [{ name: shortLabel(meta(d, `${b.q}@${pick[0]}`)).replace(/ \(.*\)$/, ""), x: pick.map((_, i) => i), y: pick.map(val).map(v => (Number.isFinite(v) ? v : null)), yerr: b.frame === "steady" ? pick.map(err) : null }];
    spec.xticklabels = pick.map(r => (d.regions || {})[r] || r);
    auto("ylabel", withUnit({ ...meta(d, `${b.q}@${pick[0]}`), label: meta(d, `${b.q}@${pick[0]}`).label.replace(/ \(.*\)$/, "") }));
  } else if (f.kind === "across") {
    const a = f.across || {};
    const all = (f.ds?.length ? ds : store.list()).filter(dd => dd.keys.some(k => k.key === a.key));
    const pts = all.map(dd => { const m = steadyMask(dd, a.from), v = dd.series(a.key).filter((_, i) => m[i]); return { x: Number(dd.params?.[a.param]), y: mean(v), e: std(v), lab: dd.label }; })
      .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y)).sort((p, q) => p.x - q.x);
    spec.kind = "line";
    spec.series = [{ name: shortLabel(meta(d, a.key)), x: pts.map(p => p.x), y: pts.map(p => p.y), yerr: pts.map(p => p.e), err_style: "bars", show_markers: true, marker: "o" }];
    auto("xlabel", (store.PARAMS.find(p => p[0] === a.param) || [a.param, a.param])[1]); auto("ylabel", `${withUnit(meta(d, a.key))}, steady state`);
    spec.note = pts.map(p => `${p.lab}: ${a.param} = ${p.x}, ${num(p.y, 4)} ± ${num(p.e, 3)}`).join("\n");
  }
  return spec;
}

// ---------------------------------------------------------------------------------------------- automatic figure set
function autoFigures(only) {
  const all = store.list(), d = only || all.find(x => x.kind === "research") || all[0];
  if (!d) return [];
  const has = k => d.keys.some(x => x.key === k) && d.series(k).some(Number.isFinite);
  const X = defaultX(d), out = [];
  const add = (name, kind, extra) => out.push({ id: uid(), name, kind, ds: [d.id], x: X, ys: [], style: {}, ...extra });
  const ser = (name, keys, extra = {}) => { const ys = keys.filter(k => has(typeof k === "string" ? k : k.key)).map(k => (typeof k === "string" ? { key: k } : k)); if (ys.length) add(name, "series", { ys, ...extra }); };
  if (d.kind === "table") {
    const tag = d.label.replace(/\.[^.]+$/, "").replace(/[^\w.\-]+/g, "_");
    const keys = d.keys.map(k => k.key);
    if (d.subkind === "atoms") {                                       // one row per atom: quantities vs position
      const pos = ["y", "x", "z"].filter(k => keys.includes(k));
      const qs = keys.filter(k => !["id", "type", "mol", "x", "y", "z", "ix", "iy", "iz"].includes(k));
      for (const q of qs.slice(0, 30)) for (const p of pos.slice(0, 2)) add(`${tag}_${q}_vs_${p}`.replace(/[\[\]]/g, ""), "scatter", { x: p, ys: [{ key: q }], style: { marker_size: 1 } });
      return out;
    }
    if (d.subkind === "frames") {                                      // one row per frame: column statistics
      const X = keys.includes("step") && d.n > 1 ? "step" : "frame";
      if (d.n < 2) { toast(`${d.label}: one frame only — use the atoms table, or analyse several frames.`, "warn"); return out; }
      const sums = keys.filter(k => / sum \(type \d+\) \[nN\]$/.test(k));
      if (sums.length) ser(`${tag}_force_sums_by_type_nN`, sums, { x: X });
      for (const k of keys.filter(k => / mean$/.test(k))) ser(`${tag}_${k.replace(/ mean$/, "")}_mean`.replace(/[\[\]]/g, ""), [{ key: k, err: keys.includes(k.replace(/ mean$/, " std")) }], { x: X });
      return out;
    }
    const X = ["step", "Step", "frame", "Frame", "time", "Time"].find(k => keys.includes(k)) || keys[0];
    for (const k of keys.filter(k => k !== X)) ser(`${tag}_${k}_vs_${X}`, [k], { x: X });
    return out;
  }
  const R = ["contact", "chip", "subsurface", "workpiece", "tool"];
  ser("forces_vs_distance", ["Fc", "Ft", "Fz"], { band: { on: true, from: 0.5 } });
  ser("force_ratio_mu_vs_distance", ["mu", "Ft_over_Fc"]);
  ser("friction_angle_vs_distance", ["friction_angle"]);
  ser("specific_cutting_energy_vs_distance", ["specific_energy"], { band: { on: true, from: 0.5 } });
  ser("cutting_work_vs_distance", ["work_cum"]);
  ser("depth_of_cut_vs_distance", ["depth_of_cut"]);
  ser("tool_speed_vs_distance", ["tool_speed_vel", "tool_speed_frames"]);
  ser("temperature_COM_by_region", R.map(r => `T_com@${r}`));
  ser("local_temperature_contact", [{ key: "T_local.mean@contact", err: true }, "T_local.max@contact"]);
  ser("von_mises_virial_by_region", R.map(r => `vir.von_mises_GPa@${r}`));
  ser("von_mises_per_atom_mean_contact", [{ key: "von_mises.mean_GPa@contact", err: true }, { key: "von_mises.mean_GPa@subsurface", err: true }]);
  ser("von_mises_max_p95_contact", ["von_mises.max_GPa@contact", "von_mises.p95_GPa@contact", "von_mises.p99_GPa@contact"]);
  ser("pressure_virial_by_region", R.map(r => `vir.pressure_GPa@${r}`));
  ser("hydrostatic_pressure_max_contact", ["pressure.max_GPa@contact", "pressure.p95_GPa@contact", "pressure.mean_GPa@contact"]);
  ser("principal_stresses_contact", ["vir.s1_GPa@contact", "vir.s2_GPa@contact", "vir.s3_GPa@contact"]);
  ser("max_principal_tensile_stress", ["s1.max_GPa@contact", "s1.p95_GPa@subsurface", "s1.max_GPa@workpiece"]);
  ser("max_shear_tresca_octahedral_contact", ["tau_max.mean_GPa@contact", "tresca.mean_GPa@contact", "tau_oct.mean_GPa@contact"]);
  ser("stress_components_virial_contact", ["vir.sxx_GPa@contact", "vir.syy_GPa@contact", "vir.szz_GPa@contact", "vir.sxy_GPa@contact", "vir.sxz_GPa@contact", "vir.syz_GPa@contact"]);
  ser("triaxiality_lode_contact", ["triaxiality.mean_GPa@contact", "lode.mean_GPa@contact"].filter(has).length ? ["triaxiality.mean_GPa@contact", "lode.mean_GPa@contact"] : []);
  ser("tool_stress", ["vir.von_mises_GPa@tool", "von_mises.max_GPa@tool", "vir.pressure_GPa@tool"]);
  ser("potential_energy_by_region", ["pe.mean@contact", "pe.mean@chip", "pe.mean@workpiece"]);
  ser("pileup_height_vs_distance", ["pileup_max", "pileup_ahead", "pileup_behind"]);
  ser("chip_atoms_vs_distance", ["chip_atoms", "atoms_above_surface"]);
  ser("chip_volume_vs_distance", ["chip_volume"]);
  ser("machined_surface_roughness", ["Ra", "Rq", "Rz"]);
  ser("subsurface_damage_depth", ["damage_depth"]);
  ser("disordered_fraction_by_region", ["disordered_frac@contact", "disordered_frac@subsurface", "disordered_frac@chip", "disordered_frac@workpiece"]);
  ser("coordination_mean_by_region", ["cn.mean@contact", "cn.mean@chip", "cn.mean@subsurface", "cn.mean@workpiece"]);
  ser("shear_strain_contact", ["shear_strain.mean@contact", "shear_strain.p95@contact", "shear_strain.mean@subsurface"]);
  ser("plastic_zone_atoms", ["plastic_n@workpiece", "plastic_n@subsurface"]);
  ser("point_defects_wigner_seitz", ["ws_vacancies", "ws_interstitials"]);
  ser("dislocation_density", ["dxa_density"]);
  ser("displacement_msd", ["msd@chip", "msd@contact", "msd@workpiece"]);
  ser("rdf_first_peak_and_cn", ["rdf_peak_r@contact", "rdf_peak_r@workpiece", { key: "rdf_cn@contact", axis: "right" }]);
  for (const r of ["workpiece", "contact"]) if (d.keys.some(k => k.key.startsWith("struct_frac_") && k.region === r)) add(`structure_fractions_${r}`, "stack", { stack: { prefix: "struct_frac_", region: r } });
  if (d.keys.some(k => k.key.startsWith("cn_frac_") && k.region === "contact")) add("coordination_fractions_contact", "stack", { stack: { prefix: "cn_frac_", region: "contact" } });
  const curves = d.curveNames();
  for (const c of ["rdf@workpiece", "rdf@contact", "rdf@chip", "rdf@subsurface"]) if (curves.includes(c)) add(`RDF_${c.split("@")[1]}`, "curve", { curve: { name: c, frames: "fml", series: "total" } });
  if (curves.includes("rdf@contact")) add("RDF_partials_contact_last_frame", "curve", { curve: { name: "rdf@contact", frames: "last", series: "*" } });
  for (const c of ["bad@workpiece", "bad@contact", "bad@chip"]) if (curves.includes(c)) add(`bond_angles_${c.split("@")[1]}`, "curve", { curve: { name: c, frames: "fml" } });
  for (const c of ["cn_hist@contact", "cn_hist@chip"]) if (curves.includes(c)) add(`coordination_histogram_${c.split("@")[1]}`, "curve", { curve: { name: c, frames: "fml" } });
  for (const q of ["von_mises", "pressure", "s1", "T_local", "shear_strain"]) if (curves.includes(`hist.${q}@contact`)) add(`histogram_${q}_contact`, "curve", { curve: { name: `hist.${q}@contact`, frames: "fml" } });
  for (const q of ["von_mises", "pressure", "s1", "tau_max", "T_local", "pe", "shear_strain", "disordered"]) if (curves.includes(`depth.${q}`)) add(`depth_profile_${q}`, "curve", { curve: { name: `depth.${q}`, frames: "fml" }, style: { xlabel: "", ylabel: "" } });
  for (const q of ["von_mises", "T_local", "disordered"]) if (curves.includes(`length.${q}`)) add(`length_profile_${q}_subsurface`, "curve", { curve: { name: `length.${q}`, frames: "fml" } });
  if (curves.includes("surface_profile")) add("surface_profile", "curve", { curve: { name: "surface_profile", frames: "fml" } });
  const last = d.frames().slice(-1)[0];
  for (const q of d.mapNames()) add(`map_${q}_last_frame`, "map", { map: { q, frame: last }, style: { width_mm: 160, height_mm: 90, cmap: q === "pressure" || q === "uy" ? "RdBu_r" : q === "T_local" ? "inferno" : "viridis" } });
  const pairs = [["T_com@contact", "vir.von_mises_GPa@contact"], ["T_com@contact", "Fc"], ["depth_of_cut", "Fc"], ["depth_of_cut", "specific_energy"],
    ["T_com@contact", "vir.pressure_GPa@contact"], ["vir.pressure_GPa@contact", "disordered_frac@contact"], ["Fc", "Ft"], ["cut_distance", "chip_atoms"], ["T_com@chip", "pe.mean@chip"]];
  for (const [x, y] of pairs) if (has(x) && has(y)) add(`correlation_${y}_vs_${x}`.replace(/[@.]/g, "_"), "scatter", { x, ys: [{ key: y }], fit: "linear" });
  const cm = ["Fc", "Ft", "mu", "specific_energy", "T_com@contact", "T_com@chip", "vir.von_mises_GPa@contact", "vir.pressure_GPa@contact", "s1.max_GPa@contact", "disordered_frac@contact",
    "damage_depth", "pileup_max", "chip_atoms", "shear_strain.mean@contact", "cut_distance"].filter(has);
  if (cm.length >= 3 && d.n >= 3) add("correlation_matrix", "corrmatrix", { keys: cm, style: { width_mm: 190, height_mm: 170, font_size: 8 } });
  const regs = Object.keys(d.regions || {});
  if (regs.length) {
    add("temperature_by_region_steady", "bar", { bar: { q: "T_com", frame: "steady", from: 0.5, regions: ["contact", "chip", "subsurface", "workpiece", "tool", "mol5", "mol2"] } });
    add("von_mises_virial_by_region_steady", "bar", { bar: { q: "vir.von_mises_GPa", frame: "steady", from: 0.5, regions: ["contact", "chip", "subsurface", "workpiece", "tool"] } });
  }
  const runs = all.filter(x => x.kind === "research");
  if (runs.length > 1) for (const [p] of store.PARAMS) {
    const vals = new Set(runs.map(r => r.params?.[p]).filter(v => v != null && Number.isFinite(+v)));
    if (vals.size < 2) continue;
    for (const k of ["Fc", "Ft", "mu", "specific_energy", "T_com@contact", "vir.von_mises_GPa@contact", "damage_depth", "pileup_max"])
      if (has(k)) out.push({ id: uid(), name: `across_runs_${k}_vs_${p}`.replace(/[@.]/g, "_"), kind: "across", ds: [], across: { param: p, key: k, from: 0.5 }, style: {}, fit: "none" });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- the page
export async function render(root) {
  let alive = true, previewUrl = null, timer = null, seqNo = 0;
  const left = el("aside", { class: "gs-left" }), mid = el("section", { class: "gs-mid" }), right = el("aside", { class: "gs-right" });
  root.append(el("div", { class: "gs-grid" }, left, mid, right));
  const img = el("img", { class: "gs-img", alt: "figure preview" }), pmsg = el("div", { class: "gs-pmsg muted" }), info = el("div", { class: "gs-info small" });
  const dataBox = el("div", { class: "table-wrap gs-data", hidden: true });
  const fileIn = el("input", { type: "file", multiple: true, accept: ".json,.txt,.csv,.tsv,.dat,.log,.lammps,*", hidden: true, onchange: e => importFiles([...e.target.files]) });
  const setIn = el("input", { type: "file", accept: ".json", hidden: true, onchange: e => loadSet(e.target.files[0]) });
  const importBox = el("div", { class: "banner", hidden: true, role: "status" });
  root.append(fileIn, setIn);
  const cur = () => G.figs.find(f => f.id === G.cur) || G.figs[0];
  const off = bus.on ? bus.on("datasets", () => { if (alive) { buildLeft(); buildRight(); refresh(); } }) : null;
  let lastStates = "";
  const offTasks = bus.on("tasks", () => { const st = tasks.list().map(t => t.key + t.status).join(); if (alive && st !== lastStates) { lastStates = st; buildLeft(); } });
  function takeRequests() {
    const req = store.takeFigureRequests();
    for (const f of req) { f.id = uid(); f.style = f.style || {}; G.figs.push(f); G.cur = f.id; }
    if (req.length) { persist(); buildAll(); toast(`${req.length} chart${req.length > 1 ? "s" : ""} from the OVITO tab added (gridlines off; every format in Download).`, "ok"); }
  }
  const offReq = bus.on("figreq", () => { if (alive) takeRequests(); });

  function buildLeft() {
    clear(left);
    const ds = store.list();
    left.append(el("section", { class: "st-sec" }, el("h4", {}, "Data"),
      ds.length ? el("ul", { class: "gs-list" }, ds.map(d => el("li", {},
        el("div", { class: "gs-ds" }, el("b", {}, d.label), el("span", { class: "muted small" }, `${d.kind === "research" ? "research analysis" : d.format} · ${d.n} ${d.kind === "research" || d.subkind === "frames" ? "frames" : d.subkind === "atoms" ? "atoms" : "rows"} · ${d.keys.length} quantities`),
          d.note ? el("span", { class: "muted small" }, d.note) : null),
        el("div", { class: "field-row" },
          el("button", { class: "btn ghost sm", type: "button", "data-tip": "Rename and set run parameters (speed, depth …) for across-run plots", onclick: () => paramsModal(d) }, "Edit"),
          el("button", { class: "btn ghost sm", type: "button", onclick: () => download(`${d.label.replace(/[^\w.\-]+/g, "_")}.nanocut-results.json`, JSON.stringify(store.toJson(d)), "application/json") }, "Save"),
          d.kind === "research" ? el("button", { class: "btn ghost sm", type: "button", onclick: () => download(`${d.label.replace(/[^\w.\-]+/g, "_")}_all_quantities.csv`, scalarsCsv(d), "text/csv") }, "CSV") : null,
          el("button", { class: "btn ghost sm", type: "button", "aria-label": `Remove ${d.label}`, onclick: () => store.remove(d.id) }, "✕"))))) :
        el("p", { class: "muted small" }, "No data yet. Open a dump folder in the OVITO tab (it is analysed automatically), or use Analyse dumps…, or Load files… (dumps, frame CSVs/ZIP, Excel, LAMMPS logs, force files, CSV)."),
      importBox,
      ...tasks.list().filter(t => t.key.startsWith("research:") && t.status === "running").map(t => tasks.progressBox(t, { onCancel: () => t.cancel?.() })),
      el("div", { class: "field-row wrap" }, el("button", { class: "btn", type: "button", "data-tip": "LAMMPS dumps (.lammpstrj), per-atom CSVs or the frame-CSV ZIP of the OVITO Export tab, the statistics Excel, LAMMPS logs, fix ave/time files (e.g. *_forces_temps.txt), any CSV/TSV, saved results (.json)", onclick: () => fileIn.click() }, "Load files…"),
        el("button", { class: "btn", type: "button", "data-tip": "Choose a folder with dump files: the full research analysis (stresses, temperatures, forces, structure, RDF …) runs in the background and appears here", onclick: analyseDumps }, "Analyse dumps…"),
        el("a", { class: "btn ghost", href: "#/ovito" }, "OVITO tab"),
        ds.length ? el("button", { class: "btn ghost", type: "button", onclick: () => download(`nanocut_session_${ds.length}_datasets.json`, JSON.stringify(store.sessionJson()), "application/json") }, "Save session") : null)));
    const figs = el("ul", { class: "gs-list gs-figs" }, G.figs.map(f => el("li", { class: f.id === cur()?.id ? "on" : "", onclick: () => { G.cur = f.id; persist(); buildLeft(); buildRight(); refresh(); } },
      el("span", { class: "gs-fname" }, f.name), el("span", { class: "muted small" }, (KINDS.find(k => k[0] === f.kind) || [, ""])[1].split(":")[0]))));
    left.append(el("section", { class: "st-sec" }, el("h4", {}, `Figures (${G.figs.length})`),
      el("div", { class: "field-row wrap" },
        el("button", { class: "btn primary", type: "button", disabled: !ds.length, "data-tip": "Every standard figure of a nano-cutting paper for the data present (missing quantities are skipped)", onclick: genAll }, "Generate all graphs"),
        el("button", { class: "btn", type: "button", disabled: !ds.length, onclick: () => addFig({ kind: "series" }) }, "+ New"),
        cur() ? el("button", { class: "btn ghost", type: "button", onclick: () => addFig(JSON.parse(JSON.stringify({ ...cur(), id: undefined, name: cur().name + "_copy" }))) }, "Duplicate") : null,
        cur() ? el("button", { class: "btn ghost", type: "button", onclick: () => { G.figs = G.figs.filter(f => f !== cur()); G.cur = G.figs[0]?.id; persist(); buildAll(); } }, "Delete") : null,
        G.figs.length ? el("button", { class: "btn ghost", type: "button", onclick: () => { if (confirm(`Delete all ${G.figs.length} figures?`)) { G.figs = []; G.cur = null; persist(); buildAll(); } } }, "Clear all") : null),
      G.figs.length ? figs : el("p", { class: "muted small" }, "No figures. “Generate all graphs” builds the standard set; “+ New” starts an empty one."),
      el("div", { class: "field-row wrap" }, el("button", { class: "btn ghost", type: "button", onclick: () => download("nanocut_figure_set.json", JSON.stringify({ nanocut_figures: 1, figs: G.figs }, null, 1), "application/json") }, "Save figure set"),
        el("button", { class: "btn ghost", type: "button", onclick: () => setIn.click() }, "Load figure set"))));
  }
  function addFig(f) {
    const d = store.list()[0];
    const nf = { id: uid(), name: f.name || `figure_${G.figs.length + 1}`, kind: f.kind || "series", ds: f.ds || (d ? [d.id] : []), x: f.x || defaultX(d), ys: f.ys || [], style: f.style || {}, ...f };
    nf.id = uid();
    if (!nf.ys.length && nf.kind === "series" && d) { const k = d.keys.find(k => k.key === "Fc") || d.keys[1]; if (k) nf.ys = [{ key: k.key }]; }
    G.figs.push(nf); G.cur = nf.id; persist(); buildAll();
  }
  function genAll() {
    const all = store.list();
    const figs = [...(all.some(d => d.kind === "research") ? autoFigures() : []), ...all.filter(d => d.kind === "table").flatMap(d => autoFigures(d))];
    const names = new Set(G.figs.map(f => f.name));
    const fresh = figs.filter(f => !names.has(f.name));
    G.figs.push(...fresh); G.cur = G.cur || fresh[0]?.id; persist(); buildAll();
    toast(`${fresh.length} figures generated${figs.length - fresh.length ? ` (${figs.length - fresh.length} already present)` : ""}.`, "ok");
  }

  // ---------------------------------------------------------------- editor
  function buildRight() {
    clear(right);
    const f = cur();
    if (!f) { right.append(el("p", { class: "muted" }, "Select or create a figure.")); return; }
    const ch = () => { persist(); refresh(); };
    const rebuild = () => { persist(); buildRight(); refresh(); };
    const ds = store.list(), d = dsOf(f)[0];
    const row = (label, c, tip) => el("label", { class: "frow", "data-tip": tip }, el("span", {}, label), el("div", { class: "fctl" }, c));
    const sel = (opts, v, on, a = {}) => el("select", { class: "select", onchange: e => on(e.target.value), ...a }, opts.map(o => (o instanceof Node ? o : el("option", { value: o[0], selected: String(o[0]) === String(v) }, o[1]))));
    const keyOpts = (dd, pred = () => true) => {
      const groups = {};
      for (const k of dd.keys) if (pred(k)) (groups[k.category] = groups[k.category] || []).push(k);
      return Object.entries(groups).map(([g, ks]) => el("optgroup", { label: g }, ks.map(k => el("option", { value: k.key }, withUnit(k)))));
    };
    const keySel = (dd, v, on, pred) => { const s = el("select", { class: "select gs-key", onchange: e => on(e.target.value) }, keyOpts(dd, pred)); s.value = v ?? ""; return s; };
    const regionFilter = { r: f._region || "" };
    const dataSec = el("section", { class: "st-sec" }, el("h4", {}, "Figure"),
      row("Name", el("input", { class: "input", value: f.name, onchange: e => { f.name = e.target.value.replace(/[^\w.\-]+/g, "_") || "figure"; persist(); buildLeft(); } }), "Also the file name"),
      row("Type", sel(KINDS, f.kind, v => { f.kind = v; if (v === "curve" && !f.curve && d) f.curve = { name: d.curveNames()[0], frames: "fml" }; if (v === "map" && !f.map && d) f.map = { q: d.mapNames()[0], frame: d.frames().slice(-1)[0] };
        if (v === "stack" && !f.stack) f.stack = { prefix: "struct_frac_", region: "workpiece" }; if (v === "corrmatrix" && !f.keys) f.keys = ["Fc", "Ft", "T_com@contact", "vir.von_mises_GPa@contact"];
        if (v === "across" && !f.across) f.across = { param: "speed_ms", key: "Fc", from: 0.5 }; if (v === "bar" && !f.bar) f.bar = { q: "T_com", frame: "steady", from: 0.5 }; rebuild(); })),
      f.kind === "across" ? el("p", { class: "muted small" }, "Uses every dataset that has the quantity (or the ones ticked below) — set each dataset's run parameters with Edit in the Data list.") : null,
      row("Dataset(s)", el("div", { class: "chips" }, ds.map(dd => el("button", { class: "chip", type: "button", "aria-pressed": (f.ds || []).includes(dd.id) || (!(f.ds || []).length && dd === ds[0] && f.kind !== "across"),
        onclick: () => { const cur_ = (f.ds || []).filter(x => store.byId(x)); f.ds = cur_.includes(dd.id) ? cur_.filter(x => x !== dd.id) : [...cur_, dd.id]; rebuild(); } }, dd.label))), "Several datasets: one series per dataset (compare runs)"));
    right.append(dataSec);
    if (!d) { right.append(el("p", { class: "muted" }, "Load data first.")); return; }
    if (f.kind === "series" || f.kind === "scatter" || f.kind === "stack") {
      dataSec.append(row(f.kind === "scatter" ? "X" : "X axis", keySel(d, f.x, v => { f.x = v; delete f.style.xlabel; ch(); })));
    }
    if (f.kind === "series" || f.kind === "scatter") {
      const regions = [...new Set(d.keys.map(k => k.region).filter(Boolean))];
      const rf = sel([["", "all regions"], ["-", "frame quantities (no region)"], ...regions.map(r => [r, (d.regions || {})[r] || r])], regionFilter.r, v => { f._region = v; rebuild(); });
      const pred = k => !regionFilter.r || (regionFilter.r === "-" ? !k.region : k.region === regionFilter.r);
      const ylist = el("div", { class: "gs-ys" }, (f.ys || []).map((y, i) => el("div", { class: "gs-y" },
        keySel(d, y.key, v => { y.key = v; delete f.style.ylabel; ch(); }, k => pred(k) || k.key === y.key),
        f.kind === "series" ? el("label", { class: "check", "data-tip": "Plot on a second (right) Y axis" }, el("input", { type: "checkbox", checked: y.axis === "right", onchange: e => { y.axis = e.target.checked ? "right" : "left"; delete f.style.y2label; ch(); } }), "right") : null,
        d.keys.some(k => k.key === stdKey(y.key)) && stdKey(y.key) !== y.key ? el("label", { class: "check", "data-tip": "± standard deviation over the region's atoms (band)" }, el("input", { type: "checkbox", checked: !!y.err, onchange: e => { y.err = e.target.checked; ch(); } }), "±std") : null,
        el("button", { class: "btn ghost sm", type: "button", "aria-label": "Remove", onclick: () => { f.ys.splice(i, 1); delete f.style.ylabel; rebuild(); } }, "✕"))));
      dataSec.append(row("Filter Y by region", rf), el("div", {}, el("span", { class: "small muted" }, f.kind === "scatter" ? "Y" : "Y quantities"), ylist),
        f.kind === "series" || !(f.ys || []).length ? el("button", { class: "btn ghost sm", type: "button", onclick: () => { const k = d.keys.find(k => pred(k)) || d.keys[0]; f.ys = [...(f.ys || []), { key: k.key }]; delete f.style.ylabel; rebuild(); } }, "+ Add Y") : null,
        row("Smoothing", numIn(f, "smooth", ch, { min: 0, step: 1, placeholder: "0 = off" }), "Moving average over n points (display only)"),
        f.kind === "series" ? el("label", { class: "check" }, el("input", { type: "checkbox", checked: !!f.markers, onchange: e => { f.markers = e.target.checked; ch(); } }), "Markers on lines") : null,
        f.kind === "series" ? el("div", { class: "field-row" }, el("label", { class: "check" }, el("input", { type: "checkbox", checked: !!f.band?.on, onchange: e => { f.band = { from: 0.5, ...(f.band || {}), on: e.target.checked }; ch(); } }), "Steady-state window from"),
          numIn(f.band = f.band || { on: false, from: 0.5 }, "from", ch, { min: 0, max: 1, step: 0.05, style: { width: "70px" } }), el("span", { class: "muted small" }, "of X range")) : null,
        row("Fit (1st series)", sel([["none", "none"], ["linear", "linear"], ["poly2", "quadratic"], ["power", "power law y = a·xᵇ"], ["exp", "exponential"]], f.fit || "none", v => { f.fit = v; ch(); })));
    } else if (f.kind === "corrmatrix") {
      const box = el("div", { class: "chips gs-chips" }, d.keys.filter(k => k.category !== "count").map(k => el("button", { class: "chip", type: "button", "aria-pressed": (f.keys || []).includes(k.key), "data-tip": withUnit(k),
        onclick: e => { f.keys = (f.keys || []).includes(k.key) ? f.keys.filter(x => x !== k.key) : [...(f.keys || []), k.key]; e.currentTarget.setAttribute("aria-pressed", f.keys.includes(k.key)); ch(); } }, k.label)));
      dataSec.append(el("p", { class: "muted small" }, `Pearson r between every pair of the chosen quantities over the ${d.n} frames.`), el("input", { class: "input", placeholder: "filter…", oninput: e => { const q = e.target.value.toLowerCase(); box.querySelectorAll(".chip").forEach(c => { c.hidden = !c.textContent.toLowerCase().includes(q); }); } }), box);
    } else if (f.kind === "curve") {
      f.curve = f.curve || {};
      const names = d.curveNames();
      const cv = d.rows?.slice().reverse().find(r => r.curves?.[f.curve.name])?.curves?.[f.curve.name];
      dataSec.append(row("Curve", sel(names.map(n => [n, curveLabel(n, d)]), f.curve.name, v => { f.curve.name = v; f.curve.series = null; delete f.style.xlabel; delete f.style.ylabel; rebuild(); })),
        cv && Object.keys(cv.series).length > 1 ? row("Series", sel([...Object.keys(cv.series).map(s => [s, s]), ["*", "all (partials)"]], f.curve.series || Object.keys(cv.series)[0], v => { f.curve.series = v; ch(); })) : null,
        row("Frames", sel([["fml", "first, middle, last"], ["first", "first"], ["last", "last"], ["all", "all analysed"], ["custom", "list…"]], ["fml", "first", "last", "all"].includes(f.curve.frames || "fml") ? (f.curve.frames || "fml") : "custom", v => { f.curve.frames = v === "custom" ? d.frames().slice(-1).join(",") : v; rebuild(); })),
        !["fml", "first", "last", "all", undefined].includes(f.curve.frames) ? row("Frame list", el("input", { class: "input mono", value: f.curve.frames, onchange: e => { f.curve.frames = e.target.value; ch(); } }), `analysed frames: ${d.frames().join(", ")}`) : null,
        cv?.note ? el("p", { class: "muted small" }, cv.note) : null);
    } else if (f.kind === "map") {
      f.map = f.map || {};
      const mp = d.rows?.find(r => r.frame === +f.map.frame)?.maps?.[f.map.q];
      dataSec.append(row("Quantity", sel(d.mapNames().map(n => [n, n]), f.map.q, v => { f.map.q = v; ["cbar_label", "title"].forEach(k => delete f.style[k]); ch(); })),
        row("Frame", sel(d.frames().map(x => [x, frameName(d, x)]), f.map.frame, v => { f.map.frame = +v; delete f.style.title; ch(); })),
        mp?.note ? el("p", { class: "muted small" }, `${mp.note}; bins ${mp.dx} Å.`) : null);
    } else if (f.kind === "stack") {
      f.stack = f.stack || {};
      const regions = [...new Set(d.keys.filter(k => /^(struct|cn)_frac_/.test(k.quantity || "")).map(k => k.region))];
      dataSec.append(row("Fractions", sel([["struct_frac_", "structure types"], ["cn_frac_", "coordination numbers"]], f.stack.prefix, v => { f.stack.prefix = v; ch(); })),
        row("Region", sel(regions.map(r => [r, (d.regions || {})[r] || r]), f.stack.region, v => { f.stack.region = v; ch(); })));
    } else if (f.kind === "bar") {
      f.bar = f.bar || {};
      const qs = [...new Set(d.keys.filter(k => k.region).map(k => k.key.split("@")[0]))];
      dataSec.append(row("Quantity", sel(qs.map(q => [q, (meta(d, `${q}@workpiece`).label || q).replace(/ \(.*\)$/, "")]), f.bar.q, v => { f.bar.q = v; delete f.style.ylabel; ch(); })),
        row("Value", sel([["steady", "steady-state mean ± std"], ...d.frames().map(x => [x, frameName(d, x)])], f.bar.frame, v => { f.bar.frame = v; ch(); })),
        row("Steady from", numIn(f.bar, "from", ch, { min: 0, max: 1, step: 0.05 }), "Fraction of the cutting distance where the steady state starts"));
    } else if (f.kind === "across") {
      f.across = f.across || {};
      dataSec.append(row("X: run parameter", sel(store.PARAMS, f.across.param, v => { f.across.param = v; delete f.style.xlabel; ch(); })),
        row("Y: quantity", keySel(d, f.across.key, v => { f.across.key = v; delete f.style.ylabel; ch(); })),
        row("Steady from", numIn(f.across, "from", ch, { min: 0, max: 1, step: 0.05 }), "Mean ± std over the cutting distance beyond this fraction"),
        row("Fit", sel([["none", "none"], ["linear", "linear"], ["poly2", "quadratic"], ["power", "power law"], ["exp", "exponential"]], f.fit || "none", v => { f.fit = v; ch(); })));
    }
    // style
    const st = f.style = f.style || {};
    const spec0 = buildSpec(f).style;
    const styleSec = el("section", { class: "st-sec" }, el("h4", {}, "Style"),
      row("Size preset", sel([["", "—"], ...SIZE_PRESETS.map((p, i) => [i, p[0]])], "", v => { if (v !== "") { st.width_mm = SIZE_PRESETS[v][1]; st.height_mm = SIZE_PRESETS[v][2]; rebuild(); } })),
      el("div", { class: "field-row wrap" }, el("button", { class: "btn ghost sm", type: "button", "data-tip": "Copy this figure's look (not its labels) to every figure", onclick: () => {
        const keep = ["title", "xlabel", "ylabel", "y2label", "annotation", "cbar_label", "xlim", "ylim", "y2lim", "clim"];
        for (const g of G.figs) if (g !== f) { const own = Object.fromEntries(keep.filter(k => g.style?.[k] != null).map(k => [k, g.style[k]])); g.style = { ...Object.fromEntries(Object.entries(st).filter(([k]) => !keep.includes(k))), ...own }; }
        persist(); toast("Style applied to all figures.", "ok"); } }, "Apply style to all"),
        el("button", { class: "btn ghost sm", type: "button", onclick: () => { f.style = {}; rebuild(); } }, "Reset style")));
    for (const [title, fields] of STYLE_FIELDS) {
      const det = el("details", { class: "gs-det", open: title === "Text" || title === "Grid and axes" }, el("summary", {}, title));
      for (const [k, label, type, opts] of fields) {
        const v = st[k];
        let c;
        if (type === "bool") c = el("input", { type: "checkbox", checked: v ?? DEF[k], onchange: e => { st[k] = e.target.checked; ch(); } });
        else if (type === "select") c = sel(opts, v ?? DEF[k], x => { st[k] = typeof DEF[k] === "number" ? +x : x; ch(); });
        else if (type === "range") c = el("div", { class: "duo" }, ...[0, 1].map(i => el("input", { class: "input num", type: "number", step: "any", placeholder: i ? "max" : "min", value: v?.[i] ?? "",
          onchange: e => { const a = [...(st[k] || [null, null])]; a[i] = e.target.value === "" ? null : +e.target.value; st[k] = a.every(x => x == null) ? null : a; ch(); } })));
        else if (type === "number") c = el("input", { class: "input num", type: "number", step: "any", value: v ?? "", placeholder: DEF[k] ?? "auto", onchange: e => { st[k] = e.target.value === "" ? null : +e.target.value; if (st[k] == null) delete st[k]; ch(); } });
        else c = el("input", { class: "input", type: "text", value: v ?? "", placeholder: spec0[k] || "", onchange: e => { st[k] = e.target.value; if (!st[k]) delete st[k]; ch(); } });
        det.append(row(label, c));
      }
      styleSec.append(det);
    }
    right.append(styleSec);
  }
  const DEF = { title_bold: true, grid_major: true, grid_minor: false, grid_style: "-", grid_alpha: 0.35, grid_width: 0.6, minor_ticks: true, tick_dir: "in", ticks_all_sides: true, frame: "box",
    logx: false, logy: false, invert_x: false, invert_y: false, legend: true, legend_loc: "best", legend_frame: false, legend_cols: 1, palette: "default", line_width: 1.5, marker_size: 4,
    cmap: "viridis", show_values: true, width_mm: 90, height_mm: 70, dpi: 300, background: "white", font_family: "sans", font_size: 10, axis_width: 0.8 };
  function numIn(obj, k, on, a = {}) { return el("input", { class: "input num", type: "number", step: "any", value: obj[k] ?? "", onchange: e => { obj[k] = e.target.value === "" ? null : +e.target.value; on(); }, ...a }); }
  function curveLabel(n, d) {
    const [fam, reg] = n.split("@");
    const L = { rdf: "RDF g(r)", bad: "bond-angle distribution", cn_hist: "coordination histogram", surface_profile: "surface height profile" };
    const base = L[fam] || (fam.startsWith("hist.") ? `histogram of ${fam.slice(5)}` : fam.startsWith("depth.") ? `depth profile of ${fam.slice(6)}` : fam.startsWith("length.") ? `profile along x of ${fam.slice(7)}` : fam);
    return reg ? `${base} — ${(d.regions || {})[reg] || reg}` : base;
  }

  // ---------------------------------------------------------------- centre: preview, data, export
  const fmtBox = el("div", { class: "chips" }, FORMATS.map(([k, l]) => el("button", { class: "chip", type: "button", "aria-pressed": G.formats.includes(k),
    onclick: e => { G.formats = G.formats.includes(k) ? G.formats.filter(x => x !== k) : [...G.formats, k]; e.currentTarget.setAttribute("aria-pressed", G.formats.includes(k)); persist(); } }, l)));
  const tabPrev = el("button", { class: "btn sm", type: "button", "aria-pressed": "true", onclick: () => showData(false) }, "Preview");
  const tabData = el("button", { class: "btn sm", type: "button", "aria-pressed": "false", onclick: () => showData(true) }, "Data");
  const zipStatus = el("span", { class: "muted small" });
  mid.append(
    el("div", { class: "gs-bar" }, tabPrev, tabData,
      el("span", { class: "gs-sep" }), el("span", { class: "muted small" }, "Formats"), fmtBox,
      el("button", { class: "btn", type: "button", onclick: () => exportOne() }, "Download figure"),
      el("button", { class: "btn primary", type: "button", onclick: exportZip }, "Download all as ZIP"),
      el("label", { class: "check small", "data-tip": "Add every analysed quantity (CSV), all curves and the full results (JSON) to the ZIP" }, el("input", { type: "checkbox", checked: G.includeData, onchange: e => { G.includeData = e.target.checked; persist(); } }), "with data"),
      zipStatus),
    el("div", { class: "gs-canvas" }, img, pmsg), dataBox, info);
  function showData(on) { dataBox.hidden = !on; img.parentElement.hidden = on; tabPrev.setAttribute("aria-pressed", !on); tabData.setAttribute("aria-pressed", on); if (on) fillData(); }
  function fillData() {
    const f = cur(); clear(dataBox);
    if (!f) return;
    const sp = buildSpec(f);
    if (sp.series?.length) {
      const n = Math.max(...sp.series.map(s => s.x.length));
      dataBox.append(el("table", { class: "data compact" }, el("thead", {}, el("tr", {}, sp.series.flatMap(s => [el("th", {}, `${s.name} · x`), el("th", { class: "num" }, `${s.name} · y`)]))),
        el("tbody", {}, [...Array(Math.min(n, 2000)).keys()].map(i => el("tr", {}, sp.series.flatMap(s => [el("td", { class: "num" }, num(s.x[i], 5)), el("td", { class: "num" }, num(s.y[i], 5))]))))));
    } else if (sp.matrix) {
      dataBox.append(el("table", { class: "data compact" }, el("thead", {}, el("tr", {}, el("th"), sp.matrix.labels.map(l => el("th", {}, l)))),
        el("tbody", {}, sp.matrix.labels.map((l, i) => el("tr", {}, el("th", {}, l), sp.matrix.values[i].map(v => el("td", { class: "num" }, v == null ? "—" : v.toFixed(3))))))));
    } else dataBox.append(el("p", { class: "muted" }, "Maps: the CSV of the grid is in the ZIP (data/<name>.csv)."));
  }
  function refresh() {
    clearTimeout(timer);
    timer = setTimeout(preview, 250);
    if (!dataBox.hidden) fillData();
  }
  async function preview() {
    const f = cur(), my = ++seqNo;
    clear(info);
    if (!f) { img.hidden = true; pmsg.textContent = store.list().length ? "No figure selected." : "No data. Load files or run the OVITO page's Research tab."; return; }
    const spec = buildSpec(f);
    if (!(spec.series?.length || spec.map || spec.matrix?.labels?.length)) { img.hidden = true; pmsg.textContent = "Nothing to draw yet: choose the quantities on the right."; return; }
    pmsg.textContent = "Rendering…";
    try {
      const res = await fetch(api.apiUrl("/api/figures/render"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ spec, format: "png", dpi: 130 }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
      const b = await res.blob();
      if (my !== seqNo || !alive) return;
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(b);
      img.src = previewUrl; img.hidden = false; pmsg.textContent = "";
      const st = { ...DEF, ...(f.style || {}) };
      info.append(el("span", { class: "muted" }, `${st.width_mm} × ${st.height_mm} mm at ${st.dpi} DPI → ${Math.round(st.width_mm / 25.4 * st.dpi)} × ${Math.round(st.height_mm / 25.4 * st.dpi)} px raster; vector formats scale freely. Preview at 130 DPI.`));
      if (spec.note) info.append(el("pre", { class: "small mono" }, spec.note));
      if (f.kind === "series" && f.band?.on && spec.band) for (const s of spec.series) {
        const v = s.y.filter((y, i) => y != null && s.x[i] >= spec.band[0]);
        if (v.length) info.append(el("div", {}, `${s.name}: steady-state mean ${num(mean(v), 4)} ± ${num(std(v), 3)} (${v.length} points)`));
      }
    } catch (e) { if (my === seqNo) { img.hidden = true; pmsg.textContent = `Could not draw: ${e.message}`; } }
  }
  async function fetchFig(spec, fmt) {
    const res = await fetch(api.apiUrl("/api/figures/render"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ spec, format: fmt }) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
    return res.blob();
  }
  async function exportOne() {
    const f = cur();
    if (!f || !G.formats.length) { toast("Choose a figure and at least one format.", "warn"); return; }
    try {
      for (const fmt of G.formats) { const b = await fetchFig(buildSpec(f), fmt); download(`${f.name}.${fmt}`, b, b.type); }
      toast(`${f.name}: ${G.formats.join(", ")} downloaded.`, "ok");
    } catch (e) { toast(e.message, "err"); }
  }
  async function exportZip() {
    if (!G.figs.length || !G.formats.length) { toast("Generate or create figures and choose at least one format.", "warn"); return; }
    const files = {};
    if (G.includeData) for (const d of store.list()) {
      const nm = d.label.replace(/[^\w.\-]+/g, "_");
      if (d.kind === "research") {
        files[`results/${nm}/all_scalars.csv`] = scalarsCsv(d);
        files[`results/${nm}/quantities.csv`] = ["key,label,unit,category,region", ...d.keys.map(k => [k.key, k.label, k.unit, k.category, k.region || ""].map(v => `"${String(v).replace(/"/g, "'")}"`).join(","))].join("\n");
        files[`results/${nm}/analysis.json`] = JSON.stringify(store.toJson(d));
        for (const c of d.curveNames()) {
          const rows = d.rows.filter(r => r.curves?.[c]);
          const cv0 = rows[0].curves[c];
          const head = [cv0.xlabel, ...rows.flatMap(r => Object.keys(r.curves[c].series).map(s => `frame ${r.frame} ${s}`))];
          const lines = cv0.x.map((x, i) => [x, ...rows.flatMap(r => Object.values(r.curves[c].series).map(a => a[i] ?? ""))].join(","));
          files[`results/${nm}/curves/${c.replace(/[@.]/g, "_")}.csv`] = [head.map(h => `"${h}"`).join(","), ...lines].join("\n");
        }
      } else files[`results/${nm}/table.csv`] = [Object.keys(d.columns).join(","), ...[...Array(d.n).keys()].map(i => Object.values(d.columns).map(a => a[i]).join(","))].join("\n");
    }
    zipStatus.textContent = `rendering ${G.figs.length} figures × ${G.formats.length} formats…`;
    try {
      const res = await fetch(api.apiUrl("/api/figures/zip"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ figures: G.figs.map(buildSpec), formats: G.formats, files }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
      const b = await res.blob();
      download(`nanocut_graphs_${G.figs.length}_figures.zip`, b, "application/zip");
      zipStatus.textContent = `ZIP downloaded (${(b.size / 1e6).toFixed(1)} MB).`;
    } catch (e) { zipStatus.textContent = ""; toast(`ZIP export failed: ${e.message}`, "err"); }
  }

  // ---------------------------------------------------------------- files, parameters
  async function importFiles(files) {
    for (const file of files) {
      try {
        if (/\.json$/i.test(file.name)) {
          const obj = JSON.parse(await file.text());
          if (obj.nanocut_figures) { loadSetObj(obj); continue; }
          store.addFromJson(obj, file.name.replace(/\.nanocut-results\.json$|\.json$/i, ""));
          toast(`${file.name} loaded.`, "ok"); continue;
        }
        // LAMMPS dumps, per-atom CSVs, ZIPs of frame CSVs, Excel, logs, ave/time files, any table: read by the backend
        importBox.hidden = false; importBox.textContent = `Reading ${file.name} (${(file.size / 1e6).toFixed(1)} MB)…`;
        const res = await fetch(api.apiUrl(`/api/graphs/import?name=${encodeURIComponent(file.name)}`), { method: "POST", body: file });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j.detail || res.statusText);
        const ds = store.addImported(j.datasets.filter(d => d.kind !== "error"));
        toast(`${file.name}: ${ds.map(d => `${d.label} (${d.n} rows)`).join(", ")}.`, "ok", 7000);
        for (const e of j.datasets.filter(d => d.kind === "error")) toast(`${e.label}: ${e.note}`, "warn", 8000);
        if (/ITEM: TIMESTEP/.test(await file.slice(0, 2000).text())) toast("A LAMMPS dump gives column statistics here. For stresses, temperatures, RDF … use “Analyse dumps…” (or the OVITO tab, which analyses automatically).", "info", 9000);
      } catch (e) { toast(`${file.name}: ${e.message}`, "err", 9000); }
      finally { importBox.hidden = true; }
    }
    fileIn.value = "";
  }
  async function analyseDumps() {
    if (api.apiHosted()) { toast("On the hosted site, open the dumps in the OVITO tab (Upload files…) and run Research there.", "warn", 8000); return; }
    try {
      const r = (await api.post("/api/local/pick", { kind: "folder", start: "" }, 1800000)).body;
      if (!r.path) return;
      const sc = await api.get(`/api/studio/scan?path=${encodeURIComponent(r.path)}`);
      const seqs = (sc.sequences || []).slice().sort((a, b) => (b.count || 0) - (a.count || 0));
      if (!seqs.length) { toast("No LAMMPS dump files in that folder (searched two levels deep).", "warn"); return; }
      const sq = seqs[0];
      const dir = sq.dir || r.path;
      const label = `${dir.split(/[\\/]/).pop()}/${sq.pattern}`;
      startResearch({ source: { path: dir, pattern: sq.pattern }, label });
      toast(`Analysing ${label} in the background (${seqs.length > 1 ? `largest of ${seqs.length} sequences; ` : ""}up to 60 frames). It appears here when finished.`, "info", 9000);
      buildLeft();
    } catch (e) { toast(e.status === 501 ? "No folder dialog available: open the folder in the OVITO tab instead." : e.message, "err", 8000); }
  }
  function loadSetObj(obj) { const figs = obj.figs || []; for (const f of figs) { f.id = uid(); f.ds = []; } G.figs.push(...figs); G.cur = figs[0]?.id || G.cur; persist(); buildAll(); toast(`${figs.length} figures loaded (applied to the first dataset).`, "ok"); }
  async function loadSet(file) { try { loadSetObj(JSON.parse(await file.text())); } catch (e) { toast(e.message, "err"); } setIn.value = ""; }
  function paramsModal(d) {
    const back = el("div", { class: "modal-backdrop open", role: "dialog", "aria-modal": "true", "aria-label": "Dataset" });
    const inputs = {};
    back.append(el("div", { class: "modal" }, el("div", { class: "panel-head" }, el("h3", {}, "Dataset")),
      el("div", { class: "panel-body grid1" },
        el("label", { class: "frow" }, el("span", {}, "Label"), inputs.label = el("input", { class: "input", value: d.label })),
        el("p", { class: "muted small" }, "Run parameters for across-run plots (prefilled from params.json when the dumps had one)."),
        ...store.PARAMS.map(([k, l]) => el("label", { class: "frow" }, el("span", {}, l), inputs[k] = el("input", { class: "input", value: d.params?.[k] ?? "" }))),
        el("div", { class: "field-row" }, el("button", { class: "btn primary", type: "button", onclick: () => {
          d.label = inputs.label.value || d.label;
          for (const [k] of store.PARAMS) { const v = inputs[k].value.trim(); if (v === "") delete d.params[k]; else d.params[k] = Number.isFinite(+v) ? +v : v; }
          back.remove(); bus.emit("datasets");
        } }, "Save"), el("button", { class: "btn", type: "button", onclick: () => back.remove() }, "Cancel")))));
    document.body.append(back);
  }
  function buildAll() { buildLeft(); buildRight(); refresh(); }
  buildAll();
  takeRequests();
  store.ready.then(() => { if (alive) { buildLeft(); buildRight(); refresh(); } });
  return () => { alive = false; if (previewUrl) URL.revokeObjectURL(previewUrl); off?.(); offTasks(); offReq(); };
}
