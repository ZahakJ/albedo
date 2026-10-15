import { useSyncExternalStore } from 'react'
import { onRenderEvent } from './renderClient.js'
import { MSG } from '../workers/protocol.js'

// The lens profile the render worker found for the open RAW ({ name, maker,
// distortion: [a1..a4] | null } or null), for the Lens panel and the crop
// overlay's auto-fit.
let state = { photoId: null, lens: null }
const subs = new Set()
let wired = false
const wire = () => {
  if (wired) return
  wired = true
  onRenderEvent((d) => {
    if (d.type !== MSG.LENS) return
    state = { photoId: d.photoId, lens: d.lens }
    for (const fn of subs) fn()
  })
}

export const getLens = (photoId) => (state.photoId === photoId ? state.lens : null)

export function useLens(photoId) {
  wire()
  return useSyncExternalStore((fn) => { subs.add(fn); return () => subs.delete(fn) },
    () => getLens(photoId))
}

// distortion terms as the worker applies them, for geometry.fitScaleFor
export function lensTerms(lens, doc) {
  const m = doc?.modules?.lens
  if (!lens?.distortion || !(m?.profile ?? 1)) return null
  const k = (m?.profDistortion ?? 100) / 100
  return lens.distortion.map((a) => a * k)
}
