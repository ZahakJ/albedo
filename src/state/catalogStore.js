import { useSyncExternalStore } from 'react'
import { MSG, msgId } from '../workers/protocol.js'
import { parseExif } from '../io/exif.js'
import { decode } from './decodeClient.js'

// Plain-module store over the catalog worker, same shape as editStore. The
// worker owns sqlite + OPFS; this side owns optimistic UI state, thumb URL
// caching, and write-behind edit-doc saves.

let state = {
  ready: false,
  photos: [],
  filter: {}, // { flag?, minRating?, colorLabel?, search?, smartId?, source? }
  sort: { by: 'takenAt', dir: 'desc' },
  importing: null, // { done, total } | null
  sidebar: null, // { total, rejected, lastImport, dates, albums, smarts } | null
}
const listeners = new Set()
const emit = () => { for (const fn of listeners) fn() }
const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn) }
export const useCatalog = () => useSyncExternalStore(subscribe, () => state)
export const getCatalogState = () => state

let worker = null
let initPromise = null
const replyWaiters = new Map()

const request = (msg, transfer) => new Promise((resolve, reject) => {
  const id = msgId()
  replyWaiters.set(id, { resolve, reject })
  worker.postMessage({ id, ...msg }, transfer ?? [])
})

// Re-queries are throttled during import so a 500-file drop doesn't hammer
// sqlite with 500 SELECTs; trailing call always lands.
let queryTimer = 0
let queryInflight = false
let metaEpoch = 0 // bumped per optimistic setMeta — stale query replies re-run
async function refreshQuery() {
  if (queryInflight) return scheduleQuery()
  queryInflight = true
  try {
    const epoch = metaEpoch
    const { photos } = await request({ type: MSG.CAT_QUERY, filter: state.filter, sort: state.sort })
    // a setMeta landed while this query was in flight: its rows were computed
    // before the write and would clobber the optimistic state — requery
    // (the new message is serialized behind the write in the worker)
    if (epoch !== metaEpoch) return scheduleQuery()
    state = { ...state, photos }
    emit()
    queueThumbFallback(photos)
  } finally { queryInflight = false }
}
function scheduleQuery() {
  if (queryTimer) return
  queryTimer = setTimeout(() => { queryTimer = 0; refreshQuery() }, 250)
}

// Navigator data (counts, date tree, albums, smarts) — cheap single message,
// refreshed whenever anything that feeds it can have changed.
let sidebarInflight = false
async function refreshSidebar() {
  if (!worker || sidebarInflight) return
  sidebarInflight = true
  try {
    const { total, rejected, lastImport, dates, albums, smarts, keywords } =
      await request({ type: MSG.CAT_SIDEBAR })
    state = { ...state, sidebar: { total, rejected, lastImport, dates, albums, smarts, keywords } }
    emit()
  } catch (err) { console.error('[catalog] sidebar', err) }
  finally { sidebarInflight = false }
}

export function initCatalog() {
  initPromise ??= (async () => {
    worker = new Worker(new URL('../workers/catalog.worker.js', import.meta.url), { type: 'module' })
    worker.onerror = (e) => console.error('[catalog.worker]', e.message ?? e)
    worker.onmessage = ({ data }) => {
      if (data.re && replyWaiters.has(data.re)) {
        const { resolve, reject } = replyWaiters.get(data.re)
        replyWaiters.delete(data.re)
        data.ok === false ? reject(new Error(data.message)) : resolve(data)
        return
      }
      if (data.type === MSG.CAT_PROGRESS) {
        state = { ...state, importing: { done: data.done, total: data.total } }
        emit()
        scheduleQuery()
      }
    }
    // persist() needs a Window context in some engines; the worker also tries
    try { await navigator.storage?.persist?.() } catch { /* best-effort */ }
    await request({ type: MSG.CAT_INIT })
    await refreshQuery()
    await refreshSidebar()
    state = { ...state, ready: true }
    emit()
  })()
  return initPromise
}

// Resolves to the new photo ids; with { names: true }, to [{ id, name }].
export async function importFiles(files, { names = false } = {}) {
  await initCatalog()
  state = { ...state, importing: { done: 0, total: files.length } }
  emit()
  const payload = await Promise.all(
    [...files].map(async (f) => ({ name: f.name, buffer: await f.arrayBuffer() })))
  try {
    const res = await request(
      { type: MSG.CAT_IMPORT, files: payload },
      payload.map((f) => f.buffer))
    return names ? res.imported ?? [] : res.photoIds
  } finally {
    state = { ...state, importing: null }
    emit()
    await refreshQuery()
    refreshSidebar()
  }
}

// Optimistic: the grid updates now; the worker write is fire-and-forget.
export function setMeta(photoId, patch) {
  metaEpoch++
  state = {
    ...state,
    photos: state.photos.map((p) => (p.id === photoId ? { ...p, ...patch } : p)),
  }
  emit()
  request({
    type: MSG.CAT_SET_META,
    photoId,
    rating: patch.rating,
    flag: patch.flag,
    colorLabel: patch.colorLabel,
  }).then(() => { if (patch.flag !== undefined) refreshSidebar() })
    .catch((err) => console.error('[catalog] setMeta', err))
}

// Optimistic text metadata (title/caption/keyword add-remove) over one or many
// photos; the worker merges keyword ops per-photo, sidebar keyword counts
// refresh after the write lands.
export function setTextMeta(photoIds, patch) {
  metaEpoch++
  const ids = new Set(photoIds)
  state = {
    ...state,
    photos: state.photos.map((p) => {
      if (!ids.has(p.id)) return p
      const n = { ...p }
      if (patch.title !== undefined) n.title = patch.title || null
      if (patch.caption !== undefined) n.caption = patch.caption || null
      if (patch.addKeywords?.length || patch.removeKeywords?.length) {
        let kws = Array.isArray(p.keywords) ? [...p.keywords] : []
        for (const k of patch.addKeywords ?? []) if (!kws.includes(k)) kws.push(k)
        if (patch.removeKeywords?.length) kws = kws.filter((k) => !patch.removeKeywords.includes(k))
        n.keywords = kws
      }
      return n
    }),
  }
  emit()
  return request({
    type: MSG.CAT_SET_TEXTMETA,
    photoIds: [...photoIds],
    title: patch.title,
    caption: patch.caption,
    addKeywords: patch.addKeywords,
    removeKeywords: patch.removeKeywords,
  }).then(() => refreshSidebar())
    .catch((err) => console.error('[catalog] setTextMeta', err))
}

export function setFilter(patch) {
  // any hand-adjusted filter detaches the live smart-collection highlight
  const filter = { ...state.filter, ...patch }
  if (!('smartId' in patch)) delete filter.smartId
  state = { ...state, filter }
  emit()
  refreshQuery()
}

export function setSort(sort) {
  state = { ...state, sort }
  emit()
  refreshQuery()
}

// clicking a smart collection replays its saved filter-bar state live
export function applySmart(smart) {
  state = { ...state, filter: { ...(smart.filter ?? {}), smartId: smart.id } }
  emit()
  refreshQuery()
}

// ── delete: rows + files in the worker, caches evicted here ───────────────

export async function deletePhotos(photoIds) {
  await initCatalog()
  const gone = new Set(photoIds)
  // debounced doc saves for dying photos must never resurrect their edits rows
  for (const id of photoIds) {
    const pending = pendingSaves.get(id)
    if (pending) { clearTimeout(pending.timer); pendingSaves.delete(id) }
  }
  for (const id of photoIds) {
    const p = thumbUrls.get(id)
    if (p) { thumbUrls.delete(id); p.then((url) => { if (url) URL.revokeObjectURL(url) }) }
  }
  // queued fallback decodes for dying photos are dropped; an in-flight one is
  // caught worker-side (no row → saved:false, no file written)
  for (let i = fallbackQueue.length - 1; i >= 0; i--)
    if (gone.has(fallbackQueue[i])) fallbackQueue.splice(i, 1)
  state = { ...state, photos: state.photos.filter((p) => !gone.has(p.id)) } // optimistic
  emit()
  await request({ type: MSG.CAT_DELETE_PHOTOS, photoIds })
  await refreshQuery()
  refreshSidebar()
}

// ids of every rejected photo, unaffected by the current filter — Clear rejects
export async function getRejectedIds() {
  await initCatalog()
  const { photos } = await request({ type: MSG.CAT_QUERY, filter: { flag: -1 } })
  return photos.map((p) => p.id)
}

// ── albums ─────────────────────────────────────────────────────────────────

export async function albumCreate(name) {
  await initCatalog()
  const { album } = await request({ type: MSG.CAT_ALBUM_CREATE, name })
  await refreshSidebar()
  return album
}

export async function albumRename(albumId, name) {
  await request({ type: MSG.CAT_ALBUM_RENAME, albumId, name })
  refreshSidebar()
}

export async function albumDelete(albumId) {
  await request({ type: MSG.CAT_ALBUM_DELETE, albumId })
  if (state.filter.source?.albumId === albumId)
    setFilter({ source: { kind: 'all' } })
  refreshSidebar()
}

export async function albumAdd(albumId, photoIds) {
  await request({ type: MSG.CAT_ALBUM_ADD, albumId, photoIds })
  if (state.filter.source?.albumId === albumId) refreshQuery()
  refreshSidebar()
}

export async function albumRemove(albumId, photoIds) {
  await request({ type: MSG.CAT_ALBUM_REMOVE, albumId, photoIds })
  if (state.filter.source?.albumId === albumId) refreshQuery()
  refreshSidebar()
}

// ── smart collections ──────────────────────────────────────────────────────

export async function smartSave(smart) {
  await request({ type: MSG.CAT_SMART_SAVE, smart })
  await refreshSidebar()
}

export async function smartDelete(smartId) {
  await request({ type: MSG.CAT_SMART_DELETE, smartId })
  if (state.filter.smartId === smartId) setFilter({})
  refreshSidebar()
}

// ── catalog backup: zip of sidecars/presets/smarts (worker builds/parses) ──

export async function backupCatalog() {
  await initCatalog()
  const { buffer, counts } = await request({ type: MSG.CAT_BACKUP })
  return { buffer, counts }
}

export async function restoreCatalog(buffer) {
  await initCatalog()
  const res = await request({ type: MSG.CAT_RESTORE, buffer }, [buffer])
  await refreshQuery()
  refreshSidebar()
  return res // { restored, skipped, presets, smarts }
}

// ── presets: thin worker proxies (presetStore owns the UI state) ───────────
// Each awaits initCatalog: the preset rail mounts before App's init effect runs.

export async function presetList() {
  await initCatalog()
  const { presets } = await request({ type: MSG.CAT_PRESET_LIST })
  return presets
}

export async function presetSave(preset) {
  await initCatalog()
  await request({ type: MSG.CAT_PRESET_SAVE, preset })
}

export async function presetDelete(presetId) {
  await initCatalog()
  await request({ type: MSG.CAT_PRESET_DELETE, presetId })
}

// ── thumbs: object URLs with LRU revocation ────────────────────────────────

const THUMB_CACHE_MAX = 200
const thumbUrls = new Map() // photoId → Promise<url|null>; Map order = LRU

export function getThumbUrl(photoId) {
  if (thumbUrls.has(photoId)) {
    const p = thumbUrls.get(photoId)
    thumbUrls.delete(photoId) // re-insert = mark most-recently-used
    thumbUrls.set(photoId, p)
    return p
  }
  const p = request({ type: MSG.CAT_GET_THUMB, photoId })
    .then(({ blob }) => (blob ? URL.createObjectURL(blob) : null))
    .catch(() => { thumbUrls.delete(photoId); return null })
  thumbUrls.set(photoId, p)
  if (thumbUrls.size > THUMB_CACHE_MAX) {
    const [oldId, oldP] = thumbUrls.entries().next().value
    thumbUrls.delete(oldId)
    oldP.then((url) => { if (url) URL.revokeObjectURL(url) })
  }
  return p
}

// ≤2048px JPEG preview blob (worker generates + caches in OPFS previews/);
// null when the source is undecodable. URL caching lives in usePreview.js.
export async function loadPreviewBlob(photoId) {
  await initCatalog()
  const { blob } = await request({ type: MSG.CAT_GET_PREVIEW, photoId })
  return blob
}

export async function loadOriginal(photoId) {
  const { buffer, name } = await request({ type: MSG.CAT_GET_FILE, photoId })
  return { buffer, name }
}

// raw thumb blob (no object-URL cache) — segmentation input for AI masks
export async function loadThumbBlob(photoId) {
  await initCatalog()
  const { blob } = await request({ type: MSG.CAT_GET_THUMB, photoId })
  return blob
}

// ── thumb fallback: RAW whose embedded previews are all undecodable ────────
// The catalog worker has no libraw, so the demosaic runs here (decode worker,
// proxy/half-size) and the JPEG is handed back via CAT_SAVE_THUMB. Bounded
// queue: a big import must stay responsive, so at most 2 decodes are in flight
// and each photo is attempted once per session.

const THUMB_FALLBACK_MAX = 2
const fallbackQueue = []
const fallbackSeen = new Set() // attempted ids — makes the queue idempotent
let fallbackActive = 0

// decoded RGB payload → ≤512px JPEG blob. bitDepth 16 is BT.709-encoded
// already (decode.worker's linear:false), so a plain >>8 is display-correct.
function payloadThumbBlob({ width: w, height: h, buffer, bitDepth }) {
  const px = new Uint8ClampedArray(w * h * 4)
  const shift = bitDepth === 16 ? 8 : 0
  for (let i = 0; i + 3 < px.length && i + 3 < buffer.length; i += 4) {
    px[i] = buffer[i] >> shift
    px[i + 1] = buffer[i + 1] >> shift
    px[i + 2] = buffer[i + 2] >> shift
    px[i + 3] = 255
  }
  const full = new OffscreenCanvas(w, h)
  full.getContext('2d').putImageData(new ImageData(px, w, h), 0, 0)
  const scale = Math.min(1, 512 / Math.max(w, h))
  const tw = Math.max(1, Math.round(w * scale))
  const th = Math.max(1, Math.round(h * scale))
  const small = new OffscreenCanvas(tw, th)
  small.getContext('2d').drawImage(full, 0, 0, tw, th)
  return small.convertToBlob({ type: 'image/jpeg', quality: 0.85 })
}

// Demosaic one photo and persist the thumb (+ true dims). Resolves false when
// the photo vanished mid-decode. Also the "rebuild thumbnail" on-demand path.
export async function rebuildThumb(photoId) {
  await initCatalog()
  const { buffer, name } = await loadOriginal(photoId)
  const exif = parseExif(buffer) // must run before decode() transfers the buffer
  const payload = await decode(photoId, buffer, name, 'proxy')
  if (payload.kind !== 'rgb') throw new Error(`proxy decode returned ${payload.kind}`)
  const blob = await payloadThumbBlob(payload)
  // proxy decodes half-size, so the EXIF walk — not the payload — owns dims
  const { saved } = await request({
    type: MSG.CAT_SAVE_THUMB, photoId, blob,
    width: exif.width ?? null, height: exif.height ?? null,
  })
  if (saved) thumbUrls.delete(photoId) // a cached null must not stick
  return saved
}

function queueThumbFallback(photos) {
  for (const p of photos) {
    if (!p.isRaw || p.thumbState === 1 || fallbackSeen.has(p.id)) continue
    fallbackSeen.add(p.id)
    fallbackQueue.push(p.id)
  }
  pumpThumbFallback()
}

function pumpThumbFallback() {
  while (fallbackActive < THUMB_FALLBACK_MAX && fallbackQueue.length) {
    const id = fallbackQueue.shift()
    fallbackActive++
    rebuildThumb(id)
      .then((saved) => { if (saved) scheduleQuery() }) // grid repaints as thumbs land
      .catch(() => { /* libraw can't read it either — stays thumb_state 2 */ })
      .finally(() => { fallbackActive--; pumpThumbFallback() })
  }
}

// ── AI-mask weight blobs: masks/{photoId}/{maskId}.png in OPFS ─────────────

export async function saveMaskBlob(photoId, maskId, blob) {
  await initCatalog()
  const buffer = await blob.arrayBuffer()
  await request({ type: MSG.CAT_SAVE_MASK, photoId, maskId, buffer }, [buffer])
}

export async function loadMaskBlob(photoId, maskId) {
  await initCatalog()
  const { blob } = await request({ type: MSG.CAT_LOAD_MASK, photoId, maskId })
  return blob
}

// ── edit docs: debounced write-behind ──────────────────────────────────────

const pendingSaves = new Map() // photoId → { doc, timer }

function flushSave(photoId) {
  const pending = pendingSaves.get(photoId)
  if (!pending) return Promise.resolve()
  pendingSaves.delete(photoId)
  clearTimeout(pending.timer)
  return request({
    type: MSG.CAT_SAVE_DOC,
    photoId,
    versionId: pending.doc?.versionId ?? 'v_default',
    doc: pending.doc,
  }).catch((err) => console.error('[catalog] saveDoc', err))
}

export function saveDoc(photoId, doc) {
  const prev = pendingSaves.get(photoId)
  if (prev) clearTimeout(prev.timer)
  pendingSaves.set(photoId, { doc, timer: setTimeout(() => flushSave(photoId), 500) })
}

export async function loadDoc(photoId) {
  // a not-yet-flushed save is the freshest truth
  const pending = pendingSaves.get(photoId)
  if (pending) return pending.doc
  const { doc } = await request({ type: MSG.CAT_LOAD_DOC, photoId, versionId: 'v_default' })
  return doc ?? null
}

// Docs sitting in the 500ms window would be lost on tab close otherwise.
if (typeof addEventListener === 'function') {
  addEventListener('beforeunload', () => {
    for (const photoId of [...pendingSaves.keys()]) flushSave(photoId)
  })
}

// ── versions: thin worker proxies (versionStore owns the UI state) ─────────

// awaited before a version switch so the debounced save of the outgoing
// version can never land after (and clobber) the incoming one
export const flushSaves = (photoId) => flushSave(photoId)

// immediate write — version create/rename must be durable before the list refreshes
export async function saveDocNow(photoId, doc) {
  await initCatalog()
  const versionId = doc?.versionId ?? 'v_default'
  const prev = pendingSaves.get(photoId)
  if (prev && (prev.doc?.versionId ?? 'v_default') === versionId) {
    clearTimeout(prev.timer)
    pendingSaves.delete(photoId)
  }
  await request({ type: MSG.CAT_SAVE_DOC, photoId, versionId, doc })
}

export async function listDocs(photoId) {
  await initCatalog()
  const { versions } = await request({ type: MSG.CAT_LIST_DOCS, photoId })
  return versions
}

export async function loadDocVersion(photoId, versionId) {
  const pending = pendingSaves.get(photoId)
  if (pending && (pending.doc?.versionId ?? 'v_default') === versionId) return pending.doc
  await initCatalog()
  const { doc } = await request({ type: MSG.CAT_LOAD_DOC, photoId, versionId })
  return doc ?? null
}

export async function deleteDocVersion(photoId, versionId) {
  const pending = pendingSaves.get(photoId)
  if (pending && (pending.doc?.versionId ?? 'v_default') === versionId) {
    clearTimeout(pending.timer)
    pendingSaves.delete(photoId)
  }
  await initCatalog()
  await request({ type: MSG.CAT_DELETE_DOC, photoId, versionId })
}

// ── DCP camera profiles (OPFS profiles/<id>.dcp) ──────────────────────────
export const saveProfileBytes = (profileId, buffer) =>
  request({ type: MSG.CAT_PROFILE_SAVE, profileId, buffer }, [buffer])
export const listProfileBytes = async () => (await request({ type: MSG.CAT_PROFILE_LIST })).profiles
export const deleteProfileBytes = (profileId) => request({ type: MSG.CAT_PROFILE_DELETE, profileId })

// a one-off query, outside the grid's state
export const queryPhotos = async (filter = {}, sort = { by: 'takenAt', dir: 'desc' }) => {
  const r = await request({ type: MSG.CAT_QUERY, filter, sort })
  r.photos.workerMs = r.ms // time spent in the worker, for benchmarks
  return r.photos
}
export const fetchSidebar = () => request({ type: MSG.CAT_SIDEBAR })
