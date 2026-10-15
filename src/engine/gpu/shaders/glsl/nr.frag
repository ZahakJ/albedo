#version 300 es
// albedo à-trous wavelet denoise pass, WebGL2 backend — math twin of
// wgsl/nr.wgsl. One 1-D 5-tap B3-spline pass ([1 4 6 4 1]/16) at hole
// spacing; run H (combine=0: plain blur into tmp) then V (combine=1: finish
// the 2-D blur of tmp AND soft-threshold detail = orig − blur, split into
// luma + chroma residual, output the denoised level). Inputs are already
// scene-linear unflipped rgba16f — the chain is seeded by a radius-0 blur
// pass that decodes/unflips the source (see computeNR).
precision highp float;

uniform sampler2D img;  // blur input (a for H, tmp for V)
uniform sampler2D orig; // level a — detail reference (V only)
uniform vec2 dir;       // hole·(1/w, 0) or hole·(0, 1/h)
uniform float tl;       // luma soft-threshold, linear units (0 = luma passthrough)
uniform float tc;       // chroma soft-threshold, linear units
uniform float combine;  // 1 = V pass: threshold + reconstruct

in vec2 uv;
out vec4 outColor;

const vec3 LW = vec3(0.2126, 0.7152, 0.0722);

void main() {
  vec3 b = 0.375 * texture(img, uv).rgb
    + 0.25 * (texture(img, uv + dir).rgb + texture(img, uv - dir).rgb)
    + 0.0625 * (texture(img, uv + 2.0 * dir).rgb + texture(img, uv - 2.0 * dir).rgb);
  if (combine < 0.5) { outColor = vec4(b, 1.0); return; }
  vec3 d = texture(orig, uv).rgb - b;
  float dY = dot(d, LW);
  vec3 dC = d - vec3(dY); // chroma residual — luma-free (dot(LW, 1) = 1)
  float dYt = sign(dY) * max(abs(dY) - tl, 0.0);
  vec3 dCt = sign(dC) * max(abs(dC) - vec3(tc), 0.0);
  outColor = vec4(b + dCt + vec3(dYt), 1.0);
}
