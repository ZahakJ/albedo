// Unit tests for src/io/dcp.js + src/engine/dcpColor.js. Synthetic DCPs are
// written by a tiny TIFF writer below; real RawTherapee DCPs are used when
// present in ALBEDO_DCP_DIR (default .cache/dcp, never committed), skipped otherwise.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { parseDcp, DCP_TAGS as T } from '../../src/io/dcp.js'
import {
  buildDcpTransform, bradford, mul3, mulV, inv3, xyToTemperature, temperatureToXy,
  neutralToXy, interpolationWeight, illuminantTemperature, xyToXYZ, D50_XY, D65_XY,
  REC709_TO_XYZ_D65, XYZ_D65_TO_REC709, PROPHOTO_TO_XYZ_D50, PROPHOTO_TO_REC709,
  splineSolver, bakeToneLut, lookupHsv, applyHsvLut, rgbToHsv, hsvToRgb,
} from '../../src/engine/dcpColor.js'

// ---- tiny TIFF writer -------------------------------------------------------
// entries: [tag, type, values|string]; type 2 ASCII, 3 SHORT, 4 LONG,
// 10 SRATIONAL (floats, written over 1e6), 11 FLOAT
const SIZE = { 2: 1, 3: 2, 4: 4, 10: 8, 11: 4 }
function writeTiff(entries, { le = true, dcp = true } = {}) {
  entries = entries.slice().sort((a, b) => a[0] - b[0])
  const enc = entries.map(([tag, type, v]) => {
    const vals = type === 2 ? [...new TextEncoder().encode(v), 0] : v
    return { tag, type, vals, size: SIZE[type] * vals.length }
  })
  const ifdSize = 2 + enc.length * 12 + 4
  let dataOff = 8 + ifdSize
  const total = dataOff + enc.reduce((a, e) => a + (e.size > 4 ? e.size + (e.size & 1) : 0), 0)
  const buf = new ArrayBuffer(total), dv = new DataView(buf), u8 = new Uint8Array(buf)
  u8[0] = u8[1] = le ? 0x49 : 0x4d
  dv.setUint16(2, dcp ? 0x4352 : 42, le)
  dv.setUint32(4, 8, le)
  dv.setUint16(8, enc.length, le)
  enc.forEach((e, i) => {
    const p = 10 + i * 12
    dv.setUint16(p, e.tag, le); dv.setUint16(p + 2, e.type, le); dv.setUint32(p + 4, e.vals.length, le)
    let at = p + 8
    if (e.size > 4) { dv.setUint32(p + 8, dataOff, le); at = dataOff; dataOff += e.size + (e.size & 1) }
    e.vals.forEach((x, k) => {
      const q = at + k * SIZE[e.type]
      if (e.type === 2) dv.setUint8(q, x)
      else if (e.type === 3) dv.setUint16(q, x, le)
      else if (e.type === 4) dv.setUint32(q, x, le)
      else if (e.type === 11) dv.setFloat32(q, x, le)
      else { dv.setInt32(q, Math.round(x * 1e6), le); dv.setInt32(q + 4, 1e6, le) }
    })
  })
  return new Uint8Array(buf)
}

const near = (a, b, eps, msg) => {
  a = Array.from(a); b = Array.from(b)
  assert.equal(a.length, b.length, msg)
  a.forEach((x, i) => assert.ok(Math.abs(x - b[i]) <= eps, `${msg}: [${i}] ${x} vs ${b[i]}`))
}
const I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1]

// camera that *is* linear Rec.709: XYZ→camera for D65 light is XYZ→Rec.709
const CM_SRGB = XYZ_D65_TO_REC709
const FM_SRGB = mul3(bradford(D65_XY, D50_XY), REC709_TO_XYZ_D65)

// ---- parser ------------------------------------------------------------------

test('parse: synthetic IIRC DCP round-trips every field', () => {
  const hsd = [4, 3, 1], hsn = 4 * 3 * 1 * 3
  const hs1 = Array.from({ length: hsn }, (_, i) => i * 0.5)
  const hs2 = Array.from({ length: hsn }, (_, i) => -i)
  const ltd = [2, 2, 2], lt = Array.from({ length: 24 }, (_, i) => i / 10)
  const bytes = writeTiff([
    [T.UniqueCameraModel, 2, 'Test Cam'],
    [T.ProfileName, 2, 'Test Profile'],
    [T.ProfileCopyright, 2, 'CC0'],
    [T.CalibrationIlluminant1, 3, [17]],
    [T.CalibrationIlluminant2, 3, [21]],
    [T.ColorMatrix1, 10, [1, 0.1, -0.2, 0.3, 0.9, 0, -0.1, 0.2, 1.1]],
    [T.ColorMatrix2, 10, CM_SRGB],
    [T.ForwardMatrix1, 10, FM_SRGB],
    [T.ForwardMatrix2, 10, FM_SRGB],
    [T.ProfileHueSatMapDims, 4, hsd],
    [T.ProfileHueSatMapData1, 11, hs1],
    [T.ProfileHueSatMapData2, 11, hs2],
    [T.ProfileHueSatMapEncoding, 4, [0]],
    [T.ProfileLookTableDims, 4, ltd],
    [T.ProfileLookTableData, 11, lt],
    [T.ProfileLookTableEncoding, 4, [1]],
    [T.ProfileToneCurve, 11, [0, 0, 0.5, 0.6, 1, 1]],
    [T.BaselineExposureOffset, 10, [-0.25]],
    [T.DefaultBlackRender, 4, [1]],
    [T.ProfileEmbedPolicy, 4, [3]],
  ])
  const p = parseDcp(bytes)
  assert.equal(p.name, 'Test Profile')
  assert.equal(p.uniqueCameraModel, 'Test Cam')
  assert.equal(p.copyright, 'CC0')
  assert.deepEqual(p.illuminants, [17, 21])
  near(p.colorMatrix1, [1, 0.1, -0.2, 0.3, 0.9, 0, -0.1, 0.2, 1.1], 1e-6, 'cm1')
  near(p.colorMatrix2, CM_SRGB, 1e-6, 'cm2')
  near(p.forwardMatrix1, FM_SRGB, 1e-6, 'fm1')
  assert.deepEqual(p.hueSatMap.dims, hsd)
  near(p.hueSatMap.data1, hs1, 1e-6, 'hs1')
  near(p.hueSatMap.data2, hs2, 1e-6, 'hs2')
  assert.equal(p.hueSatMap.encoding, 0)
  assert.deepEqual(p.lookTable.dims, ltd)
  near(p.lookTable.data, lt, 1e-6, 'lt')
  assert.equal(p.lookTable.encoding, 1)
  assert.deepEqual(p.toneCurve.map((q) => q.map((x) => +x.toFixed(6))), [[0, 0], [0.5, 0.6], [1, 1]])
  assert.equal(p.baselineExposureOffset, -0.25)
  assert.equal(p.defaultBlackRender, 1)
  assert.equal(p.embedPolicy, 3)
})

test('parse: big-endian standard TIFF (DNG IFD0) and rejects junk', () => {
  const p = parseDcp(writeTiff([
    [T.ColorMatrix1, 10, CM_SRGB], [T.CalibrationIlluminant1, 3, [21]],
  ], { le: false, dcp: false }).buffer)
  near(p.colorMatrix1, CM_SRGB, 1e-6, 'cm1 BE')
  assert.equal(p.colorMatrix2, null)
  assert.equal(p.hueSatMap, null)
  assert.equal(p.toneCurve, null)
  assert.throws(() => parseDcp(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])))
})

// ---- colour maths ----------------------------------------------------------------

test('bradford matches published D50↔D65 matrices (Lindbloom)', () => {
  const D50 = [0.96422, 1, 0.82521], D65 = [0.95047, 1, 1.08883]
  near(bradford(D50, D65), [
    0.9555766, -0.0230393, 0.0631636,
    -0.0282895, 1.0099416, 0.0210077,
    0.0122982, -0.0204830, 1.3299098,
  ], 2e-6, 'D50→D65')
  near(bradford(D65, D50), [
    1.0478112, 0.0228866, -0.0501270,
    0.0295424, 0.9904844, -0.0170491,
    -0.0092345, 0.0150436, 0.7521316,
  ], 2e-6, 'D65→D50')
  near(mulV(bradford(D50_XY, D65_XY), xyToXYZ(D50_XY)), xyToXYZ(D65_XY), 1e-9, 'white maps')
})

test('working-space matrices agree with the standard ones', () => {
  near(REC709_TO_XYZ_D65, [0.4124, 0.3576, 0.1805, 0.2126, 0.7152, 0.0722, 0.0193, 0.1192, 0.9505], 2e-4, 'sRGB')
  // SDK's dng_space_ProPhoto matrix (4-decimal, white Z rounded to 0.8249)
  near(PROPHOTO_TO_XYZ_D50, [0.7977, 0.1352, 0.0313, 0.2880, 0.7119, 0.0001, 0, 0, 0.8249], 3e-4, 'ProPhoto')
  near(mulV(PROPHOTO_TO_REC709, [1, 1, 1]), [1, 1, 1], 1e-9, 'ProPhoto white → Rec.709 white')
})

test('CCT: Robertson round trip and standard illuminants', () => {
  assert.ok(Math.abs(xyToTemperature(D65_XY).temperature - 6504) < 5)
  assert.ok(Math.abs(xyToTemperature([0.44757, 0.40745]).temperature - 2856) < 5)
  for (const K of [2500, 2850, 4000, 5000, 6500, 9000]) {
    for (const tint of [-20, 0, 15]) {
      const r = xyToTemperature(temperatureToXy(K, tint))
      assert.ok(Math.abs(r.temperature - K) / K < 1e-3, `T ${K}`)
      assert.ok(Math.abs(r.tint - tint) < 0.05, `tint ${tint}`)
    }
  }
  assert.equal(illuminantTemperature(17), 2850)
  assert.equal(illuminantTemperature(21), 6500)
  assert.equal(illuminantTemperature(23), 5000)
})

test('CCT interpolation: weight is linear in 1/T, clamped', () => {
  assert.equal(interpolationWeight(2000, 2850, 6500), 1)
  assert.equal(interpolationWeight(8000, 2850, 6500), 0)
  const w = interpolationWeight(4000, 2850, 6500)
  near([w], [(1 / 4000 - 1 / 6500) / (1 / 2850 - 1 / 6500)], 1e-12, 'w')

  // self-consistent camera: neutral generated from the interpolated matrix at
  // a known white must be inverted back to that white and weight
  // plausible second calibration: same camera, mildly different response
  // (wild matrices can have several fixed points; real ones don't)
  const cmA = mul3([1.08, 0.03, -0.02, -0.02, 1, 0.02, 0.01, -0.04, 0.9], CM_SRGB)
  const prof = { channels: 3, illuminants: [21, 17], colorMatrix1: CM_SRGB, colorMatrix2: cmA }
  for (const K of [3000, 4000, 5200, 6000]) {
    const xy = temperatureToXy(K, 0)
    const g = interpolationWeight(K, 2850, 6500) // weight of the A (lower-K) set
    const cm = cmA.map((a, i) => g * a + (1 - g) * CM_SRGB[i])
    const neutral = mulV(cm, xyToXYZ(xy))
    const found = neutralToXy(prof, neutral)
    near(found, xy, 1e-5, `xy @${K}`)
    const t = buildDcpTransform(prof, neutral)
    assert.ok(Math.abs(t.white.temperature - K) < 2, `T @${K}: ${t.white.temperature}`)
    near([t.white.weight], [g], 1e-4, `weight @${K}`)
    near(mulV(t.camToRec709, [1, 1, 1]), [1, 1, 1], 1e-5, `WB'd white → white @${K}`)
  }
})

test('sRGB-derived profile gives identity (ColorMatrix and ForwardMatrix paths)', () => {
  const cmOnly = { channels: 3, illuminants: [21, 0], colorMatrix1: CM_SRGB }
  const t1 = buildDcpTransform(cmOnly, [1, 1, 1])
  near(t1.white.xy, D65_XY, 1e-6, 'white')
  near(t1.camToRec709, I3, 1e-5, 'CM path')
  const withFm = { ...cmOnly, illuminants: [17, 21], colorMatrix2: CM_SRGB, forwardMatrix1: FM_SRGB, forwardMatrix2: FM_SRGB }
  near(buildDcpTransform(withFm, [1, 1, 1]).camToRec709, I3, 1e-5, 'FM path')
  // FM path is WB-agnostic for an sRGB camera: whatever we balanced by is white
  near(buildDcpTransform(withFm, [0.5, 1, 0.7]).camToRec709, I3, 1e-4, 'FM path, warm neutral')
  // chain consistency
  const t = buildDcpTransform(withFm, [0.6, 1, 0.8])
  near(mul3(t.prophotoToRec709, t.camToProPhoto), t.camToRec709, 1e-6, 'ProPhoto chain')
})

test('CM path under tungsten: white balances to white, matches von Kries-Bradford', () => {
  const p = { channels: 3, illuminants: [21, 0], colorMatrix1: CM_SRGB }
  const xyA = temperatureToXy(2850)
  const neutral = mulV(CM_SRGB, xyToXYZ(xyA)) // camera sees tungsten white
  const t = buildDcpTransform(p, neutral)
  near(t.white.xy, xyA, 1e-6, 'found white')
  near(mulV(t.camToRec709, [1, 1, 1]), [1, 1, 1], 1e-6, 'neutral')
  // expected: Bradford white→D65 on the raw camera (= Rec.709) values
  const n = neutral.map((v) => v / neutral[1])
  const raw2out = mul3(XYZ_D65_TO_REC709, mul3(bradford(xyA, D65_XY), REC709_TO_XYZ_D65))
  const expect = mul3(raw2out, [n[0], 0, 0, 0, n[1], 0, 0, 0, n[2]])
  const y = mulV(REC709_TO_XYZ_D65, mulV(expect, [1, 1, 1]))[1]
  near(t.camToRec709, expect.map((v) => v / y), 1e-5, 'matrix')
})

// ---- tables -------------------------------------------------------------------------

test('tone curve spline: interpolates knots, linear for 2 points, monotone LUT', () => {
  const pts = [[0, 0], [0.25, 0.35], [0.5, 0.65], [1, 1]]
  const f = splineSolver(pts)
  for (const [x, y] of pts) near([f(x)], [y], 1e-12, `knot ${x}`)
  near([splineSolver([[0, 0], [1, 1]])(0.3)], [0.3], 1e-12, 'linear')
  const lut = bakeToneLut(pts, 256)
  assert.equal(lut.length, 256)
  near([lut[0], lut[255]], [0, 1], 1e-7, 'ends')
  for (let i = 1; i < 256; i++) assert.ok(lut[i] >= lut[i - 1])
})

test('HSV table lookup + bake: identity tables are no-ops, hue wraps, interpolation', () => {
  assert.deepEqual(rgbToHsv(1, 0, 0), [0, 1, 1])
  near(hsvToRgb(...rgbToHsv(0.2, 0.5, 0.3)), [0.2, 0.5, 0.3], 1e-12, 'hsv rt')
  const dims = [6, 2, 1]
  const data = new Float32Array(6 * 2 * 3)
  for (let h = 0; h < 6; h++) for (let s = 0; s < 2; s++) data.set([h * 10, 1, 1], (h * 2 + s) * 3)
  // h=5.5 sits between node 5 (50°) and node 0 (0°)
  near(lookupHsv(dims, data, 5.5, 0.5, 0), [25, 1, 1], 1e-6, 'wrap')
  near(lookupHsv(dims, data, 2.25, 1, 0), [22.5, 1, 1], 1e-6, 'lerp')

  const ident = new Float32Array(8 * 4 * 3 * 3)
  for (let i = 0; i < ident.length; i += 3) ident.set([0, 1, 1], i)
  const p = {
    channels: 3, illuminants: [21, 0], colorMatrix1: CM_SRGB,
    hueSatMap: { dims: [8, 4, 1], data1: ident.slice(0, 8 * 4 * 3), data2: null, encoding: 0 },
    lookTable: { dims: [8, 4, 3], data: ident, encoding: 1 },
  }
  const t = buildDcpTransform(p, [1, 1, 1])
  assert.deepEqual(t.hsv.dims, [8, 4, 3])
  assert.equal(t.hsv.encoding, 1)
  assert.equal(t.hsv.lut.length, 8 * 4 * 3 * 4)
  near(applyHsvLut(t.hsv, [0.3, 0.5, 0.1]), [0.3, 0.5, 0.1], 1e-5, 'identity bake')
  assert.equal(t.toneLut, null)
})

// ---- real profiles (optional) ---------------------------------------------------

const REAL = process.env.ALBEDO_DCP_DIR ?? new URL('../../.cache/dcp', import.meta.url).pathname
const real = (name) => `${REAL}/${name}`

test('real DCP: SONY ILCE-7M3 (dual illuminant, FM, HSM, LookTable, tone)', { skip: !existsSync(real('SONY ILCE-7M3.dcp')) }, () => {
  const p = parseDcp(readFileSync(real('SONY ILCE-7M3.dcp')))
  assert.equal(p.uniqueCameraModel, 'Sony ILCE-7M3')
  assert.deepEqual(p.illuminants, [17, 21])
  assert.deepEqual(p.hueSatMap.dims, [90, 30, 1])
  assert.deepEqual(p.lookTable.dims, [90, 30, 30])
  assert.equal(p.lookTable.encoding, 1)
  assert.equal(p.toneCurve.length, 8192)
  assert.ok(p.forwardMatrix1 && p.forwardMatrix2 && p.colorMatrix2)
  assert.ok(p.hueSatMap.data1 && p.hueSatMap.data2)
  assert.ok(p.lookTable)
  assert.ok(p.toneCurve.length > 100)
  // a daylight-ish neutral: invert ColorMatrix2 (D65) at D65 white
  const n = mulV(p.colorMatrix2, xyToXYZ(D65_XY))
  const t = buildDcpTransform(p, n)
  assert.ok(Math.abs(t.white.temperature - 6504) < 100, `T ${t.white.temperature}`)
  near(mulV(t.camToRec709, [1, 1, 1]), [1, 1, 1], 0.02, 'neutral → white')
  near(mulV(inv3(Array.from(t.prophotoToRec709)), [1, 1, 1]), [1, 1, 1], 1e-5, 'pp white')
  assert.ok(t.hsv.lut.every(Number.isFinite))
  assert.ok(t.toneLut.every((v, i, a) => i === 0 || v >= a[i - 1] - 1e-6))
})

test('real DCP: Canon EOS 5D Mark III (single illuminant D50, CM only, 3D HSM)', { skip: !existsSync(real('Canon EOS 5D Mark III.dcp')) }, () => {
  const p = parseDcp(readFileSync(real('Canon EOS 5D Mark III.dcp')))
  assert.equal(p.colorMatrix2, null)
  assert.equal(p.forwardMatrix1, null)
  assert.deepEqual(p.illuminants, [23, 0])
  assert.deepEqual(p.hueSatMap.dims, [6, 6, 3])
  const n = mulV(p.colorMatrix1, xyToXYZ(temperatureToXy(5000)))
  const t = buildDcpTransform(p, n)
  near(mulV(t.camToRec709, [1, 1, 1]), [1, 1, 1], 1e-6, 'neutral → white')
  assert.equal(t.toneLut, null)
  assert.deepEqual(t.hsv.dims, p.hueSatMap.dims)
})
