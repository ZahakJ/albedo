// Pipeline benchmark driver. Real-GPU numbers need a GPU-backed browser:
//   xvfb-run -a node test/bench.mjs <dir-with-raws> [webgpu,webgl2] [masks]
// Headless Chromium falls back to a software adapter; the run reports the
// adapter so such numbers are recognisable.
import { chromium } from 'playwright'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { ensureServer } from './server.mjs'

const dir = process.argv[2]
const backends = (process.argv[3] ?? 'webgpu,webgl2').split(',')
const masks = +(process.argv[4] ?? 0)
const PORT = 5195
await ensureServer(PORT)

const files = fs.readdirSync(dir).filter((f) => /\.(nef|arw|cr2|cr3|raf|dng|orf|rw2|pef)$/i.test(f)).sort()
const raw = http.createServer((req, res) => {
  const f = path.join(dir, path.basename(decodeURIComponent(req.url)))
  res.setHeader('Access-Control-Allow-Origin', '*')
  fs.createReadStream(f).on('error', () => { res.statusCode = 404; res.end() }).pipe(res)
}).listen(5196)

const browser = await chromium.launch({
  headless: false,
  channel: 'chromium',
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--ignore-gpu-blocklist'],
})
const page0 = await browser.newPage()
await page0.goto(`http://localhost:${PORT}/test/bench.html?probe=1`)
const adapter = await page0.evaluate(async () => {
  const a = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' })
  return a ? `${a.info.vendor} ${a.info.architecture}` : 'none'
})
await page0.close()
console.log(JSON.stringify({ adapter }))

const results = []
for (const f of files) {
  for (const backend of backends) {
    const page = await browser.newPage({ viewport: { width: 1700, height: 1100 } })
    const errors = []
    page.on('console', (m) => { if (m.type() === 'error' || /WebGPU|WGSL|GL_INVALID/.test(m.text())) errors.push(m.text().slice(0, 400)) })
    await page.goto(`http://localhost:${PORT}/test/bench.html?backend=${backend}&masks=${masks}${process.env.PLAIN ? '&plain=1' : ''}${process.env.DN ? `&dn=${process.env.DN}` : ''}${process.env.FMT ? `&fmt=${process.env.FMT}` : ''}${process.env.DCP ? `&dcp=${encodeURIComponent(`http://localhost:5196/${process.env.DCP}`)}` : ''}&src=${encodeURIComponent(`http://localhost:5196/${f}`)}`)
    await page.waitForFunction(() => document.getElementById('out').textContent.includes('"ok"'), null, { timeout: 300000 })
    const r = { file: f, ...JSON.parse(await page.textContent('#out')) }
    if (errors.length) r.errors = errors.slice(0, 3)
    if (process.env.SAVE) {
      const b64 = await page.evaluate(async () => {
        const b = new Uint8Array(await window.__exportBlob.arrayBuffer())
        let s = ''
        for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000))
        return btoa(s)
      })
      fs.writeFileSync(path.join(process.env.SAVE, `${f}.${backend}${process.env.DN ? '.dn' : ''}${process.env.DCP ? '.dcp' : ''}.${process.env.FMT === 'tiff' ? 'tif' : 'jpg'}`), Buffer.from(b64, 'base64'))
    }
    console.log(JSON.stringify(r))
    results.push(r)
    await page.close()
  }
}
await browser.close()
raw.close()
process.exit(0)
