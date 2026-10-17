// Layer geometry: where a drawable node's texture lands in the document.
//
// A node's texture covers its bounds; its optional xf (model.js) moves that
// rectangle non-destructively — affine, four-corner perspective, or a warp
// grid. The compositor draws the result as a triangle mesh carrying the
// texture's uv: one quad for affine, a 16×16 grid for perspective (close to
// perspective-correct interpolation), 32×32 for warps.

// unit square (u, v) → document point
export function mapperFor(node) {
  const b = node.bounds ?? { x: 0, y: 0, w: 1, h: 1 }
  const xf = node.xf
  const lin = (u, v) => [b.x + u * b.w, b.y + v * b.h]
  if (!xf) return { fn: lin, grid: 1 }
  if (xf.kind === 'affine') {
    const [a, bb, c, d, e, f] = xf.m
    return { fn: (u, v) => { const [x, y] = lin(u, v); return [a * x + c * y + e, bb * x + d * y + f] }, grid: 1 }
  }
  if (xf.kind === 'quad') {
    const H = squareToQuad(xf.pts)
    return { fn: (u, v) => applyH(H, u, v), grid: 16 }
  }
  if (xf.kind === 'mesh') {
    const { n, pts } = xf
    return { fn: (u, v) => warpAt(pts, n, u, v), grid: 32 }
  }
  return { fn: lin, grid: 1 }
}

export function meshFor(node) {
  const { fn, grid } = mapperFor(node)
  const g = grid
  const P = []
  for (let j = 0; j <= g; j++) for (let i = 0; i <= g; i++) P.push(fn(i / g, j / g))
  const out = new Float32Array(g * g * 6 * 4)
  let o = 0
  const put = (i, j) => {
    const p = P[j * (g + 1) + i]
    out[o++] = p[0]; out[o++] = p[1]; out[o++] = i / g; out[o++] = j / g
  }
  for (let j = 0; j < g; j++) for (let i = 0; i < g; i++) {
    put(i, j); put(i + 1, j); put(i, j + 1)
    put(i + 1, j); put(i + 1, j + 1); put(i, j + 1)
  }
  return out
}

// document-space outline (for screen bounds and the transform box)
export function cornersFor(node) {
  const { fn, grid } = mapperFor(node)
  if (grid === 1) return [fn(0, 0), fn(1, 0), fn(1, 1), fn(0, 1)]
  const pts = []
  const g = 8
  for (let i = 0; i <= g; i++) pts.push(fn(i / g, 0), fn(i / g, 1), fn(0, i / g), fn(1, i / g))
  return pts
}

// ── homographies ───────────────────────────────────────────────────────────
// H maps (u, v, 1) → (x, y, w); row-major 3×3
export function squareToQuad(q) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q
  const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2
  const sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3
  let g = 0, h = 0
  if (Math.abs(sx) > 1e-9 || Math.abs(sy) > 1e-9) {
    const det = dx1 * dy2 - dx2 * dy1
    g = (sx * dy2 - dx2 * sy) / det
    h = (dx1 * sy - sx * dy1) / det
  }
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1]
}

export const applyH = (H, u, v) => {
  const w = H[6] * u + H[7] * v + H[8]
  return [(H[0] * u + H[1] * v + H[2]) / w, (H[3] * u + H[4] * v + H[5]) / w]
}

export function invert3(m) {
  const [a, b, c, d, e, f, g, h, i] = m
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g
  const det = a * A + b * B + c * C
  if (Math.abs(det) < 1e-12) return null
  return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d]
    .map((v) => v / det)
}

// ── warp grid: Catmull-Rom through n×n control points ─────────────────────
const cr = (p0, p1, p2, p3, t) => {
  const t2 = t * t, t3 = t2 * t
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
}
export function warpAt(pts, n, u, v) {
  const fx = u * (n - 1), fy = v * (n - 1)
  const ix = Math.min(n - 2, Math.floor(fx)), iy = Math.min(n - 2, Math.floor(fy))
  const tx = fx - ix, ty = fy - iy
  const at = (i, j) => {
    // linear extrapolation past the border keeps the edges straight-ish
    const ci = Math.min(n - 1, Math.max(0, i)), cj = Math.min(n - 1, Math.max(0, j))
    const p = pts[cj * n + ci]
    if (ci === i && cj === j) return p
    const q = pts[Math.min(n - 1, Math.max(0, 2 * cj - j)) * n + Math.min(n - 1, Math.max(0, 2 * ci - i))]
    return [2 * p[0] - q[0], 2 * p[1] - q[1]]
  }
  const out = [0, 0]
  for (let c = 0; c < 2; c++) {
    const rows = []
    for (let j = -1; j <= 2; j++) {
      rows.push(cr(at(ix - 1, iy + j)[c], at(ix, iy + j)[c], at(ix + 1, iy + j)[c], at(ix + 2, iy + j)[c], tx))
    }
    out[c] = cr(rows[0], rows[1], rows[2], rows[3], ty)
  }
  return out
}

// identity warp grid over a node's bounds
export function warpGrid(node, n = 4) {
  const { fn } = mapperFor(node)
  const pts = []
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) pts.push(fn(i / (n - 1), j / (n - 1)))
  return { kind: 'mesh', n, pts }
}

// document point → node uv (inverse of mapperFor), by Newton iteration for
// warps; exact for affine and perspective. Used to paint on transformed layers.
export function docToUv(node, x, y) {
  const b = node.bounds ?? { x: 0, y: 0, w: 1, h: 1 }
  const xf = node.xf
  if (!xf) return [(x - b.x) / b.w, (y - b.y) / b.h]
  if (xf.kind === 'affine') {
    const [a, bb, c, d, e, f] = xf.m
    const det = a * d - bb * c
    const px = x - e, py = y - f
    const lx = (d * px - c * py) / det, ly = (-bb * px + a * py) / det
    return [(lx - b.x) / b.w, (ly - b.y) / b.h]
  }
  if (xf.kind === 'quad') {
    const Hi = invert3(squareToQuad(xf.pts))
    return Hi ? applyH(Hi, x, y) : [0, 0]
  }
  const { fn } = mapperFor(node)
  let u = 0.5, v = 0.5
  for (let k = 0; k < 20; k++) {
    const p = fn(u, v)
    const e = 1e-3
    const pu = fn(u + e, v), pv = fn(u, v + e)
    const j00 = (pu[0] - p[0]) / e, j01 = (pv[0] - p[0]) / e, j10 = (pu[1] - p[1]) / e, j11 = (pv[1] - p[1]) / e
    const det = j00 * j11 - j01 * j10
    if (Math.abs(det) < 1e-9) break
    const rx = x - p[0], ry = y - p[1]
    u += (j11 * rx - j01 * ry) / det
    v += (-j10 * rx + j00 * ry) / det
  }
  return [u, v]
}
