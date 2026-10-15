import { useState, useEffect } from 'react'
import { getThumbUrl } from '../state/catalogStore.js'

// Sync memo over the store's async thumb-URL cache: virtualized cells remount
// constantly during scroll, and a cached URL must be there on first render or
// every remount re-runs the fade-in.
const urls = new Map()
const seen = new Set() // ids whose thumb has painted once — skip the fade

// deleted photos must not linger in the sync memo (the store revokes the URLs)
export function evictThumbs(ids) {
  for (const id of ids) { urls.delete(id); seen.delete(id) }
}

// Flinging through thousands of photos mounts a screenful of new cells every
// frame; fetching each one's thumbnail then costs more than the frame has.
// The grid reports its scroll speed; while it moves more than a screen per
// frame, requests wait, and the cells still on screen ask once it slows.
let fastUntil = 0
const waiting = new Set()
export function noteScrollSpeed(pxPerFrame, viewH) {
  if (pxPerFrame > viewH * 0.75) fastUntil = performance.now() + 120
}
const settle = () => {
  if (performance.now() < fastUntil) { setTimeout(settle, 60); return }
  for (const fn of waiting) fn()
  waiting.clear()
}

// thumbState: 0 pending, 1 ready, 2 failed (catalog worker contract)
export function useThumb(id, thumbState) {
  const [url, setUrl] = useState(() => urls.get(id) ?? null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const cached = urls.get(id)
    if (cached) { setUrl(cached); return }
    if (thumbState !== 1) return
    let on = true
    const load = () => {
      if (!on) return
      getThumbUrl(id).then((u) => {
        if (u != null) { urls.set(id, u); if (on) setUrl(u) }
      })
    }
    if (performance.now() < fastUntil) {
      if (!waiting.size) setTimeout(settle, 60)
      waiting.add(load)
    } else load()
    return () => { on = false; waiting.delete(load) }
  }, [id, thumbState, tick])
  return {
    url,
    wasSeen: seen.has(id),
    markSeen: () => seen.add(id),
    // the store LRU-revokes object URLs; a dead one gets refetched once
    onError: () => { urls.delete(id); seen.delete(id); setUrl(null); setTick((t) => t + 1) },
  }
}
