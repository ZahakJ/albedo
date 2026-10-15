// CANVAS compositor worker — owns the document raster state (one doc-sized
// OffscreenCanvas per raster layer), composites via 2D globalCompositeOperation
// (natively the whole Photoshop blend set), and draws the result into the
// transferred view canvas with the current view transform. The UI thread owns
// tool state and sends ops; nothing here ever touches React.
//
// Undo: op-based where cheap (layer props, reorder, text) + surface snapshots
// for pixel ops (stroke end, fill, adjust, transform) + whole-doc captures for
// structural ops (crop, merge, flatten). Budgeted at ~256MB of retained
// bitmaps with oldest-first eviction — undo depth shrinks gracefully.

import { CV } from './canvasProtocol.js'
import { writeFile, writeFileAtomic, readFile, getDir, deleteDir } from '../io/opfs.js'
import { newDoc, newLayer, shapePath } from '../edit/docModel.js'

// ── state ──────────────────────────────────────────────────────────────────
let view = null // transferred display canvas
let vctx = null
let vs = { w: 0, h: 0, dpr: 1, zoom: 1, offX: 0, offY: 0 } // view transform (css px)
let doc = null // { id, name, width, height, layers (bottom→top), activeLayer }
const surfaces = new Map() // layerId → OffscreenCanvas (doc-sized, local = doc − layer.x/y)
const textCache = new Map() // layerId → { key, canvas, pad }
let selection = null // { shapes, feather, mask: OffscreenCanvas }
let stroke = null // live stroke session
let xformPreview = null // { layerId, m } — draw-time only
let filtersOK = false
let dirty = false
let comp = null // reused doc-sized composite scratch
let mergeScratch = null // reused doc-sized live-stroke merge scratch
let clipScratch = null // reused buffer-clip scratch

const post = (msg, transfer) => self.postMessage(msg, transfer ?? [])
const reply = (id, payload = {}, transfer) => post({ re: id, ok: true, ...payload }, transfer)
const fail = (id, message) => post({ type: CV.ERROR, re: id, message })

// IBM Plex for worker-side text rendering (workers don't inherit page fonts)
const fontReady = (async () => {
  try {
    const faces = [
      new FontFace('IBM Plex Sans', `url(${new URL('../styles/fonts/IBMPlexSans-Regular.woff2', import.meta.url)})`, { weight: '400' }),
      new FontFace('IBM Plex Sans', `url(${new URL('../styles/fonts/IBMPlexSans-Medium.woff2', import.meta.url)})`, { weight: '500' }),
    ]
    await Promise.all(faces.map((f) => f.load()))
    for (const f of faces) self.fonts.add(f)
  } catch { /* text falls back to sans-serif */ }
})()

// ── undo ───────────────────────────────────────────────────────────────────
const BUDGET = 256 * 1024 * 1024
const MAX_DEPTH = 60
let undoStack = [] // [{ type, label, bytes, … }]
let redoStack = []

const surfBytes = (s) => (s ? s.width * s.height * 4 : 0)

function snap(s) {
  const c = new OffscreenCanvas(s.width, s.height)
  c.getContext('2d').drawImage(s, 0, 0)
  return c
}

const entryBytes = (e) => e.bytes ?? 0
const stackBytes = () => undoStack.reduce((n, e) => n + entryBytes(e), 0) +
  redoStack.reduce((n, e) => n + entryBytes(e), 0)

function pushUndo(entry) {
  redoStack = []
  undoStack.push(entry)
  while (undoStack.length > 1 && (undoStack.length > MAX_DEPTH || stackBytes() > BUDGET))
    undoStack.shift() // oldest history quietly ages out
  dirty = true
}

function captureDoc() {
  return {
    width: doc.width,
    height: doc.height,
    activeLayer: doc.activeLayer,
    layers: doc.layers.map((l) => JSON.parse(JSON.stringify(l))),
    surfaces: new Map(doc.layers.filter((l) => l.kind === 'raster')
      .map((l) => [l.id, surfaces.get(l.id)])),
    bytes: doc.layers.reduce((n, l) => n + surfBytes(surfaces.get(l.id)), 0),
  }
}

function restoreDoc(cap) {
  doc.width = cap.width
  doc.height = cap.height
  doc.activeLayer = cap.activeLayer
  doc.layers = cap.layers.map((l) => JSON.parse(JSON.stringify(l)))
  for (const [id, s] of cap.surfaces) surfaces.set(id, s)
  comp = null
  mergeScratch = null
  clipScratch = null
  setSelection(null, 0)
}

const layerOf = (id) => doc?.layers.find((l) => l.id === id)
const layerIndex = (id) => doc.layers.findIndex((l) => l.id === id)

function applyEntry(e, dir) { // dir: 'undo' | 'redo'
  const back = dir === 'undo'
  switch (e.type) {
    case 'props': {
      const l = layerOf(e.layerId)
      if (l) Object.assign(l, back ? e.before : e.after)
      if (l?.kind === 'text') textCache.delete(l.id)
      break
    }
    case 'pixels': {
      const l = layerOf(e.layerId)
      if (!l) break
      if (back) {
        e.after = { surf: surfaces.get(e.layerId), x: l.x, y: l.y }
        surfaces.set(e.layerId, e.before.surf)
        l.x = e.before.x; l.y = e.before.y
      } else {
        surfaces.set(e.layerId, e.after.surf)
        l.x = e.after.x; l.y = e.after.y
      }
      break
    }
    case 'add': case 'del': {
      const removing = (e.type === 'add') === back
      if (removing) {
        const i = layerIndex(e.layer.id)
        if (i >= 0) doc.layers.splice(i, 1)
        if (doc.activeLayer === e.layer.id)
          doc.activeLayer = doc.layers[Math.min(e.index, doc.layers.length - 1)]?.id ?? null
      } else {
        doc.layers.splice(Math.min(e.index, doc.layers.length), 0, JSON.parse(JSON.stringify(e.layer)))
        if (e.surf) surfaces.set(e.layer.id, e.surf)
        doc.activeLayer = e.layer.id
      }
      break
    }
    case 'reorder': {
      const [from, to] = back ? [e.to, e.from] : [e.from, e.to]
      const [l] = doc.layers.splice(from, 1)
      doc.layers.splice(to, 0, l)
      break
    }
    case 'doc': {
      if (back) { e.after = captureDoc(); restoreDoc(e.before) }
      else restoreDoc(e.after)
      break
    }
  }
}

function undo() {
  if (!undoStack.length) return
  const e = undoStack.pop()
  applyEntry(e, 'undo')
  redoStack.push(e)
  dirty = true
}

function redo() {
  if (!redoStack.length) return
  const e = redoStack.pop()
  applyEntry(e, 'redo')
  undoStack.push(e)
  dirty = true
}

// ── text layers ────────────────────────────────────────────────────────────
function textSurface(l) {
  const key = JSON.stringify(l.text)
  const hit = textCache.get(l.id)
  if (hit?.key === key) return hit
  const t = l.text
  const size = Math.max(1, t.size)
  const pad = Math.ceil(size * 0.5)
  const font = `${t.weight ?? 400} ${size}px "IBM Plex Sans", sans-serif`
  const lines = String(t.content ?? '').split('\n')
  const lineH = Math.round(size * 1.25)
  const mctx = new OffscreenCanvas(1, 1).getContext('2d')
  mctx.font = font
  const wid = Math.max(1, ...lines.map((s) => Math.ceil(mctx.measureText(s).width)))
  const asc = Math.ceil(mctx.measureText('Mg').actualBoundingBoxAscent || size * 0.8)
  const c = new OffscreenCanvas(wid + pad * 2, lineH * lines.length + pad * 2)
  const ctx = c.getContext('2d')
  ctx.font = font
  ctx.fillStyle = t.color ?? '#ffffff'
  ctx.textBaseline = 'alphabetic'
  lines.forEach((s, i) => ctx.fillText(s, pad, pad + asc + i * lineH))
  const entry = { key, canvas: c, pad }
  textCache.set(l.id, entry)
  return entry
}

// draw one layer's bitmap at its doc position into ctx (doc coords)
function drawLayerContent(ctx, l) {
  if (l.kind === 'raster') {
    const s = surfaces.get(l.id)
    if (s) ctx.drawImage(s, l.x, l.y)
  } else {
    const t = textSurface(l)
    ctx.drawImage(t.canvas, l.x - t.pad, l.y - t.pad)
  }
}

// ── compositing ────────────────────────────────────────────────────────────
function ensureScratch(ref) {
  if (!ref || ref.width !== doc.width || ref.height !== doc.height)
    return new OffscreenCanvas(doc.width, doc.height)
  return ref
}

// clipped copy of the live stroke buffer (selection mask applied)
function clippedBuffer() {
  if (!selection?.mask) return stroke.buffer
  clipScratch = ensureScratch(clipScratch)
  const c = clipScratch.getContext('2d')
  c.save()
  c.globalCompositeOperation = 'source-over'
  c.clearRect(0, 0, doc.width, doc.height)
  c.drawImage(stroke.buffer, 0, 0)
  c.globalCompositeOperation = 'destination-in'
  c.drawImage(selection.mask, 0, 0)
  c.restore()
  return clipScratch
}

function drawComposite(ctx) {
  ctx.save()
  ctx.clearRect(0, 0, doc.width, doc.height)
  for (const l of doc.layers) {
    if (!l.visible) continue
    ctx.globalAlpha = l.opacity
    ctx.globalCompositeOperation = l.blend
    if (stroke && stroke.layerId === l.id) {
      // live stroke: merge layer + buffer in isolation, then blend as the layer
      mergeScratch = ensureScratch(mergeScratch)
      const m = mergeScratch.getContext('2d')
      m.save()
      m.globalCompositeOperation = 'source-over'
      m.globalAlpha = 1
      m.clearRect(0, 0, doc.width, doc.height)
      drawLayerContent(m, l)
      m.globalAlpha = stroke.opacity
      if (stroke.tool === 'eraser') m.globalCompositeOperation = 'destination-out'
      m.drawImage(clippedBuffer(), 0, 0)
      m.restore()
      ctx.drawImage(mergeScratch, 0, 0)
    } else if (xformPreview && xformPreview.layerId === l.id) {
      ctx.save()
      const m = xformPreview.m
      ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5])
      drawLayerContent(ctx, l)
      ctx.restore()
    } else {
      drawLayerContent(ctx, l)
    }
  }
  ctx.restore()
}

function compositeNow() {
  comp = ensureScratch(comp)
  drawComposite(comp.getContext('2d'))
  return comp
}

// checkerboard pattern (screen space, theme-neutral grays)
let checker = null
function checkerPattern(ctx) {
  if (!checker) {
    const c = new OffscreenCanvas(16, 16)
    const t = c.getContext('2d')
    t.fillStyle = '#3a3a3a'
    t.fillRect(0, 0, 16, 16)
    t.fillStyle = '#2b2b2b'
    t.fillRect(0, 0, 8, 8)
    t.fillRect(8, 8, 8, 8)
    checker = ctx.createPattern(c, 'repeat')
  }
  return checker
}

let redrawTimer = 0
function scheduleRedraw() {
  if (redrawTimer) return
  redrawTimer = setTimeout(() => { redrawTimer = 0; redraw() }, 8)
}

function redraw() {
  if (!view || !vctx) return
  const pw = Math.max(1, Math.round(vs.w * vs.dpr))
  const ph = Math.max(1, Math.round(vs.h * vs.dpr))
  if (view.width !== pw || view.height !== ph) { view.width = pw; view.height = ph }
  vctx.setTransform(1, 0, 0, 1, 0, 0)
  vctx.clearRect(0, 0, pw, ph)
  if (!doc) return
  const scale = vs.zoom * vs.dpr
  const ox = vs.offX * vs.dpr
  const oy = vs.offY * vs.dpr
  const dw = doc.width * scale
  const dh = doc.height * scale
  // checker under transparency, clipped to the document rect
  vctx.save()
  vctx.beginPath()
  vctx.rect(ox, oy, dw, dh)
  vctx.clip()
  vctx.fillStyle = checkerPattern(vctx)
  vctx.fillRect(ox, oy, dw, dh)
  vctx.restore()
  const c = compositeNow()
  vctx.imageSmoothingEnabled = vs.zoom < 1
  vctx.imageSmoothingQuality = 'high'
  vctx.drawImage(c, ox, oy, dw, dh)
}

// ── change broadcast (doc mirror + history + layer thumbs) ────────────────
const publicDoc = () => doc && {
  id: doc.id,
  name: doc.name,
  width: doc.width,
  height: doc.height,
  activeLayer: doc.activeLayer,
  selection: selection ? { shapes: selection.shapes, feather: selection.feather } : null,
  layers: doc.layers.map((l) => JSON.parse(JSON.stringify(l))),
}

const THUMB_W = 44
const THUMB_H = 34
function layerThumbs() {
  if (!doc) return []
  const out = []
  const s = Math.min(THUMB_W / doc.width, THUMB_H / doc.height)
  for (const l of doc.layers) {
    const c = new OffscreenCanvas(THUMB_W, THUMB_H)
    const ctx = c.getContext('2d')
    ctx.translate((THUMB_W - doc.width * s) / 2, (THUMB_H - doc.height * s) / 2)
    ctx.scale(s, s)
    drawLayerContent(ctx, l)
    out.push({ layerId: l.id, bitmap: c.transferToImageBitmap() })
  }
  return out
}

function changed() {
  scheduleRedraw()
  const thumbs = layerThumbs()
  post({
    type: CV.CHANGED,
    doc: publicDoc(),
    history: {
      labels: undoStack.map((e) => e.label),
      redoLabels: redoStack.map((e) => e.label).reverse(),
    },
    dirty,
    thumbs,
  }, thumbs.map((t) => t.bitmap))
}

// ── selection ──────────────────────────────────────────────────────────────
function setSelection(shapes, feather) {
  if (!shapes?.length) { selection = null; return }
  const m = new OffscreenCanvas(doc.width, doc.height)
  const c = m.getContext('2d')
  for (const sh of shapes) {
    c.globalCompositeOperation = sh.op === 'subtract' ? 'destination-out' : 'source-over'
    c.fillStyle = '#fff'
    c.fill(shapePath(sh, new Path2D()))
  }
  let mask = m
  if (feather > 0 && filtersOK) {
    mask = new OffscreenCanvas(doc.width, doc.height)
    const b = mask.getContext('2d')
    b.filter = `blur(${feather}px)`
    b.drawImage(m, 0, 0)
  }
  selection = { shapes, feather, mask }
}

// paint src into layer surface honoring selection mask + eraser mode
function applyToLayer(l, src, alpha, erase) {
  let painted = src
  if (selection?.mask) {
    const tmp = snap(src)
    const tc = tmp.getContext('2d')
    tc.globalCompositeOperation = 'destination-in'
    tc.drawImage(selection.mask, 0, 0)
    painted = tmp
  }
  const lctx = surfaces.get(l.id).getContext('2d')
  lctx.save()
  lctx.globalAlpha = alpha
  if (erase) lctx.globalCompositeOperation = 'destination-out'
  lctx.drawImage(painted, -l.x, -l.y)
  lctx.restore()
}

// ── strokes ────────────────────────────────────────────────────────────────
function beginStroke(p) {
  const l = layerOf(p.layerId)
  if (!l || l.kind !== 'raster') return
  stroke = {
    tool: p.tool,
    layerId: p.layerId,
    size: p.size,
    hardness: Math.min(0.99, Math.max(0, p.hardness ?? 0.8)),
    opacity: p.opacity ?? 1,
    color: p.color ?? '#ffffff',
    buffer: new OffscreenCanvas(doc.width, doc.height),
    raw: [],
    carry: 0,
    before: { surf: snap(surfaces.get(p.layerId)), x: l.x, y: l.y },
  }
  if (p.tool === 'clone') {
    // sample from the merged visible state frozen at stroke start
    stroke.cloneSrc = snap(compositeNow())
    stroke.src = [p.srcX, p.srcY]
    stroke.cloneOff = null
  }
}

function stampAt(x, y, pressure) {
  const s = stroke
  const r = Math.max(0.5, (s.size / 2) * (0.3 + 0.7 * (pressure ?? 1)))
  const b = s.buffer.getContext('2d')
  if (s.tool === 'clone') {
    if (!s.cloneOff) s.cloneOff = [x - s.src[0], y - s.src[1]]
    const d = Math.ceil(r * 2) + 2
    const st = new OffscreenCanvas(d, d)
    const c = st.getContext('2d')
    c.drawImage(s.cloneSrc, -(x - r - s.cloneOff[0] - 1), -(y - r - s.cloneOff[1] - 1))
    c.globalCompositeOperation = 'destination-in'
    const g = c.createRadialGradient(r + 1, r + 1, r * s.hardness, r + 1, r + 1, r)
    g.addColorStop(0, 'rgba(0,0,0,1)')
    g.addColorStop(1, 'rgba(0,0,0,0)')
    c.fillStyle = g
    c.fillRect(0, 0, d, d)
    b.drawImage(st, x - r - 1, y - r - 1)
  } else {
    const g = b.createRadialGradient(x, y, r * s.hardness, x, y, r)
    g.addColorStop(0, s.color)
    g.addColorStop(1, fadeOut(s.color))
    b.fillStyle = g
    b.beginPath()
    b.arc(x, y, r, 0, Math.PI * 2)
    b.fill()
  }
}

// '#rrggbb' → same hue fully transparent (keeps gradient interpolation clean)
const fadeOut = (color) => (/^#[0-9a-f]{6}$/i.test(color) ? `${color}00` : 'rgba(0,0,0,0)')

// walk a quadratic (m1 → m2, ctrl p1) stamping every `spacing` px
function walkQuad(a, ctrl, b) {
  const s = stroke
  const spacing = Math.max(1, s.size * 0.25)
  const n = Math.max(2, Math.ceil((Math.hypot(ctrl[0] - a[0], ctrl[1] - a[1]) +
    Math.hypot(b[0] - ctrl[0], b[1] - ctrl[1]))))
  let px = a[0], py = a[1]
  for (let i = 1; i <= n; i++) {
    const t = i / n
    const u = 1 - t
    const x = u * u * a[0] + 2 * u * t * ctrl[0] + t * t * b[0]
    const y = u * u * a[1] + 2 * u * t * ctrl[1] + t * t * b[1]
    const pr = a[2] + (b[2] - a[2]) * t
    s.carry += Math.hypot(x - px, y - py)
    px = x; py = y
    if (s.carry >= spacing) { s.carry = 0; stampAt(x, y, pr) }
  }
}

const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]

function strokePts(pts) {
  if (!stroke) return
  const raw = stroke.raw
  for (const p of pts) {
    raw.push(p)
    if (raw.length === 1) stampAt(p[0], p[1], p[2])
    else if (raw.length >= 3) {
      const [p0, p1, p2] = raw.slice(-3)
      walkQuad(mid(p0, p1), p1, mid(p1, p2))
    }
  }
  scheduleRedraw()
}

function endStroke() {
  if (!stroke) return
  const s = stroke
  const raw = s.raw
  if (raw.length >= 2) { // finish the tail segment
    const p0 = raw[raw.length - 2]
    const p1 = raw[raw.length - 1]
    walkQuad(raw.length >= 3 ? mid(raw[raw.length - 3], p0) : p0, p0, p1)
    stampAt(p1[0], p1[1], p1[2])
  }
  const l = layerOf(s.layerId)
  stroke = null // composite path must not see the live-merge branch anymore
  if (l) {
    // applyToLayer selection-clips the buffer exactly like the live preview did
    applyToLayer(l, s.buffer, s.opacity, s.tool === 'eraser')
    pushUndo({
      type: 'pixels',
      label: s.tool === 'eraser' ? 'Eraser' : s.tool === 'clone' ? 'Clone stamp' : 'Brush',
      layerId: l.id,
      before: s.before,
      after: null,
      bytes: surfBytes(s.before.surf) * 2,
    })
  }
  changed()
}

// ── document lifecycle ─────────────────────────────────────────────────────
function resetDoc(next) {
  doc = next
  surfaces.clear()
  textCache.clear()
  selection = null
  stroke = null
  xformPreview = null
  undoStack = []
  redoStack = []
  comp = null
  mergeScratch = null
  clipScratch = null
  dirty = false
}

function makeSurface(fill) {
  const c = new OffscreenCanvas(doc.width, doc.height)
  if (fill && fill !== 'transparent') {
    const ctx = c.getContext('2d')
    ctx.fillStyle = fill === 'white' ? '#ffffff' : fill === 'black' ? '#000000' : fill
    ctx.fillRect(0, 0, doc.width, doc.height)
  }
  return c
}

async function saveDoc() {
  if (!doc) return
  const dir = `canvasdocs/${doc.id}`
  for (const l of doc.layers) {
    if (l.kind !== 'raster') continue
    const blob = await surfaces.get(l.id).convertToBlob({ type: 'image/png' })
    await writeFile(`${dir}/${l.id}.png`, await blob.arrayBuffer())
  }
  // composite thumb (≤320 long edge) for the recent-documents grid
  const c = compositeNow()
  const ts = Math.min(1, 320 / Math.max(doc.width, doc.height))
  const tc = new OffscreenCanvas(Math.max(1, Math.round(doc.width * ts)), Math.max(1, Math.round(doc.height * ts)))
  const tctx = tc.getContext('2d')
  tctx.fillStyle = '#222'
  tctx.fillRect(0, 0, tc.width, tc.height)
  tctx.drawImage(c, 0, 0, tc.width, tc.height)
  const thumbBlob = await tc.convertToBlob({ type: 'image/png' })
  await writeFile(`${dir}/thumb.png`, await thumbBlob.arrayBuffer())
  const json = { ...publicDoc(), selection: null, updatedAt: Date.now(), version: 1 }
  await writeFileAtomic(`${dir}/doc.json`, new TextEncoder().encode(JSON.stringify(json)))
  dirty = false
}

async function loadDocFromOpfs(docId) {
  const buf = await readFile(`canvasdocs/${docId}/doc.json`)
  const json = JSON.parse(new TextDecoder().decode(buf))
  resetDoc({
    id: json.id,
    name: json.name,
    width: json.width,
    height: json.height,
    activeLayer: json.activeLayer,
    layers: json.layers ?? [],
  })
  for (const l of doc.layers) {
    if (l.kind !== 'raster') continue
    const surf = makeSurface()
    try {
      const png = await readFile(`canvasdocs/${docId}/${l.id}.png`)
      const bmp = await createImageBitmap(new Blob([png], { type: 'image/png' }))
      surf.getContext('2d').drawImage(bmp, 0, 0)
      bmp.close?.()
    } catch { /* missing layer file → empty layer */ }
    surfaces.set(l.id, surf)
  }
  if (!doc.activeLayer) doc.activeLayer = doc.layers[doc.layers.length - 1]?.id ?? null
  await fontReady
}

async function listDocs() {
  const out = []
  let dir
  try { dir = await getDir('canvasdocs', true) } catch { return out }
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind !== 'directory') continue
    try {
      const meta = JSON.parse(new TextDecoder().decode(await readFile(`canvasdocs/${name}/doc.json`)))
      const thumb = await readFile(`canvasdocs/${name}/thumb.png`).catch(() => null)
      out.push({
        id: meta.id, name: meta.name, width: meta.width, height: meta.height,
        updatedAt: meta.updatedAt ?? 0, layerCount: meta.layers?.length ?? 0, thumb,
      })
    } catch { /* torn dir — skip */ }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt)
  return out
}

// content alpha bounds of a layer, doc coords
function layerBounds(l) {
  if (l.kind === 'text') {
    const t = textSurface(l)
    return { x: l.x, y: l.y, w: t.canvas.width - t.pad * 2, h: t.canvas.height - t.pad * 2 }
  }
  const s = surfaces.get(l.id)
  const { data, width, height } = s.getContext('2d').getImageData(0, 0, s.width, s.height)
  let x0 = width, y0 = height, x1 = -1, y1 = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  if (x1 < 0) return { x: l.x, y: l.y, w: 0, h: 0 }
  return { x: x0 + l.x, y: y0 + l.y, w: x1 - x0 + 1, h: y1 - y0 + 1 }
}

// ── destructive ops ────────────────────────────────────────────────────────
const FILTERS = {
  bc: (p) => `brightness(${1 + (p.brightness ?? 0) / 100}) contrast(${1 + (p.contrast ?? 0) / 100})`,
  huesat: (p) => `hue-rotate(${p.hue ?? 0}deg) saturate(${1 + (p.saturation ?? 0) / 100})`,
  invert: () => 'invert(1)',
  blur: (p) => `blur(${p.radius ?? 4}px)`,
}
const ADJUST_LABELS = { bc: 'Brightness/Contrast', huesat: 'Hue/Saturation', invert: 'Invert', blur: 'Gaussian blur' }

function adjustLayer(layerId, kind, params) {
  const l = layerOf(layerId)
  if (!l || l.kind !== 'raster') throw new Error('adjust: raster layer required')
  const s = surfaces.get(layerId)
  const out = new OffscreenCanvas(s.width, s.height)
  const c = out.getContext('2d')
  if (filtersOK) {
    c.filter = FILTERS[kind](params ?? {})
    c.drawImage(s, 0, 0)
  } else if (kind === 'invert') { // honest fallback for the one trivial case
    c.drawImage(s, 0, 0)
    const img = c.getImageData(0, 0, s.width, s.height)
    const d = img.data
    for (let i = 0; i < d.length; i += 4) { d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2] }
    c.putImageData(img, 0, 0)
  } else {
    throw new Error('ctx.filter unavailable — adjustment skipped')
  }
  pushUndo({
    type: 'pixels', label: ADJUST_LABELS[kind] ?? 'Adjust', layerId,
    before: { surf: s, x: l.x, y: l.y }, after: null, bytes: surfBytes(s) * 2,
  })
  surfaces.set(layerId, out)
}

function transformCommit(layerId, m) {
  const l = layerOf(layerId)
  if (!l || l.kind !== 'raster') return
  const s = surfaces.get(layerId)
  const out = new OffscreenCanvas(doc.width, doc.height)
  const c = out.getContext('2d')
  c.imageSmoothingEnabled = true
  c.imageSmoothingQuality = 'high'
  c.setTransform(m[0], m[1], m[2], m[3], m[4], m[5])
  c.drawImage(s, l.x, l.y)
  pushUndo({
    type: 'pixels', label: 'Transform', layerId,
    before: { surf: s, x: l.x, y: l.y }, after: null, bytes: surfBytes(s) * 2,
  })
  surfaces.set(layerId, out)
  l.x = 0
  l.y = 0
}

function cropDoc(x, y, w, h) {
  const cap = captureDoc()
  pushUndo({ type: 'doc', label: 'Crop', before: cap, after: null, bytes: cap.bytes })
  for (const l of doc.layers) {
    if (l.kind === 'raster') {
      const s = surfaces.get(l.id)
      const out = new OffscreenCanvas(w, h)
      out.getContext('2d').drawImage(s, l.x - x, l.y - y)
      surfaces.set(l.id, out)
      l.x = 0
      l.y = 0
    } else {
      l.x -= x
      l.y -= y
      textCache.delete(l.id)
    }
  }
  doc.width = w
  doc.height = h
  comp = null
  mergeScratch = null
  clipScratch = null
  setSelection(null, 0)
}

function mergeDown(layerId) {
  const i = layerIndex(layerId)
  if (i <= 0) return
  const upper = doc.layers[i]
  const lower = doc.layers[i - 1]
  if (lower.kind !== 'raster') return
  const cap = captureDoc()
  pushUndo({ type: 'doc', label: 'Merge down', before: cap, after: null, bytes: cap.bytes })
  const lctx = surfaces.get(lower.id).getContext('2d')
  lctx.save()
  lctx.globalAlpha = upper.opacity
  lctx.globalCompositeOperation = upper.blend
  lctx.translate(-lower.x, -lower.y)
  drawLayerContent(lctx, upper)
  lctx.restore()
  doc.layers.splice(i, 1)
  doc.activeLayer = lower.id
}

function flatten() {
  const cap = captureDoc()
  pushUndo({ type: 'doc', label: 'Flatten', before: cap, after: null, bytes: cap.bytes })
  const c = snap(compositeNow())
  const l = newLayer('raster', { name: 'Background' })
  doc.layers = [l]
  surfaces.set(l.id, c)
  doc.activeLayer = l.id
}

// ── message handling ───────────────────────────────────────────────────────
async function handle(data) {
  const { id, type } = data
  switch (type) {
    case CV.INIT: {
      view = data.canvas
      vctx = view.getContext('2d')
      // verify ctx.filter actually filters in this OffscreenCanvas build
      try {
        const t = new OffscreenCanvas(1, 1).getContext('2d')
        t.filter = 'invert(1)'
        t.fillStyle = '#fff'
        t.fillRect(0, 0, 1, 1)
        filtersOK = t.getImageData(0, 0, 1, 1).data[0] < 8
      } catch { filtersOK = false }
      reply(id, { filters: filtersOK })
      return
    }
    case CV.VIEW: {
      vs = { w: data.w, h: data.h, dpr: data.dpr, zoom: data.zoom, offX: data.offX, offY: data.offY }
      scheduleRedraw()
      return
    }
    case CV.NEW_DOC: {
      resetDoc(newDoc(data.width, data.height, data.name ?? 'Untitled'))
      const l = newLayer('raster', { name: 'Background' })
      doc.layers = [l]
      doc.activeLayer = l.id
      surfaces.set(l.id, makeSurface(data.background))
      await fontReady
      dirty = true
      reply(id, { doc: publicDoc() })
      changed()
      return
    }
    case CV.OPEN_IMAGE: {
      const bmp = data.bitmap
      resetDoc(newDoc(bmp.width, bmp.height, data.name ?? 'Untitled'))
      const l = newLayer('raster', { name: data.layerName ?? 'Background' })
      doc.layers = [l]
      doc.activeLayer = l.id
      const s = makeSurface()
      s.getContext('2d').drawImage(bmp, 0, 0)
      bmp.close?.()
      surfaces.set(l.id, s)
      await fontReady
      dirty = true
      reply(id, { doc: publicDoc() })
      changed()
      return
    }
    case CV.LOAD_DOC: {
      await loadDocFromOpfs(data.docId)
      reply(id, { doc: publicDoc() })
      changed()
      return
    }
    case CV.CLOSE_DOC: {
      resetDoc(null)
      doc = null
      reply(id)
      changed()
      return
    }
    case CV.LIST_DOCS: {
      const docs = await listDocs()
      reply(id, { docs }, docs.map((d) => d.thumb).filter(Boolean))
      return
    }
    case CV.DELETE_DOC: {
      await deleteDir(`canvasdocs/${data.docId}`)
      reply(id)
      return
    }
    case CV.SAVE: {
      await saveDoc()
      reply(id)
      changed()
      return
    }
    case CV.SET_ACTIVE: {
      if (layerOf(data.layerId)) doc.activeLayer = data.layerId
      changed()
      return
    }
    case CV.PROPS_PREVIEW: {
      const l = layerOf(data.layerId)
      if (l) {
        Object.assign(l, data.patch)
        if (l.kind === 'text' && data.patch.text) textCache.delete(l.id)
        scheduleRedraw()
      }
      return
    }
    case CV.PROPS_COMMIT: {
      const l = layerOf(data.layerId)
      if (!l) return
      Object.assign(l, data.patch)
      if (l.kind === 'text') textCache.delete(l.id)
      pushUndo({ type: 'props', label: data.label ?? 'Layer', layerId: l.id, before: data.before, after: data.patch })
      changed()
      return
    }
    case CV.ADD_LAYER: {
      const at = doc.activeLayer ? layerIndex(doc.activeLayer) + 1 : doc.layers.length
      const n = doc.layers.filter((q) => q.kind === data.kind).length + 1
      const l = newLayer(data.kind, {
        name: data.name ?? (data.kind === 'text' ? 'Text' : `Layer ${n}`),
        x: data.x ?? 0,
        y: data.y ?? 0,
        ...(data.kind === 'text' ? { text: data.text } : null),
      })
      let surf = null
      if (data.kind === 'raster') {
        surf = makeSurface()
        if (data.bitmap) {
          const b = data.bitmap
          const ctx = surf.getContext('2d')
          const s = Math.min(1, doc.width / b.width, doc.height / b.height)
          ctx.drawImage(b, (doc.width - b.width * s) / 2, (doc.height - b.height * s) / 2, b.width * s, b.height * s)
          b.close?.()
        }
        surfaces.set(l.id, surf)
      }
      doc.layers.splice(at, 0, l)
      doc.activeLayer = l.id
      pushUndo({
        type: 'add', label: data.kind === 'text' ? 'Add text' : 'Add layer',
        layer: JSON.parse(JSON.stringify(l)), index: at, surf, bytes: surfBytes(surf),
      })
      reply(id, { layerId: l.id })
      changed()
      return
    }
    case CV.DELETE_LAYER: {
      const i = layerIndex(data.layerId)
      if (i < 0 || doc.layers.length <= 1) return
      const [l] = doc.layers.splice(i, 1)
      const surf = surfaces.get(l.id) ?? null
      surfaces.delete(l.id)
      textCache.delete(l.id)
      if (doc.activeLayer === l.id)
        doc.activeLayer = doc.layers[Math.min(i, doc.layers.length - 1)]?.id ?? null
      pushUndo({ type: 'del', label: 'Delete layer', layer: l, index: i, surf, bytes: surfBytes(surf) })
      changed()
      return
    }
    case CV.DUPLICATE: {
      const src = layerOf(data.layerId)
      if (!src) return
      const i = layerIndex(src.id)
      const l = { ...JSON.parse(JSON.stringify(src)), id: newLayer(src.kind).id, name: `${src.name} copy` }
      let surf = null
      if (src.kind === 'raster') {
        surf = snap(surfaces.get(src.id))
        surfaces.set(l.id, surf)
      }
      doc.layers.splice(i + 1, 0, l)
      doc.activeLayer = l.id
      pushUndo({
        type: 'add', label: 'Duplicate layer',
        layer: JSON.parse(JSON.stringify(l)), index: i + 1, surf, bytes: surfBytes(surf),
      })
      changed()
      return
    }
    case CV.MERGE_DOWN: {
      mergeDown(data.layerId)
      changed()
      return
    }
    case CV.FLATTEN: {
      flatten()
      changed()
      return
    }
    case CV.REORDER: {
      const { from, to } = data
      if (from === to || from < 0 || to < 0 || from >= doc.layers.length || to >= doc.layers.length) return
      const [l] = doc.layers.splice(from, 1)
      doc.layers.splice(to, 0, l)
      pushUndo({ type: 'reorder', label: 'Reorder layers', from, to })
      changed()
      return
    }
    case CV.BEGIN_STROKE: beginStroke(data); return
    case CV.STROKE_PTS: strokePts(data.pts); return
    case CV.END_STROKE: endStroke(); return
    case CV.FILL: {
      const l = layerOf(data.layerId)
      if (!l || l.kind !== 'raster') return
      const src = new OffscreenCanvas(doc.width, doc.height)
      const c = src.getContext('2d')
      c.fillStyle = data.color
      c.fillRect(0, 0, doc.width, doc.height)
      const s = surfaces.get(l.id)
      pushUndo({
        type: 'pixels', label: 'Fill', layerId: l.id,
        before: { surf: snap(s), x: l.x, y: l.y }, after: null, bytes: surfBytes(s) * 2,
      })
      applyToLayer(l, src, 1, false)
      changed()
      return
    }
    case CV.GRADIENT: {
      const l = layerOf(data.layerId)
      if (!l || l.kind !== 'raster') return
      const src = new OffscreenCanvas(doc.width, doc.height)
      const c = src.getContext('2d')
      const g = c.createLinearGradient(data.x0, data.y0, data.x1, data.y1)
      g.addColorStop(0, data.color)
      g.addColorStop(1, fadeOut(data.color)) // fg → transparent
      c.fillStyle = g
      c.fillRect(0, 0, doc.width, doc.height)
      const s = surfaces.get(l.id)
      pushUndo({
        type: 'pixels', label: 'Gradient', layerId: l.id,
        before: { surf: snap(s), x: l.x, y: l.y }, after: null, bytes: surfBytes(s) * 2,
      })
      applyToLayer(l, src, 1, false)
      changed()
      return
    }
    case CV.SET_SELECTION: {
      setSelection(data.shapes, data.feather ?? 0)
      changed()
      return
    }
    case CV.TRANSFORM_PREVIEW: {
      xformPreview = data.m ? { layerId: data.layerId, m: data.m } : null
      scheduleRedraw()
      return
    }
    case CV.TRANSFORM_COMMIT: {
      xformPreview = null
      transformCommit(data.layerId, data.m)
      changed()
      return
    }
    case CV.ADJUST: {
      try {
        adjustLayer(data.layerId, data.kind, data.params)
        reply(id)
        changed()
      } catch (err) {
        fail(id, String(err?.message ?? err))
      }
      return
    }
    case CV.CROP: {
      cropDoc(Math.round(data.x), Math.round(data.y), Math.max(1, Math.round(data.w)), Math.max(1, Math.round(data.h)))
      changed()
      return
    }
    case CV.UNDO: undo(); changed(); return
    case CV.REDO: redo(); changed(); return
    case CV.JUMP: {
      let d = data.delta
      while (d < 0 && undoStack.length) { undo(); d++ }
      while (d > 0 && redoStack.length) { redo(); d-- }
      changed()
      return
    }
    case CV.EXPORT: {
      const c = snap(compositeNow())
      if (data.mime === 'image/jpeg') { // jpeg has no alpha — matte on white
        const m = new OffscreenCanvas(c.width, c.height)
        const mc = m.getContext('2d')
        mc.fillStyle = '#fff'
        mc.fillRect(0, 0, c.width, c.height)
        mc.drawImage(c, 0, 0)
        const blob = await m.convertToBlob({ type: 'image/jpeg', quality: data.quality ?? 0.92 })
        reply(id, { blob, width: c.width, height: c.height })
      } else {
        const blob = await c.convertToBlob({ type: 'image/png' })
        reply(id, { blob, width: c.width, height: c.height })
      }
      return
    }
    case CV.GET_DOC: {
      reply(id, { doc: publicDoc(), dirty })
      return
    }
    case CV.GET_PIXEL: {
      let px
      if (data.layerId) {
        const l = layerOf(data.layerId)
        const t = new OffscreenCanvas(1, 1)
        const c = t.getContext('2d')
        c.translate(-Math.round(data.x), -Math.round(data.y))
        if (l) drawLayerContent(c, l)
        px = [...c.getImageData(0, 0, 1, 1).data]
      } else {
        const c = compositeNow()
        px = [...c.getContext('2d').getImageData(Math.round(data.x), Math.round(data.y), 1, 1).data]
      }
      reply(id, { px })
      return
    }
    case CV.GET_BOUNDS: {
      const l = layerOf(data.layerId)
      reply(id, { bounds: l ? layerBounds(l) : null })
      return
    }
  }
}

self.onmessage = ({ data }) => {
  Promise.resolve(handle(data)).catch((err) => {
    fail(data.id, String(err?.message ?? err))
  })
}
