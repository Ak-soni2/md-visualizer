// Web Worker: reads LAMMPS text dumps from File objects in the browser (nothing is uploaded). See dumpparse.js.
import { readFrame, buildFrame, indexFile, head } from "./dumpparse.js";

self.onmessage = async e => {
  const { id, op, file, start = 0, end = 0, gz = false } = e.data;
  const progress = (p, msg) => self.postMessage({ id, progress: p, message: msg });
  try {
    if (op === "index") self.postMessage({ id, result: await indexFile(file, progress) });
    else if (op === "head") self.postMessage({ id, result: await head(file, start, gz) });
    else if (op === "parse") {
      const fr = buildFrame(await readFrame(file, start, end || file.size, gz, progress));
      const transfer = [fr.ids.buffer, fr.pos.buffer, ...Object.values(fr.cols).map(c => c.buffer)];
      self.postMessage({ id, result: fr }, transfer);
    } else throw new Error(`unknown op ${op}`);
  } catch (err) {
    self.postMessage({ id, error: err.message || String(err) });
  }
};
