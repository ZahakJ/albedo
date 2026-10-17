import { useEffect, useRef } from 'react'
import { useCompose, getCompose, op, setToolOpts, toScreen } from '../../../state/composeClient.js'
import { findNode, textPad } from '../../model.js'

// Type tool: click to start a type layer, click a type layer to edit it.
// The glyphs on the canvas are the real, shaped ones; an invisible textarea
// over them takes the keystrokes (so input methods, Arabic keyboards and
// dictation all work). Esc or a click outside commits.

let editing = null // { nodeId, created }
let rerender = () => {}

function hitText(dx, dy) {
  const d = getCompose().doc
  const all = []
  const walk = (l) => { for (const n of l) { all.push(n); if (n.children) walk(n.children) } }
  walk(d.nodes)
  for (let i = all.length - 1; i >= 0; i--) {
    const n = all[i]
    if (n.kind !== 'text' || n.visible === false || n.xf) continue
    const b = n.bounds
    if (dx >= b.x && dy >= b.y && dx <= b.x + b.w && dy <= b.y + b.h) return n
  }
  return null
}

function Editor() {
  const st = useCompose()
  const ref = useRef(null)
  const n = editing ? findNode(st.doc?.nodes ?? [], editing.nodeId)?.node : null
  useEffect(() => { if (n) ref.current?.focus() }, [n?.id])
  if (!n) return null
  const t = n.text
  const pad = textPad(t.size)
  const [x, y] = toScreen(n.bounds.x + pad, n.bounds.y + pad)
  const z = st.view.zoom
  return (
    <textarea
      ref={ref}
      className="co-text-edit"
      dir={t.direction === 'auto' ? 'auto' : t.direction}
      spellCheck={false}
      style={{
        left: x, top: y,
        width: Math.max(40, (n.bounds.w - 2 * pad) * z + 8), height: Math.max(20, (n.bounds.h - 2 * pad) * z + 4),
        fontFamily: `'${t.font}', 'IBM Plex Sans', sans-serif`, fontSize: t.size * z, lineHeight: t.leading,
        textAlign: t.align === 'center' ? 'center' : t.align === 'end' ? 'end' : 'start',
        whiteSpace: t.width > 0 ? 'pre-wrap' : 'pre',
      }}
      defaultValue={t.content}
      onInput={(e) => op('setText', { nodeId: n.id, patch: { content: e.target.value }, live: true })}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); e.currentTarget.blur() }
      }}
      onBlur={(e) => finish(n, e.target.value)}
      onPointerDown={(e) => e.stopPropagation()}
    />
  )
}

function finish(n, value) {
  const was = editing
  editing = null
  rerender()
  if (!was) return
  if (!value.trim()) { op('delete', { nodeId: n.id }); return }
  op('setText', { nodeId: n.id, patch: { content: value }, label: was.created ? 'Type' : 'Edit Type' })
}

export const typeTool = {
  id: 'text', key: 't', icon: 'text', label: 'Type', order: 50,
  cursor: () => 'text',
  Overlay: () => { const s = useCompose(); void s; return <Editor /> },
  Options: () => {
    const st = useCompose()
    const o = st.opts.text
    return (
      <>
        <label className="co-opt">Size <input type="number" min="4" max="2000" value={o.size} onChange={(e) => setToolOpts('text', { size: +e.target.value })} /> px</label>
        <span className="co-opt seg">
          {[[400, 'Regular'], [700, 'Bold']].map(([w, l]) => (
            <button key={w} type="button" className={`seg-btn${o.weight === w ? ' is-on' : ''}`} onClick={() => setToolOpts('text', { weight: w })}>{l}</button>
          ))}
        </span>
        <span className="co-hint">Click to type; drag to type into a box that wraps. Font, kerning and direction are in Properties.</span>
      </>
    )
  },
  down(c) {
    rerender = c.redraw
    if (editing) return
    const hit = hitText(c.dx, c.dy)
    if (hit) { op('select', { nodeId: hit.id }); editing = { nodeId: hit.id, created: false }; c.redraw(); return }
    this.s = { x0: c.dx, y0: c.dy, x1: c.dx, y1: c.dy }
  },
  move(c) { if (this.s) this.s = { ...this.s, x1: c.dx, y1: c.dy } },
  async up(c) {
    const s = this.s
    this.s = null
    if (!s) return
    const st = getCompose()
    const o = st.opts.text
    const box = Math.abs(s.x1 - s.x0) > 8 ? Math.abs(s.x1 - s.x0) : 0
    const x = box ? Math.min(s.x0, s.x1) : s.x0
    const y = box ? Math.min(s.y0, s.y1) + o.size * 0.8 : s.y0
    const r = await op('addText', { x, y, text: { content: '', font: o.font, size: o.size, weight: o.weight, color: st.fg, width: box } })
    editing = { nodeId: r.nodeId, created: true }
    c.redraw()
  },
}

// shapes: drag a rectangle, ellipse, polygon or line
let drag = null
export const shapeTool = {
  id: 'shape', key: 'u', icon: 'shape', label: 'Shape', order: 51,
  cursor: () => 'crosshair',
  Options: () => {
    const st = useCompose()
    const o = st.opts.shape
    return (
      <>
        <span className="co-opt seg">
          {[['rect', 'Rectangle'], ['ellipse', 'Ellipse'], ['polygon', 'Polygon'], ['line', 'Line']].map(([k, l]) => (
            <button key={k} type="button" className={`seg-btn${o.type === k ? ' is-on' : ''}`} onClick={() => setToolOpts('shape', { type: k })}>{l}</button>
          ))}
        </span>
        {o.type === 'rect' && <label className="co-opt">Radius <input type="number" min="0" max="2000" value={o.radius} onChange={(e) => setToolOpts('shape', { radius: +e.target.value })} /></label>}
        {o.type === 'polygon' && <label className="co-opt">Sides <input type="number" min="3" max="24" value={o.sides} onChange={(e) => setToolOpts('shape', { sides: +e.target.value })} /></label>}
        <span className="co-hint">Drag to draw; ⇧ keeps it square. Fill and stroke are in Properties.</span>
      </>
    )
  },
  Overlay: () => {
    useCompose()
    if (!drag) return null
    const a = toScreen(Math.min(drag.x0, drag.x1), Math.min(drag.y0, drag.y1))
    const b = toScreen(Math.max(drag.x0, drag.x1), Math.max(drag.y0, drag.y1))
    return (
      <svg className="co-overlay" aria-hidden="true">
        <rect x={a[0]} y={a[1]} width={b[0] - a[0]} height={b[1] - a[1]} className="co-box" />
      </svg>
    )
  },
  down(c) { drag = { x0: c.dx, y0: c.dy, x1: c.dx, y1: c.dy }; c.redraw() },
  move(c) {
    if (!drag) return
    let { x1, y1 } = { x1: c.dx, y1: c.dy }
    if (c.e.shiftKey) { const s = Math.max(Math.abs(x1 - drag.x0), Math.abs(y1 - drag.y0)); x1 = drag.x0 + Math.sign(x1 - drag.x0 || 1) * s; y1 = drag.y0 + Math.sign(y1 - drag.y0 || 1) * s }
    drag = { ...drag, x1, y1 }
    c.redraw()
  },
  up(c) {
    const d = drag
    drag = null
    c.redraw()
    if (!d) return
    const w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0)
    if (w < 2 && h < 2) return
    const st = getCompose()
    const o = st.opts.shape
    op('addShape', { x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1), shape: { type: o.type, w: Math.max(1, w), h: Math.max(1, o.type === 'line' ? Math.max(h, 1) : h), radius: o.radius, sides: o.sides, fill: st.fg } })
  },
}

export const typeTools = [typeTool, shapeTool]
