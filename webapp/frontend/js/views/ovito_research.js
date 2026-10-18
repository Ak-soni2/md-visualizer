// OVITO page, "Research" tab (PLAN_PHASE3.md §2): every per-region quantity of a nano-cutting paper for the chosen
// frames — all stress measures (von Mises, pressure, principal, Tresca, octahedral, triaxiality, Lode, components and
// the region's virial average), temperatures, forces and cutting mechanics, energies, displacements, structure,
// coordination, atomic strain, defects, surface, RDF and bond angles, profiles and maps. OVITO reads the frames and
// runs its structure/strain/Voronoi/Wigner–Seitz modifiers; nanocut/research.py does the arithmetic.
// Results go to Graph Studio (#/graphs) and can be saved.
import * as api from "../api.js";
import { el, clear, num, toast, loading, errorState, download } from "../ui.js";
import { selectFrames } from "./ovito_frames.js";
import * as store from "../research_store.js";

export const researchDefaults = () => ({
  sel: { mode: "interval", interval: 1, start: 0, end: null, step: 1, list: "" },
  types: null, tool_types: null, dt_ps: 0.0005, direction: "-x", rake_deg: 0, structure: "diamond", volume_mode: "nominal",
  contact_radius: 20, chip_threshold: 1, subsurface_depth: 30, rdf: true, rdf_rmax: 6, rdf_bins: 150, max_centers: 20000,
  bad: true, bond_cutoff: null, cn_cutoff: null, strain: true, strain_cutoff: 3.5, strain_threshold: 0.2, ws: false, dxa: false,
  dxa_lattice: "CubicDiamond", hist: true, profiles: true, maps: true, map_bin: 4, profile_bin: 2, label: "",
});
const HELP = {
  types: "Mass (g/mol) for COM-removed temperatures; atomic volume Ω (Å³) to turn c_s[1..6] (bar·Å³) into stress: σ = S/Ω. Nominal Ω = a0³ / atoms per cubic cell (3C-SiC 10.41, diamond 5.67, Si 20.02, Cu 11.81 Å³).",
  volume_mode: "Nominal: one Ω per type (the literature standard). Voronoi: OVITO's per-atom cell volume (follows density changes, but open cells at free surfaces/chip are too large).",
  structure: "Identify diamond structure (SiC, Si, Ge, diamond), CNA (fcc/bcc/hcp metals) or PTM. 'Other' atoms = disordered/amorphous → damage depth, disordered fraction.",
  contact_radius: "Contact zone: workpiece atoms within this distance of the contact point (leading tool atom below the original surface, mid-height of the uncut chip).",
  chip_threshold: "Chip: workpiece atoms higher than original surface + this, ahead of the cutting edge.",
  subsurface_depth: "Subsurface: workpiece atoms behind the edge, from the tool bottom down to this depth.",
  rdf: "g(r) total and partial for workpiece / contact / chip / subsurface, normalised with the bulk density 1/Ω̄.",
  bad: "Bond-angle distribution of bonds shorter than the cutoff (empty = first minimum of the workpiece RDF).",
  strain: "OVITO atomic strain against frame 0: von Mises shear strain η, volumetric strain, plastic zone (η > threshold).",
  ws: "OVITO Wigner–Seitz analysis against frame 0, tool removed: vacancies and interstitials.",
  dxa: "OVITO dislocation analysis (DXA): line length and density.",
  cn_cutoff: "Coordination by OVITO with this cutoff (Å). Empty: use the dump's c_cn column when present.",
};

/** p: the panel. ctx: {S, save, info(), spec()} */
export function buildResearchPanel(p, ctx) {
  const info = ctx.info();
  if (!info) { p.append(el("p", { class: "muted" }, "Open a trajectory first.")); return; }
  const R = ctx.S.research = { ...researchDefaults(), ...(ctx.S.research || {}) };
  R.sel = { ...researchDefaults().sel, ...(R.sel || {}) };
  const n = info.num_frames, save = ctx.save;
  const row = (label, c, tip) => el("label", { class: "frow", "data-tip": tip }, el("span", {}, label), el("div", { class: "fctl" }, c));
  const numIn = (obj, k, a = {}) => el("input", { class: "input num", type: "number", step: "any", value: obj[k] ?? "", onchange: e => { obj[k] = e.target.value === "" ? null : +e.target.value; save(); upd(); }, ...a });
  const chk = (k, label) => el("label", { class: "check", "data-tip": HELP[k] }, el("input", { type: "checkbox", checked: !!R[k], onchange: e => { R[k] = e.target.checked; save(); } }), label);
  const selBox = (k, opts) => el("select", { class: "select", onchange: e => { R[k] = e.target.value; save(); } }, opts.map(([v, l]) => el("option", { value: v, selected: String(R[k]) === v }, l)));
  const typeBox = el("div", {}), summary = el("div", { class: "fx-summary" }), modeBox = el("div", {}), status = el("div", {});

  async function loadDefaults(force) {
    clear(typeBox).append(loading("Reading run settings…"));
    try {
      const d = (await api.post("/api/ovito/research/defaults", { spec: ctx.spec() }, 120000)).body;
      if (force || !R.types) { R.types = d.types; R.tool_types = d.tool_types.length ? d.tool_types : (info.types.some(t => t.id === 1) ? [1] : []); }
      if (force || R.dt_ps == null) R.dt_ps = d.dt_ps ?? R.dt_ps;
      if (force) { R.structure = d.structure || R.structure; R.rake_deg = d.rake_deg ?? R.rake_deg; }
      R.defaultsFrom = d.source;
      save();
    } catch (e) { toast(`Defaults: ${e.message}`, "warn"); R.types = R.types || Object.fromEntries(info.types.map(t => [String(t.id), { name: t.name || "", mass: null, volume: null }])); R.tool_types = R.tool_types || []; }
    buildTypes();
  }
  function buildTypes() {
    clear(typeBox);
    const tbl = el("table", { class: "data compact" }, el("thead", {}, el("tr", {}, ["Type", "Tool", "Name", "Mass", "Ω (Å³)"].map(h => el("th", {}, h)))),
      el("tbody", {}, info.types.map(t => {
        const k = String(t.id), T = R.types[k] = R.types[k] || { name: t.name || "" };
        const inp = (f, w) => el("input", { class: "input num", type: f === "name" ? "text" : "number", step: "any", style: { width: w }, value: T[f] ?? "", "aria-label": `${f} of type ${k}`,
          onchange: e => { T[f] = f === "name" ? e.target.value : (e.target.value === "" ? null : +e.target.value); save(); } });
        return el("tr", {}, el("td", {}, `${k}`, el("span", { class: "muted small" }, ` ${num(t.count)}`)),
          el("td", {}, el("input", { type: "checkbox", checked: R.tool_types.includes(t.id), "aria-label": `Type ${k} is the tool`,
            onchange: e => { R.tool_types = e.target.checked ? [...new Set([...R.tool_types, t.id])] : R.tool_types.filter(x => x !== t.id); save(); upd(); } })),
          el("td", {}, inp("name", "52px")), el("td", {}, inp("mass", "74px")), el("td", {}, inp("volume", "74px")));
      })));
    typeBox.append(tbl, el("p", { class: "muted small" }, R.defaultsFrom ? `Prefilled from ${R.defaultsFrom}.` : "Enter masses and atomic volumes (needed for temperatures and stresses)."),
      el("div", { class: "field-row" }, el("button", { class: "btn ghost", type: "button", onclick: () => loadDefaults(true) }, "Reload defaults"),
        el("button", { class: "btn ghost", type: "button", "data-tip": "Median Voronoi volume of each type in frame 0", onclick: estimateVolumes }, "Estimate Ω (Voronoi)")));
  }
  async function estimateVolumes() {
    try {
      const v = await api.job("/api/ovito/research/volumes", { method: "POST", data: { spec: ctx.spec() } });
      for (const [k, x] of Object.entries(v)) { R.types[k] = R.types[k] || {}; R.types[k].volume = +x.toFixed(4); }
      save(); buildTypes(); toast("Atomic volumes set to the median Voronoi volume per type (frame 0).", "ok");
    } catch (e) { toast(e.message, "err"); }
  }
  function buildMode() {
    clear(modeBox);
    const S2 = R.sel;
    if (S2.mode === "interval") modeBox.append(row("Every n-th frame", numIn(S2, "interval", { min: 1, step: 1 })));
    else if (S2.mode === "range") modeBox.append(row("Start / end", el("div", { class: "duo" }, numIn(S2, "start", { min: 0, step: 1 }), numIn(S2, "end", { min: 0, step: 1, placeholder: `${n - 1}` }))), row("Step", numIn(S2, "step", { min: 1, step: 1 })));
    else modeBox.append(el("input", { class: "input mono", type: "text", value: S2.list, placeholder: "0, 50, 100-600:50", oninput: e => { S2.list = e.target.value; save(); upd(); } }));
  }
  let sel = { frames: [], errors: [] }, running = false;
  const btn = el("button", { class: "btn primary", type: "button", onclick: run }, "Analyse frames");
  function upd() {
    sel = selectFrames(R.sel, n);
    clear(summary).append(el("b", {}, `${num(sel.frames.length)} frames`), sel.frames.length ? el("span", { class: "muted small" }, ` (${sel.frames.slice(0, 8).join(", ")}${sel.frames.length > 8 ? " …" : ""})`) : null,
      ...sel.errors.map(m => el("div", { class: "status error small" }, m)));
    btn.disabled = !!sel.errors.length || running;
  }
  p.append(
    el("section", { class: "st-sec" }, el("h4", {}, "Research analysis"),
      el("p", { class: "muted small" }, "Per frame and per region (all atoms, tool, workpiece, NanoCut layers, each type, contact zone, chip, subsurface): every stress measure, temperatures, forces (Fc, Ft, μ, friction angle, specific energy, work), energies, displacement/MSD, coordination and structure fractions, atomic strain, damage depth, roughness, pile-up, chip; RDF, bond angles, histograms, depth profiles and maps. Plot and export everything in Graph Studio.")),
    el("section", { class: "st-sec" }, el("h4", {}, "Particle types"), typeBox),
    el("section", { class: "st-sec" }, el("h4", {}, "Run"),
      row("Time step (ps)", numIn(R, "dt_ps", { min: 0 }), "MD time step of the dumped run: time = step × dt (0.0005 ps = 0.5 fs)."),
      row("Tool moves", selBox("direction", [["-x", "towards −x (NanoCut)"], ["+x", "towards +x"]]), "Cutting along x, surface normal +y."),
      row("Rake angle α (°)", numIn(R, "rake_deg"), "Friction angle β = α + atan(Ft/Fc)."),
      row("Label", el("input", { class: "input", type: "text", value: R.label, placeholder: info?.label || "run label", onchange: e => { R.label = e.target.value; save(); } }), "Name of this dataset in Graph Studio (e.g. v = 200 m/s, d = 2 nm)")),
    el("section", { class: "st-sec" }, el("h4", {}, "Stress and structure"),
      row("Atomic volume", selBox("volume_mode", [["nominal", "nominal per type"], ["voronoi", "Voronoi per atom (OVITO)"]]), HELP.volume_mode),
      row("Structure", selBox("structure", [["diamond", "Identify diamond (SiC, Si)"], ["cna", "CNA (fcc, bcc, hcp)"], ["ptm", "PTM"], ["none", "none"]]), HELP.structure),
      row("CN cutoff (Å)", numIn(R, "cn_cutoff", { min: 0.5, placeholder: "dump c_cn" }), HELP.cn_cutoff),
      chk("strain", "Atomic strain vs frame 0"), row("Strain cutoff (Å)", numIn(R, "strain_cutoff", { min: 1.5 })), row("Plastic if η >", numIn(R, "strain_threshold", { min: 0 })),
      chk("ws", "Wigner–Seitz defects vs frame 0"), chk("dxa", "Dislocations (DXA)"),
      row("DXA lattice", selBox("dxa_lattice", [["CubicDiamond", "cubic diamond"], ["HexagonalDiamond", "hexagonal diamond"], ["FCC", "fcc"], ["BCC", "bcc"], ["HCP", "hcp"]]))),
    el("section", { class: "st-sec" }, el("h4", {}, "Zones"),
      row("Contact radius (Å)", numIn(R, "contact_radius", { min: 1 }), HELP.contact_radius), row("Chip threshold (Å)", numIn(R, "chip_threshold", { min: 0 }), HELP.chip_threshold),
      row("Subsurface depth (Å)", numIn(R, "subsurface_depth", { min: 1 }), HELP.subsurface_depth)),
    el("section", { class: "st-sec" }, el("h4", {}, "Distributions"),
      chk("rdf", "RDF g(r), total and partial"), row("r max / bins", el("div", { class: "duo" }, numIn(R, "rdf_rmax", { min: 2 }), numIn(R, "rdf_bins", { min: 20 }))),
      row("Centres per region ≤", numIn(R, "max_centers", { min: 100 }), "RDF/bond-angle centres are sub-sampled by atom id above this number."),
      chk("bad", "Bond-angle distribution"), row("Bond cutoff (Å)", numIn(R, "bond_cutoff", { min: 0.5, placeholder: "auto (RDF min)" }), HELP.bad),
      chk("hist", "Histograms"), chk("profiles", "Depth and length profiles"), row("Profile bin (Å)", numIn(R, "profile_bin", { min: 0.2 })),
      chk("maps", "2-D maps (x–y)"), row("Map bin (Å)", numIn(R, "map_bin", { min: 0.5 }))),
    el("section", { class: "st-sec" }, el("h4", {}, "Frames"),
      row("Mode", el("select", { class: "select", onchange: e => { R.sel.mode = e.target.value; save(); buildMode(); upd(); } },
        [["interval", "Every n-th frame"], ["range", "Range"], ["specific", "List"]].map(([v, l]) => el("option", { value: v, selected: R.sel.mode === v }, l)))),
      modeBox, summary, el("div", { class: "field-row" }, btn, el("a", { class: "btn ghost", href: "#/graphs" }, "Open Graph Studio")), status));
  buildMode(); upd();
  if (!R.types) loadDefaults(false); else buildTypes();

  async function run() {
    if (running) return;
    const missing = info.types.filter(t => !R.types?.[String(t.id)]?.volume).map(t => t.id);
    if (missing.length) toast(`No atomic volume for type(s) ${missing.join(", ")}: their stresses will be missing.`, "warn", 7000);
    running = true; upd();
    const token = Math.random().toString(16).slice(2);
    const box = loading(`OVITO analyses ${sel.frames.length} frames…`, true);
    let cancelled = false;
    clear(status).append(box, el("button", { class: "btn ghost", type: "button", onclick: () => { cancelled = true; api.post(`/api/ovito/frames/cancel/${token}`).catch(() => {}); } }, "Cancel"));
    const cfg = Object.fromEntries(Object.entries(R).filter(([k]) => !["sel", "label", "defaultsFrom"].includes(k)));
    try {
      const per = api.apiHosted() ? 3 : sel.frames.length;              // hosted: each request stays under 300 s
      let res = null;
      for (let k = 0; k < sel.frames.length; k += per) {
        if (cancelled) throw new Error("cancelled");
        const part = await api.job("/api/ovito/research", { method: "POST", pollMs: 500, timeoutMs: 24 * 3600e3, onProgress: x => box.update({ ...x, message: `${x.message || ""}${per < sel.frames.length ? ` · batch ${k / per + 1}` : ""}` }),
          data: { spec: ctx.spec(), frames: sel.frames.slice(k, k + per), cfg, token } });
        if (!res) res = part; else { res.rows.push(...part.rows); Object.assign(res.catalogue, part.catalogue); res.seconds += part.seconds; }
      }
      store.finalizeRows(res.rows, R.dt_ps);
      const label = R.label || info.label || ctx.S.last?.pattern || "analysis";
      const d = store.addResearch(res, label);
      clear(status).append(el("div", { class: "banner" }, `${res.rows.length} frames analysed (${Object.keys(res.catalogue).length} quantities per frame, OVITO ${res.ovito || ""}, ${res.seconds.toFixed(1)} s). Dataset “${d.label}” is in Graph Studio.`),
        ...[...new Set(res.rows.flatMap(r => r.notes || []))].map(m => el("div", { class: "banner warn" }, m)),
        summaryTable(res.rows[res.rows.length - 1].scalars),
        el("div", { class: "field-row" }, el("a", { class: "btn primary", href: "#/graphs" }, "Open Graph Studio"),
          el("button", { class: "btn", type: "button", onclick: () => download(`${safe(label)}.nanocut-results.json`, JSON.stringify(store.toJson(d)), "application/json") }, "Save results (.json)"),
          el("button", { class: "btn", type: "button", onclick: () => download(`${safe(label)}_all_quantities.csv`, scalarsCsv(d), "text/csv") }, "All quantities (.csv)")));
      toast("Research analysis finished.", "ok");
    } catch (e) { clear(status).append(errorState(e)); }
    finally { running = false; upd(); }
  }
}

const safe = s => String(s).replace(/[^\w.\-]+/g, "_");
const SUMMARY = [["Fc", "Cutting force Fc (nN)"], ["Ft", "Thrust force Ft (nN)"], ["mu", "μ = Fc/Ft"], ["specific_energy", "Specific energy (GPa)"],
  ["T_com@contact", "T contact zone (K)"], ["T_com@chip", "T chip (K)"], ["vir.von_mises_GPa@contact", "von Mises, contact (virial, GPa)"],
  ["von_mises.mean_GPa@contact", "von Mises, contact (mean per atom, GPa)"], ["vir.pressure_GPa@contact", "Pressure, contact (GPa)"],
  ["s1.p99_GPa@contact", "σ1 99th percentile, contact (GPa)"], ["tau_max.mean_GPa@contact", "τmax mean, contact (GPa)"], ["disordered_frac@contact", "Disordered fraction, contact"],
  ["damage_depth", "Damage depth (Å)"], ["pileup_max", "Pile-up (Å)"], ["chip_atoms", "Chip atoms"], ["Ra", "Ra (Å)"], ["rdf_peak_r@workpiece", "RDF 1st peak (Å)"]];
function summaryTable(S) {
  return el("table", { class: "data compact" }, el("caption", { class: "muted small" }, "Last analysed frame"),
    el("tbody", {}, SUMMARY.filter(([k]) => S[k] != null).map(([k, l]) => el("tr", {}, el("td", {}, l), el("td", { class: "num" }, num(S[k], 4))))));
}
export function scalarsCsv(d) {
  const keys = d.keys.map(k => k.key);
  const head = ["frame", ...keys.map(k => { const m = d.keys.find(x => x.key === k); return `${k} [${m.unit || "-"}]`; })];
  const rows = d.rows.map(r => [r.frame, ...keys.map(k => r.scalars[k] ?? "")].join(","));
  return [head.map(h => `"${h.replace(/"/g, "'")}"`).join(","), ...rows].join("\n");
}
