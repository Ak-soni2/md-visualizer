// LAMMPS text dump reader for the browser (used by dumpworker.js; pure functions, also run by tools/check_dump_reader).
// A port of backend/app/studio.py (read_header, _index_file, _parse, _build_frame) with the same rules:
// atoms sorted by id, positions from x/xu/xs/xsu in that order of preference, triclinic cells recovered from the
// bounding box, |v| from vx vy vz. Numbers are parsed with JavaScript's correctly rounded Number(); positions are
// kept in float64 for displacements, every column is handed to the viewer as float32 (as the backend does).
const CHUNK = 32 << 20;
const KEY = "ITEM: TIMESTEP";

async function* textChunks(file, start, end, gz) {
  const dec = new TextDecoder();
  if (gz) {
    const r = file.stream().pipeThrough(new DecompressionStream("gzip")).getReader();
    try {
      for (;;) {
        const { done, value } = await r.read();
        if (done) break;
        yield dec.decode(value, { stream: true });
      }
    } finally { r.cancel().catch(() => {}); }
  } else {
    for (let a = start; a < end; a += CHUNK) {
      const buf = await file.slice(a, Math.min(end, a + CHUNK)).arrayBuffer();
      yield dec.decode(new Uint8Array(buf), { stream: true });
    }
  }
  const tail = dec.decode();
  if (tail) yield tail;
}

export function parseHeader(lines) {
  if (!lines[0].startsWith(KEY)) throw new Error("frame does not start with 'ITEM: TIMESTEP'");
  const flags = lines[4].trim().split(/\s+/).slice(3);
  const tilt = lines[4].includes("xy");
  const b = [5, 6, 7].map(i => lines[i].trim().split(/\s+/).map(Number));
  const [xloB, xhiB] = b[0], [yloB, yhiB] = b[1], [zlo, zhi] = b[2];
  const [xy, xz, yz] = tilt ? [b[0][2], b[1][2], b[2][2]] : [0, 0, 0];
  // LAMMPS writes bounding-box bounds for triclinic cells; recover the cell (dump documentation, "triclinic")
  const xlo = xloB - Math.min(0, xy, xz, xy + xz), xhi = xhiB - Math.max(0, xy, xz, xy + xz);
  const ylo = yloB - Math.min(0, yz), yhi = yhiB - Math.max(0, yz);
  const f3 = flags.length >= 3 ? flags.slice(-3) : ["pp", "pp", "pp"];
  const cell = { origin: [xlo, ylo, zlo], a: [xhi - xlo, 0, 0], b: [xy, yhi - ylo, 0], c: [xz, yz, zhi - zlo],
    pbc: f3.map(f => f.startsWith("p")), flags: flags.slice(-3), triclinic: tilt };
  return { step: parseInt(lines[1], 10), natoms: parseInt(lines[3], 10), cell, columns: lines[8].trim().split(/\s+/).slice(2) };
}

function num(tok) {
  const v = +tok;
  if (v === v) return v;
  return /^\+?inf/i.test(tok) ? Infinity : /^-inf/i.test(tok) ? -Infinity : NaN;
}

export async function readFrame(file, start, end, gz, progress) {
  const hdr = [];
  let h = null, n = 0, k = 0, ncol = 0, data = null, isStr = null, carry = "", read = 0;
  const strs = {};
  const total = Math.max(1, (gz ? file.size * 4 : end - start));
  const row = line => {
    let i = 0, c = 0;
    const L = line.length;
    while (c < ncol) {
      while (i < L && line.charCodeAt(i) <= 32) i++;
      let j = i;
      while (j < L && line.charCodeAt(j) > 32) j++;
      if (j === i) throw new Error(`atom line ${k + 1} has ${c} of ${ncol} values`);
      const tok = line.substring(i, j);
      if (k === 0 && !(num(tok) === num(tok) || /^[+-]?(nan|inf)/i.test(tok))) {
        isStr[c] = 1; strs[c] = new Array(n);                 // text column (e.g. element names)
      }
      if (isStr[c]) strs[c][k] = tok; else data[c][k] = num(tok);
      i = j; c++;
    }
    k++;
  };
  outer: for await (const chunk of textChunks(file, start, end, gz)) {
    read += chunk.length;
    const text = carry + chunk;
    let pos = 0;
    for (;;) {
      const nl = text.indexOf("\n", pos);
      if (nl < 0) break;
      const line = text.substring(pos, nl);
      pos = nl + 1;
      if (!h) {
        hdr.push(line);
        if (hdr.length === 9) {
          h = parseHeader(hdr);
          n = h.natoms; ncol = h.columns.length;
          data = h.columns.map(() => new Float64Array(n));
          isStr = new Uint8Array(ncol);
        }
        continue;
      }
      if (k >= n) break outer;
      row(line);
    }
    carry = text.substring(pos);
    progress?.(Math.min(0.9, 0.05 + 0.85 * read / total), `parsing ${(read / 1e6).toFixed(0)} MB`);
  }
  if (h && k < n && carry.trim()) row(carry);                // last line without a newline
  if (!h) throw new Error("not a complete LAMMPS dump frame (header missing)");
  if (k !== n) throw new Error(`incomplete frame: ${k} of ${n} atoms (file still being written?)`);
  return { h, data, isStr, strs };
}

function sortOrder(ids) {
  const n = ids.length;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) { const v = ids[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
  if (n && hi - lo + 1 === n && Number.isInteger(lo)) {      // ids 1..N (the usual case): place directly
    const order = new Int32Array(n).fill(-1);
    let ok = true;
    for (let i = 0; i < n; i++) {
      const s = ids[i] - lo;
      if (!Number.isInteger(s) || order[s] !== -1) { ok = false; break; }
      order[s] = i;
    }
    if (ok) return order;
  }
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  return order.sort((a, b) => ids[a] - ids[b] || a - b);     // stable, like numpy's kind="stable"
}

export function buildFrame({ h, data, isStr, strs }) {
  const n = h.natoms, names = h.columns;
  const col = name => { const j = names.indexOf(name); return j >= 0 && !isStr[j] ? data[j] : null; };
  const rawIds = col("id") || Float64Array.from({ length: n }, (_, i) => i + 1);
  const order = sortOrder(rawIds);
  const ids = new Uint32Array(n);
  for (let i = 0; i < n; i++) ids[i] = rawIds[order[i]];
  const sorted = a => { const o = new Float64Array(n); for (let i = 0; i < n; i++) o[i] = a[order[i]]; return o; };
  const c64 = {};
  const typeNames = {};
  names.forEach((name, j) => { if (name !== "id" && !isStr[j]) c64[name] = sorted(data[j]); });   // other text columns are skipped, as in the backend
  const ej = names.indexOf("element");
  if (ej >= 0 && isStr[ej]) {
    const el = new Array(n);
    for (let i = 0; i < n; i++) el[i] = strs[ej][order[i]];
    if (c64.type) {
      for (let i = 0; i < n; i++) { const t = c64.type[i]; if (!(t in typeNames)) typeNames[t] = el[i]; }
    } else {
      const uniq = [...new Set(el)].sort();
      const code = new Map(uniq.map((u, i) => [u, i + 1]));
      c64.type = Float64Array.from(el, e => code.get(e));
      uniq.forEach((u, i) => { typeNames[i + 1] = u; });
    }
  }
  const { cell } = h, o = cell.origin, H = [cell.a, cell.b, cell.c];
  const has = t => t.every(c => c in c64);
  if (!has(["x", "y", "z"])) {
    for (const [trio, kind] of [[["xu", "yu", "zu"], "abs"], [["xs", "ys", "zs"], "scaled"], [["xsu", "ysu", "zsu"], "scaled"]]) {
      if (!has(trio)) continue;
      if (kind === "abs") [c64.x, c64.y, c64.z] = trio.map(t => c64[t]);
      else {
        const [s0, s1, s2] = trio.map(t => c64[t]), X = new Float64Array(n), Y = new Float64Array(n), Z = new Float64Array(n);
        for (let i = 0; i < n; i++) {                        // r = origin + s @ H (cell vectors as rows)
          const a = s0[i], b = s1[i], c = s2[i];
          X[i] = o[0] + a * H[0][0] + b * H[1][0] + c * H[2][0];
          Y[i] = o[1] + a * H[0][1] + b * H[1][1] + c * H[2][1];
          Z[i] = o[2] + a * H[0][2] + b * H[1][2] + c * H[2][2];
        }
        c64.x = X; c64.y = Y; c64.z = Z;
      }
      break;
    }
  }
  if (!has(["x", "y", "z"])) throw new Error("dump has no atom positions (need x y z, xu yu zu or xs ys zs)");
  if (!c64.type) c64.type = new Float64Array(n).fill(1);
  if (has(["vx", "vy", "vz"])) {
    const v = new Float64Array(n), { vx, vy, vz } = c64;
    for (let i = 0; i < n; i++) v[i] = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i] + vz[i] * vz[i]);
    c64.v_magnitude = v;
  }
  const counts = new Map();
  for (let i = 0; i < n; i++) { const t = Math.trunc(c64.type[i]); counts.set(t, (counts.get(t) || 0) + 1); }
  const types = [...counts.keys()].sort((a, b) => a - b).map(t => ({ id: t, count: counts.get(t), name: typeNames[t] ?? null }));
  const stats = n ? { id: { min: ids[0], max: ids[n - 1] } } : {};
  const cols = {};
  for (const [c, v] of Object.entries(c64)) {
    let lo = Infinity, hi = -Infinity;
    const f = new Float32Array(v);
    for (let i = 0; i < n; i++) { const x = f[i]; if (x < lo) lo = x; if (x > hi) hi = x; }   // nanmin/nanmax of the float32 values
    stats[c] = n ? { min: lo === Infinity ? NaN : lo, max: hi === -Infinity ? NaN : hi } : { min: 0, max: 0 };
    cols[c] = f;
  }
  const pos = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) { pos[3 * i] = c64.x[i]; pos[3 * i + 1] = c64.y[i]; pos[3 * i + 2] = c64.z[i]; }
  const columns = Object.keys(cols).sort((a, b) => {
    const ka = !["x", "y", "z", "type"].includes(a), kb = !["x", "y", "z", "type"].includes(b);
    return ka !== kb ? (ka ? 1 : -1) : a < b ? -1 : a > b ? 1 : 0;
  }).concat(["id"]);
  return { meta: { step: h.step, natoms: n, cell, dump_columns: h.columns, columns, types, stats }, ids, cols, pos };
}

export async function indexFile(file, progress) {
  // byte offsets of every 'ITEM: TIMESTEP' that starts a line, and the step written below each
  const key = new TextEncoder().encode(KEY), K = key.length, offsets = [];
  let prev = 10;                                             // byte before the chunk ("\n" at file start)
  for (let a = 0; a < file.size; a += CHUNK) {
    const b = Math.min(file.size, a + CHUNK + K - 1);
    const u = new Uint8Array(await file.slice(a, b).arrayBuffer());
    const lim = Math.min(u.length - K, CHUNK - 1);
    for (let i = 0; i <= lim; i++) {
      if (u[i] !== 73) continue;                             // 'I'
      if ((i ? u[i - 1] : prev) !== 10) continue;
      let m = 1;
      while (m < K && u[i + m] === key[m]) m++;
      if (m === K) offsets.push(a + i);
    }
    prev = u[Math.min(u.length, CHUNK) - 1];
    progress?.(0.05 + 0.85 * Math.min(1, b / file.size), `indexing frames ${(b / 1e6).toFixed(0)}/${(file.size / 1e6).toFixed(0)} MB`);
  }
  const steps = [];
  for (const off of offsets) {
    const t = await file.slice(off, off + 256).text();
    steps.push(parseInt(t.split("\n")[1], 10));
  }
  return { offsets, steps };
}

export async function head(file, start, gz) {
  const lines = [];
  let carry = "";
  for await (const chunk of textChunks(file, start, gz ? 0 : Math.min(file.size, start + 65536), gz)) {
    const parts = (carry + chunk).split("\n");
    carry = parts.pop();
    lines.push(...parts);
    if (lines.length >= 9) break;
  }
  return parseHeader(lines.slice(0, 9));
}

const rint = x => { const r = Math.round(x); return Math.abs(x % 1) === 0.5 && r % 2 ? r - 1 : r; };   // numpy round: half to even

/** r(current) - r(reference) per atom id; minimum image along periodic cell vectors (OVITO "Displacement vectors"). */
export function displacement(fr, rf, cell) {
  const n = fr.ids.length, P = fr.pos, Q = rf.pos, A = fr.ids, B = rf.ids, m = B.length;
  const H = [cell.a, cell.b, cell.c], pbc = cell.pbc, anyPbc = pbc.some(Boolean);
  // inverse of H (rows a, b, c), for fractional coordinates s = d @ inv(H)
  const [a, b, c] = H;
  const det = a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  const I = [
    [(b[1] * c[2] - b[2] * c[1]) / det, (a[2] * c[1] - a[1] * c[2]) / det, (a[1] * b[2] - a[2] * b[1]) / det],
    [(b[2] * c[0] - b[0] * c[2]) / det, (a[0] * c[2] - a[2] * c[0]) / det, (a[2] * b[0] - a[0] * b[2]) / det],
    [(b[0] * c[1] - b[1] * c[0]) / det, (a[1] * c[0] - a[0] * c[1]) / det, (a[0] * b[1] - a[1] * b[0]) / det],
  ];
  const dx = new Float32Array(n), dy = new Float32Array(n), dz = new Float32Array(n), dd = new Float32Array(n);
  let j = 0, missing = 0;
  for (let i = 0; i < n; i++) {
    while (j < m - 1 && B[j] < A[i]) j++;                     // both id-sorted
    if (B[j] !== A[i]) { dx[i] = dy[i] = dz[i] = dd[i] = NaN; missing++; continue; }
    let d0 = P[3 * i] - Q[3 * j], d1 = P[3 * i + 1] - Q[3 * j + 1], d2 = P[3 * i + 2] - Q[3 * j + 2];
    if (anyPbc) {
      let s0 = d0 * I[0][0] + d1 * I[1][0] + d2 * I[2][0], s1 = d0 * I[0][1] + d1 * I[1][1] + d2 * I[2][1], s2 = d0 * I[0][2] + d1 * I[1][2] + d2 * I[2][2];
      if (pbc[0]) s0 -= rint(s0);
      if (pbc[1]) s1 -= rint(s1);
      if (pbc[2]) s2 -= rint(s2);
      d0 = s0 * H[0][0] + s1 * H[1][0] + s2 * H[2][0];
      d1 = s0 * H[0][1] + s1 * H[1][1] + s2 * H[2][1];
      d2 = s0 * H[0][2] + s1 * H[1][2] + s2 * H[2][2];
    }
    dx[i] = d0; dy[i] = d1; dz[i] = d2; dd[i] = Math.sqrt(d0 * d0 + d1 * d1 + d2 * d2);
  }
  const cols = { dx, dy, dz, displacement: dd }, stats = {};
  for (const [k, v] of Object.entries(cols)) {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) { const x = v[i]; if (x < lo) lo = x; if (x > hi) hi = x; }
    stats[k] = { min: lo === Infinity ? NaN : lo, max: hi === -Infinity ? NaN : hi };
  }
  return { cols, stats, info: { missing, minimum_image: pbc.map(Boolean) } };
}
