import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useDevFlags, getDevFlags, cycleSplit, setSplitPos } from './devFlags.js'
import { getViewState } from '../state/viewStore.js'
import { getState as getEditState } from '../state/editStore.js'

// Split before/after view (Y / ⇧Y). The render worker composites the BEFORE
// doc on one side of the divider and the current doc on the other and paints
// a 1px neutral line in the finish pass; this component owns the keyboard
// (CAPTURE-phase window listener — never App.jsx) and the draggable divider
// handle over the canvas. Y cycles off↔h (vertical divider, before on the
// left), ⇧Y cycles off↔v (horizontal divider, before on top). The flag rides
// sendParams like before/clipOverlay — exports never see it.

export default function SplitView({ photo, canvasRef, matRef }) {
  const { splitView, splitPos } = useDevFlags()
  const [box, setBox] = useState(null)
  const drag = useRef(null)
  const active = splitView !== 'off' && !!photo

  // Y / ⇧Y — capture phase, ahead of App's router (which bails on
  // e.defaultPrevented); typing fields and other develop modes are excluded
  useEffect(() => {
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key !== 'y' && e.key !== 'Y') return
      const t = e.target
      if (t instanceof Element && (t.closest('input, textarea, select') || t.isContentEditable)) return
      if (getViewState().surface !== 'develop' || !getEditState().doc) return
      e.preventDefault()
      cycleSplit(e.shiftKey ? 'v' : 'h')
    }
    addEventListener('keydown', onKey, true)
    return () => removeEventListener('keydown', onKey, true)
  }, [])

  // track the canvas box (the mat is position:relative)
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

  if (!active || !box) return null
  const horiz = splitView === 'h' // vertical divider line, drags along x

  const onDown = (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = true
  }
  const onMove = (e) => {
    if (!drag.current) return
    e.stopPropagation()
    setSplitPos(horiz ? (e.clientX - (box.left + matPad(matRef).x)) / box.w
      : (e.clientY - (box.top + matPad(matRef).y)) / box.h)
  }
  const onUp = (e) => {
    if (!drag.current) return
    e.stopPropagation()
    drag.current = false
  }

  const style = horiz
    ? { left: box.left + splitPos * box.w - 9, top: box.top, height: box.h }
    : { top: box.top + splitPos * box.h - 9, left: box.left, width: box.w }

  return (
    <div
      className={`split-handle split-${splitView}`}
      style={style}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      <span className="split-knob mono" title="Drag the before/after divider">
        {horiz ? '◂▸' : '▴▾'}
      </span>
      <span className="split-tag mono" aria-hidden="true">BEFORE</span>
    </div>
  )
}

// mat-relative pointer math: the handle positions are mat-relative but
// pointer events arrive in client coords — offset by the mat's origin
const matPad = (matRef) => {
  const r = matRef.current?.getBoundingClientRect()
  return { x: r?.left ?? 0, y: r?.top ?? 0 }
}
