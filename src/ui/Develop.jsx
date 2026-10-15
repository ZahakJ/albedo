import { useRef, useEffect, useState, useCallback } from 'react'
import Slider from './Slider.jsx'
import Histogram from './Histogram.jsx'
import CurveEditor from './CurveEditor.jsx'
import Mixer, { getMixerAxis } from './Mixer.jsx'
import GradingWheels from './GradingWheels.jsx'
import PanelSection from './PanelSection.jsx'
import PresetRail from './PresetRail.jsx'
import CropOverlay from './CropOverlay.jsx'
import MaskPanel, { useMaskUi, washIdOf, setMaskMode } from './MaskPanel.jsx'
import MaskOverlay from './MaskOverlay.jsx'
import HealOverlay, { HealSection } from './HealOverlay.jsx'
import SplitView from './SplitView.jsx'
import { useEditState, previewParam, commitParam, setSendFlags, applyModules, getState, resetAll } from '../state/editStore.js'
import { getParam, MODULE_DEFAULTS, BAND_NAMES, wbNeutralize, hasEdits } from '../engine/editdoc.js'
import { toast } from '../state/toastStore.js'
import { geometryOf } from '../engine/geometry.js'
import { buildCurveLut } from '../engine/curve.js'
import { setView, exportPhoto, autoAdjust, samplePoint } from '../state/renderClient.js'
import { openOverlay } from '../state/commands.js'
import { openDevelopedInCanvas } from '../state/canvasClient.js'
import VersionsSection from './VersionsSection.jsx'
import { useLens } from '../state/lensStore.js'
import { useDenoise, ensureDenoised } from '../state/denoiseClient.js'
import { useProfiles, ensureProfileSent, fitsCamera } from '../state/profileStore.js'
import HistorySection from './HistorySection.jsx'
import { useCatalog } from '../state/catalogStore.js'
import { useViewState, getViewState, setZoom, setCropMode, nudgePan } from '../state/viewStore.js'
import { useDevFlags } from './devFlags.js'

const TONE = [
  { module: 'exposure', key: 'ev', label: 'Exposure', min: -5, max: 5, step: 0.05, decimals: 2 },
  { module: 'tone', key: 'contrast', label: 'Contrast' },
  { module: 'tone', key: 'highlights', label: 'Highlights' },
  { module: 'tone', key: 'shadows', label: 'Shadows' },
  { module: 'tone', key: 'whites', label: 'Whites' },
  { module: 'tone', key: 'blacks', label: 'Blacks' },
]
const WB = [
  { module: 'wb', key: 'temp', label: 'Temp' },
  { module: 'wb', key: 'tint', label: 'Tint' },
]
const COLOR = [
  { module: 'vibsat', key: 'vibrance', label: 'Vibrance' },
  { module: 'vibsat', key: 'saturation', label: 'Saturation' },
]
const EFFECTS = [
  { module: 'localcontrast', key: 'clarity', label: 'Clarity' },
  { module: 'localcontrast', key: 'texture', label: 'Texture' },
  { module: 'localcontrast', key: 'dehaze', label: 'Dehaze' },
  { module: 'vignette', key: 'amount', label: 'Vignette' },
  { module: 'vignette', key: 'midpoint', label: 'Midpoint', min: 0 },
  { module: 'vignette', key: 'roundness', label: 'Roundness' },
  { module: 'vignette', key: 'feather', label: 'Feather', min: 0 },
  { module: 'grain', key: 'amount', label: 'Grain', min: 0 },
  { module: 'grain', key: 'size', label: 'Grain Size', min: 0 },
  { module: 'grain', key: 'roughness', label: 'Roughness', min: 0 },
]

// linear sRGB → OKLab hue (deg) + nearest mixer band — CPU twin of the
// shaders' lin_to_oklab, drives the mixer targeted adjustment
const cbrtS = (x) => Math.sign(x) * Math.abs(x) ** (1 / 3)
const BAND_CENTERS = [25, 55, 90, 140, 195, 260, 300, 345]
function bandOfLinear([r, g, b]) {
  const l = cbrtS(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = cbrtS(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = cbrtS(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
  let hue = (Math.atan2(B, A) * 180) / Math.PI
  if (hue < 0) hue += 360
  let best = 0
  let bd = 1e9
  BAND_CENTERS.forEach((c, i) => {
    const d = Math.min(Math.abs(hue - c), 360 - Math.abs(hue - c))
    if (d < bd) { bd = d; best = i }
  })
  return BAND_NAMES[best]
}

const cap = (s) => s[0].toUpperCase() + s.slice(1)

// B&W mix rows — mixer-style hue-strip rows under their own bw-* classes
// (never mix-*: e2e selectors address the mixer's rows uniquely); weights
// apply while the section-header chip is on
function BwRows({ doc }) {
  const mix = doc ? getParam(doc, 'bw', 'mix') : null
  return BAND_NAMES.map((band) => (
    <div className={`bw-row bw-${band}`} key={band}>
      <Slider
        label={cap(band)}
        min={-100}
        max={100}
        step={1}
        defaultValue={0}
        value={mix?.[band] ?? 0}
        onPreview={(v) => doc && previewParam('bw', 'mix', { ...mix, [band]: v })}
        onCommit={(v) => doc && commitParam('bw', 'mix', { ...mix, [band]: v })}
      />
      <span className="mix-hue" aria-hidden="true" />
    </div>
  ))
}
const LENS = [
  { module: 'lens', key: 'distortion', label: 'Distortion' },
  { module: 'lens', key: 'caRed', label: 'CA Red' },
  { module: 'lens', key: 'caBlue', label: 'CA Blue' },
  { module: 'lens', key: 'defringe', label: 'Defringe', min: 0 },
]
const DETAIL = [
  { module: 'detail', key: 'sharpenAmount', label: 'Sharpen', min: 0, max: 150 },
  { module: 'detail', key: 'sharpenRadius', label: 'Radius', min: 0.5, max: 3, step: 0.1, decimals: 1 },
  { module: 'detail', key: 'sharpenMasking', label: 'Masking', min: 0 },
  { module: 'detail', key: 'lumaNR', label: 'NR Luma', min: 0 },
  { module: 'detail', key: 'chromaNR', label: 'NR Chroma', min: 0 },
]

// LENS profile — the lensfun calibration matched from EXIF, on by default for
// RAW; its two amounts scale distortion and vignetting (100 = as measured)
function LensProfileRows({ doc, photo }) {
  const lens = useLens(photo?.id)
  if (!photo?.isRaw) return null
  const on = !!getParam(doc, 'lens', 'profile')
  const live = !!lens && on
  const amount = (key, label) => (
    <Slider
      label={label} min={0} max={200} step={1}
      defaultValue={MODULE_DEFAULTS.lens[key]}
      value={getParam(doc, 'lens', key)}
      disabled={!live}
      onPreview={(v) => doc && previewParam('lens', key, v)}
      onCommit={(v) => doc && commitParam('lens', key, v)}
    />
  )
  return (
    <>
      <div className="lens-profile">
        <button
          type="button" className={`bw-chip${on ? ' is-on' : ''}`} aria-pressed={on}
          data-tip="Lens profile corrections"
          onClick={() => doc && commitParam('lens', 'profile', on ? 0 : 1)}
        >PROFILE</button>
        <span className="lens-name" title={lens ? `${lens.maker} ${lens.name}` : ''}>
          {lens ? lens.name : 'No profile for this lens'}
        </span>
      </div>
      {amount('profDistortion', 'Profile Dist.')}
      {amount('profVignette', 'Profile Vign.')}
    </>
  )
}

// PROFILE — the display transform. RAW defaults to AgX; JPEG and PNG to
// linear (they are display-referred already). Choosing AgX on one of those
// starts from no baseline lift, which also keeps the choice stored: a look
// equal to the RAW defaults would read as "absent" and fall back to linear.
const PROFILES = [['agx', 'AgX'], ['linear', 'Linear']]
function ProfileRows({ doc, isRaw, camera }) {
  const { profiles } = useProfiles()
  const stored = doc?.modules?.look
  const look = stored ?? (isRaw ? MODULE_DEFAULTS.look : { ...MODULE_DEFAULTS.look, profile: 'linear' })
  const agx = look.profile === 'agx' || look.profile?.startsWith('dcp:')
  // camera profiles: the ones made for this camera, else every imported one
  const mine = profiles.filter((p) => fitsCamera(p, camera))
  const dcps = isRaw ? (mine.length ? mine : profiles) : []
  const pickDcp = (id) => {
    if (!doc) return
    if (!id) { applyModules({ look: { ...look, profile: 'agx' } }); return }
    const next = { ...look, profile: `dcp:${id}` }
    ensureProfileSent(next)
    applyModules({ look: next })
  }
  const pick = (profile) => {
    if (!doc || profile === look.profile) return
    applyModules({ look: profile === 'agx' && !isRaw
      ? { ...MODULE_DEFAULTS.look, baseline: 0 }
      : { ...look, profile } })
  }
  const slider = (key, label, min, max, step, decimals) => (
    <Slider
      label={label} min={min} max={max} step={step} decimals={decimals}
      defaultValue={MODULE_DEFAULTS.look[key]}
      value={look[key]}
      disabled={!agx}
      onPreview={(v) => doc && agx && previewParam('look', key, v)}
      onCommit={(v) => doc && agx && commitParam('look', key, v)}
    />
  )
  return (
    <>
      <div className="exp-seg profile-seg" role="radiogroup" aria-label="Profile">
        {PROFILES.map(([id, name]) => (
          <button
            key={id} type="button" role="radio" aria-checked={look.profile === id}
            className={look.profile === id ? 'is-on' : ''}
            onClick={() => pick(id)}
          >{name}</button>
        ))}
      </div>
      {dcps.length > 0 && (
        <select
          className="sort-select profile-dcp" aria-label="Camera profile"
          value={look.profile?.startsWith('dcp:') ? look.profile.slice(4) : ''}
          onChange={(e) => pickDcp(e.target.value)}
        >
          <option value="">Camera profile…</option>
          {dcps.map((p) => <option key={p.id} value={p.id}>{p.name}{mine.length ? '' : ` (${p.camera})`}</option>)}
        </select>
      )}
      {slider('baseline', 'Baseline', -2, 2, 0.05, 2)}
      {slider('saturation', 'Look Sat.', 0, 200, 1, 0)}
    </>
  )
}

const Rows = ({ rows, doc }) => rows.map((r) => (
  <Slider
    key={`${r.module}.${r.key}`}
    label={r.label}
    min={r.min ?? -100}
    max={r.max ?? 100}
    step={r.step ?? 1}
    decimals={r.decimals ?? 0}
    defaultValue={MODULE_DEFAULTS[r.module][r.key]}
    value={doc ? getParam(doc, r.module, r.key) : 0}
    onPreview={(v) => doc && previewParam(r.module, r.key, v)}
    onCommit={(v) => doc && commitParam(r.module, r.key, v)}
  />
))

// DETAIL rows — same Slider atom, plus two behaviors the generic Rows lack:
// Alt-drag on Masking streams { maskPreview } so the finish pass shows the
// mask weight as grayscale, and the first drag at fit zoom surfaces a
// one-line "judge at 1:1" hint (once per session — sharpen/NR calls need
// real pixels).
let detailHintShown = false
// AI denoise: the first move above 0 starts the model on this photo; the
// slider then only blends. Bayer RAW only.
function AiDenoiseRow({ doc, photo }) {
  const dn = useDenoise()
  if (!photo?.isRaw) return null
  const mine = dn.photoId === photo.id
  const status = !mine ? null
    : dn.status === 'running' ? `denoising${dn.total ? ` ${Math.round((100 * dn.done) / dn.total)}%` : '…'}`
    : dn.status === 'unsupported' ? 'not for this sensor (X-Trans, Foveon)'
    : dn.status === 'error' ? dn.error : null
  const go = (v) => { if (v > 0) ensureDenoised(photo) }
  return (
    <>
      <Slider
        label="AI Denoise" min={0} max={100} step={1}
        defaultValue={0}
        value={doc ? getParam(doc, 'detail', 'aiDenoise') : 0}
        onPreview={(v) => { go(v); doc && previewParam('detail', 'aiDenoise', v) }}
        onCommit={(v) => { go(v); doc && commitParam('detail', 'aiDenoise', v) }}
      />
      {status && <p className="detail-hint mono">{status}</p>}
    </>
  )
}

function DetailRows({ doc, photo }) {
  const [hint, setHint] = useState(false)
  const masking = useRef(false)
  const maskOff = () => {
    if (masking.current) { masking.current = false; setSendFlags({ maskPreview: false }) }
  }
  const onDown = (key) => (e) => {
    if (!detailHintShown && getViewState().zoom === 'fit') { detailHintShown = true; setHint(true) }
    if (key === 'sharpenMasking' && e.altKey && doc) {
      masking.current = true
      setSendFlags({ maskPreview: true })
    }
  }
  return (
    <>
      <AiDenoiseRow doc={doc} photo={photo} />
      {DETAIL.map((r) => (
        <div
          key={r.key}
          onPointerDownCapture={onDown(r.key)}
          onPointerUpCapture={maskOff}
          onPointerCancelCapture={maskOff}
        >
          <Rows rows={[r]} doc={doc} />
        </div>
      ))}
      {hint && <p className="detail-hint">judge at 1:1 — press Z</p>}
    </>
  )
}

// camera · lens · ISO · shutter · ƒ · focal, skipping whatever's missing
function exifLine(p) {
  if (!p) return ''
  const parts = []
  if (p.camera) parts.push(p.camera)
  if (p.lens) parts.push(p.lens)
  if (p.iso) parts.push(`ISO ${p.iso}`)
  if (p.shutter) parts.push(p.shutter >= 1 ? `${+p.shutter.toFixed(1)}s` : `1/${Math.round(1 / p.shutter)}`)
  if (p.aperture) parts.push(`ƒ/${+p.aperture.toFixed(1)}`)
  if (p.focal) parts.push(`${Math.round(p.focal)}mm`)
  return parts.join(' · ')
}

export default function Develop({ canvasRef }) {
  const { photo, doc } = useEditState()
  const { photos } = useCatalog()
  const { before } = useDevFlags()
  const { zoom, panX, panY, cropMode, cropGrid, infoOverlay } = useViewState()
  const mu = useMaskUi()
  const maskMode = mu.on && !!photo && !!doc && !cropMode
  const matRef = useRef(null)
  const [space, setSpace] = useState(false) // Space held = pan hand at loupe
  const geometry = doc?.modules?.geometry ?? null
  const lens = doc?.modules?.lens ?? null // distortion participates in the fit
  const exifOnly = exifLine(photos.find((p) => p.id === photo?.id))
  const exif = exifOnly || (photo ? `${photo.width} × ${photo.height} px` : '')

  // Canvas control lives in the render worker; main thread only computes the
  // display size (crop aspect at fit, viewport at loupe) and CSS-sizes the
  // element to match. Crop mode shows the full raw frame.
  // Zoom fit↔loupe FLIP: the ELEMENT's CSS transform animates old→new box
  // (160ms, transform-only) while the worker re-renders underneath; pan,
  // resize and photo swaps never animate, reduced-motion skips entirely.
  const flip = useRef({ zoom: 'fit', photoId: null, anim: null })
  const fit = useCallback(() => {
    if (!photo || !matRef.current) return
    const mat = matRef.current.getBoundingClientRect()
    const dpr = Math.min(devicePixelRatio, 2)
    const g = geometryOf(cropMode ? null : geometry, photo.width, photo.height, lens)
    const canvas = canvasRef.current
    const prevBox = canvas.getBoundingClientRect()
    if (zoom === 'fit' || cropMode) {
      const pad = 24
      const scale = Math.min((mat.width - pad * 2) / g.outW, (mat.height - pad * 2) / g.outH, 1)
      const w = Math.max(1, Math.round(g.outW * scale))
      const h = Math.max(1, Math.round(g.outH * scale))
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      setView(Math.round(w * dpr), Math.round(h * dpr))
    } else {
      // loupe: the canvas IS the viewport — device pixels map 1:1 (or 2:1)
      // onto developed-output pixels and the worker renders only this window
      const w = Math.max(1, Math.min(Math.round(mat.width * dpr), Math.round(g.outW * zoom)))
      const h = Math.max(1, Math.min(Math.round(mat.height * dpr), Math.round(g.outH * zoom)))
      canvas.style.width = `${w / dpr}px`
      canvas.style.height = `${h / dpr}px`
      setView(w, h, { zoom, panX, panY })
    }
    const f = flip.current
    const zoomChanged = f.zoom !== zoom && f.photoId === photo.id && !cropMode
    f.zoom = zoom
    f.photoId = photo.id
    if (zoomChanged && prevBox.width > 1 &&
        !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const next = canvas.getBoundingClientRect()
      const sx = prevBox.width / next.width
      const sy = prevBox.height / next.height
      const dx = (prevBox.left + prevBox.width / 2) - (next.left + next.width / 2)
      const dy = (prevBox.top + prevBox.height / 2) - (next.top + next.height / 2)
      f.anim?.cancel()
      f.anim = canvas.animate(
        [{ transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` }, { transform: 'none' }],
        { duration: 160, easing: 'cubic-bezier(.2,.8,.2,1)' },
      )
    }
  }, [photo, geometry, lens, zoom, panX, panY, cropMode, canvasRef])

  useEffect(() => {
    fit()
    const obs = new ResizeObserver(fit)
    if (matRef.current) obs.observe(matRef.current)
    return () => obs.disconnect()
  }, [fit])

  // photo swap: stale loupe/crop/mask state never spans photos
  useEffect(() => { setZoom('fit'); setCropMode(false); setMaskMode(false) }, [photo?.id])

  // ── armed pointer tools: WB eyedropper + targeted adjustment (curve/mixer)
  // Canvas events are handled ONLY while armed, in the capture phase with
  // stopPropagation — loupe click-zoom, CropOverlay and MaskOverlay keep
  // their pointer language otherwise. Esc (or re-clicking the button) disarms.
  const [tool, setTool] = useState(null) // 'wb' | 'curve' | 'mixer' | null
  const tat = useRef(null)
  useEffect(() => { setTool(null) }, [photo?.id])
  useEffect(() => {
    if (!tool) return
    const esc = (e) => { if (e.key === 'Escape') setTool(null) }
    addEventListener('keydown', esc, true)
    return () => removeEventListener('keydown', esc, true)
  }, [tool])

  const canvasUV = (e) => {
    const r = canvasRef.current?.getBoundingClientRect()
    if (!r?.width) return null
    const x = (e.clientX - r.left) / r.width
    const y = (e.clientY - r.top) / r.height
    return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null
  }

  const onCapDown = (e) => {
    // pointer math trusts getBoundingClientRect — land any in-flight zoom FLIP
    try { flip.current.anim?.finish() } catch { /* already done */ }
    if (!tool || !photo || !doc || cropMode || maskMode || e.button !== 0) return
    const uv = canvasUV(e)
    if (!uv) return
    e.stopPropagation()
    e.preventDefault()
    if (tool === 'wb') {
      // pre-develop linear patch → invert the shader's WB model, one entry
      samplePoint(photo.id, uv.x, uv.y).then(({ linear }) => {
        applyModules({ wb: wbNeutralize(linear) })
        setTool(null)
      }).catch(() => {})
      return
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    const sess = { tool, y0: e.clientY, dy: 0, ready: false, up: false }
    tat.current = sess
    samplePoint(photo.id, uv.x, uv.y).then((res) => {
      if (tat.current !== sess && !sess.up) return // superseded mid-flight
      const d = getState().doc
      if (!d) return
      if (sess.tool === 'curve') {
        // add/move a point at the pre-curve display luminance under the cursor
        const pts = getParam(d, 'curve', 'points').map((p) => [...p])
        const lx = Math.min(0.99, Math.max(0.01,
          0.2126 * res.display[0] + 0.7152 * res.display[1] + 0.0722 * res.display[2]))
        let idx = -1
        for (let i = 1; i < pts.length - 1; i++) {
          if (Math.abs(pts[i][0] - lx) <= 0.03) { idx = i; break }
        }
        if (idx < 0) {
          const lut = buildCurveLut(pts)
          const at = pts.findIndex((p) => p[0] > lx)
          if (at <= 0) return
          const gx = Math.min(pts[at][0] - 0.01, Math.max(pts[at - 1][0] + 0.01, lx))
          pts.splice(at, 0, [gx, lut[Math.round(gx * 511)]])
          idx = at
        }
        const baseY = pts[idx][1]
        sess.apply = (commit) => {
          pts[idx][1] = Math.min(1, Math.max(0, baseY - sess.dy / 220))
          const out = pts.map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000])
          ;(commit ? commitParam : previewParam)('curve', 'points', out)
        }
      } else {
        // mixer: hue band under the cursor × the mixer's active axis tab
        const axis = getMixerAxis()
        const band = bandOfLinear(res.linear)
        const cur = getParam(d, 'colormix', band)
        sess.apply = (commit) => {
          const v = Math.round(Math.min(100, Math.max(-100, cur[axis] - sess.dy * 0.5)))
          ;(commit ? commitParam : previewParam)('colormix', band, { ...cur, [axis]: v })
        }
      }
      sess.ready = true
      sess.apply(sess.up) // pointer already up = click: commit immediately
    }).catch(() => {})
  }
  const onCapMove = (e) => {
    const sess = tat.current
    if (!sess) return
    e.stopPropagation()
    sess.dy = e.clientY - sess.y0
    if (sess.ready) sess.apply(false)
  }
  const onCapUp = (e) => {
    const sess = tat.current
    if (!sess) return
    e.stopPropagation()
    tat.current = null
    sess.up = true
    sess.dy = e.clientY - sess.y0
    if (sess.ready) sess.apply(true)
  }

  const auto = (kind) =>
    autoAdjust(photo.id, kind).then((r) => applyModules(r.modules)).catch(() => {})

  // Space = pan hand while the loupe is up (develop surface only)
  useEffect(() => {
    if (zoom === 'fit' || cropMode) { setSpace(false); return }
    const down = (e) => {
      if (e.code !== 'Space' || getViewState().surface !== 'develop') return
      const t = e.target
      if (t instanceof Element && (t.closest('input, textarea, select') || t.isContentEditable)) return
      e.preventDefault()
      setSpace(true)
    }
    const up = (e) => { if (e.code === 'Space') setSpace(false) }
    addEventListener('keydown', down)
    addEventListener('keyup', up)
    return () => { removeEventListener('keydown', down); removeEventListener('keyup', up) }
  }, [zoom, cropMode])

  // wheel pans the loupe — native listener: React's root wheel is passive
  useEffect(() => {
    const mat = matRef.current
    if (!mat) return
    const onWheel = (e) => {
      const v = getViewState()
      if (v.zoom === 'fit' || v.cropMode || !photo) return
      e.preventDefault()
      const dpr = Math.min(devicePixelRatio, 2)
      const g = geometryOf(geometry, photo.width, photo.height, lens)
      nudgePan((e.deltaX * dpr) / (v.zoom * g.outW), (e.deltaY * dpr) / (v.zoom * g.outH))
    }
    mat.addEventListener('wheel', onWheel, { passive: false })
    return () => mat.removeEventListener('wheel', onWheel)
  }, [photo, geometry, lens])

  // click toggles fit ↔ 1:1 at the cursor point; a drag (space-pan) is not a
  // click. Pan deltas go straight to the store; fit() re-sends the view.
  const drag = useRef(null)
  const onPointerDown = (e) => {
    if (cropMode || maskMode || !photo) return
    drag.current = { x: e.clientX, y: e.clientY, moved: false, pan: space && zoom !== 'fit' }
    if (drag.current.pan) e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e) => {
    const d = drag.current
    if (!d) return
    if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 3) d.moved = true
    if (d.pan && d.moved) {
      const dpr = Math.min(devicePixelRatio, 2)
      const g = geometryOf(geometry, photo.width, photo.height, lens)
      nudgePan((-e.movementX * dpr) / (zoom * g.outW), (-e.movementY * dpr) / (zoom * g.outH))
    }
  }
  const onPointerUp = (e) => {
    const d = drag.current
    drag.current = null
    if (!d || d.moved || cropMode || !photo) return
    if (zoom !== 'fit') { setZoom('fit'); return }
    const r = canvasRef.current.getBoundingClientRect()
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return
    setZoom(1, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height)
  }

  // one-click export at defaults (q92, full res) — the dialog owns everything else
  // No confirm: the reset is one history entry, and the toast says so.
  const resetToOriginal = () => {
    if (!doc || !hasEdits(doc)) return
    resetAll()
    toast('Reset to original — ⌘Z to undo')
  }

  const quickExport = async () => {
    const { blob } = await exportPhoto(photo.id, doc, { type: 'image/jpeg', quality: 0.92 })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = photo.name.replace(/\.[^.]+$/, '') + '-albedo.jpg'
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const cursor = cropMode || maskMode || !photo ? '' : tool ? 'pick'
    : space && zoom !== 'fit' ? 'grab'
    : zoom !== 'fit' ? 'zoom-out' : 'zoom-in'

  const bwOn = doc ? !!getParam(doc, 'bw', 'on') : false

  return (
    <div
      className={`develop${cropMode ? ' is-cropping' : ''}${maskMode ? ' is-masking' : ''}`}
      data-wash={maskMode && washIdOf(mu) != null ? '1' : undefined}
    >
      <PresetRail />
      <div
        className="canvas-mat"
        ref={matRef}
        data-cursor={cursor}
        onPointerDownCapture={onCapDown}
        onPointerMoveCapture={onCapMove}
        onPointerUpCapture={onCapUp}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <canvas ref={canvasRef} className="develop-canvas on-image" />
        {!photo && (
          <div className="dev-empty" aria-hidden="true">
            <p className="dev-empty-hero">No photo open</p>
            <p className="dev-empty-sub">Press G for the Library, then D on a photo</p>
          </div>
        )}
        {before && photo && <span className="before-tag on-image mono">BEFORE</span>}
        {photo && infoOverlay > 0 && (
          <div className={`info-card on-image mono${before ? ' is-below' : ''}`}>
            <span className="info-name">{photo.name}</span>
            <span className="info-dims">{photo.width} × {photo.height} px</span>
            {infoOverlay === 2 && exifOnly && <span className="info-exif">{exifOnly}</span>}
          </div>
        )}
        {cropMode && photo && doc && (
          <CropOverlay photo={photo} doc={doc} canvasRef={canvasRef} matRef={matRef} grid={cropGrid} />
        )}
        {maskMode && (
          <MaskOverlay photo={photo} doc={doc} canvasRef={canvasRef} matRef={matRef} />
        )}
        {/* heal + split own their keys (H / Y) via capture listeners inside */}
        {photo && doc && (
          <HealOverlay photo={photo} doc={doc} canvasRef={canvasRef} matRef={matRef} />
        )}
        {photo && doc && (
          <SplitView photo={photo} canvasRef={canvasRef} matRef={matRef} />
        )}
      </div>
      <aside className="panel panel-right">
        <div className="histo-block">
          <Histogram />
          <p className="exif-strip mono" title={exif}>{exif || ' '}</p>
        </div>
        {maskMode ? <MaskPanel /> : (
          <>
            <PanelSection id="profile" resets={['look']} title="PROFILE">
              <ProfileRows doc={doc} isRaw={!!photo?.isRaw}
                camera={photos.find((p) => p.id === photo?.id)?.camera} />
            </PanelSection>
            <PanelSection
              id="tone" resets={['exposure','tone']}
              title="TONE"
              action={photo && doc && (
                <button type="button" className="sec-btn" data-tip="Auto tone" onClick={() => auto('tone')}>AUTO</button>
              )}
            ><Rows rows={TONE} doc={doc} /></PanelSection>
            <PanelSection
              id="wb" resets={['wb']}
              title="WB"
              action={photo && doc && (
                <>
                  <button type="button" className="sec-btn" data-tip="Auto white balance" onClick={() => auto('wb')}>AUTO</button>
                  <button
                    type="button"
                    className={`sec-btn sec-icon wb-pick${tool === 'wb' ? ' is-on' : ''}`}
                    data-tip="WB eyedropper — click a neutral patch" data-tip-key="Esc cancels"
                    aria-pressed={tool === 'wb'}
                    onClick={() => setTool(tool === 'wb' ? null : 'wb')}
                  >
                    <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
                      <path d="M8.8 0.9l2.3 2.3-1.4 1.4.7.7-1.1 1.1-.7-.7-4.3 4.3-2.6.9-.9-.9.9-2.6 4.3-4.3-.7-.7 1.1-1.1.7.7z" fill="currentColor" />
                    </svg>
                  </button>
                </>
              )}
            ><Rows rows={WB} doc={doc} /></PanelSection>
            <PanelSection
              id="curve" resets={['curve']}
              title="CURVE"
              action={photo && doc && (
                <button
                  type="button"
                  className={`sec-btn sec-icon tat-btn tat-curve${tool === 'curve' ? ' is-on' : ''}`}
                  data-tip="Targeted adjustment — drag on the image" data-tip-key="Esc cancels"
                  aria-pressed={tool === 'curve'}
                  onClick={() => setTool(tool === 'curve' ? null : 'curve')}
                >
                  <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
                    <circle cx="6" cy="6" r="2.2" fill="none" stroke="currentColor" />
                    <path d="M6 0v2.4M6 9.6V12M0 6h2.4M9.6 6H12" stroke="currentColor" />
                  </svg>
                </button>
              )}
            ><CurveEditor /></PanelSection>
            <PanelSection id="color" resets={['vibsat']} title="COLOR"><Rows rows={COLOR} doc={doc} /></PanelSection>
            <PanelSection
              id="bw" resets={['bw']}
              title="B&W"
              action={photo && doc && (
                <button
                  type="button"
                  className={`bw-chip${bwOn ? ' is-on' : ''}`}
                  data-tip="Toggle black & white" data-tip-key="V"
                  aria-pressed={bwOn}
                  onClick={() => commitParam('bw', 'on', bwOn ? 0 : 1)}
                >{bwOn ? 'ON' : 'OFF'}</button>
              )}
            ><BwRows doc={doc} /></PanelSection>
            <PanelSection
              id="mixer" resets={['colormix']}
              title="MIXER"
              action={photo && doc && (
                <button
                  type="button"
                  className={`sec-btn sec-icon tat-btn tat-mixer${tool === 'mixer' ? ' is-on' : ''}`}
                  data-tip="Targeted adjustment — edits the active tab" data-tip-key="Esc cancels"
                  aria-pressed={tool === 'mixer'}
                  onClick={() => setTool(tool === 'mixer' ? null : 'mixer')}
                >
                  <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
                    <circle cx="6" cy="6" r="2.2" fill="none" stroke="currentColor" />
                    <path d="M6 0v2.4M6 9.6V12M0 6h2.4M9.6 6H12" stroke="currentColor" />
                  </svg>
                </button>
              )}
            ><Mixer /></PanelSection>
            <PanelSection id="grading" resets={['grading']} title="GRADING"><GradingWheels /></PanelSection>
            <PanelSection id="effects" resets={['localcontrast','vignette','grain']} title="EFFECTS"><Rows rows={EFFECTS} doc={doc} /></PanelSection>
            <PanelSection
              id="lens" resets={['lens']}
              title="LENS"
              action={photo && doc && (
                <button
                  type="button"
                  className={`bw-chip recon-chip${getParam(doc, 'recon', 'on') ? ' is-on' : ''}`}
                  data-tip="Highlight reconstruction (RAW)"
                  aria-pressed={!!getParam(doc, 'recon', 'on')}
                  onClick={() => commitParam('recon', 'on', getParam(doc, 'recon', 'on') ? 0 : 1)}
                >HL</button>
              )}
            ><LensProfileRows doc={doc} photo={photo} /><Rows rows={LENS} doc={doc} /></PanelSection>
            <PanelSection id="detail" resets={['detail']} title="DETAIL"><DetailRows doc={doc} photo={photo} /></PanelSection>
            <PanelSection id="heal" resets={['heal', 'remove']} title="REMOVE &amp; HEAL"><HealSection doc={doc} /></PanelSection>
            <PanelSection id="versions" title="VERSIONS">
              <VersionsSection photo={photo} doc={doc} />
            </PanelSection>
            <HistorySection />
            <section className="panel-section panel-export">
              <button
                className="btn-quick btn-reset"
                onClick={resetToOriginal}
                disabled={!photo || !doc || !hasEdits(doc)}
                data-tip="Discard every edit on this photo" data-tip-key="⇧⌘R"
              >
                Reset to original
              </button>
              <button
                className="btn-primary"
                onClick={() => openOverlay('export')}
                disabled={!photo}
              >Export…</button>
              <button className="btn-quick" onClick={quickExport} disabled={!photo}>
                Quick export JPEG
              </button>
              <button
                className="btn-quick edit-in-canvas"
                onClick={() => openDevelopedInCanvas().catch((err) => console.error('[canvas]', err))}
                disabled={!photo || !doc}
              >
                Edit in Canvas
              </button>
            </section>
          </>
        )}
      </aside>
    </div>
  )
}
