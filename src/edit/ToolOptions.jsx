import { useState } from 'react'
import Slider from '../ui/Slider.jsx'
import PanelSection from '../ui/PanelSection.jsx'
import { toast } from '../state/toastStore.js'
import {
  useCanvasState, setToolOpts, setFg, setSelectionShapes, adjustLayer,
} from '../state/canvasClient.js'

// TOOL OPTIONS — per-tool controls. With Move active this also hosts the
// Photoshop-lite adjustments (destructive, one undo snapshot each).

const SHAPES = [['rect', 'Rect'], ['ellipse', 'Ellipse'], ['lasso', 'Lasso']]

function ColorSwatch({ value, onChange, label = 'Color' }) {
  return (
    <label className="cv-swatch-row">
      <span className="slider-label">{label}</span>
      <span className="cv-swatch" style={{ background: value }} data-tip="Pick color">
        <input
          type="color"
          value={value}
          aria-label={label}
          onChange={(e) => onChange(e.target.value)}
        />
      </span>
      <span className="mono cv-swatch-hex">{value}</span>
    </label>
  )
}

function BrushRows({ tool }) {
  const { opts, fg } = useCanvasState()
  const o = opts[tool]
  const row = (label, key, min, max, scale = 1) => (
    <Slider
      label={label} min={min} max={max} step={1} defaultValue={max}
      value={Math.round(o[key] * scale)}
      onPreview={() => {}}
      onCommit={(v) => setToolOpts(tool, { [key]: v / scale })}
    />
  )
  return (
    <>
      <Slider
        label="Size" min={1} max={300} step={1} defaultValue={32}
        value={o.size}
        onPreview={() => {}}
        onCommit={(v) => setToolOpts(tool, { size: v })}
      />
      {row('Hardness', 'hardness', 0, 100, 100)}
      {row('Opacity', 'opacity', 0, 100, 100)}
      {tool === 'brush' && <ColorSwatch value={fg} onChange={setFg} />}
      {tool === 'brush' && <p className="cv-hint">⌥ click samples a color · [ ] resize</p>}
      {tool === 'clone' && <p className="cv-hint">⌥ click sets the clone source</p>}
    </>
  )
}

function Adjustments({ layerId, filtersOK }) {
  const [bc, setBc] = useState({ brightness: 0, contrast: 0 })
  const [hs, setHs] = useState({ hue: 0, saturation: 0 })
  const [blur, setBlur] = useState(6)
  const run = (kind, params) =>
    adjustLayer(layerId, kind, params).catch((err) => toast(String(err.message ?? err)))
  const apply = (label, kind, params, reset) => (
    <div className="cv-adj-apply">
      <button
        type="button"
        className="btn-quick"
        disabled={!layerId || !filtersOK}
        onClick={() => { run(kind, params); reset?.() }}
      >Apply {label}</button>
    </div>
  )
  return (
    <div className="cv-adjust">
      <p className="panel-header">ADJUSTMENTS</p>
      {!filtersOK && <p className="cv-hint">canvas filters unavailable in this browser</p>}
      <Slider label="Brightness" min={-100} max={100} step={1} defaultValue={0}
        value={bc.brightness} onPreview={() => {}}
        onCommit={(v) => setBc((s) => ({ ...s, brightness: v }))} />
      <Slider label="Contrast" min={-100} max={100} step={1} defaultValue={0}
        value={bc.contrast} onPreview={() => {}}
        onCommit={(v) => setBc((s) => ({ ...s, contrast: v }))} />
      {apply('B/C', 'bc', bc, () => setBc({ brightness: 0, contrast: 0 }))}
      <Slider label="Hue" min={-180} max={180} step={1} defaultValue={0}
        value={hs.hue} onPreview={() => {}}
        onCommit={(v) => setHs((s) => ({ ...s, hue: v }))} />
      <Slider label="Saturation" min={-100} max={100} step={1} defaultValue={0}
        value={hs.saturation} onPreview={() => {}}
        onCommit={(v) => setHs((s) => ({ ...s, saturation: v }))} />
      {apply('H/S', 'huesat', hs, () => setHs({ hue: 0, saturation: 0 }))}
      <Slider label="Blur radius" min={1} max={40} step={1} defaultValue={6}
        value={blur} onPreview={() => {}} onCommit={setBlur} />
      <div className="cv-adj-apply cv-adj-pair">
        <button type="button" className="btn-quick" disabled={!layerId || !filtersOK}
          onClick={() => run('blur', { radius: blur })}>Apply Blur</button>
        <button type="button" className="btn-quick" disabled={!layerId}
          onClick={() => run('invert', {})}>Invert</button>
      </div>
    </div>
  )
}

export default function ToolOptions({ cropRect, onCropApply, onCropCancel }) {
  const { tool, opts, fg, doc, filtersOK } = useCanvasState()
  const active = doc?.layers.find((l) => l.id === doc.activeLayer) ?? null
  const activeRaster = active?.kind === 'raster' ? active.id : null
  const sel = opts.select

  return (
    <PanelSection id="cv-tool" title="TOOL">
      {tool === 'move' && (
        <>
          <p className="cv-hint">drag moves the layer · arrows nudge · ⌘T transforms</p>
          <Adjustments layerId={activeRaster} filtersOK={filtersOK} />
        </>
      )}
      {(tool === 'brush' || tool === 'eraser' || tool === 'clone') && <BrushRows tool={tool} />}
      {tool === 'select' && (
        <>
          <div className="seg cv-shape-seg" role="tablist" aria-label="Selection shape">
            <span className="seg-thumb" aria-hidden="true" />
            {SHAPES.map(([v, label]) => (
              <button
                key={v} role="tab" aria-selected={sel.shape === v}
                className={`seg-btn${sel.shape === v ? ' is-on' : ''}`}
                onClick={() => setToolOpts('select', { shape: v })}
              >{label}</button>
            ))}
          </div>
          <Slider
            label="Feather" min={0} max={50} step={1} defaultValue={0}
            value={sel.feather}
            onPreview={() => {}}
            onCommit={(v) => {
              setToolOpts('select', { feather: v })
              const shapes = doc?.selection?.shapes
              if (shapes?.length) setSelectionShapes(shapes, v)
            }}
          />
          <p className="cv-hint">⇧ adds · ⌥ subtracts · ⌘D deselects</p>
        </>
      )}
      {tool === 'fill' && (
        <>
          <ColorSwatch value={fg} onChange={setFg} />
          <p className="cv-hint">click fills · drag pulls a gradient to transparent</p>
        </>
      )}
      {tool === 'text' && (
        <>
          <Slider
            label="Size" min={8} max={300} step={1} defaultValue={48}
            value={opts.text.size}
            onPreview={() => {}}
            onCommit={(v) => setToolOpts('text', { size: v })}
          />
          <div className="seg cv-weight-seg" role="tablist" aria-label="Text weight">
            <span className="seg-thumb" aria-hidden="true" />
            {[[400, 'Regular'], [500, 'Medium']].map(([v, label]) => (
              <button
                key={v} role="tab" aria-selected={opts.text.weight === v}
                className={`seg-btn${opts.text.weight === v ? ' is-on' : ''}`}
                onClick={() => setToolOpts('text', { weight: v })}
              >{label}</button>
            ))}
          </div>
          <ColorSwatch value={fg} onChange={setFg} />
          <p className="cv-hint">click the stage to place text · dbl-click re-edits</p>
        </>
      )}
      {tool === 'crop' && (
        <>
          <p className="cv-hint">drag the new document bounds</p>
          {cropRect && (
            <p className="cv-hint mono">
              {Math.round(Math.abs(cropRect.x1 - cropRect.x0))} × {Math.round(Math.abs(cropRect.y1 - cropRect.y0))} px
            </p>
          )}
          <div className="cv-adj-pair cv-adj-apply">
            <button type="button" className="btn-quick" disabled={!cropRect} onClick={onCropApply}>
              Apply crop ↵
            </button>
            <button type="button" className="btn-quick" disabled={!cropRect} onClick={onCropCancel}>
              Cancel
            </button>
          </div>
        </>
      )}
    </PanelSection>
  )
}
