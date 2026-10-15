// AI timings in the browser: subject, sky, object click and removal on one
// photo (?src=), each run twice (cold = model load + first run, then warm).
// Masks come back as quarter-res weights; results go to window.__ai for the
// driver to save.
import { segmentMask, samMask, inpaintRegion } from '../src/state/segmentClient.js'

const q = new URLSearchParams(location.search)
const out = document.getElementById('out')
const time = async (fn) => { const t = performance.now(); const r = await fn(); return [performance.now() - t, r] }

async function main() {
  const blob = await (await fetch(q.get('src'))).blob()
  const bmp = await createImageBitmap(blob)
  const W = bmp.width
  const H = bmp.height
  const qw = Math.round(W / 4)
  const qh = Math.round(H / 4)
  const r = { W, H }
  window.__ai = {}
  for (const kind of ['subject', 'sky']) {
    const [cold] = await time(() => segmentMask('p', kind, blob, qw, qh))
    const [warm, res] = await time(() => segmentMask('p', kind, blob, qw, qh))
    r[kind] = { cold: Math.round(cold), warm: Math.round(warm) }
    window.__ai[kind] = { w: qw, h: qh, data: Array.from(res.mask) }
  }
  const pt = [[+(q.get('x') ?? 0.5), +(q.get('y') ?? 0.5), 1]]
  const [sc] = await time(() => samMask('p', blob, pt, null, qw, qh))
  const [sw, sres] = await time(() => samMask('p', blob, [[pt[0][0] + 0.01, pt[0][1], 1]], null, qw, qh))
  r.object = { firstClick: Math.round(sc), nextClick: Math.round(sw) }
  window.__ai.object = { w: qw, h: qh, data: Array.from(sres.mask) }
  // removal: the object mask as the hole, on a 1024-wide copy of the photo
  const iw = 1024
  const ih = Math.round((H / W) * 1024)
  const cv = new OffscreenCanvas(iw, ih).getContext('2d', { willReadFrequently: true })
  cv.drawImage(bmp, 0, 0, iw, ih)
  const rgba = cv.getImageData(0, 0, iw, ih).data
  const hole = new Uint8Array(iw * ih)
  for (let y = 0; y < ih; y++) {
    for (let x = 0; x < iw; x++) {
      hole[y * iw + x] = sres.mask[Math.min(qh - 1, Math.floor((y / ih) * qh)) * qw + Math.min(qw - 1, Math.floor((x / iw) * qw))] > 100 ? 255 : 0
    }
  }
  const [ic] = await time(() => inpaintRegion(new Uint8ClampedArray(rgba), hole.slice(), iw, ih))
  const [iwarm, ires] = await time(() => inpaintRegion(new Uint8ClampedArray(rgba), hole.slice(), iw, ih))
  r.remove = { cold: Math.round(ic), warm: Math.round(iwarm), size: `${iw}x${ih}` }
  window.__ai.remove = { w: iw, h: ih, rgba: Array.from(ires.rgba) }
  out.textContent = JSON.stringify({ ok: true, ...r })
}
main().catch((e) => { out.textContent = JSON.stringify({ ok: false, error: String(e?.stack ?? e) }) })
