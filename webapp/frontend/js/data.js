// Cached per-simulation requests shared by the views.
import * as api from "./api.js";
import { bus } from "./state.js";

const overviews = new Map();
bus.on("refresh", () => overviews.clear());

export function overview(id) {
  if (!overviews.has(id)) overviews.set(id, api.get(`/api/simulations/${encodeURIComponent(id)}`).catch(e => { overviews.delete(id); throw e; }));
  return overviews.get(id);
}

/** Model summary; for presets/references it is computed in a background job (onProgress receives the job record). */
export async function model(id, onProgress) {
  const ov = await overview(id);
  if (ov.model) return { model: ov.model, source: ov.sources.model };
  const res = await api.job(`/api/simulations/${encodeURIComponent(id)}/model`, { onProgress });
  overviews.delete(id);
  return { model: res?.result ?? res, source: "computed by geometry.Model" };
}

export const enc = encodeURIComponent;
