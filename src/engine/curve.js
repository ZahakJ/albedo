// Point-curve LUT shared by the render worker (texture upload) and tests
// (reference math). Monotone cubic (Fritsch–Carlson) through the control
// points: interpolant never overshoots, so a rising curve cannot fold back.
// The shaders sample the LUT with NEAREST + manual lerp between texels —
// identical on both backends, no float-filtering extension required.

export const LUT_SIZE = 512

// points: [[x,y], ...] in 0..1; <2 points → identity. Outside the covered x
// range the curve clamps to the endpoint y (Lightroom point-curve behavior).
export function buildCurveLut(points) {
  const lut = new Float32Array(LUT_SIZE)
  const pts = (points ?? []).slice().sort((a, b) => a[0] - b[0])
  if (pts.length < 2) {
    for (let i = 0; i < LUT_SIZE; i++) lut[i] = i / (LUT_SIZE - 1)
    return lut
  }
  const n = pts.length
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])

  // secants + Fritsch–Carlson tangent limiting (a²+b² ≤ 9 keeps monotonicity)
  const d = []
  for (let i = 0; i < n - 1; i++) d[i] = (ys[i + 1] - ys[i]) / Math.max(xs[i + 1] - xs[i], 1e-6)
  const m = new Array(n)
  m[0] = d[0]
  m[n - 1] = d[n - 2]
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue }
    const a = m[i] / d[i]
    const b = m[i + 1] / d[i]
    const h = Math.hypot(a, b)
    if (h > 3) { m[i] = 3 / h * a * d[i]; m[i + 1] = 3 / h * b * d[i] }
  }

  let seg = 0
  for (let i = 0; i < LUT_SIZE; i++) {
    const x = i / (LUT_SIZE - 1)
    if (x <= xs[0]) { lut[i] = Math.min(1, Math.max(0, ys[0])); continue }
    if (x >= xs[n - 1]) { lut[i] = Math.min(1, Math.max(0, ys[n - 1])); continue }
    while (seg < n - 2 && x > xs[seg + 1]) seg++
    const h = Math.max(xs[seg + 1] - xs[seg], 1e-6)
    const t = (x - xs[seg]) / h
    const t2 = t * t
    const t3 = t2 * t
    const y = (2 * t3 - 3 * t2 + 1) * ys[seg] + (t3 - 2 * t2 + t) * h * m[seg]
      + (-2 * t3 + 3 * t2) * ys[seg + 1] + (t3 - t2) * h * m[seg + 1]
    lut[i] = Math.min(1, Math.max(0, y))
  }
  return lut
}
