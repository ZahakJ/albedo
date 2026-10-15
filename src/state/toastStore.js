import { useSyncExternalStore } from 'react'

// Tiny transient-notice store: toast('Imported 23 photos', { action: { label:
// 'View', run } }). Bottom-center stack, auto-dismiss (4s default). Generic on
// purpose — import done, export done, preset saved all ride it.

let state = { toasts: [] } // [{ id, message, action: { label, run } | null }]
const listeners = new Set()
const emit = () => { for (const fn of listeners) fn() }
const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn) }
export const useToasts = () => useSyncExternalStore(subscribe, () => state)

let nextId = 1
const timers = new Map()

export function toast(message, { action = null, timeout = 4000 } = {}) {
  const id = nextId++
  state = { ...state, toasts: [...state.toasts, { id, message, action }] }
  emit()
  timers.set(id, setTimeout(() => dismissToast(id), timeout))
  return id
}

export function dismissToast(id) {
  if (!state.toasts.some((t) => t.id === id)) return
  clearTimeout(timers.get(id))
  timers.delete(id)
  state = { ...state, toasts: state.toasts.filter((t) => t.id !== id) }
  emit()
}
