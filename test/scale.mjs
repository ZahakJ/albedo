// Catalog scale benchmark: xvfb-run -a node test/scale.mjs [n] — imports n photos once
// (kept in the browser profile under .scale-profile/, gitignored), times the
// Library's queries, then opens the app and times scrolling the grid.
import { chromium } from 'playwright'
import { ensureServer } from './server.mjs'
import { fileURLToPath } from 'node:url'

const N = +(process.argv[2] ?? 10000)
const PORT = 5188
await ensureServer(PORT)
const profile = fileURLToPath(new URL('../.scale-profile', import.meta.url))
const ctx = await chromium.launchPersistentContext(profile, {
  headless: false, channel: 'chromium', viewport: { width: 1600, height: 1000 },
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--ignore-gpu-blocklist'],
})
const page = await ctx.newPage()
await page.goto(`http://localhost:${PORT}/test/scale.html?n=${N}`)
await page.waitForFunction(() => document.getElementById('out').textContent.startsWith('{'), null, { timeout: 3600000 })
console.log(await page.textContent('#out'))
await page.close()

// the Library over the same catalog: open, then scroll top to bottom
const app = await ctx.newPage()
const t0 = Date.now()
await app.goto(`http://localhost:${PORT}/`)
await app.waitForFunction(() => document.querySelectorAll('.gcell').length > 20, null, { timeout: 120000 })
const firstGrid = Date.now() - t0
const scrollAt = (step) => app.evaluate(async (step) => {
  const el = document.querySelector('.grid-scroller')
  el.scrollTop = 0
  await new Promise((r) => setTimeout(r, 500))
  const frames = []
  let last = performance.now()
  const end = el.scrollHeight - el.clientHeight
  const dy = step > 0 ? step : Math.max(200, end / 300)
  for (let y = 0, k = 0; y <= end && k < 300; y += dy, k++) {
    el.scrollTop = y
    await new Promise((r) => requestAnimationFrame(r))
    const now = performance.now()
    frames.push(now - last)
    last = now
  }
  frames.sort((a, b) => a - b)
  return { px: Math.round(dy), frames: frames.length, median: +frames[frames.length >> 1].toFixed(1), p95: +frames[Math.floor(frames.length * 0.95)].toFixed(1) }
}, step)
// a wheel-like 120 px per frame, then a fling through the whole catalog
console.log(JSON.stringify({ firstGridMs: firstGrid, steady: await scrollAt(120), fling: await scrollAt(0) }))
await ctx.close()
process.exit(0)
