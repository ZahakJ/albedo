// Compose: selection and mask passes. Masks and selections are single-
// channel document-sized textures (r8unorm in 8-bit documents, r16float
// otherwise); these passes run full-screen over them.

struct SelU {
  a: vec4f,   // per pass (see each entry)
  b: vec4f,
  c: vec4f,
  d: vec4f,
  cols: array<vec4f, 8>, // colour range samples (Lab), w = in use
}

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var srcA: texture_2d<f32>;
@group(0) @binding(2) var srcB: texture_2d<f32>;
@group(0) @binding(3) var<uniform> S: SelU;

struct VOut { @builtin(position) p: vec4f }

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VOut {
  let xy = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VOut;
  o.p = vec4f(xy * 2.0 - 1.0, 0.0, 1.0);
  return o;
}

// combine a new shape (srcB.r) with the current selection (srcA.r)
// a.x: mode 0 new, 1 add, 2 subtract, 3 intersect
@fragment
fn fs_combine(in: VOut) -> @location(0) vec4f {
  let p = vec2i(in.p.xy);
  let o = textureLoad(srcA, p, 0).r;
  let n = textureLoad(srcB, p, 0).r;
  var v = n;
  let m = i32(S.a.x);
  if (m == 1) { v = max(o, n); }
  else if (m == 2) { v = o * (1.0 - n); }
  else if (m == 3) { v = min(o, n); }
  return vec4f(v);
}

// a.x: 1 = invert
@fragment
fn fs_invert(in: VOut) -> @location(0) vec4f {
  return vec4f(1.0 - textureLoad(srcA, vec2i(in.p.xy), 0).r);
}

// separable gaussian on r: a.xy = direction (px), a.z = sigma, a.w = radius
@fragment
fn fs_blur(in: VOut) -> @location(0) vec4f {
  let p = vec2i(in.p.xy);
  let dim = vec2i(textureDimensions(srcA));
  let dir = vec2i(S.a.xy);
  let sig = max(S.a.z, 0.3);
  let r = i32(S.a.w);
  var acc = 0.0;
  var wsum = 0.0;
  for (var i = -r; i <= r; i++) {
    let q = clamp(p + dir * i, vec2i(0), dim - 1);
    let w = exp(-f32(i * i) / (2.0 * sig * sig));
    acc += w * textureLoad(srcA, q, 0).r;
    wsum += w;
  }
  return vec4f(acc / wsum);
}

// smoothstep contrast around a.x (0..1 threshold), a.y softness; a.z shift
@fragment
fn fs_contrast(in: VOut) -> @location(0) vec4f {
  let v = textureLoad(srcA, vec2i(in.p.xy), 0).r;
  let t = clamp(S.a.x + S.a.z, 0.0, 1.0);
  let s = max(S.a.y, 1e-3);
  return vec4f(smoothstep(t - s, t + s, v));
}

// ── colour range ───────────────────────────────────────────────────────────
fn srgb_lin(c: vec3f) -> vec3f {
  return select(pow((c + 0.055) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045));
}
fn to_lab(c: vec3f) -> vec3f {
  let l = srgb_lin(clamp(c, vec3f(0.0), vec3f(1.0)));
  let x = dot(l, vec3f(0.4124, 0.3576, 0.1805)) / 0.95047;
  let y = dot(l, vec3f(0.2126, 0.7152, 0.0722));
  let z = dot(l, vec3f(0.0193, 0.1192, 0.9505)) / 1.08883;
  let f = select(vec3f(x, y, z) * 7.787 + 16.0 / 116.0, pow(vec3f(x, y, z), vec3f(1.0 / 3.0)), vec3f(x, y, z) > vec3f(0.008856));
  return vec3f(116.0 * f.y - 16.0, 500.0 * (f.x - f.y), 200.0 * (f.y - f.z));
}

// srcA = composite (premultiplied); a.x = fuzziness (ΔE), a.y = count,
// a.z = 1 when the doc is linear (32-bit), a.w = invert
@fragment
fn fs_colorrange(in: VOut) -> @location(0) vec4f {
  let c = textureLoad(srcA, vec2i(in.p.xy), 0);
  var rgb = select(vec3f(0.0), c.rgb / c.a, c.a > 1e-6);
  if (S.a.z > 0.5) {
    rgb = select(1.055 * pow(max(rgb, vec3f(0.0)), vec3f(1.0 / 2.4)) - 0.055, rgb * 12.92, rgb <= vec3f(0.0031308));
  }
  let lab = to_lab(rgb);
  var best = 0.0;
  for (var i = 0; i < 8; i++) {
    if (f32(i) >= S.a.y) { break; }
    let d = distance(lab, S.cols[i].xyz);
    best = max(best, 1.0 - smoothstep(S.a.x * 0.5, S.a.x, d));
  }
  best = best * c.a;
  return vec4f(select(best, 1.0 - best, S.a.w > 0.5));
}

// ── jump flood distance (expand / contract / stroke) ──────────────────────
// seeds: texels where the mask crosses the threshold store their own coord
// a.x: threshold, a.y: 1 = seed the outside (distance from the inside)
@fragment
fn fs_jfa_seed(in: VOut) -> @location(0) vec4f {
  let p = vec2i(in.p.xy);
  let v = textureLoad(srcA, p, 0).r;
  let inside = select((v >= S.a.x), (v < S.a.x), (S.a.y > 0.5));
  return select(vec4f(-1e6, -1e6, 0.0, 0.0), vec4f(vec2f(p), 0.0, 1.0), inside);
}
// a.x: step (px)
@fragment
fn fs_jfa_step(in: VOut) -> @location(0) vec4f {
  let p = vec2i(in.p.xy);
  let dim = vec2i(textureDimensions(srcA));
  let k = i32(S.a.x);
  var best = textureLoad(srcA, p, 0);
  var bd = select(1e12, distance(vec2f(p), best.xy), best.w > 0.5);
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let q = p + vec2i(i, j) * k;
      if (any(q < vec2i(0)) || any(q >= dim)) { continue; }
      let s = textureLoad(srcA, q, 0);
      if (s.w < 0.5) { continue; }
      let d = distance(vec2f(p), s.xy);
      if (d < bd) { bd = d; best = s; }
    }
  }
  return best;
}
// srcA = flooded seeds; a.x: radius (px), a.y: 1 = expand (distance outside
// the selection), 0 = contract; srcB = the original mask
@fragment
fn fs_jfa_apply(in: VOut) -> @location(0) vec4f {
  let p = vec2i(in.p.xy);
  let s = textureLoad(srcA, p, 0);
  let m = textureLoad(srcB, p, 0).r;
  let d = select(1e9, distance(vec2f(p), s.xy), s.w > 0.5);
  if (S.a.y > 0.5) {
    // outside pixels within radius of the selection join it
    return vec4f(max(m, clamp(S.a.x - d + 0.5, 0.0, 1.0)));
  }
  // inside pixels within radius of the outside leave it
  return vec4f(min(m, clamp(d - S.a.x + 0.5, 0.0, 1.0)));
}

// ── guided filter (refine edge) ────────────────────────────────────────────
// fast guided filter, grey guide: at a reduced scale, mean of I, p, I·p,
// I² → a, b → upsampled → q = a·I + b at full resolution, kept inside the
// edge band where the coarse mask is uncertain.
fn luma(c: vec4f) -> f32 {
  let rgb = select(vec3f(0.0), c.rgb / c.a, c.a > 1e-6);
  return dot(rgb, vec3f(0.2126, 0.7152, 0.0722));
}
// srcA = image (any size; sampled), srcB = mask; target = reduced size
@fragment
fn fs_gf_prep(in: VOut) -> @location(0) vec4f {
  let dim = vec2f(textureDimensions(srcB));
  let uv = in.p.xy / S.a.xy; // a.xy = target size
  let I = luma(textureSampleLevel(srcA, samp, uv, S.a.z));
  let p = textureSampleLevel(srcB, samp, uv, S.a.w).r;
  return vec4f(I, p, I * p, I * I);
}
// box filter, separable, on all four channels: a.xy direction, a.z radius
@fragment
fn fs_box4(in: VOut) -> @location(0) vec4f {
  let p = vec2i(in.p.xy);
  let dim = vec2i(textureDimensions(srcA));
  let dir = vec2i(S.a.xy);
  let r = i32(S.a.z);
  var acc = vec4f(0.0);
  for (var i = -r; i <= r; i++) {
    acc += textureLoad(srcA, clamp(p + dir * i, vec2i(0), dim - 1), 0);
  }
  return acc / f32(2 * r + 1);
}
// means → (a, b, 0, 0): a.x = eps
@fragment
fn fs_gf_ab(in: VOut) -> @location(0) vec4f {
  let m = textureLoad(srcA, vec2i(in.p.xy), 0);
  let varI = m.w - m.x * m.x;
  let cov = m.z - m.x * m.y;
  let a = cov / (varI + S.a.x);
  return vec4f(a, m.y - a * m.x, 0.0, 0.0);
}
// full resolution: srcA = image, srcB = mean (a, b) at reduced size; c = the
// coarse mask (sampled through binding 2's sibling below) — the band test
// uses b.x = band low, b.y = band high on the blurred coarse mask
@group(0) @binding(4) var coarse: texture_2d<f32>;
@fragment
fn fs_gf_apply(in: VOut) -> @location(0) vec4f {
  let p = vec2i(in.p.xy);
  let dim = vec2f(textureDimensions(coarse));
  let uv = (in.p.xy) / dim;
  let I = luma(textureLoad(srcA, p, 0));
  let ab = textureSampleLevel(srcB, samp, uv, 0.0).xy;
  let q = clamp(ab.x * I + ab.y, 0.0, 1.0);
  let m = textureLoad(coarse, p, 0).r;
  // inside the uncertain band take the filter's answer; elsewhere keep a
  // crisp version of the coarse mask (S.b.z = contrast for the crisp part)
  let band = smoothstep(S.b.x, S.b.x + 0.04, m) * (1.0 - smoothstep(S.b.y - 0.04, S.b.y, m));
  let crisp = smoothstep(0.5 - S.b.z, 0.5 + S.b.z, m);
  return vec4f(mix(crisp, q, band));
}

// a mask painted with a constant value through coverage (fill / clear on
// masks): out = mix(dst, a.x, srcB.r · a.y) — srcA = dst, srcB = coverage
fn cover_at(p: vec2i) -> f32 {
  // coverage is document-sized; the target may sit at an offset (c.xy)
  let q = p + vec2i(S.c.xy);
  let dim = vec2i(textureDimensions(srcB));
  if (any(q < vec2i(0)) || any(q >= dim)) { return 0.0; }
  return textureLoad(srcB, q, 0).r;
}
@fragment
fn fs_paint_value(in: VOut) -> @location(0) vec4f {
  let p = vec2i(in.p.xy);
  let d = textureLoad(srcA, p, 0).r;
  let k = cover_at(p) * S.a.y;
  return vec4f(mix(d, S.a.x, k));
}

// a premultiplied pixel layer filled through coverage: srcA = layer, srcB =
// coverage; a = colour (straight), b.x = opacity, b.y = 1 erase
@fragment
fn fs_fill_rgba(in: VOut) -> @location(0) vec4f {
  let p = vec2i(in.p.xy);
  let d = textureLoad(srcA, p, 0);
  let k = cover_at(p) * S.b.x;
  if (S.b.y > 0.5) { return d * (1.0 - k); }
  let s = vec4f(S.a.rgb * S.a.a, S.a.a) * k;
  return s + d * (1.0 - s.a);
}

// a document-space single-channel texture resampled into a region:
// a.xy = region origin (doc px), a.z = scale (region px per doc px)
@fragment
fn fs_region(in: VOut) -> @location(0) vec4f {
  let dim = vec2f(textureDimensions(srcA));
  let doc = S.a.xy + in.p.xy / S.a.z;
  let lod = max(0.0, -log2(S.a.z));
  return vec4f(textureSampleLevel(srcA, samp, doc / dim, lod).r);
}
