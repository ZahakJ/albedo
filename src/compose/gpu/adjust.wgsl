// Compose: adjustment layers.
//
// fs_unpremul turns the premultiplied accumulator into straight colour for the
// adjustment (the Develop shader and fs_adjust both read straight colour).
// fs_adjust runs the built-in adjustments; Develop adjustments run the
// Develop shader instead. fs_mix puts the adjusted colour back through the
// layer's blend mode, opacity, mask and Blend If, keeping the accumulator's
// alpha: an adjustment changes colour, never coverage.

struct AdjU {
  t: vec4f,       // type, channel mask (levels/curves), 32-bit linear, pad
  a: vec4f,       // type parameters (see adjust() below)
  b: vec4f,
  c: vec4f,
  d: vec4f,
  mtx0: vec4f,    // channel mixer rows (r, g, b) + constant in w
  mtx1: vec4f,
  mtx2: vec4f,
}

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var srcTex: texture_2d<f32>;
@group(0) @binding(2) var lutTex: texture_2d<f32>;   // 256×1: curves (r, g, b, master) or gradient map (rgba)
@group(0) @binding(3) var<uniform> A: AdjU;

struct VOut {
  @builtin(position) p: vec4f,
}

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VOut {
  let xy = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VOut;
  o.p = vec4f(xy * 2.0 - 1.0, 0.0, 1.0);
  return o;
}

@fragment
fn fs_unpremul(in: VOut) -> @location(0) vec4f {
  let c = textureLoad(srcTex, vec2i(in.p.xy), 0);
  return vec4f(select(vec3f(0.0), c.rgb / c.a, c.a > 1e-6), c.a);
}

const LW = vec3f(0.2126, 0.7152, 0.0722);

fn srgb_to_lin(c: vec3f) -> vec3f {
  return select(pow((c + 0.055) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045));
}
fn lin_to_srgb(c: vec3f) -> vec3f {
  let x = max(c, vec3f(0.0));
  return select(1.055 * pow(x, vec3f(1.0 / 2.4)) - 0.055, x * 12.92, x <= vec3f(0.0031308));
}

fn lut(v: f32, ch: i32) -> f32 {
  let t = textureSampleLevel(lutTex, samp, vec2f(clamp(v, 0.0, 1.0) * (255.0 / 256.0) + 0.5 / 256.0, 0.5), 0.0);
  if (ch == 0) { return t.r; }
  if (ch == 1) { return t.g; }
  if (ch == 2) { return t.b; }
  return t.a;
}

fn rgb_to_hsl(c: vec3f) -> vec3f {
  let mx = max(max(c.r, c.g), c.b);
  let mn = min(min(c.r, c.g), c.b);
  let l = (mx + mn) * 0.5;
  let d = mx - mn;
  if (d < 1e-6) { return vec3f(0.0, 0.0, l); }
  let s = d / (1.0 - abs(2.0 * l - 1.0) + 1e-6);
  var h = 0.0;
  if (mx == c.r) { h = (c.g - c.b) / d + select(0.0, 6.0, c.g < c.b); }
  else if (mx == c.g) { h = (c.b - c.r) / d + 2.0; }
  else { h = (c.r - c.g) / d + 4.0; }
  return vec3f(h / 6.0, s, l);
}

fn hsl_to_rgb(h: vec3f) -> vec3f {
  let k = (vec3f(0.0, 8.0, 4.0) + h.x * 12.0) % 12.0;
  let a = h.y * min(h.z, 1.0 - h.z);
  return h.z - a * max(vec3f(-1.0), min(min(k - 3.0, 9.0 - k), vec3f(1.0)));
}

// types: 1 levels, 2 curves, 3 hue/saturation, 4 invert, 5 threshold,
// 6 posterize, 7 gradient map, 8 channel mixer, 9 photo filter,
// 10 brightness/contrast, 11 exposure (32-bit friendly)
fn adjust(c0: vec3f) -> vec3f {
  let ty = i32(A.t.x);
  // in 32-bit documents the accumulator is linear: adjust in display encoding
  let lin = A.t.z > 0.5;
  var c = select(c0, lin_to_srgb(c0), lin && ty != 11);
  switch (ty) {
    case 1: {
      // a: in black, in white, gamma, out black; b.x: out white
      let x = clamp((c - A.a.x) / max(A.a.y - A.a.x, 1e-5), vec3f(0.0), vec3f(1.0));
      let g = pow(x, vec3f(1.0 / max(A.a.z, 0.01)));
      c = A.a.w + g * (A.b.x - A.a.w);
    }
    case 2: {
      c = vec3f(lut(lut(c.r, 3), 0), lut(lut(c.g, 3), 1), lut(lut(c.b, 3), 2));
    }
    case 3: {
      // a: hue shift (turns), saturation (-1..1), lightness (-1..1), colorize
      // b: colorize hue (turns), colorize saturation (0..1)
      var h = rgb_to_hsl(c);
      if (A.a.w > 0.5) {
        h = vec3f(A.b.x, A.b.y, h.z);
      } else {
        h.x = fract(h.x + A.a.x);
        h.y = clamp(h.y * (1.0 + A.a.y), 0.0, 1.0);
      }
      var o = hsl_to_rgb(h);
      if (A.a.z > 0.0) { o = mix(o, vec3f(1.0), A.a.z); } else { o = o * (1.0 + A.a.z); }
      c = o;
    }
    case 4: { c = 1.0 - c; }
    case 5: { c = vec3f(select(0.0, 1.0, dot(c, LW) >= A.a.x)); }
    case 6: {
      let n = max(A.a.x, 2.0) - 1.0;
      c = floor(c * n + 0.5) / n;
    }
    case 7: {
      let t = textureSampleLevel(lutTex, samp, vec2f(clamp(dot(c, LW), 0.0, 1.0) * (255.0 / 256.0) + 0.5 / 256.0, 0.5), 0.0);
      c = t.rgb;
    }
    case 8: {
      // a.x: monochrome
      let o = vec3f(dot(c, A.mtx0.xyz) + A.mtx0.w, dot(c, A.mtx1.xyz) + A.mtx1.w, dot(c, A.mtx2.xyz) + A.mtx2.w);
      c = select(o, vec3f(o.r), A.a.x > 0.5);
    }
    case 9: {
      // a: filter colour rgb, density; b.x: preserve luminosity
      let l0 = dot(c, LW);
      var o = mix(c, c * A.a.rgb * 2.0, A.a.w);
      if (A.b.x > 0.5) { o = o * (l0 / max(dot(o, LW), 1e-5)); }
      c = o;
    }
    case 10: {
      // a: brightness, contrast (-1..1); endpoints stay put, as in
      // Photoshop's non-legacy mode
      let o = clamp(c + 2.0 * A.a.x * c * (1.0 - c), vec3f(0.0), vec3f(1.0));
      let k = tan((A.a.y + 1.0) * 0.785398);
      c = clamp((o - 0.5) * k + 0.5, vec3f(0.0), vec3f(1.0));
    }
    case 11: {
      // a: exposure (stops), offset, gamma — in linear light, as Photoshop
      let l = select(srgb_to_lin(c), c, lin);
      let e = max(l * exp2(A.a.x) + A.a.y, vec3f(0.0));
      let g = pow(e, vec3f(1.0 / max(A.a.z, 0.01)));
      return select(lin_to_srgb(g), g, lin);
    }
    default: {}
  }
  return select(c, srgb_to_lin(c), lin);
}

@fragment
fn fs_adjust(in: VOut) -> @location(0) vec4f {
  let s = textureLoad(srcTex, vec2i(in.p.xy), 0);
  let o = adjust(s.rgb);
  // levels and curves may target one channel; the rest pass through
  let m = A.t.y;
  let keep = vec3f(select(1.0, 0.0, m == 0.0 || m == 1.0), select(1.0, 0.0, m == 0.0 || m == 2.0),
    select(1.0, 0.0, m == 0.0 || m == 3.0));
  return vec4f(mix(o, s.rgb, keep), s.a);
}

// 32-bit documents composite in linear light; the Develop shader returns
// display-encoded colour, which this brings back
@fragment
fn fs_tolinear(in: VOut) -> @location(0) vec4f {
  let s = textureLoad(srcTex, vec2i(in.p.xy), 0);
  return vec4f(srgb_to_lin(s.rgb), s.a);
}
