// CANVAS surface e2e: blank doc → brush/undo (pixel probes) → multiply blend +
// opacity math → selection-clipped fill → text layer → reorder → ⌘T scale →
// save/reload/recent-docs/reopen → 'Edit in Canvas' from Develop → flattened
// PNG export. Spawns its own dev server on 5191.
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

const photoFx = `${fx}/cv0.jpg`
if (!existsSync(photoFx))
  execSync(`magick -size 640x480 gradient:'hsl(210,50%,45%)'-'hsl(30,60%,20%)' ` +
    `-font Adwaita-Sans-Bold -fill 'rgba(255,255,255,0.85)' -gravity center -pointsize 120 -annotate 0 'CV' ${photoFx}`)

const srv = spawnVite('5191', { cwd: root, stdio: 'ignore' })
const up = async () => {
  for (let i = 0; i < 100; i++) {
    try { await fetch('http://localhost:5191/'); return } catch { await new Promise((r) => setTimeout(r, 200)) }
  }
  throw new Error('dev server never came up on 5191')
}

let failed = 0
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) failed++ }
const near = (v, want, tol) => Math.abs(v - want) <= tol

try {
  await up()
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader'],
  })
  const ctx = await browser.newContext({ colorScheme: 'dark', viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))

  const cvState = () => page.evaluate(() => window.__albedo.canvas.state())
  const cvDoc = () => page.evaluate(() => window.__albedo.canvas.getDoc())
  const px = (x, y) => page.evaluate(([x, y]) => window.__albedo.canvas.getCompositePixel(x, y), [x, y])
  const bounds = (id) => page.evaluate((lid) => window.__albedo.canvas.getLayerBounds(lid), id)
  const docToScreen = (x, y) => page.evaluate(([x, y]) => {
    const r = document.querySelector('.canvas-stage').getBoundingClientRect()
    const v = window.__albedo.canvas.state().view
    return [r.left + v.offX + x * v.zoom, r.top + v.offY + y * v.zoom]
  }, [x, y])
  const dragDoc = async (x0, y0, x1, y1, steps = 14) => {
    const a = await docToScreen(x0, y0)
    const b = await docToScreen(x1, y1)
    await page.mouse.move(a[0], a[1])
    await page.mouse.down()
    await page.mouse.move(b[0], b[1], { steps })
    await page.mouse.up()
  }
  const clickDoc = async (x, y) => {
    const [sx, sy] = await docToScreen(x, y)
    await page.mouse.click(sx, sy)
  }
  const setColor = (hex) => page.locator('.rail-fg input').evaluate((el, v) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }, hex)
  const tool = (id) => page.click(`.rail-tool[data-tool=${id}]`)
  const layersLen = () => page.evaluate(() => window.__albedo.canvas.state().doc?.layers.length ?? 0)

  await page.goto('http://localhost:5191/')
  await page.waitForSelector('text=Drop photos here')
  await page.waitForFunction(() => !!window.__albedo?.canvas)

  // ── surface + blank document ─────────────────────────────────────────────
  await page.keyboard.press('e')
  await page.waitForSelector('.cv-recent')
  check('E opens the Canvas surface (recent docs view)',
    await page.locator('.seg-btn', { hasText: 'Canvas' }).getAttribute('aria-selected') === 'true')

  await page.click('.cv-new-doc')
  await page.waitForSelector('.newdocdlg')
  await page.fill('.newdoc-field:nth-of-type(1) .newdoc-px', '800')
  await page.fill('.newdoc-field:nth-of-type(2) .newdoc-px', '600')
  await page.selectOption('.newdoc-bg', 'black')
  await page.click('.newdoc-create')
  await page.waitForFunction(() => window.__albedo.canvas.state().doc?.width === 800)
  const st0 = await cvState()
  check('blank 800×600 doc with one background layer',
    st0.doc.height === 600 && st0.doc.layers.length === 1)
  check('background layer is black', ((await px(200, 100))[0] < 8) && ((await px(200, 100))[3] === 255))

  // ── brush stroke + undo/redo ─────────────────────────────────────────────
  await tool('brush')
  await dragDoc(100, 100, 300, 100)
  await page.waitForFunction(() => window.__albedo.canvas.state().history.labels.includes('Brush'))
  let p = await px(200, 100)
  check('brush stroke paints white along the path', p[0] > 200 && p[1] > 200 && p[2] > 200)
  check('off-path pixels untouched', (await px(200, 300))[0] < 8)

  await page.keyboard.press('ControlOrMeta+KeyZ')
  await page.waitForFunction(() => !window.__albedo.canvas.state().history.labels.includes('Brush'))
  check('⌘Z reverts the stroke (pixel probe)', (await px(200, 100))[0] < 8)
  await page.keyboard.press('ControlOrMeta+Shift+KeyZ')
  await page.waitForFunction(() => window.__albedo.canvas.state().history.labels.includes('Brush'))
  check('⇧⌘Z restores the stroke', (await px(200, 100))[0] > 200)

  // ── second layer: multiply blend + opacity math ──────────────────────────
  await page.click('.sec[data-sec=cv-layers] .sec-actions .sec-btn:first-child') // new layer
  await page.waitForFunction(() => window.__albedo.canvas.state().doc?.layers.length === 2)
  await setColor('#808080')
  await tool('fill')
  await clickDoc(400, 300) // no selection → fills the whole layer
  await page.waitForFunction(() => window.__albedo.canvas.state().history.labels.includes('Fill'))
  await page.selectOption('.blend-select', 'multiply')
  await page.waitForFunction(() =>
    window.__albedo.canvas.state().doc.layers[1].blend === 'multiply')
  p = await px(200, 100)
  check('multiply blend darkens white → mid gray (pixel math)', near(p[0], 128, 14) && near(p[1], 128, 14))

  await page.click('.layer-ctl .slider-value')
  await page.fill('.layer-ctl .slider-input', '50')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() =>
    Math.abs(window.__albedo.canvas.state().doc.layers[1].opacity - 0.5) < 0.01)
  p = await px(200, 100)
  check('opacity 50 halves the multiply effect', near(p[0], 191, 14))

  await page.click('.sec[data-sec=cv-layers] .sec-actions .layer-del')
  await page.waitForFunction(() => window.__albedo.canvas.state().doc?.layers.length === 1)
  check('delete layer restores the composite', (await px(200, 100))[0] > 200)

  // ── rect selection restricts a fill ──────────────────────────────────────
  await page.click('.sec[data-sec=cv-layers] .sec-actions .sec-btn:first-child')
  await page.waitForFunction(() => window.__albedo.canvas.state().doc?.layers.length === 2)
  await tool('select')
  await dragDoc(400, 300, 500, 400)
  await page.waitForFunction(() => window.__albedo.canvas.state().doc?.selection?.shapes.length === 1)
  check('marching ants overlay is up', await page.locator('.ants-over').count() === 1)
  await page.screenshot({ path: `${shots}/canvas-ants.png` })
  await setColor('#ff0000')
  await tool('fill')
  await clickDoc(450, 350)
  await page.waitForFunction(() =>
    window.__albedo.canvas.state().history.labels.filter((l) => l === 'Fill').length === 1)
  p = await px(450, 350)
  check('fill lands inside the selection', p[0] > 200 && p[1] < 40)
  check('fill is clipped outside the selection', (await px(350, 350))[0] < 8)
  await page.keyboard.press('ControlOrMeta+KeyD')
  await page.waitForFunction(() => !window.__albedo.canvas.state().doc?.selection)
  check('⌘D deselects', true)

  // ── text layer ───────────────────────────────────────────────────────────
  await tool('text')
  await clickDoc(100, 400)
  await page.waitForSelector('.cv-text-edit')
  await page.keyboard.type('Hello')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => window.__albedo.canvas.state().doc?.layers.length === 3)
  const textLayer = (await cvDoc()).layers.find((l) => l.kind === 'text')
  check('text layer created with content', textLayer?.text.content === 'Hello')
  const tb = await bounds(textLayer.id)
  check('text layer has real glyph bounds', tb.w > 40 && tb.h > 20)
  const textHit = await page.evaluate(async ([x0, y0, x1, y1]) => {
    for (let y = y0; y < y1; y += 4) {
      for (let x = x0; x < x1; x += 4) {
        const p = await window.__albedo.canvas.getCompositePixel(x, y)
        if (p[0] > 120 && p[1] < 80) return true // red glyph pixel over black
      }
    }
    return false
  }, [tb.x, tb.y, tb.x + tb.w, tb.y + tb.h])
  check('text layer renders (pixel probe at text position)', textHit)

  // ── reorder flips which layer shows ──────────────────────────────────────
  // two rect-filled layers over the same doc region
  const mkRectLayer = async (color) => {
    await page.click('.sec[data-sec=cv-layers] .sec-actions .sec-btn:first-child')
    await tool('select')
    await dragDoc(600, 50, 700, 150)
    await setColor(color)
    await tool('fill')
    await clickDoc(650, 100)
    await page.keyboard.press('ControlOrMeta+KeyD')
  }
  await mkRectLayer('#ff0000')
  await page.waitForFunction(() => window.__albedo.canvas.state().doc?.layers.length === 4)
  await mkRectLayer('#00ff00')
  await page.waitForFunction(() => window.__albedo.canvas.state().doc?.layers.length === 5)
  p = await px(650, 100)
  check('green layer sits on top before reorder', p[1] > 200 && p[0] < 40)
  const ids = (await cvDoc()).layers.map((l) => l.id)
  const redId = ids[3]
  const greenId = ids[4]
  // drag the green row below the red row in the panel
  const greenRow = await page.locator(`.layer-row[data-id="${greenId}"]`).boundingBox()
  const redRow = await page.locator(`.layer-row[data-id="${redId}"]`).boundingBox()
  await page.mouse.move(greenRow.x + 120, greenRow.y + greenRow.height / 2)
  await page.mouse.down()
  await page.mouse.move(redRow.x + 120, redRow.y + redRow.height * 0.8, { steps: 8 })
  await page.mouse.up()
  await page.waitForFunction((rid) =>
    window.__albedo.canvas.state().doc.layers[4].id === rid, redId)
  p = await px(650, 100)
  check('reorder flips which layer shows (red now on top)', p[0] > 200 && p[1] < 40)

  await page.screenshot({ path: `${shots}/canvas-layers.png` })

  // ── ⌘T scale doubles layer bounds ────────────────────────────────────────
  await page.click(`.layer-row[data-id="${redId}"]`)
  await page.waitForFunction((rid) => window.__albedo.canvas.state().doc.activeLayer === rid, redId)
  const b0 = await bounds(redId)
  check('red layer content bounds ≈ 100×100', near(b0.w, 100, 3) && near(b0.h, 100, 3))
  await page.keyboard.press('ControlOrMeta+KeyT')
  await page.waitForSelector('.cv-handle[data-handle=se]')
  const se = await page.locator('.cv-handle[data-handle=se]').boundingBox()
  const target = await docToScreen(b0.x + b0.w / 2 + b0.w, b0.y + b0.h / 2 + b0.h) // 2× from center
  await page.mouse.move(se.x + se.width / 2, se.y + se.height / 2)
  await page.mouse.down()
  await page.mouse.move(target[0], target[1], { steps: 10 })
  await page.mouse.up()
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => window.__albedo.canvas.state().history.labels.includes('Transform'))
  const b1 = await bounds(redId)
  check('⌘T scale doubles layer bounds', near(b1.w, 200, 10) && near(b1.h, 200, 10))

  // ── save → reload → recent docs → reopen ─────────────────────────────────
  const docId = (await cvDoc()).id
  const layerCount = await layersLen()
  await page.keyboard.press('ControlOrMeta+KeyS')
  await page.waitForSelector('text=Canvas document saved')
  check('⌘S saves with a toast', true)

  await page.reload()
  await page.waitForFunction(() => !!window.__albedo?.canvas)
  await page.keyboard.press('e')
  await page.waitForSelector(`.cv-doc-card[data-id="${docId}"]`, { timeout: 15000 })
  check('recent documents grid lists the saved doc', true)
  await page.click(`.cv-doc-card[data-id="${docId}"] .cv-doc-open`)
  await page.waitForFunction((id) => window.__albedo.canvas.state().doc?.id === id, docId)
  check('reopened doc keeps its layers', await layersLen() === layerCount)
  check('reopened pixels intact: stroke', (await px(200, 100))[0] > 200)
  p = await px(650, 100)
  check('reopened pixels intact: red over green', p[0] > 200 && p[1] < 40)

  // ── 'Edit in Canvas' from Develop ────────────────────────────────────────
  await page.setInputFiles('input[type=file]', [photoFx])
  await page.waitForFunction(() => window.__albedo.catalog().photos.length === 1, null, { timeout: 30000 })
  await page.keyboard.press('g')
  await page.waitForSelector('.gcell')
  await page.click('.gcell')
  await page.keyboard.press('d')
  await page.waitForFunction(() => window.__albedo.edit().photo != null, null, { timeout: 20000 })
  await page.waitForFunction(
    () => parseInt(document.querySelector('.develop-canvas')?.style.width || 0) > 20,
    null, { timeout: 15000 })
  await page.click('.edit-in-canvas')
  await page.waitForFunction(() =>
    window.__albedo.view().surface === 'canvas' &&
    window.__albedo.canvas.state().doc?.width === 640 &&
    window.__albedo.canvas.state().doc?.height === 480, null, { timeout: 30000 })
  const photoDoc = await cvDoc()
  check('Edit in Canvas lands a base layer at developed dims',
    photoDoc.layers.length === 1 && photoDoc.layers[0].kind === 'raster')
  p = await px(320, 240)
  check('base layer carries the developed pixels', p[3] === 255 && (p[0] + p[1] + p[2]) > 30)

  await page.screenshot({ path: `${shots}/canvas-photo.png` })

  // ── flatten export downloads a PNG with correct dims ─────────────────────
  const dlP = page.waitForEvent('download')
  await page.keyboard.press('ControlOrMeta+KeyE')
  const dl = await dlP
  const out = `${shots}/canvas-export.png`
  await dl.saveAs(out)
  const [w, h, fmt] = execSync(`magick identify -format "%w %h %m" "${out}"`).toString().trim().split(' ')
  check('⌘E exports a flattened PNG at doc dims',
    fmt === 'PNG' && +w === 640 && +h === 480 && dl.suggestedFilename().endsWith('.png'))

  check('no console errors', errors.length === 0)
  if (errors.length) console.log(errors.join('\n'))
  await browser.close()
} finally {
  srv.kill()
}
process.exit(failed ? 1 : 0)
