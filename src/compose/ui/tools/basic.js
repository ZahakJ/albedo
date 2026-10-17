import { getCompose, preview, op, setView, zoomAt, fit } from '../../../state/composeClient.js'
import { findNode } from '../../model.js'

// node moved by (dx, dy) document px — bounds, transforms, fills, masks and
// group children alike; the mask rides along through its offset
export function translated(n, dx, dy) {
  const out = {}
  if (n.bounds) out.bounds = { ...n.bounds, x: n.bounds.x + dx, y: n.bounds.y + dy }
  if (n.xf?.kind === 'affine') { const m = [...n.xf.m]; m[4] += dx; m[5] += dy; out.xf = { ...n.xf, m }; out.bounds = n.bounds }
  else if (n.xf) out.xf = { ...n.xf, pts: n.xf.pts.map(([x, y]) => [x + dx, y + dy]) }
  if (n.xf) out.bounds = n.bounds
  if (n.fill?.line) { const l = n.fill.line; out.fill = { ...n.fill, line: [l[0] + dx, l[1] + dy, l[2] + dx, l[3] + dy] } }
  if (n.mask) out.mask = { ...n.mask, ox: (n.mask.ox ?? 0) + dx, oy: (n.mask.oy ?? 0) + dy }
  if (n.kind === 'group') out.children = n.children.map((c) => ({ ...c, ...translated(c, dx, dy) }))
  return out
}

const activeNode = () => {
  const d = getCompose().doc
  return d?.activeId ? findNode(d.nodes, d.activeId)?.node : null
}

export const moveTool = {
  id: 'move', key: 'v', icon: 'move', label: 'Move', order: 0, primary: true,
  cursor: () => 'move',
  down(c) {
    const n = activeNode()
    if (!n || n.locked || n.kind === 'adjust') { this.s = null; return }
    this.s = { node: n, x0: c.dx, y0: c.dy, dx: 0, dy: 0 }
  },
  move(c) {
    const s = this.s
    if (!s) return
    let dx = c.dx - s.x0, dy = c.dy - s.y0
    if (c.e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0 }
    s.dx = Math.round(dx); s.dy = Math.round(dy)
    preview(s.node.id, translated(s.node, s.dx, s.dy))
  },
  up() {
    const s = this.s
    this.s = null
    if (!s || (!s.dx && !s.dy)) return
    const patch = translated(s.node, s.dx, s.dy)
    preview(s.node.id, patch, true)
    op('props', { nodeId: s.node.id, patch, label: 'Move' })
  },
  // arrow keys nudge: handled by the surface through this hook
  nudge(dx, dy) {
    const n = activeNode()
    if (!n || n.locked) return
    op('props', { nodeId: n.id, patch: translated(n, dx, dy), label: 'Nudge' })
  },
}

export const handTool = {
  id: 'hand', key: 'h', icon: 'hand', label: 'Hand', order: 90,
  cursor: () => 'grab',
  down(c) { const v = getCompose().view; this.s = { x0: c.e.clientX, y0: c.e.clientY, ox: v.offX, oy: v.offY } },
  move(c) { const s = this.s; if (s) setView({ offX: s.ox + c.e.clientX - s.x0, offY: s.oy + c.e.clientY - s.y0, fitted: false }) },
  up() { this.s = null },
}

export const zoomTool = {
  id: 'zoom', key: 'z', icon: 'zoom', label: 'Zoom', order: 91,
  cursor: () => 'zoom-in',
  down(c) { this.s = { x0: c.sx, y0: c.sy, z0: getCompose().view.zoom, moved: false } },
  move(c) {
    const s = this.s
    if (!s) return
    // scrubby zoom: drag right to zoom in, left to zoom out
    const d = c.sx - s.x0
    if (Math.abs(d) > 3) s.moved = true
    if (!s.moved) return
    const v = getCompose().view
    zoomAt(Math.exp(d * 0.01) * s.z0 / v.zoom, s.x0, s.y0)
  },
  up(c) {
    const s = this.s
    this.s = null
    if (s && !s.moved) zoomAt(c.e.altKey ? 0.5 : 2, c.sx, c.sy)
  },
  menu() { fit() },
}
