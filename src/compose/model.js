// Compose document model — the vocabulary shared by the UI (src/compose/ui)
// and the engine in the render worker.
//
// A document is { id, name, width, height, depth (8 | 16 | 32), nodes,
// activeId, rev }. nodes are bottom → top (compositing order; the Layers
// panel shows them reversed). Every node:
//   id, kind, name, visible, locked, opacity 0..1, fillOpacity 0..1,
//   blend (BLEND_MODES key; groups also 'pass'), clip (clips to the node
//   below), blendIf null | { channel 0..3, this: [blackLo, blackHi, whiteLo,
//   whiteHi], under: [...] } (0..1), mask null | { enabled, density 0..1,
//   invert, feather }, styles null | [{ type: 'shadow'|'stroke'|'glow', … }],
//   rev (bumped by the engine on every change; groups include their children)
// and per kind:
//   pixel   bounds { x, y, w, h } — the texture's place in the document
//   smart   bounds, smart { photoId, name, edit (Develop edit document), w, h }
//   adjust  adjust { type, …params } — see ADJUSTMENTS
//   fill    fill { type 'solid'|'linear'|'radial', color [r,g,b,a], stops, line }
//   text    bounds, text { … } — see newText
//   shape   bounds, shape { … } — see newShape
//   group   children, collapsed
// Drawable nodes may carry xf: a non-destructive transform of their bounds —
//   { kind: 'affine', m: [a, b, c, d, e, f] } (doc' = M · doc)
//   { kind: 'quad', pts: [[x, y] × 4] } (corners tl, tr, br, bl)
//   { kind: 'mesh', n, pts: [[x, y] × n²] } (warp grid over the bounds)
// and liquify: true when a displacement field exists for them.
// Pixels, masks, displacement fields and developed smart objects live only
// in the worker, on the GPU.

// Photoshop's menu order; index = shader mode number (blend.wgsl)
export const BLEND_MODES = [
  ['normal', 'Normal'], ['dissolve', 'Dissolve'],
  ['darken', 'Darken'], ['multiply', 'Multiply'], ['colorBurn', 'Color Burn'], ['linearBurn', 'Linear Burn'], ['darkerColor', 'Darker Color'],
  ['lighten', 'Lighten'], ['screen', 'Screen'], ['colorDodge', 'Color Dodge'], ['linearDodge', 'Linear Dodge (Add)'], ['lighterColor', 'Lighter Color'],
  ['overlay', 'Overlay'], ['softLight', 'Soft Light'], ['hardLight', 'Hard Light'], ['vividLight', 'Vivid Light'], ['linearLight', 'Linear Light'], ['pinLight', 'Pin Light'], ['hardMix', 'Hard Mix'],
  ['difference', 'Difference'], ['exclusion', 'Exclusion'], ['subtract', 'Subtract'], ['divide', 'Divide'],
  ['hue', 'Hue'], ['saturation', 'Saturation'], ['color', 'Color'], ['luminosity', 'Luminosity'],
]
export const BLEND_INDEX = Object.fromEntries(BLEND_MODES.map(([k], i) => [k, i]))
// menu separators after these indices, as Photoshop groups them
export const BLEND_GROUP_ENDS = [1, 6, 11, 18, 22]
export const blendLabel = (k) => k === 'pass' ? 'Pass Through' : BLEND_MODES.find(([v]) => v === k)?.[1] ?? 'Normal'

// adjustment types → shader number (adjust.wgsl); develop runs Develop's shader
export const ADJUST_INDEX = {
  levels: 1, curves: 2, huesat: 3, invert: 4, threshold: 5, posterize: 6, gradmap: 7,
  mixer: 8, photofilter: 9, brightness: 10, exposure: 11,
}
export const ADJUSTMENTS = [
  ['develop', 'Develop'],
  ['curves', 'Curves'], ['levels', 'Levels'], ['brightness', 'Brightness/Contrast'], ['exposure', 'Exposure'],
  ['huesat', 'Hue/Saturation'], ['mixer', 'Channel Mixer'], ['photofilter', 'Photo Filter'],
  ['gradmap', 'Gradient Map'], ['invert', 'Invert'], ['posterize', 'Posterize'], ['threshold', 'Threshold'],
]
export const adjustLabel = (t) => ADJUSTMENTS.find(([k]) => k === t)?.[1] ?? t

export const DEPTHS = [8, 16, 32]

const rnd = () => Math.floor(Math.random() * 1e6).toString(36)
export const newId = (p = 'n') => `${p}_${Date.now().toString(36)}_${rnd()}`

const base = (kind, name, patch) => ({
  id: newId(),
  kind,
  name,
  visible: true,
  locked: false,
  opacity: 1,
  fillOpacity: 1,
  blend: kind === 'group' ? 'pass' : 'normal',
  clip: false,
  blendIf: null,
  mask: null,
  styles: null,
  rev: 1,
  ...patch,
})

export const newPixel = (bounds, patch = {}) => base('pixel', patch.name ?? 'Layer', { bounds, ...patch })
export const newGroup = (children = [], patch = {}) => base('group', patch.name ?? 'Group', { children, collapsed: false, ...patch })
export const newAdjust = (type, patch = {}) => base('adjust', patch.name ?? adjustLabel(type), {
  adjust: { type, ...ADJUST_DEFAULTS[type]?.() },
  ...patch,
})
export const newFill = (fill, patch = {}) => base('fill', patch.name ?? (fill.type === 'solid' ? 'Color Fill' : 'Gradient Fill'), { fill, ...patch })
export const newSmart = (smart, bounds, patch = {}) => base('smart', patch.name ?? smart.name ?? 'Smart Object', { smart, bounds, ...patch })

export const ADJUST_DEFAULTS = {
  // detail starts at zero: Develop's defaults (sharpen 40, chroma NR 25) are
  // for RAW captures, not for a composite
  develop: () => ({ modules: { detail: { sharpenAmount: 0, sharpenRadius: 1, sharpenMasking: 0, lumaNR: 0, chromaNR: 0, aiDenoise: 0 } } }),
  curves: () => ({ curves: { master: [[0, 0], [1, 1]] } }),
  levels: () => ({ channel: 'rgb', params: { inBlack: 0, inWhite: 1, gamma: 1, outBlack: 0, outWhite: 1 } }),
  brightness: () => ({ params: { brightness: 0, contrast: 0 } }),
  exposure: () => ({ params: { exposure: 0, offset: 0, gamma: 1 } }),
  huesat: () => ({ params: { hue: 0, saturation: 0, lightness: 0, colorize: false, cHue: 30, cSat: 25 } }),
  mixer: () => ({ params: { mono: false, matrix: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]] } }),
  photofilter: () => ({ params: { color: [0.925, 0.541, 0.0], density: 25, preserve: true } }),
  gradmap: () => ({ stops: [{ t: 0, color: [0, 0, 0, 1] }, { t: 1, color: [1, 1, 1, 1] }] }),
  invert: () => ({}),
  posterize: () => ({ params: { levels: 4 } }),
  threshold: () => ({ params: { level: 128 } }),
}

export const TEXT_DEFAULTS = {
  content: 'Text',
  font: 'IBM Plex Sans',
  weight: 400,
  size: 96, // px
  tracking: 0, // 1/1000 em
  leading: 1.2, // × size
  kerning: true, // GPOS kern feature
  ligatures: true,
  align: 'start', // start | center | end | justify
  direction: 'auto', // auto | ltr | rtl
  color: [1, 1, 1, 1],
  width: 0, // 0 = point text (no wrapping), else box width in px
}
// the margin a type layer's raster keeps around its glyphs (overhangs, accents)
export const textPad = (size) => Math.ceil(size * 0.35) + 2

export const newText = (x, y, text = {}, patch = {}) => base('text', patch.name ?? (text.content ?? 'Text').slice(0, 24), {
  text: { ...TEXT_DEFAULTS, ...text },
  bounds: { x, y, w: 1, h: 1 }, // the engine sets the real extent after shaping
  ...patch,
})

export const SHAPE_DEFAULTS = {
  type: 'rect', // rect | ellipse | polygon | line
  w: 400, h: 300, radius: 0, sides: 6, star: 0, // star 0..1 inner indent
  fill: [0.9, 0.9, 0.9, 1],
  stroke: null, // { width, color, align: 'center'|'inside'|'outside' }
}
export const newShape = (x, y, shape = {}, patch = {}) => base('shape', patch.name ?? 'Shape', {
  shape: { ...SHAPE_DEFAULTS, ...shape },
  bounds: { x, y, w: shape.w ?? SHAPE_DEFAULTS.w, h: shape.h ?? SHAPE_DEFAULTS.h },
  ...patch,
})

export const STYLE_DEFAULTS = {
  shadow: { type: 'shadow', enabled: true, color: [0, 0, 0, 1], opacity: 0.6, angle: 120, distance: 12, size: 16, spread: 0, blend: 'multiply' },
  stroke: { type: 'stroke', enabled: true, color: [1, 1, 1, 1], opacity: 1, size: 4, position: 'outside' },
  glow: { type: 'glow', enabled: true, color: [1, 0.95, 0.7, 1], opacity: 0.6, size: 24, spread: 0, blend: 'screen' },
}

export const newDoc = (width, height, { depth = 16, name = 'Untitled' } = {}) => ({
  id: newId('cd'),
  name,
  width: Math.max(1, Math.round(width)),
  height: Math.max(1, Math.round(height)),
  depth,
  nodes: [],
  activeId: null,
  rev: 1,
})

// ── tree helpers ───────────────────────────────────────────────────────────
// every walk visits bottom → top, depth first

export function walk(nodes, fn, parent = null) {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    if (fn(n, parent, i) === false) return false
    if (n.kind === 'group' && walk(n.children ?? [], fn, n) === false) return false
  }
  return true
}

export function findNode(nodes, id) {
  let hit = null
  walk(nodes, (n, parent, index) => {
    if (n.id === id) { hit = { node: n, parent, index, list: parent ? parent.children : nodes }; return false }
    return true
  })
  return hit
}

export const allNodes = (nodes) => {
  const out = []
  walk(nodes, (n) => { out.push(n) })
  return out
}

export const countLayers = (nodes) => allNodes(nodes).length

// the top-level index containing id (for the compositor's below-cache)
export function topIndexOf(nodes, id) {
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].id === id) return i
    if (nodes[i].kind === 'group' && findNode(nodes[i].children ?? [], id)) return i
  }
  return -1
}

export const isDrawable = (n) => n.kind === 'pixel' || n.kind === 'smart' || n.kind === 'text' || n.kind === 'shape'
export const hasPixels = (n) => n.kind === 'pixel'
