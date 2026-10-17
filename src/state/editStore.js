import { useSyncExternalStore } from 'react'
import { newEditDoc, setParam, MODULE_DEFAULTS } from '../engine/editdoc.js'
import { sendParams as sendToRender } from './renderClient.js'
import { saveDoc as saveToCatalog } from './catalogStore.js'

// Plain-module store. During a slider gesture the DOM is updated directly and
// only the render worker hears about every frame; the store (and React)
// commit once, on gesture end — that's what keeps drags at 60fps.

let state = {
  photo: null, // { id, name, width, height }
  doc: null,
  backend: null,
  history: [], // undo ring of docs, coalesced per gesture
  historyAt: -1,
}
const listeners = new Set()

// A bound target redirects the store: Compose binds a Develop adjustment
// layer (sink renders and saves into the layer, not the photo), and an open
// smart object binds its embedded edit (Develop still renders it, but saves
// go to the smart object). bindTarget stashes Develop's own state;
// unbindTarget brings it back untouched.
let sink = null // { render: bool, preview(doc), commit(doc) }
let stash = null
const sendParams = (photoId, doc, gesture, flags) => {
  if (sink) {
    if (sink.render) sendToRender(photoId, doc, gesture, flags)
    if (gesture) sink.preview?.(doc)
    return
  }
  sendToRender(photoId, doc, gesture, flags)
}
const saveDoc = (photoId, doc) => {
  if (sink) { sink.commit(doc); return }
  saveToCatalog(photoId, doc)
}
export function bindTarget(photo, doc, target) {
  if (!sink) stash = state
  sink = target
  state = { ...state, photo, doc, history: [doc], historyAt: 0 }
  emit()
}
// the bound document changed from outside (Compose undo, another layer)
export function retargetDoc(doc) {
  if (!sink) return
  state = { ...state, doc }
  emit()
}
export function unbindTarget() {
  if (!sink) return
  sink = null
  state = { ...stash, backend: state.backend }
  stash = null
  emit()
}
export const isBound = () => !!sink

const emit = () => { for (const fn of listeners) fn() }
const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn) }
export const useEditState = () => useSyncExternalStore(subscribe, () => state)
export const getState = () => state

export function openPhotoState(photo, initialDoc = null) {
  const doc = initialDoc ?? newEditDoc(photo.id)
  state = { ...state, photo, doc, history: [doc], historyAt: 0 }
  emit()
}

export function setBackend(backend) {
  state = { ...state, backend }
  emit()
}

// Persistent per-send flags (before / clipOverlay) — must ride along on every
// params send or the render worker's overlay state would drop mid-gesture.
let sendFlags = {}
export function setSendFlags(patch) {
  sendFlags = { ...sendFlags, ...patch }
  if (state.photo && state.doc) sendParams(state.photo.id, state.doc, false, sendFlags)
}

// Called on every pointermove during a drag: renders, doesn't re-render React.
export function previewParam(module, key, value) {
  state.doc = setParam(state.doc, module, key, value)
  sendParams(state.photo.id, state.doc, true, sendFlags)
}

// Called on gesture end (or discrete input): commits to history + React.
export function commitParam(module, key, value) {
  commitDoc(setParam(state.doc, module, key, value))
}

// Shared commit tail: ONE history entry, render, persist, notify React.
function commitDoc(doc) {
  const history = [...state.history.slice(0, state.historyAt + 1), doc].slice(-200)
  state = { ...state, doc, history, historyAt: history.length - 1 }
  sendParams(state.photo.id, doc, false, sendFlags)
  saveDoc(state.photo.id, doc)
  emit()
}

// ── local adjustment masks — same preview/commit split as params ───────────
// previews render only (React untouched); every commit is one history entry.
const withMask = (masks, maskId, patch) =>
  masks.map((m) => (m.id === maskId ? { ...m, ...patch(m) } : m))

export function previewMasks(masks) {
  if (!state.photo || !state.doc) return
  state.doc = { ...state.doc, masks }
  sendParams(state.photo.id, state.doc, true, sendFlags)
}

export function commitMasks(masks) {
  if (!state.photo || !state.doc) return
  commitDoc({ ...state.doc, masks })
}

export const previewMaskParam = (maskId, key, value) =>
  previewMasks(withMask(state.doc.masks ?? [], maskId, (m) => ({ adjust: { ...m.adjust, [key]: value } })))

export const commitMaskParam = (maskId, key, value) =>
  commitMasks(withMask(state.doc.masks ?? [], maskId, (m) => ({ adjust: { ...m.adjust, [key]: value } })))

// geometry edits (gizmo drags, feather) commit through the same path
export const commitMaskGeom = (maskId, geom) =>
  commitMasks(withMask(state.doc.masks ?? [], maskId, () => ({ geom })))

// Pure preset/paste merge: replace exactly the listed module keys wholesale,
// leave the rest. A value structurally equal to defaults clears the key so
// "has edits" stays an honest question (mirrors setParam). The 'masks' key
// is not a module: when present it replaces doc.masks wholesale.
export function mergeModules(doc, subset) {
  const { masks, ...mods } = subset
  const modules = { ...doc.modules }
  for (const [m, v] of Object.entries(mods)) {
    if (JSON.stringify(v) === JSON.stringify(MODULE_DEFAULTS[m])) delete modules[m]
    else modules[m] = JSON.parse(JSON.stringify(v)) // never alias the preset
  }
  const out = { ...doc, modules }
  if (masks) out.masks = JSON.parse(JSON.stringify(masks))
  return out
}

// Commit-free whole-doc preview (preset hover): renders only. state.doc is
// never touched, so cancel is just re-sending the real doc.
export function previewDoc(doc) {
  if (state.photo) sendParams(state.photo.id, doc, true, sendFlags)
}
export function cancelPreviewDoc() {
  if (state.photo && state.doc) sendParams(state.photo.id, state.doc, false, sendFlags)
}

// Preset apply / paste: merge a modules subset (masks ride along when the
// subset carries them) and commit ONCE.
export function applyModules(subset) {
  if (!state.photo || !state.doc) return
  commitDoc(mergeModules(state.doc, subset))
}

// Reset to the original capture: every module and mask dropped in ONE history
// entry, so ⌘Z brings the whole edit back. Versions, snapshots and the doc's
// name survive — this resets the picture, not the paperwork.
export function resetAll() {
  if (!state.photo || !state.doc) return
  const { modules, masks, ...rest } = state.doc
  commitDoc({ ...rest, modules: {}, masks: [] })
}

// Reset one panel's worth of modules (TONE, WB, …). Absent key = defaults, so
// resetting is deletion. Masks are never touched here.
export function resetModules(names) {
  if (!state.photo || !state.doc) return
  const modules = { ...state.doc.modules }
  let hit = false
  for (const n of names) if (n in modules) { delete modules[n]; hit = true }
  if (hit) commitDoc({ ...state.doc, modules })
}

export const isModulesDefault = (doc, names) =>
  !names.some((n) => n in (doc?.modules ?? {}))

export function undo() { jumpTo(state.historyAt - 1) }
export function redo() { jumpTo(state.historyAt + 1) }

// History panel rows land anywhere in the ring; undo/redo are ±1 jumps.
export function jumpTo(at) {
  if (at < 0 || at >= state.history.length || at === state.historyAt) return
  const doc = state.history[at]
  state = { ...state, doc, historyAt: at }
  sendParams(state.photo.id, doc, false, sendFlags)
  saveDoc(state.photo.id, doc)
  emit()
}

// ── snapshots — named states stored INSIDE the doc (doc.snapshots) ─────────
// Save and restore are both ordinary commits: undoable, persisted, and the
// history panel labels them via docDiff's snapshot rules.

export function saveSnapshot(name) {
  if (!state.photo || !state.doc || !name) return
  const snap = {
    name,
    at: Date.now(),
    modules: JSON.parse(JSON.stringify(state.doc.modules)),
    masks: JSON.parse(JSON.stringify(state.doc.masks ?? [])),
  }
  commitDoc({ ...state.doc, snapshots: [...(state.doc.snapshots ?? []), snap] })
}

export function restoreSnapshot(snap) {
  if (!state.photo || !state.doc || !snap) return
  commitDoc({
    ...state.doc,
    modules: JSON.parse(JSON.stringify(snap.modules ?? {})),
    masks: JSON.parse(JSON.stringify(snap.masks ?? [])),
  })
}

// ── versions ───────────────────────────────────────────────────────────────

// Version switch: swap doc + history without touching photo/texture — the
// source is already on the GPU, only the params change. No save here: the
// incoming doc is already persisted (and the outgoing one was flushed).
export function switchDoc(doc) {
  if (!state.photo || !doc) return
  state = { ...state, doc, history: [doc], historyAt: 0 }
  sendParams(state.photo.id, doc, false, sendFlags)
  emit()
}

// Doc metadata (versionName) — one history entry through the normal commit
// tail, so a rename is undoable and persists like any edit.
export function commitDocMeta(patch) {
  if (!state.photo || !state.doc) return
  commitDoc({ ...state.doc, ...patch })
}
