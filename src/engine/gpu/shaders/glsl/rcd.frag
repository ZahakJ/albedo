// albedo raw front end, WebGL2 backend: exact math twin of wgsl/rcd.wgsl.
// One source, compiled once per pass with "#define PASS n" prepended after
// the version line (1 prep, 2 hlr, 3 vh, 4 lpf, 5 green, 6 pq, 7 rb, 8 final,
// 9 dnblit: an AI-denoise tile into the denoised image, see rcd.wgsl).
// Intermediates are stored in mosaic orientation (row 0 = first sensor row);
// only the final pass flips into this backend's v=0 = bottom convention.
// Tiled exactly like the WGSL: intermediates cover one tile plus an apron
// (org, tdims), positions are image coordinates (posOff for intermediates).
precision highp float;
precision highp int;
precision highp usampler2D;
precision highp sampler2D;

uniform usampler2D mosaic;
uniform sampler2D t0;
uniform sampler2D t1;
uniform sampler2D t2;
uniform sampler2D t3;
uniform vec3 camMul;
uniform vec3 clipLvl;
uniform vec3 chroma;
uniform mat3 camToSrgb;   // rows applied as srgb = camToSrgb * cam
uniform vec2 blackWhite;
uniform vec2 cfa;
uniform vec2 dims;
uniform float flipY;
uniform vec2 org;
uniform vec2 posOff;
uniform vec2 tdims;

out vec4 outColor;

const float EPS = 1e-5;
const float EPSSQ = 1e-10;

ivec2 refl(ivec2 q) {
  ivec2 d = ivec2(dims);
  ivec2 r = abs(q);
  if (r.x >= d.x) r.x = 2 * (d.x - 1) - r.x;
  if (r.y >= d.y) r.y = 2 * (d.y - 1) - r.y;
  return clamp(r, ivec2(0), d - 1);
}

int color(ivec2 q) {
  int px = (q.x + int(cfa.x)) & 1;
  int py = (q.y + int(cfa.y)) & 1;
  if (px == 0 && py == 0) return 0;
  if (px == 1 && py == 1) return 2;
  return 1;
}

float ch(vec3 v, int c) { return c == 0 ? v.x : (c == 1 ? v.y : v.z); }

ivec2 L(ivec2 q) { return clamp(refl(q) - ivec2(org), ivec2(0), ivec2(tdims) - 1); }
float C(ivec2 q) { return texelFetch(t0, L(q), 0).r; }
float T1(ivec2 q) { return texelFetch(t1, L(q), 0).r; }
float T2(ivec2 q) { return texelFetch(t2, L(q), 0).r; }
float T3(ivec2 q) { return texelFetch(t3, L(q), 0).r; }

float intp(float a, float b, float c) { return a * (b - c) + c; }

float disc(ivec2 q) {
  float c = T3(q);
  float n = 0.25 * (T3(q + ivec2(-1, -1)) + T3(q + ivec2(1, -1)) + T3(q + ivec2(-1, 1)) + T3(q + ivec2(1, 1)));
  return abs(0.5 - c) < abs(0.5 - n) ? n : c;
}

float hpfV(ivec2 p) {
  float h = (C(p + ivec2(0, -3)) - C(p + ivec2(0, -1)) - C(p + ivec2(0, 1)) + C(p + ivec2(0, 3)))
    - 3.0 * (C(p + ivec2(0, -2)) + C(p + ivec2(0, 2))) + 6.0 * C(p);
  return h * h;
}
float hpfH(ivec2 p) {
  float h = (C(p + ivec2(-3, 0)) - C(p + ivec2(-1, 0)) - C(p + ivec2(1, 0)) + C(p + ivec2(3, 0)))
    - 3.0 * (C(p + ivec2(-2, 0)) + C(p + ivec2(2, 0))) + 6.0 * C(p);
  return h * h;
}
float hpfP(ivec2 p) {
  float h = (C(p + ivec2(-3, -3)) - C(p + ivec2(-1, -1)) - C(p + ivec2(1, 1)) + C(p + ivec2(3, 3)))
    - 3.0 * (C(p + ivec2(-2, -2)) + C(p + ivec2(2, 2))) + 6.0 * C(p);
  return h * h;
}
float hpfQ(ivec2 p) {
  float h = (C(p + ivec2(3, -3)) - C(p + ivec2(1, -1)) - C(p + ivec2(-1, 1)) + C(p + ivec2(-3, 3)))
    - 3.0 * (C(p + ivec2(2, -2)) + C(p + ivec2(-2, 2))) + 6.0 * C(p);
  return h * h;
}

float rbAt(ivec2 p, int c) { return color(p) == c ? C(p) : T2(p); }

float atGreen(ivec2 q, int c, float g0, float vh) {
  float n1 = EPS + abs(g0 - T1(q + ivec2(0, -2)));
  float s1 = EPS + abs(g0 - T1(q + ivec2(0, 2)));
  float w1 = EPS + abs(g0 - T1(q + ivec2(-2, 0)));
  float e1 = EPS + abs(g0 - T1(q + ivec2(2, 0)));
  float cn = rbAt(q + ivec2(0, -1), c); float cs = rbAt(q + ivec2(0, 1), c);
  float cw = rbAt(q + ivec2(-1, 0), c); float ce = rbAt(q + ivec2(1, 0), c);
  float sn = abs(cn - cs);
  float ew = abs(cw - ce);
  float nG = n1 + sn + abs(cn - rbAt(q + ivec2(0, -3), c));
  float sG = s1 + sn + abs(cs - rbAt(q + ivec2(0, 3), c));
  float wG = w1 + ew + abs(cw - rbAt(q + ivec2(-3, 0), c));
  float eG = e1 + ew + abs(ce - rbAt(q + ivec2(3, 0), c));
  float nE = cn - T1(q + ivec2(0, -1));
  float sE = cs - T1(q + ivec2(0, 1));
  float wE = cw - T1(q + ivec2(-1, 0));
  float eE = ce - T1(q + ivec2(1, 0));
  float vE = (nG * sE + sG * nE) / (nG + sG);
  float hE = (eG * wE + wG * eE) / (eG + wG);
  return g0 + intp(vh, hE, vE);
}

void main() {
  ivec2 q = ivec2(gl_FragCoord.xy) + ivec2(posOff);
  float r = 0.0;
#if PASS == 1
  float raw = float(texelFetch(mosaic, ivec2(gl_FragCoord.xy), 0).r);
  r = max(0.0, (raw - blackWhite.x) / (blackWhite.y - blackWhite.x)) * ch(camMul, color(q));
#elif PASS == 2
  int c = color(q);
  float v = C(q);
  r = v;
  if (v >= ch(clipLvl, c)) {
    vec3 sum = vec3(0.0);
    vec3 cnt = vec3(0.0);
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        ivec2 p = q + ivec2(dx, dy);
        int k = color(p);
        float s = C(p);
        if (k == 0) { sum.x += s; cnt.x += 1.0; }
        else if (k == 1) { sum.y += s; cnt.y += 1.0; }
        else { sum.z += s; cnt.z += 1.0; }
      }
    }
    vec3 m = pow(sum / max(cnt, vec3(1.0)), vec3(1.0 / 3.0));
    vec3 opp = vec3(0.5 * (m.y + m.z), 0.5 * (m.x + m.z), 0.5 * (m.x + m.y));
    float o = ch(opp, c);
    r = max(v, o * o * o + ch(chroma, c));
  }
#elif PASS == 3
  float v = max(EPSSQ, hpfV(q + ivec2(0, -1)) + hpfV(q) + hpfV(q + ivec2(0, 1)));
  float h = max(EPSSQ, hpfH(q + ivec2(-1, 0)) + hpfH(q) + hpfH(q + ivec2(1, 0)));
  r = v / (v + h);
#elif PASS == 4
  r = C(q)
    + 0.5 * (C(q + ivec2(0, -1)) + C(q + ivec2(0, 1)) + C(q + ivec2(-1, 0)) + C(q + ivec2(1, 0)))
    + 0.25 * (C(q + ivec2(-1, -1)) + C(q + ivec2(1, -1)) + C(q + ivec2(-1, 1)) + C(q + ivec2(1, 1)));
#elif PASS == 5
  float ci = C(q);
  r = ci;
  if (color(q) != 1) {
    float n1 = C(q + ivec2(0, -1)); float s1 = C(q + ivec2(0, 1));
    float w1 = C(q + ivec2(-1, 0)); float e1 = C(q + ivec2(1, 0));
    float nG = EPS + abs(n1 - s1) + abs(ci - C(q + ivec2(0, -2))) + abs(n1 - C(q + ivec2(0, -3))) + abs(C(q + ivec2(0, -2)) - C(q + ivec2(0, -4)));
    float sG = EPS + abs(n1 - s1) + abs(ci - C(q + ivec2(0, 2))) + abs(s1 - C(q + ivec2(0, 3))) + abs(C(q + ivec2(0, 2)) - C(q + ivec2(0, 4)));
    float wG = EPS + abs(w1 - e1) + abs(ci - C(q + ivec2(-2, 0))) + abs(w1 - C(q + ivec2(-3, 0))) + abs(C(q + ivec2(-2, 0)) - C(q + ivec2(-4, 0)));
    float eG = EPS + abs(w1 - e1) + abs(ci - C(q + ivec2(2, 0))) + abs(e1 - C(q + ivec2(3, 0))) + abs(C(q + ivec2(2, 0)) - C(q + ivec2(4, 0)));
    float l = T1(q);
    float nE = n1 * (l + l) / (EPS + l + T1(q + ivec2(0, -2)));
    float sE = s1 * (l + l) / (EPS + l + T1(q + ivec2(0, 2)));
    float wE = w1 * (l + l) / (EPS + l + T1(q + ivec2(-2, 0)));
    float eE = e1 * (l + l) / (EPS + l + T1(q + ivec2(2, 0)));
    float vE = (sG * nE + nG * sE) / (nG + sG);
    float hE = (wG * eE + eG * wE) / (eG + wG);
    r = intp(disc(q), hE, vE);
  }
#elif PASS == 6
  float p = max(EPSSQ, hpfP(q + ivec2(-1, -1)) + hpfP(q) + hpfP(q + ivec2(1, 1)));
  float k = max(EPSSQ, hpfQ(q + ivec2(1, -1)) + hpfQ(q) + hpfQ(q + ivec2(-1, 1)));
  r = p / (p + k);
#elif PASS == 7
  if (color(q) != 1) {
    float g0 = T1(q);
    float cNW = C(q + ivec2(-1, -1)); float cNE = C(q + ivec2(1, -1));
    float cSW = C(q + ivec2(-1, 1)); float cSE = C(q + ivec2(1, 1));
    float nwG = EPS + abs(cNW - cSE) + abs(cNW - C(q + ivec2(-3, -3))) + abs(g0 - T1(q + ivec2(-2, -2)));
    float neG = EPS + abs(cNE - cSW) + abs(cNE - C(q + ivec2(3, -3))) + abs(g0 - T1(q + ivec2(2, -2)));
    float swG = EPS + abs(cNE - cSW) + abs(cSW - C(q + ivec2(-3, 3))) + abs(g0 - T1(q + ivec2(-2, 2)));
    float seG = EPS + abs(cNW - cSE) + abs(cSE - C(q + ivec2(3, 3))) + abs(g0 - T1(q + ivec2(2, 2)));
    float nwE = cNW - T1(q + ivec2(-1, -1));
    float neE = cNE - T1(q + ivec2(1, -1));
    float swE = cSW - T1(q + ivec2(-1, 1));
    float seE = cSE - T1(q + ivec2(1, 1));
    float pE = (nwG * seE + seG * nwE) / (nwG + seG);
    float qE = (neG * swE + swG * neE) / (neG + swG);
    r = g0 + intp(disc(q), qE, pE);
  }
#endif
#if PASS == 9
  // this backend stores the image bottom row first; the tile is top first
  ivec2 fq = ivec2(gl_FragCoord.xy);
  ivec2 mq = ivec2(fq.x, int(dims.y) - 1 - fq.y);
  vec3 cam = texelFetch(t0, mq - ivec2(org), 0).rgb;
  vec3 base = texelFetch(t1, fq, 0).rgb;
  vec3 wb = max(cam * camMul, vec3(0.0));
  vec3 lin = max(camToSrgb * wb, vec3(0.0));
  float clip = smoothstep(0.9, 0.98, max(cam.r, max(cam.g, cam.b)));
  outColor = vec4(mix(lin, base, clip), 1.0);
#elif PASS == 8
  if (flipY > 0.5) q.y = int(dims.y) - 1 - q.y;
  float g0 = T1(q);
  vec3 rgb;
  int k = color(q);
  if (k == 0) rgb = vec3(C(q), g0, T2(q));
  else if (k == 2) rgb = vec3(T2(q), g0, C(q));
  else {
    float vh = disc(q);
    rgb = vec3(atGreen(q, 0, g0, vh), g0, atGreen(q, 2, g0, vh));
  }
  rgb = max(rgb, vec3(0.0));
  outColor = vec4(max(camToSrgb * rgb, vec3(0.0)), 1.0);
#else
  outColor = vec4(r, 0.0, 0.0, 1.0);
#endif
}
