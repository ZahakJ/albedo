// RAW pipeline e2e: drives test/raw.html on both backends and asserts the
// decode → demosaic → develop → export chain produces a plausible image.
// Prereq: dev server on :5181 (npx vite --port 5181) + test/fixtures/sample.cr2.
import { chromium } from 'playwright'
import { ensureServer } from './server.mjs'

const PORT = process.env.PORT ?? 5181

await ensureServer(5181)

const run = async (backend, quality, src = '', expectKind = null) => {
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader'],
  })
  const page = await browser.newPage()
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  await page.goto(`http://localhost:${PORT}/test/raw.html?backend=${backend}&quality=${quality}${src && `&src=${src}`}`)
  await page.waitForFunction(() => {
    const t = document.getElementById('out').textContent
    return t.includes('"ok"')
  }, null, { timeout: 120000 })
  const r = JSON.parse(await page.textContent('#out'))
  await browser.close()

  const fails = []
  const check = (cond, label) => { if (!cond) fails.push(label) }
  check(r.ok, `harness: ${r.error}`)
  if (r.ok) {
    check(r.backend === backend, `backend used ${r.backend}, wanted ${backend}`)
    const wantKind = expectKind ?? (quality === 'proxy' ? 'rgb' : 'mosaic')
    check(r.decoded.kind === wantKind, `kind=${r.decoded.kind}, wanted ${wantKind}`)
    check(r.decoded.width > 500 && r.decoded.height > 500, 'decoded dimensions')
    check(r.decoded.exif?.camera?.length > 0, 'exif camera')
    const [mr, mg, mb] = r.export.mean
    check(r.export.nonBlackFrac > 0.5, `non-black frac ${r.export.nonBlackFrac}`)
    const mean = (mr + mg + mb) / 3
    check(mean > 20 && mean < 235, `mean ${mean}`)
    // real scene + WB + camera matrix → channels must differ
    const spread = Math.max(mr, mg, mb) - Math.min(mr, mg, mb)
    check(spread > 2, `channel spread ${spread}`)
  }
  const pass = fails.length === 0
  console.log(`${backend}/${quality}${src && ` (${src.split('/').pop()})`}: ${pass ? 'PASS' : 'FAIL ' + fails.join('; ')}` +
    (r.ok ? ` (decode ${r.decodeMs}ms, open ${r.openMs}ms, export ${r.exportMs}ms,` +
      ` mean ${r.export.mean.map((v) => v.toFixed(1)).join('/')})` : '') +
    (errors.length ? ` console errors: ${errors.join(' | ')}` : ''))
  return { pass, mean: r.ok ? r.export.mean : null }
}

let ok = true
const means = {}
for (const backend of ['webgpu', 'webgl2']) {
  for (const quality of ['full', 'proxy']) {
    const r = await run(backend, quality)
    ok = r.pass && ok
    means[`${backend}/${quality}`] = r.mean
  }
}

// cross-checks: our GPU demosaic+color must agree with libraw's own render,
// and the two backends must agree with each other
const close = (a, b, tol) => a && b && a.every((v, i) => Math.abs(v - b[i]) <= tol)
const xchecks = [
  ['webgpu/full', 'webgpu/proxy', 5, 'GPU mosaic path vs libraw render'],
  ['webgpu/full', 'webgl2/full', 1.5, 'backend parity (full)'],
  ['webgpu/proxy', 'webgl2/proxy', 1.5, 'backend parity (proxy)'],
]
for (const [a, b, tol, label] of xchecks) {
  const p = close(means[a], means[b], tol)
  console.log(`xcheck ${label}: ${p ? 'PASS' : `FAIL ${means[a]} vs ${means[b]}`}`)
  ok = p && ok
}

// more bodies, one backend each: a compressed DNG (mosaic path) and an
// X-Trans RAF (the GPU X-Trans path)
ok = (await run('webgl2', 'full', '/test/fixtures/sample.dng')).pass && ok
ok = (await run('webgpu', 'full', '/test/fixtures/sample.raf', 'xtrans')).pass && ok
process.exit(ok ? 0 : 1)
