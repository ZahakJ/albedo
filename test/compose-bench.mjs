// Compose speed: a 50-layer document on a 24 MP RAW, timed to GPU
// completion. xvfb-run -a node test/compose-bench.mjs [raw] — headed Chromium
// for the hardware adapter. The document:
//   1 smart object (the RAW, developed) + 2 more placed smart objects
//   10 full-frame pixel layers (stamps), 15 partial pixel layers (800 px)
//   15 adjustment layers (5 Develop, one with clarity), 4 type and shape
//   3 groups with masks
// Measures fit and 100% views, still and panning, a Develop adjustment
// slider, and a brush stroke on a middle layer; VRAM held; browser RSS.
import { chromium } from 'playwright'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ensureServer } from './server.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const RAW = process.argv[2] ?? `${root}test/fixtures/bench-a7iii.arw`
const PORT = 5194
await ensureServer(PORT)
const W = +(process.env.VW ?? 2560), H = +(process.env.VH ?? 1440)

const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: W, height: H } })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
await page.goto(`http://localhost:${PORT}/`)
await page.waitForFunction(() => window.__albedo?.compose?.state().ready, null, { timeout: 30000 })

// the RAW into the catalog, into Develop, then Edit in Compose
await page.setInputFiles('input[type=file]', RAW)
await page.waitForFunction(() => window.__albedo.catalog().photos.length > 0, null, { timeout: 60000 })
await page.keyboard.press('d')
await page.waitForFunction(() => window.__albedo.edit().photo && window.__albedo.edit().doc, null, { timeout: 60000 })
await page.waitForTimeout(1500)
const t0 = Date.now()
await page.keyboard.press('Control+Shift+E')
await page.waitForFunction(() => window.__albedo.compose.state().doc?.nodes.length === 1, null, { timeout: 30000 })
const openMs = Date.now() - t0

const C = (fn, arg) => page.evaluate(fn, arg)
const op = (name, args = {}) => C(([n, a]) => window.__albedo.compose.op(n, a), [name, args])
const req = (m) => C((m) => window.__albedo.compose.request(m), m)
const doc = () => C(() => window.__albedo.compose.state().doc)

const d0 = await doc()
const DW = d0.width, DH = d0.height
const smart = d0.nodes[0]
console.log(`document ${DW}×${DH} (${((DW * DH) / 1e6).toFixed(1)} MP), Edit in Compose in ${openMs} ms (UI round trip)`)

const tb = Date.now()
for (let i = 0; i < 10; i++) {
  await op('stampVisible')
  const d = await doc()
  await op('props', { nodeId: d.activeId, patch: { opacity: 0.6, blend: ['normal', 'multiply', 'screen', 'overlay', 'softLight'][i % 5] } })
}
// 15 partial layers from generated 800 px images
for (let i = 0; i < 15; i++) {
  await C(async ([i, DW, DH]) => {
    const cv = new OffscreenCanvas(800, 800)
    const g = cv.getContext('2d')
    g.fillStyle = `hsl(${i * 24},70%,50%)`
    g.beginPath(); g.arc(400, 400, 380, 0, Math.PI * 2); g.fill()
    const bitmap = await createImageBitmap(cv)
    const x = Math.round((i % 5) * (DW - 800) / 4), y = Math.round(Math.floor(i / 5) * (DH - 800) / 2)
    await window.__albedo.compose.request({ type: 'coAddImage', bitmap, name: `Patch ${i + 1}`, x, y })
  }, [i, DW, DH])
}
const adj = [
  ['curves', { curves: { master: [[0, 0], [0.3, 0.25], [0.7, 0.78], [1, 1]] } }],
  ['levels', { channel: 'rgb', params: { inBlack: 0.02, inWhite: 0.98, gamma: 1.05, outBlack: 0, outWhite: 1 } }],
  ['huesat', { params: { hue: 4, saturation: 10, lightness: 0 } }],
  ['brightness', { params: { brightness: 5, contrast: 5 } }],
  ['exposure', { params: { exposure: 0.1, offset: 0, gamma: 1 } }],
  ['photofilter', null], ['mixer', null], ['gradmap', null], ['invert', null], ['posterize', { params: { levels: 64 } }],
  ['develop', { modules: { exposure: { ev: 0.2 } } }],
  ['develop', { modules: { localcontrast: { clarity: 25, texture: 10 } } }],
  ['develop', { modules: { vibsat: { vibrance: 15 } } }],
  ['develop', { modules: { grading: { shadows: { h: 220, s: 15 }, midtones: { h: 0, s: 0 }, highlights: { h: 40, s: 10 }, blending: 50, balance: 0 } } }],
  ['develop', { modules: { tone: { contrast: 10, highlights: -20, shadows: 15, whites: 0, blacks: 0 } } }],
]
const adjIds = []
for (const [type, params] of adj) {
  await op('addAdjust', { type, params })
  const d = await doc()
  adjIds.push(d.activeId)
  if (type === 'gradmap' || type === 'invert' || type === 'posterize' || type === 'mixer') await op('props', { nodeId: d.activeId, patch: { opacity: 0.15 } })
}
// two more smart objects of the same RAW, placed small
for (let i = 0; i < 2; i++) {
  await req({ type: 'coAddSmart', photoId: smart.smart.photoId, name: `Photo ${i + 2}`, editDoc: { ...smart.smart.edit, modules: { ...smart.smart.edit.modules, exposure: { ev: i ? -0.5 : 0.5 } } } })
  const d = await doc()
  await op('props', { nodeId: d.activeId, patch: { xf: { kind: 'affine', m: [0.3, 0, 0, 0.3, 200 + i * DW * 0.35, DH * 0.6] } } })
}
// type and shapes
await op('addText', { x: DW * 0.05, y: DH * 0.15, text: { content: 'albedo Compose', size: 280, color: [1, 1, 1, 1] } })
await op('addText', { x: DW * 0.05, y: DH * 0.3, text: { content: 'تركيب الصور', size: 220, color: [1, 0.9, 0.6, 1] } })
await op('addShape', { x: DW * 0.6, y: DH * 0.05, shape: { type: 'rect', w: 1200, h: 500, radius: 60, fill: [0, 0, 0, 0.35] } })
await op('addShape', { x: DW * 0.7, y: DH * 0.6, shape: { type: 'ellipse', w: 900, h: 900, fill: [1, 1, 1, 0.2], stroke: { width: 12, color: [1, 1, 1, 1], align: 'outside' } } })
// three groups of five partial layers, each with a mask
let d = await doc()
const patches = d.nodes.filter((n) => n.name?.startsWith('Patch')).map((n) => n.id)
for (let g = 0; g < 3; g++) {
  await op('group', { nodeIds: patches.slice(g * 5, g * 5 + 5) })
  d = await doc()
  await op('addMask', { nodeId: d.activeId, reveal: true })
}
const buildMs = Date.now() - tb
d = await doc()
const count = (l) => l.reduce((n, x) => n + 1 + (x.children ? count(x.children) : 0), 0)
const layers = count(d.nodes)
console.log(`${layers} layers built in ${(buildMs / 1000).toFixed(1)} s`)

const bench = (args) => req({ type: 'coBench', frames: 60, ...args })
const fit = () => C(() => window.__albedo.compose.fit())
const one = () => C(() => {
  const c = window.__albedo.compose
  const v = c.state().view
  const k = (1 / Math.min(devicePixelRatio, 2)) / v.zoom
  const el = document.querySelector('.co-stage').getBoundingClientRect()
  const cx = el.width / 2, cy = el.height / 2
  c.setView({ zoom: v.zoom * k, offX: cx - (cx - v.offX) * k, offY: cy - (cy - v.offY) * k, fitted: false })
})
await fit(); await page.waitForTimeout(800)
const res = {}
res.fitStill = await bench({ mutate: 'none' })
res.fitPan = await bench({ mutate: 'pan' })
res.fitZoom = await bench({ mutate: 'zoom' })
// a Develop adjustment slider in the middle of the stack
const mid = adjIds[11]
res.developSlider = await bench({ mutate: 'preview', nodeId: mid, patches: [
  { adjust: { type: 'develop', modules: { localcontrast: { clarity: 25, texture: 10 }, exposure: { ev: 0.3 } } } },
  { adjust: { type: 'develop', modules: { localcontrast: { clarity: 25, texture: 10 }, exposure: { ev: -0.3 } } } },
] })
// a brush stroke on a full-frame layer halfway up
const strokeLayer = d.nodes.find((n) => n.kind === 'pixel' && n.name === 'Stamp')?.id ?? d.nodes[5].id
await op('select', { nodeId: strokeLayer })
res.brushStroke = await bench({
  mutate: 'stroke', frames: 60, line: [DW * 0.2, DH * 0.5, DW * 0.01, 0],
  begin: { tool: 'brush', nodeId: strokeLayer, size: 120, hardness: 0.6, opacity: 1, flow: 0.5, spacing: 0.15, color: [1, 0.2, 0.2, 1], target: 'pixels', pressure: 'off' },
})
await one(); await page.waitForTimeout(800)
res.oneStill = await bench({ mutate: 'none' })
res.onePan = await bench({ mutate: 'pan' })
const stats = await req({ type: 'coStats' })
// browser processes' resident memory (MB)
const rss = (() => {
  try {
    const pid = browser.process()?.pid
    const out = execSync(`ps -o rss= --ppid ${pid}; ps -o rss= -p ${pid}`).toString().trim().split(/\s+/).map(Number)
    return Math.round(out.reduce((a, b) => a + b, 0) / 1024)
  } catch { return null }
})()
const vp = await C(() => { const r = document.querySelector('.co-stage').getBoundingClientRect(); return [Math.round(r.width * Math.min(devicePixelRatio, 2)), Math.round(r.height * Math.min(devicePixelRatio, 2))] })
const ms = (r) => `${r.median.toFixed(2)} ms median, ${r.p95.toFixed(2)} p95`
console.log(`stage ${vp[0]}×${vp[1]} px`)
for (const [k, v] of Object.entries(res)) console.log(`${k.padEnd(14)} ${ms(v)}`)
console.log(`VRAM held by the document and history: ${(stats.vram / 2 ** 30).toFixed(2)} GB; browser RSS ${rss} MB`)
console.log(JSON.stringify({ doc: [DW, DH], layers, openMs, buildMs, stage: vp, res, vram: stats.vram, rss }))
if (errors.length) console.log('errors:', errors.slice(0, 5).join(' | '))
await page.screenshot({ path: `${root}test/fixtures/compose-bench.png` })
await browser.close()
process.exit(0)
