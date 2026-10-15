import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react'
import { getParam, setParam } from '../engine/editdoc.js'
import { applyModules, setSendFlags, previewDoc, cancelPreviewDoc } from '../state/editStore.js'
import { setCropMode, cycleCropGrid } from '../state/viewStore.js'
import { uiScale } from './uiScale.js'
import { fitScaleFor } from '../engine/geometry.js'
import { useLens, lensTerms } from '../state/lensStore.js'

// Crop & straighten overlay. The canvas beneath shows the RAW frame (engine
// gets showUncropped); everything here is SVG — image pixels are never
// touched. The draft never reaches the doc until commit: Enter/dbl-click/R =
// ONE applyModules (one history entry), Esc = exit untouched.
//
// The drawn quad is the exact sampled region: the crop rect rotated by angle
// and shrunk by 1/fitScale about its center — instrument-grade honesty about
// which pixels survive. Drag math runs in the rect's local frame via the
// inverse display transform (frozen fitScale per gesture; exact at rest).

const MINC = 0.05 // minimum crop extent, normalized
const ASPECTS = ['orig', 'free', '1:1', '3:2', '16:9']
const GOLDEN = [0.381966, 0.618034]

// target w/h ratio in SOURCE-PIXEL terms; free = null. Fixed ratios follow
// the crop's current orientation (a portrait crop keeps 2:3).
function ratioFor(aspect, crop, W, H) {
  if (aspect === 'free') return null
  if (aspect === 'orig') return W / H
  let r = aspect === '1:1' ? 1 : aspect === '3:2' ? 3 / 2 : 16 / 9
  if (r !== 1 && (crop.w * W) / (crop.h * H) < 1) r = 1 / r
  return r
}

// axis-aligned resize in normalized local coords, aspect-locked when r set
function resizeCrop(c0, h, lx, ly, rn) {
  let x1 = c0.x
  let y1 = c0.y
  let x2 = c0.x + c0.w
  let y2 = c0.y + c0.h
  const west = h.includes('w')
  const east = h.includes('e')
  const north = h.includes('n')
  const south = h.includes('s')
  if (west) x1 = Math.min(Math.max(0, lx), x2 - MINC)
  if (east) x2 = Math.max(Math.min(1, lx), x1 + MINC)
  if (north) y1 = Math.min(Math.max(0, ly), y2 - MINC)
  if (south) y2 = Math.max(Math.min(1, ly), y1 + MINC)
  if (rn) {
    if ((west || east) && !(north || south)) {
      // side handle: height follows width, centered; shrink width if clamped
      let hh = (x2 - x1) / rn
      const cy = (y1 + y2) / 2
      y1 = cy - hh / 2
      y2 = cy + hh / 2
      if (y1 < 0) { y2 -= y1; y1 = 0 }
      if (y2 > 1) { y1 -= y2 - 1; y2 = 1 }
      y1 = Math.max(0, y1)
      const w2 = (y2 - y1) * rn
      if (west) x1 = x2 - w2
      else x2 = x1 + w2
    } else if ((north || south) && !(west || east)) {
      let w = (y2 - y1) * rn
      const cx = (x1 + x2) / 2
      x1 = cx - w / 2
      x2 = cx + w / 2
      if (x1 < 0) { x2 -= x1; x1 = 0 }
      if (x2 > 1) { x1 -= x2 - 1; x2 = 1 }
      x1 = Math.max(0, x1)
      const h2 = (x2 - x1) / rn
      if (north) y1 = y2 - h2
      else y2 = y1 + h2
    } else {
      // corner: anchor the opposite corner, take the larger implied size,
      // then clamp to the frame keeping the ratio
      const ax = west ? x2 : x1
      const ay = north ? y2 : y1
      let w = Math.max(x2 - x1, (y2 - y1) * rn, MINC)
      let hh = w / rn
      const maxW = west ? ax : 1 - ax
      const maxH = north ? ay : 1 - ay
      if (w > maxW) { w = maxW; hh = w / rn }
      if (hh > maxH) { hh = maxH; w = hh * rn }
      if (west) x1 = ax - w
      else x2 = ax + w
      if (north) y1 = ay - hh
      else y2 = ay + hh
    }
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}

// thin drag-ruler: ±0.1°/px, Alt ±0.01°/px, double-click zeroes
function AngleRuler({ value, onChange }) {
  const drag = useRef(null)
  const PPD = 7 // px per degree of tick travel
  const W = 164
  const H = 18
  const ticks = []
  const from = Math.ceil(value - W / 2 / PPD)
  const to = Math.floor(value + W / 2 / PPD)
  for (let k = from; k <= to; k++) {
    if (k < -45 || k > 45) continue
    const x = W / 2 + (k - value) * PPD
    const major = k % 5 === 0
    ticks.push(<line key={k} x1={x} y1={major ? 4 : 8} x2={x} y2={H - (major ? 4 : 8)}
      stroke={major ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.28)'} strokeWidth="1" />)
  }
  return (
    <svg
      className="crop-ruler"
      width={W}
      height={H}
      onPointerDown={(e) => {
        e.stopPropagation()
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = { x0: e.clientX, v0: value }
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d) return
        const dv = (e.clientX - d.x0) * (e.altKey ? 0.01 : 0.1)
        onChange(Math.max(-45, Math.min(45, Math.round((d.v0 + dv) * 100) / 100)))
      }}
      onPointerUp={() => { drag.current = null }}
      onDoubleClick={(e) => { e.stopPropagation(); onChange(0) }}
    >
      {ticks}
      <line x1={W / 2} y1={1} x2={W / 2} y2={H - 1} stroke="#fff" strokeWidth="1.5" />
    </svg>
  )
}

export default function CropOverlay({ photo, doc, canvasRef, matRef, grid }) {
  const W = photo.width
  const H = photo.height
  const lens = useLens(photo.id)
  const [draft, setDraft] = useState(() => ({
    crop: { ...getParam(doc, 'geometry', 'crop') },
    angle: getParam(doc, 'geometry', 'angle'),
    flipH: getParam(doc, 'geometry', 'flipH'),
    persp: { ...(getParam(doc, 'geometry', 'persp') ?? { v: 0, h: 0 }) },
  }))
  const [aspect, setAspect] = useState('free')
  const [box, setBox] = useState(null) // canvas rect relative to the mat
  const [line, setLine] = useState(null) // ⌘-drag straighten line, overlay px
  const [tip, setTip] = useState(null) // { x, y, text } angle readout
  const draftRef = useRef(draft)
  draftRef.current = draft
  const svgRef = useRef(null)
  const gesture = useRef(null)

  // engine shows the raw frame while the overlay lives
  useEffect(() => {
    setSendFlags({ showUncropped: true })
    return () => setSendFlags({ showUncropped: false })
  }, [])

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

  const commit = useCallback(() => {
    const d = draftRef.current
    const cur = {
      crop: getParam(doc, 'geometry', 'crop'),
      angle: getParam(doc, 'geometry', 'angle'),
      flipH: getParam(doc, 'geometry', 'flipH'),
      persp: getParam(doc, 'geometry', 'persp') ?? { v: 0, h: 0 },
    }
    if (JSON.stringify(d) !== JSON.stringify(cur)) applyModules({ geometry: d })
    else cancelPreviewDoc() // an un-committed keystone preview may be showing
    setCropMode(false)
  }, [doc])
  const cancel = useCallback(() => { cancelPreviewDoc(); setCropMode(false) }, [])

  // keystone drafts preview live on the raw frame (previewDoc: renders only,
  // doc untouched — Esc rolls back by re-sending the real doc)
  const setPersp = useCallback((key, v) => {
    setDraft((d) => {
      const persp = { ...d.persp, [key]: v }
      previewDoc(setParam(doc, 'geometry', 'persp', persp))
      return { ...d, persp }
    })
  }, [doc])

  // capture phase: the overlay owns Enter/Esc/O/R before the app router
  useEffect(() => {
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return // ⌘Z etc stay global
      if (e.key === 'Enter') { e.preventDefault(); commit() }
      else if (e.key === 'Escape') { e.preventDefault(); cancel() }
      else if (e.key === 'o' || e.key === 'O') { e.preventDefault(); cycleCropGrid() }
      else if (e.key === 'r' || e.key === 'R') { e.preventDefault(); commit() }
    }
    addEventListener('keydown', onKey, true)
    return () => removeEventListener('keydown', onKey, true)
  }, [commit, cancel])

  if (!box) return null
  const bw = box.w
  const bh = box.h
  const th = (draft.angle * Math.PI) / 180
  const f = fitScaleFor(draft.crop, th, W, H, draft.persp, doc?.modules?.lens?.distortion ?? 0,
    lensTerms(lens, doc))
  const rx = draft.crop.x * bw
  const ry = draft.crop.y * bh
  const rw = draft.crop.w * bw
  const rh = draft.crop.h * bh
  const cx = rx + rw / 2
  const cy = ry + rh / 2
  const quadT = `translate(${cx} ${cy}) rotate(${draft.angle}) scale(${1 / f}) translate(${-cx} ${-cy})`

  const toPt = (e) => {
    const r = svgRef.current.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  // inverse display transform: overlay px → rect-local px (unrotated frame)
  const toLocal = (p, ang, fz, ccx, ccy) => {
    const dx = p.x - ccx
    const dy = p.y - ccy
    const c = Math.cos(ang)
    const s = Math.sin(ang)
    return { x: ccx + (c * dx + s * dy) * fz, y: ccy + (-s * dx + c * dy) * fz }
  }

  const onDown = (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    svgRef.current.setPointerCapture(e.pointerId)
    const pt = toPt(e)
    const d = draftRef.current
    if (e.metaKey || e.ctrlKey) {
      gesture.current = { kind: 'line' }
      setLine({ x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y })
      return
    }
    const handle = e.target.dataset?.h
    if (handle) {
      gesture.current = { kind: 'resize', h: handle, th, f, cx, cy }
      return
    }
    const l = toLocal(pt, th, f, cx, cy)
    const inside = l.x >= rx && l.x <= rx + rw && l.y >= ry && l.y <= ry + rh
    if (inside) gesture.current = { kind: 'move', crop0: { ...d.crop }, p0: pt, th, f }
    else gesture.current = { kind: 'rotate', a0: d.angle, start: Math.atan2(pt.y - cy, pt.x - cx), cx, cy }
  }

  const onMove = (e) => {
    const g = gesture.current
    if (!g) return
    const pt = toPt(e)
    if (g.kind === 'line') {
      setLine((l) => l && { ...l, x2: pt.x, y2: pt.y })
      setTip({ x: pt.x, y: pt.y, text: `${lineAngle(line?.x1 ?? pt.x, line?.y1 ?? pt.y, pt.x, pt.y).toFixed(1)}°` })
      return
    }
    if (g.kind === 'rotate') {
      let a = g.a0 + ((Math.atan2(pt.y - g.cy, pt.x - g.cx) - g.start) * 180) / Math.PI
      while (a > 180) a -= 360
      while (a < -180) a += 360
      a = Math.max(-45, Math.min(45, Math.round(a * 10) / 10))
      setDraft((d) => ({ ...d, angle: a }))
      setTip({ x: pt.x, y: pt.y, text: `${a.toFixed(1)}°` })
      return
    }
    if (g.kind === 'move') {
      const c = Math.cos(g.th)
      const s = Math.sin(g.th)
      const dx = pt.x - g.p0.x
      const dy = pt.y - g.p0.y
      const lx = ((c * dx + s * dy) * g.f) / bw
      const ly = ((-s * dx + c * dy) * g.f) / bh
      setDraft((d) => ({
        ...d,
        crop: {
          ...g.crop0,
          x: Math.max(0, Math.min(1 - g.crop0.w, g.crop0.x + lx)),
          y: Math.max(0, Math.min(1 - g.crop0.h, g.crop0.y + ly)),
        },
      }))
      return
    }
    if (g.kind === 'resize') {
      const l = toLocal(pt, g.th, g.f, g.cx, g.cy)
      setDraft((d) => {
        const r = ratioFor(aspect, d.crop, W, H)
        return { ...d, crop: resizeCrop(d.crop, g.h, l.x / bw, l.y / bh, r ? (r * H) / W : null) }
      })
    }
  }

  // y-down line angle → straighten target: level to horizontal, or vertical
  // when the stroke is closer to vertical; positive = image turns CCW
  const lineAngle = (x1, y1, x2, y2) => {
    let a = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI
    while (a > 90) a -= 180
    while (a <= -90) a += 180
    const vert = a > 0 ? a - 90 : a + 90
    return Math.abs(a) <= Math.abs(vert) ? a : vert
  }

  const onUp = () => {
    const g = gesture.current
    gesture.current = null
    setTip(null)
    if (g?.kind === 'line' && line) {
      const len = Math.hypot(line.x2 - line.x1, line.y2 - line.y1)
      setLine(null)
      if (len > 8) {
        const t = Math.max(-45, Math.min(45,
          Math.round(lineAngle(line.x1, line.y1, line.x2, line.y2) * 10) / 10))
        setDraft((d) => ({ ...d, angle: t }))
      }
    }
  }

  const pickAspect = (a) => {
    setAspect(a)
    if (a === 'free') return
    setDraft((d) => {
      const rn = (ratioFor(a, d.crop, W, H) * H) / W
      const c = d.crop
      let w = c.w
      let h = c.h
      if (w / h > rn) w = h * rn
      else h = w / rn
      const ccx = Math.max(w / 2, Math.min(1 - w / 2, c.x + c.w / 2))
      const ccy = Math.max(h / 2, Math.min(1 - h / 2, c.y + c.h / 2))
      return { ...d, crop: { x: ccx - w / 2, y: ccy - h / 2, w, h } }
    })
  }

  // grid line fractions
  const fracs = grid === 'thirds' ? [1 / 3, 2 / 3] : grid === 'golden' ? GOLDEN : []

  // handles: 8, in rect coords (drawn inside the transformed group)
  const hs = 5 // half handle hit size
  const handles = [
    ['nw', rx, ry], ['n', cx, ry], ['ne', rx + rw, ry],
    ['e', rx + rw, cy], ['se', rx + rw, ry + rh], ['s', cx, ry + rh],
    ['sw', rx, ry + rh], ['w', rx, cy],
  ]
  const HCUR = {
    nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
    n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
  }

  // floating toolbar under the quad's bounding box, clamped into the mat
  const bbH = (Math.abs(rw * Math.sin(th)) + Math.abs(rh * Math.cos(th))) / f
  const outW = Math.max(1, Math.round((draft.crop.w * W) / f))
  const outH = Math.max(1, Math.round((draft.crop.h * H) / f))
  const tbW = Math.round(312 * uiScale())
  const tbX = Math.max(-box.left + 8, Math.min(bw + box.left - tbW - 8, cx - tbW / 2))
  const tbY = Math.min(bh + 8, cy + bbH / 2 + 12)

  return (
    <div className="crop-overlay" style={{ left: box.left, top: box.top, width: bw, height: bh }}>
      <svg
        ref={svgRef}
        className="crop-svg"
        width={bw}
        height={bh}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onDoubleClick={commit}
      >
        <defs>
          <mask id="crop-cut">
            <rect x="0" y="0" width={bw} height={bh} fill="#fff" />
            <g transform={quadT}><rect x={rx} y={ry} width={rw} height={rh} fill="#000" /></g>
          </mask>
        </defs>
        {/* outside darkening is pure SVG scrim — image pixels stay honest */}
        <rect className="crop-scrim" x="0" y="0" width={bw} height={bh} mask="url(#crop-cut)" />
        <g transform={quadT}>
          <rect className="crop-frame-shadow" x={rx} y={ry} width={rw} height={rh} />
          <rect className="crop-frame" x={rx} y={ry} width={rw} height={rh} />
          {fracs.map((t) => (
            <g key={t} className="crop-grid">
              <line x1={rx + rw * t} y1={ry} x2={rx + rw * t} y2={ry + rh} />
              <line x1={rx} y1={ry + rh * t} x2={rx + rw} y2={ry + rh * t} />
            </g>
          ))}
          {handles.map(([h, hx, hy]) => (
            <g key={h} data-h={h} style={{ cursor: HCUR[h] }}>
              <rect data-h={h} className="crop-handle-hit" x={hx - 9} y={hy - 9} width="18" height="18" />
              <rect data-h={h} className="crop-handle" x={hx - hs} y={hy - hs} width={hs * 2} height={hs * 2} />
            </g>
          ))}
        </g>
        {line && (
          <g className="crop-line">
            <line x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} className="crop-line-shadow" />
            <line x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} className="crop-line-main" />
          </g>
        )}
      </svg>

      {tip && (
        <span className="crop-tip mono" style={{ left: tip.x + 14, top: tip.y + 14 }}>{tip.text}</span>
      )}

      <div className="crop-toolbar" style={{ left: tbX, top: tbY, width: tbW }}>
        <div className="crop-aspects">
          {ASPECTS.map((a) => (
            <button
              key={a}
              className={`crop-aspect mono${aspect === a ? ' is-on' : ''}`}
              onClick={() => pickAspect(a)}
            >{a.toUpperCase()}</button>
          ))}
          <span className="crop-dims mono">{outW} × {outH}</span>
        </div>
        <div className="crop-angle-row">
          <AngleRuler value={draft.angle} onChange={(a) => setDraft((d) => ({ ...d, angle: a }))} />
          {/* hundredths appear only when Alt fine-tune produced them */}
          <span className="crop-angle-val mono">
            {draft.angle.toFixed(Math.round(draft.angle * 100) % 10 === 0 ? 1 : 2)}°
          </span>
        </div>
        {/* keystone correction — previews live, commits with the crop */}
        {['v', 'h'].map((k) => (
          <div className="crop-persp-row" key={k}>
            <span className="crop-persp-label mono" onDoubleClick={() => setPersp(k, 0)}>
              {k === 'v' ? 'PERSP V' : 'PERSP H'}
            </span>
            <input
              type="range"
              className={`crop-persp-slider crop-persp-${k}`}
              min={-100}
              max={100}
              step={1}
              value={draft.persp[k]}
              onChange={(e) => setPersp(k, +e.target.value)}
              onPointerDown={(e) => e.stopPropagation()}
            />
            <span className="crop-persp-val mono">{draft.persp[k]}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
