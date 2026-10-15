// Tile plan for the raw front end: core rectangles that cover the image, each
// with the rectangle its intermediates must cover (core plus an apron wide
// enough for the chain's reach, clipped to the image).
export const TILE = 2048
export const APRON = 16

export function tilesFor(w, h, size = TILE, apron = APRON) {
  const out = []
  for (let y0 = 0; y0 < h; y0 += size) {
    for (let x0 = 0; x0 < w; x0 += size) {
      const x1 = Math.min(w, x0 + size)
      const y1 = Math.min(h, y0 + size)
      const rx = Math.max(0, x0 - apron)
      const ry = Math.max(0, y0 - apron)
      out.push({ x0, y0, x1, y1, rx, ry, rw: Math.min(w, x1 + apron) - rx, rh: Math.min(h, y1 + apron) - ry })
    }
  }
  return out
}

// largest intermediate any tile needs
export const tileExtent = (w, h, size = TILE, apron = APRON) =>
  [Math.min(w, size + 2 * apron), Math.min(h, size + 2 * apron)]
