import { MSG } from './protocol.js'
import { createGpuDevice } from '../engine/gpu/device.js'
import { createWebGl2 } from '../engine/gpu/webgl2.js'
import { buildCurveLut } from '../engine/curve.js'
import { BAND_NAMES, MODULE_DEFAULTS, wbNeutralize } from '../engine/editdoc.js'
import { fitScaleFor } from '../engine/geometry.js'
import { lensProfileFor, packLensProfile } from '../engine/lensProfile.js'
import { parseDcp } from '../io/dcp.js'
import { encodeTiff16Deflate } from '../io/tiff.js'
import { buildDcpTransform, neutralFromCamMul } from '../engine/dcpColor.js'
import { createComposeEngine } from '../compose/engine.js'
import { installCompose } from '../compose/plugins.js'

// The render worker owns the GPU. Main thread never blocks on a render;
// slider drags arrive as coalesced PARAMS messages and draw here.

let device = null
let appBase = self.location.href // replaced by INIT's base
// current also carries the blur pyramid caches: aux (render device) and
// scratchAux (scratch GL context) — edit-independent like the demosaic
// intermediate — plus the brush textures ({ tex, sig }, sig = stroke JSON)
let current = null // { photoId, img, fullW, fullH, bitmap? | payload?, scratchImg?, aux?, scratchAux?, nr?, scratchNr?, brush?, scratchBrush? }
let lastParams = new Float32Array(128)
let lastLut = null
let lastDetail = null
let lastGrain = null
let lastDoc = null // masks + brush replay need the doc itself, not just params
let lastMasks = null // { arr: Float32Array(192), needsAux } | null
let lastHeal = null // { arr: Float32Array(256), count, needsAux } | null
let lastOverlay = -1 // flags.maskOverlay — doc.masks index washed by finish
let lastFlags = null // whole flags object — split view reads splitView/splitPos

// Layout comment lives in both develop shaders; this must build exactly that.
// flags: { before: render doc-less defaults, clipOverlay: paint clipped px,
// showUncropped: crop mode — neutral crop/angle so the raw frame shows,
// maskPreview: finish pass renders the sharpen mask weight as grayscale }
const paramsFrom = (editDoc, img, flags) => {
  const m = (flags?.before ? null : editDoc?.modules) ?? {}
  const p = new Float32Array(128)
  const bwOn = m.bw?.on ? 1 : 0
  p[0] = m.exposure?.ev ?? 0
  p[1] = m.wb?.temp ?? 0
  p[2] = m.wb?.tint ?? 0
  p[3] = m.tone?.contrast ?? 0
  p[4] = m.tone?.highlights ?? 0
  p[5] = m.tone?.shadows ?? 0
  p[6] = m.tone?.whites ?? 0
  p[7] = m.tone?.blacks ?? 0
  // B&W supersedes vibsat + colormix: leave them (and mixOn below) zeroed
  if (!bwOn) {
    p[8] = m.vibsat?.vibrance ?? 0
    p[9] = m.vibsat?.saturation ?? 0
  }
  p[10] = m.curve?.points ? 1 : 0
  p[11] = img?.isLinear ?? 0
  p[12] = flags?.clipOverlay ? 1 : 0
  if (!bwOn) BAND_NAMES.forEach((b, i) => {
    const v = m.colormix?.[b]
    p[16 + i * 4] = v?.h ?? 0
    p[16 + i * 4 + 1] = v?.s ?? 0
    p[16 + i * 4 + 2] = v?.l ?? 0
  })
  p[48] = m.localcontrast?.clarity ?? 0
  p[49] = m.localcontrast?.texture ?? 0
  p[50] = m.localcontrast?.dehaze ?? 0
  // resScale = renderW/fullW: sources are opened at full decode today, so 1;
  // the slot keeps preview/export blur sigmas image-relative once proxies land
  p[51] = 1
  p[52] = m.vignette?.amount ?? 0
  p[53] = m.vignette?.midpoint ?? 50
  p[54] = m.vignette?.roundness ?? 0
  p[55] = m.vignette?.feather ?? 50
  // lcOn: gate aux sampling (and, upstream, the blur passes themselves)
  p[56] = p[48] !== 0 || p[49] !== 0 || p[50] !== 0 ? 1 : 0
  // mixOn: gate the OKLab round-trip so untouched pixels stay bit-exact
  for (let i = 8; i < 10; i++) if (p[i] !== 0) p[13] = 1
  for (let i = 16; i < 48; i++) if (p[i] !== 0) p[13] = 1
  // lens [84..88] — distortion/CA/defringe, raw sliders scaled in-shader
  p[84] = m.lens?.distortion ?? 0
  p[85] = m.lens?.caRed ?? 0
  p[86] = m.lens?.caBlue ?? 0
  p[87] = m.lens?.defringe ?? 0
  p[88] = p[84] !== 0 || p[85] !== 0 || p[86] !== 0 || p[87] !== 0 ? 1 : 0
  // lens profile [96..111]: RAW only (cameras correct their own JPEGs)
  const lensProf = img?.isLinear && (m.lens?.profile ?? 1) ? current?.lensProfile : null
  packLensProfile(p, lensProf, m.lens?.profDistortion ?? 100, m.lens?.profVignette ?? 100)
  // AI denoise [111]: only once the whole denoised image is in, and only on
  // a device that reads back itself (a scratch context has no copy of it)
  if (current?.dn?.ready && selfReadback()) p[111] = Math.min(1, Math.max(0, (m.detail?.aiDenoise ?? 0) / 100))
  if (p[87] !== 0) p[56] = 1 // defringe reads blurSmall — force the pyramid
  // geometry [57..63] + perspective [89..91] — deliberately NOT gated by
  // `before` (the frame's aspect must not jump when comparing);
  // showUncropped neutralizes crop and angle so crop mode manipulates the
  // raw frame (flip and keystone stay applied)
  const g = flags?.showUncropped ? null : editDoc?.modules?.geometry
  const persp = editDoc?.modules?.geometry?.persp ?? null
  const crop = g?.crop ?? { x: 0, y: 0, w: 1, h: 1 }
  p[57] = ((g?.angle ?? 0) * Math.PI) / 180
  p[58] = crop.x
  p[59] = crop.y
  p[60] = crop.w
  p[61] = crop.h
  p[62] = img ? fitScaleFor(crop, p[57], img.width, img.height, persp, p[84],
    p[96] ? Array.from(p.subarray(97, 101)) : null) : 1
  p[63] = editDoc?.modules?.geometry?.flipH ?? 0
  p[89] = persp?.v ?? 0
  p[90] = persp?.h ?? 0
  p[91] = p[89] !== 0 || p[90] !== 0 ? 1 : 0
  // 3-way grading [64..72] + B&W [73, 76..83] — layout comment in the shaders
  const gr = m.grading
  p[64] = gr?.shadows?.h ?? 0
  p[65] = gr?.shadows?.s ?? 0
  p[66] = gr?.midtones?.h ?? 0
  p[67] = gr?.midtones?.s ?? 0
  p[68] = gr?.highlights?.h ?? 0
  p[69] = gr?.highlights?.s ?? 0
  p[70] = gr?.blending ?? 50
  p[71] = gr?.balance ?? 0
  p[72] = p[65] !== 0 || p[67] !== 0 || p[69] !== 0 ? 1 : 0
  p[73] = bwOn
  if (bwOn) BAND_NAMES.forEach((b, i) => { p[76 + i] = m.bw?.mix?.[b] ?? 0 })
  // look [92..94]: the profile survives `before`, like Lightroom's
  const look = editDoc?.modules?.look ?? (img?.isLinear ? MODULE_DEFAULTS.look : null)
  if (look?.profile === 'agx') {
    p[92] = 1
    p[93] = look.baseline ?? 0
    p[94] = (look.saturation ?? 100) / 100
  }
  // a DCP camera profile [112..127] (RAW): matrix + tables at the source, its
  // tone curve at the display, after the look's baseline and the profile's own
  const dcp = look?.profile?.startsWith('dcp:') ? dcpFor(look.profile.slice(4)) : null
  if (dcp) {
    p[93] = (look.baseline ?? 0) + (dcp.t.baselineExposureOffset ?? 0)
    p[112] = 1
    p[113] = dcp.t.hsv ? 1 : 0
    p[114] = dcp.t.toneLut ? 1 : 0
    p[115] = dcp.t.hsv?.encoding === 1 ? 1 : 0
    p.set(dcp.M, 116)
    if (dcp.t.hsv) p.set(dcp.t.hsv.dims, 125)
  }
  return p
}

// ── local adjustment masks ─────────────────────────────────────────────────
// masksU: 8 masks × 24 floats — layout comment in the develop shaders
// (floats 16..23 per record are the optional luma/color range refinement).
// Only enabled masks with a non-zero adjust occupy slots; wash-only masks
// (all-zero adjust) still get a brush channel + finish-pass record.

// brush AND ai masks own rgba8 channels 0..3 of the quarter-res brushTex,
// assigned by doc order (shared budget); beyond 4 dropped with a warning.
// Mirror of texChannels in state/segmentClient.js.
const brushChannels = (doc) => {
  const map = new Map()
  for (const m of doc?.masks ?? []) {
    if (m.kind !== 'brush' && m.kind !== 'ai') continue
    if (map.size < 4) map.set(m.id, map.size)
    else console.warn(`masks: mask "${m.name ?? m.id}" beyond channel budget (4), ignored`)
  }
  return map
}

const packMask = (m, arr, o, brushCh) => {
  arr[o] = m.kind === 'linear' ? 0 : m.kind === 'radial' ? 1 : 2
  arr[o + 1] = m.invert ? 1 : 0
  arr[o + 2] = 1
  const g = m.geom
  if (m.kind === 'linear') {
    arr[o + 3] = g.x0; arr[o + 4] = g.y0; arr[o + 5] = g.x1; arr[o + 6] = g.y1
  } else if (m.kind === 'radial') {
    arr[o + 3] = g.cx; arr[o + 4] = g.cy; arr[o + 5] = g.rx; arr[o + 6] = g.ry
    arr[o + 7] = ((g.angle ?? 0) * Math.PI) / 180
    arr[o + 8] = g.feather ?? 0.5
  } else {
    arr[o + 3] = brushCh
  }
  const a = m.adjust ?? {}
  arr[o + 9] = a.ev ?? 0; arr[o + 10] = a.temp ?? 0; arr[o + 11] = a.contrast ?? 0
  arr[o + 12] = a.highlights ?? 0; arr[o + 13] = a.shadows ?? 0
  arr[o + 14] = a.saturation ?? 0; arr[o + 15] = a.clarity ?? 0
  // range refinement (optional): luma window + OKLCh color proximity
  const rl = m.range?.luma
  if (rl) {
    arr[o + 16] = 1
    arr[o + 17] = rl.lo ?? 0
    arr[o + 18] = rl.hi ?? 1
    arr[o + 19] = rl.softness ?? 0.5
  }
  const rc = m.range?.color
  if (rc) {
    arr[o + 20] = 1
    arr[o + 21] = rc.h ?? 0
    arr[o + 22] = rc.s ?? 0
    arr[o + 23] = rc.tol ?? 50
  }
}

const masksFrom = (editDoc, flags) => {
  const list = flags?.before ? [] : editDoc?.masks ?? []
  const chans = brushChannels(editDoc)
  const active = list.filter((m) => m.enabled !== false &&
    Object.values(m.adjust ?? {}).some((v) => v) &&
    ((m.kind !== 'brush' && m.kind !== 'ai') || chans.has(m.id)))
  if (active.length > 8) console.warn(`masks: ${active.length} active, rendering first 8`)
  const use = active.slice(0, 8)
  if (!use.length) return null
  const arr = new Float32Array(192)
  use.forEach((m, i) => packMask(m, arr, i * 24, chans.get(m.id) ?? 0))
  return { arr, needsAux: use.some((m) => m.adjust?.clarity) }
}

// ── heal/clone spots — healU: 32 spots × 8 floats (layout in the shaders) ──
// 'heal' spots need blurSmall for the low-frequency rim match, so they force
// the pyramid like mask clarity does. Count rides params[74].
const healFrom = (editDoc, flags) => {
  const spots = (flags?.before ? null : editDoc?.modules?.heal?.spots) ?? []
  if (!spots.length) return null
  if (spots.length > 32) console.warn(`heal: ${spots.length} spots, rendering first 32`)
  const use = spots.slice(0, 32)
  const arr = new Float32Array(256)
  use.forEach((s, i) => {
    const o = i * 8
    arr[o] = s.mode === 'heal' ? 1 : 0
    arr[o + 1] = s.dx
    arr[o + 2] = s.dy
    arr[o + 3] = s.sx
    arr[o + 4] = s.sy
    arr[o + 5] = s.r
    arr[o + 6] = s.feather ?? 0.5
  })
  return { arr, count: use.length, needsAux: use.some((s) => s.mode === 'heal') }
}

// params carry the heal count + pyramid forcing; one call after paramsFrom
const applyHeal = (p, heal) => {
  p[74] = heal?.count ?? 0
  if (heal?.needsAux) p[56] = 1
  return heal
}

// ── brush texture cache: replay from doc strokes, keyed by stroke JSON ─────
// MSG.BRUSH stamps incrementally during a stroke; the commit changes the sig
// and the next PARAMS replays everything — idempotent, and undo/delete of
// strokes rebuilds for free. AI masks share the texture: their CPU-held
// weights (MSG.MASKTEX, current.ai) upload as a full-RGBA base BEFORE the
// stamps — colorMask'd stamping never touches the other channels.
let aiRev = 0 // bumps per MASKTEX arrival; keys the sig
const brushSig = (doc) => JSON.stringify((doc?.masks ?? [])
  .filter((m) => m.kind === 'brush' || m.kind === 'ai').slice(0, 4)
  .map((m) => m.kind === 'ai'
    ? [m.geom?.refine ?? 0, current?.ai?.get(m.id)?.rev ?? 0]
    : m.geom))

// separable gaussian on a single-channel Uint8 plane (refine-edge blur);
// runs at quarter res so σ ≤ 8px stays cheap
const gaussBlur = (src, w, h, sigma) => {
  const r = Math.max(1, Math.ceil(sigma * 3))
  const k = new Float32Array(r + 1)
  let sum = 0
  for (let i = 0; i <= r; i++) { k[i] = Math.exp(-(i * i) / (2 * sigma * sigma)); sum += i ? 2 * k[i] : k[i] }
  for (let i = 0; i <= r; i++) k[i] /= sum
  const tmp = new Float32Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = k[0] * src[y * w + x]
    for (let i = 1; i <= r; i++) {
      a += k[i] * (src[y * w + Math.max(0, x - i)] + src[y * w + Math.min(w - 1, x + i)])
    }
    tmp[y * w + x] = a
  }
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = k[0] * tmp[y * w + x]
    for (let i = 1; i <= r; i++) {
      a += k[i] * (tmp[Math.max(0, y - i) * w + x] + tmp[Math.min(h - 1, y + i) * w + x])
    }
    out[y * w + x] = Math.round(a)
  }
  return out
}

const rescaleNearest = (rec, w, h) => { // dims drifted by rounding — snap
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    out[y * w + x] = rec.data[
      Math.min(rec.height - 1, Math.round((y * rec.height) / h)) * rec.width +
      Math.min(rec.width - 1, Math.round((x * rec.width) / w))]
  }
  return out
}

// RGBA base image holding every ai mask's weights in its assigned channel
const aiComposite = (doc, qw, qh) => {
  if (!current?.ai?.size) return null
  let ch = -1
  let any = false
  const out = new Uint8Array(qw * qh * 4)
  for (const m of doc?.masks ?? []) {
    if (m.kind !== 'brush' && m.kind !== 'ai') continue
    if (++ch >= 4) break
    if (m.kind !== 'ai') continue
    const rec = current.ai.get(m.id)
    if (!rec) continue
    let d = rec.width === qw && rec.height === qh ? rec.data : rescaleNearest(rec, qw, qh)
    const sigma = ((m.geom?.refine ?? 0) / 100) * 8 // px at quarter res
    if (sigma >= 0.3) d = gaussBlur(d, qw, qh, sigma)
    for (let i = 0, n = qw * qh; i < n; i++) out[i * 4 + ch] = d[i]
    any = true
  }
  return any ? out : null
}

const replayBrush = (dev, tex, doc) => {
  dev.clearBrush(tex)
  const ai = aiComposite(doc, tex.width, tex.height)
  if (ai) dev.uploadBrushRGBA(tex, ai)
  let ch = -1
  for (const m of doc?.masks ?? []) {
    if (m.kind !== 'brush' && m.kind !== 'ai') continue
    if (++ch >= 4) break
    if (m.kind !== 'brush') continue
    for (const s of m.geom.strokes ?? []) {
      dev.stampBrush(tex, ch, s.pts, s.size, s.flow, s.erase, current.fullW, current.fullH)
    }
  }
}
const brushOn = (dev, slot, doc) => { // slot: 'brush' | 'scratchBrush'
  const sig = brushSig(doc)
  if (sig === '[]') return null
  let b = current[slot]
  if (!b) {
    const w = Math.max(1, Math.round(current.fullW / 4))
    const h = Math.max(1, Math.round(current.fullH / 4))
    b = current[slot] = { tex: dev.createBrushTex(w, h), sig: null }
  }
  if (b.sig !== sig) {
    replayBrush(dev, b.tex, doc)
    b.sig = sig
  }
  return b.tex
}
const brushFor = (doc) => current ? brushOn(device, 'brush', doc) : null
const scratchBrushFor = (doc) => current ? brushOn(scratch(), 'scratchBrush', doc) : null

// finish-pass wash record for the maskOverlay flag
const washFor = () => {
  const mk = lastOverlay >= 0 ? lastDoc?.masks?.[lastOverlay] : null
  if (!mk || !current) return null
  const rec = new Float32Array(24)
  packMask(mk, rec, 0, brushChannels(lastDoc).get(mk.id) ?? 0)
  return { rec }
}

// finish-pass geometry — rides the SAME params the develop draw used (loupe
// sub-crop included), so wash + grain evaluate at develop's source coordinate
// (keystone + distortion twins included)
const geomFor = (p) => current && {
  geom: [p[57], p[58], p[59], p[60], p[61], p[62]],
  srcW: current.fullW,
  srcH: current.fullH,
  perspV: p[89],
  perspH: p[90],
  distortion: p[84],
}

// Detail (sharpen + NR) rides OUTSIDE the 64-float params: NR is a source
// prepass, sharpen the finish pass — the develop layout is untouched.
// Non-RAW gating: JPEGs are already sharpened/denoised in-camera, so absent
// an explicit detail module the whole family is OFF for bitmap sources;
// RAW gets MODULE_DEFAULTS.detail implicitly (mirrors Lightroom).
const detailFrom = (editDoc, isRaw, flags) => {
  const m = flags?.before ? null : editDoc?.modules?.detail
  const d = m ?? (isRaw ? MODULE_DEFAULTS.detail : null)
  return {
    sharpenAmount: d?.sharpenAmount ?? 0,
    sharpenRadius: d?.sharpenRadius ?? 1,
    sharpenMasking: d?.sharpenMasking ?? 0,
    // AI denoise replaces the wavelet NR rather than stacking on it
    lumaNR: d?.aiDenoise ? 0 : d?.lumaNR ?? 0,
    chromaNR: d?.aiDenoise ? 0 : d?.chromaNR ?? 0,
    maskPreview: flags?.maskPreview ? 1 : 0,
  }
}

// Grain (display-referred, finish pass) also rides OUTSIDE the params array.
const grainFrom = (editDoc, flags) => {
  const m = flags?.before ? null : editDoc?.modules?.grain
  return { amount: m?.amount ?? 0, size: m?.size ?? 25, roughness: m?.roughness ?? 50 }
}
// resScale (params[51]) inflates the cell in source px so grain keeps its
// 1..3 px feature size in OUTPUT px on down-scaled renders (worker longEdge)
const grainDesc = (g, resScale) => g?.amount > 0
  ? { amount: g.amount, cell: (1 + (2 * g.size) / 100) / Math.max(resScale, 1e-3), rough: g.roughness / 100 }
  : null

// Developed-output pixel dims implied by a params array (crop / fitScale).
const outDimsOf = (p) => [
  Math.max(1, Math.round((current.fullW * p[60]) / p[62])),
  Math.max(1, Math.round((current.fullH * p[61]) / p[62])),
]

// Loupe view sent by VIEW; 'fit' renders the whole developed output.
let view = { w: 0, h: 0, zoom: 'fit', panX: 0.5, panY: 0.5 }

// ROI at loupe zoom: the visible output window folds INTO the crop slots as a
// sub-crop with the same total affine — the rotation pivot moves to the
// sub-window center, so cropXY is compensated in closed form and the shader
// needs no extra uniforms. Fit mode returns params untouched.
const viewParams = () => {
  const p = lastParams
  const z = view.zoom
  if (!current || !(z > 0)) return p
  const W = current.fullW
  const H = current.fullH
  const th = p[57]
  const f = p[62]
  const cw = p[60]
  const ch = p[61]
  const outW = (cw * W) / f
  const outH = (ch * H) / f
  const sx = Math.min(1, view.w / (z * outW))
  const sy = Math.min(1, view.h / (z * outH))
  const offX = Math.min(Math.max(view.panX - sx / 2, 0), 1 - sx)
  const offY = Math.min(Math.max(view.panY - sy / 2, 0), 1 - sy)
  const cx = p[58] + cw / 2
  const cy = p[59] + ch / 2
  // K(v) = R(θ)·(v∘dims)/f ∘ dims⁻¹ — the shader's window→source linear map
  const c = Math.cos(th)
  const s = Math.sin(th)
  const K = (x, y) => [(c * x * W - s * y * H) / (f * W), (s * x * W + c * y * H) / (f * H)]
  const w2 = sx * cw
  const h2 = sy * ch
  const g0 = K(p[58] + offX * cw - cx, p[59] + offY * ch - cy)
  const gh = K(w2 / 2, h2 / 2)
  const q = p.slice()
  // crop' = C + K(g0) − wh'/2 + K(wh'/2): shader center C' then reproduces
  // exactly C + K(window offset) — pivot compensation
  q[58] = cx + g0[0] - w2 / 2 + gh[0]
  q[59] = cy + g0[1] - h2 / 2 + gh[1]
  q[60] = w2
  q[61] = h2
  return q
}

// Blur pyramids are computed lazily on the first render that needs them
// (lcOn), then reused for every later render — including gestures, which
// never change the source. One cache per GPU context that can draw this
// photo: the render device and (webgpu backend) the scratch GL context.
const auxFor = (params) => {
  if (!current || !params[56]) return null
  current.aux ??= device.computeAux(current.img, params[51])
  return current.aux
}
const scratchAuxFor = (params, img) => {
  if (!current || !params[56]) return null
  current.scratchAux ??= scratch().computeAux(img, params[51])
  return current.scratchAux
}

// Denoised-source cache — keyed by (photoId, lumaNR, chromaNR) via the key
// string on the OPEN photo; NR slider moves rebuild (7 full-res passes),
// gestures on every OTHER slider reuse it. Aux pyramids stay derived from
// the ORIGINAL source: their σ swamps the noise NR removes.
const nrFor = (d) => {
  if (!current || (!d.lumaNR && !d.chromaNR)) return null
  const key = `${d.lumaNR}/${d.chromaNR}`
  if (current.nr && current.nr.key !== key) { current.nr.destroy(); current.nr = null }
  current.nr ??= { key, ...device.computeNR(current.img, d.lumaNR, d.chromaNR) }
  return current.nr.img
}
const scratchNrFor = (d, img) => {
  if (!current || (!d.lumaNR && !d.chromaNR)) return null
  const key = `${d.lumaNR}/${d.chromaNR}`
  if (current.scratchNr && current.scratchNr.key !== key) { current.scratchNr.destroy(); current.scratchNr = null }
  current.scratchNr ??= { key, ...scratch().computeNR(img, d.lumaNR, d.chromaNR) }
  return current.scratchNr.img
}

// Finish-pass descriptor; null when sharpening, grain, the mask wash AND the
// split divider are all inert. σ floor keeps the gaussian well-defined at
// tiny display scales. geom (from geomFor) must accompany wash or grain.
// split ({ dir, pos }, display only) forces the pass — the divider paints in
// finish and the split composite renders into the finish intermediate.
const finFor = (d, scale, clipOverlay, wash = null, grain = null, geom = null, split = null) => {
  if (!(d.sharpenAmount > 0 || d.maskPreview || wash || grain || split)) return null
  return {
    amount: d.sharpenAmount,
    sigma: Math.max(0.3, d.sharpenRadius * scale),
    maskT: (d.sharpenMasking / 100) * 0.04,
    maskPreview: d.maskPreview,
    clipOverlay,
    wash,
    grain,
    geom: wash || grain ? geom : null,
    split,
  }
}

// Sharpen σ is display-referred: at fit the render is smaller than the
// developed output, so scale by renderW/outW; 1:1+ loupe and export are 1.
const displayScale = () => {
  if (!current || view.zoom > 0 || !view.w) return 1
  const [ow, oh] = outDimsOf(lastParams)
  return Math.min(1, view.w / ow, view.h / oh)
}

// Split view (flags.splitView 'h'|'v'): the BEFORE doc draws one half of the
// finish intermediate, the current doc the other. Geometry slots are copied
// from the FOLDED current params so both halves frame identically (loupe
// included); the before half samples the un-NR'd source directly — a visual
// compare, not an export path (EXPORT never sees the flag).
const splitFor = (foldedParams) => {
  const sv = lastFlags?.splitView
  if (!current || (sv !== 'h' && sv !== 'v')) return null
  const p2 = paramsFrom(lastDoc, current.img, { ...lastFlags, before: true })
  for (let i = 57; i <= 63; i++) p2[i] = foldedParams[i]
  p2[51] = foldedParams[51]
  p2[11] = current.img.isLinear ?? 0
  p2[12] = 0
  return {
    params2: p2,
    lut2: IDENTITY_LUT,
    dir: sv,
    pos: Math.min(Math.max(lastFlags.splitPos ?? 0.5, 0.02), 0.98),
  }
}

// One display render: NR (cached) swaps the develop input, sharpen/wash
// appends the finish pass. Overrides ride a copy — lastParams stays canonical.
const renderCurrent = (offscreen = false) => {
  const nrImg = nrFor(lastDetail)
  let p = viewParams()
  const split = splitFor(p)
  const fin = finFor(lastDetail, displayScale(), lastParams[12], washFor(),
    grainDesc(lastGrain, lastParams[51]), geomFor(p), split)
  if (nrImg || fin) {
    p = p.slice()
    if (nrImg) p[11] = 1 // NR output is scene-linear
    if (fin) p[12] = 0 // finish paints the clip overlay post-sharpen
  }
  device.render(nrImg ?? current.img, p, lastLut, auxFor(lastParams), fin,
    lastMasks?.arr ?? null, brushFor(lastDoc), lastHeal?.arr ?? null, split, offscreen)
}

// LUT rebuilt only when the curve points change; the stable Float32Array
// reference doubles as the backends' "already uploaded" check.
const IDENTITY_LUT = buildCurveLut(null)
let lutCache = { key: null, lut: IDENTITY_LUT }
const lutFrom = (editDoc, flags) => {
  const pts = flags?.before ? null : editDoc?.modules?.curve?.points
  if (!pts) return IDENTITY_LUT
  const key = JSON.stringify(pts)
  if (lutCache.key !== key) lutCache = { key, lut: buildCurveLut(pts) }
  return lutCache.lut
}

// Scopes and (on webgpu) exports render through a persistent scratch WebGL2
// context: readPixels is the one readback that works on every stack, while
// WebGPU mapAsync/onSubmittedWorkDone hang on SwiftShader. One code path,
// zero WebGPU readback dependence.
let scratchGl = null
const scratch = () => {
  // the first GL context in a worker already holding a WebGPU device fails
  // transiently on ANGLE/SwiftShader; a second attempt on a fresh canvas works
  scratchGl ??= createWebGl2(new OffscreenCanvas(1, 1)) ?? createWebGl2(new OffscreenCanvas(1, 1))
  if (!scratchGl) throw new Error('scratch WebGL2 context failed')
  return scratchGl
}
// the render device reads back itself unless it is a software WebGPU adapter
// (see the note above); then a scratch WebGL2 context re-renders instead,
// at the cost of a second copy of the photo on the GPU
const selfReadback = () => device.backend === 'webgl2' || device.readback
const readbackDevice = () => selfReadback() ? device : scratch()
const readbackImage = () => {
  if (selfReadback()) return current.img
  current.scratchImg ??= current.payload
    ? scratch().uploadDecoded(current.payload, current.recon)
    : scratch().uploadImage(current.bitmap)
  return current.scratchImg
}

let scopesAt = 0
// 256-bin r/g/b/luma histogram + clip fractions of the DISPLAYED image,
// rendered small (≤320×240) and binned in JS. Gestures throttle to ≤15Hz;
// every non-gesture render reports.
async function computeScopes(gesture) {
  if (!current) return
  const now = performance.now()
  if (gesture && now - scopesAt < 1000 / 15) return
  scopesAt = now
  // full developed output (never the loupe window) at the crop's aspect
  const [gW, gH] = outDimsOf(lastParams)
  const s = Math.min(1, 320 / gW, 240 / gH)
  const w = Math.max(1, Math.round(gW * s))
  const h = Math.max(1, Math.round(gH * s))
  const p = lastParams.slice()
  p[12] = 0 // overlay paint would corrupt the histogram
  const img = readbackImage()
  const aux = selfReadback() ? auxFor(p) : scratchAuxFor(p, img)
  // detail routes through scopes too (mask preview and overlay stripped);
  // sharpen σ scales with the same shrink so acutance matches the display
  const d = { ...lastDetail, maskPreview: 0 }
  const nrImg = selfReadback() ? nrFor(d) : scratchNrFor(d, img)
  if (nrImg) p[11] = 1
  // masks route through scopes too (wash stripped — it would corrupt the
  // bins); grain stays in — it IS image content and belongs in the histogram
  const brush = selfReadback() ? brushFor(lastDoc) : scratchBrushFor(lastDoc)
  const px = await readbackDevice().renderToPixels(nrImg ?? img, p, w, h, lastLut, aux,
    finFor(d, s, 0, null, grainDesc(lastGrain, p[51]), geomFor(p)), lastMasks?.arr ?? null, brush,
    lastHeal?.arr ?? null)
  const hist = new Uint32Array(256 * 4)
  let hi = 0
  let lo = 0
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i]
    const g = px[i + 1]
    const b = px[i + 2]
    hist[r]++
    hist[256 + g]++
    hist[512 + b]++
    hist[768 + Math.min(255, Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b))]++
    if (r >= 254 || g >= 254 || b >= 254) hi++
    if (r <= 1 || g <= 1 || b <= 1) lo++
  }
  const n = w * h
  post({ type: MSG.SCOPES, photoId: current.photoId, hist, clipShadows: lo / n, clipHighlights: hi / n },
    [hist.buffer])
}

// ── auto adjustments + point sampling ──────────────────────────────────────
const s2l = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)

// small readback render of the current photo under a (possibly stripped) doc
// — the scopes route: readback device + aux/NR/brush caches, ≤320×240, no
// finish pass (sharpen/grain would perturb the statistics)
async function renderSmallFor(doc) {
  const p = paramsFrom(doc, current.img)
  p[12] = 0
  const masks = masksFrom(doc)
  if (masks?.needsAux) p[56] = 1
  const heal = applyHeal(p, healFrom(doc))
  const [gW, gH] = outDimsOf(p)
  const s = Math.min(1, 320 / gW, 240 / gH)
  const w = Math.max(1, Math.round(gW * s))
  const h = Math.max(1, Math.round(gH * s))
  const img = readbackImage()
  const aux = selfReadback() ? auxFor(p) : scratchAuxFor(p, img)
  const d = detailFrom(doc, !!current.payload)
  const nrImg = selfReadback() ? nrFor(d) : scratchNrFor(d, img)
  if (nrImg) p[11] = 1
  const brush = selfReadback() ? brushFor(doc) : scratchBrushFor(doc)
  const px = await readbackDevice().renderToPixels(nrImg ?? img, p, w, h, lutFrom(doc),
    aux, null, masks?.arr ?? null, brush, heal?.arr ?? null)
  return { px, w, h }
}

const lumaByte = (px, i) =>
  Math.min(255, Math.round(0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]))

// auto WB: gray-world over the brightest 50% (clipped pixels excluded),
// inverted through the shaders' own wb_mul model
function autoWbFrom(px) {
  const hist = new Uint32Array(256)
  const n = px.length / 4
  for (let i = 0; i < px.length; i += 4) hist[lumaByte(px, i)]++
  let acc = 0
  let thr = 0
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= n / 2) { thr = v; break } }
  let r = 0
  let g = 0
  let b = 0
  let m = 0
  for (let i = 0; i < px.length; i += 4) {
    const R = px[i]
    const G = px[i + 1]
    const B = px[i + 2]
    if (R >= 250 || G >= 250 || B >= 250 || lumaByte(px, i) < thr) continue
    r += s2l(R / 255); g += s2l(G / 255); b += s2l(B / 255); m++
  }
  return { wb: m ? wbNeutralize([r / m, g / m, b / m]) : { ...MODULE_DEFAULTS.wb } }
}

// auto tone: display-luma percentiles → parametric sliders. Exposure puts the
// median at display ~0.42; blacks/whites stretch the 0.5%/99.5% percentiles
// toward display 0.02/0.98, inverted through the shader's own zone weights
// (lift toward an already-met target is damped ×0.15 — crushed blacks stay
// black); shadows/highlights re-center the quartiles at ∓1.5/+1.2 stops from
// mid-gray. Measured with exposure+tone stripped → idempotent.
function autoToneFrom(px) {
  const hist = new Uint32Array(256)
  const n = px.length / 4
  for (let i = 0; i < px.length; i += 4) hist[lumaByte(px, i)]++
  const pct = (q) => {
    let acc = 0
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= q * n) return v / 255 }
    return 1
  }
  const ev = Math.round(Math.max(-5, Math.min(5,
    Math.log2(s2l(0.42) / Math.max(s2l(pct(0.5)), 1e-5)))) * 20) / 20
  const lz = (v) => Math.log2(Math.max(s2l(v) * 2 ** ev, 1e-6) / 0.18)
  const sst = (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)
  }
  const cl = (v, lim) => Math.round(Math.max(-lim, Math.min(lim, v)))
  const lzLo = lz(pct(0.005))
  let dB = Math.log2(s2l(0.02) / 0.18) - lzLo
  if (dB > 0) dB *= 0.15
  const blacks = cl((100 * dB) / (0.75 * Math.max(sst(2, 4.5, -lzLo), 0.25)), 100)
  const lzHi = lz(pct(0.995))
  let dW = Math.log2(s2l(0.98) / 0.18) - lzHi
  if (dW < 0) dW *= 0.6 // pulling blown whites back is gentler than the reach
  const whites = cl((100 * dW) / (0.75 * Math.max(sst(1, 2.47, lzHi), 0.25)), 80)
  const shadows = cl(35 * (-1.5 - lz(pct(0.25))), 60)
  const highlights = cl(35 * (1.2 - lz(pct(0.75))), 60)
  return {
    exposure: { ev, black: 0 },
    tone: { contrast: 0, highlights, shadows, whites, blacks },
  }
}

// Highlight reconstruction rides the demosaic pass, so the RAW intermediate
// is edit-independent EXCEPT for modules.recon (default ON, absent = on).
// Toggles are rare: rebuild the intermediate + every derived cache. Rides
// the committed doc only — before/split never trigger a rebuild.
const reconOf = (doc) => ((doc?.modules?.recon?.on ?? 1) ? 1 : 0)
const ensureRecon = (editDoc) => {
  if (!current?.payload?.buffer) return
  const recon = reconOf(editDoc)
  if (recon === current.recon) return
  device.destroyImage(current.img)
  current.img = device.uploadDecoded(current.payload, recon)
  current.recon = recon
  current.aux?.destroy(); current.aux = null
  current.nr?.destroy(); current.nr = null
  if (current.scratchImg) { scratchGl?.destroyImage(current.scratchImg); current.scratchImg = null }
  current.scratchAux?.destroy(); current.scratchAux = null
  current.scratchNr?.destroy(); current.scratchNr = null
}

// one message of the AI denoise stream: a tile, or the end of it
function dnMessage(photoId, m) {
  if (!current || current.photoId !== photoId || !current.dn) return
  if (m.type === 'tile') {
    device.denoiseTile(current.payload, current.img, m)
    post({ type: MSG.DN_STATE, photoId, done: m.done, total: m.total, ready: false })
    return
  }
  if (m.type === 'done') {
    current.dn.ready = true
    current.dn.release()
    post({ type: MSG.DN_STATE, photoId, ready: true })
    chain = chain.then(async () => {
      if (!current || current.photoId !== photoId || !lastDoc) return
      lastParams = paramsFrom(lastDoc, current.img, lastFlags)
      syncPatches(lastFlags?.before ? null : lastDoc, lastParams)
      lastDetail = detailFrom(lastDoc, !!current.payload, lastFlags)
      renderCurrent()
      post({ type: MSG.FRAME, photoId })
      await computeScopes(false)
    })
  }
}

// ── DCP camera profiles ─────────────────────────────────────────────────────
// Imported profile bytes arrive by id (PROFILE) and stay parsed here; the
// transform depends on the open photo's white balance, so it is built per
// photo and per profile, and its tables go to the device once.
const dcpProfiles = new Map()
const mul3 = (a, b) => {
  const o = new Float32Array(9)
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]
  return o
}
const inv3 = (m) => {
  const [a, b, c, d, e, f, g, h, i] = m
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g
  const det = a * A + b * B + c * C
  return Float32Array.of(A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d),
    C, -(a * h - b * g), a * e - b * d).map((v) => v / det)
}
function dcpFor(id) {
  const prof = dcpProfiles.get(id)
  const pay = current?.payload
  if (!prof || !pay) return null
  if (current.dcp?.id === id) return current.dcp
  const t = buildDcpTransform(prof, neutralFromCamMul(pay.camMul))
  // the source is already LibRaw's camera → Rec.709; correct it to the profile's
  current.dcp = { id, t, M: mul3(t.camToRec709, inv3(pay.camToSrgb)) }
  device.setProfile(t.hsv ?? null, t.toneLut ?? null)
  if (scratchGl && !selfReadback()) scratchGl.setProfile(t.hsv ?? null, t.toneLut ?? null)
  return current.dcp
}

// ── removal patches ────────────────────────────────────────────────────────
// Patch pixels arrive once per patch (PATCH) and are packed into one rgba8
// atlas; which patches draw, and where, follows the doc on every render, so
// undo and redo cost nothing.
const ATLAS = 2048
function packAtlas(images) {
  // shelf packing, largest first; halve everything until it fits
  for (let k = 1; k <= 8; k *= 2) {
    const list = [...images].map(([id, im]) => ({ id, im, w: Math.ceil(im.width / k), h: Math.ceil(im.height / k) }))
      .sort((a, b) => b.h - a.h)
    let x = 0, y = 0, rowH = 0
    const place = new Map()
    let ok = true
    for (const it of list) {
      if (x + it.w > ATLAS) { x = 0; y += rowH; rowH = 0 }
      if (it.w > ATLAS || y + it.h > ATLAS) { ok = false; break }
      place.set(it.id, { x, y, w: it.w, h: it.h, im: it.im })
      x += it.w
      rowH = Math.max(rowH, it.h)
    }
    if (!ok) continue
    const data = new Uint8ClampedArray(ATLAS * ATLAS * 4)
    const cv = new OffscreenCanvas(ATLAS, ATLAS).getContext('2d', { willReadFrequently: true })
    for (const p of place.values()) {
      const src = new OffscreenCanvas(p.im.width, p.im.height)
      src.getContext('2d').putImageData(new ImageData(p.im.data, p.im.width, p.im.height), 0, 0)
      cv.drawImage(src, p.x, p.y, p.w, p.h)
    }
    data.set(cv.getImageData(0, 0, ATLAS, ATLAS).data)
    const uv = new Map([...place].map(([id, p]) => [id, [p.x / ATLAS, p.y / ATLAS, p.w / ATLAS, p.h / ATLAS]]))
    return { width: ATLAS, height: ATLAS, data: new Uint8Array(data.buffer), uv }
  }
  return null
}

// doc → patchU rects for the patches the atlas holds; sets params[110]
function syncPatches(doc, p) {
  const list = (doc?.modules?.remove?.patches ?? []).filter((q) => current?.atlas?.uv.has(q.id)).slice(0, 16)
  const rects = new Float32Array(192)
  list.forEach((q, i) => {
    rects.set([q.x, q.y, q.w, q.h, ...current.atlas.uv.get(q.id), q.scale ?? 1], i * 12)
  })
  p[110] = list.length
  device.setPatches(undefined, rects)
  if (scratchGl && !selfReadback()) scratchGl.setPatches(undefined, rects)
}

const closeCurrent = () => {
  if (!current) return
  if (current.keep) {
    // Compose holds this photo as a smart object: keep its textures, drop
    // only the device-wide state that belongs to Develop's open photo
    if (current.dcp) device.setProfile(null, null)
    if (current.dn) { current.dn.port?.close(); current.dn.release?.(); device.setDenoised(null); current.dn = null }
    if (current.atlas) device.setPatches(null, null)
    current = null
    lastDoc = null
    lastMasks = null
    lastHeal = null
    lastOverlay = -1
    lastFlags = null
    return
  }
  if (current.dcp) {
    device.setProfile(null, null)
    if (scratchGl) scratchGl.setProfile(null, null)
  }
  if (current.dn) {
    current.dn.port?.close()
    current.dn.release?.()
    device.setDenoised(null)
  }
  if (current.atlas) {
    device.setPatches(null, null)
    if (scratchGl) scratchGl.setPatches(null, null)
  }
  device.destroyImage(current.img)
  current.aux?.destroy()
  current.scratchAux?.destroy()
  current.nr?.destroy()
  current.scratchNr?.destroy()
  current.brush?.tex.destroy()
  current.scratchBrush?.tex.destroy()
  if (current.scratchImg) scratchGl?.destroyImage(current.scratchImg)
  current.bitmap?.close()
  current = null
  lastDoc = null
  lastMasks = null
  lastHeal = null
  lastOverlay = -1
  lastFlags = null
}

const post = (msg, transfer) => self.postMessage(msg, transfer ?? [])

// ── Compose host ───────────────────────────────────────────────────────────
// Compose (src/compose) shares this worker's GPU device. Smart objects are
// photos developed by the code above, each on its own session (the same
// shape as `current`); Develop adjustment layers run the develop pass over
// the composite below them.
let compose = null
const sessions = new Map() // photoId → session
const sessionRevs = new Map()
const bumpSession = (id) => sessionRevs.set(id, (sessionRevs.get(id) ?? 0) + 1)

function sessionOf(photoId) {
  if (current?.photoId === photoId && (current.keep || !sessions.has(photoId))) return current
  return sessions.get(photoId) ?? null
}

// run fn with `current` swapped to session s; restores Develop's device state
function withSession(s, fn) {
  const prev = current
  const swap = s !== prev
  current = s
  try {
    if (swap && (s?.atlas || prev?.atlas)) device.setPatches(s?.atlas ?? null, null)
    return fn()
  } finally {
    current = prev
    if (swap) {
      if (s?.atlas || prev?.atlas) device.setPatches(prev?.atlas ?? null, null)
      if (prev && lastDoc) syncPatches(lastFlags?.before ? null : lastDoc, lastParams)
      if (s?.dcp && s.dcp !== prev?.dcp) device.setProfile(prev?.dcp?.t.hsv ?? null, prev?.dcp?.t.toneLut ?? null)
    }
  }
}

async function sessionFromSource(photoId, source) {
  const decoded = !(source instanceof ImageBitmap)
  const lensP = decoded ? lensProfileFor(appBase, source.exif).catch(() => null) : null
  const img = decoded ? device.uploadDecoded(source, 1) : device.uploadImage(source)
  if (decoded && !source.hl?.clipped) source.buffer = null
  return {
    photoId, img, fullW: source.width, fullH: source.height,
    bitmap: decoded ? null : source, payload: decoded ? source : null, recon: 1,
    lensProfile: await lensP, keep: true,
  }
}

const ADJUST_MODULES = ['wb', 'exposure', 'tone', 'curve', 'colormix', 'vibsat', 'bw', 'grading', 'localcontrast', 'vignette', 'grain', 'detail']
let adjTex = null

const composeHost = {
  post,
  get appBase() { return appBase },
  get gpu() { return device.gpu },
  hasSession: (photoId) => !!sessionOf(photoId),
  sessionRev: (photoId) => sessionRevs.get(photoId) ?? 0,
  adoptCurrent(photoId) {
    if (current?.photoId !== photoId) throw new Error('that photo is not open in Develop')
    current.keep = true
    sessions.set(photoId, current)
    bumpSession(photoId)
  },
  retainSession(photoId) {
    const s = sessionOf(photoId)
    if (s) { s.keep = true; sessions.set(photoId, s) }
  },
  async registerSource(photoId, source) {
    const old = sessions.get(photoId)
    if (old && old !== current) destroySession(old)
    sessions.set(photoId, await sessionFromSource(photoId, source))
    bumpSession(photoId)
  },
  releaseSessions() {
    for (const [id, s] of sessions) {
      if (s === current) { s.keep = false; continue }
      destroySession(s)
    }
    sessions.clear()
  },
  smartDims(photoId, editDoc) {
    const s = sessionOf(photoId)
    if (!s) return [1, 1]
    return withSession(s, () => outDimsOf(paramsFrom(editDoc, s.img)))
  },
  developSmart(photoId, editDoc, into) {
    const s = sessionOf(photoId)
    if (!s) return null
    const developing = current
    return withSession(s, () => {
      ensureRecon(editDoc)
      const p = paramsFrom(editDoc, s.img)
      syncPatches(editDoc, p)
      if (p[112] && s.dcp) device.setProfile(s.dcp.t.hsv ?? null, s.dcp.t.toneLut ?? null)
      if (s !== developing) p[111] = 0 // the denoised capture belongs to Develop's photo
      const lut = lutFrom(editDoc)
      const masks = masksFrom(editDoc)
      const heal = applyHeal(p, healFrom(editDoc))
      if (masks?.needsAux) p[56] = 1
      const d = detailFrom(editDoc, !!s.payload)
      const nrImg = nrFor(d)
      if (nrImg) p[11] = 1
      const [w, h] = outDimsOf(p)
      const fin = finFor(d, 1, 0, null, grainDesc(grainFrom(editDoc), p[51]), geomFor(p))
      return device.developTo(nrImg ?? s.img, p, w, h, lut, auxFor(p), fin, masks?.arr ?? null,
        brushFor(editDoc), heal?.arr ?? null, into)
    })
  },
  // Develop modules over a straight-colour view of the composite (Ut)
  developAdjust(Ut, modules, ctx) {
    const W = ctx.W
    const H = ctx.H
    const [sx, sy, ox, oy] = ctx.view
    const img = { texture: Ut, width: W, height: H, isLinear: ctx.linear ? 1 : 0 }
    const pick = {}
    for (const k of ADJUST_MODULES) if (modules[k]) pick[k] = modules[k]
    const editDoc = { modules: { ...pick, look: { profile: 'linear' } } }
    return withSession(null, () => {
      const p = paramsFrom(editDoc, img)
      p[92] = 0 // clamp display transform: the composite is already display-referred
      p[51] = sx
      p[14] = -ox / sx / ctx.dw
      p[15] = -oy / sy / ctx.dh
      p[75] = W / sx / ctx.dw
      p[95] = H / sy / ctx.dh
      p[96] = 0
      p[110] = 0
      const lut = lutFrom(editDoc)
      const d = detailFrom(editDoc, false)
      const nr = d.lumaNR || d.chromaNR ? device.computeNR(img, d.lumaNR, d.chromaNR) : null
      if (nr) p[11] = 1
      const aux = p[56] ? device.computeAux(img, sx) : null
      const geom = { geom: [0, p[14], p[15], p[75], p[95], 1], srcW: ctx.dw, srcH: ctx.dh, perspV: 0, perspH: 0, distortion: 0 }
      const fin = finFor(d, sx, 0, null, grainDesc(grainFrom(editDoc), 1), geom)
      if (adjTex?.width !== W || adjTex?.height !== H) {
        adjTex?.destroy()
        adjTex = device.gpu.device.createTexture({
          size: [W, H], format: 'rgba16float',
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
        })
      }
      device.developTo(nr?.img ?? img, p, W, H, lut, aux, fin, null, null, null, adjTex)
      aux?.destroy()
      nr?.destroy()
      return adjTex
    })
  },
}

function destroySession(s) {
  device.destroyImage(s.img)
  s.aux?.destroy()
  s.nr?.destroy()
  s.brush?.tex.destroy()
}

async function composeMessage(data) {
  if (!compose) {
    if (device?.backend !== 'webgpu') {
      post({ re: data.id, type: 'coError', message: 'Compose needs WebGPU' })
      return
    }
    compose = createComposeEngine(composeHost)
    installCompose(compose.E)
  }
  await compose.handle(data)
}

// Messages are handled strictly in order: async handlers don't queue by
// themselves, and an OPEN racing a slow INIT (GPU adapter request) must wait,
// not crash on a null device.
let chain = Promise.resolve()
self.onmessage = (e) => { chain = chain.then(() => handle(e.data)) }

async function handle(data) {
  try {
    if (data.type?.startsWith('co')) { await composeMessage(data); return }
    switch (data.type) {
      case MSG.INIT: {
        if (data.base) appBase = data.base
        device = await createGpuDevice(data.canvas, data.backendPref)
        post({ re: data.id, type: MSG.READY, backend: device.backend, limits: device.limits })
        break
      }

      case MSG.OPEN: {
        closeCurrent()
        const source = data.source
        // decoded RAW payload vs ImageBitmap; uploadDecoded runs the demosaic
        // pass once here, PARAMS then only re-runs the develop pass on the
        // cached linear texture. Source retained so the scratch GL context can
        // re-render the same image for scopes and (webgpu) export.
        const decoded = !(source instanceof ImageBitmap)
        // the lens lookup (lensfun JSON, cached after the first RAW) runs while
        // the GPU demosaics, and lands before the first frame: no late jump
        const lensP = decoded ? lensProfileFor(appBase, source.exif).catch(() => null) : null
        const recon = reconOf(data.editDoc)
        const img = decoded ? device.uploadDecoded(source, recon) : device.uploadImage(source)
        // the mosaic is kept only for what can re-read it: a scratch context,
        // or a highlight-reconstruction toggle on a photo that clips. Else a
        // 60 MP file would hold 120 MB here for nothing.
        if (decoded && selfReadback() && !source.hl?.clipped) source.buffer = null
        current = {
          photoId: data.photoId,
          img,
          fullW: source.width,
          fullH: source.height,
          bitmap: decoded ? null : source,
          payload: decoded ? source : null,
          recon,
          lensProfile: await lensP,
        }
        const lp = current.lensProfile
        post({ type: MSG.LENS, photoId: data.photoId,
          lens: lp && { name: lp.name, maker: lp.maker, distortion: lp.distortion } })
        lastParams = paramsFrom(data.editDoc, img)
        syncPatches(data.editDoc, lastParams)
        lastLut = lutFrom(data.editDoc)
        lastDetail = detailFrom(data.editDoc, decoded)
        lastGrain = grainFrom(data.editDoc)
        lastDoc = data.editDoc
        lastMasks = masksFrom(data.editDoc)
        lastHeal = applyHeal(lastParams, healFrom(data.editDoc))
        lastOverlay = -1
        lastFlags = null
        if (lastMasks?.needsAux) lastParams[56] = 1 // mask clarity needs the pyramid
        view = { ...view, zoom: 'fit' } // stale loupe never spans photos
        renderCurrent()
        if (data.sync) await device.sync?.()
        post({ re: data.id, type: MSG.FRAME, photoId: current.photoId })
        await computeScopes(false)
        break
      }

      case MSG.OPEN_SESSION: {
        // a smart object opened in Develop: the session Compose holds
        // becomes Develop's current photo, textures and caches included
        const s = sessions.get(data.photoId)
        if (!s) throw new Error('no such session')
        if (current !== s) closeCurrent()
        current = s
        if (current.atlas) device.setPatches(current.atlas, null)
        if (current.dcp) device.setProfile(current.dcp.t.hsv ?? null, current.dcp.t.toneLut ?? null)
        const lp = current.lensProfile
        post({ type: MSG.LENS, photoId: data.photoId, lens: lp && { name: lp.name, maker: lp.maker, distortion: lp.distortion } })
        lastParams = paramsFrom(data.editDoc, current.img)
        syncPatches(data.editDoc, lastParams)
        lastLut = lutFrom(data.editDoc)
        lastDetail = detailFrom(data.editDoc, !!current.payload)
        lastGrain = grainFrom(data.editDoc)
        lastDoc = data.editDoc
        lastMasks = masksFrom(data.editDoc)
        lastHeal = applyHeal(lastParams, healFrom(data.editDoc))
        lastOverlay = -1
        lastFlags = null
        if (lastMasks?.needsAux) lastParams[56] = 1
        view = { ...view, zoom: 'fit' }
        renderCurrent()
        post({ re: data.id, type: MSG.FRAME, photoId: current.photoId, width: current.fullW, height: current.fullH })
        await computeScopes(false)
        break
      }

      case MSG.PARAMS: {
        if (!current || current.photoId !== data.photoId) break
        ensureRecon(data.editDoc) // recon toggle rebuilds the RAW intermediate
        lastParams = paramsFrom(data.editDoc, current.img, data.flags)
        syncPatches(data.flags?.before ? null : data.editDoc, lastParams)
        lastLut = lutFrom(data.editDoc, data.flags)
        lastDetail = detailFrom(data.editDoc, !!current.payload, data.flags)
        lastGrain = grainFrom(data.editDoc, data.flags)
        lastDoc = data.editDoc
        lastMasks = masksFrom(data.editDoc, data.flags)
        lastHeal = applyHeal(lastParams, healFrom(data.editDoc, data.flags))
        lastOverlay = data.flags?.before ? -1 : data.flags?.maskOverlay ?? -1
        lastFlags = data.flags ?? null
        if (lastMasks?.needsAux) lastParams[56] = 1 // mask clarity needs the pyramid
        // t0 spans a possible first blur-pyramid/NR build; gestures hit the caches
        const t0 = performance.now()
        renderCurrent(!!data.flags?.offscreen)
        const cpuMs = performance.now() - t0
        if (data.flags?.sync) await device.sync?.()
        post({ type: MSG.FRAME, photoId: current.photoId, ms: performance.now() - t0, cpuMs })
        await computeScopes(data.gesture)
        break
      }

      case MSG.VIEW: {
        if (!device) break
        view = {
          w: data.w, h: data.h,
          zoom: data.zoom ?? 'fit',
          panX: data.panX ?? 0.5, panY: data.panY ?? 0.5,
        }
        device.resize(data.w, data.h)
        // same image, same params: the histogram cannot have changed
        if (current) renderCurrent()
        break
      }

      case MSG.EXPORT: {
        if (!current || current.photoId !== data.photoId) break
        const encodeOpts = {
          type: data.opts?.type ?? 'image/jpeg',
          quality: data.opts?.quality ?? 0.92,
        }
        ensureRecon(data.editDoc)
        if (data.editDoc?.modules?.detail?.aiDenoise && current.dn && !current.dn.ready) {
          await current.dn.finished
        }
        const exportParams = paramsFrom(data.editDoc, current.img)
        syncPatches(data.editDoc, exportParams)
        const exportLut = lutFrom(data.editDoc)
        const exportMasks = masksFrom(data.editDoc)
        const exportHeal = applyHeal(exportParams, healFrom(data.editDoc))
        if (exportMasks?.needsAux) exportParams[56] = 1
        // geometry decides output dims: crop aspect, shrunk by the inscribed
        // auto-zoom so rotated content is real resolution. opts.longEdge
        // (optional) renders directly at the reduced size with resScale set —
        // grain keeps its output-px feature size, sharpen σ display-scales;
        // the main thread's blob resize then no-ops (never upscales).
        const [ow, oh] = outDimsOf(exportParams)
        const le = data.opts?.longEdge
        const es = le && le < Math.max(ow, oh) ? le / Math.max(ow, oh) : 1
        if (es < 1) exportParams[51] = es
        const w = Math.max(1, Math.round(ow * es))
        const h = Math.max(1, Math.round(oh * es))
        // detail at export: σ scale follows the render scale, no overlays
        const ed = detailFrom(data.editDoc, !!current.payload)
        const efin = finFor(ed, es, 0, null,
          grainDesc(grainFrom(data.editDoc), exportParams[51]), geomFor(exportParams))
        // a software WebGPU adapter never reads back: export re-renders on
        // the persistent scratch GL context from the retained source
        let blob
        if (encodeOpts.type === 'image/tiff') {
          // 16 bits per channel, Deflate, sRGB profile embedded
          const dev = readbackDevice()
          const src = selfReadback() ? current.img : readbackImage()
          const nrImg = selfReadback() ? nrFor(ed) : scratchNrFor(ed, src)
          if (nrImg) exportParams[11] = 1
          const aux = selfReadback() ? auxFor(exportParams) : scratchAuxFor(exportParams, current.scratchImg)
          const brush = selfReadback() ? brushFor(data.editDoc) : scratchBrushFor(data.editDoc)
          const rgb = await dev.renderToPixels16(nrImg ?? src, exportParams, w, h, exportLut, aux, efin,
            exportMasks?.arr ?? null, brush, exportHeal?.arr ?? null)
          const bytes = await encodeTiff16Deflate({ width: w, height: h, data: rgb, channels: 3, exif: current.payload?.exif })
          blob = new Blob([bytes], { type: 'image/tiff' })
        } else if (selfReadback()) {
          const nrImg = nrFor(ed)
          if (nrImg) exportParams[11] = 1
          blob = await device.renderToBlob(nrImg ?? current.img, exportParams, w, h, encodeOpts,
            exportLut, auxFor(exportParams), efin, exportMasks?.arr ?? null,
            brushFor(data.editDoc), exportHeal?.arr ?? null)
        } else {
          const src = readbackImage()
          const nrImg = scratchNrFor(ed, src)
          if (nrImg) exportParams[11] = 1
          blob = await scratch().renderToBlob(nrImg ?? src, exportParams, w, h, encodeOpts,
            exportLut, scratchAuxFor(exportParams, current.scratchImg), efin,
            exportMasks?.arr ?? null, scratchBrushFor(data.editDoc), exportHeal?.arr ?? null)
        }
        syncPatches(lastFlags?.before ? null : lastDoc, lastParams) // back to the display doc
        post({ re: data.id, type: MSG.EXPORTED, photoId: current.photoId, blob })
        break
      }

      case MSG.BRUSH: {
        // live stroke increment: stamp into the render device's brushTex and
        // redraw. The doc sig is untouched, so the commit's PARAMS replays
        // everything (idempotent); the scratch copy just goes stale.
        if (!current || current.photoId !== data.photoId) break
        const tex = brushFor(lastDoc)
        if (!tex) break // no brush mask in the doc yet — UI commits one first
        device.stampBrush(tex, data.channel, data.pts, data.size, data.flow, data.erase,
          current.fullW, current.fullH)
        if (current.scratchBrush) current.scratchBrush.sig = null
        renderCurrent()
        post({ type: MSG.FRAME, photoId: current.photoId })
        break
      }

      case MSG.MASKTEX: {
        // full-channel AI-mask weights: retained CPU-side (quarter res) and
        // merged into brushTex by replayBrush — sig bump forces the replay
        if (!current || current.photoId !== data.photoId) break
        current.ai ??= new Map()
        current.ai.set(data.maskId, {
          data: data.data, width: data.width, height: data.height, rev: ++aiRev,
        })
        if (current.brush) current.brush.sig = null
        if (current.scratchBrush) current.scratchBrush.sig = null
        lastMasks = masksFrom(lastDoc)
        if (lastMasks?.needsAux) lastParams[56] = 1
        renderCurrent()
        post({ type: MSG.FRAME, photoId: current.photoId })
        await computeScopes(false)
        break
      }

      case MSG.DN_PORT: {
        // AI denoise tiles for the open photo arrive on this port, in order.
        // Tiles are placed at once, outside the message queue (synchronous GPU
        // writes): an export waiting in the queue for the denoise to finish
        // must not block the tiles it waits for. Only the redraw is queued.
        if (!current || current.photoId !== data.photoId || !current.payload) break
        if (current.dn) { current.dn.port?.close(); device.setDenoised(null) }
        let release
        const finished = new Promise((r) => { release = r })
        current.dn = { ready: false, port: data.port, finished, release }
        device.setDenoised(current.img)
        const id = data.photoId
        data.port.onmessage = ({ data: m }) => dnMessage(id, m)
        break
      }

      case MSG.PROFILE: {
        // an imported DCP's bytes; a doc naming it renders through it
        if (!dcpProfiles.has(data.profileId)) dcpProfiles.set(data.profileId, parseDcp(data.bytes))
        if (current && lastDoc?.modules?.look?.profile === `dcp:${data.profileId}`) {
          current.dcp = null
          lastParams = paramsFrom(lastDoc, current.img, lastFlags)
          syncPatches(lastFlags?.before ? null : lastDoc, lastParams)
          renderCurrent()
          post({ type: MSG.FRAME, photoId: current.photoId })
          await computeScopes(false)
        }
        break
      }

      case MSG.PATCH: {
        // a removal patch's pixels: repack the atlas, redraw with the doc's set
        if (!current || current.photoId !== data.photoId) break
        current.patchImgs ??= new Map()
        current.patchImgs.set(data.patchId, { width: data.width, height: data.height, data: data.data })
        current.atlas = packAtlas(current.patchImgs)
        device.setPatches(current.atlas ?? null, null)
        if (scratchGl && !selfReadback()) scratchGl.setPatches(current.atlas ?? null, null)
        syncPatches(lastFlags?.before ? null : lastDoc, lastParams)
        renderCurrent()
        post({ type: MSG.FRAME, photoId: current.photoId })
        await computeScopes(false)
        break
      }

      case MSG.REGION: {
        // the capture inside rect (final source space), as removal input:
        // no edits, no lens profile, no patches, 1 stop down for headroom;
        // pixels are sRGB of (linear ÷ scale)
        if (!current || current.photoId !== data.photoId) break
        const p = paramsFrom({ modules: { look: { profile: 'linear' } } }, current.img)
        const [rx, ry, rw, rh] = data.rect
        p[0] = -1
        p[57] = 0; p[58] = rx; p[59] = ry; p[60] = rw; p[61] = rh; p[62] = 1; p[63] = 0
        p[84] = p[85] = p[86] = p[87] = p[88] = 0
        p[89] = p[90] = p[91] = 0
        p[96] = 0
        p[110] = 0
        const rects = new Float32Array(192)
        device.setPatches(undefined, rects)
        const px = await readbackDevice().renderToPixels(readbackImage(), p, data.width, data.height,
          IDENTITY_LUT, null, null, null, null, null)
        syncPatches(lastFlags?.before ? null : lastDoc, lastParams)
        post({ re: data.id, type: MSG.REGIONED, data: px, width: data.width, height: data.height, scale: 2 },
          [px.buffer])
        break
      }

      case MSG.AUTO: {
        // measure with the family being computed STRIPPED: the reply is a
        // replacement, so a second AUTO reproduces the same answer
        if (!current || current.photoId !== data.photoId) break
        const base = lastDoc ?? { modules: {} }
        const mods = { ...base.modules }
        if (data.kind === 'wb') delete mods.wb
        else { delete mods.exposure; delete mods.tone }
        const { px } = await renderSmallFor({ ...base, modules: mods })
        post({
          re: data.id,
          type: MSG.AUTOED,
          modules: data.kind === 'wb' ? autoWbFrom(px) : autoToneFrom(px),
        })
        break
      }

      case MSG.SAMPLE: {
        if (!current || current.photoId !== data.photoId) break
        // map the clicked display uv through the DRAWN window params (loupe
        // sub-crop included) — CPU twin of the shader's inverse geometry map
        const q = viewParams()
        const W = current.fullW
        const H = current.fullH
        const cx = q[58] + q[60] / 2
        const cy = q[59] + q[61] / 2
        const dx = (q[58] + data.x * q[60] - cx) * W
        const dy = (q[59] + data.y * q[61] - cy) * H
        const c = Math.cos(q[57])
        const sn = Math.sin(q[57])
        let mx = cx + (c * dx - sn * dy) / (q[62] * W)
        let my = cy + (sn * dx + c * dy) / (q[62] * H)
        // keystone + distortion CPU twins (same constants as the shaders)
        if (q[91]) {
          const nx = mx - 0.5
          const ny = my - 0.5
          const pw = Math.max(1 + 2 * ((q[90] / 100) * 0.3 * nx + (q[89] / 100) * 0.3 * ny), 0.2)
          mx = 0.5 + nx / pw
          my = 0.5 + ny / pw
        }
        if (q[84]) {
          const ddx = (mx - 0.5) * W
          const ddy = (my - 0.5) * H
          const r2d = (ddx * ddx + ddy * ddy) / (0.25 * (W * W + H * H))
          const sc = 1 + (q[84] / 100) * r2d * 0.15
          mx = 0.5 + (mx - 0.5) * sc
          my = 0.5 + (my - 0.5) * sc
        }
        const cl01 = (v) => Math.min(1, Math.max(0, v))
        // linear: direct 5×5 readback of the pre-develop source texture
        // (RAW demosaic intermediate or sRGB-decoded bitmap; NR ignored —
        // it barely moves a 5×5 mean). Chosen over a neutral-doc render:
        // no display clamp, no 8-bit re-quantization of RAW data.
        const img = readbackImage()
        const linear = readbackDevice().readSource(img, cl01(q[63] ? 1 - mx : mx), cl01(my), 5)
        // display: re-render the drawn window small with curve, overlays and
        // finish stripped (TAT curve wants the PRE-curve display value)
        const p = q.slice()
        p[10] = 0
        p[12] = 0
        const [vw, vh] = outDimsOf(p)
        const s = Math.min(1, 256 / vw, 256 / vh)
        const w = Math.max(1, Math.round(vw * s))
        const h = Math.max(1, Math.round(vh * s))
        const aux = selfReadback() ? auxFor(p) : scratchAuxFor(p, img)
        const d2 = { ...lastDetail, maskPreview: 0 }
        const nrImg = selfReadback() ? nrFor(d2) : scratchNrFor(d2, img)
        if (nrImg) p[11] = 1
        const brush = selfReadback() ? brushFor(lastDoc) : scratchBrushFor(lastDoc)
        const px = await readbackDevice().renderToPixels(nrImg ?? img, p, w, h, lastLut,
          aux, null, lastMasks?.arr ?? null, brush, lastHeal?.arr ?? null)
        const px0 = Math.min(w - 1, Math.max(0, Math.round(data.x * w)))
        const py0 = Math.min(h - 1, Math.max(0, Math.round(data.y * h)))
        const disp = [0, 0, 0]
        let m = 0
        for (let yy = Math.max(0, py0 - 2); yy <= Math.min(h - 1, py0 + 2); yy++) {
          for (let xx = Math.max(0, px0 - 2); xx <= Math.min(w - 1, px0 + 2); xx++) {
            const i = (yy * w + xx) * 4
            disp[0] += px[i]; disp[1] += px[i + 1]; disp[2] += px[i + 2]; m++
          }
        }
        post({ re: data.id, type: MSG.SAMPLED, linear, display: disp.map((v) => v / (255 * m)) })
        break
      }

      case MSG.CLOSE: {
        closeCurrent()
        break
      }
    }
  } catch (err) {
    post({ re: data.id, type: MSG.ERROR, message: String(err?.message ?? err) })
  }
}
