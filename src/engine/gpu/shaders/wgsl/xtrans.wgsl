// albedo X-Trans front end, WebGPU backend: 6×6 mosaic → scene-linear RGB.
//
//   fs_prep   mosaic (r16uint) → cfa: black-subtracted, normalised, white-balanced
//   fs_green  cfa → green everywhere: four directional estimates (two axes,
//             two diagonals) from the nearest greens on either side, weighted
//             by the inverse square of each direction's gradient
//   fs_final  cfa, green → R and B by guided colour-difference interpolation
//             over the 7×7 neighbourhood (weights fall with spatial distance
//             and with green dissimilarity), camera matrix, rgba16f
//
// Highlight inpainting runs on the cfa between prep and green (rcd.wgsl's
// fs_hlr generalised to the pattern). Tiled like rcd.wgsl. GLSL twin:
// glsl/xtrans.frag.

struct XParams {
  camMul: vec3f, black: f32,
  clip: vec3f, white: f32,
  chroma: vec3f, flipY: f32,
  row0: vec3f, _a: f32,
  row1: vec3f, _b: f32,
  row2: vec3f, _c: f32,
  dims: vec2f, tdims: vec2f,
  org: vec2f, posOff: vec2f,  // tiling, as in rcd.wgsl
  pat: array<vec4f, 9>,        // colour of (y mod 6)·6 + (x mod 6): 0 R, 1 G, 2 B
}

@group(0) @binding(0) var mosaic: texture_2d<u32>;
@group(0) @binding(1) var t0: texture_2d<f32>;
@group(0) @binding(2) var t1: texture_2d<f32>;
@group(0) @binding(5) var<uniform> P: XParams; // bindings 3, 4: unused (layout shared with rcd)

const EPS: f32 = 1e-6;

struct VOut { @builtin(position) pos: vec4f }

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  var out: VOut;
  let x = f32(i32(vi & 1u) * 4 - 1);
  let y = f32(i32(vi >> 1u) * 4 - 1);
  out.pos = vec4f(x, y, 0.0, 1.0);
  return out;
}

// mirror by whole pattern periods so the colour at a mirrored site is right
fn refl(q: vec2i) -> vec2i {
  let d = vec2i(P.dims);
  var r = q;
  r = select(r, r + 6 * ((-r + 5) / 6), r < vec2i(0));
  r = select(r, r - 6 * ((r - d + 6) / 6), r >= d);
  return clamp(r, vec2i(0), d - 1);
}

fn color(q: vec2i) -> i32 {
  let i = ((q.y % 6 + 6) % 6) * 6 + ((q.x % 6 + 6) % 6);
  return i32(P.pat[i / 4][i % 4]);
}

fn ch(v: vec3f, c: i32) -> f32 {
  if (c == 0) { return v.x; }
  if (c == 1) { return v.y; }
  return v.z;
}

fn L(q: vec2i) -> vec2i { return clamp(refl(q) - vec2i(P.org), vec2i(0), vec2i(P.tdims) - 1); }
fn C(q: vec2i) -> f32 { return textureLoad(t0, L(q), 0).r; }
fn G(q: vec2i) -> f32 { return textureLoad(t1, L(q), 0).r; }
fn gpos(p: vec4f) -> vec2i { return vec2i(p.xy) + vec2i(P.posOff); }

@fragment
fn fs_prep(in: VOut) -> @location(0) vec4f {
  let q = gpos(in.pos);
  let raw = f32(textureLoad(mosaic, vec2i(in.pos.xy), 0).r);
  let v = max(0.0, (raw - P.black) / (P.white - P.black)) * ch(P.camMul, color(q));
  return vec4f(v, 0.0, 0.0, 1.0);
}

@fragment
fn fs_hlr(in: VOut) -> @location(0) vec4f {
  let q = gpos(in.pos);
  let c = color(q);
  let v = C(q);
  if (v < ch(P.clip, c)) { return vec4f(v, 0.0, 0.0, 1.0); }
  var sum = vec3f(0.0);
  var cnt = vec3f(0.0);
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let p = q + vec2i(dx, dy);
      let k = color(p);
      let s = C(p);
      if (k == 0) { sum.x += s; cnt.x += 1.0; }
      else if (k == 1) { sum.y += s; cnt.y += 1.0; }
      else { sum.z += s; cnt.z += 1.0; }
    }
  }
  // an X-Trans 3×3 always holds green, but not always both red and blue
  var m = pow(sum / max(cnt, vec3f(1.0)), vec3f(1.0 / 3.0));
  if (cnt.x < 0.5) { m.x = m.y; }
  if (cnt.z < 0.5) { m.z = m.y; }
  let opp = vec3f(0.5 * (m.y + m.z), 0.5 * (m.x + m.z), 0.5 * (m.x + m.y));
  let o = ch(opp, c);
  return vec4f(max(v, o * o * o + ch(P.chroma, c)), 0.0, 0.0, 1.0);
}

// nearest green along d within 3 steps: (value, distance); distance 0 = none
fn greenAlong(q: vec2i, d: vec2i) -> vec2f {
  for (var k = 1; k <= 3; k++) {
    let p = q + d * k;
    if (color(p) == 1) { return vec2f(C(p), f32(k)); }
  }
  return vec2f(0.0, 0.0);
}

@fragment
fn fs_green(in: VOut) -> @location(0) vec4f {
  let q = gpos(in.pos);
  let c0 = C(q);
  let k0 = color(q);
  if (k0 == 1) { return vec4f(c0, 0.0, 0.0, 1.0); }
  var dirs = array<vec2i, 4>(vec2i(1, 0), vec2i(0, 1), vec2i(1, 1), vec2i(1, -1));
  var acc = 0.0;
  var wsum = 0.0;
  for (var i = 0; i < 4; i++) {
    let d = dirs[i];
    let a = greenAlong(q, d);
    let b = greenAlong(q, -d);
    if (a.y == 0.0 || b.y == 0.0) { continue; }
    // linear interpolation between the two greens at their distances
    let g = (a.x * b.y + b.x * a.y) / (a.y + b.y);
    // gradient: green change across q plus raw change one step either side
    let grad = abs(a.x - b.x) / (a.y + b.y) + 0.5 * abs(C(q + d) - C(q - d))
      + 0.25 * abs(C(q + 2 * d) - C(q - 2 * d));
    let w = 1.0 / (EPS + grad * grad);
    acc += w * g;
    wsum += w;
  }
  let g = select(c0, acc / wsum, wsum > 0.0);
  return vec4f(max(g, 0.0), 0.0, 0.0, 1.0);
}

// channel c (0 or 2) at q: the raw value at a c site, otherwise green plus
// the colour difference of c sites in the 7×7 window, weighted by distance
// and by how similar their green is to q's
fn guided(q: vec2i, c: i32, g0: f32) -> f32 {
  var acc = 0.0;
  var wsum = 0.0;
  let s = max(g0, 1e-4);
  for (var dy = -3; dy <= 3; dy++) {
    for (var dx = -3; dx <= 3; dx++) {
      let p = q + vec2i(dx, dy);
      if (color(p) != c) { continue; }
      let gp = G(p);
      let dg = (gp - g0) / s;
      let w = 1.0 / ((1.0 + 0.35 * f32(dx * dx + dy * dy)) * (0.02 + dg * dg));
      acc += w * (C(p) - gp);
      wsum += w;
    }
  }
  return g0 + acc / max(wsum, 1e-12);
}

@fragment
fn fs_final(in: VOut) -> @location(0) vec4f {
  var q = vec2i(in.pos.xy);
  if (P.flipY > 0.5) { q.y = i32(P.dims.y) - 1 - q.y; }
  let g0 = G(q);
  let k = color(q);
  var r = select(guided(q, 0, g0), C(q), k == 0);
  var b = select(guided(q, 2, g0), C(q), k == 2);
  let rgb = max(vec3f(r, g0, b), vec3f(0.0));
  let lin = vec3f(dot(P.row0, rgb), dot(P.row1, rgb), dot(P.row2, rgb));
  return vec4f(max(lin, vec3f(0.0)), 1.0);
}
