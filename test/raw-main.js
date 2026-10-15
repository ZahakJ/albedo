// UI-less RAW pipeline harness: decode → open → render → export, stats into
// #out as JSON for the e2e driver. ?backend=webgpu|webgl2, ?src=<url>,
// ?quality=full|proxy. Also accepts a local file via the input.
import { decode } from '../src/state/decodeClient.js'
import { initRender, openPhoto, exportPhoto } from '../src/state/renderClient.js'
import { newEditDoc } from '../src/engine/editdoc.js'

const out = document.getElementById('out')
const report = (obj) => { out.textContent = JSON.stringify(obj, null, 2) }

async function blobStats(blob) {
  const bmp = await createImageBitmap(blob)
  const c = new OffscreenCanvas(bmp.width, bmp.height)
  const ctx = c.getContext('2d')
  ctx.drawImage(bmp, 0, 0)
  const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data
  const sum = [0, 0, 0]
  let nonBlack = 0
  for (let i = 0; i < d.length; i += 4) {
    sum[0] += d[i]
    sum[1] += d[i + 1]
    sum[2] += d[i + 2]
    if (d[i] + d[i + 1] + d[i + 2] > 12) nonBlack++
  }
  const n = d.length / 4
  return {
    width: bmp.width,
    height: bmp.height,
    mean: [sum[0] / n, sum[1] / n, sum[2] / n],
    nonBlackFrac: nonBlack / n,
  }
}

async function run(rawBuffer, name) {
  const q = new URLSearchParams(location.search)
  const quality = q.get('quality') ?? 'full'
  const t0 = performance.now()
  const payload = await decode('p1', rawBuffer, name, quality)
  const decodeMs = performance.now() - t0

  const decoded = {
    kind: payload.kind,
    width: payload.width,
    height: payload.height,
    bitDepth: payload.bitDepth,
    linear: payload.linear,
    black: payload.black,
    white: payload.white,
    camMul: payload.camMul,
    camToSrgb: Array.from(payload.camToSrgb),
    cfa: payload.cfa,
    flip: payload.flip,
    exif: payload.exif,
    bufferLength: payload.buffer.length,
  }

  const { backend } = await initRender(document.getElementById('view'), q.get('backend') ?? 'webgpu')
  const t1 = performance.now()
  await openPhoto('p1', payload, newEditDoc('p1'))
  const openMs = performance.now() - t1

  const t2 = performance.now()
  const { blob } = await exportPhoto('p1', newEditDoc('p1'), { type: 'image/png' })
  const exportMs = performance.now() - t2
  window.__exportBlob = blob // e2e drivers can lift the actual bytes
  const stats = await blobStats(blob)

  report({
    ok: true,
    backend,
    quality,
    decodeMs: Math.round(decodeMs),
    openMs: Math.round(openMs),
    exportMs: Math.round(exportMs),
    decoded,
    export: stats,
  })
}

const boot = async () => {
  const q = new URLSearchParams(location.search)
  const src = q.get('src') ?? '/test/fixtures/sample.cr2'
  const res = await fetch(src)
  if (!res.ok) throw new Error(`fetch ${src}: ${res.status}`)
  await run(await res.arrayBuffer(), src.split('/').pop())
}

document.getElementById('file').onchange = async (e) => {
  const f = e.target.files[0]
  run(await f.arrayBuffer(), f.name).catch((err) => report({ ok: false, error: String(err?.message ?? err) }))
}

boot().catch((err) => report({ ok: false, error: String(err?.stack ?? err) }))
