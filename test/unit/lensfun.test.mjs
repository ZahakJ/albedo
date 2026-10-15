// Unit tests for src/engine/lensfun.js and the XML side of
// scripts/build-lensfun.mjs. Run: npm run test:unit. The EXIF matching cases
// need the generated public/lensfun/ (npm run setup-lensfun) and skip without it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseXml, extractDb } from '../../scripts/build-lensfun.mjs'
import {
  splitWords, fuzzyScore, guessFromName, hermite, matchLens, correctionAt, shaderParams, distortRadius,
} from '../../src/engine/lensfun.js'

const near = (a, b, eps = 1e-9, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} ${a} ≉ ${b}`)

const XML = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE lensdatabase SYSTEM "lensfun-database.dtd">
<lensdatabase version="2">
  <!-- a comment with <tags> inside -->
  <mount><name>Sony E</name><compat>M42</compat></mount>
  <camera>
    <maker>Sony</maker><maker lang="en">Sony</maker>
    <model>ILCE-7M3</model><model lang="en">α7 III</model>
    <mount>Sony E</mount><cropfactor>1</cropfactor>
  </camera>
  <lens>
    <maker>Sony</maker>
    <model>FE 24-70mm f/2.8 GM &amp; co</model>
    <mount>Sony E</mount>
    <cropfactor>1</cropfactor>
    <calibration>
      <distortion model="ptlens" focal="24" a="0.01" b="-0.03" c="0.02"/>
      <distortion model="poly3" focal="35" k1="-0.01"/>
      <distortion model="ptlens" focal="70" a='0.005' b="-0.01" c="0.004"/>
      <tca model="poly3" focal="24" br="-0.0002" vr="1.0003" bb="0.0001" vb="0.9998"/>
      <vignetting model="pa" focal="24" aperture="2.8" distance="10" k1="-0.5" k2="0.1" k3="-0.05"/>
      <vignetting model="acm" focal="24" aperture="4" distance="10" k1="-0.4" k2="0" k3="0"/>
    </calibration>
  </lens>
  <lens><maker>Nobody</maker><model>No data 50mm f/2</model><mount>Sony E</mount></lens>
</lensdatabase>`

test('xml reader: prolog, comments, entities, quotes, self-closing', () => {
  const doc = parseXml(XML)
  const db = doc.children.find((c) => c.name === 'lensdatabase')
  assert.equal(db.attrs.version, '2')
  const lens = db.children.filter((c) => c.name === 'lens')[0]
  assert.equal(lens.children.find((c) => c.name === 'model').text, 'FE 24-70mm f/2.8 GM & co')
  const cal = lens.children.find((c) => c.name === 'calibration')
  assert.equal(cal.children.length, 6)
  assert.equal(cal.children[2].attrs.a, '0.005')
  // tolerant: unclosed and stray tags do not throw
  const t = parseXml('<a><b x="1>2">hi</c></b><d/>')
  assert.equal(t.children[0].children[0].attrs.x, '1>2')
  assert.equal(t.children[0].children[1].name, 'd')
})

test('extractDb: first model per kind wins, acm dropped, uncalibrated lenses skipped', () => {
  const db = extractDb(parseXml(XML))
  assert.deepEqual(db.mounts, { 'Sony E': ['M42'] })
  assert.equal(db.cameras.length, 1)
  assert.deepEqual(db.cameras[0].alt, ['α7 III'])
  assert.equal(db.lenses.length, 1)
  const { calib, entry } = db.lenses[0]
  assert.equal(calib.distortion.model, 'ptlens')
  assert.deepEqual(calib.distortion.points.map((p) => p[0]), [24, 70]) // poly3 @35 ignored, like lensfun
  assert.deepEqual(calib.tca.points[0], [24, 1.0003, 0.9998, 0, 0, -0.0002, 0.0001])
  assert.equal(calib.vignetting.points.length, 1)
  assert.deepEqual(entry.focal, [24, 70])
  assert.equal(entry.aperture[0], 2.8)
})

test('fuzzy words follow lfFuzzyStrCmp::Split', () => {
  assert.deepEqual(splitWords('FE 24-70mm F2.8 GM'), ['2.8', '24', '70', 'fe', 'gm', 'mm'])
  assert.deepEqual(splitWords('Nikkor Z 50mm f/1.0'), ['1', '50', 'mm', 'nikkor', 'z'])
  assert.ok(splitWords('EF 70-200mm f/4L IS USM +1.4x').includes('+'))
  assert.equal(fuzzyScore(splitWords('FE 24-70mm F2.8 GM'), 'FE 24-70mm f/2.8 GM'), 100)
  assert.equal(fuzzyScore(splitWords('FE 24-70mm F2.8 GM II'), 'FE 24-70mm f/2.8 GM'), 0) // strict: extra word
  assert.ok(fuzzyScore(splitWords('FE 24-70mm F2.8 GM II'), 'FE 24-70mm f/2.8 GM', false) > 0)
})

test('name guessing (case-insensitive, optional space after mm)', () => {
  assert.deepEqual(guessFromName('XF18-55mmF2.8-4 R LM OIS'), { minFocal: 18, maxFocal: 55, minAperture: 2.8 })
  assert.deepEqual(guessFromName('FE 85mm F1.8'), { minFocal: 85, maxFocal: 85, minAperture: 1.8 })
  assert.deepEqual(guessFromName('Canon EF 2x extender III'), { minFocal: 0, maxFocal: 0, minAperture: 0 })
})

test('hermite reproduces linear data and endpoints', () => {
  near(hermite(1, 2, 3, 4, 0.25), 2.25)
  near(hermite(null, 2, 3, null, 0.5), 2.5)
  near(hermite(0, 5, 7, 1, 0), 5)
  near(hermite(0, 5, 7, 1, 1), 7)
})

// synthetic lens whose terms follow lensfun's 1/f law exactly: after the
// focal pre-scaling every spline knot is the same constant, so any focal must
// come back as exactly C/f — a direct check of __parameter_scales
const synth = {
  cropFactor: 1, focal: [10, 40],
  distortion: { model: 'poly3', points: [10, 20, 30, 40].map((f) => [f, -0.5 / f]) },
  tca: { model: 'poly3', points: [10, 20, 30, 40].map((f) => [f, 1.001, 0.999, 0.02 / f, 0, 0.01 / f, -0.01 / f]) },
  vignetting: { model: 'pa', points: [[20, 2.8, 1000, -0.6, 0.2, -0.1], [20, 5.6, 1000, -0.2, 0.1, 0]] },
}

test('focal interpolation: 1/f scaling, exact hits, clamped ends', () => {
  const c = correctionAt(synth, { focal: 25 })
  near(c.distortion.terms[0], -0.5 / 25, 1e-12)
  near(c.tca.terms[0], 1.001, 1e-12) // vr/vb are not focal-scaled
  near(c.tca.terms[2], 0.02 / 25, 1e-12)
  near(c.tca.terms[4], 0.01 / 25, 1e-12)
  assert.deepEqual(correctionAt(synth, { focal: 30 }).distortion.terms, [-0.5 / 30])
  assert.deepEqual(correctionAt(synth, { focal: 8 }).distortion.terms, [-0.5 / 10]) // nearest, unscaled
  assert.deepEqual(correctionAt(synth, { focal: 55 }).distortion.terms, [-0.5 / 40])
})

test('vignetting IDW: exact, reciprocal-aperture midpoint, too far, crop guard', () => {
  assert.deepEqual(correctionAt(synth, { focal: 20, aperture: 2.8 }).vignetting.terms, [-0.6, 0.2, -0.1])
  // equal reciprocal-axis distance to both samples → plain average
  const a = 4 / ((4 / 2.8 + 4 / 5.6) / 2)
  const v = correctionAt(synth, { focal: 20, aperture: a }).vignetting.terms
  near(v[0], -0.4, 1e-9); near(v[1], 0.15, 1e-9); near(v[2], -0.05, 1e-9)
  assert.equal(correctionAt(synth, { focal: 20, aperture: 1.2 }).vignetting, null) // 4/1.2 - 4/2.8 > 1
  assert.equal(correctionAt(synth, { focal: 20 }).vignetting, null) // no aperture
  const big = correctionAt({ ...synth, cropFactor: 1.5 }, { focal: 20, aperture: 2.8, cropFactor: 1 })
  assert.equal(big.distortion, null) // calibration from a smaller sensor
})

test('shaderParams reproduces the Hugin formulas in corner units', () => {
  // poly3, ptlens with a 1.5-crop calibration applied to a 1.5-crop image:
  // r_hugin = s·r, s = hypot(1.5, 1); lensfun keeps centre scale (u_h = d·Ru_h)
  const s = Math.hypot(1.5, 1)
  for (const [model, terms] of [['poly3', [-0.03]], ['ptlens', [0.01, -0.04, 0.02]], ['poly5', [-0.02, 0.003]]]) {
    const corr = { cropFactor: 1.5, aspectRatio: 1.5, distortion: { model, terms }, tca: null, vignetting: null }
    const a = shaderParams(corr, { imageCrop: 1.5 }).distortion
    const [A, B, C] = model === 'ptlens' ? terms : model === 'poly3' ? [0, terms[0], 0] : [0, 0, 0]
    const d = model === 'poly5' ? 1 : 1 - A - B - C
    for (const r of [0.1, 0.5, 0.9, 1]) {
      const Ru = (s * r) / d
      const Rd = model === 'poly5'
        ? s * r * (1 + terms[0] * (s * r) ** 2 + terms[1] * (s * r) ** 4)
        : Ru * (A * Ru ** 3 + B * Ru ** 2 + C * Ru + d)
      near(distortRadius(a, r), Rd / s, 1e-12, `${model} r=${r}`)
    }
  }
  // pa: r = 1 at the calibration corner; a 1.0 calibration on a 1.5 crop sees r·(1/1.5)
  const v = shaderParams({ cropFactor: 1, vignetting: { model: 'pa', terms: [-0.9, 0.3, 0.1] } }, { imageCrop: 1.5 }).vignetting
  const g = (k, r) => 1 + k[0] * r * r + k[1] * r ** 4 + k[2] * r ** 6
  near(g(v, 1), g([-0.9, 0.3, 0.1], 1 / 1.5), 1e-12)
  // tca poly3 c, b scale by s, s²
  const t = shaderParams({ cropFactor: 1, aspectRatio: 1.5, tca: { model: 'poly3', terms: [1.001, 0.999, 0.002, 0, 0.001, -0.001] } }).tca
  near(t.red[1], 0.002 * s, 1e-15); near(t.red[2], 0.001 * s * s, 1e-15); near(t.blue[2], -0.001 * s * s, 1e-15)
})

const indexPath = fileURLToPath(new URL('../../public/lensfun/index.json', import.meta.url))
const have = existsSync(indexPath)
const index = have ? JSON.parse(readFileSync(indexPath, 'utf8')) : null
const calibOf = (lens) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../public/lensfun/${lens.file}`, import.meta.url)), 'utf8'))[lens.i]

test('matches real EXIF lens strings against the generated index', { skip: !have && 'public/lensfun not generated' }, () => {
  const cases = [
    [['SONY', 'ILCE-7M3', 'FE 24-70mm F2.8 GM'], /^FE 24-70mm f\/2\.8 GM$/],
    [['NIKON CORPORATION', 'NIKON Z 6', 'NIKKOR Z 24-70mm f/4 S'], /^Nikkor Z 24-70mm f\/4 S$/],
    [['Canon', 'Canon EOS R5', 'RF24-105mm F4 L IS USM'], /^Canon RF 24-105mm F4L IS USM$/],
    [['FUJIFILM', 'X-T3', 'XF18-55mmF2.8-4 R LM OIS'], /^XF18-55mmF2\.8-4 R LM OIS$/],
  ]
  for (const [[cameraMaker, cameraModel, lensModel], want] of cases) {
    const r = matchLens(index, { cameraMaker, cameraModel, lensModel, focal: 35 })
    assert.ok(r.camera, `camera ${cameraModel}`)
    assert.match(r.lens?.model ?? '', want, lensModel)
    const c = correctionAt(calibOf(r.lens), { focal: 35, aperture: 5.6, cropFactor: r.camera.cropFactor })
    assert.ok(c.distortion, `${lensModel} distortion`)
    const p = shaderParams(c, { imageCrop: r.camera.cropFactor })
    assert.equal(p.distortion.length, 5)
    assert.ok(p.distortion.every(Number.isFinite))
    // sane: under 10% radial displacement at the corner
    assert.ok(Math.abs(distortRadius(p.distortion, 1) - 1) < 0.1, lensModel)
  }
  // mount honoured: a Sony E body never gets the Canon RF lens
  const x = matchLens(index, { cameraMaker: 'SONY', cameraModel: 'ILCE-7M3', lensModel: 'RF24-105mm F4 L IS USM' })
  assert.equal(x.lens, null)
  // extra EXIF words: falls back to the db name contained in the EXIF string
  const y = matchLens(index, { cameraMaker: 'SONY', cameraModel: 'ILCE-7M3', lensModel: 'Sony FE 24-70mm F2.8 GM (SEL2470GM)' })
  assert.match(y.lens?.model ?? '', /^FE 24-70mm f\/2\.8 GM$/)
  // empty lens string on an interchangeable mount identifies nothing
  assert.equal(matchLens(index, { cameraMaker: 'SONY', cameraModel: 'ILCE-7M3', lensModel: '' }).lens, null)
})
