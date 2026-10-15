// Presets e2e: built-in looks in the rail, apply a preset to many photos
// (palette + context menu), preset files in and out (albedo .json with a
// version, Lightroom .xmp), Lightroom sidecars applied on photo import, and
// persistence across a reload. Spawns its own dev server on 5193.
import { chromium } from 'playwright'
import { execSync, spawn } from 'node:child_process'
import { mkdirSync, existsSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawnVite } from './server.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const fx = `${root}test/fixtures/presets`
const xmpFx = `${root}test/unit/fixtures/xmp`
mkdirSync(fx, { recursive: true })

const photos = []
for (let i = 0; i < 3; i++) {
  const f = `${fx}/ps${i}.jpg`
  if (!existsSync(f))
    execSync(`magick -size 480x320 gradient:'hsl(${i * 90 + 20},45%,45%)'-'hsl(${i * 90 + 80},40%,15%)' ${f}`)
  photos.push(f)
}
// a Lightroom sidecar that pairs with ps0.jpg by name
copyFileSync(`${xmpFx}/jpeg-sidecar.xmp`, `${fx}/ps0.xmp`)
// preset files for the rail's Import…
const jsonPreset = `${fx}/travel.albedo.json`
writeFileSync(jsonPreset, JSON.stringify({
  format: 'albedo-presets', version: 1,
  presets: [{ name: 'Dusk', group: 'Travel', modules: { vibsat: { vibrance: 33, saturation: 0 } } }],
}))
const xmpPreset = `${fx}/Grade.xmp`
copyFileSync(`${xmpFx}/colorgrade.xmp`, xmpPreset)

const PORT = 5193
const srv = spawnVite(String(PORT), { cwd: root, stdio: 'ignore' })
const up = async () => {
  for (let i = 0; i < 100; i++) {
    try { await fetch(`http://localhost:${PORT}/`); return } catch { await new Promise((r) => setTimeout(r, 200)) }
  }
  throw new Error(`dev server never came up on ${PORT}`)
}

let failed = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` ${extra}`}`)
  if (!ok) failed++
}

try {
  await up()
  const browser = await chromium.launch({ args: ['--no-sandbox', '--use-angle=swiftshader'] })
  const ctx = await browser.newContext({ colorScheme: 'dark', viewport: { width: 1440, height: 900 }, acceptDownloads: true })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  const toasts = () => page.$$eval('.toast', (els) => els.map((e) => e.textContent).join(' | '))
  const docOf = (id) => page.evaluate((i) => window.__albedo.loadDoc(i), id)

  await page.goto(`http://localhost:${PORT}/?backend=webgl2`)
  await page.waitForSelector('text=Drop photos here')

  // ── photos + a Lightroom sidecar in one drop ─────────────────────────────
  await page.setInputFiles('input[type=file]', [...photos, `${fx}/ps0.xmp`])
  await page.waitForFunction(() => document.querySelectorAll('.gcell').length === 3, null, { timeout: 30000 })
  await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => /Imported 3 photos/.test(t.textContent)))
  check('import toast counts the Lightroom edit', /1 with Lightroom edits/.test(await toasts()), await toasts())
  const byName = await page.evaluate(() =>
    Object.fromEntries(window.__albedo.catalog().photos.map((p) => [p.name, p.id])))
  await page.waitForTimeout(800) // saveDoc debounce
  const side = await docOf(byName['ps0.jpg'])
  check('sidecar edit landed on its photo', side?.modules?.wb != null && side.modules.wb.temp !== 0,
    JSON.stringify(side?.modules))
  check('photos without a sidecar stay clean', (await docOf(byName['ps1.jpg'])) == null ||
    Object.keys((await docOf(byName['ps1.jpg'])).modules).length === 0)

  // ── apply a built-in to many from the palette ────────────────────────────
  await page.click(`.gcell[data-id="${byName['ps0.jpg']}"]`)
  await page.click(`.gcell[data-id="${byName['ps2.jpg']}"]`, { modifiers: ['Shift'] })
  await page.waitForFunction(() => window.__albedo.view().selection.size === 3)
  await page.keyboard.press('Control+k')
  await page.keyboard.type('Apply Preset: Punchy')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(900)
  const punchy = await Promise.all(['ps0.jpg', 'ps1.jpg', 'ps2.jpg'].map((n) => docOf(byName[n])))
  check('palette applies a preset to every selected photo',
    punchy.every((d) => d?.modules?.tone?.contrast === 25), JSON.stringify(punchy.map((d) => d?.modules?.tone)))
  check('the preset leaves modules it does not cover (sidecar WB stays)',
    punchy[0]?.modules?.wb?.temp === side.modules.wb.temp)

  // ── context menu: Apply Preset ▸ B&W Classic on one photo ────────────────
  await page.click(`.gcell[data-id="${byName['ps1.jpg']}"]`)
  await page.click(`.gcell[data-id="${byName['ps1.jpg']}"]`, { button: 'right' })
  await page.click('.cmenu >> text=Apply Preset')
  await page.click('.cmenu >> text=B&W Classic')
  await page.waitForTimeout(900)
  const bw = await docOf(byName['ps1.jpg'])
  check('context menu applies a look', bw?.modules?.bw?.on === 1 && bw.modules.tone.contrast === 15)
  check('a look replaces the previous look', (bw?.modules?.vibsat?.vibrance ?? 0) === 0)

  // ── rail: built-ins listed, import .json + .xmp, export ──────────────────
  await page.dblclick(`.gcell[data-id="${byName['ps2.jpg']}"]`)
  await page.waitForSelector('.preset-row.is-builtin')
  check('rail lists the built-in looks', (await page.locator('.preset-row.is-builtin').count()) >= 6)
  const chooser = page.waitForEvent('filechooser')
  await page.click('.preset-io >> text=Import…')
  await (await chooser).setFiles([jsonPreset, xmpPreset])
  await page.waitForFunction(() => document.querySelectorAll('.preset-row:not(.is-builtin)').length === 2, null, { timeout: 10000 })
  const names = await page.$$eval('.preset-row:not(.is-builtin) .preset-name', (els) => els.map((e) => e.textContent))
  check('imported presets appear', names.includes('Dusk') && names.length === 2, names.join(','))
  const heads = await page.$$eval('.preset-group-head', (els) => els.map((e) => e.textContent))
  check('groups come from the file and from XMP', heads.includes('Travel') && heads.includes('Imported') && heads.includes('Built-in'),
    heads.join(','))
  check('import toast is one line', /Imported 2 presets/.test(await toasts()), await toasts())

  await page.click('.preset-row:not(.is-builtin) >> text=Dusk')
  await page.waitForFunction(() => window.__albedo.edit().doc?.modules?.vibsat?.vibrance === 33)
  check('click applies an imported preset in Develop', true)

  const dl = page.waitForEvent('download')
  await page.click('.preset-io >> text=Export all')
  const file = await (await dl).path()
  const out = JSON.parse(readFileSync(file, 'utf8'))
  check('export is a versioned albedo preset file',
    out.format === 'albedo-presets' && out.version === 1 && out.presets.length === 2,
    JSON.stringify(out).slice(0, 200))
  check('export carries groups, not local ids',
    out.presets.some((p) => p.group === 'Travel') && out.presets.every((p) => !('id' in p)))

  // ── persistence ───────────────────────────────────────────────────────────
  await page.reload()
  await page.waitForSelector('.gcell')
  await page.dblclick('.gcell >> nth=0')
  await page.waitForFunction(() => document.querySelectorAll('.preset-row:not(.is-builtin)').length === 2, null, { timeout: 15000 })
  const persisted = await page.evaluate(() => window.__albedo.presets().presets.map((p) => [p.name, p.group, p.source]))
  check('presets survive reload with group and source',
    persisted.some(([n, g, s]) => n === 'Dusk' && g === 'Travel' && s === 'import') &&
    persisted.some(([, g, s]) => g === 'Imported' && s === 'xmp'), JSON.stringify(persisted))

  check('no page errors', errors.length === 0, errors.join('\n'))
  await browser.close()
} catch (err) {
  console.error(err)
  failed++
} finally {
  srv.kill()
}
process.exit(failed ? 1 : 0)
