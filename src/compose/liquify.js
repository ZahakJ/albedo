import { CO } from './protocol.js'
import { findNode } from './model.js'
import { docToUv } from './mesh.js'

// Liquify. Each layer can carry a displacement field (node.disp): for every
// point of the layer, where its content comes from, in layer texels. The
// compositor reads it when drawing the layer, so liquify on a smart object
// or a type layer stays editable, and Reconstruct brings the original back
// exactly. The tools edit the field: forward warp (push), bloat, pucker,
// twirl, reconstruct, smooth. The field is half the layer's resolution.

const WGSL = `
struct LU { a: vec4f, b: vec4f } // a: centre x, y (field px), radius, strength; b: mode, push x, y, pad
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var copy: texture_2d<f32>;  // the field under the dab (rect-sized)
@group(0) @binding(2) var<uniform> L: LU;
@group(0) @binding(3) var<uniform> R: vec4f;      // rect origin x, y, field scale (layer texels per field px), pad
struct VOut { @builtin(position) p: vec4f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> VOut {
  let xy = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VOut; o.p = vec4f(xy * 2.0 - 1.0, 0.0, 1.0); return o;
}
fn at(q: vec2f) -> vec2f {
  // bilinear read of the copied field at field px q
  let dim = vec2f(textureDimensions(copy));
  return textureSampleLevel(copy, samp, (q - R.xy) / dim, 0.0).xy;
}
@fragment fn fs(in: VOut) -> @location(0) vec4f {
  let p = in.p.xy;
  let c = L.a.xy;
  let r = max(L.a.z, 1.0);
  let dist = length(p - c);
  let w0 = clamp(1.0 - dist / r, 0.0, 1.0);
  let w = w0 * w0 * (3.0 - 2.0 * w0) * L.a.w;
  let mode = i32(L.b.x);
  let d = at(p);
  if (mode == 4) { return vec4f(d * (1.0 - w), 0.0, 1.0); }                // reconstruct
  if (mode == 5) {                                                         // smooth
    let s = (at(p + vec2f(2.0, 0.0)) + at(p - vec2f(2.0, 0.0)) + at(p + vec2f(0.0, 2.0)) + at(p - vec2f(0.0, 2.0))) * 0.25;
    return vec4f(mix(d, s, w), 0.0, 1.0);
  }
  var q = p;
  if (mode == 0) { q = p - L.b.yz * w; }                                   // push
  else if (mode == 1) { q = c + (p - c) * (1.0 - 0.5 * w); }               // bloat
  else if (mode == 2) { q = c + (p - c) * (1.0 + 0.5 * w); }               // pucker
  else if (mode == 3) {                                                    // twirl
    let t = w * 0.6;
    let o = p - c;
    q = c + vec2f(cos(t) * o.x - sin(t) * o.y, sin(t) * o.x + cos(t) * o.y);
  }
  // displacement is in layer texels: field px offsets scale by R.z
  return vec4f(at(q) + (q - p) * R.z, 0.0, 1.0);
}
`
const MODES = { push: 0, bloat: 1, pucker: 2, twirl: 3, reconstruct: 4, smooth: 5 }

export function liquifyPlugin() {
  let E
  let pipe = null
  let s = null

  const pipeline = () => (pipe ??= E.device.createRenderPipeline({
    layout: 'auto',
    vertex: { module: E.device.createShaderModule({ code: WGSL }), entryPoint: 'vs' },
    fragment: { module: E.device.createShaderModule({ code: WGSL }), entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
    primitive: { topology: 'triangle-list' },
  }))

  function texSize(n) {
    if (n.kind === 'pixel') return [E.texOf(n.pix).width, E.texOf(n.pix).height]
    const r = E.resMap({ ...E.doc, nodes: [n] }).get(n.id)
    return r?.tex ? [r.tex.width, r.tex.height] : [n.bounds.w, n.bounds.h]
  }

  function begin(d) {
    const n = findNode(E.doc.nodes, d.nodeId ?? E.doc.activeId)?.node
    if (!n || !(n.kind === 'pixel' || n.kind === 'smart' || n.kind === 'text' || n.kind === 'shape')) throw new Error('Liquify works on pixel, smart object, type and shape layers')
    if (n.locked) throw new Error('The layer is locked')
    const docBefore = E.doc
    let node = n
    const [tw, th] = texSize(n)
    if (!n.disp) {
      const fw = Math.max(1, Math.ceil(tw / 2)), fh = Math.max(1, Math.ceil(th / 2))
      const id = E.newRes(fw, fh, 'rgba16float', false)
      const t = E.texOf(id)
      const enc = E.device.createCommandEncoder()
      enc.beginRenderPass({ colorAttachments: [{ view: E.C.level0(t), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] }).end()
      E.device.queue.submit([enc.finish()])
      node = { ...n, disp: id, liquify: true }
      E.doc = E.patchNode(E.doc, n.id, { disp: id, liquify: true })
    }
    const tex = E.texOf(node.disp)
    const orig = E.C.createTex(tex.width, tex.height, tex.format, false)
    const enc = E.device.createCommandEncoder()
    enc.copyTextureToTexture({ texture: tex }, { texture: orig }, [tex.width, tex.height])
    E.device.queue.submit([enc.finish()])
    s = { node, tex, orig, docBefore, opts: d, last: null, dirty: null, scale: tw / tex.width }
    E.interacting = n.id
  }

  function dab(px, py, push) {
    const o = s.opts
    // brush size in field px: through the layer's own mapping
    const r = (o.size / 2) * (s.tex.width / Math.max(1, s.node.bounds.w * xfScale(s.node)))
    const pad = Math.ceil(r + Math.hypot(push[0], push[1]) + 3)
    const x0 = Math.max(0, Math.floor(px - pad)), y0 = Math.max(0, Math.floor(py - pad))
    const x1 = Math.min(s.tex.width, Math.ceil(px + pad)), y1 = Math.min(s.tex.height, Math.ceil(py + pad))
    if (x1 <= x0 || y1 <= y0) return
    const w = x1 - x0, h = y1 - y0
    const copy = E.C.createTex(w, h, 'rgba16float', false)
    let enc = E.device.createCommandEncoder()
    enc.copyTextureToTexture({ texture: s.tex, origin: [x0, y0] }, { texture: copy }, [w, h])
    E.device.queue.submit([enc.finish()])
    const L = E.device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    E.device.queue.writeBuffer(L, 0, Float32Array.of(px, py, r, (o.pressure ?? 0.5) * (o.rate ?? 1), MODES[o.mode] ?? 0, push[0], push[1], 0))
    const Rb = E.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    E.device.queue.writeBuffer(Rb, 0, Float32Array.of(x0, y0, s.scale, 0))
    const p = pipeline()
    enc = E.device.createCommandEncoder()
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: E.C.level0(s.tex), loadOp: 'load', storeOp: 'store' }] })
    pass.setScissorRect(x0, y0, w, h)
    pass.setPipeline(p)
    pass.setBindGroup(0, E.device.createBindGroup({
      layout: p.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: E.C.sampler },
        { binding: 1, resource: copy.createView() },
        { binding: 2, resource: { buffer: L } },
        { binding: 3, resource: { buffer: Rb } },
      ],
    }))
    pass.draw(3)
    pass.end()
    E.device.queue.submit([enc.finish()])
    copy.destroy(); L.destroy(); Rb.destroy()
    const rect = [x0, y0, w, h]
    s.dirty = s.dirty ? union(s.dirty, rect) : rect
  }

  function points(pts) {
    for (const [x, y] of pts) {
      const [u, v] = docToUv(s.node, x, y)
      const fx = u * s.tex.width, fy = v * s.tex.height
      if (!s.last) { s.last = [fx, fy]; if (s.opts.mode !== 'push') dab(fx, fy, [0, 0]); continue }
      const dx = fx - s.last[0], dy = fy - s.last[1]
      const dist = Math.hypot(dx, dy)
      const r = (s.opts.size / 2) * (s.tex.width / Math.max(1, s.node.bounds.w * xfScale(s.node)))
      const step = Math.max(1, r * 0.15)
      const n = Math.max(1, Math.ceil(dist / step))
      for (let i = 1; i <= n; i++) {
        const px = s.last[0] + (dx * i) / n, py = s.last[1] + (dy * i) / n
        dab(px, py, s.opts.mode === 'push' ? [dx / n, dy / n] : [0, 0])
      }
      s.last = [fx, fy]
    }
    E.markDirty(s.node.disp)
    E.requestFrame()
  }

  function end() {
    const st = s
    s = null
    E.interacting = null
    if (!st) return
    const after = E.touch(E.doc, st.node.id)
    E.doc = st.docBefore
    if (!st.dirty) { st.orig.destroy(); if (after !== st.docBefore) E.commit('Liquify', after); return }
    const before = E.snapRegion(st.orig, st.dirty)
    const aft = E.snapRegion(st.tex, st.dirty)
    st.orig.destroy()
    E.commit('Liquify', after, [{ resId: st.node.disp, rect: st.dirty, before, after: aft }])
  }

  return {
    init(e) { E = e },
    handles: {
      [CO.LIQUIFY]: (d) => {
        if (d.phase === 'begin') begin(d)
        else if (d.phase === 'pts' && s) points(d.pts)
        else if (d.phase === 'end') end()
        return {}
      },
    },
    ops: {
      // drop the field: the layer as it was before any liquify
      resetLiquify({ nodeId }) {
        const n = findNode(E.doc.nodes, nodeId ?? E.doc.activeId)?.node
        if (!n?.disp) return
        E.commit('Reset Liquify', E.patchNode(E.doc, n.id, { disp: null, liquify: false }))
      },
    },
    reset() { s = null },
    refs(keep) { if (s) keep.add(s.node.disp) },
  }
}

const xfScale = (n) => {
  const m = n.xf?.kind === 'affine' ? n.xf.m : null
  return m ? Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) : 1
}
const union = (a, b) => {
  const x0 = Math.min(a[0], b[0]), y0 = Math.min(a[1], b[1])
  return [x0, y0, Math.max(a[0] + a[2], b[0] + b[2]) - x0, Math.max(a[1] + a[3], b[1] + b[3]) - y0]
}
