// 16-bit TIFF export + the little-endian TIFF/IFD writer dng.js builds on.
// Pure ES module (browser + Node), no dependencies.
//
//   encodeTiff16({ width, height, data, channels?, iccProfile?, exif?, orientation? }) → Uint8Array
//       baseline RGB(A) 16-bit, uncompressed, synchronous
//   encodeTiff16Deflate(same) → Promise<Uint8Array>
//       Adobe Deflate (Compression 8) + horizontal predictor (Predictor 2),
//       via CompressionStream('deflate') (zlib stream = what TIFF 8 wants;
//       browsers and Node ≥ 18)
//   writeTiff(ifds) → Uint8Array — generic writer (see below)
//   exifIfd(exif) / baseTags(exif) — EXIF sub-IFD / IFD0 descriptive tags
//   SRGB_ICC — a minimal ICC v2 sRGB display profile, built at load
//
// data: Uint16Array, interleaved RGB or RGBA (channels inferred from length),
// gamma-encoded in whatever space iccProfile describes. iccProfile defaults to
// SRGB_ICC; pass null to omit tag 34675. Alpha is unassociated (ExtraSamples 2).
//
// exif (all optional): { make, model, camera, lens, iso, shutter (s),
// aperture, focal (mm), takenAt (ISO string or Date), software, artist,
// copyright, description } — albedo's decode `exif` object fits as is
// (`camera` stands in for Model when model is absent).

export const T = { BYTE: 1, ASCII: 2, SHORT: 3, LONG: 4, RATIONAL: 5, UNDEFINED: 7, SSHORT: 8, SLONG: 9, SRATIONAL: 10, FLOAT: 11, DOUBLE: 12 }
const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 }

// ---------------------------------------------------------------------------
// Generic writer. An IFD is { tags: { [tag]: [type, value] }, strips?:
// Uint8Array[] }. value: number | number[] | TypedArray | string (ASCII,
// NUL added) | { ifd } / { ifds: [...] } (pointer to sub-IFD(s), written as
// LONG offsets). RATIONAL/SRATIONAL values are plain numbers (converted
// here) or [num, den] pairs. When `strips` is given, StripOffsets (273) and
// StripByteCounts (279) are generated. writeTiff(ifds) chains the given IFDs
// through next-IFD links (IFD0 first); sub-IFDs are laid out after them.
// Layout: header, then each IFD followed by its out-of-line values, then all
// strip data — every offset word-aligned.

// best rational for v with |num|, den inside 32 bits (continued fraction)
export function toRational(v, signed = false) {
  if (Array.isArray(v)) return v
  if (!Number.isFinite(v)) return [0, 1]
  const max = signed ? 0x7fffffff : 0xffffffff
  if (Number.isInteger(v) && Math.abs(v) <= max) return [v, 1]
  const sgn = v < 0 ? -1 : 1
  let x = Math.abs(v)
  let [h0, h1, k0, k1] = [0, 1, 1, 0]
  for (let i = 0; i < 32; i++) {
    const a = Math.floor(x)
    const h2 = a * h1 + h0
    const k2 = a * k1 + k0
    if (h2 > max || k2 > max) break
    ;[h0, h1, k0, k1] = [h1, h2, k1, k2]
    const f = x - a
    if (f < 1e-12 || Math.abs(h1 / k1 - Math.abs(v)) < 1e-10 * Math.abs(v)) break
    x = 1 / f
  }
  return k1 === 0 ? [sgn * max, 1] : [sgn * h1, k1]
}

const enc = new TextEncoder()

function normalise([type, value]) {
  if (value && (value.ifd || value.ifds)) return { type: T.LONG, ptr: value.ifds ?? [value.ifd], count: (value.ifds ?? [value.ifd]).length }
  if (type === T.ASCII) {
    const b = enc.encode(String(value))
    const out = new Uint8Array(b.length + 1)
    out.set(b)
    return { type, bytes: out, count: out.length }
  }
  if ((type === T.BYTE || type === T.UNDEFINED) && value instanceof Uint8Array) return { type, bytes: value, count: value.length }
  let vals = typeof value === 'number' ? [value] : Array.from(value)
  if (type === T.RATIONAL || type === T.SRATIONAL) {
    // [n, d] pairs or plain numbers
    vals = vals.flatMap((v) => toRational(v, type === T.SRATIONAL))
    return { type, vals, count: vals.length / 2 }
  }
  return { type, vals, count: vals.length }
}

export function writeTiff(chain) {
  // collect every IFD once: chain first, then sub-IFDs depth-first
  const all = []
  const visit = (ifd) => {
    if (all.includes(ifd)) return
    all.push(ifd)
    for (const v of Object.values(ifd.tags)) {
      const p = v[1]
      if (p && (p.ifd || p.ifds)) (p.ifds ?? [p.ifd]).forEach(visit)
    }
  }
  chain.forEach(visit)

  const align = (n) => n + (n & 1)
  const L = all.map((ifd) => {
    const tags = { ...ifd.tags }
    if (ifd.strips) {
      tags[273] = [T.LONG, ifd.strips.map(() => 0)]
      tags[279] = [T.LONG, ifd.strips.map((s) => s.length)]
    }
    const entries = Object.keys(tags).map(Number).sort((a, b) => a - b)
      .map((tag) => ({ tag, ...normalise(tags[tag]) }))
    return { ifd, entries }
  })

  let pos = 8
  for (const l of L) {
    l.offset = pos
    pos += 2 + 12 * l.entries.length + 4
    for (const e of l.entries) {
      e.size = e.count * SIZE[e.type]
      if (e.size > 4) { e.at = pos; pos = align(pos + e.size) }
    }
  }
  for (const l of L) {
    l.stripAt = (l.ifd.strips ?? []).map((s) => { const p = pos; pos = align(pos + s.length); return p })
    if (l.ifd.strips) l.entries.find((e) => e.tag === 273).vals = l.stripAt
  }
  if (pos > 0xffffffff) throw new Error('TIFF larger than 4 GB (classic TIFF limit)')

  const out = new Uint8Array(pos)
  const dv = new DataView(out.buffer)
  out.set([0x49, 0x49, 42, 0])
  dv.setUint32(4, L[0].offset, true)
  const offsetOf = (ifd) => L.find((l) => l.ifd === ifd).offset

  for (const l of L) {
    let p = l.offset
    dv.setUint16(p, l.entries.length, true)
    p += 2
    for (const e of l.entries) {
      dv.setUint16(p, e.tag, true)
      dv.setUint16(p + 2, e.type, true)
      dv.setUint32(p + 4, e.count, true)
      const vals = e.ptr ? e.ptr.map(offsetOf) : e.vals
      let q = e.size > 4 ? e.at : p + 8
      if (e.size > 4) dv.setUint32(p + 8, e.at, true)
      if (e.bytes) out.set(e.bytes, q)
      else {
        for (const v of vals) {
          switch (e.type) {
            case T.BYTE: case T.UNDEFINED: dv.setUint8(q, v); q += 1; break
            case T.SHORT: dv.setUint16(q, v, true); q += 2; break
            case T.SSHORT: dv.setInt16(q, v, true); q += 2; break
            case T.LONG: case T.RATIONAL: dv.setUint32(q, v, true); q += 4; break
            case T.SLONG: case T.SRATIONAL: dv.setInt32(q, v, true); q += 4; break
            case T.FLOAT: dv.setFloat32(q, v, true); q += 4; break
            case T.DOUBLE: dv.setFloat64(q, v, true); q += 8; break
          }
        }
      }
      p += 12
    }
    const next = chain.indexOf(l.ifd)
    dv.setUint32(p, next >= 0 && next + 1 < chain.length ? offsetOf(chain[next + 1]) : 0, true)
    ;(l.ifd.strips ?? []).forEach((s, i) => out.set(s, l.stripAt[i]))
  }
  return out
}

// ---------------------------------------------------------------------------
// EXIF

const exifDate = (d) => {
  const t = d instanceof Date ? d : new Date(d)
  if (isNaN(t)) return null
  const p = (n) => String(n).padStart(2, '0')
  // EXIF has no zone; use UTC, which is what an ISO 'Z' string carries
  return `${t.getUTCFullYear()}:${p(t.getUTCMonth() + 1)}:${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}`
}

// IFD0 descriptive tags
export function baseTags(exif = {}, software = 'albedo') {
  const t = {}
  const model = exif.model ?? exif.camera
  if (exif.description) t[270] = [T.ASCII, exif.description]
  if (exif.make) t[271] = [T.ASCII, exif.make]
  if (model) t[272] = [T.ASCII, model]
  t[305] = [T.ASCII, exif.software ?? software]
  const dt = exif.takenAt && exifDate(exif.takenAt)
  if (dt) t[306] = [T.ASCII, dt]
  if (exif.artist) t[315] = [T.ASCII, exif.artist]
  if (exif.copyright) t[33432] = [T.ASCII, exif.copyright]
  return t
}

// EXIF sub-IFD (pointed to by tag 34665), or null when there is nothing to say
export function exifIfd(exif = {}) {
  const t = {}
  if (exif.shutter > 0) {
    // 1/250 s as 1/250, long exposures as n/1
    t[33434] = [T.RATIONAL, [exif.shutter < 1 ? [1, Math.round(1 / exif.shutter)] : toRational(exif.shutter)]]
  }
  if (exif.aperture > 0) t[33437] = [T.RATIONAL, [exif.aperture]]
  if (exif.iso > 0) t[34855] = [T.SHORT, [Math.min(65535, Math.round(exif.iso))]]
  const dt = exif.takenAt && exifDate(exif.takenAt)
  if (dt) t[36867] = [T.ASCII, dt]
  if (exif.focal > 0) t[37386] = [T.RATIONAL, [exif.focal]]
  if (exif.lens) t[42036] = [T.ASCII, exif.lens]
  if (!Object.keys(t).length) return null
  t[36864] = [T.UNDEFINED, enc.encode('0231')]
  return { tags: t }
}

// ---------------------------------------------------------------------------
// sRGB ICC profile (v2.1, display class, RGB → XYZ PCS), generated here
// rather than embedded. Source: IEC 61966-2.1 — primaries/white chromatically
// adapted to the D50 PCS with the Bradford transform (the values every
// D50-adapted sRGB profile carries, e.g. Elle Stone's "sRGB-elle-V2"), and
// the sRGB piecewise transfer function sampled into a 1024-entry curv table.
// The media white point is D50, per ICC.1:2001-04 Annex for display profiles
// written after v4 made that normative. ~2.6 KB; no MD5 profile ID (v2).

function buildSrgbIcc() {
  const s15 = (v) => Math.round(v * 65536)
  const xyz = (X, Y, Z) => ({ sig: 'XYZ ', words: [s15(X), s15(Y), s15(Z)] })
  const N = 1024
  const curve = new Uint16Array(N)
  for (let i = 0; i < N; i++) {
    const c = i / (N - 1)
    curve[i] = Math.round(65535 * (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  }
  const desc = 'sRGB IEC61966-2.1 (albedo)'
  // tag bodies
  const textDesc = () => {
    // textDescriptionType: ASCII + empty Unicode + empty ScriptCode (67 bytes)
    const n = desc.length + 1
    const b = new Uint8Array(12 + n + 8 + 3 + 67)
    const dv = new DataView(b.buffer)
    b.set(enc.encode('desc'))
    dv.setUint32(8, n)
    b.set(enc.encode(desc), 12)
    return b
  }
  const text = (s) => { const b = new Uint8Array(8 + s.length + 1); b.set(enc.encode('text')); b.set(enc.encode(s), 8); return b }
  const xyzTag = ({ words }) => {
    const b = new Uint8Array(20)
    const dv = new DataView(b.buffer)
    b.set(enc.encode('XYZ '))
    words.forEach((w, i) => dv.setInt32(8 + 4 * i, w))
    return b
  }
  const curv = () => {
    const b = new Uint8Array(12 + 2 * N)
    const dv = new DataView(b.buffer)
    b.set(enc.encode('curv'))
    dv.setUint32(8, N)
    curve.forEach((v, i) => dv.setUint16(12 + 2 * i, v))
    return b
  }
  const trc = curv()
  const tags = [
    ['desc', textDesc()],
    ['cprt', text('No copyright, use freely')],
    ['wtpt', xyzTag(xyz(0.9642, 1.0, 0.8249))],
    ['rXYZ', xyzTag(xyz(0.4360747, 0.2225045, 0.0139322))],
    ['gXYZ', xyzTag(xyz(0.3850649, 0.7168786, 0.0971045))],
    ['bXYZ', xyzTag(xyz(0.1430804, 0.0606169, 0.7141733))],
    ['rTRC', trc], ['gTRC', trc], ['bTRC', trc], // shared data, as ICC allows
  ]
  const tableSize = 4 + 12 * tags.length
  let pos = 128 + tableSize
  const placed = new Map()
  const table = tags.map(([sig, body]) => {
    if (!placed.has(body)) { placed.set(body, pos); pos += body.length; pos += (4 - (pos % 4)) % 4 }
    return [sig, placed.get(body), body.length]
  })
  const out = new Uint8Array(pos)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, pos)
  dv.setUint32(8, 0x02100000) // v2.1.0
  out.set(enc.encode('mntrRGB XYZ '), 12)
  // creation date 2026-01-01 00:00:00 (fixed, so the profile is reproducible)
  ;[2026, 1, 1, 0, 0, 0].forEach((v, i) => dv.setUint16(24 + 2 * i, v))
  out.set(enc.encode('acsp'), 36)
  dv.setInt32(68, s15(0.9642)); dv.setInt32(72, s15(1)); dv.setInt32(76, s15(0.8249)) // PCS illuminant D50
  dv.setUint32(128, tags.length)
  table.forEach(([sig, off, len], i) => {
    out.set(enc.encode(sig), 132 + 12 * i)
    dv.setUint32(136 + 12 * i, off)
    dv.setUint32(140 + 12 * i, len)
  })
  for (const [body, off] of placed) out.set(body, off)
  return out
}

export const SRGB_ICC = buildSrgbIcc()

// ---------------------------------------------------------------------------
// 16-bit RGB(A) TIFF

const STRIP_BYTES = 1 << 18 // ~256 KB strips: fine for readers, streaming deflate

function layout({ width, height, data, channels }) {
  if (!(width > 0 && height > 0)) throw new Error('bad dimensions')
  const ch = channels ?? data.length / (width * height)
  if (ch !== 3 && ch !== 4) throw new Error(`expected RGB or RGBA data, got ${ch} samples/pixel`)
  if (data.length < width * height * ch) throw new Error('data too short')
  const rowBytes = width * ch * 2
  const rowsPerStrip = Math.max(1, Math.min(height, Math.floor(STRIP_BYTES / rowBytes)))
  return { ch, rowBytes, rowsPerStrip }
}

// rows [y0, y1) as little-endian bytes, optionally horizontally differenced
// (Predictor 2 works on samples, per channel, mod 2^16)
function stripBytes(data, width, ch, y0, y1, predict) {
  const n = (y1 - y0) * width * ch
  const s = new Uint16Array(n)
  s.set(data.subarray(y0 * width * ch, y0 * width * ch + n))
  if (predict) {
    const rowLen = width * ch
    for (let r = 0; r < y1 - y0; r++) {
      const o = r * rowLen
      for (let i = rowLen - 1; i >= ch; i--) s[o + i] = (s[o + i] - s[o + i - ch]) & 0xffff
    }
  }
  const b = new Uint8Array(s.buffer)
  if (new Uint8Array(Uint16Array.of(1).buffer)[0] !== 1) {
    // big-endian host: swap to the file's little-endian order
    for (let i = 0; i < b.length; i += 2) { const t = b[i]; b[i] = b[i + 1]; b[i + 1] = t }
  }
  return b
}

function tiffIfd(opts, ch, rowsPerStrip, strips, compression) {
  const { width, height, exif, orientation } = opts
  const icc = opts.iccProfile === undefined ? SRGB_ICC : opts.iccProfile
  const tags = {
    ...baseTags(exif),
    254: [T.LONG, 0],
    256: [T.LONG, width],
    257: [T.LONG, height],
    258: [T.SHORT, new Array(ch).fill(16)],
    259: [T.SHORT, compression],
    262: [T.SHORT, 2], // RGB
    274: [T.SHORT, orientation ?? 1],
    277: [T.SHORT, ch],
    278: [T.LONG, rowsPerStrip],
    282: [T.RATIONAL, [72]],
    283: [T.RATIONAL, [72]],
    284: [T.SHORT, 1], // chunky
    296: [T.SHORT, 2], // inch
    339: [T.SHORT, new Array(ch).fill(1)], // unsigned int
  }
  if (compression === 8) tags[317] = [T.SHORT, 2]
  if (ch === 4) tags[338] = [T.SHORT, 2] // unassociated alpha
  if (icc) tags[34675] = [T.UNDEFINED, icc]
  const ex = exifIfd(exif)
  if (ex) tags[34665] = [T.LONG, { ifd: ex }]
  return { tags, strips }
}

export function encodeTiff16(opts) {
  const { width, height, data } = opts
  const { ch, rowsPerStrip } = layout(opts)
  const strips = []
  for (let y = 0; y < height; y += rowsPerStrip) strips.push(stripBytes(data, width, ch, y, Math.min(height, y + rowsPerStrip), false))
  return writeTiff([tiffIfd(opts, ch, rowsPerStrip, strips, 1)])
}

export async function deflate(bytes) {
  if (typeof CompressionStream === 'undefined') throw new Error('CompressionStream unavailable')
  const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'))
  return new Uint8Array(await new Response(s).arrayBuffer())
}

export async function encodeTiff16Deflate(opts) {
  const { width, height, data } = opts
  const { ch, rowsPerStrip } = layout(opts)
  const strips = []
  // one strip at a time keeps peak memory at ~one strip beyond the output
  for (let y = 0; y < height; y += rowsPerStrip) {
    strips.push(await deflate(stripBytes(data, width, ch, y, Math.min(height, y + rowsPerStrip), true)))
  }
  return writeTiff([tiffIfd(opts, ch, rowsPerStrip, strips, 8)])
}
