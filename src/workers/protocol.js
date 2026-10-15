// Message contracts binding all workers to the UI. Every message is
// { id, type, ...payload }; replies are { re: id, ok, ...payload }.
// Pixel buffers always move as Transferables, never copied.

export const MSG = {
  // main → render worker
  INIT: 'init',                 // { canvas: OffscreenCanvas, backendPref }
  OPEN: 'open',                 // { photoId, source: ImageBitmap | decoded payload, editDoc }
  PARAMS: 'params',             // { photoId, editDoc, gesture: bool } — coalesced per rAF
  VIEW: 'view',                 // { w, h (canvas device px), zoom: 'fit'|1|2, panX, panY }
  EXPORT: 'export',             // { photoId, editDoc, opts: { type, quality, longEdge } }
  BRUSH: 'brush',               // { photoId, maskId, channel 0..3, pts: [[x,y,pressure]..]
                                //   (y-down source-normalized), size, flow, erase } —
                                //   rAF-batched live stroke increments; the committed
                                //   stroke arrives later via PARAMS (doc replay)
  MASKTEX: 'maskTex',           // { photoId, maskId, channel 0..3, width, height,
                                //   data: Uint8Array (transfer) } — full-channel AI-mask
                                //   weights at quarter res; worker keeps them and re-merges
                                //   into brushTex on every replay (refine blur applied there)
  AUTO: 'auto',                 // { photoId, kind: 'tone'|'wb' } — measures the
                                //   current photo at scopes size (exposure/tone or
                                //   wb stripped first) and computes replacement
                                //   module values → AUTOED
  SAMPLE: 'sample',             // { photoId, x, y } — normalized display coords of
                                //   the rendered view; worker maps through the
                                //   drawn geometry and reads a 5×5 average →
                                //   SAMPLED (WB eyedropper + TAT)
  CLOSE: 'close',               // { photoId }
  PROFILE: 'profile',           // { profileId, bytes: ArrayBuffer } — an imported DCP camera
                                //   profile; docs name it as look.profile 'dcp:<id>'
  PATCH: 'patch',               // { photoId, patchId, width, height, data: Uint8ClampedArray
                                //   RGBA (transfer) } — a removal patch's pixels (doc
                                //   modules.remove decides where and whether it draws)
  REGION: 'region',             // { photoId, rect: [x,y,w,h] final source space, width,
                                //   height } → REGIONED { data: RGBA8 sRGB of linear ÷
                                //   scale, width, height, scale } — removal input

  // render worker → main
  READY: 'ready',               // { backend: 'webgpu'|'webgl2', limits }
  LENS: 'lens',                 // { photoId, lens: { name, maker, distortion } | null }
                                //   — the lens profile found for the open RAW
  AUTOED: 'autoed',             // { re, modules } — subset for editStore.applyModules
  SAMPLED: 'sampled',           // { re, linear: [r,g,b] scene-linear pre-develop,
                                //   display: [r,g,b] 0..1 display-referred
                                //   (pre-curve, overlay/finish stripped) }
  FRAME: 'frame',               // { photoId, quality, ms }
  REGIONED: 'regioned',         // reply to REGION
  DN_STATE: 'dnState',          // { photoId, ready, done?, total? } — AI denoise progress
  SCOPES: 'scopes',             // { photoId, hist: Uint32Array(256*4) r/g/b/luma
                                //   (transfer), clipShadows, clipHighlights (0..1 frac) }
  EXPORTED: 'exported',         // { re, photoId, blob }
  ERROR: 'error',               // { re?, message }

  // main → decode worker
  DECODE: 'decode',             // { photoId, buffer, name, quality: 'proxy'|'full'|'export' }
  // decode worker → main
  DECODED: 'decoded',           // { photoId, kind: 'mosaic'|'xtrans'|'rgb', width, height,
                                //   bitDepth: 16|8, linear: bool (false = BT.709-encoded), black, white,
                                //   camMul: [r,1,b], camToSrgb: Float32Array(9) row-major,
                                //   cfa: [ox,oy] RGGB phase, xtrans?: Uint8Array(36)
                                //   6×6 layout (0 R 1 G 2 B) for kind 'xtrans', flip,
                                //   buffer (transfer): Uint16Array raw frame | RGBA16 | RGBA8;
                                //   raw frames keep LibRaw's masked borders: rawWidth
                                //   (row stride), left, top locate the visible area,
                                //   exif: { camera, lens, iso, shutter, aperture,
                                //   focal, takenAt } }

  // main → AI worker (every request also carries base: the app root URL)
  SEG_SUBJECT: 'segSubject',    // { photoId, kind: 'subject'|'sky', blob (preview), outW, outH }
                                //   → { re, ok, mask: Uint8Array outW×outH (transfer),
                                //       width, height, ms } — quarter-res source weights
  SAM_MASK: 'samMask',          // { photoId, blob (preview), points: [[x,y,label]] source-
                                //   normalised (1 include, 0 exclude), box?: [x0,y0,x1,y1],
                                //   outW, outH } → same reply as SEG_SUBJECT
  INPAINT: 'inpaint',           // { rgba: Uint8ClampedArray w×h RGBA, hole: Uint8Array w×h
                                //   (255 = fill), width, height } → { re, ok, rgba, ms }
  AI_RELEASE: 'aiRelease',      // {} — drop loaded models and the cached SAM embedding
  DENOISE: 'denoise',           // { payload: decoded Bayer payload (buffer transferred),
                                //   port: MessagePort to the render worker } — streams
                                //   { type: 'tile', x, y, w, h, data: Float32Array RGBA
                                //   camera RGB, done, total } then { type: 'done' } on port
  DENOISE_CANCEL: 'denoiseCancel', // {} — stop the running denoise between tiles

  // main → render worker, AI denoise
  DN_PORT: 'dnPort',            // { photoId, port } — receive denoise tiles for this photo

  // main → catalog worker
  CAT_INIT: 'catInit',          // {} → { ok }
  CAT_IMPORT: 'catImport',      // { files: [{ name, buffer (transfer) }] }
  CAT_QUERY: 'catQuery',        // { filter: { folderId?, minRating?, flag?, search?
                                //   (filename/camera/lens/title/caption/keywords LIKE),
                                //   keyword? (exact token in the keywords array),
                                //   source?: { kind: 'all'|'recent'|'date'|'album', y?, m?, albumId? } },
                                //   sort: { by: 'takenAt'|'importedAt'|'name'|'rating', dir } }
                                //   → { photos: [...] }
  CAT_SET_META: 'catSetMeta',   // { photoId, rating?, flag?, colorLabel? }
  CAT_SET_TEXTMETA: 'catSetTextMeta', // { photoIds, title?, caption?, addKeywords?, removeKeywords? }
                                      //   — title/caption overwrite; keyword ops merge per-photo
                                      //   into the JSON-array `keywords` column (batch-safe)
  CAT_GET_FILE: 'catGetFile',   // { photoId } → { buffer (transfer), name }
  CAT_GET_THUMB: 'catGetThumb', // { photoId } → { blob }
  CAT_GET_PREVIEW: 'catGetPreview', // { photoId } → { blob | null } — ≤2048px JPEG
                                    //   (RAW: embedded preview, else the original,
                                    //   downscaled), generated once and cached in
                                    //   OPFS previews/ — feeds compare/survey/cull
  CAT_SAVE_THUMB: 'catSaveThumb', // { photoId, blob, width?, height? } → { saved }
                                  //   — main-thread fallback thumb for RAW with no
                                  //   decodable embedded preview (the worker has no
                                  //   libraw); writes thumbs/<id>.jpg, thumb_state=1,
                                  //   and heals the row's true dims. No row → saved:false
  CAT_SAVE_DOC: 'catSaveDoc',   // { photoId, versionId, doc }
  CAT_LOAD_DOC: 'catLoadDoc',   // { photoId, versionId } → { doc | null }
  CAT_LIST_DOCS: 'catListDocs', // { photoId } → { versions: [{ versionId, name, updatedAt }] }
  CAT_DELETE_DOC: 'catDeleteDoc', // { photoId, versionId } — removes sidecar + row
  CAT_PROFILE_SAVE: 'catProfileSave', // { profileId, buffer (transfer, .dcp bytes) }
  CAT_PROFILE_LIST: 'catProfileList', // {} → { profiles: [{ id, buffer }] }
  CAT_PROFILE_DELETE: 'catProfileDelete', // { profileId }
  CAT_SAVE_MASK: 'catSaveMask', // { photoId, maskId, buffer (transfer, png bytes) }
  CAT_LOAD_MASK: 'catLoadMask', // { photoId, maskId } → { blob | null }
  CAT_PRESET_SAVE: 'catPresetSave',     // { preset: { id, name, modules } } — upsert (rename rides the same path)
  CAT_PRESET_LIST: 'catPresetList',     // {} → { presets: [{ id, name, modules }] } name-sorted
  CAT_PRESET_DELETE: 'catPresetDelete', // { presetId }
  CAT_DELETE_PHOTOS: 'catDeletePhotos', // { photoIds } — rows (photos/album_photos/edits) then
                                        //   OPFS originals/thumbs/edits/masks; rows first in one
                                        //   transaction, files best-effort (orphans are invisible)
  CAT_SIDEBAR: 'catSidebar',    // {} → { total, rejected, lastImport: { id, count, at } | null,
                                //   dates: [{ y, m, count }], albums: [{ id, name, count }],
                                //   smarts: [{ id, name, filter }] } — one navigator refresh
  CAT_ALBUM_CREATE: 'catAlbumCreate',   // { name } → { album: { id, name } }
  CAT_ALBUM_RENAME: 'catAlbumRename',   // { albumId, name }
  CAT_ALBUM_DELETE: 'catAlbumDelete',   // { albumId } — album + memberships, never photos
  CAT_ALBUM_ADD: 'catAlbumAdd',         // { albumId, photoIds } — idempotent
  CAT_ALBUM_REMOVE: 'catAlbumRemove',   // { albumId, photoIds }
  CAT_SMART_SAVE: 'catSmartSave',       // { smart: { id, name, filter } } — upsert
  CAT_SMART_DELETE: 'catSmartDelete',   // { smartId }
  CAT_BACKUP: 'catBackup',      // {} → { buffer (transfer): STORE-only zip of edit
                                //   sidecars + presets + smarts.json + manifest.json
                                //   (never originals), counts: { sidecars, presets, smarts } }
  CAT_RESTORE: 'catRestore',    // { buffer (transfer): backup zip } → { restored, skipped,
                                //   presets, smarts } — sidecars re-imported for matching
                                //   photo ids (manifest filename remap covers fresh imports)
  // catalog worker → main (streamed during import)
  CAT_PROGRESS: 'catProgress',  // { done, total, photoId, thumbReady }
}

let nextId = 1
export const msgId = () => nextId++
