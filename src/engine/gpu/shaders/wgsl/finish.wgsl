// albedo finish pass, WebGPU backend — math twin of glsl/finish.frag.
// Output-referred unsharp sharpen + film grain + clip overlay + mask-overlay
// wash + split-view divider. Input is the develop pass's display-referred
// sRGB output (rendered to an intermediate rgba8 instead of the canvas); runs
// when sharpening, grain, the sharpen-mask preview, the mask wash or split
// view is active. Blurred-luma tap is an inline Gaussian, radius ≤ 4 px (σ is
// already display-scaled by the worker).
//
// Uniforms — ONE Float32Array(48), identical in both backends
// (WGSL: 12 × vec4f; GLSL: uniform vec4 F[12]).
//   [0] amount (0..150)  [1] sigma (display px)  [2] maskT  [3] maskPreview
//   [4] clipOverlay      [5] washOn  [6] srcW  [7] srcH
//   [8] angle rad        [9..12] crop x/y/w/h  [13] fitScale
//   [14] persp v (raw)   [15] persp h (raw) — develop's keystone twin
//   [16..39] selected mask record — SAME 24-float layout as develop's masksU
//        (the range slots [32..39] are carried but unused here: the wash
//        shows the geometric weight — finish has no source pixels)
//   [40] grain amount 0..100  [41] grain cell size (source px, resScale
//        already honored by the worker)  [42] grain roughness 0..1
//   [43] lens distortion (raw) — develop's radial remap twin
//   [44] split mode 0=off 1=h 2=v  [45] split position 0..1  [46..47] pad
// Wash: 40% #e84d4d × the mask's weight, composited after sharpen + clip.
// The geometry slots [6..15]+[43] replicate develop's inverse map (affine +
// keystone + distortion) and are filled whenever the wash OR grain is active
// — both evaluate at the develop pass's PRE-mirror source coordinate (masks
// and grain ignore flipH), which is what glues grain to image content
// through crop/rotate/loupe. Split view: the worker renders the BEFORE doc
// on one side of the intermediate and the current doc on the other; this
// pass only paints the 1px neutral divider at [45].

struct FParams {
  a: vec4f, // amount, sigma, maskT, maskPreview
  b: vec4f, // clipOverlay, washOn, srcW, srcH
  c: vec4f, // angle, cropX, cropY, cropW
  d: vec4f, // cropH, fitScale, persp v, persp h
  m0: vec4f, // kind, invert, enabled, g0
  m1: vec4f, // g1, g2, g3, g4
  m2: vec4f, // g5, ev, temp, contrast
  m3: vec4f, // highlights, shadows, saturation, clarity
  m4: vec4f, // range: lumaOn, lumaLo, lumaHi, lumaSoftness (unused here)
  m5: vec4f, // range: colorOn, hue, chroma, tolerance (unused here)
  g: vec4f,  // grain amount, grain cell (source px), grain roughness, distortion
  s: vec4f,  // split mode, split position, pad, pad
}

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var img: texture_2d<f32>;
@group(0) @binding(2) var<uniform> F: FParams;
@group(0) @binding(3) var brushTex: texture_2d<f32>; // quarter-res rgba8, dummy when unused

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

// portable integer hash (pcg-ish u32 mix) — bit-identical in WGSL/GLSL, no
// fract-sin (its precision differs across drivers). Input: integer lattice
// coords as floats (post-floor); negatives wrap through two's complement.
fn hash21(p: vec2f) -> f32 {
  var h = u32(i32(p.x)) * 1597334677u + u32(i32(p.y)) * 3812015801u;
  h = (h ^ (h >> 16u)) * 2246822519u;
  h = (h ^ (h >> 13u)) * 3266489917u;
  h = h ^ (h >> 16u);
  return f32(h >> 8u) * (1.0 / 16777216.0);
}

fn vnoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = hash21(i);
  let b = hash21(i + vec2f(1.0, 0.0));
  let c = hash21(i + vec2f(0.0, 1.0));
  let d = hash21(i + vec2f(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// selected-mask weight — math twin of develop's mask_weight over F.m0..m3
// (geometric part only; range refinement needs the source and stays in
// develop — the wash approximates)
fn wash_weight(p: vec2f, dim: vec2f) -> f32 {
  var m = 0.0;
  if (F.m0.x < 0.5) {
    let a = vec2f(F.m0.w, F.m1.x);
    let b = vec2f(F.m1.y, F.m1.z);
    let d = (b - a) * dim;
    let q = (p - a) * dim;
    m = smoothstep(0.0, 1.0, dot(q, d) / max(dot(d, d), 1e-8));
  } else if (F.m0.x < 1.5) {
    let c = vec2f(F.m0.w, F.m1.x);
    let rr = max(vec2f(F.m1.y, F.m1.z), vec2f(1e-4)) * dim.x;
    let e = (p - c) * dim;
    let ca = cos(F.m1.w);
    let sa = sin(F.m1.w);
    let u = vec2f(ca * e.x + sa * e.y, -sa * e.x + ca * e.y);
    let f = clamp(F.m2.x, 0.005, 1.0);
    m = 1.0 - smoothstep(1.0 - f, 1.0, length(u / rr));
  } else {
    let bt = textureSampleLevel(brushTex, samp, p, 0.0);
    let ch = F.m0.w;
    m = select(select(select(bt.a, bt.b, ch < 2.5), bt.g, ch < 1.5), bt.r, ch < 0.5);
  }
  return select(m, 1.0 - m, F.m0.y > 0.5);
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  let texel = 1.0 / vec2f(textureDimensions(img));
  let c = textureSampleLevel(img, samp, in.uv, 0.0).rgb;
  let L = dot(c, LW);
  let r = i32(clamp(ceil(2.5 * F.a.y), 1.0, 4.0));
  let s2 = 2.0 * F.a.y * F.a.y;
  var acc = 0.0;
  var sum = 0.0;
  for (var y = -4; y <= 4; y++) {
    for (var x = -4; x <= 4; x++) {
      if (abs(x) > r || abs(y) > r) { continue; }
      let w = exp(-f32(x * x + y * y) / s2);
      acc += w * dot(textureSampleLevel(img, samp, in.uv + vec2f(f32(x), f32(y)) * texel, 0.0).rgb, LW);
      sum += w;
    }
  }
  let d = L - acc / sum;
  // masking: edge-gated weight; maskT=0 → 1 (smoothstep(0,0,·) is undefined)
  var wM = 1.0;
  if (F.a.z > 0.0) { wM = smoothstep(F.a.z, F.a.z * 3.0, abs(d)); }
  if (F.a.w > 0.5) { return vec4f(vec3f(wM), 1.0); } // Alt-drag mask preview
  let Ls = L + (F.a.x / 100.0) * 1.5 * d * wM;
  // hue-preserving: scale RGB by the luma ratio, guarded near black
  var o = clamp(c * (max(Ls, 0.0) / max(L, 1e-4)), vec3f(0.0), vec3f(1.0));
  // shared inverse geometry map (in.uv is already y-down) — grain + wash;
  // the keystone + distortion warps mirror develop so both stay glued
  var muv = vec2f(0.0);
  let dim = vec2f(F.b.z, F.b.w);
  if (F.b.y > 0.5 || F.g.x > 0.0) {
    let cxy = vec2f(F.c.y, F.c.z);
    let cwh = vec2f(F.c.w, F.d.x);
    let cc2 = cxy + 0.5 * cwh;
    let dpx = (cxy + in.uv * cwh - cc2) * dim;
    let ca = cos(F.c.x);
    let sa = sin(F.c.x);
    muv = cc2 + vec2f(ca * dpx.x - sa * dpx.y, sa * dpx.x + ca * dpx.y) / (F.d.y * dim);
    if (F.d.z != 0.0 || F.d.w != 0.0) {
      let n = muv - 0.5;
      let pw = max(1.0 + 2.0 * ((F.d.w / 100.0) * 0.3 * n.x + (F.d.z / 100.0) * 0.3 * n.y), 0.2);
      muv = 0.5 + n / pw;
    }
    if (F.g.w != 0.0) {
      let dd = (muv - 0.5) * dim;
      let r2d = dot(dd, dd) / (0.25 * dot(dim, dim));
      muv = 0.5 + (muv - 0.5) * (1.0 + (F.g.w / 100.0) * r2d * 0.15);
    }
  }
  // film grain — value noise on the SOURCE pixel lattice (cell = F.g.y px),
  // two octaves mixed by roughness, midtone-weighted (fades in blacks and
  // whites), amount 0..100 → ±0.06 max deviation. Deterministic.
  if (F.g.x > 0.0) {
    let sp = muv * dim / max(F.g.y, 1e-3);
    let n1 = vnoise(sp);
    let n2 = vnoise(sp * 2.0 + vec2f(37.0, 17.0));
    let n = mix(n1, 0.5 * (n1 + n2), F.g.z);
    let Lg = dot(o, LW);
    let wG = smoothstep(0.0, 0.2, Lg) * (1.0 - smoothstep(0.75, 1.0, Lg));
    o = clamp(o + vec3f((F.g.x / 100.0) * 0.06 * (2.0 * n - 1.0) * wG), vec3f(0.0), vec3f(1.0));
  }
  // clip overlay: paint blown/crushed pixels (colors match develop.wgsl)
  if (F.b.x > 0.5) {
    if (max(max(o.r, o.g), o.b) >= 254.0 / 255.0) {
      o = vec3f(255.0, 59.0, 48.0) / 255.0;   // #ff3b30
    } else if (min(min(o.r, o.g), o.b) <= 1.0 / 255.0) {
      o = vec3f(47.0, 111.0, 237.0) / 255.0;  // #2f6fed
    }
  }
  // mask wash — evaluated at the same pre-mirror source coordinate
  if (F.b.y > 0.5) {
    o = mix(o, vec3f(232.0, 77.0, 77.0) / 255.0, 0.4 * wash_weight(muv, dim)); // #e84d4d
  }
  // split-view divider — 1px neutral line at the split position (the two
  // halves were composited by the develop draws; in.uv is y-down already)
  if (F.s.x > 0.5) {
    let t = select(in.uv.y, in.uv.x, F.s.x < 1.5);
    let px = select(texel.y, texel.x, F.s.x < 1.5);
    if (abs(t - F.s.y) < 0.6 * px) { o = vec3f(0.5); }
  }
  return vec4f(o, 1.0);
}
