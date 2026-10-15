// DNG 1.4 export: the undemosaiced CFA mosaic (encodeRawDng) or demosaiced
// linear camera RGB (encodeLinearDng), 16-bit, uncompressed, little-endian.
// Pure ES module (browser + Node) on top of tiff.js's IFD writer.
//
// File layout: IFD0 holds the image and all DNG metadata. With `preview`
// ({ width, height, data: Uint8Array RGB 8-bit sRGB }) IFD0 becomes that
// preview (NewSubFileType 1) and the raw moves to a SubIFD (tag 330), the
// layout cameras and Adobe's converter use.
//
// Tags written (raw/linear IFD):
//   254 NewSubFileType 0 (main image)       256/257 ImageWidth/Length
//   258 BitsPerSample 16 (× samples)        259 Compression 1 (none)
//   262 PhotometricInterpretation 32803 CFA | 34892 LinearRaw
//   273/279 StripOffsets/StripByteCounts    277 SamplesPerPixel 1 | 3
//   278 RowsPerStrip                        284 PlanarConfiguration 1
//   33421 CFARepeatPatternDim 2,2           33422 CFAPattern (0 R, 1 G, 2 B)
//   50710 CFAPlaneColor 0,1,2               50711 CFALayout 1 (rectangular)
//   50713 BlackLevelRepeatDim 2,2 (per-CFA-site black only)
//   50714 BlackLevel                        50717 WhiteLevel
//   50718 DefaultScale 1,1                  50719/50720 DefaultCropOrigin/Size
// IFD0 (shared with the raw IFD when there is no preview):
//   271/272 Make/Model                      274 Orientation (EXIF 1..8)
//   305 Software, 306 DateTime              700 XMP packet (if given)
//   34665 ExifIFD (ISO, shutter, aperture, focal, lens, DateTimeOriginal)
//   50706 DNGVersion 1.4.0.0                50707 DNGBackwardVersion 1.1.0.0
//   50708 UniqueCameraModel                 50721 ColorMatrix1 (XYZ → camera)
//   50728 AsShotNeutral                     50778 CalibrationIlluminant1 21 (D65)
//   50936 ProfileName "albedo"
//
// Raw layout: `mosaic` (or albedo's decode `buffer`) may be the whole sensor
// frame — pass rawWidth (row stride) and left/top of the visible area and it
// is cropped while writing; width/height are the visible size. cfaPattern is
// the 2×2 pattern at the visible area's top-left: 'RGGB' | 'BGGR' | 'GRBG' |
// 'GBRG', or albedo's `cfa` phase [ox, oy] via cfaPatternFromPhase.

import { T, writeTiff, baseTags, exifIfd } from './tiff.js'

const enc = new TextEncoder()

// ---------------------------------------------------------------------------
// color

// linear sRGB (D65) → XYZ, IEC 61966-2.1
export const SRGB_TO_XYZ = [
  [0.4124564, 0.3575761, 0.1804375],
  [0.2126729, 0.7151522, 0.0721750],
  [0.0193339, 0.1191920, 0.9503041],
]
const D65 = [0.95047, 1, 1.08883]

const mat3 = (m) => (m.length === 9 || ArrayBuffer.isView(m)
  ? [[m[0], m[1], m[2]], [m[3], m[4], m[5]], [m[6], m[7], m[8]]]
  : m.map((r) => Array.from(r)))
const mul = (a, b) => a.map((r) => b[0].map((_, j) => r[0] * b[0][j] + r[1] * b[1][j] + r[2] * b[2][j]))
const mulv = (a, v) => a.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2])
export function inv3(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m
  const A = e * i - f * h
  const B = -(d * i - f * g)
  const C = d * h - e * g
  const det = a * A + b * B + c * C
  if (Math.abs(det) < 1e-12) throw new Error('singular matrix')
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ]
}
export const XYZ_TO_SRGB = inv3(SRGB_TO_XYZ)

// DNG SDK convention: scale so the calibration illuminant's white (Y = 1)
// maps to a camera vector whose largest component is 1
function normaliseCm(cm) {
  const w = mulv(cm, D65)
  const k = 1 / Math.max(...w)
  return cm.map((r) => r.map((v) => v * k))
}

// XYZ(D65) → camera-native matrix from LibRaw's rgb_cam (albedo's
// payload.camToSrgb), for ColorMatrix1 with CalibrationIlluminant1 = D65.
//
// LibRaw (cam_xyz_coeff) builds rgb_cam as follows, with cam_xyz the
// XYZ → native camera matrix and xyz_rgb the sRGB → XYZ (D65) matrix:
//   cam_rgb  = cam_xyz · xyz_rgb               sRGB → native camera
//   pre_mul  = 1 / rowsum(cam_rgb)              daylight multipliers
//   cam_rgb' = diag(pre_mul) · cam_rgb          rows sum to 1: sRGB white → (1,1,1)
//   rgb_cam  = cam_rgb'⁻¹                       white-balanced camera → sRGB
// so  cam_xyz = diag(1/pre_mul) · rgb_cam⁻¹ · xyz_rgb⁻¹, which is what this
// returns (normalised). The row normalisation erased pre_mul from rgb_cam,
// so it must come from LibRaw (color_data.pre_mul). Without it, the as-shot
// camMul is the usual stand-in (exact when the shot was lit by daylight); a
// wrong guess tints the rendering but keeps the file valid.
export function colorMatrixFromCamToSrgb(camToSrgb, preMul = [1, 1, 1]) {
  const C = mat3(camToSrgb)
  const g = preMul[1] || 1
  const p = [preMul[0] / g, 1, preMul[2] / g]
  const cm = mul(inv3(C), XYZ_TO_SRGB).map((r, i) => r.map((v) => v / p[i]))
  return normaliseCm(cm)
}

// camera-native neutral (the as-shot white's raw response) = 1 / multipliers
export const asShotNeutralFromCamMul = (camMul) => {
  const g = camMul[1] || 1
  return [g / camMul[0], 1, g / camMul[2]]
}

const CFA = { R: 0, G: 1, B: 2 }
// albedo's phase: RGGB[(y+oy)&1][(x+ox)&1] is the color at (y, x)
export function cfaPatternFromPhase([ox, oy]) {
  const rggb = [['R', 'G'], ['G', 'B']]
  return [0, 1].flatMap((y) => [0, 1].map((x) => rggb[(y + oy) & 1][(x + ox) & 1])).join('')
}
const cfaBytes = (p) => {
  const s = String(p).toUpperCase()
  if (!/^[RGB]{4}$/.test(s)) throw new Error(`bad cfaPattern ${p}`)
  return Uint8Array.from(s, (c) => CFA[c])
}

// ---------------------------------------------------------------------------

const STRIP_BYTES = 1 << 18

// rows of `src` (stride rawWidth samples × spp) cropped to [left, left+width)
function strips({ src, width, height, spp, rawWidth, left, top }) {
  const rowLen = width * spp
  const rows = Math.max(1, Math.min(height, Math.floor(STRIP_BYTES / (rowLen * 2))))
  const le = new Uint8Array(Uint16Array.of(1).buffer)[0] === 1
  const out = []
  for (let y = 0; y < height; y += rows) {
    const n = Math.min(rows, height - y)
    const s = new Uint16Array(n * rowLen)
    for (let r = 0; r < n; r++) {
      const o = ((top + y + r) * rawWidth + left) * spp
      s.set(src.subarray(o, o + rowLen), r * rowLen)
    }
    const b = new Uint8Array(s.buffer)
    if (!le) for (let i = 0; i < b.length; i += 2) { const t = b[i]; b[i] = b[i + 1]; b[i + 1] = t }
    out.push(b)
  }
  return { strips: out, rowsPerStrip: rows }
}

const isInts = (a) => a.every((v) => Number.isInteger(v) && v >= 0)

function imageTags({ width, height, spp, photometric, rowsPerStrip, black, white }) {
  const t = {
    254: [T.LONG, 0],
    256: [T.LONG, width],
    257: [T.LONG, height],
    258: [T.SHORT, new Array(spp).fill(16)],
    259: [T.SHORT, 1],
    262: [T.SHORT, photometric],
    277: [T.SHORT, spp],
    278: [T.LONG, rowsPerStrip],
    284: [T.SHORT, 1],
    50717: [T.LONG, new Array(spp).fill(Math.round(white))],
    50718: [T.RATIONAL, [1, 1]],
    50719: [T.LONG, [0, 0]],
    50720: [T.LONG, [width, height]],
  }
  // count = repeat rows × cols × samples, so a scalar black repeats per sample
  const bl = Array.isArray(black) || ArrayBuffer.isView(black) ? Array.from(black) : new Array(spp).fill(black ?? 0)
  t[50714] = [isInts(bl) ? T.LONG : T.RATIONAL, bl]
  return t
}

function globalTags(o, uniqueDefault) {
  const make = o.make ?? o.exif?.make
  const model = o.model ?? o.exif?.model ?? o.exif?.camera
  const t = {
    ...baseTags({ ...o.exif, make, model }),
    274: [T.SHORT, o.orientation ?? 1],
    50706: [T.BYTE, Uint8Array.of(1, 4, 0, 0)],
    50707: [T.BYTE, Uint8Array.of(1, 1, 0, 0)],
    50708: [T.ASCII, o.uniqueCameraModel ?? ([make, model].filter(Boolean).join(' ') || uniqueDefault)],
    50721: [T.SRATIONAL, mat3(o.colorMatrix1).flat()],
    50728: [T.RATIONAL, o.asShotNeutral ?? [1, 1, 1]],
    50778: [T.SHORT, 21],
    50936: [T.ASCII, 'albedo'],
  }
  if (o.xmp) t[700] = [T.BYTE, enc.encode(o.xmp)]
  const ex = exifIfd(o.exif)
  if (ex) t[34665] = [T.LONG, { ifd: ex }]
  return t
}

function assemble(o, rawIfd, uniqueDefault) {
  const g = globalTags(o, uniqueDefault)
  if (!o.preview) return writeTiff([{ tags: { ...g, ...rawIfd.tags }, strips: rawIfd.strips }])
  const { width, height, data } = o.preview
  if (data.length < width * height * 3) throw new Error('preview data too short')
  const rowBytes = width * 3
  const rows = Math.max(1, Math.min(height, Math.floor(STRIP_BYTES / rowBytes)))
  const ps = []
  for (let y = 0; y < height; y += rows) ps.push(data.slice(y * rowBytes, Math.min(height, y + rows) * rowBytes))
  const ifd0 = {
    tags: {
      ...g,
      254: [T.LONG, 1],
      256: [T.LONG, width], 257: [T.LONG, height],
      258: [T.SHORT, [8, 8, 8]], 259: [T.SHORT, 1], 262: [T.SHORT, 2],
      277: [T.SHORT, 3], 278: [T.LONG, rows], 284: [T.SHORT, 1],
      330: [T.LONG, { ifds: [rawIfd] }],
      50970: [T.LONG, 2], // PreviewColorSpace sRGB
    },
    strips: ps,
  }
  return writeTiff([ifd0])
}

export function encodeRawDng(o) {
  const { width, height } = o
  const src = o.mosaic ?? o.buffer
  const rawWidth = o.rawWidth ?? width
  const left = o.left ?? 0
  const top = o.top ?? 0
  if (!(width > 0 && height > 0)) throw new Error('bad dimensions')
  if (!src || src.length < (top + height - 1) * rawWidth + left + width) throw new Error('mosaic too short for the visible area')
  if (!o.colorMatrix1) throw new Error('colorMatrix1 required')
  const pattern = o.cfaPattern ?? (o.cfa ? cfaPatternFromPhase(o.cfa) : 'RGGB')
  const { strips: st, rowsPerStrip } = strips({ src, width, height, spp: 1, rawWidth, left, top })
  const tags = {
    ...imageTags({ width, height, spp: 1, photometric: 32803, rowsPerStrip, black: o.black, white: o.white ?? 65535 }),
    33421: [T.SHORT, [2, 2]],
    33422: [T.BYTE, cfaBytes(pattern)],
    50710: [T.BYTE, Uint8Array.of(0, 1, 2)],
    50711: [T.SHORT, 1],
  }
  // per-CFA-site black: 4 values in the 2×2 repeat (row-major)
  if (tags[50714][1].length === 4) tags[50713] = [T.SHORT, [2, 2]]
  // DefaultCrop must start on a CFA repeat for some readers; ours is 0,0
  return assemble(o, { tags, strips: st }, 'albedo raw')
}

// Demosaiced linear 16-bit RGB in camera space (PhotometricInterpretation
// LinearRaw). colorMatrix1 defaults to XYZ → linear sRGB, i.e. "the camera
// is linear sRGB": right for albedo's demosaiced fallback once its BT.709
// curve is undone. data: Uint16Array RGB, or RGBA with channels: 4 (alpha
// dropped).
export function encodeLinearDng(o) {
  const { width, height } = o
  const ch = o.channels ?? o.data.length / (width * height)
  if (ch !== 3 && ch !== 4) throw new Error(`expected RGB or RGBA data, got ${ch} samples/pixel`)
  let src = o.data
  if (ch === 4) {
    src = new Uint16Array(width * height * 3)
    for (let i = 0, j = 0; j < src.length; i += 4, j += 3) { src[j] = o.data[i]; src[j + 1] = o.data[i + 1]; src[j + 2] = o.data[i + 2] }
  }
  const { strips: st, rowsPerStrip } = strips({ src, width, height, spp: 3, rawWidth: width, left: 0, top: 0 })
  const tags = imageTags({ width, height, spp: 3, photometric: 34892, rowsPerStrip, black: o.black ?? 0, white: o.white ?? 65535 })
  const colorMatrix1 = o.colorMatrix1 ?? normaliseCm(XYZ_TO_SRGB)
  return assemble({ ...o, colorMatrix1 }, { tags, strips: st }, 'albedo linear')
}
