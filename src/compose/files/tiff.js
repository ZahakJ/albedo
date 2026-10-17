// TIFF reading for Compose: every page of a baseline TIFF (RGB, RGBA or
// greyscale; 8, 16 or 32-bit float; uncompressed, LZW, Deflate or PackBits;
// strips or tiles; horizontal predictor), and the raw bytes of tag 37724,
// where Photoshop keeps the layers of a layered TIFF.

const TYPES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8 }

export function parseTiff(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const le = dv.getUint16(0) === 0x4949
  const g16 = (o) => dv.getUint16(o, le)
  const g32 = (o) => dv.getUint32(o, le)
  if (g16(2) !== 42) throw new Error('Not a TIFF (BigTIFF is not supported)')
  const pages = []
  let off = g32(4)
  const seen = new Set()
  while (off && !seen.has(off) && off < bytes.length) {
    seen.add(off)
    const n = g16(off)
    const tags = {}
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12
      const tag = g16(e), type = g16(e + 2), count = g32(e + 4)
      const size = (TYPES[type] ?? 1) * count
      const vo = size <= 4 ? e + 8 : g32(e + 8)
      const read = (k) => {
        switch (type) {
          case 3: return g16(vo + k * 2)
          case 4: return g32(vo + k * 4)
          case 11: return dv.getFloat32(vo + k * 4, le)
          case 1: case 6: case 7: return bytes[vo + k]
          default: return g32(vo + k * 4)
        }
      }
      if (type === 7 || type === 1 || type === 2) tags[tag] = bytes.subarray(vo, vo + count)
      else tags[tag] = count === 1 ? read(0) : Array.from({ length: count }, (_, k) => read(k))
      if (tag === 37724) tags[tag] = bytes.subarray(vo, vo + count)
    }
    pages.push({ tags, le })
    off = g32(off + 2 + n * 12)
  }
  return pages
}

const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v])

function lzwDecode(src, outLen) {
  const out = new Uint8Array(outLen)
  let o = 0
  let dict = []
  const reset = () => { dict = []; for (let i = 0; i < 256; i++) dict.push([i]); dict.push(null, null) }
  reset()
  let bits = 9, buf = 0, nb = 0, prev = null, p = 0
  while (true) {
    while (nb < bits && p < src.length) { buf = (buf << 8) | src[p++]; nb += 8 }
    if (nb < bits) break
    const code = (buf >> (nb - bits)) & ((1 << bits) - 1)
    nb -= bits
    if (code === 257) break
    if (code === 256) { reset(); bits = 9; prev = null; continue }
    let entry
    if (code < dict.length && dict[code]) entry = dict[code]
    else if (prev) entry = [...prev, prev[0]]
    else break
    for (const v of entry) { if (o < outLen) out[o++] = v }
    if (prev) dict.push([...prev, entry[0]])
    prev = entry
    if (dict.length + 1 >= (1 << bits) && bits < 12) bits++
  }
  return out
}
function unpack(src, outLen) {
  const out = new Uint8Array(outLen)
  let i = 0, o = 0
  while (i < src.length && o < outLen) {
    const c = (src[i++] << 24) >> 24
    if (c >= 0) { for (let k = 0; k <= c && o < outLen; k++) out[o++] = src[i++] }
    else if (c !== -128) { const v = src[i++]; for (let k = 0; k < 1 - c && o < outLen; k++) out[o++] = v }
  }
  return out
}
async function inflate(src) {
  const s = new Blob([src]).stream().pipeThrough(new DecompressionStream('deflate'))
  return new Uint8Array(await new Response(s).arrayBuffer())
}

// one page → { width, height, depth, rgba: Float32 straight }
export async function decodePage(bytes, page) {
  const t = page.tags
  const W = t[256], H = t[257]
  const bps = arr(t[258])[0] ?? 1
  const spp = t[277] ?? 1
  const comp = t[259] ?? 1
  const photo = t[262] ?? 2
  const pred = t[317] ?? 1
  const fmt = arr(t[339])[0] ?? 1
  const planar = t[284] ?? 1
  if (planar !== 1) throw new Error('Planar TIFFs are not supported')
  if (![8, 16, 32].includes(bps)) throw new Error(`${bps}-bit TIFF is not supported`)
  const bpp = (bps / 8) * spp
  const tiled = t[322] != null
  const tw = tiled ? t[322] : W, th = tiled ? t[323] : t[278] ?? H
  const offs = arr(tiled ? t[324] : t[273]), counts = arr(tiled ? t[325] : t[279])
  const raw = new Uint8Array(W * H * bpp)
  const across = Math.ceil(W / tw)
  for (let k = 0; k < offs.length; k++) {
    const src = bytes.subarray(offs[k], offs[k] + counts[k])
    const rows = tiled ? th : Math.min(th, H - k * th)
    const len = tw * rows * bpp
    let d
    if (comp === 1) d = src
    else if (comp === 5) d = lzwDecode(src, len)
    else if (comp === 8 || comp === 32946) d = await inflate(src)
    else if (comp === 32773) d = unpack(src, len)
    else throw new Error(`TIFF compression ${comp} is not supported`)
    if (pred === 2) predict(d, tw, rows, spp, bps, page.le)
    else if (pred === 3) throw new Error('Floating-point predictor is not supported')
    const x0 = tiled ? (k % across) * tw : 0
    const y0 = tiled ? Math.floor(k / across) * th : k * th
    for (let y = 0; y < rows && y0 + y < H; y++) {
      const n = Math.min(tw, W - x0) * bpp
      raw.set(d.subarray(y * tw * bpp, y * tw * bpp + n), ((y0 + y) * W + x0) * bpp)
    }
  }
  const dv = new DataView(raw.buffer)
  const out = new Float32Array(W * H * 4)
  const val = (i) => (bps === 8 ? raw[i] / 255 : bps === 16 ? dv.getUint16(i, page.le) / 65535 : fmt === 3 ? dv.getFloat32(i, page.le) : dv.getUint32(i, page.le) / 4294967295)
  const extra = arr(t[338])[0] ?? 0 // 1 = associated (premultiplied) alpha
  for (let p = 0; p < W * H; p++) {
    const b = p * bpp
    let r, g, bl, a = 1
    if (spp >= 3) { r = val(b); g = val(b + bps / 8); bl = val(b + 2 * bps / 8); if (spp > 3) a = val(b + 3 * bps / 8) }
    else { r = g = bl = val(b); if (spp > 1) a = val(b + bps / 8) }
    if (photo === 0) { r = 1 - r; g = 1 - g; bl = 1 - bl }
    if (extra === 1 && a > 0) { r /= a; g /= a; bl /= a }
    out[p * 4] = r; out[p * 4 + 1] = g; out[p * 4 + 2] = bl; out[p * 4 + 3] = a
  }
  return { width: W, height: H, depth: bps === 32 ? 32 : bps === 16 ? 16 : 8, rgba: out, float: fmt === 3 }
}

function predict(d, w, h, spp, bps, le) {
  if (bps === 8) {
    for (let y = 0; y < h; y++) for (let x = spp; x < w * spp; x++) d[y * w * spp + x] = (d[y * w * spp + x] + d[y * w * spp + x - spp]) & 255
  } else if (bps === 16) {
    const dv = new DataView(d.buffer, d.byteOffset, d.byteLength)
    for (let y = 0; y < h; y++) for (let x = spp; x < w * spp; x++) {
      const i = (y * w * spp + x) * 2
      dv.setUint16(i, (dv.getUint16(i, le) + dv.getUint16(i - spp * 2, le)) & 0xffff, le)
    }
  }
}
