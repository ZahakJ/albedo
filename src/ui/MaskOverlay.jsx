import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { newMask } from '../engine/editdoc.js'
import { getState as getEditState, previewMasks, commitMasks, commitMaskGeom } from '../state/editStore.js'
import { sendBrush } from '../state/renderClient.js'
import { geometryOf } from '../engine/geometry.js'
import {
  useMaskUi, getMaskUi, selectMask, setTool, setMaskDragging, nextMaskName, bumpBrushSize, addObjectMask,
} from './MaskPanel.jsx'

// Mask-mode canvas layer (CropOverlay pattern): pure SVG over the developed
// image, neutral white/black only. Handles creation drags (linear/radial),
// brush painting (pts stream to the worker per rAF AND accumulate into the
// draft stroke), and the selected mask's gizmo. All math converts overlay px
// ↔ PRE-mirror y-down source-normalized coords through the same inverse map
// the shader uses, so gizmos stay glued to image content under crop/rotate.

const MINR = 0.002 // minimum radial radius, source-width fraction

export default function MaskOverlay({ photo, doc, canvasRef, matRef }) {
  const W = photo.width
  const H = photo.height
  const u = useMaskUi()
  const [box, setBox] = useState(null)
  const [draft, setDraft] = useState(null) // mask being created (drag in flight)
  const [editGeom, setEditGeom] = useState(null) // gizmo drag geometry override
  const [cursor, setCursor] = useState(null) // brush cursor circle, overlay px
  const [objBox, setObjBox] = useState(null) // object tool drag box, overlay px
  const svgRef = useRef(null)
  const gesture = useRef(null)

  // track the canvas box (the mat is position:relative)
  useLayoutEffect(() => {
    const track = () => {
      const m = matRef.current?.getBoundingClientRect()
      const c = canvasRef.current?.getBoundingClientRect()
      if (!m || !c || c.width < 2) return
      setBox((b) => b && b.left === c.left - m.left && b.top === c.top - m.top &&
        b.w === c.width && b.h === c.height
        ? b : { left: c.left - m.left, top: c.top - m.top, w: c.width, h: c.height })
    }
    track()
    const obs = new ResizeObserver(track)
    obs.observe(matRef.current)
    obs.observe(canvasRef.current)
    return () => obs.disconnect()
  }, [canvasRef, matRef])

  // wheel resizes the brush while the brush tool is armed (fit mode: no pan)
  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    const onWheel = (e) => {
      if (getMaskUi().tool !== 'brush') return
      e.preventDefault()
      bumpBrushSize(e.deltaY < 0 ? 1 : -1)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  })

  if (!box) return null
  const bw = box.w
  const bh = box.h
  const g = geometryOf(doc?.modules?.geometry ?? null, W, H)
  const th = g.angleRad
  const f = g.fitScale
  const crop = g.crop
  const ccx = crop.x + crop.w / 2
  const ccy = crop.y + crop.h / 2
  const sPx = (bw * f) / (crop.w * W) // display px per source px (uniform)

  const toPt = (e) => {
    const r = svgRef.current.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  // overlay px → pre-mirror y-down source-normalized (the shader's muv)
  const toSource = (px, py) => {
    const dx = (crop.x + (px / bw) * crop.w - ccx) * W
    const dy = (crop.y + (py / bh) * crop.h - ccy) * H
    const c = Math.cos(th)
    const s = Math.sin(th)
    return { x: ccx + (c * dx - s * dy) / (f * W), y: ccy + (s * dx + c * dy) / (f * H) }
  }
  const toDisplay = (mx, my) => {
    const ex = (mx - ccx) * W * f
    const ey = (my - ccy) * H * f
    const c = Math.cos(th)
    const s = Math.sin(th)
    const dx = c * ex + s * ey // R(-θ)
    const dy = -s * ex + c * ey
    return { x: ((ccx + dx / W - crop.x) / crop.w) * bw, y: ((ccy + dy / H - crop.y) / crop.h) * bh }
  }

  const masks = doc.masks ?? []
  const committed = masks.find((m) => m.id === u.selectedId) ?? null
  const sel = draft ?? (committed && editGeom ? { ...committed, geom: editGeom } : committed)

  const flushBrush = () => {
    const q = gesture.current
    if (!q || q.kind !== 'paint' || !q.batch.length) return
    sendBrush(photo.id, {
      maskId: q.maskId, channel: q.channel, pts: q.batch,
      size: q.size, flow: q.flow, erase: q.erase,
    })
    q.batch = []
  }

  const onDown = (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    svgRef.current.setPointerCapture(e.pointerId)
    const pt = toPt(e)
    const sp = toSource(pt.x, pt.y)
    const masks0 = getEditState().doc?.masks ?? []

    if (u.tool === 'linear' || u.tool === 'radial') {
      const d = u.tool === 'linear'
        ? newMask('linear', { x0: sp.x, y0: sp.y, x1: sp.x, y1: sp.y }, nextMaskName(masks0, 'linear'))
        : newMask('radial', { cx: sp.x, cy: sp.y, rx: MINR, ry: MINR, angle: 0, feather: 0.5 },
            nextMaskName(masks0, 'radial'))
      gesture.current = { kind: 'create', masks0, draft: d, p0: sp, moved: false }
      selectMask(d.id)
      setMaskDragging(true)
      setDraft(d)
      previewMasks([...masks0, d])
      return
    }

    if (u.tool === 'object') {
      gesture.current = { kind: 'object', p0: sp, px0: pt, sp, pt }
      return
    }

    if (u.tool === 'brush') {
      const mask = masks0.find((m) => m.id === u.selectedId && m.kind === 'brush')
      if (!mask) return
      // channels are shared with 'ai' masks, assigned by doc order over both
      const channel = masks0.filter((m) => m.kind === 'brush' || m.kind === 'ai')
        .findIndex((m) => m.id === mask.id)
      if (channel < 0 || channel > 3) return
      const p0 = [sp.x, sp.y, e.pressure > 0 ? e.pressure : 1]
      gesture.current = {
        kind: 'paint', maskId: mask.id, channel, erase: e.altKey,
        size: u.brushSize, flow: 1, pts: [p0], batch: [p0], raf: 0,
      }
      setMaskDragging(true)
      flushBrush()
      return
    }

    const h = e.target.dataset?.h
    if (h && committed) {
      gesture.current = { kind: 'edit', h, mask: committed, g0: { ...committed.geom }, p0: sp }
      setMaskDragging(true)
      setEditGeom({ ...committed.geom })
    }
  }

  const onMove = (e) => {
    const pt = toPt(e)
    if (u.tool === 'brush') setCursor(pt)
    const q = gesture.current
    if (!q) return
    const sp = toSource(pt.x, pt.y)

    if (q.kind === 'object') {
      q.sp = sp
      q.pt = pt
      setObjBox({ x0: q.px0.x, y0: q.px0.y, x1: pt.x, y1: pt.y })
      return
    }

    if (q.kind === 'create') {
      q.moved = true
      const d = q.draft
      if (d.kind === 'linear') {
        d.geom = { x0: q.p0.x, y0: q.p0.y, x1: sp.x, y1: sp.y }
      } else {
        d.geom = {
          ...d.geom,
          rx: Math.max(MINR, Math.abs(sp.x - q.p0.x)),
          ry: Math.max(MINR, (Math.abs(sp.y - q.p0.y) * H) / W),
        }
      }
      setDraft({ ...d })
      previewMasks([...q.masks0, d])
      return
    }

    if (q.kind === 'paint') {
      // densify: interpolate so stamps overlap (≤ size/6 spacing in width
      // fractions) — pointer events alone leave dashed gaussians. The dense
      // pts land in the committed stroke too, so doc replay matches exactly.
      const pr = e.pressure > 0 ? e.pressure : 1
      const last = q.pts[q.pts.length - 1]
      const dist = Math.hypot(sp.x - last[0], ((sp.y - last[1]) * H) / W)
      const n = Math.max(1, Math.min(64, Math.ceil(dist / (q.size / 6))))
      for (let i = 1; i <= n; i++) {
        const p = [last[0] + ((sp.x - last[0]) * i) / n, last[1] + ((sp.y - last[1]) * i) / n, pr]
        q.pts.push(p)
        q.batch.push(p)
      }
      if (!q.raf) q.raf = requestAnimationFrame(() => { q.raf = 0; flushBrush() })
      return
    }

    if (q.kind === 'edit') {
      const m = q.mask
      let geom = q.g0
      if (m.kind === 'linear') {
        if (q.h === 'p0') geom = { ...q.g0, x0: sp.x, y0: sp.y }
        else if (q.h === 'p1') geom = { ...q.g0, x1: sp.x, y1: sp.y }
        else {
          const dx = sp.x - q.p0.x
          const dy = sp.y - q.p0.y
          geom = { x0: q.g0.x0 + dx, y0: q.g0.y0 + dy, x1: q.g0.x1 + dx, y1: q.g0.y1 + dy }
        }
      } else if (m.kind === 'radial') {
        const ex = (sp.x - q.g0.cx) * W
        const ey = (sp.y - q.g0.cy) * H
        const b = ((q.g0.angle ?? 0) * Math.PI) / 180
        const lx = Math.cos(b) * ex + Math.sin(b) * ey
        const ly = -Math.sin(b) * ex + Math.cos(b) * ey
        if (q.h === 'c') {
          geom = { ...q.g0, cx: q.g0.cx + (sp.x - q.p0.x), cy: q.g0.cy + (sp.y - q.p0.y) }
        } else if (q.h === 'rx') {
          geom = { ...q.g0, rx: Math.max(MINR, Math.abs(lx) / W) }
        } else if (q.h === 'ry') {
          geom = { ...q.g0, ry: Math.max(MINR, Math.abs(ly) / W) }
        } else if (q.h === 'rot') {
          // handle rides the -y ellipse axis: pointer angle + 90° = mask angle
          let a = (Math.atan2(ey, ex) * 180) / Math.PI + 90
          while (a > 180) a -= 360
          while (a < -180) a += 360
          geom = { ...q.g0, angle: Math.round(a * 10) / 10 }
        }
      }
      q.geom = geom
      setEditGeom(geom)
      previewMasks((getEditState().doc?.masks ?? []).map((x) => (x.id === m.id ? { ...x, geom } : x)))
    }
  }

  const onUp = () => {
    const q = gesture.current
    gesture.current = null
    setMaskDragging(false)
    if (!q) return

    if (q.kind === 'object') {
      setObjBox(null)
      setTool(null)
      // a drag of more than a few pixels is a box, anything less a click
      const drag = Math.hypot(q.pt.x - q.px0.x, q.pt.y - q.px0.y) > 6
      const clamp01 = (v) => Math.min(1, Math.max(0, v))
      if (drag) {
        addObjectMask([], [
          clamp01(Math.min(q.p0.x, q.sp.x)), clamp01(Math.min(q.p0.y, q.sp.y)),
          clamp01(Math.max(q.p0.x, q.sp.x)), clamp01(Math.max(q.p0.y, q.sp.y))])
      } else {
        addObjectMask([[clamp01(q.p0.x), clamp01(q.p0.y), 1]], null)
      }
      return
    }

    if (q.kind === 'create') {
      setDraft(null)
      setTool(null)
      const d = q.draft
      const big = d.kind === 'linear'
        ? Math.hypot((d.geom.x1 - d.geom.x0) * W, (d.geom.y1 - d.geom.y0) * H) > 6 / sPx
        : d.geom.rx > MINR * 2 || d.geom.ry > MINR * 2
      if (q.moved && big) commitMasks([...q.masks0, d])
      else { previewMasks(q.masks0); selectMask(null) } // degenerate click: discard
      return
    }
    if (q.kind === 'paint') {
      if (q.raf) cancelAnimationFrame(q.raf)
      flushBrush()
      const stroke = { pts: q.pts, size: q.size, flow: q.flow, erase: q.erase }
      commitMasks((getEditState().doc?.masks ?? []).map((m) =>
        m.id === q.maskId ? { ...m, geom: { strokes: [...(m.geom.strokes ?? []), stroke] } } : m))
      return
    }
    if (q.kind === 'edit') {
      setEditGeom(null)
      if (q.geom) commitMaskGeom(q.mask.id, q.geom)
    }
  }

  // ── gizmo (selected mask only; brush has the cursor circle instead) ──────
  let gizmo = null
  if (sel && sel.kind === 'linear') {
    const a = toDisplay(sel.geom.x0, sel.geom.y0)
    const b = toDisplay(sel.geom.x1, sel.geom.y1)
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy) || 1
    const nx = -dy / len // perpendicular: the feather rails
    const ny = dx / len
    const EXT = 4000
    const rail = (p, key) => (
      <line key={key} className="mask-rail"
        x1={p.x - nx * EXT} y1={p.y - ny * EXT} x2={p.x + nx * EXT} y2={p.y + ny * EXT} />
    )
    gizmo = (
      <g className="mask-gizmo mask-gizmo-linear">
        {rail(a, 'r0')}
        {rail(b, 'r1')}
        <line className="mask-axis-shadow" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
        <line className="mask-axis" data-h="mid" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
        <circle className="mask-handle-hit" data-h="p0" cx={a.x} cy={a.y} r="11" />
        <circle className="mask-handle mask-handle-open" data-h="p0" cx={a.x} cy={a.y} r="5" />
        <circle className="mask-handle-hit" data-h="p1" cx={b.x} cy={b.y} r="11" />
        <circle className="mask-handle" data-h="p1" cx={b.x} cy={b.y} r="5" />
      </g>
    )
  } else if (sel && sel.kind === 'radial') {
    const c = toDisplay(sel.geom.cx, sel.geom.cy)
    const rx = sel.geom.rx * W * sPx
    const ry = sel.geom.ry * W * sPx
    const rot = (sel.geom.angle ?? 0) - (th * 180) / Math.PI // display = mask − geometry angle
    gizmo = (
      <g className="mask-gizmo mask-gizmo-radial"
        transform={`translate(${c.x} ${c.y}) rotate(${rot})`}>
        <ellipse className="mask-ellipse-shadow" cx="0" cy="0" rx={rx} ry={ry} />
        <ellipse className="mask-ellipse" cx="0" cy="0" rx={rx} ry={ry} />
        <line className="mask-rot-stem" x1="0" y1={-ry} x2="0" y2={-ry - 22} />
        <circle className="mask-handle-hit" data-h="rot" cx="0" cy={-ry - 26} r="11" />
        <circle className="mask-handle mask-handle-open" data-h="rot" cx="0" cy={-ry - 26} r="4.5" />
        {[[rx, 0, 'rx'], [-rx, 0, 'rx'], [0, ry, 'ry'], [0, -ry, 'ry']].map(([hx, hy, h], i) => (
          <g key={i}>
            <circle className="mask-handle-hit" data-h={h} cx={hx} cy={hy} r="11" />
            <rect className="mask-handle" data-h={h} x={hx - 4} y={hy - 4} width="8" height="8" />
          </g>
        ))}
        <circle className="mask-handle-hit" data-h="c" cx="0" cy="0" r="12" />
        <circle className="mask-center" data-h="c" cx="0" cy="0" r="3.5" />
      </g>
    )
  }

  const brushR = ((u.brushSize / 2) * f * bw) / crop.w // display px

  return (
    <div className="mask-overlay" style={{ left: box.left, top: box.top, width: bw, height: bh }}>
      <svg
        ref={svgRef}
        className={`mask-svg${u.tool === 'brush' ? ' is-painting' : ''}${u.tool === 'object' ? ' is-picking' : ''}`}
        width={bw}
        height={bh}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onPointerLeave={() => setCursor(null)}
      >
        {gizmo}
        {objBox && (
          <rect className="mask-objbox"
            x={Math.min(objBox.x0, objBox.x1)} y={Math.min(objBox.y0, objBox.y1)}
            width={Math.abs(objBox.x1 - objBox.x0)} height={Math.abs(objBox.y1 - objBox.y0)} />
        )}
        {u.tool === 'brush' && cursor && (
          <g className="mask-brush-cursor">
            <circle className="mask-brush-ring-shadow" cx={cursor.x} cy={cursor.y} r={brushR} />
            <circle className="mask-brush-ring" cx={cursor.x} cy={cursor.y} r={brushR} />
            <circle className="mask-brush-dot" cx={cursor.x} cy={cursor.y} r="1.5" />
          </g>
        )}
      </svg>
    </div>
  )
}
