#version 300 es
// albedo finish pass, WebGL2 backend — math twin of wgsl/finish.wgsl.
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
precision highp float;

uniform sampler2D img;
uniform sampler2D brushTex; // quarter-res rgba8, dummy when unused
uniform vec4 F[12];

in vec2 uv;
out vec4 outColor;

const vec3 LW = vec3(0.2126, 0.7152, 0.0722);

// portable integer hash (pcg-ish u32 mix) — bit-identical in WGSL/GLSL, no
// fract-sin (its precision differs across drivers). Input: integer lattice
// coords as floats (post-floor); negatives wrap through two's complement.
float hash21(vec2 p) {
  uint h = uint(int(p.x)) * 1597334677u + uint(int(p.y)) * 3812015801u;
  h = (h ^ (h >> 16u)) * 2246822519u;
  h = (h ^ (h >> 13u)) * 3266489917u;
  h = h ^ (h >> 16u);
  return float(h >> 8u) * (1.0 / 16777216.0);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// selected-mask weight — math twin of develop's maskWeight over F[4..7]
// (geometric part only; range refinement needs the source and stays in
// develop — the wash approximates)
float washWeight(vec2 p, vec2 dim) {
  float m = 0.0;
  if (F[4].x < 0.5) {
    vec2 a = vec2(F[4].w, F[5].x);
    vec2 b = vec2(F[5].y, F[5].z);
    vec2 d = (b - a) * dim;
    vec2 q = (p - a) * dim;
    m = smoothstep(0.0, 1.0, dot(q, d) / max(dot(d, d), 1e-8));
  } else if (F[4].x < 1.5) {
    vec2 c = vec2(F[4].w, F[5].x);
    vec2 rr = max(vec2(F[5].y, F[5].z), 1e-4) * dim.x;
    vec2 e = (p - c) * dim;
    float ca = cos(F[5].w);
    float sa = sin(F[5].w);
    vec2 u = vec2(ca * e.x + sa * e.y, -sa * e.x + ca * e.y);
    float f = clamp(F[6].x, 0.005, 1.0);
    m = 1.0 - smoothstep(1.0 - f, 1.0, length(u / rr));
  } else {
    vec4 bt = textureLod(brushTex, p, 0.0);
    float ch = F[4].w;
    m = ch < 0.5 ? bt.r : ch < 1.5 ? bt.g : ch < 2.5 ? bt.b : bt.a;
  }
  return F[4].y > 0.5 ? 1.0 - m : m;
}

void main() {
  vec2 texel = 1.0 / vec2(textureSize(img, 0));
  vec3 c = texture(img, uv).rgb;
  float L = dot(c, LW);
  int r = int(clamp(ceil(2.5 * F[0].y), 1.0, 4.0));
  float s2 = 2.0 * F[0].y * F[0].y;
  float acc = 0.0;
  float sum = 0.0;
  for (int y = -4; y <= 4; y++) {
    for (int x = -4; x <= 4; x++) {
      if (abs(x) > r || abs(y) > r) continue;
      float w = exp(-float(x * x + y * y) / s2);
      acc += w * dot(texture(img, uv + vec2(float(x), float(y)) * texel).rgb, LW);
      sum += w;
    }
  }
  float d = L - acc / sum;
  // masking: edge-gated weight; maskT=0 → 1 (smoothstep(0,0,·) is undefined)
  float wM = 1.0;
  if (F[0].z > 0.0) { wM = smoothstep(F[0].z, F[0].z * 3.0, abs(d)); }
  if (F[0].w > 0.5) { outColor = vec4(vec3(wM), 1.0); return; } // Alt-drag mask preview
  float Ls = L + (F[0].x / 100.0) * 1.5 * d * wM;
  // hue-preserving: scale RGB by the luma ratio, guarded near black
  vec3 o = clamp(c * (max(Ls, 0.0) / max(L, 1e-4)), 0.0, 1.0);
  // shared inverse geometry map (convert GL uv to y-down) — grain + wash;
  // the keystone + distortion warps mirror develop so both stay glued
  vec2 muv = vec2(0.0);
  vec2 dim = vec2(F[1].z, F[1].w);
  if (F[1].y > 0.5 || F[10].x > 0.0) {
    vec2 cxy = vec2(F[2].y, F[2].z);
    vec2 cwh = vec2(F[2].w, F[3].x);
    vec2 cc2 = cxy + 0.5 * cwh;
    vec2 uvd = vec2(uv.x, 1.0 - uv.y);
    vec2 dpx = (cxy + uvd * cwh - cc2) * dim;
    float ca = cos(F[2].x);
    float sa = sin(F[2].x);
    muv = cc2 + vec2(ca * dpx.x - sa * dpx.y, sa * dpx.x + ca * dpx.y) / (F[3].y * dim);
    if (F[3].z != 0.0 || F[3].w != 0.0) {
      vec2 n = muv - 0.5;
      float pw = max(1.0 + 2.0 * ((F[3].w / 100.0) * 0.3 * n.x + (F[3].z / 100.0) * 0.3 * n.y), 0.2);
      muv = 0.5 + n / pw;
    }
    if (F[10].w != 0.0) {
      vec2 dd = (muv - 0.5) * dim;
      float r2d = dot(dd, dd) / (0.25 * dot(dim, dim));
      muv = 0.5 + (muv - 0.5) * (1.0 + (F[10].w / 100.0) * r2d * 0.15);
    }
  }
  // film grain — value noise on the SOURCE pixel lattice (cell = F[10].y px),
  // two octaves mixed by roughness, midtone-weighted (fades in blacks and
  // whites), amount 0..100 → ±0.06 max deviation. Deterministic.
  if (F[10].x > 0.0) {
    vec2 sp = muv * dim / max(F[10].y, 1e-3);
    float n1 = vnoise(sp);
    float n2 = vnoise(sp * 2.0 + vec2(37.0, 17.0));
    float n = mix(n1, 0.5 * (n1 + n2), F[10].z);
    float Lg = dot(o, LW);
    float wG = smoothstep(0.0, 0.2, Lg) * (1.0 - smoothstep(0.75, 1.0, Lg));
    o = clamp(o + vec3((F[10].x / 100.0) * 0.06 * (2.0 * n - 1.0) * wG), 0.0, 1.0);
  }
  // clip overlay: paint blown/crushed pixels (colors match develop.frag)
  if (F[1].x > 0.5) {
    if (max(max(o.r, o.g), o.b) >= 254.0 / 255.0) {
      o = vec3(255.0, 59.0, 48.0) / 255.0;   // #ff3b30
    } else if (min(min(o.r, o.g), o.b) <= 1.0 / 255.0) {
      o = vec3(47.0, 111.0, 237.0) / 255.0;  // #2f6fed
    }
  }
  // mask wash — evaluated at the same pre-mirror source coordinate
  if (F[1].y > 0.5) {
    o = mix(o, vec3(232.0, 77.0, 77.0) / 255.0, 0.4 * washWeight(muv, dim)); // #e84d4d
  }
  // split-view divider — 1px neutral line at the split position (the two
  // halves were composited by the develop draws; y-down image coords)
  if (F[11].x > 0.5) {
    vec2 uvd2 = vec2(uv.x, 1.0 - uv.y);
    float t = F[11].x < 1.5 ? uvd2.x : uvd2.y;
    float px = F[11].x < 1.5 ? texel.x : texel.y;
    if (abs(t - F[11].y) < 0.6 * px) { o = vec3(0.5); }
  }
  outColor = vec4(o, 1.0);
}
