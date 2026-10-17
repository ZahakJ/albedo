import { useEffect, useRef, useState } from 'react'
import Slider from '../../ui/Slider.jsx'
import PanelSection from '../../ui/PanelSection.jsx'
import { DevelopAdjustPanels } from '../../ui/Develop.jsx'
import { bindTarget, unbindTarget, retargetDoc, useEditState } from '../../state/editStore.js'
import { useCompose, getCompose, op, preview } from '../../state/composeClient.js'
import { findNode, adjustLabel } from '../model.js'
import { monotoneSpline } from '../gpu/compositor.js'
import { BlendSelect } from './LayersPanel.jsx'
import { editSmartInDevelop } from './smartEdit.js'
import TextProps from './TextProps.jsx'

// PROPERTIES — what the active layer is made of: an adjustment's controls
// (a Develop adjustment shows Develop's own panels), a fill's colours, a
// smart object's development, a text layer's type, plus Blend If, the mask
// and layer styles for any layer.

const hex = (c) => '#' + c.slice(0, 3).map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')
const unhex = (h, a = 1) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255, a]

export function Swatch({ color, onChange, label }) {
  return (
    <label className="co-swatch" style={{ background: hex(color) }} title={label}>
      <input type="color" value={hex(color)} aria-label={label} onChange={(e) => onChange(unhex(e.target.value, color[3] ?? 1))} />
    </label>
  )
}

// slider bound to a node property path
function NodeSlider({ node, label, get, set, min, max, step = 1, decimals = 0, defaultValue = 0, histLabel }) {
  return (
    <Slider
      label={label} min={min} max={max} step={step} decimals={decimals} defaultValue={defaultValue}
      value={get(node)}
      onPreview={(v) => preview(node.id, set(node, v))}
      onCommit={(v) => { preview(node.id, set(node, v), true); op('props', { nodeId: node.id, patch: set(node, v), label: histLabel ?? label }) }}
    />
  )
}

const P = (node, key, d) => node.adjust?.params?.[key] ?? d
const setP = (key) => (node, v) => ({ adjust: { ...node.adjust, params: { ...node.adjust.params, [key]: v } } })

// ── Develop adjustment: Develop's panels bound to the layer ───────────────
function DevelopAdjust({ node }) {
  const { doc: bound } = useEditState()
  const nodeRef = useRef(node)
  nodeRef.current = node
  useEffect(() => {
    const target = {
      render: false,
      preview: (d) => preview(nodeRef.current.id, { adjust: { ...nodeRef.current.adjust, modules: d.modules } }),
      commit: (d) => {
        const n = nodeRef.current
        preview(n.id, { adjust: { ...n.adjust, modules: d.modules } }, true)
        op('props', { nodeId: n.id, patch: { adjust: { ...n.adjust, modules: d.modules } }, label: n.name })
      },
    }
    // Develop sizes its (hidden) canvas from the bound photo: give it the document's
    const d = getCompose().doc
    bindTarget({ id: `compose:${node.id}`, name: node.name, isRaw: false, width: d?.width ?? 1, height: d?.height ?? 1 },
      { modules: node.adjust.modules ?? {}, masks: [] }, target)
    return () => unbindTarget()
  }, [node.id])
  // undo in Compose, or another client, changed the layer: follow it
  useEffect(() => {
    if (bound && JSON.stringify(bound.modules) !== JSON.stringify(node.adjust.modules ?? {})) {
      retargetDoc({ modules: node.adjust.modules ?? {}, masks: [] })
    }
  }, [node.adjust.modules])
  if (!bound) return null
  return <div className="co-develop-panels"><DevelopAdjustPanels doc={bound} /></div>
}

// ── Curves ──────────────────────────────────────────────────────────────────
const CH = [['master', 'RGB'], ['r', 'R'], ['g', 'G'], ['b', 'B']]
function Curves({ node }) {
  const [ch, setCh] = useState('master')
  const svg = useRef(null)
  const drag = useRef(null)
  const curves = node.adjust.curves ?? {}
  const pts = curves[ch] ?? [[0, 0], [1, 1]]
  const write = (next, commit) => {
    const patch = { adjust: { ...node.adjust, curves: { ...curves, [ch]: next } } }
    if (commit) { preview(node.id, patch, true); op('props', { nodeId: node.id, patch, label: 'Curves' }) } else preview(node.id, patch)
  }
  const at = (e) => {
    const r = svg.current.getBoundingClientRect()
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height))]
  }
  const f = monotoneSpline(pts)
  let d = ''
  for (let i = 0; i <= 64; i++) { const x = i / 64; d += `${i ? 'L' : 'M'}${x * 100} ${(1 - f(x)) * 100}` }
  return (
    <div className="co-curves">
      <div className="seg co-seg" role="tablist">
        {CH.map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={ch === k} className={`seg-btn${ch === k ? ' is-on' : ''}`} onClick={() => setCh(k)}>{l}</button>
        ))}
      </div>
      <svg
        ref={svg} className="co-curve" viewBox="0 0 100 100" preserveAspectRatio="none" data-ch={ch}
        onPointerDown={(e) => {
          const p = at(e)
          let i = pts.findIndex(([x, y]) => Math.hypot(x - p[0], y - p[1]) < 0.05)
          let next = pts
          if (i < 0) { next = [...pts, p].sort((a, b) => a[0] - b[0]); i = next.findIndex((q) => q === p) }
          drag.current = { i, pts: next }
          e.currentTarget.setPointerCapture(e.pointerId)
          write(next, false)
        }}
        onPointerMove={(e) => {
          const g = drag.current
          if (!g) return
          const p = at(e)
          const next = g.pts.map((q, j) => (j === g.i ? p : q))
          // a point dragged off the side (not an endpoint) deletes itself
          const off = g.i > 0 && g.i < next.length - 1 && (e.clientX < svg.current.getBoundingClientRect().left - 20 || e.clientX > svg.current.getBoundingClientRect().right + 20)
          g.cur = off ? next.filter((_, j) => j !== g.i) : [...next].sort((a, b) => a[0] - b[0])
          write(g.cur, false)
        }}
        onPointerUp={() => { const g = drag.current; drag.current = null; if (g) write(g.cur ?? g.pts, true) }}
        onDoubleClick={() => write([[0, 0], [1, 1]], true)}
      >
        <path d="M25 0V100M50 0V100M75 0V100M0 25H100M0 50H100M0 75H100" className="co-curve-grid" />
        <path d="M0 100L100 0" className="co-curve-diag" />
        <path d={d} className="co-curve-line" />
        {pts.map(([x, y], i) => <circle key={i} cx={x * 100} cy={(1 - y) * 100} r="2.2" className="co-curve-pt" />)}
      </svg>
      <p className="co-hint">Click to add a point, drag it off the side to remove, double-click to reset.</p>
    </div>
  )
}

function Levels({ node }) {
  const ch = node.adjust.channel ?? 'rgb'
  return (
    <>
      <div className="seg co-seg" role="tablist">
        {[['rgb', 'RGB'], ['r', 'R'], ['g', 'G'], ['b', 'B']].map(([k, l]) => (
          <button key={k} type="button" className={`seg-btn${ch === k ? ' is-on' : ''}`} aria-selected={ch === k}
            onClick={() => op('props', { nodeId: node.id, patch: { adjust: { ...node.adjust, channel: k } }, label: 'Levels' })}>{l}</button>
        ))}
      </div>
      <NodeSlider node={node} label="Input black" min={0} max={255} get={(n) => Math.round(P(n, 'inBlack', 0) * 255)} set={(n, v) => setP('inBlack')(n, v / 255)} histLabel="Levels" />
      <NodeSlider node={node} label="Gamma" min={0.1} max={9.99} step={0.01} decimals={2} defaultValue={1} get={(n) => P(n, 'gamma', 1)} set={setP('gamma')} histLabel="Levels" />
      <NodeSlider node={node} label="Input white" min={0} max={255} defaultValue={255} get={(n) => Math.round(P(n, 'inWhite', 1) * 255)} set={(n, v) => setP('inWhite')(n, v / 255)} histLabel="Levels" />
      <NodeSlider node={node} label="Output black" min={0} max={255} get={(n) => Math.round(P(n, 'outBlack', 0) * 255)} set={(n, v) => setP('outBlack')(n, v / 255)} histLabel="Levels" />
      <NodeSlider node={node} label="Output white" min={0} max={255} defaultValue={255} get={(n) => Math.round(P(n, 'outWhite', 1) * 255)} set={(n, v) => setP('outWhite')(n, v / 255)} histLabel="Levels" />
    </>
  )
}

function HueSat({ node }) {
  const colorize = !!P(node, 'colorize', false)
  return (
    <>
      <label className="co-check"><input type="checkbox" checked={colorize}
        onChange={(e) => op('props', { nodeId: node.id, patch: setP('colorize')(node, e.target.checked), label: 'Hue/Saturation' })} /> Colorize</label>
      {colorize ? (
        <>
          <NodeSlider node={node} label="Hue" min={0} max={360} get={(n) => P(n, 'cHue', 30)} set={setP('cHue')} defaultValue={30} histLabel="Hue/Saturation" />
          <NodeSlider node={node} label="Saturation" min={0} max={100} get={(n) => P(n, 'cSat', 25)} set={setP('cSat')} defaultValue={25} histLabel="Hue/Saturation" />
        </>
      ) : (
        <>
          <NodeSlider node={node} label="Hue" min={-180} max={180} get={(n) => P(n, 'hue', 0)} set={setP('hue')} histLabel="Hue/Saturation" />
          <NodeSlider node={node} label="Saturation" min={-100} max={100} get={(n) => P(n, 'saturation', 0)} set={setP('saturation')} histLabel="Hue/Saturation" />
        </>
      )}
      <NodeSlider node={node} label="Lightness" min={-100} max={100} get={(n) => P(n, 'lightness', 0)} set={setP('lightness')} histLabel="Hue/Saturation" />
    </>
  )
}

function Mixer({ node }) {
  const M = P(node, 'matrix', [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]])
  const [row, setRow] = useState(0)
  const setM = (r, c) => (n, v) => {
    const m = P(n, 'matrix', [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]]).map((x) => [...x])
    m[r][c] = v / 100
    return setP('matrix')(n, m)
  }
  const mono = !!P(node, 'mono', false)
  return (
    <>
      <label className="co-check"><input type="checkbox" checked={mono}
        onChange={(e) => op('props', { nodeId: node.id, patch: setP('mono')(node, e.target.checked), label: 'Channel Mixer' })} /> Monochrome</label>
      {!mono && (
        <div className="seg co-seg" role="tablist">
          {['Red', 'Green', 'Blue'].map((l, i) => (
            <button key={l} type="button" className={`seg-btn${row === i ? ' is-on' : ''}`} aria-selected={row === i} onClick={() => setRow(i)}>{l}</button>
          ))}
        </div>
      )}
      {['Red', 'Green', 'Blue'].map((l, c) => (
        <NodeSlider key={`${row}${c}`} node={node} label={l} min={-200} max={200} defaultValue={row === c ? 100 : 0}
          get={() => Math.round(M[mono ? 0 : row][c] * 100)} set={setM(mono ? 0 : row, c)} histLabel="Channel Mixer" />
      ))}
      <NodeSlider key={`${row}k`} node={node} label="Constant" min={-200} max={200}
        get={() => Math.round(M[mono ? 0 : row][3] * 100)} set={setM(mono ? 0 : row, 3)} histLabel="Channel Mixer" />
    </>
  )
}

function GradientStops({ stops, onChange }) {
  const s = stops ?? [{ t: 0, color: [0, 0, 0, 1] }, { t: 1, color: [1, 1, 1, 1] }]
  const css = `linear-gradient(90deg, ${s.map((x) => `rgba(${x.color.slice(0, 3).map((v) => Math.round(v * 255)).join(',')},${x.color[3] ?? 1}) ${x.t * 100}%`).join(',')})`
  return (
    <div className="co-stops">
      <div className="co-ramp" style={{ background: css }} />
      <div className="co-stop-row">
        {s.map((x, i) => (
          <Swatch key={i} color={x.color} label={`Stop ${i + 1}`}
            onChange={(c) => onChange(s.map((y, j) => (j === i ? { ...y, color: c } : y)))} />
        ))}
        <button type="button" className="sec-btn" onClick={() => onChange([...s].reverse().map((x) => ({ ...x, t: 1 - x.t })))}>REVERSE</button>
      </div>
    </div>
  )
}

function AdjustBody({ node }) {
  const t = node.adjust?.type
  switch (t) {
    case 'develop': return <DevelopAdjust node={node} />
    case 'curves': return <Curves node={node} />
    case 'levels': return <Levels node={node} />
    case 'huesat': return <HueSat node={node} />
    case 'mixer': return <Mixer node={node} />
    case 'brightness': return (
      <>
        <NodeSlider node={node} label="Brightness" min={-150} max={150} get={(n) => P(n, 'brightness', 0)} set={setP('brightness')} histLabel="Brightness/Contrast" />
        <NodeSlider node={node} label="Contrast" min={-50} max={100} get={(n) => P(n, 'contrast', 0)} set={setP('contrast')} histLabel="Brightness/Contrast" />
      </>
    )
    case 'exposure': return (
      <>
        <NodeSlider node={node} label="Exposure" min={-10} max={10} step={0.01} decimals={2} get={(n) => P(n, 'exposure', 0)} set={setP('exposure')} histLabel="Exposure" />
        <NodeSlider node={node} label="Offset" min={-0.5} max={0.5} step={0.001} decimals={3} get={(n) => P(n, 'offset', 0)} set={setP('offset')} histLabel="Exposure" />
        <NodeSlider node={node} label="Gamma" min={0.01} max={9.99} step={0.01} decimals={2} defaultValue={1} get={(n) => P(n, 'gamma', 1)} set={setP('gamma')} histLabel="Exposure" />
      </>
    )
    case 'photofilter': return (
      <>
        <div className="co-row-ctl"><span className="co-ctl-label">Color</span>
          <Swatch color={[...P(node, 'color', [0.925, 0.541, 0]), 1]} label="Filter colour"
            onChange={(c) => op('props', { nodeId: node.id, patch: setP('color')(node, c.slice(0, 3)), label: 'Photo Filter' })} /></div>
        <NodeSlider node={node} label="Density" min={0} max={100} defaultValue={25} get={(n) => P(n, 'density', 25)} set={setP('density')} histLabel="Photo Filter" />
        <label className="co-check"><input type="checkbox" checked={P(node, 'preserve', true) !== false}
          onChange={(e) => op('props', { nodeId: node.id, patch: setP('preserve')(node, e.target.checked), label: 'Photo Filter' })} /> Preserve luminosity</label>
      </>
    )
    case 'threshold': return <NodeSlider node={node} label="Level" min={1} max={255} defaultValue={128} get={(n) => P(n, 'level', 128)} set={setP('level')} histLabel="Threshold" />
    case 'posterize': return <NodeSlider node={node} label="Levels" min={2} max={255} defaultValue={4} get={(n) => P(n, 'levels', 4)} set={setP('levels')} histLabel="Posterize" />
    case 'gradmap': return <GradientStops stops={node.adjust.stops} onChange={(stops) => op('props', { nodeId: node.id, patch: { adjust: { ...node.adjust, stops } }, label: 'Gradient Map' })} />
    case 'invert': return <p className="co-hint">Inverts the colours below. No settings.</p>
    default: return null
  }
}

function FillBody({ node }) {
  const f = node.fill
  const set = (patch, label = 'Fill') => op('props', { nodeId: node.id, patch: { fill: { ...f, ...patch } }, label })
  if (f.type === 'solid') {
    return <div className="co-row-ctl"><span className="co-ctl-label">Color</span><Swatch color={f.color} label="Fill colour" onChange={(color) => set({ color }, 'Color Fill')} /></div>
  }
  return (
    <>
      <div className="seg co-seg">
        {['linear', 'radial'].map((k) => (
          <button key={k} type="button" className={`seg-btn${f.type === k ? ' is-on' : ''}`} onClick={() => set({ type: k }, 'Gradient Fill')}>{k === 'linear' ? 'Linear' : 'Radial'}</button>
        ))}
      </div>
      <GradientStops stops={f.stops} onChange={(stops) => set({ stops }, 'Gradient Fill')} />
      <p className="co-hint">Drag on the image with the Gradient tool (G) to place it.</p>
    </>
  )
}

function SmartBody({ node }) {
  const s = node.smart
  return (
    <div className="co-smart">
      <p className="co-smart-name">{s.name ?? node.name}</p>
      <p className="co-hint">A smart object keeps the original and its Develop edit. Change the edit as often as you like; the layer re-develops each time, with nothing written to disk.</p>
      <button type="button" className="btn-quick co-smart-edit" onClick={() => editSmartInDevelop(node)}>Edit in Develop</button>
    </div>
  )
}

function BlendIf({ node }) {
  const bi = node.blendIf
  const on = !!bi
  const val = (which) => bi?.[which] ?? [0, 0, 1, 1]
  const set = (which, i) => (n, v) => {
    const cur = n.blendIf ?? { channel: 0, this: [0, 0, 1, 1], under: [0, 0, 1, 1] }
    const arr = [...cur[which]]
    arr[i] = v / 255
    // keep the split pairs ordered
    if (i === 0 && arr[1] < arr[0]) arr[1] = arr[0]
    if (i === 1 && arr[0] > arr[1]) arr[0] = arr[1]
    if (i === 2 && arr[3] < arr[2]) arr[3] = arr[2]
    if (i === 3 && arr[2] > arr[3]) arr[2] = arr[3]
    return { blendIf: { ...cur, [which]: arr } }
  }
  return (
    <PanelSection id="co-blendif" title="BLEND IF"
      action={(
        <button type="button" className={`bw-chip${on ? ' is-on' : ''}`} aria-pressed={on}
          onClick={() => op('props', { nodeId: node.id, patch: { blendIf: on ? null : { channel: 0, this: [0, 0, 1, 1], under: [0, 0, 1, 1] } }, label: 'Blend If' })}>{on ? 'ON' : 'OFF'}</button>
      )}
    >
      {on ? (
        <>
          <div className="seg co-seg">
            {['Gray', 'Red', 'Green', 'Blue'].map((l, i) => (
              <button key={l} type="button" className={`seg-btn${(bi.channel ?? 0) === i ? ' is-on' : ''}`}
                onClick={() => op('props', { nodeId: node.id, patch: { blendIf: { ...bi, channel: i } }, label: 'Blend If' })}>{l}</button>
            ))}
          </div>
          {[['this', 'This layer'], ['under', 'Underlying']].map(([w, l]) => (
            <div key={w} className="co-bif">
              <p className="co-ctl-label">{l}</p>
              <NodeSlider node={node} label="Black" min={0} max={255} get={() => Math.round(val(w)[0] * 255)} set={set(w, 0)} histLabel="Blend If" />
              <NodeSlider node={node} label="Black fade" min={0} max={255} get={() => Math.round(val(w)[1] * 255)} set={set(w, 1)} histLabel="Blend If" />
              <NodeSlider node={node} label="White fade" min={0} max={255} defaultValue={255} get={() => Math.round(val(w)[2] * 255)} set={set(w, 2)} histLabel="Blend If" />
              <NodeSlider node={node} label="White" min={0} max={255} defaultValue={255} get={() => Math.round(val(w)[3] * 255)} set={set(w, 3)} histLabel="Blend If" />
            </div>
          ))}
          <p className="co-hint">Blend If stays live: change the layers below and the blend follows, with no pixel mask to redo.</p>
        </>
      ) : <p className="co-hint">Blend by the brightness of this layer or the ones below, like a luminosity mask that never goes stale.</p>}
    </PanelSection>
  )
}

function MaskBody({ node }) {
  const m = node.mask
  const set = (patch, label = 'Layer Mask') => op('props', { nodeId: node.id, patch: { mask: { ...m, ...patch } }, label })
  return (
    <PanelSection id="co-mask" title="MASK"
      action={(
        <button type="button" className={`bw-chip${m.enabled !== false ? ' is-on' : ''}`} aria-pressed={m.enabled !== false}
          onClick={() => set({ enabled: m.enabled === false })}>{m.enabled !== false ? 'ON' : 'OFF'}</button>
      )}
    >
      <NodeSlider node={node} label="Density" min={0} max={100} defaultValue={100}
        get={(n) => Math.round((n.mask?.density ?? 1) * 100)} set={(n, v) => ({ mask: { ...n.mask, density: v / 100 } })} histLabel="Mask Density" />
      <div className="co-btn-row">
        <button type="button" className="btn-quick" onClick={() => set({ invert: !m.invert }, 'Invert Mask')}>Invert</button>
        <button type="button" className="btn-quick" onClick={() => op('maskToSelection', { nodeId: node.id })}>Select</button>
        <button type="button" className="btn-quick" onClick={() => op('refineMask', { nodeId: node.id })}>Refine edge</button>
      </div>
      <p className="co-hint">Paint on the mask with the brush: hold \ or pick the mask thumbnail.</p>
    </PanelSection>
  )
}

function StyleBody({ node }) {
  const styles = node.styles ?? []
  if (!styles.length) return null
  const setStyle = (i, patch, live) => {
    const next = styles.map((s, j) => (j === i ? { ...s, ...patch } : s))
    if (live) preview(node.id, { styles: next })
    else { preview(node.id, { styles: next }, true); op('props', { nodeId: node.id, patch: { styles: next }, label: 'Layer Style' }) }
  }
  const SS = ({ i, k, label, min, max, step = 1, decimals = 0, def = 0, scale = 1 }) => (
    <Slider label={label} min={min} max={max} step={step} decimals={decimals} defaultValue={def}
      value={(styles[i][k] ?? def / scale) * scale}
      onPreview={(v) => setStyle(i, { [k]: v / scale }, true)} onCommit={(v) => setStyle(i, { [k]: v / scale }, false)} />
  )
  return (
    <PanelSection id="co-styles" title="LAYER STYLE">
      {styles.map((s, i) => (
        <div key={s.type} className="co-style">
          <div className="co-row-ctl">
            <span className="co-ctl-label">{s.type === 'shadow' ? 'Drop shadow' : s.type === 'stroke' ? 'Stroke' : 'Outer glow'}</span>
            <Swatch color={s.color} label="Colour" onChange={(color) => setStyle(i, { color }, false)} />
          </div>
          <SS i={i} k="opacity" label="Opacity" min={0} max={100} def={100} scale={100} />
          <SS i={i} k="size" label="Size" min={0} max={250} def={s.type === 'stroke' ? 4 : 16} />
          {s.type === 'shadow' && <SS i={i} k="distance" label="Distance" min={0} max={500} def={12} />}
          {s.type === 'shadow' && <SS i={i} k="angle" label="Angle" min={-180} max={180} def={120} />}
          {s.type !== 'stroke' && <SS i={i} k="spread" label="Spread" min={0} max={100} def={0} scale={100} />}
          {s.type === 'stroke' && (
            <div className="seg co-seg">
              {['outside', 'center', 'inside'].map((p) => (
                <button key={p} type="button" className={`seg-btn${s.position === p ? ' is-on' : ''}`} onClick={() => setStyle(i, { position: p }, false)}>{p[0].toUpperCase() + p.slice(1)}</button>
              ))}
            </div>
          )}
        </div>
      ))}
    </PanelSection>
  )
}

export default function PropertiesPanel() {
  const { doc } = useCompose()
  const node = doc?.activeId ? findNode(doc.nodes, doc.activeId)?.node : null
  if (!node) return <div className="co-props-empty"><p className="co-hint">Select a layer to see its properties.</p></div>
  const title = node.kind === 'adjust' ? adjustLabel(node.adjust?.type).toUpperCase()
    : node.kind === 'smart' ? 'SMART OBJECT' : node.kind === 'fill' ? 'FILL' : node.kind === 'text' ? 'TYPE'
      : node.kind === 'shape' ? 'SHAPE' : node.kind === 'group' ? 'GROUP' : 'PIXEL LAYER'
  return (
    <div className="co-props" data-kind={node.kind}>
      {node.kind === 'adjust' && node.adjust.type === 'develop' ? <AdjustBody node={node} /> : (
        <PanelSection id={`co-p-${node.kind}`} title={title}>
          {node.kind === 'adjust' && <AdjustBody node={node} />}
          {node.kind === 'fill' && <FillBody node={node} />}
          {node.kind === 'smart' && <SmartBody node={node} />}
          {(node.kind === 'text' || node.kind === 'shape') && <TextProps node={node} />}
          {node.kind === 'pixel' && (
            <p className="co-hint mono">{node.bounds.w} × {node.bounds.h} px at {Math.round(node.bounds.x)}, {Math.round(node.bounds.y)}{node.xf ? ' · transformed' : ''}</p>
          )}
          {node.kind === 'group' && (
            <div className="co-row-ctl"><span className="co-ctl-label">Mode</span>
              <BlendSelect group value={node.blend ?? 'pass'} onChange={(v) => op('props', { nodeId: node.id, patch: { blend: v }, label: 'Blend Mode' })} /></div>
          )}
        </PanelSection>
      )}
      {node.mask && <MaskBody node={node} />}
      {node.kind !== 'group' && <BlendIf node={node} />}
      <StyleBody node={node} />
    </div>
  )
}
