// Layer styles: drop shadow, stroke and outer glow, drawn from the layer's
// alpha at the resolution it is shown (so they stay crisp at any zoom and
// cost nothing until used). The compositor draws the layer alone into a
// scratch texture; this replaces it with styles + content, which is then
// blended with the layer's mode and opacity. Shadow and glow sit under the
// content in normal mode (Photoshop blends them with their own mode against
// the layers below; here they take the layer's).

const WGSL = `
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var srcA: texture_2d<f32>;
@group(0) @binding(2) var srcB: texture_2d<f32>;
@group(0) @binding(3) var<uniform> U: array<vec4f, 4>;
@group(0) @binding(4) var srcC: texture_2d<f32>;
struct VOut { @builtin(position) p: vec4f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> VOut {
  let xy = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VOut; o.p = vec4f(xy * 2.0 - 1.0, 0.0, 1.0); return o;
}
fn ld(t: texture_2d<f32>, p: vec2i) -> vec4f {
  let d = vec2i(textureDimensions(t));
  if (any(p < vec2i(0)) || any(p >= d)) { return vec4f(0.0); }
  return textureLoad(t, p, 0);
}
// alpha, offset by U[0].xy (px), into r
@fragment fn fs_alpha(in: VOut) -> @location(0) vec4f {
  return vec4f(ld(srcA, vec2i(in.p.xy - U[0].xy)).a);
}
// separable gaussian of r: U[0].xy dir, U[0].z sigma, U[0].w radius
@fragment fn fs_blur(in: VOut) -> @location(0) vec4f {
  let p = vec2i(in.p.xy);
  let dir = vec2i(U[0].xy);
  let s = max(U[0].z, 0.3);
  var acc = 0.0; var ws = 0.0;
  for (var i = -i32(U[0].w); i <= i32(U[0].w); i++) {
    let w = exp(-f32(i * i) / (2.0 * s * s));
    acc += w * ld(srcA, p + dir * i).r; ws += w;
  }
  return vec4f(acc / ws);
}
// jump flood: seed = texels with alpha ≥ ½ (U[0].y = 1: the outside instead)
@fragment fn fs_seed(in: VOut) -> @location(0) vec4f {
  let p = vec2i(in.p.xy);
  let a = ld(srcA, p).a;
  let inside = select((a >= 0.5), (a < 0.5), (U[0].y > 0.5));
  return select(vec4f(-1e6, -1e6, 0.0, 0.0), vec4f(vec2f(p), 0.0, 1.0), inside);
}
@fragment fn fs_jfa(in: VOut) -> @location(0) vec4f {
  let p = vec2i(in.p.xy);
  let k = i32(U[0].x);
  var best = ld(srcA, p);
  var bd = select(1e12, distance(vec2f(p), best.xy), best.w > 0.5);
  for (var j = -1; j <= 1; j++) { for (var i = -1; i <= 1; i++) {
    let s = ld(srcA, p + vec2i(i, j) * k);
    if (s.w < 0.5) { continue; }
    let d = distance(vec2f(p), s.xy);
    if (d < bd) { bd = d; best = s; }
  } }
  return best;
}
// combine: srcA = content (premultiplied), srcB = shadow/glow coverage (r =
// shadow, from fs_blur), srcC = distance field outside (xy nearest seed)
// U[1] = shadow colour (rgb, opacity in a), U[2] = stroke colour (rgb,
// opacity), U[3] = stroke size (px), stroke mode (0 off 1 outside 2 centre
// 3 inside), glow opacity, has shadow
@fragment fn fs_combine(in: VOut) -> @location(0) vec4f {
  let p = vec2i(in.p.xy);
  let c = ld(srcA, p);
  var out = vec4f(0.0);
  if (U[3].w > 0.5) {
    let a = ld(srcB, p).r * U[1].a;
    out = vec4f(U[1].rgb * a, a);
  }
  // content over the shadow
  out = c + out * (1.0 - c.a);
  let mode = i32(U[3].y);
  if (mode > 0) {
    let s = ld(srcC, p);
    let d = select(1e9, distance(vec2f(p), s.xy), s.w > 0.5);
    let size = U[3].x;
    var k = 0.0;
    if (mode == 1) { k = clamp(size - d + 0.5, 0.0, 1.0) * (1.0 - c.a); }
    else if (mode == 3) { k = clamp(size - d + 0.5, 0.0, 1.0) * c.a; }
    else { k = clamp(size * 0.5 - d + 0.5, 0.0, 1.0); }
    k = k * U[2].a;
    out = vec4f(U[2].rgb * k, k) + out * (1.0 - k);
  }
  return out;
}
`

export function stylesPlugin() {
  let E
  const run = (...a) => E.C.run('styles', ...a)
  const u4 = (...rows) => { const u = new Float32Array(16); rows.forEach((r, i) => u.set(r, i * 4)); return u }

  function jfa(src, W, H, outside) {
    const a = E.C.borrow(W, H, 'rgba32float')
    const b = E.C.borrow(W, H, 'rgba32float')
    run('fs_seed', a, [null, E.C.level0(src)], u4([0, outside ? 1 : 0, 0, 0]))
    let s = a, d = b
    for (let step = 1 << Math.ceil(Math.log2(Math.max(W, H))); step >= 1; step >>= 1) {
      run('fs_jfa', d, [null, E.C.level0(s)], u4([step, 0, 0, 0]));
      [s, d] = [d, s]
    }
    E.C.giveBack(d)
    return s
  }

  // ctx: compositor frame; L: the layer drawn alone (premultiplied)
  function styles(ctx, node, L) {
    const W = ctx.W, H = ctx.H
    const sc = ctx.view[0]
    const st = (node.styles ?? []).filter((s) => s.enabled !== false)
    const shadow = st.find((s) => s.type === 'shadow')
    const glow = st.find((s) => s.type === 'glow')
    const stroke = st.find((s) => s.type === 'stroke')
    // the compositor's pending work must reach the queue before ours
    ctx.enc && E.device.queue.submit([ctx.enc.finish()])
    ctx.enc = E.device.createCommandEncoder()
    let cover = null
    const under = shadow ?? glow
    if (under) {
      const isShadow = !!shadow
      const ang = ((shadow?.angle ?? 120) * Math.PI) / 180
      const dist = isShadow ? (shadow.distance ?? 12) * sc : 0
      const off = [-Math.cos(ang) * dist, Math.sin(ang) * dist]
      const sigma = Math.max(0.3, ((under.size ?? 16) / 2) * sc)
      const r = Math.min(128, Math.ceil(sigma * 2.5))
      const t1 = E.C.borrow(W, H, 'r16float')
      const t2 = E.C.borrow(W, H, 'r16float')
      run('fs_alpha', t1, [null, E.C.level0(L)], u4([off[0], off[1], 0, 0]))
      run('fs_blur', t2, [null, E.C.level0(t1)], u4([1, 0, sigma, r]))
      run('fs_blur', t1, [null, E.C.level0(t2)], u4([0, 1, sigma, r]))
      E.C.giveBack(t2)
      cover = t1
    }
    let dist = null
    if (stroke) dist = jfa(L, W, H, stroke.position === 'inside')
    const out = E.C.borrow(W, H, L.format)
    const sc0 = under?.color ?? [0, 0, 0, 1]
    const scol = ctx.linear ? sc0.slice(0, 3).map(lin) : sc0.slice(0, 3)
    const kc = stroke?.color ?? [1, 1, 1, 1]
    const kcol = ctx.linear ? kc.slice(0, 3).map(lin) : kc.slice(0, 3)
    const spread = 1 + (under?.spread ?? 0) * 3
    const mode = !stroke ? 0 : stroke.position === 'inside' ? 3 : stroke.position === 'center' ? 2 : 1
    run('fs_combine', out, [null, E.C.level0(L), cover ? E.C.level0(cover) : E.C.dummy.r.createView(), null, dist ? E.C.level0(dist) : E.C.dummy.rgba.createView()],
      u4([0, 0, 0, 0], [...scol, Math.min(1, (under?.opacity ?? 0.6) * spread)], [...kcol, stroke?.opacity ?? 1], [(stroke?.size ?? 0) * sc, mode, 0, under ? 1 : 0]))
    // the result replaces the layer's scratch
    const enc = E.device.createCommandEncoder()
    enc.copyTextureToTexture({ texture: out }, { texture: L }, [W, H])
    E.device.queue.submit([enc.finish()])
    E.C.giveBack(out)
    if (cover) E.C.giveBack(cover)
    if (dist) E.C.giveBack(dist)
  }

  return { init(e) { E = e; E.C.addModule('styles', WGSL) }, styles }
}
const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
