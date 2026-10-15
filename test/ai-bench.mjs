// Real-GPU AI timings: xvfb-run -a node test/ai-bench.mjs <photo.jpg> [x y] [outdir]
import { chromium } from 'playwright'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { ensureServer } from './server.mjs'

const [file, x = '0.5', y = '0.5', outDir] = process.argv.slice(2)
const PORT = 5195
await ensureServer(PORT)
const srv = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  fs.createReadStream(file).on('error', () => { res.statusCode = 404; res.end() }).pipe(res)
}).listen(5196)
const browser = await chromium.launch({
  headless: false, channel: 'chromium',
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--ignore-gpu-blocklist'],
})
const page = await browser.newPage()
const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)) })
await page.goto(`http://localhost:${PORT}/test/ai.html?src=${encodeURIComponent('http://localhost:5196/p.jpg')}&x=${x}&y=${y}`)
await page.waitForFunction(() => document.getElementById('out').textContent.length > 0, null, { timeout: 600000 })
console.log(await page.textContent('#out'), errors.length ? JSON.stringify(errors) : '')
if (outDir) {
  const ai = await page.evaluate(() => window.__ai)
  const pgm = (name, { w, h, data }) => fs.writeFileSync(path.join(outDir, `${name}.pgm`),
    Buffer.concat([Buffer.from(`P5 ${w} ${h} 255\n`), Buffer.from(data)]))
  for (const k of ['subject', 'sky', 'object']) if (ai[k]) pgm(k, ai[k])
  if (ai.remove) {
    const { w, h, rgba } = ai.remove
    const rgb = Buffer.alloc(w * h * 3)
    for (let i = 0; i < w * h; i++) { rgb[i * 3] = rgba[i * 4]; rgb[i * 3 + 1] = rgba[i * 4 + 1]; rgb[i * 3 + 2] = rgba[i * 4 + 2] }
    fs.writeFileSync(path.join(outDir, 'remove.ppm'), Buffer.concat([Buffer.from(`P6 ${w} ${h} 255\n`), rgb]))
  }
}
await browser.close()
srv.close()
process.exit(0)
