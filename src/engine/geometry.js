// Geometry math shared by the render worker (params + output sizing),
// Develop's fit(), and the crop overlay. Crop is axis-aligned in
// source-normalized y-down coords; angle (radians here) rotates the image
// CCW on screen about the crop center; fitScale zooms in just enough that
// the rotated crop window never samples outside the source. Perspective
// (keystone homography) and lens distortion warp the affine result — the
// shader's exact chain — so the inscribed fit accounts for them too.

// CPU twin of the develop shaders' warp chain: affine output (pre-mirror
// y-down source-normalized) → inverse keystone homography about the source
// center → inverse radial distortion remap. Constants mirror the shaders.
// lens: lens-profile terms [a1..a4] (develop shader slots 97..100), applied
// innermost like the shader: r_d = r·(1 + a1 r + a2 r² + a3 r³ + a4 r⁴)
const warpFor = (persp, distortion, W, H, lens = null) => {
  const kv = ((persp?.v ?? 0) / 100) * 0.3
  const kh = ((persp?.h ?? 0) / 100) * 0.3
  const k1 = (distortion ?? 0) / 100
  const lf = lens?.some((a) => a) ? lens : null
  if (!kv && !kh && !k1 && !lf) return null
  return (mx, my) => {
    if (kv || kh) {
      const nx = mx - 0.5
      const ny = my - 0.5
      const w = Math.max(1 + 2 * (kh * nx + kv * ny), 0.2)
      mx = 0.5 + nx / w
      my = 0.5 + ny / w
    }
    if (k1) {
      const dx = (mx - 0.5) * W
      const dy = (my - 0.5) * H
      const r2 = (dx * dx + dy * dy) / (0.25 * (W * W + H * H))
      const s = 1 + k1 * r2 * 0.15
      mx = 0.5 + (mx - 0.5) * s
      my = 0.5 + (my - 0.5) * s
    }
    if (lf) {
      const r = Math.hypot((mx - 0.5) * W, (my - 0.5) * H) / (0.5 * Math.hypot(W, H))
      const s = 1 + r * (lf[0] + r * (lf[1] + r * (lf[2] + r * lf[3])))
      mx = 0.5 + (mx - 0.5) * s
      my = 0.5 + (my - 0.5) * s
    }
    return [mx, my]
  }
}

// a crop-space point (the shader's muv) → final source space (fuv), through
// keystone, manual distortion and the lens profile, as the develop pass maps
// it; heal spots and removal patches live in final source space
export function toFinalSource(x, y, W, H, persp = null, distortion = 0, lens = null) {
  const warp = warpFor(persp, distortion, W, H, lens)
  return warp ? warp(x, y) : [x, y]
}

// Smallest zoom-in f ≥ 1 keeping every corner of the rotated crop window
// inside the source: corners C + R(θ)k/f must satisfy 0 ≤ x ≤ W, 0 ≤ y ≤ H —
// each violated bound yields a minimum f; take the max over all corners.
// With persp/distortion active the map is no longer affine (distortion even
// curves edges), so the closed form gives a seed and a bisection over an
// edge-sampled inside() predicate finds the true inscribed zoom.
export function fitScaleFor(crop, angleRad, W, H, persp = null, distortion = 0, lens = null) {
  const cx = (crop.x + crop.w / 2) * W
  const cy = (crop.y + crop.h / 2) * H
  const hx = (crop.w * W) / 2
  const hy = (crop.h * H) / 2
  const c = Math.cos(angleRad)
  const s = Math.sin(angleRad)
  let f = 1
  // crop center pinned to an edge + rotation would need infinite zoom; cap
  const need = (d, room) => { if (d > 1e-9) f = Math.max(f, room > 1e-9 ? d / room : 1e6) }
  for (const [kx, ky] of [[-hx, -hy], [hx, -hy], [-hx, hy], [hx, hy]]) {
    const rx = c * kx - s * ky
    const ry = s * kx + c * ky
    need(-rx, cx)
    need(rx, W - cx)
    need(-ry, cy)
    need(ry, H - cy)
  }
  const warp = warpFor(persp, distortion, W, H, lens)
  if (!warp) return f
  // edge-sampled predicate: 8 points per crop-window edge through the full
  // affine+warp chain must land in the source (homographies keep lines
  // straight but distortion bows them — corners alone are not enough)
  const corners = [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]]
  const inside = (fz) => {
    const eps = 1e-4
    for (let e = 0; e < 4; e++) {
      const [ax, ay] = corners[e]
      const [bx, by] = corners[(e + 1) % 4]
      for (let i = 0; i <= 8; i++) {
        const t = i / 8
        const kx = ax + (bx - ax) * t
        const ky = ay + (by - ay) * t
        const mx = (cx + (c * kx - s * ky) / fz) / W
        const my = (cy + (s * kx + c * ky) / fz) / H
        const [wx, wy] = warp(mx, my)
        if (wx < -eps || wx > 1 + eps || wy < -eps || wy > 1 + eps) return false
      }
    }
    return true
  }
  if (inside(Math.max(f, 1))) return Math.max(f, 1)
  let lo = Math.max(f, 1)
  let hi = lo
  for (let i = 0; i < 40 && !inside(hi); i++) hi *= 1.5
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2
    if (inside(mid)) hi = mid
    else lo = mid
  }
  return hi
}

// geometry module value (or null = identity) → derived render geometry.
// outW/outH are the developed image's pixel dims: the crop shrunk by fitScale
// so rotated content is real resolution, never upsampled. lens (optional) is
// the modules.lens value — its distortion participates in the inscribed fit.
export function geometryOf(g, W, H, lens = null) {
  const crop = g?.crop ?? { x: 0, y: 0, w: 1, h: 1 }
  const angleRad = ((g?.angle ?? 0) * Math.PI) / 180
  const flipH = g?.flipH ?? 0
  const fitScale = fitScaleFor(crop, angleRad, W, H, g?.persp ?? null, lens?.distortion ?? 0)
  return {
    crop, angleRad, flipH, fitScale,
    outW: Math.max(1, Math.round((crop.w * W) / fitScale)),
    outH: Math.max(1, Math.round((crop.h * H) / fitScale)),
  }
}
