// Compose: the brush engine.
//
// A stroke stamps dabs into a stroke buffer (coverage, or colour for clone
// and heal), then resolves the touched rectangle from a snapshot of the
// target taken when the stroke began: target = f(snapshot, buffer). So the
// stroke's opacity caps the stroke as in Photoshop, flow builds up inside it,
// and the layer always shows the live result. Smudge works dab by dab on the
// target itself. Heal finishes a clone stroke by spreading the boundary
// difference inward (pull-push), which matches tone and colour to the area
// around it.

struct Dab {
  pos: vec4f,   // x, y (target px), radius (px), hardness 0..1
  k: vec4f,     // flow (0..1), sample offset x, y (px, clone), angle (unused)
}
struct DabU {
  n: vec4f,         // count, target w, h, pad
  dabs: array<Dab, 64>,
}

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var srcTex: texture_2d<f32>;  // clone source / snapshot
@group(0) @binding(2) var bufTex: texture_2d<f32>;  // stroke buffer
@group(0) @binding(3) var<uniform> D: DabU;

struct DOut {
  @builtin(position) p: vec4f,
  @location(0) local: vec2f,   // −1..1 across the dab
  @location(1) @interpolate(flat) i: u32,
}

@vertex
fn vs_dab(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> DOut {
  let corners = array<vec2f, 6>(vec2f(-1, -1), vec2f(1, -1), vec2f(-1, 1), vec2f(1, -1), vec2f(1, 1), vec2f(-1, 1));
  let d = D.dabs[i];
  let c = corners[v];
  let r = d.pos.z + 1.0;
  let t = d.pos.xy + c * r;
  var o: DOut;
  o.p = vec4f(t.x / D.n.y * 2.0 - 1.0, 1.0 - t.y / D.n.z * 2.0, 0.0, 1.0);
  o.local = c * r / max(d.pos.z, 1e-3);
  o.i = i;
  return o;
}

// soft round tip: 1 inside radius·hardness, smooth falloff to the rim
fn falloff(local: vec2f, hard: f32) -> f32 {
  let r = length(local);
  if (r >= 1.0) { return 0.0; }
  let h = clamp(hard, 0.0, 0.99);
  let x = clamp((r - h) / (1.0 - h), 0.0, 1.0);
  return 1.0 - x * x * (3.0 - 2.0 * x);
}

// coverage dabs (blend: one, one-minus-src → union of coverage)
@fragment
fn fs_dab_cov(in: DOut) -> @location(0) vec4f {
  let d = D.dabs[in.i];
  let a = falloff(in.local, d.pos.w) * d.k.x;
  return vec4f(a);
}

// clone dabs: the source under the dab, offset (blend: premultiplied over)
@fragment
fn fs_dab_clone(in: DOut) -> @location(0) vec4f {
  let d = D.dabs[in.i];
  let a = falloff(in.local, d.pos.w) * d.k.x;
  let src = in.p.xy + d.k.yz;
  let dim = vec2f(textureDimensions(srcTex));
  let c = textureSampleLevel(srcTex, samp, src / dim, 0.0);
  let inside = all(src >= vec2f(0.0)) && all(src < dim);
  return select(vec4f(0.0), c * a, inside);
}

// ── resolve: target(rect) = f(snapshot, buffer) ────────────────────────────
struct ResU {
  color: vec4f,  // paint colour (straight) / mask value in x
  k: vec4f,      // opacity, mode-specific (dodge exposure, range), …
  k2: vec4f,
}
@group(0) @binding(4) var<uniform> R: ResU;

struct FOut { @builtin(position) p: vec4f }
@vertex
fn vs_full(@builtin(vertex_index) i: u32) -> FOut {
  let xy = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: FOut;
  o.p = vec4f(xy * 2.0 - 1.0, 0.0, 1.0);
  return o;
}

@fragment
fn fs_res_paint(in: FOut) -> @location(0) vec4f {
  let p = vec2i(in.p.xy);
  let o = textureLoad(srcTex, p, 0);
  let cov = textureLoad(bufTex, p, 0).r * R.k.x;
  let s = vec4f(R.color.rgb * R.color.a, R.color.a) * cov;
  return s + o * (1.0 - s.a);
}

@fragment
fn fs_res_erase(in: FOut) -> @location(0) vec4f {
  let p = vec2i(in.p.xy);
  let o = textureLoad(srcTex, p, 0);
  return o * (1.0 - textureLoad(bufTex, p, 0).r * R.k.x);
}

@fragment
fn fs_res_clone(in: FOut) -> @location(0) vec4f {
  let p = vec2i(in.p.xy);
  let o = textureLoad(srcTex, p, 0);
  let s = textureLoad(bufTex, p, 0) * R.k.x;
  return s + o * (1.0 - s.a);
}

@fragment
fn fs_res_mask(in: FOut) -> @location(0) vec4f {
  let p = vec2i(in.p.xy);
  let o = textureLoad(srcTex, p, 0).r;
  let cov = textureLoad(bufTex, p, 0).r * R.k.x;
  return vec4f(mix(o, R.color.x, cov));
}

// dodge / burn: k.y = exposure (−1..1, burn negative), k.z = range
// (0 shadows, 1 midtones, 2 highlights), k.w = 1 protect tones (colour kept)
@fragment
fn fs_res_dodge(in: FOut) -> @location(0) vec4f {
  let p = vec2i(in.p.xy);
  let o = textureLoad(srcTex, p, 0);
  if (o.a < 1e-6) { return o; }
  let c = o.rgb / o.a;
  let cov = textureLoad(bufTex, p, 0).r;
  let l = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  var w = 1.0;
  if (R.k.z < 0.5) { w = 1.0 - smoothstep(0.0, 0.5, l); }
  else if (R.k.z < 1.5) { w = 1.0 - abs(l - 0.5) * 2.0; }
  else { w = smoothstep(0.5, 1.0, l); }
  let e = R.k.y * cov * max(w, 0.0);
  var n: vec3f;
  if (e >= 0.0) { n = c + (1.0 - c) * e; } else { n = c * (1.0 + e); }
  if (R.k.w > 0.5) {
    // keep saturation: scale the colour by the luminance change instead
    let l2 = dot(n, vec3f(0.2126, 0.7152, 0.0722));
    n = clamp(c * (l2 / max(l, 1e-4)), vec3f(0.0), vec3f(1.0));
  }
  return vec4f(n * o.a, o.a);
}

// ── heal: pull-push of the boundary difference ─────────────────────────────
// seed (rect-sized): bufTex = the clone source (the layer itself, or the
// composite of the layers sampled), covTex = the clone stroke buffer (alpha
// = coverage). Outside the stroke the difference between the destination
// and the place it was cloned from is known — both read from the source,
// so healing onto an empty layer matches the image below; inside it is
// spread by the pull-push below. k2.xy = rect origin (target px), k2.zw =
// clone offset (px)
@group(0) @binding(5) var covTex: texture_2d<f32>;
@fragment
fn fs_heal_seed(in: FOut) -> @location(0) vec4f {
  let q = vec2i(in.p.xy) + vec2i(R.k2.xy);
  let dimS = vec2i(textureDimensions(bufTex));
  let dst = textureLoad(bufTex, clamp(q, vec2i(0), dimS - 1), 0);
  let src = textureLoad(bufTex, clamp(q + vec2i(round(R.k2.zw)), vec2i(0), dimS - 1), 0);
  let cov = textureLoad(covTex, q, 0).a;
  let w = select(0.0, 1.0, cov < 0.02);
  return vec4f((dst.rgb - src.rgb) * w, w);
}
// 2× down: average of weighted colour and weights
@fragment
fn fs_pp_down(in: FOut) -> @location(0) vec4f {
  let q = vec2i(in.p.xy) * 2;
  let dim = vec2i(textureDimensions(srcTex));
  var s = vec4f(0.0);
  for (var j = 0; j < 2; j++) {
    for (var i = 0; i < 2; i++) {
      s += textureLoad(srcTex, min(q + vec2i(i, j), dim - 1), 0);
    }
  }
  return s * 0.25;
}
// up: fine level (srcTex: weighted colour, weight) over the coarse
// interpolation (bufTex, normalised colour in rgb, weight 1)
@fragment
fn fs_pp_up(in: FOut) -> @location(0) vec4f {
  let p = vec2i(in.p.xy);
  let fine = textureLoad(srcTex, p, 0);
  let dimF = vec2f(textureDimensions(srcTex));
  let coarse = textureSampleLevel(bufTex, samp, (in.p.xy) / dimF, 0.0).rgb;
  let own = select(coarse, fine.rgb / fine.w, fine.w > 1e-5);
  return vec4f(mix(coarse, own, clamp(fine.w * 4.0, 0.0, 1.0)), 1.0);
}
// apply: target = cloned + interpolated difference, inside the stroke
// (srcTex = interpolated difference at rect size, bufTex = cloned result)
@fragment
fn fs_heal_apply(in: FOut) -> @location(0) vec4f {
  let q = vec2i(in.p.xy);
  let local = q - vec2i(R.k2.xy);
  let diff = textureLoad(srcTex, local, 0).rgb;
  let cloned = textureLoad(bufTex, q, 0);
  let cov = textureLoad(covTex, q, 0).a;
  let healed = vec4f(max(cloned.rgb + diff * cloned.a, vec3f(0.0)), cloned.a);
  return mix(cloned, healed, clamp(cov * 1.5, 0.0, 1.0));
}

// ── smudge (dab by dab on the target) ──────────────────────────────────────
// fs_smudge_apply: target(dab rect) = mix(copy of target under the dab,
// carried colour, strength·tip); srcTex = copy (dab-sized), bufTex = carried
// (dab-sized). k.xy = dab rect origin, k.z = strength, k.w = hardness;
// k2.x = dab size (px)
@fragment
fn fs_smudge_apply(in: FOut) -> @location(0) vec4f {
  let local = in.p.xy - R.k.xy;
  let size = R.k2.x;
  let uv = local / size;
  let cur = textureLoad(srcTex, vec2i(local), 0);
  let carried = textureSampleLevel(bufTex, samp, uv, 0.0);
  let a = falloff(uv * 2.0 - 1.0, R.k.w) * R.k.z;
  return mix(cur, carried, a);
}
// carried colour picks up some of what it smears over: k.z = strength
@fragment
fn fs_smudge_carry(in: FOut) -> @location(0) vec4f {
  let p = vec2i(in.p.xy);
  let carried = textureLoad(bufTex, p, 0);
  let cur = textureLoad(srcTex, p, 0);
  return mix(cur, carried, R.k.z);
}
