import { useState, useEffect } from 'react'
import { loadPreviewBlob, getThumbUrl } from './catalogStore.js'

// 2048px preview URLs with LRU revocation (thumbUrls pattern, fewer + bigger).
// usePreview shows the grid thumb instantly and swaps the preview in when the
// worker delivers it — compare/survey/cull never stage a blank frame.

const PREVIEW_CACHE_MAX = 40
const urls = new Map() // photoId → Promise<url|null>; Map order = LRU

export function getPreviewUrl(photoId) {
  if (urls.has(photoId)) {
    const p = urls.get(photoId)
    urls.delete(photoId) // re-insert = mark most-recently-used
    urls.set(photoId, p)
    return p
  }
  const p = loadPreviewBlob(photoId)
    .then((blob) => (blob ? URL.createObjectURL(blob) : null))
    .catch(() => { urls.delete(photoId); return null })
  urls.set(photoId, p)
  if (urls.size > PREVIEW_CACHE_MAX) {
    const [oldId, oldP] = urls.entries().next().value
    urls.delete(oldId)
    oldP.then((url) => { if (url) URL.revokeObjectURL(url) })
  }
  return p
}

// cull looks ahead: warm the worker + URL cache, result intentionally dropped
export const preloadPreview = (photoId) => { if (photoId != null) getPreviewUrl(photoId) }

// deleted photos must not linger (mirrors evictThumbs)
export function evictPreviews(ids) {
  for (const id of ids) {
    const p = urls.get(id)
    if (p) { urls.delete(id); p.then((url) => { if (url) URL.revokeObjectURL(url) }) }
  }
}

export function usePreview(photoId) {
  const [got, setGot] = useState({ id: null, url: null, isPreview: false })
  useEffect(() => {
    if (photoId == null) return
    let on = true
    let done = false
    // thumb first (almost always cached) so the swap-in reads as a sharpen
    getThumbUrl(photoId).then((u) => {
      if (on && !done && u) setGot({ id: photoId, url: u, isPreview: false })
    })
    getPreviewUrl(photoId).then((u) => {
      if (on && u) { done = true; setGot({ id: photoId, url: u, isPreview: true }) }
    })
    return () => { on = false }
  }, [photoId])
  // never show the previous photo's pixels for the new id
  return got.id === photoId ? { url: got.url, isPreview: got.isPreview } : { url: null, isPreview: false }
}
