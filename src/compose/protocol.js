// Messages between the main thread and Compose, which runs in the render
// worker beside Develop (one GPU device). Every request is
// { id, type, ...payload }; replies are { re: id, ok, ...payload }. Bitmaps
// and buffers always move as transferables.

export const CO = {
  INIT: 'coInit',             // { canvas: OffscreenCanvas } → { features }
  VIEW: 'coView',             // { w, h (css px), dpr, zoom, offX, offY, surround: [r,g,b] }
  NEW: 'coNew',               // { width, height, depth, name, background: 'white'|'black'|'transparent'|[r,g,b,a] }
  OPEN_IMAGE: 'coOpenImage',  // { bitmap, name, depth } — new document, the image as its layer
  FROM_PHOTO: 'coFromPhoto',  // { photoId, name, editDoc, depth } — new document, the photo as a smart object
  ADD_IMAGE: 'coAddImage',    // { bitmap, name, x?, y? } — new pixel layer
  ADD_SMART: 'coAddSmart',    // { photoId, name, editDoc } — new smart object layer
  SOURCE: 'coSource',         // { photoId, source (decoded payload | ImageBitmap) } — a smart object's original
  CLOSE: 'coClose',
  LIST: 'coList',             // → { docs: [{ id, name, width, height, depth, layers, updatedAt, thumb }] }
  LOAD: 'coLoad',             // { docId }
  SAVE: 'coSave',             // {} — OPFS autosave (also on a timer)
  DELETE: 'coDelete',         // { docId }

  OP: 'coOp',                 // { op, ...args } — document operations (engine.js OPS)
  PREVIEW: 'coPreview',       // { nodeId, patch } — live property change, no history
  UNDO: 'coUndo',
  REDO: 'coRedo',
  JUMP: 'coJump',             // { to } — history index

  STROKE_BEGIN: 'coStrokeBegin', // { tool, target: 'pixels'|'mask', ...brush }
  STROKE_PTS: 'coStrokePts',  // { pts: [[x, y, pressure, tiltX, tiltY], …] } document px
  STROKE_END: 'coStrokeEnd',

  SELECT: 'coSelect',         // { op, ... } — selection operations (select.js)
  TRANSFORM: 'coTransform',   // { nodeId, xf, commit } — live (commit false) or final
  LIQUIFY: 'coLiquify',       // { nodeId, phase: 'begin'|'pts'|'end', ... }

  EXPORT: 'coExport',         // { format: 'jpeg'|'png'|'tiff'|'psd'|'albedo', quality } → { blob }
  IMPORT: 'coImport',         // { bytes, name, kind: 'psd'|'tiff'|'albedo' } — open a layered file
  READ_REGION: 'coReadRegion',// { rect, source: 'composite'|'layer', nodeId? } → { data: Float32Array RGBA straight, w, h }
  WRITE_REGION: 'coWriteRegion', // { nodeId?, rect, data, w, h, mode: 'newLayer'|'replace', mask? } — AI fills
  GET_DOC: 'coGetDoc',        // → { doc }
  GET_PIXEL: 'coGetPixel',    // { x, y, nodeId? } → { px: [r, g, b, a] } straight, document px
  STATS: 'coStats',           // → { vram, frameMs, ... }
  BENCH: 'coBench',           // { kind, frames } → timings (benchmarks only)

  // worker → main
  CHANGED: 'coChanged',       // { doc, history: { labels, at }, selection, stats, needSources }
  THUMBS: 'coThumbs',         // { thumbs: [{ id, bitmap }] }
  ERROR: 'coError',
}

let next = 1
export const coId = () => next++
