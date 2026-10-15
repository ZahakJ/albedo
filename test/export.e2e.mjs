// Export + versions e2e: ⌘E dialog (format/quality/long-edge/filename),
// main-thread resize, batch export from the library selection, and the
// VERSIONS panel (create / switch / rename / delete-guard / persistence).
// Spawns its own dev server on 5180.
import { chromium } from 'playwright'
import { execSync, spawn } from 'node:child_process'
import { mkdirSync, existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawnVite } from './server.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const fx = `${root}test/fixtures`
const shots = process.env.SHOT_DIR ?? fx
const dls = `${shots}/export-dl`
mkdirSync(fx, { recursive: true })
mkdirSync(shots, { recursive: true })
mkdirSync(dls, { recursive: true })

// ex0 is the 2400px-long-edge subject; ex1/ex2 pad the batch
const files = []
for (let i = 0; i < 3; i++) {
  const f = `${fx}/ex${i}.jpg`
  const [w, h] = i === 0 ? [2400, 1600] : [800, 600]
  if (!existsSync(f))
    execSync(
      `magick -size ${w}x${h} gradient:'hsl(${i * 70 + 10},50%,40%)'-'hsl(${(i * 70 + 80) % 360},45%,12%)' ` +
      `-font Adwaita-Sans-Bold -fill 'rgba(255,255,255,0.85)' -gravity center -pointsize 160 -annotate 0 'E${i}' ${f}`)
  files.push(f)
}

const srv = spawnVite('5180', { cwd: root, stdio: 'ignore' })
const up = async () => {
  for (let i = 0; i < 100; i++) {
    try { await fetch('http://localhost:5180/'); return } catch { await new Promise((r) => setTimeout(r, 200)) }
  }
  throw new Error('dev server never came up on 5180')
}

let failed = 0
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) failed++ }
const doc = (page) => page.evaluate(() => window.__albedo.edit().doc)
const identify = (p) => execSync(`magick identify -format "%w %h %m" "${p}"`).toString().trim().split(' ')

async function scrub(page, locator, dx) {
  await locator.scrollIntoViewIfNeeded()
  const box = await locator.boundingBox()
  const x = box.x + box.width / 2, y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx, y, { steps: 4 })
  await page.mouse.up()
}

async function openInDevelop(page, id) {
  await page.keyboard.press('g')
  await page.waitForFunction(() => document.querySelectorAll('.gcell').length === 3)
  await page.click(`.gcell[data-id="${id}"]`)
  await page.keyboard.press('d')
  await page.waitForFunction((want) => window.__albedo.edit().photo?.id === want, id, { timeout: 15000 })
  await page.waitForFunction(
    () => parseInt(document.querySelector('.develop-canvas')?.style.width || 0) > 20,
    null, { timeout: 15000 })
}

// configure the open dialog and export; resolves with the download.
// Format/edge are always set explicitly — the dialog restores 'last used'
// settings on open, so defaults can't be assumed.
async function exportOnce(page, { quality, edge, png, as } = {}) {
  await page.keyboard.press('ControlOrMeta+KeyE')
  await page.waitForSelector('.exportdlg')
  await page.click(`.exp-seg button:has-text("${png ? 'PNG' : 'JPEG'}")`)
  if (quality != null) {
    await page.click('.exportdlg .slider-value')
    await page.fill('.exportdlg .slider-input', String(quality))
    await page.keyboard.press('Enter')
  }
  if (edge != null) {
    await page.click('.exp-seg button:has-text("Custom")')
    await page.fill('.exp-px', String(edge))
  } else {
    await page.click('.exp-seg button:has-text("Off")')
  }
  const dlP = page.waitForEvent('download')
  await page.click('.exportdlg .btn-primary')
  const dl = await dlP
  await page.waitForSelector('.exportdlg', { state: 'detached' })
  const to = `${dls}/${as ?? dl.suggestedFilename()}`
  await dl.saveAs(to)
  return { name: dl.suggestedFilename(), path: to }
}

try {
  await up()
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader'],
  })
  const ctx = await browser.newContext({ colorScheme: 'dark', viewport: { width: 1440, height: 900 } })
  // no directory picker in headless: force the sequential-download fallback
  await ctx.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', { value: undefined, configurable: true })
  })
  const page = await ctx.newPage()
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))

  await page.goto('http://localhost:5180/')
  await page.waitForSelector('text=Drop photos here')
  await page.setInputFiles('input[type=file]', files)
  await page.waitForFunction(() => document.querySelectorAll('.gcell').length === 3, null, { timeout: 30000 })
  // grid order is sort-dependent; map filenames → ids through the catalog
  const byName = await page.evaluate(() =>
    Object.fromEntries(window.__albedo.catalog().photos.map((p) => [p.name, p.id])))
  const id0 = byName['ex0.jpg'], id1 = byName['ex1.jpg'], id2 = byName['ex2.jpg']

  // ── single export: JPEG q80, long edge 1024, of the 2400px photo ─────────
  await openInDevelop(page, id0)
  await page.keyboard.press('ControlOrMeta+KeyE')
  await page.waitForSelector('.exportdlg')
  check('⌘E opens export dialog', true)
  await page.click('.exp-seg button:has-text("Custom")')
  await page.fill('.exp-px', '1024')
  await page.click('.exportdlg .slider-value')
  await page.fill('.exportdlg .slider-input', '80')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(150)
  await page.screenshot({ path: `${shots}/export-dialog.png` })
  const dlP = page.waitForEvent('download')
  await page.click('.exportdlg .btn-primary')
  const dl80 = await dlP
  await page.waitForSelector('.exportdlg', { state: 'detached' })
  const p80 = `${dls}/${dl80.suggestedFilename()}`
  await dl80.saveAs(p80)
  check('filename follows {name}-albedo pattern', dl80.suggestedFilename() === 'ex0-albedo.jpg')
  {
    const [w, h, fmt] = identify(p80)
    check('JPEG long edge resized to 1024', fmt === 'JPEG' && Math.max(+w, +h) === 1024)
    check('aspect preserved', Math.abs(+h - Math.round(1024 * 1600 / 2400)) <= 1)
  }

  // same geometry at q100: quality must show up in the byte size
  const q100 = await exportOnce(page, { quality: 100, edge: 1024, as: 'ex0-q100.jpg' })
  check('q80 file is smaller than q100', statSync(p80).size < statSync(q100.path).size)

  // ── PNG export, full resolution ──────────────────────────────────────────
  const png = await exportOnce(page, { png: true })
  {
    const [w, h, fmt] = identify(png.path)
    check('PNG export works at full res',
      png.name === 'ex0-albedo.png' && fmt === 'PNG' && +w === 2400 && +h === 1600)
  }

  // ── batch export: 3 selected in library → 3 downloads + progress UI ──────
  await page.keyboard.press('g')
  await page.waitForFunction(() => document.querySelectorAll('.gcell').length === 3)
  await page.click(`.gcell[data-id="${id0}"]`)
  await page.click(`.gcell[data-id="${id1}"]`, { modifiers: ['ControlOrMeta'] })
  await page.click(`.gcell[data-id="${id2}"]`, { modifiers: ['ControlOrMeta'] })
  await page.keyboard.press('ControlOrMeta+KeyE')
  await page.waitForSelector('.exportdlg')
  check('batch dialog counts the selection',
    (await page.textContent('.exportdlg .panel-header')).includes('3 PHOTOS'))
  // 'last used' restore would keep the previous PNG/edge settings — reset
  await page.click('.exp-seg button:has-text("JPEG")')
  await page.click('.exp-seg button:has-text("Off")')
  const batchDls = []
  page.on('download', (d) => batchDls.push(d))
  const barP = page.waitForSelector('.exp-bar', { timeout: 10000 }).then(() => true, () => false)
  await page.click('.exportdlg .btn-primary')
  check('batch progress UI appeared', await barP)
  await page.waitForSelector('.exportdlg', { state: 'detached', timeout: 60000 })
  await page.waitForTimeout(300)
  const got = batchDls.map((d) => d.suggestedFilename()).sort()
  check('batch produced 3 downloads with correct names',
    got.length === 3 && got.join() === 'ex0-albedo.jpg,ex1-albedo.jpg,ex2-albedo.jpg')

  // ── versions: edit default → new version → diverge → switch back ─────────
  await openInDevelop(page, id0)
  await page.waitForSelector('.sec[data-sec=versions] .ver-row')
  check('versions section lists Original edit',
    (await page.textContent('.ver-row .ver-name')) === 'Original edit')

  await scrub(page, page.locator('.sec[data-sec=tone] .slider').first(), 40)
  const ev0 = (await doc(page)).modules.exposure?.ev ?? 0
  check('v_default edit committed', ev0 > 0)

  await page.click('.ver-new')
  await page.waitForFunction(() => document.querySelectorAll('.ver-row').length === 2)
  let d = await doc(page)
  const vid = d.versionId
  check('new version duplicates and switches',
    /^v_\d+$/.test(vid) && d.versionName === 'Version 2' && d.modules.exposure?.ev === ev0)

  // track-mode drags are absolute — a longer drag lands on a higher value
  await scrub(page, page.locator('.sec[data-sec=tone] .slider').first(), 90)
  const ev1 = (await doc(page)).modules.exposure?.ev ?? 0
  check('version edit diverges', ev1 > ev0)

  await page.locator('.sec[data-sec=versions]').scrollIntoViewIfNeeded()
  await page.waitForTimeout(150)
  await page.screenshot({ path: `${shots}/versions-section.png` })

  await page.click('.ver-row:first-child')
  await page.waitForFunction(() => window.__albedo.edit().doc?.versionId === 'v_default')
  d = await doc(page)
  check('switch back to v_default reverts exposure on canvas doc',
    (d.modules.exposure?.ev ?? 0) === ev0)

  // ── persistence: both sidecars survive a reload ──────────────────────────
  await page.reload()
  await page.waitForFunction(() => document.querySelectorAll('.gcell').length === 3, null, { timeout: 30000 })
  const saved0 = await page.evaluate(([pid]) => window.__albedo.loadDocVersion(pid, 'v_default'), [id0])
  const saved1 = await page.evaluate(([pid, v]) => window.__albedo.loadDocVersion(pid, v), [id0, vid])
  check('v_default sidecar persisted', saved0?.modules?.exposure?.ev === ev0)
  check('version sidecar persisted',
    saved1?.modules?.exposure?.ev === ev1 && saved1?.versionName === 'Version 2')

  // ── rename persists ──────────────────────────────────────────────────────
  await openInDevelop(page, id0)
  await page.waitForFunction(() => document.querySelectorAll('.ver-row').length === 2)
  await page.dblclick('.ver-row:nth-child(2) .ver-name')
  await page.waitForSelector('.ver-edit')
  await page.fill('.ver-edit', 'punchy')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.ver-name')].some((el) => el.textContent === 'punchy'))
  await page.waitForTimeout(700) // let the rename write-behind flush
  await page.reload()
  await page.waitForFunction(() => document.querySelectorAll('.gcell').length === 3, null, { timeout: 30000 })
  const renamed = await page.evaluate(([pid, v]) => window.__albedo.loadDocVersion(pid, v), [id0, vid])
  check('version rename persists across reload', renamed?.versionName === 'punchy')

  // ── delete + last-version guard ──────────────────────────────────────────
  await openInDevelop(page, id0)
  await page.waitForFunction(() => document.querySelectorAll('.ver-row').length === 2)
  await page.hover('.ver-row:nth-child(2)')
  await page.click('.ver-row:nth-child(2) .ver-del')
  await page.waitForFunction(() => document.querySelectorAll('.ver-row').length === 1)
  const gone = await page.evaluate(([pid, v]) => window.__albedo.loadDocVersion(pid, v), [id0, vid])
  check('delete removes the version sidecar', gone == null)
  check('last version has no delete affordance',
    (await page.$$('.ver-del')).length === 0)

  check('no console errors', errors.length === 0)
  if (errors.length) console.log(errors.join('\n'))
  await browser.close()
} finally {
  srv.kill()
}
process.exit(failed ? 1 : 0)
