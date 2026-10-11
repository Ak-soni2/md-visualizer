// Minimal ZIP writer for the browser (hosted CSV exports): DEFLATE via the built-in CompressionStream, CRC-32,
// standard local headers + central directory (no ZIP64, so the archive must stay below 4 GB). Output: a Blob.
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(bytes, c = 0xffffffff) {
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return c;
}
const u16 = v => [v & 255, (v >>> 8) & 255], u32 = v => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];

export class ZipWriter {
  constructor() { this.parts = []; this.central = []; this.offset = 0; }
  /** add one file; data: Blob (read and compressed as a stream) */
  async add(name, data) {
    const nameBytes = new TextEncoder().encode(name);
    let crc = 0xffffffff, size = 0;
    const counted = data.stream().pipeThrough(new TransformStream({ transform(chunk, ctl) { crc = crc32(chunk, crc); size += chunk.length; ctl.enqueue(chunk); } }));
    const comp = await new Response(counted.pipeThrough(new CompressionStream("deflate-raw"))).blob();
    crc = (crc ^ 0xffffffff) >>> 0;
    if (this.offset + comp.size + size > 0xfffffff0) throw new Error("the ZIP would exceed 4 GB; select fewer frames");
    const d = new Date(), time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const common = [...u16(20), ...u16(0x0800), ...u16(8), ...u16(time), ...u16(date), ...u32(crc), ...u32(comp.size), ...u32(size), ...u16(nameBytes.length), ...u16(0)];
    const local = new Uint8Array([...u32(0x04034b50), ...common, ...nameBytes]);
    this.central.push(new Uint8Array([...u32(0x02014b50), ...u16(20), ...common, ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(this.offset), ...nameBytes]));
    this.parts.push(local, comp);
    this.offset += local.length + comp.size;
  }
  finish() {
    const cd = new Blob(this.central), n = this.central.length;
    const end = new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(n), ...u16(n), ...u32(cd.size), ...u32(this.offset), ...u16(0)]);
    return new Blob([...this.parts, cd, end], { type: "application/zip" });
  }
}
