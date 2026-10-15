// Develop UI e2e: panel restructure, TONE scrubs, curve editor, mixer,
// clip toggle (J), before/after (\), section collapse persistence.
// Spawns its own dev server on 5184. Scopes are mocked through the render
// worker's message event until the engine lands SCOPES emission.
import { chromium } from 'playwright'
import { execSync, spawn } from 'node:child_process'
import { mkdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawnVite } from './server.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const fx = `${root}test/fixtures`
const shots = process.env.SHOT_DIR ?? fx
mkdirSync(fx, { recursive: true })
mkdirSync(shots, { recursive: true })

const file = `${fx}/dev-gradient.jpg`
if (!existsSync(file))
  execSync(`magick -size 900x600 gradient:'hsl(210,40%,12%)'-'hsl(35,55%,72%)' ${file}`)

const srv = spawnVite('5184', { cwd: root, stdio: 'ignore' })
const up = async () => {
  for (let i = 0; i < 100; i++) {
    try { await fetch('http://localhost:5184/'); return } catch { await new Promise((r) => setTimeout(r, 200)) }
  }
  throw new Error('dev server never came up on 5184')
}

let failed = 0
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) failed++ }
const doc = (page) => page.evaluate(() => window.__albedo.edit().doc)

// drag from the middle of an element by dx
async function scrub(page, locator, dx) {
  const box = await locator.boundingBox()
  const x = box.x + box.width / 2, y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx, y, { steps: 4 })
  await page.mouse.up()
}

try {
  await up()
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader'],
  })
  const ctx = await browser.newContext({ colorScheme: 'dark', viewport: { width: 1440, height: 900 } })
  // harness-side scopes mock: keep a handle on the render worker so tests can
  // synthesize SCOPES messages through its normal event path
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

  await page.goto('http://localhost:5184/')
  await page.waitForSelector('text=Drop photos here')
  await page.setInputFiles('input[type=file]', [file])
  await page.waitForFunction(() => document.querySelectorAll('.gcell').length === 1, null, { timeout: 30000 })
  await page.keyboard.press('d')
  await page.waitForFunction(
    () => parseInt(document.querySelector('.develop-canvas')?.style.width || 0) > 20,
    null, { timeout: 15000 })

  // ── TONE: six sliders, scrub-commit each ─────────────────────────────────
  const tone = page.locator('.sec[data-sec=tone] .slider')
  check('six TONE sliders present', await tone.count() === 6)
  const toneKeys = [['exposure', 'ev'], ['tone', 'contrast'], ['tone', 'highlights'],
    ['tone', 'shadows'], ['tone', 'whites'], ['tone', 'blacks']]
  for (let i = 0; i < 6; i++) {
    await scrub(page, tone.nth(i), 60)
    const [m, k] = toneKeys[i]
    const d = await doc(page)
    check(`scrub ${m}.${k} commits`, (d.modules[m]?.[k] ?? 0) > 0)
  }

  // ── CURVE: click adds a point that persists in the doc ───────────────────
  const curve = page.locator('.curve-canvas')
  await curve.scrollIntoViewIfNeeded()
  const cb = await curve.boundingBox()
  await page.mouse.click(cb.x + cb.width * 0.5, cb.y + cb.height * 0.35)
  let d = await doc(page)
  const pts = d.modules.curve?.points
  check('curve click adds point (persists in doc)', pts?.length === 3 && pts[1][0] > 0 && pts[1][0] < 1)

  // ── MIXER: tab switch + red-band drag commits colormix ───────────────────
  await page.click('.mix-seg .seg-btn >> nth=1') // S
  check('mixer S tab selected', await page.locator('.mix-seg .seg-btn >> nth=1')
    .evaluate((el) => el.getAttribute('aria-selected') === 'true'))
  await scrub(page, page.locator('.mix-red .slider'), 55)
  d = await doc(page)
  check('red-band S drag commits colormix', (d.modules.colormix?.red?.s ?? 0) > 0)
  check('red-band H untouched', (d.modules.colormix?.red?.h ?? 0) === 0)

  // ── J toggles the persistent clip overlay ────────────────────────────────
  await page.keyboard.press('j')
  check('J lights clip toggles', await page.locator('.clip-toggle.is-on').count() === 2)
  await page.keyboard.press('j')
  check('J clears clip toggles', await page.locator('.clip-toggle.is-on').count() === 0)

  // ── \ shows the BEFORE tag ───────────────────────────────────────────────
  await page.keyboard.press('\\')
  check('\\ shows BEFORE tag', await page.locator('.before-tag').count() === 1)
  await page.keyboard.press('\\')
  check('\\ hides BEFORE tag', await page.locator('.before-tag').count() === 0)

  // ── mock scopes delivery: histogram lights the clip indicator ────────────
  await page.evaluate(() => {
    const hist = new Uint32Array(1024)
    for (let i = 0; i < 256; i++) {
      const g = Math.exp(-((i - 96) ** 2) / 4200) + 0.55 * Math.exp(-((i - 205) ** 2) / 900)
      hist[i] = (g * 5200) | 0
      hist[256 + i] = (g * 4400 * (0.7 + i / 512)) | 0
      hist[512 + i] = (g * 3800 * (1.15 - i / 640)) | 0
      hist[768 + i] = (g * 4800) | 0
    }
    hist[255] = 2600
    window.__renderWorker.dispatchEvent(new MessageEvent('message', {
      data: { type: 'scopes', photoId: 1, hist, clipShadows: 0, clipHighlights: 0.02 },
    }))
  })
  await page.waitForSelector('.clip-hl.is-lit')
  check('scopes delivery lights highlight clip indicator', true)
  check('shadow indicator stays unlit', await page.locator('.clip-sh.is-lit').count() === 0)

  // ── sections collapse + persist across reload ────────────────────────────
  await page.click('.sec[data-sec=tone] .sec-head')
  check('TONE collapses', await page.locator('.sec[data-sec=tone].is-open').count() === 0)
  check('TONE body hidden', await page.locator('.sec[data-sec=tone] .sec-body')
    .evaluate((el) => el.hidden))
  await page.reload()
  // develop stays mounted but hidden behind Library after reload
  await page.waitForSelector('.sec[data-sec=tone]', { state: 'attached' })
  check('TONE stays collapsed after reload', await page.locator('.sec[data-sec=tone].is-open').count() === 0)

  // back into develop, then re-expand
  await page.waitForFunction(() => document.querySelectorAll('.gcell').length === 1, null, { timeout: 30000 })
  await page.keyboard.press('d')
  await page.waitForFunction(
    () => parseInt(document.querySelector('.develop-canvas')?.style.width || 0) > 20,
    null, { timeout: 15000 })
  await page.click('.sec[data-sec=tone] .sec-head')
  check('TONE re-expands', await page.locator('.sec[data-sec=tone].is-open').count() === 1)

  // ── final surface capture on the webgl2 parity backend ───────────────────
  // swiftshader's webgpu path presents a blank display frame headlessly
  // (scopes still flow); the UI is backend-agnostic, webgl2 keeps it honest.
  const ctx2 = await browser.newContext({ colorScheme: 'dark', viewport: { width: 1440, height: 900 } })
  const page2 = await ctx2.newPage()
  await page2.goto('http://localhost:5184/?backend=webgl2')
  await page2.waitForSelector('text=Drop photos here')
  await page2.setInputFiles('input[type=file]', [file])
  await page2.waitForFunction(() => document.querySelectorAll('.gcell').length === 1, null, { timeout: 30000 })
  await page2.keyboard.press('d')
  await page2.waitForFunction(
    () => parseInt(document.querySelector('.develop-canvas')?.style.width || 0) > 20,
    null, { timeout: 15000 })
  // gentle, visible edits so modified state reads in the capture
  await scrub(page2, page2.locator('.sec[data-sec=tone] .slider').first(), 12)
  const cv = await page2.locator('.curve-canvas').boundingBox()
  await page2.mouse.click(cv.x + cv.width * 0.45, cv.y + cv.height * 0.42)
  await page2.waitForTimeout(400) // let scopes land
  await page2.screenshot({ path: `${shots}/develop-final.png` })
  await page2.locator('.panel-right').evaluate((el) => el.scrollTo(0, el.scrollHeight))
  await page2.waitForTimeout(150)
  await page2.locator('.panel-right').screenshot({ path: `${shots}/develop-panel-mixer.png` })
  await ctx2.close()

  check('no console errors', errors.length === 0)
  if (errors.length) console.log(errors.join('\n'))
  await browser.close()
} finally {
  srv.kill()
}
process.exit(failed ? 1 : 0)
