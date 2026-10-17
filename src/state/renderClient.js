import { MSG, msgId } from '../workers/protocol.js'

// Thin proxy between React and the render worker. Param sends are coalesced
// per animation frame so a fast slider drag becomes at most 60 messages/s.

let worker = null
let pendingParams = null
let rafId = 0
let timerId = 0
const listeners = new Set()
const replyWaiters = new Map()

// Compose talks to the same worker (it shares the GPU device with Develop)
export const renderWorker = () => worker

export const onRenderEvent = (fn) => {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

const request = (msg, transfer) => new Promise((resolve, reject) => {
  const id = msgId()
  replyWaiters.set(id, { resolve, reject })
  worker.postMessage({ id, ...msg }, transfer ?? [])
})

export async function initRender(canvasEl, backendPref) {
  worker = new Worker(new URL('../workers/render.worker.js', import.meta.url), { type: 'module' })
  worker.onerror = (e) => console.error('[render.worker]', e.message ?? e)
  worker.onmessage = ({ data }) => {
    if (data.type === MSG.ERROR && !(typeof data.re === 'string')) console.error('[render.worker]', data.message)
    if (data.re && replyWaiters.has(data.re)) {
      const { resolve, reject } = replyWaiters.get(data.re)
      replyWaiters.delete(data.re)
      data.type === MSG.ERROR ? reject(new Error(data.message)) : resolve(data)
    }
    for (const fn of listeners) fn(data)
  }
  const offscreen = canvasEl.transferControlToOffscreen()
  // base: the app root, where the worker finds static data (lensfun/)
  const base = new URL('./', document.baseURI).href
  const ready = await request({ type: MSG.INIT, canvas: offscreen, backendPref, base }, [offscreen])
  return { backend: ready.backend, limits: ready.limits }
}

// source: ImageBitmap or a DECODED payload (whose pixel buffer is transferred)
// opts.sync: reply only once the GPU has finished the first frame (benchmarks)
export const openPhoto = (photoId, source, editDoc, opts) =>
  request({ type: MSG.OPEN, photoId, source, editDoc, sync: !!opts?.sync },
    source instanceof ImageBitmap ? [source] : [source.buffer.buffer])

// a photo Compose holds as a smart object, opened in Develop without a decode
export const openSession = (photoId, editDoc) => request({ type: MSG.OPEN_SESSION, photoId, editDoc })

// flags (optional): { before: true } renders the un-edited default doc,
// { clipOverlay: true } paints clipped highlights/shadows in the display,
// { maskPreview: true } renders the sharpen mask weight as grayscale
// (Alt-drag on the DETAIL Masking slider), { maskOverlay: i } paints
// doc.masks[i]'s weight as a 40% red wash in the finish pass (-1 = off)
export function sendParams(photoId, editDoc, gesture, flags) {
  pendingParams = { type: MSG.PARAMS, photoId, editDoc, gesture, flags }
  if (rafId || timerId) return
  // rAF coalesces during active drags; the timer fallback keeps edits
  // rendering when the tab is backgrounded (or headless) and rAF starves
  const flush = () => {
    if (rafId) cancelAnimationFrame(rafId)
    clearTimeout(timerId)
    rafId = 0
    timerId = 0
    if (!pendingParams) return
    worker.postMessage(pendingParams)
    pendingParams = null
  }
  rafId = requestAnimationFrame(flush)
  timerId = setTimeout(flush, 33)
}

// Scopes subscription: fn({ photoId, hist: Uint32Array(256*4) r/g/b/luma,
// clipShadows, clipHighlights }); returns unsubscribe.
export const onScopes = (fn) =>
  onRenderEvent((d) => { if (d.type === MSG.SCOPES) fn(d) })

// view (optional): { zoom: 'fit' | 1 | 2, panX, panY } — loupe window; pan is
// the view center in developed-output-normalized coords. Omitted = fit.
export const setView = (w, h, view) => worker.postMessage({
  type: MSG.VIEW, w, h,
  zoom: view?.zoom ?? 'fit',
  panX: view?.panX ?? 0.5,
  panY: view?.panY ?? 0.5,
})

export const exportPhoto = (photoId, editDoc, opts) =>
  request({ type: MSG.EXPORT, photoId, editDoc, opts })

// auto tone / auto WB: worker measures the current photo (with the family
// being computed stripped) and replies { modules } for editStore.applyModules
export const autoAdjust = (photoId, kind) =>
  request({ type: MSG.AUTO, photoId, kind })

// point sample at normalized display coords of the rendered view →
// { linear: [r,g,b] pre-develop scene-linear, display: [r,g,b] 0..1
// pre-curve display-referred } — WB eyedropper + targeted adjustment
export const samplePoint = (photoId, x, y) =>
  request({ type: MSG.SAMPLE, photoId, x, y })

// live brush-stroke increment (caller batches pts per rAF); the committed
// stroke lands in the doc and rides the next sendParams
export const sendBrush = (photoId, { maskId, channel, pts, size, flow, erase }) =>
  worker.postMessage({ type: MSG.BRUSH, photoId, maskId, channel, pts, size, flow, erase })

// AI-mask weights (quarter-res Uint8, transferred) → brushTex channel; the
// worker retains them CPU-side and re-merges on every brush replay
export const sendMaskTex = (photoId, { maskId, channel, width, height, data }) =>
  worker.postMessage({ type: MSG.MASKTEX, photoId, maskId, channel, width, height, data },
    [data.buffer])

// removal input: the capture inside rect ([x, y, w, h], final source space)
// at width × height → { data: RGBA8 sRGB of linear ÷ scale, width, height, scale }
export const requestRegion = (photoId, rect, width, height) =>
  request({ type: MSG.REGION, photoId, rect, width, height })

// a removal patch's pixels (RGBA8, transferred); the doc decides where it draws
export const sendPatch = (photoId, patchId, { width, height, data }) =>
  worker.postMessage({ type: MSG.PATCH, photoId, patchId, width, height, data }, [data.buffer])

// AI denoise: the port the denoise tiles for this photo will arrive on
export const sendDenoisePort = (photoId, port) =>
  worker.postMessage({ type: MSG.DN_PORT, photoId, port }, [port])

// an imported DCP camera profile's bytes (copied: the store keeps its own)
export const sendProfile = (profileId, bytes) =>
  worker.postMessage({ type: MSG.PROFILE, profileId, bytes: bytes.slice(0) })
