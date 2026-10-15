// Global chrominance offsets for opposed-channel highlight inpainting, after
// darktable's "inpaint opposed" (GPL-3.0-or-later). Measured once per photo
// on the white-balanced mosaic: the unclipped photosites just around clipped
// areas tell how far each channel sits from the cube-root mean of the other
// two. The GPU pass (rcd fs_hlr) adds that offset to the same estimate at
// clipped photosites.

// fraction of the white level treated as clipped
export const CLIP = 0.98

// 0 red, 1 green, 2 blue at (x, y): an RGGB-phase offset [ox, oy] for
// Bayer, or a 6×6 pattern (row-major, 36 entries) for X-Trans
const colorFn = (p) => {
  if (p.xtrans) {
    const t = p.xtrans
    return (x, y) => t[(y % 6) * 6 + (x % 6)]
  }
  const [ox, oy] = p.cfa
  return (x, y) => {
    const px = (x + ox) & 1
    const py = (y + oy) & 1
    return px === 0 && py === 0 ? 0 : px === 1 && py === 1 ? 2 : 1
  }
}

// p: decoded mosaic payload { buffer: Uint16Array raw frame, rawWidth, left,
// top, width, height, black, white, camMul, cfa | xtrans }
// → { clipped, chroma: [r, g, b], clip: [r, g, b] }
export function hlChroma(p) {
  const { buffer: d, width: W, height: H, black, white, camMul } = p
  const S = p.rawWidth ?? W
  const base = (p.top ?? 0) * S + (p.left ?? 0)
  const colorAt = colorFn(p)
  const range = white - black
  const clip = [0, 1, 2].map((c) => CLIP * camMul[c])
  const rawClip = black + CLIP * range
  const none = { clipped: false, chroma: [0, 0, 0], clip }

  // 3×3-photosite cells: does any photosite of colour c clip in the cell?
  const mw = Math.floor(W / 3)
  const mh = Math.floor(H / 3)
  if (mw < 8 || mh < 8) return none
  const mask = [new Uint8Array(mw * mh), new Uint8Array(mw * mh), new Uint8Array(mw * mh)]
  let any = false
  for (let y = 0; y < mh * 3; y++) {
    const row = base + y * S
    const my = ((y / 3) | 0) * mw
    for (let x = 0; x < mw * 3; x++) {
      if (d[row + x] >= rawClip) {
        mask[colorAt(x, y)][my + ((x / 3) | 0)] = 1
        any = true
      }
    }
  }
  if (!any) return none

  // dilate each mask by two cells: the unclipped ring around clipped areas
  const ring = mask.map((m) => {
    const o = new Uint8Array(mw * mh)
    for (let y = 0; y < mh; y++) {
      for (let x = 0; x < mw; x++) {
        if (!m[y * mw + x]) continue
        for (let j = Math.max(0, y - 2); j <= Math.min(mh - 1, y + 2); j++) {
          o.fill(1, j * mw + Math.max(0, x - 2), j * mw + Math.min(mw - 1, x + 2) + 1)
        }
      }
    }
    return o
  })

  const val = (x, y) => {
    const v = (d[base + y * S + x] - black) / range
    return v > 0 ? v * camMul[colorAt(x, y)] : 0
  }
  const sums = [0, 0, 0]
  const cnts = [0, 0, 0]
  const mean = [0, 0, 0]
  const n = [0, 0, 0]
  // the offset is a mean: a big blown sky needs no more than ~30k ring cells
  let ringCells = 0
  for (let i = 0; i < mw * mh; i++) if (ring[0][i] || ring[1][i] || ring[2][i]) ringCells++
  const every = Math.max(1, Math.ceil(ringCells / 30000))
  let seen = 0
  for (let my = 1; my < mh - 1; my++) {
    for (let mx = 1; mx < mw - 1; mx++) {
      const mi = my * mw + mx
      if (!ring[0][mi] && !ring[1][mi] && !ring[2][mi]) continue
      if (seen++ % every) continue
      for (let y = my * 3; y < my * 3 + 3; y++) {
        for (let x = mx * 3; x < mx * 3 + 3; x++) {
          const c = colorAt(x, y)
          if (!ring[c][mi]) continue
          const v = val(x, y)
          if (v >= clip[c] || v <= 0.2 * clip[c]) continue
          mean[0] = mean[1] = mean[2] = 0
          n[0] = n[1] = n[2] = 0
          for (let j = y - 1; j <= y + 1; j++) {
            for (let i = x - 1; i <= x + 1; i++) {
              const k = colorAt(i, j)
              mean[k] += val(i, j)
              n[k]++
            }
          }
          const m1 = Math.cbrt(mean[1] / n[1])
          // an X-Trans 3×3 can miss red or blue; stand in green, as the GPU does
          const m0 = n[0] ? Math.cbrt(mean[0] / n[0]) : m1
          const m2 = n[2] ? Math.cbrt(mean[2] / n[2]) : m1
          const o = c === 0 ? 0.5 * (m1 + m2) : c === 1 ? 0.5 * (m0 + m2) : 0.5 * (m0 + m1)
          sums[c] += v - o * o * o
          cnts[c]++
        }
      }
    }
  }
  return {
    clipped: true,
    chroma: sums.map((s, c) => (cnts[c] > 100 / every ? s / cnts[c] : 0)),
    clip,
  }
}
