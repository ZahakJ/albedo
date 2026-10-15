// albedo à-trous wavelet denoise pass, WebGPU backend — math twin of
// glsl/nr.frag. One 1-D 5-tap B3-spline pass ([1 4 6 4 1]/16) at hole
// spacing; run H (combine=0: plain blur into tmp) then V (combine=1: finish
// the 2-D blur of tmp AND soft-threshold detail = orig − blur, split into
// luma + chroma residual, output the denoised level). Inputs are already
// scene-linear unflipped rgba16f — the chain is seeded by a radius-0 blur
// pass that decodes the source (see computeNR).

struct NParams {
  dir: vec2f,   // hole·(1/w, 0) or hole·(0, 1/h)
  tl: f32,      // luma soft-threshold, linear units (0 = luma passthrough)
  tc: f32,      // chroma soft-threshold, linear units
  combine: f32, // 1 = V pass: threshold + reconstruct
  _p0: f32, _p1: f32, _p2: f32,
}

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var img: texture_2d<f32>;  // blur input (a for H, tmp for V)
@group(0) @binding(2) var orig: texture_2d<f32>; // level a — detail reference (V only)
@group(0) @binding(3) var<uniform> P: NParams;

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

const LW = vec3f(0.2126, 0.7152, 0.0722);

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  let b = 0.375 * textureSampleLevel(img, samp, in.uv, 0.0).rgb
    + 0.25 * (textureSampleLevel(img, samp, in.uv + P.dir, 0.0).rgb
            + textureSampleLevel(img, samp, in.uv - P.dir, 0.0).rgb)
    + 0.0625 * (textureSampleLevel(img, samp, in.uv + 2.0 * P.dir, 0.0).rgb
              + textureSampleLevel(img, samp, in.uv - 2.0 * P.dir, 0.0).rgb);
  if (P.combine < 0.5) { return vec4f(b, 1.0); }
  let d = textureSampleLevel(orig, samp, in.uv, 0.0).rgb - b;
  let dY = dot(d, LW);
  let dC = d - vec3f(dY); // chroma residual — luma-free (dot(LW, 1) = 1)
  let dYt = sign(dY) * max(abs(dY) - P.tl, 0.0);
  let dCt = sign(dC) * max(abs(dC) - vec3f(P.tc), vec3f(0.0));
  return vec4f(b + dCt + vec3f(dYt), 1.0);
}
