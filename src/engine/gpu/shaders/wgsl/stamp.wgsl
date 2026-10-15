// albedo brush stamp pass, WebGPU backend — math twin of glsl/stamp.frag.
// Accumulates feathered gaussian disc stamps into ONE channel of the
// quarter-res rgba8 brush texture (channel picked by the pipeline's color
// write mask). Normal strokes: shader outputs max(vᵢ) and the pipeline
// MAX-blends onto dst (flow-accumulate). Erase strokes: shader outputs
// Π(1−vᵢ) and the pipeline multiplies it down (dst·src).
//
// Uniforms — ONE Float32Array(264), identical in both backends:
//   [0] count ≤64  [1] size (stamp DIAMETER as a source-WIDTH fraction)
//   [2] flow       [3] erase
//   [4] srcW px    [5] srcH px  [6..7] pad
//   [8+4i .. 10+4i] x, y (y-down source-normalized, pre-mirror), pressure
// uv convention: uv.y = 0 at texture row 0 = image TOP (matches develop's
// pre-mirror mask space, so the develop pass samples brushTex at muv as-is).

struct SParams {
  s: vec4f,               // count, size, flow, erase
  dims: vec4f,            // srcW, srcH, pad, pad
  pts: array<vec4f, 64>,  // x, y, pressure, pad
}

@group(0) @binding(0) var<uniform> U: SParams;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  var out: VOut;
  let x = f32(i32(vi & 1u) * 4 - 1);
  let y = f32(i32(vi >> 1u) * 4 - 1);
  out.pos = vec4f(x, y, 0.0, 1.0);
  out.uv = vec2f(x * 0.5 + 0.5, 0.5 - y * 0.5);
  return out;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  let n = i32(U.s.x);
  let aspect = vec2f(1.0, U.dims.y / U.dims.x); // distances in width fractions
  let r = max(U.s.y * 0.5, 1e-5);
  let erase = U.s.w > 0.5;
  var acc = select(0.0, 1.0, erase);
  for (var i = 0; i < 64; i++) {
    if (i >= n) { break; }
    let d = (in.uv - U.pts[i].xy) * aspect;
    // feathered gaussian falloff: ~1 at center, ~0.01 at the radius
    let v = clamp(U.s.z * U.pts[i].z * exp(-4.5 * dot(d, d) / (r * r)), 0.0, 1.0);
    acc = select(max(acc, v), acc * (1.0 - v), erase);
  }
  return vec4f(acc);
}
