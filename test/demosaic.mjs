// Demosaic quality: node test/demosaic.mjs <dir of truth PNGs> — every image
// through a Bayer and an X-Trans mosaic, PSNR (dB) of albedo's demosaic and
// of bilinear / Malvar-He-Cutler baselines on the same mosaic.
import { chromium } from 'playwright'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { ensureServer } from './server.mjs'

const dir = process.argv[2]
const PORT = 5195
await ensureServer(PORT)
const srv = http.createServer((q, r) => {
  r.setHeader('Access-Control-Allow-Origin', '*')
  fs.createReadStream(path.join(dir, path.basename(q.url))).on('error', () => { r.statusCode = 404; r.end() }).pipe(r)
}).listen(5196)
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--use-angle=swiftshader'] })
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.png')).sort()) {
  for (const cfa of ['bayer', 'xtrans']) {
    const page = await browser.newPage()
    await page.goto(`http://localhost:${PORT}/test/demosaic.html?backend=webgl2&cfa=${cfa}&src=${encodeURIComponent(`http://localhost:5196/${f}`)}`)
    await page.waitForFunction(() => document.getElementById('out').textContent.length > 0, null, { timeout: 300000 })
    console.log(JSON.stringify({ file: f, ...JSON.parse(await page.textContent('#out')) }))
    await page.close()
  }
}
await browser.close()
srv.close()
process.exit(0)
