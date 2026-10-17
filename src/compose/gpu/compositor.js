import layerWgsl from './layer.wgsl?raw'
import blendWgsl from './blend.wgsl?raw'
import adjustWgsl from './adjust.wgsl?raw'
import utilWgsl from './util.wgsl?raw'
import { BLEND_INDEX, ADJUST_INDEX } from '../model.js'
import { meshFor } from '../mesh.js'

// Compose's GPU compositor. Draws a document's node tree into a view-aligned
// target: the screen (at view resolution, so cost follows the screen, not the
// document) or a full-resolution export. Layer textures are premultiplied
// and mipmapped; the accumulator is premultiplied.
//
// Normal layers draw straight onto the accumulator with fixed-function
// "over" blending. Everything else (other modes, Blend If, clipping groups,
// isolated groups, layer styles) draws into a scratch texture first, copies
// the destination's region, and blends in the shader. Adjustment layers run
// over a straight-colour copy of the accumulator.

const U_SLOT = 256 // uniform arena slot (WebGPU's offset alignment)
const ARENA = 8192 // slots per frame

export const storageFormat = (depth) => depth === 32 ? 'rgba32float' : depth === 8 ? 'rgba8unorm' : 'rgba16float'
export const maskFormat = (depth) => depth === 8 ? 'r8unorm' : 'r16float'
const BPP = { rgba8unorm: 4, rgba16float: 8, rgba32float: 16, r8unorm: 1, r16float: 2, r32float: 4, rg16float: 4, rg32float: 8 }
export const texBytes = (t) => {
  if (!t) return 0
  let n = 0
  for (let i = 0; i < t.mipLevelCount; i++) n += Math.max(1, t.width >> i) * Math.max(1, t.height >> i)
  return n * (BPP[t.format] ?? 8)
}
export const mipCount = (w, h) => Math.floor(Math.log2(Math.max(w, h))) + 1

export function createCompositor(gpu) {
  const { device } = gpu
  const canBlend32 = device.features.has('float32-blendable')
  const canFilter32 = device.features.has('float32-filterable')

  const sampler = device.createSampler({
    magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
    addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge',
  })
  const nearest = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' })

  const modules = {
    layer: device.createShaderModule({ code: layerWgsl }),
    blend: device.createShaderModule({ code: blendWgsl }),
    adjust: device.createShaderModule({ code: adjustWgsl }),
    util: device.createShaderModule({ code: utilWgsl }),
  }

  // ── pipelines, cached by (module, entry, format, blend) ──────────────────
  const pipes = new Map()
  const OVER = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } }
  const MESH_LAYOUT = [{
    arrayStride: 16,
    attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x2' },
      { shaderLocation: 1, offset: 8, format: 'float32x2' },
    ],
  }]
  function pipe(mod, entry, format, { blend = null, mesh = false } = {}) {
    const key = `${mod}/${entry}/${format}/${blend ? 'over' : ''}`
    let p = pipes.get(key)
    if (p) return p
    const m = modules[mod]
    p = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: m, entryPoint: 'vs', buffers: mesh ? MESH_LAYOUT : [] },
      fragment: { module: m, entryPoint: entry, targets: [{ format, ...(blend ? { blend } : {}) }] },
      primitive: { topology: 'triangle-list' },
    })
    pipes.set(key, p)
    return p
  }

  // ── per-frame uniform arena ──────────────────────────────────────────────
  const arena = device.createBuffer({ size: U_SLOT * ARENA, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  let slot = 0
  const uniform = (f32) => {
    if (slot >= ARENA) slot = 0 // wraps only on absurd frames; queue order keeps it correct across submits
    const offset = slot++ * U_SLOT
    device.queue.writeBuffer(arena, offset, f32)
    return { buffer: arena, offset, size: Math.max(16, f32.byteLength) }
  }

  // ── textures ─────────────────────────────────────────────────────────────
  const USAGE = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT |
    GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST
  const createTex = (w, h, format, mips = true) => device.createTexture({
    size: [Math.max(1, w), Math.max(1, h)], format, usage: USAGE,
    mipLevelCount: mips ? mipCount(w, h) : 1,
  })
  const level0 = (t) => t.createView({ baseMipLevel: 0, mipLevelCount: 1 })
  const dummy = {
    rgba: createTex(1, 1, 'rgba16float', false),
    r: createTex(1, 1, 'r16float', false),
  }
  device.queue.writeTexture({ texture: dummy.r }, new Uint16Array([0x3c00]), { bytesPerRow: 2 }, [1, 1])

  // scratch textures of the current target size, pooled by format
  const pool = new Map() // key → [GPUTexture]
  const poolKey = (w, h, f) => `${w}x${h}/${f}`
  const borrow = (w, h, format) => {
    const list = pool.get(poolKey(w, h, format))
    return list?.pop() ?? createTex(w, h, format, false)
  }
  const giveBack = (t) => {
    const k = poolKey(t.width, t.height, t.format)
    if (!pool.has(k)) pool.set(k, [])
    pool.get(k).push(t)
  }
  const trimPool = (w, h) => { // drop scratch of other sizes (view resized)
    for (const [k, list] of pool) {
      if (!k.startsWith(`${w}x${h}/`)) { list.forEach((t) => t.destroy()); pool.delete(k) }
    }
  }

  const clearPass = (enc, view, rect) => {
    const p = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] })
    if (rect) p.setScissorRect(...rect)
    p.end()
  }

  function genMips(tex, rect = null) {
    if (tex.mipLevelCount < 2) return
    const p = pipe('util', 'fs_down', tex.format)
    const enc = device.createCommandEncoder()
    for (let i = 1; i < tex.mipLevelCount; i++) {
      const pass = enc.beginRenderPass({
        colorAttachments: [{ view: tex.createView({ baseMipLevel: i, mipLevelCount: 1 }), loadOp: 'load', storeOp: 'store' }],
      })
      const lw = Math.max(1, tex.width >> i)
      const lh = Math.max(1, tex.height >> i)
      if (rect) {
        const x0 = Math.max(0, Math.floor(rect[0] / 2 ** i) - 1)
        const y0 = Math.max(0, Math.floor(rect[1] / 2 ** i) - 1)
        const x1 = Math.min(lw, Math.ceil((rect[0] + rect[2]) / 2 ** i) + 1)
        const y1 = Math.min(lh, Math.ceil((rect[1] + rect[3]) / 2 ** i) + 1)
        if (x1 <= x0 || y1 <= y0) { pass.end(); continue }
        pass.setScissorRect(x0, y0, x1 - x0, y1 - y0)
      }
      pass.setPipeline(p)
      pass.setBindGroup(0, device.createBindGroup({
        layout: p.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: sampler },
          { binding: 1, resource: tex.createView({ baseMipLevel: i - 1, mipLevelCount: 1 }) },
        ],
      }))
      pass.draw(3)
      pass.end()
    }
    device.queue.submit([enc.finish()])
  }

  // ── mesh buffers ─────────────────────────────────────────────────────────
  // one vertex buffer per (node, geometry) — rebuilt when the geometry changes
  const meshCache = new WeakMap() // res → { key, buf, count }
  function meshBuf(res, node, w, h) {
    const key = JSON.stringify([node.xf ?? null, node.bounds ?? null, w, h])
    let m = meshCache.get(res)
    if (m?.key === key) return m
    m?.buf.destroy()
    const verts = meshFor(node, w, h)
    const buf = device.createBuffer({ size: verts.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    device.queue.writeBuffer(buf, 0, verts)
    m = { key, buf, count: verts.length / 4 }
    meshCache.set(res, m)
    return m
  }
  // full-document quad for fill layers
  const docQuadCache = new Map()
  function docQuad(dw, dh) {
    const key = `${dw}x${dh}`
    if (docQuadCache.has(key)) return docQuadCache.get(key)
    const v = new Float32Array([0, 0, 0, 0, dw, 0, 1, 0, 0, dh, 0, 1, dw, 0, 1, 0, dw, dh, 1, 1, 0, dh, 0, 1])
    const buf = device.createBuffer({ size: v.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    device.queue.writeBuffer(buf, 0, v)
    const m = { buf, count: 6 }
    docQuadCache.set(key, m)
    return m
  }

  // gradient ramps for fill layers / gradient maps / curves: 256×1 rgba16f
  const rampCache = new Map() // key → texture
  function rampTex(key, data /* Float32Array(1024) */) {
    let t = rampCache.get(key)
    if (t) return t
    if (rampCache.size > 64) { for (const v of rampCache.values()) v.destroy(); rampCache.clear() }
    t = device.createTexture({ size: [256, 1], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
    device.queue.writeTexture({ texture: t }, new Float16Array(data), { bytesPerRow: 256 * 8 }, [256, 1])
    rampCache.set(key, t)
    return t
  }

  // ── frame context ────────────────────────────────────────────────────────
  // ctx: { enc, W, H, view: [sx, sy, ox, oy], dw, dh, fmt, res, host, doc, linear }
  const flush = (ctx) => {
    device.queue.submit([ctx.enc.finish()])
    ctx.enc = device.createCommandEncoder()
  }

  // node's bounding box in target px (for scissor + copies), clipped to target
  function screenRect(ctx, node, res) {
    if (node.kind === 'fill' || node.kind === 'adjust' || node.kind === 'group' || node.styles) return [0, 0, ctx.W, ctx.H]
    const pts = res?.corners ?? null
    if (!pts) return [0, 0, ctx.W, ctx.H]
    const [sx, sy, ox, oy] = ctx.view
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const [x, y] of pts) {
      x0 = Math.min(x0, x * sx + ox); y0 = Math.min(y0, y * sy + oy)
      x1 = Math.max(x1, x * sx + ox); y1 = Math.max(y1, y * sy + oy)
    }
    const pad = node.liquify ? 1e9 : 2
    x0 = Math.max(0, Math.floor(x0) - pad); y0 = Math.max(0, Math.floor(y0) - pad)
    x1 = Math.min(ctx.W, Math.ceil(x1) + pad); y1 = Math.min(ctx.H, Math.ceil(y1) + pad)
    if (x1 <= x0 || y1 <= y0) return null
    return [x0, y0, x1 - x0, y1 - y0]
  }

  const maskOf = (ctx, node) => {
    const m = node.mask
    if (!m || m.enabled === false) return null
    return ctx.res.get(node.id)?.mask ?? null
  }

  // draw a drawable node (pixel, smart, text, shape, fill) into `view` (a
  // render target): with `over` it blends onto the target, else it replaces
  // the (cleared) target. opacity overrides node opacity×fill.
  function drawNode(ctx, node, view, over, opacity, rect) {
    const res = ctx.res.get(node.id)
    const fill = node.kind === 'fill'
    const tex = fill ? null : res?.tex
    if (!fill && !tex) return
    const fmt = ctx.fmt
    const p = pipe('layer', fill ? 'fs_fill' : 'fs', fmt, { blend: over ? OVER : null, mesh: true })
    const mask = maskOf(ctx, node)
    const [sx, sy, ox, oy] = ctx.view
    const u = new Float32Array(28)
    u.set([sx, sy, ox, oy, ctx.W, ctx.H, ctx.dw, ctx.dh])
    // 32-bit documents are linear: derived layers (smart objects, type,
    // shapes, fills) arrive display-encoded and decode here
    u[24] = ctx.linear && node.kind !== 'pixel' ? 1 : 0
    u.set([opacity, mask ? 1 : 0, node.mask?.density ?? 1, res?.disp ? 1 : 0], 8)
    let rampT = null
    if (fill) {
      const f = node.fill
      const kind = f.type === 'linear' ? 2 : f.type === 'radial' ? 3 : 1
      u.set([kind, node.mask?.invert ? 1 : 0, node.mask?.ox ?? 0, node.mask?.oy ?? 0], 12)
      u.set(f.color ?? [1, 1, 1, 1], 16)
      if (kind > 1) {
        u.set(f.line ?? [0, 0, ctx.dw, 0], 20)
        rampT = rampTex(`g:${JSON.stringify(f.stops)}`, gradientRamp(f.stops))
      }
    } else {
      u.set([0, node.mask?.invert ? 1 : 0, node.mask?.ox ?? 0, node.mask?.oy ?? 0], 12)
    }
    const pass = ctx.enc.beginRenderPass({ colorAttachments: [{ view, loadOp: 'load', storeOp: 'store' }] })
    if (rect) pass.setScissorRect(...rect)
    pass.setPipeline(p)
    pass.setBindGroup(0, device.createBindGroup({
      layout: p.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: sampler },
        { binding: 1, resource: (fill ? (rampT ?? dummy.rgba) : tex).createView() },
        { binding: 2, resource: (mask ?? dummy.r).createView() },
        { binding: 3, resource: (res?.disp ?? dummy.rgba).createView() },
        { binding: 4, resource: uniform(u) },
      ],
    }))
    const m = fill ? docQuad(ctx.dw, ctx.dh) : meshBuf(res, node, tex.width, tex.height)
    pass.setVertexBuffer(0, m.buf)
    pass.draw(m.count)
    pass.end()
  }

  // composite premultiplied `src` (target-sized) onto `dstTex` within rect
  function blendOnto(ctx, dstTex, src, mode, opacity, atop, node, rect, maskNode = null) {
    const S = borrow(ctx.W, ctx.H, ctx.fmt)
    const [x, y, w, h] = rect
    ctx.enc.copyTextureToTexture({ texture: dstTex, origin: [x, y] }, { texture: S, origin: [x, y] }, [w, h])
    const p = pipe('blend', 'fs', ctx.fmt)
    const mask = maskNode ? maskOf(ctx, maskNode) : null
    const bi = node?.blendIf
    const u = new Float32Array(28)
    u.set([BLEND_INDEX[mode] ?? 0, opacity, atop ? 1 : 0, mask ? 1 : 0])
    u.set(ctx.view, 4)
    u.set([ctx.W, ctx.H, ctx.dw, ctx.dh], 8)
    if (bi) {
      u.set(bi.this ?? [0, 0, 1, 1], 12)
      u.set(bi.under ?? [0, 0, 1, 1], 16)
    }
    u.set([bi ? 1 : 0, bi?.channel ?? 0, maskNode?.mask?.density ?? 1, maskNode?.mask?.invert ? 1 : 0], 20)
    u.set([ctx.seed ?? 0, maskNode?.mask?.ox ?? 0, maskNode?.mask?.oy ?? 0], 24)
    const pass = ctx.enc.beginRenderPass({ colorAttachments: [{ view: level0(dstTex), loadOp: 'load', storeOp: 'store' }] })
    pass.setScissorRect(x, y, w, h)
    pass.setPipeline(p)
    pass.setBindGroup(0, device.createBindGroup({
      layout: p.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: sampler },
        { binding: 1, resource: S.createView() },
        { binding: 2, resource: src.createView() },
        { binding: 3, resource: (mask ?? dummy.r).createView() },
        { binding: 4, resource: uniform(u) },
      ],
    }))
    pass.draw(3)
    pass.end()
    ctx.release.push(S)
  }

  // fade a pass-through group's result back towards the backdrop copy
  function fadeOnto(ctx, dstTex, backdrop, opacity, node) {
    const after = borrow(ctx.W, ctx.H, ctx.fmt)
    ctx.enc.copyTextureToTexture({ texture: dstTex }, { texture: after }, [ctx.W, ctx.H])
    const p = pipe('blend', 'fs_fade', ctx.fmt)
    const mask = maskOf(ctx, node)
    const u = new Float32Array(28)
    u.set([0, opacity, 0, mask ? 1 : 0])
    u.set(ctx.view, 4)
    u.set([ctx.W, ctx.H, ctx.dw, ctx.dh], 8)
    u.set([0, 0, node.mask?.density ?? 1, node.mask?.invert ? 1 : 0], 20)
    u.set([0, node.mask?.ox ?? 0, node.mask?.oy ?? 0], 24)
    const pass = ctx.enc.beginRenderPass({ colorAttachments: [{ view: level0(dstTex), loadOp: 'load', storeOp: 'store' }] })
    pass.setPipeline(p)
    pass.setBindGroup(0, device.createBindGroup({
      layout: p.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: sampler },
        { binding: 1, resource: backdrop.createView() },
        { binding: 2, resource: after.createView() },
        { binding: 3, resource: (mask ?? dummy.r).createView() },
        { binding: 4, resource: uniform(u) },
      ],
    }))
    pass.draw(3)
    pass.end()
    ctx.release.push(after)
  }

  // ── adjustment layers ────────────────────────────────────────────────────
  function fullPass(ctx, mod, entry, format, targetView, entries, u) {
    const p = pipe(mod, entry, format)
    const pass = ctx.enc.beginRenderPass({ colorAttachments: [{ view: targetView, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] })
    pass.setPipeline(p)
    const list = entries.map((r, i) => ({ binding: i, resource: r === 'U' ? uniform(u) : r }))
    pass.setBindGroup(0, device.createBindGroup({ layout: p.getBindGroupLayout(0), entries: list.filter((e) => e.resource) }))
    pass.draw(3)
    pass.end()
  }

  function applyAdjust(ctx, node, dstTex) {
    const a = node.adjust
    const Ut = borrow(ctx.W, ctx.H, ctx.fmt)
    // straight colour copy of what's below
    fullPass(ctx, 'adjust', 'fs_unpremul', ctx.fmt, Ut.createView(), [null, level0(dstTex)])
    let V
    if (a.type === 'develop') {
      flush(ctx) // the Develop backend submits its own work: ours goes first
      V = ctx.host.developAdjust(Ut, a.modules ?? {}, ctx)
      if (!V) { giveBack(Ut); return }
      if (ctx.linear) {
        const V2 = borrow(ctx.W, ctx.H, ctx.fmt)
        fullPass(ctx, 'adjust', 'fs_tolinear', ctx.fmt, V2.createView(), [null, level0(V)])
        ctx.release.push(V2)
        V = V2
      }
    } else {
      V = borrow(ctx.W, ctx.H, ctx.fmt)
      const u = adjustUniforms(a, ctx.linear)
      let lutT = dummy.rgba
      if (a.type === 'curves') lutT = rampTex(`c:${JSON.stringify(a.curves)}`, curvesRamp(a.curves))
      else if (a.type === 'gradmap') lutT = rampTex(`g:${JSON.stringify(a.stops)}`, gradientRamp(a.stops))
      fullPass(ctx, 'adjust', 'fs_adjust', ctx.fmt, V.createView(),
        [sampler, Ut.createView(), lutT.createView(), 'U'], u)
    }
    // mix back through mode, opacity, mask, Blend If
    const p = pipe('blend', 'fs_mix', ctx.fmt)
    const mask = maskOf(ctx, node)
    const bi = node.blendIf
    const u = new Float32Array(28)
    u.set([BLEND_INDEX[node.blend] ?? 0, node.opacity * (node.fillOpacity ?? 1), 0, mask ? 1 : 0])
    u.set(ctx.view, 4)
    u.set([ctx.W, ctx.H, ctx.dw, ctx.dh], 8)
    if (bi) { u.set(bi.this ?? [0, 0, 1, 1], 12); u.set(bi.under ?? [0, 0, 1, 1], 16) }
    u.set([bi ? 1 : 0, bi?.channel ?? 0, node.mask?.density ?? 1, node.mask?.invert ? 1 : 0], 20)
    u.set([0, node.mask?.ox ?? 0, node.mask?.oy ?? 0], 24)
    const pass = ctx.enc.beginRenderPass({ colorAttachments: [{ view: level0(dstTex), loadOp: 'load', storeOp: 'store' }] })
    pass.setPipeline(p)
    pass.setBindGroup(0, device.createBindGroup({
      layout: p.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: sampler },
        { binding: 1, resource: Ut.createView() },
        { binding: 2, resource: (V.texture ?? V).createView({ baseMipLevel: 0, mipLevelCount: 1 }) },
        { binding: 3, resource: (mask ?? dummy.r).createView() },
        { binding: 4, resource: uniform(u) },
      ],
    }))
    pass.draw(3)
    pass.end()
    ctx.release.push(Ut)
    if (a.type !== 'develop' && !ctx.release.includes(V)) ctx.release.push(V)
  }

  // ── tree walk ────────────────────────────────────────────────────────────
  const isVisible = (n) => n.visible !== false
  const needsScratch = (ctx, n) => (n.blend && n.blend !== 'normal') || n.blendIf || n.styles?.length ||
    (ctx.fmt === 'rgba32float' && !canBlend32)

  function drawLeaf(ctx, node, dstTex) {
    if (node.kind === 'adjust') return applyAdjust(ctx, node, dstTex)
    if (node.kind === 'group') return drawGroup(ctx, node, dstTex)
    const res = ctx.res.get(node.id)
    const rect = screenRect(ctx, node, res)
    if (!rect) return
    const op = node.opacity * (node.fillOpacity ?? 1)
    if (!needsScratch(ctx, node)) {
      drawNode(ctx, node, level0(dstTex), true, op, rect)
      return
    }
    const L = borrow(ctx.W, ctx.H, ctx.fmt)
    clearPass(ctx.enc, L.createView(), rect)
    drawNode(ctx, node, L.createView(), false, node.fillOpacity ?? 1, rect)
    if (node.styles?.length) ctx.host.styles?.(ctx, node, L, rect)
    blendOnto(ctx, dstTex, L, node.blend ?? 'normal', node.opacity, false, node, node.styles?.length ? [0, 0, ctx.W, ctx.H] : rect)
    ctx.release.push(L)
  }

  function drawGroup(ctx, g, dstTex) {
    const kids = g.children ?? []
    if (g.blend === 'pass' || g.blend == null) {
      const fade = g.opacity < 1 || maskOf(ctx, g)
      let backdrop = null
      if (fade) {
        backdrop = borrow(ctx.W, ctx.H, ctx.fmt)
        ctx.enc.copyTextureToTexture({ texture: dstTex }, { texture: backdrop }, [ctx.W, ctx.H])
      }
      drawList(ctx, kids, dstTex)
      if (fade) { fadeOnto(ctx, dstTex, backdrop, g.opacity, g); ctx.release.push(backdrop) }
      return
    }
    const T = borrow(ctx.W, ctx.H, ctx.fmt)
    clearPass(ctx.enc, T.createView())
    drawList(ctx, kids, T)
    blendOnto(ctx, dstTex, T, g.blend, g.opacity, false, g, [0, 0, ctx.W, ctx.H], g)
    ctx.release.push(T)
  }

  function drawClipGroup(ctx, base, clipped, dstTex) {
    const T = borrow(ctx.W, ctx.H, ctx.fmt)
    clearPass(ctx.enc, T.createView())
    // the base draws with its fill only; its opacity and mode apply to the group
    const b2 = { ...base, opacity: 1, blend: 'normal', blendIf: null }
    drawLeaf(ctx, b2, T)
    for (const c of clipped) {
      if (!isVisible(c)) continue
      if (c.kind === 'adjust') { applyAdjust(ctx, c, T); continue }
      const L = borrow(ctx.W, ctx.H, ctx.fmt)
      clearPass(ctx.enc, L.createView())
      if (c.kind === 'group') drawGroup(ctx, { ...c, blend: c.blend === 'pass' ? 'normal' : c.blend, opacity: 1 }, L)
      else {
        const res = ctx.res.get(c.id)
        const rect = screenRect(ctx, c, res)
        if (rect) drawNode(ctx, c, L.createView(), false, c.fillOpacity ?? 1, rect)
        if (c.styles?.length) ctx.host.styles?.(ctx, c, L, [0, 0, ctx.W, ctx.H])
      }
      blendOnto(ctx, T, L, c.blend === 'pass' ? 'normal' : c.blend ?? 'normal', c.opacity, true, c, [0, 0, ctx.W, ctx.H])
      ctx.release.push(L)
    }
    blendOnto(ctx, dstTex, T, base.blend ?? 'normal', base.opacity, false, base, [0, 0, ctx.W, ctx.H])
    ctx.release.push(T)
  }

  function drawList(ctx, list, dstTex, from = 0) {
    for (let i = from; i < list.length;) {
      const n = list[i]
      let j = i + 1
      const clipped = []
      while (j < list.length && list[j].clip) clipped.push(list[j++])
      if (isVisible(n)) {
        if (clipped.some(isVisible) && n.kind !== 'adjust') drawClipGroup(ctx, n, clipped, dstTex)
        else {
          drawLeaf(ctx, n, dstTex)
          // clipped onto an adjustment: Photoshop clips them to what is below
          if (n.kind === 'adjust') for (const c of clipped) if (isVisible(c)) drawLeaf(ctx, { ...c, clip: false }, dstTex)
        }
      }
      i = j
    }
  }

  // below-cache: the accumulator after the first k top-level nodes
  let below = null // { sig, tex }

  // Render the document into `acc` (a target-sized texture of fmt).
  // spec: { W, H, view: [sx, sy, ox, oy], dw, dh, depth, cacheAt?, sig?(i) }
  function composite(doc, res, host, acc, spec) {
    slot = 0
    const fmt = acc.format
    const ctx = {
      enc: device.createCommandEncoder(), W: spec.W, H: spec.H, view: spec.view,
      dw: doc.width, dh: doc.height, fmt, res, host, doc, release: [],
      linear: doc.depth === 32, seed: 0, spec,
    }
    clearPass(ctx.enc, level0(acc))
    const nodes = doc.nodes
    let start = 0
    const k = spec.cacheAt ?? -1
    if (k > 0 && spec.sigs) {
      const sig = spec.sigs(k)
      if (below?.sig === sig && below.tex.width === spec.W && below.tex.height === spec.H && below.tex.format === fmt) {
        ctx.enc.copyTextureToTexture({ texture: below.tex }, { texture: acc }, [spec.W, spec.H])
        start = k
      } else {
        drawList(ctx, nodes.slice(0, k), acc)
        if (below?.tex.width !== spec.W || below?.tex.height !== spec.H || below?.tex.format !== fmt) {
          below?.tex.destroy()
          below = { sig: null, tex: createTex(spec.W, spec.H, fmt, false) }
        }
        ctx.enc.copyTextureToTexture({ texture: acc }, { texture: below.tex }, [spec.W, spec.H])
        below.sig = sig
        start = k
      }
    }
    // clipped layers right after the cache point belong to a base below it
    while (start > 0 && start < nodes.length && nodes[start].clip) start--
    if (start > 0 && start !== k) {
      // fell back across a clipping group: redraw from scratch
      clearPass(ctx.enc, level0(acc))
      start = 0
    }
    drawList(ctx, nodes, acc, start)
    device.queue.submit([ctx.enc.finish()])
    for (const t of ctx.release) giveBack(t)
  }

  // present the accumulator on a canvas context
  // map: target px → source uv (default: the source is target-aligned)
  function present(gctx, acc, { docRect, surround, checker = 8, linear = false, dither = true, exposure = 0, map = null }) {
    const view = gctx.getCurrentTexture().createView()
    const fmt = gpu.format
    const p = pipe('util', 'fs_present', fmt)
    const u = new Float32Array(20)
    u.set(docRect)
    u.set(surround, 4)
    u.set([checker, linear ? 1 : 0, dither ? 1 : 0, 1], 8)
    u.set([exposure, 0, 0, 0], 12)
    u.set(map ?? [1 / acc.width, 1 / acc.height, 0, 0], 16)
    const enc = device.createCommandEncoder()
    const pass = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] })
    pass.setPipeline(p)
    pass.setBindGroup(0, device.createBindGroup({
      layout: p.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: sampler },
        { binding: 1, resource: level0(acc) },
        { binding: 2, resource: uniform(u) },
      ],
    }))
    pass.draw(3)
    pass.end()
    device.queue.submit([enc.finish()])
  }

  // same-size shader copy (format conversion)
  function convert(src, dst) {
    const p = pipe('util', 'fs_copy', dst.format)
    const enc = device.createCommandEncoder()
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: level0(dst), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] })
    pass.setPipeline(p)
    pass.setBindGroup(0, device.createBindGroup({
      layout: p.getBindGroupLayout(0),
      entries: [{ binding: 1, resource: level0(src) }],
    }))
    pass.draw(3)
    pass.end()
    device.queue.submit([enc.finish()])
  }

  // a plugin's shaders: pipe(name, entry, format) once added
  const addModule = (name, code) => { if (!modules[name]) modules[name] = device.createShaderModule({ code }) }

  // one full-screen pass of `mod`/`entry` into target (a texture, its first
  // mip level): resources by binding index (null skips), uniforms (Float32
  // Array) bound at uBinding. rect: optional scissor
  function run(mod, entry, target, resources, u = null, { uBinding = 3, rect = null, load = false, blend = null } = {}) {
    const p = pipe(mod, entry, target.format, { blend })
    const entries = []
    resources.forEach((r, i) => { if (r) entries.push({ binding: i, resource: r }) })
    if (u) entries.push({ binding: uBinding, resource: uniform(u) })
    const enc = device.createCommandEncoder()
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: level0(target), loadOp: load ? 'load' : 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] })
    if (rect) pass.setScissorRect(...rect)
    pass.setPipeline(p)
    pass.setBindGroup(0, device.createBindGroup({ layout: p.getBindGroupLayout(0), entries }))
    pass.draw(3)
    pass.end()
    device.queue.submit([enc.finish()])
  }

  return {
    device, sampler, nearest, canBlend32, canFilter32, addModule, run,
    createTex, level0, genMips, borrow, giveBack, trimPool, composite, present, convert, pipe, uniform,
    resetArena: () => { slot = 0 },
    invalidateBelow: () => { if (below) below.sig = null },
    dropBelow: () => { below?.tex.destroy(); below = null },
    dummy,
  }
}

// ── CPU helpers for ramps and adjustment uniforms ──────────────────────────
// stops: [{ t 0..1, color [r,g,b,a] straight }] → 256 rgba floats
export function gradientRamp(stops) {
  const s = [...(stops?.length ? stops : [{ t: 0, color: [0, 0, 0, 1] }, { t: 1, color: [1, 1, 1, 1] }])]
    .sort((a, b) => a.t - b.t)
  const out = new Float32Array(1024)
  for (let i = 0; i < 256; i++) {
    const t = i / 255
    let j = 0
    while (j < s.length - 1 && s[j + 1].t < t) j++
    const a = s[j]
    const b = s[Math.min(j + 1, s.length - 1)]
    const f = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0
    for (let c = 0; c < 4; c++) out[i * 4 + c] = (a.color[c] ?? 1) + ((b.color[c] ?? 1) - (a.color[c] ?? 1)) * f
  }
  return out
}

// curves: { master: [[x,y]…], r, g, b } in 0..1 → 256 × (r, g, b, master)
export function curvesRamp(curves) {
  const out = new Float32Array(1024)
  const chans = ['r', 'g', 'b', 'master']
  chans.forEach((k, c) => {
    const f = monotoneSpline(curves?.[k] ?? null)
    for (let i = 0; i < 256; i++) out[i * 4 + c] = f(i / 255)
  })
  return out
}

// Fritsch–Carlson monotone cubic through the points (identity without any)
export function monotoneSpline(pts) {
  if (!pts || pts.length < 2) return (x) => x
  const p = [...pts].sort((a, b) => a[0] - b[0])
  const n = p.length
  const d = []
  const m = []
  for (let i = 0; i < n - 1; i++) d.push((p[i + 1][1] - p[i][1]) / Math.max(p[i + 1][0] - p[i][0], 1e-6))
  m.push(d[0])
  for (let i = 1; i < n - 1; i++) m.push(d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2)
  m.push(d[n - 2])
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue }
    const a = m[i] / d[i]
    const b = m[i + 1] / d[i]
    const s = a * a + b * b
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i] }
  }
  return (x) => {
    if (x <= p[0][0]) return p[0][1]
    if (x >= p[n - 1][0]) return p[n - 1][1]
    let i = 0
    while (i < n - 2 && x > p[i + 1][0]) i++
    const h = p[i + 1][0] - p[i][0]
    const t = (x - p[i][0]) / h
    const t2 = t * t
    const t3 = t2 * t
    const v = (2 * t3 - 3 * t2 + 1) * p[i][1] + (t3 - 2 * t2 + t) * h * m[i] +
      (-2 * t3 + 3 * t2) * p[i + 1][1] + (t3 - t2) * h * m[i + 1]
    return Math.min(1, Math.max(0, v))
  }
}

const CHANNEL = { rgb: 0, r: 1, g: 2, b: 3 }
export function adjustUniforms(a, linear) {
  const u = new Float32Array(32)
  const t = ADJUST_INDEX[a.type] ?? 0
  u[0] = t
  u[1] = CHANNEL[a.channel ?? 'rgb'] ?? 0
  u[2] = linear ? 1 : 0
  const P = a.params ?? {}
  switch (a.type) {
    case 'levels': u.set([P.inBlack ?? 0, P.inWhite ?? 1, P.gamma ?? 1, P.outBlack ?? 0, P.outWhite ?? 1], 4); break
    case 'huesat': u.set([(P.hue ?? 0) / 360, (P.saturation ?? 0) / 100, (P.lightness ?? 0) / 100, P.colorize ? 1 : 0,
      (P.cHue ?? 0) / 360, (P.cSat ?? 25) / 100], 4); break
    case 'threshold': u[4] = (P.level ?? 128) / 255; break
    case 'posterize': u[4] = P.levels ?? 4; break
    case 'mixer': {
      u[4] = P.mono ? 1 : 0
      const M = P.matrix ?? [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]]
      u.set(M[0], 20); u.set(M[1], 24); u.set(M[2], 28)
      break
    }
    case 'photofilter': u.set([...(P.color ?? [0.93, 0.54, 0.1]), (P.density ?? 25) / 100, P.preserve === false ? 0 : 1], 4); break
    case 'brightness': u.set([(P.brightness ?? 0) / 100, (P.contrast ?? 0) / 100], 4); break
    case 'exposure': u.set([P.exposure ?? 0, P.offset ?? 0, P.gamma ?? 1], 4); break
    default: break
  }
  return u
}
