// Phase 6 masks e2e: linear/radial/brush local adjustment masks through the
// real develop pipeline. Part A drives the render worker directly (tone
// harness) on BOTH backends — mask math, invert, stacking, crop composition,
// brush replay from doc strokes, per-mask clarity (lcOn forcing) — with a
// backend-parity diff over every frame. Part B drives the app UI on webgl2
// (SwiftShader webgpu display is blank — see orient.e2e): mask mode, gizmos,
// wash show/hide rules, brush painting + reload persistence, copy/paste.
// Starts its own vite on 5180 unless one is already listening.
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { execSync, spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { spawnVite } from './server.mjs'

const PORT = process.env.PORT ?? 5180
const root = new URL('..', import.meta.url).pathname
const scratch = process.env.SHOT_DIR ??
  join(tmpdir(), 'albedo-test')
mkdirSync(scratch, { recursive: true })

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

// ── Part A: engine math via the tone harness, both backends ────────────────
const inPage = async ({ backend }) => {
  const rc = await import('/src/state/renderClient.js')
  const info = await rc.initRender(document.getElementById('view'), backend)
  rc.setView(192, 128)
  const doc = (modules, masks = []) => ({ schema: 1, photoId: 'x', versionId: 'v', modules, masks })

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
  const shoot = async (id, modules, masks) => {
    const { blob } = await rc.exportPhoto(id, doc(modules, masks), { type: 'image/png' })
    const bm = await createImageBitmap(blob)
    const c2 = new OffscreenCanvas(bm.width, bm.height)
    const g = c2.getContext('2d', { willReadFrequently: true })
    g.drawImage(bm, 0, 0)
    return { w: bm.width, h: bm.height, b64: b64(new Uint8Array(g.getImageData(0, 0, bm.width, bm.height).data.buffer)) }
  }

  const A = (a) => ({ ev: 0, temp: 0, contrast: 0, highlights: 0, shadows: 0, saturation: 0, clarity: 0, ...a })
  let uid = 0
  const mask = (kind, geom, adjust, extra = {}) => ({
    id: `m${++uid}`, name: kind, kind, enabled: true, invert: false,
    geom, adjust: A(adjust), ...extra,
  })
  // linear rising left→right over x 0.55..0.65: left half m=0, right m=1
  const LIN = { x0: 0.55, y0: 0.5, x1: 0.65, y1: 0.5 }
  const geo = (crop) => ({ geometry: { crop, angle: 0, flipH: 0 } })
  const F = {}

  // quadrant card: TL red, TR green, BL blue, BR white
  await open('quad', 200, 200, (cx) => {
    cx.fillStyle = 'red'; cx.fillRect(0, 0, 100, 100)
    cx.fillStyle = 'lime'; cx.fillRect(100, 0, 100, 100)
    cx.fillStyle = 'blue'; cx.fillRect(0, 100, 100, 100)
    cx.fillStyle = 'white'; cx.fillRect(100, 100, 100, 100)
  })
  F.qBase = await shoot('quad', {}, [])
  F.qLin = await shoot('quad', {}, [mask('linear', LIN, { ev: -2 })])
  F.qLinInv = await shoot('quad', {}, [mask('linear', LIN, { ev: -2 }, { invert: true })])
  F.qStack = await shoot('quad', {}, [mask('linear', LIN, { ev: -1 }), mask('linear', LIN, { ev: -1 })])
  // mask + crop composition: the mask is source-anchored, so a right-half
  // crop lands fully inside it and a left-half crop misses it entirely
  F.qCropRBase = await shoot('quad', geo({ x: 0.5, y: 0, w: 0.5, h: 1 }), [])
  F.qCropR = await shoot('quad', geo({ x: 0.5, y: 0, w: 0.5, h: 1 }), [mask('linear', LIN, { ev: -2 })])
  F.qCropLBase = await shoot('quad', geo({ x: 0, y: 0, w: 0.5, h: 1 }), [])
  F.qCropL = await shoot('quad', geo({ x: 0, y: 0, w: 0.5, h: 1 }), [mask('linear', LIN, { ev: -2 })])

  // flat orange card for radial saturation
  await open('sat', 256, 256, (cx) => {
    cx.fillStyle = 'rgb(230,140,60)'
    cx.fillRect(0, 0, 256, 256)
  })
  const RAD = { cx: 0.5, cy: 0.5, rx: 0.25, ry: 0.25, angle: 0, feather: 0.3 }
  F.sBase = await shoot('sat', {}, [])
  F.sRad = await shoot('sat', {}, [mask('radial', RAD, { saturation: -100 })])
  F.sRadInv = await shoot('sat', {}, [mask('radial', RAD, { saturation: -100 }, { invert: true })])

  // midtone bars left / flat highlight right (effects card 2 twin) for
  // per-mask clarity — no global localcontrast, so lcOn forcing is on trial
  await open('bars', 512, 128, (cx) => {
    cx.fillStyle = 'rgb(240,240,240)'
    cx.fillRect(0, 0, 512, 128)
    for (let x = 0; x < 256; x += 32) {
      const v = (x >> 5) & 1 ? 140 : 100
      cx.fillStyle = `rgb(${v},${v},${v})`
      cx.fillRect(x, 0, 32, 128)
    }
  })
  const RADCL = { cx: 0.25, cy: 0.5, rx: 0.22, ry: 0.125, angle: 0, feather: 0.1 }
  F.clBase = await shoot('bars', {}, [])
  F.clMask = await shoot('bars', {}, [mask('radial', RADCL, { clarity: 80 })])

  // flat gray card for brush replay-from-doc (the OPEN/EXPORT rebuild path)
  await open('gray', 256, 256, (cx) => {
    cx.fillStyle = 'rgb(200,200,200)'
    cx.fillRect(0, 0, 256, 256)
  })
  const strokeMain = { pts: [[0.3, 0.5, 1], [0.35, 0.5, 1], [0.4, 0.5, 1]], size: 0.2, flow: 1, erase: false }
  const strokeErase = { pts: [[0.3, 0.5, 1]], size: 0.3, flow: 1, erase: true }
  F.brBase = await shoot('gray', {}, [])
  F.brMask = await shoot('gray', {}, [mask('brush', { strokes: [strokeMain] }, { ev: -2 })])
  F.brErase = await shoot('gray', {}, [mask('brush', { strokes: [strokeMain, strokeErase] }, { ev: -2 })])

  return { backend: info.backend, frames: F }
}

const buf = (f) => Buffer.from(f.b64, 'base64')
const px = (b, w, x, y, ch = 0) => b[(y * w + x) * 4 + ch]
const s2l = (c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
const stopsDown = (base, masked) =>
  Math.log2(s2l(base / 255) / Math.max(1e-6, s2l(masked / 255)))
const stat = (b, w, x0, x1, y0, y1, ch = 0) => {
  let s = 0
  let n = 0
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { s += b[(y * w + x) * 4 + ch]; n++ }
  return s / n
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
  const F = r.frames
  const B = Object.fromEntries(Object.entries(F).map(([k, f]) => [k, buf(f)]))

  // linear ev -2: graded (right) side ≥1 stop down, far (left) side <2/255
  const gDown = stopsDown(px(B.qBase, 200, 150, 50, 1), px(B.qLin, 200, 150, 50, 1))
  check(`${backend}: linear ev-2 darkens graded side ≥1 stop`, gDown >= 1, `${gDown.toFixed(2)} stops`)
  const lMove = Math.abs(px(B.qLin, 200, 50, 50) - px(B.qBase, 200, 50, 50))
  check(`${backend}: linear ev-2 leaves far side (<2/255)`, lMove < 2, `Δ${lMove}`)

  // invert flips which side moves
  const iDown = stopsDown(px(B.qBase, 200, 50, 50), px(B.qLinInv, 200, 50, 50))
  check(`${backend}: inverted linear darkens the OTHER side ≥1 stop`, iDown >= 1, `${iDown.toFixed(2)} stops`)
  const iMove = Math.abs(px(B.qLinInv, 200, 150, 50, 1) - px(B.qBase, 200, 150, 50, 1))
  check(`${backend}: inverted linear leaves graded side (<2/255)`, iMove < 2, `Δ${iMove}`)

  // two ev-1 masks stack additively (≈2 stops)
  const sDown = stopsDown(px(B.qBase, 200, 150, 50, 1), px(B.qStack, 200, 150, 50, 1))
  check(`${backend}: 2× ev-1 masks stack ≈2 stops`, sDown >= 1.7 && sDown <= 2.3, `${sDown.toFixed(2)} stops`)

  // mask + crop compose: right-half crop sits fully in the mask, left misses
  const cDown = stopsDown(px(B.qCropRBase, 100, 50, 50, 1), px(B.qCropR, 100, 50, 50, 1))
  check(`${backend}: mask glued under right crop (≥1 stop)`, cDown >= 1, `${cDown.toFixed(2)} stops`)
  const cMove = Math.abs(px(B.qCropL, 100, 50, 50) - px(B.qCropLBase, 100, 50, 50))
  check(`${backend}: mask misses left crop (<2/255)`, cMove < 2, `Δ${cMove}`)

  // radial saturation -100: inside desaturates, corner untouched
  const chroma = (b, x, y) => Math.abs(px(b, 256, x, y, 0) - px(b, 256, x, y, 2))
  check(`${backend}: radial sat-100 desaturates center`,
    chroma(B.sBase, 128, 128) > 100 && chroma(B.sRad, 128, 128) < 14,
    `|r-b| ${chroma(B.sBase, 128, 128)} → ${chroma(B.sRad, 128, 128)}`)
  const cornerMove = Math.max(...[0, 1, 2].map((ch) =>
    Math.abs(px(B.sRad, 256, 16, 16, ch) - px(B.sBase, 256, 16, 16, ch))))
  check(`${backend}: radial sat-100 leaves corner (<2/255)`, cornerMove < 2, `Δ${cornerMove}`)
  check(`${backend}: inverted radial flips inside/outside`,
    chroma(B.sRadInv, 128, 128) > 100 && chroma(B.sRadInv, 16, 16) < 14,
    `center ${chroma(B.sRadInv, 128, 128)}, corner ${chroma(B.sRadInv, 16, 16)}`)

  // per-mask clarity (no global lc → exercises worker lcOn forcing): central
  // bars gain contrast, far flat highlight stays put
  const barContrast = (b) => {
    let hi = 0
    let lo = 0
    for (let i = 2; i <= 5; i++) {
      const m = stat(b, 512, i * 32 + 8, i * 32 + 24, 40, 88)
      if (i & 1) hi += m / 2
      else lo += m / 2
    }
    return hi - lo
  }
  const cb = barContrast(B.clBase)
  const cm = barContrast(B.clMask)
  check(`${backend}: mask clarity+80 lifts bar contrast`, cm >= cb + 1.5, `${cb.toFixed(1)} → ${cm.toFixed(1)}`)
  const fB = stat(B.clBase, 512, 384, 496, 8, 120)
  const fM = stat(B.clMask, 512, 384, 496, 8, 120)
  check(`${backend}: mask clarity leaves flat right`, Math.abs(fM - fB) <= 1, `${fB.toFixed(1)} → ${fM.toFixed(1)}`)

  // brush replay from doc strokes (export path rebuilds brushTex)
  const bDown = stopsDown(px(B.brBase, 256, 90, 128), px(B.brMask, 256, 90, 128))
  check(`${backend}: brush ev-2 darkens painted region ≥1.2 stops`, bDown >= 1.2, `${bDown.toFixed(2)} stops`)
  const bFar = Math.abs(px(B.brMask, 256, 240, 16) - px(B.brBase, 256, 240, 16))
  check(`${backend}: brush leaves unpainted region (<2/255)`, bFar < 2, `Δ${bFar}`)
  const eBack = Math.abs(px(B.brErase, 256, 77, 128) - px(B.brBase, 256, 77, 128))
  check(`${backend}: erase stroke restores its center (≤4/255)`, eBack <= 4, `Δ${eBack}`)
  const eKeep = stopsDown(px(B.brBase, 256, 102, 128), px(B.brErase, 256, 102, 128))
  check(`${backend}: erase leaves the rest of the stroke dark`, eKeep >= 0.8, `${eKeep.toFixed(2)} stops`)

  check(`${backend}: no console errors`, errors.length === 0, errors.slice(0, 3).join(' | '))
  return F
}

const fa = await runHarness('webgpu')
const fb = await runHarness('webgl2')

// backend parity: mean |diff| ≤ 2/255 per frame over rgb bytes
for (const k of Object.keys(fa)) {
  const pa = buf(fa[k])
  const pb = buf(fb[k])
  let sum = 0
  let n = 0
  for (let i = 0; i < pa.length; i += 4) {
    sum += Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2])
    n += 3
  }
  const mad = sum / n
  check(`parity ${k} ≤2/255`, mad <= 2, `mean diff ${mad.toFixed(3)}`)
}

// ── Part B: app UI — mask mode, wash rules, brush + persistence (webgl2) ───
const card1 = `${scratch}/masks-card.png`
const card2 = `${scratch}/masks-card2.png`
execSync(`magick -size 1000x700 xc:'rgb(172,172,172)' ${card1}`)
execSync(`magick -size 1000x700 gradient:'rgb(60,70,90)'-'rgb(200,190,170)' ${card2}`)

// read one pixel's r/g/b at fractional coords
const probe = (png, fx, fy) => execSync(
  `magick ${png} -format "%[fx:int(255*p{int(w*${fx}),int(h*${fy})}.r)] %[fx:int(255*p{int(w*${fx}),int(h*${fy})}.g)] %[fx:int(255*p{int(w*${fx}),int(h*${fy})}.b)]" info:`
).toString().trim().split(' ').map(Number)

{
  const browser = await chromium.launch({ args: ['--no-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader'] })
  const ctx = await browser.newContext({ colorScheme: 'dark', viewport: { width: 1440, height: 900 } })
  // keep a handle on the render worker: canvas assertions must wait for a
  // real FRAME (the app coalesces PARAMS per rAF, which headless can defer)
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
  await page.setInputFiles('input[type=file]', [card1, card2])
  await page.waitForFunction(() => document.querySelectorAll('.gcell').length === 2, null, { timeout: 30000 })
  await page.keyboard.press('d')
  await page.waitForFunction(
    () => parseInt(document.querySelector('.develop-canvas')?.style.width || 0) > 20,
    null, { timeout: 15000 })
  const doc = () => page.evaluate(() => window.__albedo.edit().doc)
  const maskUi = () => page.evaluate(() => window.__albedo.maskUi())
  const wash = () => page.evaluate(() => document.querySelector('.develop').dataset.wash === '1')
  // flush the rAF-coalesced PARAMS and wait for the worker's next frame
  const settle = async () => {
    await page.evaluate(() => new Promise((res) => {
      const w = window.__renderWorker
      const done = () => { w?.removeEventListener('message', h); setTimeout(res, 0) }
      const h = (e) => { if (e.data.type === 'frame') done() }
      w?.addEventListener('message', h)
      requestAnimationFrame(() => { if (!w) done() })
      setTimeout(done, 1500)
    }))
    await page.waitForTimeout(150) // let the compositor pick the frame up
  }
  // canvas-pixel assertion with retry: headless compositing of the
  // worker-owned canvas can lag frames under load — assert the steady state
  const probeUntil = async (path, fn, tries = 8) => {
    for (let i = 0; i < tries; i++) {
      await settle()
      await page.locator('.develop-canvas').screenshot({ path })
      if (fn()) return true
    }
    return false
  }

  // M opens mask mode, panel swaps in
  await page.keyboard.press('m')
  await page.waitForSelector('.mask-panel')
  check('M opens mask mode (panel swaps)', (await maskUi()).on === true)

  // ⇧M arms radial; drag creates it, wash shows DURING the drag
  await page.keyboard.press('Shift+M')
  check('⇧M arms radial tool', (await maskUi()).tool === 'radial')
  const cv = await page.locator('.develop-canvas').boundingBox()
  const ccx = cv.x + cv.width / 2
  const ccy = cv.y + cv.height / 2
  await page.mouse.move(ccx, ccy)
  await page.mouse.down()
  await page.mouse.move(ccx + 130, ccy + 80, { steps: 6 })
  check('wash shows during geometry drag', await wash())
  await page.mouse.up()
  await page.waitForTimeout(150)
  let d = await doc()
  check('drag creates radial mask', d.masks.length === 1 && d.masks[0].kind === 'radial',
    JSON.stringify(d.masks[0]?.geom ?? null))
  check('wash hides after the drag', !(await wash()))
  check('radial gizmo renders', await page.locator('.mask-gizmo-radial').count() === 1)

  // one history entry: undo removes, redo restores
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(100)
  check('undo removes the mask', (await doc()).masks.length === 0)
  await page.keyboard.press('Control+Shift+z')
  await page.waitForTimeout(100)
  check('redo restores the mask', (await doc()).masks.length === 1)
  await page.evaluate(() => document.querySelectorAll('.mask-row')[0].click()) // reselect after undo/redo

  // L arms linear; drag creates it; Delete removes the selection
  await page.keyboard.press('l')
  check('L arms linear tool', (await maskUi()).tool === 'linear')
  await page.mouse.move(cv.x + cv.width * 0.15, cv.y + cv.height * 0.85)
  await page.mouse.down()
  await page.mouse.move(cv.x + cv.width * 0.15, cv.y + cv.height * 0.55, { steps: 4 })
  await page.mouse.up()
  await page.waitForTimeout(150)
  d = await doc()
  check('L-drag creates linear mask', d.masks.length === 2 && d.masks[1].kind === 'linear',
    d.masks[1]?.kind)
  check('linear gizmo renders', await page.locator('.mask-gizmo-linear').count() === 1)
  await page.keyboard.press('Delete')
  await page.waitForTimeout(100)
  check('Delete removes the selected mask', (await doc()).masks.length === 1)
  await page.evaluate(() => document.querySelectorAll('.mask-row')[0].click())

  // O pins the wash; touching an adjust slider kills it (the key rule)
  await page.keyboard.press('o')
  check('O pins the wash', await wash())
  const sliders = page.locator('.mask-adjust .slider')
  const scrub = async (i, dx) => {
    const b = await sliders.nth(i).boundingBox()
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
    await page.mouse.down()
    await page.mouse.move(b.x + b.width / 2 + dx, b.y + b.height / 2, { steps: 4 })
    await page.mouse.up()
  }
  // radial panel rows: 0 Feather, 1 Exposure, 2 Temp, … 6 Saturation
  const satBox = await sliders.nth(6).boundingBox()
  await page.mouse.move(satBox.x + satBox.width / 2, satBox.y + satBox.height / 2)
  await page.mouse.down()
  check('adjust-slider touch hides the wash instantly', !(await wash()))
  await page.mouse.move(satBox.x + satBox.width * 0.2, satBox.y + satBox.height / 2, { steps: 4 })
  await page.mouse.up()
  await page.waitForTimeout(120)
  d = await doc()
  check('saturation scrub commits to the mask', (d.masks[0].adjust.saturation ?? 0) < 0,
    `sat ${d.masks[0].adjust.saturation}`)

  // strong negative ev on the radial → center darkens vs corner
  await scrub(1, -(await sliders.nth(1).boundingBox()).width * 0.45)
  d = await doc()
  check('exposure scrub commits negative ev', d.masks[0].adjust.ev < -0.5, `ev ${d.masks[0].adjust.ev}`)
  const shot1 = `${scratch}/masks-radial.png`
  // same-row probes (base tone equal); off-center dodges the gizmo dot
  let cMid = 0
  let cOut = 0
  const radialOk = await probeUntil(shot1, () => {
    cMid = probe(shot1, 0.54, 0.48)[0]
    cOut = probe(shot1, 0.88, 0.48)[0]
    return cOut - cMid >= 15
  })
  check('radial ev darkens inside vs outside on canvas', radialOk, `outside ${cOut} vs inside ${cMid}`)

  // K creates a brush mask; painting streams + commits ONE stroke
  await page.keyboard.press('k')
  await page.waitForTimeout(120)
  d = await doc()
  check('K adds a brush mask', d.masks.length === 2 && d.masks[1].kind === 'brush')
  check('brush tool armed', (await maskUi()).tool === 'brush')
  const px0 = cv.x + cv.width * 0.25
  const py0 = cv.y + cv.height * 0.28
  await page.mouse.move(px0, py0)
  await page.mouse.down()
  await page.mouse.move(cv.x + cv.width * 0.40, py0, { steps: 10 })
  await page.mouse.up()
  await page.waitForTimeout(200)
  d = await doc()
  const stroke = d.masks[1].geom.strokes[0]
  check('stroke commits to the doc', d.masks[1].geom.strokes.length === 1 && stroke.pts.length >= 3,
    `pts ${stroke?.pts.length}`)
  // brush ev via the (brush-selected) Exposure slider — brush panel row 0 is
  // Exposure (no feather for brush masks)
  const bs = page.locator('.mask-adjust .slider')
  const evBox = await bs.nth(0).boundingBox()
  await page.mouse.move(evBox.x + evBox.width / 2, evBox.y + evBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(evBox.x + evBox.width * 0.08, evBox.y + evBox.height / 2, { steps: 4 })
  await page.mouse.up()
  await page.waitForTimeout(150)
  d = await doc()
  check('brush ev commits', d.masks[1].adjust.ev < -1, `ev ${d.masks[1].adjust.ev}`)
  const shot2 = `${scratch}/masks-brush.png`
  // mirrored probes share the radial weight; only the left one is painted
  let painted = 0
  let mirror = 0
  const brushOk = await probeUntil(shot2, () => {
    painted = probe(shot2, 0.32, 0.28)[0]
    mirror = probe(shot2, 0.68, 0.28)[0]
    return mirror - painted >= 15
  })
  check('brush stroke darkens painted region only', brushOk,
    `painted ${painted} vs mirror ${mirror}`)

  // reload: doc + brushTex rebuild survive
  await page.reload()
  await page.waitForFunction(() => document.querySelectorAll('.gcell').length === 2, null, { timeout: 30000 })
  await page.keyboard.press('d')
  await page.waitForFunction(
    () => parseInt(document.querySelector('.develop-canvas')?.style.width || 0) > 20,
    null, { timeout: 15000 })
  d = await doc()
  check('masks survive reload', d.masks?.length === 2 && d.masks[1].geom.strokes.length === 1,
    `masks ${d.masks?.length}`)
  const shot3 = `${scratch}/masks-reload.png`
  let rPainted = 0
  let rMirror = 0
  const reloadOk = await probeUntil(shot3, () => {
    rPainted = probe(shot3, 0.32, 0.28)[0]
    rMirror = probe(shot3, 0.68, 0.28)[0]
    return rMirror - rPainted >= 15
  })
  check('brush render survives reload (brushTex rebuilt)', reloadOk,
    `painted ${rPainted} vs mirror ${rMirror}`)

  // copy with the Masks group → paste onto photo 2
  await page.keyboard.press('Control+c')
  await page.waitForSelector('.copydlg')
  const boxes = page.locator('.copy-check input')
  check('copy dialog has a Masks group, prechecked', await boxes.nth(6).isChecked())
  // uncheck everything but Masks so the paste is unambiguous
  for (let i = 0; i < 6; i++) if (await boxes.nth(i).isChecked()) await boxes.nth(i).click()
  await page.keyboard.press('Enter')
  await page.waitForTimeout(100)
  await page.keyboard.press('g')
  await page.waitForTimeout(200)
  const id2 = await page.evaluate(() => document.querySelectorAll('.gcell')[1].dataset.id)
  await page.evaluate((id) => window.__albedo.view().selection, id2)
  await page.click(`.gcell[data-id="${id2}"]`)
  await page.keyboard.press('Control+v')
  await page.waitForTimeout(300)
  const doc2 = await page.evaluate(async (id) => await window.__albedo.loadDoc(isNaN(+id) ? id : +id), id2)
  check('masks ride copy/paste when group checked', doc2?.masks?.length === 2,
    `pasted masks ${doc2?.masks?.length}`)

  // ── final capture: mask mode, radial gizmo + list panel ──────────────────
  await page.click('.gcell:first-child')
  await page.keyboard.press('d')
  await page.waitForFunction(
    () => parseInt(document.querySelector('.develop-canvas')?.style.width || 0) > 20,
    null, { timeout: 15000 })
  await page.keyboard.press('m')
  await page.waitForSelector('.mask-panel')
  await page.evaluate(() => document.querySelectorAll('.mask-row')[0].click())
  await page.keyboard.press('o') // pin the wash for the capture
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${scratch}/masks-final.png` })

  check('app: no console errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  await browser.close()
}

if (vite) vite.kill()
console.log(failed ? `${failed} FAILURES` : 'ALL PASS')
process.exit(failed ? 1 : 0)
