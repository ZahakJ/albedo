// Phase 4 effects e2e: local contrast (texture/clarity/dehaze) + vignette
// through the real multi-pass blur pyramid on BOTH backends. All assertions
// run on lossless PNG export readbacks; the same frames feed a backend-parity
// diff. Perf: 24MP synthetic card, cold (blur build) vs warm render + export.
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

  // via PNG blob, matching the app's file flow (see tone.e2e note on
  // GPU-backed bitmaps and the worker's scratch GL context)
  const open = async (id, w, h, paint) => {
    const oc = new OffscreenCanvas(w, h)
    paint(oc.getContext('2d'))
    const bmp = await createImageBitmap(await oc.convertToBlob({ type: 'image/png' }))
    await rc.openPhoto(id, bmp, doc({}))
  }
  const b64 = (u8) => {
    let s = ''
    for (let i = 0; i < u8.length; i += 32768) s += String.fromCharCode.apply(null, u8.subarray(i, i + 32768))
    return btoa(s)
  }
  const shoot = async (id, modules) => {
    const { blob } = await rc.exportPhoto(id, doc(modules), { type: 'image/png' })
    const bm = await createImageBitmap(blob)
    const c2 = new OffscreenCanvas(bm.width, bm.height)
    const g = c2.getContext('2d', { willReadFrequently: true })
    g.drawImage(bm, 0, 0)
    return { w: bm.width, h: bm.height, b64: b64(new Uint8Array(g.getImageData(0, 0, bm.width, bm.height).data.buffer)) }
  }
  const lc = (clarity, texture, dehaze) => ({ localcontrast: { clarity, texture, dehaze } })
  const vig = (amount, midpoint = 50, roundness = 0, feather = 50) =>
    ({ vignette: { amount, midpoint, roundness, feather } })
  const F = {}

  // card 1 — half sharp / half flat: left 2×2 checker 85/150, right flat 118
  await open('detail', 512, 128, (cx) => {
    cx.fillStyle = 'rgb(118,118,118)'
    cx.fillRect(0, 0, 512, 128)
    for (let y = 0; y < 128; y += 2) {
      for (let x = 0; x < 256; x += 2) {
        const v = ((x >> 1) + (y >> 1)) & 1 ? 150 : 85
        cx.fillStyle = `rgb(${v},${v},${v})`
        cx.fillRect(x, y, 2, 2)
      }
    }
  })
  F.detailBase = await shoot('detail', {})
  F.detailTex = await shoot('detail', lc(0, 80, 0))
  // display render with effects on: exercises the RENDER device's blur
  // pipeline (webgpu exports re-render on the scratch GL context, so this is
  // the only WGSL multi-pass coverage; validation errors land on the console)
  const fm = new Promise((res) => {
    const off = rc.onRenderEvent((d) => { if (d.type === 'frame' && d.ms != null) { off(); res() } })
  })
  rc.sendParams('detail', doc(lc(30, 50, 10)), false)
  await fm

  // card 2 — midtone bars (32px, 100/140) left, highlight flat 240 right
  await open('clarity', 512, 128, (cx) => {
    cx.fillStyle = 'rgb(240,240,240)'
    cx.fillRect(0, 0, 512, 128)
    for (let x = 0; x < 256; x += 32) {
      const v = (x >> 5) & 1 ? 140 : 100
      cx.fillStyle = `rgb(${v},${v},${v})`
      cx.fillRect(x, 0, 32, 128)
    }
  })
  F.clarityBase = await shoot('clarity', {})
  F.clarityPlus = await shoot('clarity', lc(80, 0, 0))
  F.clarityMinus = await shoot('clarity', lc(-80, 0, 0))

  // card 3 — hazy low-contrast gradient: r=g 150→200, constant blue veil 140
  await open('haze', 512, 64, (cx) => {
    for (let x = 0; x < 512; x++) {
      const v = 150 + Math.round((50 * x) / 511)
      cx.fillStyle = `rgb(${v},${v},140)`
      cx.fillRect(x, 0, 1, 64)
    }
  })
  F.hazeBase = await shoot('haze', {})
  F.hazePlus = await shoot('haze', lc(0, 0, 80))

  // card 4 — flat 180 square for the vignette family
  await open('vin', 256, 256, (cx) => {
    cx.fillStyle = 'rgb(180,180,180)'
    cx.fillRect(0, 0, 256, 256)
  })
  F.vinBase = await shoot('vin', {})
  F.vin80 = await shoot('vin', vig(-80))
  F.vinMid30 = await shoot('vin', vig(-80, 30))
  F.vinMid70 = await shoot('vin', vig(-80, 70))
  F.vinF20 = await shoot('vin', vig(-80, 50, 0, 20))
  F.vinF80 = await shoot('vin', vig(-80, 50, 0, 80))

  // perf — 24MP gradient; cold FRAME includes the blur-pyramid build on the
  // render device, warm reuses the cache; export forces full completion
  let P = null
  if (perf) {
    await open('perf', 6000, 4000, (cx) => {
      const g = cx.createLinearGradient(0, 0, 6000, 4000)
      g.addColorStop(0, 'rgb(30,40,60)')
      g.addColorStop(1, 'rgb(230,210,180)')
      cx.fillStyle = g
      cx.fillRect(0, 0, 6000, 4000)
    })
    const fx = { ...lc(40, 40, 20), ...vig(-40) }
    // exports force GPU completion (readback+encode), so wall time is honest:
    // off = no effects; cold = first effects render, builds the blur pyramid;
    // warm = pyramid cached, develop pass only
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
  return { backend: info.backend, frames: F, perf: P }
}

// --- node-side metrics over decoded RGBA buffers ---
const buf = (f) => Buffer.from(f.b64, 'base64')
const stat = (b, w, x0, x1, y0, y1, ch = 0) => {
  let s = 0
  let s2 = 0
  let n = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const v = b[(y * w + x) * 4 + ch]
      s += v
      s2 += v * v
      n++
    }
  }
  const mean = s / n
  return { mean, std: Math.sqrt(Math.max(0, s2 / n - mean * mean)) }
}
const px = (b, w, x, y, ch = 0) => b[(y * w + x) * 4 + ch]
const s2l = (c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4

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

  // texture +80: detailed-half local stddev up ≥1.3×, flat half untouched
  const dBase = stat(B.detailBase, 512, 16, 240, 8, 120)
  const dTex = stat(B.detailTex, 512, 16, 240, 8, 120)
  check(dTex.std >= dBase.std * 1.3, `texture+80 detail std ${dBase.std.toFixed(1)} → ${dTex.std.toFixed(1)} (<1.3×)`)
  const fBase = stat(B.detailBase, 512, 272, 496, 8, 120)
  const fTex = stat(B.detailTex, 512, 272, 496, 8, 120)
  check(Math.abs(fTex.mean - fBase.mean) <= 1, `texture+80 moved flat half ${fBase.mean.toFixed(2)} → ${fTex.mean.toFixed(2)}`)

  // clarity ±80: midtone bar contrast moves both ways, highlights drift <3%
  const barContrast = (b) => {
    let hi = 0
    let lo = 0
    for (let i = 1; i <= 6; i++) {
      const m = stat(b, 512, i * 32 + 8, i * 32 + 24, 8, 120).mean
      if (i & 1) hi += m / 3 // odd bars painted 140
      else lo += m / 3
    }
    return hi - lo
  }
  const cB = barContrast(B.clarityBase)
  const cP = barContrast(B.clarityPlus)
  const cM = barContrast(B.clarityMinus)
  check(cP >= cB + 2, `clarity+80 bar contrast ${cB.toFixed(1)} → ${cP.toFixed(1)} (< +2)`)
  check(cM <= cB - 2, `clarity-80 bar contrast ${cB.toFixed(1)} → ${cM.toFixed(1)} (> -2)`)
  const hB = stat(B.clarityBase, 512, 384, 496, 8, 120).mean
  for (const [k, b] of [['clarity+80', B.clarityPlus], ['clarity-80', B.clarityMinus]]) {
    const m = stat(b, 512, 384, 496, 8, 120).mean
    check(Math.abs(m - hB) / hB < 0.03, `${k} highlight drift ${hB.toFixed(1)} → ${m.toFixed(1)} (≥3%)`)
  }

  // dehaze +80: gradient range up ≥1.25× (green channel column means)
  const colRange = (b) => {
    let mn = 255
    let mx = 0
    for (let x = 32; x < 480; x++) {
      const m = stat(b, 512, x, x + 1, 0, 64, 1).mean
      mn = Math.min(mn, m)
      mx = Math.max(mx, m)
    }
    return mx - mn
  }
  const hzB = colRange(B.hazeBase)
  const hzP = colRange(B.hazePlus)
  check(hzP >= hzB * 1.25, `dehaze+80 range ${hzB.toFixed(1)} → ${hzP.toFixed(1)} (<1.25×)`)

  // vignette -80: corner ≥0.5 stops down, center within 2/255
  const stops = Math.log2(s2l(px(B.vinBase, 256, 2, 2) / 255) / Math.max(1e-6, s2l(px(B.vin80, 256, 2, 2) / 255)))
  check(stops >= 0.5, `vignette-80 corner only ${stops.toFixed(2)} stops down`)
  check(Math.abs(px(B.vin80, 256, 128, 128) - px(B.vinBase, 256, 128, 128)) <= 2,
    `vignette-80 moved center ${px(B.vinBase, 256, 128, 128)} → ${px(B.vin80, 256, 128, 128)}`)

  // monotonicity: midpoint widens the clear zone; feather softens the corner
  const vm = [px(B.vinMid30, 256, 16, 128), px(B.vin80, 256, 16, 128), px(B.vinMid70, 256, 16, 128)]
  check(vm[0] <= vm[1] + 1 && vm[1] <= vm[2] + 1 && vm[2] - vm[0] >= 2,
    `vignette midpoint 30/50/70 not monotone at r≈0.62: ${vm}`)
  const vf = [px(B.vinF20, 256, 2, 2), px(B.vin80, 256, 2, 2), px(B.vinF80, 256, 2, 2)]
  check(vf[0] <= vf[1] + 1 && vf[1] <= vf[2] + 1 && vf[2] - vf[0] >= 2,
    `vignette feather 20/50/80 not monotone at corner: ${vf}`)

  check(errors.length === 0, `console: ${errors.join(' | ')}`)
  await browser.close()
  const pass = fails.length === 0
  console.log(`${backend}: ${pass ? 'PASS' : 'FAIL\n  ' + fails.join('\n  ')}`)
  console.log(`${backend} metrics: tex std ×${(dTex.std / dBase.std).toFixed(2)}, `
    + `clarity contrast ${cB.toFixed(1)} → +${cP.toFixed(1)}/-${cM.toFixed(1)}, `
    + `dehaze range ×${(hzP / hzB).toFixed(2)}, vignette corner -${stops.toFixed(2)} stops`)
  console.log(`${backend} perf (24MP export, SwiftShader): effects off ${r.perf.exportOff.toFixed(0)}ms, `
    + `cold (blur build) ${r.perf.exportCold.toFixed(0)}ms, warm (cached) ${r.perf.exportWarm.toFixed(0)}ms`)
  return { pass, frames: r.frames }
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
