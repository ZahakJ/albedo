// Minimal hand-rolled TIFF/EXIF reader. Covers JPEG (APP1) and TIFF-based RAW
// (CR2/NEF/ARW/DNG share the TIFF container). CR3 is ISO-BMFF, not TIFF: the
// top-level try/catch returns whatever partial data was gathered before the
// walk failed. All offsets are bounds-checked; a lying file yields nulls, not
// a crash.

const TAGS = {
  MAKE: 0x10f, MODEL: 0x110, ORIENTATION: 0x112,
  IMAGE_WIDTH: 0x100, IMAGE_LENGTH: 0x101,
  COMPRESSION: 0x103, NEW_SUBFILE_TYPE: 0xfe,
  STRIP_OFFSETS: 0x111, STRIP_BYTE_COUNTS: 0x117,
  JPEG_IF: 0x201, JPEG_IF_LENGTH: 0x202,
  EXIF_IFD: 0x8769, SUB_IFDS: 0x14a, DATETIME: 0x132,
  // Exif IFD
  EXPOSURE_TIME: 0x829a, F_NUMBER: 0x829d, ISO: 0x8827,
  DATETIME_ORIGINAL: 0x9003, FOCAL_LENGTH: 0x920a, LENS_MODEL: 0xa434,
  PIXEL_X: 0xa002, PIXEL_Y: 0xa003,
}

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8 }

// One IFD entry → JS value (first value, or array; ASCII → trimmed string).
function readValue(view, entry, littleEndian, tiffBase) {
  const type = view.getUint16(entry + 2, littleEndian)
  const count = view.getUint32(entry + 4, littleEndian)
  const size = TYPE_SIZE[type]
  if (!size || count === 0 || count > 0x100000) return null
  const byteLen = size * count
  let at = byteLen <= 4 ? entry + 8 : tiffBase + view.getUint32(entry + 8, littleEndian)
  if (at + byteLen > view.byteLength) return null

  if (type === 2) { // ASCII
    let s = ''
    for (let i = 0; i < count; i++) {
      const c = view.getUint8(at + i)
      if (c === 0) break
      s += String.fromCharCode(c)
    }
    return s.trim()
  }
  const one = (o) => {
    switch (type) {
      case 1: case 7: return view.getUint8(o)
      case 3: return view.getUint16(o, littleEndian)
      case 4: return view.getUint32(o, littleEndian)
      case 6: return view.getInt8(o)
      case 8: return view.getInt16(o, littleEndian)
      case 9: return view.getInt32(o, littleEndian)
      case 5: { const n = view.getUint32(o, littleEndian), d = view.getUint32(o + 4, littleEndian); return d ? n / d : 0 }
      case 10: { const n = view.getInt32(o, littleEndian), d = view.getInt32(o + 4, littleEndian); return d ? n / d : 0 }
      default: return null
    }
  }
  if (count === 1) return one(at)
  const out = new Array(count)
  for (let i = 0; i < count; i++) out[i] = one(at + i * size)
  return out
}

// Reads one IFD into { tags: Map, next: offset|0 }.
function readIfd(view, at, littleEndian, tiffBase) {
  if (at < 0 || at + 2 > view.byteLength) return null
  const n = view.getUint16(at, littleEndian)
  if (n > 512) return null // sane cap; corrupt counts otherwise walk gigabytes
  const tags = new Map()
  for (let i = 0; i < n; i++) {
    const entry = at + 2 + i * 12
    if (entry + 12 > view.byteLength) break
    tags.set(view.getUint16(entry, littleEndian), readValue(view, entry, littleEndian, tiffBase))
  }
  const nextAt = at + 2 + n * 12
  const next = nextAt + 4 <= view.byteLength ? view.getUint32(nextAt, littleEndian) : 0
  return { tags, next }
}

const first = (v) => (Array.isArray(v) ? v[0] : v)

// "YYYY:MM:DD HH:MM:SS" → epoch ms (local time; EXIF has no zone) | null.
function parseExifDate(s) {
  if (typeof s !== 'string') return null
  const m = s.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/)
  if (!m) return null
  const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime()
  return Number.isFinite(t) ? t : null
}

// SOFn markers (0xc4 DHT / 0xc8 JPG / 0xcc DAC are not frame headers).
const isSofMarker = (m) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc
// Only these three are decodable by a browser: baseline, extended sequential,
// progressive. SOF3 (lossless) is what CR2/DNG store their RAW strips in and
// SOF5-7/9-15 are differential/arithmetic — createImageBitmap rejects them all.
const DECODABLE_SOF = new Set([0xc0, 0xc1, 0xc2])

// First frame header of the JPEG stream at [offset, offset+length) →
// { marker, width, height, decodable } | null. bytes: ArrayBuffer, TypedArray
// or DataView. The IFD tags around an embedded preview describe the sensor,
// not the stream, so this is the only trustworthy source of preview dims.
export function parseJpegSof(bytes, offset = 0, length) {
  try {
    const view = bytes instanceof DataView ? bytes
      : bytes instanceof ArrayBuffer ? new DataView(bytes)
      : new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const end = Math.min(view.byteLength, offset + (length ?? view.byteLength - offset))
    if (offset + 4 > end || view.getUint16(offset) !== 0xffd8) return null
    let at = offset + 2
    while (at + 4 <= end) {
      if (view.getUint8(at) !== 0xff) return null
      const marker = view.getUint8(at + 1)
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { at += 2; continue }
      if (marker === 0xda || marker === 0xd9) return null // scan before frame: malformed
      const len = view.getUint16(at + 2)
      if (len < 2 || at + 2 + len > end) return null
      if (isSofMarker(marker)) {
        if (at + 10 > end) return null
        return {
          marker,
          height: view.getUint16(at + 5),
          width: view.getUint16(at + 7),
          decodable: DECODABLE_SOF.has(marker),
        }
      }
      at += 2 + len
    }
  } catch { /* truncated stream */ }
  return null
}

// A preview candidate only counts if the bytes start with SOI *and* carry a
// frame header we can read — dims and decodability both come from the stream.
function jpegCandidate(view, tiffBase, offset, length) {
  if (!offset || !length) return null
  const at = tiffBase + offset
  if (at + length > view.byteLength || length < 128) return null
  if (view.getUint16(at) !== 0xffd8) return null
  const sof = parseJpegSof(view, at, length)
  if (!sof || !sof.width || !sof.height) return null
  return { offset: at, length, width: sof.width, height: sof.height, decodable: sof.decodable }
}

// Walks the TIFF starting at tiffBase. Returns metadata + all embedded JPEG
// streams found in the IFD chain, SubIFDs, and IFD1 (the EXIF thumbnail).
function parseTiff(view, tiffBase) {
  const bom = view.getUint16(tiffBase)
  const littleEndian = bom === 0x4949
  if (!littleEndian && bom !== 0x4d4d) return null
  if (view.getUint16(tiffBase + 2, littleEndian) !== 42) return null

  const out = { previews: [], thumb: null }
  // queue holds [tiffBase-RELATIVE offset, chainIndex] — seeding with an
  // absolute offset double-counted the base for JPEG APP1 (base > 0).
  // chainIndex counts position in the IFD *chain* only (SubIFDs get -1): the
  // classic thumbnail is chain slot 1, whereas a DNG's SubIFD 0 is the full
  // image and must never be mistaken for it.
  const queue = [[view.getUint32(tiffBase + 4, littleEndian), 0]]
  const seen = new Set()
  const sized = [] // { subfileType, width, height } per non-thumbnail IFD
  let ifdCount = 0

  while (queue.length) {
    const [off, chainIndex] = queue.shift()
    if (!off || seen.has(off)) continue
    seen.add(off)
    // IFD offsets in TIFF are relative to tiffBase
    const parsed = readIfd(view, tiffBase + off, littleEndian, tiffBase)
    if (!parsed) continue
    const t = parsed.tags
    const isPrimary = chainIndex === 0
    const isThumbIfd = chainIndex === 1

    if (isPrimary) {
      out.make = t.get(TAGS.MAKE) ?? out.make
      out.model = t.get(TAGS.MODEL) ?? out.model
      out.orientation = first(t.get(TAGS.ORIENTATION)) ?? out.orientation
      out.dateTime = t.get(TAGS.DATETIME) ?? out.dateTime
    }

    const w = first(t.get(TAGS.IMAGE_WIDTH))
    const h = first(t.get(TAGS.IMAGE_LENGTH))
    if (!isThumbIfd && w > 0 && h > 0) {
      sized.push({ subfileType: first(t.get(TAGS.NEW_SUBFILE_TYPE)), width: w, height: h })
    }

    // Embedded JPEG streams: old-style JPEG pointer pair, or JPEG-compressed
    // strips (CR2 IFD0 keeps its full preview in StripOffsets).
    const comp = first(t.get(TAGS.COMPRESSION))
    let cand = jpegCandidate(view, tiffBase, first(t.get(TAGS.JPEG_IF)), first(t.get(TAGS.JPEG_IF_LENGTH)))
    if (!cand && (comp === 6 || comp === 7)) {
      cand = jpegCandidate(view, tiffBase, first(t.get(TAGS.STRIP_OFFSETS)), first(t.get(TAGS.STRIP_BYTE_COUNTS)))
    }
    if (cand) {
      // IFD1 of the Exif structure is the classic thumbnail
      if (isThumbIfd && !out.thumb) out.thumb = cand
      out.previews.push(cand)
    }

    const exifOff = first(t.get(TAGS.EXIF_IFD))
    if (exifOff) {
      const exif = readIfd(view, tiffBase + exifOff, littleEndian, tiffBase)
      if (exif) {
        const e = exif.tags
        out.iso = first(e.get(TAGS.ISO)) ?? out.iso
        out.shutter = first(e.get(TAGS.EXPOSURE_TIME)) ?? out.shutter
        out.aperture = first(e.get(TAGS.F_NUMBER)) ?? out.aperture
        out.focal = first(e.get(TAGS.FOCAL_LENGTH)) ?? out.focal
        out.lens = e.get(TAGS.LENS_MODEL) ?? out.lens
        out.dateTimeOriginal = e.get(TAGS.DATETIME_ORIGINAL) ?? out.dateTimeOriginal
        out.pixelX = out.pixelX ?? first(e.get(TAGS.PIXEL_X))
        out.pixelY = out.pixelY ?? first(e.get(TAGS.PIXEL_Y))
      }
    }

    const subs = t.get(TAGS.SUB_IFDS)
    if (subs != null) for (const s of Array.isArray(subs) ? subs : [subs]) queue.push([s, -1])
    if (parsed.next) queue.push([parsed.next, chainIndex < 0 ? -1 : chainIndex + 1])
    ifdCount++
    if (ifdCount > 32) break // corrupt chain guard
  }

  // The main image is the IFD flagged NewSubfileType 0 (DNG puts the 160×120
  // thumbnail in IFD0 and the real frame in a SubIFD); with no flag anywhere,
  // the largest IFD wins. Exif PixelXDimension is the last resort.
  const bigger = (a, b) => (b.width * b.height > a.width * a.height ? b : a)
  const full = sized.filter((d) => d.subfileType === 0)
  const main = (full.length ? full : sized).reduce(bigger, { width: 0, height: 0 })
  out.width = main.width || out.pixelX
  out.height = main.height || out.pixelY
  return out
}

// JPEG scan over [start, end) of `view` — find APP1/Exif for the TIFF block,
// and SOF for true pixel dims. Offsets stay absolute so an embedded stream
// (Fuji RAF) yields file-absolute preview offsets.
function parseJpeg(view, start = 0, end = view.byteLength) {
  let out = null
  let at = start + 2
  while (at + 4 <= end) {
    if (view.getUint8(at) !== 0xff) break
    const marker = view.getUint8(at + 1)
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue }
    if (marker === 0xda || marker === 0xd9) break // entropy data / EOI: done
    const len = view.getUint16(at + 2)
    if (len < 2 || at + 2 + len > end) break
    if (marker === 0xe1 && len >= 8 &&
        view.getUint32(at + 4) === 0x45786966 && view.getUint16(at + 8) === 0) { // "Exif\0\0"
      out = parseTiff(view, at + 10) ?? out
    }
    if (isSofMarker(marker)) { // authoritative dimensions of this stream
      out = out ?? {}
      out.height = view.getUint16(at + 5)
      out.width = view.getUint16(at + 7)
    }
    at += 2 + len
  }
  return out
}

// ── Fuji RAF ───────────────────────────────────────────────────────────────
// Not a TIFF: 16-byte magic, then a big-endian header table. The full-size
// preview JPEG (which carries the EXIF and its own thumbnail) sits at the
// offset/length declared at 84/88; the CFA header at 92/96 holds sensor dims.

const RAF_MAGIC = 'FUJIFILMCCD-RAW'

function isRaf(view) {
  if (view.byteLength < 100) return false // through the CFA header offset/length pair
  for (let i = 0; i < RAF_MAGIC.length; i++)
    if (view.getUint8(i) !== RAF_MAGIC.charCodeAt(i)) return false
  return true
}

// CFA header record table: u32 count, then { u16 tag, u16 length, payload }.
// 0x0111 RawImageCroppedSize / 0x0100 RawImageFullSize, each (height, width).
function rafSensorDims(view) {
  const off = view.getUint32(92)
  const len = view.getUint32(96)
  if (!off || !len || off + len > view.byteLength) return null
  const n = view.getUint32(off)
  if (n > 64) return null
  let at = off + 4
  let fallback = null
  for (let i = 0; i < n && at + 4 <= off + len; i++) {
    const tag = view.getUint16(at)
    const l = view.getUint16(at + 2)
    if (at + 4 + l > off + len) break
    if (l >= 4 && (tag === 0x0111 || tag === 0x0100)) {
      const dims = { width: view.getUint16(at + 6), height: view.getUint16(at + 4) }
      if (tag === 0x0111) return dims
      fallback = fallback ?? dims
    }
    at += 4 + l
  }
  return fallback
}

function parseRaf(view) {
  const offset = view.getUint32(84)
  const length = view.getUint32(88)
  if (!offset || !length || offset + length > view.byteLength) return null
  if (view.getUint16(offset) !== 0xffd8) return null
  const out = parseJpeg(view, offset, offset + length) ?? {}
  out.previews = out.previews ?? []
  const cand = jpegCandidate(view, 0, offset, length)
  if (cand) out.previews.push(cand)
  const dims = rafSensorDims(view)
  if (dims) { out.width = dims.width; out.height = dims.height }
  return out
}

// buffer: ArrayBuffer of the whole file. Returns a flat, camelCase summary;
// every field may be undefined. previews/thumb carry ABSOLUTE byte offsets
// into the buffer so callers can slice the embedded JPEG directly.
export function parseExif(buffer) {
  const out = {
    make: undefined, model: undefined, lens: undefined,
    iso: undefined, shutter: undefined, aperture: undefined, focal: undefined,
    takenAt: null, width: undefined, height: undefined, orientation: undefined,
    thumb: null, previews: [], isTiff: false,
  }
  try {
    const view = new DataView(buffer)
    if (view.byteLength < 16) return out
    let parsed = null
    if (view.getUint16(0) === 0xffd8) {
      parsed = parseJpeg(view)
    } else if (isRaf(view)) {
      parsed = parseRaf(view)
    } else {
      const bom = view.getUint16(0)
      if (bom === 0x4949 || bom === 0x4d4d) {
        parsed = parseTiff(view, 0)
        if (parsed) out.isTiff = true
      }
    }
    if (parsed) {
      Object.assign(out, {
        make: parsed.make, model: parsed.model, lens: parsed.lens,
        iso: parsed.iso, shutter: parsed.shutter, aperture: parsed.aperture,
        focal: parsed.focal, orientation: parsed.orientation,
        width: parsed.width, height: parsed.height,
        thumb: parsed.thumb ?? null, previews: parsed.previews ?? [],
        takenAt: parseExifDate(parsed.dateTimeOriginal) ?? parseExifDate(parsed.dateTime),
        isTiff: out.isTiff,
      })
    }
  } catch { /* partial data is the contract for non-TIFF RAW (CR3 etc.) */ }
  return out
}

// Largest DECODABLE embedded JPEG by pixel area — the cheap RAW preview path.
// Byte length is the wrong ranking: a CR2/DNG's biggest stream is its lossless
// SOF3 RAW data, which no browser decodes (that produced blank thumbnails).
// null means "nothing here a canvas can draw" → caller falls back to libraw.
export function biggestPreview(exif) {
  let best = null
  for (const p of exif.previews) {
    if (!p.decodable) continue
    if (!best || p.width * p.height > best.width * best.height) best = p
  }
  return best
}

// ── EXIF carry-over for exports ────────────────────────────────────────────
// Canvas re-encodes drop metadata, so JPEG exports splice the original's APP1
// back in: exifApp1() lifts the segment payload off the source JPEG,
// stripOrientation() neutralizes tag 0x112 (export pixels are already
// oriented), spliceExifJpeg() inserts it right after SOI in the encoded file.

// ArrayBuffer of a JPEG → Uint8Array copy of its APP1 Exif payload (starting
// "Exif\0\0"), or null (not a JPEG / no Exif APP1 — TIFF-based RAW has none).
export function exifApp1(buffer) {
  try {
    const view = new DataView(buffer)
    if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null
    let at = 2
    while (at + 4 <= view.byteLength) {
      if (view.getUint8(at) !== 0xff) break
      const marker = view.getUint8(at + 1)
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue }
      if (marker === 0xda || marker === 0xd9) break // entropy data / EOI
      const len = view.getUint16(at + 2)
      if (len < 2 || at + 2 + len > view.byteLength) break
      if (marker === 0xe1 && len >= 8 &&
          view.getUint32(at + 4) === 0x45786966 && view.getUint16(at + 8) === 0) { // "Exif\0\0"
        return new Uint8Array(buffer.slice(at + 4, at + 2 + len))
      }
      at += 2 + len
    }
  } catch { /* corrupt file → no carry-over */ }
  return null
}

// APP1 payload ("Exif\0\0" + TIFF) → copy with IFD0 Orientation forced to 1.
// Walks only IFD0 (where 0x112 lives); a malformed payload returns unchanged.
export function stripOrientation(app1) {
  const out = app1.slice()
  try {
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
    const base = 6 // past "Exif\0\0"
    const bom = view.getUint16(base)
    const le = bom === 0x4949
    if (!le && bom !== 0x4d4d) return out
    let at = base + view.getUint32(base + 4, le)
    if (at + 2 > out.length) return out
    const n = view.getUint16(at, le)
    for (let i = 0; i < Math.min(n, 512); i++) {
      const entry = at + 2 + i * 12
      if (entry + 12 > out.length) break
      if (view.getUint16(entry, le) === 0x112) { // Orientation, SHORT, count 1: inline value
        view.setUint16(entry + 8, 1, le)
        break
      }
    }
  } catch { /* leave as-is */ }
  return out
}

// Exported-JPEG bytes + APP1 payload → new bytes with the segment inserted
// immediately after SOI (Exif spec position). Payload > segment max → unchanged.
export function spliceExifJpeg(jpegBytes, app1) {
  if (!app1 || app1.length + 2 > 0xffff) return jpegBytes
  if (jpegBytes.length < 2 || jpegBytes[0] !== 0xff || jpegBytes[1] !== 0xd8) return jpegBytes
  const out = new Uint8Array(jpegBytes.length + 4 + app1.length)
  out[0] = 0xff
  out[1] = 0xd8
  out[2] = 0xff
  out[3] = 0xe1
  out[4] = (app1.length + 2) >> 8
  out[5] = (app1.length + 2) & 0xff
  out.set(app1, 6)
  out.set(jpegBytes.subarray(2), 6 + app1.length)
  return out
}
