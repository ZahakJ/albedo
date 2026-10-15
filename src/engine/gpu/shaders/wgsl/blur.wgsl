// albedo separable Gaussian blur pass, WebGPU backend — math twin of
// glsl/blur.frag. One 1-D pass; run H then V for the 2-D Gaussian.
// radius 0 = single-tap resample (the 2× downsample steps feeding the
// quarter-res large blur; LINEAR filtering makes each tap a 2×2 box).
// The first pass of a chain samples the raw source: linearize decodes sRGB —
// every aux texture the develop pass consumes is scene-linear, matching its
// own decode. No flip here: WebGPU textures are always stored v=0 = top.

struct BParams {
  dir: vec2f,     // one input-texel step in uv units: (1/w,0) or (0,1/h)
  sigma: f32,     // in input texels; unused when radius == 0
  radius: f32,    // taps each side; capped at 64 by the loop bound
  linearize: f32, // 1 = input is sRGB-encoded, decode per tap
  _p0: f32, _p1: f32, _p2: f32,
}

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var img: texture_2d<f32>;
@group(0) @binding(2) var<uniform> P: BParams;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  // fullscreen triangle, uv convention identical to develop.wgsl
  var out: VOut;
  let x = f32(i32(vi & 1u) * 4 - 1);
  let y = f32(i32(vi >> 1u) * 4 - 1);
  out.pos = vec4f(x, y, 0.0, 1.0);
  out.uv = vec2f(x * 0.5 + 0.5, 0.5 - y * 0.5);
  return out;
}

fn srgb_to_linear(c: vec3f) -> vec3f {
  let lo = c / 12.92;
  let hi = pow((c + vec3f(0.055)) / 1.055, vec3f(2.4));
  return select(hi, lo, c <= vec3f(0.04045));
}

fn tap(p: vec2f) -> vec3f {
  // SampleLevel: taps inside the data-dependent loop need no derivatives
  let c = textureSampleLevel(img, samp, p, 0.0).rgb;
  return select(c, srgb_to_linear(c), P.linearize > 0.5);
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  let r = i32(P.radius);
  var acc = tap(in.uv);
  var sum = 1.0;
  let s2 = 2.0 * P.sigma * P.sigma;
  for (var i = 1; i <= 64; i++) {
    if (i > r) { break; }
    let w = exp(-f32(i * i) / s2);
    acc += w * (tap(in.uv + f32(i) * P.dir) + tap(in.uv - f32(i) * P.dir));
    sum += 2.0 * w;
  }
  return vec4f(acc / sum, 1.0);
}
