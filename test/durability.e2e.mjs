// Durability: crash the tab (the renderer process, workers and all) right
// after edits, reopen, and check nothing committed was lost — a Develop
// edit (500 ms write-behind) and a Compose document (2.5 s autosave). Run
// headed for Compose: xvfb-run -a node test/durability.e2e.mjs
import { chromium } from 'playwright'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ensureServer } from './server.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const fx = `${root}test/fixtures`
mkdirSync(fx, { recursive: true })
const img = `${fx}/dur0.jpg`
if (!existsSync(img)) execSync(`magick -size 1200x800 gradient:'#a05030'-'#203050' ${img}`)
const PORT = 5192
const BASE = process.env.TEST_URL ?? `http://localhost:${PORT}/`
if (!process.env.TEST_URL) await ensureServer(PORT)
const headed = !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)

let failed = 0
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`); if (!ok) failed++ }

const browser = await chromium.launch({ headless: !headed, args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--ignore-gpu-blocklist'] })
// one context: OPFS persists across pages of the same origin
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
const open = async () => {
  const p = await ctx.newPage()
  console.log('new page')
  await p.goto(BASE)
  await p.waitForFunction(() => window.__albedo?.catalog, null, { timeout: 30000 })
  return p
}
const crash = async (p) => {
  console.log('crashing')
  const cdp = await ctx.newCDPSession(p)
  cdp.send('Page.crash').catch(() => {}) // never answers: the renderer is gone
  await new Promise((r) => setTimeout(r, 1500))
  await Promise.race([p.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))])
}

// ── Develop: one edit, then the tab dies 1 s later ─────────────────────────
let page = await open()
console.log('opened')
await page.setInputFiles('input[type=file]', img)
await page.waitForFunction(() => window.__albedo.catalog().photos.length > 0, null, { timeout: 30000 })
const photoId = await page.evaluate(() => window.__albedo.catalog().photos[0].id)
console.log('imported', photoId)
await page.keyboard.press('d')
await page.waitForFunction(() => window.__albedo.edit().doc, null, { timeout: 30000 })
console.log('in develop')
await page.waitForTimeout(800) // Develop takes keys once its first frame is up
await page.keyboard.press('v') // black & white: one committed edit
await page.waitForFunction(() => window.__albedo.edit().doc?.modules?.bw?.on === 1, null, { timeout: 5000 })
console.log('edited')
await page.waitForTimeout(1000)
await crash(page)
console.log('crashed')
page = await open()
await page.waitForFunction(() => window.__albedo.catalog().photos.length > 0, null, { timeout: 30000 })
const kept = await page.evaluate((id) => window.__albedo.loadDoc(id).then((d) => d?.modules?.bw?.on ?? 0), photoId)
check('a Develop edit survives the tab crashing 1 s later', kept === 1)

// ── Compose: a document, then the tab dies 3.5 s later ─────────────────────
const ready = await page.waitForFunction(() => window.__albedo.compose.state().ready || window.__albedo.compose.state().error, null, { timeout: 30000 }).then(() => page.evaluate(() => window.__albedo.compose.state().ready))
if (!ready) console.log('SKIP compose part: no WebGPU in this browser')
else {
  await page.keyboard.press('e')
  const docId = await page.evaluate(async () => {
    const c = window.__albedo.compose
    const r = await c.request({ type: 'coNew', width: 400, height: 300, depth: 16, background: 'white', name: 'crash test' })
    await c.op('addFill', { fill: { type: 'solid', color: [0.2, 0.5, 0.8, 1] } })
    await c.op('addAdjust', { type: 'invert' })
    return r.docId
  })
  await page.waitForTimeout(3500)
  await crash(page)
  page = await open()
  await page.waitForFunction(() => window.__albedo.compose.state().ready, null, { timeout: 30000 })
  const r = await page.evaluate(async (id) => {
    const c = window.__albedo.compose
    const { docs } = await c.request({ type: 'coList' })
    const d = docs.find((x) => x.id === id)
    if (!d) return null
    await c.request({ type: 'coLoad', docId: id })
    return { layers: d.layers, px: await c.getPixel(200, 150) }
  }, docId)
  check('a Compose document survives the tab crashing 3.5 s later', r?.layers === 3 && Math.abs(r.px[0] - 0.8) < 0.01 && Math.abs(r.px[2] - 0.2) < 0.01, JSON.stringify(r))
}

await browser.close()
console.log(failed ? `\n${failed} FAILED` : '\nall passed')
process.exit(failed ? 1 : 0)
