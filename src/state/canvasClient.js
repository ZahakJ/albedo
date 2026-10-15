import { useSyncExternalStore } from 'react'
import { CV, cvMsgId } from '../workers/canvasProtocol.js'
import { exportPhoto } from './renderClient.js'
import { getState as getEditState } from './editStore.js'
import { setSurface } from './viewStore.js'

// Thin proxy between React and the canvas worker (renderClient pattern) plus
// the plain-module store for everything UI-side the canvas surface needs:
// tool state, view transform, the worker's doc mirror, history labels.
// Pixel truth lives in the worker; this mirror is metadata only.

let worker = null
const replyWaiters = new Map()
const listeners = new Set()
const emit = () => { for (const fn of listeners) fn() }
const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn) }

let state = {
  ready: false,
  filtersOK: false,
  doc: null, // worker mirror: { id, name, width, height, activeLayer, selection, layers[] bottom→top }
  history: { labels: [], redoLabels: [] },
  dirty: false,
  thumbGen: 0, // bumped when layer thumbnails refresh (bitmaps live in `thumbs`)
  docsList: null, // recent documents [{ id, name, width, height, updatedAt, thumbUrl }]
  tool: 'move', // move | brush | eraser | clone | select | fill | text | crop
  fg: '#ffffff',
  opts: {
    brush: { size: 32, hardness: 0.7, opacity: 1 },
    eraser: { size: 32, hardness: 0.7, opacity: 1 },
    clone: { size: 48, hardness: 0.6, opacity: 1 },
    select: { shape: 'rect', feather: 0 }, // rect | ellipse | lasso
    text: { size: 48, weight: 400 },
  },
  cloneSrc: null, // [x, y] doc coords (Alt-click)
  view: { zoom: 1, offX: 0, offY: 0, fitted: true },
}

export const useCanvasState = () => useSyncExternalStore(subscribe, () => state)
export const getCanvasState = () => state

export const thumbs = new Map() // layerId → ImageBitmap (drawn by LayerRow)

const set = (patch) => { state = { ...state, ...patch }; emit() }

const request = (msg, transfer) => new Promise((resolve, reject) => {
  const id = cvMsgId()
  replyWaiters.set(id, { resolve, reject })
  worker.postMessage({ id, ...msg }, transfer ?? [])
})

// ── autosave: debounced write-behind after any dirtying change ─────────────
let saveTimer = 0
function scheduleAutosave() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { if (state.doc) request({ type: CV.SAVE }).catch(() => {}) }, 2500)
}

export function initCanvas(canvasEl) {
  worker = new Worker(new URL('../workers/canvas.worker.js', import.meta.url), { type: 'module' })
  worker.onerror = (e) => console.error('[canvas.worker]', e.message ?? e)
  worker.onmessage = ({ data }) => {
    if (data.type === CV.ERROR && !data.re) console.error('[canvas.worker]', data.message)
    if (data.re && replyWaiters.has(data.re)) {
      const { resolve, reject } = replyWaiters.get(data.re)
      replyWaiters.delete(data.re)
      data.type === CV.ERROR ? reject(new Error(data.message)) : resolve(data)
    }
    if (data.type === CV.CHANGED) {
      for (const b of thumbs.values()) b.close?.()
      thumbs.clear()
      for (const t of data.thumbs ?? []) thumbs.set(t.layerId, t.bitmap)
      set({ doc: data.doc, history: data.history, dirty: data.dirty, thumbGen: state.thumbGen + 1 })
      if (data.dirty && data.doc) scheduleAutosave()
    }
  }
  const offscreen = canvasEl.transferControlToOffscreen()
  return request({ type: CV.INIT, canvas: offscreen }, [offscreen]).then((r) => {
    set({ ready: true, filtersOK: r.filters })
    return r
  })
}

// ── document lifecycle ─────────────────────────────────────────────────────
export const newDocument = (width, height, background, name) =>
  request({ type: CV.NEW_DOC, width, height, background, name })

export async function openImageAsDoc(source, name, layerName) {
  const bitmap = source instanceof ImageBitmap ? source : await createImageBitmap(source)
  return request({ type: CV.OPEN_IMAGE, bitmap, name, layerName }, [bitmap])
}

export const loadCanvasDoc = (docId) => request({ type: CV.LOAD_DOC, docId })
export const closeCanvasDoc = () => request({ type: CV.CLOSE_DOC })
export const saveCanvasDoc = () => request({ type: CV.SAVE })
export const deleteCanvasDoc = (docId) => request({ type: CV.DELETE_DOC, docId })

let docUrls = []
export async function refreshDocsList() {
  const { docs } = await request({ type: CV.LIST_DOCS })
  for (const u of docUrls) URL.revokeObjectURL(u)
  docUrls = []
  const docsList = docs.map((d) => {
    let thumbUrl = null
    if (d.thumb) {
      thumbUrl = URL.createObjectURL(new Blob([d.thumb], { type: 'image/png' }))
      docUrls.push(thumbUrl)
    }
    return { ...d, thumb: undefined, thumbUrl }
  })
  set({ docsList })
  return docsList
}

// ── layers ─────────────────────────────────────────────────────────────────
export const setActiveLayer = (layerId) => worker.postMessage({ type: CV.SET_ACTIVE, layerId })
export const previewLayerProps = (layerId, patch) =>
  worker.postMessage({ type: CV.PROPS_PREVIEW, layerId, patch })
export const commitLayerProps = (layerId, patch, before, label) =>
  worker.postMessage({ type: CV.PROPS_COMMIT, layerId, patch, before, label })
export const addLayer = (opts = { kind: 'raster' }) => request({ type: CV.ADD_LAYER, ...opts })
export const addImageLayer = async (source) => {
  const bitmap = source instanceof ImageBitmap ? source : await createImageBitmap(source)
  return request({ type: CV.ADD_LAYER, kind: 'raster', bitmap, name: bitmap ? 'Image' : 'Layer' }, [bitmap])
}
export const deleteLayer = (layerId) => worker.postMessage({ type: CV.DELETE_LAYER, layerId })
export const duplicateLayer = (layerId) => worker.postMessage({ type: CV.DUPLICATE, layerId })
export const mergeDown = (layerId) => worker.postMessage({ type: CV.MERGE_DOWN, layerId })
export const flattenDoc = () => worker.postMessage({ type: CV.FLATTEN })
export const reorderLayers = (from, to) => worker.postMessage({ type: CV.REORDER, from, to })

// ── strokes (pts batched per animation frame) ──────────────────────────────
let penPts = []
let penRaf = 0
let penTimer = 0
export const beginStroke = (opts) => worker.postMessage({ type: CV.BEGIN_STROKE, ...opts })
export function strokePoint(x, y, pressure) {
  penPts.push([x, y, pressure])
  if (penRaf || penTimer) return
  const flush = () => {
    if (penRaf) cancelAnimationFrame(penRaf)
    clearTimeout(penTimer)
    penRaf = 0
    penTimer = 0
    if (!penPts.length) return
    worker.postMessage({ type: CV.STROKE_PTS, pts: penPts })
    penPts = []
  }
  penRaf = requestAnimationFrame(flush)
  penTimer = setTimeout(flush, 33)
}
export function endStroke() {
  if (penPts.length) { worker.postMessage({ type: CV.STROKE_PTS, pts: penPts }); penPts = [] }
  worker.postMessage({ type: CV.END_STROKE })
}

export const fillLayer = (layerId, color) => worker.postMessage({ type: CV.FILL, layerId, color })
export const gradientLayer = (layerId, x0, y0, x1, y1, color) =>
  worker.postMessage({ type: CV.GRADIENT, layerId, x0, y0, x1, y1, color })
export const setSelectionShapes = (shapes, feather) =>
  worker.postMessage({ type: CV.SET_SELECTION, shapes, feather })
export const transformPreview = (layerId, m) =>
  worker.postMessage({ type: CV.TRANSFORM_PREVIEW, layerId, m })
export const transformCommit = (layerId, m) =>
  worker.postMessage({ type: CV.TRANSFORM_COMMIT, layerId, m })
export const adjustLayer = (layerId, kind, params) =>
  request({ type: CV.ADJUST, layerId, kind, params })
export const cropDoc = (x, y, w, h) => worker.postMessage({ type: CV.CROP, x, y, w, h })

export const cvUndo = () => worker.postMessage({ type: CV.UNDO })
export const cvRedo = () => worker.postMessage({ type: CV.REDO })
export const cvJump = (delta) => worker.postMessage({ type: CV.JUMP, delta })

export const exportFlattened = (mime, quality) => request({ type: CV.EXPORT, mime, quality })
export const getWorkerDoc = () => request({ type: CV.GET_DOC }).then((r) => r.doc)
export const getPixel = (layerId, x, y) =>
  request({ type: CV.GET_PIXEL, layerId, x, y }).then((r) => r.px)
export const getLayerBounds = (layerId) =>
  request({ type: CV.GET_BOUNDS, layerId }).then((r) => r.bounds)

export const sendViewport = (w, h, dpr, zoom, offX, offY) =>
  worker?.postMessage({ type: CV.VIEW, w, h, dpr, zoom, offX, offY })

// 'Edit in Canvas': render the developed photo at full res → new doc with the
// result as base layer, then land on the canvas surface
export async function openDevelopedInCanvas() {
  const { photo, doc } = getEditState()
  if (!photo || !doc) return
  const { blob } = await exportPhoto(photo.id, doc, { type: 'image/png' })
  await openImageAsDoc(blob, photo.name.replace(/\.[^.]+$/, ''), 'Photo')
  setSurface('canvas')
}

// drop onto the canvas surface: doc open → new layer; no doc → new document
export async function dropImageFiles(files) {
  const imgs = [...files].filter((f) => /^image\//.test(f.type))
  if (!imgs.length) return false
  if (state.doc) await addImageLayer(imgs[0])
  else await openImageAsDoc(imgs[0], imgs[0].name.replace(/\.[^.]+$/, ''))
  return true
}

// ── UI-side state ──────────────────────────────────────────────────────────
export const setTool = (tool) => { if (tool !== state.tool) set({ tool }) }
export const setFg = (fg) => set({ fg })
export const setToolOpts = (tool, patch) =>
  set({ opts: { ...state.opts, [tool]: { ...state.opts[tool], ...patch } } })
export const setCloneSrc = (cloneSrc) => set({ cloneSrc })
export const setCanvasView = (patch) => set({ view: { ...state.view, ...patch } })

// e2e hook — installed onto window.__albedo by App
export const canvasE2e = {
  getDoc: getWorkerDoc,
  getLayerPixel: (layerId, x, y) => getPixel(layerId, x, y),
  getCompositePixel: (x, y) => getPixel(null, x, y),
  getLayerBounds,
  state: getCanvasState,
}
