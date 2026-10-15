// Develop feature-wave e2e: 3-way color grading, B&W conversion, film grain,
// auto tone / auto WB, WB eyedropper, curve TAT, histogram region-drag.
// Engine assertions run on lossless PNG exports through tone.html on BOTH
// backends (parity ≤ 2/255); UI assertions drive the real app (webgl2).
// Reuses the shared vite on 5180.
import { chromium } from 'playwright'
import { execSync } from 'node:child_process'
import { mkdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ensureServer } from './server.mjs'
import { wbNeutralize } from '../src/engine/editdoc.js'

const PORT = process.env.PORT ?? 5180
const root = fileURLToPath(new URL('..', import.meta.url))
const shots = process.env.SHOT_DIR ?? `${root}test/fixtures`
mkdirSync(shots, { recursive: true })

// UI fixture: flat warm-cast card (known linear values for the eyedropper)
const CAST = [150, 140, 125]
const castFile = `${root}test/fixtures/grade-cast.png`
if (!existsSync(castFile)) {
  execSync(`magick -size 400x300 xc:'rgb(${CAST[0]},${CAST[1]},${CAST[2]})' ${castFile}`)
}

await ensureServer(PORT)

const fails = []
const check = (cond, label) => { if (!cond) fails.push(label) }
const LAUNCH = { args: ['--no-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader'] }

// ── engine half: renders + exports through tone.html ───────────────────────
const inPage = async ({ backend }) => {
  const rc = await import('/src/state/renderClient.js')
  const info = await rc.initRender(document.getElementById('view'), backend)
  rc.setView(192, 128)
  const doc = (modules) => ({ schema: 1, photoId: 'x', versionId: 'v', modules, masks: [] })
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
  const shoot = async (id, modules, opts) => {
    const { blob } = await rc.exportPhoto(id, doc(modules), { type: 'image/png', ...opts })
    const bm = await createImageBitmap(blob)
    const c2 = new OffscreenCanvas(bm.width, bm.height)
    const g = c2.getContext('2d', { willReadFrequently: true })
    g.drawImage(bm, 0, 0)
    return {
      w: bm.width, h: bm.height,
      b64: b64(new Uint8Array(g.getImageData(0, 0, bm.width, bm.height).data.buffer)),
    }
  }
  const F = {}

  // card 1 — grading: dark 40 left half, bright 220 right half (192×128)
  await open('gr', 192, 128, (cx) => {
    cx.fillStyle = 'rgb(40,40,40)'
    cx.fillRect(0, 0, 96, 128)
    cx.fillStyle = 'rgb(220,220,220)'
    cx.fillRect(96, 0, 96, 128)
  })
  const zeroG = { shadows: { h: 0, s: 0 }, midtones: { h: 0, s: 0 }, highlights: { h: 0, s: 0 }, blending: 50, balance: 0 }
  F.grBase = await shoot('gr', {})
  F.grSh = await shoot('gr', { grading: { ...zeroG, shadows: { h: 220, s: 60 } } })
  F.grHi = await shoot('gr', { grading: { ...zeroG, highlights: { h: 40, s: 60 } } })

  // card 2 — B&W: red / gray / blue vertical thirds (192×96)
  await open('bw', 192, 96, (cx) => {
    cx.fillStyle = 'rgb(200,40,40)'
    cx.fillRect(0, 0, 64, 96)
    cx.fillStyle = 'rgb(128,128,128)'
    cx.fillRect(64, 0, 64, 96)
    cx.fillStyle = 'rgb(60,80,200)'
    cx.fillRect(128, 0, 64, 96)
  })
  const mix0 = Object.fromEntries(['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'].map((b) => [b, 0]))
  F.bwBase = await shoot('bw', {})
  F.bwOn = await shoot('bw', { bw: { on: 1, mix: mix0 } })
  F.bwRed = await shoot('bw', { bw: { on: 1, mix: { ...mix0, red: -80 } } })
  // toned B&W: grading still lands after conversion
  F.bwToned = await shoot('bw', {
    bw: { on: 1, mix: mix0 },
    grading: { ...zeroG, shadows: { h: 220, s: 60 } },
  })

  // card 3 — grain: flat 128 (256×256)
  await open('gn', 256, 256, (cx) => {
    cx.fillStyle = 'rgb(128,128,128)'
    cx.fillRect(0, 0, 256, 256)
  })
  const grainDoc = { grain: { amount: 60, size: 25, roughness: 50 } }
  F.gnBase = await shoot('gn', {})
  F.gn1 = await shoot('gn', grainDoc)
  F.gn2 = await shoot('gn', grainDoc)
  F.gnHalf = await shoot('gn', grainDoc, { longEdge: 128 }) // worker-side resScale

  // auto-WB round trip on a flat cast card: MSG.AUTO → apply → export
  await open('wb', 128, 96, (cx) => {
    cx.fillStyle = 'rgb(150,140,125)'
    cx.fillRect(0, 0, 128, 96)
  })
  const { modules: wbMods } = await rc.autoAdjust('wb', 'wb')
  F.wbFixed = await shoot('wb', wbMods)
  const wbApplied = wbMods.wb

  // sample the same card dead-center (eyedropper route, engine level)
  const sampled = await rc.samplePoint('wb', 0.5, 0.5)

  // auto-tone on the RAW DNG fixture: decode → open → AUTO → apply → export;
  // run AUTO again on the applied doc — idempotency
  const { decode } = await import('/src/state/decodeClient.js')
  const res = await fetch('/test/fixtures/sample.dng')
  const payload = await decode('dng', await res.arrayBuffer(), 'sample.dng', 'full')
  await rc.openPhoto('dng', payload, doc({}))
  const { modules: t1 } = await rc.autoAdjust('dng', 'tone')
  const fm = new Promise((r2) => {
    const off = rc.onRenderEvent((d) => { if (d.type === 'frame' && d.ms != null) { off(); r2() } })
  })
  rc.sendParams('dng', doc(t1), false)
  await fm
  F.dngAuto = await shoot('dng', t1, { type: 'image/jpeg', quality: 0.92 })
  const { modules: t2 } = await rc.autoAdjust('dng', 'tone')

  return { backend: info.backend, frames: F, wbApplied, sampled, t1, t2 }
}

// node-side pixel helpers over decoded RGBA
const buf = (f) => Buffer.from(f.b64, 'base64')
const boxMean = (f, x0, x1, y0, y1) => {
  const b = buf(f)
  const m = [0, 0, 0]
  let n = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * f.w + x) * 4
      m[0] += b[i]; m[1] += b[i + 1]; m[2] += b[i + 2]; n++
    }
  }
  return m.map((v) => v / n)
}
const lumaStd = (f) => {
  const b = buf(f)
  let s = 0
  let ss = 0
  let n = 0
  for (let i = 0; i < b.length; i += 4) {
    const l = 0.2126 * b[i] + 0.7152 * b[i + 1] + 0.0722 * b[i + 2]
    s += l; ss += l * l; n++
  }
  return Math.sqrt(Math.max(0, ss / n - (s / n) ** 2))
}
const chromaMean = (f) => {
  const b = buf(f)
  let s = 0
  let n = 0
  for (let i = 0; i < b.length; i += 4) {
    s += Math.abs(b[i] - b[i + 1]) + Math.abs(b[i + 1] - b[i + 2])
    n++
  }
  return s / n
}
const lumaMedian = (f) => {
  const b = buf(f)
  const hist = new Uint32Array(256)
  let n = 0
  for (let i = 0; i < b.length; i += 4) {
    hist[Math.min(255, Math.round(0.2126 * b[i] + 0.7152 * b[i + 1] + 0.0722 * b[i + 2]))]++
    n++
  }
  let acc = 0
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n / 2) return v }
  return 255
}

const runEngine = async (backend) => {
  const browser = await chromium.launch(LAUNCH)
  const page = await browser.newPage()
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(`http://localhost:${PORT}/test/tone.html`)
  const r = await page.evaluate(inPage, { backend })
  const t = (label) => `${backend} ${label}`
  check(r.backend === backend, t(`backend used ${r.backend}`))

  const F = r.frames
  // grading: shadows h220 s60 tints the dark half blue-ish, leaves brights
  const dark = (f) => boxMean(f, 16, 80, 16, 112)
  const bright = (f) => boxMean(f, 112, 176, 16, 112)
  const br = (m) => m[2] - m[0] // blue minus red
  check(br(dark(F.grSh)) - br(dark(F.grBase)) >= 5,
    t(`grading shadows: dark b-r Δ ${(br(dark(F.grSh)) - br(dark(F.grBase))).toFixed(1)} < 5`))
  check(Math.abs(br(bright(F.grSh)) - br(bright(F.grBase))) <= 3,
    t(`grading shadows leaked to brights Δ ${(br(bright(F.grSh)) - br(bright(F.grBase))).toFixed(1)}`))
  // highlights h40 s60 warms the bright half, leaves darks
  const rb = (m) => m[0] - m[2]
  check(rb(bright(F.grHi)) - rb(bright(F.grBase)) >= 5,
    t(`grading highlights: bright r-b Δ ${(rb(bright(F.grHi)) - rb(bright(F.grBase))).toFixed(1)} < 5`))
  check(Math.abs(rb(dark(F.grHi)) - rb(dark(F.grBase))) <= 3,
    t(`grading highlights leaked to darks Δ ${(rb(dark(F.grHi)) - rb(dark(F.grBase))).toFixed(1)}`))

  // B&W: chroma ≈ 0 everywhere; red-band -80 darkens the red patch's gray
  check(chromaMean(F.bwOn) <= 1, t(`bw chroma ${chromaMean(F.bwOn).toFixed(2)} > 1`))
  const redGray = (f) => boxMean(f, 8, 56, 8, 88)[1]
  const grayGray = (f) => boxMean(f, 72, 120, 8, 88)[1]
  check(redGray(F.bwOn) - redGray(F.bwRed) >= 10,
    t(`bw red -80 darkened only ${(redGray(F.bwOn) - redGray(F.bwRed)).toFixed(1)}`))
  check(Math.abs(grayGray(F.bwOn) - grayGray(F.bwRed)) <= 2, t('bw red -80 moved the gray patch'))
  // toned B&W: grading lands after conversion (blue-ish cast on the dark red patch)
  const tonedPatch = boxMean(F.bwToned, 8, 56, 8, 88)
  check(tonedPatch[2] - tonedPatch[0] >= 4,
    t(`toned bw: b-r ${(tonedPatch[2] - tonedPatch[0]).toFixed(1)} < 4`))

  // grain: raises flat std, deterministic, ≈scale-invariant via longEdge
  const s0 = lumaStd(F.gnBase)
  const s1 = lumaStd(F.gn1)
  const s2 = lumaStd(F.gn2)
  const sH = lumaStd(F.gnHalf)
  check(s1 - s0 >= 1.5, t(`grain60 std ${s0.toFixed(2)} → ${s1.toFixed(2)} (<+1.5)`))
  check(Math.abs(s1 - s2) < 0.05, t(`grain not deterministic: ${s1.toFixed(3)} vs ${s2.toFixed(3)}`))
  check(F.gnHalf.w === 128, t(`longEdge export width ${F.gnHalf.w} != 128`))
  check(sH > s1 * 0.55 && sH < s1 * 1.8,
    t(`grain scale variance: full ${s1.toFixed(2)} vs 1024-style ${sH.toFixed(2)}`))

  // auto WB neutralizes the cast card (temp/tint through the shader model)
  const wbC = boxMean(F.wbFixed, 32, 96, 24, 72)
  check(Math.max(...wbC) - Math.min(...wbC) <= 3,
    t(`auto-WB spread ${(Math.max(...wbC) - Math.min(...wbC)).toFixed(1)} > 3 (${wbC.map((v) => v.toFixed(1))})`))
  // SAMPLE returns the true pre-develop linear patch → same neutralization
  const nz = wbNeutralize(r.sampled.linear)
  check(Math.abs(nz.temp - r.wbApplied.temp) <= 2 && Math.abs(nz.tint - r.wbApplied.tint) <= 2,
    t(`sample-vs-auto wb mismatch: ${JSON.stringify(nz)} vs ${JSON.stringify(r.wbApplied)}`))

  // auto tone: DNG median lands mid, second run is a no-op-ish
  const med = lumaMedian(F.dngAuto)
  check(med >= 0.35 * 255 && med <= 0.5 * 255, t(`auto-tone median ${med} outside [89,128]`))
  const d1 = r.t1
  const d2 = r.t2
  const dev = Math.abs(d1.exposure.ev - d2.exposure.ev) * 20 // 0.05 steps → units
  const dtone = Math.max(...['highlights', 'shadows', 'whites', 'blacks']
    .map((k) => Math.abs(d1.tone[k] - d2.tone[k])))
  check(dev < 10 && dtone < 10, t(`auto-tone not idempotent: ev Δ${dev / 20}, tone Δ${dtone}`))

  check(errors.length === 0, t(`console: ${errors.join(' | ')}`))
  await browser.close()
  return r
}

const A = await runEngine('webgpu')
const B = await runEngine('webgl2')

// backend parity on the export frames: mean |rgb diff| ≤ 2/255
for (const k of Object.keys(A.frames)) {
  if (k === 'dngAuto') continue // JPEG re-encode noise; covered by raw.e2e parity
  const pa = buf(A.frames[k])
  const pb = buf(B.frames[k])
  let sum = 0
  let n = 0
  for (let i = 0; i < pa.length; i += 4) {
    sum += Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2])
    n += 3
  }
  check(sum / n <= 2, `parity ${k}: mean diff ${(sum / n).toFixed(3)} > 2`)
}

// ── UI half: eyedropper, curve TAT, histogram drag, B&W chip, wheels ───────
{
  const browser = await chromium.launch(LAUNCH)
  const ctx = await browser.newContext({ colorScheme: 'dark', viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(`http://localhost:${PORT}/?backend=webgl2`)
  await page.waitForSelector('text=Drop photos here')
  await page.setInputFiles('input[type=file]', [castFile])
  await page.waitForFunction(() => document.querySelectorAll('.gcell').length === 1, null, { timeout: 30000 })
  await page.keyboard.press('d')
  await page.waitForFunction(
    () => parseInt(document.querySelector('.develop-canvas')?.style.width || 0) > 20,
    null, { timeout: 15000 })
  const doc = () => page.evaluate(() => window.__albedo.edit().doc)
  const canvasBox = () => page.locator('.develop-canvas').boundingBox()

  // WB eyedropper: arm, click the (uniform) image center → wb committed
  await page.click('.wb-pick')
  check(await page.locator('.wb-pick.is-on').count() === 1, 'ui: eyedropper arms')
  let cb = await canvasBox()
  await page.mouse.click(cb.x + cb.width / 2, cb.y + cb.height / 2)
  await page.waitForFunction(() => !!window.__albedo.edit().doc?.modules?.wb, null, { timeout: 10000 })
  const wb = (await doc()).modules.wb
  const s2l = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  const l2s = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055)
  const lin = CAST.map((v) => s2l(v / 255))
  const mul = [1 + 0.25 * (wb.temp / 100), 1 - 0.25 * (wb.tint / 100), 1 - 0.25 * (wb.temp / 100)]
  const out = lin.map((v, i) => l2s(Math.min(1, v * mul[i])) * 255)
  check(Math.max(...out) - Math.min(...out) <= 3,
    `ui: eyedropper spread ${(Math.max(...out) - Math.min(...out)).toFixed(2)} > 3 (${JSON.stringify(wb)})`)
  check(await page.locator('.wb-pick.is-on').count() === 0, 'ui: eyedropper disarms after pick')

  // curve TAT: arm, vertical drag on the image → a point appears + moves
  await page.click('.tat-curve')
  cb = await canvasBox()
  const tx = cb.x + cb.width / 2
  const ty = cb.y + cb.height / 2
  await page.mouse.move(tx, ty)
  await page.mouse.down()
  await page.mouse.move(tx, ty - 44, { steps: 5 })
  await page.mouse.up()
  await page.waitForFunction(() => window.__albedo.edit().doc?.modules?.curve?.points?.length === 3,
    null, { timeout: 10000 })
  const pts = (await doc()).modules.curve.points
  check(pts[1][0] > 0 && pts[1][0] < 1, `ui: TAT point x ${pts[1][0]} not interior`)
  check(pts[1][1] > pts[1][0], `ui: TAT upward drag did not lift the curve (${pts[1]})`)
  await page.keyboard.press('Escape')
  check(await page.locator('.tat-curve.is-on').count() === 0, 'ui: Esc disarms TAT')

  // mixer TAT: arm, drag → some band of the active axis moves
  await page.click('.tat-mixer')
  await page.mouse.move(tx, ty)
  await page.mouse.down()
  await page.mouse.move(tx, ty + 36, { steps: 4 })
  await page.mouse.up()
  await page.waitForFunction(() => {
    const cm = window.__albedo.edit().doc?.modules?.colormix
    return cm && Object.values(cm).some((b) => b.h !== 0)
  }, null, { timeout: 10000 })
  check(true, 'ui: mixer TAT moves a band')
  await page.keyboard.press('Escape')

  // histogram region drag: exposure region raises ev, shadows region shadows
  const hb = await page.locator('.histo-canvas').boundingBox()
  const hy = hb.y + hb.height / 2
  await page.mouse.move(hb.x + hb.width * 0.5, hy)
  await page.mouse.down()
  await page.mouse.move(hb.x + hb.width * 0.5 + 40, hy, { steps: 4 })
  await page.mouse.up()
  let d = await doc()
  check((d.modules.exposure?.ev ?? 0) > 0, `ui: histogram exposure drag ev=${d.modules.exposure?.ev}`)
  await page.mouse.move(hb.x + hb.width * 0.2, hy)
  await page.mouse.down()
  await page.mouse.move(hb.x + hb.width * 0.2 + 40, hy, { steps: 4 })
  await page.mouse.up()
  d = await doc()
  check((d.modules.tone?.shadows ?? 0) > 0, `ui: histogram shadows drag = ${d.modules.tone?.shadows}`)

  // B&W chip toggles + persists in the doc
  await page.locator('.sec[data-sec=bw] .bw-chip').click()
  d = await doc()
  check(d.modules.bw?.on === 1, 'ui: B&W chip toggles on')

  // grading wheel drag: upper-left ≈ h135, s ≈ 60 on the shadows wheel
  await page.locator('.sec[data-sec=grading]').scrollIntoViewIfNeeded()
  const gw = await page.locator('.sec[data-sec=grading] .gwheel-canvas').first().boundingBox()
  const gcx = gw.x + gw.width / 2
  const gcy = gw.y + gw.height / 2
  await page.mouse.move(gcx, gcy)
  await page.mouse.down()
  await page.mouse.move(gcx - gw.width * 0.28, gcy - gw.height * 0.28, { steps: 4 })
  await page.mouse.up()
  d = await doc()
  const sh = d.modules.grading?.shadows
  check(sh?.s > 20 && sh?.h > 100 && sh?.h < 170, `ui: wheel drag → ${JSON.stringify(sh)}`)

  // screenshots: grading wheels + B&W panel
  await page.waitForTimeout(300)
  await page.locator('.sec[data-sec=grading]').screenshot({ path: `${shots}/grade-wheels.png` })
  await page.locator('.sec[data-sec=bw]').screenshot({ path: `${shots}/grade-bw.png` })
  await page.locator('.panel-right').screenshot({ path: `${shots}/grade-panel.png` })

  check(errors.length === 0, `ui console: ${errors.join(' | ')}`)
  await browser.close()
}

console.log(fails.length === 0 ? 'PASS grade' : `FAIL grade\n  ${fails.join('\n  ')}`)
process.exit(fails.length ? 1 : 0)
