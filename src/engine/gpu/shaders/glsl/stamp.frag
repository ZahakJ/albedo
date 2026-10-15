#version 300 es
// albedo brush stamp pass, WebGL2 backend — math twin of wgsl/stamp.wgsl.
// Accumulates feathered gaussian disc stamps into ONE channel of the
// quarter-res rgba8 brush texture (channel picked via gl.colorMask). Normal
// strokes: shader outputs max(vᵢ), blended with glBlendEquation(MAX)
// (flow-accumulate). Erase strokes: shader outputs Π(1−vᵢ), blended with
// blendFunc(ZERO, SRC_COLOR) so dst multiplies down.
//
// Uniforms — ONE Float32Array(264), identical in both backends (layout
// comment in stamp.wgsl). Uses develop.vert: uv.y = 0 at gl_FragCoord.y = 0
// = texture row 0, which the brush convention defines as image TOP.
precision highp float;

uniform vec4 S;      // count, size (source-WIDTH-fraction diameter), flow, erase
uniform vec2 dims;   // srcW, srcH px
uniform vec4 PT[64]; // x, y (y-down source-normalized, pre-mirror), pressure, pad

in vec2 uv;
out vec4 outColor;

void main() {
  int n = int(S.x);
  vec2 aspect = vec2(1.0, dims.y / dims.x); // distances in width fractions
  float r = max(S.y * 0.5, 1e-5);
  bool erase = S.w > 0.5;
  float acc = erase ? 1.0 : 0.0;
  for (int i = 0; i < 64; i++) {
    if (i >= n) break;
    vec2 d = (uv - PT[i].xy) * aspect;
    // feathered gaussian falloff: ~1 at center, ~0.01 at the radius
    float v = clamp(S.z * PT[i].z * exp(-4.5 * dot(d, d) / (r * r)), 0.0, 1.0);
    acc = erase ? acc * (1.0 - v) : max(acc, v);
  }
  outColor = vec4(acc);
}
