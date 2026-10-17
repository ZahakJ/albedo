// Compose: small full-screen passes — mip downsampling, format-converting
// copies, and presenting the composite on screen.

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var srcTex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> P: PresentU;

struct PresentU {
  doc: vec4f,      // document rectangle in target px: x0, y0, x1, y1
  surround: vec4f, // colour outside the document
  k: vec4f,        // checker size (px), linear (32-bit doc), dither, show checker
  k2: vec4f,       // exposure (32-bit view), src uv scale x, y, pad
}

struct VOut {
  @builtin(position) p: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VOut {
  let xy = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VOut;
  o.p = vec4f(xy * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(xy.x, 1.0 - xy.y);
  return o;
}

// 2×2 box: one bilinear tap at the shared corner of four parent texels
@fragment
fn fs_down(in: VOut) -> @location(0) vec4f {
  return textureSampleLevel(srcTex, samp, in.uv, 0.0);
}

// same-size copy through the shader (format conversion, e.g. rgba16f → rgba8)
@fragment
fn fs_copy(in: VOut) -> @location(0) vec4f {
  return textureLoad(srcTex, vec2i(in.p.xy), 0);
}

fn lin_to_srgb(c: vec3f) -> vec3f {
  let x = clamp(c, vec3f(0.0), vec3f(1.0));
  return select(1.055 * pow(x, vec3f(1.0 / 2.4)) - 0.055, x * 12.92, x <= vec3f(0.0031308));
}

fn hash(p: vec2f) -> f32 {
  let q = fract(p * vec2f(0.1031, 0.1030));
  let r = q + dot(q, q.yx + 33.33);
  return fract((r.x + r.y) * r.x);
}

@fragment
fn fs_present(in: VOut) -> @location(0) vec4f {
  let px = in.p.xy;
  let inDoc = px.x >= P.doc.x && px.y >= P.doc.y && px.x < P.doc.z && px.y < P.doc.w;
  if (!inDoc) { return vec4f(P.surround.rgb, 1.0); }
  let c = textureLoad(srcTex, vec2i(px), 0);
  var rgb = select(vec3f(0.0), c.rgb / c.a, c.a > 1e-6);
  if (P.k.y > 0.5) { rgb = lin_to_srgb(rgb * exp2(P.k2.x)); }
  // checkerboard under transparency, anchored to the document's corner
  let cell = floor((px - P.doc.xy) / max(P.k.x, 1.0));
  let odd = (i32(cell.x) + i32(cell.y)) % 2 != 0;
  let ck = select(vec3f(1.0), vec3f(0.8), odd);
  let under = select(vec3f(1.0), ck, P.k.w > 0.5);
  var o = rgb * c.a + under * (1.0 - c.a);
  // a 16- or 32-bit composite dithers into the 8-bit display: no banding
  if (P.k.z > 0.5) { o = o + (hash(px) - 0.5) / 255.0; }
  return vec4f(o, 1.0);
}

// display-encoded premultiplied → linear premultiplied (32-bit documents)
@fragment
fn fs_lin_premul(in: VOut) -> @location(0) vec4f {
  let c = textureLoad(srcTex, vec2i(in.p.xy), 0);
  if (c.a <= 1e-6) { return vec4f(0.0); }
  let s = c.rgb / c.a;
  let l = select(pow((s + 0.055) / 1.055, vec3f(2.4)), s / 12.92, s <= vec3f(0.04045));
  return vec4f(l * c.a, c.a);
}
