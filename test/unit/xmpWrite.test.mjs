// Unit tests for src/io/xmpWrite.js — albedo edit doc → Lightroom XMP, checked
// by reading it back with parseXmp (the writer is its exact inverse on every
// mapped field) and by the lossless albedo: payload.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseXmp, kelvinToWb, lrHueToOklab } from '../../src/io/xmp.js'
import { writeXmp, writePresetXmp, readAlbedoXmp, wbToKelvin, oklabHueToLr } from '../../src/io/xmpWrite.js'
import { MODULE_DEFAULTS, BAND_NAMES, newEditDoc } from '../../src/engine/editdoc.js'

const D = MODULE_DEFAULTS
const full = (m, v) => ({ ...structuredClone(D[m]), ...v })

// What parseXmp can see of a module set: every mapped field, with the
// parser's effect gates (vignette/grain/grading/bw only exist when switched
// on, so their satellite sliders only count then).
function lrView(modules) {
  const g = (m) => full(m, modules[m])
  const grading = g('grading')
  const gradOn = grading.shadows.s > 0 || grading.midtones.s > 0 || grading.highlights.s > 0
  const vig = g('vignette')
  const grain = g('grain')
  const bw = g('bw')
  const geo = g('geometry')
  return {
    exposure: { ev: g('exposure').ev },
    tone: g('tone'),
    wb: g('wb'),
    vibsat: g('vibsat'),
    localcontrast: g('localcontrast'),
    curve: g('curve'),
    colormix: g('colormix'),
    bw: bw.on ? bw : D.bw,
    grading: gradOn ? grading : D.grading,
    vignette: vig.amount !== 0 ? vig : D.vignette,
    grain: grain.amount > 0 ? grain : D.grain,
    geometry: { crop: geo.crop, angle: geo.angle, persp: geo.persp },
    detail: g('detail'),
    lens: { distortion: g('lens').distortion, defringe: g('lens').defringe },
  }
}

// per-path tolerance: WB tint is stored by LR as an integer (~2.4 albedo
// units per step), hues go through integer HSL degrees, curves through
// integer 0..255, defringe through LR's 0..20 scale
function tolFor(path) {
  if (path === 'wb.tint') return 1.5
  if (path === 'wb.temp') return 0.5
  if (/^grading\.\w+\.h$/.test(path)) return 1
  if (path.startsWith('curve.')) return 0.5 / 255 + 1e-4
  if (path === 'lens.defringe') return 2.5
  if (path.startsWith('geometry.crop')) return 1e-6
  return 1e-9
}

function assertClose(actual, expected, path = '') {
  if (typeof expected === 'number') {
    let d = Math.abs(actual - expected)
    if (/^grading\.\w+\.h$/.test(path)) d = Math.min(d, 360 - d)
    assert.ok(d <= tolFor(path), `${path}: got ${actual}, want ${expected}`)
    return
  }
  if (Array.isArray(expected)) {
    assert.equal(actual.length, expected.length, `${path} length`)
    expected.forEach((e, i) => assertClose(actual[i], e, `${path}.${i}`))
    return
  }
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${path} keys`)
  for (const k of Object.keys(expected)) assertClose(actual[k], expected[k], path ? `${path}.${k}` : k)
}

const roundTrip = (doc, meta) => {
  const xmp = writeXmp(doc, meta)
  const r = parseXmp(xmp)
  // the parser flags a WB at albedo's ±100 edge as saturating; nothing else
  const edge = [doc.modules.wb?.temp, doc.modules.wb?.tint].some((v) => Math.abs(v) === 100)
  assert.deepEqual(r.warnings.filter((w) => !(edge && /saturates/.test(w))), [], 'no parser warnings')
  assert.deepEqual(r.unmapped, [], 'writer emits nothing the parser reports as unmapped')
  assertClose(lrView(r.modules), lrView(doc.modules))
  assert.deepEqual(readAlbedoXmp(xmp), { doc }, 'albedo payload is exact')
  return { xmp, r }
}

const mix = (f) => Object.fromEntries(BAND_NAMES.map((b, i) => [b, f(b, i)]))

const DOCS = {
  rich: {
    ...newEditDoc('ph_0123456789abcdef'),
    modules: {
      wb: { temp: 37, tint: -12 },
      exposure: { ev: 0.45, black: 0.02 },
      tone: { contrast: 22, highlights: -35, shadows: 30, whites: 12, blacks: -14 },
      curve: { points: [[0, 0.05], [0.25, 0.2], [0.5, 0.52], [0.75, 0.8], [1, 0.97]] },
      colormix: mix((b, i) => ({ h: i * 7 - 20, s: (i % 3) * 15 - 15, l: 40 - i * 9 })),
      vibsat: { vibrance: 18, saturation: -6 },
      localcontrast: { clarity: 15, texture: -10, dehaze: 7 },
      vignette: { amount: -25, midpoint: 40, roundness: 30, feather: 70 },
      grading: { shadows: { h: 250, s: 25 }, midtones: { h: 60, s: 8 }, highlights: { h: 85, s: 30 }, blending: 62, balance: -20 },
      grain: { amount: 22, size: 35, roughness: 60 },
      geometry: { crop: { x: 0.1, y: 0.05, w: 0.8, h: 0.75 }, angle: 2.5, flipH: 1, persp: { v: -18, h: 6 } },
      detail: { sharpenAmount: 70, sharpenRadius: 1.4, sharpenMasking: 35, lumaNR: 20, chromaNR: 30 },
      lens: { distortion: -12, caRed: 10, caBlue: -5, defringe: 40 },
      recon: { on: 0 },
    },
    masks: [{ id: 'm_1', name: 'Sky', kind: 'linear', enabled: true, invert: false, geom: { x0: 0.5, y0: 0, x1: 0.5, y1: 0.4 }, adjust: { ev: -0.5, temp: 0, contrast: 0, highlights: 0, shadows: 0, saturation: 0, clarity: 0 } }],
    snapshots: [{ name: 'Before "grading" & <stuff>', at: 1760000000000, modules: {}, masks: [] }],
  },
  bw: {
    ...newEditDoc('ph_bw'),
    modules: {
      bw: { on: 1, mix: mix((b, i) => (i - 4) * 11) },
      grading: { shadows: { h: 0, s: 0 }, midtones: { h: 0, s: 0 }, highlights: { h: 70, s: 12 }, blending: 50, balance: 30 },
      tone: { contrast: 40, highlights: 0, shadows: 0, whites: 0, blacks: -30 },
      wb: { temp: -100, tint: 100 },
    },
    masks: [],
  },
  empty: newEditDoc('ph_empty'),
  healOnly: {
    ...newEditDoc('ph_heal'),
    modules: { heal: { spots: [{ id: 'h_1', mode: 'heal', dx: 0.3, dy: 0.4, sx: 0.35, sy: 0.4, r: 0.01, feather: 0.5 }] } },
    masks: [],
  },
}

test('sidecar round-trips every mapped field (raw, orientation 1)', () => {
  for (const [name, doc] of Object.entries(DOCS)) {
    const { r } = roundTrip(doc, { filename: `${name}.CR3` })
    assert.equal(r.isPreset, false)
  }
})

test('crop and angle survive every tiff:Orientation', () => {
  for (let o = 1; o <= 8; o++) {
    const { xmp } = roundTrip(DOCS.rich, { filename: 'IMG_1.NEF', orientation: o })
    assert.match(xmp, new RegExp(`tiff:Orientation="${o}"`))
  }
})

test('non-raw sidecar uses incremental WB and an explicit "detail off" baseline', () => {
  const jpg = { ...newEditDoc('ph_j'), modules: { wb: { temp: 12, tint: -8 }, exposure: { ev: -0.65, black: 0 } }, masks: [] }
  const { xmp, r } = roundTrip(jpg, { filename: 'a.jpg' })
  assert.match(xmp, /crs:IncrementalTemperature="\+12"/)
  assert.doesNotMatch(xmp, /crs:Temperature=/)
  assert.deepEqual(r.modules.wb, { temp: 12, tint: -8 })
  assert.equal(r.modules.detail, undefined)
  // As Shot on a bitmap still marks it non-raw; detail present at LR's
  // defaults is real sharpening on a JPEG and must come back
  const sharp = { ...jpg, modules: { detail: { ...D.detail } } }
  const back = roundTrip(sharp, { filename: 'b.tif' }).r
  assert.deepEqual(back.modules.detail, D.detail)
  assert.equal(back.modules.wb, undefined)
})

test('raw WB is written as Kelvin and inverts kelvinToWb', () => {
  for (const temp of [-100, -60, -7, 0, 1, 33, 99, 100]) {
    for (const tint of [-100, -41, 0, 5, 77, 100]) {
      const { kelvin, tint: t } = wbToKelvin({ temp, tint })
      assert.ok(Number.isInteger(kelvin) && Number.isInteger(t))
      const back = kelvinToWb(kelvin, t)
      assert.ok(Math.abs(back.temp - temp) <= 0.5, `temp ${temp} → ${kelvin}K → ${back.temp}`)
      assert.ok(Math.abs(back.tint - tint) <= 1.5, `tint ${tint} → ${t} → ${back.tint}`)
    }
  }
  assert.deepEqual(wbToKelvin({ temp: 0, tint: 0 }), { kelvin: 5500, tint: 10 })
})

test('OKLab hue → LR hue lands within a degree everywhere on the circle', () => {
  for (let h = 0; h < 360; h++) {
    const back = lrHueToOklab(oklabHueToLr(h))
    const d = Math.abs(back - h)
    assert.ok(Math.min(d, 360 - d) <= 1, `${h} → ${oklabHueToLr(h)} → ${back}`)
  }
})

test('photo metadata: rating, reject, label, title, caption, keywords, escaping', () => {
  const xmp = writeXmp(DOCS.empty, {
    filename: 'IMG_9.ARW', rating: 4, label: 'green',
    title: 'Dusk & "rain" <over> the hills', caption: 'line 1\nline 2 — ünïcødé',
    keywords: ['sea', 'R&D', 'zürich'],
  })
  assert.match(xmp, /xmp:Rating="4"/)
  assert.match(xmp, /xmp:Label="Green"/)
  assert.match(xmp, /<dc:title>\s*<rdf:Alt>\s*<rdf:li xml:lang="x-default">Dusk &amp; "rain" &lt;over&gt; the hills<\/rdf:li>/)
  assert.match(xmp, /<dc:description>[\s\S]*line 1\nline 2 — ünïcødé/)
  assert.match(xmp, /<dc:subject>\s*<rdf:Bag>\s*<rdf:li>sea<\/rdf:li>\s*<rdf:li>R&amp;D<\/rdf:li>/)
  assert.match(xmp, /crs:ProcessVersion="15.4"/)
  assert.match(xmp, /crs:RawFileName="IMG_9.ARW"/)
  assert.match(writeXmp(DOCS.empty, { rating: 3, flag: -1 }), /xmp:Rating="-1"/)
  // no tiff:Orientation unless told: LR would take it as the photo's own
  assert.doesNotMatch(xmp, /tiff:Orientation/)
  assert.doesNotMatch(writeXmp(DOCS.empty, { albedo: false }), /albedo:/)
})

test('albedo payload survives awkward JSON (quotes, newlines, unicode, lone surrogates)', () => {
  const doc = { ...DOCS.rich, versionName: 'a "b"\n\t<c> &   \ud800 😀' }
  assert.deepEqual(readAlbedoXmp(writeXmp(doc)), { doc })
  assert.equal(readAlbedoXmp('<x:xmpmeta/>'), null)
})

test('preset: only the given modules, neutral ones reset, LR preset fields', () => {
  const modules = {
    tone: { contrast: 20, highlights: 0, shadows: 0, whites: 0, blacks: 0 },
    bw: { on: 1, mix: mix((b, i) => i * 5) },
    grain: { amount: 30, size: 40, roughness: 60 },
    exposure: { ...D.exposure },
    wb: { ...D.wb },
  }
  const xmp = writePresetXmp('Silver & Grain', 'Mono', modules, { uuid: '0123456789ABCDEF0123456789ABCDEF' })
  const r = parseXmp(xmp)
  assert.equal(r.isPreset, true)
  assert.equal(r.name, 'Silver & Grain')
  assert.deepEqual(r.warnings, [])
  assert.deepEqual(r.modules, modules)
  assert.deepEqual(readAlbedoXmp(xmp), { modules })
  assert.match(xmp, /crs:PresetType="Normal"/)
  assert.match(xmp, /crs:UUID="0123456789ABCDEF0123456789ABCDEF"/)
  assert.match(xmp, /crs:SupportsAmount2="True"/)
  assert.match(xmp, /<crs:Group>\s*<rdf:Alt>\s*<rdf:li xml:lang="x-default">Mono</)
  assert.doesNotMatch(xmp, /crs:Vibrance|crs:HasCrop|ToneCurvePV2012/)
  assert.match(writePresetXmp('x', '', {}), /crs:UUID="[0-9A-F]{32}"/)
})

test('preset of every module round-trips through parseXmp', () => {
  const { heal, recon, ...mods } = DOCS.rich.modules
  const r = parseXmp(writePresetXmp('All', 'g', mods))
  assert.deepEqual(Object.keys(r.modules).sort(), Object.keys(mods).sort())
  assertClose(lrView(r.modules), lrView(mods))
})
