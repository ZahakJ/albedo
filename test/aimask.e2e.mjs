// AI masks e2e: ISNet subject segmentation → brushTex channel → develop
// pipeline. Part A drives renderClient + segmentClient directly (tone
// harness) on BOTH backends: mask weight concentration on a synthetic dark
// subject, ev -2 through the ai mask on export, refine-edge blur widening
// the transition band. Part B drives the app UI on webgl2: + Subject
// button, wash on landing, exposure scrub darkens subject only, reload
// persistence (OPFS blob replay), refine slider commit.
// Tolerances are loose — segmentation is approximate. Skips (exit 0) with a clear
// message when public/models is absent (npm run setup-models).
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { execSync, spawn } from 'node:child_process'
import { mkdirSync, existsSync, statSync } from 'node:fs'
import { spawnVite } from './server.mjs'

const PORT = process.env.PORT ?? 5180
const root = new URL('..', import.meta.url).pathname
const scratch = process.env.SHOT_DIR ??
  join(tmpdir(), 'albedo-test')
mkdirSync(scratch, { recursive: true })

const model = `${root}public/models/isnet-general-use.onnx`
if (!existsSync(model) || statSync(model).size < 4_000_000) {
  console.log('SKIP aimask: model not installed — run: npm run setup-models')
  process.exit(0)
}

const listening = () => fetch(`http://localhost:${PORT}/`).then(() => true, () => false)
let vite = null
if (!(await listening())) {
  vite = spawnVite(String(PORT), { cwd: root, stdio: 'ignore' })
  for (let i = 0; i < 100 && !(await listening()); i++) await new Promise((r) => setTimeout(r, 200))
  if (!(await listening())) { console.error('vite failed to start'); process.exit(1) }
}

let failed = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`)
  if (!ok) failed++
}

// ── Part A: engine path via the tone harness, both backends ────────────────
const inPage = async ({ backend }) => {
  const rc = await import('/src/state/renderClient.js')
  const sc = await import('/src/state/segmentClient.js')
  const info = await rc.initRender(document.getElementById('view'), backend)
  rc.setView(192, 128)

  // synthetic card: clear dark subject (ellipse) on a light ground
  const W = 1024
  const H = 704
  const oc = new OffscreenCanvas(W, H)
  const cx = oc.getContext('2d')
  cx.fillStyle = 'rgb(205,205,205)'
  cx.fillRect(0, 0, W, H)
  cx.fillStyle = 'rgb(25,28,35)'
  cx.beginPath()
  cx.ellipse(W / 2, H / 2, 230, 185, 0, 0, Math.PI * 2)
  cx.fill()
  const blob = await oc.convertToBlob({ type: 'image/png' })
  const doc = (masks = []) => ({ schema: 1, photoId: 'seg', versionId: 'v', modules: {}, masks })
  await rc.openPhoto('seg', await createImageBitmap(blob), doc())

  const [qw, qh] = sc.quarterDims(W, H)
  const t0 = performance.now()
  const { mask } = await sc.segmentMask('seg', 'subject', blob, qw, qh)
  const segMs = performance.now() - t0

  // weight stats straight off the mask (0..255)
  const region = (fx0, fx1, fy0, fy1) => {
    let s = 0
    let n = 0
    for (let y = Math.round(fy0 * qh); y < fy1 * qh; y++) {
      for (let x = Math.round(fx0 * qw); x < fx1 * qw; x++) { s += mask[y * qw + x]; n++ }
    }
    return s / n
  }
  const wCenter = region(0.42, 0.58, 0.42, 0.58)
  const wCorners = (region(0, 0.12, 0, 0.12) + region(0.88, 1, 0, 0.12) +
    region(0, 0.12, 0.88, 1) + region(0.88, 1, 0.88, 1)) / 4

  rc.sendMaskTex('seg', { maskId: 'ai1', channel: 0, width: qw, height: qh, data: mask.slice() })

  const A = (a) => ({ ev: 0, temp: 0, contrast: 0, highlights: 0, shadows: 0, saturation: 0, clarity: 0, ...a })
  const aim = (refine) => [{
    id: 'ai1', name: 'Subject 1', kind: 'ai', enabled: true, invert: false,
    geom: { refine }, adjust: A({ ev: -2 }), model: 'subject', channel: 0,
  }]
  const b64 = (u8) => {
    let s = ''
    for (let i = 0; i < u8.length; i += 32768) s += String.fromCharCode.apply(null, u8.subarray(i, i + 32768))
    return btoa(s)
  }
  const shoot = async (masks) => {
    const { blob: out } = await rc.exportPhoto('seg', doc(masks), { type: 'image/png' })
    const bm = await createImageBitmap(out)
    const c2 = new OffscreenCanvas(bm.width, bm.height)
    const g = c2.getContext('2d', { willReadFrequently: true })
    g.drawImage(bm, 0, 0)
    return { w: bm.width, h: bm.height, b64: b64(new Uint8Array(g.getImageData(0, 0, bm.width, bm.height).data.buffer)) }
  }
  const F = {}
  F.base = await shoot([])
  F.ev = await shoot(aim(0))
  F.refined = await shoot(aim(80))
  return { backend: info.backend, frames: F, segMs, qw, qh, wCenter, wCorners }
}

const buf = (f) => Buffer.from(f.b64, 'base64')
const px = (b, w, x, y, ch = 0) => b[(y * w + x) * 4 + ch]
const s2l = (c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
const stopsDown = (base, masked) =>
  Math.log2(s2l(base / 255) / Math.max(1e-6, s2l(masked / 255)))

// edge softness along the center row: the card's content edge is hard, so
// the mask ramp shows as a darkened halo on the background side — count the
// pixels sitting between the two plateaus (dark subject / untouched bg)
const softCount = (b, w, h, dark, light) => {
  const y = h >> 1
  const t1 = dark + 15
  const t2 = light - 8
  let n = 0
  for (let x = w >> 1; x < w; x++) {
    const v = px(b, w, x, y)
    if (v > t1 && v < t2) n++
  }
  return n
}

const runHarness = async (backend) => {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader'] })
  const page = await browser.newPage()
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(`http://localhost:${PORT}/test/tone.html`)
  const r = await page.evaluate(inPage, { backend })
  await browser.close()
  check(`${backend}: backend used`, r.backend === backend, r.backend)
  // headless runs the model on one CPU thread (no hardware adapter): the
  // budget is generous; real-GPU timings live in test/bench
  check(`${backend}: segmentation completes <60s`, r.segMs < 60000, `${r.segMs.toFixed(0)}ms`)
  console.log(`     ${backend}: segment took ${r.segMs.toFixed(0)}ms (${r.qw}×${r.qh} mask)`)
  check(`${backend}: mask weight concentrated on subject`, r.wCenter >= 140, `center ${r.wCenter.toFixed(0)}/255`)
  check(`${backend}: mask leaves background`, r.wCorners <= 50, `corners ${r.wCorners.toFixed(0)}/255`)

  const B = Object.fromEntries(Object.entries(r.frames).map(([k, f]) => [k, buf(f)]))
  const { w, h } = r.frames.base
  const cD = stopsDown(px(B.base, w, w >> 1, h >> 1), px(B.ev, w, w >> 1, h >> 1))
  check(`${backend}: ai ev-2 darkens subject ≥0.7 stops`, cD >= 0.7, `${cD.toFixed(2)} stops`)
  const bD = Math.abs(stopsDown(px(B.base, w, 30, 30), px(B.ev, w, 30, 30)))
  check(`${backend}: ai ev-2 leaves background <0.15 stops`, bD < 0.15, `${bD.toFixed(3)} stops`)

  const dark = px(B.ev, w, w >> 1, h >> 1)
  const light = px(B.ev, w, 30, h >> 1)
  const w0 = softCount(B.ev, w, h, dark, light)
  const w80 = softCount(B.refined, w, h, px(B.refined, w, w >> 1, h >> 1), light)
  check(`${backend}: refine 80 widens the edge band`, w80 >= w0 + 8, `${w0}px → ${w80}px soft`)

  check(`${backend}: no console errors`, errors.length === 0, errors.slice(0, 3).join(' | '))
}

await runHarness('webgpu')
await runHarness('webgl2')

// ── Part B: app UI — + Subject, wash, adjust, reload persistence ────────
const card = `${scratch}/aimask-card.png`
execSync(`magick -size 1000x700 xc:'rgb(205,205,205)' -fill 'rgb(25,28,35)' -draw "ellipse 500,350 230,180 0,360" ${card}`)

const probe = (png, fx, fy) => execSync(
  `magick ${png} -format "%[fx:int(255*p{int(w*${fx}),int(h*${fy})}.r)]" info:`
).toString().trim() * 1

{
  const browser = await chromium.launch({ args: ['--no-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader'] })
  const ctx = await browser.newContext({ colorScheme: 'dark', viewport: { width: 1440, height: 900 } })
  await ctx.addInitScript(() => {
    const Native = window.Worker
    window.Worker = class extends Native {
      constructor(url, opts) {
        super(url, opts)
        if (String(url).includes('render.worker')) window.__renderWorker = this
      }
    }
  })
  const page = await ctx.newPage()
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(`http://localhost:${PORT}/?backend=webgl2`)
  await page.waitForSelector('text=Drop photos here')
  await page.setInputFiles('input[type=file]', [card])
  await page.waitForFunction(() => document.querySelectorAll('.gcell').length === 1, null, { timeout: 30000 })
  await page.keyboard.press('d')
  await page.waitForFunction(
    () => parseInt(document.querySelector('.develop-canvas')?.style.width || 0) > 20,
    null, { timeout: 15000 })
  const doc = () => page.evaluate(() => window.__albedo.edit().doc)
  const wash = () => page.evaluate(() => document.querySelector('.develop').dataset.wash === '1')
  const settle = async () => {
    await page.evaluate(() => new Promise((res) => {
      const w = window.__renderWorker
      const done = () => { w?.removeEventListener('message', h); setTimeout(res, 0) }
      const h = (e) => { if (e.data.type === 'frame') done() }
      w?.addEventListener('message', h)
      requestAnimationFrame(() => { if (!w) done() })
      setTimeout(done, 1500)
    }))
    await page.waitForTimeout(150)
  }
  const probeUntil = async (path, fn, tries = 8) => {
    for (let i = 0; i < tries; i++) {
      await settle()
      await page.locator('.develop-canvas').screenshot({ path })
      if (fn()) return true
    }
    return false
  }

  // M → + Subject → mask lands, wash pinned on landing
  await page.keyboard.press('m')
  await page.waitForSelector('.mask-panel')
  await page.click('.mask-tool-ai >> nth=0')
  await page.waitForFunction(
    () => window.__albedo.edit().doc?.masks?.length === 1, null, { timeout: 60000 })
  let d = await doc()
  check('+ Subject creates an ai mask', d.masks[0].kind === 'ai' && d.masks[0].model === 'subject',
    JSON.stringify({ kind: d.masks[0].kind, model: d.masks[0].model, channel: d.masks[0].channel }))
  check('ai mask selected, wash shows on landing', await page.waitForFunction(
    () => document.querySelector('.develop').dataset.wash === '1', null, { timeout: 3000 },
  ).then(() => true, () => false))

  // exposure scrub (ai panel rows: 0 Refine edge, 1 Exposure) darkens the
  // subject on canvas; background stays put
  const sliders = page.locator('.mask-adjust .slider')
  const evBox = await sliders.nth(1).boundingBox()
  await page.mouse.move(evBox.x + evBox.width / 2, evBox.y + evBox.height / 2)
  await page.mouse.down()
  check('adjust-slider touch hides the wash', !(await wash()))
  await page.mouse.move(evBox.x + evBox.width * 0.08, evBox.y + evBox.height / 2, { steps: 4 })
  await page.mouse.up()
  await page.waitForTimeout(150)
  d = await doc()
  check('ai exposure commits', d.masks[0].adjust.ev < -1, `ev ${d.masks[0].adjust.ev}`)
  const shot1 = `${scratch}/aimask-ev.png`
  let cIn = 0
  let cOut = 0
  const evOk = await probeUntil(shot1, () => {
    cIn = probe(shot1, 0.5, 0.5)
    cOut = probe(shot1, 0.06, 0.5)
    return cOut - cIn >= 15 && cOut >= 180
  })
  check('ai ev darkens subject only on canvas', evOk, `subject ${cIn} vs bg ${cOut}`)

  // refine slider commits and re-renders
  const rBox = await sliders.nth(0).boundingBox()
  await page.mouse.move(rBox.x + rBox.width / 2, rBox.y + rBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(rBox.x + rBox.width * 0.9, rBox.y + rBox.height / 2, { steps: 4 })
  await page.mouse.up()
  await page.waitForTimeout(200)
  d = await doc()
  check('refine edge commits', (d.masks[0].geom.refine ?? 0) > 30, `refine ${d.masks[0].geom.refine}`)
  await settle()

  // reload: doc + OPFS mask blob replay survive
  await page.reload()
  await page.waitForFunction(() => document.querySelectorAll('.gcell').length === 1, null, { timeout: 30000 })
  await page.keyboard.press('d')
  await page.waitForFunction(
    () => parseInt(document.querySelector('.develop-canvas')?.style.width || 0) > 20,
    null, { timeout: 15000 })
  d = await doc()
  check('ai mask survives reload', d.masks?.length === 1 && d.masks[0].kind === 'ai',
    `masks ${d.masks?.length}`)
  const shot2 = `${scratch}/aimask-reload.png`
  let rIn = 0
  let rOut = 0
  const reloadOk = await probeUntil(shot2, () => {
    rIn = probe(shot2, 0.5, 0.5)
    rOut = probe(shot2, 0.06, 0.5)
    return rOut - rIn >= 15 && rOut >= 180
  })
  check('ai mask weights replay from OPFS blob', reloadOk, `subject ${rIn} vs bg ${rOut}`)

  check('app: no console errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  await browser.close()
}

if (vite) vite.kill()
console.log(failed ? `${failed} FAILURES` : 'ALL PASS')
process.exit(failed ? 1 : 0)
