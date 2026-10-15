// Unit tests for src/io/xmp.js — Lightroom/Camera Raw XMP → albedo modules.
// Run: npm run test:unit (node --test, no deps). Fixtures are hand-written
// (test/unit/fixtures/xmp/), not Adobe files.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseXmp, xmpSummary } from '../../src/io/xmp.js'
import { MODULE_DEFAULTS } from '../../src/engine/editdoc.js'

const fx = (name) => readFileSync(fileURLToPath(new URL(`./fixtures/xmp/${name}`, import.meta.url)), 'utf8')

// every emitted module must be a complete, self-standing module object
const assertValidModules = (modules) => {
  for (const [k, v] of Object.entries(modules)) {
    assert.ok(MODULE_DEFAULTS[k], `unknown module ${k}`)
    assert.deepEqual(Object.keys(v).sort(), Object.keys(MODULE_DEFAULTS[k]).sort(), `module ${k} keys`)
  }
}

// minimal sidecar wrapper for inline cases
const wrap = (attrs, body = '') => `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:tiff="http://ns.adobe.com/tiff/1.0/" ${attrs}>${body}</rdf:Description>
</rdf:RDF></x:xmpmeta>`

test('raw sidecar: Kelvin WB, crop+angle under orientation 6, curve, HSL, unmapped locals', () => {
  const r = parseXmp(fx('raw-sidecar.xmp'))
  assert.equal(r.isPreset, false)
  assert.equal(r.name, null)
  assert.deepEqual(r.warnings, [])
  assertValidModules(r.modules)
  assert.deepEqual(Object.keys(r.modules).sort(),
    ['colormix', 'curve', 'exposure', 'geometry', 'localcontrast', 'tone', 'vibsat', 'wb'])
  assert.deepEqual(r.modules.exposure, { ev: 0.35, black: 0 })
  assert.deepEqual(r.modules.tone, { contrast: 12, highlights: -45, shadows: 30, whites: 8, blacks: -15 })
  // 6500 K / +10 vs the 5500 K / +10 reference: warmer, tint untouched
  assert.deepEqual(r.modules.wb, { temp: 58, tint: 0 })
  assert.deepEqual(r.modules.vibsat, { vibrance: 18, saturation: -5 })
  assert.deepEqual(r.modules.localcontrast, { clarity: 15, texture: 10, dehaze: 5 })
  assert.deepEqual(r.modules.curve.points, [[0, 0], [0.251, 0.2039], [0.7529, 0.8039], [1, 1]])
  assert.deepEqual(r.modules.colormix.orange, { h: 5, s: -12, l: 10 })
  assert.deepEqual(r.modules.colormix.yellow, { h: -10, s: 0, l: 0 })
  assert.deepEqual(r.modules.colormix.green, { h: 0, s: -30, l: 0 })
  assert.deepEqual(r.modules.colormix.blue, { h: -8, s: 20, l: -25 })
  assert.deepEqual(r.modules.colormix.red, { h: 0, s: 0, l: 0 })
  // stored rect L.1 T.05 R.9 B.8 rotated by orientation 6 (90° CW); LR +2.5° (CW) → albedo −2.5 (CCW+)
  assert.deepEqual(r.modules.geometry, { crop: { x: 0.2, y: 0.1, w: 0.75, h: 0.8 }, angle: -2.5, flipH: 0, persp: { v: 0, h: 0 } })
  // GrayMixer present but ConvertToGrayscale=False → no bw; detail at LR defaults → absent;
  // the Look's nested Exposure2012/ToneCurve must not leak into the top level
  assert.equal(r.modules.bw, undefined)
  assert.equal(r.modules.detail, undefined)
  assert.deepEqual(r.unmapped, ['Calibration', 'Masks', 'Spot removal'])
  assert.equal(xmpSummary(r.unmapped), 'Not imported: Calibration, Masks, Spot removal')
})

test('JPEG sidecar: incremental WB 1:1, signed values, non-raw detail baseline', () => {
  const r = parseXmp(fx('jpeg-sidecar.xmp'))
  assertValidModules(r.modules)
  assert.deepEqual(r.modules, {
    exposure: { ev: -0.65, black: 0 },
    tone: { contrast: 0, highlights: -20, shadows: 0, whites: 0, blacks: 0 },
    wb: { temp: 12, tint: -8 },
    vibsat: { vibrance: 20, saturation: 0 },
    localcontrast: { clarity: 0, texture: 6, dehaze: -10 },
  })
  assert.deepEqual(r.unmapped, [])
  assert.deepEqual(r.warnings, [])
  assert.equal(xmpSummary(r.unmapped), '')
})

test('JPEG sidecar with LR default sharpening still imports detail (albedo disables it on bitmaps)', () => {
  const r = parseXmp(wrap('crs:IncrementalTemperature="0" crs:Sharpness="40" crs:ColorNoiseReduction="25" crs:RawFileName="x.jpg"'))
  assert.deepEqual(r.modules.detail, { sharpenAmount: 40, sharpenRadius: 1, sharpenMasking: 0, lumaNR: 0, chromaNR: 25, aiDenoise: 0 })
  assert.equal(r.modules.wb, undefined)
})

test('preset: rdf:Alt name with entity, grayscale mixer, grain, neutral groups reset', () => {
  const r = parseXmp(fx('preset-bw.xmp'))
  assert.equal(r.isPreset, true)
  assert.equal(r.name, 'Silver & Grain 02')
  assertValidModules(r.modules)
  assert.deepEqual(r.modules, {
    // explicitly neutral in the preset → included at defaults (applying resets)
    exposure: { ev: 0, black: 0 },
    wb: { temp: 0, tint: 0 },
    tone: { contrast: 20, highlights: 0, shadows: 0, whites: 0, blacks: 0 },
    bw: { on: 1, mix: { red: 10, orange: 25, yellow: 5, green: -20, aqua: -10, blue: -35, purple: 0, magenta: 5 } },
    grain: { amount: 30, size: 40, roughness: 60 },
  })
  assert.deepEqual(r.unmapped, ['Profile/Look']) // Adobe Monochrome look
  assert.deepEqual(r.warnings, [])
})

test('color grade + split toning + vignette', () => {
  const r = parseXmp(fx('colorgrade.xmp'))
  assertValidModules(r.modules)
  // As Shot → wb unset even though Temperature/Tint are present
  assert.deepEqual(Object.keys(r.modules).sort(), ['grading', 'vignette'])
  // LR HSL hues → OKLab hue: 220 → 263, 30 → 53, 45 → 84; balance negated
  assert.deepEqual(r.modules.grading, {
    shadows: { h: 263, s: 25 }, midtones: { h: 53, s: 10 }, highlights: { h: 84, s: 30 },
    blending: 60, balance: -20,
  })
  assert.deepEqual(r.modules.vignette, { amount: -25, midpoint: 40, roundness: 0, feather: 70 })
  assert.deepEqual(r.unmapped, ['Color grade luminance'])
  assert.deepEqual(r.warnings, ['vignette roundness -20 clamped to 0'])
})

test('ColorGrade* shadow keys win over SplitToning*; primary hues land on OKLab primaries', () => {
  const r = parseXmp(wrap('crs:SplitToningShadowHue="0" crs:SplitToningShadowSaturation="5" crs:ColorGradeShadowHue="120" crs:ColorGradeShadowSat="40" crs:SplitToningHighlightHue="240" crs:SplitToningHighlightSaturation="10" crs:ColorGradeGlobalSat="15"'))
  assert.deepEqual(r.modules.grading.shadows, { h: 142, s: 40 })
  assert.deepEqual(r.modules.grading.highlights, { h: 264, s: 10 })
  assert.deepEqual(r.unmapped, ['Color grade global'])
})

test('single quotes, entities, CDATA, DOCTYPE, odd prefix, element-form curves', () => {
  const r = parseXmp(fx('quirky.xmp'))
  assertValidModules(r.modules)
  assert.deepEqual(r.modules.exposure, { ev: 1.25, black: 0 })
  // unsuffixed Shadows with ProcessVersion 11 is read as the 2012 slider
  assert.deepEqual(r.modules.tone, { contrast: 0, highlights: -60, shadows: 40, whites: 0, blacks: 0 })
  assert.deepEqual(r.modules.curve.points, [[0, 0.0784], [0.502, 0.549], [1, 0.9412]])
  assert.deepEqual(r.modules.geometry, { crop: { x: 0, y: 0, w: 1, h: 1 }, angle: 0, flipH: 0, persp: { v: -18, h: 6 } })
  assert.deepEqual(r.modules.detail, { sharpenAmount: 70, sharpenRadius: 1.4, sharpenMasking: 35, lumaNR: 20, chromaNR: 25, aiDenoise: 0 })
  // LR +12 corrects barrel → albedo −12; defringe 5·max(4, 2)
  assert.deepEqual(r.modules.lens, { distortion: -12, caRed: 0, caBlue: 0, defringe: 20, profile: 1, profDistortion: 100, profVignette: 100 })
  assert.deepEqual(r.unmapped, ['RGB channel curves', 'Transform rotate/scale/offset', 'Sharpen detail', 'Profile/Look'])
})

test('neutral sidecar: no modules, nothing unmapped, no warnings', () => {
  const r = parseXmp(fx('neutral.xmp'))
  assert.deepEqual(r, { name: null, modules: {}, unmapped: [], isPreset: false, warnings: [] })
})

test('Kelvin mapping is monotonic and clamps with a warning', () => {
  const temps = [3000, 4500, 5000, 5500, 6000, 7000, 9000].map((k) =>
    parseXmp(wrap(`crs:WhiteBalance="Custom" crs:Temperature="${k}" crs:Tint="+10"`)).modules.wb?.temp ?? 0)
  for (let i = 1; i < temps.length; i++) assert.ok(temps[i] >= temps[i - 1], `monotonic ${temps}`)
  assert.equal(temps[3], 0)
  assert.equal(temps[0], -100)
  assert.equal(temps[6], 100)
  const hot = parseXmp(wrap('crs:WhiteBalance="Custom" crs:Temperature="9000" crs:Tint="+10"'))
  assert.match(hot.warnings[0], /saturates/)
  // + tint is magenta in both; tint maps independently of temperature
  const mag = parseXmp(wrap('crs:WhiteBalance="Custom" crs:Temperature="5500" crs:Tint="+30"')).modules.wb
  assert.deepEqual(mag, { temp: 0, tint: 45 })
  // named preset without explicit Kelvin uses LR's preset values
  assert.deepEqual(parseXmp(wrap('crs:WhiteBalance="Cloudy"')).modules.wb, { temp: 58, tint: 0 }) // = 6500 K / +10
  assert.deepEqual(parseXmp(wrap('crs:WhiteBalance="Auto" crs:Temperature="5600"')).unmapped, ['Auto white balance'])
})

test('crop: mirrored orientation flips angle; HasCrop False ignores rect; angle clamps', () => {
  const m = parseXmp(wrap('tiff:Orientation="2" crs:HasCrop="True" crs:CropLeft="0.1" crs:CropTop="0.2" crs:CropRight="0.5" crs:CropBottom="0.9" crs:CropAngle="-3"'))
  assert.deepEqual(m.modules.geometry.crop, { x: 0.5, y: 0.2, w: 0.4, h: 0.7 })
  assert.equal(m.modules.geometry.angle, -3)
  const off = parseXmp(wrap('crs:HasCrop="False" crs:CropLeft="0.1" crs:CropRight="0.5" crs:CropAngle="4"'))
  assert.equal(off.modules.geometry, undefined)
  const big = parseXmp(wrap('crs:HasCrop="True" crs:CropAngle="50"'))
  assert.equal(big.modules.geometry.angle, -45)
  assert.match(big.warnings[0], /clamped/)
})

test('preset with HasCrop False resets geometry; legacy PV2010 tone is reported', () => {
  const p = parseXmp(wrap('crs:PresetType="Normal" crs:HasCrop="False"'))
  assert.equal(p.isPreset, true)
  assert.equal(p.name, null)
  assert.deepEqual(p.modules, { geometry: MODULE_DEFAULTS.geometry })
  const legacy = parseXmp(wrap('crs:ProcessVersion="6.7" crs:Exposure="+0.5" crs:Contrast="+50" crs:Shadows="5" crs:Brightness="+50" crs:FillLight="10" crs:Clarity="20"'))
  assert.deepEqual(legacy.modules.exposure, { ev: 0.5, black: 0 })
  assert.deepEqual(legacy.modules.localcontrast, { clarity: 20, texture: 0, dehaze: 0 })
  assert.equal(legacy.modules.tone, undefined)
  assert.deepEqual(legacy.unmapped, ['Legacy (PV2010) tone'])
})

test('unmapped de-duplication and parametric curve, empty / junk input', () => {
  const r = parseXmp(wrap('crs:ParametricShadows="-10" crs:ParametricLights="+5" crs:RedHue="3" crs:BlueSaturation="-4" crs:LensProfileEnable="1" crs:VignetteAmount="-20" crs:AutoLateralCA="1" crs:PerspectiveUpright="2"'))
  assert.deepEqual(r.unmapped, ['Parametric curve', 'Upright', 'Chromatic aberration', 'Lens vignetting', 'Calibration'])
  assert.deepEqual(r.modules, {})
  for (const junk of ['', '   ', 'not xml at all', '<a><b>unclosed']) {
    const j = parseXmp(junk)
    assert.deepEqual(j.modules, {})
    assert.deepEqual(j.unmapped, [])
    assert.equal(j.warnings.length, 1)
  }
  assert.equal(xmpSummary([]), '')
  assert.equal(xmpSummary(['Grain']), 'Not imported: Grain')
})
