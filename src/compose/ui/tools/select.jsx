import { useCompose, getCompose, selectOp, setToolOpts, request } from '../../../state/composeClient.js'
import { CO } from '../../protocol.js'
import { segmentMask, samMask } from '../../../state/segmentClient.js'
import { toast } from '../../../state/toastStore.js'

// Selection tools: rectangle and ellipse marquee, lasso and polygon lasso,
// magic wand, colour range (⇧ on the wand), and AI select (subject, sky, or
// an object by click or box). Shift adds, Alt subtracts, Shift+Alt
// intersects — or the mode buttons in the options bar.

const modeOf = (e, base) => (e.shiftKey && e.altKey ? 'intersect' : e.shiftKey ? 'add' : e.altKey ? 'subtract' : base ?? 'new')

let live = null // in-progress shape, document px — read by the overlay
let redraw = () => {}

function ModeButtons({ tool }) {
  const st = useCompose()
  const m = st.opts[tool]?.mode ?? 'new'
  return (
    <span className="co-opt seg" role="group" aria-label="Selection mode">
      {[['new', 'New'], ['add', 'Add'], ['subtract', 'Subtract'], ['intersect', 'Intersect']].map(([k, l]) => (
        <button key={k} type="button" className={`seg-btn${m === k ? ' is-on' : ''}`} onClick={() => setToolOpts(tool, { mode: k })}>{l}</button>
      ))}
    </span>
  )
}
const Feather = ({ tool }) => {
  const st = useCompose()
  return (
    <label className="co-opt">Feather
      <input type="number" min="0" max="250" value={st.opts[tool].feather ?? 0} onChange={(e) => setToolOpts(tool, { feather: +e.target.value })} /> px
    </label>
  )
}
const SelectionActions = () => (
  <span className="co-opt">
    <button type="button" className="btn-quick" onClick={() => selectOp({ op: 'refine', radius: 10 })} data-tip="Guided filter along the edge: keeps hair and fine detail">Refine edge</button>
    <button type="button" className="btn-quick" onClick={() => selectOp({ op: 'modify', kind: 'expand', amount: 4 })}>Expand 4</button>
    <button type="button" className="btn-quick" onClick={() => selectOp({ op: 'modify', kind: 'contract', amount: 4 })}>Contract 4</button>
    <button type="button" className="btn-quick" onClick={() => selectOp({ op: 'modify', kind: 'feather', amount: 6 })}>Feather 6</button>
  </span>
)

function Overlay() {
  const st = useCompose()
  const v = st.view
  if (!live) return null
  let d = ''
  if (live.kind === 'rect') {
    const [x0, y0] = [Math.min(live.x0, live.x1), Math.min(live.y0, live.y1)]
    d = `M${x0} ${y0}h${Math.abs(live.x1 - live.x0)}v${Math.abs(live.y1 - live.y0)}h${-Math.abs(live.x1 - live.x0)}Z`
  } else if (live.kind === 'ellipse') {
    const cx = (live.x0 + live.x1) / 2, cy = (live.y0 + live.y1) / 2
    const rx = Math.abs(live.x1 - live.x0) / 2, ry = Math.abs(live.y1 - live.y0) / 2
    d = `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${rx * 2} 0a${rx} ${ry} 0 1 0 ${-rx * 2} 0Z`
  } else if (live.pts?.length) {
    d = `M${live.pts.map((p) => `${p[0]} ${p[1]}`).join('L')}${live.hover ? `L${live.hover[0]} ${live.hover[1]}` : ''}`
  }
  return (
    <svg className="co-overlay" aria-hidden="true">
      <g transform={`translate(${v.offX} ${v.offY}) scale(${v.zoom})`}>
        <path className="ants ants-under" d={d} />
        <path className="ants ants-over" d={d} />
      </g>
    </svg>
  )
}

const marquee = (id, kind, icon, label) => ({
  id, key: 'm', icon, label, order: 10, group: ['marquee', 'ellipse'], primary: kind === 'rect',
  cursor: () => 'crosshair',
  Overlay: () => <Overlay />,
  Options: () => <><ModeButtons tool="marquee" /><Feather tool="marquee" /><SelectionActions /></>,
  down(c) { live = { kind, x0: c.dx, y0: c.dy, x1: c.dx, y1: c.dy, mode: modeOf(c.e, getCompose().opts.marquee.mode) }; c.redraw() },
  move(c) {
    if (!live) return
    let x1 = c.dx, y1 = c.dy
    if (c.e.shiftKey && !live.mode.startsWith('add')) { // square / circle
      const s = Math.max(Math.abs(x1 - live.x0), Math.abs(y1 - live.y0))
      x1 = live.x0 + Math.sign(x1 - live.x0) * s; y1 = live.y0 + Math.sign(y1 - live.y0) * s
    }
    live = { ...live, x1, y1 }
    c.redraw()
  },
  up(c) {
    const s = live
    live = null
    c.redraw()
    if (!s) return
    if (Math.abs(s.x1 - s.x0) < 1 && Math.abs(s.y1 - s.y0) < 1) {
      // a click without a drag deselects, like Photoshop
      if (s.mode === 'new') selectOp({ op: 'shape', shapes: [], mode: 'new', label: 'Deselect' }).catch(() => {})
      return
    }
    selectOp({ op: 'shape', shapes: [s], mode: s.mode, feather: getCompose().opts.marquee.feather, label: kind === 'rect' ? 'Rectangular Marquee' : 'Elliptical Marquee' })
  },
})

export const marqueeTool = marquee('marquee', 'rect', 'marquee', 'Rectangular marquee')
export const ellipseTool = { ...marquee('ellipse', 'ellipse', 'ellipse', 'Elliptical marquee'), hidden: true }

export const lassoTool = {
  id: 'lasso', key: 'l', icon: 'lasso', label: 'Lasso', order: 11, group: ['lasso', 'poly'], primary: true,
  cursor: () => 'crosshair',
  Overlay: () => <Overlay />,
  Options: () => <><ModeButtons tool="lasso" /><Feather tool="lasso" /><SelectionActions /></>,
  down(c) { live = { kind: 'lasso', pts: [[c.dx, c.dy]], mode: modeOf(c.e, getCompose().opts.lasso.mode) }; c.redraw() },
  move(c) {
    if (!live) return
    const l = live.pts[live.pts.length - 1]
    if (Math.hypot(c.dx - l[0], c.dy - l[1]) * getCompose().view.zoom > 1.5) live.pts.push([c.dx, c.dy])
    c.redraw()
  },
  up(c) {
    const s = live
    live = null
    c.redraw()
    if (s?.pts.length > 2) selectOp({ op: 'shape', shapes: [s], mode: s.mode, feather: getCompose().opts.lasso.feather, label: 'Lasso' })
  },
}

export const polyTool = {
  id: 'poly', key: 'l', icon: 'poly', label: 'Polygonal lasso', order: 12, hidden: true,
  cursor: () => 'crosshair',
  Overlay: () => <Overlay />,
  Options: () => <><ModeButtons tool="lasso" /><Feather tool="lasso" /><span className="co-hint">Click points; double-click, Enter or click the first point to close. Esc cancels.</span></>,
  down(c) {
    redraw = c.redraw
    const z = getCompose().view.zoom
    if (!live) { live = { kind: 'poly', pts: [[c.dx, c.dy]], mode: modeOf(c.e, getCompose().opts.lasso.mode) }; c.redraw(); return }
    const f = live.pts[0]
    if (live.pts.length > 2 && (Math.hypot(c.dx - f[0], c.dy - f[1]) * z < 8 || c.e.detail > 1)) { this.commit(); return }
    live.pts.push([c.dx, c.dy])
    c.redraw()
  },
  hover(c) { if (live) { live.hover = [c.dx, c.dy]; c.redraw() } },
  move(c) { this.hover(c) },
  up() {},
  commit() {
    const s = live
    live = null
    redraw()
    if (s?.pts.length > 2) { selectOp({ op: 'shape', shapes: [s], mode: s.mode, feather: getCompose().opts.lasso.feather, label: 'Polygonal Lasso' }); return true }
    return !!s
  },
  cancel() { const had = !!live; live = null; return had },
}

export const wandTool = {
  id: 'wand', key: 'w', icon: 'wand', label: 'Magic wand', order: 13, group: ['wand', 'aiselect'], primary: true,
  cursor: () => 'crosshair',
  Options: () => {
    const st = useCompose()
    const o = st.opts.wand
    return (
      <>
        <ModeButtons tool="wand" />
        <label className="co-opt">Tolerance <input type="number" min="0" max="255" value={o.tolerance} onChange={(e) => setToolOpts('wand', { tolerance: +e.target.value })} /></label>
        <label className="co-opt"><input type="checkbox" checked={o.contiguous} onChange={(e) => setToolOpts('wand', { contiguous: e.target.checked })} /> Contiguous</label>
        <label className="co-opt"><input type="checkbox" checked={o.sampleAll} onChange={(e) => setToolOpts('wand', { sampleAll: e.target.checked })} /> Sample all layers</label>
        <button type="button" className="btn-quick" data-tip="Select every pixel near the colour under the last click"
          onClick={() => colorRangeAtLast()}>Color range</button>
        <SelectionActions />
      </>
    )
  },
  down(c) {
    const o = getCompose().opts.wand
    lastClick = [c.dx, c.dy]
    selectOp({ op: 'wand', x: c.dx, y: c.dy, tolerance: o.tolerance, contiguous: o.contiguous, sampleAll: o.sampleAll, mode: modeOf(c.e, o.mode) })
      .catch((err) => toast(err.message))
  },
}
let lastClick = null
async function colorRangeAtLast() {
  if (!lastClick) { toast('Click the colour with the wand first'); return }
  const { getPixel } = await import('../../../state/composeClient.js')
  const px = await getPixel(lastClick[0], lastClick[1])
  selectOp({ op: 'colorRange', colors: [px.slice(0, 3)], fuzziness: 40, mode: getCompose().opts.wand.mode })
}

// ── AI select ──────────────────────────────────────────────────────────────
let aiKey = null // { key, rev } — the SAM embedding is cached per composite
async function compositeBlob(maxSide = 1024) {
  const r = await selectOp({ op: 'readComposite', maxSide })
  const cv = new OffscreenCanvas(r.w, r.h)
  cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.rgba.buffer, r.rgba.byteOffset, r.w * r.h * 4), r.w, r.h), 0, 0)
  return { blob: await cv.convertToBlob({ type: 'image/png' }), w: r.w, h: r.h, rev: r.rev }
}
export async function aiSelect(kind, { points = null, box = null, mode = 'new' } = {}) {
  const doc = getCompose().doc
  if (!doc) return
  const t0 = performance.now()
  try {
    const { blob, w, h, rev } = await compositeBlob(1024)
    let res
    if (kind === 'object') {
      if (!aiKey || aiKey.rev !== rev || aiKey.doc !== doc.id) aiKey = { key: `compose:${doc.id}:${rev}`, rev, doc: doc.id }
      res = await samMask(aiKey.key, blob, points, box, w, h)
    } else {
      res = await segmentMask(`compose:${doc.id}:${rev}:${kind}`, kind, blob, w, h)
    }
    const mask = res.mask ?? res.data
    await request({ type: CO.SELECT, op: 'ai', mask, w: res.width ?? w, h: res.height ?? h, mode, refine: getCompose().opts.aiselect.refine,
      label: kind === 'subject' ? 'Select Subject' : kind === 'sky' ? 'Select Sky' : 'Object Selection' }, [mask.buffer])
    toast(`${kind === 'object' ? 'Object' : kind[0].toUpperCase() + kind.slice(1)} selected in ${((performance.now() - t0) / 1000).toFixed(2)} s`)
  } catch (err) {
    toast(/not installed|404|fetch/i.test(err.message) ? 'The AI models are not installed (npm run setup-models)' : `AI select failed: ${err.message}`)
  }
}

export const aiSelectTool = {
  id: 'aiselect', key: 'w', icon: 'aiselect', label: 'AI select', order: 14, hidden: true,
  cursor: () => 'crosshair',
  Overlay: () => <Overlay />,
  Options: () => {
    const st = useCompose()
    const o = st.opts.aiselect
    return (
      <>
        <ModeButtons tool="aiselect" />
        <button type="button" className="btn-quick" onClick={() => aiSelect('subject', { mode: o.mode })}>Select subject</button>
        <button type="button" className="btn-quick" onClick={() => aiSelect('sky', { mode: o.mode })}>Select sky</button>
        <span className="co-hint">or click / drag a box around an object</span>
        <label className="co-opt"><input type="checkbox" checked={o.refine} onChange={(e) => setToolOpts('aiselect', { refine: e.target.checked })} /> Refine edge</label>
      </>
    )
  },
  down(c) { live = { kind: 'rect', x0: c.dx, y0: c.dy, x1: c.dx, y1: c.dy, mode: modeOf(c.e, getCompose().opts.aiselect.mode) }; c.redraw() },
  move(c) { if (live) { live = { ...live, x1: c.dx, y1: c.dy }; c.redraw() } },
  up(c) {
    const s = live
    live = null
    c.redraw()
    if (!s) return
    const d = getCompose().doc
    const nx = (x) => x / d.width, ny = (y) => y / d.height
    if (Math.abs(s.x1 - s.x0) < 4 && Math.abs(s.y1 - s.y0) < 4) aiSelect('object', { points: [[nx(s.x0), ny(s.y0), 1]], mode: s.mode })
    else aiSelect('object', { box: [nx(Math.min(s.x0, s.x1)), ny(Math.min(s.y0, s.y1)), nx(Math.max(s.x0, s.x1)), ny(Math.max(s.y0, s.y1))], mode: s.mode })
  },
}

export const selectionTools = [marqueeTool, ellipseTool, lassoTool, polyTool, wandTool, aiSelectTool]
