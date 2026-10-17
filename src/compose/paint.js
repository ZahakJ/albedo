import paintWgsl from './gpu/paint.wgsl?raw'
import { CO } from './protocol.js'
import { findNode } from './model.js'

// Brush engine (brush, eraser, clone, heal, smudge, dodge/burn, and painting
// on masks). Strokes arrive as document points with pressure; dabs are laid
// along the path at the tool's spacing and drawn on the GPU in batches of 64.
// See paint.wgsl for the snapshot + stroke-buffer model.

const BATCH = 64

export function paintPlugin() {
  let E
  let mod = null
  const pipes = new Map()
  let stroke = null
  let bufCov = null // r16float, document-sized, reused
  let bufRgba = null // rgba16float, for clone and heal
  let bufMasked = null // the stroke buffer × the selection (resolve input)
  let ub = null // dab uniform buffer
  let rb = null // resolve uniform buffer
  let cloneAnchor = null // aligned clone: offset kept between strokes

  const device = () => E.device
  function pipe(key, vs, fs, format, blend = null) {
    const k = `${key}/${format}/${blend ? 1 : 0}`
    if (pipes.has(k)) return pipes.get(k)
    const p = device().createRenderPipeline({
      layout: 'auto',
      vertex: { module: mod, entryPoint: vs },
      fragment: { module: mod, entryPoint: fs, targets: [{ format, ...(blend ? { blend } : {}) }] },
      primitive: { topology: 'triangle-list' },
    })
    pipes.set(k, p)
    return p
  }
  const COV_BLEND = { color: { srcFactor: 'one', dstFactor: 'one-minus-src' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src' } }
  const OVER = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } }

  function scratch(kind, w, h) {
    const fmt = kind === 'rgba' ? 'rgba16float' : 'r16float'
    let t = kind === 'rgba' ? bufRgba : bufCov
    if (!t || t.width !== w || t.height !== h) {
      t?.destroy()
      t = E.C.createTex(w, h, fmt, false)
      if (kind === 'rgba') bufRgba = t; else bufCov = t
    }
    return t
  }
  const clear = (tex) => {
    const enc = device().createCommandEncoder()
    enc.beginRenderPass({ colorAttachments: [{ view: E.C.level0(tex), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] }).end()
    device().queue.submit([enc.finish()])
  }
  const copyTex = (src, w, h) => {
    const t = E.C.createTex(w, h, src.format, false)
    const enc = device().createCommandEncoder()
    enc.copyTextureToTexture({ texture: src }, { texture: t }, [w, h])
    device().queue.submit([enc.finish()])
    return t
  }

  // ── the layer a stroke paints on ─────────────────────────────────────────
  // a pixel layer must cover the document and be untransformed to take paint;
  // a transformed or liquified one is baked first, a partial one grown
  function prepareTarget(n, target) {
    if (target === 'mask') {
      if (!n.mask?.tex) throw new Error('This layer has no mask')
      return { node: n, resId: n.mask.tex, ox: n.mask.ox ?? 0, oy: n.mask.oy ?? 0 }
    }
    if (n.kind !== 'pixel') {
      if (n.mask?.tex) return prepareTarget(n, 'mask')
      throw new Error(n.kind === 'adjust' || n.kind === 'fill' ? 'Paint on its mask' : 'Rasterize the layer to paint on it')
    }
    let node = n
    if (n.xf || n.disp) {
      const id = E.bakeNode(n, { applyMask: false })
      node = { ...n, pix: id, bounds: { x: 0, y: 0, w: E.doc.width, h: E.doc.height }, xf: null, disp: null, liquify: false }
    } else {
      const b = n.bounds
      if (b.x > 0 || b.y > 0 || b.x + b.w < E.doc.width || b.y + b.h < E.doc.height) {
        node = growToDoc(n)
      }
    }
    return { node, resId: node.pix, ox: node.bounds.x, oy: node.bounds.y }
  }
  function growToDoc(n) {
    const b = n.bounds
    const x0 = Math.min(0, Math.floor(b.x)), y0 = Math.min(0, Math.floor(b.y))
    const x1 = Math.max(E.doc.width, Math.ceil(b.x + b.w)), y1 = Math.max(E.doc.height, Math.ceil(b.y + b.h))
    const src = E.texOf(n.pix)
    const id = E.newRes(x1 - x0, y1 - y0)
    const t = E.texOf(id)
    const enc = device().createCommandEncoder()
    enc.beginRenderPass({ colorAttachments: [{ view: E.C.level0(t), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] }).end()
    enc.copyTextureToTexture({ texture: src }, { texture: t, origin: [Math.round(b.x - x0), Math.round(b.y - y0)] }, [src.width, src.height])
    device().queue.submit([enc.finish()])
    E.C.genMips(t)
    return { ...n, pix: id, bounds: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } }
  }

  // ── stroke ───────────────────────────────────────────────────────────────
  function begin(data) {
    const n = findNode(E.doc.nodes, data.nodeId ?? E.doc.activeId)?.node
    if (!n) throw new Error('No layer selected')
    if (n.locked) throw new Error('The layer is locked')
    const tool = data.tool
    const docBefore = E.doc
    const t = prepareTarget(n, data.target ?? 'pixels')
    if (t.node !== n) E.doc = E.patchNode(E.doc, n.id, t.node)
    const tex = E.texOf(t.resId)
    const orig = copyTex(tex, tex.width, tex.height)
    const rgba = tool === 'clone' || tool === 'heal'
    const buf = tool === 'smudge' ? null : scratch(rgba ? 'rgba' : 'cov', tex.width, tex.height)
    if (buf) clear(buf)
    let source = null
    if (rgba) {
      if (data.sample === 'layer' || t.resId === n.mask?.tex) source = orig
      else {
        // composite of the layers up to this one (or all) — the source the
        // clone reads, in the target's pixel grid
        const sel = E.selectApi()
        const nodes = data.sample === 'all' ? E.doc.nodes : nodesUpTo(E.doc.nodes, n.id)
        source = sel.compositeTex(nodes)
      }
    }
    stroke = {
      tool, nodeId: n.id, resId: t.resId, tex, orig, buf, source, ox: t.ox, oy: t.oy,
      docBefore, opts: data, dirty: null, last: null, carry: 0, smooth: null,
      cloneOff: null, selection: E.selectApi().selection(),
      isMask: t.resId === t.node.mask?.tex,
    }
    if (rgba) {
      const src = data.source // [x, y] document px (⌥-click)
      if (!src) throw new Error('⌥-click to set the clone source first')
      stroke.cloneSrc = src
    }
    E.interacting = n.id
  }

  // dabs along the segment, spacing from the tool
  function points(pts) {
    const s = stroke
    const o = s.opts
    const out = []
    for (const raw of pts) {
      let p = [raw[0] - s.ox, raw[1] - s.oy, raw[2] ?? 1]
      // lazy-mouse smoothing
      if (o.smoothing > 0 && s.smooth) {
        const k = 1 - Math.min(0.95, o.smoothing)
        p = [s.smooth[0] + (p[0] - s.smooth[0]) * k, s.smooth[1] + (p[1] - s.smooth[1]) * k, p[2]]
      }
      s.smooth = p
      if (!s.last) {
        out.push(p)
        s.last = p
        if (s.cloneSrc && !s.cloneOff) {
          const keep = o.aligned && cloneAnchor && cloneAnchor.src === s.cloneSrc
          s.cloneOff = keep ? cloneAnchor.off : [s.cloneSrc[0] - s.ox - p[0], s.cloneSrc[1] - s.oy - p[1]]
          cloneAnchor = { src: s.cloneSrc, off: s.cloneOff }
        }
        continue
      }
      const [lx, ly, lp] = s.last
      const dx = p[0] - lx, dy = p[1] - ly
      const dist = Math.hypot(dx, dy)
      const size = dabSize(o, p[2])
      const step = Math.max(0.5, size * (o.spacing ?? 0.15))
      let t = step - s.carry
      while (t <= dist) {
        const f = t / dist
        out.push([lx + dx * f, ly + dy * f, lp + (p[2] - lp) * f])
        t += step
      }
      s.carry = dist - (t - step)
      s.last = p
    }
    return out
  }
  const dabSize = (o, pr) => Math.max(1, o.size * (o.pressure === 'size' ? Math.max(0.1, pr) : 1))
  const dabFlow = (o, pr) => (o.flow ?? 1) * (o.pressure === 'flow' || o.pressure === 'opacity' ? pr : 1)

  function drawDabs(dabs) {
    const s = stroke
    const o = s.opts
    const W = s.tex.width, H = s.tex.height
    for (let i = 0; i < dabs.length; i += BATCH) {
      const batch = dabs.slice(i, i + BATCH)
      const u = new Float32Array(4 + BATCH * 8)
      u.set([batch.length, W, H, 0])
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      batch.forEach((d, j) => {
        const r = dabSize(o, d[2]) / 2
        const flow = s.tool === 'dodge' ? (o.pressure === 'flow' ? d[2] : 1) : dabFlow(o, d[2])
        u.set([d[0], d[1], r, o.hardness ?? 0.8, flow, s.cloneOff?.[0] ?? 0, s.cloneOff?.[1] ?? 0, 0], 4 + j * 8)
        x0 = Math.min(x0, d[0] - r - 2); y0 = Math.min(y0, d[1] - r - 2)
        x1 = Math.max(x1, d[0] + r + 2); y1 = Math.max(y1, d[1] + r + 2)
      })
      const rect = clampRect([x0, y0, x1 - x0, y1 - y0], W, H)
      if (!rect) continue
      ub ??= device().createBuffer({ size: u.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
      device().queue.writeBuffer(ub, 0, u)
      if (s.tool === 'smudge') { smudgeBatch(batch); continue }
      const rgba = s.tool === 'clone' || s.tool === 'heal'
      const p = rgba ? pipe('dabc', 'vs_dab', 'fs_dab_clone', 'rgba16float', OVER) : pipe('dab', 'vs_dab', 'fs_dab_cov', 'r16float', COV_BLEND)
      const enc = device().createCommandEncoder()
      const pass = enc.beginRenderPass({ colorAttachments: [{ view: E.C.level0(s.buf), loadOp: 'load', storeOp: 'store' }] })
      pass.setPipeline(p)
      const entries = [{ binding: 3, resource: { buffer: ub } }]
      if (rgba) entries.push({ binding: 0, resource: E.C.sampler }, { binding: 1, resource: s.source.createView({ baseMipLevel: 0, mipLevelCount: 1 }) })
      pass.setBindGroup(0, device().createBindGroup({ layout: p.getBindGroupLayout(0), entries }))
      pass.draw(6, batch.length)
      pass.end()
      device().queue.submit([enc.finish()])
      resolve(rect)
    }
  }

  // apply the selection: coverage outside it is removed before resolving
  function resolve(rect) {
    const s = stroke
    s.dirty = s.dirty ? union(s.dirty, rect) : rect
    const o = s.opts
    let entry = 'fs_res_paint'
    const u = new Float32Array(12)
    u.set(E.linColor(o.color ?? [1, 1, 1, 1]))
    u[4] = o.opacity ?? 1
    if (s.isMask) { entry = 'fs_res_mask'; u[0] = lum(o.color ?? [1, 1, 1]) }
    else if (s.tool === 'eraser') entry = 'fs_res_erase'
    else if (s.tool === 'clone' || s.tool === 'heal') entry = 'fs_res_clone'
    else if (s.tool === 'dodge') {
      entry = 'fs_res_dodge'
      u[5] = (o.mode === 'burn' ? -1 : 1) * (o.exposure ?? 0.15)
      u[6] = o.range === 'shadows' ? 0 : o.range === 'highlights' ? 2 : 1
      u[7] = o.protect === false ? 0 : 1
    }
    const bufIn = s.selection ? maskBufferBySelection(rect) : s.buf
    rb ??= device().createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    device().queue.writeBuffer(rb, 0, u)
    const p = pipe(entry, 'vs_full', entry, s.tex.format)
    const enc = device().createCommandEncoder()
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: E.C.level0(s.tex), loadOp: 'load', storeOp: 'store' }] })
    pass.setScissorRect(...rect)
    pass.setPipeline(p)
    pass.setBindGroup(0, device().createBindGroup({
      layout: p.getBindGroupLayout(0),
      entries: [
        { binding: 1, resource: E.C.level0(s.orig) },
        { binding: 2, resource: E.C.level0(bufIn) },
        { binding: 4, resource: { buffer: rb } },
      ],
    }))
    pass.draw(3)
    pass.end()
    device().queue.submit([enc.finish()])
    E.C.genMips(s.tex, rect)
    E.markDirty(s.resId)
    E.requestFrame()
  }

  // the stroke buffer × the selection, within rect, into a second buffer
  // (the stroke buffer itself keeps accumulating unmasked)
  function maskBufferBySelection(rect) {
    const s = stroke
    if (!bufMasked || bufMasked.width !== s.buf.width || bufMasked.height !== s.buf.height || bufMasked.format !== s.buf.format) {
      bufMasked?.destroy()
      bufMasked = E.C.createTex(s.buf.width, s.buf.height, s.buf.format, false)
    }
    E.C.run('maskmul', 'fs', bufMasked, [null, E.C.level0(s.buf), E.C.level0(s.selection)],
      Float32Array.of(0, 0, s.ox, s.oy), { uBinding: 3, rect, load: true })
    return bufMasked
  }

  function smudgeBatch(batch) {
    const s = stroke
    const o = s.opts
    for (const d of batch) {
      const size = Math.ceil(dabSize(o, d[2]))
      const x = Math.round(d[0] - size / 2), y = Math.round(d[1] - size / 2)
      const rect = clampRect([x, y, size, size], s.tex.width, s.tex.height)
      if (!rect || rect[2] !== size || rect[3] !== size) continue
      // the copy under the dab
      const cur = E.C.createTex(size, size, s.tex.format, false)
      let enc = device().createCommandEncoder()
      enc.copyTextureToTexture({ texture: s.tex, origin: [x, y] }, { texture: cur }, [size, size])
      device().queue.submit([enc.finish()])
      if (!s.carried || s.carried.width !== size) {
        s.carried?.destroy()
        s.carried = E.C.createTex(size, size, s.tex.format, false)
        enc = device().createCommandEncoder()
        enc.copyTextureToTexture({ texture: s.tex, origin: [x, y] }, { texture: s.carried }, [size, size])
        device().queue.submit([enc.finish()])
        cur.destroy()
        continue
      }
      const strength = (o.strength ?? 0.6) * (o.pressure === 'strength' ? d[2] : 1)
      const u = new Float32Array(12)
      u.set([0, 0, 0, 0, x, y, strength, o.hardness ?? 0.5, size])
      rb ??= device().createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
      device().queue.writeBuffer(rb, 0, u)
      const pa = pipe('smudge', 'vs_full', 'fs_smudge_apply', s.tex.format)
      enc = device().createCommandEncoder()
      let pass = enc.beginRenderPass({ colorAttachments: [{ view: E.C.level0(s.tex), loadOp: 'load', storeOp: 'store' }] })
      pass.setScissorRect(...rect)
      pass.setPipeline(pa)
      pass.setBindGroup(0, device().createBindGroup({
        layout: pa.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: E.C.sampler },
          { binding: 1, resource: cur.createView() },
          { binding: 2, resource: s.carried.createView() },
          { binding: 4, resource: { buffer: rb } },
        ],
      }))
      pass.draw(3)
      pass.end()
      // carried colour picks up a little of the new spot
      const next = E.C.createTex(size, size, s.tex.format, false)
      const pc = pipe('carry', 'vs_full', 'fs_smudge_carry', s.tex.format)
      pass = enc.beginRenderPass({ colorAttachments: [{ view: next.createView(), loadOp: 'clear', storeOp: 'store' }] })
      pass.setPipeline(pc)
      pass.setBindGroup(0, device().createBindGroup({
        layout: pc.getBindGroupLayout(0),
        entries: [
          { binding: 1, resource: cur.createView() },
          { binding: 2, resource: s.carried.createView() },
          { binding: 4, resource: { buffer: rb } },
        ],
      }))
      pass.draw(3)
      pass.end()
      device().queue.submit([enc.finish()])
      cur.destroy()
      s.carried.destroy()
      s.carried = next
      s.dirty = s.dirty ? union(s.dirty, rect) : rect
      E.C.genMips(s.tex, rect)
    }
    E.markDirty(s.resId)
    E.requestFrame()
  }

  // heal: match the cloned area to its surroundings (pull-push membrane)
  function heal() {
    const s = stroke
    if (!s.dirty) return
    const pad = Math.ceil((s.opts.size ?? 60) * 0.5) + 4
    const r = clampRect([s.dirty[0] - pad, s.dirty[1] - pad, s.dirty[2] + 2 * pad, s.dirty[3] + 2 * pad], s.tex.width, s.tex.height)
    if (!r) return
    const cloned = copyTex(s.tex, s.tex.width, s.tex.height)
    const levels = []
    let w = r[2], h = r[3]
    const seed = E.C.createTex(w, h, 'rgba16float', false)
    runPaint('fs_heal_seed', seed, [[1, E.C.level0(s.orig)], [2, s.source.createView({ baseMipLevel: 0, mipLevelCount: 1 })], [5, E.C.level0(s.buf)]],
      [0, 0, 0, 0, 0, 0, 0, 0, r[0], r[1], s.cloneOff?.[0] ?? 0, s.cloneOff?.[1] ?? 0])
    levels.push(seed)
    while (w > 1 || h > 1) {
      w = Math.max(1, Math.ceil(w / 2)); h = Math.max(1, Math.ceil(h / 2))
      const t = E.C.createTex(w, h, 'rgba16float', false)
      runPaint('fs_pp_down', t, [[1, E.C.level0(levels[levels.length - 1])]], [])
      levels.push(t)
    }
    // up: normalise the coarsest, then blend each finer level over the
    // interpolation from below
    let up = E.C.createTex(1, 1, 'rgba16float', false)
    runPaint('fs_pp_up', up, [[0, E.C.sampler], [1, E.C.level0(levels[levels.length - 1])], [2, E.C.level0(levels[levels.length - 1])]], [])
    for (let i = levels.length - 2; i >= 0; i--) {
      const L = levels[i]
      const t = E.C.createTex(L.width, L.height, 'rgba16float', false)
      runPaint('fs_pp_up', t, [[0, E.C.sampler], [1, E.C.level0(L)], [2, up.createView()]], [])
      up.destroy()
      up = t
    }
    runPaint('fs_heal_apply', s.tex, [[1, up.createView()], [2, E.C.level0(cloned)], [5, E.C.level0(s.buf)]],
      [0, 0, 0, 0, 0, 0, 0, 0, r[0], r[1]], r)
    levels.forEach((t) => t.destroy())
    up.destroy()
    cloned.destroy()
    s.dirty = union(s.dirty, r)
    E.C.genMips(s.tex, r)
  }
  function runPaint(entry, target, res, uvals, rect = null) {
    const p = pipe(entry, 'vs_full', entry, target.format)
    const u = new Float32Array(12)
    u.set(uvals.slice(0, 12))
    // each pass gets its own uniform buffer
    const buf = device().createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    device().queue.writeBuffer(buf, 0, u)
    const enc = device().createCommandEncoder()
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: E.C.level0(target), loadOp: rect ? 'load' : 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] })
    if (rect) pass.setScissorRect(...rect)
    pass.setPipeline(p)
    const entries = res.map(([binding, resource]) => ({ binding, resource }))
    if (usesR(entry)) entries.push({ binding: 4, resource: { buffer: buf } })
    pass.setBindGroup(0, device().createBindGroup({ layout: p.getBindGroupLayout(0), entries }))
    pass.draw(3)
    pass.end()
    device().queue.submit([enc.finish()])
    buf.destroy()
  }
  const usesR = (entry) => entry === 'fs_heal_seed' || entry === 'fs_heal_apply' || entry.startsWith('fs_res') || entry.startsWith('fs_smudge')

  function end() {
    const s = stroke
    stroke = null
    E.interacting = null
    if (!s) return
    if (s.tool === 'heal') heal()
    s.carried?.destroy()
    if (s.source && s.source !== s.orig) s.source.destroy()
    if (!s.dirty) {
      s.orig.destroy()
      if (E.doc !== s.docBefore) { const d = E.doc; E.doc = s.docBefore; E.commit(LABEL[s.tool] ?? 'Paint', d) }
      return
    }
    const rect = s.dirty
    const before = E.snapRegion(s.orig, rect)
    const after = E.snapRegion(s.tex, rect)
    s.orig.destroy()
    const docAfter = E.touch(E.doc, s.nodeId)
    E.doc = s.docBefore
    E.commit(s.isMask ? `${LABEL[s.tool] ?? 'Paint'} (Mask)` : LABEL[s.tool] ?? 'Paint', docAfter, [{ resId: s.resId, rect, before, after }])
  }

  const LABEL = { brush: 'Brush', eraser: 'Eraser', clone: 'Clone Stamp', heal: 'Healing Brush', smudge: 'Smudge', dodge: 'Dodge/Burn' }

  return {
    init(e) {
      E = e
      mod = device().createShaderModule({ code: paintWgsl })
      E.C.addModule('maskmul', MASKMUL)
      E.ensureDocCoverage = (n) => {
        const b = n.bounds
        if (n.xf || n.disp || b.x > 0 || b.y > 0 || b.x + b.w < E.doc.width || b.y + b.h < E.doc.height) {
          const t = prepareTarget(n, 'pixels')
          return t.node
        }
        return n
      }
    },
    handles: {
      [CO.STROKE_BEGIN]: (data) => { begin(data); return null },
      [CO.STROKE_PTS]: (data) => { if (stroke) drawDabs(points(data.pts)); return null },
      [CO.STROKE_END]: () => { end(); return {} },
    },
    reset() { stroke = null; cloneAnchor = null },
    refs(keep) { if (stroke) keep.add(stroke.resId) },
  }
}

const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
const union = (a, b) => {
  const x0 = Math.min(a[0], b[0]), y0 = Math.min(a[1], b[1])
  const x1 = Math.max(a[0] + a[2], b[0] + b[2]), y1 = Math.max(a[1] + a[3], b[1] + b[3])
  return [x0, y0, x1 - x0, y1 - y0]
}
const clampRect = (r, W, H) => {
  const x0 = Math.max(0, Math.floor(r[0])), y0 = Math.max(0, Math.floor(r[1]))
  const x1 = Math.min(W, Math.ceil(r[0] + r[2])), y1 = Math.min(H, Math.ceil(r[1] + r[3]))
  return x1 > x0 && y1 > y0 ? [x0, y0, x1 - x0, y1 - y0] : null
}
// the nodes up to and including id, as a document list (groups kept whole)
function nodesUpTo(nodes, id) {
  const out = []
  for (const n of nodes) {
    out.push(n)
    if (n.id === id) return out
    if (n.kind === 'group' && findNode(n.children ?? [], id)) {
      out[out.length - 1] = { ...n, children: nodesUpTo(n.children, id) }
      return out
    }
  }
  return out
}

// stroke buffer × selection: srcA = buffer copy of the rect, srcB = selection
// (document px = target px + target offset)
const MASKMUL = `
@group(0) @binding(1) var bufCopy: texture_2d<f32>;
@group(0) @binding(2) var sel: texture_2d<f32>;
@group(0) @binding(3) var<uniform> U: vec4f; // rect x, y, target offset x, y
struct VOut { @builtin(position) p: vec4f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> VOut {
  let xy = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VOut; o.p = vec4f(xy * 2.0 - 1.0, 0.0, 1.0); return o;
}
@fragment fn fs(in: VOut) -> @location(0) vec4f {
  let p = vec2i(in.p.xy);
  let b = textureLoad(bufCopy, p - vec2i(U.xy), 0);
  let q = p + vec2i(U.zw);
  let dim = vec2i(textureDimensions(sel));
  var m = 0.0;
  if (all(q >= vec2i(0)) && all(q < dim)) { m = textureLoad(sel, q, 0).r; }
  return b * m;
}
`
