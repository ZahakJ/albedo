import { useCompose, getCompose, preview, op, toScreen, setTool, getPixel, setColors } from '../../../state/composeClient.js'
import { findNode, isDrawable } from '../../model.js'
import { cornersFor, warpGrid, mapperFor } from '../../mesh.js'
import { toast } from '../../../state/toastStore.js'

// Free transform (⌘T): move, scale, rotate; Distort: drag the four corners
// (perspective); Warp: a 4×4 grid. Every transform stays editable — the
// layer's pixels are never resampled until something has to paint on them.
// Enter applies, Esc cancels.

const mul = (a, b) => [ // affine [a b c d e f]: x' = a x + c y + e
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
]
const inv = (m) => {
  const det = m[0] * m[3] - m[1] * m[2]
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det]
}
const ap = (m, [x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
const T = (x, y) => [1, 0, 0, 1, x, y]
const S = (sx, sy) => [sx, 0, 0, sy, 0, 0]
const R = (t) => [Math.cos(t), Math.sin(t), -Math.sin(t), Math.cos(t), 0, 0]

let st = null // { node, mode, m (affine), quad, mesh, drag }
let redraw = () => {}

const activeDrawable = () => {
  const d = getCompose().doc
  const n = d?.activeId ? findNode(d.nodes, d.activeId)?.node : null
  return n && (isDrawable(n) || n.kind === 'group') ? n : null
}

function begin(n) {
  const mode = n.xf?.kind === 'quad' ? 'distort' : n.xf?.kind === 'mesh' ? 'warp' : 'free'
  st = {
    node: n, mode,
    m: n.xf?.kind === 'affine' ? [...n.xf.m] : [1, 0, 0, 1, 0, 0],
    quad: n.xf?.kind === 'quad' ? n.xf.pts.map((p) => [...p]) : null,
    mesh: n.xf?.kind === 'mesh' ? { n: n.xf.n, pts: n.xf.pts.map((p) => [...p]) } : null,
  }
}
const xfOf = () => {
  if (st.mode === 'distort') return { kind: 'quad', pts: st.quad }
  if (st.mode === 'warp') return { kind: 'mesh', n: st.mesh.n, pts: st.mesh.pts }
  const m = st.m
  const id = Math.abs(m[0] - 1) + Math.abs(m[1]) + Math.abs(m[2]) + Math.abs(m[3] - 1) + Math.abs(m[4]) + Math.abs(m[5]) < 1e-9
  return id ? null : { kind: 'affine', m }
}
const livePreview = () => { preview(st.node.id, { xf: xfOf() }); redraw() }

function setMode(mode) {
  if (!st) return
  const base = { ...st.node, xf: xfOf() }
  if (mode === 'distort' && !st.quad) {
    const c = cornersFor(base)
    st.quad = c.length === 4 ? c : [mapperFor(base).fn(0, 0), mapperFor(base).fn(1, 0), mapperFor(base).fn(1, 1), mapperFor(base).fn(0, 1)]
  }
  if (mode === 'warp' && !st.mesh) st.mesh = warpGrid(base, 4)
  st.mode = mode
  livePreview()
}

function corners() {
  const n = { ...st.node, xf: xfOf() }
  const f = mapperFor(n).fn
  return { tl: f(0, 0), tr: f(1, 0), br: f(1, 1), bl: f(0, 1), t: f(0.5, 0), r: f(1, 0.5), b: f(0.5, 1), l: f(0, 0.5), c: f(0.5, 0.5) }
}

function Overlay() {
  useCompose()
  if (!st) return null
  const c = corners()
  const scr = (p) => toScreen(p[0], p[1])
  const box = [c.tl, c.tr, c.br, c.bl].map(scr)
  const handle = (key, p, cls = '') => {
    const [x, y] = scr(p)
    return <span key={key} className={`co-handle ${cls}`} data-h={key} style={{ left: x, top: y }} />
  }
  let lines = null
  let handles = []
  if (st.mode === 'warp') {
    const { n: g, pts } = st.mesh
    const f = mapperFor({ ...st.node, xf: xfOf() }).fn
    const grid = []
    for (let i = 0; i <= 8; i++) {
      grid.push([...Array(17).keys()].map((j) => scr(f(i / 8, j / 16))))
      grid.push([...Array(17).keys()].map((j) => scr(f(j / 16, i / 8))))
    }
    lines = grid.map((pl, i) => <polyline key={i} points={pl.map((p) => p.join(',')).join(' ')} className="co-box co-box-dim" fill="none" />)
    handles = pts.map((p, i) => handle(`w${i}`, p, 'is-pin'))
    void g
  } else if (st.mode === 'distort') {
    handles = st.quad.map((p, i) => handle(`q${i}`, p))
  } else {
    handles = ['tl', 'tr', 'br', 'bl', 't', 'r', 'b', 'l'].map((k) => handle(k, c[k]))
  }
  return (
    <div className="co-handles">
      <svg className="co-overlay" aria-hidden="true">
        <polygon points={box.map((p) => p.join(',')).join(' ')} className="co-box" />
        {lines}
      </svg>
      {handles}
    </div>
  )
}

const OPP = { tl: 'br', tr: 'bl', br: 'tl', bl: 'tr', t: 'b', b: 't', l: 'r', r: 'l' }
const UV = { tl: [0, 0], tr: [1, 0], br: [1, 1], bl: [0, 1], t: [0.5, 0], b: [0.5, 1], l: [0, 0.5], r: [1, 0.5] }

export const transformTool = {
  id: 'transform', key: null, icon: 'transform', label: 'Free transform (⌘T)', order: 2,
  cursor: () => 'default',
  Overlay: () => <Overlay />,
  Options: () => {
    useCompose()
    const n = activeDrawable()
    if (!n) return <span className="co-hint">Select a layer to transform.</span>
    if (!st || st.node.id !== n.id) begin(n)
    return (
      <>
        <span className="co-opt seg">
          {[['free', 'Free'], ['distort', 'Distort'], ['warp', 'Warp']].map(([k, l]) => (
            <button key={k} type="button" className={`seg-btn${st.mode === k ? ' is-on' : ''}`} onClick={() => setMode(k)}>{l}</button>
          ))}
        </span>
        <button type="button" className="btn-quick" onClick={() => transformTool.commit()}>Apply ⏎</button>
        <button type="button" className="btn-quick" onClick={() => { transformTool.cancel(); setTool('move') }}>Cancel</button>
        <button type="button" className="btn-quick" onClick={() => flip('h')}>Flip H</button>
        <button type="button" className="btn-quick" onClick={() => flip('v')}>Flip V</button>
        <span className="co-hint">Drag inside to move, outside to rotate; ⇧ frees the aspect ratio.</span>
      </>
    )
  },
  down(c) {
    redraw = c.redraw
    const n = activeDrawable()
    if (!n) return
    if (!st || st.node.id !== n.id) begin(n)
    const h = c.e.target instanceof Element ? c.e.target.dataset?.h : null
    const p = [c.dx, c.dy]
    if (st.mode === 'warp') {
      if (h?.startsWith('w')) st.drag = { kind: 'warp', i: +h.slice(1), p0: p, from: [...st.mesh.pts[+h.slice(1)]] }
      return
    }
    if (st.mode === 'distort') {
      if (h?.startsWith('q')) st.drag = { kind: 'quad', i: +h.slice(1), p0: p, from: [...st.quad[+h.slice(1)]] }
      else st.drag = { kind: 'move', p0: p, quad0: st.quad.map((q) => [...q]) }
      return
    }
    const cs = corners()
    if (h && UV[h]) {
      st.drag = { kind: 'scale', h, m0: [...st.m], anchor: baseAt(OPP[h]), grab: baseAt(h) }
      return
    }
    const inside = pointInQuad(p, [cs.tl, cs.tr, cs.br, cs.bl])
    if (inside) st.drag = { kind: 'move', p0: p, m0: [...st.m] }
    else st.drag = { kind: 'rotate', c: cs.c, a0: Math.atan2(p[1] - cs.c[1], p[0] - cs.c[0]), m0: [...st.m] }
  },
  move(c) {
    const d = st?.drag
    if (!d) return
    const p = [c.dx, c.dy]
    if (d.kind === 'warp') { st.mesh.pts[d.i] = [d.from[0] + p[0] - d.p0[0], d.from[1] + p[1] - d.p0[1]]; livePreview(); return }
    if (d.kind === 'quad') { st.quad[d.i] = [d.from[0] + p[0] - d.p0[0], d.from[1] + p[1] - d.p0[1]]; livePreview(); return }
    if (d.kind === 'move' && st.mode === 'distort') { st.quad = d.quad0.map(([x, y]) => [x + p[0] - d.p0[0], y + p[1] - d.p0[1]]); livePreview(); return }
    if (d.kind === 'move') { st.m = mul(T(p[0] - d.p0[0], p[1] - d.p0[1]), d.m0); livePreview(); return }
    if (d.kind === 'rotate') {
      let a = Math.atan2(p[1] - d.c[1], p[0] - d.c[0]) - d.a0
      if (c.e.shiftKey) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12)
      st.m = mul(T(d.c[0], d.c[1]), mul(R(a), mul(T(-d.c[0], -d.c[1]), d.m0)))
      livePreview()
      return
    }
    if (d.kind === 'scale') {
      // in the layer's own frame: S about the anchor so the grabbed handle
      // follows the pointer; proportional unless ⇧ (Photoshop's default)
      const local = ap(inv(d.m0), p)
      const A = d.anchor, G = d.grab
      let sx = Math.abs(G[0] - A[0]) > 1e-6 ? (local[0] - A[0]) / (G[0] - A[0]) : 1
      let sy = Math.abs(G[1] - A[1]) > 1e-6 ? (local[1] - A[1]) / (G[1] - A[1]) : 1
      const edge = d.h.length === 1
      if (edge) { if (d.h === 't' || d.h === 'b') sx = c.e.shiftKey ? 1 : sy; else sy = c.e.shiftKey ? 1 : sx }
      else if (!c.e.shiftKey) { const s = Math.abs(sx) > Math.abs(sy) ? sx : sy; sx = Math.sign(sx || 1) * Math.abs(s); sy = Math.sign(sy || 1) * Math.abs(s) }
      st.m = mul(d.m0, mul(T(A[0], A[1]), mul(S(sx, sy), T(-A[0], -A[1]))))
      livePreview()
    }
  },
  up() { if (st) st.drag = null },
  commit() {
    if (!st) return false
    const s = st
    const xf = xfOf()
    st = null
    preview(s.node.id, { xf }, true)
    op('props', { nodeId: s.node.id, patch: { xf }, label: s.mode === 'warp' ? 'Warp' : s.mode === 'distort' ? 'Distort' : 'Free Transform' })
      .catch((e) => toast(e.message))
    setTool('move')
    return true
  },
  cancel() {
    if (!st) return false
    preview(st.node.id, { xf: st.node.xf ?? null }, true)
    st = null
    return true
  },
}

function flip(axis) {
  if (!st) return
  const c = corners().c
  st.m = mul(T(c[0], c[1]), mul(axis === 'h' ? S(-1, 1) : S(1, -1), mul(T(-c[0], -c[1]), st.m)))
  livePreview()
}
// a handle's position in the layer's own (pre-affine) document frame
function baseAt(h) {
  const b = st.node.bounds ?? { x: 0, y: 0, w: getCompose().doc.width, h: getCompose().doc.height }
  const [u, v] = UV[h]
  return [b.x + u * b.w, b.y + v * b.h]
}
function pointInQuad(p, q) {
  let inside = false
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    if ((q[i][1] > p[1]) !== (q[j][1] > p[1]) && p[0] < ((q[j][0] - q[i][0]) * (p[1] - q[i][1])) / (q[j][1] - q[i][1]) + q[i][0]) inside = !inside
  }
  return inside
}

// ── crop ───────────────────────────────────────────────────────────────────
let crop = null
export const cropTool = {
  id: 'crop', key: 'c', icon: 'crop', label: 'Crop', order: 3,
  cursor: () => 'crosshair',
  Overlay: () => {
    const s = useCompose()
    if (!crop) return null
    const a = toScreen(Math.min(crop.x0, crop.x1), Math.min(crop.y0, crop.y1))
    const b = toScreen(Math.max(crop.x0, crop.x1), Math.max(crop.y0, crop.y1))
    void s
    return (
      <div className="co-handles">
        <div className="co-crop-shade" style={{ left: a[0], top: a[1], width: b[0] - a[0], height: b[1] - a[1] }} />
        <span className="co-tag mono" style={{ left: (a[0] + b[0]) / 2, top: b[1] }}>
          {Math.round(Math.abs(crop.x1 - crop.x0))} × {Math.round(Math.abs(crop.y1 - crop.y0))}
        </span>
      </div>
    )
  },
  Options: () => <span className="co-hint">Drag the new frame, then Enter. Layers keep their pixels outside it, as Photoshop does with Delete Cropped Pixels off.</span>,
  down(c) { redraw = c.redraw; crop = { x0: c.dx, y0: c.dy, x1: c.dx, y1: c.dy }; c.redraw() },
  move(c) { if (crop?.drag !== false) { crop = { ...crop, x1: c.dx, y1: c.dy }; c.redraw() } },
  up() { if (crop) crop.drag = false },
  commit() {
    if (!crop) return false
    const x = Math.min(crop.x0, crop.x1), y = Math.min(crop.y0, crop.y1)
    const w = Math.abs(crop.x1 - crop.x0), h = Math.abs(crop.y1 - crop.y0)
    crop = null
    redraw()
    if (w >= 1 && h >= 1) op('crop', { x, y, w, h })
    return true
  },
  cancel() { const had = !!crop; crop = null; redraw(); return had },
}

// ── eyedropper ─────────────────────────────────────────────────────────────
export const eyedropperTool = {
  id: 'eyedropper', key: 'i', icon: 'eyedropper', label: 'Eyedropper', order: 92,
  cursor: () => 'crosshair',
  Options: () => <span className="co-hint">Click to pick the foreground colour; ⌥-click for the background.</span>,
  async down(c) {
    const px = await getPixel(c.dx, c.dy)
    if (!px) return
    const col = [px[0], px[1], px[2], 1]
    setColors(c.e.altKey ? { bg: col } : { fg: col })
  },
}

export const transformTools = [transformTool, cropTool, eyedropperTool]
