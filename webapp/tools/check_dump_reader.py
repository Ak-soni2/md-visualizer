"""The browser's dump reader (frontend/js/studio/dumpparse.js) against the backend's studio.py, on the same files.

    .venv\\Scripts\\python webapp\\tools\\check_dump_reader.py          (needs Node.js 20+)

Cases: the sample run (frame 2 vs 0, displacements), and synthetic dumps with a triclinic cell, scaled coordinates,
an element column, shuffled ids, three frames in one file without a final newline, and a gzip file.
Tolerance: ids/types/steps/cell exact; positions and displacements within 4 float32 ulps of the largest coordinate
(the backend rounds positions to float32 before subtracting, the browser parses in float64 and rounds the result, so
the browser's values are the more precise ones); other values within 2 ulps of themselves.
"""
import gzip
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from webapp.backend.app import studio  # noqa: E402

PARSE = (ROOT / "webapp" / "frontend" / "js" / "studio" / "dumpparse.js").as_uri()
COLS = ["id", "x", "y", "z", "type", "v_magnitude", "dx", "dy", "dz", "displacement"]


def synthetic(d):
    rng = np.random.default_rng(7)
    n = 500

    def frame(step, shift):
        xy, xz, yz = 2.5, -1.25, 0.75
        L = (30.0, 20.0, 10.0)
        ids = rng.permutation(np.arange(101, 101 + n))
        s = (rng.random((n, 3)) + shift) % 1.0
        typ = rng.integers(1, 3, n)
        v = rng.normal(size=(n, 3))
        head = ["ITEM: TIMESTEP", str(step), "ITEM: NUMBER OF ATOMS", str(n), "ITEM: BOX BOUNDS xy xz yz pp ss pp",
                f"{min(0, xy, xz, xy + xz)} {L[0] + max(0, xy, xz, xy + xz)} {xy}", f"{min(0, yz)} {L[1] + max(0, yz)} {xz}",
                f"0.0 {L[2]} {yz}", "ITEM: ATOMS id type element xs ys zs vx vy vz"]
        rows = [f"{ids[i]} {typ[i]} {'Si' if typ[i] == 1 else 'C'} {s[i, 0]:.6f} {s[i, 1]:.6f} {s[i, 2]:.6f} "
                f"{v[i, 0]:.5g} {v[i, 1]:.5g} {v[i, 2]:.5g}" for i in range(n)]
        return "\n".join(head + rows) + "\n"

    (d / "multi.lammpstrj").write_text((frame(0, 0.0) + frame(1000, 0.37) + frame(2000, 0.81)).rstrip("\n"))
    with gzip.open(d / "one.lammpstrj.gz", "wt") as f:
        f.write(frame(5, 0.1))


def expected(path, index, ref, pattern=None):
    src = studio.open_source(str(path), pattern)
    meta = studio.load_frame(src["id"], index, ref)
    names = [c for c in COLS if c in meta["columns"]]
    raw = studio.columns_bytes(src["id"], index, names, ref)
    n = meta["natoms"]
    cols = {c: np.frombuffer(raw, "<u4" if c == "id" else "<f4", n, k * n * 4).tolist() for k, c in enumerate(names)}
    return dict(steps=src["steps"], n_frames=src["n_frames"], meta={k: meta.get(k) for k in ("step", "natoms", "cell", "columns", "types", "reference")}, cols=cols)


NODE = r"""
import { openAsBlob } from "node:fs";
import { readFrame, buildFrame, indexFile, displacement } from "%s";
const cases = JSON.parse(process.argv[1]);
const out = [];
for (const c of cases) {
  const blobs = await Promise.all(c.files.map(f => openAsBlob(f)));
  let frames, steps;
  if (blobs.length === 1 && !c.gz) {
    const ix = await indexFile(blobs[0]);
    frames = ix.offsets.map((o, k) => [blobs[0], o, ix.offsets[k + 1] ?? blobs[0].size]);
    steps = ix.steps;
  } else { frames = blobs.map(b => [b, 0, b.size]); steps = c.nums; }
  const load = async i => buildFrame(await readFrame(frames[i][0], frames[i][1], frames[i][2], c.gz));
  const fr = await load(c.index), meta = { ...fr.meta };
  let D = null;
  if (c.ref != null) {
    D = displacement(fr, await load(c.ref), fr.meta.cell);
    meta.reference = { index: c.ref, step: steps[c.ref], ...D.info };
    meta.columns = [...meta.columns, "dx", "dy", "dz", "displacement"];
  }
  const cols = {};
  for (const k of c.cols) cols[k] = Array.from(k === "id" ? fr.ids : fr.cols[k] ?? D.cols[k]);
  out.push({ steps, n_frames: frames.length, meta, cols });
}
process.stdout.write(JSON.stringify(out));
""" % PARSE


POSITIONAL = {"x", "y", "z", "dx", "dy", "dz", "displacement"}


def ulps(a, b, scale=None):
    """Largest difference in float32 ulps, of `scale` (positional columns) or of the values themselves."""
    a, b = np.asarray(a, np.float32), np.asarray(b, np.float32)
    if np.any(np.isnan(a) != np.isnan(b)):
        return np.inf
    sp = np.spacing(np.float32(scale)) if scale else np.spacing(np.maximum(np.abs(a), np.abs(b))).astype(np.float64)
    d = np.abs(a.astype(np.float64) - b.astype(np.float64)) / np.where(sp > 0, sp, 1)
    return float(np.nanmax(d)) if len(a) else 0.0


def main():
    fails = []
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        synthetic(d)
        sample = sorted((ROOT / "examples" / "sample_run").glob("*_cut.*.lammpstrj"), key=lambda p: int(p.name.split(".")[-2]))
        cases = [
            dict(name="sample run, frame 2 vs 0", files=[str(p) for p in sample], nums=[int(p.name.split(".")[-2]) for p in sample],
                 gz=False, index=2, ref=0, exp=expected(sample[0].parent, 2, 0, "cut_SiC_R10_d10_preview_cut.*.lammpstrj")),
            dict(name="triclinic, scaled, element, 3 frames in one file", files=[str(d / "multi.lammpstrj")], gz=False, index=2, ref=0,
                 exp=expected(d / "multi.lammpstrj", 2, 0)),
            dict(name="gzip, one frame", files=[str(d / "one.lammpstrj.gz")], nums=[5], gz=True, index=0, ref=None,
                 exp=expected(d / "one.lammpstrj.gz", 0, None)),
        ]
        for c in cases:
            c["cols"] = list(c["exp"]["cols"])
        got = json.loads(subprocess.run(["node", "--input-type=module", "-e", NODE, json.dumps([{k: v for k, v in c.items() if k != "exp"} for c in cases])],
                                        capture_output=True, text=True, check=True).stdout)
    for c, g in zip(cases, got):
        e = c["exp"]
        checks = [("steps", g["steps"] == e["steps"]), ("frames", g["n_frames"] == e["n_frames"])]
        checks += [(k, g["meta"].get(k) == e["meta"][k]) for k in ("step", "natoms", "cell", "columns", "types", "reference")]
        scale = max(float(np.max(np.abs(e["cols"][k]))) for k in ("x", "y", "z"))
        err = {k: ulps(g["cols"][k], v, scale if k in POSITIONAL else None) for k, v in e["cols"].items() if k not in ("id", "type")}
        checks += [(k, g["cols"][k] == e["cols"][k]) for k in ("id", "type")]
        checks += [(k, u <= (4 if k in POSITIONAL else 2)) for k, u in err.items()]
        bad = [k for k, ok in checks if not ok]
        worst = max(err.values(), default=0)
        print(("PASS " if not bad else "FAIL ") + c["name"] + f"  [max {worst:.1f} float32 ulp]" + (f"  differs: {bad}" if bad else ""))
        fails += bad
    print("\nALL CHECKS PASSED" if not fails else f"\n{len(fails)} FAILED")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
