import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { newHealSpot, getParam } from '../engine/editdoc.js'
import { previewParam, commitParam, getState as getEditState } from '../state/editStore.js'
import { geometryOf, toFinalSource } from '../engine/geometry.js'
import { removeArea, removeObjectAt } from '../state/removeTool.js'
import { useLens, lensTerms } from '../state/lensStore.js'
import { useViewState, getViewState, setZoom } from '../state/viewStore.js'
import { useMaskUi, getMaskUi } from './MaskPanel.jsx'

// Heal/clone spot removal (H). This module owns the tiny heal-mode store
// (MaskPanel pattern), the canvas overlay (CropOverlay pattern: pure SVG in
// neutral white/black over the developed image) and the HEAL panel section.
// H toggles the mode via a CAPTURE-phase window listener installed here —
// never in App.jsx. Gesture language: click-drag paints the dest circle then
// drags the source; existing spots show the dest circle, the selected spot
// shows both circles + a connecting line; drag moves either circle, wheel
// resizes, ⌫ removes the selection, Esc (or H) exits. Every spot op is ONE
// history entry (preview during the drag, commit on release).

let ui = {
  on: false,
  tool: 'heal', // 'heal' spots, or 'remove': paint a hole or click an object
  selectedId: null,
  radius: 0.04, // next spot's radius, source-WIDTH fraction
  removeSize: 0.03, // remove brush diameter, source-WIDTH fraction
  busy: false, // a removal in flight
  error: null,
}
const listeners = new Set()
const emit = () => { for (const fn of listeners) fn() }
const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn) }
export const useHealUi = () => useSyncExternalStore(subscribe, () => ui)
export const getHealUi = () => ui

function set(patch) {
  ui = { ...ui, ...patch }
  emit()
}

export function setHealMode(on, tool) {
  if (on && tool && tool !== ui.tool) set({ tool })
  if (on === !!ui.on) return
  if (on) setZoom('fit') // spot math is fit-only, like crop/mask modes
  set(on ? { on: true } : { on: false, selectedId: null })
}

// a removal, with the busy flag and any error on the store
async function runRemove(job) {
  if (ui.busy) return
  set({ busy: true, error: null })
  try {
    await job()
  } catch (err) {
    set({ error: String(err?.message ?? err) })
  } finally {
    set({ busy: false })
  }
}
export const selectSpot = (id) => set({ selectedId: id })

const spotsOf = (doc) => (doc ? getParam(doc, 'heal', 'spots') : [])

const patchSpots = (spots, id, patch) =>
  spots.map((s) => (s.id === id ? { ...s, ...patch } : s))

export function deleteSelectedSpot() {
  const doc = getEditState().doc
  if (!doc || ui.selectedId == null) return
  commitParam('heal', 'spots', spotsOf(doc).filter((s) => s.id !== ui.selectedId))
  set({ selectedId: null })
}

export const toggleSpotMode = (id) => {
  const doc = getEditState().doc
  if (!doc) return
  commitParam('heal', 'spots', spotsOf(doc).map((s) =>
    s.id === id ? { ...s, mode: s.mode === 'heal' ? 'clone' : 'heal' } : s))
}

// ── canvas overlay + key router (always mounted while a photo is open) ─────
export default function HealOverlay({ photo, doc, canvasRef, matRef }) {
  const u = useHealUi()
  const [box, setBox] = useState(null)
  const [cursor, setCursor] = useState(null) // hover circle, overlay px
  // previews render only (editStore never re-renders React mid-gesture), so
  // the gizmo tracks a local copy of the in-flight spots array
  const [previewSpots, setPreviewSpots] = useState(null)
  const [stroke, setStroke] = useState(null) // remove brush path, overlay px
  const lens = useLens(photo?.id)
  const svgRef = useRef(null)
  const gesture = useRef(null)
  const wheelCommit = useRef(0)

  const { cropMode } = useViewState()
  const maskOn = useMaskUi().on
  const active = u.on && !!photo && !!doc && !cropMode && !maskOn

  // H toggles heal mode — capture phase, ahead of App's keyboard router
  // (which bails on e.defaultPrevented). Mode keys route here while on.
  useEffect(() => {
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target
      if (t instanceof Element && (t.closest('input, textarea, select') || t.isContentEditable)) return
      if (getViewState().surface !== 'develop') return
      if (e.key === 'h' || e.key === 'H' || e.key === 'q' || e.key === 'Q') {
        if (!getHealUi().on && (getViewState().cropMode || getMaskUi().on)) return
        e.preventDefault()
        const tool = e.key.toLowerCase() === 'q' ? 'remove' : 'heal'
        const u0 = getHealUi()
        if (u0.on && u0.tool !== tool) set({ tool })
        else setHealMode(!u0.on, tool)
        return
      }
      if (!getHealUi().on) return
      switch (e.key) {
        case 'Escape': e.preventDefault(); setHealMode(false); return
        case 'Enter': e.preventDefault(); setHealMode(false); return
        case 'Backspace': case 'Delete': e.preventDefault(); deleteSelectedSpot(); return
        case 'z': case 'Z': e.preventDefault(); return // fit-only: swallow the loupe
        case '[': e.preventDefault(); ui.tool === 'remove'
          ? set({ removeSize: Math.max(0.003, ui.removeSize * 0.8) })
          : set({ radius: Math.max(0.005, ui.radius * 0.8) }); return
        case ']': e.preventDefault(); ui.tool === 'remove'
          ? set({ removeSize: Math.min(0.3, ui.removeSize * 1.25) })
          : set({ radius: Math.min(0.3, ui.radius * 1.25) }); return
        // crop/mask mode takes over: drop heal mode, let App route the key
        case 'r': case 'R': case 'm': case 'M': setHealMode(false); return
      }
    }
    addEventListener('keydown', onKey, true)
    return () => removeEventListener('keydown', onKey, true)
  }, [])

  // heal mode never spans photos
  useEffect(() => { setHealMode(false) }, [photo?.id])

  // track the canvas box (the mat is position:relative) — CropOverlay pattern
  useLayoutEffect(() => {
    if (!active) return
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
  }, [active, canvasRef, matRef])

  // wheel resizes the selected spot (or the next-spot radius) — preview
  // immediately, commit once after the wheel run settles (one history entry)
  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    const onWheel = (e) => {
      e.preventDefault()
      const k = e.deltaY < 0 ? 1.15 : 0.87
      if (getHealUi().tool === 'remove') {
        set({ removeSize: Math.min(0.3, Math.max(0.003, ui.removeSize * k)) })
        return
      }
      const id = getHealUi().selectedId
      const d = getEditState().doc
      const spot = spotsOf(d).find((s) => s.id === id)
      if (!spot) { set({ radius: Math.min(0.3, Math.max(0.005, ui.radius * k)) }); return }
      const spots = patchSpots(spotsOf(d), id, { r: Math.min(0.3, Math.max(0.005, spot.r * k)) })
      previewParam('heal', 'spots', spots)
      setPreviewSpots(spots)
      clearTimeout(wheelCommit.current)
      wheelCommit.current = setTimeout(() => {
        commitParam('heal', 'spots', spotsOf(getEditState().doc))
        setPreviewSpots(null)
      }, 400)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  })

  if (!active || !box) return null
  const W = photo.width
  const H = photo.height
  const bw = box.w
  const bh = box.h
  const g = geometryOf(doc?.modules?.geometry ?? null, W, H, doc?.modules?.lens ?? null)
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
  // overlay px → pre-mirror y-down source-normalized (affine twin; the
  // persp/lens warps are ignored here — spot placement drifts a little under
  // heavy keystone, the same accepted drift as the mask gizmos)
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

  const spots = previewSpots ?? spotsOf(doc)
  const sel = spots.find((s) => s.id === u.selectedId) ?? null

  // painted points live in crop space; patches in final source space
  const toFinal = (p) => {
    const m = doc?.modules
    return toFinalSource(p.x, p.y, W, H, m?.geometry?.persp ?? null, m?.lens?.distortion ?? 0, lensTerms(lens, doc))
  }

  const onDown = (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    svgRef.current.setPointerCapture(e.pointerId)
    const pt = toPt(e)
    const sp = toSource(pt.x, pt.y)
    if (u.tool === 'remove') {
      if (u.busy) return
      gesture.current = { kind: 'stroke', pts: [sp], px: [pt], len: 0 }
      setStroke([pt])
      return
    }
    const spots0 = spotsOf(getEditState().doc)
    const hid = e.target.dataset?.hid
    const hh = e.target.dataset?.h // 'd' dest | 's' source
    if (hid && hh) {
      const spot = spots0.find((s) => s.id === hid)
      if (!spot) return
      set({ selectedId: hid })
      gesture.current = { kind: 'move', id: hid, which: hh, p0: sp, s0: { ...spot } }
      return
    }
    // create: dest lands here; the drag places the source (a plain click
    // auto-offsets the source just outside the dest circle)
    const spot = newHealSpot('heal', sp.x, sp.y, sp.x + ui.radius * 2.5, sp.y, ui.radius)
    gesture.current = { kind: 'create', id: spot.id, moved: false }
    set({ selectedId: spot.id })
    const next = [...spots0, spot]
    previewParam('heal', 'spots', next)
    setPreviewSpots(next)
  }

  const onMove = (e) => {
    const pt = toPt(e)
    setCursor(pt)
    const q = gesture.current
    if (!q) return
    const sp = toSource(pt.x, pt.y)
    if (q.kind === 'stroke') {
      const last = q.px[q.px.length - 1]
      q.len += Math.hypot(pt.x - last.x, pt.y - last.y)
      q.pts.push(sp)
      q.px.push(pt)
      setStroke([...q.px])
      return
    }
    const spots0 = spotsOf(getEditState().doc)
    let next = null
    if (q.kind === 'create') {
      q.moved = true
      next = patchSpots(spots0, q.id, { sx: sp.x, sy: sp.y })
    } else if (q.kind === 'move') {
      const ddx = sp.x - q.p0.x
      const ddy = sp.y - q.p0.y
      next = patchSpots(spots0, q.id, q.which === 'd'
        ? { dx: q.s0.dx + ddx, dy: q.s0.dy + ddy }
        : { sx: q.s0.sx + ddx, sy: q.s0.sy + ddy })
    }
    if (next) {
      previewParam('heal', 'spots', next)
      setPreviewSpots(next)
    }
  }

  const onUp = () => {
    const q = gesture.current
    gesture.current = null
    if (!q) return
    if (q.kind === 'stroke') {
      setStroke(null)
      // a click removes the object under it; a stroke removes what it covers
      if (q.len < 6) {
        const [fx, fy] = toFinal(q.pts[0])
        runRemove(() => removeObjectAt(fx, fy))
      } else {
        const pts = q.pts.map((p) => toFinal(p))
        runRemove(() => removeArea({ strokes: [{ pts, size: ui.removeSize }] }))
      }
      return
    }
    // ONE history entry per spot op (the whole preview chain lands at once)
    commitParam('heal', 'spots', spotsOf(getEditState().doc))
    setPreviewSpots(null)
  }

  const rOf = (s) => Math.max(3, s.r * W * sPx)

  return (
    <div className="heal-overlay" style={{ left: box.left, top: box.top, width: bw, height: bh }}>
      <svg
        ref={svgRef}
        className={`heal-svg${u.tool === 'remove' ? ' is-remove' : ''}`}
        width={bw}
        height={bh}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onPointerLeave={() => setCursor(null)}
      >
        {spots.map((s) => {
          const d = toDisplay(s.dx, s.dy)
          const r = rOf(s)
          const selected = s.id === u.selectedId
          if (!selected) {
            return (
              <g key={s.id} className="heal-spot">
                <circle className="heal-ring-shadow" cx={d.x} cy={d.y} r={r} />
                <circle className="heal-ring" data-h="d" data-hid={s.id} cx={d.x} cy={d.y} r={r} />
              </g>
            )
          }
          const so = toDisplay(s.sx, s.sy)
          return (
            <g key={s.id} className="heal-spot is-selected">
              <line className="heal-link-shadow" x1={d.x} y1={d.y} x2={so.x} y2={so.y} />
              <line className="heal-link" x1={d.x} y1={d.y} x2={so.x} y2={so.y} />
              <circle className="heal-ring-shadow" cx={d.x} cy={d.y} r={r} />
              <circle className="heal-ring" data-h="d" data-hid={s.id} cx={d.x} cy={d.y} r={r} />
              <circle className="heal-ring-shadow" cx={so.x} cy={so.y} r={r} />
              <circle className="heal-ring heal-ring-src" data-h="s" data-hid={s.id} cx={so.x} cy={so.y} r={r} />
            </g>
          )
        })}
        {u.tool === 'heal' && cursor && !sel && !gesture.current && (
          <circle className="heal-cursor" cx={cursor.x} cy={cursor.y} r={ui.radius * W * sPx} />
        )}
        {u.tool === 'remove' && stroke && (
          <polyline className="remove-stroke" points={stroke.map((p) => `${p.x},${p.y}`).join(' ')}
            strokeWidth={Math.max(2, ui.removeSize * W * sPx)} />
        )}
        {u.tool === 'remove' && cursor && !stroke && (
          <circle className="heal-cursor" cx={cursor.x} cy={cursor.y} r={(ui.removeSize / 2) * W * sPx} />
        )}
      </svg>
      <span className="heal-hint mono on-image">{u.tool === 'remove'
        ? (u.busy ? 'removing…' : u.error ?? 'Q remove · paint over it, or click an object · [ ] size · Esc done')
        : 'H heal · drag dest → source · wheel size · ⌫ delete · Esc done'}</span>
    </div>
  )
}

// ── HEAL panel section body (rendered by Develop's right rail) ─────────────
export function HealSection({ doc }) {
  const u = useHealUi()
  const spots = spotsOf(doc)
  const patches = doc ? getParam(doc, 'remove', 'patches') : []
  return (
    <div className="heal-section">
      {spots.map((s, i) => (
        <div
          key={s.id}
          className={`heal-row${s.id === u.selectedId ? ' is-selected' : ''}`}
          onClick={() => { setHealMode(true); selectSpot(s.id) }}
        >
          <span className="heal-idx mono">{i + 1}</span>
          <button
            type="button"
            className="heal-mode mono"
            title="Toggle heal / clone"
            onClick={(e) => { e.stopPropagation(); toggleSpotMode(s.id) }}
          >{s.mode === 'heal' ? 'HEAL' : 'CLONE'}</button>
          <span className="heal-dims mono">r {Math.round(s.r * 1000)}</span>
          <button
            type="button"
            className="heal-del"
            title="Delete spot"
            onClick={(e) => {
              e.stopPropagation()
              commitParam('heal', 'spots', spotsOf(getEditState().doc).filter((q) => q.id !== s.id))
              if (getHealUi().selectedId === s.id) set({ selectedId: null })
            }}
          >×</button>
        </div>
      ))}
      {patches.map((p, i) => (
        <div key={p.id} className="heal-row">
          <span className="heal-idx mono">{spots.length + i + 1}</span>
          <span className="heal-mode mono">REMOVED</span>
          <span className="heal-dims mono">{Math.round(p.w * 100)}×{Math.round(p.h * 100)}%</span>
          <button
            type="button" className="heal-del" title="Restore"
            onClick={() => commitParam('remove', 'patches',
              getParam(getEditState().doc, 'remove', 'patches').filter((q) => q.id !== p.id))}
          >×</button>
        </div>
      ))}
      {!spots.length && !patches.length &&
        <p className="heal-empty">Press Q and paint over anything to remove it, or click an object. H heals spots.</p>}
      <div className="heal-tools">
        <button
          type="button"
          className={`heal-toggle mono${u.on && u.tool === 'remove' ? ' is-on' : ''}`}
          onClick={() => (u.on && u.tool === 'remove' ? setHealMode(false) : setHealMode(true, 'remove'))}
        >{u.busy ? 'REMOVING…' : 'REMOVE — Q'}</button>
        <button
          type="button"
          className={`heal-toggle mono${u.on && u.tool === 'heal' ? ' is-on' : ''}`}
          onClick={() => (u.on && u.tool === 'heal' ? setHealMode(false) : setHealMode(true, 'heal'))}
        >HEAL — H</button>
      </div>
    </div>
  )
}
