import { useRef, useState, useEffect } from 'react'

// The slider atom — everything else in the app inherits its feel.
// Full spec: drag anywhere on the row, scrubbable value, Alt=fine Shift=coarse,
// double-click resets, click value to type, zero-detent on bipolar tracks.
// During a drag React is bypassed: fill/thumb/value update via direct style
// writes inside rAF; the store commits once on pointer-up.

export default function Slider({
  label, value, min, max, step = 1, decimals = 0,
  defaultValue = 0, bipolar = min < 0,
  onPreview, onCommit, disabled = false,
}) {
  const rowRef = useRef(null)
  const valRef = useRef(null)
  const drag = useRef(null)
  const [typing, setTyping] = useState(null)

  const fmt = (v) => v.toFixed(decimals)
  const clamp = (v) => Math.min(max, Math.max(min, v))
  const quantize = (v) => Math.round(v / step) * step

  const paint = (v) => {
    const el = rowRef.current
    if (!el || !valRef.current) return // value cell is an input while typing
    const frac = (v - min) / (max - min)
    el.style.setProperty('--fill-from', bipolar ? `${(0 - min) / (max - min) * 100}%` : '0%')
    el.style.setProperty('--fill-to', `${frac * 100}%`)
    el.style.setProperty('--thumb-x', `${frac * 100}%`)
    el.classList.toggle('is-modified', v !== defaultValue)
    valRef.current.textContent = fmt(v)
  }

  useEffect(() => { if (!drag.current) paint(value) })

  const applyPointer = (e) => {
    const d = drag.current
    const fine = e.altKey ? 0.1 : e.shiftKey ? 10 : 1
    let v
    if (d.mode === 'track') {
      const rect = rowRef.current.getBoundingClientRect()
      v = min + ((e.clientX - rect.left) / rect.width) * (max - min)
    } else {
      // scrub: relative, 1px = 1 step at normal speed
      v = d.start + (e.clientX - d.startX) * step * fine
    }
    // zero-detent: bipolar thumbs snap near 0 unless Alt overrides
    if (bipolar && !e.altKey && Math.abs(v) < step * 1.5) v = 0
    v = clamp(quantize(v))
    if (v !== d.last) {
      d.last = v
      if (!d.raf) {
        d.raf = requestAnimationFrame(() => {
          d.raf = 0
          paint(d.last)
          onPreview(d.last)
        })
      }
    }
  }

  const startDrag = (e, mode) => {
    if (e.button !== 0 || typing !== null) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { mode, start: value, startX: e.clientX, last: value, raf: 0 }
    if (mode === 'track') applyPointer(e)
  }
  const moveDrag = (e) => { if (drag.current) applyPointer(e) }
  const endDrag = () => {
    const d = drag.current
    if (!d) return
    if (d.raf) cancelAnimationFrame(d.raf)
    drag.current = null
    if (d.last !== value) onCommit(d.last)
  }

  const onKey = (e) => {
    const stepBy = e.shiftKey ? step * 10 : step
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') onCommit(clamp(quantize(value + stepBy)))
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') onCommit(clamp(quantize(value - stepBy)))
    else return
    e.preventDefault()
  }

  const commitTyped = () => {
    if (typing === null) return
    const t = typing.trim()
    // relative entry: "+15" / "-15" adjusts from current
    const rel = /^[+-]/.test(t) && !/^-?\d+\.?\d*$/.test(t.slice(1)) ? null : t
    let v = parseFloat(rel ?? t)
    if (!Number.isNaN(v)) {
      if (/^[+-]/.test(t) && t !== String(v)) v = value + parseFloat(t)
      onCommit(clamp(quantize(v)))
    }
    setTyping(null)
  }

  return (
    <div
      ref={rowRef}
      className={`slider${bipolar ? ' bipolar' : ''}${disabled ? ' is-disabled' : ''}`}
      aria-disabled={disabled || undefined}
      onPointerDown={(e) => startDrag(e, 'track')}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => onCommit(defaultValue)}
      onKeyDown={onKey}
      tabIndex={0}
      role="slider"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
    >
      <span className="slider-tick" aria-hidden="true" />
      <span className="slider-label">{label}</span>
      {typing !== null ? (
        <input
          className="slider-input mono"
          value={typing}
          autoFocus
          onChange={(e) => setTyping(e.target.value)}
          onBlur={commitTyped}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitTyped()
            else if (e.key === 'Escape') setTyping(null)
            e.stopPropagation()
          }}
          onPointerDown={(e) => e.stopPropagation()}
        />
      ) : (
        <span
          ref={valRef}
          className="slider-value mono"
          onPointerDown={(e) => { e.stopPropagation(); startDrag(e, 'scrub') }}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onClick={(e) => { if (!drag.current) setTyping(fmt(value)) }}
        >{fmt(value)}</span>
      )}
      <span className="slider-track" aria-hidden="true">
        <span className="slider-fill" />
        <span className="slider-thumb" />
      </span>
    </div>
  )
}
