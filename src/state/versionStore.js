import { useSyncExternalStore } from 'react'
import { newEditDoc } from '../engine/editdoc.js'
import { getState as getEditState, switchDoc, commitDocMeta } from './editStore.js'
import {
  listDocs, loadDocVersion, deleteDocVersion, saveDocNow, flushSaves,
} from './catalogStore.js'

// Versions = Lightroom's virtual copies, simplified. The sidecar/doc model
// already keys by (photoId, versionId); this store owns the list for the
// photo currently open in Develop. Names live inside the doc (doc.versionName)
// so a version is one self-contained sidecar file.

let state = {
  photoId: null,
  versions: [], // [{ versionId, name, updatedAt }] — v_default first
}
const listeners = new Set()
const emit = () => { for (const fn of listeners) fn() }
const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn) }
export const useVersions = () => useSyncExternalStore(subscribe, () => state)
export const getVersionState = () => state

export const versionLabel = (v) =>
  v.name ?? (v.versionId === 'v_default' ? 'Original edit' : 'Untitled version')

export const currentVersionId = () => getEditState().doc?.versionId ?? 'v_default'

export async function refreshVersions(photoId) {
  if (photoId == null) {
    state = { photoId: null, versions: [] }
    emit()
    return
  }
  const versions = await listDocs(photoId)
  // a fresh doc lives only in memory until the write-behind flushes — the
  // current version must still show up in the list
  const es = getEditState()
  if (es.photo?.id === photoId && es.doc) {
    const vid = es.doc.versionId ?? 'v_default'
    if (!versions.some((v) => v.versionId === vid)) {
      const row = { versionId: vid, name: es.doc.versionName ?? null, updatedAt: Date.now() }
      vid === 'v_default' ? versions.unshift(row) : versions.push(row)
    }
  }
  state = { photoId, versions }
  emit()
}

// Duplicate the current doc under v_<timestamp> and switch to it.
export async function createVersion() {
  const { photo, doc } = getEditState()
  if (!photo || !doc) return
  await flushSaves(photo.id) // outgoing version persists first
  const copy = JSON.parse(JSON.stringify(doc))
  copy.versionId = 'v_' + Date.now()
  copy.versionName = `Version ${state.versions.length + 1}`
  await saveDocNow(photo.id, copy)
  switchDoc(copy)
  await refreshVersions(photo.id)
}

// loadDoc(photoId, versionId) → switchDoc: no re-decode, params only.
export async function switchVersion(versionId) {
  const { photo, doc } = getEditState()
  if (!photo || !doc || versionId === (doc.versionId ?? 'v_default')) return
  await flushSaves(photo.id)
  let next = await loadDocVersion(photo.id, versionId)
  if (!next) next = { ...newEditDoc(photo.id), versionId }
  switchDoc(next)
  await refreshVersions(photo.id)
}

export async function renameVersion(versionId, name) {
  const { photo, doc } = getEditState()
  if (!photo || !name) return
  if (doc && versionId === (doc.versionId ?? 'v_default')) {
    commitDocMeta({ versionName: name }) // rides undo + write-behind
    await flushSaves(photo.id)
  } else {
    const target = await loadDocVersion(photo.id, versionId)
    if (!target) return
    await saveDocNow(photo.id, { ...target, versionName: name })
  }
  await refreshVersions(photo.id)
}

// Guard: the last version can never be deleted. Deleting the current version
// switches to the first remaining one before removing the sidecar.
export async function deleteVersion(versionId) {
  const { photo } = getEditState()
  if (!photo || state.versions.length <= 1) return
  if (versionId === currentVersionId()) {
    const other = state.versions.find((v) => v.versionId !== versionId)
    if (!other) return
    await switchVersion(other.versionId)
  }
  await deleteDocVersion(photo.id, versionId)
  await refreshVersions(photo.id)
}
