import { newPixel, newGroup, findNode } from './model.js'

// Retouching set-ups: frequency separation and a dodge-and-burn layer.
//
// Frequency separation splits the active layer (or everything visible) into
// Low (a gaussian blur: colour and tone) and High ((source − low) / 2 + ½ in
// Linear Light: texture), grouped so the pair recombines to the source
// exactly. In 16- and 32-bit documents the split is lossless to the
// storage precision; in 8-bit it rounds, as in Photoshop.

const WGSL = `
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var srcA: texture_2d<f32>;
@group(0) @binding(2) var srcB: texture_2d<f32>;
@group(0) @binding(3) var<uniform> U: vec4f; // per pass
struct VOut { @builtin(position) p: vec4f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> VOut {
  let xy = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VOut; o.p = vec4f(xy * 2.0 - 1.0, 0.0, 1.0); return o;
}
// separable gaussian on premultiplied rgba: U.xy direction, U.z sigma, U.w radius
@fragment fn fs_blur(in: VOut) -> @location(0) vec4f {
  let p = vec2i(in.p.xy);
  let dim = vec2i(textureDimensions(srcA));
  let dir = vec2i(U.xy);
  let s = max(U.z, 0.3);
  var acc = vec4f(0.0);
  var ws = 0.0;
  for (var i = -i32(U.w); i <= i32(U.w); i++) {
    let w = exp(-f32(i * i) / (2.0 * s * s));
    acc += w * textureLoad(srcA, clamp(p + dir * i, vec2i(0), dim - 1), 0);
    ws += w;
  }
  return acc / ws;
}
// high = (source − low) / 2 + ½, straight colour, alpha of the source
@fragment fn fs_high(in: VOut) -> @location(0) vec4f {
  let p = vec2i(in.p.xy);
  let s = textureLoad(srcA, p, 0);
  let l = textureLoad(srcB, p, 0);
  let cs = select(vec3f(0.0), s.rgb / s.a, s.a > 1e-6);
  let cl = select(vec3f(0.0), l.rgb / l.a, l.a > 1e-6);
  let h = (cs - cl) * 0.5 + 0.5;
  return vec4f(h * s.a, s.a);
}
`

export function retouchPlugin() {
  let E
  const run = (...a) => E.C.run('retouch', ...a)
  const f4 = (...v) => Float32Array.of(...v, 0, 0, 0, 0).slice(0, 4)

  function blurRes(srcId, sigma) {
    const src = E.texOf(srcId)
    const tmp = E.C.createTex(src.width, src.height, src.format, false)
    const out = E.newRes(src.width, src.height, src.format)
    const r = Math.min(256, Math.ceil(sigma * 3))
    run('fs_blur', tmp, [null, E.C.level0(src)], f4(1, 0, sigma, r))
    run('fs_blur', E.texOf(out), [null, E.C.level0(tmp)], f4(0, 1, sigma, r))
    tmp.destroy()
    E.C.genMips(E.texOf(out))
    return out
  }

  const ops = {
    // { radius (px), source: 'layer'|'visible' }
    frequencySeparation({ radius = 6, source = 'layer' } = {}) {
      const n = E.active()
      let srcId, name
      if (source === 'visible' || !n || n.kind !== 'pixel' || n.xf || n.disp) {
        srcId = E.renderToRes(E.doc.nodes)
        name = 'Visible'
      } else {
        const g = E.ensureDocCoverage(n)
        srcId = g.pix
        name = n.name
      }
      const lowId = blurRes(srcId, radius)
      const src = E.texOf(srcId)
      const highId = E.newRes(src.width, src.height, src.format)
      run('fs_high', E.texOf(highId), [null, E.C.level0(src), E.C.level0(E.texOf(lowId))])
      E.C.genMips(E.texOf(highId))
      const b = { x: 0, y: 0, w: src.width, h: src.height }
      const low = newPixel(b, { name: 'Low frequency', pix: lowId })
      const high = newPixel(b, { name: 'High frequency', pix: highId, blend: 'linearLight' })
      const group = newGroup([low, high], { name: `Frequency separation (${name}, ${radius} px)` })
      let d = E.doc
      if (name !== 'Visible' && n) d = E.updateNode(d, n.id, (x) => ({ ...x, visible: false }))
      E.commit('Frequency Separation', E.setActive(E.insertAbove(d, n?.id ?? null, [group]), high.id))
    },
    // a neutral grey layer in Soft Light: paint lighter or darker to dodge
    // and burn without touching the pixels below
    dodgeBurnLayer() {
      const id = E.newRes(E.doc.width, E.doc.height)
      const t = E.texOf(id)
      const enc = E.device.createCommandEncoder()
      enc.beginRenderPass({ colorAttachments: [{ view: E.C.level0(t), loadOp: 'clear', storeOp: 'store', clearValue: [0.5, 0.5, 0.5, 1] }] }).end()
      E.device.queue.submit([enc.finish()])
      E.C.genMips(t)
      const n = newPixel({ x: 0, y: 0, w: E.doc.width, h: E.doc.height }, { name: 'Dodge & Burn', pix: id, blend: 'softLight' })
      E.commit('New Dodge & Burn Layer', E.setActive(E.insertAbove(E.doc, E.doc.activeId, [n]), n.id))
    },
    // Gaussian blur of the active pixel layer (destructive, like the filter)
    gaussianBlur({ nodeId, radius = 4 }) {
      const n = findNode(E.doc.nodes, nodeId ?? E.doc.activeId)?.node
      if (n?.kind !== 'pixel') throw new Error('Select a pixel layer')
      const g = E.ensureDocCoverage(n)
      const out = blurRes(g.pix, radius)
      E.commit('Gaussian Blur', E.patchNode(E.doc, n.id, { pix: out, bounds: g.bounds }))
    },
  }
  return { init(e) { E = e; E.C.addModule('retouch', WGSL) }, ops, handles: {} }
}
