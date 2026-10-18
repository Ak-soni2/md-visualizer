// "Help" in the bottom-left corner of the sidebar: what each tab is for, and the usual order of work.
import { el } from "./ui.js";

const TABS = [
  ["Workspace", "Alt 1", "Start here. Project explorer and the list of simulations (run folders, reference decks, presets); pick the run the other tabs show."],
  ["Overview", "Alt 2", "Summary of the selected run: material, tool, process, laser, output settings, atom counts per layer, trajectory facts, warnings and missing data."],
  ["Visualizer", "Alt 3", "3-D atoms of the run frame by frame (GPU): colour by temperature, coordination, stress, energy, speed, layer or type; play the cut; overlays (surface, tool, depth line)."],
  ["Analysis", "Alt 4", "Force and temperature curves from the run's force file vs cutting distance, steady-state averages, Fc/Ft, per-frame metrics (pile-up, contact-zone T), run comparison."],
  ["Parameters", "Alt 5", "Every parameter with where it comes from: a deck line (click to open it), computed, editable or missing."],
  ["Decks", "Alt 6", "Build LAMMPS input decks A (build + equilibrate) and B (cut) from all parameters: material, potential, tool shape, depth, speed, laser, thermostats, output. Download A/B and params.json."],
  ["Validation", "Alt 7", "Checks per simulation: files parse, decks agree with the reference, potential files verified; re-run the checks."],
  ["Studio", "Alt 8", "OVITO-style viewer that reads any dump file in the browser: pipeline (slice, select, colour coding, displacements), pile-up tab, publication PNG and MP4 movies."],
  ["OVITO", "Alt 9", "The official OVITO engine on any dump folder, file, upload or HPC cluster. Side tabs: Pipeline (modifiers), Render (images), Export (CSV ZIP, statistics, Excel), Ductile–brittle (regime per frame), Measure (pile-up height, two-point distances), Research (every stress, temperature, force, structure, RDF … per frame and region), Results, More."],
  ["Graphs", "Alt 0", "Graph Studio: plot any analysed quantity against any other (force vs distance, temperature vs speed, correlations, RDF, maps …), style everything (grids, titles, fonts, sizes), download PNG, JPEG, TIFF, WebP, SVG, PDF, EPS, PS or a ZIP of all graphs with their data."],
];
const FLOW = [
  "Generate decks (Decks) → run them on your PC or cluster with LAMMPS.",
  "Open the dumps: OVITO tab → Open folder… (or HPC… for files on the cluster).",
  "OVITO → Research: choose frames → Analyse frames (stresses, temperatures, forces, structure, RDF …).",
  "Graphs → Generate all graphs → adjust titles, grids and sizes → Download all as ZIP.",
  "Several runs (different speed, depth …): analyse each, set its run parameters (Graphs → Data → Edit), then use “Across runs” figures (e.g. temperature vs cutting speed).",
];

export function openGuide() {
  const back = el("div", { class: "modal-backdrop open", role: "dialog", "aria-modal": "true", "aria-label": "Help: what each tab does", onclick: e => { if (e.target === back) back.remove(); } },
    el("div", { class: "modal wide" },
      el("div", { class: "panel-head" }, el("h3", {}, "Help — what each tab does"),
        el("div", { class: "actions" }, el("button", { class: "btn", type: "button", onclick: () => back.remove() }, "Close ", el("span", { class: "kbd" }, "Esc")))),
      el("div", { class: "panel-body grid1", style: { maxHeight: "75vh", overflow: "auto" } },
        el("table", { class: "data guide" }, el("tbody", {}, TABS.map(([t, k, d]) => el("tr", {},
          el("th", {}, el("a", { href: `#/${t.toLowerCase()}`, onclick: () => back.remove() }, t)), el("td", { class: "muted small" }, k), el("td", {}, d))))),
        el("h4", {}, "Typical workflow"), el("ol", { class: "guide-flow" }, FLOW.map(s => el("li", {}, s))),
        el("p", { class: "muted small" }, "Keyboard: Alt+1 … Alt+0 switch tabs, ? shows shortcuts, Esc closes dialogs. Hover any control with a dotted underline or ⓘ for its explanation. Full documentation: README.md, webapp/README.md, BIBLE.md in the program folder."))));
  const esc = e => { if (e.key === "Escape") { back.remove(); document.removeEventListener("keydown", esc); } };
  document.addEventListener("keydown", esc);
  document.body.append(back);
}

export function mountGuideButton(foot) {
  foot.prepend(el("button", { class: "btn guide-btn", type: "button", "data-tip": "What each tab is for, and the usual workflow", onclick: openGuide },
    el("span", { class: "guide-q", "aria-hidden": "true" }, "?"), el("span", { class: "guide-label" }, "Help — what each tab does")));
}
