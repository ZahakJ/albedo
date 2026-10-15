// Workflow layer e2e: presets (save / apply / hover-preview), copy-paste
// settings across the library, ⌘K palette, '?' cheat-sheet, persistence.
// Spawns its own dev server on 5185.
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
for (let i = 0; i < 4; i++) {
  const f = `${fx}/fx${i}.jpg`
  const [w, h] = i % 3 === 0 ? [420, 560] : [560, 400]
  if (!existsSync(f))
    execSync(
      `magick -size ${w}x${h} gradient:'hsl(${i * 45},45%,38%)'-'hsl(${(i * 45 + 60) % 360},50%,14%)' ` +
      `-font Adwaita-Sans-Bold -fill 'rgba(255,255,255,0.85)' -gravity center -pointsize 110 -annotate 0 '${i + 1}' ${f}`)
  files.push(f)
}

const srv = spawnVite('5185', { cwd: root, stdio: 'ignore' })
const up = async () => {
  for (let i = 0; i < 100; i++) {
    try { await fetch('http://localhost:5185/'); return } catch { await new Promise((r) => setTimeout(r, 200)) }
  }
  throw new Error('dev server never came up on 5185')
}

let failed = 0
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) failed++ }
const doc = (page) => page.evaluate(() => window.__albedo.edit().doc)
const openId = (page) => page.evaluate(() => window.__albedo.edit().photo?.id ?? null)

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
  await page.waitForFunction(() => document.querySelectorAll('.gcell').length === 4)
  await page.click(`.gcell[data-id="${id}"]`)
  await page.keyboard.press('d')
  await page.waitForFunction((want) => window.__albedo.edit().photo?.id === want, id, { timeout: 15000 })
  await page.waitForFunction(
    () => parseInt(document.querySelector('.develop-canvas')?.style.width || 0) > 20,
    null, { timeout: 15000 })
}

try {
  await up()
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader'],
  })
  const ctx = await browser.newContext({ colorScheme: 'dark', viewport: { width: 1440, height: 900 } })
  // count params sends to the render worker: hover-preview must churn renders
  // without ever touching the committed doc
  await ctx.addInitScript(() => {
    const Native = window.Worker
    window.__paramsCount = 0
    window.Worker = class extends Native {
      constructor(url, opts) {
        super(url, opts)
        if (String(url).includes('render.worker')) {
          const orig = this.postMessage.bind(this)
          this.postMessage = (msg, t) => {
            if (msg?.type === 'params') window.__paramsCount++
            return orig(msg, t)
          }
        }
      }
    }
  })
  const page = await ctx.newPage()
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))

  await page.goto('http://localhost:5185/')
  await page.waitForSelector('text=Drop photos here')
  await page.setInputFiles('input[type=file]', files)
  await page.waitForFunction(() => document.querySelectorAll('.gcell').length === 4, null, { timeout: 30000 })
  const ids = await page.$$eval('.gcell', (els) => els.map((el) => el.dataset.id))
  const [idA, idB, idC, idD] = ids

  // ── develop A: exposure + a mixer band ───────────────────────────────────
  await openInDevelop(page, idA)
  await scrub(page, page.locator('.sec[data-sec=tone] .slider').first(), 60)
  await scrub(page, page.locator('.mix-red .slider'), 55)
  let d = await doc(page)
  const ev = d.modules.exposure?.ev ?? 0
  const redH = d.modules.colormix?.red?.h ?? 0
  check('exposure + mixer band committed on A', ev > 0 && redH > 0)

  // ── save preset: prechecked to non-default groups (Tone + Mixer) ─────────
  await page.click('.preset-add')
  const states = await page.$$eval('.preset-groups input', (els) => els.map((el) => el.checked))
  check('save row prechecks exactly Tone + Mixer',
    states.length === 6 && states[0] && states[4] && !states[1] && !states[2] && !states[3] && !states[5])
  await page.fill('.preset-save .preset-edit', 'warm shift')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.preset-row:not(.is-builtin)')
  check('preset appears in rail', (await page.textContent('.preset-row:not(.is-builtin) .preset-name')) === 'warm shift')

  // rail screenshot while the save state is fresh
  await page.waitForTimeout(200)
  await page.screenshot({ path: `${shots}/workflow-rail.png` })

  // ── apply preset by click on B ───────────────────────────────────────────
  await openInDevelop(page, idB)
  await page.click('.preset-row:not(.is-builtin)')
  await page.waitForFunction(() => !!window.__albedo.edit().doc.modules.exposure)
  d = await doc(page)
  check('apply matches subset (exposure + colormix only)',
    d.modules.exposure?.ev === ev && d.modules.colormix?.red?.h === redH &&
    Object.keys(d.modules).sort().join() === 'colormix,exposure')
  check('apply is one history entry', await page.evaluate(() => {
    const s = window.__albedo.edit()
    return s.historyAt === 1 && s.history.length === 2
  }))

  // ── hover-preview on C: render churn, doc untouched ──────────────────────
  await openInDevelop(page, idC)
  const before = await page.evaluate(() => window.__paramsCount)
  const beforeDoc = JSON.stringify(await doc(page))
  await page.hover('.preset-row:not(.is-builtin)')
  await page.waitForTimeout(250)
  const during = await page.evaluate(() => window.__paramsCount)
  check('hover-preview sends params', during > before)
  check('hover-preview leaves doc untouched', JSON.stringify(await doc(page)) === beforeDoc)
  await page.mouse.move(720, 450) // leave the rail → restore send
  await page.waitForTimeout(250)
  check('mouse-leave restores without commit', JSON.stringify(await doc(page)) === beforeDoc)

  // ── ⌘C on B → ⌘V onto a 2-photo library selection ────────────────────────
  await openInDevelop(page, idB)
  await page.keyboard.press('ControlOrMeta+KeyC')
  await page.waitForSelector('.copydlg')
  check('⌘C opens copy dialog', true)
  await page.keyboard.press('Enter')
  await page.waitForSelector('.copydlg', { state: 'detached' })

  await page.keyboard.press('g')
  await page.waitForFunction(() => document.querySelectorAll('.gcell').length === 4)
  await page.click(`.gcell[data-id="${idC}"]`)
  await page.click(`.gcell[data-id="${idD}"]`, { modifiers: ['ControlOrMeta'] })
  const flashP = page.waitForSelector('.gcell.paste-flash', { timeout: 2000 }).then(() => true, () => false)
  await page.keyboard.press('ControlOrMeta+KeyV')
  check('paste flashes the affected cells', await flashP)
  await page.waitForTimeout(900) // let the 500ms write-behind flush

  // ── reload: pasted docs persisted ────────────────────────────────────────
  await page.reload()
  await page.waitForFunction(() => document.querySelectorAll('.gcell').length === 4, null, { timeout: 30000 })
  for (const [label, id] of [['C', idC], ['D', idD]]) {
    const saved = await page.evaluate((pid) => window.__albedo.loadDoc(pid), id)
    check(`paste persisted on ${label}`,
      saved?.modules?.exposure?.ev === ev && saved?.modules?.colormix?.red?.h === redH)
  }

  // preset list persisted too (sidecar + table)
  await page.waitForFunction(() => document.querySelectorAll('.preset-row:not(.is-builtin)').length === 1, null, { timeout: 15000 })
  check('preset survives reload', (await page.textContent('.preset-row:not(.is-builtin) .preset-name')) === 'warm shift')

  // ── ⌘K palette: 'rej' + Enter rejects the selection ──────────────────────
  await page.click(`.gcell[data-id="${idD}"]`)
  // park the pointer: a palette row under it would take the highlight on hover
  await page.mouse.move(2, 2)
  await page.keyboard.press('ControlOrMeta+KeyK')
  await page.waitForSelector('.palette')
  await page.keyboard.type('rej')
  await page.waitForFunction(() =>
    document.querySelector('.pal-row.is-at .pal-title')?.textContent === 'Reject')
  await page.waitForTimeout(150)
  await page.screenshot({ path: `${shots}/workflow-palette.png` })
  await page.keyboard.press('Enter')
  await page.waitForSelector('.palette', { state: 'detached' })
  await page.waitForSelector(`.gcell[data-id="${idD}"].is-rejected`)
  check('palette Enter rejects selected', true)

  // ── '?' cheat-sheet: opens, any key dismisses ────────────────────────────
  await page.keyboard.press('?')
  await page.waitForSelector('.cheat-card')
  check('? opens cheat-sheet', true)
  await page.waitForTimeout(150)
  await page.screenshot({ path: `${shots}/workflow-cheatsheet.png` })
  await page.keyboard.press('a')
  await page.waitForSelector('.cheat-card', { state: 'detached' })
  check('any key dismisses cheat-sheet', true)

  check('no console errors', errors.length === 0)
  if (errors.length) console.log(errors.join('\n'))
  await browser.close()
} finally {
  srv.kill()
}
process.exit(failed ? 1 : 0)
