import { useEffect, useRef, useState } from 'react'
import { buildCurveLut } from '../engine/curve.js'
import { onScopes } from '../state/renderClient.js'
import { useEditState, previewParam, commitParam } from '../state/editStore.js'
import { getParam } from '../engine/editdoc.js'

// Tone curve editor. Click adds a point, drag moves (x clamped between
// neighbors; endpoints vertical-only), double-click or drag-off-canvas
// removes, Del removes selected. In-drag frames go through previewParam —
// React re-renders only on commit. Develop is dark-only: plot colors are
// literals; the luma ghost is data, not chrome.

const PAD = 7        // keeps 6px handles inside the plot border
const EPS = 0.01     // min x gap between neighbors
const HIT = 8        // px hit radius
const OFF = 24       // px past the edge that counts as "dragged off"

const clamp01 = (v) => Math.min(1, Math.max(0, v))
const round3 = (pts) => pts.map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000])

export default function CurveEditor() {
  const { doc } = useEditState()
  const points = doc ? getParam(doc, 'curve', 'points') : [[0, 0], [1, 1]]
  const canvasRef = useRef(null)
  const ctxRef = useRef(null)
  const lumaRef = useRef(null)
  const drag = useRef(null) // { idx, pts, dead, dirty, raf }
  const geom = useRef({ w: 282, h: 196 })
  const paintRef = useRef(() => {})
  const [sel, setSel] = useState(-1)

  const paint = () => {
    const ctx = ctxRef.current
    if (!ctx) return
    const { w, h } = geom.current
    const d = drag.current
    const pts = (d ? d.pts : points).filter((_, i) => !(d?.dead && i === d.idx))
    const iw = w - 2 * PAD
    const ih = h - 2 * PAD
    const px = (x) => PAD + x * iw
    const py = (y) => PAD + (1 - y) * ih
    ctx.clearRect(0, 0, w, h)
    // luma ghost at 15%
    const luma = lumaRef.current
    if (luma) {
      let max = 1
      for (let i = 1; i < 255; i++) max = Math.max(max, luma[768 + i])
      ctx.globalAlpha = 0.15
      ctx.fillStyle = '#d9d9d9'
      ctx.beginPath()
      ctx.moveTo(px(0), py(0))
      for (let i = 0; i < 256; i++)
        ctx.lineTo(px(i / 255), py(Math.sqrt(Math.min(1.2, luma[768 + i] / max))))
      ctx.lineTo(px(1), py(0))
      ctx.closePath()
      ctx.fill()
      ctx.globalAlpha = 1
    }
    // quarter grid + identity diagonal
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'
    ctx.lineWidth = 1
    ctx.beginPath()
    for (const f of [0.25, 0.5, 0.75]) {
      ctx.moveTo(px(f), py(0)); ctx.lineTo(px(f), py(1))
      ctx.moveTo(px(0), py(f)); ctx.lineTo(px(1), py(f))
    }
    ctx.stroke()
    ctx.strokeStyle = 'rgba(255,255,255,0.12)'
    ctx.beginPath()
    ctx.moveTo(px(0), py(0))
    ctx.lineTo(px(1), py(1))
    ctx.stroke()
    // the curve — the engine's own LUT, so drawn == applied
    const lut = buildCurveLut(pts)
    const n = lut.length
    ctx.strokeStyle = '#e6e6e6'
    ctx.lineWidth = 1.25
    ctx.beginPath()
    for (let i = 0; i < n; i++) {
      const x = px(i / (n - 1)), y = py(lut[i])
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)
    }
    ctx.stroke()
    // points: 6px neutral squares, selected = filled
    const selIdx = d ? d.idx : sel
    pts.forEach((p, i) => {
      const x = px(p[0]), y = py(p[1])
      ctx.fillStyle = i === selIdx ? '#e6e6e6' : '#232323'
      ctx.strokeStyle = '#e6e6e6'
      ctx.lineWidth = 1
      ctx.fillRect(x - 3, y - 3, 6, 6)
      ctx.strokeRect(x - 2.5, y - 2.5, 5, 5)
    })
  }
  paintRef.current = paint

  useEffect(() => {
    const canvas = canvasRef.current
    // software raster — same rationale as Histogram
    ctxRef.current = canvas.getContext('2d', { willReadFrequently: true })
    const size = () => {
      const r = canvas.getBoundingClientRect()
      if (!r.width) return
      const dpr = Math.min(devicePixelRatio, 2)
      geom.current = { w: Math.round(r.width), h: Math.round(r.height) }
      canvas.width = Math.round(geom.current.w * dpr)
      canvas.height = Math.round(geom.current.h * dpr)
      ctxRef.current.setTransform(dpr, 0, 0, dpr, 0, 0)
      paintRef.current()
    }
    size()
    const ro = new ResizeObserver(size)
    ro.observe(canvas)
    const off = onScopes(({ hist }) => { lumaRef.current = hist; paintRef.current() })
    return () => { ro.disconnect(); off() }
  }, [])

  // repaint for committed doc / selection changes (drags paint directly)
  useEffect(() => { if (!drag.current) paint() })

  const toXY = (e) => {
    const r = canvasRef.current.getBoundingClientRect()
    const { w, h } = geom.current
    const cx = e.clientX - r.left
    const cy = e.clientY - r.top
    return { x: (cx - PAD) / (w - 2 * PAD), y: 1 - (cy - PAD) / (h - 2 * PAD), cx, cy }
  }

  const hitTest = (pts, cx, cy) => {
    const { w, h } = geom.current
    for (let i = 0; i < pts.length; i++) {
      const x = PAD + pts[i][0] * (w - 2 * PAD)
      const y = PAD + (1 - pts[i][1]) * (h - 2 * PAD)
      if (Math.abs(cx - x) <= HIT && Math.abs(cy - y) <= HIT) return i
    }
    return -1
  }

  const effective = (d) => round3(d.pts.filter((_, i) => !(d.dead && i === d.idx)))

  const onPointerDown = (e) => {
    if (!doc || e.button !== 0) return
    e.preventDefault()
    const { x, y, cx, cy } = toXY(e)
    const pts = points.map((p) => [...p])
    let idx = hitTest(pts, cx, cy)
    let added = false
    if (idx < 0) {
      const nx = clamp01(x)
      const at = pts.findIndex((p) => p[0] > nx)
      if (at <= 0) return // beyond the endpoints' x — nothing to add
      const gx = Math.min(pts[at][0] - EPS, Math.max(pts[at - 1][0] + EPS, nx))
      pts.splice(at, 0, [gx, clamp01(y)])
      idx = at
      added = true
    }
    drag.current = { idx, pts, dead: false, dirty: added, raf: 0 }
    setSel(idx)
    canvasRef.current.setPointerCapture(e.pointerId)
    if (added) previewParam('curve', 'points', effective(drag.current))
    paint()
  }

  const onPointerMove = (e) => {
    const d = drag.current
    if (!d) return
    const { x, y, cx, cy } = toXY(e)
    const { w, h } = geom.current
    const last = d.pts.length - 1
    const p = d.pts[d.idx]
    d.dirty = true
    if (d.idx === 0 || d.idx === last) {
      p[1] = clamp01(y)
    } else {
      d.dead = cx < -OFF || cx > w + OFF || cy < -OFF || cy > h + OFF
      p[0] = Math.min(d.pts[d.idx + 1][0] - EPS, Math.max(d.pts[d.idx - 1][0] + EPS, clamp01(x)))
      p[1] = clamp01(y)
    }
    if (!d.raf) {
      d.raf = requestAnimationFrame(() => {
        d.raf = 0
        if (!drag.current) return
        paintRef.current()
        previewParam('curve', 'points', effective(drag.current))
      })
    }
  }

  const onPointerUp = () => {
    const d = drag.current
    if (!d) return
    if (d.raf) cancelAnimationFrame(d.raf)
    drag.current = null
    setSel(d.dead ? -1 : d.idx)
    if (d.dirty) commitParam('curve', 'points', effective(d))
    else paint()
  }

  const onDoubleClick = (e) => {
    if (!doc) return
    const { cx, cy } = toXY(e)
    const idx = hitTest(points, cx, cy)
    if (idx > 0 && idx < points.length - 1) {
      setSel(-1)
      commitParam('curve', 'points', round3(points.filter((_, i) => i !== idx)))
    }
  }

  const onKeyDown = (e) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel > 0 && sel < points.length - 1) {
      e.preventDefault()
      setSel(-1)
      commitParam('curve', 'points', round3(points.filter((_, i) => i !== sel)))
    }
  }

  return (
    <div className="curve" tabIndex={0} onKeyDown={onKeyDown} role="application" aria-label="Tone curve">
      <canvas
        ref={canvasRef}
        className="curve-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
      />
    </div>
  )
}
