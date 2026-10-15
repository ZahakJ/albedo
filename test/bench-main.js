// Pipeline benchmark: decode → open (GPU-synced first frame) → N slider
// frames (GPU-synced) → full-resolution JPEG export. Results as JSON in #out.
// ?src=<url>&backend=webgpu|webgl2&n=60&masks=0..8
import { decode } from '../src/state/decodeClient.js'
import { initRender, openPhoto, exportPhoto, setView, onRenderEvent, sendParams, sendDenoisePort, sendProfile } from '../src/state/renderClient.js'
import { denoisePayload } from '../src/state/segmentClient.js'
import { newEditDoc } from '../src/engine/editdoc.js'
import { MSG } from '../src/workers/protocol.js'

const q = new URLSearchParams(location.search)
const out = document.getElementById('out')
const report = (o) => { out.textContent = JSON.stringify(o, null, 2) }
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1] }
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))] }

async function main() {
  const src = q.get('src')
  const n = +(q.get('n') ?? 60)
  const nMasks = +(q.get('masks') ?? 0)
  const buf = await (await fetch(src)).arrayBuffer()
  const t0 = performance.now()
  const payload = await decode('b1', buf, src.split('/').pop(), 'full')
  const decodeMs = performance.now() - t0
  const dims = [payload.width, payload.height]

  const canvas = document.getElementById('view')
  let lens = null
  onRenderEvent((d) => { if (d.type === MSG.LENS) lens = d.lens?.name ?? null })
  const { backend } = await initRender(canvas, q.get('backend') ?? 'webgpu')
  setView(1600, 1000, { zoom: 'fit' })
  const doc = newEditDoc('b1')
  // ?dcp=<url>: render through that camera profile
  if (q.get('dcp')) {
    sendProfile('bench', await (await fetch(q.get('dcp'))).arrayBuffer())
    doc.modules.look = { profile: 'dcp:bench', baseline: 0.5, saturation: 100 }
  }
  const t1 = performance.now()
  await openPhoto('b1', payload, doc, { sync: true })
  const openMs = performance.now() - t1

  // masks: radial masks with exposure, the worst common case for Lightroom
  const masks = []
  for (let i = 0; i < nMasks; i++) {
    masks.push({ id: `m${i}`, kind: 'radial', name: `r${i}`, enabled: true, invert: false,
      geom: { cx: 0.2 + 0.08 * i, cy: 0.5, rx: 0.15, ry: 0.15, angle: 0, feather: 0.5 },
      adjust: { ev: 0.3, contrast: 10, clarity: 10, saturation: 5 } })
  }
  const frames = []
  const gpu = []
  const cpu = []
  let resolve = null
  onRenderEvent((d) => { if (d.type === MSG.FRAME && !d.re && resolve) { const r = resolve; resolve = null; r(d) } })
  for (let i = 0; i < n + 5; i++) {
    const ev = ((i % 40) - 20) / 20
    const d = { ...doc, masks, modules: { ...doc.modules, exposure: { ev, black: 0 }, tone: { contrast: 10, highlights: -30, shadows: 30, whites: 0, blacks: 0 }, ...(q.get('plain') ? { detail: { sharpenAmount: 0, sharpenRadius: 1, sharpenMasking: 0, lumaNR: 0, chromaNR: 0 } } : {}) } }
    const s = performance.now()
    const done = new Promise((r) => { resolve = r })
    sendParams('b1', d, true, { sync: true, offscreen: true })
    const fr = await done
    if (i >= 5) { frames.push(performance.now() - s); gpu.push(fr.ms); cpu.push(fr.cpuMs) }
  }

  // ?dn=1: AI denoise, timed from a fresh decode to the last tile placed
  let denoiseMs = null
  let exportDoc = doc
  if (q.get('dn')) {
    const td = performance.now()
    const ready = new Promise((r) => onRenderEvent((d) => { if (d.type === MSG.DN_STATE && d.ready) r() }))
    const p2 = await decode('b1', await (await fetch(src)).arrayBuffer(), src.split('/').pop(), 'full')
    const { port1, port2 } = new MessageChannel()
    sendDenoisePort('b1', port1)
    await denoisePayload(p2, port2)
    await ready
    denoiseMs = Math.round(performance.now() - td)
    exportDoc = { ...doc, modules: { ...doc.modules, detail: { sharpenAmount: 40, sharpenRadius: 1, sharpenMasking: 0, lumaNR: 0, chromaNR: 25, aiDenoise: +q.get('dn') } } }
  }

  const t2 = performance.now()
  const { blob } = await exportPhoto('b1', exportDoc, { type: q.get('fmt') === 'tiff' ? 'image/tiff' : 'image/jpeg', quality: 0.92 })
  const exportMs = performance.now() - t2
  window.__exportBlob = blob
  report({ ok: true, backend, dims, lens, decodeMs: Math.round(decodeMs), openMs: Math.round(openMs),
    frameMedian: +med(frames).toFixed(1), frameP95: +pct(frames, 0.95).toFixed(1),
    workerMedian: +med(gpu).toFixed(1), workerP95: +pct(gpu, 0.95).toFixed(1), cpuMedian: +med(cpu).toFixed(1),
    exportMs: Math.round(exportMs), exportBytes: blob.size, masks: nMasks, denoiseMs })
}
if (!q.get("probe")) main().catch((e) => report({ ok: false, error: String(e?.stack ?? e) }))
