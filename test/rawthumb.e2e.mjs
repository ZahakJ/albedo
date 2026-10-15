// RAW thumbnail e2e — the suite that would have caught blank RAW cells.
// Every other suite imports synthetic JPEGs; this one drives the three real
// fixtures (Ricoh GR DNG, Canon 350D CR2, Fuji X20 RAF) through both halves of
// the path that was broken: exif.js dimension/preview selection (node), and
// import → grid thumb pixels (browser). Spawns its own dev server on 5192.
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ensureServer } from './server.mjs'
import { parseExif, biggestPreview, parseJpegSof } from '../src/io/exif.js'

const PORT = 5192
const root = fileURLToPath(new URL('..', import.meta.url))
const fx = `${root}test/fixtures`

let failed = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra && ` — ${extra}`}`)
  if (!ok) failed++
}

// ── node section: exif.js against real RAW containers ──────────────────────

// true dims (main image, not the DNG's 160×120 IFD0 thumbnail) + the preview
// each fixture must end up using
const CASES = [
  { file: 'sample.dng', minW: 4000, dims: [4960, 3280], preview: [640, 424] },
  { file: 'sample.cr2', minW: 3000, dims: [3456, 2304], preview: [3456, 2304] },
  { file: 'sample.raf', minW: 3000, dims: [4000, 3000], preview: [2048, 1536] },
]

const exifs = {}
for (const c of CASES) {
  const bytes = readFileSync(`${fx}/${c.file}`)
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  const exif = parseExif(buffer)
  const best = biggestPreview(exif)
  exifs[c.file] = { buffer, exif, best }

  check(`${c.file}: true dims`, exif.width >= c.minW &&
    exif.width === c.dims[0] && exif.height === c.dims[1], `${exif.width}×${exif.height}`)
  check(`${c.file}: previews found`, exif.previews.length > 0, `${exif.previews.length}`)
  check(`${c.file}: every preview has real numeric dims`,
    exif.previews.every((p) => Number.isFinite(p.width) && Number.isFinite(p.height) &&
      p.width > 0 && p.height > 0),
    JSON.stringify(exif.previews.map((p) => [p.width, p.height, p.decodable])))
  check(`${c.file}: biggestPreview is decodable + biggest by AREA`, !!best && best.decodable &&
    best.width === c.preview[0] && best.height === c.preview[1],
    best ? `${best.width}×${best.height} (${best.length}B)` : 'null')
  if (best) {
    const sof = parseJpegSof(new Uint8Array(buffer, best.offset, best.length))
    check(`${c.file}: chosen preview is a baseline/progressive JPEG`,
      !!sof && [0xc0, 0xc1, 0xc2].includes(sof.marker),
      sof ? `SOF${(sof.marker - 0xc0).toString(16)}` : 'no SOF')
  }
}

// the exact regression: the fattest stream in a DNG/CR2 is lossless SOF3 RAW
// strip data. It must be seen, dimensioned, and refused.
for (const file of ['sample.dng', 'sample.cr2']) {
  const { previews } = exifs[file].exif
  const fattest = previews.reduce((a, b) => (b.length > a.length ? b : a))
  check(`${file}: fattest stream is SOF3 and rejected`,
    !fattest.decodable && fattest.length > 5e6, `${fattest.length}B`)
}

// non-RAW must be untouched by the walker changes
{
  const b = readFileSync(`${fx}/meta0.jpg`)
  const x = parseExif(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
  check('meta0.jpg: JPEG dims still come from SOF', x.width === 1200 && x.height === 800,
    `${x.width}×${x.height}`)
  const sof = parseJpegSof(b)
  check('parseJpegSof reads a plain JPEG', sof?.decodable && sof.width === 1200)
}

// ── browser section ────────────────────────────────────────────────────────

await ensureServer(PORT)
const browser = await chromium.launch({ args: ['--no-sandbox'] })
try {
  // fresh profile: a new context gets its own OPFS, so this import is clean
  const page = await (await browser.newContext({
    colorScheme: 'dark', viewport: { width: 1600, height: 900 },
  })).newPage()
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))

  await page.goto(`http://localhost:${PORT}/`)
  await page.waitForSelector('text=Drop photos here')

  // the chosen preview bytes must survive an actual browser decode — node can
  // read a SOF header the engine still refuses
  for (const c of CASES) {
    const { best } = exifs[c.file]
    const got = await page.evaluate(async ({ file, offset, length }) => {
      const buf = await (await fetch(`/test/fixtures/${file}`)).arrayBuffer()
      try {
        const bmp = await createImageBitmap(new Blob([buf.slice(offset, offset + length)]))
        return [bmp.width, bmp.height]
      } catch (err) { return `throw: ${err.message}` }
    }, { file: c.file, offset: best.offset, length: best.length })
    check(`${c.file}: chosen preview createImageBitmaps in-page`,
      Array.isArray(got) && got[0] === c.preview[0] && got[1] === c.preview[1], JSON.stringify(got))
  }

  // ── import the three RAW files ───────────────────────────────────────────
  await page.setInputFiles('input[type=file]', CASES.map((c) => `${fx}/${c.file}`))
  await page.waitForFunction(() => document.querySelectorAll('.gcell').length === 3,
    null, { timeout: 120000 })
  check('grid shows 3 RAW cells', true)
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.gthumb')].filter((i) => i.complete && i.naturalWidth > 0)
      .length === 3, null, { timeout: 120000 })
  check('all 3 RAW thumbs painted', true)

  // decode each painted thumb and demand real image variance: a blank, white
  // or black cell has stddev ≈ 0 and must fail here
  const stats = await page.evaluate(async () => {
    const out = []
    for (const cell of document.querySelectorAll('.gcell')) {
      const img = cell.querySelector('.gthumb')
      const name = window.__albedo.catalog().photos.find((p) => p.id === cell.dataset.id)?.name
      if (!img?.src) { out.push({ name, err: 'no img' }); continue }
      const bmp = await createImageBitmap(await (await fetch(img.src)).blob())
      const c = new OffscreenCanvas(bmp.width, bmp.height)
      c.getContext('2d').drawImage(bmp, 0, 0)
      const d = c.getContext('2d').getImageData(0, 0, bmp.width, bmp.height).data
      let sum = 0, sq = 0
      const n = d.length / 4
      for (let i = 0; i < d.length; i += 4) {
        const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
        sum += l; sq += l * l
      }
      const mean = sum / n
      out.push({ name, id: cell.dataset.id, w: bmp.width, h: bmp.height, mean,
        stddev: Math.sqrt(Math.max(0, sq / n - mean * mean)) })
    }
    return out
  })
  for (const c of CASES) {
    const s = stats.find((r) => r.name === c.file)
    check(`${c.file}: thumb has non-uniform pixels`, !!s && s.stddev > 5,
      s ? `${s.w}×${s.h} mean ${s.mean.toFixed(1)} stddev ${s.stddev.toFixed(1)}` : 'missing')
  }

  // ── metadata panel shows the true megapixel dims for the DNG ─────────────
  const dngId = stats.find((r) => r.name === 'sample.dng')?.id
  await page.click(`.gcell[data-id="${dngId}"]`)
  await page.waitForSelector('.metapanel .meta-rows')
  const panel = await page.textContent('.metapanel')
  check('metadata panel shows the DNG true dims', panel.includes('4960 × 3280'),
    panel.match(/Pixels\s*\S+/)?.[0] ?? 'no Pixels row')
  check('metadata panel does NOT show the 160×120 IFD0 thumbnail dims',
    !panel.includes('160 × 120'))

  // ── fallback: libraw demosaic on the main thread → CAT_SAVE_THUMB ────────
  // (the queue drains automatically for photos with no decodable preview; here
  // it is driven on demand, which is the same code path)
  const fb = await page.evaluate(async (id) => {
    const before = new Uint8Array(await (await window.__albedo.loadThumbBlob(id)).arrayBuffer())
    const saved = await window.__albedo.rebuildThumb(id)
    const blob = await window.__albedo.loadThumbBlob(id)
    const after = new Uint8Array(await blob.arrayBuffer())
    const bmp = await createImageBitmap(blob)
    const c = new OffscreenCanvas(bmp.width, bmp.height)
    c.getContext('2d').drawImage(bmp, 0, 0)
    const d = c.getContext('2d').getImageData(0, 0, bmp.width, bmp.height).data
    let sum = 0, sq = 0
    for (let i = 0; i < d.length; i += 4) {
      const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
      sum += l; sq += l * l
    }
    const n = d.length / 4
    const mean = sum / n
    const row = window.__albedo.catalog().photos.find((p) => p.id === id)
    return {
      saved, replaced: before.length !== after.length, w: bmp.width, h: bmp.height,
      stddev: Math.sqrt(Math.max(0, sq / n - mean * mean)), mean,
      thumbState: row?.thumbState, width: row?.width, height: row?.height,
    }
  }, dngId)
  check('fallback rebuildThumb persists a thumb', fb.saved === true && fb.replaced,
    `${fb.w}×${fb.h}`)
  check('fallback thumb is a real demosaiced image', fb.stddev > 5 && fb.w <= 512 && fb.h <= 512,
    `mean ${fb.mean.toFixed(1)} stddev ${fb.stddev.toFixed(1)}`)
  check('fallback keeps thumb_state ready + true dims',
    fb.thumbState === 1 && fb.width === 4960 && fb.height === 3280,
    `state ${fb.thumbState}, ${fb.width}×${fb.height}`)

  // deleting mid-flight must not resurrect files: the worker guard reports it
  const gone = await page.evaluate(async (id) => {
    await window.__albedo.deletePhotos([id])
    try { return { rejected: false, saved: await window.__albedo.rebuildThumb(id) } }
    catch (err) { return { rejected: true, message: err.message } }
  }, dngId)
  check('rebuildThumb on a deleted photo is a safe no-op',
    gone.rejected === true || gone.saved === false, JSON.stringify(gone))

  check('no console errors', errors.length === 0, errors.join(' | '))
} catch (err) {
  // a thumb that never paints shows up as a waitForFunction timeout — report
  // it as a failing check, not an uncaught throw
  check('browser section completed', false, String(err?.message ?? err).split('\n')[0])
} finally {
  await browser.close()
}

console.log(failed ? `RAWTHUMB FAIL (${failed})` : 'RAWTHUMB PASS')
process.exit(failed ? 1 : 0)
