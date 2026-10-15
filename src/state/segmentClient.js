import { MSG, msgId } from '../workers/protocol.js'

// Thin proxy to the AI worker (masks, object selection, removal), plus the
// shared helpers AI masks need on the main thread: texture-channel
// assignment and PNG (de)serialization of quarter-res mask weights.

let worker = null
const replyWaiters = new Map()

function ensureWorker() {
  if (worker) return
  worker = new Worker(new URL('../workers/ai.worker.js', import.meta.url), { type: 'module' })
  worker.onerror = (e) => console.error('[ai.worker]', e.message ?? e)
  worker.onmessage = ({ data }) => {
    if (!data.re || !replyWaiters.has(data.re)) return
    const { resolve, reject } = replyWaiters.get(data.re)
    replyWaiters.delete(data.re)
    data.ok === false ? reject(new Error(data.message)) : resolve(data)
  }
}

const request = (msg, transfer = []) => {
  ensureWorker()
  return new Promise((resolve, reject) => {
    const id = msgId()
    replyWaiters.set(id, { resolve, reject })
    worker.postMessage({ id, base: new URL('./', document.baseURI).href, ...msg }, transfer)
  })
}

// kind 'subject' | 'sky'; blob: the photo's preview (the source orientation)
// → { mask: Uint8Array outW×outH (0..255 weight), width, height, ms }
export const segmentMask = (photoId, kind, blob, outW, outH) =>
  request({ type: MSG.SEG_SUBJECT, photoId, kind, blob, outW, outH })

// click/box selection; points [[x, y, label]] and box in source-normalised
// coords; the image embedding is computed once per photo and cached
export const samMask = (photoId, blob, points, box, outW, outH) =>
  request({ type: MSG.SAM_MASK, photoId, blob, points, box, outW, outH })

// fill the hole (255) of an RGBA8 region → { rgba }
export const inpaintRegion = (rgba, hole, width, height) =>
  request({ type: MSG.INPAINT, rgba, hole, width, height }, [rgba.buffer, hole.buffer])

// AI denoise of a decoded Bayer payload, streamed tile by tile to `port`
export const denoisePayload = (payload, port) =>
  request({ type: MSG.DENOISE, payload, port }, [payload.buffer.buffer, port])
export const cancelDenoise = () => { if (worker) worker.postMessage({ type: MSG.DENOISE_CANCEL }) }

export const releaseAi = () => (worker ? request({ type: MSG.AI_RELEASE }) : Promise.resolve())

// brushTex channel per brush/ai mask, assigned by doc order over BOTH kinds
// (shared budget 4) — must mirror brushChannels in workers/render.worker.js
export function texChannels(masks) {
  const map = new Map()
  for (const m of masks ?? []) {
    if (m.kind !== 'brush' && m.kind !== 'ai') continue
    if (map.size < 4) map.set(m.id, map.size)
  }
  return map
}

// quarter-res of a source, matching the render worker's brushTex dims
export const quarterDims = (w, h) =>
  [Math.max(1, Math.round(w / 4)), Math.max(1, Math.round(h / 4))]

// gray weights → PNG blob (OPFS persistence format for AI masks)
export async function maskToPngBlob(mask, w, h) {
  const px = new Uint8ClampedArray(w * h * 4)
  for (let i = 0, n = w * h; i < n; i++) {
    px[i * 4] = mask[i]; px[i * 4 + 1] = mask[i]; px[i * 4 + 2] = mask[i]; px[i * 4 + 3] = 255
  }
  const cv = new OffscreenCanvas(w, h)
  cv.getContext('2d').putImageData(new ImageData(px, w, h), 0, 0)
  return cv.convertToBlob({ type: 'image/png' })
}

export async function pngBlobToMask(blob) {
  const bmp = await createImageBitmap(blob)
  const cv = new OffscreenCanvas(bmp.width, bmp.height)
  const cx = cv.getContext('2d', { willReadFrequently: true })
  cx.drawImage(bmp, 0, 0)
  const px = cx.getImageData(0, 0, bmp.width, bmp.height).data
  const data = new Uint8Array(bmp.width * bmp.height)
  for (let i = 0; i < data.length; i++) data[i] = px[i * 4]
  const out = { data, width: bmp.width, height: bmp.height }
  bmp.close()
  return out
}
