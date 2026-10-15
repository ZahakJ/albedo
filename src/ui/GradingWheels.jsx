import { useRef, useEffect, useState } from 'react'
import Slider from './Slider.jsx'
import { useEditState, previewParam, commitParam } from '../state/editStore.js'
import { getParam } from '../engine/editdoc.js'

// 3-way color grading wheels (shadows / midtones / highlights). Each wheel:
// hue ring (data, not chrome — sanctioned like the mixer strips) + saturation
// knob; drag anywhere sets h from the angle and s from the radius,
// double-click resets the zone, the mono value under the wheel scrubs s
// alone. Tabs S | M | H show one large wheel, ALL shows the three small.
// Angle convention: h=0° at 3 o'clock, increasing counter-clockwise on
// screen — matches the shader's cos/sin(h) direction in OKLab a/b.

const ZONES = [
  ['shadows', 'S', 'Shadows'],
  ['midtones', 'M', 'Midtones'],
  ['highlights', 'H', 'Highlights'],
]

const TAU = Math.PI * 2

function paintWheel(canvas, size, h, s) {
  const dpr = Math.min(devicePixelRatio, 2)
  if (canvas.width !== size * dpr) {
    canvas.width = size * dpr
    canvas.height = size * dpr
  }
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, size, size)
  const c = size / 2
  const ringR = c - 5
  // hue ring — 120 arc segments, hsl approximates the OKLab hue direction
  for (let i = 0; i < 120; i++) {
    const a0 = (i / 120) * TAU
    ctx.strokeStyle = `hsl(${(i / 120) * 360} 62% 52%)`
    ctx.lineWidth = 5
    ctx.beginPath()
    ctx.arc(c, c, ringR, -a0 - TAU / 110, -a0 + 0.02, false)
    ctx.stroke()
  }
  // interior well
  const wellR = c - 10
  ctx.fillStyle = '#141414'
  ctx.beginPath()
  ctx.arc(c, c, wellR, 0, TAU)
  ctx.fill()
  ctx.strokeStyle = 'rgba(255,255,255,0.08)'
  ctx.lineWidth = 1
  ctx.stroke()
  // center tick
  ctx.fillStyle = 'rgba(255,255,255,0.22)'
  ctx.fillRect(c - 0.5, c - 3, 1, 6)
  ctx.fillRect(c - 3, c - 0.5, 6, 1)
  // knob: radius = s, angle = h (CCW, y-down canvas → negate sin)
  const kMax = wellR - 6
  const kr = (s / 100) * kMax
  const kx = c + kr * Math.cos((h * Math.PI) / 180)
  const ky = c - kr * Math.sin((h * Math.PI) / 180)
  if (s > 0) {
    ctx.strokeStyle = 'rgba(255,255,255,0.3)'
    ctx.beginPath()
    ctx.moveTo(c, c)
    ctx.lineTo(kx, ky)
    ctx.stroke()
  }
  ctx.beginPath()
  ctx.arc(kx, ky, 4.5, 0, TAU)
  ctx.fillStyle = s > 0 ? `hsl(${h} 62% 58%)` : '#2c2c2c'
  ctx.fill()
  ctx.strokeStyle = '#f0f0f0'
  ctx.lineWidth = 1.4
  ctx.stroke()
}

function Wheel({ zone, title, value, size, disabled, onPreview, onCommit }) {
  const canvasRef = useRef(null)
  const drag = useRef(null)

  useEffect(() => {
    if (!drag.current) paintWheel(canvasRef.current, size, value.h, value.s)
  })

  const fromEvent = (e) => {
    const r = canvasRef.current.getBoundingClientRect()
    const dx = e.clientX - r.left - r.width / 2
    const dy = e.clientY - r.top - r.height / 2
    const kMax = r.width / 2 - 10 - 6
    let h = Math.round((Math.atan2(-dy, dx) * 180) / Math.PI)
    if (h < 0) h += 360
    const s = Math.round(Math.min(100, (Math.hypot(dx, dy) / kMax) * 100))
    return { h, s }
  }

  const move = (e) => {
    const d = drag.current
    if (!d) return
    d.last = fromEvent(e)
    if (!d.raf) {
      d.raf = requestAnimationFrame(() => {
        d.raf = 0
        if (!drag.current) return
        paintWheel(canvasRef.current, size, d.last.h, d.last.s)
        onPreview(d.last)
      })
    }
  }
  const down = (e) => {
    if (disabled || e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { last: fromEvent(e), raf: 0 }
    paintWheel(canvasRef.current, size, drag.current.last.h, drag.current.last.s)
    onPreview(drag.current.last)
  }
  const up = () => {
    const d = drag.current
    if (!d) return
    if (d.raf) cancelAnimationFrame(d.raf)
    drag.current = null
    onCommit(d.last)
  }

  // s-only scrub on the value readout
  const scrub = useRef(null)
  const sDown = (e) => {
    if (disabled || e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    scrub.current = { x0: e.clientX, s0: value.s, last: value }
  }
  const sMove = (e) => {
    const d = scrub.current
    if (!d) return
    const s = Math.round(Math.min(100, Math.max(0, d.s0 + (e.clientX - d.x0) * 0.5)))
    d.last = { h: value.h, s }
    e.currentTarget.textContent = s // React sits out the gesture
    paintWheel(canvasRef.current, size, value.h, s)
    onPreview(d.last)
  }
  const sUp = () => {
    const d = scrub.current
    if (!d) return
    scrub.current = null
    onCommit(d.last)
  }

  return (
    <div className={`gwheel gwheel-${zone}`}>
      <canvas
        ref={canvasRef}
        className="gwheel-canvas"
        style={{ width: size, height: size }}
        role="slider"
        aria-label={`${title} grading`}
        aria-valuetext={`hue ${value.h}, saturation ${value.s}`}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onDoubleClick={() => !disabled && onCommit({ h: 0, s: 0 })}
      />
      <span className="gwheel-name">{title}</span>
      <span
        className={`gwheel-val mono${value.s ? ' is-set' : ''}`}
        title="Drag to adjust saturation, double-click to reset"
        onPointerDown={sDown}
        onPointerMove={sMove}
        onPointerUp={sUp}
        onPointerCancel={sUp}
        onDoubleClick={() => !disabled && onCommit({ h: value.h, s: 0 })}
      >{value.s}</span>
    </div>
  )
}

export default function GradingWheels() {
  const { doc } = useEditState()
  const [tab, setTab] = useState('all')
  const zoneVal = (z) => (doc ? getParam(doc, 'grading', z) : { h: 0, s: 0 })
  const shown = tab === 'all' ? ZONES : ZONES.filter(([z, k]) => k === tab)
  return (
    <div className="grading">
      <div className="seg grade-seg" role="tablist" aria-label="Grading zone">
        <span className="seg-thumb" aria-hidden="true" />
        {[...ZONES.map(([, k, t]) => [k, t]), ['all', 'All zones']].map(([k, t]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            title={t}
            className={`seg-btn${tab === k ? ' is-on' : ''}`}
            onClick={() => setTab(k)}
          >{k === 'all' ? 'ALL' : k}</button>
        ))}
      </div>
      <div className={`gwheels${tab === 'all' ? ' is-all' : ''}`}>
        {shown.map(([zone, , title]) => (
          <Wheel
            key={zone}
            zone={zone}
            title={title}
            size={tab === 'all' ? 82 : 132}
            disabled={!doc}
            value={zoneVal(zone)}
            onPreview={(v) => doc && previewParam('grading', zone, v)}
            onCommit={(v) => doc && commitParam('grading', zone, v)}
          />
        ))}
      </div>
      <Slider
        label="Blending"
        min={0}
        max={100}
        step={1}
        defaultValue={50}
        value={doc ? getParam(doc, 'grading', 'blending') : 50}
        onPreview={(v) => doc && previewParam('grading', 'blending', v)}
        onCommit={(v) => doc && commitParam('grading', 'blending', v)}
      />
      <Slider
        label="Balance"
        min={-100}
        max={100}
        step={1}
        defaultValue={0}
        value={doc ? getParam(doc, 'grading', 'balance') : 0}
        onPreview={(v) => doc && previewParam('grading', 'balance', v)}
        onCommit={(v) => doc && commitParam('grading', 'balance', v)}
      />
    </div>
  )
}
