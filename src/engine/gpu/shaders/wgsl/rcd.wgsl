// albedo raw front end, WebGPU backend: Bayer mosaic → scene-linear RGB.
// A chain of fullscreen passes, each one entry point of this module:
//
//   fs_prep   mosaic (r16uint) → cfa: black-subtracted, normalised, white-balanced
//   fs_hlr    cfa → cfa: opposed-channel inpainting of clipped photosites
//   fs_vh     cfa → vertical/horizontal discrimination
//   fs_lpf    cfa → low-pass of the mosaic
//   fs_green  cfa, lpf, vh → green at every site
//   fs_pq     cfa → diagonal discrimination
//   fs_rb     cfa, green, pq → red at blue sites, blue at red sites
//   fs_final  cfa, green, rb, vh → RGB at every site, camera matrix, rgba16f
//
// Demosaic is Ratio Corrected Demosaicing (RCD) by Luis Sanz Rodríguez, after
// the RawTherapee implementation (GPL-3.0-or-later). Highlight inpainting
// follows darktable's "inpaint opposed" (GPL-3.0-or-later): a clipped
// photosite becomes max(value, cube-root mean of the other two colours in its
// 3×3 neighbourhood + a global per-channel chrominance offset). The offset is
// measured on the CPU (src/engine/hlchroma.js). GLSL twin: glsl/rcd.frag.
//
// The chain runs per tile: every intermediate covers one tile plus an apron
// (org = its top-left in image coordinates, tdims = its size), so GPU memory
// stays at the output plus a few tile-sized buffers whatever the sensor size.
// Positions are image coordinates throughout: posOff maps an intermediate's
// fragment position to them (0 for the final pass, which draws straight into
// the full-size output), and reads map back through org.

struct RParams {
  camMul: vec3f, black: f32,
  clip: vec3f, white: f32,     // clip: per-channel clip level after white balance
  chroma: vec3f, flipY: f32,   // chroma: opposed-inpaint offsets per channel
  row0: vec3f, _a: f32,
  row1: vec3f, _b: f32,
  row2: vec3f, _c: f32,
  cfa: vec2f, dims: vec2f,
  org: vec2f, posOff: vec2f,
  tdims: vec2f, _e: vec2f,
}

@group(0) @binding(0) var mosaic: texture_2d<u32>;
@group(0) @binding(1) var t0: texture_2d<f32>;
@group(0) @binding(2) var t1: texture_2d<f32>;
@group(0) @binding(3) var t2: texture_2d<f32>;
@group(0) @binding(4) var t3: texture_2d<f32>;
@group(0) @binding(5) var<uniform> P: RParams;

const EPS: f32 = 1e-5;
const EPSSQ: f32 = 1e-10;

struct VOut { @builtin(position) pos: vec4f }

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  var out: VOut;
  let x = f32(i32(vi & 1u) * 4 - 1);
  let y = f32(i32(vi >> 1u) * 4 - 1);
  out.pos = vec4f(x, y, 0.0, 1.0);
  return out;
}

// mirror at the edges without changing the CFA parity
fn refl(q: vec2i) -> vec2i {
  let d = vec2i(P.dims);
  var r = abs(q);
  r = select(r, 2 * (d - 1) - r, r >= d);
  return clamp(r, vec2i(0), d - 1);
}

// 0 red, 1 green, 2 blue
fn color(q: vec2i) -> i32 {
  let px = (q.x + i32(P.cfa.x)) & 1;
  let py = (q.y + i32(P.cfa.y)) & 1;
  if (px == 0 && py == 0) { return 0; }
  if (px == 1 && py == 1) { return 2; }
  return 1;
}

fn ch(v: vec3f, c: i32) -> f32 {
  if (c == 0) { return v.x; }
  if (c == 1) { return v.y; }
  return v.z;
}

// image coordinate → texel of a tile intermediate
fn L(q: vec2i) -> vec2i { return clamp(refl(q) - vec2i(P.org), vec2i(0), vec2i(P.tdims) - 1); }
fn C(q: vec2i) -> f32 { return textureLoad(t0, L(q), 0).r; }
fn T1(q: vec2i) -> f32 { return textureLoad(t1, L(q), 0).r; }
fn T2(q: vec2i) -> f32 { return textureLoad(t2, L(q), 0).r; }
fn T3(q: vec2i) -> f32 { return textureLoad(t3, L(q), 0).r; }

fn gpos(p: vec4f) -> vec2i { return vec2i(p.xy) + vec2i(P.posOff); }

fn intp(a: f32, b: f32, c: f32) -> f32 { return a * (b - c) + c; }

@fragment
fn fs_prep(in: VOut) -> @location(0) vec4f {
  let q = gpos(in.pos);
  let raw = f32(textureLoad(mosaic, vec2i(in.pos.xy), 0).r); // mosaic tile = this tile
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
  let m = pow(sum / max(cnt, vec3f(1.0)), vec3f(1.0 / 3.0));
  let opp = vec3f(0.5 * (m.y + m.z), 0.5 * (m.x + m.z), 0.5 * (m.x + m.y));
  let o = ch(opp, c);
  return vec4f(max(v, o * o * o + ch(P.chroma, c)), 0.0, 0.0, 1.0);
}

fn hpfV(p: vec2i) -> f32 {
  let h = (C(p + vec2i(0, -3)) - C(p + vec2i(0, -1)) - C(p + vec2i(0, 1)) + C(p + vec2i(0, 3)))
    - 3.0 * (C(p + vec2i(0, -2)) + C(p + vec2i(0, 2))) + 6.0 * C(p);
  return h * h;
}
fn hpfH(p: vec2i) -> f32 {
  let h = (C(p + vec2i(-3, 0)) - C(p + vec2i(-1, 0)) - C(p + vec2i(1, 0)) + C(p + vec2i(3, 0)))
    - 3.0 * (C(p + vec2i(-2, 0)) + C(p + vec2i(2, 0))) + 6.0 * C(p);
  return h * h;
}

@fragment
fn fs_vh(in: VOut) -> @location(0) vec4f {
  let q = gpos(in.pos);
  let v = max(EPSSQ, hpfV(q + vec2i(0, -1)) + hpfV(q) + hpfV(q + vec2i(0, 1)));
  let h = max(EPSSQ, hpfH(q + vec2i(-1, 0)) + hpfH(q) + hpfH(q + vec2i(1, 0)));
  return vec4f(v / (v + h), 0.0, 0.0, 1.0);
}

@fragment
fn fs_lpf(in: VOut) -> @location(0) vec4f {
  let q = gpos(in.pos);
  let l = C(q)
    + 0.5 * (C(q + vec2i(0, -1)) + C(q + vec2i(0, 1)) + C(q + vec2i(-1, 0)) + C(q + vec2i(1, 0)))
    + 0.25 * (C(q + vec2i(-1, -1)) + C(q + vec2i(1, -1)) + C(q + vec2i(-1, 1)) + C(q + vec2i(1, 1)));
  return vec4f(l, 0.0, 0.0, 1.0);
}

// refined discrimination: the centre, unless the diagonal neighbourhood is
// more decided. VH and PQ maps are both read through T3 by their callers.
fn disc(q: vec2i) -> f32 {
  let c = T3(q);
  let n = 0.25 * (T3(q + vec2i(-1, -1)) + T3(q + vec2i(1, -1)) + T3(q + vec2i(-1, 1)) + T3(q + vec2i(1, 1)));
  return select(c, n, abs(0.5 - c) < abs(0.5 - n));
}

// t1 = lpf, t3 = vh
@fragment
fn fs_green(in: VOut) -> @location(0) vec4f {
  let q = gpos(in.pos);
  let ci = C(q);
  if (color(q) == 1) { return vec4f(ci, 0.0, 0.0, 1.0); }
  let n1 = C(q + vec2i(0, -1)); let s1 = C(q + vec2i(0, 1));
  let w1 = C(q + vec2i(-1, 0)); let e1 = C(q + vec2i(1, 0));
  let nG = EPS + abs(n1 - s1) + abs(ci - C(q + vec2i(0, -2))) + abs(n1 - C(q + vec2i(0, -3))) + abs(C(q + vec2i(0, -2)) - C(q + vec2i(0, -4)));
  let sG = EPS + abs(n1 - s1) + abs(ci - C(q + vec2i(0, 2))) + abs(s1 - C(q + vec2i(0, 3))) + abs(C(q + vec2i(0, 2)) - C(q + vec2i(0, 4)));
  let wG = EPS + abs(w1 - e1) + abs(ci - C(q + vec2i(-2, 0))) + abs(w1 - C(q + vec2i(-3, 0))) + abs(C(q + vec2i(-2, 0)) - C(q + vec2i(-4, 0)));
  let eG = EPS + abs(w1 - e1) + abs(ci - C(q + vec2i(2, 0))) + abs(e1 - C(q + vec2i(3, 0))) + abs(C(q + vec2i(2, 0)) - C(q + vec2i(4, 0)));
  let l = T1(q);
  let nE = n1 * (l + l) / (EPS + l + T1(q + vec2i(0, -2)));
  let sE = s1 * (l + l) / (EPS + l + T1(q + vec2i(0, 2)));
  let wE = w1 * (l + l) / (EPS + l + T1(q + vec2i(-2, 0)));
  let eE = e1 * (l + l) / (EPS + l + T1(q + vec2i(2, 0)));
  let vE = (sG * nE + nG * sE) / (nG + sG);
  let hE = (wG * eE + eG * wE) / (eG + wG);
  return vec4f(intp(disc(q), hE, vE), 0.0, 0.0, 1.0);
}

fn hpfP(p: vec2i) -> f32 {
  let h = (C(p + vec2i(-3, -3)) - C(p + vec2i(-1, -1)) - C(p + vec2i(1, 1)) + C(p + vec2i(3, 3)))
    - 3.0 * (C(p + vec2i(-2, -2)) + C(p + vec2i(2, 2))) + 6.0 * C(p);
  return h * h;
}
fn hpfQ(p: vec2i) -> f32 {
  let h = (C(p + vec2i(3, -3)) - C(p + vec2i(1, -1)) - C(p + vec2i(-1, 1)) + C(p + vec2i(-3, 3)))
    - 3.0 * (C(p + vec2i(2, -2)) + C(p + vec2i(-2, 2))) + 6.0 * C(p);
  return h * h;
}

@fragment
fn fs_pq(in: VOut) -> @location(0) vec4f {
  let q = gpos(in.pos);
  let p = max(EPSSQ, hpfP(q + vec2i(-1, -1)) + hpfP(q) + hpfP(q + vec2i(1, 1)));
  let k = max(EPSSQ, hpfQ(q + vec2i(1, -1)) + hpfQ(q) + hpfQ(q + vec2i(-1, 1)));
  return vec4f(p / (p + k), 0.0, 0.0, 1.0);
}

// t1 = green, t3 = pq. At red and blue sites: the opposite colour.
@fragment
fn fs_rb(in: VOut) -> @location(0) vec4f {
  let q = gpos(in.pos);
  if (color(q) == 1) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  let g0 = T1(q);
  let cNW = C(q + vec2i(-1, -1)); let cNE = C(q + vec2i(1, -1));
  let cSW = C(q + vec2i(-1, 1)); let cSE = C(q + vec2i(1, 1));
  let nwG = EPS + abs(cNW - cSE) + abs(cNW - C(q + vec2i(-3, -3))) + abs(g0 - T1(q + vec2i(-2, -2)));
  let neG = EPS + abs(cNE - cSW) + abs(cNE - C(q + vec2i(3, -3))) + abs(g0 - T1(q + vec2i(2, -2)));
  let swG = EPS + abs(cNE - cSW) + abs(cSW - C(q + vec2i(-3, 3))) + abs(g0 - T1(q + vec2i(-2, 2)));
  let seG = EPS + abs(cNW - cSE) + abs(cSE - C(q + vec2i(3, 3))) + abs(g0 - T1(q + vec2i(2, 2)));
  let nwE = cNW - T1(q + vec2i(-1, -1));
  let neE = cNE - T1(q + vec2i(1, -1));
  let swE = cSW - T1(q + vec2i(-1, 1));
  let seE = cSE - T1(q + vec2i(1, 1));
  let pE = (nwG * seE + seG * nwE) / (nwG + seG);
  let qE = (neG * swE + swG * neE) / (neG + swG);
  return vec4f(g0 + intp(disc(q), qE, pE), 0.0, 0.0, 1.0);
}

// value of channel c (0 or 2) at a red or blue site
fn rbAt(p: vec2i, c: i32) -> f32 {
  return select(T2(p), C(p), color(p) == c);
}

fn atGreen(q: vec2i, c: i32, g0: f32, vh: f32) -> f32 {
  let n1 = EPS + abs(g0 - T1(q + vec2i(0, -2)));
  let s1 = EPS + abs(g0 - T1(q + vec2i(0, 2)));
  let w1 = EPS + abs(g0 - T1(q + vec2i(-2, 0)));
  let e1 = EPS + abs(g0 - T1(q + vec2i(2, 0)));
  let cn = rbAt(q + vec2i(0, -1), c); let cs = rbAt(q + vec2i(0, 1), c);
  let cw = rbAt(q + vec2i(-1, 0), c); let ce = rbAt(q + vec2i(1, 0), c);
  let sn = abs(cn - cs);
  let ew = abs(cw - ce);
  let nG = n1 + sn + abs(cn - rbAt(q + vec2i(0, -3), c));
  let sG = s1 + sn + abs(cs - rbAt(q + vec2i(0, 3), c));
  let wG = w1 + ew + abs(cw - rbAt(q + vec2i(-3, 0), c));
  let eG = e1 + ew + abs(ce - rbAt(q + vec2i(3, 0), c));
  let nE = cn - T1(q + vec2i(0, -1));
  let sE = cs - T1(q + vec2i(0, 1));
  let wE = cw - T1(q + vec2i(-1, 0));
  let eE = ce - T1(q + vec2i(1, 0));
  let vE = (nG * sE + sG * nE) / (nG + sG);
  let hE = (eG * wE + wG * eE) / (eG + wG);
  return g0 + intp(vh, hE, vE);
}

// t1 = green, t2 = rb, t3 = vh
@fragment
fn fs_final(in: VOut) -> @location(0) vec4f {
  var q = vec2i(in.pos.xy);
  if (P.flipY > 0.5) { q.y = i32(P.dims.y) - 1 - q.y; }
  let g0 = T1(q);
  var rgb: vec3f;
  let k = color(q);
  if (k == 0) { rgb = vec3f(C(q), g0, T2(q)); }
  else if (k == 2) { rgb = vec3f(T2(q), g0, C(q)); }
  else {
    let vh = disc(q);
    rgb = vec3f(atGreen(q, 0, g0, vh), g0, atGreen(q, 2, g0, vh));
  }
  rgb = max(rgb, vec3f(0.0));
  let lin = vec3f(dot(P.row0, rgb), dot(P.row1, rgb), dot(P.row2, rgb));
  return vec4f(max(lin, vec3f(0.0)), 1.0);
}

// AI denoise tile → working space. t0: the model's camera RGB for this tile
// (org = its top-left), t1: the regular demosaic of the same photo. Clipped
// photosites keep the regular result: the model has no highlight
// reconstruction. Drawn straight into the denoised image, posOff 0.
@fragment
fn fs_dnblit(in: VOut) -> @location(0) vec4f {
  let q = vec2i(in.pos.xy);
  let cam = textureLoad(t0, q - vec2i(P.org), 0).rgb;
  let base = textureLoad(t1, q, 0).rgb;
  let wb = max(cam * P.camMul, vec3f(0.0));
  let lin = max(vec3f(dot(P.row0, wb), dot(P.row1, wb), dot(P.row2, wb)), vec3f(0.0));
  let clip = smoothstep(0.9, 0.98, max(cam.r, max(cam.g, cam.b)));
  return vec4f(mix(lin, base, clip), 1.0);
}
