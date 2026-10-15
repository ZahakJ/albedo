import { MSG, msgId } from '../workers/protocol.js'

// Thin proxy between the UI and the decode worker, renderClient's twin.
// One worker, requests matched to replies by id; RAW bytes move in, decoded
// pixel buffers move out — both as Transferables.

let worker = null
const replyWaiters = new Map()

function ensureWorker() {
  if (worker) return
  worker = new Worker(new URL('../workers/decode.worker.js', import.meta.url), { type: 'module' })
  worker.onerror = (e) => console.error('[decode.worker]', e.message ?? e)
  worker.onmessage = ({ data }) => {
    if (!data.re || !replyWaiters.has(data.re)) return
    const { resolve, reject } = replyWaiters.get(data.re)
    replyWaiters.delete(data.re)
    data.type === MSG.ERROR ? reject(new Error(data.message)) : resolve(data)
  }
}

// → DECODED payload: { kind, width, height, bitDepth, linear, buffer, black,
//   white, camMul, camToSrgb, cfa, flip, exif } — pass straight to openPhoto.
export function decode(photoId, arrayBuffer, name, quality = 'full') {
  ensureWorker()
  return new Promise((resolve, reject) => {
    const id = msgId()
    replyWaiters.set(id, { resolve, reject })
    worker.postMessage({ id, type: MSG.DECODE, photoId, buffer: arrayBuffer, name, quality }, [arrayBuffer])
  })
}
