import { getCompose, op } from '../../state/composeClient.js'
import { inpaintRegion } from '../../state/segmentClient.js'
import { toast } from '../../state/toastStore.js'

// Content-aware fill and the spot healing brush. The hole (the selection, or
// brushed strokes) and a margin of context around it are read from the
// composite, filled by the local inpainting model (MI-GAN), and placed as a
// new layer above the active one, so the original stays untouched.

const MAX_SIDE = 1024
const GROW = 4
const FEATHER = 3

// strokes: [{ pts: [[x, y]…] (doc px), size (px) }] — else the selection
export async function contentAwareFill({ strokes = null, name } = {}) {
  const st = getCompose()
  const doc = st.doc
  if (!doc) return
  let box
  if (strokes?.length) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const s of strokes) for (const [x, y] of s.pts) {
      x0 = Math.min(x0, x - s.size / 2); y0 = Math.min(y0, y - s.size / 2)
      x1 = Math.max(x1, x + s.size / 2); y1 = Math.max(y1, y + s.size / 2)
    }
    box = [x0, y0, x1, y1]
  } else {
    const b = st.selection?.bounds
    if (!b) { toast('Select the area to fill first'); return }
    box = [b[0], b[1], b[0] + b[2], b[1] + b[3]]
  }
  const t0 = performance.now()
  const pw = Math.max((box[2] - box[0]) * 0.75, 48)
  const ph = Math.max((box[3] - box[1]) * 0.75, 48)
  const rx0 = Math.max(0, Math.floor(box[0] - pw)), ry0 = Math.max(0, Math.floor(box[1] - ph))
  const rx1 = Math.min(doc.width, Math.ceil(box[2] + pw)), ry1 = Math.min(doc.height, Math.ceil(box[3] + ph))
  const rect = [rx0, ry0, rx1 - rx0, ry1 - ry0]
  if (rect[2] < 4 || rect[3] < 4) return
  const k = Math.min(1, MAX_SIDE / Math.max(rect[2], rect[3]))
  const w = Math.max(16, Math.round(rect[2] * k)), h = Math.max(16, Math.round(rect[3] * k))
  try {
    const r = await op('regionPixels', { rect, w, h, sample: 'all', hole: !strokes })
    // the hole at region resolution, grown to swallow halos
    const hc = new OffscreenCanvas(w, h)
    const hx = hc.getContext('2d', { willReadFrequently: true })
    if (strokes) {
      hx.strokeStyle = '#fff'
      hx.lineCap = 'round'
      hx.lineJoin = 'round'
      for (const s of strokes) {
        hx.lineWidth = s.size * k + 2 * GROW
        hx.beginPath()
        s.pts.forEach(([x, y], i) => { const px = (x - rx0) * k, py = (y - ry0) * k; i ? hx.lineTo(px, py) : hx.moveTo(px, py) })
        if (s.pts.length === 1) hx.lineTo((s.pts[0][0] - rx0) * k + 0.01, (s.pts[0][1] - ry0) * k)
        hx.stroke()
      }
    } else {
      const img = new Uint8ClampedArray(w * h * 4)
      for (let i = 0; i < w * h; i++) { img[i * 4] = img[i * 4 + 1] = img[i * 4 + 2] = 255; img[i * 4 + 3] = r.hole[i] > 127 ? 255 : 0 }
      const m = new OffscreenCanvas(w, h)
      m.getContext('2d').putImageData(new ImageData(img, w, h), 0, 0)
      hx.filter = `blur(${GROW}px)`
      hx.drawImage(m, 0, 0)
      hx.filter = 'none'
    }
    const hp = hx.getImageData(0, 0, w, h).data
    const hole = new Uint8Array(w * h)
    for (let i = 0; i < hole.length; i++) hole[i] = hp[i * 4 + 3] > 8 ? 255 : 0
    const { rgba } = await inpaintRegion(new Uint8ClampedArray(r.rgba.buffer, r.rgba.byteOffset, w * h * 4).slice(), hole.slice(), w, h)
    // soft edge
    const holeImg = new Uint8ClampedArray(w * h * 4)
    for (let i = 0; i < hole.length; i++) { holeImg[i * 4 + 3] = hole[i] }
    const t = new OffscreenCanvas(w, h)
    t.getContext('2d').putImageData(new ImageData(holeImg, w, h), 0, 0)
    const ac = new OffscreenCanvas(w, h)
    const ax = ac.getContext('2d', { willReadFrequently: true })
    ax.filter = `blur(${FEATHER}px)`
    ax.drawImage(t, 0, 0)
    const alpha = ax.getImageData(0, 0, w, h).data
    const out = new Uint8Array(w * h * 4)
    for (let i = 0; i < w * h; i++) {
      const a = alpha[i * 4 + 3] / 255
      out[i * 4] = Math.round(rgba[i * 4] * a)
      out[i * 4 + 1] = Math.round(rgba[i * 4 + 1] * a)
      out[i * 4 + 2] = Math.round(rgba[i * 4 + 2] * a)
      out[i * 4 + 3] = alpha[i * 4 + 3]
    }
    await op('placePatch', { rect, w, h, rgba: out, name: name ?? (strokes ? 'Spot Healing' : 'Content-Aware Fill') })
    toast(`${strokes ? 'Healed' : 'Filled'} in ${((performance.now() - t0) / 1000).toFixed(2)} s, on a new layer`)
  } catch (err) {
    toast(/not installed|404|fetch|model/i.test(err.message) ? 'The inpainting model is not installed (npm run setup-models)' : `Fill failed: ${err.message}`)
  }
}
