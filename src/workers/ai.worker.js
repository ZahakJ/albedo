// The WebGPU bundle carries both execution providers (WebGPU, and wasm on the
// CPU) and needs one wasm file, served from the app's ort/ directory.
import * as ort from 'onnxruntime-web/webgpu'
import { MSG } from './protocol.js'
import { MODELS } from '../engine/models.js'

// Local AI: masks (subject, sky, click/box object), removal (inpainting) and
// raw denoise, all on the user's machine. Models live under models/ next to
// the app (npm run setup-models), load on first use and stay cached in this
// worker; each session runs on WebGPU when the browser has it, else on the
// CPU. Mask outputs are quarter-resolution weights of the source, the format
// the render worker's brush texture takes.

let base = null
let gpu = null // resolved once: is a WebGPU adapter available here?
const sessions = new Map()

// a software adapter (SwiftShader) runs models slower than the CPU path
const hasGpu = async () => (gpu ??= await (async () => {
  ort.env.webgpu.powerPreference = 'high-performance'
  const a = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null)
  return !!a && !a.info?.isFallbackAdapter && a.info?.architecture !== 'swiftshader'
})())

async function session(id) {
  if (sessions.has(id)) return sessions.get(id)
  const p = (async () => {
    const m = MODELS[id]
    const res = await fetch(new URL(`models/${m.file}`, base))
    const buf = res.ok ? await res.arrayBuffer() : null
    // a dev server answers a miss with HTML: size is the honest check
    if (!buf || buf.byteLength < m.minBytes) throw new Error(`${m.label} model not installed (npm run setup-models)`)
    const opts = { graphOptimizationLevel: 'all' }
    if (!m.cpuOnly && (await hasGpu())) {
      // a GPU can still refuse a model (missing shader-f16 on some iGPUs):
      // then it runs on the CPU rather than not at all
      try {
        return await ort.InferenceSession.create(buf, { ...opts, executionProviders: ['webgpu'] })
      } catch (err) {
        console.warn(`[ai] ${m.label} on the CPU: ${err?.message ?? err}`)
      }
    }
    return ort.InferenceSession.create(buf, { ...opts, executionProviders: ['wasm'] })
  })()
  sessions.set(id, p)
  p.catch(() => sessions.delete(id))
  return p
}

// draw a bitmap into w×h RGBA bytes (non-uniform squash unless fit)
function pixels(bmp, w, h) {
  const cv = new OffscreenCanvas(w, h)
  const cx = cv.getContext('2d', { willReadFrequently: true })
  cx.drawImage(bmp, 0, 0, w, h)
  return cx.getImageData(0, 0, w, h).data
}

// gray model output (n×n floats 0..1) → quarter-res source weights
function upscale(gray, gw, gh, outW, outH) {
  const px = new Uint8ClampedArray(gw * gh * 4)
  for (let i = 0; i < gw * gh; i++) {
    const v = Math.round(Math.min(1, Math.max(0, gray[i])) * 255)
    px[i * 4] = v; px[i * 4 + 1] = v; px[i * 4 + 2] = v; px[i * 4 + 3] = 255
  }
  const small = new OffscreenCanvas(gw, gh)
  small.getContext('2d').putImageData(new ImageData(px, gw, gh), 0, 0)
  const up = new OffscreenCanvas(outW, outH)
  const ux = up.getContext('2d', { willReadFrequently: true })
  ux.imageSmoothingEnabled = true
  ux.imageSmoothingQuality = 'high'
  ux.drawImage(small, 0, 0, outW, outH)
  const u = ux.getImageData(0, 0, outW, outH).data
  const mask = new Uint8Array(outW * outH)
  for (let i = 0; i < mask.length; i++) mask[i] = u[i * 4]
  return mask
}

// subject (ISNet, 1024²) or sky (U²-Net skyseg, 320²)
async function segment(kind, blob, outW, outH) {
  const m = MODELS[kind]
  const sess = await session(kind)
  const bmp = await createImageBitmap(blob)
  const S = m.size
  const px = pixels(bmp, S, S)
  bmp.close()
  const n = S * S
  const input = new Float32Array(3 * n)
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) input[c * n + i] = (px[i * 4 + c] / 255 - m.mean[c]) / m.std[c]
  }
  const out = await sess.run({ [sess.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, S, S]) })
  const d = out[sess.outputNames[0]].data
  let gray = d
  if (m.minmax) {
    // salient-object maps are relative: stretch to the full range. Sky is
    // absolute — a frame with a sliver of sky must not be amplified.
    let lo = Infinity
    let hi = -Infinity
    for (let i = 0; i < n; i++) { if (d[i] < lo) lo = d[i]; if (d[i] > hi) hi = d[i] }
    const span = Math.max(1e-6, hi - lo)
    gray = new Float32Array(n)
    for (let i = 0; i < n; i++) gray[i] = (d[i] - lo) / span
  }
  return upscale(gray, S, S, outW, outH)
}

// MobileSAM: the encoder runs once per photo; every click or box is a
// decoder pass (~15 ms on a GPU)
let samCache = { photoId: null, emb: null, w: 0, h: 0, scale: 1 }
async function samEmbed(photoId, blob) {
  if (samCache.photoId === photoId) return
  const enc = await session('samEncoder')
  const bmp = await createImageBitmap(blob)
  const scale = 1024 / Math.max(bmp.width, bmp.height)
  const w = Math.round(bmp.width * scale)
  const h = Math.round(bmp.height * scale)
  const px = pixels(bmp, w, h)
  bmp.close()
  const hwc = new Float32Array(w * h * 3)
  for (let i = 0; i < w * h; i++) {
    hwc[i * 3] = px[i * 4]; hwc[i * 3 + 1] = px[i * 4 + 1]; hwc[i * 3 + 2] = px[i * 4 + 2]
  }
  const out = await enc.run({ [enc.inputNames[0]]: new ort.Tensor('float32', hwc, [h, w, 3]) })
  samCache = { photoId, emb: out[enc.outputNames[0]], w, h, scale }
}

// points: [[x, y, label]] in source-normalised coords (label 1 = include,
// 0 = exclude); box: [x0, y0, x1, y1] or null
async function samMask(points, box, outW, outH) {
  const dec = await session('samDecoder')
  const { emb, w, h } = samCache
  const pts = []
  const lbl = []
  for (const [x, y, l] of points) { pts.push(x * w, y * h); lbl.push(l) }
  if (box) {
    pts.push(box[0] * w, box[1] * h, box[2] * w, box[3] * h)
    lbl.push(2, 3)
  } else {
    pts.push(0, 0) // padding point: the ONNX decoder expects one without a box
    lbl.push(-1)
  }
  const n = lbl.length
  const feeds = {
    image_embeddings: emb,
    point_coords: new ort.Tensor('float32', Float32Array.from(pts), [1, n, 2]),
    point_labels: new ort.Tensor('float32', Float32Array.from(lbl), [1, n]),
    mask_input: new ort.Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256]),
    has_mask_input: new ort.Tensor('float32', new Float32Array(1), [1]),
    orig_im_size: new ort.Tensor('float32', Float32Array.of(h, w), [2]),
  }
  const out = await dec.run(feeds)
  const masks = out.masks
  const iou = out.iou_predictions.data
  let best = 0
  for (let i = 1; i < iou.length; i++) if (iou[i] > iou[best]) best = i
  const [, , mh, mw] = masks.dims
  const plane = masks.data.subarray(best * mh * mw, (best + 1) * mh * mw)
  // logits → soft weight: a 1-logit ramp keeps edges anti-aliased
  const gray = new Float32Array(mh * mw)
  for (let i = 0; i < gray.length; i++) gray[i] = 1 / (1 + Math.exp(-4 * plane[i]))
  return upscale(gray, mw, mh, outW, outH)
}

// MI-GAN: rgba (w×h RGBA8, the region to fill) + hole (w×h, 255 = remove)
// → filled RGBA8. The model's own mask convention is 255 = keep.
async function inpaint(rgba, hole, w, h) {
  const sess = await session('inpaint')
  const n = w * h
  const img = new Uint8Array(3 * n)
  const msk = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    img[i] = rgba[i * 4]; img[n + i] = rgba[i * 4 + 1]; img[2 * n + i] = rgba[i * 4 + 2]
    msk[i] = hole[i] > 127 ? 0 : 255
  }
  const out = await sess.run({
    image: new ort.Tensor('uint8', img, [1, 3, h, w]),
    mask: new ort.Tensor('uint8', msk, [1, 1, h, w]),
  })
  const r = out[sess.outputNames[0]].data
  const res = new Uint8ClampedArray(4 * n)
  for (let i = 0; i < n; i++) {
    res[i * 4] = r[i]; res[i * 4 + 1] = r[n + i]; res[i * 4 + 2] = r[2 * n + i]; res[i * 4 + 3] = 255
  }
  return res
}

// RawNIND (UtNet2, Bayer): joint denoise and demosaic of the mosaic. Input
// windows are 1024 raw px (512 packed RGGB quads), (raw − black)/(white −
// black) without white balance; the output is 1024² camera RGB at an
// arbitrary learned gain, matched back to the input's mean. Windows overlap
// by PAD and only their cores are kept. Each core goes straight to the render
// worker through `port` as RGBA floats; the photo is never whole in memory.
const DN_WIN = 1024
const DN_PAD = 32
let dnJob = 0
async function denoise(p, port, job) {
  const sess = await session('denoise')
  const W = p.width
  const H = p.height
  const stride = p.rawWidth ?? W
  const base = (p.top ?? 0) * stride + (p.left ?? 0)
  const d = p.buffer
  const k = 1 / (p.white - p.black)
  const [ox, oy] = p.cfa
  // mirror without changing the CFA colour (even reflections)
  const rx = (x) => (x < 0 ? -x : x >= W ? 2 * (W - 1) - x : x)
  const ry = (y) => (y < 0 ? -y : y >= H ? 2 * (H - 1) - y : y)
  const v = (x, y) => {
    const r = (d[base + ry(y) * stride + rx(x)] - p.black) * k
    return r < 0 ? 0 : r > 1 ? 1 : r
  }
  const N = DN_WIN / 2
  const inp = new Float32Array(4 * N * N)
  const core = DN_WIN - 2 * DN_PAD
  let done = 0
  const total = Math.ceil(W / core) * Math.ceil(H / core)
  for (let ty = 0; ty < H; ty += core) {
    for (let tx = 0; tx < W; tx += core) {
      if (job !== dnJob) return false // superseded: another photo or a cancel
      // window origin on an R photosite: RGGB sits at (x + ox, y + oy) even
      let xs = tx - DN_PAD
      let ys = ty - DN_PAD
      if ((xs + ox) & 1) xs -= 1
      if ((ys + oy) & 1) ys -= 1
      let sumIn = 0
      for (let j = 0; j < N; j++) {
        const Y = ys + 2 * j
        for (let i = 0; i < N; i++) {
          const X = xs + 2 * i
          const o = j * N + i
          const r = v(X, Y)
          const g1 = v(X + 1, Y)
          const g2 = v(X, Y + 1)
          const b = v(X + 1, Y + 1)
          inp[o] = r; inp[N * N + o] = g1; inp[2 * N * N + o] = g2; inp[3 * N * N + o] = b
          // like for like with the RGB output: R, mean green, B
          sumIn += r + 0.5 * (g1 + g2) + b
        }
      }
      const out = (await sess.run({ input: new ort.Tensor('float32', inp, [1, 4, N, N]) })).output.data
      let sumOut = 0
      for (let i = 0; i < out.length; i++) sumOut += out[i]
      // per photosite quad the input sums 3 values, the output 3 per pixel
      // over 4 pixels: equal means → equal sums per quad
      const gain = sumOut !== 0 ? (sumIn * 4) / sumOut : 0
      const cw = Math.min(core, W - tx)
      const ch = Math.min(core, H - ty)
      const cx0 = tx - xs
      const cy0 = ty - ys
      const P = DN_WIN * DN_WIN
      const data = new Float32Array(cw * ch * 4)
      for (let j = 0; j < ch; j++) {
        const row = (cy0 + j) * DN_WIN + cx0
        for (let i = 0; i < cw; i++) {
          const o = (j * cw + i) * 4
          data[o] = out[row + i] * gain
          data[o + 1] = out[P + row + i] * gain
          data[o + 2] = out[2 * P + row + i] * gain
          data[o + 3] = 1
        }
      }
      port.postMessage({ type: 'tile', x: tx, y: ty, w: cw, h: ch, data, done: ++done, total }, [data.buffer])
    }
  }
  port.postMessage({ type: 'done' })
  return true
}

// strictly serial, like the other workers
// (a denoise cancel jumps the queue: it must reach the job it stops)
let chain = Promise.resolve()
self.onmessage = (e) => {
  if (e.data.type === MSG.DENOISE_CANCEL) { dnJob++; return }
  chain = chain.then(() => handle(e.data))
}

const reply = (data, payload, transfer = []) =>
  self.postMessage({ re: data.id, ok: true, ...payload }, transfer)

async function handle(data) {
  try {
    if (data.base) base = data.base
    if (!ort.env.wasm.wasmPaths) {
      ort.env.wasm.wasmPaths = { wasm: new URL('ort/ort-wasm-simd-threaded.asyncify.wasm', base).href }
      ort.env.wasm.numThreads = 1 // no SharedArrayBuffer without cross-origin isolation
    }
    const t0 = performance.now()
    switch (data.type) {
      case MSG.SEG_SUBJECT: {
        const mask = await segment(data.kind ?? 'subject', data.blob, data.outW, data.outH)
        reply(data, { mask, width: data.outW, height: data.outH, ms: performance.now() - t0 }, [mask.buffer])
        break
      }
      case MSG.SAM_MASK: {
        await samEmbed(data.photoId, data.blob)
        const mask = await samMask(data.points ?? [], data.box ?? null, data.outW, data.outH)
        reply(data, { mask, width: data.outW, height: data.outH, ms: performance.now() - t0 }, [mask.buffer])
        break
      }
      case MSG.INPAINT: {
        const rgba = await inpaint(data.rgba, data.hole, data.width, data.height)
        reply(data, { rgba, ms: performance.now() - t0 }, [rgba.buffer])
        break
      }
      case MSG.DENOISE: {
        // a newer request (or a cancel) stops the running one between tiles
        const job = ++dnJob
        const ok = await denoise(data.payload, data.port, job)
        reply(data, { ok, ms: performance.now() - t0 })
        break
      }
      case MSG.AI_RELEASE: {
        // free GPU and wasm memory when the user leaves masks and removal
        for (const p of sessions.values()) p.then((s) => s.release()).catch(() => {})
        sessions.clear()
        samCache = { photoId: null, emb: null, w: 0, h: 0, scale: 1 }
        reply(data, {})
        break
      }
    }
  } catch (err) {
    self.postMessage({ re: data.id, ok: false, type: MSG.ERROR, message: String(err?.message ?? err) })
  }
}
