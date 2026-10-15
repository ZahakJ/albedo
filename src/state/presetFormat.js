// Preset files and built-in looks. Pure (no DOM, no stores) so it runs under
// node:test as well as in the app.
//
// File format (.json):
//   { "format": "albedo-presets", "version": 1,
//     "presets": [{ "name": "...", "group": "...", "modules": { ... } }] }
// `modules` is an EditDoc modules subset: applying a preset replaces exactly
// those modules on the target and leaves the rest. Lightroom/ACR .xmp files
// (presets or sidecars) import through io/xmp.js.

import { MODULE_DEFAULTS } from '../engine/editdoc.js'
import { parseXmp } from '../io/xmp.js'

export const PRESET_FORMAT = 'albedo-presets'
export const PRESET_FILE_VERSION = 1

const clone = (v) => JSON.parse(JSON.stringify(v))

// Structural deep-merge onto defaults, keeping only keys the default knows and
// only values of the default's type. Unknown modules are dropped. Curve points
// and heal spots are arrays and pass through when they are arrays.
function cleanValue(def, v) {
  if (Array.isArray(def)) return Array.isArray(v) ? clone(v) : clone(def)
  if (def && typeof def === 'object') {
    const out = {}
    for (const k of Object.keys(def)) out[k] = cleanValue(def[k], v?.[k])
    return out
  }
  if (typeof def === 'number') return typeof v === 'number' && Number.isFinite(v) ? v : def
  return typeof v === typeof def ? v : def
}

export function sanitizeModules(modules) {
  const out = {}
  if (!modules || typeof modules !== 'object') return out
  for (const [k, v] of Object.entries(modules)) {
    if (!(k in MODULE_DEFAULTS) || k === 'heal') continue // spots are per-photo
    out[k] = cleanValue(MODULE_DEFAULTS[k], v)
  }
  return out
}

export function serializePresets(presets) {
  return JSON.stringify({
    format: PRESET_FORMAT,
    version: PRESET_FILE_VERSION,
    presets: presets.map((p) => ({
      name: p.name,
      ...(p.group ? { group: p.group } : {}),
      modules: p.modules,
    })),
  }, null, 2) + '\n'
}

export const presetFileName = (presets) =>
  presets.length === 1
    ? `${presets[0].name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'preset'}.albedo.json`
    : 'albedo-presets.json'

const baseName = (filename) => (filename ?? '').replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '').replace(/\.albedo$/, '')

// → { presets: [{ name, group, source, modules }], unmapped: string[], error?: string }
// Never throws: a bad file comes back with `error` and no presets.
export function parsePresetFile(text, filename = '') {
  const isXmp = /\.xmp$/i.test(filename) || /^\s*(<\?xpacket|<x:xmpmeta|<\?xml)/.test(text)
  if (isXmp) {
    const r = parseXmp(text)
    if (!Object.keys(r.modules).length) {
      return { presets: [], unmapped: r.unmapped, error: `${filename || 'XMP'}: no settings albedo can use` }
    }
    return {
      presets: [{
        name: r.name || baseName(filename) || 'Imported',
        group: 'Imported',
        source: 'xmp',
        modules: sanitizeModules(r.modules),
      }],
      unmapped: r.unmapped,
    }
  }
  let data
  try { data = JSON.parse(text) } catch { return { presets: [], unmapped: [], error: `${filename || 'File'}: not a preset file` } }
  // a bare single preset ({ name, modules }) is accepted too
  const list = data?.format === PRESET_FORMAT ? data.presets
    : data && typeof data === 'object' && data.modules ? [data]
    : null
  if (!Array.isArray(list)) return { presets: [], unmapped: [], error: `${filename || 'File'}: not a preset file` }
  if (data.format === PRESET_FORMAT && !(data.version >= 1 && data.version <= PRESET_FILE_VERSION)) {
    return { presets: [], unmapped: [], error: `${filename || 'File'}: preset file version ${data.version} is newer than this app` }
  }
  const presets = []
  for (const p of list) {
    const modules = sanitizeModules(p?.modules)
    if (!Object.keys(modules).length) continue
    presets.push({
      name: String(p.name ?? '').trim() || baseName(filename) || 'Imported',
      group: typeof p.group === 'string' ? p.group : '',
      source: 'import',
      modules,
    })
  }
  if (!presets.length) return { presets: [], unmapped: [], error: `${filename || 'File'}: no presets in file` }
  return { presets, unmapped: [] }
}

// ── built-in looks ─────────────────────────────────────────────────────────
// Each look covers the same "look" modules (tone, curve, color, local
// contrast, grading, B&W, grain), filled with defaults where it changes
// nothing, so stepping from one look to another never leaves the previous
// one behind. White balance, exposure and geometry are per-photo and stay put.

const LOOK_MODULES = ['tone', 'curve', 'vibsat', 'localcontrast', 'grading', 'bw', 'grain']
const BAND = (o) => ({ ...MODULE_DEFAULTS.bw.mix, ...o })

function look(id, name, patch) {
  const modules = {}
  for (const m of LOOK_MODULES) {
    const d = MODULE_DEFAULTS[m]
    const p = patch[m] ?? {}
    modules[m] = m === 'grading'
      ? {
        ...clone(d), ...p,
        shadows: { ...d.shadows, ...p.shadows },
        midtones: { ...d.midtones, ...p.midtones },
        highlights: { ...d.highlights, ...p.highlights },
      }
      : { ...clone(d), ...p }
  }
  return { id: `builtin:${id}`, name, group: 'Built-in', source: 'builtin', builtin: true, modules }
}

export const BUILTIN_PRESETS = [
  look('punchy', 'Punchy', {
    tone: { contrast: 25, highlights: -20, shadows: 15, whites: 10, blacks: -10 },
    vibsat: { vibrance: 25, saturation: 0 },
    localcontrast: { clarity: 15, texture: 10, dehaze: 0 },
  }),
  look('bright-airy', 'Bright & Airy', {
    tone: { contrast: -10, highlights: -30, shadows: 35, whites: 15, blacks: 10 },
    curve: { points: [[0, 0.04], [0.5, 0.56], [1, 1]] },
    vibsat: { vibrance: 10, saturation: -8 },
  }),
  look('soft-matte', 'Soft Matte', {
    tone: { contrast: -15, highlights: -10, shadows: 10, whites: 0, blacks: 0 },
    curve: { points: [[0, 0.08], [0.25, 0.25], [0.75, 0.76], [1, 0.95]] },
    vibsat: { vibrance: 0, saturation: -12 },
  }),
  look('warm-film', 'Warm Film', {
    tone: { contrast: 10, highlights: -15, shadows: 10, whites: 0, blacks: 0 },
    curve: { points: [[0, 0.05], [0.5, 0.5], [1, 0.97]] },
    vibsat: { vibrance: 5, saturation: -10 },
    grading: { shadows: { h: 200, s: 8 }, highlights: { h: 70, s: 18 }, blending: 60 },
    grain: { amount: 22, size: 30, roughness: 50 },
  }),
  look('cool-fade', 'Cool Fade', {
    tone: { contrast: -5, highlights: -10, shadows: 15, whites: 0, blacks: 0 },
    curve: { points: [[0, 0.1], [0.5, 0.5], [1, 0.96]] },
    vibsat: { vibrance: 0, saturation: -18 },
    grading: { shadows: { h: 240, s: 16 }, midtones: { h: 220, s: 6 } },
  }),
  look('teal-orange', 'Teal & Orange', {
    tone: { contrast: 15, highlights: -10, shadows: 10, whites: 0, blacks: -5 },
    vibsat: { vibrance: 15, saturation: 0 },
    grading: { shadows: { h: 205, s: 28 }, highlights: { h: 60, s: 22 }, balance: 10 },
  }),
  look('bw-classic', 'B&W Classic', {
    tone: { contrast: 15, highlights: -10, shadows: 10, whites: 5, blacks: -5 },
    bw: { on: 1, mix: BAND({}) },
  }),
  look('bw-contrast', 'B&W High Contrast', {
    tone: { contrast: 40, highlights: -20, shadows: 10, whites: 15, blacks: -20 },
    localcontrast: { clarity: 20, texture: 10, dehaze: 0 },
    bw: { on: 1, mix: BAND({ red: 20, orange: 15, yellow: 10, blue: -30, aqua: -15 }) },
    grain: { amount: 15, size: 20, roughness: 60 },
  }),
]
