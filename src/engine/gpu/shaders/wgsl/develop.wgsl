// albedo develop pass, WebGPU backend — exact math twin of glsl/develop.frag.
// Scene-referred pipeline: geometry (crop/rotate/flip inverse map + keystone
// homography + lens distortion/CA) → decode → heal/clone spots → WB
// (temp/tint) → exposure → parametric tone (log2-luma zones, pivot 0.18) →
// local contrast (texture/clarity/dehaze vs blurred-SOURCE pyramid) +
// defringe → OKLCh colormix → vibrance/saturation → B&W → 3-way color
// grading → vignette (radial gain, post-crop frame) → display transform
// (clamp, or the AgX tone mapper, + sRGB encode) → point-curve LUT → clip
// overlay.
//
// Params layout — ONE Float32Array(128), identical in both backends
// (WGSL: 32 × vec4f; GLSL: uniform vec4 P[32]). Keep this comment block
// verbatim in both shaders.
//   [ 0] ev          [ 1] temp        [ 2] tint        [ 3] contrast
//   [ 4] highlights  [ 5] shadows     [ 6] whites      [ 7] blacks
//   [ 8] vibrance    [ 9] saturation  [10] hasCurve    [11] inputIsLinear
//   [12] clipOverlay [13] mixOn (any colormix/vibsat nonzero; the worker
//        zeroes vibsat, colormix and mixOn while B&W is on) [14..15] frame
//        offset x, y (Compose; see [75])
//   [16+4b .. 18+4b] h, s, l of band b — red orange yellow green aqua blue
//                    purple magenta — [19+4b] pad
//   [48] clarity     [49] texture     [50] dehaze      [51] resScale
//   [52] vignette amount [53] vignette midpoint [54] vignette roundness
//   [55] vignette feather [56] lcOn (any of clarity/texture/dehaze nonzero;
//        the worker also forces it for mask clarity, heal spots and defringe)
//   [57] angle rad   [58..61] crop x/y/w/h (source-normalized, y-down)
//   [62] fitScale (inscribed auto-zoom, ≥1) [63] flipH
//   [64] grading shadows h (deg)  [65] grading shadows s (0..100)
//   [66] grading midtones h       [67] grading midtones s
//   [68] grading highlights h     [69] grading highlights s
//   [70] grading blending 0..100  [71] grading balance -100..100
//   [72] gradingOn (any zone s nonzero) [73] bwOn
//   [74] healCount (0..32, healU below) [75] frame scale x — with [95]
//        (scale y) and [14..15], the output's place in a larger frame:
//        frame uv = offset + uv·scale. Compose renders adjustment layers
//        over a view of the document, and the vignette follows the
//        document. 0 = the output is the frame
//   [76..83] B&W mix weight per band, red..magenta (-100..100)
//   [84] lens distortion (-100..100)  [85] caRed  [86] caBlue (-100..100)
//   [87] defringe (0..100)  [88] lensOn (any of 84..87 nonzero)
//   [89] persp v (-100..100)  [90] persp h  [91] perspOn
//   [92] toneMap 0=clamp 1=AgX  [93] baseline EV (AgX only)
//   [94] look saturation (AgX only, 1 = neutral)  [95] frame scale y
//   [96] lensfunOn  [97..100] distortion a1..a4: inverse map from output to
//        source radius r_d = r·(1 + a1 r + a2 r² + a3 r³ + a4 r⁴), r = 1 at
//        the source half-diagonal  [101..103] TCA red v, c, b and
//        [104..106] blue: r_ch = r_d·(v + c r_d + b r_d²)  [107..109]
//        vignetting k1..k3: linear rgb ÷ (1 + k1 r² + k2 r⁴ + k3 r⁶) at r_d
//        [110] patchCount (0..16, patchU below)  [111] AI denoise amount
//        (0..1): mixes the denoised capture (dnTex) over the source
//   [112] dcpOn  [113] hsvOn  [114] toneOn  [115] hsv value encoding (1 = sRGB)
//   [116..124] dcpMatrix, row-major: LibRaw's working space → the profile's
//        (both linear Rec.709 of white-balanced camera RGB)
//   [125..127] hsv table dims: hue, saturation, value divisions
//   A DCP camera profile (DNG SDK order, folded): matrix, then HueSatMap and
//   LookTable as one table over the HSV of linear ProPhoto (hsvLut: width =
//   saturation, height = hue (wraps), depth = value; texels: hue shift deg,
//   saturation scale, value scale), at the source; its tone curve (toneTex,
//   1024 samples, hue-preserving on ProPhoto) replaces the display transform
//   sliders arrive raw (-100..100, ev in stops); all scaling lives here
//   detail (denoise/sharpen) deliberately rides OUTSIDE this array: NR swaps
//   the develop input for a denoised linear texture (worker forces [11]=1);
//   sharpen runs as the separate finish pass (finish.*, own uniform group) —
//   when it runs the worker forces [12]=0 and finish paints the clip overlay
//   post-sharpen instead
//
// masksU — SECOND uniform group, ONE Float32Array(192) = 8 masks × 24 floats
// (WGSL: array<vec4f,48> at @binding(6); GLSL: uniform vec4 M[48]), identical
// in both backends. Per mask (offset o = 24·i):
//   [o+0] kind 0=linear 1=radial 2=brush   [o+1] invert   [o+2] enabled
//   [o+3..o+8] geom — linear: x0,y0,x1,y1,·,· (weight 0 at p0 → 1 at p1)
//     radial: cx,cy,rx,ry,angle rad,feather 0..1 (rx/ry × source WIDTH)
//     brush:  channel 0..3 into brushTex,·,·,·,·,·
//   [o+9..o+15] adjust: ev, temp, contrast, highlights, shadows, saturation,
//     clarity — raw slider units, scaled by the mask weight in-shader
//   [o+16] lumaOn [o+17] lumaLo [o+18] lumaHi [o+19] lumaSoftness (0..1) —
//     range window over the display-encoded SOURCE luma
//   [o+20] colorOn [o+21] hue (OKLCh deg) [o+22] chroma (OKLab C)
//   [o+23] tolerance (0..100) — OKLCh proximity of the SOURCE color
// Masks evaluate at the PRE-mirror y-down source-normalized coord (crop
// space, so they survive crop/rotate changes); applied after local contrast,
// before colormix, reusing the global module math × m — multiplicative gains
// are additive stops, so masks stack. brushTex: quarter-res rgba8, one
// channel per brush mask (stamp pass); worker forces lcOn ([56]) whenever
// any mask carries clarity.
//
// healU — THIRD uniform group, ONE Float32Array(256) = 32 spots × 8 floats
// (WGSL: array<vec4f,64> at @binding(8); GLSL: uniform vec4 Hl[64]).
// Per spot (offset o = 8·i, i < params[74]):
//   [o+0] mode 0=clone 1=heal  [o+1] destX [o+2] destY  [o+3] srcX
//   [o+4] srcY  [o+5] radius (source-WIDTH fraction)  [o+6] feather 0..1
//   [o+7] pad
// Spots live in FINAL source space (post persp/distortion, pre-mirror) so
// they stay glued to image content under crop/rotate/lens edits.
//
// patchU — FOURTH uniform group, ONE Float32Array(192) = 16 patches × 12
// floats (WGSL: array<vec4f,48> at @binding(10); GLSL: uniform vec4 Pt[48]),
// with their pixels in one rgba8 atlas (patchTex, @binding(9) / unit 5).
// Per patch (offset o = 12·i, i < params[110]):
//   [o+0..3] rect x, y, w, h in final source space (like heal spots)
//   [o+4..7] atlas rect u, v, w, h (0..1)  [o+8] scale  [o+9..11] pad
// A patch is a removed area refilled by inpainting: rgb is the fill as sRGB
// of (scene-linear ÷ scale), alpha the feathered hole. It replaces the
// capture before anything else reads it.

struct Params {
  a: vec4f,               // ev, temp, tint, contrast
  b: vec4f,               // highlights, shadows, whites, blacks
  c: vec4f,               // vibrance, saturation, hasCurve, inputIsLinear
  d: vec4f,               // clipOverlay, mixOn, frame offset x, y
  bands: array<vec4f, 8>, // h, s, l, pad per band
  e: vec4f,               // clarity, texture, dehaze, resScale
  f: vec4f,               // vignette amount, midpoint, roundness, feather
  g: vec4f,               // lcOn, angle rad, crop x, crop y
  h: vec4f,               // crop w, crop h, fitScale, flipH
  i: vec4f,               // grading: shadows h, shadows s, midtones h, midtones s
  j: vec4f,               // grading: highlights h, highlights s, blending, balance
  k: vec4f,               // gradingOn, bwOn, healCount, frame scale x
  bw0: vec4f,             // B&W mix: red, orange, yellow, green
  bw1: vec4f,             // B&W mix: aqua, blue, purple, magenta
  l: vec4f,               // lens: distortion, caRed, caBlue, defringe
  q: vec4f,               // lensOn, persp v, persp h, perspOn
  p2: vec4f,              // toneMap, baseline EV, look saturation, frame scale y
  lf0: vec4f,             // lensfunOn, a1, a2, a3
  lf1: vec4f,             // a4, TCA red v, c, b
  lf2: vec4f,             // TCA blue v, c, b, vignetting k1
  lf3: vec4f,             // vignetting k2, k3, patchCount, AI denoise amount
  d0: vec4f,              // dcpOn, hsvOn, toneOn, hsv value encoding
  d1: vec4f,              // dcpMatrix 0..3
  d2: vec4f,              // dcpMatrix 4..7
  d3: vec4f,              // dcpMatrix 8, hsv dims hue, sat, val
}

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var img: texture_2d<f32>;
@group(0) @binding(2) var<uniform> P: Params;
@group(0) @binding(3) var curveTex: texture_2d<f32>; // 512×1 r32float LUT
@group(0) @binding(4) var blurSmall: texture_2d<f32>; // scene-linear source, σ≈3px·resScale (full res)
@group(0) @binding(5) var blurLarge: texture_2d<f32>; // scene-linear source, σ≈40px·resScale (quarter res)
struct MasksU { m: array<vec4f, 48> } // masksU layout comment above
@group(0) @binding(6) var<uniform> M: MasksU;
@group(0) @binding(7) var brushTex: texture_2d<f32>; // quarter-res rgba8, 1×1 dummy when unused
struct HealU { m: array<vec4f, 64> } // healU layout comment above
@group(0) @binding(8) var<uniform> Hl: HealU;
@group(0) @binding(9) var patchTex: texture_2d<f32>; // rgba8 atlas, 1×1 dummy when unused
struct PatchU { m: array<vec4f, 48> } // patchU layout comment above
@group(0) @binding(10) var<uniform> Pt: PatchU;
@group(0) @binding(11) var dnTex: texture_2d<f32>; // AI-denoised capture, 1×1 dummy when unused
@group(0) @binding(12) var hsvLut: texture_3d<f32>; // DCP HSV table, 1×1×1 dummy when unused
@group(0) @binding(13) var lutSamp: sampler;        // linear, hue (v) repeats
@group(0) @binding(14) var toneTex: texture_2d<f32>; // DCP tone curve, 1024×1 r32float

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
}

// AgX (Troy Sobotka), the minimal fit by Benjamin Wrensch (MIT): inset
// matrix, log2 encoding over [-12.47, +4.03] stops around 0.18, a sixth-order
// sigmoid, outset matrix. Highlights roll off and desaturate toward white
// instead of clipping per channel. sat scales chroma in the encoded domain.
fn agx_curve(x: vec3f) -> vec3f {
  let x2 = x * x;
  let x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
fn agx(lin: vec3f, sat: f32) -> vec3f {
  let inset = mat3x3f(
    vec3f(0.842479062253094, 0.0423282422610123, 0.0423756549057051),
    vec3f(0.0784335999999992, 0.878468636469772, 0.0784336),
    vec3f(0.0792237451477643, 0.0791661274605434, 0.879142973793104));
  let outset = mat3x3f(
    vec3f(1.19687900512017, -0.0528968517574562, -0.0529716355144438),
    vec3f(-0.0980208811401368, 1.15190312990417, -0.0980434501171241),
    vec3f(-0.0990297440797205, -0.0989611768448433, 1.15107367264116));
  let lo = -12.47393;
  let hi = 4.026069;
  var v = inset * max(lin, vec3f(1e-10));
  v = clamp(log2(max(v, vec3f(1e-10))), vec3f(lo), vec3f(hi));
  v = agx_curve((v - lo) / (hi - lo));
  let y = dot(v, vec3f(0.2126, 0.7152, 0.0722));
  v = y + sat * (v - y);
  v = outset * v;
  return clamp(pow(max(v, vec3f(0.0)), vec3f(2.2)), vec3f(0.0), vec3f(1.0));
}

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  // fullscreen triangle
  var out: VOut;
  let x = f32(i32(vi & 1u) * 4 - 1);
  let y = f32(i32(vi >> 1u) * 4 - 1);
  out.pos = vec4f(x, y, 0.0, 1.0);
  // WebGPU framebuffer origin is top-left; v=0 maps to image top as uploaded.
  out.uv = vec2f(x * 0.5 + 0.5, 0.5 - y * 0.5);
  return out;
}

fn srgb_to_linear(c: vec3f) -> vec3f {
  let lo = c / 12.92;
  let hi = pow((c + vec3f(0.055)) / 1.055, vec3f(2.4));
  return select(hi, lo, c <= vec3f(0.04045));
}

fn linear_to_srgb(c: vec3f) -> vec3f {
  let lo = c * 12.92;
  let hi = 1.055 * pow(c, vec3f(1.0 / 2.4)) - vec3f(0.055);
  return select(hi, lo, c <= vec3f(0.0031308));
}

// sign-safe cube root: camera matrices can push channels slightly negative
fn cbrt_s(x: f32) -> f32 { return sign(x) * pow(abs(x), 1.0 / 3.0); }

// OKLab (Björn Ottosson's published sRGB matrices)
fn lin_to_oklab(c: vec3f) -> vec3f {
  let l = cbrt_s(dot(vec3f(0.4122214708, 0.5363325363, 0.0514459929), c));
  let m = cbrt_s(dot(vec3f(0.2119034982, 0.6806995451, 0.1073969566), c));
  let s = cbrt_s(dot(vec3f(0.0883024619, 0.2817188376, 0.6299787005), c));
  return vec3f(
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s);
}

fn oklab_to_lin(lab: vec3f) -> vec3f {
  var l = lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z; l = l * l * l;
  var m = lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z; m = m * m * m;
  var s = lab.x - 0.0894841775 * lab.y - 1.2914855480 * lab.z; s = s * s * s;
  return vec3f(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
}

// LUT lookup with manual lerp between texels (parity with GLSL texelFetch)
fn curve_at(x: f32) -> f32 {
  let t = clamp(x, 0.0, 1.0) * 511.0;
  let i = i32(t);
  let y0 = textureLoad(curveTex, vec2i(i, 0), 0).r;
  let y1 = textureLoad(curveTex, vec2i(min(i + 1, 511), 0), 0).r;
  return mix(y0, y1, t - f32(i));
}

const PI: f32 = 3.141592653589793;
const LW = vec3f(0.2126, 0.7152, 0.0722);

// shared module math — global modules and per-mask reapplication use the SAME
// helpers so a mask at m=1 matches the global slider exactly
fn wb_mul(t: f32, ti: f32) -> vec3f {
  return vec3f(1.0 + 0.25 * t, 1.0 - 0.25 * ti, 1.0 - 0.25 * t);
}

fn tone_stops(lz: f32, c: f32, hl: f32, sh: f32, wh: f32, bl: f32) -> f32 {
  let k = exp2(0.8 * c / 100.0);
  return (hl / 100.0) * smoothstep(0.0, 2.0, lz)           // highlights: >mid
    + (sh / 100.0) * smoothstep(0.0, 2.0, -lz)             // shadows: <mid
    + 0.75 * (wh / 100.0) * smoothstep(1.0, 2.47, lz)      // whites: top ~1.5 stops
    + 0.75 * (bl / 100.0) * smoothstep(2.0, 4.5, -lz)      // blacks: floor
    + (k - 1.0) * 1.5 * tanh(lz / 1.5);                    // contrast
}

// OKLCh chroma scale, hue/L preserved (per-mask saturation)
fn chroma_scale(c: vec3f, s: f32) -> vec3f {
  let lab = lin_to_oklab(c);
  return max(oklab_to_lin(vec3f(lab.x, lab.y * s, lab.z * s)), vec3f(0.0));
}

// pre-mirror y-down source-normalized coord → linear rgb, single tap
// (WebGPU's v=0 is already the image top — no vFlip leg)
fn src_at(m: vec2f) -> vec3f {
  let g = vec2f(mix(m.x, 1.0 - m.x, P.h.w), m.y);
  var c = textureSampleLevel(img, samp, g, 0.0).rgb;
  if (P.lf3.w > 0.0) { c = mix(c, textureSampleLevel(dnTex, samp, g, 0.0).rgb, P.lf3.w); }
  return select(srgb_to_linear(c), c, P.c.w > 0.5);
}

// source tap with lens CA: per-channel radial scale about the source center,
// ±0.5% at ±100 — red and blue each get their own tap when active
fn sample_source(m: vec2f) -> vec3f {
  var kr = 1.0;
  var kb = 1.0;
  if (P.q.x > 0.5) {
    kr = 1.0 + P.l.y / 100.0 * 0.005;
    kb = 1.0 + P.l.z / 100.0 * 0.005;
  }
  // lens profile: TCA scales red and blue about the centre; vignetting is
  // undone on the capture itself, before any edit sees it
  var gain = 1.0;
  if (P.lf0.x > 0.5) {
    let dim = vec2f(textureDimensions(img));
    let r = length((m - 0.5) * dim) / (0.5 * length(dim));
    kr *= P.lf1.y + r * (P.lf1.z + r * P.lf1.w);
    kb *= P.lf2.x + r * (P.lf2.y + r * P.lf2.z);
    let r2 = r * r;
    gain = 1.0 + r2 * (P.lf2.w + r2 * (P.lf3.x + r2 * P.lf3.y));
  }
  var rgb = src_at(m);
  if (kr != 1.0 || kb != 1.0) {
    rgb = vec3f(src_at(0.5 + (m - 0.5) * kr).r, rgb.g, src_at(0.5 + (m - 0.5) * kb).b);
  }
  let src = patched(m, rgb) / gain;
  if (P.d0.x > 0.5) { return dcp_source(src); }
  return src;
}

// ── DCP camera profile ──────────────────────────────────────────────────────
const REC709_TO_PP = mat3x3f(
  vec3f(0.529345874, 0.098374386, 0.016883197),
  vec3f(0.330072825, 0.87346107, 0.117672492),
  vec3f(0.140581278, 0.028164692, 0.865444313));
const PP_TO_REC709 = mat3x3f(
  vec3f(2.034076208, -0.228813442, -0.008569773),
  vec3f(-0.727334325, 1.231730155, -0.153286613),
  vec3f(-0.306741729, -0.0029169, 1.161856407));

fn dcp_source(rgb: vec3f) -> vec3f {
  let M = mat3x3f(vec3f(P.d1.x, P.d1.w, P.d2.z), vec3f(P.d1.y, P.d2.x, P.d2.w), vec3f(P.d1.z, P.d2.y, P.d3.x));
  var c = max(M * rgb, vec3f(0.0));
  if (P.d0.y < 0.5) { return c; }
  // DNG SDK RGBtoHSV on linear ProPhoto: h in [0,6), s = (max-min)/max, v = max
  let pp = max(REC709_TO_PP * c, vec3f(0.0));
  let v = max(pp.r, max(pp.g, pp.b));
  if (v <= 0.0) { return c; }
  let mn = min(pp.r, min(pp.g, pp.b));
  let d = v - mn;
  let s = d / v;
  var h = 0.0;
  if (d > 0.0) {
    if (pp.r == v) { h = (pp.g - pp.b) / d; if (h < 0.0) { h += 6.0; } }
    else if (pp.g == v) { h = 2.0 + (pp.b - pp.r) / d; }
    else { h = 4.0 + (pp.r - pp.g) / d; }
  }
  let dims = P.d3.yzw; // hue, sat, val divisions
  var vv = v;
  if (P.d0.w > 0.5) { vv = select(12.92 * v, 1.055 * pow(v, 1.0 / 2.4) - 0.055, v > 0.0031308); }
  let tc = vec3f(
    (s * (dims.y - 1.0) + 0.5) / dims.y,
    h / 6.0 + 0.5 / dims.x,
    (clamp(vv, 0.0, 1.0) * max(dims.z - 1.0, 0.0) + 0.5) / dims.z);
  let t = textureSampleLevel(hsvLut, lutSamp, tc, 0.0).rgb;
  var h2 = h + t.x * 6.0 / 360.0;
  h2 = h2 - 6.0 * floor(h2 / 6.0);
  let s2 = min(s * t.y, 1.0);
  let v2 = v * t.z;
  // HSV → RGB
  let i = floor(h2);
  let f = h2 - i;
  let p0 = v2 * (1.0 - s2);
  let q0 = v2 * (1.0 - s2 * f);
  let t0 = v2 * (1.0 - s2 * (1.0 - f));
  var o: vec3f;
  if (i < 1.0) { o = vec3f(v2, t0, p0); }
  else if (i < 2.0) { o = vec3f(q0, v2, p0); }
  else if (i < 3.0) { o = vec3f(p0, v2, t0); }
  else if (i < 4.0) { o = vec3f(p0, q0, v2); }
  else if (i < 5.0) { o = vec3f(t0, p0, v2); }
  else { o = vec3f(v2, p0, q0); }
  return max(PP_TO_REC709 * o, vec3f(0.0));
}

fn tone_at(x: f32) -> f32 {
  let t = clamp(x, 0.0, 1.0) * 1023.0;
  let i = i32(t);
  let y0 = textureLoad(toneTex, vec2i(i, 0), 0).r;
  let y1 = textureLoad(toneTex, vec2i(min(i + 1, 1023), 0), 0).r;
  return mix(y0, y1, t - f32(i));
}

// DNG SDK RGBTone: the curve on the largest and smallest ProPhoto channel,
// the middle one keeps its place between them — hue survives the curve
fn dcp_tone(rgb: vec3f) -> vec3f {
  let pp = clamp(REC709_TO_PP * max(rgb, vec3f(0.0)), vec3f(0.0), vec3f(1.0));
  let hi = max(pp.r, max(pp.g, pp.b));
  let lo = min(pp.r, min(pp.g, pp.b));
  let th = tone_at(hi);
  let tl = tone_at(lo);
  let k = select(0.0, (th - tl) / (hi - lo), hi > lo);
  let o = tl + (pp - vec3f(lo)) * k;
  return clamp(PP_TO_REC709 * o, vec3f(0.0), vec3f(1.0));
}

// removal patches: the inpainted fill over the capture, feathered by alpha
fn patched(m: vec2f, rgb: vec3f) -> vec3f {
  var c = rgb;
  for (var i = 0; i < 16; i++) {
    if (f32(i) >= P.lf3.z) { break; }
    let r = Pt.m[i * 3];
    let t = (m - r.xy) / r.zw;
    if (any(t < vec2f(0.0)) || any(t > vec2f(1.0))) { continue; }
    let a = Pt.m[i * 3 + 1];
    let s = textureSampleLevel(patchTex, samp, a.xy + t * a.zw, 0.0);
    c = mix(c, srgb_to_linear(s.rgb) * Pt.m[i * 3 + 2].x, s.a);
  }
  return c;
}

// blurSmall tap at a pre-mirror coord (pyramids store the unflipped source)
fn blur_at(m: vec2f) -> vec3f {
  let g = vec2f(mix(m.x, 1.0 - m.x, P.h.w), m.y);
  return textureSampleLevel(blurSmall, samp, g, 0.0).rgb;
}

// mask weight at p = pre-mirror y-down source-normalized coord; dim = source
// px; srcLin = pre-develop linear source (range refinements evaluate on it)
fn mask_weight(i: i32, p: vec2f, dim: vec2f, srcLin: vec3f) -> f32 {
  let r0 = M.m[i * 6];
  let r1 = M.m[i * 6 + 1];
  var m = 0.0;
  if (r0.x < 0.5) {
    // linear: smoothstep along the p0→p1 axis, aspect-corrected
    let a = vec2f(r0.w, r1.x);
    let b = vec2f(r1.y, r1.z);
    let d = (b - a) * dim;
    let q = (p - a) * dim;
    m = smoothstep(0.0, 1.0, dot(q, d) / max(dot(d, d), 1e-8));
  } else if (r0.x < 1.5) {
    // radial: elliptical falloff, rotated; feather eats inward from the edge
    let c = vec2f(r0.w, r1.x);
    let rr = max(vec2f(r1.y, r1.z), vec2f(1e-4)) * dim.x; // width-normalized radii
    let e = (p - c) * dim;
    let ca = cos(r1.w);
    let sa = sin(r1.w);
    let u = vec2f(ca * e.x + sa * e.y, -sa * e.x + ca * e.y);
    let dN = length(u / rr);
    let f = clamp(M.m[i * 6 + 2].x, 0.005, 1.0);
    m = 1.0 - smoothstep(1.0 - f, 1.0, dN);
  } else {
    // brush: bilinear tap of this mask's channel in the quarter-res stamp tex
    let bt = textureSampleLevel(brushTex, samp, p, 0.0);
    let ch = r0.w;
    m = select(select(select(bt.a, bt.b, ch < 2.5), bt.g, ch < 1.5), bt.r, ch < 0.5);
  }
  m = select(m, 1.0 - m, r0.y > 0.5); // invert flips
  // range refinement — luma window over the display-encoded source luma;
  // color = OKLCh hue/chroma proximity of the source; both multiply m
  let r4 = M.m[i * 6 + 4];
  if (r4.x > 0.5) {
    let L = linear_to_srgb(vec3f(clamp(dot(srcLin, LW), 0.0, 1.0))).x;
    let sft = r4.w * 0.25 + 0.001;
    m *= smoothstep(r4.y - sft, r4.y, L) * (1.0 - smoothstep(r4.z, r4.z + sft, L));
  }
  let r5 = M.m[i * 6 + 5];
  if (r5.x > 0.5) {
    let lab = lin_to_oklab(srcLin);
    let cc = length(lab.yz);
    var hue = select(0.0, degrees(atan2(lab.z, lab.y)), cc > 1e-6);
    hue = select(hue, hue + 360.0, hue < 0.0);
    var dh = abs(hue - r5.y);
    dh = min(dh, 360.0 - dh);
    let tolH = 12.0 + 0.68 * r5.w;
    let tolC = 0.04 + 0.0035 * r5.w;
    let wh = 1.0 - smoothstep(tolH * 0.6, tolH, dh);
    let wc = 1.0 - smoothstep(tolC, tolC * 2.5 + 0.02, abs(cc - r5.z));
    m *= select(wh * wc, wc, r5.z < 0.02); // near-gray target: hue is meaningless
  }
  return m;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  // 0. geometry — inverse map in y-down source-normalized coords: un-crop
  // (p = cropXY + uv·cropWH) → rotate by -angle about the crop center in
  // pixel space → 1/fitScale auto-zoom → optional mirror. WebGPU's uv is
  // already y-down; aux pyramids are source-space so they sample the SAME
  // coord below. R(θ) in y-down coords makes +angle rotate the image CCW on
  // screen.
  let dim = vec2f(textureDimensions(img));
  let cxy = vec2f(P.g.z, P.g.w);
  let cwh = vec2f(P.h.x, P.h.y);
  let cc = cxy + 0.5 * cwh;
  let dpx = (cxy + in.uv * cwh - cc) * dim;
  let ca = cos(P.g.y);
  let sa = sin(P.g.y);
  // muv: pre-mirror = crop/mask space (affine)
  let muv = cc + vec2f(ca * dpx.x - sa * dpx.y, sa * dpx.x + ca * dpx.y) / (P.h.z * dim);

  // 0.5 perspective + lens distortion — inverse warps about the SOURCE
  // center, applied to the affine output (final source space): the loupe's
  // crop-slot fold stays exact because the warp anchor is fold-invariant.
  // Keystone: proper 3×3 homography [[1,0,0],[0,1,0],[2kh,2kv,1]] about the
  // center; +v narrows the frame top (converging verticals corrected).
  // Distortion: r' = r(1 + k1·r²·0.15), r normalized to the half-diagonal.
  var fuv = muv;
  if (P.q.w > 0.5) {
    let n = fuv - 0.5;
    let pw = max(1.0 + 2.0 * ((P.q.z / 100.0) * 0.3 * n.x + (P.q.y / 100.0) * 0.3 * n.y), 0.2);
    fuv = 0.5 + n / pw;
  }
  if (P.l.x != 0.0) {
    let dd = (fuv - 0.5) * dim;
    let r2d = dot(dd, dd) / (0.25 * dot(dim, dim));
    fuv = 0.5 + (fuv - 0.5) * (1.0 + (P.l.x / 100.0) * r2d * 0.15);
  }
  // lens profile distortion, innermost: the capture itself is what bends
  if (P.lf0.x > 0.5) {
    let r = length((fuv - 0.5) * dim) / (0.5 * length(dim));
    fuv = 0.5 + (fuv - 0.5) * (1.0 + r * (P.lf0.y + r * (P.lf0.z + r * (P.lf0.w + r * P.lf1.x))));
  }
  // guv: post-mirror texture/pyramid space of the final source coord
  let guv = vec2f(mix(fuv.x, 1.0 - fuv.x, P.h.w), fuv.y);

  var rgb = sample_source(fuv);

  // 0.7 heal/clone spots — feathered circular clone in final source space;
  // 'heal' also matches the local low-frequency level: 4 blurSmall rim taps
  // (radius ×1.35, outside the blemish) around dest minus around source
  // (worker forces lcOn whenever a heal-mode spot exists)
  var rims = array<vec2f, 4>(vec2f(1.0, 0.0), vec2f(-1.0, 0.0), vec2f(0.0, 1.0), vec2f(0.0, -1.0));
  for (var i = 0; i < 32; i++) {
    if (f32(i) >= P.k.z) { break; }
    let h0 = Hl.m[i * 2];     // mode, destX, destY, srcX
    let h1 = Hl.m[i * 2 + 1]; // srcY, radius, feather, pad
    let dpx2 = (fuv - h0.yz) * dim;
    let rpx = max(h1.y * dim.x, 1.0);
    let dist = length(dpx2);
    if (dist >= rpx) { continue; }
    let fw = clamp(h1.z, 0.02, 1.0);
    let w = 1.0 - smoothstep(rpx * (1.0 - fw), rpx, dist);
    let off = vec2f(h0.w, h1.x) - h0.yz;
    var cs = sample_source(fuv + off);
    if (h0.x > 0.5 && P.g.x > 0.5) {
      let rim = vec2f(h1.y * 1.35, h1.y * 1.35 * dim.x / dim.y);
      var ring = vec3f(0.0);
      for (var k = 0; k < 4; k++) {
        ring += blur_at(h0.yz + rims[k] * rim) - blur_at(vec2f(h0.w, h1.x) + rims[k] * rim);
      }
      cs = max(cs + ring * 0.25, vec3f(0.0));
    }
    rgb = mix(rgb, cs, w);
  }
  let srcLin = rgb; // pre-develop linear source (healed) — the pyramids' twin

  // 1. white balance: temp warms r / cools b; tint + = magenta (g down)
  rgb = rgb * wb_mul(P.a.y / 100.0, P.a.z / 100.0);

  // 2. exposure, scene-linear
  rgb = rgb * exp2(P.a.x);

  // 3. parametric tone: gains in stops over lz = log2(luma/0.18), so every
  //    control pivots at mid-gray; display white sits at lz ≈ 2.47. Zone
  //    masks are smoothsteps in stops; contrast is a saturating log-slope
  //    (±100 → ×2^±0.8 slope at the pivot, reach capped at ±1.5·(k−1) stops
  //    so extremes roll off instead of running away). Applying the summed
  //    stops as a scalar gain IS the luma ratio lumaOut/lumaIn = 2^stops —
  //    chroma-preserving with no divide to guard.
  let luma = dot(rgb, LW);
  let lz = log2(max(luma, 1e-6) / 0.18);
  rgb = rgb * exp2(tone_stops(lz, P.a.w, P.b.x, P.b.y, P.b.z, P.b.w));

  // 3.5 local contrast — log-luma unsharp masks vs. blurred-SOURCE pyramids.
  // Detail Δ = source lz − blurred lz is exposure/WB/tone-invariant, so the
  // masks don't shift as other sliders move; applied as a 2^Δstops gain —
  // chroma-preserving, same trick as tone. Aux textures hold the scene-linear
  // source; when lcOn=0 they may be 1×1 dummies and are never sampled.
  // lzS/lzLg/wMid outlive the block: per-mask clarity reuses the SAME unsharp
  var lzS = 0.0;
  var lzLg = 0.0;
  let wMid = exp(-lz * lz / (2.0 * 1.2 * 1.2));
  if (P.g.x > 0.5) {
    let bS = textureSampleLevel(blurSmall, samp, guv, 0.0).rgb;
    let bL = textureSampleLevel(blurLarge, samp, guv, 0.0).rgb;
    lzS = log2(max(dot(srcLin, LW), 1e-6) / 0.18);
    let lzSm = log2(max(dot(bS, LW), 1e-6) / 0.18);
    lzLg = log2(max(dot(bL, LW), 1e-6) / 0.18);
    // texture: fine detail vs σ_small; clarity: midtone-weighted vs σ_large
    // (Gaussian over lz, σ=1.2 stops — shadows/highlights aren't crunched)
    let dStops = 0.5 * (P.e.y / 100.0) * (lzS - lzSm)
               + 0.35 * (P.e.x / 100.0) * wMid * (lzS - lzLg);
    rgb = rgb * exp2(dStops);
    // dehaze: veil from blurLarge min-channel, airlight A = 1 fixed;
    // transmission clamped ≥0.1 and output ≥0. Negative side adds haze.
    let dh = P.e.z / 100.0;
    if (dh > 0.0) {
      let bLn = clamp(bL, vec3f(0.0), vec3f(1.0));
      let tr = 1.0 - 0.95 * dh * min(min(bLn.r, bLn.g), bLn.b);
      rgb = max((rgb - vec3f(1.0 - tr)) / max(tr, 0.1), vec3f(0.0));
    } else if (dh < 0.0) {
      rgb = mix(rgb, vec3f(0.8), -dh * 0.3);
    }
    // defringe: desaturate high-chroma purple/green pixels at strong luma
    // edges (edge = |source lz − blurSmall lz|); worker forces lcOn when on
    let dfr = P.l.w / 100.0;
    if (dfr > 0.0) {
      let edge = clamp(abs(lzS - lzSm) * 1.2, 0.0, 1.0);
      let labF = lin_to_oklab(rgb);
      let cF = length(labF.yz);
      if (cF > 1e-6) {
        var hueF = degrees(atan2(labF.z, labF.y));
        hueF = select(hueF, hueF + 360.0, hueF < 0.0);
        let dP = abs(hueF - 310.0);
        let dG = abs(hueF - 140.0);
        let wHue = max(1.0 - smoothstep(20.0, 45.0, min(dP, 360.0 - dP)),
                       1.0 - smoothstep(20.0, 45.0, min(dG, 360.0 - dG)));
        let wf = dfr * edge * wHue * smoothstep(0.02, 0.08, cF);
        if (wf > 0.0) { rgb = chroma_scale(rgb, 1.0 - 0.9 * wf); }
      }
    }
  }

  // 4.5 local masks — each enabled mask reapplies the global module math
  // scaled by its weight m (order mirrors the globals: WB → ev → tone →
  // clarity → saturation). Zero-filled slots have enabled=0 and are skipped;
  // sub-blocks gate on their own adjust so untouched pixels stay bit-exact.
  for (var mi = 0; mi < 8; mi++) {
    let r0 = M.m[mi * 6];
    if (r0.z < 0.5) { continue; }
    let m = mask_weight(mi, fuv, dim, srcLin);
    if (m <= 0.0) { continue; }
    let r2 = M.m[mi * 6 + 2]; // g5, ev, temp, contrast
    let r3 = M.m[mi * 6 + 3]; // highlights, shadows, saturation, clarity
    rgb = rgb * wb_mul(m * r2.z / 100.0, 0.0) * exp2(m * r2.y);
    if (r2.w != 0.0 || r3.x != 0.0 || r3.y != 0.0) {
      let lzm = log2(max(dot(rgb, LW), 1e-6) / 0.18);
      rgb = rgb * exp2(tone_stops(lzm, m * r2.w, m * r3.x, m * r3.y, 0.0, 0.0));
    }
    if (r3.w != 0.0 && P.g.x > 0.5) {
      rgb = rgb * exp2(0.35 * (m * r3.w / 100.0) * wMid * (lzS - lzLg));
    }
    if (r3.z != 0.0) {
      rgb = chroma_scale(rgb, max(1.0 + m * r3.z / 100.0, 0.0));
    }
  }

  // 5+6. OKLCh colormix + vibrance/saturation. Skipped when all-zero so the
  // lab round-trip cannot perturb untouched pixels.
  if (P.d.y > 0.5) {
    var centers = array<f32, 8>(25.0, 55.0, 90.0, 140.0, 195.0, 260.0, 300.0, 345.0);
    var lab = lin_to_oklab(rgb);
    var cc2 = length(lab.yz);
    // hue guard: atan2(0,0) is indeterminate; grays keep hue 0
    var hue = select(0.0, degrees(atan2(lab.z, lab.y)), cc2 > 1e-6);
    hue = select(hue, hue + 360.0, hue < 0.0);
    var hShift = 0.0;
    var cScale = 1.0;
    var lShift = 0.0;
    for (var i = 0; i < 8; i++) {
      let dd = abs(hue - centers[i]);
      // raised cosine over hue angle, zero at ±55° (half-power ±27.5°);
      // centers put sRGB primaries in-band (red 29°, green 143°, blue 269°)
      let w = 0.5 + 0.5 * cos(min(min(dd, 360.0 - dd) / 55.0, 1.0) * PI);
      let band = P.bands[i].xyz / 100.0;
      hShift += band.x * 30.0 * w;      // h ±100 → ±30° rotate
      cScale *= 1.0 + 0.6 * band.y * w; // s ±100 → chroma ×(1±0.6·w)
      lShift += band.z * 0.25 * w;      // l ±100 → L ±0.25·w
    }
    let presence = min(cc2 * 12.5, 1.0); // gray pixels: no L push from bands
    hue += hShift;
    cc2 *= max(cScale, 0.0);
    lab.x += lShift * presence;
    // saturation: uniform chroma scale; vibrance: gain weighted toward muted
    // colors (1 − C/0.35), skin hues 25–55° protected at factor 0.4
    let dSkin = abs(hue - 40.0);
    let skin = 0.5 + 0.5 * cos(min(min(dSkin, 360.0 - dSkin) / 30.0, 1.0) * PI);
    let vibW = (1.0 - min(cc2 / 0.35, 1.0)) * (1.0 - 0.6 * skin);
    cc2 *= max(1.0 + P.c.y / 100.0, 0.0) * max(1.0 + P.c.x / 100.0 * vibW, 0.0);
    let hr = radians(hue);
    rgb = max(oklab_to_lin(vec3f(lab.x, cc2 * cos(hr), cc2 * sin(hr))), vec3f(0.0));
  }

  // 6.2 B&W — after colormix (which the worker zeroes while on): base rec709
  // luma nudged ±50% per OKLCh hue band via the mix weights, scaled by band
  // membership and chroma presence (grays keep plain luma). Output is neutral
  // gray in linear light — grading applies after, so toned B&W works.
  if (P.k.y > 0.5) {
    var bwc = array<f32, 8>(25.0, 55.0, 90.0, 140.0, 195.0, 260.0, 300.0, 345.0);
    let labB = lin_to_oklab(rgb);
    let ccB = length(labB.yz);
    var hueB = select(0.0, degrees(atan2(labB.z, labB.y)), ccB > 1e-6);
    hueB = select(hueB, hueB + 360.0, hueB < 0.0);
    let presB = min(ccB * 12.5, 1.0);
    var fmix = 1.0;
    for (var i = 0; i < 8; i++) {
      let dd = abs(hueB - bwc[i]);
      let w = 0.5 + 0.5 * cos(min(min(dd, 360.0 - dd) / 55.0, 1.0) * PI);
      let mw = select(P.bw1[i & 3], P.bw0[i & 3], i < 4) / 100.0;
      fmix += mw * 0.5 * w * presB;
    }
    rgb = vec3f(max(dot(rgb, LW) * fmix, 0.0));
  }

  // 6.3 color grading — 3-way OKLab a/b offset by display-luma zone. Zone
  // weights come from sRGB-encoded luma: shadows below ~0.33, highlights
  // above ~0.66, midtones between; blending widens the smoothstep overlap,
  // balance shifts both pivots ±0.15. Chroma push is s/100·0.12 toward hue h,
  // scaled by zone weight only — NOT by pixel chroma: grading tints grays,
  // that is the point.
  if (P.k.x > 0.5) {
    let ld = linear_to_srgb(vec3f(clamp(dot(rgb, LW), 0.0, 1.0))).x;
    let soft = mix(0.08, 0.45, P.j.z / 100.0);
    let pv = 0.15 * P.j.w / 100.0;
    let wS = 1.0 - smoothstep(0.33 + pv - soft, 0.33 + pv + soft, ld);
    let wH = smoothstep(0.66 + pv - soft, 0.66 + pv + soft, ld);
    let wM = clamp(1.0 - wS - wH, 0.0, 1.0);
    var labG = lin_to_oklab(rgb);
    let cS = (P.i.y / 100.0) * 0.12 * wS;
    let cM = (P.i.w / 100.0) * 0.12 * wM;
    let cH = (P.j.y / 100.0) * 0.12 * wH;
    labG.y += cS * cos(radians(P.i.x)) + cM * cos(radians(P.i.z)) + cH * cos(radians(P.j.x));
    labG.z += cS * sin(radians(P.i.x)) + cM * sin(radians(P.i.z)) + cH * sin(radians(P.j.x));
    rgb = max(oklab_to_lin(labG), vec3f(0.0));
  }

  // 6.5 vignette — scene-referred radial exposure gain in post-crop frame
  // coords (uv is the cropped output frame). roundness 0 follows the frame
  // (uv-circle = frame-shaped ellipse); 100 is physically circular. r is
  // normalized so the far corner sits at 1; amount ±100 → ±1.2 stops there.
  if (P.f.x != 0.0) {
    let framed = P.k.w > 0.0;
    let frs = select(vec2f(1.0), vec2f(P.k.w, P.p2.w), framed);
    let fuv2 = select(in.uv, vec2f(P.d.z, P.d.w) + in.uv * frs, framed);
    let fwh = cwh * dim / frs;
    let ax = mix(1.0, fwh.x / fwh.y, clamp(P.f.z / 100.0, 0.0, 1.0));
    let dv = vec2f((fuv2.x - 0.5) * ax, fuv2.y - 0.5);
    let r = length(dv) / length(vec2f(0.5 * ax, 0.5));
    let inner = P.f.y / 100.0 * 0.7 + 0.15;
    let vt = smoothstep(inner, inner + 0.05 + 1.1 * P.f.w / 100.0, r);
    rgb = rgb * exp2(P.f.x / 100.0 * 1.2 * vt);
  }

  // 7. display transform: clamp + sRGB encode, or AgX
  var c: vec3f;
  if (P.d0.z > 0.5) {
    c = linear_to_srgb(dcp_tone(rgb * exp2(P.p2.y)));
  } else if (P.p2.x > 0.5) {
    c = linear_to_srgb(agx(rgb * exp2(P.p2.y), P.p2.z));
  } else {
    c = linear_to_srgb(clamp(rgb, vec3f(0.0), vec3f(1.0)));
  }

  // 4. point curve — display-referred, per channel like Lightroom's
  if (P.c.z > 0.5) {
    c = vec3f(curve_at(c.r), curve_at(c.g), curve_at(c.b));
  }
  c = clamp(c, vec3f(0.0), vec3f(1.0));

  // clip overlay: paint blown/crushed pixels (colors = --clip-hl/--clip-sh)
  if (P.d.x > 0.5) {
    if (max(max(c.r, c.g), c.b) >= 254.0 / 255.0) {
      c = vec3f(255.0, 59.0, 48.0) / 255.0;   // #ff3b30
    } else if (min(min(c.r, c.g), c.b) <= 1.0 / 255.0) {
      c = vec3f(47.0, 111.0, 237.0) / 255.0;  // #2f6fed
    }
  }

  return vec4f(c, 1.0);
}
