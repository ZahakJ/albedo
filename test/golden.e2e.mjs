// Golden export test: flat-color test image + known params → exported JPEG
// must match the reference math within JPEG tolerance, on BOTH backends.
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'
import { ensureServer } from './server.mjs'
import { execSync } from 'node:child_process'

const scratch = join(tmpdir(), 'albedo-test')
mkdirSync(scratch, { recursive: true })

// flat mid-gray sRGB(128) test card
execSync(`magick -size 64x64 xc:'rgb(128,128,128)' ${scratch}/gray.png`)

// reference math (twin of the shaders) — params: ev=1, contrast=0, sat=0, temp=0
const s2l = (c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
const l2s = (c) => c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055
const expected = Math.round(l2s(Math.min(1, s2l(128 / 255) * 2 ** 1)) * 255)

await ensureServer(5180)

const run = async (backend) => {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader'] })
  const page = await (await browser.newContext({ acceptDownloads: true })).newPage()
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  await page.goto(`http://localhost:5180/?backend=${backend}`)
  await page.waitForSelector('text=Drop photos here')
  await page.setInputFiles('input[type=file]', `${scratch}/gray.png`)
  // library flow: import → grid cell → D opens develop
  await page.waitForFunction(() => document.querySelectorAll('.gcell').length === 1)
  await page.click('.gcell >> nth=0')
  await page.keyboard.press('d')
  await page.waitForFunction(
    () => parseInt(document.querySelector('.develop-canvas')?.style.width || 0) > 20,
    null, { timeout: 15000 })
  const usedBackend = await page.textContent('.topbar-backend')

  // exposure +1.00 EV via keyboard: 2 × Shift+ArrowUp (step .05 × 10)
  const slider = page.locator('.slider', { hasText: 'Exposure' })
  await slider.focus()
  await page.keyboard.press('Shift+ArrowUp')
  await page.keyboard.press('Shift+ArrowUp')
  const value = await slider.locator('.slider-value').textContent()

  const dl = page.waitForEvent('download', { timeout: 15000 })
  await page.click('text=Export JPEG')
  await (await dl).saveAs(`${scratch}/golden-${backend}.jpg`)
  await browser.close()

  const mean = parseFloat(execSync(
    `magick ${scratch}/golden-${backend}.jpg -format "%[fx:mean*255]" info:`).toString())
  const pass = Math.abs(mean - expected) <= 2 && value === '1.00'
  console.log(`${backend}: used=${usedBackend} ev=${value} mean=${mean.toFixed(1)} expected=${expected} ${pass ? 'PASS' : 'FAIL'}${errors.length ? ' errors:' + errors : ''}`)
  return pass
}

const ok = (await run('webgpu')) & (await run('webgl2'))
process.exit(ok ? 0 : 1)
