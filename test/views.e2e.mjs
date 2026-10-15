// Views-wave e2e: docDiff unit labels, compare (C) two-up cycle/promote/rate,
// survey (N) tiles + ✕ + double-click→Develop, cull (⇧C) fullscreen pass with
// auto-advance HUD, Develop HISTORY rows + jump + snapshot roundtrip, and the
// CAT_GET_PREVIEW 2048px pipeline. Spawns its own dev server on 5188.
import { chromium } from 'playwright'
import { execSync, spawn } from 'node:child_process'
import { mkdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describeDiff } from '../src/engine/docDiff.js'
import { spawnVite } from './server.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const fx = `${root}test/fixtures`
const shots = process.env.SHOT_DIR ?? fx
mkdirSync(fx, { recursive: true })
mkdirSync(shots, { recursive: true })

const files = []
for (let i = 0; i < 4; i++) {
  const f = `${fx}/fxv${i}.jpg`
  const [w, h] = i === 0 ? [2400, 1600] : [900, 600] // fxv0 exercises the 2048px preview
  if (!existsSync(f))
    execSync(
      `magick -size ${w}x${h} gradient:'hsl(${i * 70 + 10},45%,40%)'-'hsl(${(i * 70 + 80) % 360},50%,16%)' ` +
      `-font Adwaita-Sans-Bold -fill 'rgba(255,255,255,0.85)' -gravity center -pointsize 160 -annotate 0 '${i + 1}' ${f}`)
  files.push(f)
}

const srv = spawnVite('5188', { cwd: root, stdio: 'ignore' })
const up = async () => {
  for (let i = 0; i < 100; i++) {
    try { await fetch('http://localhost:5188/'); return } catch { await new Promise((r) => setTimeout(r, 200)) }
  }
  throw new Error('dev server never came up on 5188')
}

let failed = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` ${extra}`}`)
  if (!ok) failed++
}

// ── docDiff: pure label rules, no browser needed ───────────────────────────
{
  const base = { modules: {}, masks: [] }
  const d = describeDiff
  check('docDiff: single numeric key carries value',
    d(base, { modules: { exposure: { ev: 0.85, black: 0 } }, masks: [] }) === 'Exposure +0.85',
    d(base, { modules: { exposure: { ev: 0.85, black: 0 } }, masks: [] }))
  check('docDiff: crop',
    d(base, { modules: { geometry: { crop: { x: 0.1, y: 0, w: 0.8, h: 1 }, angle: 0, flipH: 0 } }, masks: [] }) === 'Crop')
  check('docDiff: angle-only is straighten',
    d(base, { modules: { geometry: { crop: { x: 0, y: 0, w: 1, h: 1 }, angle: 3, flipH: 0 } }, masks: [] }) === 'Straighten')
  const m1 = { id: 'm1', name: 'Radial 1', kind: 'radial', enabled: true, invert: false, geom: { cx: 0.5, cy: 0.5, rx: 0.2, ry: 0.2 }, adjust: {} }
  check('docDiff: mask added',
    d(base, { modules: {}, masks: [m1] }) === 'Mask: Radial 1 added')
  check('docDiff: mask removed',
    d({ modules: {}, masks: [m1] }, base) === 'Mask: Radial 1 removed')
  check('docDiff: mask geom is moved',
    d({ modules: {}, masks: [m1] }, { modules: {}, masks: [{ ...m1, geom: { ...m1.geom, cx: 0.7 } }] }) === 'Mask: Radial 1 moved')
  check('docDiff: preset multi-module counts',
    d(base, { modules: { wb: { temp: 20, tint: 0 }, vibsat: { vibrance: 30, saturation: 0 }, grain: { amount: 40, size: 25, roughness: 50 } }, masks: [] }) === '3 modules')
  check('docDiff: exposure+tone together is auto tone',
    d(base, { modules: { exposure: { ev: 0.4, black: 0 }, tone: { contrast: 10, highlights: -20, shadows: 15, whites: 0, blacks: 0 } }, masks: [] }) === 'Auto tone')
  const snap = { name: 'warm', at: 1, modules: { wb: { temp: 30, tint: 0 } }, masks: [] }
  check('docDiff: snapshot save',
    d(base, { ...base, snapshots: [snap] }) === 'Snapshot: warm')
  check('docDiff: snapshot restore',
    d({ modules: { exposure: { ev: 1, black: 0 } }, masks: [], snapshots: [snap] },
      { modules: snap.modules, masks: [], snapshots: [snap] }) === 'Snapshot: warm')
}

try {
  await up()
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader'],
  })
  const page = await (await browser.newContext({
    colorScheme: 'dark', viewport: { width: 1440, height: 900 },
  })).newPage()
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  const view = () => page.evaluate(() => window.__albedo.view())
  const doc = () => page.evaluate(() => window.__albedo.edit().doc)
  // instrument-grade shots: never with a transient toast in frame
  const shot = async (path) => {
    await page.waitForFunction(() => !document.querySelector('.toast'), null, { timeout: 10000 })
    await page.waitForTimeout(250)
    await page.screenshot({ path })
  }

  await page.goto('http://localhost:5188/')
  await page.waitForSelector('text=Drop photos here')
  await page.setInputFiles('input[type=file]', files)
  await page.waitForFunction(() => document.querySelectorAll('.gcell').length === 4, null, { timeout: 30000 })
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.gthumb')].filter((i) => i.complete && i.naturalWidth > 0).length === 4)

  const gridIds = await page.$$eval('.gcell', (els) => els.map((el) => el.dataset.id))
  const nameOf = await page.evaluate(() =>
    Object.fromEntries(window.__albedo.catalog().photos.map((p) => [p.id, p.name])))
  const selectAll = async () => {
    await page.click(`.gcell[data-id="${gridIds[0]}"]`)
    await page.click(`.gcell[data-id="${gridIds[3]}"]`, { modifiers: ['Shift'] })
    await page.waitForFunction(() => window.__albedo.view().selection.size === 4)
  }

  // ── compare (C): two-up, cycle, promote, rate candidate ──────────────────
  await selectAll()
  await page.keyboard.press('c')
  await page.waitForSelector('.cmp-pane[data-role="CANDIDATE"]')
  check('C opens two-up compare', await page.locator('.cmp-pane').count() === 2)
  check('panes are tagged SELECT / CANDIDATE',
    (await page.textContent('.cmp-pane[data-role="SELECT"] .view-tag')) === 'SELECT' &&
    (await page.textContent('.cmp-pane[data-role="CANDIDATE"] .view-tag')) === 'CANDIDATE')
  const candName = () => page.textContent('.cmp-pane[data-role="CANDIDATE"] .cmp-name')
  const selName = () => page.textContent('.cmp-pane[data-role="SELECT"] .cmp-name')
  // selection focus was gridIds[3] → select pane pins it, candidate wraps to [0]
  check('select pane pins the focused photo', (await selName()) === nameOf[gridIds[3]])
  check('candidate starts at the next pool photo', (await candName()) === nameOf[gridIds[0]])
  await page.keyboard.press('ArrowRight')
  await page.waitForFunction((n) =>
    document.querySelector('.cmp-pane[data-role="CANDIDATE"] .cmp-name')?.textContent === n, nameOf[gridIds[1]])
  check('→ cycles the candidate', true)
  await page.keyboard.press('ArrowUp')
  await page.waitForFunction((n) =>
    document.querySelector('.cmp-pane[data-role="SELECT"] .cmp-name')?.textContent === n, nameOf[gridIds[1]])
  check('↑ promotes candidate to select', true)
  check('promotion advances the candidate', (await candName()) === nameOf[gridIds[2]])
  await page.keyboard.press('4')
  await page.waitForFunction((id) =>
    window.__albedo.catalog().photos.find((p) => p.id === id)?.rating === 4, gridIds[2])
  check('rating key hits the CANDIDATE and persists', true)
  check('candidate caption shows ★★★★',
    (await page.textContent('.cmp-pane[data-role="CANDIDATE"] .cmp-stars')) === '★★★★')
  await page.waitForFunction(() => document.querySelectorAll('.cmp-img.is-hi').length === 2, null, { timeout: 15000 })
  await shot(`${shots}/views-compare.png`)
  await page.keyboard.press('Escape')
  await page.waitForSelector('.grid-scroller')
  check('Esc returns compare to grid', (await view()).mode === 'grid')

  // ── survey (N): tiles, ✕ removal with reflow, double-click → Develop ─────
  await selectAll()
  await page.keyboard.press('n')
  await page.waitForFunction(() => document.querySelectorAll('.svy-tile').length === 4)
  check('N tiles the 4 selected photos', true)
  await page.waitForFunction(() => document.querySelectorAll('.svy-img.is-hi').length === 4, null, { timeout: 15000 })
  await shot(`${shots}/views-survey.png`)
  await page.hover(`.svy-tile[data-id="${gridIds[0]}"]`)
  await page.click(`.svy-tile[data-id="${gridIds[0]}"] .svy-x`)
  await page.waitForFunction(() => document.querySelectorAll('.svy-tile').length === 3)
  check('✕ removes the tile from the survey', true)
  check('catalog still holds 4 photos (✕ is not delete)',
    await page.evaluate(() => window.__albedo.catalog().photos.length) === 4)
  await page.dblclick(`.svy-tile[data-id="${gridIds[1]}"]`)
  await page.waitForFunction(
    () => parseInt(document.querySelector('.develop-canvas')?.style.width || 0) > 20,
    null, { timeout: 15000 })
  check('double-click opens Develop', (await view()).surface === 'develop')
  await page.keyboard.press('g')
  await page.waitForSelector('.grid-scroller')
  check('G exits Develop to the grid', (await view()).mode === 'grid' && (await view()).surface === 'library')

  // ── cull (⇧C): fullscreen pass, auto-advance, HUD, Z, Esc ────────────────
  await page.click(`.gcell[data-id="${gridIds[0]}"]`)
  await page.keyboard.press('C')
  await page.waitForSelector('.cull')
  const cullBox = await page.locator('.cull').boundingBox()
  check('⇧C fills the whole window', cullBox.width === 1440 && cullBox.height === 900)
  check('HUD reads position 1 of 4', (await page.textContent('.hud-pos')) === '1 of 4')
  const r0 = parseInt(await page.textContent('.hud-left'))
  check('HUD counts photos awaiting a decision', r0 === 3, `remaining ${r0}`)
  await page.waitForFunction(() => document.querySelector('.cull-img.is-hi'), null, { timeout: 15000 })
  await shot(`${shots}/views-cull.png`)
  await page.keyboard.press('3')
  await page.waitForFunction((r) =>
    document.querySelector('.hud-left')?.textContent === `${r - 1} remaining`, r0)
  check('rating decrements the remaining count', true)
  check('rating auto-advances to the next undecided', (await page.textContent('.hud-pos')) === '2 of 4')
  await page.keyboard.press('ArrowLeft')
  await page.waitForFunction(() => document.querySelector('.hud-pos')?.textContent === '1 of 4')
  check('← walks back; HUD shows the stamp', (await page.textContent('.hud-stars')) === '★★★')
  await page.keyboard.press('z')
  await page.waitForFunction(() =>
    (document.querySelector('.cull-img')?.style.transform ?? '').includes('scale'))
  check('Z zooms the preview 1:1 (CSS transform only)', true)
  await page.keyboard.press('Escape')
  await page.waitForSelector('.grid-scroller')
  check('Esc exits cull to the grid at the current photo',
    (await view()).mode === 'grid' && (await view()).selectedId === gridIds[0])

  // ── history: three commits → rows, jump, snapshot roundtrip ──────────────
  await page.keyboard.press('d')
  await page.waitForFunction(
    () => parseInt(document.querySelector('.develop-canvas')?.style.width || 0) > 20,
    null, { timeout: 15000 })
  const scrub = async (nth, dx) => {
    const loc = page.locator('.sec[data-sec=tone] .slider').nth(nth)
    await loc.scrollIntoViewIfNeeded()
    const box = await loc.boundingBox()
    const x = box.x + box.width / 2, y = box.y + box.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + dx, y, { steps: 4 })
    await page.mouse.up()
  }
  await scrub(0, 40) // Exposure
  await scrub(1, 35) // Contrast
  await scrub(2, 30) // Highlights
  await page.waitForFunction(() => document.querySelectorAll('.hist-row').length === 4)
  const labels = await page.$$eval('.hist-row .hist-label', (els) => els.map((e) => e.textContent))
  check('three commits → three labeled rows above Original',
    /^Highlights \+/.test(labels[0]) && /^Contrast \+/.test(labels[1]) &&
    /^Exposure \+/.test(labels[2]) && labels[3] === 'Original',
    labels.join(' | '))
  check('newest row is current',
    (await page.locator('.hist-row >> nth=0').getAttribute('class')).includes('is-current'))
  const hBefore = (await doc()).modules.tone.highlights
  await page.click('.hist-row >> nth=1')
  await page.waitForFunction(() => {
    const d = window.__albedo.edit().doc
    return (d.modules.tone?.highlights ?? 0) === 0 && (d.modules.tone?.contrast ?? 0) > 0
  })
  check('clicking a row jumps history (doc reverts)', hBefore > 0)
  check('jumped row carries the amber tick',
    (await page.locator('.hist-row >> nth=1').getAttribute('class')).includes('is-current'))
  check('rows above the current one read as redo side',
    (await page.locator('.hist-row >> nth=0').getAttribute('class')).includes('is-ahead'))

  // snapshot: name the current state, drift away, restore
  await page.click('.sec[data-sec=history] .sec-btn')
  await page.waitForSelector('.hist-input')
  await page.fill('.hist-input', 'warm')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.hist-snap')
  check('snapshot row appears above history', (await page.textContent('.hist-snap .hist-label')) === 'warm')
  check('snapshot save is its own labeled step',
    (await page.textContent('.hist-row:not(.hist-snap) .hist-label')) === 'Snapshot: warm')
  await scrub(3, 50) // Shadows — drift off the snapshot
  await page.waitForFunction(() => (window.__albedo.edit().doc.modules.tone?.shadows ?? 0) > 0)
  await page.click('.hist-snap')
  await page.waitForFunction(() => (window.__albedo.edit().doc.modules.tone?.shadows ?? 0) === 0)
  check('clicking the snapshot restores its state', true)
  check('restore lands as one history entry',
    (await page.textContent('.hist-row:not(.hist-snap) .hist-label')) === 'Snapshot: warm')
  await page.locator('.sec[data-sec=history]').scrollIntoViewIfNeeded()
  await shot(`${shots}/views-history.png`)

  // ── preview pipeline: ≥1024px for the 2400px import ──────────────────────
  const bigId = await page.evaluate(() =>
    window.__albedo.catalog().photos.find((p) => p.name === 'fxv0.jpg')?.id)
  const longEdge = await page.evaluate(async (id) => {
    const blob = await window.__albedo.preview(id)
    if (!blob) return 0
    const bmp = await createImageBitmap(blob)
    return Math.max(bmp.width, bmp.height)
  }, bigId)
  check('CAT_GET_PREVIEW serves ≥1024px for a 2400px source', longEdge >= 1024, `long edge ${longEdge}`)
  check('preview is capped at 2048px', longEdge <= 2048, `long edge ${longEdge}`)

  check('no console errors', errors.length === 0)
  if (errors.length) console.log(errors.join('\n'))
  await browser.close()
} finally {
  srv.kill()
}
process.exit(failed ? 1 : 0)
