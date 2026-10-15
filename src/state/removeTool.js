import { requestRegion, sendPatch } from './renderClient.js'
import { inpaintRegion, samMask } from './segmentClient.js'
import { getState as getEditState, commitParam } from './editStore.js'
import { saveMaskBlob, loadMaskBlob, loadPreviewBlob, loadThumbBlob } from './catalogStore.js'
import { getParam } from '../engine/editdoc.js'

// Content-aware removal. A hole — brush strokes, or the object under a click
// (MobileSAM) — is filled by the inpainting model from its surroundings and
// becomes a patch: an RGBA image in OPFS plus a rect in the doc
// (modules.remove). The develop pass composites patches as it reads the
// capture, so removing one is an ordinary undo.

const MAX_SIDE = 1024 // the model works at 512 inside; 1024 keeps context sharp
const FEATHER = 3 // px of soft edge at region resolution
const GROW = 4 // px the hole grows to swallow halos and fringes

const id = () => 'rm_' + Math.random().toString(36).slice(2, 10)

// hole extent in source-normalised coords: [x0, y0, x1, y1]
function strokesBox(strokes, W, H) {
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0
  for (const s of strokes) {
    const rx = s.size / 2
    const ry = (s.size / 2) * (W / H)
    for (const [x, y] of s.pts) {
      x0 = Math.min(x0, x - rx); x1 = Math.max(x1, x + rx)
      y0 = Math.min(y0, y - ry); y1 = Math.max(y1, y + ry)
    }
  }
  return [x0, y0, x1, y1]
}
function maskBox(mask, qw, qh) {
  let x0 = qw, y0 = qh, x1 = -1, y1 = -1
  for (let y = 0; y < qh; y++) {
    for (let x = 0; x < qw; x++) {
      if (mask[y * qw + x] < 128) continue
      if (x < x0) x0 = x; if (x > x1) x1 = x
      if (y < y0) y0 = y; if (y > y1) y1 = y
    }
  }
  return x1 < 0 ? null : [x0 / qw, y0 / qh, (x1 + 1) / qw, (y1 + 1) / qh]
}

// hole: { strokes } or { mask, qw, qh } (quarter-res weights) → patch, or
// null when there was nothing to remove
export async function removeArea(hole) {
  const { photo } = getEditState()
  if (!photo) return null
  const W = photo.width
  const H = photo.height
  const box = hole.strokes ? strokesBox(hole.strokes, W, H) : maskBox(hole.mask, hole.qw, hole.qh)
  if (!box || box[2] <= box[0] || box[3] <= box[1]) return null
  // context: as much again around the hole, at least 48 px
  const pw = Math.max((box[2] - box[0]) * 0.75, 48 / W)
  const ph = Math.max((box[3] - box[1]) * 0.75, 48 / H)
  const rx0 = Math.max(0, box[0] - pw)
  const ry0 = Math.max(0, box[1] - ph)
  const rx1 = Math.min(1, box[2] + pw)
  const ry1 = Math.min(1, box[3] + ph)
  const rect = [rx0, ry0, rx1 - rx0, ry1 - ry0]
  const k = Math.min(1, MAX_SIDE / Math.max(rect[2] * W, rect[3] * H))
  const w = Math.max(16, Math.round(rect[2] * W * k))
  const h = Math.max(16, Math.round(rect[3] * H * k))

  // the hole at region resolution, grown a little
  const hc = new OffscreenCanvas(w, h)
  const hx = hc.getContext('2d', { willReadFrequently: true })
  hx.fillStyle = '#fff'
  hx.strokeStyle = '#fff'
  if (hole.strokes) {
    hx.lineCap = 'round'
    hx.lineJoin = 'round'
    for (const s of hole.strokes) {
      hx.lineWidth = s.size * W * k + 2 * GROW
      hx.beginPath()
      s.pts.forEach(([x, y], i) => {
        const px = ((x - rx0) / rect[2]) * w
        const py = ((y - ry0) / rect[3]) * h
        i ? hx.lineTo(px, py) : hx.moveTo(px, py)
      })
      if (s.pts.length === 1) hx.lineTo(((s.pts[0][0] - rx0) / rect[2]) * w + 0.01, ((s.pts[0][1] - ry0) / rect[3]) * h)
      hx.stroke()
    }
  } else {
    const m = new OffscreenCanvas(hole.qw, hole.qh)
    const px = new Uint8ClampedArray(hole.qw * hole.qh * 4)
    for (let i = 0; i < hole.mask.length; i++) {
      const v = hole.mask[i] > 127 ? 255 : 0
      px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = 255
      px[i * 4 + 3] = v
    }
    m.getContext('2d').putImageData(new ImageData(px, hole.qw, hole.qh), 0, 0)
    // grow by blurring the alpha and taking anything touched
    hx.filter = `blur(${GROW}px)`
    hx.drawImage(m, rx0 * hole.qw, ry0 * hole.qh, rect[2] * hole.qw, rect[3] * hole.qh, 0, 0, w, h)
    hx.filter = 'none'
  }
  const hp = hx.getImageData(0, 0, w, h).data
  const holeMask = new Uint8Array(w * h)
  for (let i = 0; i < holeMask.length; i++) holeMask[i] = hp[i * 4 + 3] > 8 ? 255 : 0

  const region = await requestRegion(photo.id, rect, w, h)
  const { rgba } = await inpaintRegion(new Uint8ClampedArray(region.data), holeMask.slice(), w, h)

  // alpha: the hole with a soft edge
  const ac = new OffscreenCanvas(w, h)
  const ax = ac.getContext('2d', { willReadFrequently: true })
  const holeImg = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < holeMask.length; i++) {
    holeImg[i * 4] = holeImg[i * 4 + 1] = holeImg[i * 4 + 2] = 255
    holeImg[i * 4 + 3] = holeMask[i]
  }
  const tmp = new OffscreenCanvas(w, h)
  tmp.getContext('2d').putImageData(new ImageData(holeImg, w, h), 0, 0)
  ax.filter = `blur(${FEATHER}px)`
  ax.drawImage(tmp, 0, 0)
  const alpha = ax.getImageData(0, 0, w, h).data

  // crop the patch to where alpha is non-zero
  let px0 = w, py0 = h, px1 = -1, py1 = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (alpha[(y * w + x) * 4 + 3] === 0) continue
      if (x < px0) px0 = x; if (x > px1) px1 = x
      if (y < py0) py0 = y; if (y > py1) py1 = y
    }
  }
  if (px1 < 0) return null
  const cw = px1 - px0 + 1
  const ch = py1 - py0 + 1
  const out = new Uint8ClampedArray(cw * ch * 4)
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const s = ((y + py0) * w + x + px0) * 4
      const d = (y * cw + x) * 4
      out[d] = rgba[s]; out[d + 1] = rgba[s + 1]; out[d + 2] = rgba[s + 2]
      out[d + 3] = alpha[s + 3]
    }
  }
  const patch = {
    id: id(),
    x: rx0 + (px0 / w) * rect[2], y: ry0 + (py0 / h) * rect[3],
    w: (cw / w) * rect[2], h: (ch / h) * rect[3],
    scale: region.scale,
  }
  const pc = new OffscreenCanvas(cw, ch)
  pc.getContext('2d').putImageData(new ImageData(out, cw, ch), 0, 0)
  const png = await pc.convertToBlob({ type: 'image/png' })
  // the doc may have moved on while the model ran: commit against the live one
  const live = getEditState()
  if (live.photo?.id !== photo.id || !live.doc) return null
  await saveMaskBlob(photo.id, patch.id, png)
  sendPatch(photo.id, patch.id, { width: cw, height: ch, data: out })
  commitParam('remove', 'patches', [...getParam(live.doc, 'remove', 'patches'), patch])
  return patch
}

// the object under a click (source-normalised), removed
export async function removeObjectAt(x, y) {
  const { photo } = getEditState()
  if (!photo) return null
  const blob = (await loadPreviewBlob(photo.id).catch(() => null)) ??
    (await loadThumbBlob(photo.id).catch(() => null))
  const qw = Math.max(1, Math.round(photo.width / 4))
  const qh = Math.max(1, Math.round(photo.height / 4))
  const { mask } = await samMask(photo.id, blob, [[x, y, 1]], null, qw, qh)
  return removeArea({ mask, qw, qh })
}

// open: hand the doc's patch pixels back to the render worker
export async function replayPatches(photoId, doc) {
  const patches = doc?.modules?.remove?.patches ?? []
  await Promise.all(patches.map(async (p) => {
    try {
      const blob = await loadMaskBlob(photoId, p.id)
      if (!blob) return
      const bmp = await createImageBitmap(blob)
      const cv = new OffscreenCanvas(bmp.width, bmp.height)
      const cx = cv.getContext('2d', { willReadFrequently: true })
      cx.drawImage(bmp, 0, 0)
      const data = cx.getImageData(0, 0, bmp.width, bmp.height).data
      sendPatch(photoId, p.id, { width: bmp.width, height: bmp.height, data })
      bmp.close()
    } catch (err) { console.error('[remove] replay', err) }
  }))
}
