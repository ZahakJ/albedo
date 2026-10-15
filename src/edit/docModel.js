// Canvas document model — shared vocabulary between the UI (src/edit/*) and
// the canvas worker. A doc is { id, name, width, height, layers, activeLayer,
// selection }; layers are bottom→top (compositing order, panel reverses).
// Raster pixel surfaces live only in the worker (doc-sized OffscreenCanvas
// per layer, drawn at layer x/y); text layers are pure props rendered by the
// worker on demand. Persistence: OPFS canvasdocs/<id>/doc.json + <layerId>.png.

// globalCompositeOperation names — natively cover the Photoshop set
export const BLEND_MODES = [
  ['source-over', 'Normal'],
  ['multiply', 'Multiply'],
  ['screen', 'Screen'],
  ['overlay', 'Overlay'],
  ['darken', 'Darken'],
  ['lighten', 'Lighten'],
  ['color-dodge', 'Color Dodge'],
  ['color-burn', 'Color Burn'],
  ['hard-light', 'Hard Light'],
  ['soft-light', 'Soft Light'],
  ['difference', 'Difference'],
  ['exclusion', 'Exclusion'],
  ['hue', 'Hue'],
  ['saturation', 'Saturation'],
  ['color', 'Color'],
  ['luminosity', 'Luminosity'],
]

export const blendLabel = (op) =>
  BLEND_MODES.find(([v]) => v === op)?.[1] ?? 'Normal'

// new-document dialog presets (name, w, h)
export const DOC_PRESETS = [
  ['Square 2048', 2048, 2048],
  ['HD 1920 × 1080', 1920, 1080],
  ['4:5 Portrait', 1638, 2048],
  ['A4 @150dpi', 1240, 1754],
  ['Small 800 × 600', 800, 600],
]

export const docId = () => `cd_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`
export const layerId = () => `l_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`

export function newLayer(kind = 'raster', patch = {}) {
  return {
    id: layerId(),
    name: patch.name ?? (kind === 'text' ? 'Text' : 'Layer'),
    kind,
    visible: true,
    opacity: 1,
    blend: 'source-over',
    x: 0,
    y: 0,
    ...(kind === 'text'
      ? { text: { content: '', size: 48, color: '#ffffff', weight: 400, ...patch.text } }
      : null),
    ...patch,
  }
}

export function newDoc(width, height, name = 'Untitled') {
  return {
    id: docId(),
    name,
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
    layers: [], // bottom→top
    activeLayer: null,
    selection: null, // { shapes: [{ kind, op, … }], feather }
  }
}

// selection shape → Path2D-ish points helper shared by worker (mask) and UI
// (marching ants). rect: {x0,y0,x1,y1} ellipse: same bbox lasso: {pts:[[x,y]…]}
export function shapePath(sh, path, close = true) {
  if (sh.kind === 'rect') {
    const x = Math.min(sh.x0, sh.x1), y = Math.min(sh.y0, sh.y1)
    path.rect(x, y, Math.abs(sh.x1 - sh.x0), Math.abs(sh.y1 - sh.y0))
  } else if (sh.kind === 'ellipse') {
    const cx = (sh.x0 + sh.x1) / 2, cy = (sh.y0 + sh.y1) / 2
    path.ellipse(cx, cy, Math.abs(sh.x1 - sh.x0) / 2, Math.abs(sh.y1 - sh.y0) / 2, 0, 0, Math.PI * 2)
  } else if (sh.kind === 'lasso' && sh.pts?.length > 1) {
    path.moveTo(sh.pts[0][0], sh.pts[0][1])
    for (let i = 1; i < sh.pts.length; i++) path.lineTo(sh.pts[i][0], sh.pts[i][1])
    if (close) path.closePath()
  }
  return path
}
