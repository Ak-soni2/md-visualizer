// Colour maps (perceptually ordered) and categorical palettes used by the viewer and the plots.
function lerpStops(stops) {
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255, k = Math.min(stops.length - 2, Math.floor(t * (stops.length - 1)));
    const f = t * (stops.length - 1) - k, a = stops[k], b = stops[k + 1];
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = a[c] + (b[c] - a[c]) * f;
  }
  return lut;
}
const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

export const MAPS = {
  inferno: lerpStops(["#000004", "#1b0c41", "#4a0c6b", "#781c6d", "#a52c60", "#cf4446", "#ed6925", "#fb9b06", "#f7d13d", "#fcffa4"].map(hex)),
  viridis: lerpStops(["#440154", "#482878", "#3e4989", "#31688e", "#26828e", "#1f9e89", "#35b779", "#6ece58", "#b5de2b", "#fde725"].map(hex)),
  cividis: lerpStops(["#00224e", "#123570", "#3b496c", "#575d6d", "#707173", "#8a8779", "#a69d75", "#c4b56c", "#e4cf5b", "#fee838"].map(hex)),
  diverging: lerpStops(["#2f5f9e", "#5d8cc4", "#a9c1dc", "#e6e3dc", "#e6b98f", "#d27f4f", "#a8432a"].map(hex)),
};
export const MAP_FOR = { sequential: "inferno", diverging: "diverging" };

export function cssGradient(name) {
  const lut = MAPS[name], stops = [];
  for (let i = 0; i <= 10; i++) { const j = Math.round(i * 25.5) * 3; stops.push(`rgb(${lut[j]},${lut[j + 1]},${lut[j + 2]}) ${i * 10}%`); }
  return `linear-gradient(90deg, ${stops.join(",")})`;
}

export const LAYERS = {
  1: { name: "Tool · Newtonian", color: "#8f949b" },
  2: { name: "Tool · thermostat", color: "#c98a3a" },
  3: { name: "Tool · fixed", color: "#4c5259" },
  4: { name: "Workpiece · Newtonian", color: "#6f9fd6" },
  5: { name: "Workpiece · thermostat", color: "#93b26a" },
  6: { name: "Workpiece · fixed", color: "#5b6878" },
};
export const ELEMENT_COLORS = { C: "#8f949b", Si: "#d6a548", Ge: "#c27c4f", Cu: "#c8743f", Al: "#a9b3bd", Ni: "#8fa3a0", Fe: "#b0714f", W: "#7f8aa3", Au: "#e0b84c", Ag: "#c9ccd1" };
export function typeLegend(types) {
  // type 1 is always the tool in NanoCut decks; workpiece types follow
  const out = {};
  (types || []).forEach((e, i) => {
    const t = i + 1;
    out[t] = { name: `${t}: ${e}${t === 1 ? " (tool)" : " (workpiece)"}`, color: t === 1 ? "#8f949b" : (e === "C" ? "#5f8fca" : (ELEMENT_COLORS[e] || "#d6a548")) };
  });
  if (!types || !types.length) { out[1] = { name: "1", color: "#8f949b" }; out[2] = { name: "2", color: "#d6a548" }; out[3] = { name: "3", color: "#5f8fca" }; }
  return out;
}
export const COORD = { 0: "#3d434a", 1: "#565d65", 2: "#7b828a", 3: "#c98a3a", 4: "#6f9fd6", 5: "#93b26a", 6: "#df6b5d", 7: "#d4b98a", 8: "#e9e6df" };
export function coordLegend() { const o = {}; for (let k = 0; k <= 8; k++) o[k] = { name: k === 4 ? "4 (sp³ crystal)" : (k === 8 ? "≥ 8" : String(k)), color: COORD[k] }; return o; }
export const LASER = { 0: { name: "outside laser zone", color: "#4a5560" }, 1: { name: "inside laser zone", color: "#f0b453" } };
export const MOCK_KIND = { 0: { name: "tool", color: "#8f949b" }, 1: { name: "workpiece", color: "#6f9fd6" }, 2: { name: "chip (schematic)", color: "#df6b5d" }, 3: { name: "damaged band (illustrative)", color: "#e2a23a" } };

export const SERIES_COLORS = ["#e2a23a", "#6f9fd6", "#df6b5d", "#a8b86a", "#c9c6be", "#c98fb0", "#5fb0c0", "#d4b98a"];
export { hex };
