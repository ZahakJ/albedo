import { useSyncExternalStore } from 'react'
import { parseDcp } from '../io/dcp.js'
import { saveProfileBytes, listProfileBytes, deleteProfileBytes } from './catalogStore.js'
import { sendProfile } from './renderClient.js'

// Imported DCP camera profiles (Adobe's, RawTherapee's, or any DNG-spec
// profile). Bytes live in OPFS; this store keeps their names and cameras for
// the Profile menu and hands bytes to the render worker when a doc names one
// (look.profile 'dcp:<id>').

let state = { profiles: [] } // [{ id, name, camera, bytes }]
const subs = new Set()
const emit = (patch) => { state = { ...state, ...patch }; for (const fn of subs) fn() }
export const useProfiles = () => useSyncExternalStore((fn) => { subs.add(fn); return () => subs.delete(fn) }, () => state)
export const getProfiles = () => state.profiles

const sent = new Set()
const entryOf = (id, bytes) => {
  const p = parseDcp(bytes)
  return { id, name: p.name || 'Camera profile', camera: p.uniqueCameraModel || '', bytes }
}

export async function loadProfiles() {
  const list = await listProfileBytes().catch(() => [])
  const out = []
  for (const { id, buffer } of list) {
    try { out.push(entryOf(id, buffer)) } catch { /* not a profile after all */ }
  }
  emit({ profiles: out.sort((a, b) => a.name.localeCompare(b.name)) })
}

// files: .dcp File objects → { added, skipped }
export async function importProfiles(files) {
  let added = 0
  let skipped = 0
  const next = [...state.profiles]
  for (const f of files) {
    try {
      const bytes = await f.arrayBuffer()
      const id = 'dcp_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16)
      const e = entryOf(id, bytes)
      await saveProfileBytes(id, bytes.slice(0))
      next.push(e)
      added++
    } catch { skipped++ }
  }
  emit({ profiles: next.sort((a, b) => a.name.localeCompare(b.name)) })
  return { added, skipped }
}

export async function deleteProfile(id) {
  await deleteProfileBytes(id)
  sent.delete(id)
  emit({ profiles: state.profiles.filter((p) => p.id !== id) })
}

// make sure the render worker has the profile a doc names
export function ensureProfileSent(look) {
  const id = look?.profile?.startsWith('dcp:') ? look.profile.slice(4) : null
  if (!id || sent.has(id)) return
  const p = state.profiles.find((q) => q.id === id)
  if (!p) return
  sendProfile(id, p.bytes)
  sent.add(id)
}

// does this profile belong to that camera? DCPs name it as "Make Model"
// with the maker's own spelling and case
export const fitsCamera = (p, camera) => {
  const norm = (s) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const a = norm(p.camera)
  const b = norm(camera)
  return !!a && !!b && (a === b || a.endsWith(b) || b.endsWith(a))
}
