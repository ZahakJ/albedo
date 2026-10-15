// Polish e2e: theme toggle (flip + persist), lights-out cycle (L/Esc), info
// overlay (I), tooltip delay, navigator pan-box (rect at 1:1, drag pans),
// reduced-motion collapses the motion tokens. Spawns vite on 5187.
import { chromium } from 'playwright'
import { execSync, spawn } from 'node:child_process'
import { mkdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawnVite } from './server.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const fx = `${root}test/fixtures`
mkdirSync(fx, { recursive: true })

const file = `${fx}/dev-gradient.jpg`
if (!existsSync(file))
  execSync(`magick -size 900x600 gradient:'hsl(210,40%,12%)'-'hsl(35,55%,72%)' ${file}`)

const srv = spawnVite('5187', { cwd: root, stdio: 'ignore' })
const up = async () => {
  for (let i = 0; i < 100; i++) {
    try { await fetch('http://localhost:5187/'); return } catch { await new Promise((r) => setTimeout(r, 200)) }
  }
  throw new Error('dev server never came up on 5187')
}

let failed = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` ${extra}`}`)
  if (!ok) failed++
}

try {
  await up()
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader'],
  })
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  const themeAttr = () => page.evaluate(() => document.documentElement.dataset.theme)
  const lights = () => page.evaluate(() => document.querySelector('.shell')?.dataset.lights ?? null)
  const view = () => page.evaluate(() => window.__albedo.view())

  await page.goto('http://localhost:5187/')
  await page.waitForSelector('text=Drop photos here')
  await page.setInputFiles('input[type=file]', [file])
  await page.waitForFunction(() => document.querySelectorAll('.gcell').length === 1, null, { timeout: 30000 })

  // ── theme toggle: flips html[data-theme], persists across reload ─────────
  check('boots dark', (await themeAttr()) === 'dark')
  await page.click('.theme-toggle')
  check('toggle flips to light', (await themeAttr()) === 'light')
  await page.reload()
  await page.waitForSelector('.theme-toggle')
  check('light persists across reload', (await themeAttr()) === 'light')
  await page.click('.theme-toggle')
  check('toggle returns to dark', (await themeAttr()) === 'dark')

  // ── tooltips: appear after the hover delay, with the shortcut hint ───────
  await page.waitForFunction(() => document.querySelectorAll('.gcell').length === 1, null, { timeout: 30000 })
  await page.hover('.theme-toggle')
  await page.waitForTimeout(150)
  check('tooltip not yet shown at 150ms', await page.locator('.tip.is-on').count() === 0)
  await page.waitForSelector('.tip.is-on', { timeout: 2000 })
  check('tooltip appears after delay', true)
  await page.hover('.surface-seg .seg-btn >> nth=0')
  await page.waitForFunction(
    () => document.querySelector('.tip.is-on .tip-key')?.textContent === 'G', null, { timeout: 2000 })
  check('tooltip carries the shortcut hint', true)
  await page.mouse.move(700, 500)
  await page.waitForFunction(() => !document.querySelector('.tip.is-on'), null, { timeout: 2000 })

  // ── lights-out: L cycles normal → dim → out → normal; Esc exits ──────────
  check('lights normal at boot', (await lights()) === null)
  await page.keyboard.press('l')
  check('L dims the chrome', (await lights()) === 'dim')
  await page.keyboard.press('l')
  check('L again goes black', (await lights()) === 'out')
  await page.keyboard.press('l')
  check('L again restores', (await lights()) === null)
  await page.keyboard.press('l')
  await page.keyboard.press('Escape')
  check('Esc exits lights-out', (await lights()) === null)

  // ── develop: info overlay + navigator pan-box ────────────────────────────
  await page.keyboard.press('d')
  await page.waitForFunction(
    () => parseInt(document.querySelector('.develop-canvas')?.style.width || 0) > 20,
    null, { timeout: 15000 })

  check('navigator block present', await page.locator('.navbox').count() === 1)
  await page.waitForSelector('.navbox-thumb', { timeout: 10000 })
  check('navigator shows the photo thumb', true)
  check('no viewport rect at fit', await page.locator('.navbox-rect').count() === 0)

  await page.keyboard.press('i')
  await page.waitForSelector('.info-card')
  check('I shows the info card', true)
  check('info card carries filename',
    (await page.textContent('.info-card .info-name')).includes('dev-gradient'))
  check('info card carries dims',
    (await page.textContent('.info-card .info-dims')).includes('900 × 600'))
  await page.keyboard.press('i') // level 2 (+EXIF when present)
  check('info level 2 keeps the card', await page.locator('.info-card').count() === 1)
  await page.keyboard.press('i')
  check('I cycles back off', await page.locator('.info-card').count() === 0)

  // zoom to 1:1 → rect appears; dragging it pans (writes viewStore pan)
  await page.keyboard.press('z')
  await page.waitForTimeout(300)
  check('Z zooms to 1:1', (await view()).zoom === 1)
  await page.waitForSelector('.navbox-rect', { timeout: 5000 })
  check('viewport rect appears at 1:1', true)
  const before = await view()
  const rb = await page.locator('.navbox-rect').boundingBox()
  await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2)
  await page.mouse.down()
  await page.mouse.move(rb.x + rb.width / 2 + 30, rb.y + rb.height / 2 + 14, { steps: 4 })
  await page.mouse.up()
  const after = await view()
  check('dragging the rect pans the loupe',
    after.panX !== before.panX || after.panY !== before.panY,
    `pan ${before.panX?.toFixed(3)},${before.panY?.toFixed(3)} → ${after.panX?.toFixed(3)},${after.panY?.toFixed(3)}`)
  check('zoom stays 1:1 through the drag', after.zoom === 1)

  // ── reduced motion: every motion token collapses to 0ms ──────────────────
  const rctx = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1200, height: 800 } })
  const rpage = await rctx.newPage()
  await rpage.goto('http://localhost:5187/')
  await rpage.waitForSelector('.topbar')
  const tokens = await rpage.evaluate(() => {
    const cs = getComputedStyle(document.documentElement)
    return ['--t-fast', '--t-med', '--t-slow'].map((t) => cs.getPropertyValue(t).trim())
  })
  check('reduced motion zeroes the tokens', tokens.every((t) => t === '0ms'), tokens.join(','))
  const segDur = await rpage.evaluate(() =>
    getComputedStyle(document.querySelector('.seg-thumb')).transitionDuration)
  check('seg thumb reports 0s under reduced motion', segDur === '0s', segDur)
  await rctx.close()

  check('no console errors', errors.length === 0)
  if (errors.length) console.log(errors.join('\n'))
  await browser.close()
} finally {
  srv.kill()
}
process.exit(failed ? 1 : 0)
