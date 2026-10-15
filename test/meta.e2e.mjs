// Library metadata + export-parity e2e: metadata panel (title/caption/keywords
// save + persist + searchable), keyword browser filtering, batch keyword apply
// with mixed-state chips, watermark export (pixel probe), {seq}/{date} filename
// tokens, export presets + last-used restore, EXIF carry-over (APP1 spliced,
// orientation stripped), and catalog backup/restore roundtrip into a fresh
// profile. Spawns its own dev server on 5190. Needs magick + exiftool.
import { chromium } from 'playwright'
import { execSync, spawn } from 'node:child_process'
import { mkdirSync, existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { zipRead } from '../src/io/zip.js'
import { spawnVite } from './server.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const fx = `${root}test/fixtures`
const shots = process.env.SHOT_DIR ?? fx
const dls = `${shots}/meta-dl`
mkdirSync(fx, { recursive: true })
mkdirSync(shots, { recursive: true })
mkdirSync(dls, { recursive: true })

// dark fixtures (watermark probe needs a corner with no native whites);
// meta0/meta1 carry constructed EXIF: camera model, capture date, orientation 6
const EXIF = [
  { date: '2023:07:14 10:30:00', model: 'Albedo Test Cam' },
  { date: '2024:03:05 16:45:00', model: 'Albedo Test Cam' },
  null,
]
const files = []
for (let i = 0; i < 3; i++) {
  const f = `${fx}/meta${i}.jpg`
  if (!existsSync(f)) {
    execSync(
      `magick -size 1200x800 gradient:'hsl(${i * 60 + 200},30%,14%)'-'hsl(${i * 60 + 240},35%,6%)' ` +
      `-font Adwaita-Sans-Bold -fill 'rgba(160,160,160,0.8)' -gravity center -pointsize 120 -annotate 0 'M${i}' ${f}`)
    if (EXIF[i]) {
      execSync(`exiftool -q -Make=AlbedoCam "-Model=${EXIF[i].model}" ` +
        `"-DateTimeOriginal=${EXIF[i].date}" -Orientation#=6 -overwrite_original ${f}`)
    }
  }
  files.push(f)
}

const srv = spawnVite('5190', { cwd: root, stdio: 'ignore' })
const up = async () => {
  for (let i = 0; i < 100; i++) {
    try { await fetch('http://localhost:5190/'); return } catch { await new Promise((r) => setTimeout(r, 200)) }
  }
  throw new Error('dev server never came up on 5190')
}

let failed = 0
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) failed++ }
const et = (args, p) => execSync(`exiftool -s3 ${args} "${p}"`).toString().trim()
// max pixel value (0..1) inside a corner crop
const cornerMax = (p, gravity, geom) =>
  +execSync(`magick "${p}" -gravity ${gravity} -crop ${geom} -format "%[fx:maxima]" info:`).toString().trim()

async function importAll(page) {
  await page.goto('http://localhost:5190/')
  await page.waitForSelector('text=Drop photos here')
  await page.setInputFiles('input[type=file]', files)
  await page.waitForFunction(() => document.querySelectorAll('.gcell').length === 3, null, { timeout: 30000 })
  return page.evaluate(() =>
    Object.fromEntries(window.__albedo.catalog().photos.map((p) => [p.name, p.id])))
}

const photoOf = (page, id) =>
  page.evaluate((pid) => window.__albedo.catalog().photos.find((p) => p.id === pid), id)

async function exportRun(page, { pattern, wmOff, wmOn, count = 1 } = {}) {
  await page.keyboard.press('ControlOrMeta+KeyE')
  await page.waitForSelector('.exportdlg')
  if (pattern != null) await page.fill('.exp-name', pattern)
  const isOn = await page.isChecked('.exp-wm-check input')
  if (wmOn && !isOn) await page.check('.exp-wm-check input')
  if (wmOff && isOn) await page.uncheck('.exp-wm-check input')
  const got = []
  const listener = (d) => got.push(d)
  page.on('download', listener)
  await page.click('.exportdlg .btn-primary')
  await page.waitForSelector('.exportdlg', { state: 'detached', timeout: 60000 })
  for (let i = 0; i < 100 && got.length < count; i++) await page.waitForTimeout(100)
  page.off('download', listener)
  const out = []
  for (const d of got) {
    const to = `${dls}/${d.suggestedFilename()}`
    await d.saveAs(to)
    out.push({ name: d.suggestedFilename(), path: to })
  }
  return out
}

try {
  await up()
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader'],
  })
  const ctx = await browser.newContext({ colorScheme: 'dark', viewport: { width: 1600, height: 900 } })
  // no directory picker in headless: force the sequential-download fallback
  await ctx.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', { value: undefined, configurable: true })
  })
  const page = await ctx.newPage()
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))

  const byName = await importAll(page)
  const id0 = byName['meta0.jpg']
  const id1 = byName['meta1.jpg']
  const id2 = byName['meta2.jpg']

  // ── metadata panel: EXIF display ─────────────────────────────────────────
  await page.click(`.gcell[data-id="${id0}"]`)
  await page.waitForSelector('.metapanel .meta-rows')
  const panelText = await page.textContent('.metapanel')
  check('metadata panel shows EXIF camera model', panelText.includes('Albedo Test Cam'))
  check('metadata panel shows file info', panelText.includes('meta0.jpg') && panelText.includes('JPG'))

  // ── title / caption save ─────────────────────────────────────────────────
  await page.fill('.metapanel input.meta-input', 'Golden hour test')
  await page.keyboard.press('Enter')
  await page.fill('.metapanel .meta-area', 'A caption for the harbor')
  await page.click('.grid-scroller') // blur commits — but keep selection: click the cell
  await page.click(`.gcell[data-id="${id0}"]`)
  await page.waitForFunction((pid) => {
    const p = window.__albedo.catalog().photos.find((q) => q.id === pid)
    return p?.title === 'Golden hour test' && p?.caption === 'A caption for the harbor'
  }, id0)
  check('title + caption land in the catalog', true)

  // ── keywords: token input ────────────────────────────────────────────────
  await page.fill('.kw-input', 'alpha')
  await page.keyboard.press('Enter')
  await page.fill('.kw-input', 'beach')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelectorAll('.kw-chip').length === 2)
  check('keyword chips appear', true)
  await page.screenshot({ path: `${shots}/meta-panel.png` })

  // ── persistence across reload ────────────────────────────────────────────
  await page.waitForTimeout(300) // let the worker writes land
  await page.reload()
  await page.waitForFunction(() => document.querySelectorAll('.gcell').length === 3, null, { timeout: 30000 })
  const p0 = await photoOf(page, id0)
  check('title/caption/keywords persist across reload',
    p0?.title === 'Golden hour test' && p0?.caption === 'A caption for the harbor' &&
    JSON.stringify(p0?.keywords) === '["alpha","beach"]')

  // ── search over title + keywords ─────────────────────────────────────────
  await page.fill('.search-input', 'alpha')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelectorAll('.gcell').length === 1)
  check('search finds by keyword', true)
  await page.fill('.search-input', '')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelectorAll('.gcell').length === 3)
  await page.fill('.search-input', 'Golden hour')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelectorAll('.gcell').length === 1)
  check('search finds by title', true)
  await page.fill('.search-input', '')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelectorAll('.gcell').length === 3)

  // ── keyword browser filters ──────────────────────────────────────────────
  const kwSec = page.locator('[data-nav-sec="keywords"]')
  await kwSec.waitFor()
  const alphaRow = kwSec.locator('.nav-row', { hasText: 'alpha' })
  check('keyword browser lists alpha with count 1',
    (await alphaRow.locator('.nav-count').textContent()) === '1')
  await alphaRow.click()
  await page.waitForFunction(() => document.querySelectorAll('.gcell').length === 1)
  check('keyword row filters the grid', true)
  await page.screenshot({ path: `${shots}/meta-keywords.png` })
  await alphaRow.click()
  await page.waitForFunction(() => document.querySelectorAll('.gcell').length === 3)
  check('keyword row toggles off', true)

  // ── multi-select batch apply + mixed state ───────────────────────────────
  await page.click(`.gcell[data-id="${id0}"]`)
  await page.click(`.gcell[data-id="${id1}"]`, { modifiers: ['ControlOrMeta'] })
  await page.click(`.gcell[data-id="${id2}"]`, { modifiers: ['ControlOrMeta'] })
  await page.waitForSelector('.metapanel .kw-input')
  await page.fill('.kw-input', 'trip')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-nav-sec="keywords"] .nav-row')].some((r) =>
      r.textContent.includes('trip') && r.querySelector('.nav-count')?.textContent === '3'))
  check('batch keyword apply hits all 3', true)
  const mixed = await page.evaluate(() =>
    [...document.querySelectorAll('.kw-chip')].map((c) =>
      [c.textContent.replace('×', '').trim(), c.classList.contains('is-mixed')]))
  check('mixed-state chips: trip solid, alpha mixed',
    mixed.some(([k, m]) => k === 'trip' && !m) && mixed.some(([k, m]) => k === 'alpha' && m))

  // ── watermark export + EXIF carry-over (single photo) ────────────────────
  await page.click(`.gcell[data-id="${id0}"]`)
  await page.keyboard.press('ControlOrMeta+KeyE')
  await page.waitForSelector('.exportdlg')
  await page.check('.exp-wm-check input')
  await page.waitForSelector('.exp-corners')
  await page.click('.exp-corners button[aria-label="Corner se"]')
  await page.waitForTimeout(120)
  await page.screenshot({ path: `${shots}/meta-export.png` })
  {
    const dlP = page.waitForEvent('download')
    await page.click('.exportdlg .btn-primary')
    const dl = await dlP
    await page.waitForSelector('.exportdlg', { state: 'detached', timeout: 60000 })
    const wmPath = `${dls}/wm-${dl.suggestedFilename()}`
    await dl.saveAs(wmPath)
    check('watermark export downloads', dl.suggestedFilename() === 'meta0-albedo.jpg')
    // pixel probe: bright text in the SE corner of a dark fixture
    const withWm = cornerMax(wmPath, 'SouthEast', '25%x12%+0+0')
    check(`watermark visible in SE corner (maxima ${withWm.toFixed(2)})`, withWm > 0.45)
    // EXIF carried over, orientation neutralized
    check('exported JPEG carries the camera Model tag', et('-Model', wmPath) === 'Albedo Test Cam')
    check('orientation tag stripped to 1', et('-n -Orientation', wmPath) === '1')
  }
  // control: same corner without watermark stays dark
  {
    const [plain] = await exportRun(page, { wmOff: true })
    const noWm = cornerMax(plain.path, 'SouthEast', '25%x12%+0+0')
    check(`no-watermark corner stays dark (maxima ${noWm.toFixed(2)})`, noWm < 0.4)
  }

  // ── {date}/{seq} pattern + live preview ──────────────────────────────────
  await page.click(`.gcell[data-id="${id0}"]`)
  await page.click(`.gcell[data-id="${id1}"]`, { modifiers: ['ControlOrMeta'] })
  await page.keyboard.press('ControlOrMeta+KeyE')
  await page.waitForSelector('.exportdlg')
  await page.fill('.exp-name', '{date}-{seq}')
  check('live filename preview resolves tokens',
    (await page.textContent('.exp-preview')).includes('20230714-001.jpg'))
  {
    const got = []
    page.on('download', (d) => got.push(d))
    await page.click('.exportdlg .btn-primary')
    await page.waitForSelector('.exportdlg', { state: 'detached', timeout: 60000 })
    for (let i = 0; i < 100 && got.length < 2; i++) await page.waitForTimeout(100)
    const names = got.map((d) => d.suggestedFilename()).sort()
    check('{date}-{seq} batch names resolve from capture dates',
      names.join() === '20230714-001.jpg,20240305-002.jpg')
  }

  // ── export presets: save, last-used restore, apply ───────────────────────
  await page.keyboard.press('ControlOrMeta+KeyE')
  await page.waitForSelector('.exportdlg')
  check('last-used settings auto-restore (pattern)',
    (await page.inputValue('.exp-name')) === '{date}-{seq}')
  await page.fill('.exp-name', '{name}-web')
  await page.click('.exp-preset-save')
  await page.fill('.exp-preset-name', 'Web')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.exp-preset option')].some((o) => o.value === 'Web'))
  check('preset saved into the dropdown', true)
  await page.keyboard.press('Escape')
  await page.waitForSelector('.exportdlg', { state: 'detached' })
  await page.keyboard.press('ControlOrMeta+KeyE')
  await page.waitForSelector('.exportdlg')
  await page.fill('.exp-name', '{name}')
  await page.selectOption('.exp-preset', 'Web')
  await page.waitForFunction(() => document.querySelector('.exp-name')?.value === '{name}-web')
  check('choosing a preset applies its settings', true)
  await page.keyboard.press('Escape')
  await page.waitForSelector('.exportdlg', { state: 'detached' })

  // ── backup: zip carries sidecars + manifest ──────────────────────────────
  await page.evaluate(([pid]) => window.__albedoMeta.saveDocNow(pid, {
    versionId: 'v_default', photoId: pid, modules: { exposure: { ev: 0.5 } },
  }), [id0])
  await page.click('.nav-io:has-text("Back up catalog")')
  await page.waitForSelector('.confirmdlg')
  check('backup confirm notes originals are excluded',
    (await page.textContent('.confirm-body')).includes('NOT included'))
  const zipP = page.waitForEvent('download')
  await page.click('.confirmdlg .btn-primary')
  const zipDl = await zipP
  const zipPath = `${dls}/${zipDl.suggestedFilename()}`
  await zipDl.saveAs(zipPath)
  const stamp = new Date()
  const ymd = `${stamp.getFullYear()}${String(stamp.getMonth() + 1).padStart(2, '0')}${String(stamp.getDate()).padStart(2, '0')}`
  check('backup zip named albedo-backup-YYYYMMDD.zip',
    zipDl.suggestedFilename() === `albedo-backup-${ymd}.zip`)
  {
    const entries = zipRead(new Uint8Array(readFileSync(zipPath)))
    const names = entries.map((e) => e.name)
    check('zip contains the edit sidecar + manifest + smarts',
      names.includes(`edits/${id0}/v_default.json`) &&
      names.includes('manifest.json') && names.includes('smarts.json'))
    const manifest = JSON.parse(new TextDecoder().decode(
      entries.find((e) => e.name === 'manifest.json').data))
    check('manifest maps photo ids to filenames',
      manifest.photos.some((p) => p.id === id0 && p.filename === 'meta0.jpg'))
  }

  // ── restore roundtrip: fresh profile (new ids) + filename remap ──────────
  const ctx2 = await browser.newContext({ colorScheme: 'dark', viewport: { width: 1600, height: 900 } })
  const page2 = await ctx2.newPage()
  page2.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page2.on('pageerror', (e) => errors.push(String(e)))
  const byName2 = await importAll(page2)
  const newId0 = byName2['meta0.jpg']
  check('fresh profile mints a different id', newId0 !== id0)
  const preDoc = await page2.evaluate((pid) => window.__albedoMeta.loadDoc(pid), newId0)
  check('fresh profile has no edit doc yet', preDoc == null)
  const fcP = page2.waitForEvent('filechooser')
  await page2.click('.nav-io:has-text("Restore backup")')
  await (await fcP).setFiles(zipPath)
  // the import toast may still be up — wait for the restore one specifically
  await page2.waitForFunction(() =>
    [...document.querySelectorAll('.toast .toast-msg')].some((t) => /Restored/.test(t.textContent)))
  const toastMsg = await page2.evaluate(() =>
    [...document.querySelectorAll('.toast .toast-msg')].map((t) => t.textContent)
      .find((t) => /Restored/.test(t)))
  check(`restore toast reports counts (${toastMsg})`, /Restored 1 edit/.test(toastMsg))
  const restoredDoc = await page2.evaluate((pid) => window.__albedoMeta.loadDoc(pid), newId0)
  check('restored edit doc lands on the remapped photo id',
    restoredDoc?.modules?.exposure?.ev === 0.5 && restoredDoc?.photoId === newId0)
  await ctx2.close()

  check('no console errors', errors.length === 0)
  if (errors.length) console.log(errors.join('\n'))
  await browser.close()
} finally {
  srv.kill()
}
process.exit(failed ? 1 : 0)
