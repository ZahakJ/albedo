// Catalog-organization e2e: navigator (date tree / albums / smart), search,
// sort, DnD to albums, context menu, rubber-band select, delete + clear
// rejects (rows AND OPFS bytes gone after reload), import toast.
// Spawns its own dev server on 5186.
import { chromium } from 'playwright'
import { execSync, spawn } from 'node:child_process'
import { mkdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawnVite } from './server.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const fx = `${root}test/fixtures`
const shots = process.env.SHOT_DIR ?? fx
mkdirSync(fx, { recursive: true })
mkdirSync(shots, { recursive: true })

const files = []
for (let i = 0; i < 6; i++) {
  const f = `${fx}/fx${i}.jpg`
  const [w, h] = i % 3 === 0 ? [420, 560] : [560, 400]
  if (!existsSync(f))
    execSync(
      `magick -size ${w}x${h} gradient:'hsl(${i * 45},45%,38%)'-'hsl(${(i * 45 + 60) % 360},50%,14%)' ` +
      `-font Adwaita-Sans-Bold -fill 'rgba(255,255,255,0.85)' -gravity center -pointsize 110 -annotate 0 '${i + 1}' ${f}`)
  files.push(f)
}

const srv = spawnVite('5186', { cwd: root, stdio: 'ignore' })
const up = async () => {
  for (let i = 0; i < 100; i++) {
    try { await fetch('http://localhost:5186/'); return } catch { await new Promise((r) => setTimeout(r, 200)) }
  }
  throw new Error('dev server never came up on 5186')
}

let failed = 0
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) failed++ }
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']

// synthetic HTML5 DnD: one DataTransfer carried through the whole gesture
const dragTo = (page, srcSel, dstSel) => page.evaluate(([s, d]) => {
  const src = document.querySelector(s)
  const dst = document.querySelector(d)
  if (!src || !dst) throw new Error(`dnd: missing ${!src ? s : d}`)
  const dt = new DataTransfer()
  for (const [el, type] of [[src, 'dragstart'], [dst, 'dragover'], [dst, 'drop'], [src, 'dragend']])
    el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
}, [srcSel, dstSel])

try {
  await up()
  const browser = await chromium.launch({ args: ['--no-sandbox'] })
  const page = await (await browser.newContext({
    colorScheme: 'dark', viewport: { width: 1440, height: 900 },
  })).newPage()
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))

  await page.goto('http://localhost:5186/')
  await page.waitForSelector('text=Drop photos here')
  await page.setInputFiles('input[type=file]', files)

  // ── import toast ─────────────────────────────────────────────────────────
  await page.waitForSelector('.toast', { timeout: 30000 })
  check('toast appears after import',
    (await page.textContent('.toast .toast-msg')) === 'Imported 6 photos')
  await page.waitForFunction(() => document.querySelectorAll('.gcell').length === 6)
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.gthumb')].filter((i) => i.complete && i.naturalWidth > 0).length === 6)
  // the metadata panel (right side) narrows the grid — fold it to its rib so
  // the rubber-band pixel geometry below keeps its original layout
  await page.click('.meta-fold')
  await page.waitForSelector('.metapanel.is-rib')

  // ── date tree (no EXIF in fixtures → imported_at fallback = today) ───────
  const now = new Date()
  const yearRow = page.locator('.nav-row', { hasText: String(now.getFullYear()) })
  await yearRow.waitFor()
  check('date tree: year node with count 6',
    (await yearRow.locator('.nav-count').textContent()) === '6')
  const monthRow = page.locator('.nav-row', { hasText: MONTHS[now.getMonth()] })
  check('date tree: month node with count 6',
    (await monthRow.locator('.nav-count').textContent()) === '6')
  await monthRow.click()
  await page.waitForFunction(() => document.querySelectorAll('.gcell').length === 6)
  check('month node filters grid (still 6)', true)
  await page.locator('.nav-row', { hasText: 'All Photos' }).click()

  const ids = await page.$$eval('.gcell', (els) => els.map((el) => el.dataset.id))

  // ── rubber-band: drag over the first 3 cells from empty space below ─────
  {
    const grid = await page.locator('.grid-scroller').boundingBox()
    await page.mouse.move(grid.x + 560, grid.y + 400)
    await page.mouse.down()
    await page.mouse.move(grid.x + 20, grid.y + 60, { steps: 8 })
    await page.mouse.up()
    const sel = await page.evaluate(() => document.querySelectorAll('.gcell.is-sel').length)
    check('rubber-band selects 3', sel === 3)
  }

  // ── album: create via +, inline name, drag 2 photos in ───────────────────
  await page.locator('.nav-head', { hasText: 'Albums' }).locator('.nav-add').click()
  await page.waitForSelector('.nav-edit')
  await page.fill('.nav-edit', 'Trip')
  await page.keyboard.press('Enter')
  const tripRow = page.locator('.nav-row', { hasText: 'Trip' })
  await tripRow.waitFor()
  check('album created with inline name', true)

  await page.click(`.gcell[data-id="${ids[0]}"]`)
  await page.click(`.gcell[data-id="${ids[1]}"]`, { modifiers: ['ControlOrMeta'] })
  const albumSel = await page.evaluate(() =>
    document.querySelector('.nav-row[data-nav^="album-"]')?.dataset.nav)
  await dragTo(page, `.gcell[data-id="${ids[0]}"]`, `.nav-row[data-nav="${albumSel}"]`)
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.nav-row')].some((r) =>
      r.textContent.includes('Trip') && r.querySelector('.nav-count')?.textContent === '2'))
  check('drag 2 photos into album → count 2', true)

  await tripRow.click()
  await page.waitForFunction(() => document.querySelectorAll('.gcell').length === 2)
  check('album click filters grid to 2', true)
  await page.locator('.nav-row', { hasText: 'All Photos' }).click()
  await page.waitForFunction(() => document.querySelectorAll('.gcell').length === 6)

  // ── context menu: rate ★3, add to album via submenu ──────────────────────
  await page.click(`.gcell[data-id="${ids[2]}"]`, { button: 'right' })
  await page.waitForSelector('.cmenu')
  check('context menu opens', true)
  await page.waitForTimeout(150)
  await page.screenshot({ path: `${shots}/organize-menu.png` })
  await page.click('.cmenu-starset .star-btn >> nth=2')
  await page.waitForFunction((id) =>
    document.querySelector(`.gcell[data-id="${id}"] .gstars`)?.textContent === '★★★', ids[2])
  check('context menu rates ★★★', true)

  await page.click(`.gcell[data-id="${ids[2]}"]`, { button: 'right' })
  await page.waitForSelector('.cmenu')
  await page.locator('.cmenu-parent', { hasText: 'Add to Album' }).hover()
  await page.locator('.cmenu-subwrap .cmenu-row', { hasText: 'Trip' }).click()
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.nav-row')].some((r) =>
      r.textContent.includes('Trip') && r.querySelector('.nav-count')?.textContent === '3'))
  check('context menu adds to album → count 3', true)

  // ── smart collection from the ★≥3 filter ─────────────────────────────────
  await page.click('.filterbar .star-btn >> nth=2')
  await page.waitForFunction(() => document.querySelectorAll('.gcell').length === 1)
  await page.locator('.nav-head', { hasText: 'Smart' }).locator('.nav-add').click()
  await page.waitForSelector('.nav-edit')
  await page.fill('.nav-edit', 'Best')
  await page.keyboard.press('Enter')
  await page.locator('.nav-row', { hasText: 'Best' }).waitFor()
  check('smart collection saved from filter', true)
  await page.keyboard.press('Alt+\\')
  await page.waitForFunction(() => document.querySelectorAll('.gcell').length === 6)
  await page.locator('.nav-row', { hasText: 'Best' }).click()
  await page.waitForFunction(() => document.querySelectorAll('.gcell').length === 1)
  check('smart click re-applies filter live', true)
  await page.keyboard.press('Alt+\\')
  await page.waitForFunction(() => document.querySelectorAll('.gcell').length === 6)

  // ── search narrows by filename ───────────────────────────────────────────
  await page.keyboard.press('ControlOrMeta+KeyF')
  await page.waitForFunction(() => document.activeElement?.classList.contains('search-input'))
  await page.fill('.search-input', 'fx3')
  await page.waitForFunction(() => document.querySelectorAll('.gcell').length === 1, null, { timeout: 5000 })
  check('search narrows by filename', true)
  await page.keyboard.press('Escape') // clears text
  await page.keyboard.press('Escape') // blurs the field
  await page.waitForFunction(() => document.querySelectorAll('.gcell').length === 6)

  // navigator + populated grid screenshot
  await page.waitForTimeout(250)
  await page.screenshot({ path: `${shots}/organize-library.png` })

  // ── X-reject 2 → Clear rejects deletes them ──────────────────────────────
  const deadIds = [ids[4], ids[5]]
  const deadMeta = await page.evaluate((dd) =>
    window.__albedo.catalog().photos
      .filter((p) => dd.includes(p.id)).map((p) => ({ id: p.id, ext: p.ext })), deadIds)
  await page.click(`.gcell[data-id="${deadIds[0]}"]`)
  await page.click(`.gcell[data-id="${deadIds[1]}"]`, { modifiers: ['ControlOrMeta'] })
  await page.keyboard.press('x')
  await page.waitForFunction(() => document.querySelectorAll('.gcell.is-rejected').length === 2)
  await page.waitForSelector('.nav-sweep')
  await page.click('.nav-sweep')
  await page.waitForSelector('.confirmdlg')
  check('clear rejects asks for confirmation', true)
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelectorAll('.gcell').length === 4)
  check('clear rejects removes both from grid', true)
  // the "Removed…" toast fires only after the worker confirms rows + files are
  // gone — reloading before it would race the OPFS cleanup
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.toast-msg')].some((t) => t.textContent === 'Removed 2 photos'))

  // ── reload: rows AND bytes gone; album + smart persisted ─────────────────
  await page.reload()
  await page.waitForFunction(() => document.querySelectorAll('.gcell').length === 4, null, { timeout: 30000 })
  check('reload: rejected photos stay gone', true)
  check('reload: album persisted with count 3', await page.evaluate(() =>
    [...document.querySelectorAll('.nav-row')].some((r) =>
      r.textContent.includes('Trip') && r.querySelector('.nav-count')?.textContent === '3')))
  check('reload: smart collection persisted', await page.evaluate(() =>
    [...document.querySelectorAll('.nav-row')].some((r) => r.textContent.includes('Best'))))
  check('reload: CAT_GET_FILE fails for deleted photo', await page.evaluate((id) =>
    window.__albedo.loadOriginal(id).then(() => false, () => true), deadIds[0]))
  check('reload: OPFS originals gone', await page.evaluate(async (metas) => {
    const root = await navigator.storage.getDirectory()
    for (const m of metas) {
      try {
        const d = await root.getDirectoryHandle('originals')
        await d.getFileHandle(`${m.id}.${m.ext}`)
        return false // still there
      } catch { /* expected */ }
    }
    return true
  }, deadMeta))

  // ── Delete key on a selection, with confirm ──────────────────────────────
  const ids2 = await page.$$eval('.gcell', (els) => els.map((el) => el.dataset.id))
  await page.click(`.gcell[data-id="${ids2[0]}"]`)
  await page.keyboard.press('Delete')
  await page.waitForSelector('.confirmdlg')
  await page.click('.btn-danger')
  await page.waitForFunction(() => document.querySelectorAll('.gcell').length === 3)
  check('Delete key removes selection after confirm', true)
  check('selection moves to a survivor', await page.evaluate((gone) => {
    const sel = window.__albedo.view().selectedId
    return sel != null && sel !== gone
  }, ids2[0]))

  check('no console errors', errors.length === 0)
  if (errors.length) console.log(errors.join('\n'))
  await browser.close()
} finally {
  srv.kill()
}
process.exit(failed ? 1 : 0)
