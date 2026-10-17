// Compose: composite a premultiplied source (a drawn layer, a group or a
// clipping group) onto a destination with one of Photoshop's 27 blend modes.
//
// dst is a copy of the destination's region (same pixel coordinates), src a
// view-aligned scratch texture. Separable modes follow the W3C compositing
// formulas, except soft light, which uses Photoshop's curve; the
// non-separable ones (hue, saturation, colour, luminosity) use the W3C
// SetLum/SetSat construction, which is what Photoshop documents. Darker and
// lighter colour pick the whole pixel with the lower or higher luminance.
//
// Blend If: this layer's and the underlying pixels' grey (or one channel)
// fade the source between the split sliders, as in Photoshop's Blending
// Options. atop keeps the destination's alpha (clipped layers).

struct BlendU {
  m: vec4f,         // mode, opacity, atop, hasMask
  view: vec4f,      // document → target px: scale x, scale y, offset x, offset y
  tgt: vec4f,    // target w, h, document w, h
  bifThis: vec4f,   // black lo, black hi, white lo, white hi (0..1)
  bifUnder: vec4f,
  bif: vec4f,       // on, channel (0 grey, 1 r, 2 g, 3 b), mask density, mask invert
  seed: vec4f,      // dissolve seed, mask offset x, y (doc px), pad
}

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var dstTex: texture_2d<f32>;
@group(0) @binding(2) var srcTex: texture_2d<f32>;
@group(0) @binding(3) var maskTex: texture_2d<f32>;
@group(0) @binding(4) var<uniform> B: BlendU;

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

const LUMA = vec3f(0.3, 0.59, 0.11);

fn lum(c: vec3f) -> f32 { return dot(c, LUMA); }

fn clip_color(c: vec3f) -> vec3f {
  let l = lum(c);
  let n = min(min(c.r, c.g), c.b);
  let x = max(max(c.r, c.g), c.b);
  var o = c;
  if (n < 0.0) { o = l + (o - l) * l / max(l - n, 1e-6); }
  if (x > 1.0) { o = l + (o - l) * (1.0 - l) / max(x - l, 1e-6); }
  return o;
}

fn set_lum(c: vec3f, l: f32) -> vec3f { return clip_color(c + (l - lum(c))); }

fn sat(c: vec3f) -> f32 { return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b); }

fn set_sat(c: vec3f, s: f32) -> vec3f {
  let mx = max(max(c.r, c.g), c.b);
  let mn = min(min(c.r, c.g), c.b);
  let r = mx - mn;
  if (r <= 1e-6) { return vec3f(0.0); }
  return (c - mn) * s / r;
}

fn soft_light_ps(b: f32, s: f32) -> f32 {
  if (s <= 0.5) { return 2.0 * b * s + b * b * (1.0 - 2.0 * s); }
  return 2.0 * b * (1.0 - s) + sqrt(max(b, 0.0)) * (2.0 * s - 1.0);
}

fn dodge(b: f32, s: f32) -> f32 {
  if (b <= 0.0) { return 0.0; }
  if (s >= 1.0) { return 1.0; }
  return min(1.0, b / (1.0 - s));
}

fn burn(b: f32, s: f32) -> f32 {
  if (b >= 1.0) { return 1.0; }
  if (s <= 0.0) { return 0.0; }
  return 1.0 - min(1.0, (1.0 - b) / s);
}

fn vivid(b: f32, s: f32) -> f32 {
  if (s <= 0.5) { return burn(b, 2.0 * s); }
  return dodge(b, 2.0 * s - 1.0);
}

fn pin(b: f32, s: f32) -> f32 {
  if (s <= 0.5) { return min(b, 2.0 * s); }
  return max(b, 2.0 * s - 1.0);
}

fn hard_light(b: f32, s: f32) -> f32 {
  if (s <= 0.5) { return b * 2.0 * s; }
  let s2 = 2.0 * s - 1.0;
  return b + s2 - b * s2;
}

fn sep(mode: i32, b: f32, s: f32) -> f32 {
  switch (mode) {
    case 2: { return min(b, s); }                       // darken
    case 3: { return b * s; }                           // multiply
    case 4: { return burn(b, s); }                      // colour burn
    case 5: { return max(0.0, b + s - 1.0); }           // linear burn
    case 7: { return max(b, s); }                       // lighten
    case 8: { return b + s - b * s; }                   // screen
    case 9: { return dodge(b, s); }                     // colour dodge
    case 10: { return min(1.0, b + s); }                // linear dodge (add)
    case 12: { return hard_light(s, b); }               // overlay
    case 13: { return soft_light_ps(b, s); }            // soft light
    case 14: { return hard_light(b, s); }               // hard light
    case 15: { return vivid(b, s); }                    // vivid light
    case 16: { return clamp(b + 2.0 * s - 1.0, 0.0, 1.0); } // linear light
    case 17: { return pin(b, s); }                      // pin light
    case 18: { return select(0.0, 1.0, vivid(b, s) >= 0.5); } // hard mix
    case 19: { return abs(b - s); }                     // difference
    case 20: { return b + s - 2.0 * b * s; }            // exclusion
    case 21: { return max(0.0, b - s); }                // subtract
    case 22: { return select(min(1.0, b / s), 1.0, s <= 0.0); } // divide
    default: { return s; }                              // normal, dissolve
  }
}

// Modes 0..26 in Photoshop's menu order (model.js BLEND_MODES)
fn blend_rgb(mode: i32, b: vec3f, s: vec3f) -> vec3f {
  switch (mode) {
    case 6: { return select(s, b, lum(b) < lum(s)); }   // darker colour
    case 11: { return select(s, b, lum(b) > lum(s)); }  // lighter colour
    case 23: { return set_lum(set_sat(s, sat(b)), lum(b)); } // hue
    case 24: { return set_lum(set_sat(b, sat(s)), lum(b)); } // saturation
    case 25: { return set_lum(s, lum(b)); }             // colour
    case 26: { return set_lum(b, lum(s)); }             // luminosity
    default: {
      return vec3f(sep(mode, b.r, s.r), sep(mode, b.g, s.g), sep(mode, b.b, s.b));
    }
  }
}

fn ramp(v: f32, r: vec4f) -> f32 {
  // 1 inside [black hi, white lo], fading to 0 at black lo / white hi
  let lo = select(smoothstep(r.x, r.y, v), select(0.0, 1.0, v >= r.x), r.y <= r.x);
  let hi = select(1.0 - smoothstep(r.z, r.w, v), select(0.0, 1.0, v <= r.w), r.w <= r.z);
  return lo * hi;
}

fn bif_value(c: vec3f, ch: f32) -> f32 {
  if (ch < 0.5) { return lum(c); }
  if (ch < 1.5) { return c.r; }
  if (ch < 2.5) { return c.g; }
  return c.b;
}

fn hash(p: vec2f) -> f32 {
  let q = fract(p * vec2f(0.1031, 0.1030));
  let r = q + dot(q, q.yx + 33.33);
  return fract((r.x + r.y) * r.x);
}

fn mask_at(fragPx: vec2f) -> f32 {
  let doc = (fragPx - B.view.zw) / B.view.xy - B.seed.yz;
  let m = textureSampleLevel(maskTex, samp, doc / B.tgt.zw,
    max(0.0, -log2(max(B.view.x, 1e-6)))).r;
  let mi = select(m, 1.0 - m, B.bif.w > 0.5);
  return mix(1.0, mi, B.bif.z);
}

// shared by the layer blend and the adjustment mix
fn composite(mode: i32, d: vec4f, s: vec4f, k: f32, atop: bool, px: vec2f) -> vec4f {
  var sa = s.a * k;
  let da = d.a;
  let cs = select(vec3f(0.0), s.rgb / s.a, s.a > 1e-6);
  let cb = select(vec3f(0.0), d.rgb / da, da > 1e-6);
  if (mode == 1) { sa = select(0.0, 1.0, hash(px + B.seed.x) < sa); } // dissolve
  let bl = blend_rgb(mode, cb, cs);
  let csp = (1.0 - da) * cs + da * bl;
  if (atop) {
    return vec4f(sa * da * csp + d.rgb * (1.0 - sa), da);
  }
  return vec4f(sa * csp + d.rgb * (1.0 - sa), sa + da * (1.0 - sa));
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  let px = vec2i(in.p.xy);
  let d = textureLoad(dstTex, px, 0);
  let s = textureLoad(srcTex, px, 0);
  var k = B.m.y;
  if (B.m.w > 0.5) { k = k * mask_at(in.p.xy); }
  if (B.bif.x > 0.5) {
    let cs = select(vec3f(0.0), s.rgb / s.a, s.a > 1e-6);
    let cb = select(vec3f(0.0), d.rgb / d.a, d.a > 1e-6);
    k = k * ramp(bif_value(cs, B.bif.y), B.bifThis) * ramp(bif_value(cb, B.bif.y), B.bifUnder);
  }
  return composite(i32(B.m.x), d, s, k, B.m.z > 0.5, in.p.xy);
}

// Pass-through groups with an opacity or a mask: the children drew onto the
// destination directly; this fades the result back towards the backdrop.
@fragment
fn fs_fade(in: VOut) -> @location(0) vec4f {
  let px = vec2i(in.p.xy);
  let before = textureLoad(dstTex, px, 0);
  let after = textureLoad(srcTex, px, 0);
  var k = B.m.y;
  if (B.m.w > 0.5) { k = k * mask_at(in.p.xy); }
  return mix(before, after, k);
}

// Adjustment layers: dst holds the straight colour below, src the adjusted
// straight colour. The result keeps the destination's alpha.
@fragment
fn fs_mix(in: VOut) -> @location(0) vec4f {
  let px = vec2i(in.p.xy);
  let d = textureLoad(dstTex, px, 0);
  let s = textureLoad(srcTex, px, 0);
  var k = B.m.y;
  if (B.m.w > 0.5) { k = k * mask_at(in.p.xy); }
  if (B.bif.x > 0.5) {
    k = k * ramp(bif_value(s.rgb, B.bif.y), B.bifThis) * ramp(bif_value(d.rgb, B.bif.y), B.bifUnder);
  }
  let mode = i32(B.m.x);
  var c = blend_rgb(mode, d.rgb, s.rgb);
  if (mode == 1) { k = select(0.0, 1.0, hash(in.p.xy + B.seed.x) < k); }
  c = mix(d.rgb, c, k);
  return vec4f(c * d.a, d.a);
}
