// Tiny event bus + app state. The selected simulation is the main piece of shared state.
const listeners = new Map();
export const bus = {
  on(ev, fn) { (listeners.get(ev) ?? listeners.set(ev, new Set()).get(ev)).add(fn); return () => listeners.get(ev).delete(fn); },
  emit(ev, data) { listeners.get(ev)?.forEach(fn => { try { fn(data); } catch (e) { console.error(e); } }); },
};

const KEY = "nanocut.sim";
export const state = {
  sims: [],
  simId: (() => { try { return localStorage.getItem(KEY); } catch { return null; } })(),
  setSims(list) { this.sims = list; bus.emit("sims", list); },
  sim() { return this.sims.find(s => s.id === this.simId) || null; },
  select(id) {
    if (id === this.simId) return;
    this.simId = id;
    try { localStorage.setItem(KEY, id); } catch { /* private mode: selection simply is not remembered */ }
    bus.emit("sim", this.sim());
  },
};
