import { useEffect, useRef } from 'react'
import { onScopes } from '../state/renderClient.js'
import { getState, previewParam, commitParam } from '../state/editStore.js'
import { getParam } from '../engine/editdoc.js'
import { useDevFlags, toggleClipOverlay } from './devFlags.js'

// Live RGB histogram. Redraws straight to canvas on every scopes delivery —
// React never re-renders for data. Develop is dark-only, so plot colors are
// literals. Channel color inside the plot is data, not chrome (sanctioned).
// Lightroom region-drag: hovering highlights the tonal region under the
// cursor (blacks/shadows/exposure/highlights/whites); a horizontal drag
// adjusts the matching slider through previewParam/commitParam so the
// gesture coalesces into one undo entry.

const CHANNELS = [
  ['#6e3434', 0],   // r
  ['#37603d', 256], // g
  ['#35506e', 512], // b
]
const LUMA = 'rgba(214,214,214,0.55)'

// x-fraction bands over the luminance axis → slider; span = value change per
// full-histogram-width drag
const REGIONS = [
  { a: 0, b: 0.1, module: 'tone', key: 'blacks', label: 'Blacks', span: 220, min: -100, max: 100 },
  { a: 0.1, b: 0.33, module: 'tone', key: 'shadows', label: 'Shadows', span: 220, min: -100, max: 100 },
  { a: 0.33, b: 0.67, module: 'exposure', key: 'ev', label: 'Exposure', span: 7, min: -5, max: 5, step: 0.05 },
  { a: 0.67, b: 0.9, module: 'tone', key: 'highlights', label: 'Highlights', span: 220, min: -100, max: 100 },
  { a: 0.9, b: 1, module: 'tone', key: 'whites', label: 'Whites', span: 220, min: -100, max: 100 },
]
const regionAt = (frac) => REGIONS.find((r) => frac < r.b) ?? REGIONS[4]
const fmt = (r, v) => (r.step ? v.toFixed(2) : Math.round(v))

export default function Histogram() {
  const canvasRef = useRef(null)
  const shRef = useRef(null)
  const hlRef = useRef(null)
  const zoneRef = useRef(null)
  const labelRef = useRef(null)
  const drag = useRef(null) // { region, start, last, raf }
  const { clipOverlay } = useDevFlags()

  const showZone = (region, value) => {
    const z = zoneRef.current
    const l = labelRef.current
    if (!z || !l) return
    if (!region) {
      z.style.display = 'none'
      l.style.display = 'none'
      return
    }
    z.style.display = 'block'
    z.style.left = `${region.a * 100}%`
    z.style.width = `${(region.b - region.a) * 100}%`
    l.style.display = 'block'
    l.textContent = `${region.label}  ${fmt(region, value)}`
  }

  const valueOf = (region) => {
    const { doc } = getState()
    return doc ? getParam(doc, region.module, region.key) : null
  }
  const frac = (e) => {
    const r = canvasRef.current.getBoundingClientRect()
    return { f: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), w: r.width }
  }

  const onDown = (e) => {
    if (e.button !== 0 || !getState().doc) return
    e.preventDefault()
    const { f } = frac(e)
    const region = regionAt(f)
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { region, x0: e.clientX, start: valueOf(region), last: valueOf(region), raf: 0 }
    showZone(region, drag.current.start)
  }
  const onMove = (e) => {
    const d = drag.current
    if (!d) {
      if (!getState().doc) return
      const { f } = frac(e)
      const region = regionAt(f)
      showZone(region, valueOf(region))
      return
    }
    const { w } = frac(e)
    const r = d.region
    let v = d.start + ((e.clientX - d.x0) / w) * r.span
    v = Math.min(r.max, Math.max(r.min, r.step ? Math.round(v / r.step) * r.step : Math.round(v)))
    if (v === d.last) return
    d.last = v
    if (!d.raf) {
      d.raf = requestAnimationFrame(() => {
        d.raf = 0
        if (!drag.current) return
        showZone(r, d.last)
        previewParam(r.module, r.key, d.last)
      })
    }
  }
  const onUp = () => {
    const d = drag.current
    if (!d) return
    if (d.raf) cancelAnimationFrame(d.raf)
    drag.current = null
    if (d.last !== d.start) commitParam(d.region.module, d.region.key, d.last)
  }
  const onLeave = () => { if (!drag.current) showZone(null) }

  useEffect(() => {
    const canvas = canvasRef.current
    // software raster: tiny surface redrawn every scopes frame; also keeps
    // output visible under ANGLE/swiftshader (headless test) compositing
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    const histRef = { current: null }
    let w = 0, h = 0

    const paint = () => {
      ctx.clearRect(0, 0, w, h)
      const hist = histRef.current
      if (!hist) return
      let max = 1
      for (let c = 0; c < 3; c++)
        for (let i = 1; i < 255; i++) max = Math.max(max, hist[c * 256 + i])
      const top = h - 5 // headroom so peaks don't kiss the border
      const y = (v) => h - Math.sqrt(Math.min(1.4, v / max)) * top
      ctx.globalCompositeOperation = 'screen'
      for (const [color, base] of CHANNELS) {
        ctx.fillStyle = color
        ctx.beginPath()
        ctx.moveTo(-1, h + 1)
        for (let i = 0; i < 256; i++) ctx.lineTo((i / 255) * w, y(hist[base + i]))
        ctx.lineTo(w + 1, h + 1)
        ctx.closePath()
        ctx.fill()
      }
      ctx.globalCompositeOperation = 'source-over'
      ctx.strokeStyle = LUMA
      ctx.lineWidth = 1
      ctx.beginPath()
      for (let i = 0; i < 256; i++) {
        const py = y(hist[768 + i])
        i ? ctx.lineTo((i / 255) * w, py) : ctx.moveTo(0, py)
      }
      ctx.stroke()
    }

    const size = () => {
      const r = canvas.getBoundingClientRect()
      if (!r.width) return
      const dpr = Math.min(devicePixelRatio, 2)
      w = Math.round(r.width)
      h = Math.round(r.height)
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      paint()
    }

    size()
    const ro = new ResizeObserver(size)
    ro.observe(canvas)
    const off = onScopes(({ hist, clipShadows, clipHighlights }) => {
      histRef.current = hist
      paint()
      shRef.current?.classList.toggle('is-lit', clipShadows > 0.001)
      hlRef.current?.classList.toggle('is-lit', clipHighlights > 0.001)
    })
    return () => { ro.disconnect(); off() }
  }, [])

  return (
    <div className="histo">
      <canvas
        ref={canvasRef}
        className="histo-canvas"
        aria-label="Histogram"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onPointerLeave={onLeave}
      />
      <div ref={zoneRef} className="histo-zone" aria-hidden="true" />
      <span ref={labelRef} className="histo-zone-label mono" aria-hidden="true" />
      <button
        ref={shRef}
        type="button"
        className={`clip-toggle clip-sh${clipOverlay ? ' is-on' : ''}`}
        data-tip="Shadow clipping" data-tip-key="J"
        aria-pressed={clipOverlay}
        onClick={toggleClipOverlay}
      >
        <svg width="9" height="9" viewBox="0 0 9 9" aria-hidden="true">
          <path d="M1 1h7L1 8z" fill="currentColor" />
        </svg>
      </button>
      <button
        ref={hlRef}
        type="button"
        className={`clip-toggle clip-hl${clipOverlay ? ' is-on' : ''}`}
        data-tip="Highlight clipping" data-tip-key="J"
        aria-pressed={clipOverlay}
        onClick={toggleClipOverlay}
      >
        <svg width="9" height="9" viewBox="0 0 9 9" aria-hidden="true">
          <path d="M1 1h7v7z" fill="currentColor" />
        </svg>
      </button>
    </div>
  )
}
