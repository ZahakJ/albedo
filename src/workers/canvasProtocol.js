// Message contracts for the CANVAS layer-editor worker (canvas.worker.js).
// Deliberately separate from workers/protocol.js: the develop pipeline and
// the canvas compositor never share a message. Every message is
// { id, type, ...payload }; replies are { re: id, ok, ...payload }.
// Bitmaps/buffers always move as Transferables.

export const CV = {
  // main → canvas worker
  INIT: 'cvInit',               // { canvas: OffscreenCanvas } → { filters: bool }
  NEW_DOC: 'cvNewDoc',          // { width, height, background: 'transparent'|'white'|'black', name }
  OPEN_IMAGE: 'cvOpenImage',    // { bitmap (transfer), name } — new doc, bitmap = base layer
  LOAD_DOC: 'cvLoadDoc',        // { docId } — hydrate from OPFS canvasdocs/<id>/
  CLOSE_DOC: 'cvCloseDoc',      // {}
  LIST_DOCS: 'cvListDocs',      // {} → { docs: [{ id, name, width, height, updatedAt, thumb: ArrayBuffer|null }] }
  DELETE_DOC: 'cvDeleteDoc',    // { docId }
  SAVE: 'cvSave',               // {} → { ok } — doc.json + layer PNGs + thumb.png
  VIEW: 'cvView',               // { w, h (css px), dpr, zoom, offX, offY } — view transform; worker redraws

  SET_ACTIVE: 'cvSetActive',    // { layerId } — not undoable
  PROPS_PREVIEW: 'cvPropsPrev', // { layerId, patch } — live (drag/typing), no history
  PROPS_COMMIT: 'cvPropsCommit',// { layerId, patch, before, label } — ONE history entry
  ADD_LAYER: 'cvAddLayer',      // { kind: 'raster'|'text', name?, text?, x?, y?, bitmap? (transfer) }
  DELETE_LAYER: 'cvDelLayer',   // { layerId }
  DUPLICATE: 'cvDupLayer',      // { layerId }
  MERGE_DOWN: 'cvMergeDown',    // { layerId }
  FLATTEN: 'cvFlatten',         // {}
  REORDER: 'cvReorder',         // { from, to } — indices in bottom→top order

  BEGIN_STROKE: 'cvStrokeBegin',// { tool: 'brush'|'eraser'|'clone', layerId,
                                //   size, hardness, opacity, color, srcX?, srcY? (clone) }
  STROKE_PTS: 'cvStrokePts',    // { pts: [[x, y, pressure], …] doc coords } — rAF-batched
  END_STROKE: 'cvStrokeEnd',    // {} — composites the stroke buffer → layer, ONE snapshot entry
  FILL: 'cvFill',               // { layerId, color } — selection-clipped
  GRADIENT: 'cvGradient',       // { layerId, x0, y0, x1, y1, color } — linear fg→transparent
  SET_SELECTION: 'cvSelect',    // { shapes: [{ kind: 'rect'|'ellipse'|'lasso', op: 'add'|'subtract', … }] | null, feather }
  TRANSFORM_PREVIEW: 'cvXformPrev', // { layerId, m: [a,b,c,d,e,f] | null } — draw-time only
  TRANSFORM_COMMIT: 'cvXformCommit',// { layerId, m } — destructive resample, ONE entry
  ADJUST: 'cvAdjust',           // { layerId, kind: 'bc'|'huesat'|'invert'|'blur', params } — destructive
  CROP: 'cvCrop',               // { x, y, w, h } — document resize

  UNDO: 'cvUndo',               // {}
  REDO: 'cvRedo',               // {}
  JUMP: 'cvJump',               // { delta } — history panel rows (n× undo/redo)

  EXPORT: 'cvExport',           // { mime, quality } → { blob, width, height } — flattened
  GET_DOC: 'cvGetDoc',          // {} → { doc } — serializable mirror (e2e)
  GET_PIXEL: 'cvGetPixel',      // { layerId|null, x, y } → { px: [r,g,b,a] } — null = composite
  GET_BOUNDS: 'cvGetBounds',    // { layerId } → { x, y, w, h } — content alpha bounds

  // canvas worker → main
  CHANGED: 'cvChanged',         // { doc, history: { labels, at }, selection, dirty,
                                //   thumbs: [{ layerId, bitmap (transfer) }] }
  ERROR: 'cvError',             // { re?, message }
}

let nextId = 1
export const cvMsgId = () => nextId++
