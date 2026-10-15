import { useSyncExternalStore } from 'react'
import { onRenderEvent, sendDenoisePort } from './renderClient.js'
import { denoisePayload, cancelDenoise } from './segmentClient.js'
import { loadOriginal } from './catalogStore.js'
import { decode } from './decodeClient.js'
import { MSG } from '../workers/protocol.js'

// AI denoise of the open RAW. The model needs the mosaic, which the render
// worker no longer holds, so the file is decoded once more and handed to the
// AI worker, which streams denoised tiles straight to the render worker over
// a MessageChannel. Runs once per opened photo; the Amount slider only
// blends, it never re-runs the model.

let state = { photoId: null, status: 'idle', done: 0, total: 0, error: null }
const subs = new Set()
const emit = (patch) => { state = { ...state, ...patch }; for (const fn of subs) fn() }
export const useDenoise = () => useSyncExternalStore((fn) => { subs.add(fn); return () => subs.delete(fn) }, () => state)

let wired = false
const wire = () => {
  if (wired) return
  wired = true
  onRenderEvent((d) => {
    if (d.type !== MSG.DN_STATE || d.photoId !== state.photoId) return
    emit(d.ready ? { status: 'ready' } : { status: 'running', done: d.done, total: d.total })
  })
}

// photo: { id, isRaw }; idempotent per photo
export async function ensureDenoised(photo) {
  wire()
  if (!photo?.isRaw) return
  if (state.photoId === photo.id && state.status !== 'error' && state.status !== 'idle') return
  if (state.status === 'running') cancelDenoise()
  emit({ photoId: photo.id, status: 'running', done: 0, total: 0, error: null })
  try {
    const { buffer, name } = await loadOriginal(photo.id)
    const payload = await decode(photo.id, buffer, name, 'full')
    if (state.photoId !== photo.id) return
    if (payload.kind !== 'mosaic') {
      emit({ status: 'unsupported' })
      return
    }
    const { port1, port2 } = new MessageChannel()
    sendDenoisePort(photo.id, port1)
    await denoisePayload(payload, port2)
  } catch (err) {
    if (state.photoId === photo.id) emit({ status: 'error', error: String(err?.message ?? err) })
  }
}

// a photo closes: its denoise is moot
export function resetDenoise() {
  if (state.status === 'running') cancelDenoise()
  emit({ photoId: null, status: 'idle', done: 0, total: 0, error: null })
}

export const getDenoiseState = () => state
