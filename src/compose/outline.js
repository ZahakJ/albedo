// Selection outline for the marching ants.

// marching squares → SVG path in document px (closed contours); vertices on
// cell edges by linear interpolation; adjacent segments joined into rings
export function marchingSquares(v, w, h, t, sx, sy) {
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : v[y * w + x])
  // undirected segment graph keyed by quantised vertex position
  const adj = new Map()
  const pos = new Map()
  const key = (p) => `${Math.round(p[0] * 64)},${Math.round(p[1] * 64)}`
  const link = (a, b) => {
    const ka = key(a), kb = key(b)
    if (ka === kb) return
    pos.set(ka, a); pos.set(kb, b)
    if (!adj.has(ka)) adj.set(ka, [])
    if (!adj.has(kb)) adj.set(kb, [])
    adj.get(ka).push(kb)
    adj.get(kb).push(ka)
  }
  for (let y = -1; y < h; y++) {
    for (let x = -1; x < w; x++) {
      const a = at(x, y), b = at(x + 1, y), c = at(x + 1, y + 1), d = at(x, y + 1)
      const idx = (a >= t ? 8 : 0) | (b >= t ? 4 : 0) | (c >= t ? 2 : 0) | (d >= t ? 1 : 0)
      if (idx === 0 || idx === 15) continue
      const f = (p, q) => Math.min(1, Math.max(0, (t - p) / (q - p || 1e-6)))
      const T = [x + f(a, b), y], R = [x + 1, y + f(b, c)]
      const B = [x + f(d, c), y + 1], L = [x, y + f(a, d)]
      switch (idx) {
        case 1: case 14: link(B, L); break
        case 2: case 13: link(R, B); break
        case 3: case 12: link(R, L); break
        case 4: case 11: link(T, R); break
        case 6: case 9: link(T, B); break
        case 7: case 8: link(T, L); break
        case 5: link(T, L); link(B, R); break
        case 10: link(T, R); link(B, L); break
      }
    }
  }
  let d = ''
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  const used = new Set()
  const edge = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`)
  for (const start of adj.keys()) {
    for (const first of adj.get(start)) {
      if (used.has(edge(start, first))) continue
      const ring = [pos.get(start)]
      let prev = start, cur = first
      used.add(edge(start, first))
      while (cur !== start) {
        ring.push(pos.get(cur))
        const next = adj.get(cur).find((k) => !used.has(edge(cur, k)))
        if (!next) break
        used.add(edge(cur, next))
        prev = cur
        cur = next
      }
      if (ring.length < 3) continue
      const out = [ring[0]]
      for (let i = 1; i < ring.length - 1; i++) {
        const p = out[out.length - 1], q = ring[i], r = ring[i + 1]
        const cross = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
        if (Math.abs(cross) > 0.02) out.push(q)
      }
      out.push(ring[ring.length - 1])
      d += 'M' + out.map(([x, y]) => {
        const X = (x + 0.5) * sx, Y = (y + 0.5) * sy
        x0 = Math.min(x0, X); y0 = Math.min(y0, Y); x1 = Math.max(x1, X); y1 = Math.max(y1, Y)
        return `${X.toFixed(1)} ${Y.toFixed(1)}`
      }).join('L') + 'Z'
    }
  }
  return { path: d || null, bounds: d ? [x0, y0, x1 - x0, y1 - y0] : null }
}
