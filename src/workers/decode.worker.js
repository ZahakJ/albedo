import { MSG } from './protocol.js'
import LibRaw from 'libraw-wasm'

// Decode worker: wraps libraw-wasm (which runs the actual wasm in its own
// nested worker — importing it here keeps postMessage traffic off main).
// Full quality prefers the undebayered mosaic so demosaic + color happen on
// the GPU; X-Trans/Foveon/sRAW fall back to libraw's own demosaic.

// (ox, oy) such that RGGB[(y+oy)&1][(x+ox)&1] equals the file's CFA at (y, x);
// null for X-Trans / non-RGGB-family patterns.
function cfaPhase(filters) {
  const at = (r, c) => {
    const v = (filters >> ((((r << 1) & 14) | (c & 1)) << 1)) & 3
    return v === 3 ? 1 : v
  }
  const rggb = (r, c) => (r & 1) === 0 ? ((c & 1) === 0 ? 0 : 1) : ((c & 1) === 0 ? 1 : 2)
  for (let oy = 0; oy < 2; oy++) {
    for (let ox = 0; ox < 2; ox++) {
      let ok = true
      for (let y = 0; y < 2 && ok; y++) {
        for (let x = 0; x < 2 && ok; x++) ok = rggb(y + oy, x + ox) === at(y, x)
      }
      if (ok) return [ox, oy]
    }
  }
  return null
}

const canUseMosaic = (meta) =>
  (meta.filters ?? 0) > 9 && !meta.is_foveon && cfaPhase(meta.filters) !== null

// X-Trans: 6×6 layout of the raw frame (0 R, 1 G, 2 B). Fuji writes it in
// the RAF CFA header as tag 0x131, last photosite first (as dcraw reads it);
// older bodies without the tag use dcraw's built-in layout.
const XTRANS_DEFAULT = [
  1, 1, 0, 1, 1, 2, 1, 1, 2, 1, 1, 0, 2, 0, 1, 0, 2, 1,
  1, 1, 2, 1, 1, 0, 1, 1, 0, 1, 1, 2, 0, 2, 1, 2, 0, 1,
]
function rafXtrans(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < 120 || String.fromCharCode(...bytes.subarray(0, 8)) !== 'FUJIFILM') return null
  const at = v.getUint32(92)
  const len = v.getUint32(96)
  if (!at || at + len > bytes.length) return null
  const n = v.getUint32(at)
  let o = at + 4
  for (let i = 0; i < n && o + 4 <= at + len; i++) {
    const tag = v.getUint16(o)
    const size = v.getUint16(o + 2)
    if (tag === 0x131 && size === 36) {
      return Array.from({ length: 36 }, (_, c) => bytes[o + 4 + 35 - c] & 3)
    }
    o += 4 + size
  }
  return null
}

// Fuji black level: the TIFF block at the RAF's CFA offset holds a FujiIFD
// (tag 0xF000) whose 0xF00A is the black level, one value per photosite of
// the 6×6 (or 2×2) repeat. LibRaw has it, but this build does not expose it.
function rafBlack(bytes) {
  if (bytes.length < 120 || String.fromCharCode(...bytes.subarray(0, 8)) !== 'FUJIFILM') return null
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const base = v.getUint32(100)
  if (base + 8 > bytes.length) return null
  const le = v.getUint16(base) === 0x4949
  const u16 = (o) => v.getUint16(base + o, le)
  const u32 = (o) => v.getUint32(base + o, le)
  const ifd = (off, want) => {
    if (off <= 0 || base + off + 2 > bytes.length) return null
    const n = u16(off)
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12
      if (base + e + 12 > bytes.length) return null
      if (u16(e) === want) return { type: u16(e + 2), count: u32(e + 4), at: e + 8 }
    }
    return null
  }
  const sub = ifd(u32(4), 0xf000)
  if (!sub) return null
  const bl = ifd(u32(sub.at), 0xf00a)
  if (!bl || bl.count < 1) return null
  const off = bl.count * 4 > 4 ? u32(bl.at) : bl.at
  let sum = 0
  for (let i = 0; i < bl.count; i++) sum += u32(off + i * 4)
  return sum / bl.count
}

// Pattern for the cropped mosaic. The margins shift the raw-frame layout;
// the result is checked against the data: green photosites must form the
// brightest class pre-white-balance on any real scene, and a shift that puts
// green elsewhere is replaced by the best-fitting one.
function xtransFor(abs, mosaic, w, h, top, left, stride) {
  const shifted = (oy, ox) => Array.from({ length: 36 }, (_, i) =>
    abs[(((i / 6) | 0) + oy) % 6 * 6 + ((i % 6) + ox) % 6])
  const mean = new Float64Array(36)
  const cnt = new Float64Array(36)
  for (let y = 0; y < h; y += 7) {
    const row = (y + top) * stride + left
    for (let x = 0; x < w; x += 1) {
      const k = (y % 6) * 6 + (x % 6)
      mean[k] += mosaic[row + x]
      cnt[k]++
    }
  }
  for (let k = 0; k < 36; k++) mean[k] /= cnt[k] || 1
  const greenScore = (p) => {
    let g = 0
    let o = 0
    for (let k = 0; k < 36; k++) p[k] === 1 ? (g += mean[k] / 20) : (o += mean[k] / 16)
    return g - o
  }
  const want = shifted(top % 6, left % 6)
  let best = want
  let bestScore = greenScore(want)
  for (let oy = 0; oy < 6; oy++) {
    for (let ox = 0; ox < 6; ox++) {
      const p = shifted(oy, ox)
      const sc = greenScore(p)
      if (sc > bestScore * 1.05) { best = p; bestScore = sc }
    }
  }
  return Uint8Array.from(best)
}

const exifOf = (m) => ({
  camera: [m.camera_make, m.camera_model].filter(Boolean).join(' ') || null,
  make: m.camera_make || null,
  model: m.camera_model || null,
  lens: m.lens?.Lens || null,
  iso: m.iso_speed || null,
  shutter: m.shutter || null,
  aperture: m.aperture || null,
  focal: m.focal_len || null,
  takenAt: m.timestamp instanceof Date && !isNaN(m.timestamp) ? m.timestamp.toISOString() : null,
})

const IDENTITY = Float32Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1)

// GPU texture formats have no 3-channel 16-bit layout; pad to RGBA once here.
function expandRgba(data, colors, alpha) {
  if (colors === 4) return data
  const n = data.length / colors
  const out = new data.constructor(n * 4)
  for (let i = 0, j = 0; j < out.length; i += colors, j += 4) {
    out[j] = data[i]
    out[j + 1] = data[i + 1]
    out[j + 2] = data[i + 2]
    out[j + 3] = alpha
  }
  return out
}

// LibRaw keeps some bodies' black level (Fuji, several Sony) in the
// per-channel cblack table, which this build does not expose: black reads 0.
// The sensor's masked margins are optical black, so measure it there — the
// median of up to 200k masked photosites, trusted only if it is plausible.
function blackOf(r, cd) {
  if (cd.black > 0) return cd.black
  const d = r.data
  const W = r.raw_width
  const H = r.raw_height
  const L = r.left_margin ?? 0
  const T = r.top_margin ?? 0
  const rects = [
    [L + r.width, 0, W, H], [0, 0, L, H], [0, 0, W, T], [0, T + r.height, W, H],
  ].filter(([x0, y0, x1, y1]) => x1 - x0 >= 4 && y1 - y0 >= 4)
  const area = rects.reduce((a, [x0, y0, x1, y1]) => a + (x1 - x0) * (y1 - y0), 0)
  if (!area) return 0
  const step = Math.max(1, Math.floor(area / 200000))
  const v = []
  for (const [x0, y0, x1, y1] of rects) {
    // skip two photosites next to the visible area: they can bleed light
    for (let y = y0 + 2; y < y1 - 2; y++) {
      for (let x = x0 + 2; x < x1 - 2; x += step) v.push(d[y * W + x])
    }
  }
  if (v.length < 100) return 0
  v.sort((a, b) => a - b)
  const med = v[v.length >> 1]
  return med > 0 && med < 0.25 * (cd.maximum || 65535) ? med : 0
}

function mosaicPayload(photoId, r, meta) {
  const cd = meta.color_data
  const M = cd.rgb_cam
  const g = cd.cam_mul?.[1] || 1
  return {
    photoId,
    kind: 'mosaic',
    width: r.width,
    height: r.height,
    bitDepth: 16,
    linear: true,
    // the whole raw frame, masked borders included: the GPU uploads the
    // visible area tile by tile through the margins, so no cropped copy of
    // a 60 MP mosaic is ever made
    buffer: r.data,
    rawWidth: r.raw_width,
    left: r.left_margin ?? 0,
    top: r.top_margin ?? 0,
    black: blackOf(r, cd),
    white: cd.maximum || 65535,
    camMul: [(cd.cam_mul?.[0] || g) / g, 1, (cd.cam_mul?.[2] || g) / g],
    // daylight multipliers, for writing a DNG colour matrix
    preMul: cd.pre_mul?.[1] ? [cd.pre_mul[0] / cd.pre_mul[1], 1, cd.pre_mul[2] / cd.pre_mul[1]] : null,
    camToSrgb: Float32Array.of(
      M[0][0], M[0][1], M[0][2],
      M[1][0], M[1][1], M[1][2],
      M[2][0], M[2][1], M[2][2],
    ),
    cfa: cfaPhase(meta.filters),
    flip: meta.flip ?? 0,
    exif: exifOf(meta),
  }
}

// libraw-wasm 1.6.0 ignores the gamm setting entirely: imageData() output is
// always BT.709-encoded (libraw's default curve). linear:false makes the GPU
// passthrough decode that curve, so every decoded source ends up linear.
function rgbPayload(photoId, img, meta) {
  const max = img.bits === 16 ? 65535 : 255
  return {
    photoId,
    kind: 'rgb',
    width: img.width,
    height: img.height,
    bitDepth: img.bits,
    linear: false,
    buffer: expandRgba(img.data, img.colors, max),
    black: 0,
    white: max,
    camMul: [1, 1, 1],
    camToSrgb: IDENTITY.slice(),
    cfa: [0, 0],
    flip: 0, // imageData() already applied the raw orientation
    exif: exifOf(meta),
  }
}

// camera WB + matrix baked in by libraw; 16-bit keeps the curve invertible.
const FALLBACK_RGB_SETTINGS = {
  outputBps: 16,
  useCameraWb: true,
  useCameraMatrix: 3,
  noAutoBright: true,
}

function xtransPayload(photoId, r, meta, bytes) {
  const p = mosaicPayload(photoId, r, meta)
  p.kind = 'xtrans'
  if (!p.black) p.black = rafBlack(bytes) ?? 0
  p.xtrans = xtransFor(rafXtrans(bytes) ?? XTRANS_DEFAULT, p.buffer, r.width, r.height,
    p.top, p.left, p.rawWidth)
  p.cfa = [0, 0]
  return p
}

async function decode({ photoId, buffer, name, quality }) {
  const bytes = new Uint8Array(buffer)
  const raw = new LibRaw()
  try {
    if (quality === 'proxy') {
      await raw.open(bytes, { halfSize: true, useCameraWb: true, noAutoBright: true })
      const meta = await raw.metadata(true)
      const img = await raw.imageData()
      return rgbPayload(photoId, img, meta)
    }

    // open() transfers its buffer into libraw's nested worker, so hand it a
    // copy and keep the original for the fallback re-open.
    await raw.open(bytes.slice(), {})
    const meta = await raw.metadata(true)
    const xtrans = meta.filters === 9 && !meta.is_foveon
    if ((canUseMosaic(meta) || xtrans) && meta.color_data?.rgb_cam?.[0]?.[0]) {
      try {
        const r = await raw.rawImageData()
        // the visible area must sit inside the frame it is cut from: Fuji's
        // Super CCD, for one, reports a rotated geometry that does not
        const fits = r && r.raw_width >= (r.left_margin ?? 0) + r.width &&
          r.raw_height >= (r.top_margin ?? 0) + r.height &&
          r.data?.length >= r.raw_width * r.raw_height
        if (fits) {
          // black level is only known after unpack (masked-pixel measurement)
          const meta2 = await raw.metadata(true)
          return xtrans ? xtransPayload(photoId, r, meta2, bytes) : mosaicPayload(photoId, r, meta2)
        }
      } catch {
        // compressed formats without mosaic access → demosaiced fallback
      }
    }
    await raw.open(bytes, FALLBACK_RGB_SETTINGS)
    const meta2 = await raw.metadata(true)
    const img = await raw.imageData()
    return rgbPayload(photoId, img, meta2)
  } finally {
    raw.dispose()
  }
}

self.onmessage = async (e) => {
  const data = e.data
  if (data.type !== MSG.DECODE) return
  try {
    const payload = await decode(data)
    self.postMessage({ re: data.id, type: MSG.DECODED, ...payload }, [payload.buffer.buffer])
  } catch (err) {
    self.postMessage({ re: data.id, type: MSG.ERROR, message: String(err?.message ?? err) })
  }
}
