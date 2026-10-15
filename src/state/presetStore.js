import { writePresetXmp } from '../io/xmpWrite.js'
import { useSyncExternalStore } from 'react'
import { MODULE_DEFAULTS, newEditDoc } from '../engine/editdoc.js'
import { presetList, presetSave, presetDelete, loadDoc, saveDoc } from './catalogStore.js'
import { getState as getEditState, mergeModules, applyModules } from './editStore.js'
import { BUILTIN_PRESETS, parsePresetFile, serializePresets, presetFileName } from './presetFormat.js'
import { parseXmp, xmpSummary } from '../io/xmp.js'
import { sanitizeModules } from './presetFormat.js'

// Presets + the settings clipboard. Semantics: a preset stores a SUBSET of
// modules; apply replaces exactly those keys and leaves the rest of the doc.
// A checked-but-default group is stored AS defaults, so applying it resets
// that group on the target (LR behavior); mergeModules drops default values.

// UI checkbox groups → EditDoc module keys. The 'masks' group is special: it
// maps doc.masks wholesale (mergeModules replaces the array when present) and
// is copyOnly — geometry-anchored masks travel photo→photo via ⌘C/⌘V, not
// presets, so the rail filters it out.
export const GROUPS = [
  { id: 'tone', label: 'Tone', modules: ['exposure', 'tone'] },
  { id: 'wb', label: 'WB', modules: ['wb'] },
  { id: 'curve', label: 'Curve', modules: ['curve'] },
  { id: 'color', label: 'Color', modules: ['vibsat'] },
  { id: 'mixer', label: 'Mixer', modules: ['colormix'] },
  { id: 'effects', label: 'Effects', modules: ['localcontrast', 'vignette', 'grading', 'bw', 'grain'] },
  { id: 'masks', label: 'Masks', modules: [], masks: true, copyOnly: true },
]

export const nonDefaultGroupIds = (doc) =>
  GROUPS.filter((g) => g.masks
    ? (doc?.masks ?? []).length > 0
    : g.modules.some((m) => doc?.modules[m] != null)).map((g) => g.id)

// checked groups → modules subset (doc value when present, defaults otherwise)
export function pickGroups(doc, groupIds) {
  const out = {}
  for (const g of GROUPS) {
    if (!groupIds.includes(g.id)) continue
    if (g.masks) { out.masks = JSON.parse(JSON.stringify(doc?.masks ?? [])); continue }
    for (const m of g.modules)
      out[m] = JSON.parse(JSON.stringify(doc?.modules[m] ?? MODULE_DEFAULTS[m]))
  }
  return out
}

// ── store (editStore shape) ────────────────────────────────────────────────

let state = { presets: [], loaded: false }
const listeners = new Set()
const emit = () => { for (const fn of listeners) fn() }
const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn) }
export const usePresets = () => useSyncExternalStore(subscribe, () => state)
export const getPresetState = () => state

const byName = (a, b) => a.name.localeCompare(b.name)
const uid = () => 'ps_' + crypto.randomUUID().replaceAll('-', '').slice(0, 16)

export async function loadPresets() {
  if (state.loaded) return
  state = { ...state, loaded: true }
  try {
    const presets = await presetList()
    state = { ...state, presets }
    emit()
  } catch (err) {
    state = { ...state, loaded: false } // retry on next mount
    console.error('[presets] list', err)
  }
}

export { BUILTIN_PRESETS }
// user presets first (the ones you made), then the built-in looks
export const allPresets = (s = state) => [...s.presets, ...BUILTIN_PRESETS]
export const findPreset = (id) => allPresets().find((p) => p.id === id) ?? null

// All writes are optimistic; the worker write is fire-and-forget.
export function savePreset(name, modules, { group = '', source = 'user' } = {}) {
  const preset = { id: uid(), name, group, source, createdAt: Date.now(), modules }
  state = { ...state, presets: [...state.presets, preset].sort(byName) }
  emit()
  presetSave(preset).catch((err) => console.error('[presets] save', err))
  return preset
}

export function renamePreset(id, name) {
  const p = state.presets.find((q) => q.id === id)
  if (!p || p.name === name) return
  const next = { ...p, name }
  state = { ...state, presets: state.presets.map((q) => (q.id === id ? next : q)).sort(byName) }
  emit()
  presetSave(next).catch((err) => console.error('[presets] rename', err))
}

// Reads .json / .xmp preset files; returns one short line for a toast.
export async function importPresetFiles(files) {
  let added = 0
  const unmapped = new Set()
  const errors = []
  for (const f of files) {
    const r = parsePresetFile(await f.text(), f.name)
    if (r.error) errors.push(r.error)
    for (const u of r.unmapped) unmapped.add(u)
    for (const p of r.presets) {
      savePreset(uniqueName(p.name), p.modules, { group: p.group, source: p.source })
      added++
    }
  }
  const parts = []
  if (added) parts.push(`Imported ${added} preset${added === 1 ? '' : 's'}`)
  if (errors.length) parts.push(errors.length === 1 ? errors[0] : `${errors.length} files skipped`)
  const miss = xmpSummary([...unmapped])
  if (miss) parts.push(miss)
  return { added, message: parts.join(' · ') || 'Nothing to import' }
}

// "Name", "Name 2", "Name 3"… against the user's presets
function uniqueName(name) {
  const taken = new Set(state.presets.map((p) => p.name))
  if (!taken.has(name)) return name
  let n = 2
  while (taken.has(`${name} ${n}`)) n++
  return `${name} ${n}`
}

export function exportPresets(presets) {
  if (!presets.length) return
  const blob = new Blob([serializePresets(presets)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = presetFileName(presets)
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

// one preset as a Lightroom / Camera Raw preset (.xmp); what Lightroom
// cannot hold rides along in the albedo namespace
export function exportPresetXmp(p) {
  const text = writePresetXmp(p.name, p.group || 'albedo', p.modules, { albedo: true })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/rdf+xml' }))
  a.download = `${p.name.replace(/[\\/:*?"<>|]+/g, '_')}.xmp`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

export function deletePreset(id) {
  state = { ...state, presets: state.presets.filter((p) => p.id !== id) }
  emit()
  presetDelete(id).catch((err) => console.error('[presets] delete', err))
}

// ── settings clipboard (in-memory, session-scoped) ─────────────────────────

let clipboard = null // modules subset | null
export const setClipboard = (modules) => { clipboard = modules }
export const getClipboard = () => clipboard

// Library paste: per-photo merge onto the saved doc (fresh doc when none).
// The currently-open develop photo routes through editStore so its history
// and canvas stay coherent.
export async function pasteToPhotos(photoIds, modules) {
  for (const id of photoIds) {
    if (getEditState().photo?.id === id) { applyModules(modules); continue }
    const base = (await loadDoc(id).catch(() => null)) ?? newEditDoc(id)
    saveDoc(id, mergeModules(base, modules))
  }
}

// Preset → many photos: one merge per photo, same path as paste.
export const applyPresetToPhotos = (preset, photoIds) => pasteToPhotos(photoIds, preset.modules)

// Lightroom sidecars dropped with their photos: IMG_1.xmp or IMG_1.CR2.xmp
// pairs with IMG_1.CR2 from the same import. Returns the .xmp files that
// matched no photo (the caller imports those as presets).
const stem = (n) => n.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '').toLowerCase()
export async function applyXmpSidecars(xmpFiles, imported) {
  const byStem = new Map()
  for (const p of imported) {
    byStem.set(stem(p.name), p.id)
    byStem.set(p.name.toLowerCase(), p.id)
  }
  let applied = 0
  const unmapped = new Set()
  const rest = []
  for (const f of xmpFiles) {
    const id = byStem.get(stem(f.name))
    if (id == null) { rest.push(f); continue }
    const r = parseXmp(await f.text())
    const modules = sanitizeModules(r.modules)
    for (const u of r.unmapped) unmapped.add(u)
    if (!Object.keys(modules).length) continue
    saveDoc(id, mergeModules(newEditDoc(id), modules))
    applied++
  }
  return { applied, rest, unmapped: [...unmapped] }
}
