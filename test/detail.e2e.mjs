// Phase 5b detail e2e: à-trous wavelet denoise (luma/chroma split) + the
// output-referred unsharp finish pass on BOTH backends. All assertions run on
// lossless PNG export readbacks of synthetic noisy cards (deterministic PRNG);
// the same frames feed a backend-parity diff. Also verifies the non-RAW
// gate: an untouched bitmap doc must render byte-similar to the source even
// though detail defaults are non-zero. Perf: 12MP card, NR off vs cold
// (7-pass chain build) vs warm (cached) export.
// Starts its own vite on 5180 unless one is already listening.
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { spawnVite } from './server.mjs'

const PORT = process.env.PORT ?? 5180
const root = new URL('..', import.meta.url).pathname
const listening = () => fetch(`http://localhost:${PORT}/`).then(() => true, () => false)
let vite = null
if (!(await listening())) {
  vite = spawnVite(String(PORT), { cwd: root, stdio: 'ignore' })
  for (let i = 0; i < 100 && !(await listening()); i++) await new Promise((r) => setTimeout(r, 200))
  if (!(await listening())) { console.error('vite failed to start'); process.exit(1) }
}

const inPage = async ({ backend, perf }) => {
  const rc = await import('/src/state/renderClient.js')
  const info = await rc.initRender(document.getElementById('view'), backend)
  rc.setView(192, 128)
  const doc = (modules) => ({ schema: 1, photoId: 'x', versionId: 'v', modules, masks: [] })
  // explicit detail module: applies even to bitmap sources (the gate only
  // forces defaults off when the module is ABSENT)
  const det = (over) => ({ detail: {
    sharpenAmount: 0, sharpenRadius: 1, sharpenMasking: 0, lumaNR: 0, chromaNR: 0, ...over } })

  const b64 = (u8) => {
    let s = ''
    for (let i = 0; i < u8.length; i += 32768) s += String.fromCharCode.apply(null, u8.subarray(i, i + 32768))
    return btoa(s)
  }
  // via PNG blob, matching the app's file flow (see tone.e2e note)
  const open = async (id, w, h, paint) => {
    const oc = new OffscreenCanvas(w, h)
    paint(oc.getContext('2d'))
    const bmp = await createImageBitmap(await oc.convertToBlob({ type: 'image/png' }))
    await rc.openPhoto(id, bmp, doc({}))
  }
  const shoot = async (id, modules) => {
    const { blob } = await rc.exportPhoto(id, doc(modules), { type: 'image/png' })
    const bm = await createImageBitmap(blob)
    const c2 = new OffscreenCanvas(bm.width, bm.height)
    const g = c2.getContext('2d', { willReadFrequently: true })
    g.drawImage(bm, 0, 0)
    return { w: bm.width, h: bm.height, b64: b64(new Uint8Array(g.getImageData(0, 0, bm.width, bm.height).data.buffer)) }
  }
  const mulberry32 = (seed) => () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const F = {}

  // card 1 — noise card: flat 128 left half, 90|170 step at x=288 right half,
  // independent per-channel uniform noise ±8 everywhere (deterministic)
  let srcNz = null
  await open('nz', 384, 192, (cx) => {
    const im = cx.createImageData(384, 192)
    const rnd = mulberry32(7)
    for (let y = 0; y < 192; y++) {
      for (let x = 0; x < 384; x++) {
        const base = x < 192 ? 128 : x < 288 ? 90 : 170
        const i = (y * 384 + x) * 4
        for (let c = 0; c < 3; c++) {
          im.data[i + c] = Math.max(0, Math.min(255, base + Math.round((rnd() * 2 - 1) * 8)))
        }
        im.data[i + 3] = 255
      }
    }
    cx.putImageData(im, 0, 0)
    srcNz = b64(new Uint8Array(im.data.buffer))
  })
  F.nzBase = await shoot('nz', {}) // untouched doc: detail must stay OFF (bitmap)
  F.nzChroma = await shoot('nz', det({ chromaNR: 80 }))
  F.nzLuma = await shoot('nz', det({ lumaNR: 80 }))
  F.nzSharp = await shoot('nz', det({ sharpenAmount: 100 }))
  F.nzSharpMask = await shoot('nz', det({ sharpenAmount: 100, sharpenMasking: 100 }))

  // display render with NR + sharpen on: exercises the RENDER device's nr +
  // finish pipelines (webgpu exports re-render on the scratch GL context, so
  // this is the only WGSL multi-pass coverage; validation errors → console)
  const fm = new Promise((res) => {
    const off = rc.onRenderEvent((d) => { if (d.type === 'frame' && d.ms != null) { off(); res() } })
  })
  rc.sendParams('nz', doc(det({ lumaNR: 40, chromaNR: 40, sharpenAmount: 80, sharpenMasking: 30 })), false)
  await fm

  // card 2 — clean 90|170 step at x=128 for acutance
  await open('edge', 256, 128, (cx) => {
    cx.fillStyle = 'rgb(90,90,90)'
    cx.fillRect(0, 0, 128, 128)
    cx.fillStyle = 'rgb(170,170,170)'
    cx.fillRect(128, 0, 128, 128)
  })
  F.edgeBase = await shoot('edge', {})
  F.edgeSharp = await shoot('edge', det({ sharpenAmount: 100 }))

  // perf — 12MP gradient; cold export builds the 7-pass NR chain, warm
  // reuses the (photoId, lumaNR, chromaNR) cache; exports force completion
  let P = null
  if (perf) {
    await open('perf', 4000, 3000, (cx) => {
      const g = cx.createLinearGradient(0, 0, 4000, 3000)
      g.addColorStop(0, 'rgb(30,40,60)')
      g.addColorStop(1, 'rgb(230,210,180)')
      cx.fillStyle = g
      cx.fillRect(0, 0, 4000, 3000)
    })
    const fx = det({ lumaNR: 50, chromaNR: 50, sharpenAmount: 60 })
    const timed = async (modules) => {
      const t0 = performance.now()
      await rc.exportPhoto('perf', doc(modules), { type: 'image/jpeg', quality: 0.9 })
      return performance.now() - t0
    }
    const exportOff = await timed({})
    const exportCold = await timed(fx)
    const exportWarm = await timed(fx)
    P = { exportOff, exportCold, exportWarm }
  }
  return { backend: info.backend, frames: F, srcNz, perf: P }
}

// --- node-side metrics over decoded RGBA buffers ---
const buf = (f) => Buffer.from(typeof f === 'string' ? f : f.b64, 'base64')
// luma (Rec.709 weights, matching the shader's LW) + chroma residuals r−y, b−y
const stats = (b, w, x0, x1, y0, y1) => {
  let sy = 0, syy = 0, scr = 0, scrr = 0, scb = 0, scbb = 0, n = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4
      const lum = 0.2126 * b[i] + 0.7152 * b[i + 1] + 0.0722 * b[i + 2]
      const cr = b[i] - lum
      const cb = b[i + 2] - lum
      sy += lum; syy += lum * lum
      scr += cr; scrr += cr * cr
      scb += cb; scbb += cb * cb
      n++
    }
  }
  const std = (s, ss) => Math.sqrt(Math.max(0, ss / n - (s / n) * (s / n)))
  return { mean: sy / n, luma: std(sy, syy), chroma: (std(scr, scrr) + std(scb, scbb)) / 2 }
}
// total variation of luma across the vertical step — overshoot raises it
const acutance = (b, w, x0, x1, y0, y1) => {
  let s = 0, n = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1 - 1; x++) {
      const i = (y * w + x) * 4
      const l0 = 0.2126 * b[i] + 0.7152 * b[i + 1] + 0.0722 * b[i + 2]
      const l1 = 0.2126 * b[i + 4] + 0.7152 * b[i + 5] + 0.0722 * b[i + 6]
      s += Math.abs(l1 - l0)
    }
    n++
  }
  return s / n
}

const run = async (backend) => {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader'] })
  const page = await browser.newPage()
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(`http://localhost:${PORT}/test/tone.html`)
  const r = await page.evaluate(inPage, { backend, perf: true })

  const fails = []
  const check = (cond, label) => { if (!cond) fails.push(label) }
  check(r.backend === backend, `backend used ${r.backend}, wanted ${backend}`)

  const B = Object.fromEntries(Object.entries(r.frames).map(([k, f]) => [k, buf(f)]))
  const W = 384
  const flat = (b) => stats(b, W, 16, 176, 16, 176)          // noisy flat 128
  const edgeWin = (b) => stats(b, W, 240, 336, 16, 176)      // spans the step
  // strip means 16..40 px each side of the step at x=288 — outside the
  // à-trous support (levels reach ±14 px), so retention isolates the edge
  const contrast = (b) =>
    stats(b, W, 304, 328, 16, 176).mean - stats(b, W, 248, 272, 16, 176).mean

  // non-RAW gate: untouched doc renders byte-similar to the painted source
  // despite the non-zero detail defaults (sharpen 40 / chroma NR 25)
  {
    const src = buf(r.srcNz)
    const out = B.nzBase
    let sum = 0, n = 0
    for (let i = 0; i < src.length; i += 4) {
      sum += Math.abs(src[i] - out[i]) + Math.abs(src[i + 1] - out[i + 1]) + Math.abs(src[i + 2] - out[i + 2])
      n += 3
    }
    check(sum / n < 0.5, `non-RAW gate: untouched export drifted ${(sum / n).toFixed(3)}/255 from source (≥0.5)`)
  }

  // chroma NR 80: flat chroma std down ≥40%, luma edge window moves <10%
  const cB = flat(B.nzBase)
  const cN = flat(B.nzChroma)
  check(cN.chroma <= cB.chroma * 0.6,
    `chromaNR80 flat chroma std ${cB.chroma.toFixed(2)} → ${cN.chroma.toFixed(2)} (<40% cut)`)
  const eB = edgeWin(B.nzBase)
  const eN = edgeWin(B.nzChroma)
  check(Math.abs(eN.luma - eB.luma) / eB.luma < 0.1,
    `chromaNR80 disturbed luma edges ${eB.luma.toFixed(2)} → ${eN.luma.toFixed(2)} (≥10%)`)

  // luma NR 80: flat luma std down ≥40%, step keeps ≥80% contrast
  const lN = flat(B.nzLuma)
  check(lN.luma <= cB.luma * 0.6,
    `lumaNR80 flat luma std ${cB.luma.toFixed(2)} → ${lN.luma.toFixed(2)} (<40% cut)`)
  const kB = contrast(B.nzBase)
  const kN = contrast(B.nzLuma)
  check(kN >= kB * 0.8, `lumaNR80 edge contrast ${kB.toFixed(1)} → ${kN.toFixed(1)} (<80% kept)`)

  // sharpen 100: acutance across the clean step up ≥1.3×
  const aB = acutance(B.edgeBase, 256, 120, 136, 8, 120)
  const aS = acutance(B.edgeSharp, 256, 120, 136, 8, 120)
  check(aS >= aB * 1.3, `sharpen100 acutance ${aB.toFixed(1)} → ${aS.toFixed(1)} (<1.3×)`)

  // masking 100: flat noise NOT amplified (≈ base ±10%); sanity: without
  // masking the same sharpen DOES amplify it, or the gate proves nothing
  const sF = flat(B.nzSharp)
  const mF = flat(B.nzSharpMask)
  check(sF.luma >= cB.luma * 1.2,
    `sharpen100 flat luma std ${cB.luma.toFixed(2)} → ${sF.luma.toFixed(2)} — masking test moot`)
  check(Math.abs(mF.luma - cB.luma) / cB.luma <= 0.1,
    `masking100 flat luma std ${cB.luma.toFixed(2)} → ${mF.luma.toFixed(2)} (>±10%)`)

  check(errors.length === 0, `console: ${errors.join(' | ')}`)
  await browser.close()
  const pass = fails.length === 0
  console.log(`${backend}: ${pass ? 'PASS' : 'FAIL\n  ' + fails.join('\n  ')}`)
  console.log(`${backend} metrics: chroma ×${(cN.chroma / cB.chroma).toFixed(2)}, `
    + `lumaNR ×${(lN.luma / cB.luma).toFixed(2)} (edge kept ${(kN / kB * 100).toFixed(0)}%), `
    + `acutance ×${(aS / aB).toFixed(2)}, masked flat ×${(mF.luma / cB.luma).toFixed(2)}`)
  console.log(`${backend} perf (12MP export, SwiftShader): detail off ${r.perf?.exportOff.toFixed(0) ?? '—'}ms, `
    + `cold (NR build) ${r.perf?.exportCold.toFixed(0) ?? '—'}ms, warm (cached) ${r.perf?.exportWarm.toFixed(0) ?? '—'}ms`)
  return { pass, frames: r.frames, perf: r.perf }
}

const a = await run('webgpu')
const b = await run('webgl2')

// backend parity: mean |diff| ≤ 2/255 per test case over rgb bytes
let parityOk = true
for (const k of Object.keys(a.frames)) {
  const pa = buf(a.frames[k])
  const pb = buf(b.frames[k])
  let sum = 0
  let n = 0
  for (let i = 0; i < pa.length; i += 4) {
    sum += Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2])
    n += 3
  }
  const mad = sum / n
  if (mad > 2) { parityOk = false; console.log(`parity FAIL ${k}: mean diff ${mad.toFixed(3)}`) }
}
console.log(`parity: ${parityOk ? 'PASS' : 'FAIL'}`)

if (vite) vite.kill()
process.exit(a.pass && b.pass && parityOk ? 0 : 1)
