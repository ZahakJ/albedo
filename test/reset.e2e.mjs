// Reset to original: the escape hatch from a non-destructive edit that
// persists across reloads. Whole-photo reset, per-section reset, and the
// guarantee that both are a single ⌘Z away.
import { chromium } from 'playwright'
import { ensureServer } from './server.mjs'
import { execSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 5193
await ensureServer(PORT)
const dir = mkdtempSync(join(tmpdir(), 'albedo-reset-'))
const card = join(dir, 'card.png')
execSync(`magick -size 600x400 gradient:'rgb(30,60,120)'-'rgb(220,180,120)' ${card}`)

let fails = 0
const check = (name, ok, info = '') => {
  if (!ok) fails++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ` — ${info}` : ''}`)
}

const browser = await chromium.launch({ args: ['--no-sandbox', '--use-angle=swiftshader'] })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)) })

await page.goto(`http://localhost:${PORT}/?backend=webgl2`)
await page.waitForSelector('text=Drop photos here')
await page.setInputFiles('input[type=file]', [card])
await page.waitForSelector('.gcell', { timeout: 30000 })
await page.keyboard.press('Enter')
await page.waitForFunction(
  () => parseInt(document.querySelector('.develop-canvas')?.style.width || 0) > 20,
  null, { timeout: 20000 })

const doc = () => page.evaluate(() => window.__albedo.edit().doc)
const drag = async (sec, frac) => {
  const s = page.locator(`.sec[data-sec="${sec}"] .slider`).first()
  await s.scrollIntoViewIfNeeded() // COLOR sits below the panel's fold
  const b = await s.boundingBox()
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
  await page.mouse.down()
  await page.mouse.move(b.x + b.width * frac, b.y + b.height / 2, { steps: 5 })
  await page.mouse.up()
  await page.waitForTimeout(120)
}

// ── edits in two different sections ────────────────────────────────────────
await drag('tone', 0.8)
await drag('color', 0.2)
let d = await doc()
check('two sections carry edits', !!d.modules.exposure && !!d.modules.vibsat,
  JSON.stringify(Object.keys(d.modules)))

// ── per-section reset clears only its own modules ──────────────────────────
check('dirty section shows a reset button',
  await page.locator('.sec[data-sec="tone"] .reset-btn').count() === 1)
check('clean section hides its reset button',
  await page.locator('.sec[data-sec="curve"] .reset-btn').count() === 0)
await page.locator('.sec[data-sec="tone"] .reset-btn').click()
await page.waitForTimeout(150)
d = await doc()
check('section reset drops only that section', !d.modules.exposure && !!d.modules.vibsat,
  JSON.stringify(Object.keys(d.modules)))
await page.keyboard.press('Control+z')
await page.waitForTimeout(150)
d = await doc()
check('one ⌘Z restores the section', !!d.modules.exposure)

// ── whole-photo reset ──────────────────────────────────────────────────────
await page.click('.btn-reset')
await page.waitForTimeout(200)
d = await doc()
check('reset clears every module', Object.keys(d.modules).length === 0,
  JSON.stringify(Object.keys(d.modules)))
check('reset announces itself', await page.locator('.toast', { hasText: 'Reset to original' }).count() >= 1)
check('reset button disables when clean', await page.locator('.btn-reset').isDisabled())
await page.keyboard.press('Control+z')
await page.waitForTimeout(200)
d = await doc()
check('one ⌘Z brings the whole edit back',
  !!d.modules.exposure && !!d.modules.vibsat, JSON.stringify(Object.keys(d.modules)))

// ── ⇧⌘R and persistence: the reset must survive a reload ───────────────────
await page.keyboard.press('Control+Shift+r')
await page.waitForTimeout(250)
d = await doc()
check('⇧⌘R resets', Object.keys(d.modules).length === 0)
await page.waitForTimeout(700) // sidecar write-behind
await page.reload()
await page.waitForSelector('.gcell', { timeout: 30000 })
await page.keyboard.press('Enter')
await page.waitForFunction(
  () => parseInt(document.querySelector('.develop-canvas')?.style.width || 0) > 20,
  null, { timeout: 20000 })
d = await doc()
check('the reset persisted across reload', Object.keys(d.modules ?? {}).length === 0,
  JSON.stringify(Object.keys(d.modules ?? {})))

check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '))
await browser.close()
console.log(fails ? `${fails} FAILURES` : 'ALL PASS')
process.exit(fails ? 1 : 0)
