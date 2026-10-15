// albedo demosaic + camera-color pass, WebGPU backend.
// Malvar-He-Cutler 5×5 on the 16-bit Bayer mosaic (r16uint), or passthrough
// for libraw-demosaiced RGB (rgba16uint/rgba8uint). Black subtract, WB, and
// the camera→sRGB matrix run in the same pass; output is linear working-space
// RGB into an rgba16f intermediate consumed by the develop pass. GLSL twin:
// glsl/demosaic.frag.

struct DParams {
  row0: vec3f, mode: f32,   // camera→sRGB rows; mode 0 = bayer, 1 = rgb
  row1: vec3f, black: f32,
  row2: vec3f, white: f32,
  camMul: vec3f, flipY: f32, // flipY: WebGL2 intermediate keeps v=0 = bottom
  cfa: vec2f, dims: vec2f,   // cfa: offset shifting RGGB onto the file's CFA
  srcGamma: f32,             // 1 = libraw BT.709-encoded input, decode it
  recon: f32,                // 1 = highlight reconstruction (clipped channels
                             // rebuilt from unclipped ones post-WB — no magenta)
  _p2: f32, _p3: f32,
}

@group(0) @binding(0) var img: texture_2d<u32>;
@group(0) @binding(1) var<uniform> P: DParams;

struct VOut { @builtin(position) pos: vec4f }

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  var out: VOut;
  let x = f32(i32(vi & 1u) * 4 - 1);
  let y = f32(i32(vi >> 1u) * 4 - 1);
  out.pos = vec4f(x, y, 0.0, 1.0);
  return out;
}

fn tap(q: vec2i) -> f32 {
  let c = clamp(q, vec2i(0), vec2i(i32(P.dims.x) - 1, i32(P.dims.y) - 1));
  return f32(textureLoad(img, c, 0).r);
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  var q = vec2i(in.pos.xy);
  if (P.flipY > 0.5) { q.y = i32(P.dims.y) - 1 - q.y; }

  var rgb: vec3f;
  if (P.mode > 0.5) {
    let c = clamp(q, vec2i(0), vec2i(i32(P.dims.x) - 1, i32(P.dims.y) - 1));
    rgb = vec3f(textureLoad(img, c, 0).rgb);
  } else {
    let px = (q.x + i32(P.cfa.x)) & 1;
    let py = (q.y + i32(P.cfa.y)) & 1;
    let c = tap(q);
    let h = tap(q + vec2i(-1, 0)) + tap(q + vec2i(1, 0));
    let v = tap(q + vec2i(0, -1)) + tap(q + vec2i(0, 1));
    let h2 = tap(q + vec2i(-2, 0)) + tap(q + vec2i(2, 0));
    let v2 = tap(q + vec2i(0, -2)) + tap(q + vec2i(0, 2));
    let d = tap(q + vec2i(-1, -1)) + tap(q + vec2i(1, -1))
          + tap(q + vec2i(-1, 1)) + tap(q + vec2i(1, 1));
    if (px == 0 && py == 0) {          // red site
      let g = (4.0 * c + 2.0 * (h + v) - h2 - v2) / 8.0;
      let b = (6.0 * c + 2.0 * d - 1.5 * (h2 + v2)) / 8.0;
      rgb = vec3f(c, g, b);
    } else if (px == 1 && py == 1) {   // blue site
      let g = (4.0 * c + 2.0 * (h + v) - h2 - v2) / 8.0;
      let r = (6.0 * c + 2.0 * d - 1.5 * (h2 + v2)) / 8.0;
      rgb = vec3f(r, g, c);
    } else if (px == 1) {              // green site, red row
      let r = (5.0 * c + 4.0 * h - h2 + 0.5 * v2 - d) / 8.0;
      let b = (5.0 * c + 4.0 * v - v2 + 0.5 * h2 - d) / 8.0;
      rgb = vec3f(r, c, b);
    } else {                           // green site, blue row
      let r = (5.0 * c + 4.0 * v - v2 + 0.5 * h2 - d) / 8.0;
      let b = (5.0 * c + 4.0 * h - h2 + 0.5 * v2 - d) / 8.0;
      rgb = vec3f(r, c, b);
    }
  }

  var lin = (rgb - vec3f(P.black)) / (P.white - P.black);
  if (P.srcGamma > 0.5) { // inverse Rec.709 OETF
    let lo = lin / 4.5;
    let hi = pow((lin + vec3f(0.099)) / 1.099, vec3f(1.0 / 0.45));
    lin = select(hi, lo, lin < vec3f(0.081));
  }
  // clip detect BEFORE WB: a channel at/near the sensor ceiling carries no
  // information; camMul then boosts r/b past g and blown areas go magenta
  let clipped = lin >= vec3f(0.95);
  lin = lin * P.camMul;
  if (P.recon > 0.5 && any(clipped)) {
    // pragmatic v1: a clipped channel takes the max of the OTHER channels
    // (already WB'd) — partially-blown pixels roll toward neutral white
    // instead of magenta; fully-blown pixels stay at the common ceiling
    let rec = vec3f(max(lin.g, lin.b), max(lin.r, lin.b), max(lin.r, lin.g));
    lin = select(lin, max(lin, rec), clipped);
  }
  lin = vec3f(dot(P.row0, lin), dot(P.row1, lin), dot(P.row2, lin));
  return vec4f(max(lin, vec3f(0.0)), 1.0);
}
