// Phase 3 tone/color pipeline e2e: flat test cards through the real develop
// math on BOTH backends. Exports are PNG (lossless) and read back in-page;
// scopes, before-flag, and clip overlay ride the same session. Starts its own
// vite on 5180 unless one is already listening.
import { chromium } from 'playwright'
import { spawn, execSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCurveLut } from '../src/engine/curve.js'
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

// card: six 64×64 patches. Top: dark 40, bright 220, pivot 118 (≈ linear
// 0.18 mid-gray). Bottom: red, blue, black — colormix bands + clip overlay.
const PATCHES = [[40, 40, 40], [220, 220, 220], [118, 118, 118], [255, 0, 0], [0, 0, 255], [0, 0, 0]]
const NAMES = ['dark', 'bright', 'pivot', 'red', 'blue', 'black']

// mirrors the shaders' curve lookup: 512-texel LUT, manual lerp
const lutAt = (lut, x) => {
  const t = Math.min(1, Math.max(0, x)) * 511
  const i = Math.floor(t)
  return lut[i] + (lut[Math.min(i + 1, 511)] - lut[i]) * (t - i)
}

const CURVE_PTS = [[0, 0], [0.5, 0.7], [1, 1]]

const inPage = async ({ backend, patches, curvePts }) => {
  const rc = await import('/src/state/renderClient.js')
  const info = await rc.initRender(document.getElementById('view'), backend)
  rc.setView(192, 128)
  const oc = new OffscreenCanvas(192, 128)
  const cx = oc.getContext('2d')
  patches.forEach((rgb, i) => {
    cx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`
    cx.fillRect((i % 3) * 64, i < 3 ? 0 : 64, 64, 64)
  })
  // via PNG blob, matching the app's file flow — a bitmap taken straight off
  // an accelerated OffscreenCanvas can arrive GPU-backed and upload black
  // into the worker's scratch GL context on SwiftShader
  const bmp = await createImageBitmap(await oc.convertToBlob({ type: 'image/png' }))
  const doc = (modules) => ({ schema: 1, photoId: 'p1', versionId: 'v', modules, masks: [] })
  const nextScopes = () => new Promise((res) => {
    const off = rc.onScopes((d) => { off(); res({ hi: d.clipHighlights, lo: d.clipShadows, hist: Array.from(d.hist) }) })
  })

  // gradient card first: zone selectivity over a continuous 0..255 ramp,
  // measured as per-quarter means of the export
  const goc = new OffscreenCanvas(256, 64)
  const gcx = goc.getContext('2d')
  for (let x = 0; x < 256; x++) { gcx.fillStyle = `rgb(${x},${x},${x})`; gcx.fillRect(x, 0, 1, 64) }
  const gbmp = await createImageBitmap(await goc.convertToBlob({ type: 'image/png' }))
  await rc.openPhoto('p2', gbmp, doc({}))
  const quarters = async (modules) => {
    const { blob } = await rc.exportPhoto('p2', doc(modules), { type: 'image/png' })
    const b = await createImageBitmap(blob)
    const c2 = new OffscreenCanvas(b.width, b.height)
    const g = c2.getContext('2d', { willReadFrequently: true })
    g.drawImage(b, 0, 0)
    const d = g.getImageData(0, 0, 256, 64).data
    const m = [0, 0, 0, 0]
    for (let y = 0; y < 64; y++) for (let x = 0; x < 256; x++) m[x >> 6] += d[(y * 256 + x) * 4]
    return m.map((v) => v / (64 * 64))
  }
  const grad = {
    base: await quarters({}),
    hl: await quarters({ tone: { highlights: -50 } }),
    sh: await quarters({ tone: { shadows: 50 } }),
  }

  let sc = nextScopes()
  await rc.openPhoto('p1', bmp, doc({}))
  const scOpen = await sc

  const shoot = async (modules) => {
    const { blob } = await rc.exportPhoto('p1', doc(modules), { type: 'image/png' })
    const b = await createImageBitmap(blob)
    const c2 = new OffscreenCanvas(b.width, b.height)
    const g = c2.getContext('2d', { willReadFrequently: true })
    g.drawImage(b, 0, 0)
    return [[32, 32], [96, 32], [160, 32], [32, 96], [96, 96], [160, 96]]
      .map(([x, y]) => Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3)))
  }

  const shots = {
    base: await shoot({}),
    cp: await shoot({ tone: { contrast: 50 } }),
    cn: await shoot({ tone: { contrast: -50 } }),
    hl: await shoot({ tone: { highlights: -100 } }),
    sh: await shoot({ tone: { shadows: 50 } }),
    curve: await shoot({ curve: { points: curvePts } }),
    mixRed: await shoot({ colormix: { red: { h: 0, s: -100, l: 0 } } }),
    mixBlue: await shoot({ colormix: { blue: { h: 0, s: -100, l: 0 } } }),
    mixBlueL: await shoot({ colormix: { blue: { h: 0, s: 0, l: 50 } } }),
  }

  // scopes on a blown render, then the before-flag view of the same doc
  sc = nextScopes()
  rc.sendParams('p1', doc({ exposure: { ev: 5 } }), false)
  const scBlown = await sc
  sc = nextScopes()
  rc.sendParams('p1', doc({ exposure: { ev: 5 } }), false, { before: true })
  const scBefore = await sc

  // leave the display showing the blown render with the clip overlay on;
  // the driver screenshots it (webgl2 only — SwiftShader can't composite a
  // worker-owned WebGPU canvas, same caveat as orient.e2e)
  rc.sendParams('p1', doc({ exposure: { ev: 5 } }), false, { clipOverlay: true })
  await new Promise((r) => setTimeout(r, 500))
  return { backend: info.backend, scOpen, scBlown, scBefore, shots, grad }
}

const lumaMean = (hist) => {
  let sum = 0
  let n = 0
  for (let i = 0; i < 256; i++) { sum += i * hist[768 + i]; n += hist[768 + i] }
  return sum / n
}

const dir = mkdtempSync(join(tmpdir(), 'albedo-tone-'))
const lut = buildCurveLut(CURVE_PTS)

const run = async (backend) => {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader'] })
  const page = await browser.newPage()
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(`http://localhost:${PORT}/test/tone.html`)
  const r = await page.evaluate(inPage, { backend, patches: PATCHES, curvePts: CURVE_PTS })

  const fails = []
  const check = (cond, label) => { if (!cond) fails.push(label) }
  check(r.backend === backend, `backend used ${r.backend}, wanted ${backend}`)

  const S = r.shots
  const v = (shot, patch) => S[shot][NAMES.indexOf(patch)][0] // gray patches: channel 0
  const near = (a, b, tol) => Math.abs(a - b) <= tol

  // contrast ±50: dark down/up, bright up/down, 0.18-linear pivot unmoved
  check(v('cp', 'dark') < v('base', 'dark') - 2, `contrast+50 dark ${v('cp', 'dark')} !< ${v('base', 'dark')} - 2`)
  check(v('cp', 'bright') > v('base', 'bright') + 2, `contrast+50 bright ${v('cp', 'bright')} !> ${v('base', 'bright')} + 2`)
  check(near(v('cp', 'pivot'), v('base', 'pivot'), 2), `contrast+50 pivot moved ${v('base', 'pivot')} → ${v('cp', 'pivot')}`)
  check(v('cn', 'dark') > v('base', 'dark') + 2, `contrast-50 dark ${v('cn', 'dark')} !> ${v('base', 'dark')} + 2`)
  check(v('cn', 'bright') < v('base', 'bright') - 2, `contrast-50 bright ${v('cn', 'bright')} !< ${v('base', 'bright')} - 2`)
  check(near(v('cn', 'pivot'), v('base', 'pivot'), 2), `contrast-50 pivot moved ${v('base', 'pivot')} → ${v('cn', 'pivot')}`)

  // highlights -100: bright patch drops ≥15%, dark patch essentially still
  check(v('hl', 'bright') <= v('base', 'bright') * 0.85, `highlights-100 bright ${v('base', 'bright')} → ${v('hl', 'bright')} (<15% drop)`)
  check(near(v('hl', 'dark'), v('base', 'dark'), 1), `highlights-100 dark moved ${v('base', 'dark')} → ${v('hl', 'dark')}`)

  // shadows +50 mirror: dark patch lifts ≥8%, bright patch essentially still
  check(v('sh', 'dark') >= v('base', 'dark') * 1.08, `shadows+50 dark ${v('base', 'dark')} → ${v('sh', 'dark')} (<8% lift)`)
  check(near(v('sh', 'bright'), v('base', 'bright'), 2), `shadows+50 bright moved ${v('base', 'bright')} → ${v('sh', 'bright')}`)

  // gradient ramp: zone gains hit their own quarter, not the opposite one
  const G = r.grad
  check(G.hl[3] <= G.base[3] * 0.92, `grad highlights-50 top quarter ${G.base[3].toFixed(1)} → ${G.hl[3].toFixed(1)}`)
  check(near(G.hl[0], G.base[0], 1.5), `grad highlights-50 moved bottom quarter ${G.base[0].toFixed(1)} → ${G.hl[0].toFixed(1)}`)
  check(G.sh[0] >= G.base[0] * 1.1, `grad shadows+50 bottom quarter ${G.base[0].toFixed(1)} → ${G.sh[0].toFixed(1)}`)
  check(near(G.sh[3], G.base[3], 1.5), `grad shadows+50 moved top quarter ${G.base[3].toFixed(1)} → ${G.sh[3].toFixed(1)}`)

  // curve [[0,0],[.5,.7],[1,1]]: every patch/channel must match the LUT
  // applied to the base export exactly (tolerance 2/255)
  for (let i = 0; i < 6; i++) {
    for (let ch = 0; ch < 3; ch++) {
      const want = 255 * lutAt(lut, S.base[i][ch] / 255)
      check(near(S.curve[i][ch], want, 2), `curve ${NAMES[i]}[${ch}] ${S.curve[i][ch]} != lut ${want.toFixed(1)}`)
    }
  }
  check(v('curve', 'pivot') > v('base', 'pivot') + 10, `curve failed to lift mids ${v('base', 'pivot')} → ${v('curve', 'pivot')}`)

  // colormix per-band: red s=-100 desaturates red, leaves blue + grays alone
  const spread = (p) => Math.max(...p) - Math.min(...p)
  check(spread(S.mixRed[3]) < spread(S.base[3]) * 0.7, `red s-100 spread ${spread(S.base[3])} → ${spread(S.mixRed[3])}`)
  check(S.mixRed[4].every((c, i) => near(c, S.base[4][i], 3)), `red s-100 moved blue ${S.base[4]} → ${S.mixRed[4]}`)
  check(near(v('mixRed', 'pivot'), v('base', 'pivot'), 2), `red s-100 moved gray pivot`)
  // blue s=-100 mirror
  check(spread(S.mixBlue[4]) < spread(S.base[4]) * 0.7, `blue s-100 spread ${spread(S.base[4])} → ${spread(S.mixBlue[4])}`)
  check(S.mixBlue[3].every((c, i) => near(c, S.base[3][i], 3)), `blue s-100 moved red ${S.base[3]} → ${S.mixBlue[3]}`)
  // blue l=+50 lightens blue, chroma-presence guard keeps grays fixed
  const mean = (p) => (p[0] + p[1] + p[2]) / 3
  check(mean(S.mixBlueL[4]) > mean(S.base[4]) + 3, `blue l+50 mean ${mean(S.base[4])} → ${mean(S.mixBlueL[4])}`)
  check(near(v('mixBlueL', 'pivot'), v('base', 'pivot'), 2), `blue l+50 moved gray pivot`)

  // scopes: full histogram coverage, blown render clips, before-flag = default
  const n = 192 * 128
  check(r.scOpen.hist.slice(768).reduce((a, b) => a + b, 0) === n, 'scopes luma bins != pixel count')
  // red (r=255) + blue (b=255) patches read as highlight-clipped even at
  // defaults: 2/6 area; red/blue/black all carry a ≤1 channel: 3/6
  check(near(r.scOpen.hi, 2 / 6, 0.03), `open clipHighlights ${r.scOpen.hi}`)
  check(near(r.scOpen.lo, 3 / 6, 0.03), `open clipShadows ${r.scOpen.lo}`)
  // ev+5 blows bright/pivot/red/blue (4/6 area); red/blue/black crush (3/6)
  check(r.scBlown.hi > 0.55 && r.scBlown.hi < 0.78, `blown clipHighlights ${r.scBlown.hi}`)
  check(r.scBlown.lo > 0.4 && r.scBlown.lo < 0.6, `blown clipShadows ${r.scBlown.lo}`)
  check(near(lumaMean(r.scBefore.hist), lumaMean(r.scOpen.hist), 1), `before-flag mean ${lumaMean(r.scBefore.hist).toFixed(1)} != default ${lumaMean(r.scOpen.hist).toFixed(1)}`)

  // clip overlay display check — webgl2 only (see comment in inPage)
  if (backend === 'webgl2') {
    const shot = join(dir, 'overlay.png')
    await page.locator('#view').screenshot({ path: shot })
    const probe = (x, y) => execSync(
      `magick ${shot} -format "%[fx:int(255*p{${x},${y}}.r)] %[fx:int(255*p{${x},${y}}.g)] %[fx:int(255*p{${x},${y}}.b)]" info:`
    ).toString().trim().split(' ').map(Number)
    const hl = probe(96, 32)  // blown bright patch → #ff3b30
    const sh = probe(160, 96) // black patch → #2f6fed
    check(hl.every((c, i) => near(c, [255, 59, 48][i], 2)), `overlay highlight ${hl} != #ff3b30`)
    check(sh.every((c, i) => near(c, [47, 111, 237][i], 2)), `overlay shadow ${sh} != #2f6fed`)
  }

  await browser.close()
  const pass = fails.length === 0
  console.log(`${backend}: ${pass ? 'PASS' : 'FAIL\n  ' + fails.join('\n  ')}${errors.length ? '\n  console: ' + errors.join(' | ') : ''}`)
  return pass
}

const a = await run('webgpu')
const b = await run('webgl2')
if (vite) vite.kill()
process.exit(a && b ? 0 : 1)
