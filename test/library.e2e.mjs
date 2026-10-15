// Library surface e2e: import 8 JPEGs → grid → culling keys → filter chips →
// surface switching. Spawns its own dev server on 5183.
import { chromium } from 'playwright'
import { execSync, spawn } from 'node:child_process'
import { mkdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawnVite } from './server.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const fx = `${root}test/fixtures`
const shots = process.env.SHOT_DIR ?? `${root}test/fixtures`
mkdirSync(fx, { recursive: true })
mkdirSync(shots, { recursive: true })

const files = []
for (let i = 0; i < 8; i++) {
  const f = `${fx}/fx${i}.jpg`
  const [w, h] = i % 3 === 0 ? [420, 560] : [560, 400]
  if (!existsSync(f))
    execSync(
      `magick -size ${w}x${h} gradient:'hsl(${i * 45},45%,38%)'-'hsl(${(i * 45 + 60) % 360},50%,14%)' ` +
      `-font Adwaita-Sans-Bold -fill 'rgba(255,255,255,0.85)' -gravity center -pointsize 110 -annotate 0 '${i + 1}' ${f}`)
  files.push(f)
}

const srv = spawnVite('5183', { cwd: root, stdio: 'ignore' })
const up = async () => {
  for (let i = 0; i < 100; i++) {
    try { await fetch('http://localhost:5183/'); return } catch { await new Promise((r) => setTimeout(r, 200)) }
  }
  throw new Error('dev server never came up on 5183')
}

let failed = 0
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) failed++ }

try {
  await up()
  const browser = await chromium.launch({ args: ['--no-sandbox'] })
  const page = await (await browser.newContext({
    colorScheme: 'dark', viewport: { width: 1440, height: 900 },
  })).newPage()
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))

  await page.goto('http://localhost:5183/')
  await page.waitForSelector('text=Drop photos here')
  await page.setInputFiles('input[type=file]', files)

  await page.waitForFunction(() => document.querySelectorAll('.gcell').length === 8, null, { timeout: 30000 })
  check('grid shows 8 cells', true)
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.gthumb')].filter((i) => i.complete && i.naturalWidth > 0).length === 8)
  check('all 8 thumbs painted', true)

  // rate + pick the first cell
  await page.click('.gcell >> nth=0')
  await page.keyboard.press('3')
  await page.waitForSelector('.gcell >> nth=0 >> .gstars')
  check('press 3 → ★★★ badge', (await page.textContent('.gcell >> nth=0 >> .gstars')) === '★★★')
  await page.keyboard.press('p')
  await page.waitForSelector('.gcell >> nth=0 >> .gflag')
  check('press P → pick badge', true)

  // reject another
  await page.click('.gcell >> nth=1')
  await page.keyboard.press('x')
  await page.waitForSelector('.gcell.is-rejected .gtick')
  // wait out the 120ms opacity fade before reading the computed value
  await page.waitForFunction(() =>
    getComputedStyle(document.querySelector('.gcell.is-rejected .gthumb')).opacity === '0.3')
  check('press X → rejected dim + tick', true)

  // filter ★≥3 narrows to the one rated photo
  await page.click('.star-btn >> nth=2')
  await page.waitForFunction(() => document.querySelectorAll('.gcell').length === 1)
  check('★≥3 chip narrows to 1', true)
  await page.waitForTimeout(200) // let --t-fast/--t-med transitions settle before capture
  await page.screenshot({ path: `${shots}/library-filtered.png` })

  // ⌥\ clears
  await page.keyboard.press('Alt+\\')
  await page.waitForFunction(() => document.querySelectorAll('.gcell').length === 8)
  check('⌥\\ clears filter', true)

  // surface switching: D → develop, G → library. fit() writes the canvas CSS
  // width only after the photo actually opened — wait for that, not clientWidth.
  await page.keyboard.press('d')
  await page.waitForFunction(
    () => parseInt(document.querySelector('.develop-canvas')?.style.width || 0) > 20,
    null, { timeout: 15000 })
  check('D opens develop', await page.locator('.seg-btn', { hasText: 'Develop' })
    .evaluate((el) => el.getAttribute('aria-selected') === 'true'))
  await page.waitForTimeout(200)
  await page.screenshot({ path: `${shots}/develop.png` })
  await page.keyboard.press('g')
  await page.waitForFunction(() => {
    const cells = document.querySelectorAll('.gcell')
    return cells.length === 8 && cells[0].getBoundingClientRect().width > 100
  })
  check('G returns to library', await page.locator('.seg-btn', { hasText: 'Library' })
    .evaluate((el) => el.getAttribute('aria-selected') === 'true'))

  await page.waitForTimeout(200)
  await page.screenshot({ path: `${shots}/library.png` })

  // zoomed cell close-up at a bigger thumb stop
  await page.keyboard.press('+')
  await page.waitForTimeout(200)
  await page.locator('.gcell', { has: page.locator('.gstars') }).first()
    .screenshot({ path: `${shots}/cell-zoom.png` })
  await page.keyboard.press('-')

  check('no console errors', errors.length === 0)
  if (errors.length) console.log(errors.join('\n'))
  await browser.close()
} finally {
  srv.kill()
}
process.exit(failed ? 1 : 0)
