// WOFF 1.0 → sfnt (TrueType/OpenType bytes), for HarfBuzz, which reads
// sfnt only. WOFF tables are individually zlib-compressed; this inflates
// them and rebuilds the table directory. WOFF2 (Brotli + transforms) is not
// handled: TTF, OTF and WOFF are.
export async function woffToSfnt(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  const sig = dv.getUint32(0)
  if (sig !== 0x774f4646) return u8 // already sfnt (or unknown: let HarfBuzz decide)
  const flavor = dv.getUint32(4)
  const numTables = dv.getUint16(12)
  const tables = []
  for (let i = 0; i < numTables; i++) {
    const o = 44 + i * 20
    tables.push({
      tag: dv.getUint32(o), offset: dv.getUint32(o + 4), compLength: dv.getUint32(o + 8),
      origLength: dv.getUint32(o + 12), checksum: dv.getUint32(o + 16),
    })
  }
  const data = await Promise.all(tables.map(async (t) => {
    const raw = u8.subarray(t.offset, t.offset + t.compLength)
    if (t.compLength === t.origLength) return raw
    const s = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate'))
    return new Uint8Array(await new Response(s).arrayBuffer())
  }))
  let size = 12 + numTables * 16
  for (const d of data) size += (d.length + 3) & ~3
  const out = new Uint8Array(size)
  const ov = new DataView(out.buffer)
  ov.setUint32(0, flavor)
  ov.setUint16(4, numTables)
  let es = 0
  while (1 << (es + 1) <= numTables) es++
  ov.setUint16(6, (1 << es) * 16)
  ov.setUint16(8, es)
  ov.setUint16(10, numTables * 16 - (1 << es) * 16)
  let off = 12 + numTables * 16
  tables.forEach((t, i) => {
    const r = 12 + i * 16
    ov.setUint32(r, t.tag)
    ov.setUint32(r + 4, t.checksum)
    ov.setUint32(r + 8, off)
    ov.setUint32(r + 12, data[i].length)
    out.set(data[i], off)
    off += (data[i].length + 3) & ~3
  })
  return out
}
