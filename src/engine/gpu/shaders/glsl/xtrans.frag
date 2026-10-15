// albedo X-Trans front end, WebGL2 backend: exact math twin of
// wgsl/xtrans.wgsl. Compiled once per pass with "#define PASS n" prepended
// after the version line (1 prep, 2 hlr, 3 green, 4 final).
precision highp float;
precision highp int;
precision highp usampler2D;
precision highp sampler2D;

uniform usampler2D mosaic;
uniform sampler2D t0;
uniform sampler2D t1;
uniform vec3 camMul;
uniform vec3 clipLvl;
uniform vec3 chroma;
uniform mat3 camToSrgb;
uniform vec2 blackWhite;
uniform vec2 dims;
uniform float flipY;
uniform vec2 org;
uniform vec2 posOff;
uniform vec2 tdims;
uniform vec4 pat[9];      // colour of (y mod 6)·6 + (x mod 6): 0 R, 1 G, 2 B

out vec4 outColor;

const float EPS = 1e-6;

ivec2 refl(ivec2 q) {
  ivec2 d = ivec2(dims);
  ivec2 r = q;
  if (r.x < 0) r.x += 6 * ((-r.x + 5) / 6);
  if (r.y < 0) r.y += 6 * ((-r.y + 5) / 6);
  if (r.x >= d.x) r.x -= 6 * ((r.x - d.x + 6) / 6);
  if (r.y >= d.y) r.y -= 6 * ((r.y - d.y + 6) / 6);
  return clamp(r, ivec2(0), d - 1);
}

int color(ivec2 q) {
  int i = ((q.y % 6 + 6) % 6) * 6 + ((q.x % 6 + 6) % 6);
  return int(pat[i / 4][i % 4]);
}

float ch(vec3 v, int c) { return c == 0 ? v.x : (c == 1 ? v.y : v.z); }

ivec2 L(ivec2 q) { return clamp(refl(q) - ivec2(org), ivec2(0), ivec2(tdims) - 1); }
float C(ivec2 q) { return texelFetch(t0, L(q), 0).r; }
float G(ivec2 q) { return texelFetch(t1, L(q), 0).r; }

vec2 greenAlong(ivec2 q, ivec2 d) {
  for (int k = 1; k <= 3; k++) {
    ivec2 p = q + d * k;
    if (color(p) == 1) return vec2(C(p), float(k));
  }
  return vec2(0.0);
}

float guided(ivec2 q, int c, float g0) {
  float acc = 0.0;
  float wsum = 0.0;
  float s = max(g0, 1e-4);
  for (int dy = -3; dy <= 3; dy++) {
    for (int dx = -3; dx <= 3; dx++) {
      ivec2 p = q + ivec2(dx, dy);
      if (color(p) != c) continue;
      float gp = G(p);
      float dg = (gp - g0) / s;
      float w = 1.0 / ((1.0 + 0.35 * float(dx * dx + dy * dy)) * (0.02 + dg * dg));
      acc += w * (C(p) - gp);
      wsum += w;
    }
  }
  return g0 + acc / max(wsum, 1e-12);
}

void main() {
  ivec2 q = ivec2(gl_FragCoord.xy) + ivec2(posOff);
#if PASS == 1
  float raw = float(texelFetch(mosaic, ivec2(gl_FragCoord.xy), 0).r);
  outColor = vec4(max(0.0, (raw - blackWhite.x) / (blackWhite.y - blackWhite.x)) * ch(camMul, color(q)), 0.0, 0.0, 1.0);
#elif PASS == 2
  int c = color(q);
  float v = C(q);
  float r = v;
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
    if (cnt.x < 0.5) m.x = m.y;
    if (cnt.z < 0.5) m.z = m.y;
    vec3 opp = vec3(0.5 * (m.y + m.z), 0.5 * (m.x + m.z), 0.5 * (m.x + m.y));
    float o = ch(opp, c);
    r = max(v, o * o * o + ch(chroma, c));
  }
  outColor = vec4(r, 0.0, 0.0, 1.0);
#elif PASS == 3
  float c0 = C(q);
  float g = c0;
  if (color(q) != 1) {
    ivec2 dirs[4] = ivec2[4](ivec2(1, 0), ivec2(0, 1), ivec2(1, 1), ivec2(1, -1));
    float acc = 0.0;
    float wsum = 0.0;
    for (int i = 0; i < 4; i++) {
      ivec2 d = dirs[i];
      vec2 a = greenAlong(q, d);
      vec2 b = greenAlong(q, -d);
      if (a.y == 0.0 || b.y == 0.0) continue;
      float gi = (a.x * b.y + b.x * a.y) / (a.y + b.y);
      float grad = abs(a.x - b.x) / (a.y + b.y) + 0.5 * abs(C(q + d) - C(q - d))
        + 0.25 * abs(C(q + 2 * d) - C(q - 2 * d));
      float w = 1.0 / (EPS + grad * grad);
      acc += w * gi;
      wsum += w;
    }
    g = wsum > 0.0 ? acc / wsum : c0;
  }
  outColor = vec4(max(g, 0.0), 0.0, 0.0, 1.0);
#else
  if (flipY > 0.5) q.y = int(dims.y) - 1 - q.y;
  float g0 = G(q);
  int k = color(q);
  float r = k == 0 ? C(q) : guided(q, 0, g0);
  float b = k == 2 ? C(q) : guided(q, 2, g0);
  vec3 rgb = max(vec3(r, g0, b), vec3(0.0));
  outColor = vec4(max(camToSrgb * rgb, vec3(0.0)), 1.0);
#endif
}
