import { useSyncExternalStore } from 'react'
import { setSendFlags } from '../state/editStore.js'

// View-only Develop flags (before-state, clip overlay, split before/after).
// The render side hears about them via editStore.setSendFlags so they
// survive slider gestures. splitView: 'off' | 'h' | 'v' — Y cycles off↔h,
// ⇧Y cycles off↔v (SplitView.jsx owns the keys + divider handle); splitPos
// is the divider position 0..1 along the split axis. Export never sees them.

let flags = { before: false, clipOverlay: false, splitView: 'off', splitPos: 0.5 }
const listeners = new Set()
const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn) }
export const useDevFlags = () => useSyncExternalStore(subscribe, () => flags)
export const getDevFlags = () => flags

function set(patch) {
  flags = { ...flags, ...patch }
  setSendFlags(flags)
  for (const fn of listeners) fn()
}

export const toggleBefore = () => set({ before: !flags.before })
export const toggleClipOverlay = () => set({ clipOverlay: !flags.clipOverlay })
export const cycleSplit = (dir) => set({ splitView: flags.splitView === dir ? 'off' : dir })
export const setSplitPos = (p) => set({ splitPos: Math.min(0.98, Math.max(0.02, p)) })
