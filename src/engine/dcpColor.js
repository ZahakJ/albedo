// DNG-SDK colour pipeline for a parsed DCP (src/io/dcp.js), in plain JS so
// the worker can bake uniforms/LUTs once per open. Follows dng_color_spec,
// dng_temperature, dng_hue_sat_map, dng_spline_solver and dng_render.
//
// Conventions (match decode.worker.js mosaicPayload):
//  - input to every cam* matrix is white-balanced camera RGB: raw * camMul,
//    camMul = neutral[1] / neutral, i.e. green mul = 1 and a neutral surface
//    reads (1,1,1). Matrices are Float32Array(9), row-major, out = M * in.
//  - WB'd white (1,1,1) maps to the illuminant-free PCS white at Y = 1, so
//    camToRec709 * (1,1,1) = (1,1,1) like LibRaw's rgb_cam. (The SDK instead
//    puts its max-channel camera white at Y = 1; identical when green is the
//    largest neutral channel, which it is for every Bayer camera we know.)
//  - PCS is XYZ D50 (xy 0.3457, 0.3585). ProPhoto is linear ROMM RGB, D50.
//    Rec.709 is linear sRGB primaries, D65 (xy 0.3127, 0.3290), via Bradford.
//
// Where the profile stages apply (dng_render order), for a shader:
//   proPhoto = camToProPhoto * wbCam          (linear ProPhoto, D50)
//   1. HueSatMap  in HSV of linear ProPhoto   (hsv LUT, see bakeHsv)
//   2. exposure   (BaselineExposure + offset, user exposure)
//   3. LookTable  in HSV of linear ProPhoto   (folded into the same hsv LUT)
//   4. ToneCurve  on linear ProPhoto, hue-preserving RGB tone (toneLut)
//   rec709 = prophotoToRec709 * proPhoto
// Skipping 1–4 gives camToRec709 directly.

// ---- 3×3 helpers (row-major arrays of 9) ----------------------------------

export const mul3 = (a, b) => {
  const o = new Array(9)
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]
    }
  }
  return o
}

export const mulV = (m, v) => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
]

export function inv3(m) {
  const [a, b, c, d, e, f, g, h, i] = m
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g
  const det = a * A + b * B + c * C
  if (Math.abs(det) < 1e-300) throw new Error('dcpColor: singular matrix')
  const k = 1 / det
  return [
    A * k, -(b * i - c * h) * k, (b * f - c * e) * k,
    B * k, (a * i - c * g) * k, -(a * f - c * d) * k,
    C * k, -(a * h - b * g) * k, (a * e - b * d) * k,
  ]
}

const diag = (v) => [v[0], 0, 0, 0, v[1], 0, 0, 0, v[2]]
const lerp = (a, b, w) => a.map((x, i) => w * x + (1 - w) * b[i]) // w weights a

// ---- chromaticity ------------------------------------------------------------

export const D50_XY = [0.3457, 0.3585] // dng_xy_coord D50 (SDK's PCS white)
export const D65_XY = [0.3127, 0.3290]

export const xyToXYZ = ([x, y]) => {
  // SDK pins xy into a sane range before dividing
  x = Math.min(Math.max(x, 0.000001), 0.999999)
  y = Math.min(Math.max(y, 0.000001), 0.999999)
  if (x + y > 0.999999) { const s = 0.999999 / (x + y); x *= s; y *= s }
  return [x / y, 1, (1 - x - y) / y]
}

export const XYZtoXy = ([X, Y, Z]) => {
  const t = X + Y + Z
  return t > 0 ? [X / t, Y / t] : D50_XY.slice()
}

// RGB→XYZ from primaries + white (Y of white = 1)
export function rgbToXYZ(prim, white) {
  const P = [], cols = prim.map(xyToXYZ)
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) P.push(cols[c][r])
  const S = mulV(inv3(P), xyToXYZ(white))
  return mul3(P, diag(S))
}

export const BRADFORD = [
  0.8951, 0.2664, -0.1614,
  -0.7502, 1.7135, 0.0367,
  0.0389, -0.0685, 1.0296,
]

// dng MapWhiteMatrix: Bradford XYZ adaptation srcWhite→dstWhite. Whites are
// xy pairs or XYZ triples; cone ratios pinned to [0.1, 10] as in the SDK.
export function bradford(src, dst) {
  const w1 = mulV(BRADFORD, src.length === 2 ? xyToXYZ(src) : src).map((v) => Math.max(v, 0))
  const w2 = mulV(BRADFORD, dst.length === 2 ? xyToXYZ(dst) : dst).map((v) => Math.max(v, 0))
  const A = w1.map((v, i) => Math.min(Math.max(v > 0 ? w2[i] / v : 10, 0.1), 10))
  return mul3(inv3(BRADFORD), mul3(diag(A), BRADFORD))
}

const PROPHOTO_PRIM = [[0.7347, 0.2653], [0.1596, 0.8404], [0.0366, 0.0001]]
const REC709_PRIM = [[0.64, 0.33], [0.30, 0.60], [0.15, 0.06]]

export const PROPHOTO_TO_XYZ_D50 = rgbToXYZ(PROPHOTO_PRIM, D50_XY)
export const XYZ_D50_TO_PROPHOTO = inv3(PROPHOTO_TO_XYZ_D50)
export const REC709_TO_XYZ_D65 = rgbToXYZ(REC709_PRIM, D65_XY)
export const XYZ_D65_TO_REC709 = inv3(REC709_TO_XYZ_D65)
export const XYZ_D50_TO_REC709 = mul3(XYZ_D65_TO_REC709, bradford(D50_XY, D65_XY))
export const PROPHOTO_TO_REC709 = mul3(XYZ_D50_TO_REC709, PROPHOTO_TO_XYZ_D50)

// ---- correlated colour temperature (dng_temperature, Robertson) -------------

const TINT_SCALE = -3000
// [ 1e6/T (mired), u, v, isotherm slope ] — Robertson 1968, as in the SDK
const TEMP_TABLE = [
  [0, 0.18006, 0.26352, -0.24341], [10, 0.18066, 0.26589, -0.25479],
  [20, 0.18133, 0.26846, -0.26876], [30, 0.18208, 0.27119, -0.28539],
  [40, 0.18293, 0.27407, -0.30470], [50, 0.18388, 0.27709, -0.32675],
  [60, 0.18494, 0.28021, -0.35156], [70, 0.18611, 0.28342, -0.37915],
  [80, 0.18740, 0.28668, -0.40955], [90, 0.18880, 0.28997, -0.44278],
  [100, 0.19032, 0.29326, -0.47888], [125, 0.19462, 0.30141, -0.58204],
  [150, 0.19962, 0.30921, -0.70471], [175, 0.20525, 0.31647, -0.84901],
  [200, 0.21142, 0.32312, -1.0182], [225, 0.21807, 0.32909, -1.2168],
  [250, 0.22511, 0.33439, -1.4512], [275, 0.23247, 0.33904, -1.7298],
  [300, 0.24010, 0.34308, -2.0637], [325, 0.24792, 0.34655, -2.4681],
  [350, 0.25591, 0.34951, -2.9641], [375, 0.26400, 0.35200, -3.5814],
  [400, 0.27218, 0.35407, -4.3633], [425, 0.28039, 0.35577, -5.3762],
  [450, 0.28863, 0.35714, -6.7262], [475, 0.29685, 0.35823, -8.5955],
  [500, 0.30505, 0.35907, -11.324], [525, 0.31320, 0.35968, -15.628],
  [550, 0.32129, 0.36011, -23.325], [575, 0.32931, 0.36038, -40.770],
  [600, 0.33724, 0.36051, -116.45],
]

export function xyToTemperature([x, y]) {
  const den = 1.5 - x + 6 * y
  const u = 2 * x / den, v = 3 * y / den
  let lastDt = 0, lastDu = 0, lastDv = 0
  for (let i = 1; i <= 30; i++) {
    let du = 1, dv = TEMP_TABLE[i][3]
    let len = Math.hypot(du, dv)
    du /= len; dv /= len
    let uu = u - TEMP_TABLE[i][1], vv = v - TEMP_TABLE[i][2]
    let dt = -uu * dv + vv * du
    if (dt <= 0 || i === 30) {
      if (dt > 0) dt = 0
      dt = -dt
      const f = i === 1 ? 0 : dt / (lastDt + dt)
      const temperature = 1e6 / (TEMP_TABLE[i - 1][0] * f + TEMP_TABLE[i][0] * (1 - f))
      uu = u - (TEMP_TABLE[i - 1][1] * f + TEMP_TABLE[i][1] * (1 - f))
      vv = v - (TEMP_TABLE[i - 1][2] * f + TEMP_TABLE[i][2] * (1 - f))
      du = du * (1 - f) + lastDu * f
      dv = dv * (1 - f) + lastDv * f
      len = Math.hypot(du, dv)
      du /= len; dv /= len
      return { temperature, tint: (uu * du + vv * dv) * TINT_SCALE }
    }
    lastDt = dt; lastDu = du; lastDv = dv
  }
}

export function temperatureToXy(temperature, tint = 0) {
  const r = 1e6 / temperature
  const offset = tint / TINT_SCALE
  for (let i = 0; i <= 29; i++) {
    if (r < TEMP_TABLE[i + 1][0] || i === 29) {
      const a = TEMP_TABLE[i], b = TEMP_TABLE[i + 1]
      const f = (b[0] - r) / (b[0] - a[0])
      let u = a[1] * f + b[1] * (1 - f)
      let v = a[2] * f + b[2] * (1 - f)
      const l1 = Math.hypot(1, a[3]), l2 = Math.hypot(1, b[3])
      let uu = f / l1 + (1 - f) / l2
      let vv = a[3] / l1 * f + b[3] / l2 * (1 - f)
      const l3 = Math.hypot(uu, vv)
      uu /= l3; vv /= l3
      u += uu * offset; v += vv * offset
      const d = u - 4 * v + 2
      return [1.5 * u / d, v / d]
    }
  }
}

// EXIF LightSource → kelvin (dng_camera_profile::IlluminantToTemperature)
export function illuminantTemperature(code) {
  switch (code) {
    case 17: case 3: return 2850 // Standard A, Tungsten
    case 24: return 3200 // ISO studio tungsten
    case 23: return 5000 // D50
    case 20: case 1: case 9: case 4: case 18: return 5500 // D55, daylight, fine, flash, B
    case 21: case 19: case 10: return 6500 // D65, C, cloudy
    case 22: case 11: return 7500 // D75, shade
    case 12: return (5700 + 7100) * 0.5 // daylight fluorescent
    case 13: return (4600 + 5500) * 0.5 // day white fluorescent
    case 14: case 2: return (3800 + 4500) * 0.5 // cool white fluorescent
    case 15: return (3250 + 3800) * 0.5 // white fluorescent
    case 16: return (2600 + 3250) * 0.5 // warm white fluorescent
    default: return 0
  }
}

// Calibration set normalised so set 1 is the lower temperature (SDK swaps).
function calibration(profile) {
  if (profile.channels && profile.channels !== 3) throw new Error('dcpColor: only 3-channel profiles')
  const cm1 = profile.colorMatrix1, cm2 = profile.colorMatrix2
  if (!cm1) throw new Error('dcpColor: profile has no ColorMatrix1')
  let t1 = illuminantTemperature(profile.illuminants?.[0] ?? 0)
  let t2 = illuminantTemperature(profile.illuminants?.[1] ?? 0)
  const hsm = profile.hueSatMap
  let s1 = { cm: cm1, fm: profile.forwardMatrix1, hsv: hsm?.data1 ?? hsm?.data2 ?? null }
  let s2 = { cm: cm2, fm: profile.forwardMatrix2, hsv: hsm?.data2 ?? hsm?.data1 ?? null }
  const dual = !!cm2 && t1 > 0 && t2 > 0 && t1 !== t2
  if (dual && t1 > t2) { [s1, s2] = [s2, s1];[t1, t2] = [t2, t1] }
  return { dual, t1, t2, s1, s2 }
}

// Weight of calibration set 1 (the lower-K one) for a white of `temperature`:
// linear in inverse CCT, clamped outside [t1, t2].
export function interpolationWeight(temperature, t1, t2) {
  if (temperature <= t1) return 1
  if (temperature >= t2) return 0
  return (1 / temperature - 1 / t2) / (1 / t1 - 1 / t2)
}

function setForWhite(cal, xy) {
  if (!cal.dual) return { w: 1, cm: cal.s1.cm, fm: cal.s1.fm, hsv: cal.s1.hsv }
  const w = interpolationWeight(xyToTemperature(xy).temperature, cal.t1, cal.t2)
  const pick = (a, b) => (a && b ? lerp(a, b, w) : a || b || null)
  // SDK uses forward matrices only when both are present on a dual profile
  const fm = cal.s1.fm && cal.s2.fm ? lerp(cal.s1.fm, cal.s2.fm, w) : null
  return { w, cm: pick(cal.s1.cm, cal.s2.cm), fm, hsv: pick(cal.s1.hsv, cal.s2.hsv) }
}

// dng_color_spec::NeutralToXY — fixed point of xy → matrix(xy) → xy.
export function neutralToXy(profile, neutral) {
  const cal = calibration(profile)
  let last = D50_XY.slice()
  for (let pass = 0; pass < 30; pass++) {
    const xyzToCam = setForWhite(cal, last).cm
    let next = XYZtoXy(mulV(inv3(xyzToCam), neutral))
    if (Math.abs(next[0] - last[0]) + Math.abs(next[1] - last[1]) < 1e-7) return next
    // non-convergence is a two-value oscillation: settle on the midpoint
    if (pass === 29) next = [(last[0] + next[0]) / 2, (last[1] + next[1]) / 2]
    last = next
  }
  return last
}

// WB'd camera → XYZ D50, scaled so (1,1,1) lands on Y = 1.
function cameraToPcs(set, white, n) {
  let m
  if (set.fm) {
    // NormalizeForwardMatrix: FM * (1,1,1) = PCS white; then undo the
    // SDK's camera-white division and redo it with the neutral we balanced by
    const fmOne = mulV(set.fm, [1, 1, 1])
    const pcs = xyToXYZ(D50_XY)
    const fmN = mul3(diag(pcs.map((v, i) => v / fmOne[i])), set.fm)
    const cw = mulV(set.cm, xyToXYZ(white))
    m = mul3(fmN, diag(n.map((v, i) => v / cw[i])))
  } else {
    const pcsToCam = mul3(set.cm, bradford(D50_XY, white))
    m = mul3(inv3(pcsToCam), diag(n))
  }
  const y = m[3] + m[4] + m[5]
  return m.map((v) => v / y)
}

// ---- HSV tables ------------------------------------------------------------

export function rgbToHsv(r, g, b) {
  const v = Math.max(r, g, b), gap = v - Math.min(r, g, b)
  if (!(gap > 0)) return [0, 0, v]
  let h
  if (r === v) { h = (g - b) / gap; if (h < 0) h += 6 } else if (g === v) h = 2 + (b - r) / gap
  else h = 4 + (r - g) / gap
  return [h, gap / v, v] // h in [0, 6)
}

export function hsvToRgb(h, s, v) {
  if (!(s > 0)) return [v, v, v]
  h = ((h % 6) + 6) % 6
  const i = Math.floor(h), f = h - i
  const p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f))
  return [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i]
}

// sRGB transfer, used as the value-axis encoding when encoding = 1
export const srgbEncode = (x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055)
export const srgbDecode = (x) => (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4))
const clamp01 = (x) => Math.min(Math.max(x, 0), 1)

// dng RefBaselineHueSatMap lookup: returns [hueShiftDeg, satScale, valScale].
// `vEnc` is the value already in the table's encoding (ignored for 2.5D).
export function lookupHsv(dims, data, h, s, vEnc) {
  const [hd, sd, vd] = dims
  const hScale = hd < 2 ? 0 : hd / 6
  const sScaled = clamp01(s) * (sd - 1)
  const hScaled = (((h % 6) + 6) % 6) * hScale
  let h0 = Math.floor(hScaled), h1 = h0 + 1
  if (h0 >= hd - 1) { h0 = hd - 1; h1 = 0 } // hue wraps
  const hf = hScaled - h0
  const s0 = Math.min(Math.floor(sScaled), Math.max(sd - 2, 0))
  const s1 = Math.min(s0 + 1, sd - 1)
  const sf = sScaled - s0
  let v0 = 0, v1 = 0, vf = 0
  if (vd >= 2) {
    const vScaled = clamp01(vEnc) * (vd - 1)
    v0 = Math.min(Math.floor(vScaled), vd - 2)
    v1 = v0 + 1
    vf = vScaled - v0
  }
  const at = (vi, hi, si, k) => data[((vi * hd + hi) * sd + si) * 3 + k]
  const out = [0, 0, 0]
  for (let k = 0; k < 3; k++) {
    const plane = (vi) => {
      const a = at(vi, h0, s0, k) * (1 - hf) + at(vi, h1, s0, k) * hf
      const b = at(vi, h0, s1, k) * (1 - hf) + at(vi, h1, s1, k) * hf
      return a * (1 - sf) + b * sf
    }
    out[k] = vd >= 2 ? plane(v0) * (1 - vf) + plane(v1) * vf : plane(0)
  }
  return out
}

// One table stage on an HSV triple (linear v); v is not clamped above 1 so
// scene-linear highlights survive (the SDK pins to [0,1] — its data is 0..1).
function applyStage(st, [h, s, v]) {
  const enc = st.dims[2] >= 2 && st.encoding === 1
  const ve = enc ? srgbEncode(clamp01(v)) : v
  const [dh, ss, vs] = lookupHsv(st.dims, st.data, h, s, ve)
  let v2 = enc ? srgbDecode(clamp01(ve * vs)) : v * vs
  if (enc && v > 1) v2 = v * vs // above the table's domain: plain scale
  return [h + dh * 6 / 360, Math.min(s * ss, 1), v2, dh, ss, vs]
}

// Bake HueSatMap (already illuminant-interpolated) and LookTable into a
// single delta table. Exact when only one stage exists; with both, the
// grid holds the composition evaluated at each node (exposure between the
// two stages is assumed 0 EV, as for a default render).
export function bakeHsv(stages) {
  stages = stages.filter(Boolean)
  if (!stages.length) return null
  if (stages.length === 1) {
    const st = stages[0]
    return { dims: st.dims.slice(), encoding: st.dims[2] >= 2 ? st.encoding : 0, lut: toRgba(st.data) }
  }
  const dims = [0, 1, 2].map((i) => Math.max(...stages.map((s) => s.dims[i])))
  const v3 = stages.find((s) => s.dims[2] >= 2)
  const encoding = dims[2] >= 2 ? v3.encoding : 0
  const [hd, sd, vd] = dims
  const lut = new Float32Array(hd * sd * vd * 4)
  for (let vi = 0; vi < vd; vi++) {
    const ve = vd >= 2 ? vi / (vd - 1) : 1
    const v = encoding === 1 ? srgbDecode(ve) : ve
    for (let hi = 0; hi < hd; hi++) {
      for (let si = 0; si < sd; si++) {
        let hsv = [hi * 6 / hd, sd >= 2 ? si / (sd - 1) : 0, v]
        let dh = 0, ss = 1, vs = 1
        for (const st of stages) {
          const r = applyStage(st, hsv)
          hsv = r.slice(0, 3)
          dh += r[3]; ss *= r[4]; vs *= r[5]
        }
        // value scale re-expressed in the baked table's encoding
        const e0 = encoding === 1 ? srgbEncode(clamp01(v)) : v
        const e1 = encoding === 1 ? srgbEncode(clamp01(hsv[2])) : hsv[2]
        const o = ((vi * hd + hi) * sd + si) * 4
        lut[o] = dh; lut[o + 1] = ss; lut[o + 2] = e0 > 1e-6 ? e1 / e0 : vs; lut[o + 3] = 1
      }
    }
  }
  return { dims, encoding, lut }
}

function toRgba(d) {
  const n = d.length / 3, o = new Float32Array(n * 4)
  for (let i = 0; i < n; i++) {
    o[i * 4] = d[i * 3]; o[i * 4 + 1] = d[i * 3 + 1]; o[i * 4 + 2] = d[i * 3 + 2]; o[i * 4 + 3] = 1
  }
  return o
}

// Reference CPU application of a baked table (what the shader must match).
export function applyHsvLut(hsv, rgb) {
  const [h, s, v] = rgbToHsv(...rgb)
  const vd = hsv.dims[2]
  const enc = vd >= 2 && hsv.encoding === 1
  const ve = enc ? srgbEncode(clamp01(v)) : v
  const data = new Float32Array(hsv.lut.length / 4 * 3)
  for (let i = 0, j = 0; i < hsv.lut.length; i += 4, j += 3) {
    data[j] = hsv.lut[i]; data[j + 1] = hsv.lut[i + 1]; data[j + 2] = hsv.lut[i + 2]
  }
  const [dh, ss, vs] = lookupHsv(hsv.dims, data, h, s, ve)
  const v2 = enc && v <= 1 ? srgbDecode(clamp01(ve * vs)) : v * vs
  return hsvToRgb(h + dh * 6 / 360, Math.min(s * ss, 1), v2)
}

// ---- tone curve (dng_spline_solver) -----------------------------------------

export function splineSolver(points) {
  const X = points.map((p) => p[0]), Y = points.map((p) => p[1])
  const n = X.length
  const S = new Array(n)
  let A = X[1] - X[0], B = (Y[1] - Y[0]) / A
  S[0] = B
  for (let j = 2; j < n; j++) {
    const C = X[j] - X[j - 1], D = (Y[j] - Y[j - 1]) / C
    S[j - 1] = (B * C + D * A) / (A + C)
    A = C; B = D
  }
  S[n - 1] = 2 * B - S[n - 2]
  S[0] = 2 * S[0] - S[1]
  if (n > 2) {
    const E = new Array(n), F = new Array(n), G = new Array(n)
    F[0] = 0.5; E[n - 1] = 0.5
    G[0] = 0.75 * (S[0] + S[1]); G[n - 1] = 0.75 * (S[n - 2] + S[n - 1])
    for (let j = 1; j < n - 1; j++) {
      const a = (X[j + 1] - X[j - 1]) * 2
      E[j] = (X[j + 1] - X[j]) / a
      F[j] = (X[j] - X[j - 1]) / a
      G[j] = 1.5 * S[j]
    }
    for (let j = 1; j < n; j++) {
      const a = 1 - F[j - 1] * E[j]
      if (j !== n - 1) F[j] /= a
      G[j] = (G[j] - G[j - 1] * E[j]) / a
    }
    for (let j = n - 2; j >= 0; j--) G[j] = G[j] - F[j] * G[j + 1]
    for (let j = 0; j < n; j++) S[j] = G[j]
  }
  return (x) => {
    if (x <= X[0]) return Y[0]
    if (x >= X[n - 1]) return Y[n - 1]
    let lo = 1, hi = n - 1
    while (hi > lo) {
      const mid = (lo + hi) >> 1
      if (x === X[mid]) return Y[mid]
      if (x > X[mid]) lo = mid + 1
      else hi = mid
    }
    const j = lo, x0 = X[j - 1], x1 = X[j]
    const a = x1 - x0, b = (x - x0) / a, c = (x1 - x) / a
    return ((Y[j - 1] * (2 - c + b) + S[j - 1] * a * b) * c * c) +
      ((Y[j] * (2 - b + c) - S[j] * a * c) * b * b)
  }
}

// Uniform samples of the curve over linear x ∈ [0,1]: lut[i] = f(i/(size-1)).
export function bakeToneLut(points, size = 1024) {
  if (!points || points.length < 2) return null
  const f = splineSolver(points)
  const lut = new Float32Array(size)
  for (let i = 0; i < size; i++) lut[i] = f(i / (size - 1))
  return lut
}

// dng RefBaselineRGBTone: curve on max and min, middle channel keeps its
// relative position — hue-preserving. Reference for the shader.
export function applyRgbTone(lut, rgb) {
  const N = lut.length - 1
  const f = (x) => {
    const t = clamp01(x) * N, i = Math.min(Math.floor(t), N - 1)
    return lut[i] + (lut[i + 1] - lut[i]) * (t - i)
  }
  const idx = [0, 1, 2].sort((a, b) => rgb[b] - rgb[a])
  const [hi, mid, lo] = idx.map((i) => rgb[i])
  const H = f(hi), L = f(lo)
  const M = hi > lo ? L + (H - L) * (mid - lo) / (hi - lo) : H
  const out = [0, 0, 0]
  out[idx[0]] = H; out[idx[1]] = M; out[idx[2]] = L
  return out
}

// ---- entry point --------------------------------------------------------------

const f32 = (m) => Float32Array.from(m)

// profile: parseDcp() output. camNeutral: camera-space neutral (AsShotNeutral,
// or 1/camMul). Options: { toneSize = 1024 }.
export function buildDcpTransform(profile, camNeutral, { toneSize = 1024 } = {}) {
  const n = camNeutral.map((v) => Math.max(v, 1e-6) / Math.max(camNeutral[1], 1e-6))
  const cal = calibration(profile)
  const white = neutralToXy(profile, n)
  const set = setForWhite(cal, white)
  const camToXYZ = cameraToPcs(set, white, n)
  const camToProPhoto = mul3(XYZ_D50_TO_PROPHOTO, camToXYZ)
  const camToRec709 = mul3(XYZ_D50_TO_REC709, camToXYZ)

  const hsm = profile.hueSatMap && set.hsv
    ? { dims: profile.hueSatMap.dims, data: set.hsv, encoding: profile.hueSatMap.encoding }
    : null
  const lt = profile.lookTable
    ? { dims: profile.lookTable.dims, data: profile.lookTable.data, encoding: profile.lookTable.encoding }
    : null

  return {
    camToRec709: f32(camToRec709),
    camToProPhoto: f32(camToProPhoto),
    prophotoToRec709: f32(PROPHOTO_TO_REC709),
    hsv: bakeHsv([hsm, lt]),
    toneLut: profile.toneCurve ? bakeToneLut(profile.toneCurve, toneSize) : null,
    baselineExposureOffset: profile.baselineExposureOffset ?? 0,
    // diagnostics: found white, its CCT, and calibration-set-1 weight
    white: { xy: white, ...xyToTemperature(white), weight: set.w },
  }
}

export const neutralFromCamMul = (camMul) => camMul.map((m) => 1 / m)
