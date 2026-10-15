// Lens-correction lookup over the lensfun database (CC BY-SA 3.0, see
// public/lensfun/LICENSE). Pure ES module, no DOM: runs in workers, the main
// thread and Node. Data comes from scripts/build-lensfun.mjs:
//   public/lensfun/index.json     cameras, lenses (with file + i), mounts
//   public/lensfun/<maker>.json   [lensCalib, …] addressed by index lens.i
//
// Ported from lensfun master (github.com/lensfun/lensfun, libs/lensfun/):
//   auxfun.cpp    lfFuzzyStrCmp (Split/Compare), _lf_strcmp, _lf_interpolate
//   database.cpp  MatchScore, FindLenses, FindCamerasExt, XML attribute names
//   lens.cpp      GuessParameters (name regexes), InterpolateDistortion/TCA/
//                 Vignetting, __parameter_scales, __vignetting_dist
//   modifier.cpp  coordinate systems (the comment block at the top)
//   mod-coord.cpp / mod-subpix.cpp / mod-color.cpp
//                 rescale_polynomial_coefficients + the per-model formulas
//
// Coordinate conventions (modifier.cpp):
//   distortion + TCA (Hugin models): r = 1 at half the SHORTER side of the
//     calibration frame, i.e. half-height of a landscape frame whose diagonal
//     is 43.27 mm / calibCrop and whose aspect is calibAspect (default 1.5).
//   vignetting "pa": r = 1 at the CORNER (half-diagonal) of that frame.
// shaderParams() converts everything to one convention for the target image:
//   r = 1 at the corner (half-diagonal) of the image being corrected.
// Because lensfun maps the target image's diagonal onto 43.27 mm / imageCrop
// (NormScale in modifier.cpp), only the crop factors matter for that change,
// not the target aspect:
//   r_hugin = r · (calibCrop / imageCrop) · hypot(calibAspect, 1)
//   r_pa    = r · (calibCrop / imageCrop)

// ---------------------------------------------------------------- matching

// lfFuzzyStrCmp::Split: words by character class (digit runs incl. '.',
// punctuation runs, letter runs); "x.0" loses its ".0"; lone punctuation and a
// lone "f" are dropped except '*' and '+'; casefolded; sorted. ASCII classes
// only, like the C ctype calls on UTF-8 bytes.
const isSpace = (c) => c === ' ' || (c >= '\t' && c <= '\r')
const isDigit = (c) => c >= '0' && c <= '9'
const isPunct = (c) => /[!-/:-@[-`{-~]/.test(c)

export function splitWords(str) {
  const out = []
  if (!str) return out
  const n = str.length
  let i = 0
  while (i < n) {
    while (i < n && isSpace(str[i])) i++
    if (i >= n) break
    const w = i++
    let strip = 0
    if (isDigit(str[w])) {
      while (i < n && (isDigit(str[i]) || str[i] === '.')) i++
      if (i - w >= 2 && str[i - 2] === '.' && str[i - 1] === '0') strip = 2
    } else if (isPunct(str[w])) {
      while (i < n && isPunct(str[i])) i++
    } else {
      while (i < n && !isSpace(str[i]) && !isDigit(str[i]) && !isPunct(str[i])) i++
    }
    if (i - w === 1 && (isPunct(str[w]) || str[w].toLowerCase() === 'f') && str[w] !== '*' && str[w] !== '+') continue
    out.push(str.slice(w, i - strip).toLowerCase())
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

// lfFuzzyStrCmp::Compare: 0..100 (100 = same word multiset). allWords
// (lensfun's default, non-LOOSE search) rejects unless every pattern word
// occurs in the candidate.
export function fuzzyScore(patternWords, candidate, allWords = true) {
  const mw = splitWords(candidate)
  const pw = patternWords
  if (!mw.length || !pw.length) return 0
  let mi = 0
  let score = 0
  for (const p of pw) {
    const old = mi
    for (; mi < mw.length; mi++) {
      if (p === mw[mi]) { score++; break }
      if (p < mw[mi]) {
        if (allWords) return 0
        mi = old - 1
        break
      }
    }
    if (allWords) {
      if (mi >= mw.length) return 0
      mi++
    } else {
      mi = mi < 0 || mi >= mw.length ? old : mi + 1
    }
  }
  return Math.trunc((score * 200) / (pw.length + mw.length))
}

// best score over a name and its translations (lfMLstr)
const mlScore = (pw, name, alt, allWords) => {
  let best = fuzzyScore(pw, name, allWords)
  for (const a of alt ?? []) best = Math.max(best, fuzzyScore(pw, a, allWords))
  return best
}

// _lf_strcmp equality: case-insensitive, whitespace runs collapsed and trimmed
const normEq = (a, b) => {
  const n = (s) => (s ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
  return n(a) === n(b)
}

// lfLens::GuessParameters name regexes. Deviation: lensfun's are
// case-sensitive and need whitespace after "mm", so EXIF strings such as
// "FE 24-70mm F2.8 GM" or "XF18-55mmF2.8-4" yield no focal range there; here
// the match is case-insensitive and the space optional, which only makes the
// numeric cross-check stricter, never looser.
const NAME_RES = [
  [/^[^:]*?([0-9]+[0-9.]*)-?([0-9]+[0-9.]*)?\s*(mm)\s*(f\/|f|1\/|1:)?([0-9.]+)(-[0-9.]+)?.*$/is, [1, 2, 5]],
  [/^.*?1:([0-9.]+)-?([0-9.]+)?\s+([0-9.]+)-?([0-9.]+)?(mm)?.*$/is, [3, 4, 1]],
  [/^.*?([0-9.]+)-?([0-9.]+)?\s*\/\s*([0-9.]+)-?([0-9.]+)?.*$/s, [3, 4, 1]],
]
const NOT_A_LENS = /adapter|reducer|booster|extender|converter|magnifier/
const EXTENDER = /^.*?[0-9](\.[0.9]+)?x.*$/s

// Focal range and widest aperture from a lens name, as lensfun guesses them for
// both EXIF patterns and database entries (db entries also fall back to the
// calibration focals; the build script does that part).
export function guessFromName(model) {
  const r = { minFocal: 0, maxFocal: 0, minAperture: 0 }
  if (!model || NOT_A_LENS.test(model) || EXTENDER.test(model)) return r
  for (const [re, [fi, fa, ai]] of NAME_RES) {
    const m = re.exec(model)
    if (!m) continue
    if (m[fi] !== undefined) r.minFocal = parseFloat(m[fi]) || 0
    if (m[fa] !== undefined) r.maxFocal = parseFloat(m[fa]) || 0
    if (m[ai] !== undefined) r.minAperture = parseFloat(m[ai]) || 0
    break
  }
  if (!r.maxFocal) r.maxFocal = r.minFocal
  return r
}

// _lf_compare_num: 0 neutral (either unknown), -1 reject, +1 agree within 1%
const cmpNum = (a, b) => {
  if (!a || !b) return 0
  const r = a / b
  return r <= 0.99 || r >= 1.01 ? -1 : 1
}

// lfDatabase::MatchScore (database.cpp). 0 = rejected.
function matchScore(pattern, lens, camera, cropFactor, compat, modelScore) {
  let score = 0
  const crop = camera?.cropFactor ?? cropFactor
  if (crop) {
    // one calibration set per lens in practice (lens.cpp always files into
    // Calibrations[0] with the lens-level crop factor)
    const c = lens.cropFactor
    let s = 0
    if (crop > 0.01 && crop < c * 0.96) s = 0
    else if (crop >= c * 1.41) s = 2
    else if (crop >= c * 1.31) s = 4
    else if (crop >= c * 1.21) s = 6
    else if (crop >= c * 1.11) s = 8
    else if (crop >= c * 1.01) s = 10
    else if (crop >= c) s = 5
    else if (crop >= c * 0.96) s = 3
    if (!s) return 0
    score += s
  }
  for (const [a, b] of [
    [pattern.minFocal, lens.focal?.[0]], [pattern.maxFocal, lens.focal?.[1]],
    [pattern.minAperture, lens.aperture?.[0]], [pattern.maxAperture, lens.aperture?.[1]],
  ]) {
    const c = cmpNum(a, b)
    if (c < 0) return 0
    if (c > 0) score += 10
  }
  if (lens.mounts?.length && (camera?.mount || compat?.length)) {
    let ok = false
    if (camera?.mount && lens.mounts.some((m) => normEq(m, camera.mount))) { ok = true; score += 10 }
    else if (compat?.some((cm) => lens.mounts.some((m) => normEq(m, cm)))) { ok = true; score += 9 }
    if (!ok) return 0
  }
  if (pattern.maker && lens.maker) {
    if (!normEq(pattern.maker, lens.maker) && !(lens.makerAlt ?? []).some((a) => normEq(pattern.maker, a))) return 0
    score += 10
  }
  if (pattern.model && lens.model) {
    let s = modelScore(lens)
    if (!s) return 0
    s = Math.trunc((s * 4) / 10) || 1
    score += s
  }
  return score
}

// lfDatabase::FindCamerasExt with both maker and model: fuzzy, all words
export function findCameras(index, maker, model) {
  const mk = maker ? splitWords(maker) : null
  const md = model ? splitWords(model) : null
  const out = []
  for (const cam of index.cameras) {
    let s1 = 0
    let s2 = 0
    if ((!mk || (s1 = mlScore(mk, cam.maker, cam.makerAlt, true))) &&
        (!md || (s2 = mlScore(md, cam.model, cam.alt, true)))) out.push({ camera: cam, score: s1 + s2 })
  }
  return out.sort((a, b) => b.score - a.score)
}

// lfDatabase::FindLenses(camera, maker, model) with lensfun's default strict
// word matching, then a reverse-subset retry when nothing survives. Albedo
// additions: an optional focal (from EXIF) drops lenses whose range cannot contain it, and an empty lens
// string falls back to the camera's own fixed lens (same mount, e.g. compacts).
export function findLenses(index, { camera = null, cropFactor = 0, lensMaker = null, lensModel = '', focal = 0 } = {}) {
  const g = guessFromName(lensModel)
  const pattern = { maker: lensMaker || null, model: lensModel || null, ...g, maxAperture: 0 }
  const compat = camera?.mount ? index.mounts?.[camera.mount] ?? null : null
  const inRange = (l) => !focal || !l.focal?.[0] || (focal >= l.focal[0] * 0.99 && focal <= (l.focal[1] || l.focal[0]) * 1.01)
  const pw = splitWords(lensModel)
  // strict: every EXIF word occurs in the db name (lensfun). Fallback: every
  // db-name word occurs in the EXIF string — EXIF names often carry extra
  // words; lensfun's own LOOSE mode (any shared word) picks unrelated lenses
  // such as "FE 24-105mm f/4 G OSS" for "RF24-105mm F4 L IS USM".
  const strictScore = (l) => mlScore(pw, l.model, l.alt, true)
  const reverseScore = (l) => Math.max(...[l.model, ...(l.alt ?? [])].map((n) => fuzzyScore(splitWords(n), lensModel, true)))
  const run = (modelScore) => {
    const out = []
    for (const lens of index.lenses) {
      if (!inRange(lens)) continue
      const s = matchScore(pattern, lens, camera, cropFactor, compat, modelScore)
      if (s > 0) out.push({ lens, score: s })
    }
    return out.sort((a, b) => b.score - a.score)
  }
  if (!lensModel) {
    if (!camera?.mount) return []
    // fixed-lens bodies have a private mount with one or two entries; on an
    // interchangeable mount an empty string identifies nothing
    const own = index.lenses.filter((l) => l.mounts?.some((m) => normEq(m, camera.mount)))
    if (own.length > 3) return []
    return own
      .filter(inRange)
      .map((lens) => ({ lens, score: matchScore(pattern, lens, camera, cropFactor, null, () => 1) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
  }
  const strict = run(strictScore)
  return strict.length ? strict : run(reverseScore)
}

// One-call lookup: camera by EXIF make/model, then the best lens for it.
// Returns { camera, lens, score, candidates } — lens/camera null when unknown.
// lens.file + lens.i locate its calibration: (await fetch(file)).json()[i].
export function matchLens(index, { cameraMaker, cameraModel, lensMaker, lensModel, focal, cropFactor } = {}) {
  const cams = cameraModel ? findCameras(index, cameraMaker, cameraModel) : []
  const camera = cams[0]?.camera ?? null
  const candidates = findLenses(index, {
    camera, cropFactor: cropFactor ?? 0, lensMaker, lensModel: (lensModel ?? '').trim(), focal: focal ?? 0,
  })
  return { camera, lens: candidates[0]?.lens ?? null, score: candidates[0]?.score ?? 0, candidates: candidates.slice(0, 8) }
}

// ----------------------------------------------------------- interpolation

// _lf_interpolate (auxfun.cpp): cubic Hermite between y2 and y3, tangents from
// the outer neighbours when present (null = absent, lensfun's FLT_MAX)
export function hermite(y1, y2, y3, y4, t) {
  const t2 = t * t
  const t3 = t2 * t
  const tg2 = y1 == null ? y3 - y2 : (y3 - y1) * 0.5
  const tg3 = y4 == null ? y3 - y2 : (y4 - y2) * 0.5
  return (2 * t3 - 3 * t2 + 1) * y2 + (t3 - 2 * t2 + t) * tg2 + (-2 * t3 + 3 * t2) * y3 + (t3 - t2) * tg3
}

// InterpolateDistortion / InterpolateTCA: the two calibrated focals nearest on
// each side (spline[1] = nearest above, spline[2] = nearest below, [0]/[3] the
// next ones out), Hermite in focal. Terms flagged by scaleByFocal are
// multiplied by their focal before and divided by the target focal after
// (__parameter_scales: distortion and TCA terms follow ~1/f). Outside the
// calibrated range the nearest entry is used as is; an exact focal returns it.
function interpFocal(points, focal, scaleByFocal) {
  const sp = [null, null, null, null]
  const sd = [-Infinity, -Infinity, Infinity, Infinity]
  for (const p of points) {
    const df = focal - p[0]
    if (df === 0) return p.slice(1)
    // __insert_spline
    if (df < 0) {
      if (df > sd[1]) { sd[0] = sd[1]; sd[1] = df; sp[0] = sp[1]; sp[1] = p }
      else if (df > sd[0]) { sd[0] = df; sp[0] = p }
    } else {
      if (df < sd[2]) { sd[3] = sd[2]; sd[2] = df; sp[3] = sp[2]; sp[2] = p }
      else if (df < sd[3]) { sd[3] = df; sp[3] = p }
    }
  }
  if (!sp[1] || !sp[2]) return (sp[1] ?? sp[2])?.slice(1) ?? null
  const t = (focal - sp[1][0]) / (sp[2][0] - sp[1][0])
  const out = []
  for (let i = 1; i < sp[1].length; i++) {
    const sc = scaleByFocal(i - 1)
    const v = (p) => (p ? p[i] * (sc ? p[0] : 1) : null)
    out.push(hermite(v(sp[0]), v(sp[1]), v(sp[2]), v(sp[3]), t) / (sc ? focal : 1))
  }
  return out
}

// __vignetting_dist: focal normalised over the lens range, aperture and
// distance on reciprocal axes (4/N, 0.1/d)
function vignDist(lens, p, focal, aperture, distance) {
  const [minF, maxF] = lens.focal ?? [0, 0]
  let f1 = focal - minF
  let f2 = p[0] - minF
  const df = maxF - minF
  if (df !== 0) { f1 /= df; f2 /= df }
  return Math.hypot(f2 - f1, 4 / p[1] - 4 / aperture, 0.1 / p[2] - 0.1 / distance)
}

// InterpolateVignetting: inverse-distance weighting, power 3.5, over every
// (focal, aperture, distance) sample; refuses when the nearest sample is
// farther than 1 in that normalised space. pa terms are not focal-scaled.
function interpVignetting(lens, points, focal, aperture, distance) {
  let total = 0
  let nearest = Infinity
  const acc = [0, 0, 0]
  for (const p of points) {
    const d = vignDist(lens, p, focal, aperture, distance)
    if (d < 0.0001) return p.slice(3, 6)
    nearest = Math.min(nearest, d)
    const w = Math.abs(1 / Math.pow(d, 3.5))
    for (let i = 0; i < 3; i++) acc[i] += w * p[3 + i]
    total += w
  }
  if (nearest > 1 || !(total > 0)) return null
  return acc.map((v) => v / total)
}

// Coefficients for one shot, in lensfun's native conventions (see top).
// lensCalib is one entry of a per-maker file. distance in metres (unknown:
// 1000, effectively infinity); aperture is the f-number (no vignetting
// without it). cropFactor is the camera's: lensfun refuses calibrations made
// on a sensor more than 4% smaller than the image's (r would extrapolate).
//   distortion: { model: 'poly3', terms: [k1] } | 'poly5' [k1, k2] | 'ptlens' [a, b, c]
//   tca:        { model: 'linear', terms: [kr, kb] } | 'poly3' [vr, vb, cr, cb, br, bb]
//   vignetting: { model: 'pa', terms: [k1, k2, k3] }
export function correctionAt(lensCalib, { focal, aperture = 0, distance = 1000, cropFactor = 0 } = {}) {
  const calibCrop = lensCalib.cropFactor ?? 1
  const out = { cropFactor: calibCrop, aspectRatio: lensCalib.aspectRatio ?? 1.5, focal, distortion: null, tca: null, vignetting: null }
  if (cropFactor && cropFactor / calibCrop < 0.96) return out
  const f = focal || lensCalib.focal?.[0] || 0
  if (!f) return out
  const dist = lensCalib.distortion
  if (dist?.points?.length) {
    const terms = interpFocal(dist.points, f, () => true)
    if (terms) out.distortion = { model: dist.model, terms }
  }
  const tca = lensCalib.tca
  if (tca?.points?.length) {
    // linear [kr, kb] and poly3 [vr, vb] are ~constant in f; poly3 c/b ~1/f
    const terms = interpFocal(tca.points, f, (i) => i >= 2)
    if (terms) out.tca = { model: tca.model, terms }
  }
  const vig = lensCalib.vignetting
  if (vig?.points?.length && aperture > 0) {
    const terms = interpVignetting(lensCalib, vig.points, f, aperture, distance > 0 ? distance : 1000)
    if (terms) out.vignetting = { model: 'pa', terms }
  }
  return out
}

// ------------------------------------------------------------ shader terms

// Shader-ready numbers for an image shot with crop factor imageCrop (defaults
// to the calibration's). ONE radius convention for all three:
//   r = |p - centre| / half-diagonal of the image   (r = 1 at the corners)
// with p in pixels of the uncropped, unrotated source frame (optical centre =
// frame centre; lensfun's rare per-lens centre offsets are not applied).
//
// distortion: [a0, a1, a2, a3, a4], an inverse map from the corrected
//   (output) radius r_u to the radius to sample in the source:
//     r_d = r_u · (a0 + a1·r_u + a2·r_u² + a3·r_u³ + a4·r_u⁴)
//     src = centre + (out - centre) · (r_d / r_u)
//   a0 = 1: like lensfun master (mod-coord.cpp, "Note about PT-based models")
//   the Hugin d = 1-a-b-c factor is folded into the terms so the centre keeps
//   its scale (a'=a/d⁴, b'=b/d³, c'=c/d²; poly3 k1'=k1/d³); the corrected
//   frame grows by ~d at the edges, so the caller still needs an auto-fit.
//   poly3:  a2 = k1·s²/d³ (d = 1-k1)       poly5: a2 = k1·s², a4 = k2·s⁴
//   ptlens: a1 = c·s/d², a2 = b·s²/d³, a3 = a·s³/d⁴ (d = 1-a-b-c)
//   with s = (calibCrop/imageCrop)·hypot(calibAspect, 1)  (Hugin → corner units)
// tca: { red: [v, c, b], blue: [v, c, b] }, applied AFTER distortion on the
//   source radius r_d that green samples at (mod-subpix.cpp; TCA was fitted
//   against green on the uncorrected image):
//     r_ch = r_d · (v + c·r_d + b·r_d²),  src_ch = centre + (src - centre)·(r_ch / r_d)
//   linear model: [k, 0, 0]. poly3: c·s, b·s² (same s as distortion).
// vignetting: [k1, k2, k3] at the SOURCE radius r_d (vignetting lives in the
//   uncorrected frame; lensfun applies it before geometry):
//     gain = 1 + k1·r_d² + k2·r_d⁴ + k3·r_d⁶,   linear_rgb /= gain
//   pa terms scaled by sv², sv⁴, sv⁶ with sv = calibCrop/imageCrop.
// Each field is null when the lens has no usable data for that correction.
export function shaderParams(corr, { imageCrop } = {}) {
  const crop = imageCrop || corr.cropFactor
  const ratio = corr.cropFactor / crop
  const s = ratio * Math.hypot(corr.aspectRatio ?? 1.5, 1)
  const out = { distortion: null, tca: null, vignetting: null }
  const d = corr.distortion
  if (d) {
    const t = d.terms
    if (d.model === 'poly3') {
      const dd = 1 - t[0]
      out.distortion = [1, 0, (t[0] * s * s) / dd ** 3, 0, 0]
    } else if (d.model === 'poly5') {
      out.distortion = [1, 0, t[0] * s * s, 0, (t[1] ?? 0) * s ** 4]
    } else if (d.model === 'ptlens') {
      const [a, b, c] = t
      const dd = 1 - a - b - c
      out.distortion = [1, (c * s) / dd ** 2, (b * s * s) / dd ** 3, (a * s ** 3) / dd ** 4, 0]
    }
  }
  const tc = corr.tca
  if (tc) {
    const t = tc.terms
    if (tc.model === 'linear') out.tca = { red: [t[0], 0, 0], blue: [t[1], 0, 0] }
    else if (tc.model === 'poly3') {
      out.tca = { red: [t[0], (t[2] ?? 0) * s, (t[4] ?? 0) * s * s], blue: [t[1], (t[3] ?? 0) * s, (t[5] ?? 0) * s * s] }
    }
  }
  const v = corr.vignetting
  if (v) {
    const r2 = ratio * ratio
    out.vignetting = [v.terms[0] * r2, v.terms[1] * r2 * r2, v.terms[2] * r2 * r2 * r2]
  }
  return out
}

// convenience for the shader twin / tests: r_d for a corrected radius r_u
export const distortRadius = (a, r) => r * (a[0] + r * (a[1] + r * (a[2] + r * (a[3] + r * a[4]))))
