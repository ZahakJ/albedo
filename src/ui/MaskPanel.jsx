import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import Slider from './Slider.jsx'
import {
  useEditState, getState as getEditState, setSendFlags,
  previewMaskParam, commitMaskParam, commitMasks, commitMaskGeom, previewMasks,
} from '../state/editStore.js'
import { MASK_ADJUST_DEFAULTS, newMask } from '../engine/editdoc.js'
import { setZoom } from '../state/viewStore.js'
import { segmentMask, samMask, texChannels, maskToPngBlob } from '../state/segmentClient.js'
import { loadThumbBlob, loadPreviewBlob, loadOriginal, saveMaskBlob } from '../state/catalogStore.js'
import { sendMaskTex, samplePoint } from '../state/renderClient.js'

// Mask mode (M). This module owns BOTH the right-panel mask UI and the tiny
// mask-mode store (editStore pattern) that App's keyboard router and the
// canvas overlay share. Wash rule: the red weight overlay shows while
// creating/dragging geometry or hovering a mask row, pins with O, and hides
// the moment an adjust slider is touched.

let ui = {
  on: false,
  selectedId: null,
  tool: null, // 'linear' | 'radial' (armed creation) | 'brush' (paint) | null
  brushSize: 0.06, // stamp diameter, source-width fraction
  washPinned: false,
  hoverId: null,
  dragging: false, // geometry create/edit/paint gesture in flight
  aiBusy: false, // segmentation in flight ('finding subject…' row)
  aiError: null, // quiet row message, never a dialog
}
const listeners = new Set()
const emit = () => { for (const fn of listeners) fn() }
const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn) }
export const useMaskUi = () => useSyncExternalStore(subscribe, () => ui)
export const getMaskUi = () => ui

// which mask id the wash previews right now (null = off)
export const washIdOf = (u = ui) =>
  u.dragging ? u.selectedId : u.hoverId ?? (u.washPinned ? u.selectedId : null)

// the engine hears wash changes through the persistent send flags
const syncWash = () => {
  const id = ui.on ? washIdOf() : null
  const idx = id != null
    ? (getEditState().doc?.masks ?? []).findIndex((m) => m.id === id)
    : -1
  setSendFlags({ maskOverlay: idx })
}

function set(patch) {
  ui = { ...ui, ...patch }
  syncWash()
  emit()
}

export function setMaskMode(on) {
  if (on === !!ui.on) return
  if (on) setZoom('fit') // gizmo math is fit-only, like crop mode
  set(on
    ? { on: true }
    : { on: false, tool: null, selectedId: null, hoverId: null, dragging: false, washPinned: false })
}
export function toggleMaskMode() {
  if (!ui.on && !getEditState().doc) return
  setMaskMode(!ui.on)
}

export const selectMask = (id) => {
  const m = (getEditState().doc?.masks ?? []).find((q) => q.id === id)
  set({ selectedId: id, tool: m?.kind === 'brush' ? 'brush' : null })
}
export const setTool = (tool) => set({ tool })
export const setHoverMask = (id) => set({ hoverId: id })
export const setMaskDragging = (dragging) => set({ dragging })
export const toggleWashPin = () => set({ washPinned: !ui.washPinned })
// the design's key rule: touching an adjust slider hides the wash instantly
export const killWash = () => set({ washPinned: false, hoverId: null, dragging: false })
export const bumpBrushSize = (dir) =>
  set({ brushSize: Math.min(0.5, Math.max(0.005, ui.brushSize * (dir > 0 ? 1.25 : 0.8))) })

const AI_NAMES = { subject: 'Subject', sky: 'Sky', background: 'Background', object: 'Object' }
export const nextMaskName = (masks, kind, model) => {
  const base = kind === 'linear' ? 'Linear' : kind === 'radial' ? 'Radial'
    : kind === 'ai' ? AI_NAMES[model] ?? 'Subject' : 'Brush'
  return `${base} ${masks.filter((m) => m.kind === kind && (kind !== 'ai' || m.model === model)).length + 1}`
}

// K: a brush mask exists before the first stroke streams (worker replays
// brushTex from the doc, so the mask row must be committed up front)
export function addBrushMask() {
  const doc = getEditState().doc
  if (!doc) return
  const masks = doc.masks ?? []
  if (ui.tool === 'brush' && masks.some((m) => m.id === ui.selectedId && m.kind === 'brush')) return
  // channel budget is shared with 'ai' masks
  if (masks.filter((m) => m.kind === 'brush' || m.kind === 'ai').length >= 4) {
    // channel budget: re-arm painting on the last brush mask instead
    const last = [...masks].reverse().find((m) => m.kind === 'brush')
    if (last) set({ selectedId: last.id, tool: 'brush' })
    else set({ aiError: 'mask channel budget (4) reached — delete an AI mask first' })
    return
  }
  const m = newMask('brush', { strokes: [] }, nextMaskName(masks, 'brush'))
  commitMasks([...masks, m])
  set({ selectedId: m.id, tool: 'brush' })
}

// AI masks: subject, sky, background (the inverted subject) and object
// (a click or box, MobileSAM). The worker sees the photo's preview, assumed
// in the decoded source's orientation (RAW: the embedded preview); weights
// come back at quarter resolution, go to the brush texture (MASKTEX) and to
// OPFS for reload replay. points/box are kept on object masks so a reload
// or a later click can rebuild them.
const previewOf = async (photo) =>
  (await loadPreviewBlob(photo.id).catch(() => null)) ??
  (await loadThumbBlob(photo.id).catch(() => null)) ??
  (await loadOriginal(photo.id).then(({ buffer }) => new Blob([buffer])))

async function runAiMask(model, make, extra = {}) {
  const { doc, photo } = getEditState()
  if (!doc || !photo || ui.aiBusy) return
  if (texChannels(doc.masks ?? []).size >= 4) {
    set({ aiError: 'mask channel budget (4) reached — delete a brush/AI mask first' })
    return
  }
  set({ aiBusy: model, aiError: null })
  try {
    const qw = Math.max(1, Math.round(photo.width / 4)) // brushTex dims
    const qh = Math.max(1, Math.round(photo.height / 4))
    const { mask } = await make(photo, await previewOf(photo), qw, qh)
    // doc may have changed while segmenting — recheck against the live doc
    const cur = getEditState().doc
    if (!cur || getEditState().photo?.id !== photo.id) return
    const curMasks = cur.masks ?? []
    const channel = texChannels(curMasks).size
    if (channel >= 4) { set({ aiError: 'mask channel budget (4) reached' }); return }
    const m = {
      ...newMask('ai', { refine: 0 }, nextMaskName(curMasks, 'ai', model)),
      model, channel, invert: model === 'background', ...extra,
    }
    // blob saved BEFORE the transfer detaches mask's buffer
    await saveMaskBlob(photo.id, m.id, await maskToPngBlob(mask, qw, qh))
      .catch((err) => console.error('[ai mask] save', err))
    commitMasks([...curMasks, m])
    sendMaskTex(photo.id, { maskId: m.id, channel, width: qw, height: qh, data: mask })
    // wash pinned so the found area shows; first adjust touch hides it
    set({ selectedId: m.id, tool: null, washPinned: true })
  } catch (err) {
    set({ aiError: String(err?.message ?? err) })
  } finally {
    set({ aiBusy: false })
  }
}

export const addAiMask = (model) => runAiMask(model, (photo, blob, qw, qh) =>
  segmentMask(photo.id, model === 'background' ? 'subject' : model, blob, qw, qh))
export const addSubjectMask = () => addAiMask('subject')

// object tool: a click (point) or a drag (box) in source-normalised coords
export const addObjectMask = (points, box) => runAiMask('object',
  (photo, blob, qw, qh) => samMask(photo.id, blob, points, box, qw, qh), { points, box })

export function deleteSelectedMask() {
  const doc = getEditState().doc
  if (!doc || ui.selectedId == null) return
  commitMasks((doc.masks ?? []).filter((m) => m.id !== ui.selectedId))
  set({ selectedId: null, tool: null })
}

// mask-mode key language, called by App's router in capture order; returns
// true when consumed. R falls through so crop mode opens cleanly.
export function handleMaskKey(e) {
  switch (e.key) {
    case 'Escape': ui.tool ? setTool(null) : setMaskMode(false); return true
    case 'Enter': setMaskMode(false); return true
    case 'm': setMaskMode(false); return true
    case 'M': setTool('radial'); return true // ⇧M — R belongs to crop
    case 'l': case 'L': setTool('linear'); return true
    case 'k': case 'K': addBrushMask(); return true
    case 'b': case 'B': setTool(ui.tool === 'object' ? null : 'object'); return true
    case 'o': case 'O': toggleWashPin(); return true
    case '[': bumpBrushSize(-1); return true
    case ']': bumpBrushSize(1); return true
    case 'Backspace': case 'Delete': deleteSelectedMask(); return true
    case 'z': case 'Z': return true // masking is fit-only; swallow the loupe
    case 'r': case 'R': setMaskMode(false); return false
    default: return false
  }
}

// ── panel ──────────────────────────────────────────────────────────────────

const ADJUST = [
  { key: 'ev', label: 'Exposure', min: -5, max: 5, step: 0.05, decimals: 2 },
  { key: 'temp', label: 'Temp' },
  { key: 'contrast', label: 'Contrast' },
  { key: 'highlights', label: 'Highlights' },
  { key: 'shadows', label: 'Shadows' },
  { key: 'saturation', label: 'Saturation' },
  { key: 'clarity', label: 'Clarity' },
]

const KIND_TAG = { linear: 'LIN', radial: 'RAD', brush: 'BRU', ai: 'AI' }

// ── range refinement (mask.range = { luma, color }) ────────────────────────
// linear sRGB → OKLCh hue (deg) + chroma — CPU twin of the shaders' range
// color proximity, so the eyedropper stores exactly what the shader compares
const cbrtS = (x) => Math.sign(x) * Math.abs(x) ** (1 / 3)
function oklchOf([r, g, b]) {
  const l = cbrtS(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = cbrtS(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = cbrtS(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
  let h = (Math.atan2(B, A) * 180) / Math.PI
  if (h < 0) h += 360
  return { h, C: Math.hypot(A, B) }
}

// dual-handle 0..1 mini-slider for the luminance window
function DualRange({ lo, hi, onPreview, onCommit }) {
  const ref = useRef(null)
  const [drag, setDrag] = useState(null)
  const val = useRef({ lo, hi })
  if (!drag) val.current = { lo, hi }
  const pos = (e) => {
    const r = ref.current.getBoundingClientRect()
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
  }
  const apply = (e, which) => {
    const p = pos(e)
    const v = { ...val.current }
    if (which === 'lo') v.lo = Math.min(Math.round(p * 100) / 100, v.hi - 0.02)
    else v.hi = Math.max(Math.round(p * 100) / 100, v.lo + 0.02)
    val.current = v
    onPreview(v)
  }
  return (
    <div
      ref={ref}
      className="range-dual"
      onPointerDown={(e) => {
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        const p = pos(e)
        const which = Math.abs(p - val.current.lo) <= Math.abs(p - val.current.hi) ? 'lo' : 'hi'
        setDrag(which)
        apply(e, which)
      }}
      onPointerMove={(e) => { if (drag) apply(e, drag) }}
      onPointerUp={() => { if (drag) { setDrag(null); onCommit(val.current) } }}
      onPointerCancel={() => { if (drag) { setDrag(null); onCommit(val.current) } }}
    >
      <span className="range-track" />
      <span
        className="range-band"
        style={{ left: `${val.current.lo * 100}%`, width: `${(val.current.hi - val.current.lo) * 100}%` }}
      />
      <span className="range-handle" style={{ left: `${val.current.lo * 100}%` }} />
      <span className="range-handle" style={{ left: `${val.current.hi * 100}%` }} />
    </div>
  )
}

// per-mask 'Range' disclosure: luminance window (dual handles + softness)
// and color proximity (eyedropper via MSG.SAMPLE + tolerance). Range edits
// are geometry-like: the wash stays visible while they drag.
function RangeControls({ mask, masks }) {
  const [open, setOpen] = useState(!!mask.range)
  const [picking, setPicking] = useState(false)
  const rl = mask.range?.luma ?? null
  const rc = mask.range?.color ?? null

  const patchRange = (patch, commit = true) => {
    const range = { luma: rl, color: rc, ...patch }
    const next = (getEditState().doc?.masks ?? []).map((m) => {
      if (m.id !== mask.id) return m
      const out = { ...m }
      if (range.luma || range.color) out.range = range
      else delete out.range
      return out
    })
    ;(commit ? commitMasks : previewMasks)(next)
  }

  // armed eyedropper: one CAPTURE-phase click on the canvas samples the
  // pre-develop source color (MSG.SAMPLE) — exactly what the shader compares
  useEffect(() => {
    if (!picking) return
    const onDown = (e) => {
      const cv = document.querySelector('.develop-canvas')
      const r = cv?.getBoundingClientRect()
      const x = r?.width ? (e.clientX - r.left) / r.width : -1
      const y = r?.width ? (e.clientY - r.top) / r.height : -1
      setPicking(false)
      if (x < 0 || x > 1 || y < 0 || y > 1) return
      e.preventDefault()
      e.stopPropagation()
      const pid = getEditState().photo?.id
      if (pid == null) return
      samplePoint(pid, x, y).then(({ linear }) => {
        const { h, C } = oklchOf(linear)
        patchRange({ color: { h: Math.round(h), s: Math.round(C * 1000) / 1000, tol: rc?.tol ?? 50 } })
      }).catch(() => {})
    }
    const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setPicking(false) } }
    addEventListener('pointerdown', onDown, true)
    addEventListener('keydown', esc, true)
    return () => {
      removeEventListener('pointerdown', onDown, true)
      removeEventListener('keydown', esc, true)
    }
  })

  const dragWrap = {
    onPointerDownCapture: () => setMaskDragging(true),
    onPointerUpCapture: () => setMaskDragging(false),
    onPointerCancelCapture: () => setMaskDragging(false),
  }

  return (
    <div className="mask-range">
      <button
        type="button"
        className={`range-head mono${open ? ' is-open' : ''}`}
        onClick={() => setOpen(!open)}
      >Range {mask.range ? '●' : ''}</button>
      {open && (
        <div className="range-body">
          <div className="range-row">
            <button
              type="button"
              className={`range-chip mono${rl ? ' is-on' : ''}`}
              onClick={() => patchRange({ luma: rl ? null : { lo: 0.25, hi: 1, softness: 0.5 } })}
            >Luminance</button>
          </div>
          {rl && (
            <div {...dragWrap}>
              <DualRange
                lo={rl.lo}
                hi={rl.hi}
                onPreview={(v) => patchRange({ luma: { ...rl, ...v } }, false)}
                onCommit={(v) => patchRange({ luma: { ...rl, ...v } })}
              />
              <Slider
                label="Softness" min={0} max={100} step={1} decimals={0} defaultValue={50}
                value={Math.round((rl.softness ?? 0.5) * 100)}
                onPreview={(v) => patchRange({ luma: { ...rl, softness: v / 100 } }, false)}
                onCommit={(v) => patchRange({ luma: { ...rl, softness: v / 100 } })}
              />
            </div>
          )}
          <div className="range-row">
            <button
              type="button"
              className={`range-chip mono${rc ? ' is-on' : ''}`}
              onClick={() => (rc ? patchRange({ color: null }) : setPicking(true))}
            >Color</button>
            <button
              type="button"
              className={`range-pick${picking ? ' is-on' : ''}`}
              data-tip="Sample a color from the image"
              aria-pressed={picking}
              onClick={() => setPicking(!picking)}
            >
              <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
                <path d="M8.8 0.9l2.3 2.3-1.4 1.4.7.7-1.1 1.1-.7-.7-4.3 4.3-2.6.9-.9-.9.9-2.6 4.3-4.3-.7-.7 1.1-1.1.7.7z" fill="currentColor" />
              </svg>
            </button>
            {rc && (
              <span
                className="range-swatch"
                style={{ background: `oklch(0.7 ${Math.min(rc.s, 0.3)} ${rc.h})` }}
                title={`h ${rc.h}° · C ${rc.s}`}
              />
            )}
          </div>
          {picking && <p className="mask-hint mono">click the image to sample · Esc cancels</p>}
          {rc && (
            <div {...dragWrap}>
              <Slider
                label="Tolerance" min={0} max={100} step={1} decimals={0} defaultValue={50}
                value={Math.round(rc.tol ?? 50)}
                onPreview={(v) => patchRange({ color: { ...rc, tol: v } }, false)}
                onCommit={(v) => patchRange({ color: { ...rc, tol: v } })}
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function MaskRow({ mask, selected }) {
  const [editing, setEditing] = useState(null)
  const patch = (p) => commitMasks(
    (getEditState().doc?.masks ?? []).map((m) => (m.id === mask.id ? { ...m, ...p } : m)))
  const remove = () => {
    commitMasks((getEditState().doc?.masks ?? []).filter((m) => m.id !== mask.id))
    if (getMaskUi().selectedId === mask.id) set({ selectedId: null, tool: null })
  }
  const rename = () => {
    if (editing != null && editing.trim() && editing !== mask.name) patch({ name: editing.trim() })
    setEditing(null)
  }
  return (
    <div
      className={`mask-row${selected ? ' is-selected' : ''}${mask.enabled ? '' : ' is-off'}`}
      onClick={() => selectMask(mask.id)}
      onMouseEnter={() => setHoverMask(mask.id)}
      onMouseLeave={() => setHoverMask(null)}
    >
      <button
        className={`mask-eye${mask.enabled ? ' is-on' : ''}`}
        title="Enable / disable"
        onClick={(e) => { e.stopPropagation(); patch({ enabled: !mask.enabled }) }}
      ><span /></button>
      <span className="mask-tag mono">{KIND_TAG[mask.kind]}</span>
      {editing != null ? (
        <input
          className="mask-name-input"
          value={editing}
          autoFocus
          onChange={(e) => setEditing(e.target.value)}
          onBlur={rename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') rename()
            else if (e.key === 'Escape') setEditing(null)
            e.stopPropagation()
          }}
          onPointerDown={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="mask-name" onDoubleClick={() => setEditing(mask.name)}>{mask.name}</span>
      )}
      <button
        className={`mask-invert mono${mask.invert ? ' is-on' : ''}`}
        title="Invert"
        onClick={(e) => { e.stopPropagation(); patch({ invert: !mask.invert }) }}
      >◐</button>
      <button
        className="mask-del"
        title="Delete"
        onClick={(e) => { e.stopPropagation(); remove() }}
      >×</button>
    </div>
  )
}

export default function MaskPanel() {
  const { doc } = useEditState()
  const u = useMaskUi()
  const masks = doc?.masks ?? []
  const sel = masks.find((m) => m.id === u.selectedId) ?? null

  return (
    <section className="panel-section mask-panel">
      <div className="mask-head">
        <span className="panel-header">MASKS</span>
        <button className="mask-close mono" title="Done — M" onClick={() => setMaskMode(false)}>M ✕</button>
      </div>

      <div className="mask-list">
        {masks.map((m) => <MaskRow key={m.id} mask={m} selected={m.id === u.selectedId} />)}
        {u.aiBusy && (
          <div className="mask-row is-busy">
            <span className="mask-tag mono">AI</span>
            <span className="mask-name mono">{u.aiBusy === 'object' ? 'selecting…' : `finding ${u.aiBusy}…`}</span>
          </div>
        )}
        {!masks.length && !u.aiBusy &&
          <p className="mask-empty">No masks — drag on the image after arming a tool.</p>}
      </div>

      <div className="mask-new">
        <button className={`mask-tool${u.tool === 'linear' ? ' is-on' : ''}`}
          onClick={() => setTool(u.tool === 'linear' ? null : 'linear')}>+ Linear <kbd>L</kbd></button>
        <button className={`mask-tool${u.tool === 'radial' ? ' is-on' : ''}`}
          onClick={() => setTool(u.tool === 'radial' ? null : 'radial')}>+ Radial <kbd>⇧M</kbd></button>
        <button className={`mask-tool${u.tool === 'brush' ? ' is-on' : ''}`}
          onClick={addBrushMask}>+ Brush <kbd>K</kbd></button>
        <button className="mask-tool mask-tool-ai" disabled={!!u.aiBusy}
          onClick={() => addAiMask('subject')}>+ Subject</button>
        <button className="mask-tool mask-tool-ai" disabled={!!u.aiBusy}
          onClick={() => addAiMask('sky')}>+ Sky</button>
        <button className="mask-tool mask-tool-ai" disabled={!!u.aiBusy}
          onClick={() => addAiMask('background')}>+ Background</button>
        <button className={`mask-tool mask-tool-ai${u.tool === 'object' ? ' is-on' : ''}`} disabled={!!u.aiBusy}
          onClick={() => setTool(u.tool === 'object' ? null : 'object')}>+ Object <kbd>B</kbd></button>
      </div>

      {u.aiError && <p className="mask-hint mono">{u.aiError}</p>}

      {u.tool === 'brush' && (
        <p className="mask-hint mono">paint on image · size [ ] or wheel · ⌥ erase</p>
      )}
      {u.tool === 'object' && (
        <p className="mask-hint mono">click an object, or drag a box around it</p>
      )}
      {(u.tool === 'linear' || u.tool === 'radial') && (
        <p className="mask-hint mono">drag on the image to place the {u.tool}</p>
      )}

      {sel && (
        <div className="mask-adjust">
          <p className="mask-adjust-title mono">{sel.name}</p>
          {sel.kind === 'radial' && (
            // feather is geometry: wash stays visible while it drags
            <div
              onPointerDownCapture={() => setMaskDragging(true)}
              onPointerUpCapture={() => setMaskDragging(false)}
              onPointerCancelCapture={() => setMaskDragging(false)}
            >
              <Slider
                label="Feather" min={0} max={100} step={1} decimals={0} defaultValue={50}
                value={Math.round((sel.geom.feather ?? 0.5) * 100)}
                onPreview={(v) => previewMasks(masks.map((m) =>
                  m.id === sel.id ? { ...m, geom: { ...m.geom, feather: v / 100 } } : m))}
                onCommit={(v) => commitMaskGeom(sel.id, { ...sel.geom, feather: v / 100 })}
              />
            </div>
          )}
          {sel.kind === 'ai' && (
            // refine is geometry (edge softness): wash stays visible while it drags
            <div
              onPointerDownCapture={() => setMaskDragging(true)}
              onPointerUpCapture={() => setMaskDragging(false)}
              onPointerCancelCapture={() => setMaskDragging(false)}
            >
              <Slider
                label="Refine edge" min={0} max={100} step={1} decimals={0} defaultValue={0}
                value={Math.round(sel.geom.refine ?? 0)}
                onPreview={(v) => previewMasks(masks.map((m) =>
                  m.id === sel.id ? { ...m, geom: { ...m.geom, refine: v } } : m))}
                onCommit={(v) => commitMaskGeom(sel.id, { ...sel.geom, refine: v })}
              />
            </div>
          )}
          {/* range refinement — luma window + color proximity, on ANY kind */}
          <RangeControls mask={sel} masks={masks} />
          {/* adjust sliders auto-hide the wash on touch — the key design rule */}
          <div onPointerDownCapture={killWash}>
            {ADJUST.map((r) => (
              <Slider
                key={r.key}
                label={r.label}
                min={r.min ?? -100}
                max={r.max ?? 100}
                step={r.step ?? 1}
                decimals={r.decimals ?? 0}
                defaultValue={MASK_ADJUST_DEFAULTS[r.key]}
                value={sel.adjust?.[r.key] ?? 0}
                onPreview={(v) => previewMaskParam(sel.id, r.key, v)}
                onCommit={(v) => commitMaskParam(sel.id, r.key, v)}
              />
            ))}
          </div>
        </div>
      )}

      <p className="mask-footer mono">O overlay · ⌫ delete · Esc done</p>
    </section>
  )
}
