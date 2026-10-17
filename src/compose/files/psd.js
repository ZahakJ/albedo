// Photoshop documents (PSD, and PSB for reading), 8, 16 and 32 bits per
// channel, RGB. Pure JS over plain arrays: the engine supplies and receives
// layer pixels as straight-alpha Float32 RGBA (0..1, linear in 32-bit
// documents, as Photoshop's 32-bit mode).
//
// Written: pixel layers, groups (pass-through or not, open or closed), layer
// masks, blend modes, opacity, fill opacity (iOpa), clipping, visibility,
// Blend If (blending ranges), Unicode names, an sRGB profile, the merged
// image. Read: the same, from Photoshop, Krita, GIMP, Affinity or Photopea,
// including 16/32-bit files whose layers sit in Lr16/Lr32 blocks, and the
// layer data Photoshop puts inside a layered TIFF.
//
// Spec: Adobe Photoshop File Formats Specification (2016) — section numbers
// below refer to it.

const BLEND_TO = {
  normal: 'norm', dissolve: 'diss', darken: 'dark', multiply: 'mul ', colorBurn: 'idiv', linearBurn: 'lbrn',
  darkerColor: 'dkCl', lighten: 'lite', screen: 'scrn', colorDodge: 'div ', linearDodge: 'lddg',
  lighterColor: 'lgCl', overlay: 'over', softLight: 'sLit', hardLight: 'hLit', vividLight: 'vLit',
  linearLight: 'lLit', pinLight: 'pLit', hardMix: 'hMix', difference: 'diff', exclusion: 'smud',
  subtract: 'fsub', divide: 'fdiv', hue: 'hue ', saturation: 'sat ', color: 'colr', luminosity: 'lum ',
  pass: 'pass',
}
const BLEND_FROM = Object.fromEntries(Object.entries(BLEND_TO).map(([k, v]) => [v, k]))
export const psdBlendKey = (k) => BLEND_TO[k] ?? 'norm'

// ── writer ─────────────────────────────────────────────────────────────────
class W {
  constructor() { this.chunks = []; this.len = 0 }
  bytes(b) { this.chunks.push(b); this.len += b.length }
  u8(v) { this.bytes(Uint8Array.of(v & 255)) }
  u16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v); this.bytes(b) }
  i16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setInt16(0, v); this.bytes(b) }
  u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v); this.bytes(b) }
  i32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v); this.bytes(b) }
  ascii(s) { this.bytes(new TextEncoder().encode(s)) }
  pad(to) { while (this.len % to) this.u8(0) }
  out() {
    const o = new Uint8Array(this.len)
    let p = 0
    for (const c of this.chunks) { o.set(c, p); p += c.length }
    return o
  }
}

// PackBits, one row
function packBits(row) {
  const out = []
  let i = 0
  const n = row.length
  while (i < n) {
    let j = i
    while (j + 1 < n && row[j + 1] === row[i] && j - i < 127) j++
    if (j > i) { out.push(257 - (j - i + 1) & 255, row[i]); i = j + 1; continue }
    j = i
    while (j + 1 < n && j - i < 127 && !(j + 2 < n && row[j + 1] === row[j + 2])) j++
    out.push(j - i)
    for (let k = i; k <= j; k++) out.push(row[k])
    i = j + 1
  }
  return Uint8Array.from(out)
}

const deflateZlib = async (bytes) => {
  const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'))
  return new Uint8Array(await new Response(s).arrayBuffer())
}
const inflateZlib = async (bytes) => {
  const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'))
  return new Uint8Array(await new Response(s).arrayBuffer())
}

// one channel plane (Float32 0..1, w×h) → compressed channel data, with its
// 2-byte compression code first
async function encodeChannel(plane, w, h, depth) {
  if (!w || !h) return Uint8Array.of(0, 0)
  if (depth === 8) {
    const rows = []
    const counts = new Uint8Array(h * 2)
    const cv = new DataView(counts.buffer)
    const row = new Uint8Array(w)
    let total = 0
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) row[x] = Math.round(Math.min(1, Math.max(0, plane[y * w + x])) * 255)
      const r = packBits(row)
      rows.push(r)
      cv.setUint16(y * 2, r.length)
      total += r.length
    }
    const out = new Uint8Array(2 + counts.length + total)
    out.set([0, 1])
    out.set(counts, 2)
    let p = 2 + counts.length
    for (const r of rows) { out.set(r, p); p += r.length }
    return out
  }
  if (depth === 16) {
    // ZIP with prediction: per-row deltas of the big-endian values
    const raw = new Uint8Array(w * h * 2)
    const dv = new DataView(raw.buffer)
    for (let y = 0; y < h; y++) {
      let prev = 0
      for (let x = 0; x < w; x++) {
        const v = Math.round(Math.min(1, Math.max(0, plane[y * w + x])) * 65535)
        dv.setUint16((y * w + x) * 2, (v - prev) & 0xffff)
        prev = v
      }
    }
    const z = await deflateZlib(raw)
    const out = new Uint8Array(2 + z.length)
    out.set([0, 3])
    out.set(z, 2)
    return out
  }
  const out = new Uint8Array(2 + w * h * 4)
  const dv = new DataView(out.buffer)
  for (let i = 0; i < w * h; i++) dv.setFloat32(2 + i * 4, plane[i])
  return out
}

const pascal = (w, s, padTo) => {
  const b = new TextEncoder().encode(s).slice(0, 255)
  w.u8(b.length)
  w.bytes(b)
  const used = 1 + b.length
  for (let i = used; i % padTo; i++) w.u8(0)
}
function block(w, key, body) {
  w.ascii('8BIM'); w.ascii(key)
  const len = body.length + (body.length % 2)
  w.u32(len)
  w.bytes(body)
  if (body.length % 2) w.u8(0)
}
const unicodeName = (s) => {
  const b = new W()
  b.u32(s.length)
  for (let i = 0; i < s.length; i++) b.u16(s.charCodeAt(i))
  return b.out()
}

// layers: bottom → top, flattened with group markers:
//   { kind: 'pixel', name, x, y, w, h, rgba (Float32 straight), opacity,
//     fill, blend, clip, visible, blendIf, mask: { x, y, w, h, data
//     (Float32), default, disabled } | null }
//   { kind: 'groupEnd' } (below the group's children)
//   { kind: 'groupStart', name, blend, opacity, visible, collapsed, mask }
// composite: Float32 straight RGBA of the document; private: bytes kept in
// an image resource (4000) that albedo reads back
export async function writePsd({ width, height, depth, layers, composite, icc = null, privateData = null }) {
  const w = new W()
  const hasAlpha = (() => { for (let i = 3; i < composite.length; i += 4) if (composite[i] < 0.9999) return true; return false })()
  w.ascii('8BPS'); w.u16(1); w.bytes(new Uint8Array(6))
  w.u16(hasAlpha ? 4 : 3); w.u32(height); w.u32(width); w.u16(depth); w.u16(3)
  w.u32(0) // colour mode data
  // image resources
  const res = new W()
  const resource = (id, data) => {
    res.ascii('8BIM'); res.u16(id); res.u16(0) // empty name, padded
    res.u32(data.length); res.bytes(data)
    if (data.length % 2) res.u8(0)
  }
  if (icc) resource(1039, icc)
  if (privateData) resource(4000, privateData)
  const rb = res.out()
  w.u32(rb.length); w.bytes(rb)

  // layer info (8-bit: in the section; 16/32-bit: in an Lr16 / Lr32 block)
  const li = new W()
  li.i16(hasAlpha ? -layers.length : layers.length)
  const channelData = []
  for (const L of layers) {
    const isGroup = L.kind === 'groupStart' || L.kind === 'groupEnd'
    const x = isGroup ? 0 : L.x, y = isGroup ? 0 : L.y, lw = isGroup ? 0 : L.w, lh = isGroup ? 0 : L.h
    li.i32(y); li.i32(x); li.i32(y + lh); li.i32(x + lw)
    const chans = []
    const planes = isGroup ? [null, null, null, null] : splitPlanes(L.rgba, lw * lh)
    for (const [id, plane] of [[-1, planes[3]], [0, planes[0]], [1, planes[1]], [2, planes[2]]]) {
      chans.push({ id, data: isGroup ? Uint8Array.of(0, 0) : await encodeChannel(plane, lw, lh, depth) })
    }
    if (L.mask?.data) chans.push({ id: -2, data: await encodeChannel(L.mask.data, L.mask.w, L.mask.h, depth) })
    li.u16(chans.length)
    for (const c of chans) { li.i16(c.id); li.u32(c.data.length) }
    channelData.push(chans)
    li.ascii('8BIM'); li.ascii(L.kind === 'groupEnd' ? 'norm' : psdBlendKey(L.blend))
    li.u8(Math.round((L.opacity ?? 1) * 255))
    li.u8(L.clip ? 1 : 0)
    li.u8((L.visible === false ? 2 : 0) | 8 | (isGroup ? 16 : 0))
    li.u8(0)
    const ex = new W()
    // mask data
    if (L.mask) {
      ex.u32(20)
      ex.i32(L.mask.y); ex.i32(L.mask.x); ex.i32(L.mask.y + L.mask.h); ex.i32(L.mask.x + L.mask.w)
      ex.u8(L.mask.default ?? 255)
      ex.u8(L.mask.disabled ? 2 : 0)
      ex.u16(0)
    } else ex.u32(0)
    // blending ranges: composite grey, then the three channels
    const br = (r) => [Math.round(r[0] * 255), Math.round(r[1] * 255), Math.round(r[2] * 255), Math.round(r[3] * 255)]
    const src = L.blendIf ? br(L.blendIf.this) : [0, 0, 255, 255]
    const dst = L.blendIf ? br(L.blendIf.under) : [0, 0, 255, 255]
    ex.u32(8 + 3 * 8)
    const range = (r) => { ex.u8(r[0]); ex.u8(r[1]); ex.u8(r[2]); ex.u8(r[3]) }
    const ch = L.blendIf?.channel ?? 0
    range(ch === 0 ? src : [0, 0, 255, 255]); range(ch === 0 ? dst : [0, 0, 255, 255])
    for (let c = 1; c <= 3; c++) { range(ch === c ? src : [0, 0, 255, 255]); range(ch === c ? dst : [0, 0, 255, 255]) }
    const name = L.kind === 'groupEnd' ? '</Layer group>' : L.name ?? 'Layer'
    pascal(ex, name, 4)
    block(ex, 'luni', unicodeName(name))
    if (isGroup) {
      const s = new W()
      s.u32(L.kind === 'groupEnd' ? 3 : L.collapsed ? 2 : 1)
      if (L.kind === 'groupStart') { s.ascii('8BIM'); s.ascii(psdBlendKey(L.blend ?? 'pass')) }
      block(ex, 'lsct', s.out())
    } else if (L.fill != null && L.fill < 1) {
      block(ex, 'iOpa', Uint8Array.of(Math.round(L.fill * 255), 0, 0, 0))
    }
    const eb = ex.out()
    li.u32(eb.length); li.bytes(eb)
  }
  for (const chans of channelData) for (const c of chans) li.bytes(c.data)
  li.pad(2)
  const layerInfo = li.out()

  const lm = new W()
  if (depth === 8) { lm.u32(layerInfo.length); lm.bytes(layerInfo) } else lm.u32(0)
  lm.u32(0) // global layer mask info
  if (depth !== 8) block(lm, depth === 16 ? 'Lr16' : 'Lr32', layerInfo)
  const lmb = lm.out()
  w.u32(lmb.length); w.bytes(lmb)

  // merged image: planar, raw (16/32) or RLE (8)
  const planes = splitPlanes(composite, width * height)
  const order = hasAlpha ? [0, 1, 2, 3] : [0, 1, 2]
  if (depth === 8) {
    w.u16(1)
    const rows = []
    const counts = new W()
    const row = new Uint8Array(width)
    for (const c of order) {
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) row[x] = Math.round(Math.min(1, Math.max(0, planes[c][y * width + x])) * 255)
        const r = packBits(row)
        counts.u16(r.length)
        rows.push(r)
      }
    }
    w.bytes(counts.out())
    for (const r of rows) w.bytes(r)
  } else {
    w.u16(0)
    for (const c of order) {
      const b = new Uint8Array(width * height * (depth / 8))
      const dv = new DataView(b.buffer)
      for (let i = 0; i < width * height; i++) {
        if (depth === 16) dv.setUint16(i * 2, Math.round(Math.min(1, Math.max(0, planes[c][i])) * 65535))
        else dv.setFloat32(i * 4, planes[c][i])
      }
      w.bytes(b)
    }
  }
  return w.out()
}

function splitPlanes(rgba, n) {
  const p = [new Float32Array(n), new Float32Array(n), new Float32Array(n), new Float32Array(n)]
  for (let i = 0; i < n; i++) { p[0][i] = rgba[i * 4]; p[1][i] = rgba[i * 4 + 1]; p[2][i] = rgba[i * 4 + 2]; p[3][i] = rgba[i * 4 + 3] }
  return p
}

// ── reader ─────────────────────────────────────────────────────────────────
class R {
  constructor(bytes, big = false) { this.b = bytes; this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); this.p = 0; this.big = big }
  u8() { return this.b[this.p++] }
  u16() { const v = this.dv.getUint16(this.p); this.p += 2; return v }
  i16() { const v = this.dv.getInt16(this.p); this.p += 2; return v }
  u32() { const v = this.dv.getUint32(this.p); this.p += 4; return v }
  i32() { const v = this.dv.getInt32(this.p); this.p += 4; return v }
  u64() { const hi = this.u32(); const lo = this.u32(); return hi * 2 ** 32 + lo }
  len() { return this.big ? this.u64() : this.u32() } // PSB lengths
  ascii(n) { const s = String.fromCharCode(...this.b.subarray(this.p, this.p + n)); this.p += n; return s }
  bytes(n) { const v = this.b.subarray(this.p, this.p + n); this.p += n; return v }
  skip(n) { this.p += n }
}

const LONG_KEYS = new Set(['LMsk', 'Lr16', 'Lr32', 'Layr', 'Mt16', 'Mt32', 'Mtrn', 'Alph', 'FMsk', 'lnk2', 'FEid', 'FXid', 'PxSD'])

// → { width, height, depth, layers (bottom → top, flattened as written
// above, with rgba / mask.data as Float32), composite (Float32 RGBA | null),
// private (Uint8Array | null) }
export async function readPsd(bytes) {
  const r = new R(bytes)
  if (r.ascii(4) !== '8BPS') throw new Error('Not a Photoshop file')
  const version = r.u16()
  r.big = version === 2
  r.skip(6)
  const channels = r.u16()
  const height = r.u32(), width = r.u32()
  const depth = r.u16(), mode = r.u16()
  if (mode !== 3 && mode !== 1) throw new Error(`Colour mode ${mode} is not supported (RGB and greyscale are)`)
  r.skip(r.u32()) // colour mode data
  // image resources
  const resEnd = r.u32() + r.p
  let priv = null
  let icc = null
  while (r.p < resEnd) {
    if (r.ascii(4) !== '8BIM') break
    const id = r.u16()
    const nl = r.u8(); r.skip(nl + ((nl + 1) % 2))
    const size = r.u32()
    const data = r.bytes(size)
    if (size % 2) r.skip(1)
    if (id === 4000) priv = data
    if (id === 1039) icc = data
  }
  r.p = resEnd
  // layer and mask info
  const lmLen = r.len()
  const lmEnd = r.p + lmLen
  let layers = []
  if (lmLen) {
    const liLen = r.len()
    const liEnd = r.p + liLen
    if (liLen) layers = await readLayerInfo(r, depth, mode)
    r.p = liEnd
    if (r.p < lmEnd) { const g = r.u32(); r.skip(g) }
    // additional blocks: Lr16 / Lr32 carry the layers of deep documents
    while (r.p + 12 <= lmEnd) {
      const sig = r.ascii(4)
      if (sig !== '8BIM' && sig !== '8B64') break
      const key = r.ascii(4)
      const len = r.big && LONG_KEYS.has(key) ? r.u64() : r.u32()
      const end = r.p + len
      if ((key === 'Lr16' || key === 'Lr32' || key === 'Layr') && !layers.length) layers = await readLayerInfo(r, depth, mode)
      r.p = end + (len % 4 && r.p < lmEnd ? 0 : 0)
      while (r.p < lmEnd && r.p % 2) r.p++
    }
  }
  r.p = lmEnd
  // merged image
  let composite = null
  try {
    const comp = r.u16()
    const planes = []
    const n = width * height
    if (comp === 1) {
      const counts = []
      for (let i = 0; i < channels * height; i++) counts.push(r.big ? r.u32() : r.u16())
      for (let c = 0; c < channels; c++) {
        const plane = new Float32Array(n)
        for (let y = 0; y < height; y++) {
          const row = unpackBits(r.bytes(counts[c * height + y]), width * (depth / 8))
          decodeRow(row, plane, y * width, width, depth)
        }
        planes.push(plane)
      }
    } else if (comp === 0) {
      for (let c = 0; c < channels; c++) {
        const plane = new Float32Array(n)
        const raw = r.bytes(n * (depth / 8))
        for (let y = 0; y < height; y++) decodeRow(raw.subarray(y * width * (depth / 8)), plane, y * width, width, depth)
        planes.push(plane)
      }
    }
    if (planes.length) composite = mergePlanes(planes, n, mode)
  } catch { composite = null }
  return { width, height, depth, layers, composite, private: priv, icc }
}

function decodeRow(src, plane, off, w, depth) {
  if (depth === 8) for (let x = 0; x < w; x++) plane[off + x] = src[x] / 255
  else if (depth === 16) { const dv = new DataView(src.buffer, src.byteOffset, w * 2); for (let x = 0; x < w; x++) plane[off + x] = dv.getUint16(x * 2) / 65535 }
  else if (depth === 32) { const dv = new DataView(src.buffer, src.byteOffset, w * 4); for (let x = 0; x < w; x++) plane[off + x] = dv.getFloat32(x * 4) }
  else if (depth === 1) for (let x = 0; x < w; x++) plane[off + x] = (src[x >> 3] >> (7 - (x & 7))) & 1 ? 0 : 1
}

function unpackBits(src, n) {
  const out = new Uint8Array(n)
  let i = 0, o = 0
  while (i < src.length && o < n) {
    const c = src[i++]
    if (c < 128) { for (let k = 0; k <= c && o < n; k++) out[o++] = src[i++] }
    else if (c > 128) { const v = src[i++]; for (let k = 0; k < 257 - c && o < n; k++) out[o++] = v }
  }
  return out
}

async function decodeChannel(data, w, h, depth) {
  const comp = (data[0] << 8) | data[1]
  const body = data.subarray(2)
  const n = w * h
  const plane = new Float32Array(n)
  if (!n) return plane
  const bpp = depth / 8
  if (comp === 0) {
    for (let y = 0; y < h; y++) decodeRow(body.subarray(y * w * bpp), plane, y * w, w, depth)
  } else if (comp === 1) {
    const big = body.length >= h * 4 && false
    let p = h * (big ? 4 : 2)
    const dv = new DataView(body.buffer, body.byteOffset, body.byteLength)
    for (let y = 0; y < h; y++) {
      const c = dv.getUint16(y * 2)
      decodeRow(unpackBits(body.subarray(p, p + c), w * bpp), plane, y * w, w, depth)
      p += c
    }
  } else {
    const raw = await inflateZlib(body)
    if (comp === 3) {
      if (depth === 8) for (let y = 0; y < h; y++) for (let x = 1; x < w; x++) raw[y * w + x] = (raw[y * w + x] + raw[y * w + x - 1]) & 255
      else if (depth === 16) {
        const dv = new DataView(raw.buffer)
        for (let y = 0; y < h; y++) for (let x = 1; x < w; x++) {
          const i = (y * w + x) * 2
          dv.setUint16(i, (dv.getUint16(i) + dv.getUint16(i - 2)) & 0xffff)
        }
      } else if (depth === 32) {
        // Photoshop: byte deltas per row, then the four byte planes of the row
        const row = new Uint8Array(w * 4)
        for (let y = 0; y < h; y++) {
          const o = y * w * 4
          for (let x = 1; x < w * 4; x++) raw[o + x] = (raw[o + x] + raw[o + x - 1]) & 255
          for (let x = 0; x < w; x++) for (let b = 0; b < 4; b++) row[x * 4 + b] = raw[o + b * w + x]
          raw.set(row, o)
        }
      }
    }
    for (let y = 0; y < h; y++) decodeRow(raw.subarray(y * w * bpp), plane, y * w, w, depth)
  }
  return plane
}

async function readLayerInfo(r, depth, mode) {
  let count = r.i16()
  count = Math.abs(count)
  const recs = []
  for (let i = 0; i < count; i++) {
    const top = r.i32(), left = r.i32(), bottom = r.i32(), right = r.i32()
    const nc = r.u16()
    const chans = []
    for (let c = 0; c < nc; c++) chans.push({ id: r.i16(), len: r.len() })
    r.ascii(4)
    const blend = r.ascii(4)
    const opacity = r.u8() / 255
    const clip = r.u8() === 1
    const flags = r.u8()
    r.u8()
    const exLen = r.u32()
    const exEnd = r.p + exLen
    const rec = { top, left, bottom, right, chans, blend: BLEND_FROM[blend] ?? 'normal', opacity, clip, visible: !(flags & 2), name: '', fill: 1, section: 0, mask: null, blendIf: null, adjust: null }
    const mLen = r.u32()
    if (mLen) {
      const mEnd = r.p + mLen
      const mt = r.i32(), ml = r.i32(), mb = r.i32(), mr = r.i32()
      rec.mask = { x: ml, y: mt, w: mr - ml, h: mb - mt, default: r.u8(), flags: r.u8() }
      r.p = mEnd
    }
    const bLen = r.u32()
    if (bLen >= 8) {
      const g = r.bytes(8)
      const src = [g[0], g[1], g[2], g[3]].map((v) => v / 255), dst = [g[4], g[5], g[6], g[7]].map((v) => v / 255)
      const neutral = (a) => a[0] === 0 && a[1] === 0 && a[2] === 1 && a[3] === 1
      if (!neutral(src) || !neutral(dst)) rec.blendIf = { channel: 0, this: src, under: dst }
      r.skip(bLen - 8)
    } else r.skip(bLen)
    const nl = r.u8()
    rec.name = new TextDecoder('latin1').decode(r.bytes(nl))
    r.skip((4 - ((nl + 1) % 4)) % 4)
    while (r.p + 12 <= exEnd) {
      const sig = r.ascii(4)
      if (sig !== '8BIM' && sig !== '8B64') break
      const key = r.ascii(4)
      const len = r.big && LONG_KEYS.has(key) ? r.u64() : r.u32()
      const end = r.p + len
      if (key === 'luni') {
        const n = r.u32()
        let s = ''
        for (let k = 0; k < n; k++) s += String.fromCharCode(r.u16())
        rec.name = s.replace(/\0+$/, '')
      } else if (key === 'lsct') {
        rec.section = r.u32()
        if (len >= 12) { r.ascii(4); rec.blend = BLEND_FROM[r.ascii(4)] ?? rec.blend }
      } else if (key === 'iOpa') rec.fill = r.u8() / 255
      else if (key === 'nvrt') rec.adjust = { type: 'invert' }
      else if (key === 'thrs') rec.adjust = { type: 'threshold', params: { level: r.u16() } }
      else if (key === 'post') rec.adjust = { type: 'posterize', params: { levels: r.u16() } }
      else if (key === 'levl') {
        r.u16()
        const rd = () => ({ ib: r.u16(), iw: r.u16(), ob: r.u16(), ow: r.u16(), g: r.u16() })
        const m = rd()
        rec.adjust = { type: 'levels', channel: 'rgb', params: { inBlack: m.ib / 255, inWhite: m.iw / 255, outBlack: m.ob / 255, outWhite: m.ow / 255, gamma: m.g / 100 } }
      } else if (key === 'brit') {
        rec.adjust = { type: 'brightness', params: { brightness: r.i16(), contrast: r.i16() } }
      } else if (key === 'curv') {
        r.u8(); r.u16()
        const bits = r.u32()
        const curves = {}
        const names = ['master', 'r', 'g', 'b']
        for (let c = 0; c < 4; c++) {
          if (!(bits & (1 << c))) continue
          const n = r.u16()
          const pts = []
          for (let k = 0; k < n; k++) { const out = r.u16(), inp = r.u16(); pts.push([inp / 255, out / 255]) }
          curves[names[c]] = pts
        }
        rec.adjust = { type: 'curves', curves }
      } else if (key === 'hue2') {
        r.u16(); const colorize = r.u8(); r.u8()
        const cz = [r.i16(), r.i16(), r.i16()]
        const m = [r.i16(), r.i16(), r.i16()]
        rec.adjust = { type: 'huesat', params: colorize ? { colorize: true, cHue: cz[0], cSat: cz[1], lightness: cz[2] } : { hue: m[0], saturation: m[1], lightness: m[2] } }
      } else if (key === 'expA') {
        r.u16()
        const f = () => { const v = r.dv.getFloat32(r.p); r.p += 4; return v }
        rec.adjust = { type: 'exposure', params: { exposure: f(), offset: f(), gamma: f() } }
      } else if (key === 'SoCo' || key === 'GdFl' || key === 'PtFl' || key === 'vibA' || key === 'selc' || key === 'mixr' || key === 'phfl' || key === 'grdm' || key === 'clrL' || key === 'blwh') {
        rec.unsupportedAdjust = key
      }
      r.p = end
      while (r.p % 2 && r.p < exEnd) r.p++
    }
    r.p = exEnd
    recs.push(rec)
  }
  // channel image data
  for (const rec of recs) {
    const w = rec.right - rec.left, h = rec.bottom - rec.top
    const planes = {}
    for (const c of rec.chans) {
      const data = r.bytes(c.len)
      const cw = c.id === -2 && rec.mask ? rec.mask.w : w
      const ch = c.id === -2 && rec.mask ? rec.mask.h : h
      if (c.id < -2 || c.len < 2) continue
      planes[c.id] = await decodeChannel(data, cw, ch, depth)
    }
    const n = w * h
    if (n > 0 && planes[0]) {
      const rgba = new Float32Array(n * 4)
      const gray = mode === 1
      for (let i = 0; i < n; i++) {
        rgba[i * 4] = planes[0][i]
        rgba[i * 4 + 1] = gray ? planes[0][i] : planes[1]?.[i] ?? 0
        rgba[i * 4 + 2] = gray ? planes[0][i] : planes[2]?.[i] ?? 0
        rgba[i * 4 + 3] = planes[-1] ? planes[-1][i] : 1
      }
      rec.rgba = rgba
    }
    if (rec.mask && planes[-2]) rec.mask.data = planes[-2]
    delete rec.chans
  }
  return recs.map((rec) => {
    const x = rec.left, y = rec.top, w = rec.right - rec.left, h = rec.bottom - rec.top
    const base = { name: rec.name, blend: rec.blend, opacity: rec.opacity, fill: rec.fill, clip: rec.clip, visible: rec.visible, blendIf: rec.blendIf,
      mask: rec.mask?.data ? { x: rec.mask.x, y: rec.mask.y, w: rec.mask.w, h: rec.mask.h, data: rec.mask.data, default: rec.mask.default, disabled: !!(rec.mask.flags & 2) } : null }
    if (rec.section === 3) return { kind: 'groupEnd' }
    if (rec.section === 1 || rec.section === 2) return { ...base, kind: 'groupStart', collapsed: rec.section === 2 }
    if (rec.adjust) return { ...base, kind: 'adjust', adjust: rec.adjust }
    return { ...base, kind: 'pixel', x, y, w, h, rgba: rec.rgba ?? null, unsupported: rec.unsupportedAdjust ?? null }
  })
}

function mergePlanes(planes, n, mode) {
  const out = new Float32Array(n * 4)
  const gray = mode === 1 || planes.length < 3
  for (let i = 0; i < n; i++) {
    out[i * 4] = planes[0][i]
    out[i * 4 + 1] = gray ? planes[0][i] : planes[1][i]
    out[i * 4 + 2] = gray ? planes[0][i] : planes[2][i]
    out[i * 4 + 3] = gray ? (planes[1]?.[i] ?? 1) : planes[3]?.[i] ?? 1
  }
  return out
}

// layered TIFF: Photoshop's layers live in tag 37724 (ImageSourceData) as
// "Adobe Photoshop Document Data Block" + the layer-and-mask tagged blocks
export async function readTiffLayers(source, depth) {
  const sig = 'Adobe Photoshop Document Data Block\0'
  const head = new TextDecoder('latin1').decode(source.subarray(0, sig.length))
  if (head !== sig) return null
  // the blocks are little-endian in Intel-order TIFFs: try both
  for (const little of [false, true]) {
    try {
      const body = little ? swapBlocks(source.subarray(sig.length)) : source.subarray(sig.length)
      const r = new R(body)
      while (r.p + 12 <= body.length) {
        r.ascii(4)
        const key = r.ascii(4)
        const len = r.u32()
        const end = r.p + len
        if (key === 'Layr' || key === 'Lr16' || key === 'Lr32') {
          r.u32() // layer info length
          const layers = await readLayerInfo(r, depth, 3)
          if (layers.length) return layers
        }
        r.p = end
        while (r.p % 4) r.p++
      }
    } catch { /* try the other byte order */ }
  }
  return null
}
// little-endian layer blocks are rare (Photoshop writes them in the file's
// byte order); reading them would need every field swapped — not supported
const swapBlocks = () => { throw new Error('little-endian layer data') }
