// Compose: draw one layer into a view-aligned target.
//
// The layer is a mesh in document pixels (one quad for an affine transform,
// a grid for perspective and warp), carrying the layer texture's uv. The
// target is either the accumulator (Normal layers, premultiplied "over" by
// fixed-function blending) or a cleared scratch texture that the blend pass
// then composites with the layer's mode.
//
// Every layer texture is premultiplied. Masks live in document space and are
// sampled at the fragment's document position; a liquify displacement lives
// in the layer's uv space at its own (reduced) resolution, in texels of the
// layer texture.

struct LayerU {
  view: vec4f,    // document → target px: scale x, scale y, offset x, offset y
  tgt: vec4f,  // target w, h, document w, h
  k: vec4f,       // opacity, hasMask, mask density, hasDisp
  k2: vec4f,      // fill kind (0 texture, 1 solid, 2 linear, 3 radial), mask invert, mask offset x, y (doc px)
  color: vec4f,   // solid fill colour (straight)
  grad: vec4f,    // gradient line in document px: x0, y0, x1, y1
  k3: vec4f,      // x: 1 = the texture is display-encoded and the document linear (32-bit): decode it
}

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var maskTex: texture_2d<f32>;
@group(0) @binding(3) var dispTex: texture_2d<f32>;
@group(0) @binding(4) var<uniform> U: LayerU;

struct VIn {
  @location(0) pos: vec2f,
  @location(1) uv: vec2f,
}
struct VOut {
  @builtin(position) p: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs(v: VIn) -> VOut {
  let t = v.pos * U.view.xy + U.view.zw;
  let ndc = vec2f(t.x / U.tgt.x * 2.0 - 1.0, 1.0 - t.y / U.tgt.y * 2.0);
  var o: VOut;
  o.p = vec4f(ndc, 0.0, 1.0);
  o.uv = v.uv;
  return o;
}

fn srgb_lin(c: vec3f) -> vec3f {
  return select(pow((max(c, vec3f(0.0)) + 0.055) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045));
}

fn mask_at(fragPx: vec2f) -> f32 {
  let doc = (fragPx - U.view.zw) / U.view.xy - U.k2.zw;
  let m = textureSampleLevel(maskTex, samp, doc / U.tgt.zw,
    max(0.0, -log2(max(U.view.x, 1e-6)))).r;
  let mi = select(m, 1.0 - m, U.k2.y > 0.5);
  return mix(1.0, mi, U.k.z);
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  var uv = in.uv;
  let d = textureSampleLevel(dispTex, samp, in.uv, 0.0).xy / vec2f(textureDimensions(tex));
  uv = uv + select(vec2f(0.0), d, U.k.w > 0.5);
  var c = textureSample(tex, samp, uv);
  let inside = all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0));
  c = select(vec4f(0.0), c, inside);
  if (U.k3.x > 0.5 && c.a > 1e-6) { c = vec4f(srgb_lin(c.rgb / c.a) * c.a, c.a); }
  var k = U.k.x;
  if (U.k.y > 0.5) { k = k * mask_at(in.p.xy); }
  return c * k;
}

// Fill layers: solid colour or a gradient through a 256×1 ramp (straight
// colour + alpha), evaluated in document space.
@fragment
fn fs_fill(in: VOut) -> @location(0) vec4f {
  // every entry point binds the same set: keep the displacement binding live
  let keep = textureSampleLevel(dispTex, samp, vec2f(0.5), 0.0).w * 0.0;
  let doc = (in.p.xy - U.view.zw) / U.view.xy + keep;
  var c = U.color;
  if (U.k2.x > 1.5) {
    let a = U.grad.xy;
    let b = U.grad.zw;
    var t = 0.0;
    if (U.k2.x < 2.5) {
      let ab = b - a;
      t = dot(doc - a, ab) / max(dot(ab, ab), 1e-6);
    } else {
      t = length(doc - a) / max(length(b - a), 1e-6);
    }
    c = textureSampleLevel(tex, samp, vec2f(clamp(t, 0.0, 1.0), 0.5), 0.0);
  }
  if (U.k3.x > 0.5) { c = vec4f(srgb_lin(c.rgb), c.a); }
  var k = U.k.x;
  if (U.k.y > 0.5) { k = k * mask_at(in.p.xy); }
  return vec4f(c.rgb * c.a, c.a) * k;
}
