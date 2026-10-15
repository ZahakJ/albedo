// EditDoc — the parameter document that IS the edit. ~2KB of JSON per photo
// version; an absent module key means defaults, which means the pass is
// skipped entirely. Schema migrations run on load, never in place.

export const SCHEMA = 1

export const BAND_NAMES = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta']

export const MODULE_DEFAULTS = {
  wb: { temp: 0, tint: 0 },
  exposure: { ev: 0, black: 0 },
  tone: { contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0 },
  // curve points are [x,y] in 0..1, sorted by x; identity when absent
  curve: { points: [[0, 0], [1, 1]] },
  // 8 hue bands × hue-shift/saturation/luminance, each -100..100
  colormix: Object.fromEntries(BAND_NAMES.map((b) => [b, { h: 0, s: 0, l: 0 }])),
  vibsat: { vibrance: 0, saturation: 0 },
  // local contrast family: clarity (midtone punch), texture (fine detail),
  // dehaze; all -100..100
  localcontrast: { clarity: 0, texture: 0, dehaze: 0 },
  // post-crop creative vignette: amount -100..100, rest 0..100
  vignette: { amount: 0, midpoint: 50, roundness: 0, feather: 50 },
  // 3-way color grading: per-zone hue (deg 0..360) + strength s (0..100);
  // blending 0..100 widens the zone overlap, balance -100..100 shifts the
  // shadow/highlight pivots together
  grading: {
    shadows: { h: 0, s: 0 }, midtones: { h: 0, s: 0 }, highlights: { h: 0, s: 0 },
    blending: 50, balance: 0,
  },
  // B&W conversion: on 0|1 + per-hue-band luminance weights -100..100
  // (worker zeroes colormix/vibsat while on; grading applies after = toning)
  bw: { on: 0, mix: Object.fromEntries(BAND_NAMES.map((b) => [b, 0])) },
  // film grain (finish pass, display-referred): amount 0..100 (→ ±0.06 max
  // deviation), size 0..100 (→ 1..3 px at full res), roughness 0..100
  grain: { amount: 0, size: 25, roughness: 50 },
  // crop in source-normalized y-down coords; angle degrees -45..45 rotates
  // the image (CCW on screen) about the crop center; the engine auto-zooms so
  // the rotated window never shows past the frame (see engine/geometry.js).
  // persp: keystone correction -100..100 per axis (v converges/diverges
  // verticals, h horizontals) — a proper 3×3 homography about the source
  // center, composed innermost in the inverse map; auto-fit re-inscribes.
  geometry: { crop: { x: 0, y: 0, w: 1, h: 1 }, angle: 0, flipH: 0, persp: { v: 0, h: 0 } },
  // sharpen (output-referred unsharp) + wavelet denoise. NON-ZERO defaults
  // mirror Lightroom (sharpen 40/1.0, chroma NR 25): the module is 'default'
  // when it equals these values — hasEdits/presets keep working through the
  // structural compare above. RAW gets the defaults implicitly; the render
  // worker forces the whole family OFF for non-RAW bitmaps unless the module
  // is explicitly present (JPEGs are already sharpened/denoised in-camera).
  // aiDenoise 0..100 blends the AI-denoised capture (RAW, Bayer) over the
  // source and turns the wavelet NR off; 0 = off
  detail: { sharpenAmount: 40, sharpenRadius: 1.0, sharpenMasking: 0, lumaNR: 0, chromaNR: 25, aiDenoise: 0 },
  // heal/clone spots, source-normalized y-down (final source space, so spots
  // survive crop/rotate/lens changes): dx,dy = dest center, sx,sy = source
  // center, r = radius as a source-WIDTH fraction, feather 0..1 eats inward.
  // 'clone' pastes the source circle; 'heal' additionally matches the local
  // low-frequency level (4 blurSmall rim taps around dest minus source).
  // ≤32 spots render (uniform array budget); the engine warns beyond.
  heal: { spots: [] },
  // removal patches: areas refilled by inpainting, in final source space
  // like heal spots: { id, x, y, w, h (source-normalised rect), scale }.
  // The pixels live in OPFS beside AI masks (masks/{photoId}/{id}.png: rgb =
  // sRGB of linear ÷ scale, alpha = feathered hole); ≤16 render.
  remove: { patches: [] },
  // lens corrections: distortion -100..100 (k1 barrel/pincushion radial
  // remap), caRed/caBlue -100..100 (per-channel radial scale, ±0.5% at full),
  // defringe 0..100 (desaturate purple/green fringes at strong luma edges)
  // profile: 1 applies the lensfun calibration found for a RAW's lens
  // (distortion, lateral CA, vignetting), scaled by profDistortion and
  // profVignette (0..200, 100 = as measured)
  lens: { distortion: 0, caRed: 0, caBlue: 0, defringe: 0, profile: 1, profDistortion: 100, profVignette: 100 },
  // look (Lightroom's "profile"): the display transform. 'agx' tone-maps
  // scene-linear light with a highlight shoulder, after a baseline exposure
  // (stops) and with a chroma scale (100 = neutral); 'linear' clamps.
  // RAW gets these defaults implicitly; JPEG/PNG render 'linear' unless the
  // module is present (they are display-referred already).
  look: { profile: 'agx', baseline: 0.5, saturation: 110 },
  // highlight reconstruction (RAW only, demosaic pass): clipped channels
  // rebuilt from unclipped neighbors post-WB so blown areas roll to white
  // instead of magenta. Default ON — module absent means on.
  recon: { on: 1 },
}

// Local adjustment masks — doc.masks: [{ id, name, kind, enabled, invert,
// geom, adjust }]. All coords are SOURCE-normalized y-down, PRE-mirror (the
// same space as crop), so masks stay glued to image content when crop/rotate
// change and behave like crop under flip. geom by kind:
//   'linear': { x0,y0, x1,y1 } — weight 0 at p0 → 1 at p1 (full-feather
//             smoothstep along the axis)
//   'radial': { cx,cy, rx,ry, angle (deg), feather 0..1 } — rx/ry are
//             source-WIDTH fractions so rotation stays shape-true; weight 1
//             inside, feather eats inward from the edge
//   'brush':  { strokes: [{ pts: [[x,y,pressure]..], size, flow, erase }] }
//             — size is the stamp diameter as a source-WIDTH fraction;
//             strokes replay into a quarter-res rgba8 texture, one channel
//             per brush mask (brush+ai share the 4 channels; 8 masks total
//             on the GPU)
//   'ai':     { refine: 0..100 } — segmentation mask (extra top-level keys
//             model: 'subject' | 'sky' | 'background' (inverted subject) | 'object' (with its
//             SAM points/box), channel: informational). Weights are NOT in
//             the doc: quarter-res grayscale PNG in OPFS (masks/{photoId}/
//             {maskId}.png), replayed into a brushTex channel on open via
//             MSG.MASKTEX; renders through the brush path (kind 2). refine
//             gaussian-blurs the channel at merge time (σ = refine/100·8px
//             quarter-res) for edge softness.
// adjust (subset of the global modules, defaults 0): applied inside develop
// between local contrast and colormix, each term scaled by the mask weight.
// range (optional, on ANY mask kind): { luma: { lo, hi, softness } | null,
// color: { h, s, tol } | null } — refines the geometric weight in-shader:
// m *= lumaWindow(source display luma) * colorProximity(source OKLCh hue h /
// chroma s within tolerance tol 0..100). Absent key = no refinement.
export const MASK_ADJUST_DEFAULTS = {
  ev: 0, temp: 0, contrast: 0, highlights: 0, shadows: 0, saturation: 0, clarity: 0,
}

export const newMask = (kind, geom, name) => ({
  id: 'm_' + Math.random().toString(36).slice(2, 10),
  name,
  kind,
  enabled: true,
  invert: false,
  geom,
  adjust: { ...MASK_ADJUST_DEFAULTS },
})

export const newHealSpot = (mode, dx, dy, sx, sy, r) => ({
  id: 'h_' + Math.random().toString(36).slice(2, 10),
  mode, // 'heal' | 'clone'
  dx, dy, sx, sy, r,
  feather: 0.5,
})

export const newEditDoc = (photoId) => ({
  schema: SCHEMA,
  photoId,
  versionId: 'v_default',
  modules: {},
  masks: [],
})

export const getParam = (doc, module, key) =>
  doc.modules[module]?.[key] ?? MODULE_DEFAULTS[module][key]

// Returns a new doc; drops the module key entirely when back at all-defaults
// so "has edits" stays an honest question.
export function setParam(doc, module, key, value) {
  const merged = { ...MODULE_DEFAULTS[module], ...doc.modules[module], [key]: value }
  // values may be nested (curve points, colormix bands) — structural compare
  const isDefault = Object.entries(merged).every(
    ([k, v]) => JSON.stringify(v) === JSON.stringify(MODULE_DEFAULTS[module][k]))
  const modules = { ...doc.modules }
  if (isDefault) delete modules[module]
  else modules[module] = merged
  return { ...doc, modules }
}

export const hasEdits = (doc) => Object.keys(doc.modules).length > 0 || (doc.masks ?? []).length > 0

// Inverts the develop shaders' wb_mul model so a sampled PRE-develop linear
// patch [r,g,b] lands neutral: r·(1+0.25t) = b·(1−0.25t) = g·(1−0.25ti),
// t = temp/100. Shared by auto-WB (worker) and the eyedropper (UI).
export function wbNeutralize([r, g, b]) {
  const cl = (v) => Math.max(-100, Math.min(100, v))
  const temp = cl((400 * (b - r)) / Math.max(r + b, 1e-6))
  const mr = 1 + 0.25 * (temp / 100)
  const tint = cl(400 * (1 - (r * mr) / Math.max(g, 1e-6)))
  return { temp: Math.round(temp), tint: Math.round(tint) }
}
