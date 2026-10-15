// Demosaic quality: a ground-truth RGB image (?src=, 8-bit, treated as linear
// light) is sampled through a Bayer (?cfa=bayer) or X-Trans (?cfa=xtrans)
// pattern, demosaiced by the render worker with identity colour, exported as
// 16-bit-free PNG, and compared with the truth. Reports PSNR (dB) and the
// mean of the per-pixel colour error, a zipper/false-colour proxy.
import { initRender, openPhoto, exportPhoto } from '../src/state/renderClient.js'

const q = new URLSearchParams(location.search)
const out = document.getElementById('out')
const report = (o) => { out.textContent = JSON.stringify(o) }

const XT = [1, 1, 0, 1, 1, 2, 1, 1, 2, 1, 1, 0, 2, 0, 1, 0, 2, 1,
  1, 1, 2, 1, 1, 0, 1, 1, 0, 1, 1, 2, 0, 2, 1, 2, 0, 1]

async function main() {
  const bm = await createImageBitmap(await (await fetch(q.get('src'))).blob())
  const W = bm.width
  const H = bm.height
  const c = new OffscreenCanvas(W, H).getContext('2d', { willReadFrequently: true })
  c.drawImage(bm, 0, 0)
  const truth = c.getImageData(0, 0, W, H).data
  const xtrans = q.get('cfa') === 'xtrans'
  const colorAt = (x, y) => xtrans ? XT[(y % 6) * 6 + (x % 6)]
    : (y & 1) === 0 ? ((x & 1) === 0 ? 0 : 1) : ((x & 1) === 0 ? 1 : 2)
  // 8-bit truth → 16-bit mosaic; with an identity matrix, no white balance
  // and the linear look, the export is truth again where demosaic is exact
  const mosaic = new Uint16Array(W * H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) mosaic[y * W + x] = truth[(y * W + x) * 4 + colorAt(x, y)] * 257
  }
  const ref = mosaic.slice() // the payload's copy is transferred to the worker
  const payload = {
    photoId: 'd1', kind: xtrans ? 'xtrans' : 'mosaic', width: W, height: H, bitDepth: 16, linear: true,
    buffer: mosaic, black: 0, white: 65535,
    camMul: [1, 1, 1], camToSrgb: Float32Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1),
    cfa: [0, 0], xtrans: xtrans ? Uint8Array.from(XT) : undefined, flip: 0, exif: {},
  }
  await initRender(document.getElementById('view'), q.get('backend') ?? 'webgpu')
  // linear look, no sharpening, no NR: the export is the demosaic itself.
  // The sRGB encode is undone below, so 8-bit truth compares as linear.
  const doc = { schema: 1, photoId: 'd1', versionId: 'v', masks: [], modules: {
    look: { profile: 'linear' }, recon: { on: 0 },
    detail: { sharpenAmount: 0, sharpenRadius: 1, sharpenMasking: 0, lumaNR: 0, chromaNR: 0 } } }
  await openPhoto('d1', payload, doc)
  const { blob } = await exportPhoto('d1', doc, { type: 'image/png' })
  const eb = await createImageBitmap(blob)
  const c2 = new OffscreenCanvas(W, H).getContext('2d', { willReadFrequently: true })
  c2.drawImage(eb, 0, 0)
  const got = c2.getImageData(0, 0, W, H).data
  const s2l = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  const lut = Array.from({ length: 256 }, (_, i) => s2l(i / 255) * 255)
  let se = 0
  let n = 0
  let cerr = 0
  const B = 8 // skip borders
  for (let y = B; y < H - B; y++) {
    for (let x = B; x < W - B; x++) {
      const i = (y * W + x) * 4
      const d = [0, 1, 2].map((k) => lut[got[i + k]] - truth[i + k])
      se += d[0] * d[0] + d[1] * d[1] + d[2] * d[2]
      n += 3
      const m = (d[0] + d[1] + d[2]) / 3
      cerr += Math.hypot(d[0] - m, d[1] - m, d[2] - m)
    }
  }
  const score = (getLin) => {
    let e = 0, k = 0
    for (let y = B; y < H - B; y++) {
      for (let x = B; x < W - B; x++) {
        const i = (y * W + x) * 4
        for (let c = 0; c < 3; c++) { const d = getLin(x, y, c) - truth[i + c]; e += d * d; k++ }
      }
    }
    return +(10 * Math.log10((255 * 255) / (e / k))).toFixed(2)
  }
  const M = (x, y) => ref[Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))] / 257
  // baselines on the same mosaic: bilinear (average of the colour's photosites
  // in the 3×3, 5×5 for X-Trans) and, for Bayer, Malvar-He-Cutler
  const bilinear = (x, y, c) => {
    if (colorAt(x, y) === c) return M(x, y)
    const r = xtrans ? 2 : 1
    let s = 0, n = 0
    for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) {
      const X = x + i, Y = y + j
      if (X < 0 || Y < 0 || X >= W || Y >= H || colorAt(X, Y) !== c) continue
      s += M(X, Y); n++
    }
    return n ? s / n : 0
  }
  const mhc = (x, y, c) => {
    const k = colorAt(x, y)
    if (k === c) return M(x, y)
    const C = M(x, y)
    const h = M(x - 1, y) + M(x + 1, y), v = M(x, y - 1) + M(x, y + 1)
    const h2 = M(x - 2, y) + M(x + 2, y), v2 = M(x, y - 2) + M(x, y + 2)
    const d = M(x - 1, y - 1) + M(x + 1, y - 1) + M(x - 1, y + 1) + M(x + 1, y + 1)
    if (c === 1) return Math.max(0, (4 * C + 2 * (h + v) - h2 - v2) / 8)
    if (k !== 1) return Math.max(0, (6 * C + 2 * d - 1.5 * (h2 + v2)) / 8) // R at B, B at R
    // at green: red row has R left/right
    const redRow = colorAt(x + 1, y) === 0 || colorAt(x - 1, y) === 0
    const along = (c === 0) === redRow
    return Math.max(0, along ? (5 * C + 4 * h - h2 + 0.5 * v2 - d) / 8 : (5 * C + 4 * v - v2 + 0.5 * h2 - d) / 8)
  }
  const mse = se / n
  report({ ok: true, W, H, cfa: xtrans ? 'xtrans' : 'bayer', psnr: +(10 * Math.log10((255 * 255) / mse)).toFixed(2),
    colorErr: +(cerr / (n / 3)).toFixed(3), bilinear: score(bilinear), ...(xtrans ? {} : { mhc: score(mhc) }) })
}
main().catch((e) => report({ ok: false, error: String(e?.stack ?? e) }))
