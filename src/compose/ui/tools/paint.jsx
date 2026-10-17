import { useCompose, getCompose, setToolOpts, strokeBegin, strokePoint, strokeEnd, setCloneSource, toScreen, op } from '../../../state/composeClient.js'
import { toast } from '../../../state/toastStore.js'
import { contentAwareFill } from '../contentAware.js'

// Brush-engine tools. Pointer events carry pressure (pen tablets, Apple
// Pencil); coalesced events keep fast strokes smooth. [ and ] change the
// size, ⇧[ ⇧] the hardness, number keys the opacity.

function Range({ tool, k, label, min, max, step = 1, scale = 1, unit = '' }) {
  const st = useCompose()
  const v = st.opts[tool][k]
  return (
    <label className="co-opt">{label}
      <input type="range" min={min} max={max} step={step} value={v * scale} onChange={(e) => setToolOpts(tool, { [k]: +e.target.value / scale })} />
      <span className="co-opt-val mono">{Math.round(v * scale)}{unit}</span>
    </label>
  )
}
function Pressure({ tool, options = ['size', 'opacity', 'flow', 'off'] }) {
  const st = useCompose()
  return (
    <label className="co-opt" data-tip="What pen pressure controls">Pressure
      <select value={st.opts[tool].pressure} onChange={(e) => setToolOpts(tool, { pressure: e.target.value })}>
        {options.map((o) => <option key={o} value={o}>{o[0].toUpperCase() + o.slice(1)}</option>)}
      </select>
    </label>
  )
}
function Target() {
  const st = useCompose()
  return (
    <span className="co-opt seg" role="group" aria-label="Paint on">
      {[['pixels', 'Pixels'], ['mask', 'Mask']].map(([k, l]) => (
        <button key={k} type="button" className={`seg-btn${st.paintTarget === k ? ' is-on' : ''}`}
          onClick={() => import('../../../state/composeClient.js').then((m) => m.setPaintTarget(k))}>{l}</button>
      ))}
    </span>
  )
}

function BrushRing({ hover, tool }) {
  const st = useCompose()
  if (!hover) return null
  const o = st.opts[tool]
  const d = Math.max(4, o.size * st.view.zoom)
  const src = (tool === 'clone' || tool === 'heal') && st.cloneSource ? toScreen(...st.cloneSource) : null
  return (
    <>
      <div className="co-ring" style={{ width: d, height: d, transform: `translate(${hover[0] - d / 2}px, ${hover[1] - d / 2}px)` }} />
      {src && <div className="co-cross" style={{ left: src[0], top: src[1] }} />}
    </>
  )
}

const brushLike = (id, key, icon, label, order, extra = {}) => ({
  id, key, icon, label, order,
  cursor: () => 'none',
  Overlay: ({ hover }) => <BrushRing hover={hover} tool={id} />,
  Options: () => (
    <>
      <Range tool={id} k="size" label="Size" min={1} max={2000} unit=" px" />
      <Range tool={id} k="hardness" label="Hardness" min={0} max={100} scale={100} unit="%" />
      {id !== 'smudge' && id !== 'dodge' && <Range tool={id} k="opacity" label="Opacity" min={1} max={100} scale={100} unit="%" />}
      {id !== 'smudge' && id !== 'dodge' && <Range tool={id} k="flow" label="Flow" min={1} max={100} scale={100} unit="%" />}
      {id === 'smudge' && <Range tool={id} k="strength" label="Strength" min={1} max={100} scale={100} unit="%" />}
      {extra.options?.()}
      {id === 'brush' || id === 'eraser' ? <Range tool={id} k="smoothing" label="Smoothing" min={0} max={90} scale={100} unit="%" /> : null}
      <Pressure tool={id} options={id === 'smudge' ? ['strength', 'size', 'off'] : undefined} />
      {(id === 'brush' || id === 'eraser') && <Target />}
    </>
  ),
  bracket(dir, shift) {
    const o = getCompose().opts[id]
    if (shift) setToolOpts(id, { hardness: Math.min(1, Math.max(0, o.hardness + dir * 0.25)) })
    else setToolOpts(id, { size: Math.max(1, Math.min(2000, Math.round(o.size * (dir > 0 ? 1.25 : 0.8)))) })
  },
  opacityKey(v) { if ('opacity' in getCompose().opts[id]) setToolOpts(id, { opacity: v }) },
  async down(c) {
    const st = getCompose()
    const o = st.opts[id]
    if ((id === 'clone' || id === 'heal') && c.e.altKey) { setCloneSource([c.dx, c.dy]); return }
    this.active = true
    const onMask = st.paintTarget === 'mask'
    strokeBegin({
      tool: id, ...o,
      color: id === 'eraser' && onMask ? st.bg : st.fg,
      target: id === 'brush' || id === 'eraser' ? st.paintTarget : 'pixels',
      source: st.cloneSource,
      ...(extra.begin?.(st) ?? {}),
    }).catch((err) => { this.active = false; toast(err.message) })
    strokePoint([c.dx, c.dy, c.pressure])
  },
  move(c) { if (this.active) strokePoint([c.dx, c.dy, c.pressure]) },
  async up(c) {
    if (!this.active) return
    this.active = false
    strokePoint([c.dx, c.dy, c.pressure])
    await strokeEnd().catch((err) => toast(err.message))
  },
})

export const brushTool = brushLike('brush', 'b', 'brush', 'Brush', 30)
export const eraserTool = brushLike('eraser', 'e', 'eraser', 'Eraser', 31)
export const smudgeTool = brushLike('smudge', 'r', 'smudge', 'Smudge', 32)
export const cloneTool = brushLike('clone', 's', 'clone', 'Clone stamp', 33, {
  options: () => <CloneOptions tool="clone" />,
})
export const healTool = { ...brushLike('heal', 'j', 'heal', 'Healing brush', 35, { options: () => <CloneOptions tool="heal" /> }), hidden: true }
export const dodgeTool = brushLike('dodge', 'o', 'dodge', 'Dodge / burn', 36, {
  options: () => <DodgeOptions />,
  begin: (st) => ({ mode: st.opts.dodge.mode }),
})

function CloneOptions({ tool }) {
  const st = useCompose()
  const o = st.opts[tool]
  return (
    <>
      <label className="co-opt">Sample
        <select value={o.sample} onChange={(e) => setToolOpts(tool, { sample: e.target.value })}>
          <option value="layer">Current layer</option>
          <option value="below">Current &amp; below</option>
          <option value="all">All layers</option>
        </select>
      </label>
      <label className="co-opt"><input type="checkbox" checked={o.aligned} onChange={(e) => setToolOpts(tool, { aligned: e.target.checked })} /> Aligned</label>
      <span className="co-hint">{st.cloneSource ? '⌥-click to move the source' : '⌥-click to set the source'}</span>
    </>
  )
}
function DodgeOptions() {
  const st = useCompose()
  const o = st.opts.dodge
  return (
    <>
      <span className="co-opt seg">
        {[['dodge', 'Dodge'], ['burn', 'Burn']].map(([k, l]) => (
          <button key={k} type="button" className={`seg-btn${o.mode === k ? ' is-on' : ''}`} onClick={() => setToolOpts('dodge', { mode: k })}>{l}</button>
        ))}
      </span>
      <label className="co-opt">Range
        <select value={o.range} onChange={(e) => setToolOpts('dodge', { range: e.target.value })}>
          <option value="shadows">Shadows</option><option value="mid">Midtones</option><option value="highlights">Highlights</option>
        </select>
      </label>
      <Range tool="dodge" k="exposure" label="Exposure" min={1} max={100} scale={100} unit="%" />
      <button type="button" className="btn-quick" data-tip="A neutral grey Soft Light layer to dodge and burn on, non-destructively"
        onClick={() => op('dodgeBurnLayer')}>New D&amp;B layer</button>
    </>
  )
}

// spot healing: paint over a blemish; the model fills it from around it
let spot = null
export const spotTool = {
  id: 'spot', key: 'j', icon: 'heal', label: 'Spot healing (content-aware)', order: 34, primary: true, group: ['spot', 'heal'],
  cursor: () => 'none',
  Overlay: ({ hover }) => {
    const st = useCompose()
    const d = Math.max(4, st.opts.heal.size * st.view.zoom)
    return (
      <>
        {spot && (
          <svg className="co-overlay" aria-hidden="true">
            <g transform={`translate(${st.view.offX} ${st.view.offY}) scale(${st.view.zoom})`}>
              <polyline points={spot.pts.map((p) => p.join(',')).join(' ')} fill="none" stroke="rgba(255,255,255,0.45)" strokeWidth={spot.size} strokeLinecap="round" strokeLinejoin="round" />
            </g>
          </svg>
        )}
        {hover && <div className="co-ring" style={{ width: d, height: d, transform: `translate(${hover[0] - d / 2}px, ${hover[1] - d / 2}px)` }} />}
      </>
    )
  },
  Options: () => (
    <>
      <Range tool="heal" k="size" label="Size" min={2} max={1000} unit=" px" />
      <span className="co-hint">Paint over a spot or a wire; the local model fills it from around it, on a new layer.</span>
      <button type="button" className="btn-quick" onClick={() => contentAwareFill()}>Fill selection</button>
    </>
  ),
  bracket(dir) {
    const o = getCompose().opts.heal
    setToolOpts('heal', { size: Math.max(2, Math.min(1000, Math.round(o.size * (dir > 0 ? 1.25 : 0.8)))) })
  },
  down(c) { spot = { pts: [[c.dx, c.dy]], size: getCompose().opts.heal.size }; c.redraw() },
  move(c) { if (spot) { spot.pts.push([c.dx, c.dy]); c.redraw() } },
  up(c) {
    const s = spot
    spot = null
    c.redraw()
    if (s) contentAwareFill({ strokes: [s] })
  },
}

// gradient: drag to place the active fill layer's gradient, or a gradient
// into the selection on a pixel layer (as a new gradient fill layer)
let grad = null
export const gradientTool = {
  id: 'gradient', key: 'g', icon: 'gradient', label: 'Gradient', order: 40,
  cursor: () => 'crosshair',
  Options: () => {
    const st = useCompose()
    const o = st.opts.gradient
    return (
      <>
        <span className="co-opt seg">
          {[['linear', 'Linear'], ['radial', 'Radial']].map(([k, l]) => (
            <button key={k} type="button" className={`seg-btn${o.kind === k ? ' is-on' : ''}`} onClick={() => setToolOpts('gradient', { kind: k })}>{l}</button>
          ))}
        </span>
        <span className="co-hint">Drag: foreground to transparent. On a gradient fill layer, drag to move its gradient.</span>
      </>
    )
  },
  Overlay: () => {
    const st = useCompose()
    if (!grad) return null
    const a = toScreen(grad.x0, grad.y0), b = toScreen(grad.x1, grad.y1)
    return (
      <svg className="co-overlay" aria-hidden="true">
        <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} className="co-box" />
        <circle cx={a[0]} cy={a[1]} r="3" fill="#fff" />
        <circle cx={b[0]} cy={b[1]} r="3" fill="#fff" stroke="#000" />
      </svg>
    )
  },
  down(c) { grad = { x0: c.dx, y0: c.dy, x1: c.dx, y1: c.dy }; c.redraw() },
  move(c) { if (grad) { grad = { ...grad, x1: c.dx, y1: c.dy }; c.redraw() } },
  up(c) {
    const g = grad
    grad = null
    c.redraw()
    if (!g || Math.hypot(g.x1 - g.x0, g.y1 - g.y0) < 2) return
    const st = getCompose()
    const kind = st.opts.gradient.kind
    const n = activeNode()
    const line = [g.x0, g.y0, g.x1, g.y1]
    if (n?.kind === 'fill' && n.fill.type !== 'solid') {
      op('props', { nodeId: n.id, patch: { fill: { ...n.fill, type: kind, line } }, label: 'Gradient' })
      return
    }
    const fg = st.fg
    op('addFill', { fill: { type: kind, line, stops: [{ t: 0, color: [...fg.slice(0, 3), 1] }, { t: 1, color: [...fg.slice(0, 3), 0] }] } })
      .then(() => { if (st.selection) op('addMask', { fromSelection: true }) })
  },
}
const activeNode = () => {
  const d = getCompose().doc
  if (!d?.activeId) return null
  let hit = null
  const walk = (l) => { for (const n of l) { if (n.id === d.activeId) hit = n; if (n.children) walk(n.children) } }
  walk(d.nodes)
  return hit
}

export const paintTools = [brushTool, eraserTool, smudgeTool, cloneTool, spotTool, healTool, dodgeTool, gradientTool]
