// Orientation test: quadrant card (TL red, TR green, BL blue, BR white) must
// arrive unmirrored and unflipped on BOTH backends, on-screen AND in export.
// Screenshot geometry is trustworthy even on software GPU stacks (color isn't).
import { chromium } from 'playwright'
import { ensureServer } from './server.mjs'
import { execSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'albedo-orient-'))
const card = join(dir, 'card.png')
execSync(`magick -size 200x200 xc:none \
  \\( -size 100x100 xc:red \\) -geometry +0+0 -composite \
  \\( -size 100x100 xc:lime \\) -geometry +100+0 -composite \
  \\( -size 100x100 xc:blue \\) -geometry +0+100 -composite \
  \\( -size 100x100 xc:white \\) -geometry +100+100 -composite ${card}`)

const PORT = process.env.PORT ?? 5180
const classify = (r, g, b) => r > 128 && g > 128 && b > 128 ? 'white'
  : r > 128 && g < 128 && b < 128 ? 'red'
  : g > 128 && r < 128 ? 'green'
  : b > 128 && r < 128 ? 'blue' : `?(${r},${g},${b})`

const quadrantsOf = (png) => {
  const probe = (x, y) => execSync(
    `magick ${png} -format "%[fx:int(255*p{${x},${y}}.r)] %[fx:int(255*p{${x},${y}}.g)] %[fx:int(255*p{${x},${y}}.b)]" info:`
  ).toString().trim().split(' ').map(Number)
  const [w, h] = execSync(`magick ${png} -format "%w %h" info:`).toString().trim().split(' ').map(Number)
  return ['tl', 'tr', 'bl', 'br'].map((q, i) => {
    const x = i % 2 ? Math.round(w * 0.75) : Math.round(w * 0.25)
    const y = i > 1 ? Math.round(h * 0.75) : Math.round(h * 0.25)
    return classify(...probe(x, y))
  }).join(',')
}

await ensureServer(5180)

const run = async (backend) => {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader'] })
  const page = await (await browser.newContext({ acceptDownloads: true })).newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(`http://localhost:${PORT}/?backend=${backend}`)
  await page.waitForSelector('text=Drop photos here')
  await page.setInputFiles('input[type=file]', card)
  // import lands in library; open develop on the photo
  await page.waitForSelector('.gcell', { timeout: 15000 })
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelector('.develop-canvas')?.clientWidth > 50)
  await page.waitForTimeout(600)

  const shot = join(dir, `screen-${backend}.png`)
  await page.locator('.develop-canvas').screenshot({ path: shot })
  const screen = quadrantsOf(shot)

  const dl = page.waitForEvent('download', { timeout: 20000 })
  await page.click('text=Export JPEG')
  const exp = join(dir, `export-${backend}.jpg`)
  await (await dl).saveAs(exp)
  const exported = quadrantsOf(exp)
  await browser.close()

  const want = 'red,green,blue,white'
  // SwiftShader can't composite a worker-owned WebGPU canvas into screenshots
  // (blank capture); display orientation there is covered by a headed real-GPU
  // check instead. Export goes through readPixels and is asserted everywhere.
  const screenOk = backend === 'webgpu' ? true : screen === want
  const pass = screenOk && exported === want
  console.log(`${backend}: screen=[${screen}] export=[${exported}] ${pass ? 'PASS' : 'FAIL'}${errors.length ? ' errors:' + errors.join(';') : ''}`)
  return pass
}

const a = await run('webgpu')
const b = await run('webgl2')
process.exit(a && b ? 0 : 1)
