import { useSyncExternalStore } from 'react'
import { CO } from '../compose/protocol.js'
import { renderWorker, onRenderEvent } from './renderClient.js'
import { loadOriginal, getCatalogState } from './catalogStore.js'
import { decode } from './decodeClient.js'

// Main-thread side of Compose: a mirror of the worker's document, tool
// state, and promise wrappers for the protocol. Compose runs in the render
// worker (it shares the GPU with Develop), so requests go to that worker
// with string ids, which keep them apart from Develop's numeric ones.

let seq = 0
const waiters = new Map()
const listeners = new Set()
const emit = () => { for (const fn of listeners) fn() }
const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn) }

export const TOOL_DEFAULTS = {
  move: { autoSelect: false },
  marquee: { shape: 'rect', feather: 0, mode: 'new' },
  lasso: { kind: 'free', feather: 0, mode: 'new' },
  wand: { tolerance: 32, contiguous: true, sampleAll: true, mode: 'new' },
  aiselect: { kind: 'object', refine: true, mode: 'new' },
  brush: { size: 40, hardness: 0.8, opacity: 1, flow: 1, spacing: 0.15, smoothing: 0.2, pressure: 'size' },
  eraser: { size: 40, hardness: 0.8, opacity: 1, flow: 1, spacing: 0.15, smoothing: 0.2, pressure: 'size' },
  smudge: { size: 40, hardness: 0.5, strength: 0.6, spacing: 0.1, pressure: 'strength' },
  clone: { size: 60, hardness: 0.6, opacity: 1, flow: 1, spacing: 0.15, sample: 'below', aligned: true, pressure: 'size' },
  heal: { size: 60, hardness: 0.6, opacity: 1, flow: 1, spacing: 0.15, sample: 'below', aligned: true, pressure: 'size' },
  dodge: { size: 120, hardness: 0.3, exposure: 0.15, range: 'mid', mode: 'dodge', spacing: 0.15, pressure: 'flow' },
  gradient: { kind: 'linear' },
  text: { font: 'IBM Plex Sans', size: 96, weight: 400 },
  shape: { type: 'rect', radius: 0, sides: 6 },
  crop: {},
  liquify: { mode: 'push', size: 160, pressure: 0.5, rate: 0.5 },
  eyedropper: { sample: 'all' },
  hand: {}, zoom: {}, transform: {},
}

let state = {
  ready: false,
  error: null,
  features: null,
  doc: null,
  history: { labels: [], at: -1 },
  selection: null, // { bounds, outline }
  stats: null,
  thumbGen: 0,
  docs: null, // recent documents
  tool: 'move',
  opts: TOOL_DEFAULTS,
  fg: [1, 1, 1, 1],
  bg: [0, 0, 0, 1],
  view: { zoom: 1, offX: 0, offY: 0, fitted: true },
  editingSmart: null, // { nodeId, photoId } while a smart object is open in Develop
  paintTarget: 'pixels', // 'pixels' | 'mask' — what brushes paint on
  cloneSource: null, // [x, y] document px, set with ⌥-click
  panel: 'layers',
}

export const thumbs = new Map() // `${nodeId}/content|mask` → ImageBitmap

export const useCompose = () => useSyncExternalStore(subscribe, () => state)
export const getCompose = () => state
const set = (patch) => { state = { ...state, ...patch }; emit() }

export function request(msg, transfer) {
  const w = renderWorker()
  if (!w) return Promise.reject(new Error('render worker not started'))
  const id = `c${++seq}`
  return new Promise((resolve, reject) => {
    waiters.set(id, { resolve, reject })
    w.postMessage({ id, ...msg }, transfer ?? [])
  })
}
const send = (msg, transfer) => renderWorker()?.postMessage(msg, transfer ?? [])

let unlisten = null
export async function initCompose(canvasEl) {
  if (state.ready || unlisten) return
  unlisten = onRenderEvent(onMessage)
  const offscreen = canvasEl.transferControlToOffscreen()
  try {
    const r = await request({ type: CO.INIT, canvas: offscreen }, [offscreen])
    set({ ready: true, features: r.features })
  } catch (err) {
    set({ error: String(err.message ?? err) })
  }
}

function onMessage(data) {
  if (typeof data.re === 'string' && waiters.has(data.re)) {
    const { resolve, reject } = waiters.get(data.re)
    waiters.delete(data.re)
    if (data.ok) resolve(data)
    else reject(new Error(data.message ?? 'Compose error'))
    return
  }
  if (data.type === CO.CHANGED) {
    set({ doc: data.doc, history: data.history, selection: data.selection, stats: data.stats })
    for (const id of data.needSources ?? []) supplySource(id)
    return
  }
  if (data.type === CO.THUMBS) {
    for (const t of data.thumbs) {
      const k = `${t.id}/${t.which}`
      thumbs.get(k)?.close?.()
      thumbs.set(k, t.bitmap)
    }
    set({ thumbGen: state.thumbGen + 1 })
  }
}

// a smart object whose original the worker doesn't hold yet (a document
// reopened later): load and decode it from the catalog
const supplying = new Set()
async function supplySource(photoId) {
  if (supplying.has(photoId)) return
  supplying.add(photoId)
  try {
    const photo = getCatalogState().photos.find((p) => String(p.id) === String(photoId))
    const { buffer, name } = embedded.get(String(photoId)) ?? await loadOriginal(photoId)
    let source
    if (photo?.isRaw ?? /\.(cr2|cr3|nef|nrw|arw|srf|sr2|dng|raf|orf|rw2|pef|srw|raw|erf|kdc|3fr|mrw|iiq|rwl|x3f)$/i.test(name)) {
      source = await decode(photoId, buffer, name, 'full')
    } else {
      source = await createImageBitmap(new Blob([buffer]))
    }
    await request({ type: CO.SOURCE, photoId, source }, source instanceof ImageBitmap ? [source] : [source.buffer.buffer])
  } catch (err) {
    console.warn('[compose] smart object source', photoId, err)
  } finally {
    supplying.delete(photoId)
  }
}

// ── documents ──────────────────────────────────────────────────────────────
export const newDocument = (width, height, { depth = 16, background = 'white', name = 'Untitled' } = {}) =>
  request({ type: CO.NEW, width, height, depth, background, name }).then(fitSoon)
export async function openImage(blobOrBitmap, name, depth = 16) {
  const bitmap = blobOrBitmap instanceof ImageBitmap ? blobOrBitmap : await createImageBitmap(blobOrBitmap, { colorSpaceConversion: 'default' })
  return request({ type: CO.OPEN_IMAGE, bitmap, name, depth }, [bitmap]).then(fitSoon)
}
export const fromPhoto = (photoId, name, editDoc, depth = 16) =>
  request({ type: CO.FROM_PHOTO, photoId, name, editDoc, depth }).then(fitSoon)
export async function placeImage(blobOrBitmap, name) {
  const bitmap = blobOrBitmap instanceof ImageBitmap ? blobOrBitmap : await createImageBitmap(blobOrBitmap)
  return request({ type: CO.ADD_IMAGE, bitmap, name }, [bitmap])
}
export const placeSmart = (photoId, name, editDoc) => request({ type: CO.ADD_SMART, photoId, name, editDoc })
export const closeDocument = () => request({ type: CO.CLOSE })
export const saveDocument = () => request({ type: CO.SAVE })
export const loadDocument = (docId) => request({ type: CO.LOAD, docId }).then(fitSoon)
export const deleteDocument = (docId) => request({ type: CO.DELETE, docId }).then(refreshDocs)
let docUrls = []
export async function refreshDocs() {
  const { docs } = await request({ type: CO.LIST })
  for (const u of docUrls) URL.revokeObjectURL(u)
  docUrls = []
  const list = docs.map((d) => {
    const thumbUrl = d.thumb ? URL.createObjectURL(new Blob([d.thumb], { type: 'image/jpeg' })) : null
    if (thumbUrl) docUrls.push(thumbUrl)
    return { ...d, thumb: undefined, thumbUrl }
  })
  set({ docs: list })
  return list
}

// ── operations ─────────────────────────────────────────────────────────────
// args ride in their own field: an op may well take an argument named `type`
export const op = (name, args = {}, transfer) => request({ type: CO.OP, op: name, args }, transfer)
export const preview = (nodeId, patch, end = false) => send({ type: CO.PREVIEW, nodeId, patch, end })
export const undo = () => request({ type: CO.UNDO })
export const redo = () => request({ type: CO.REDO })
export const jump = (to) => request({ type: CO.JUMP, to })
export const exportDoc = (format, opts = {}) => request({ type: CO.EXPORT, format, ...opts }).then((r) => r.blob)
export const getPixel = (x, y) => request({ type: CO.GET_PIXEL, x, y }).then((r) => r.px)
export const readRegion = (rect, source = 'composite', nodeId) => request({ type: CO.READ_REGION, rect, source, nodeId })
export const stats = () => request({ type: CO.STATS })
export const selectOp = (args) => request({ type: CO.SELECT, ...args })
export const transform = (nodeId, xf, commit = false) =>
  commit ? request({ type: CO.TRANSFORM, nodeId, xf, commit }) : send({ type: CO.TRANSFORM, nodeId, xf, commit })
export const liquify = (args) => send({ type: CO.LIQUIFY, ...args })
export const liquifyEnd = (args) => request({ type: CO.LIQUIFY, ...args, phase: 'end' })
export async function importFile(bytes, name, kind) {
  // .albedo carries the originals of its smart objects: hold on to them
  let originals = []
  if (kind === 'albedo') {
    const { zipRead } = await import('../io/zip.js')
    originals = zipRead(bytes).filter((e) => e.name.startsWith('originals/'))
  }
  for (const o of originals) {
    const [, photoId, file] = o.name.split('/')
    embedded.set(photoId, { buffer: o.data.slice().buffer, name: file })
  }
  const r = await request({ type: CO.IMPORT, bytes, name, kind }, [bytes.buffer])
  fitSoon(r)
  return r
}
const embedded = new Map() // photoId → original bytes from an .albedo file

// strokes: points batched per animation frame
let strokePts = []
let strokeRaf = 0
export const strokeBegin = (args) => request({ type: CO.STROKE_BEGIN, ...args })
export function strokePoint(p) {
  strokePts.push(p)
  if (strokeRaf) return
  strokeRaf = requestAnimationFrame(flushStroke)
}
function flushStroke() {
  strokeRaf = 0
  if (!strokePts.length) return
  send({ type: CO.STROKE_PTS, pts: strokePts })
  strokePts = []
}
export function strokeEnd() {
  if (strokeRaf) cancelAnimationFrame(strokeRaf)
  flushStroke()
  return request({ type: CO.STROKE_END })
}

// ── view ───────────────────────────────────────────────────────────────────
let stageSize = { w: 0, h: 0 }
let surround = [0.11, 0.11, 0.11]
export function setStage(w, h, color) {
  stageSize = { w, h }
  if (color) surround = color
  if (state.view.fitted) fit()
  else pushView()
}
export function setView(patch) {
  set({ view: { ...state.view, ...patch } })
  pushView()
}
export function fit() {
  const d = state.doc
  if (!d || stageSize.w < 40) return
  const pad = 28
  const zoom = Math.min((stageSize.w - pad * 2) / d.width, (stageSize.h - pad * 2) / d.height, 4)
  set({ view: { zoom, offX: (stageSize.w - d.width * zoom) / 2, offY: (stageSize.h - d.height * zoom) / 2, fitted: true } })
  pushView()
}
export function zoomAt(factor, cx, cy) {
  const v = state.view
  const zoom = Math.min(64, Math.max(0.01, v.zoom * factor))
  const k = zoom / v.zoom
  setView({ zoom, offX: cx - (cx - v.offX) * k, offY: cy - (cy - v.offY) * k, fitted: false })
}
export function actualPixels(cx = stageSize.w / 2, cy = stageSize.h / 2) {
  zoomAt((1 / devicePixelRatio) / state.view.zoom, cx, cy)
}
function pushView() {
  const v = state.view
  send({ type: CO.VIEW, w: stageSize.w, h: stageSize.h, dpr: Math.min(devicePixelRatio, 2), zoom: v.zoom, offX: v.offX, offY: v.offY, surround })
}
export const fitSoonPublic = (r) => fitSoon(r)
function fitSoon(r) {
  set({ view: { ...state.view, fitted: true } })
  setTimeout(fit, 0)
  return r
}
export const toDoc = (x, y) => [(x - state.view.offX) / state.view.zoom, (y - state.view.offY) / state.view.zoom]
export const toScreen = (x, y) => [x * state.view.zoom + state.view.offX, y * state.view.zoom + state.view.offY]

// ── tools ──────────────────────────────────────────────────────────────────
export const setTool = (tool) => { if (tool !== state.tool) set({ tool }) }
export const setToolOpts = (tool, patch) => set({ opts: { ...state.opts, [tool]: { ...state.opts[tool], ...patch } } })
export const setColors = (patch) => set(patch)
export const swapColors = () => set({ fg: state.bg, bg: state.fg })
export const resetColors = () => set({ fg: [1, 1, 1, 1], bg: [0, 0, 0, 1] })
export const setPanel = (panel) => set({ panel })
export const setPaintTarget = (paintTarget) => set({ paintTarget })
export const setCloneSource = (cloneSource) => set({ cloneSource })
export const setEditingSmart = (editingSmart) => set({ editingSmart })

// e2e hook
export const composeE2e = { state: getCompose, request, op, getPixel, stats, exportDoc, fit, setView, toDoc }
