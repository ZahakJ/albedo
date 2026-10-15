// AI denoise e2e: the real CR2 fixture in Develop on WebGL2; moving AI
// Denoise above 0 runs the model over the mosaic (on the CPU here), the
// export must lose high-frequency energy but keep its brightness and colour,
// and the doc must carry the amount. Skips (exit 0) without the model.
// Spawns vite on 5190.
import { chromium } from 'playwright'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawnVite } from './server.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
if (!existsSync(`${root}public/models/rawnind_bayer.onnx`)) {
  console.log('SKIP denoise: model not installed — run: npm run setup-models')
  process.exit(0)
}
const file = `${root}test/fixtures/sample.cr2`
if (!existsSync(file)) {
  console.log('SKIP denoise: test/fixtures/sample.cr2 missing')
  process.exit(0)
}

const PORT = 5190
const srv = spawnVite(String(PORT), { cwd: root })
const up = async () => {
  for (let i = 0; i < 100; i++) {
    try { await fetch(`http://localhost:${PORT}/`); return } catch { await new Promise((r) => setTimeout(r, 200)) }
  }
  throw new Error(`dev server never came up on ${PORT}`)
}

let failed = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`)
  if (!ok) failed++
}

// mean luma and mean |neighbour difference| of a central crop of an export,
// pushed 2 stops so the shadows' noise dominates the measure
const stats = (page, aiDenoise) => page.evaluate(async (amt) => {
  const { photo, doc } = window.__albedo.edit()
  const d0 = { ...doc, modules: { ...doc.modules, exposure: { ev: 2, black: 0 },
    detail: { ...(doc.modules.detail ?? {}), sharpenAmount: 0, lumaNR: 0, chromaNR: 0, aiDenoise: amt } } }
  const { blob } = await window.__albedo.exportPhoto(photo.id, d0, { type: 'image/png' })
  const bm = await createImageBitmap(blob)
  const c = new OffscreenCanvas(bm.width, bm.height).getContext('2d', { willReadFrequently: true })
  c.drawImage(bm, 0, 0)
  const S = 400
  const d = c.getImageData(Math.round(bm.width / 2 - S / 2), Math.round(bm.height / 2 - S / 2), S, S).data
  let lum = 0
  let hf = 0
  const L = (i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S - 1; x++) {
      const i = (y * S + x) * 4
      lum += L(i)
      hf += Math.abs(L(i) - L(i + 4))
    }
  }
  const n = S * (S - 1)
  return { lum: lum / n, hf: hf / n }
}, aiDenoise)

try {
  await up()
  const browser = await chromium.launch({ args: ['--no-sandbox', '--use-angle=swiftshader'] })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(`http://localhost:${PORT}/?backend=webgl2`)
  await page.waitForSelector('text=Drop photos here')
  await page.setInputFiles('input[type=file]', [file])
  await page.waitForFunction(() => document.querySelectorAll('.gcell').length === 1, null, { timeout: 60000 })
  await page.dblclick('.gcell')
  await page.waitForFunction(() => window.__albedo.edit().doc, null, { timeout: 60000 })
  await page.waitForFunction(() => parseInt(document.querySelector('.develop-canvas')?.style.width || 0) > 20)

  const before = await stats(page, 0)

  // drag the AI Denoise slider to the right
  const row = page.locator('.sec[data-sec=detail] .slider').first()
  await row.scrollIntoViewIfNeeded()
  const b = await row.boundingBox()
  await page.mouse.move(b.x + b.width * 0.3, b.y + b.height / 2)
  await page.mouse.down()
  await page.mouse.move(b.x + b.width * 0.95, b.y + b.height / 2, { steps: 8 })
  await page.mouse.up()
  const amount = await page.evaluate(() => window.__albedo.edit().doc.modules.detail?.aiDenoise ?? 0)
  check('slider commits aiDenoise', amount > 50, String(amount))

  await page.waitForFunction(() => window.__albedo.denoise().status === 'ready', null, { timeout: 300000 })
  check('the model runs to the end', true)
  const after = await stats(page, 100)
  // a clean low-ISO file: the drop is small, detail stays (quality numbers
  // with noisy files live in docs/BENCHMARKS.md)
  check('high-frequency energy drops', after.hf < before.hf * 0.97, `${before.hf.toFixed(2)} → ${after.hf.toFixed(2)}`)
  check('brightness holds', Math.abs(after.lum - before.lum) < 3, `${before.lum.toFixed(1)} → ${after.lum.toFixed(1)}`)
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  await browser.close()
} catch (err) {
  console.error(err)
  failed++
} finally {
  srv.kill()
}
process.exit(failed ? 1 : 0)
