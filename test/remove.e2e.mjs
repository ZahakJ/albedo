// Remove e2e: a dark disc on a smooth gradient; Q, paint over the disc, the
// inpainting model fills it; the export must no longer show the disc, the
// patch must be one undoable doc entry, and it must survive a reload. Skips
// (exit 0) when the models are not installed. Spawns vite on 5194.
import { chromium } from 'playwright'
import { execSync } from 'node:child_process'
import { mkdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawnVite } from './server.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
if (!existsSync(`${root}public/models/migan_pipeline_v2.onnx`)) {
  console.log('SKIP remove: model not installed — run: npm run setup-models')
  process.exit(0)
}
const fx = `${root}test/fixtures`
mkdirSync(fx, { recursive: true })
const file = `${fx}/remove-disc.jpg`
if (!existsSync(file)) {
  execSync(`magick -size 900x600 gradient:'hsl(200,35%,30%)'-'hsl(40,45%,70%)' -fill 'rgb(20,20,20)' -draw 'circle 450,300 450,350' ${file}`)
}

const PORT = 5194
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

// mean luma of the disc's centre in an export of the current doc
const discLuma = (page) => page.evaluate(async () => {
  const { photo, doc } = window.__albedo.edit()
  const { blob } = await window.__albedo.exportPhoto(photo.id, doc, { type: 'image/png' })
  const bm = await createImageBitmap(blob)
  const c = new OffscreenCanvas(bm.width, bm.height).getContext('2d', { willReadFrequently: true })
  c.drawImage(bm, 0, 0)
  const d = c.getImageData(Math.round(bm.width / 2) - 20, Math.round(bm.height / 2) - 20, 40, 40).data
  let s = 0
  for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]
  return s / (d.length / 4)
})

try {
  await up()
  const browser = await chromium.launch({ args: ['--no-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader'] })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(`http://localhost:${PORT}/`)
  await page.waitForSelector('text=Drop photos here')
  await page.setInputFiles('input[type=file]', [file])
  await page.waitForFunction(() => document.querySelectorAll('.gcell').length === 1, null, { timeout: 30000 })
  await page.dblclick('.gcell')
  await page.waitForFunction(() => window.__albedo.edit().doc, null, { timeout: 30000 })
  await page.waitForFunction(() => parseInt(document.querySelector('.develop-canvas')?.style.width || 0) > 20)

  const before = await discLuma(page)
  check('disc is dark before', before < 40, before.toFixed(1))

  // Q, then paint a stroke across the disc (canvas centre ± a bit)
  await page.keyboard.press('q')
  await page.waitForSelector('.heal-svg.is-remove')
  const box = await page.locator('.heal-svg').boundingBox()
  await page.keyboard.press(']')
  await page.keyboard.press(']')
  await page.keyboard.press(']')
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  const r = box.width * (60 / 900)
  await page.mouse.move(cx - r, cy - r * 0.6)
  await page.mouse.down()
  for (let i = 0; i <= 12; i++) {
    const t = i / 12
    await page.mouse.move(cx - r + 2 * r * t, cy + (i % 2 ? r * 0.6 : -r * 0.6), { steps: 2 })
  }
  await page.mouse.up()
  await page.waitForFunction(() => (window.__albedo.edit().doc?.modules?.remove?.patches?.length ?? 0) === 1,
    null, { timeout: 120000 })
  check('one patch in the doc', true)
  const after = await discLuma(page)
  check('disc is gone from the export', after > before + 40, `${before.toFixed(1)} → ${after.toFixed(1)}`)

  await page.keyboard.press('Escape')
  await page.keyboard.press('Meta+z')
  await page.keyboard.press('Control+z')
  await page.waitForFunction(() => !(window.__albedo.edit().doc?.modules?.remove?.patches?.length), null, { timeout: 10000 })
  const undone = await discLuma(page)
  check('undo brings the disc back', Math.abs(undone - before) < 4, undone.toFixed(1))
  await page.keyboard.press('Meta+Shift+z')
  await page.keyboard.press('Control+Shift+z')
  await page.waitForFunction(() => (window.__albedo.edit().doc?.modules?.remove?.patches?.length ?? 0) === 1, null, { timeout: 10000 })

  await page.reload()
  await page.waitForFunction(() => document.querySelectorAll('.gcell').length === 1, null, { timeout: 30000 })
  await page.dblclick('.gcell')
  await page.waitForFunction(() => window.__albedo.edit().doc?.modules?.remove?.patches?.length === 1, null, { timeout: 30000 })
  await page.waitForTimeout(1500) // patch pixels replay after the first frame
  const reloaded = await discLuma(page)
  check('patch survives a reload', Math.abs(reloaded - after) < 4, `${after.toFixed(1)} vs ${reloaded.toFixed(1)}`)
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  await browser.close()
} catch (err) {
  console.error(err)
  failed++
} finally {
  srv.kill()
}
process.exit(failed ? 1 : 0)
