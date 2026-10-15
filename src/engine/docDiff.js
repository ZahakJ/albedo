import { MODULE_DEFAULTS } from './editdoc.js'

// Pure diff between two consecutive edit docs → one terse history label.
// Label rules, in precedence order:
//   1. snapshots list grew            → 'Snapshot: <name>'  (the save step)
//   2. state lands exactly on a
//      stored snapshot's modules+masks → 'Snapshot: <name>' (the restore step)
//   3. only masks changed             → 'Mask: <name> added|removed|moved|edited'
//   4. several modules changed        → 'Auto tone' when only exposure/tone
//                                       moved together, else 'N modules'
//                                       (presets, paste, auto adjustments)
//   5. one module changed             → module/key label; single numeric key
//                                       carries its new value ('Exposure +0.85')
//   6. nothing but versionName        → 'Renamed'

const eq = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

const MODULE_LABELS = {
  exposure: 'Exposure', tone: 'Tone', wb: 'White balance', curve: 'Curve',
  colormix: 'Mixer', vibsat: 'Color', localcontrast: 'Effects',
  vignette: 'Vignette', grading: 'Grading', bw: 'B&W', grain: 'Grain',
  geometry: 'Crop', detail: 'Detail', heal: 'Heal', lens: 'Lens',
  recon: 'Highlights',
}

// key → label (+ decimals for the value suffix; default 0)
const KEY_LABELS = {
  exposure: { ev: ['Exposure', 2], black: 'Black level' },
  tone: { contrast: 'Contrast', highlights: 'Highlights', shadows: 'Shadows', whites: 'Whites', blacks: 'Blacks' },
  wb: { temp: 'Temp', tint: 'Tint' },
  vibsat: { vibrance: 'Vibrance', saturation: 'Saturation' },
  localcontrast: { clarity: 'Clarity', texture: 'Texture', dehaze: 'Dehaze' },
  vignette: { amount: 'Vignette', midpoint: 'Vignette midpoint', roundness: 'Vignette roundness', feather: 'Vignette feather' },
  grain: { amount: 'Grain', size: 'Grain size', roughness: 'Grain roughness' },
  detail: {
    sharpenAmount: 'Sharpen', sharpenRadius: ['Sharpen radius', 1],
    sharpenMasking: 'Sharpen masking', lumaNR: 'NR luma', chromaNR: 'NR chroma',
  },
  lens: {
    distortion: 'Distortion', caRed: 'CA red', caBlue: 'CA blue', defringe: 'Defringe',
  },
  heal: { spots: 'Heal spots' },
  recon: { on: 'Highlight recovery' },
}

// first mask difference wins — commits touch one mask at a time
function diffMasks(a, b) {
  const am = new Map(a.map((m) => [m.id, m]))
  const bm = new Map(b.map((m) => [m.id, m]))
  for (const m of b) if (!am.has(m.id)) return `Mask: ${m.name} added`
  for (const m of a) if (!bm.has(m.id)) return `Mask: ${m.name} removed`
  for (const m of b) {
    const o = am.get(m.id)
    if (!eq(o.geom, m.geom)) return `Mask: ${m.name} moved`
    if (!eq(o, m)) return `Mask: ${m.name} edited`
  }
  return null
}

function labelModule(m, keys, mod) {
  if (m === 'curve') return 'Curve'
  if (m === 'grading') return 'Grading'
  if (m === 'colormix') return keys.length === 1 ? `Mixer: ${keys[0]}` : 'Mixer'
  if (m === 'bw') return keys.includes('on') ? (mod.on ? 'B&W on' : 'B&W off') : 'B&W mix'
  if (m === 'geometry') {
    if (keys.length === 1 && keys[0] === 'angle') return 'Straighten'
    if (keys.length === 1 && keys[0] === 'flipH') return 'Flip'
    if (keys.length === 1 && keys[0] === 'persp') return 'Perspective'
    return 'Crop'
  }
  if (keys.length > 1) return MODULE_LABELS[m] ?? m
  const spec = KEY_LABELS[m]?.[keys[0]]
  const [label, decimals] = Array.isArray(spec) ? spec : [spec ?? `${m}.${keys[0]}`, 0]
  const v = mod[keys[0]]
  if (typeof v !== 'number') return label
  return `${label} ${v > 0 ? '+' : ''}${v.toFixed(decimals)}`
}

export function describeDiff(prev, next) {
  if (!prev || !next) return 'Edit'
  const ns = next.snapshots ?? []
  if (ns.length > (prev.snapshots ?? []).length) return `Snapshot: ${ns[ns.length - 1].name}`

  // module diff over the union of keys — an absent module means defaults
  const mods = new Set([...Object.keys(prev.modules ?? {}), ...Object.keys(next.modules ?? {})])
  const changed = [] // [module, changedKeys, mergedNextModule]
  for (const m of mods) {
    const a = { ...MODULE_DEFAULTS[m], ...prev.modules?.[m] }
    const b = { ...MODULE_DEFAULTS[m], ...next.modules?.[m] }
    const keys = Object.keys({ ...a, ...b }).filter((k) => !eq(a[k], b[k]))
    if (keys.length) changed.push([m, keys, b])
  }
  const maskLabel = diffMasks(prev.masks ?? [], next.masks ?? [])
  const n = changed.length + (maskLabel ? 1 : 0)

  if (n > 0) {
    for (const s of ns) {
      if (eq(s.modules ?? {}, next.modules ?? {}) && eq(s.masks ?? [], next.masks ?? []))
        return `Snapshot: ${s.name}`
    }
  }
  if (n === 0) return eq(prev.versionName, next.versionName) ? 'Edit' : 'Renamed'
  if (changed.length === 0) return maskLabel
  if (n > 1) {
    if (!maskLabel && changed.every(([m]) => m === 'exposure' || m === 'tone')) return 'Auto tone'
    return `${n} modules`
  }
  return labelModule(...changed[0])
}
