// Lightroom-parity wave e2e: heal/clone spots, range masks, lens corrections
// (distortion/CA/defringe), perspective keystone, highlight reconstruction
// and the split before/after view. Part A drives the render worker directly
// (tone harness) on BOTH backends with a parity diff over every frame; Part
// B (recon) opens the DNG fixture through the real decode chain; Part C
// drives the app UI on webgl2 (H heal gesture + history, range-mask UI, Y
// split view + export-unaffected) with screenshots.
// Starts its own vite on 5189 unless one is already listening.
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { execSync, spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { spawnVite } from './server.mjs'

const PORT = process.env.PORT ?? 5189
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
  const spot = (mode, dx, dy, sx, sy, r) => ({ id: `s${++uid}`, mode, dx, dy, sx, sy, r, feather: 0.4 })
  const F = {}

  // linear sRGB triplet → OKLCh {h, C} — twin of the shader's range color
  const cbrtS = (x) => Math.sign(x) * Math.abs(x) ** (1 / 3)
  const s2l = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const oklch = (r8, g8, b8) => {
    const [r, g, b] = [r8, g8, b8].map((v) => s2l(v / 255))
    const l = cbrtS(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
    const m = cbrtS(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
    const s = cbrtS(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
    const Aa = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s
    const Bb = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
    let h = (Math.atan2(Bb, Aa) * 180) / Math.PI
    if (h < 0) h += 360
    return { h, C: Math.hypot(Aa, Bb) }
  }

  // heal card: gray 150 bg, black blemish at (0.3,0.5), darker source region
  // around (0.7,0.75), blue clone marker at (0.7,0.25)
  await open('heal', 400, 300, (cx) => {
    cx.fillStyle = 'rgb(150,150,150)'
    cx.fillRect(0, 0, 400, 300)
    cx.fillStyle = 'rgb(120,120,120)'
    cx.fillRect(220, 165, 120, 120) // darker source region 0.55..0.85 × 0.55..0.95
    cx.fillStyle = 'rgb(40,80,200)'
    cx.fillRect(272, 67, 16, 16) // blue clone marker at (0.7, 0.25)
    cx.fillStyle = 'black'
    cx.beginPath()
    cx.arc(120, 150, 12, 0, Math.PI * 2) // blemish at (0.3, 0.5)
    cx.fill()
  })
  F.hBase = await shoot('heal', {}, [])
  F.hHeal = await shoot('heal', { heal: { spots: [spot('heal', 0.3, 0.5, 0.7, 0.75, 0.06)] } }, [])
  F.hClone = await shoot('heal', { heal: { spots: [spot('clone', 0.3, 0.5, 0.7, 0.25, 0.06)] } }, [])

  // range card: dark left / bright right halves; luma-restricted linear mask
  await open('range', 400, 200, (cx) => {
    cx.fillStyle = 'rgb(50,50,50)'
    cx.fillRect(0, 0, 200, 200)
    cx.fillStyle = 'rgb(210,210,210)'
    cx.fillRect(200, 0, 200, 200)
  })
  // near-whole-frame linear mask (weight 1 below y=0.03)
  const LIN = { x0: 0.5, y0: 0.02, x1: 0.5, y1: 0.03 }
  F.rBase = await shoot('range', {}, [])
  F.rLuma = await shoot('range', {}, [mask('linear', LIN, { ev: -2 }, {
    range: { luma: { lo: 0.55, hi: 1, softness: 0.2 }, color: null },
  })])

  // color-range card: red left / blue right; mask restricted to the red hue
  await open('crange', 400, 200, (cx) => {
    cx.fillStyle = 'rgb(200,40,40)'
    cx.fillRect(0, 0, 200, 200)
    cx.fillStyle = 'rgb(40,60,200)'
    cx.fillRect(200, 0, 200, 200)
  })
  const red = oklch(200, 40, 40)
  F.cBase = await shoot('crange', {}, [])
  F.cColor = await shoot('crange', {}, [mask('linear', LIN, { ev: -2 }, {
    range: { luma: null, color: { h: red.h, s: red.C, tol: 50 } },
  })])

  // lens card: gray bg, colored corner squares + vertical stripes for CA
  await open('lens', 400, 300, (cx) => {
    cx.fillStyle = 'rgb(120,120,120)'
    cx.fillRect(0, 0, 400, 300)
    cx.fillStyle = 'rgb(255,255,255)'
    cx.fillRect(0, 0, 400, 300)
    for (let x = 0; x < 400; x += 32) {
      cx.fillStyle = 'black'
      cx.fillRect(x, 0, 8, 300)
    }
    cx.fillStyle = 'rgb(220,180,60)'
    for (const [x, y] of [[0, 0], [376, 0], [0, 276], [376, 276]]) cx.fillRect(x, y, 24, 24)
  })
  F.lBase = await shoot('lens', {}, [])
  F.lDistP = await shoot('lens', { lens: { distortion: 80, caRed: 0, caBlue: 0, defringe: 0 } }, [])
  F.lDistN = await shoot('lens', { lens: { distortion: -80, caRed: 0, caBlue: 0, defringe: 0 } }, [])
  F.lCA = await shoot('lens', { lens: { distortion: 0, caRed: 100, caBlue: -100, defringe: 0 } }, [])

  // persp card: white bg, centered black rect — v=50 must converge verticals
  await open('persp', 400, 300, (cx) => {
    cx.fillStyle = 'white'
    cx.fillRect(0, 0, 400, 300)
    cx.fillStyle = 'black'
    cx.fillRect(120, 60, 160, 180) // 0.3..0.7 × 0.2..0.8
  })
  F.pBase = await shoot('persp', {}, [])
  F.pV50 = await shoot('persp', {
    geometry: { crop: { x: 0, y: 0, w: 1, h: 1 }, angle: 0, flipH: 0, persp: { v: 50, h: 0 } },
  }, [])

  return { backend: info.backend, frames: F, red }
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
// mean |Δ| between two frames over an rgb region
const regionDiff = (a, b, w, x0, x1, y0, y1) => {
  let s = 0
  let n = 0
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * w + x) * 4
    s += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])
    n += 3
  }
  return s / n
}
// mean |r−b| over a region (CA fringe metric)
const fringe = (b, w, x0, x1, y0, y1) => {
  let s = 0
  let n = 0
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * w + x) * 4
    s += Math.abs(b[i] - b[i + 2])
    n++
  }
  return s / n
}
// width of the black run in a row (px < 100)
const blackRun = (b, w, y) => {
  let run = 0
  for (let x = 0; x < w; x++) if (px(b, w, x, y) < 100) run++
  return run
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

  // heal: blemish center (120,150) was black, converges toward surround 150
  const blemBase = stat(B.hBase, 400, 112, 128, 142, 158)
  const blemHeal = stat(B.hHeal, 400, 112, 128, 142, 158)
  check(`${backend}: heal removes the blemish (dest → surround mean)`,
    blemBase < 40 && Math.abs(blemHeal - 150) <= 12, `${blemBase.toFixed(1)} → ${blemHeal.toFixed(1)}`)
  // heal (not clone): the darker source region is level-matched up to ~150
  check(`${backend}: heal matches the local level (not a raw 120 paste)`,
    blemHeal >= 138, `${blemHeal.toFixed(1)}`)
  // far pixel untouched
  const farMove = Math.abs(px(B.hHeal, 400, 40, 30) - px(B.hBase, 400, 40, 30))
  check(`${backend}: heal leaves the rest of the frame (<2/255)`, farMove < 2, `Δ${farMove}`)
  // clone: dest center copies the blue marker exactly
  const cloneRGB = [0, 1, 2].map((c) => px(B.hClone, 400, 120, 150, c))
  const markRGB = [0, 1, 2].map((c) => px(B.hBase, 400, 280, 75, c))
  const cloneErr = Math.max(...cloneRGB.map((v, i) => Math.abs(v - markRGB[i])))
  check(`${backend}: clone copies the source patch exactly (≤2/255)`, cloneErr <= 2,
    `dest ${cloneRGB} vs src ${markRGB}`)

  // range mask (luma): bright right darkens ≥1 stop, dark left untouched
  const rDown = stopsDown(px(B.rBase, 400, 300, 100), px(B.rLuma, 400, 300, 100))
  check(`${backend}: luma range darkens in-range luma ≥1 stop`, rDown >= 1, `${rDown.toFixed(2)} stops`)
  const rLeft = Math.abs(px(B.rLuma, 400, 100, 100) - px(B.rBase, 400, 100, 100))
  check(`${backend}: luma range leaves out-of-range luma (<2/255)`, rLeft < 2, `Δ${rLeft}`)

  // range mask (color): red side darkens, blue side untouched
  const cDown = stopsDown(px(B.cBase, 400, 100, 100), px(B.cColor, 400, 100, 100))
  check(`${backend}: color range darkens the sampled hue ≥1 stop`, cDown >= 1, `${cDown.toFixed(2)} stops`)
  const cBlue = Math.abs(px(B.cColor, 400, 300, 100, 2) - px(B.cBase, 400, 300, 100, 2))
  check(`${backend}: color range leaves other hues (<2/255)`, cBlue < 2, `Δ${cBlue}`)

  // distortion ±80: corner regions move measurably, nothing goes black
  const dP = regionDiff(B.lBase, B.lDistP, 400, 2, 40, 2, 30)
  const dN = regionDiff(B.lBase, B.lDistN, 400, 2, 40, 2, 30)
  check(`${backend}: distortion +80 moves corners`, dP >= 8, `Δ${dP.toFixed(1)}`)
  check(`${backend}: distortion -80 moves corners`, dN >= 8, `Δ${dN.toFixed(1)}`)
  // distortion changes the output dims (auto-fit crops in) — probe the real frame
  const dW = F.lDistP.w
  const dH = F.lDistP.h
  const cornMin = Math.min(...[[3, 3], [dW - 4, 3], [3, dH - 4], [dW - 4, dH - 4]].map(([x, y]) =>
    Math.max(...[0, 1, 2].map((c) => px(B.lDistP, dW, x, y, c)))))
  check(`${backend}: distortion +80 shows no black corners (auto-fit)`, cornMin > 30, `min ${cornMin}`)

  // CA: r/b fringes appear at corners, none at the center
  const caCorner = fringe(B.lCA, 400, 4, 80, 4, 60)
  const baseCorner = fringe(B.lBase, 400, 4, 80, 4, 60)
  const caCenter = fringe(B.lCA, 400, 170, 230, 130, 170)
  check(`${backend}: CA shifts channels at corners`, caCorner >= baseCorner + 2,
    `${baseCorner.toFixed(2)} → ${caCorner.toFixed(2)}`)
  check(`${backend}: CA leaves the center (<2)`, caCenter < 2, `${caCenter.toFixed(2)}`)

  // persp v=50: the rect's top width < bottom width; corners stay white
  const H = F.pV50.h
  const W = F.pV50.w
  let topRow = -1
  let botRow = -1
  for (let y = 0; y < H; y++) if (blackRun(B.pV50, W, y) > 20) { topRow = y; break }
  for (let y = H - 1; y >= 0; y--) if (blackRun(B.pV50, W, y) > 20) { botRow = y; break }
  const topW = blackRun(B.pV50, W, topRow + 12)
  const botW = blackRun(B.pV50, W, botRow - 12)
  check(`${backend}: persp v=50 converges verticals (top < bottom)`, topW < botW - 6,
    `top ${topW} vs bottom ${botW}`)
  const pCorn = Math.min(px(B.pV50, W, 3, 3), px(B.pV50, W, W - 4, 3),
    px(B.pV50, W, 3, H - 4), px(B.pV50, W, W - 4, H - 4))
  check(`${backend}: persp shows no black corners (auto-fit)`, pCorn > 200, `min ${pCorn}`)

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

// ── Part B: highlight reconstruction, both backends ────────────────────────
// A synthetic RGGB mosaic, not a fixture: real files only contain blown
// highlights by luck, and recon must be proven on pixels that ARE clipped.
// Top half = a neutral surface brightening into clipping (2 stops over the
// ceiling at the top edge, under it at the seam): green clips first, red and
// blue keep climbing — the magenta-highlight case; bottom half = neutral
// mid, the control.
const inPageRecon = async ({ backend }) => {
  const rc = await import('/src/state/renderClient.js')
  const W = 256
  const H = 256
  const WHITE = 4095
  const MUL = [1.9, 1, 1.5]
  const mosaic = new Uint16Array(W * H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = y % 2 === 0 && x % 2 === 0 ? 0 : y % 2 === 1 && x % 2 === 1 ? 2 : 1
      // white-balanced intensity: 2.0 at the top, 0.5 at the seam
      const lum = y < H / 2 ? 2.0 - 1.5 * (y / (H / 2)) : 0.4
      mosaic[y * W + x] = Math.round(Math.min(WHITE, (WHITE * lum) / MUL[c]))
    }
  }
  const payload = {
    photoId: 'p1', kind: 'mosaic', width: W, height: H, bitDepth: 16, linear: true,
    buffer: mosaic, black: 0, white: WHITE,
    camMul: MUL, // a typical daylight WB: what turns clipping magenta
    camToSrgb: Float32Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1),
    cfa: [0, 0], flip: 0, exif: {},
  }
  const info = await rc.initRender(document.getElementById('view'), backend)
  const doc = (modules) => ({ schema: 1, photoId: 'p1', versionId: 'v', modules, masks: [] })
  await rc.openPhoto('p1', payload, doc({}))
  const b64 = (u8) => {
    let s = ''
    for (let i = 0; i < u8.length; i += 32768) s += String.fromCharCode.apply(null, u8.subarray(i, i + 32768))
    return btoa(s)
  }
  const shoot = async (modules) => {
    const { blob } = await rc.exportPhoto('p1', doc(modules), { type: 'image/png' })
    const bm = await createImageBitmap(blob)
    const c2 = new OffscreenCanvas(bm.width, bm.height)
    const g = c2.getContext('2d', { willReadFrequently: true })
    g.drawImage(bm, 0, 0)
    return { w: bm.width, h: bm.height, b64: b64(new Uint8Array(g.getImageData(0, 0, bm.width, bm.height).data.buffer)) }
  }
  // -1 EV keeps the WB-boosted channels under the display ceiling, so the
  // magenta cast survives the clamp and stays measurable in the export
  // linear look: AgX would desaturate the cast it is meant to measure
  const look = { profile: 'linear', baseline: 0, saturation: 100 }
  const off = await shoot({ recon: { on: 0 }, exposure: { ev: -1 }, look })
  const on = await shoot({ exposure: { ev: -1 }, look }) // recon default ON
  return { backend: info.backend, off, on }
}

for (const backend of ['webgl2', 'webgpu']) {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader'] })
  const page = await browser.newPage()
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(`http://localhost:${PORT}/test/tone.html`)
  const r = await page.evaluate(inPageRecon, { backend })
  await browser.close()
  const off = buf(r.off)
  const on = buf(r.on)
  // regions, not thresholds: the synthetic frame's top half is the blown
  // half and the bottom half is the control. Rows near the seam are skipped —
  // demosaic interpolates across it.
  const { w, h } = r.off
  const stats = (px, y0, y1) => {
    let spread = 0
    let n = 0
    for (let y = Math.round(h * y0); y < Math.round(h * y1); y++) {
      for (let x = 4; x < w - 4; x += 2) {
        const i = (y * w + x) * 4
        spread += Math.max(px[i], px[i + 1], px[i + 2]) - Math.min(px[i], px[i + 1], px[i + 2])
        n++
      }
    }
    return spread / n
  }
  const blownOff = stats(off, 0.10, 0.40)
  const blownOn = stats(on, 0.10, 0.40)
  const ctrlOff = stats(off, 0.60, 0.90)
  const ctrlOn = stats(on, 0.60, 0.90)
  check(`${backend}: unreconstructed blown half is magenta (channels split)`,
    blownOff >= 15, `spread ${blownOff.toFixed(1)}`)
  check(`${backend}: recon neutralizes the blown half (r≈g≈b)`,
    blownOn <= blownOff - 10, `spread ${blownOff.toFixed(1)} → ${blownOn.toFixed(1)}`)
  check(`${backend}: recon leaves unclipped pixels alone`,
    Math.abs(ctrlOn - ctrlOff) <= 1, `control ${ctrlOff.toFixed(2)} → ${ctrlOn.toFixed(2)}`)
  check(`${backend}: recon harness no console errors`, errors.length === 0, errors.slice(0, 3).join(' | '))
  if (backend === 'webgl2') globalThis.__reconGl = r
  else {
    // backend parity on the recon-ON frame
    const pa = buf(globalThis.__reconGl.on)
    const pb = on
    let sum = 0
    let n = 0
    for (let i = 0; i < Math.min(pa.length, pb.length); i += 4) {
      sum += Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2])
      n += 3
    }
    check('parity recon-on ≤2/255', sum / n <= 2, `mean diff ${(sum / n).toFixed(3)}`)
  }
}

// ── Part C: app UI — heal gesture, range UI, split view (webgl2) ───────────
const card = `${scratch}/parity-card.png`
execSync(`magick -size 1000x700 xc:'rgb(150,150,150)' -fill 'rgb(40,40,40)' -draw 'circle 300,350 300,338' ${card}`)

const probe = (png, fx, fy) => execSync(
  `magick ${png} -format "%[fx:int(255*p{int(w*${fx}),int(h*${fy})}.r)] %[fx:int(255*p{int(w*${fx}),int(h*${fy})}.g)] %[fx:int(255*p{int(w*${fx}),int(h*${fy})}.b)]" info:`
).toString().trim().split(' ').map(Number)

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

  // H opens heal mode (capture listener in HealOverlay, never App.jsx)
  await page.keyboard.press('h')
  await page.waitForSelector('.heal-overlay')
  check('H opens heal mode (overlay mounts)', true)

  // drag: dest over the dark blemish (0.3, 0.5) → source on clean gray
  const cv = await page.locator('.develop-canvas').boundingBox()
  await page.mouse.move(cv.x + cv.width * 0.3, cv.y + cv.height * 0.5)
  await page.mouse.down()
  await page.mouse.move(cv.x + cv.width * 0.7, cv.y + cv.height * 0.3, { steps: 6 })
  await page.mouse.up()
  await page.waitForTimeout(150)
  let d = await doc()
  check('heal drag commits one spot', d.modules.heal?.spots?.length === 1,
    JSON.stringify(d.modules.heal?.spots?.[0] ?? null))
  const spotShot = `${scratch}/parity-heal.png`
  let healed = 0
  const healOk = await probeUntil(spotShot, () => {
    healed = probe(spotShot, 0.3, 0.5)[0]
    return healed > 120
  })
  check('heal spot erases the blemish on canvas', healOk, `dest ${healed}`)
  await page.screenshot({ path: `${scratch}/parity-heal.png` })

  // one history entry per spot op
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(100)
  d = await doc()
  check('undo removes the spot (one history entry)', !d.modules.heal?.spots?.length)
  await page.keyboard.press('Control+Shift+z')
  await page.waitForTimeout(100)
  d = await doc()
  check('redo restores the spot', d.modules.heal?.spots?.length === 1)

  // HEAL panel section lists the spot with a mode toggle
  check('HEAL panel lists the spot', await page.locator('.heal-row').count() === 1)
  await page.click('.heal-row .heal-mode')
  await page.waitForTimeout(100)
  d = await doc()
  check('panel mode toggle flips heal→clone', d.modules.heal.spots[0].mode === 'clone')

  // Esc exits heal mode
  await page.keyboard.press('Escape')
  await page.waitForTimeout(100)
  check('Esc exits heal mode', await page.locator('.heal-overlay').count() === 0)

  // ── range mask UI: radial mask + Range disclosure ────────────────────────
  await page.keyboard.press('m')
  await page.waitForSelector('.mask-panel')
  await page.keyboard.press('Shift+M')
  await page.mouse.move(cv.x + cv.width / 2, cv.y + cv.height / 2)
  await page.mouse.down()
  await page.mouse.move(cv.x + cv.width * 0.7, cv.y + cv.height * 0.7, { steps: 5 })
  await page.mouse.up()
  await page.waitForTimeout(150)
  await page.click('.range-head')
  await page.waitForSelector('.range-chip')
  await page.click('.range-chip') // Luminance on
  await page.waitForTimeout(120)
  d = await doc()
  check('range disclosure toggles mask.range.luma', !!d.masks[0]?.range?.luma,
    JSON.stringify(d.masks[0]?.range ?? null))
  check('dual-handle mini-slider renders', await page.locator('.range-dual').count() === 1)
  await page.screenshot({ path: `${scratch}/parity-range.png` })
  await page.keyboard.press('m') // exit mask mode
  await page.waitForTimeout(100)

  // ── split view: strong exposure edit, then Y ─────────────────────────────
  const evSlider = page.locator('.sec[data-sec="tone"] .slider').first()
  const eb = await evSlider.boundingBox()
  await page.mouse.move(eb.x + eb.width / 2, eb.y + eb.height / 2)
  await page.mouse.down()
  await page.mouse.move(eb.x + eb.width * 0.18, eb.y + eb.height / 2, { steps: 5 })
  await page.mouse.up()
  await page.waitForTimeout(150)
  d = await doc()
  check('exposure edit committed for the split compare', (d.modules.exposure?.ev ?? 0) < -1,
    `ev ${d.modules.exposure?.ev}`)

  await page.keyboard.press('y')
  await page.waitForSelector('.split-handle.split-h')
  check('Y shows the split divider handle', true)
  const splitShot = `${scratch}/parity-split.png`
  let bLeft = 0
  let bRight = 0
  const splitOk = await probeUntil(splitShot, () => {
    bLeft = probe(splitShot, 0.2, 0.25)[0]
    bRight = probe(splitShot, 0.8, 0.25)[0]
    return bLeft - bRight >= 20
  })
  check('split view: left half shows BEFORE (brighter)', splitOk, `before ${bLeft} vs after ${bRight}`)
  await page.screenshot({ path: `${scratch}/parity-split.png` })

  // export is unaffected by the split flag: both halves carry the edit
  const exp = await page.evaluate(async () => {
    // via the app's own module instances — a page-side import() can land on a
    // second copy of the store whose photo is null
    const st = window.__albedo.edit()
    const { blob } = await window.__albedo.exportPhoto(st.photo.id, st.doc, { type: 'image/png' })
    const bm = await createImageBitmap(blob)
    const c = new OffscreenCanvas(bm.width, bm.height)
    const g = c.getContext('2d', { willReadFrequently: true })
    g.drawImage(bm, 0, 0)
    const px = g.getImageData(0, 0, bm.width, bm.height).data
    const mean = (x0, x1) => {
      let s = 0
      let n = 0
      for (let y = 0; y < bm.height; y += 4) for (let x = x0; x < x1; x += 4) {
        s += px[(y * bm.width + x) * 4]; n++
      }
      return s / n
    }
    return { left: mean(0, Math.floor(bm.width * 0.4)), right: mean(Math.ceil(bm.width * 0.6), bm.width) }
  })
  check('export unaffected by split (halves match)', Math.abs(exp.left - exp.right) <= 3,
    `left ${exp.left.toFixed(1)} vs right ${exp.right.toFixed(1)}`)

  // ⇧Y switches to the vertical split, ⇧Y again turns it off
  await page.keyboard.press('Shift+Y')
  await page.waitForSelector('.split-handle.split-v')
  check('⇧Y switches to the vertical split', true)
  await page.keyboard.press('Shift+Y')
  await page.waitForTimeout(100)
  check('⇧Y again turns the split off', await page.locator('.split-handle').count() === 0)

  check('app: no console errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  await browser.close()
}

if (vite) vite.kill()
console.log(failed ? `${failed} FAILURES` : 'ALL PASS')
process.exit(failed ? 1 : 0)
