import { useRef, useEffect, useState, useCallback } from 'react'
import LayersPanel from './LayersPanel.jsx'
import ToolOptions from './ToolOptions.jsx'
import CanvasHistory from './CanvasHistory.jsx'
import RecentDocs from './RecentDocs.jsx'
import { toast } from '../state/toastStore.js'
import {
  useCanvasState, getCanvasState, setTool, setFg, setToolOpts, setCloneSrc, setCanvasView,
  sendViewport, beginStroke, strokePoint, endStroke, previewLayerProps, commitLayerProps,
  setSelectionShapes, fillLayer, gradientLayer, transformPreview, transformCommit, cropDoc,
  cvUndo, cvRedo, addLayer, exportFlattened, saveCanvasDoc, closeCanvasDoc, getPixel,
  getLayerBounds,
} from '../state/canvasClient.js'

// CANVAS — the layer-editor surface. Left tool rail, center stage (worker-drawn
// composite with checkerboard + view transform), right panel (layers / tool
// options / history). The stage owns the whole pointer language; the worker
// owns every pixel.

const TOOLS = [
  ['move', 'V', 'Move'],
  ['brush', 'B', 'Brush'],
  ['eraser', 'E', 'Eraser'],
  ['clone', 'S', 'Clone stamp'],
  ['select', 'M', 'Select'],
  ['fill', 'K', 'Fill / gradient'],
  ['text', 'T', 'Text'],
  ['crop', 'C', 'Crop'],
]

const ICONS = {
  move: <path d="M7 1v12M3.5 4.5L7 1l3.5 3.5M3.5 9.5L7 13l3.5-3.5M1 7h12M4.5 3.5L1 7l3.5 3.5M9.5 3.5L13 7l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />,
  brush: <path d="M11.7 1.6c.6.6.7 1.5.1 2.1L6.5 9.4 4 10.9l-.9-.9L4.6 7.5l5.7-5.7c.6-.6 1.5-.5 2.1-.2zM3.2 10.8c-.4 1-1.1 1.6-2.2 1.8.5-.9.5-1.6.9-2.3z" fill="currentColor" />,
  eraser: <path d="M5.5 12h6M2 9.5l6-6a1.2 1.2 0 0 1 1.7 0l2.3 2.3a1.2 1.2 0 0 1 0 1.7L8.5 11a1.6 1.6 0 0 1-2.3 0L2 9.5zM6.2 4.8l4 4" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />,
  clone: <path d="M4.5 6.5h5v-1a2.5 2.5 0 0 0-5 0v1zM2.5 9c0-1.4 1.1-2.5 2.5-2.5h4c1.4 0 2.5 1.1 2.5 2.5M2 11.5h10M7 6.5v2.5" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />,
  select: <path d="M2 3.5v-1a.5.5 0 0 1 .5-.5h1M6 2h2M11 2h.5a.5.5 0 0 1 .5.5v1M12 6v2M12 11v.5a.5.5 0 0 1-.5.5h-1M8 12H6M3 12h-.5a.5.5 0 0 1-.5-.5v-1M2 8V6" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />,
  fill: <path d="M6.5 1.5l4.5 4.5-4 4a1.5 1.5 0 0 1-2.1 0L2.6 7.7a1.5 1.5 0 0 1 0-2.1l3.9-4.1zM3 6.5h7M11.8 8.7s1.2 1.6 1.2 2.4a1.2 1.2 0 0 1-2.4 0c0-.8 1.2-2.4 1.2-2.4z" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />,
  text: <path d="M2.5 4V2.5h9V4M7 2.5V11.5M5 11.5h4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />,
  crop: <path d="M3.5 1v9.5H13M1 3.5h9.5V13" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />,
}

// selection shape → svg path (doc coords)
function shapeD(sh) {
  if (sh.kind === 'rect') {
    const x = Math.min(sh.x0, sh.x1), y = Math.min(sh.y0, sh.y1)
    return `M${x} ${y}h${Math.abs(sh.x1 - sh.x0)}v${Math.abs(sh.y1 - sh.y0)}h${-Math.abs(sh.x1 - sh.x0)}Z`
  }
  if (sh.kind === 'ellipse') {
    const cx = (sh.x0 + sh.x1) / 2, cy = (sh.y0 + sh.y1) / 2
    const rx = Math.abs(sh.x1 - sh.x0) / 2, ry = Math.abs(sh.y1 - sh.y0) / 2
    return `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${rx * 2} 0a${rx} ${ry} 0 1 0 ${-rx * 2} 0Z`
  }
  if (sh.kind === 'lasso' && sh.pts?.length > 1)
    return `M${sh.pts.map((p) => `${p[0]} ${p[1]}`).join('L')}Z`
  return ''
}

const xformMatrix = (x) => {
  const cx = x.bounds.x + x.bounds.w / 2
  const cy = x.bounds.y + x.bounds.h / 2
  const cos = Math.cos(x.rot), sin = Math.sin(x.rot)
  const a = cos * x.sx, b = sin * x.sx, c = -sin * x.sy, d = cos * x.sy
  return [a, b, c, d, cx + x.dx - (a * cx + c * cy), cy + x.dy - (b * cx + d * cy)]
}

export default function CanvasSurface({ canvasRef, active }) {
  const st = useCanvasState()
  const { doc, tool, opts, fg, view } = st
  const stageRef = useRef(null)
  const ringRef = useRef(null)
  const sess = useRef(null) // active pointer session on the stage
  const [space, setSpace] = useState(false)
  const [dragShape, setDragShape] = useState(null) // in-progress selection
  const [gradLine, setGradLine] = useState(null)
  const [cropRect, setCropRect] = useState(null)
  const [xform, setXform] = useState(null)
  const [textEdit, setTextEdit] = useState(null)
  const activeLayer = doc?.layers.find((l) => l.id === doc.activeLayer) ?? null

  // ── view: fit / viewport sync ────────────────────────────────────────────
  const fit = useCallback(() => {
    const el = stageRef.current
    const d = getCanvasState().doc
    if (!el || !d) return
    const r = el.getBoundingClientRect()
    if (r.width < 40 || r.height < 40) return
    const pad = 32
    const zoom = Math.min((r.width - pad * 2) / d.width, (r.height - pad * 2) / d.height)
    setCanvasView({
      zoom,
      offX: (r.width - d.width * zoom) / 2,
      offY: (r.height - d.height * zoom) / 2,
      fitted: true,
    })
  }, [])

  useEffect(() => { fit() }, [doc?.id, fit]) // new / loaded document → fit
  useEffect(() => { if (getCanvasState().view.fitted) fit() }, [doc?.width, doc?.height, fit])

  useEffect(() => { // every view change reaches the worker
    const el = stageRef.current
    if (!el || !doc) return
    const r = el.getBoundingClientRect()
    if (r.width < 2) return
    sendViewport(r.width, r.height, Math.min(devicePixelRatio, 2), view.zoom, view.offX, view.offY)
  }, [doc?.id, doc?.width, doc?.height, view])

  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const obs = new ResizeObserver(() => {
      const v = getCanvasState().view
      const d = getCanvasState().doc
      if (!d) return
      if (v.fitted) fit()
      else {
        const r = el.getBoundingClientRect()
        if (r.width > 2) sendViewport(r.width, r.height, Math.min(devicePixelRatio, 2), v.zoom, v.offX, v.offY)
      }
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [fit])

  const zoomBy = useCallback((f, mx, my) => {
    const el = stageRef.current
    const v = getCanvasState().view
    if (!el) return
    const r = el.getBoundingClientRect()
    const ax = mx ?? r.width / 2
    const ay = my ?? r.height / 2
    const zoom = Math.min(16, Math.max(0.03, v.zoom * f))
    setCanvasView({
      zoom,
      offX: ax - (ax - v.offX) * (zoom / v.zoom),
      offY: ay - (ay - v.offY) * (zoom / v.zoom),
      fitted: false,
    })
  }, [])

  const toggleFit = useCallback(() => {
    const v = getCanvasState().view
    const d = getCanvasState().doc
    const el = stageRef.current
    if (!d || !el) return
    if (v.fitted) {
      const r = el.getBoundingClientRect()
      setCanvasView({ zoom: 1, offX: (r.width - d.width) / 2, offY: (r.height - d.height) / 2, fitted: false })
    } else fit()
  }, [fit])

  // wheel = zoom around the cursor
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const onWheel = (e) => {
      if (!getCanvasState().doc) return
      e.preventDefault()
      const r = el.getBoundingClientRect()
      zoomBy(Math.exp(-e.deltaY * 0.0016), e.clientX - r.left, e.clientY - r.top)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomBy])

  const toDoc = (e) => {
    const r = stageRef.current.getBoundingClientRect()
    const v = getCanvasState().view
    return [(e.clientX - r.left - v.offX) / v.zoom, (e.clientY - r.top - v.offY) / v.zoom]
  }
  const toScreen = (x, y) => {
    const v = view
    return [x * v.zoom + v.offX, y * v.zoom + v.offY]
  }

  // ── export / save ────────────────────────────────────────────────────────
  const doExport = useCallback(async (type) => {
    const d = getCanvasState().doc
    if (!d) return
    const { blob, width, height } = await exportFlattened(type, 0.92)
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${(d.name || 'canvas').replace(/[/\\:*?"<>|]/g, '-')}.${type === 'image/jpeg' ? 'jpg' : 'png'}`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 4000)
    toast(`Exported ${width} × ${height} ${type === 'image/jpeg' ? 'JPEG' : 'PNG'}`)
  }, [])

  const doSave = useCallback(() => {
    saveCanvasDoc().then(() => toast('Canvas document saved')).catch((err) => {
      console.error('[canvas save]', err)
      toast('Save failed — see console')
    })
  }, [])

  // ── transform (⌘T) ───────────────────────────────────────────────────────
  const startTransform = useCallback(async () => {
    const d = getCanvasState().doc
    const l = d?.layers.find((q) => q.id === d.activeLayer)
    if (!l || l.kind !== 'raster') return
    const b = await getLayerBounds(l.id)
    if (!b || b.w < 1 || b.h < 1) return
    setTool('move')
    setXform({ layerId: l.id, bounds: b, sx: 1, sy: 1, rot: 0, dx: 0, dy: 0 })
  }, [])

  useEffect(() => {
    if (xform) transformPreview(xform.layerId, xformMatrix(xform))
  }, [xform])

  const commitXform = useCallback(() => {
    setXform((x) => {
      if (x) transformCommit(x.layerId, xformMatrix(x))
      return null
    })
  }, [])
  const cancelXform = useCallback(() => {
    setXform((x) => {
      if (x) transformPreview(x.layerId, null)
      return null
    })
  }, [])

  // ── text editing ─────────────────────────────────────────────────────────
  const openTextEditor = useCallback((layer, x, y) => {
    const o = getCanvasState().opts.text
    if (layer) {
      previewLayerProps(layer.id, { visible: false })
      setTextEdit({
        layerId: layer.id, x: layer.x, y: layer.y, value: layer.text.content,
        size: layer.text.size, weight: layer.text.weight ?? 400, color: layer.text.color,
        before: { text: { ...layer.text }, visible: true },
      })
    } else {
      setTextEdit({
        layerId: null, x, y, value: '',
        size: o.size, weight: o.weight, color: getCanvasState().fg, before: null,
      })
    }
  }, [])

  const commitText = useCallback((cancel = false) => {
    setTextEdit((t) => {
      if (!t) return null
      if (t.layerId) {
        if (cancel || !t.value.trim()) {
          previewLayerProps(t.layerId, { ...t.before })
        } else {
          commitLayerProps(
            t.layerId,
            { text: { ...t.before.text, content: t.value }, visible: true },
            t.before,
            'Edit text',
          )
        }
      } else if (!cancel && t.value.trim()) {
        addLayer({
          kind: 'text',
          x: Math.round(t.x),
          y: Math.round(t.y),
          name: t.value.trim().slice(0, 24),
          text: { content: t.value, size: t.size, color: t.color, weight: t.weight },
        })
      }
      return null
    })
  }, [])

  // ── crop commit ──────────────────────────────────────────────────────────
  const applyCrop = useCallback(() => {
    setCropRect((r) => {
      const d = getCanvasState().doc
      if (!r || !d) return null
      const x = Math.max(0, Math.min(r.x0, r.x1))
      const y = Math.max(0, Math.min(r.y0, r.y1))
      const w = Math.min(d.width, Math.max(r.x0, r.x1)) - x
      const h = Math.min(d.height, Math.max(r.y0, r.y1)) - y
      if (w >= 2 && h >= 2) { cropDoc(x, y, w, h); setTool('move') }
      return null
    })
  }, [])

  // ── stage pointer language ───────────────────────────────────────────────
  const onDown = (e) => {
    const stg = getCanvasState()
    if (e.button === 1 || (space && stg.doc)) {
      sess.current = { kind: 'pan', x0: e.clientX, y0: e.clientY, off: { ...stg.view } }
      e.currentTarget.setPointerCapture(e.pointerId)
      e.preventDefault()
      return
    }
    if (e.button !== 0 || !stg.doc) return
    const [x, y] = toDoc(e)
    const l = stg.doc.layers.find((q) => q.id === stg.doc.activeLayer)
    e.currentTarget.setPointerCapture(e.pointerId)
    switch (stg.tool) {
      case 'move': {
        if (xform) { // drag inside ⌘T = translate
          sess.current = { kind: 'xform-move', x0: x, y0: y, base: xform }
          return
        }
        if (!l) return
        sess.current = { kind: 'move', layerId: l.id, x0: x, y0: y, l0: { x: l.x, y: l.y }, moved: false }
        return
      }
      case 'brush': case 'eraser': case 'clone': {
        if (stg.tool === 'brush' && e.altKey) { // eyedropper: sample the composite
          getPixel(null, Math.round(x), Math.round(y)).then(([r, g, b]) => {
            setFg(`#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`)
          }).catch(() => {})
          return
        }
        if (stg.tool === 'clone' && e.altKey) { setCloneSrc([x, y]); return }
        if (!l || l.kind !== 'raster') { toast('Select a pixel layer first'); return }
        if (stg.tool === 'clone' && !stg.cloneSrc) { toast('⌥ click to set the clone source'); return }
        const o = stg.opts[stg.tool]
        beginStroke({
          tool: stg.tool, layerId: l.id, size: o.size, hardness: o.hardness,
          opacity: o.opacity, color: stg.fg,
          srcX: stg.cloneSrc?.[0], srcY: stg.cloneSrc?.[1],
        })
        const pr = e.pointerType === 'pen' ? e.pressure || 0.5 : 1
        strokePoint(x, y, pr)
        sess.current = { kind: 'stroke' }
        return
      }
      case 'select': {
        const shape = stg.opts.select.shape
        sess.current = shape === 'lasso'
          ? { kind: 'lasso', pts: [[x, y]], add: e.shiftKey, sub: e.altKey }
          : { kind: 'select', shape, x0: x, y0: y, add: e.shiftKey, sub: e.altKey, moved: false }
        return
      }
      case 'fill': {
        if (!l || l.kind !== 'raster') { toast('Select a pixel layer first'); return }
        sess.current = { kind: 'fill', layerId: l.id, x0: x, y0: y, moved: false }
        return
      }
      case 'text': {
        // cancel the pointerdown so the compat mousedown can't steal focus
        // from the freshly auto-focused editor (blur would commit-and-close)
        e.preventDefault()
        openTextEditor(null, x, y)
        return
      }
      case 'crop': {
        sess.current = { kind: 'crop', x0: x, y0: y }
        setCropRect(null)
        return
      }
    }
  }

  const onMove = (e) => {
    // brush ring follows the raw pointer
    const ring = ringRef.current
    const stg = getCanvasState()
    if (ring) {
      const show = stg.doc && ['brush', 'eraser', 'clone'].includes(stg.tool) && !space
      ring.style.display = show ? '' : 'none'
      if (show) {
        const r = stageRef.current.getBoundingClientRect()
        const d = stg.opts[stg.tool].size * stg.view.zoom
        ring.style.width = `${d}px`
        ring.style.height = `${d}px`
        ring.style.transform = `translate(${e.clientX - r.left - d / 2}px, ${e.clientY - r.top - d / 2}px)`
      }
    }
    const s = sess.current
    if (!s) return
    if (s.kind === 'pan') {
      setCanvasView({
        offX: s.off.offX + (e.clientX - s.x0),
        offY: s.off.offY + (e.clientY - s.y0),
        fitted: false,
      })
      return
    }
    const [x, y] = toDoc(e)
    switch (s.kind) {
      case 'move': {
        s.moved = true
        previewLayerProps(s.layerId, {
          x: Math.round(s.l0.x + x - s.x0),
          y: Math.round(s.l0.y + y - s.y0),
        })
        return
      }
      case 'xform-move': {
        setXform({ ...s.base, dx: s.base.dx + x - s.x0, dy: s.base.dy + y - s.y0 })
        return
      }
      case 'stroke': {
        const evs = e.nativeEvent.getCoalescedEvents?.() ?? [e.nativeEvent]
        for (const ev of evs) {
          const r = stageRef.current.getBoundingClientRect()
          const v = getCanvasState().view
          strokePoint(
            (ev.clientX - r.left - v.offX) / v.zoom,
            (ev.clientY - r.top - v.offY) / v.zoom,
            ev.pointerType === 'pen' ? ev.pressure || 0.5 : 1,
          )
        }
        return
      }
      case 'select': {
        if (Math.abs(x - s.x0) + Math.abs(y - s.y0) > 2) s.moved = true
        setDragShape({ kind: s.shape, x0: s.x0, y0: s.y0, x1: x, y1: y, op: s.sub ? 'subtract' : 'add' })
        return
      }
      case 'lasso': {
        const last = s.pts[s.pts.length - 1]
        if (Math.hypot(x - last[0], y - last[1]) > 2 / getCanvasState().view.zoom) {
          s.pts.push([x, y])
          setDragShape({ kind: 'lasso', pts: [...s.pts], op: s.sub ? 'subtract' : 'add' })
        }
        return
      }
      case 'fill': {
        if (Math.abs(x - s.x0) + Math.abs(y - s.y0) > 4) s.moved = true
        if (s.moved) setGradLine({ x0: s.x0, y0: s.y0, x1: x, y1: y })
        return
      }
      case 'crop': {
        setCropRect({ x0: s.x0, y0: s.y0, x1: x, y1: y })
        return
      }
    }
  }

  const onUp = (e) => {
    const s = sess.current
    sess.current = null
    if (!s) return
    const stg = getCanvasState()
    const feather = stg.opts.select.feather
    switch (s.kind) {
      case 'move': {
        if (!s.moved) return
        const [x, y] = toDoc(e)
        commitLayerProps(
          s.layerId,
          { x: Math.round(s.l0.x + x - s.x0), y: Math.round(s.l0.y + y - s.y0) },
          { x: s.l0.x, y: s.l0.y },
          'Move layer',
        )
        return
      }
      case 'stroke': endStroke(); return
      case 'select': {
        setDragShape(null)
        if (!s.moved) { setSelectionShapes(null, feather); return }
        const [x, y] = toDoc(e)
        const sh = { kind: s.shape, x0: s.x0, y0: s.y0, x1: x, y1: y, op: s.sub ? 'subtract' : 'add' }
        const prev = (s.add || s.sub) ? (stg.doc?.selection?.shapes ?? []) : []
        setSelectionShapes([...prev, sh], feather)
        return
      }
      case 'lasso': {
        setDragShape(null)
        if (s.pts.length < 3) { setSelectionShapes(null, feather); return }
        const sh = { kind: 'lasso', pts: s.pts.map(([a, b]) => [Math.round(a), Math.round(b)]), op: s.sub ? 'subtract' : 'add' }
        const prev = (s.add || s.sub) ? (stg.doc?.selection?.shapes ?? []) : []
        setSelectionShapes([...prev, sh], feather)
        return
      }
      case 'fill': {
        setGradLine(null)
        const [x, y] = toDoc(e)
        if (s.moved) gradientLayer(s.layerId, s.x0, s.y0, x, y, stg.fg)
        else fillLayer(s.layerId, stg.fg)
        return
      }
      // crop rect persists until Enter/Esc; pan needs no epilogue
    }
  }

  const onDblClick = () => {
    if (activeLayer?.kind === 'text' && (tool === 'move' || tool === 'text') && !textEdit)
      openTextEditor(activeLayer)
  }

  // ── transform handles ────────────────────────────────────────────────────
  const hsess = useRef(null)
  const onHandleDown = (h) => (e) => {
    e.stopPropagation()
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    hsess.current = { h, base: xform }
  }
  const onHandleMove = (e) => {
    const s = hsess.current
    if (!s) return
    e.stopPropagation()
    const [px, py] = toDoc(e)
    const x = s.base
    const b = x.bounds
    const cx = b.x + b.w / 2 + x.dx
    const cy = b.y + b.h / 2 + x.dy
    if (s.h === 'rot') {
      setXform({ ...x, rot: Math.atan2(py - cy, px - cx) + Math.PI / 2 })
      return
    }
    // scale: pointer into the unrotated frame, ratio against the grabbed corner
    const cos = Math.cos(-x.rot), sin = Math.sin(-x.rot)
    const qx = cos * (px - cx) - sin * (py - cy)
    const qy = sin * (px - cx) + cos * (py - cy)
    const hx = (s.h.includes('e') ? 1 : -1) * (b.w / 2)
    const hy = (s.h.includes('s') ? 1 : -1) * (b.h / 2)
    let sx = hx ? qx / hx : x.sx
    let sy = hy ? qy / hy : x.sy
    if (e.shiftKey) {
      const u = (Math.abs(sx) + Math.abs(sy)) / 2
      sx = Math.sign(sx || 1) * u
      sy = Math.sign(sy || 1) * u
    }
    setXform({ ...x, sx, sy })
  }
  const onHandleUp = (e) => { if (hsess.current) { e.stopPropagation(); hsess.current = null } }

  // ── keyboard (capture phase — runs ahead of App's router) ────────────────
  const ctx = useRef(null)
  ctx.current = { xform, cropRect, textEdit, commitXform, cancelXform, applyCrop, doExport, doSave, startTransform, toggleFit, zoomBy }
  useEffect(() => {
    if (!active) return
    const onKey = (e) => {
      const t = e.target
      if (t instanceof Element && (t.closest('input, textarea, select') || t.isContentEditable)) return
      const c = ctx.current
      const stg = getCanvasState()
      const meta = e.metaKey || e.ctrlKey
      const k = e.key.toLowerCase()
      const eat = () => { e.preventDefault(); e.stopPropagation() }
      if (meta) {
        if (!stg.doc) return
        if (k === 'z') { eat(); e.shiftKey ? cvRedo() : cvUndo(); return }
        if (k === 's') { eat(); c.doSave(); return }
        if (k === 'e') { eat(); c.doExport('image/png'); return }
        if (k === 'd') { eat(); setSelectionShapes(null, stg.opts.select.feather); return }
        if (k === 't') { eat(); c.startTransform(); return }
        if (k === '=' || k === '+') { eat(); c.zoomBy(1.25); return }
        if (k === '-') { eat(); c.zoomBy(0.8); return }
        return
      }
      if (e.altKey) return
      if (!stg.doc) return
      if (e.key === 'Escape') {
        if (c.xform) { eat(); c.cancelXform(); return }
        if (c.cropRect) { eat(); setCropRect(null); return }
        return // lights-out Esc falls through to App
      }
      if (e.key === 'Enter') {
        if (c.xform) { eat(); c.commitXform(); return }
        if (c.cropRect) { eat(); c.applyCrop(); return }
        return
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        if (stg.tool !== 'move') return
        const l = stg.doc.layers.find((q) => q.id === stg.doc.activeLayer)
        if (!l) return
        eat()
        const d = e.shiftKey ? 10 : 1
        const dx = e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0
        const dy = e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0
        commitLayerProps(l.id, { x: l.x + dx, y: l.y + dy }, { x: l.x, y: l.y }, 'Nudge')
        return
      }
      switch (k) {
        case 'v': eat(); setTool('move'); return
        case 'b': eat(); setTool('brush'); return
        case 'e': eat(); setTool('eraser'); return
        case 's': eat(); setTool('clone'); return
        case 'm': {
          eat()
          if (stg.tool === 'select') {
            const order = ['rect', 'ellipse', 'lasso']
            const at = order.indexOf(stg.opts.select.shape)
            setToolOpts('select', { shape: order[(at + 1) % order.length] })
          } else setTool('select')
          return
        }
        case 'l': eat(); setTool('select'); setToolOpts('select', { shape: 'lasso' }); return
        case 'k': eat(); setTool('fill'); return
        case 't': eat(); setTool('text'); return
        case 'c': eat(); setTool('crop'); return
        case 'z': eat(); c.toggleFit(); return
        case '[': case ']': {
          if (!['brush', 'eraser', 'clone'].includes(stg.tool)) return
          eat()
          const o = stg.opts[stg.tool]
          const size = Math.max(1, Math.min(300, Math.round(o.size * (k === '[' ? 1 / 1.2 : 1.2))))
          setToolOpts(stg.tool, { size })
          return
        }
      }
    }
    addEventListener('keydown', onKey, true)
    return () => removeEventListener('keydown', onKey, true)
  }, [active])

  // Space = pan hand
  useEffect(() => {
    if (!active) { setSpace(false); return }
    const down = (e) => {
      if (e.code !== 'Space') return
      const t = e.target
      if (t instanceof Element && (t.closest('input, textarea, select') || t.isContentEditable)) return
      e.preventDefault()
      setSpace(true)
    }
    const up = (e) => { if (e.code === 'Space') setSpace(false) }
    addEventListener('keydown', down)
    addEventListener('keyup', up)
    return () => { removeEventListener('keydown', down); removeEventListener('keyup', up) }
  }, [active])

  // tool switches clear tool-scoped transients
  useEffect(() => {
    if (tool !== 'crop') setCropRect(null)
    setDragShape(null)
    setGradLine(null)
  }, [tool])

  // ── overlays geometry ────────────────────────────────────────────────────
  const selShapes = [
    ...(doc?.selection?.shapes ?? []),
    ...(dragShape ? [dragShape] : []),
  ]
  const antsD = selShapes.map(shapeD).join('')

  let xformPts = null
  if (xform) {
    const m = xformMatrix(xform)
    const b = xform.bounds
    const map = (px, py) => {
      const dx = m[0] * px + m[2] * py + m[4]
      const dy = m[1] * px + m[3] * py + m[5]
      return toScreen(dx, dy)
    }
    xformPts = {
      nw: map(b.x, b.y), ne: map(b.x + b.w, b.y),
      se: map(b.x + b.w, b.y + b.h), sw: map(b.x, b.y + b.h),
      n: map(b.x + b.w / 2, b.y), rotBase: map(b.x + b.w / 2, b.y - 24 / view.zoom),
    }
  }

  let cropBox = null
  if (cropRect) {
    const [ax, ay] = toScreen(Math.min(cropRect.x0, cropRect.x1), Math.min(cropRect.y0, cropRect.y1))
    const [bx, by] = toScreen(Math.max(cropRect.x0, cropRect.x1), Math.max(cropRect.y0, cropRect.y1))
    cropBox = { left: ax, top: ay, width: bx - ax, height: by - ay }
  }

  const cursor = !doc ? '' : space ? 'grab'
    : tool === 'move' ? 'move'
    : tool === 'text' ? 'text'
    : ['brush', 'eraser', 'clone'].includes(tool) ? 'none'
    : 'crosshair'

  return (
    <div className="canvas-surface">
      <nav className="tool-rail" aria-label="Canvas tools">
        {TOOLS.map(([id, key, label]) => (
          <button
            key={id}
            type="button"
            className={`rail-tool${tool === id ? ' is-on' : ''}`}
            data-tool={id}
            data-tip={label}
            data-tip-key={key}
            aria-pressed={tool === id}
            disabled={!doc}
            onClick={() => setTool(id)}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">{ICONS[id]}</svg>
          </button>
        ))}
        <span className="rail-gap" aria-hidden="true" />
        <span className="rail-fg" data-tip="Foreground color">
          <span className="cv-swatch rail-swatch" style={{ background: fg }}>
            <input type="color" value={fg} aria-label="Foreground color" disabled={!doc}
              onChange={(e) => setFg(e.target.value)} />
          </span>
        </span>
      </nav>

      <div
        ref={stageRef}
        className="canvas-stage"
        data-cursor={cursor}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onDoubleClick={onDblClick}
        onPointerLeave={() => { if (ringRef.current) ringRef.current.style.display = 'none' }}
      >
        <canvas ref={canvasRef} className="cv-view" />
        {doc && (
          <svg className="cv-overlay" aria-hidden="true">
            <g transform={`translate(${view.offX} ${view.offY}) scale(${view.zoom})`}>
              {antsD && (
                <>
                  <path className="ants ants-under" d={antsD} />
                  <path className="ants ants-over" d={antsD} />
                </>
              )}
              {gradLine && (
                <line className="cv-gradline" x1={gradLine.x0} y1={gradLine.y0} x2={gradLine.x1} y2={gradLine.y1} />
              )}
            </g>
          </svg>
        )}
        {xformPts && (
          <div className="cv-xform" aria-hidden={false}>
            <svg className="cv-overlay">
              <polygon
                className="cv-xform-box"
                points={['nw', 'ne', 'se', 'sw'].map((h) => xformPts[h].join(',')).join(' ')}
              />
              <line className="cv-xform-stem"
                x1={xformPts.n[0]} y1={xformPts.n[1]} x2={xformPts.rotBase[0]} y2={xformPts.rotBase[1]} />
            </svg>
            {['nw', 'ne', 'se', 'sw'].map((h) => (
              <span
                key={h}
                className="cv-handle"
                data-handle={h}
                style={{ left: xformPts[h][0], top: xformPts[h][1] }}
                onPointerDown={onHandleDown(h)}
                onPointerMove={onHandleMove}
                onPointerUp={onHandleUp}
                onPointerCancel={onHandleUp}
              />
            ))}
            <span
              className="cv-handle cv-handle-rot"
              data-handle="rot"
              style={{ left: xformPts.rotBase[0], top: xformPts.rotBase[1] }}
              onPointerDown={onHandleDown('rot')}
              onPointerMove={onHandleMove}
              onPointerUp={onHandleUp}
              onPointerCancel={onHandleUp}
            />
          </div>
        )}
        {cropBox && (
          <div className="cv-crop-box" style={cropBox}>
            <span className="cv-crop-dims mono">
              {Math.round(Math.abs(cropRect.x1 - cropRect.x0))} × {Math.round(Math.abs(cropRect.y1 - cropRect.y0))}
            </span>
          </div>
        )}
        {textEdit && (
          <textarea
            className="cv-text-edit mono"
            style={{
              left: toScreen(textEdit.x, textEdit.y)[0],
              top: toScreen(textEdit.x, textEdit.y)[1],
              fontSize: textEdit.size * view.zoom,
              color: textEdit.color,
              fontWeight: textEdit.weight,
            }}
            value={textEdit.value}
            autoFocus
            spellCheck={false}
            onChange={(e) => setTextEdit((t) => t && { ...t, value: e.target.value })}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitText() }
              else if (e.key === 'Escape') { e.preventDefault(); commitText(true) }
            }}
            onBlur={() => commitText()}
            onPointerDown={(e) => e.stopPropagation()}
          />
        )}
        <div ref={ringRef} className="cv-ring" style={{ display: 'none' }} aria-hidden="true" />
        {doc && (
          <span className="cv-zoom-tag mono" aria-hidden="true">
            {Math.round(view.zoom * 100)}%
          </span>
        )}
        {!doc && <RecentDocs visible={active} />}
      </div>

      {doc && (
        <aside className="panel panel-right cv-panel">
          <LayersPanel />
          <ToolOptions cropRect={cropRect} onCropApply={applyCrop} onCropCancel={() => setCropRect(null)} />
          <CanvasHistory />
          <section className="panel-section panel-export">
            <button className="btn-primary cv-save" onClick={doSave}>Save ⌘S</button>
            <button className="btn-quick cv-export-png" onClick={() => doExport('image/png')}>
              Export PNG ⌘E
            </button>
            <button className="btn-quick cv-export-jpg" onClick={() => doExport('image/jpeg')}>
              Export JPEG
            </button>
            <button
              className="btn-quick cv-close"
              onClick={() => saveCanvasDoc().catch(() => {}).then(() => closeCanvasDoc())}
            >Close document</button>
          </section>
        </aside>
      )}
    </div>
  )
}
