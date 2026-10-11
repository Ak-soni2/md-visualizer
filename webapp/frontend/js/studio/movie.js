// Movie export: frames rendered by the Studio (same image as Render, overlays included) encoded in the browser with
// WebCodecs and written as MP4 (mp4-muxer), or saved as a numbered PNG sequence into a folder (lossless, for ffmpeg).
// Every frame gets exactly 1/fps seconds; timing never depends on how long a frame took to load.
import { Muxer, ArrayBufferTarget } from "../vendor/mp4-muxer.mjs";

// H.264 first (plays in PowerPoint, Word, every player), then VP9 / AV1 in MP4 when H.264 is not available
const CODECS = [["avc1.640034", "avc", "H.264 High"], ["avc1.4d0034", "avc", "H.264 Main"], ["avc1.42003e", "avc", "H.264 Baseline"],
  ["vp09.00.51.08", "vp9", "VP9"], ["av01.0.12M.08", "av1", "AV1"]];

export const canEncode = () => typeof VideoEncoder === "function" && typeof VideoFrame === "function";
export const canWriteFolder = () => typeof window.showDirectoryPicker === "function";

/** First codec this browser encodes at w x h; w and h must be even. Returns {cfg, mux, label} or null. */
export async function pickCodec(w, h, fps, bitrate) {
  if (!canEncode()) return null;
  for (const [codec, mux, label] of CODECS) {
    const cfg = { codec, width: w, height: h, bitrate, framerate: fps, latencyMode: "quality", ...(mux === "avc" ? { avc: { format: "avc" } } : {}) };
    try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) return { cfg, mux, label }; } catch { /* try the next codec */ }
  }
  return null;
}

export function mp4Writer({ cfg, mux }, fps) {
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({ target, video: { codec: mux, width: cfg.width, height: cfg.height, frameRate: fps }, fastStart: "in-memory" });
  let err = null, k = 0;
  const enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: e => { err = e; } });
  enc.configure(cfg);
  const gop = Math.max(1, Math.round(fps * 2));              // a key frame every 2 s, so players can seek
  return {
    async add(canvas) {
      if (err) throw err;
      while (enc.encodeQueueSize > 4) await new Promise(r => setTimeout(r, 5));
      const vf = new VideoFrame(canvas, { timestamp: Math.round(k * 1e6 / fps), duration: Math.round(1e6 / fps) });
      enc.encode(vf, { keyFrame: k % gop === 0 });
      vf.close();
      k++;
    },
    async finish() {
      await enc.flush();
      if (err) throw err;
      enc.close();
      muxer.finalize();
      return new Blob([target.buffer], { type: "video/mp4" });
    },
    abort() { try { enc.close(); } catch { /* already closed */ } },
  };
}

/** PNG sequence into a folder the user picks (written frame by frame, so length is not limited by memory). */
export async function pngFolderWriter(prefix) {
  const dir = await window.showDirectoryPicker({ mode: "readwrite", id: "nanocut-frames" });
  let n = 0;
  return {
    folder: dir.name,
    async add(canvas, label) {
      const blob = await new Promise(r => canvas.toBlob(r, "image/png"));
      const fh = await dir.getFileHandle(`${prefix}_${label}.png`, { create: true });
      const w = await fh.createWritable();
      await w.write(blob); await w.close();
      n++;
    },
    count: () => n,
  };
}
