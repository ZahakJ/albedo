// Phase 5a geometry e2e: crop/rotate/flip through the develop shaders, ROI
// loupe zoom, and the crop-mode overlay. Export math asserted on BOTH
// backends via the tone harness (SwiftShader webgpu display is blank — see
// orient.e2e — so display-side checks ride webgl2 in the app UI part).
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

// ── Part A: export math via the tone harness, both backends ────────────────
const inPage = async ({ backend }) => {
  const rc = await import('/src/state/renderClient.js')
  const info = await rc.initRender(document.getElementById('view'), backend)
  rc.setView(192, 128)
  const doc = (modules) => ({ schema: 1, photoId: 'x', versionId: 'v', modules, masks: [] })

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
  const geo = (crop, angle = 0) => ({ geometry: { crop, angle, flipH: 0 } })
  const F = {}

  // quadrant card: TL red, TR green, BL blue, BR white (orient.e2e's card)
  await open('quad', 200, 200, (cx) => {
    cx.fillStyle = 'red'; cx.fillRect(0, 0, 100, 100)
    cx.fillStyle = 'lime'; cx.fillRect(100, 0, 100, 100)
    cx.fillStyle = 'blue'; cx.fillRect(0, 100, 100, 100)
    cx.fillStyle = 'white'; cx.fillRect(100, 100, 100, 100)
  })
  F.right = await shoot('quad', geo({ x: 0.5, y: 0, w: 0.5, h: 1 }))
  F.rotP = await shoot('quad', geo({ x: 0, y: 0, w: 1, h: 1 }, 10))
  F.rotN = await shoot('quad', geo({ x: 0, y: 0, w: 1, h: 1 }, -10))
  F.cropRot = await shoot('quad', geo({ x: 0.05, y: 0.05, w: 0.9, h: 0.9 }, 10))

  // effects card 1 twin: left half 2×2 checker 85/150, right half flat 118 —
  // crop straddles the boundary so aux (blur pyramid) misalignment would show
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
  F.cropBase = await shoot('detail', geo({ x: 0.25, y: 0, w: 0.5, h: 1 }))
  F.cropTex = await shoot('detail', { ...geo({ x: 0.25, y: 0, w: 0.5, h: 1 }), localcontrast: { clarity: 0, texture: 80, dehaze: 0 } })

  return { backend: info.backend, frames: F }
}

const buf = (f) => Buffer.from(f.b64, 'base64')
const px = (b, w, x, y) => [b[(y * w + x) * 4], b[(y * w + x) * 4 + 1], b[(y * w + x) * 4 + 2]]
const classify = ([r, g, b]) => r > 128 && g > 128 && b > 128 ? 'white'
  : r > 128 && g < 128 && b < 128 ? 'red'
  : g > 128 && r < 128 ? 'green'
  : b > 128 && r < 128 ? 'blue' : `?(${r},${g},${b})`
const stat = (b, w, x0, x1, y0, y1) => {
  let s = 0
  let s2 = 0
  let n = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const v = b[(y * w + x) * 4]
      s += v
      s2 += v * v
      n++
    }
  }
  const mean = s / n
  return { mean, std: Math.sqrt(Math.max(0, s2 / n - mean * mean)) }
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

  // 1. crop right half: dims halved, only green (top) / white (bottom) remain
  const R = buf(F.right)
  check(`${backend}: crop-right dims 100×200`, F.right.w === 100 && F.right.h === 200, `${F.right.w}×${F.right.h}`)
  check(`${backend}: crop-right top green`, classify(px(R, 100, 50, 50)) === 'green', classify(px(R, 100, 50, 50)))
  check(`${backend}: crop-right bottom white`, classify(px(R, 100, 50, 150)) === 'white', classify(px(R, 100, 50, 150)))
  let stray = 0
  for (let y = 5; y < 200; y += 10) {
    for (let x = 5; x < 100; x += 10) {
      const c = classify(px(R, 100, x, y))
      if (c !== 'green' && c !== 'white') stray++
    }
  }
  check(`${backend}: crop-right has no red/blue anywhere`, stray === 0, `${stray} stray probes`)

  // 2. angle ±10°: dims shrink by the inscribed scale (200/(cos+sin) ≈ 173);
  // near-center probes tilt with the quadrant boundary — direction asserted
  for (const [name, F2, leftOfC, aboveC] of [['rot+10', F.rotP, 'red', 'green'], ['rot-10', F.rotN, 'blue', 'red']]) {
    const B = buf(F2)
    const exp = Math.round(200 / (Math.cos(Math.PI / 18) + Math.sin(Math.PI / 18)))
    check(`${backend}: ${name} dims inscribed`, Math.abs(F2.w - exp) <= 1 && Math.abs(F2.h - exp) <= 1, `${F2.w}×${F2.h} want ~${exp}`)
    const w = F2.w
    const a = classify(px(B, w, Math.round(w * 0.4), Math.round(w * 0.5)))
    const b = classify(px(B, w, Math.round(w * 0.5), Math.round(w * 0.4)))
    check(`${backend}: ${name} left-of-center is ${leftOfC}`, a === leftOfC, a)
    check(`${backend}: ${name} above-center is ${aboveC}`, b === aboveC, b)
    let dark = 0
    for (const [x, y] of [[3, 3], [w - 4, 3], [3, F2.h - 4], [w - 4, F2.h - 4]]) {
      const [r, g, bl] = px(B, w, x, y)
      if (r + g + bl < 90) dark++
    }
    check(`${backend}: ${name} no black corners`, dark === 0, `${dark} dark corners`)
  }

  // 3. crop+rotate: square crop stays square, corners never black
  const C = buf(F.cropRot)
  check(`${backend}: crop+rot square`, Math.abs(F.cropRot.w - F.cropRot.h) <= 1, `${F.cropRot.w}×${F.cropRot.h}`)
  let dark = 0
  for (const [x, y] of [[3, 3], [F.cropRot.w - 4, 3], [3, F.cropRot.h - 4], [F.cropRot.w - 4, F.cropRot.h - 4]]) {
    const [r, g, b] = px(C, F.cropRot.w, x, y)
    if (r + g + b < 90) dark++
  }
  check(`${backend}: crop+rot no black corners`, dark === 0, `${dark} dark corners`)

  // 4. clarity family composes with crop: texture +80 on a crop straddling
  // the sharp/flat boundary — sharp half sharpens, flat half stays put (an
  // aux-pyramid/geometry mismatch would smear the boundary or shift detail)
  const b0 = buf(F.cropBase)
  const b1 = buf(F.cropTex)
  check(`${backend}: detail crop dims 256×128`, F.cropBase.w === 256 && F.cropBase.h === 128, `${F.cropBase.w}×${F.cropBase.h}`)
  const s0 = stat(b0, 256, 8, 112, 8, 120)
  const s1 = stat(b1, 256, 8, 112, 8, 120)
  check(`${backend}: texture+80 on crop sharpens detail ≥1.3×`, s1.std >= s0.std * 1.3, `std ${s0.std.toFixed(1)} → ${s1.std.toFixed(1)}`)
  const f0 = stat(b0, 256, 140, 248, 8, 120)
  const f1 = stat(b1, 256, 140, 248, 8, 120)
  check(`${backend}: texture+80 on crop leaves flat half`, Math.abs(f1.mean - f0.mean) <= 1, `${f0.mean.toFixed(2)} → ${f1.mean.toFixed(2)}`)

  check(`${backend}: no console errors`, errors.length === 0, errors.join(' | '))
}

await runHarness('webgpu')
await runHarness('webgl2')

// ── Part B: app UI — loupe zoom + crop mode overlay (webgl2 display) ───────
const file = `${scratch}/geometry-card.png`
execSync(`magick -size 2400x1600 plasma:fractal -blur 0x2 ${file}`)

{
  const browser = await chromium.launch({ args: ['--no-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader'] })
  const ctx = await browser.newContext({ colorScheme: 'dark', viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(`http://localhost:${PORT}/?backend=webgl2`)
  await page.waitForSelector('text=Drop photos here')
  await page.setInputFiles('input[type=file]', file)
  await page.waitForFunction(() => document.querySelectorAll('.gcell').length === 1, null, { timeout: 30000 })
  await page.keyboard.press('d')
  await page.waitForFunction(
    () => parseInt(document.querySelector('.develop-canvas')?.style.width || 0) > 20,
    null, { timeout: 15000 })
  const view = () => page.evaluate(() => window.__albedo.view())
  const doc = () => page.evaluate(() => window.__albedo.edit().doc)

  // zoom: click → 1:1 with a viewport-sized canvas, never image-sized
  check('indicator FIT', (await page.textContent('.topbar-zoom')) === 'FIT')
  await page.locator('.develop-canvas').click()
  await page.waitForTimeout(200)
  check('click zooms to 1:1', (await view()).zoom === 1)
  check('indicator 100%', (await page.textContent('.topbar-zoom')) === '100%')
  const cw = await page.evaluate(() => document.querySelector('.develop-canvas').width)
  check('1:1 canvas stays viewport-sized', cw > 100 && cw < 1200, `canvas.width=${cw} (image 2400)`)

  // wheel + space-drag pan
  const before = await view()
  await page.mouse.move(700, 400)
  await page.mouse.wheel(60, 40)
  await page.waitForTimeout(120)
  const afterWheel = await view()
  check('wheel pans the loupe', afterWheel.panX !== before.panX || afterWheel.panY !== before.panY,
    `pan ${before.panX.toFixed(3)},${before.panY.toFixed(3)} → ${afterWheel.panX.toFixed(3)},${afterWheel.panY.toFixed(3)}`)
  await page.keyboard.down('Space')
  await page.waitForTimeout(80)
  check('space shows grab cursor', await page.locator('.canvas-mat[data-cursor="grab"]').count() === 1)
  await page.mouse.move(700, 400)
  await page.mouse.down()
  await page.mouse.move(640, 360, { steps: 4 })
  await page.mouse.up()
  await page.keyboard.up('Space')
  const afterDrag = await view()
  check('space-drag pans', afterDrag.panX !== afterWheel.panX || afterDrag.panY !== afterWheel.panY)
  await page.keyboard.press('z')
  await page.waitForTimeout(120)
  check('Z returns to fit', (await view()).zoom === 'fit')

  // crop mode: R opens, Esc cancels without touching the doc
  const docBefore = JSON.stringify(await doc())
  await page.keyboard.press('r')
  await page.waitForSelector('.crop-svg')
  check('R opens crop mode', (await view()).cropMode === true)
  check('right panel dimmed', await page.locator('.develop.is-cropping').count() === 1)
  const se = await page.locator('.crop-handle-hit[data-h="se"]').boundingBox()
  const dragBy = async (box, dx, dy) => {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 6 })
    await page.mouse.up()
  }
  await dragBy(se, -200, -60)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(120)
  check('Esc leaves crop mode', (await view()).cropMode === false)
  check('Esc restores prior doc', JSON.stringify(await doc()) === docBefore)

  // R again → resize → Enter commits ONE history entry
  await page.keyboard.press('r')
  await page.waitForSelector('.crop-svg')
  const se2 = await page.locator('.crop-handle-hit[data-h="se"]').boundingBox()
  await dragBy(se2, -200, -60)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(200)
  const committed = await doc()
  const g = committed.modules.geometry
  check('Enter commits geometry', !!g && g.crop.w < 0.95 && g.crop.h < 0.95,
    g ? `crop ${g.crop.w.toFixed(3)}×${g.crop.h.toFixed(3)}` : 'missing')
  // canvas re-fits to the crop aspect
  const ar = await page.evaluate(() => {
    const c = document.querySelector('.develop-canvas')
    return parseFloat(c.style.width) / parseFloat(c.style.height)
  })
  const wantAr = (g.crop.w * 2400) / (g.crop.h * 1600)
  check('canvas aspect follows crop', Math.abs(ar - wantAr) / wantAr < 0.02, `${ar.toFixed(3)} vs ${wantAr.toFixed(3)}`)
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(200)
  check('one undo restores pre-crop', (await doc()).modules.geometry === undefined)

  // straighten: ⌘/ctrl-drag sets the angle so the line goes horizontal
  await page.keyboard.press('r')
  await page.waitForSelector('.crop-svg')
  const svg = await page.locator('.crop-svg').boundingBox()
  const cx = svg.x + svg.width / 2
  const cy = svg.y + svg.height / 2
  await page.keyboard.down('Control')
  await page.mouse.move(cx - 100, cy)
  await page.mouse.down()
  await page.mouse.move(cx + 100, cy + 30, { steps: 6 })
  await page.mouse.up()
  await page.keyboard.up('Control')
  const want = (Math.atan2(30, 200) * 180 / Math.PI).toFixed(1)
  const val = (await page.textContent('.crop-angle-val')).trim()
  check('straighten line sets angle', val === `${want}°`, `${val} want ${want}°`)
  // grid cycles thirds → golden → off
  await page.keyboard.press('o')
  check('O cycles grid to golden', (await view()).cropGrid === 'golden')
  await page.keyboard.press('o')
  await page.keyboard.press('o')
  check('O wraps back to thirds', (await view()).cropGrid === 'thirds')
  // ruler double-click zeroes
  await page.locator('.crop-ruler').dblclick()
  check('ruler dbl-click zeroes angle', (await page.textContent('.crop-angle-val')).trim() === '0.0°')

  // screenshot state: modest crop + a few degrees for the record
  const se3 = await page.locator('.crop-handle-hit[data-h="se"]').boundingBox()
  await dragBy(se3, -140, -50)
  const nw = await page.locator('.crop-handle-hit[data-h="nw"]').boundingBox()
  await dragBy(nw, 60, 40)
  const ruler = await page.locator('.crop-ruler').boundingBox()
  await dragBy(ruler, 40, 0) // +4°
  await page.waitForTimeout(150)
  await page.locator('.canvas-mat').screenshot({ path: `${scratch}/geometry-crop.png` })
  await page.keyboard.press('Escape')

  check('app: no console errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  await browser.close()
}

if (vite) vite.kill()
console.log(failed ? `${failed} FAILURES` : 'ALL PASS')
process.exit(failed ? 1 : 0)
