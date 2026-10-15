#version 300 es
// albedo demosaic + camera-color pass, WebGL2 backend — exact math twin of
// wgsl/demosaic.wgsl. flipY=1 here: the rgba16f intermediate keeps this
// backend's v=0 = image-bottom convention while demosaic runs in image space.
precision highp float;
precision highp usampler2D;

uniform usampler2D img;
uniform mat3 camToSrgb;   // rows applied as srgb = camToSrgb * cam
uniform vec3 camMul;
uniform vec2 blackWhite;
uniform vec2 cfa;
uniform vec2 dims;
uniform float mode;       // 0 = bayer, 1 = rgb passthrough
uniform float flipY;
uniform float srcGamma;   // 1 = libraw BT.709-encoded input, decode it
uniform float recon;      // 1 = highlight reconstruction (clipped channels
                          // rebuilt from unclipped ones post-WB — no magenta)

out vec4 outColor;

float tap(ivec2 q) {
  ivec2 c = clamp(q, ivec2(0), ivec2(dims) - 1);
  return float(texelFetch(img, c, 0).r);
}

void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  if (flipY > 0.5) q.y = int(dims.y) - 1 - q.y;

  vec3 rgb;
  if (mode > 0.5) {
    ivec2 c = clamp(q, ivec2(0), ivec2(dims) - 1);
    rgb = vec3(texelFetch(img, c, 0).rgb);
  } else {
    int px = (q.x + int(cfa.x)) & 1;
    int py = (q.y + int(cfa.y)) & 1;
    float c = tap(q);
    float h = tap(q + ivec2(-1, 0)) + tap(q + ivec2(1, 0));
    float v = tap(q + ivec2(0, -1)) + tap(q + ivec2(0, 1));
    float h2 = tap(q + ivec2(-2, 0)) + tap(q + ivec2(2, 0));
    float v2 = tap(q + ivec2(0, -2)) + tap(q + ivec2(0, 2));
    float d = tap(q + ivec2(-1, -1)) + tap(q + ivec2(1, -1))
            + tap(q + ivec2(-1, 1)) + tap(q + ivec2(1, 1));
    if (px == 0 && py == 0) {          // red site
      float g = (4.0 * c + 2.0 * (h + v) - h2 - v2) / 8.0;
      float b = (6.0 * c + 2.0 * d - 1.5 * (h2 + v2)) / 8.0;
      rgb = vec3(c, g, b);
    } else if (px == 1 && py == 1) {   // blue site
      float g = (4.0 * c + 2.0 * (h + v) - h2 - v2) / 8.0;
      float r = (6.0 * c + 2.0 * d - 1.5 * (h2 + v2)) / 8.0;
      rgb = vec3(r, g, c);
    } else if (px == 1) {              // green site, red row
      float r = (5.0 * c + 4.0 * h - h2 + 0.5 * v2 - d) / 8.0;
      float b = (5.0 * c + 4.0 * v - v2 + 0.5 * h2 - d) / 8.0;
      rgb = vec3(r, c, b);
    } else {                           // green site, blue row
      float r = (5.0 * c + 4.0 * v - v2 + 0.5 * h2 - d) / 8.0;
      float b = (5.0 * c + 4.0 * h - h2 + 0.5 * v2 - d) / 8.0;
      rgb = vec3(r, c, b);
    }
  }

  vec3 lin = (rgb - blackWhite.x) / (blackWhite.y - blackWhite.x);
  if (srcGamma > 0.5) { // inverse Rec.709 OETF
    vec3 lo = lin / 4.5;
    vec3 hi = pow((lin + 0.099) / 1.099, vec3(1.0 / 0.45));
    lin = mix(hi, lo, vec3(lessThan(lin, vec3(0.081))));
  }
  // clip detect BEFORE WB: a channel at/near the sensor ceiling carries no
  // information; camMul then boosts r/b past g and blown areas go magenta
  bvec3 clipped = greaterThanEqual(lin, vec3(0.95));
  lin *= camMul;
  if (recon > 0.5 && any(clipped)) {
    // pragmatic v1: a clipped channel takes the max of the OTHER channels
    // (already WB'd) — partially-blown pixels roll toward neutral white
    // instead of magenta; fully-blown pixels stay at the common ceiling
    vec3 rec = vec3(max(lin.g, lin.b), max(lin.r, lin.b), max(lin.r, lin.g));
    lin = mix(lin, max(lin, rec), vec3(clipped));
  }
  lin = camToSrgb * lin;
  outColor = vec4(max(lin, 0.0), 1.0);
}
