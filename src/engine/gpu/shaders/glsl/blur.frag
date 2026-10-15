#version 300 es
// albedo separable Gaussian blur pass, WebGL2 backend — math twin of
// wgsl/blur.wgsl. One 1-D pass; run H then V for the 2-D Gaussian.
// radius 0 = single-tap resample (the 2× downsample steps feeding the
// quarter-res large blur; LINEAR filtering makes each tap a 2×2 box).
// The first pass of a chain samples the raw source: vFlip resolves
// ImageBitmap orientation, linearize decodes sRGB — every aux texture the
// develop pass consumes is scene-linear, matching its own decode.
precision highp float;

uniform sampler2D img;
uniform vec2 dir;        // one input-texel step in uv units: (1/w,0) or (0,1/h)
uniform float sigma;     // in input texels; unused when radius == 0
uniform float radius;    // taps each side; capped at 64 by the loop bound
uniform float vFlip;     // 1 = input stored top-down (ImageBitmap uploads)
uniform float linearize; // 1 = input is sRGB-encoded, decode per tap

in vec2 uv;
out vec4 outColor;

vec3 srgbToLinear(vec3 c) {
  vec3 lo = c / 12.92;
  vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));
  return mix(hi, lo, lessThanEqual(c, vec3(0.04045)));
}

vec3 tap(vec2 p) {
  vec3 c = texture(img, vec2(p.x, mix(p.y, 1.0 - p.y, vFlip))).rgb;
  return linearize > 0.5 ? srgbToLinear(c) : c;
}

void main() {
  int r = int(radius);
  vec3 acc = tap(uv);
  float sum = 1.0;
  float s2 = 2.0 * sigma * sigma;
  for (int i = 1; i <= 64; i++) {
    if (i > r) break;
    float w = exp(-float(i * i) / s2);
    acc += w * (tap(uv + float(i) * dir) + tap(uv - float(i) * dir));
    sum += 2.0 * w;
  }
  outColor = vec4(acc / sum, 1.0);
}
