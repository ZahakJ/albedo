import { useRef, useState, useEffect } from 'react'
import Slider from '../ui/Slider.jsx'
import PanelSection from '../ui/PanelSection.jsx'
import { BLEND_MODES } from './docModel.js'
import {
  useCanvasState, thumbs, setActiveLayer, previewLayerProps, commitLayerProps,
  addLayer, deleteLayer, duplicateLayer, mergeDown, flattenDoc, reorderLayers,
} from '../state/canvasClient.js'

// LAYERS — Photoshop-shaped stack: top layer first, active-layer blend +
// opacity controls above it, tool strip below. Reorder is pointer-drag on the
// rows (worker indices are bottom→top, the panel reverses).

function LayerThumb({ id, gen }) {
  const ref = useRef(null)
  useEffect(() => {
    const c = ref.current
    if (!c) return
    const ctx = c.getContext('2d')
    ctx.clearRect(0, 0, c.width, c.height)
    const b = thumbs.get(id)
    if (b) ctx.drawImage(b, 0, 0)
  }, [id, gen])
  return <canvas ref={ref} className="layer-thumb" width="44" height="34" aria-hidden="true" />
}

export default function LayersPanel() {
  const { doc, thumbGen } = useCanvasState()
  const [renaming, setRenaming] = useState(null) // layerId
  const [dropAt, setDropAt] = useState(null) // display insertion index 0..n
  const drag = useRef(null)
  const listRef = useRef(null)

  if (!doc) return null
  const n = doc.layers.length
  const display = [...doc.layers].reverse() // top first
  const active = doc.layers.find((l) => l.id === doc.activeLayer) ?? null

  const commit = (l, patch, label) => {
    const before = {}
    for (const k of Object.keys(patch)) before[k] = l[k]
    commitLayerProps(l.id, patch, before, label)
  }

  // pointer drag-reorder over the display list
  const onRowDown = (e, dispIdx) => {
    if (e.button !== 0) return
    if (e.target instanceof Element && e.target.closest('button, input')) return
    const l = display[dispIdx]
    setActiveLayer(l.id)
    drag.current = { dispIdx, y0: e.clientY, moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onRowMove = (e) => {
    const d = drag.current
    if (!d) return
    if (Math.abs(e.clientY - d.y0) > 4) d.moved = true
    if (!d.moved) return
    const list = listRef.current
    const rows = [...list.querySelectorAll('.layer-row')]
    let at = rows.length
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect()
      if (e.clientY < r.top + r.height / 2) { at = i; break }
    }
    setDropAt(at)
  }
  const onRowUp = () => {
    const d = drag.current
    drag.current = null
    const at = dropAt
    setDropAt(null)
    if (!d || !d.moved || at == null) return
    const dispTo = at > d.dispIdx ? at - 1 : at
    if (dispTo === d.dispIdx) return
    reorderLayers(n - 1 - d.dispIdx, n - 1 - dispTo)
  }

  return (
    <PanelSection
      id="cv-layers"
      title="LAYERS"
      action={(
        <>
          <button type="button" className="sec-btn sec-icon" data-tip="New layer"
            onClick={() => addLayer({ kind: 'raster' })}>
            <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M6 1.5v9M1.5 6h9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
          <button type="button" className="sec-btn sec-icon" data-tip="Duplicate layer"
            disabled={!active} onClick={() => active && duplicateLayer(active.id)}>
            <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
              <rect x="1.5" y="3.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1.2" />
              <path d="M4 1.5h6.5V8" fill="none" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          </button>
          <button type="button" className="sec-btn sec-icon" data-tip="Merge down"
            disabled={!active} onClick={() => active && mergeDown(active.id)}>
            <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M6 1v6M3.4 4.6L6 7.2l2.6-2.6M2 10.5h8" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          </button>
          <button type="button" className="sec-btn" data-tip="Flatten image"
            onClick={() => flattenDoc()}>FLAT</button>
          <button type="button" className="sec-btn sec-icon layer-del" data-tip="Delete layer"
            disabled={!active || n <= 1} onClick={() => active && deleteLayer(active.id)}>
            <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          </button>
        </>
      )}
    >
      {active && (
        <div className="layer-ctl">
          <select
            className="blend-select mono"
            aria-label="Blend mode"
            value={active.blend}
            onChange={(e) => commit(active, { blend: e.target.value }, 'Blend mode')}
          >
            {BLEND_MODES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>
          <Slider
            label="Opacity"
            min={0} max={100} step={1} defaultValue={100}
            value={Math.round(active.opacity * 100)}
            onPreview={(v) => previewLayerProps(active.id, { opacity: v / 100 })}
            onCommit={(v) => commit(active, { opacity: v / 100 }, 'Opacity')}
          />
        </div>
      )}
      <div className="layer-list" ref={listRef}>
        {display.map((l, i) => (
          <div
            key={l.id}
            className={
              `layer-row${l.id === doc.activeLayer ? ' is-active' : ''}` +
              `${dropAt === i ? ' drop-before' : ''}` +
              `${dropAt === i + 1 && i === n - 1 ? ' drop-after' : ''}`
            }
            data-id={l.id}
            onPointerDown={(e) => onRowDown(e, i)}
            onPointerMove={onRowMove}
            onPointerUp={onRowUp}
            onPointerCancel={onRowUp}
            onDoubleClick={(e) => {
              if (e.target instanceof Element && e.target.closest('button')) return
              setRenaming(l.id)
            }}
          >
            <button
              type="button"
              className={`layer-eye${l.visible ? ' is-on' : ''}`}
              data-tip={l.visible ? 'Hide layer' : 'Show layer'}
              aria-pressed={l.visible}
              onClick={() => commit(l, { visible: !l.visible }, 'Visibility')}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                {l.visible ? (
                  <>
                    <path d="M1 6c1.6-2.4 3.2-3.5 5-3.5S9.4 3.6 11 6c-1.6 2.4-3.2 3.5-5 3.5S2.6 8.4 1 6z"
                      fill="none" stroke="currentColor" strokeWidth="1.1" />
                    <circle cx="6" cy="6" r="1.6" fill="currentColor" />
                  </>
                ) : (
                  <path d="M1 6c1.6-2.4 3.2-3.5 5-3.5S9.4 3.6 11 6c-1.6 2.4-3.2 3.5-5 3.5S2.6 8.4 1 6z"
                    fill="none" stroke="currentColor" strokeWidth="1.1" opacity="0.35" />
                )}
              </svg>
            </button>
            <LayerThumb id={l.id} gen={thumbGen} />
            {renaming === l.id ? (
              <input
                className="layer-rename mono"
                defaultValue={l.name}
                autoFocus
                onFocus={(e) => e.target.select()}
                onBlur={(e) => {
                  const name = e.target.value.trim()
                  setRenaming(null)
                  if (name && name !== l.name) commit(l, { name }, 'Rename layer')
                }}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter') e.target.blur()
                  else if (e.key === 'Escape') { e.target.value = l.name; e.target.blur() }
                }}
                onPointerDown={(e) => e.stopPropagation()}
              />
            ) : (
              <span className="layer-name" title={l.name}>{l.name}</span>
            )}
            {l.kind === 'text' && <span className="layer-badge mono" aria-label="Text layer">T</span>}
            <span className="layer-pct mono">{Math.round(l.opacity * 100)}</span>
          </div>
        ))}
      </div>
    </PanelSection>
  )
}
