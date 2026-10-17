// Compose end to end, on the GPU. Compose needs WebGPU with readback, so this
// suite runs headed Chromium (xvfb-run -a node test/compose.e2e.mjs) — headless
// Chromium only has SwiftShader here. It drives the app's own module
// instances through window.__albedo.compose and checks composites by readback.
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ensureServer } from './server.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const shots = process.env.SHOT_DIR ?? `${root}test/fixtures`
mkdirSync(shots, { recursive: true })
const PORT = 5193
// a hardware WebGPU adapter needs a display (xvfb-run); without one, skip
if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
  console.log('SKIP compose: no display — run under xvfb-run -a for a GPU-backed browser')
  process.exit(0)
}
// TEST_URL: a static build (keeps a dev server's reloads out of a long run)
const BASE = process.env.TEST_URL ?? `http://localhost:${PORT}/`
if (!process.env.TEST_URL) await ensureServer(PORT)

let failed = 0
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`); if (!ok) failed++ }
const near = (a, b, tol = 1.5 / 255) => a.every((v, i) => Math.abs(v - b[i]) <= tol)
const fmt = (a) => `[${a.map((v) => v.toFixed(4)).join(', ')}]`

const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
await page.goto(BASE)
await page.waitForFunction(() => window.__albedo?.compose?.state().ready || window.__albedo?.compose?.state().error, null, { timeout: 30000 })
if (await page.evaluate(() => window.__albedo.compose.state().error)) {
  console.log(`SKIP compose: ${await page.evaluate(() => window.__albedo.compose.state().error)}`)
  await browser.close()
  process.exit(0)
}
await page.keyboard.press('e')

const C = (fn, arg) => page.evaluate(fn, arg)
const op = (name, args = {}) => C(([n, a]) => window.__albedo.compose.op(n, a), [name, args])
const px = (x, y) => C(([x, y]) => window.__albedo.compose.getPixel(x, y), [x, y])
const req = (msg) => C((m) => window.__albedo.compose.request(m), msg)
const doc = () => C(() => window.__albedo.compose.state().doc)
const newDoc = (w, h, opts) => req({ type: 'coNew', width: w, height: h, depth: 16, background: 'white', name: 'e2e', ...opts })
const settle = () => page.waitForTimeout(150)

// ── blend modes against the reference formulas ─────────────────────────────
// Photoshop's soft light, W3C for the rest; opaque layers, so the result is
// the blend function itself
const lum = (c) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]
const clipC = (c) => { const l = lum(c), n = Math.min(...c), x = Math.max(...c); let o = c; if (n < 0) o = o.map((v) => l + ((v - l) * l) / (l - n)); if (x > 1) o = o.map((v) => l + ((v - l) * (1 - l)) / (x - l)); return o }
const setLum = (c, l) => clipC(c.map((v) => v + l - lum(c)))
const sat = (c) => Math.max(...c) - Math.min(...c)
const setSat = (c, s) => { const mx = Math.max(...c), mn = Math.min(...c); return mx - mn <= 1e-6 ? [0, 0, 0] : c.map((v) => ((v - mn) * s) / (mx - mn)) }
const burn = (b, s) => (b >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s))
const dodge = (b, s) => (b <= 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s)))
const hard = (b, s) => (s <= 0.5 ? b * 2 * s : b + (2 * s - 1) - b * (2 * s - 1))
const vivid = (b, s) => (s <= 0.5 ? burn(b, 2 * s) : dodge(b, 2 * s - 1))
const SEP = {
  normal: (b, s) => s, darken: Math.min, multiply: (b, s) => b * s, colorBurn: burn, linearBurn: (b, s) => Math.max(0, b + s - 1),
  lighten: Math.max, screen: (b, s) => b + s - b * s, colorDodge: dodge, linearDodge: (b, s) => Math.min(1, b + s),
  overlay: (b, s) => hard(s, b), softLight: (b, s) => (s <= 0.5 ? 2 * b * s + b * b * (1 - 2 * s) : 2 * b * (1 - s) + Math.sqrt(b) * (2 * s - 1)),
  hardLight: hard, vividLight: vivid, linearLight: (b, s) => Math.min(1, Math.max(0, b + 2 * s - 1)),
  pinLight: (b, s) => (s <= 0.5 ? Math.min(b, 2 * s) : Math.max(b, 2 * s - 1)), hardMix: (b, s) => (vivid(b, s) >= 0.5 ? 1 : 0),
  difference: (b, s) => Math.abs(b - s), exclusion: (b, s) => b + s - 2 * b * s, subtract: (b, s) => Math.max(0, b - s),
  divide: (b, s) => (s <= 0 ? 1 : Math.min(1, b / s)),
}
const NONSEP = {
  darkerColor: (b, s) => (lum(b) < lum(s) ? b : s), lighterColor: (b, s) => (lum(b) > lum(s) ? b : s),
  hue: (b, s) => setLum(setSat(s, sat(b)), lum(b)), saturation: (b, s) => setLum(setSat(b, sat(s)), lum(b)),
  color: (b, s) => setLum(s, lum(b)), luminosity: (b, s) => setLum(b, lum(s)),
}
const MODES = ['normal', 'darken', 'multiply', 'colorBurn', 'linearBurn', 'darkerColor', 'lighten', 'screen', 'colorDodge', 'linearDodge', 'lighterColor',
  'overlay', 'softLight', 'hardLight', 'vividLight', 'linearLight', 'pinLight', 'hardMix', 'difference', 'exclusion', 'subtract', 'divide',
  'hue', 'saturation', 'color', 'luminosity']
const ref = (m, b, s) => (SEP[m] ? b.map((v, i) => SEP[m](v, s[i])) : NONSEP[m](b, s))

await newDoc(64, 64)
const B = [0.62, 0.35, 0.18], S = [0.25, 0.55, 0.8]
await op('addFill', { fill: { type: 'solid', color: [...B, 1] } })
await op('addFill', { fill: { type: 'solid', color: [...S, 1] } })
let d = await doc()
const top = d.nodes[d.nodes.length - 1].id
let modesOk = 0
const bad = []
for (const m of MODES) {
  await op('props', { nodeId: top, patch: { blend: m } })
  const got = (await px(32, 32)).slice(0, 3)
  const want = ref(m, B, S).map((v) => Math.min(1, Math.max(0, v)))
  if (near(got, want, 2 / 255)) modesOk++
  else bad.push(`${m} got ${fmt(got)} want ${fmt(want)}`)
}
check(`blend modes match the formulas (${modesOk}/${MODES.length}, plus dissolve)`, modesOk === MODES.length, bad.join('; '))

// opacity and fill
await op('props', { nodeId: top, patch: { blend: 'normal', opacity: 0.5 } })
check('opacity 50% mixes halfway', near((await px(32, 32)).slice(0, 3), B.map((b, i) => (b + S[i]) / 2)))

// ── adjustments ────────────────────────────────────────────────────────────
await newDoc(64, 64)
await op('addFill', { fill: { type: 'solid', color: [0.2, 0.4, 0.6, 1] } })
await op('addAdjust', { type: 'invert' })
check('invert adjustment', near((await px(10, 10)).slice(0, 3), [0.8, 0.6, 0.4]))
d = await doc()
await op('props', { nodeId: d.activeId, patch: { visible: false } })
await op('addAdjust', { type: 'levels', params: { channel: 'rgb', params: { inBlack: 0.2, inWhite: 0.6, gamma: 1, outBlack: 0, outWhite: 1 } } })
check('levels adjustment', near((await px(10, 10)).slice(0, 3), [0, 0.5, 1], 2 / 255))
d = await doc()
await op('props', { nodeId: d.activeId, patch: { visible: false } })
await op('addAdjust', { type: 'develop', params: { modules: { exposure: { ev: 1 } } } })
const dev = await px(10, 10)
check('Develop adjustment (exposure +1 brightens)', dev[0] > 0.25 && dev[2] > 0.75, fmt(dev))
// mask on the adjustment: hide all → no effect
d = await doc()
await op('addMask', { nodeId: d.activeId, reveal: false })
check('a hide-all mask removes the adjustment', near((await px(10, 10)).slice(0, 3), [0.2, 0.4, 0.6]))

// a mask made from a selection limits the adjustment to it
await newDoc(100, 100, { background: 'white' })
await op('addAdjust', { type: 'invert' })
d = await doc()
await req({ type: 'coSelect', op: 'shape', shapes: [{ kind: 'rect', x0: 0, y0: 0, x1: 50, y1: 100 }], mode: 'new' })
await op('addMask', { nodeId: d.activeId, reveal: true, fromSelection: true })
check('a mask from the selection limits the adjustment', near((await px(25, 50)).slice(0, 3), [0, 0, 0]) && near((await px(75, 50)).slice(0, 3), [1, 1, 1]))
await op('deleteMask', { nodeId: d.activeId })
await op('addMask', { nodeId: d.activeId, reveal: false, fromSelection: true })
check('a hide-selection mask is its inverse', near((await px(25, 50)).slice(0, 3), [1, 1, 1]) && near((await px(75, 50)).slice(0, 3), [0, 0, 0]))
await op('deselect')

// ── clipping and groups ────────────────────────────────────────────────────
await newDoc(100, 100, { background: 'white' })
await op('addLayer', { kind: 'pixel' }) // empty base
d = await doc()
const base = d.activeId
await req({ type: 'coSelect', op: 'shape', shapes: [{ kind: 'rect', x0: 0, y0: 0, x1: 50, y1: 100 }], mode: 'new' })
await op('fillSelection', { color: [0, 0, 1, 1] })
await op('deselect')
await op('addFill', { fill: { type: 'solid', color: [1, 0, 0, 1] } })
d = await doc()
await op('props', { nodeId: d.activeId, patch: { clip: true } })
check('a clipped layer shows only over its base', near((await px(25, 50)).slice(0, 3), [1, 0, 0]) && near((await px(75, 50)).slice(0, 3), [1, 1, 1]))
await op('group', { nodeIds: [base, d.activeId] })
d = await doc()
await op('props', { nodeId: d.activeId, patch: { opacity: 0.5 } })
check('a pass-through group fades its contents', near((await px(25, 50)).slice(0, 3), [1, 0.5, 0.5], 2 / 255))

// ── selection, fill, undo ──────────────────────────────────────────────────
await newDoc(200, 100)
await op('addLayer', { kind: 'pixel' })
await req({ type: 'coSelect', op: 'shape', shapes: [{ kind: 'ellipse', x0: 20, y0: 20, x1: 80, y1: 80 }], mode: 'new' })
await op('fillSelection', { color: [0, 0.5, 0, 1] })
check('fill through an elliptical selection', near((await px(50, 50)).slice(0, 3), [0, 0.5, 0]) && near((await px(150, 50)).slice(0, 3), [1, 1, 1]))
await page.waitForFunction(() => !!window.__albedo.compose.state().selection?.outline, null, { timeout: 5000 }).catch(() => {})
check('marching ants outline traced', !!(await C(() => window.__albedo.compose.state().selection?.outline)))
await req({ type: 'coUndo' })
check('undo the fill', near((await px(50, 50)).slice(0, 3), [1, 1, 1]))
await req({ type: 'coRedo' })
// wand: click the green disc, then fill red
await op('deselect')
await req({ type: 'coSelect', op: 'wand', x: 50, y: 50, tolerance: 10, contiguous: true, sampleAll: true, mode: 'new' })
await op('fillSelection', { color: [1, 0, 0, 1] })
check('magic wand selects the disc', near((await px(50, 50)).slice(0, 3), [1, 0, 0]) && near((await px(150, 50)).slice(0, 3), [1, 1, 1]))

// ── brush stroke ───────────────────────────────────────────────────────────
await newDoc(200, 200)
await op('addLayer', { kind: 'pixel' })
await req({ type: 'coStrokeBegin', tool: 'brush', size: 20, hardness: 1, opacity: 1, flow: 1, spacing: 0.1, color: [0, 0, 0, 1], target: 'pixels', pressure: 'off' })
await req({ type: 'coStrokePts', pts: [[20, 100, 1], [180, 100, 1]] })
await req({ type: 'coStrokeEnd' })
check('a brush stroke paints its path', near((await px(100, 100)).slice(0, 3), [0, 0, 0]) && near((await px(100, 150)).slice(0, 3), [1, 1, 1]))
await req({ type: 'coUndo' })
check('undo the stroke', near((await px(100, 100)).slice(0, 3), [1, 1, 1]))
await req({ type: 'coRedo' })
// eraser on the same layer halves it at 50% opacity
await req({ type: 'coStrokeBegin', tool: 'eraser', size: 30, hardness: 1, opacity: 0.5, flow: 1, spacing: 0.1, target: 'pixels', pressure: 'off' })
await req({ type: 'coStrokePts', pts: [[100, 60, 1], [100, 140, 1]] })
await req({ type: 'coStrokeEnd' })
check('eraser at 50% opacity', near((await px(100, 100)).slice(0, 3), [0.5, 0.5, 0.5], 3 / 255))

// ── clone ──────────────────────────────────────────────────────────────────
await newDoc(200, 100)
await op('addFill', { fill: { type: 'linear', line: [0, 0, 200, 0], stops: [{ t: 0, color: [0, 0, 0, 1] }, { t: 1, color: [1, 1, 1, 1] }] } })
await op('addLayer', { kind: 'pixel' })
const src40 = await px(40, 50)
await req({ type: 'coStrokeBegin', tool: 'clone', size: 20, hardness: 1, opacity: 1, flow: 1, spacing: 0.1, sample: 'below', source: [40, 50], target: 'pixels', pressure: 'off' })
await req({ type: 'coStrokePts', pts: [[160, 50, 1]] })
await req({ type: 'coStrokeEnd' })
check('clone stamp copies from the source (sampling below)', near((await px(160, 50)).slice(0, 3), src40.slice(0, 3), 3 / 255), `${fmt(await px(160, 50))} vs ${fmt(src40)}`)

// ── transform ──────────────────────────────────────────────────────────────
await newDoc(200, 200, { background: 'white' })
await op('addLayer', { kind: 'pixel' })
await req({ type: 'coSelect', op: 'shape', shapes: [{ kind: 'rect', x0: 0, y0: 0, x1: 40, y1: 40 }], mode: 'new' })
await op('fillSelection', { color: [0, 0, 0, 1] })
await op('deselect')
d = await doc()
await op('props', { nodeId: d.activeId, patch: { xf: { kind: 'affine', m: [2, 0, 0, 2, 100, 100] } } })
check('affine transform (2× and moved), non-destructive', near((await px(150, 150)).slice(0, 3), [0, 0, 0]) && near((await px(20, 20)).slice(0, 3), [1, 1, 1]))
await op('props', { nodeId: d.activeId, patch: { xf: { kind: 'quad', pts: [[0, 0], [200, 0], [200, 200], [0, 200]] } } })
check('perspective (quad) transform', near((await px(10, 10)).slice(0, 3), [0, 0, 0]) && near((await px(150, 150)).slice(0, 3), [1, 1, 1]))

// ── type ───────────────────────────────────────────────────────────────────
await newDoc(600, 200, { background: 'white' })
const t0 = await op('addText', { x: 20, y: 140, text: { content: 'سلام Hello', size: 96, color: [0, 0, 0, 1] } })
await page.waitForTimeout(500)
d = await doc()
const tn = d.nodes.find((n) => n.id === t0.nodeId)
let dark = 0
for (let x = 30; x < 560; x += 10) { const p = await px(x, 110); if (p[0] < 0.5) dark++ }
check('type layer shapes and draws Arabic and Latin', tn?.bounds.w > 300 && dark > 5, `width ${tn?.bounds.w}, dark samples ${dark}`)
await page.screenshot({ path: `${shots}/compose-type.png` })

// ── frequency separation recombines exactly ────────────────────────────────
await newDoc(128, 128)
await op('addFill', { fill: { type: 'radial', line: [64, 64, 120, 64], stops: [{ t: 0, color: [0.9, 0.6, 0.3, 1] }, { t: 1, color: [0.1, 0.2, 0.4, 1] }] } })
await op('stampVisible')
const before = await px(40, 70)
await op('frequencySeparation', { radius: 6 })
const after = await px(40, 70)
check('frequency separation recombines to the source (16-bit)', near(before.slice(0, 3), after.slice(0, 3), 1 / 255), `${fmt(before)} → ${fmt(after)}`)

// ── PSD round trip ─────────────────────────────────────────────────────────
await newDoc(120, 80, { background: 'white' })
await op('addLayer', { kind: 'pixel' })
await req({ type: 'coSelect', op: 'shape', shapes: [{ kind: 'rect', x0: 10, y0: 10, x1: 60, y1: 60 }], mode: 'new' })
await op('fillSelection', { color: [0.8, 0.2, 0.1, 1] })
await op('deselect')
d = await doc()
await op('props', { nodeId: d.activeId, patch: { blend: 'multiply', opacity: 0.75, name: 'Red square' } })
await op('addMask', { nodeId: d.activeId, reveal: true })
await op('group', { nodeIds: [d.activeId] })
const comp0 = await px(30, 30)
const rt = await C(async () => {
  const c = window.__albedo.compose
  const blob = await c.exportDoc('psd')
  const bytes = new Uint8Array(await blob.arrayBuffer())
  await c.request({ type: 'coImport', bytes, name: 'rt', kind: 'psd' })
  const d = c.state().doc
  const flat = []
  const walk = (l, depth) => { for (const n of l) { flat.push({ kind: n.kind, name: n.name, blend: n.blend, opacity: n.opacity, mask: !!n.mask, depth }); if (n.children) walk(n.children, depth + 1) } }
  walk(d.nodes, 0)
  return { size: bytes.length, flat, depth: d.depth }
})
await settle()
const comp1 = await px(30, 30)
const red = rt.flat.find((n) => n.name === 'Red square')
check('PSD round trip keeps names, groups, modes, opacity, masks, depth',
  !!red && red.blend === 'multiply' && Math.abs(red.opacity - 0.75) < 0.01 && red.mask && red.depth === 1 && rt.depth === 16 && rt.flat.some((n) => n.kind === 'group'),
  JSON.stringify(rt.flat))
check('PSD round trip keeps the pixels', near(comp0.slice(0, 3), comp1.slice(0, 3), 1 / 255), `${fmt(comp0)} → ${fmt(comp1)}`)

// ── save, close, reopen ────────────────────────────────────────────────────
await newDoc(80, 80, { background: 'black', name: 'persist' })
await op('addFill', { fill: { type: 'solid', color: [0.3, 0.6, 0.9, 1] } })
d = await doc()
await op('props', { nodeId: d.activeId, patch: { opacity: 0.5 } })
const p0 = await px(40, 40)
const id0 = d.id
await req({ type: 'coSave' })
await req({ type: 'coClose' })
const list = await req({ type: 'coList' })
await req({ type: 'coLoad', docId: id0 })
const p1 = await px(40, 40)
check('a document saves to OPFS and reopens identical', list.docs.some((x) => x.id === id0) && near(p0, p1, 1 / 255))

// ── liquify ────────────────────────────────────────────────────────────────
await newDoc(200, 200, { background: 'white' })
await op('addLayer', { kind: 'pixel' })
await req({ type: 'coSelect', op: 'shape', shapes: [{ kind: 'rect', x0: 90, y0: 0, x1: 110, y1: 200 }], mode: 'new' })
await op('fillSelection', { color: [0, 0, 0, 1] })
await op('deselect')
const l0 = await px(130, 100)
await req({ type: 'coLiquify', phase: 'begin', mode: 'push', size: 120, pressure: 1, rate: 1 })
await req({ type: 'coLiquify', phase: 'pts', pts: [[100, 100], [115, 100], [130, 100], [145, 100]] })
await req({ type: 'coLiquify', phase: 'end' })
const l1 = await px(130, 100)
await op('resetLiquify', {})
const l2 = await px(130, 100)
check('liquify pushes pixels, and restores', l0[0] > 0.9 && l1[0] < 0.6 && l2[0] > 0.9, `${l0[0].toFixed(2)} → ${l1[0].toFixed(2)} → ${l2[0].toFixed(2)}`)

// ── the UI itself: mouse and keys, as a person uses it ─────────────────────
await newDoc(800, 600, { background: 'white' })
await op('addLayer', { kind: 'pixel' })
await page.waitForTimeout(300)
await C(() => window.__albedo.compose.fit())
await page.waitForTimeout(300)
const toScreen = async (x, y) => C(([x, y]) => {
  const s = window.__albedo.compose.state()
  const r = document.querySelector('.co-stage').getBoundingClientRect()
  return [r.left + s.view.offX + x * s.view.zoom, r.top + s.view.offY + y * s.view.zoom]
}, [x, y])
await page.keyboard.press('x') // foreground black
await page.keyboard.press('b')
let [ax, ay] = await toScreen(100, 300)
let [bx, by] = await toScreen(700, 300)
await page.mouse.move(ax, ay)
await page.mouse.down()
await page.mouse.move(bx, by, { steps: 20 })
await page.mouse.up()
await page.waitForTimeout(400)
check('UI: dragging the brush paints', (await px(400, 300))[0] < 0.2, fmt(await px(400, 300)))
await page.keyboard.press('m')
;[ax, ay] = await toScreen(100, 100)
;[bx, by] = await toScreen(300, 200)
await page.mouse.move(ax, ay)
await page.mouse.down()
await page.mouse.move(bx, by, { steps: 8 })
await page.mouse.up()
await page.waitForFunction(() => !!window.__albedo.compose.state().selection?.outline, null, { timeout: 5000 }).catch(() => {})
check('UI: the marquee makes a selection with ants', !!(await C(() => window.__albedo.compose.state().selection?.outline)))
await page.keyboard.press('Alt+Backspace') // fill with the foreground
await page.waitForTimeout(300)
check('UI: ⌥⌫ fills the selection', (await px(200, 150))[0] < 0.2 && (await px(500, 100))[0] > 0.9)
await page.keyboard.press('Control+d')
await page.keyboard.press('t')
;[ax, ay] = await toScreen(420, 120)
await page.mouse.click(ax, ay)
await page.waitForSelector('.co-text-edit', { timeout: 5000 })
await page.keyboard.type('Hello مرحبا')
await page.keyboard.press('Escape')
await page.waitForTimeout(800)
d = await doc()
const typed = d.nodes.find((n) => n.kind === 'text')
check('UI: the type tool makes a type layer from what you type', typed?.text.content === 'Hello مرحبا', typed?.text.content)
const nBefore = (await doc()).nodes.length
await page.keyboard.press('v')
await page.keyboard.press('Control+j')
await page.waitForTimeout(300)
const dup = (await doc()).nodes.length
await page.keyboard.press('Control+z')
await page.waitForTimeout(300)
check('UI: ⌘J duplicates and ⌘Z undoes it', dup === nBefore + 1 && (await doc()).nodes.length === nBefore)

await page.screenshot({ path: `${shots}/compose-ui.png` })
check('no page errors', errors.length === 0, errors.slice(0, 5).join(' | '))
await browser.close()
console.log(failed ? `\n${failed} FAILED` : '\nall passed')
process.exit(failed ? 1 : 0)
