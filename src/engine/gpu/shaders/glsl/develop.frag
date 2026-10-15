#version 300 es
// albedo develop pass, WebGL2 backend — exact math twin of wgsl/develop.wgsl.
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
//        zeroes vibsat, colormix and mixOn while B&W is on) [14..15] pad
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
//   [74] healCount (0..32, healU below) [75] pad
//   [76..83] B&W mix weight per band, red..magenta (-100..100)
//   [84] lens distortion (-100..100)  [85] caRed  [86] caBlue (-100..100)
//   [87] defringe (0..100)  [88] lensOn (any of 84..87 nonzero)
//   [89] persp v (-100..100)  [90] persp h  [91] perspOn
//   [92] toneMap 0=clamp 1=AgX  [93] baseline EV (AgX only)
//   [94] look saturation (AgX only, 1 = neutral)  [95] pad
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
precision highp float;

uniform sampler2D img;
uniform sampler2D curveTex;  // 512×1 R32F LUT, NEAREST — lerp done in-shader
uniform sampler2D blurSmall; // scene-linear source, σ≈3px·resScale (full res)
uniform sampler2D blurLarge; // scene-linear source, σ≈40px·resScale (quarter res)
uniform sampler2D brushTex;  // quarter-res rgba8, 1×1 transparent dummy when unused
uniform vec4 P[32];
uniform vec4 M[48];          // masksU layout comment above
uniform vec4 Hl[64];         // healU layout comment above
uniform sampler2D patchTex;  // rgba8 patch atlas, unit 5, 1×1 dummy when unused
uniform vec4 Pt[48];         // patchU layout comment above
uniform sampler2D dnTex;     // AI-denoised capture, unit 6, 1×1 dummy when unused
uniform highp sampler3D hsvLut; // DCP HSV table, unit 7 (hue axis repeats)
uniform sampler2D toneTex;   // DCP tone curve, unit 8, 1024×1 R32F
uniform float inputIsLinear; // 1 = demosaic pass already delivered linear RGB
uniform float vFlip;         // 1 = texture is stored top-down (ImageBitmap uploads)

in vec2 uv;
out vec4 outColor;

vec3 srgbToLinear(vec3 c) {
  vec3 lo = c / 12.92;
  vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));
  return mix(hi, lo, lessThanEqual(c, vec3(0.04045)));
}

vec3 linearToSrgb(vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(hi, lo, lessThanEqual(c, vec3(0.0031308)));
}

// sign-safe cube root: camera matrices can push channels slightly negative
float cbrtS(float x) { return sign(x) * pow(abs(x), 1.0 / 3.0); }

// OKLab (Björn Ottosson's published sRGB matrices)
vec3 linToOklab(vec3 c) {
  float l = cbrtS(dot(vec3(0.4122214708, 0.5363325363, 0.0514459929), c));
  float m = cbrtS(dot(vec3(0.2119034982, 0.6806995451, 0.1073969566), c));
  float s = cbrtS(dot(vec3(0.0883024619, 0.2817188376, 0.6299787005), c));
  return vec3(
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s);
}

vec3 oklabToLin(vec3 lab) {
  float l = lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z; l = l * l * l;
  float m = lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z; m = m * m * m;
  float s = lab.x - 0.0894841775 * lab.y - 1.2914855480 * lab.z; s = s * s * s;
  return vec3(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
}

// LUT lookup with manual lerp between texels (parity with WGSL textureLoad)
float curveAt(float x) {
  float t = clamp(x, 0.0, 1.0) * 511.0;
  int i = int(t);
  float y0 = texelFetch(curveTex, ivec2(i, 0), 0).r;
  float y1 = texelFetch(curveTex, ivec2(min(i + 1, 511), 0), 0).r;
  return mix(y0, y1, t - float(i));
}

const float PI = 3.141592653589793;
const float CENTERS[8] = float[8](25.0, 55.0, 90.0, 140.0, 195.0, 260.0, 300.0, 345.0);
const vec3 LW = vec3(0.2126, 0.7152, 0.0722);
const vec2 RIMS[4] = vec2[4](vec2(1.0, 0.0), vec2(-1.0, 0.0), vec2(0.0, 1.0), vec2(0.0, -1.0));

// shared module math — global modules and per-mask reapplication use the SAME
// helpers so a mask at m=1 matches the global slider exactly
vec3 wbMul(float t, float ti) {
  return vec3(1.0 + 0.25 * t, 1.0 - 0.25 * ti, 1.0 - 0.25 * t);
}

float toneStops(float lz, float c, float hl, float sh, float wh, float bl) {
  float k = exp2(0.8 * c / 100.0);
  return (hl / 100.0) * smoothstep(0.0, 2.0, lz)           // highlights: >mid
    + (sh / 100.0) * smoothstep(0.0, 2.0, -lz)             // shadows: <mid
    + 0.75 * (wh / 100.0) * smoothstep(1.0, 2.47, lz)      // whites: top ~1.5 stops
    + 0.75 * (bl / 100.0) * smoothstep(2.0, 4.5, -lz)      // blacks: floor
    + (k - 1.0) * 1.5 * tanh(lz / 1.5);                    // contrast
}

// OKLCh chroma scale, hue/L preserved (per-mask saturation)
vec3 chromaScale(vec3 c, float s) {
  vec3 lab = linToOklab(c);
  return max(oklabToLin(vec3(lab.x, lab.y * s, lab.z * s)), 0.0);
}

// pre-mirror y-down source-normalized coord → linear rgb, single tap.
// textureLod (not texture): the heal loop calls this in non-uniform control
// flow, where implicit-derivative sampling is undefined; no mips exist.
vec3 srcAt(vec2 m) {
  vec2 g = vec2(mix(m.x, 1.0 - m.x, P[15].w), 1.0 - m.y);
  vec2 t = vec2(g.x, mix(g.y, 1.0 - g.y, vFlip));
  vec3 c = textureLod(img, t, 0.0).rgb;
  if (P[27].w > 0.0) c = mix(c, textureLod(dnTex, t, 0.0).rgb, P[27].w);
  return inputIsLinear > 0.5 ? c : srgbToLinear(c);
}

// source tap with lens CA: per-channel radial scale about the source center,
// ±0.5% at ±100 — red and blue each get their own tap when active
// ── DCP camera profile (twin of develop.wgsl) ───────────────────────────────
const mat3 REC709_TO_PP = mat3(
  0.529345874, 0.098374386, 0.016883197,
  0.330072825, 0.87346107, 0.117672492,
  0.140581278, 0.028164692, 0.865444313);
const mat3 PP_TO_REC709 = mat3(
  2.034076208, -0.228813442, -0.008569773,
  -0.727334325, 1.231730155, -0.153286613,
  -0.306741729, -0.0029169, 1.161856407);

vec3 dcpSource(vec3 rgb) {
  mat3 M = mat3(P[29].x, P[29].w, P[30].z, P[29].y, P[30].x, P[30].w, P[29].z, P[30].y, P[31].x);
  vec3 c = max(M * rgb, vec3(0.0));
  if (P[28].y < 0.5) return c;
  vec3 pp = max(REC709_TO_PP * c, vec3(0.0));
  float v = max(pp.r, max(pp.g, pp.b));
  if (v <= 0.0) return c;
  float mn = min(pp.r, min(pp.g, pp.b));
  float d = v - mn;
  float s = d / v;
  float h = 0.0;
  if (d > 0.0) {
    if (pp.r == v) { h = (pp.g - pp.b) / d; if (h < 0.0) h += 6.0; }
    else if (pp.g == v) h = 2.0 + (pp.b - pp.r) / d;
    else h = 4.0 + (pp.r - pp.g) / d;
  }
  vec3 dims = P[31].yzw;
  float vv = v;
  if (P[28].w > 0.5) vv = v > 0.0031308 ? 1.055 * pow(v, 1.0 / 2.4) - 0.055 : 12.92 * v;
  vec3 tc = vec3(
    (s * (dims.y - 1.0) + 0.5) / dims.y,
    h / 6.0 + 0.5 / dims.x,
    (clamp(vv, 0.0, 1.0) * max(dims.z - 1.0, 0.0) + 0.5) / dims.z);
  vec3 t = textureLod(hsvLut, tc, 0.0).rgb;
  float h2 = h + t.x * 6.0 / 360.0;
  h2 = h2 - 6.0 * floor(h2 / 6.0);
  float s2 = min(s * t.y, 1.0);
  float v2 = v * t.z;
  float i = floor(h2);
  float f = h2 - i;
  float p0 = v2 * (1.0 - s2);
  float q0 = v2 * (1.0 - s2 * f);
  float t0 = v2 * (1.0 - s2 * (1.0 - f));
  vec3 o;
  if (i < 1.0) o = vec3(v2, t0, p0);
  else if (i < 2.0) o = vec3(q0, v2, p0);
  else if (i < 3.0) o = vec3(p0, v2, t0);
  else if (i < 4.0) o = vec3(p0, q0, v2);
  else if (i < 5.0) o = vec3(t0, p0, v2);
  else o = vec3(v2, p0, q0);
  return max(PP_TO_REC709 * o, vec3(0.0));
}

float toneAt(float x) {
  float t = clamp(x, 0.0, 1.0) * 1023.0;
  int i = int(t);
  float y0 = texelFetch(toneTex, ivec2(i, 0), 0).r;
  float y1 = texelFetch(toneTex, ivec2(min(i + 1, 1023), 0), 0).r;
  return mix(y0, y1, t - float(i));
}

vec3 dcpTone(vec3 rgb) {
  vec3 pp = clamp(REC709_TO_PP * max(rgb, vec3(0.0)), 0.0, 1.0);
  float hi = max(pp.r, max(pp.g, pp.b));
  float lo = min(pp.r, min(pp.g, pp.b));
  float th = toneAt(hi);
  float tl = toneAt(lo);
  float k = hi > lo ? (th - tl) / (hi - lo) : 0.0;
  vec3 o = tl + (pp - vec3(lo)) * k;
  return clamp(PP_TO_REC709 * o, 0.0, 1.0);
}

// removal patches: the inpainted fill over the capture, feathered by alpha.
// The atlas is uploaded top row first, so v grows downward like WebGPU's.
vec3 patched(vec2 m, vec3 rgb) {
  vec3 c = rgb;
  for (int i = 0; i < 16; i++) {
    if (float(i) >= P[27].z) break;
    vec4 r = Pt[i * 3];
    vec2 t = (m - r.xy) / r.zw;
    if (any(lessThan(t, vec2(0.0))) || any(greaterThan(t, vec2(1.0)))) continue;
    vec4 a = Pt[i * 3 + 1];
    vec4 s = textureLod(patchTex, a.xy + t * a.zw, 0.0);
    c = mix(c, srgbToLinear(s.rgb) * Pt[i * 3 + 2].x, s.a);
  }
  return c;
}

vec3 sampleSource(vec2 m) {
  float kr = 1.0;
  float kb = 1.0;
  if (P[22].x > 0.5) {
    kr = 1.0 + P[21].y / 100.0 * 0.005;
    kb = 1.0 + P[21].z / 100.0 * 0.005;
  }
  // lens profile: TCA scales red and blue about the centre; vignetting is
  // undone on the capture itself, before any edit sees it
  float gain = 1.0;
  if (P[24].x > 0.5) {
    vec2 dim = vec2(textureSize(img, 0));
    float r = length((m - 0.5) * dim) / (0.5 * length(dim));
    kr *= P[25].y + r * (P[25].z + r * P[25].w);
    kb *= P[26].x + r * (P[26].y + r * P[26].z);
    float r2 = r * r;
    gain = 1.0 + r2 * (P[26].w + r2 * (P[27].x + r2 * P[27].y));
  }
  vec3 rgb = srcAt(m);
  if (kr != 1.0 || kb != 1.0) {
    rgb = vec3(srcAt(0.5 + (m - 0.5) * kr).r, rgb.g, srcAt(0.5 + (m - 0.5) * kb).b);
  }
  vec3 src = patched(m, rgb) / gain;
  if (P[28].x > 0.5) return dcpSource(src);
  return src;
}

// blurSmall tap at a pre-mirror coord (pyramids store the unflipped source)
vec3 blurAt(vec2 m) {
  vec2 g = vec2(mix(m.x, 1.0 - m.x, P[15].w), 1.0 - m.y);
  return textureLod(blurSmall, g, 0.0).rgb;
}

// mask weight at p = pre-mirror y-down source-normalized coord; dim = source
// px; srcLin = pre-develop linear source (range refinements evaluate on it)
float maskWeight(int i, vec2 p, vec2 dim, vec3 srcLin) {
  vec4 r0 = M[i * 6];
  vec4 r1 = M[i * 6 + 1];
  float m = 0.0;
  if (r0.x < 0.5) {
    // linear: smoothstep along the p0→p1 axis, aspect-corrected
    vec2 a = vec2(r0.w, r1.x);
    vec2 b = vec2(r1.y, r1.z);
    vec2 d = (b - a) * dim;
    vec2 q = (p - a) * dim;
    m = smoothstep(0.0, 1.0, dot(q, d) / max(dot(d, d), 1e-8));
  } else if (r0.x < 1.5) {
    // radial: elliptical falloff, rotated; feather eats inward from the edge
    vec2 c = vec2(r0.w, r1.x);
    vec2 rr = max(vec2(r1.y, r1.z), 1e-4) * dim.x; // width-normalized radii
    vec2 e = (p - c) * dim;
    float ca = cos(r1.w);
    float sa = sin(r1.w);
    vec2 u = vec2(ca * e.x + sa * e.y, -sa * e.x + ca * e.y);
    float dN = length(u / rr);
    float f = clamp(M[i * 6 + 2].x, 0.005, 1.0);
    m = 1.0 - smoothstep(1.0 - f, 1.0, dN);
  } else {
    // brush: bilinear tap of this mask's channel in the quarter-res stamp tex
    vec4 bt = textureLod(brushTex, p, 0.0);
    float ch = r0.w;
    m = ch < 0.5 ? bt.r : ch < 1.5 ? bt.g : ch < 2.5 ? bt.b : bt.a;
  }
  m = r0.y > 0.5 ? 1.0 - m : m; // invert flips
  // range refinement — luma window over the display-encoded source luma;
  // color = OKLCh hue/chroma proximity of the source; both multiply m
  vec4 r4 = M[i * 6 + 4];
  if (r4.x > 0.5) {
    float L = linearToSrgb(vec3(clamp(dot(srcLin, LW), 0.0, 1.0))).x;
    float sft = r4.w * 0.25 + 0.001;
    m *= smoothstep(r4.y - sft, r4.y, L) * (1.0 - smoothstep(r4.z, r4.z + sft, L));
  }
  vec4 r5 = M[i * 6 + 5];
  if (r5.x > 0.5) {
    vec3 lab = linToOklab(srcLin);
    float cc = length(lab.yz);
    float hue = cc > 1e-6 ? degrees(atan(lab.z, lab.y)) : 0.0;
    hue = hue < 0.0 ? hue + 360.0 : hue;
    float dh = abs(hue - r5.y);
    dh = min(dh, 360.0 - dh);
    float tolH = 12.0 + 0.68 * r5.w;
    float tolC = 0.04 + 0.0035 * r5.w;
    float wh = 1.0 - smoothstep(tolH * 0.6, tolH, dh);
    float wc = 1.0 - smoothstep(tolC, tolC * 2.5 + 0.02, abs(cc - r5.z));
    m *= r5.z < 0.02 ? wc : wh * wc; // near-gray target: hue is meaningless
  }
  return m;
}

// AgX (Troy Sobotka), the minimal fit by Benjamin Wrensch (MIT): inset
// matrix, log2 encoding over [-12.47, +4.03] stops around 0.18, a sixth-order
// sigmoid, outset matrix. Highlights roll off and desaturate toward white
// instead of clipping per channel. sat scales chroma in the encoded domain.
vec3 agxCurve(vec3 x) {
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
vec3 agx(vec3 lin, float sat) {
  mat3 inset = mat3(
    0.842479062253094, 0.0423282422610123, 0.0423756549057051,
    0.0784335999999992, 0.878468636469772, 0.0784336,
    0.0792237451477643, 0.0791661274605434, 0.879142973793104);
  mat3 outset = mat3(
    1.19687900512017, -0.0528968517574562, -0.0529716355144438,
    -0.0980208811401368, 1.15190312990417, -0.0980434501171241,
    -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
  const float lo = -12.47393;
  const float hi = 4.026069;
  vec3 v = inset * max(lin, vec3(1e-10));
  v = clamp(log2(max(v, vec3(1e-10))), vec3(lo), vec3(hi));
  v = agxCurve((v - lo) / (hi - lo));
  float y = dot(v, vec3(0.2126, 0.7152, 0.0722));
  v = y + sat * (v - y);
  v = outset * v;
  return clamp(pow(max(v, vec3(0.0)), vec3(2.2)), 0.0, 1.0);
}

void main() {
  // 0. geometry — inverse map in y-down source-normalized coords: un-crop
  // (p = cropXY + uv·cropWH) → rotate by -angle about the crop center in
  // pixel space → 1/fitScale auto-zoom → optional mirror. GL's y-up uv
  // converts at both ends; aux pyramids are source-space so they sample the
  // SAME guv below. R(θ) in y-down coords makes +angle rotate the image CCW
  // on screen.
  vec2 dim = vec2(textureSize(img, 0));
  vec2 cxy = vec2(P[14].z, P[14].w);
  vec2 cwh = vec2(P[15].x, P[15].y);
  vec2 cc = cxy + 0.5 * cwh;
  vec2 dpx = (cxy + vec2(uv.x, 1.0 - uv.y) * cwh - cc) * dim;
  float ca = cos(P[14].y);
  float sa = sin(P[14].y);
  // muv: pre-mirror = crop/mask space (affine)
  vec2 muv = cc + vec2(ca * dpx.x - sa * dpx.y, sa * dpx.x + ca * dpx.y) / (P[15].z * dim);

  // 0.5 perspective + lens distortion — inverse warps about the SOURCE
  // center, applied to the affine output (final source space): the loupe's
  // crop-slot fold stays exact because the warp anchor is fold-invariant.
  // Keystone: proper 3×3 homography [[1,0,0],[0,1,0],[2kh,2kv,1]] about the
  // center; +v narrows the frame top (converging verticals corrected).
  // Distortion: r' = r(1 + k1·r²·0.15), r normalized to the half-diagonal.
  vec2 fuv = muv;
  if (P[22].w > 0.5) {
    vec2 n = fuv - 0.5;
    float pw = max(1.0 + 2.0 * ((P[22].z / 100.0) * 0.3 * n.x + (P[22].y / 100.0) * 0.3 * n.y), 0.2);
    fuv = 0.5 + n / pw;
  }
  if (P[21].x != 0.0) {
    vec2 dd = (fuv - 0.5) * dim;
    float r2d = dot(dd, dd) / (0.25 * dot(dim, dim));
    fuv = 0.5 + (fuv - 0.5) * (1.0 + (P[21].x / 100.0) * r2d * 0.15);
  }
  // lens profile distortion, innermost: the capture itself is what bends
  if (P[24].x > 0.5) {
    float r = length((fuv - 0.5) * dim) / (0.5 * length(dim));
    fuv = 0.5 + (fuv - 0.5) * (1.0 + r * (P[24].y + r * (P[24].z + r * (P[24].w + r * P[25].x))));
  }
  // guv: post-mirror GL y-up texture/pyramid space of the final source coord
  vec2 suv = vec2(mix(fuv.x, 1.0 - fuv.x, P[15].w), fuv.y);
  vec2 guv = vec2(suv.x, 1.0 - suv.y);

  vec3 rgb = sampleSource(fuv);

  // 0.7 heal/clone spots — feathered circular clone in final source space;
  // 'heal' also matches the local low-frequency level: 4 blurSmall rim taps
  // (radius ×1.35, outside the blemish) around dest minus around source
  // (worker forces lcOn whenever a heal-mode spot exists)
  for (int i = 0; i < 32; i++) {
    if (float(i) >= P[18].z) break;
    vec4 h0 = Hl[i * 2];     // mode, destX, destY, srcX
    vec4 h1 = Hl[i * 2 + 1]; // srcY, radius, feather, pad
    vec2 dpx2 = (fuv - h0.yz) * dim;
    float rpx = max(h1.y * dim.x, 1.0);
    float dist = length(dpx2);
    if (dist >= rpx) continue;
    float fw = clamp(h1.z, 0.02, 1.0);
    float w = 1.0 - smoothstep(rpx * (1.0 - fw), rpx, dist);
    vec2 off = vec2(h0.w, h1.x) - h0.yz;
    vec3 cs = sampleSource(fuv + off);
    if (h0.x > 0.5 && P[14].x > 0.5) {
      vec2 rim = vec2(h1.y * 1.35, h1.y * 1.35 * dim.x / dim.y);
      vec3 ring = vec3(0.0);
      for (int k = 0; k < 4; k++) {
        ring += blurAt(h0.yz + RIMS[k] * rim) - blurAt(vec2(h0.w, h1.x) + RIMS[k] * rim);
      }
      cs = max(cs + ring * 0.25, 0.0);
    }
    rgb = mix(rgb, cs, w);
  }
  vec3 srcLin = rgb; // pre-develop linear source (healed) — the pyramids' twin

  // 1. white balance: temp warms r / cools b; tint + = magenta (g down)
  rgb *= wbMul(P[0].y / 100.0, P[0].z / 100.0);

  // 2. exposure, scene-linear
  rgb *= exp2(P[0].x);

  // 3. parametric tone: gains in stops over lz = log2(luma/0.18), so every
  //    control pivots at mid-gray; display white sits at lz ≈ 2.47. Zone
  //    masks are smoothsteps in stops; contrast is a saturating log-slope
  //    (±100 → ×2^±0.8 slope at the pivot, reach capped at ±1.5·(k−1) stops
  //    so extremes roll off instead of running away). Applying the summed
  //    stops as a scalar gain IS the luma ratio lumaOut/lumaIn = 2^stops —
  //    chroma-preserving with no divide to guard.
  float luma = dot(rgb, LW);
  float lz = log2(max(luma, 1e-6) / 0.18);
  rgb *= exp2(toneStops(lz, P[0].w, P[1].x, P[1].y, P[1].z, P[1].w));

  // 3.5 local contrast — log-luma unsharp masks vs. blurred-SOURCE pyramids.
  // Detail Δ = source lz − blurred lz is exposure/WB/tone-invariant, so the
  // masks don't shift as other sliders move; applied as a 2^Δstops gain —
  // chroma-preserving, same trick as tone. Aux textures hold the scene-linear
  // source; when lcOn=0 they may be 1×1 dummies and are never sampled.
  // lzS/lzLg/wMid outlive the block: per-mask clarity reuses the SAME unsharp
  float lzS = 0.0;
  float lzLg = 0.0;
  float wMid = exp(-lz * lz / (2.0 * 1.2 * 1.2));
  if (P[14].x > 0.5) {
    vec3 bS = textureLod(blurSmall, guv, 0.0).rgb;
    vec3 bL = textureLod(blurLarge, guv, 0.0).rgb;
    lzS = log2(max(dot(srcLin, LW), 1e-6) / 0.18);
    float lzSm = log2(max(dot(bS, LW), 1e-6) / 0.18);
    lzLg = log2(max(dot(bL, LW), 1e-6) / 0.18);
    // texture: fine detail vs σ_small; clarity: midtone-weighted vs σ_large
    // (Gaussian over lz, σ=1.2 stops — shadows/highlights aren't crunched)
    float dStops = 0.5 * (P[12].y / 100.0) * (lzS - lzSm)
                 + 0.35 * (P[12].x / 100.0) * wMid * (lzS - lzLg);
    rgb *= exp2(dStops);
    // dehaze: veil from blurLarge min-channel, airlight A = 1 fixed;
    // transmission clamped ≥0.1 and output ≥0. Negative side adds haze.
    float dh = P[12].z / 100.0;
    if (dh > 0.0) {
      vec3 bLn = clamp(bL, 0.0, 1.0);
      float tr = 1.0 - 0.95 * dh * min(min(bLn.r, bLn.g), bLn.b);
      rgb = max((rgb - (1.0 - tr)) / max(tr, 0.1), 0.0);
    } else if (dh < 0.0) {
      rgb = mix(rgb, vec3(0.8), -dh * 0.3);
    }
    // defringe: desaturate high-chroma purple/green pixels at strong luma
    // edges (edge = |source lz − blurSmall lz|); worker forces lcOn when on
    float dfr = P[21].w / 100.0;
    if (dfr > 0.0) {
      float edge = clamp(abs(lzS - lzSm) * 1.2, 0.0, 1.0);
      vec3 labF = linToOklab(rgb);
      float cF = length(labF.yz);
      if (cF > 1e-6) {
        float hueF = degrees(atan(labF.z, labF.y));
        hueF = hueF < 0.0 ? hueF + 360.0 : hueF;
        float dP = abs(hueF - 310.0);
        float dG = abs(hueF - 140.0);
        float wHue = max(1.0 - smoothstep(20.0, 45.0, min(dP, 360.0 - dP)),
                         1.0 - smoothstep(20.0, 45.0, min(dG, 360.0 - dG)));
        float wf = dfr * edge * wHue * smoothstep(0.02, 0.08, cF);
        if (wf > 0.0) rgb = chromaScale(rgb, 1.0 - 0.9 * wf);
      }
    }
  }

  // 4.5 local masks — each enabled mask reapplies the global module math
  // scaled by its weight m (order mirrors the globals: WB → ev → tone →
  // clarity → saturation). Zero-filled slots have enabled=0 and are skipped;
  // sub-blocks gate on their own adjust so untouched pixels stay bit-exact.
  for (int mi = 0; mi < 8; mi++) {
    vec4 r0 = M[mi * 6];
    if (r0.z < 0.5) continue;
    float m = maskWeight(mi, fuv, dim, srcLin);
    if (m <= 0.0) continue;
    vec4 r2 = M[mi * 6 + 2]; // g5, ev, temp, contrast
    vec4 r3 = M[mi * 6 + 3]; // highlights, shadows, saturation, clarity
    rgb *= wbMul(m * r2.z / 100.0, 0.0) * exp2(m * r2.y);
    if (r2.w != 0.0 || r3.x != 0.0 || r3.y != 0.0) {
      float lzm = log2(max(dot(rgb, LW), 1e-6) / 0.18);
      rgb *= exp2(toneStops(lzm, m * r2.w, m * r3.x, m * r3.y, 0.0, 0.0));
    }
    if (r3.w != 0.0 && P[14].x > 0.5) {
      rgb *= exp2(0.35 * (m * r3.w / 100.0) * wMid * (lzS - lzLg));
    }
    if (r3.z != 0.0) {
      rgb = chromaScale(rgb, max(1.0 + m * r3.z / 100.0, 0.0));
    }
  }

  // 5+6. OKLCh colormix + vibrance/saturation. Skipped when all-zero so the
  // lab round-trip cannot perturb untouched pixels.
  if (P[3].y > 0.5) {
    vec3 lab = linToOklab(rgb);
    float cc2 = length(lab.yz);
    // hue guard: atan(0,0) is indeterminate; grays keep hue 0
    float hue = cc2 > 1e-6 ? degrees(atan(lab.z, lab.y)) : 0.0;
    hue = hue < 0.0 ? hue + 360.0 : hue;
    float hShift = 0.0;
    float cScale = 1.0;
    float lShift = 0.0;
    for (int i = 0; i < 8; i++) {
      float dd = abs(hue - CENTERS[i]);
      // raised cosine over hue angle, zero at ±55° (half-power ±27.5°);
      // centers put sRGB primaries in-band (red 29°, green 143°, blue 269°)
      float w = 0.5 + 0.5 * cos(min(min(dd, 360.0 - dd) / 55.0, 1.0) * PI);
      vec3 band = P[4 + i].xyz / 100.0;
      hShift += band.x * 30.0 * w;      // h ±100 → ±30° rotate
      cScale *= 1.0 + 0.6 * band.y * w; // s ±100 → chroma ×(1±0.6·w)
      lShift += band.z * 0.25 * w;      // l ±100 → L ±0.25·w
    }
    float presence = min(cc2 * 12.5, 1.0); // gray pixels: no L push from bands
    hue += hShift;
    cc2 *= max(cScale, 0.0);
    lab.x += lShift * presence;
    // saturation: uniform chroma scale; vibrance: gain weighted toward muted
    // colors (1 − C/0.35), skin hues 25–55° protected at factor 0.4
    float dSkin = abs(hue - 40.0);
    float skin = 0.5 + 0.5 * cos(min(min(dSkin, 360.0 - dSkin) / 30.0, 1.0) * PI);
    float vibW = (1.0 - min(cc2 / 0.35, 1.0)) * (1.0 - 0.6 * skin);
    cc2 *= max(1.0 + P[2].y / 100.0, 0.0) * max(1.0 + P[2].x / 100.0 * vibW, 0.0);
    float hr = radians(hue);
    rgb = max(oklabToLin(vec3(lab.x, cc2 * cos(hr), cc2 * sin(hr))), 0.0);
  }

  // 6.2 B&W — after colormix (which the worker zeroes while on): base rec709
  // luma nudged ±50% per OKLCh hue band via the mix weights, scaled by band
  // membership and chroma presence (grays keep plain luma). Output is neutral
  // gray in linear light — grading applies after, so toned B&W works.
  if (P[18].y > 0.5) {
    vec3 labB = linToOklab(rgb);
    float ccB = length(labB.yz);
    float hueB = ccB > 1e-6 ? degrees(atan(labB.z, labB.y)) : 0.0;
    hueB = hueB < 0.0 ? hueB + 360.0 : hueB;
    float presB = min(ccB * 12.5, 1.0);
    float fmix = 1.0;
    for (int i = 0; i < 8; i++) {
      float dd = abs(hueB - CENTERS[i]);
      float w = 0.5 + 0.5 * cos(min(min(dd, 360.0 - dd) / 55.0, 1.0) * PI);
      float mw = P[19 + (i >> 2)][i & 3] / 100.0;
      fmix += mw * 0.5 * w * presB;
    }
    rgb = vec3(max(dot(rgb, LW) * fmix, 0.0));
  }

  // 6.3 color grading — 3-way OKLab a/b offset by display-luma zone. Zone
  // weights come from sRGB-encoded luma: shadows below ~0.33, highlights
  // above ~0.66, midtones between; blending widens the smoothstep overlap,
  // balance shifts both pivots ±0.15. Chroma push is s/100·0.12 toward hue h,
  // scaled by zone weight only — NOT by pixel chroma: grading tints grays,
  // that is the point.
  if (P[18].x > 0.5) {
    float ld = linearToSrgb(vec3(clamp(dot(rgb, LW), 0.0, 1.0))).x;
    float soft = mix(0.08, 0.45, P[17].z / 100.0);
    float pv = 0.15 * P[17].w / 100.0;
    float wS = 1.0 - smoothstep(0.33 + pv - soft, 0.33 + pv + soft, ld);
    float wH = smoothstep(0.66 + pv - soft, 0.66 + pv + soft, ld);
    float wM = clamp(1.0 - wS - wH, 0.0, 1.0);
    vec3 labG = linToOklab(rgb);
    float cS = (P[16].y / 100.0) * 0.12 * wS;
    float cM = (P[16].w / 100.0) * 0.12 * wM;
    float cH = (P[17].y / 100.0) * 0.12 * wH;
    labG.y += cS * cos(radians(P[16].x)) + cM * cos(radians(P[16].z)) + cH * cos(radians(P[17].x));
    labG.z += cS * sin(radians(P[16].x)) + cM * sin(radians(P[16].z)) + cH * sin(radians(P[17].x));
    rgb = max(oklabToLin(labG), 0.0);
  }

  // 6.5 vignette — scene-referred radial exposure gain in post-crop frame
  // coords (uv is the cropped output frame). roundness 0 follows the frame
  // (uv-circle = frame-shaped ellipse); 100 is physically circular. r is
  // normalized so the far corner sits at 1; amount ±100 → ±1.2 stops there.
  if (P[13].x != 0.0) {
    float ax = mix(1.0, (cwh.x * dim.x) / (cwh.y * dim.y), clamp(P[13].z / 100.0, 0.0, 1.0));
    vec2 dv = vec2((uv.x - 0.5) * ax, uv.y - 0.5);
    float r = length(dv) / length(vec2(0.5 * ax, 0.5));
    float inner = P[13].y / 100.0 * 0.7 + 0.15;
    float vt = smoothstep(inner, inner + 0.05 + 1.1 * P[13].w / 100.0, r);
    rgb *= exp2(P[13].x / 100.0 * 1.2 * vt);
  }

  // 7. display transform: clamp + sRGB encode, or AgX
  vec3 c;
  if (P[28].z > 0.5) {
    c = linearToSrgb(dcpTone(rgb * exp2(P[23].y)));
  } else if (P[23].x > 0.5) {
    c = linearToSrgb(agx(rgb * exp2(P[23].y), P[23].z));
  } else {
    c = linearToSrgb(clamp(rgb, 0.0, 1.0));
  }

  // 4. point curve — display-referred, per channel like Lightroom's
  if (P[2].z > 0.5) {
    c = vec3(curveAt(c.r), curveAt(c.g), curveAt(c.b));
  }
  c = clamp(c, 0.0, 1.0);

  // clip overlay: paint blown/crushed pixels (colors = --clip-hl/--clip-sh)
  if (P[3].x > 0.5) {
    if (max(max(c.r, c.g), c.b) >= 254.0 / 255.0) {
      c = vec3(255.0, 59.0, 48.0) / 255.0;   // #ff3b30
    } else if (min(min(c.r, c.g), c.b) <= 1.0 / 255.0) {
      c = vec3(47.0, 111.0, 237.0) / 255.0;  // #2f6fed
    }
  }

  outColor = vec4(c, 1.0);
}
