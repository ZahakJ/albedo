// Lightroom / Camera Raw XMP import — crs: (camera-raw-settings) → albedo
// modules. Pure ES module (browser + Node): no DOMParser, a small tolerant
// XML reader for the XMP subset Adobe writes instead.
//
//   parseXmp(text) → { name, modules, unmapped, isPreset, warnings }
//   xmpSummary(unmapped) → 'Not imported: Grain, Calibration' | ''
//
// Inputs handled: .xmp sidecars (x:xmpmeta wrapper, xmp:/tiff:/exif:/dc:
// noise, settings as attributes and/or child elements, possibly split over
// several rdf:Description nodes) and .xmp presets (crs:PresetType, crs:Name /
// crs:Group as rdf:Alt). Only top-level properties of the rdf:RDF
// Descriptions are read; structured properties (crs:Look, crs:Mask*, crs:
// RetouchInfo, crs:LensBlur, ...) are inspected only to decide whether they
// carry something non-neutral that albedo cannot represent.
//
// Module inclusion policy:
//  • sidecar — a module appears only when the mapped value has a visible
//    effect (differs from MODULE_DEFAULTS; for vignette/grain/grading/bw the
//    gate is the effect switch: amount≠0, amount>0, any zone s>0, on=1 — LR
//    writes the satellite sliders (GrayMixer*, Midpoint, ...) into every file).
//  • preset — additionally, any module whose crs keys the preset CONTAINS is
//    included, at defaults if the values are neutral: a LR preset only
//    carries the groups that were ticked when it was saved, so a ticked group
//    at neutral means "reset this", and applying the module at defaults does
//    exactly that.
//  • every included module is a full object (MODULE_DEFAULTS merged), so it
//    is valid on its own.
//
// Mapping (all derived from the engine code; see the per-module comments):
//   Exposure2012 (EV)                 → exposure.ev 1:1 (both 2^ev linear gain), clamp ±5
//   Contrast/Highlights/Shadows/Whites/Blacks2012 (±100) → tone.* 1:1
//   Temperature/Tint (raw, absolute K) → wb via illuminant chromaticity vs the
//       LR "Daylight" reference (5500 K, tint +10), inverting wb_mul (below)
//   IncrementalTemperature/Tint (±100) → wb.temp/tint 1:1
//   Vibrance/Saturation (±100)        → vibsat 1:1
//   Clarity2012/Texture/Dehaze (±100) → localcontrast 1:1
//   ToneCurvePV2012 [0..255]          → curve.points [0..1] (/255)
//   Hue/Saturation/LuminanceAdjustment<Band> (±100) → colormix.<band>.h/s/l 1:1
//   ConvertToGrayscale + GrayMixer<Band> → bw.on + bw.mix 1:1
//   SplitToning*/ColorGrade* hue (HSL deg) → grading.*.h in OKLab hue deg
//       (converted through the fully saturated sRGB color), sat 1:1,
//       ColorGradeBlending 1:1, SplitToningBalance → balance × −1
//   PostCropVignetteAmount/Midpoint/Feather 1:1, Roundness clamp 0..100
//   GrainAmount/Size/Frequency        → grain.amount/size/roughness 1:1
//   HasCrop + CropLeft/Top/Right/Bottom → geometry.crop (tiff:Orientation applied)
//   CropAngle (deg, + = image CW)     → geometry.angle × −1 (albedo + = CCW), clamp ±45
//   PerspectiveVertical/Horizontal    → geometry.persp.v/h 1:1
//   Sharpness/SharpenRadius/SharpenEdgeMasking → detail.sharpen* 1:1
//   LuminanceSmoothing/ColorNoiseReduction → detail.lumaNR/chromaNR 1:1
//   LensManualDistortionAmount        → lens.distortion × −1
//   DefringePurple/GreenAmount (0..20) → lens.defringe = 5·max(p, g)
//   LensProfileDistortion/VignettingScale → lens.profDistortion/profVignette 1:1
//       (LensProfileEnable is ignored: albedo's lensfun profile is on by default)

import { MODULE_DEFAULTS, BAND_NAMES } from '../engine/editdoc.js'

const NS_CRS = 'http://ns.adobe.com/camera-raw-settings/1.0/'
const NS_RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'
const NS_TIFF = 'http://ns.adobe.com/tiff/1.0/'

// ---------------------------------------------------------------------------
// Tolerant XML reader → { name, attrs, children, text } tree. Handles
// comments, CDATA, processing instructions (<?xpacket?>), DOCTYPE, single and
// double quoted attributes, self-closing tags, the five XML entities and
// numeric character references. Mismatched end tags close back to the
// nearest matching open element (or are ignored when none matches).

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
function decodeEntities(s) {
  if (s.indexOf('&') < 0) return s
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      try { return String.fromCodePoint(cp) } catch { return m }
    }
    return ENT[e] ?? m
  })
}

const ATTR_RE = /([^\s=/>"']+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g

function parseXml(text) {
  const root = { name: '#root', attrs: {}, children: [], text: '' }
  const stack = [root]
  const top = () => stack[stack.length - 1]
  let i = 0
  const n = text.length
  while (i < n) {
    const lt = text.indexOf('<', i)
    if (lt < 0) { top().text += decodeEntities(text.slice(i)); break }
    if (lt > i) top().text += decodeEntities(text.slice(i, lt))
    if (text.startsWith('<!--', lt)) {
      const e = text.indexOf('-->', lt + 4)
      i = e < 0 ? n : e + 3
    } else if (text.startsWith('<![CDATA[', lt)) {
      const e = text.indexOf(']]>', lt + 9)
      top().text += text.slice(lt + 9, e < 0 ? n : e)
      i = e < 0 ? n : e + 3
    } else if (text.startsWith('<?', lt)) {
      const e = text.indexOf('?>', lt + 2)
      i = e < 0 ? n : e + 2
    } else if (text.startsWith('<!', lt)) {
      // DOCTYPE (an internal subset's brackets are skipped as a block)
      let j = lt + 2
      let depth = 0
      while (j < n && !(text[j] === '>' && depth === 0)) {
        if (text[j] === '[') depth++
        else if (text[j] === ']') depth--
        j++
      }
      i = j + 1
    } else if (text[lt + 1] === '/') {
      const e = text.indexOf('>', lt)
      const name = text.slice(lt + 2, e < 0 ? n : e).trim()
      i = e < 0 ? n : e + 1
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name) { stack.length = k; break }
      }
    } else {
      // start tag: scan to the closing '>' outside quotes
      let j = lt + 1
      let q = null
      while (j < n) {
        const c = text[j]
        if (q) { if (c === q) q = null } else if (c === '"' || c === "'") q = c
        else if (c === '>') break
        j++
      }
      let body = text.slice(lt + 1, j)
      i = j + 1
      const selfClose = /\/\s*$/.test(body)
      if (selfClose) body = body.replace(/\/\s*$/, '')
      const m = /^\s*([^\s/>]+)/.exec(body)
      if (!m) continue
      const el = { name: m[1], attrs: {}, children: [], text: '' }
      ATTR_RE.lastIndex = m[0].length
      let a
      while ((a = ATTR_RE.exec(body))) el.attrs[a[1]] = decodeEntities(a[2] ?? a[3] ?? '')
      top().children.push(el)
      if (!selfClose) stack.push(el)
    }
  }
  return root
}

// namespace prefixes: global (unscoped) xmlns:p="uri" collection — XMP
// files declare each prefix once; good enough and tolerant of odd prefixes
function collectNs(node, map) {
  for (const [k, v] of Object.entries(node.attrs)) {
    if (k.startsWith('xmlns:')) (map[v] ??= new Set()).add(k.slice(6))
  }
  node.children.forEach((c) => collectNs(c, map))
  return map
}

const splitName = (qn) => {
  const c = qn.indexOf(':')
  return c < 0 ? ['', qn] : [qn.slice(0, c), qn.slice(c + 1)]
}

// ---------------------------------------------------------------------------
// XMP property extraction. Values become:
//   string                       — attribute or simple element text
//   { list: [item, ...] }        — rdf:Seq / rdf:Bag (items: string | struct)
//   { struct: {props}, empty }   — rdf:Description / parseType="Resource"
// rdf:Alt collapses to its x-default (or first) li string.

function makeReader(nsMap) {
  const pfx = (uri, dflt) => nsMap[uri] ?? new Set([dflt])
  const crs = pfx(NS_CRS, 'crs')
  const rdf = pfx(NS_RDF, 'rdf')
  const tiff = pfx(NS_TIFF, 'tiff')
  const isRdf = (qn, local) => { const [p, l] = splitName(qn); return l === local && rdf.has(p) }
  const elems = (node) => node.children

  function valueOf(el) {
    const parseType = Object.entries(el.attrs).find(([k]) => isRdf(k, 'parseType'))?.[1]
    if (parseType === 'Resource') return { struct: propsOf(el), empty: !hasContent(el) }
    const kids = elems(el)
    if (kids.length === 0) {
      // an empty element with property attributes is a struct shorthand
      const own = Object.keys(el.attrs).some((k) => !k.startsWith('xmlns') && !isRdf(k, 'about') && !k.startsWith('xml:'))
      return own ? { struct: propsOf(el), empty: false } : el.text.trim()
    }
    const k = kids[0]
    if (isRdf(k.name, 'Seq') || isRdf(k.name, 'Bag')) {
      return {
        list: elems(k).filter((li) => isRdf(li.name, 'li')).map((li) => {
          if (elems(li).length || Object.keys(li.attrs).some((a) => !a.startsWith('xml:'))) {
            return valueOf(li)
          }
          return li.text.trim()
        }),
      }
    }
    if (isRdf(k.name, 'Alt')) {
      const lis = elems(k).filter((li) => isRdf(li.name, 'li'))
      const def = lis.find((li) => li.attrs['xml:lang'] === 'x-default') ?? lis[0]
      return def ? def.text.trim() : ''
    }
    if (isRdf(k.name, 'Description')) return { struct: propsOf(k), empty: !hasContent(k) }
    return { struct: propsOf(el), empty: !hasContent(el) }
  }

  function hasContent(el) {
    return el.children.length > 0 || el.text.trim() !== ''
      || Object.keys(el.attrs).some((k) => !k.startsWith('xmlns') && !isRdf(k, 'parseType') && !isRdf(k, 'about'))
  }

  // crs:* properties of one node (attributes + child elements), plus
  // tiff:Orientation collected on the side
  function propsOf(node, side = null) {
    const out = {}
    for (const [k, v] of Object.entries(node.attrs)) {
      const [p, l] = splitName(k)
      if (crs.has(p)) out[l] = v
      else if (side && tiff.has(p) && l === 'Orientation') side.orientation = v
    }
    for (const el of node.children) {
      const [p, l] = splitName(el.name)
      if (crs.has(p)) out[l] = valueOf(el)
      else if (side && tiff.has(p) && l === 'Orientation') side.orientation = el.text.trim()
    }
    return out
  }

  // top-level Descriptions: children of rdf:RDF (fall back to any outermost
  // rdf:Description when there is no rdf:RDF, e.g. a bare fragment)
  function descriptions(root) {
    const out = []
    const walk = (node) => {
      for (const c of node.children) {
        if (isRdf(c.name, 'RDF')) out.push(...c.children.filter((d) => isRdf(d.name, 'Description')))
        else if (isRdf(c.name, 'Description')) out.push(c)
        else walk(c)
      }
    }
    walk(root)
    return out
  }

  return { propsOf, descriptions }
}

// ---------------------------------------------------------------------------
// value helpers

const isStr = (v) => typeof v === 'string'
const toNum = (v) => {
  if (!isStr(v)) return undefined
  const s = v.trim()
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return undefined
  return Number(s)
}
const toBool = (v) => (isStr(v) ? /^(true|1|yes)$/i.test(v.trim()) : undefined)
const round = (v, d = 0) => { const k = 10 ** d; const r = Math.round(v * k) / k; return r === 0 ? 0 : r }
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const clone = (o) => JSON.parse(JSON.stringify(o))

// ---------------------------------------------------------------------------
// White balance. albedo's wb is RELATIVE (temp/tint 0 = the camera's as-shot
// multipliers) while LR raw files carry an ABSOLUTE illuminant (Kelvin +
// tint). We map relative to LR's own "Daylight" preset (5500 K, tint +10) —
// i.e. we assume the as-shot WB ≈ daylight — which keeps the map monotonic
// and puts a Daylight-balanced file at temp/tint 0:
//   1. illuminant chromaticity: Planckian locus in CIE 1960 uv (Krystek
//      1985 rational fit, T clamped 2000..15000 K) offset along the locus
//      normal by tint/3000 toward green (DNG SDK kTintScale magnitude). LR
//      + tint renders the image MAGENTA, i.e. it declares a GREENER light
//   2. uv → xy → XYZ(Y=1) → linear sRGB
//   3. patch = rgb(illuminant) / rgb(reference): the color that illuminant's
//      white has under the reference balance
//   4. invert the shader's wb_mul = (1+0.25t, 1−0.25ti, 1−0.25t) for that
//      patch (same algebra as editdoc's wbNeutralize, but unclamped until
//      the end): t = 4(b−r)/(r+b); ti = 4(1 − H(r,b)/g), H = harmonic mean.
//   Axes are mapped SEPARABLY so each albedo slider is a monotonic function
//   of one LR slider: temp from the patch of (K, ref tint), tint from the
//   patch of (ref K, tint). (Walking the Planckian locus also drifts green
//   slightly vs albedo's r/b-only temp axis; that drift is dropped so a
//   Kelvin-only edit never leaks into tint.) Clamped ±100, integers.
// Higher K → bluer patch → positive (warmer) temp, as in Lightroom; + tint →
// greener patch → positive (magenta) tint. Shader range: temp ±100 = ±0.74
// stops R/B, reached around 4350 K / 7550 K; clamping adds a warning.
export const WB_REF = { k: 5500, tint: 10 }
const WB_PRESETS = {
  daylight: [5500, 10], cloudy: [6500, 10], shade: [7500, 10],
  tungsten: [2850, 0], fluorescent: [3800, 21], flash: [5500, 0],
}

function planckUv(T) {
  const u = (0.860117757 + 1.54118254e-4 * T + 1.28641212e-7 * T * T)
    / (1 + 8.42420235e-4 * T + 7.08145163e-7 * T * T)
  const v = (0.317398726 + 4.22806245e-5 * T + 4.20481691e-8 * T * T)
    / (1 - 2.89741816e-5 * T + 1.61456053e-7 * T * T)
  return [u, v]
}

function illuminantRgb(kelvin, tint) {
  const T = clamp(kelvin, 2000, 15000)
  const [u0, v0] = planckUv(T)
  const [u1, v1] = planckUv(T + 1)
  // unit normal to the locus, oriented toward +v (green)
  let nu = -(v1 - v0)
  let nv = u1 - u0
  const len = Math.hypot(nu, nv) || 1
  nu /= len; nv /= len
  if (nv < 0) { nu = -nu; nv = -nv }
  const d = tint / 3000
  const u = u0 + nu * d
  const v = v0 + nv * d
  const den = 2 * u - 8 * v + 4
  const x = (3 * u) / den
  const y = (2 * v) / den
  const X = x / y
  const Z = (1 - x - y) / y
  return [
    3.2404542 * X - 1.5371385 - 0.4985314 * Z,
    -0.9692660 * X + 1.8760108 + 0.0415560 * Z,
    0.0556434 * X - 0.2040259 + 1.0572252 * Z,
  ]
}

export function kelvinToWb(kelvin, tint) {
  const ref = illuminantRgb(WB_REF.k, WB_REF.tint)
  const patch = (k, ti) => illuminantRgb(k, ti).map((c, i) => c / ref[i])
  const [r1, , b1] = patch(kelvin, WB_REF.tint)
  const [r2, g2, b2] = patch(WB_REF.k, tint)
  const temp = 400 * (b1 - r1) / Math.max(r1 + b1, 1e-6)
  const tintV = 400 * (1 - (2 * r2 * b2) / Math.max((r2 + b2) * g2, 1e-6))
  return { temp: round(clamp(temp, -100, 100)), tint: round(clamp(tintV, -100, 100)) }
}

// ---------------------------------------------------------------------------
// LR color-grade / split-toning hue is an HSL hue (0 red, 120 green, 240
// blue); albedo grading.h is an OKLab hue angle (shader: a/b offset along
// cos/sin(h)). Convert through the fully saturated sRGB color hsl(h,100%,50%).
export function lrHueToOklab(h) {
  const hh = ((h % 360) + 360) % 360
  const f = (n) => {
    const k = (n + hh / 30) % 12
    return 0.5 - 0.5 * Math.max(-1, Math.min(k - 3, 9 - k, 1))
  }
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const [r, g, b] = [lin(f(0)), lin(f(8)), lin(f(4))]
  const cb = (x) => Math.cbrt(x)
  const l = cb(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = cb(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = cb(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
  let deg = (Math.atan2(B, A) * 180) / Math.PI
  if (deg < 0) deg += 360
  return round(deg) % 360
}

// ---------------------------------------------------------------------------
// Crop orientation. LR's CropLeft/Top/Right/Bottom are normalized to the
// image AS STORED (sensor orientation); albedo's crop is normalized to the
// decoded source, which is already rotated upright (libraw applies the flip).
// tiff:Orientation maps stored → displayed coords; mirrored orientations
// also reverse the rotation sense, so the angle flips sign with them.
export const ORIENT = {
  1: [(x, y) => [x, y], 1],
  2: [(x, y) => [1 - x, y], -1],
  3: [(x, y) => [1 - x, 1 - y], 1],
  4: [(x, y) => [x, 1 - y], -1],
  5: [(x, y) => [y, x], -1],
  6: [(x, y) => [1 - y, x], 1],
  7: [(x, y) => [1 - y, 1 - x], -1],
  8: [(x, y) => [y, 1 - x], 1],
}

// ---------------------------------------------------------------------------

export const BAND_LR = ['Red', 'Orange', 'Yellow', 'Green', 'Aqua', 'Blue', 'Purple', 'Magenta']

const curveFromList = (v) => {
  if (!v?.list) return null
  const pts = []
  for (const it of v.list) {
    if (!isStr(it)) continue
    const m = it.split(/[\s,]+/).filter(Boolean).map(Number)
    if (m.length >= 2 && m.every(Number.isFinite)) pts.push([clamp(m[0], 0, 255), clamp(m[1], 0, 255)])
  }
  pts.sort((a, b) => a[0] - b[0])
  const dedup = pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1][0])
  return dedup.length >= 2 ? dedup : null
}
const isIdentityCurve = (pts) => !pts || pts.every(([x, y]) => x === y)

const LOOK_NEUTRAL = new Set(['', 'adobe color', 'adobe standard'])
const PROFILE_NEUTRAL = new Set(['', 'adobe standard', 'adobe color', 'embedded'])
const NONRAW_EXT = /\.(jpe?g|tiff?|png|heic|heif|webp|psd|avif)$/i

export function parseXmp(text) {
  const warnings = []
  const modules = {}
  const unmapped = []
  const report = (label) => { if (!unmapped.includes(label)) unmapped.push(label) }
  const empty = { name: null, modules, unmapped, isPreset: false, warnings }
  if (typeof text !== 'string' || !text.trim()) {
    warnings.push('empty input')
    return empty
  }

  let root
  try { root = parseXml(text.replace(/^﻿/, '')) } catch (e) {
    warnings.push(`unparseable XMP: ${e?.message ?? e}`)
    return empty
  }
  const nsMap = collectNs(root, {})
  const reader = makeReader(nsMap)
  const side = {}
  const P = {}
  for (const d of reader.descriptions(root)) Object.assign(P, reader.propsOf(d, side))
  if (!Object.keys(P).length) {
    warnings.push('no Camera Raw (crs:) settings found')
    return empty
  }

  const has = (k) => P[k] !== undefined
  const num = (k) => toNum(P[k])
  const bool = (k) => toBool(P[k])
  const nonZero = (k) => { const v = num(k); return v !== undefined && v !== 0 }
  const differs = (k, neutral) => { const v = num(k); return v !== undefined && v !== neutral }
  const anyKey = (keys) => keys.some(has)
  // clamped slider read with a warning when the source exceeds the range
  const slider = (k, lo, hi, dflt, label = k) => {
    const v = num(k)
    if (v === undefined) return dflt
    if (v < lo || v > hi) warnings.push(`${label} ${v} clamped to ${lo}..${hi}`)
    return clamp(v, lo, hi)
  }

  const isPreset = has('PresetType') || (isStr(P.Name) && P.Name !== '')
  const name = isPreset && isStr(P.Name) && P.Name.trim() ? P.Name.trim() : null
  const pv = toNum(P.ProcessVersion)
  const legacyPV = pv !== undefined && pv < 10
  const nonRaw = has('IncrementalTemperature') || has('IncrementalTint')
    || (isStr(P.RawFileName) && NONRAW_EXT.test(P.RawFileName))

  // include rule (see header): effect for sidecars, presence for presets
  const put = (mod, value, effective, touched) => {
    const full = { ...clone(MODULE_DEFAULTS[mod]), ...value }
    if (effective || (isPreset && touched)) modules[mod] = full
  }
  const notDefault = (mod, value) => !same({ ...MODULE_DEFAULTS[mod], ...value }, MODULE_DEFAULTS[mod])

  // --- exposure: LR Exposure is EV (2^ev linear gain), albedo ev identical.
  // Exposure (PV2010, ±4 EV) is the same quantity → fallback.
  {
    const key = has('Exposure2012') ? 'Exposure2012' : 'Exposure'
    const ev = round(slider(key, -5, 5, 0, 'Exposure'), 2)
    put('exposure', { ev }, ev !== 0, has(key))
  }

  // --- tone: PV2012 sliders are ±100 with the same intent and sign as
  // albedo's tone zones (−highlights darkens >mid, +shadows lifts <mid,
  // −blacks deepens the floor, ±contrast slope at mid-gray) → 1:1.
  // Unsuffixed names: Highlights/Whites/Blacks never existed in PV2010, so
  // they are read as 2012 aliases; unsuffixed Contrast/Shadows mean the
  // PV2010 controls (Contrast default 25, Shadows = blacks default 5) when
  // ProcessVersion < 10 → reported as legacy tone, else read as aliases.
  {
    const keys = { contrast: 'Contrast', highlights: 'Highlights', shadows: 'Shadows', whites: 'Whites', blacks: 'Blacks' }
    const tone = {}
    let touched = false
    for (const [k, base] of Object.entries(keys)) {
      let key = `${base}2012`
      if (!has(key) && !(legacyPV && (base === 'Contrast' || base === 'Shadows'))) key = base
      if (has(key)) touched = true
      tone[k] = round(slider(key, -100, 100, 0, base))
    }
    put('tone', tone, notDefault('tone', tone), touched)
    if (legacyPV && (differs('Contrast', 25) || differs('Shadows', 5))) report('Legacy (PV2010) tone')
    if (differs('Brightness', 50) || nonZero('FillLight') || nonZero('HighlightRecovery')) report('Legacy (PV2010) tone')
  }

  // --- white balance (see kelvinToWb). Incremental (non-raw) sliders are
  // already relative ±100 with LR's sign (+temp warmer, +tint magenta) =
  // albedo's wb_mul sign → 1:1. "As Shot" ≡ albedo's 0 → wb left unset
  // (presets: included at defaults = reset to as-shot). "Auto" needs pixels.
  {
    const wbMode = isStr(P.WhiteBalance) ? P.WhiteBalance.trim().toLowerCase() : ''
    const touched = anyKey(['WhiteBalance', 'Temperature', 'Tint', 'IncrementalTemperature', 'IncrementalTint'])
    let wb = { temp: 0, tint: 0 }
    if (wbMode === 'auto') report('Auto white balance')
    else if (wbMode === 'as shot') { /* relative 0 */ } else if (has('IncrementalTemperature') || has('IncrementalTint')) {
      wb = {
        temp: round(slider('IncrementalTemperature', -100, 100, 0, 'IncrementalTemperature')),
        tint: round(slider('IncrementalTint', -100, 100, 0, 'IncrementalTint')),
      }
    } else if (has('Temperature') || WB_PRESETS[wbMode]) {
      const [pk, pt] = WB_PRESETS[wbMode] ?? [WB_REF.k, WB_REF.tint]
      const k = num('Temperature') ?? pk
      const t = num('Tint') ?? pt
      wb = kelvinToWb(k, clamp(t, -150, 150))
      if (Math.abs(wb.temp) === 100 || Math.abs(wb.tint) === 100) {
        warnings.push(`white balance ${k} K / tint ${t} saturates albedo's ±100 range`)
      }
    }
    put('wb', wb, notDefault('wb', wb), touched)
  }

  // --- vibrance / saturation: ±100 both; LR −100 saturation = grayscale =
  // albedo's chroma ×0 at −100 → 1:1.
  {
    const v = { vibrance: round(slider('Vibrance', -100, 100, 0)), saturation: round(slider('Saturation', -100, 100, 0)) }
    put('vibsat', v, notDefault('vibsat', v), anyKey(['Vibrance', 'Saturation']))
  }

  // --- local contrast: Clarity2012 (fallback PV2010 Clarity), Texture,
  // Dehaze are ±100 with the same sign/intent → 1:1.
  {
    const ck = has('Clarity2012') ? 'Clarity2012' : 'Clarity'
    const v = {
      clarity: round(slider(ck, -100, 100, 0, 'Clarity')),
      texture: round(slider('Texture', -100, 100, 0)),
      dehaze: round(slider('Dehaze', -100, 100, 0)),
    }
    put('localcontrast', v, notDefault('localcontrast', v), anyKey([ck, 'Texture', 'Dehaze']))
  }

  // --- point curve: LR ToneCurvePV2012 is a display-referred per-channel
  // (same curve on R,G,B) point curve on 0..255; albedo's curve is the same
  // kind of curve on 0..1 (applied after the sRGB encode) → x/255, y/255.
  // Interpolation differs slightly (albedo: monotone cubic). PV2010's
  // ToneCurve is used when no PV2012 curve exists.
  {
    const key = has('ToneCurvePV2012') ? 'ToneCurvePV2012' : 'ToneCurve'
    const pts = curveFromList(P[key])
    const points = pts && !isIdentityCurve(pts)
      ? pts.map(([x, y]) => [round(x / 255, 4), round(y / 255, 4)])
      : clone(MODULE_DEFAULTS.curve.points)
    put('curve', { points }, !isIdentityCurve(pts), has(key))
    for (const c of ['Red', 'Green', 'Blue']) {
      if (!isIdentityCurve(curveFromList(P[`ToneCurvePV2012${c}`]))) report('RGB channel curves')
    }
    if (['ParametricShadows', 'ParametricDarks', 'ParametricLights', 'ParametricHighlights'].some(nonZero)) {
      report('Parametric curve')
    }
  }

  // --- HSL / color mixer: LR's 8 bands are exactly albedo's 8 bands
  // (red orange yellow green aqua blue purple magenta). Sign conventions
  // agree: +hue moves toward the next band in the red→orange→yellow…
  // direction, which is increasing OKLCh hue in the shader (hShift added to
  // the hue angle); +sat/+lum increase chroma/L. Ranges ±100 → 1:1. Strength
  // differs at the extremes (albedo s −100 keeps 40% chroma at band center,
  // h ±100 ≈ ±30°) — accepted.
  {
    const mix = clone(MODULE_DEFAULTS.colormix)
    let touched = false
    BAND_NAMES.forEach((b, i) => {
      const L = BAND_LR[i]
      for (const [k, pre] of [['h', 'HueAdjustment'], ['s', 'SaturationAdjustment'], ['l', 'LuminanceAdjustment']]) {
        if (has(pre + L)) touched = true
        mix[b][k] = round(slider(pre + L, -100, 100, 0))
      }
    })
    put('colormix', mix, notDefault('colormix', mix), touched)
  }

  // --- B&W: ConvertToGrayscale → bw.on; GrayMixer<Band> ±100 → bw.mix 1:1
  // (both are per-hue-band luminance weights on the same 8 bands). LR writes
  // GrayMixer* into color files too, so a sidecar includes bw only when on.
  {
    const on = bool('ConvertToGrayscale') ? 1 : 0
    const mix = Object.fromEntries(BAND_NAMES.map((b, i) => [b, round(slider(`GrayMixer${BAND_LR[i]}`, -100, 100, 0))]))
    put('bw', { on, mix }, on === 1, has('ConvertToGrayscale'))
  }

  // --- color grading. Shadows/highlights wheels: ColorGradeShadow* when
  // present, else SplitToning* (LR ≥10 itself stores the S/H wheels in the
  // SplitToning* keys). Midtones: ColorGradeMidtone*. Hue: HSL deg → OKLab
  // deg (lrHueToOklab); sat 0..100 → s 1:1; ColorGradeBlending 0..100 → 1:1
  // (both default 50). Balance: LR + favors highlights (moves the split
  // down); albedo + raises both zone pivots (more shadows) → × −1.
  // Global wheel and per-zone luminance have no albedo equivalent.
  {
    const zone = (cgH, cgS, stH, stS) => {
      const hk = has(cgH) ? cgH : stH
      const sk = has(cgS) ? cgS : stS
      const s = round(slider(sk, 0, 100, 0, sk))
      return { h: num(hk) !== undefined ? lrHueToOklab(num(hk)) : 0, s }
    }
    const g = {
      shadows: zone('ColorGradeShadowHue', 'ColorGradeShadowSat', 'SplitToningShadowHue', 'SplitToningShadowSaturation'),
      midtones: zone('ColorGradeMidtoneHue', 'ColorGradeMidtoneSat', '', ''),
      highlights: zone('ColorGradeHighlightHue', 'ColorGradeHighlightSat', 'SplitToningHighlightHue', 'SplitToningHighlightSaturation'),
      blending: round(slider('ColorGradeBlending', 0, 100, 50)),
      balance: round(-slider('SplitToningBalance', -100, 100, 0)),
    }
    const effective = g.shadows.s > 0 || g.midtones.s > 0 || g.highlights.s > 0
    const touched = Object.keys(P).some((k) => k.startsWith('SplitToning') || k.startsWith('ColorGrade'))
    put('grading', g, effective, touched)
    if (['ColorGradeShadowLum', 'ColorGradeMidtoneLum', 'ColorGradeHighlightLum'].some(nonZero)) report('Color grade luminance')
    if (nonZero('ColorGradeGlobalSat') || nonZero('ColorGradeGlobalLum')) report('Color grade global')
  }

  // --- post-crop vignette: amount ±100 (− darkens; albedo exp2(amount/100·
  // 1.2·t) also darkens for −), midpoint 0..100 and feather 0..100 → 1:1.
  // Roundness: LR 0 = frame-shaped ellipse, +100 = circle — albedo's
  // 0..100 exactly; LR's negative (rounded-rectangle) side has no albedo
  // shape (shader clamps to 0) → clamped to 0 with a warning. Style and
  // highlight-contrast sub-controls are ignored.
  {
    const rr = num('PostCropVignetteRoundness') ?? 0
    if (rr < 0 && nonZero('PostCropVignetteAmount')) warnings.push(`vignette roundness ${rr} clamped to 0`)
    const v = {
      amount: round(slider('PostCropVignetteAmount', -100, 100, 0, 'Vignette')),
      midpoint: round(slider('PostCropVignetteMidpoint', 0, 100, 50)),
      roundness: round(clamp(rr, 0, 100)),
      feather: round(slider('PostCropVignetteFeather', 0, 100, 50)),
    }
    put('vignette', v, v.amount !== 0, Object.keys(P).some((k) => k.startsWith('PostCropVignette')))
  }

  // --- grain: albedo's grain mirrors LR's three sliders, same ranges and
  // defaults (amount 0..100, size 0..100 def 25, roughness 0..100 def 50 =
  // LR GrainFrequency) → 1:1. GrainSeed is bookkeeping.
  {
    const v = {
      amount: round(slider('GrainAmount', 0, 100, 0)),
      size: round(slider('GrainSize', 0, 100, 25)),
      roughness: round(slider('GrainFrequency', 0, 100, 50)),
    }
    put('grain', v, v.amount > 0, anyKey(['GrainAmount', 'GrainSize', 'GrainFrequency']))
  }

  // --- geometry. Crop rect: normalized stored-orientation coords → albedo
  // source-normalized via tiff:Orientation (see ORIENT). Angle: LR + rotates
  // the image clockwise on screen (the crop frame tilts CCW); albedo + is
  // CCW → negated, clamped ±45.
  // Approximation: LR's rect is the crop expressed in the ROTATED frame;
  // albedo's crop is axis-aligned in source coords and rotates about its
  // center. We keep LR's center and normalized w/h and let albedo rotate
  // about that center — exact for angle 0, and for small angles the center
  // and size match to first order; any overflow past the frame is absorbed
  // by albedo's inscribed auto-zoom (fitScale ≥ 1), so it never shows edges.
  // Perspective: LR Vertical − widens the top (fixes up-tilted verticals);
  // albedo's keystone with v < 0 makes pw > 1 at the top, i.e. also widens
  // the top → same sign, 1:1 (albedo ±100 = ±0.3 homography weight; LR's
  // full-scale strength differs). Horizontal by the same analogy (+ enlarges
  // the right edge in both) → 1:1.
  {
    const hasCropKey = anyKey(['CropLeft', 'CropTop', 'CropRight', 'CropBottom'])
    let hasCrop = bool('HasCrop')
    if (hasCrop === undefined) hasCrop = hasCropKey
    const geom = clone(MODULE_DEFAULTS.geometry)
    const orient = Number(side.orientation ?? 1)
    const [omap, osign] = ORIENT[orient] ?? ORIENT[1]
    if (!ORIENT[orient]) warnings.push(`unknown tiff:Orientation ${side.orientation}; crop assumed upright`)
    if (hasCrop) {
      const l = clamp(num('CropLeft') ?? 0, 0, 1)
      const t = clamp(num('CropTop') ?? 0, 0, 1)
      const r = clamp(num('CropRight') ?? 1, 0, 1)
      const b = clamp(num('CropBottom') ?? 1, 0, 1)
      if (r - l > 1e-4 && b - t > 1e-4) {
        const c1 = omap(l, t)
        const c2 = omap(r, b)
        const x = Math.min(c1[0], c2[0])
        const y = Math.min(c1[1], c2[1])
        geom.crop = {
          x: round(x, 6), y: round(y, 6),
          w: round(Math.abs(c2[0] - c1[0]), 6), h: round(Math.abs(c2[1] - c1[1]), 6),
        }
      } else warnings.push('degenerate crop rectangle ignored')
      const a = num('CropAngle') ?? 0
      if (Math.abs(a) > 45) warnings.push(`CropAngle ${a} clamped to ±45`)
      geom.angle = round(-osign * clamp(a, -45, 45), 3)
    }
    geom.persp = {
      v: round(slider('PerspectiveVertical', -100, 100, 0)),
      h: round(slider('PerspectiveHorizontal', -100, 100, 0)),
    }
    const touched = has('HasCrop') || hasCropKey || anyKey(['CropAngle', 'PerspectiveVertical', 'PerspectiveHorizontal'])
    put('geometry', geom, notDefault('geometry', geom), touched)
    if (nonZero('PerspectiveUpright')) report('Upright')
    if (nonZero('PerspectiveRotate') || differs('PerspectiveScale', 100) || nonZero('PerspectiveAspect')
      || nonZero('PerspectiveX') || nonZero('PerspectiveY')) report('Transform rotate/scale/offset')
  }

  // --- detail: albedo's detail module mirrors LR's (defaults 40 / 1.0 / 0 /
  // 0 / 25; ranges Sharpness 0..150, radius 0.5..3, masking/NR 0..100) →
  // 1:1. Sidecar baseline: raw files compare against MODULE_DEFAULTS.detail
  // (what albedo applies implicitly to raw); non-raw files (Incremental WB or
  // a JPEG/TIFF RawFileName) against "all off", since albedo disables detail
  // on bitmaps unless the module is present — so a JPEG with LR's default
  // 40/25 is still imported, and LR's non-raw 0/0 is not.
  {
    const base = nonRaw ? { sharpenAmount: 0, sharpenRadius: 1, sharpenMasking: 0, lumaNR: 0, chromaNR: 0 } : MODULE_DEFAULTS.detail
    const v = {
      sharpenAmount: round(slider('Sharpness', 0, 150, base.sharpenAmount)),
      sharpenRadius: round(slider('SharpenRadius', 0.5, 3, base.sharpenRadius), 1),
      sharpenMasking: round(slider('SharpenEdgeMasking', 0, 100, base.sharpenMasking)),
      lumaNR: round(slider('LuminanceSmoothing', 0, 100, base.lumaNR)),
      chromaNR: round(slider('ColorNoiseReduction', 0, 100, base.chromaNR)),
    }
    const effective = nonRaw ? (v.sharpenAmount > 0 || v.lumaNR > 0 || v.chromaNR > 0) : notDefault('detail', v)
    put('detail', v, effective,
      anyKey(['Sharpness', 'SharpenRadius', 'SharpenEdgeMasking', 'LuminanceSmoothing', 'ColorNoiseReduction']))
    if (differs('SharpenDetail', 25)) report('Sharpen detail')
    if (differs('LuminanceNoiseReductionDetail', 50) || nonZero('LuminanceNoiseReductionContrast')
      || differs('ColorNoiseReductionDetail', 50) || differs('ColorNoiseReductionSmoothness', 50)) {
      report('Noise reduction detail')
    }
  }

  // --- lens. Distortion: LR + corrects BARREL (applies a pincushion warp);
  // albedo's inverse remap r' = r(1 + k1·r²·0.15) with k1 > 0 samples further
  // out toward the edges, bowing straight lines outward (adds barrel =
  // corrects pincushion) → × −1. Defringe: LR Purple/Green amounts 0..20
  // each; albedo has one 0..100 control covering both hue families →
  // 5·max(p, g). Hue-range sub-sliders ignored.
  {
    const p = slider('DefringePurpleAmount', 0, 20, 0)
    const gr = slider('DefringeGreenAmount', 0, 20, 0)
    // lens profile scales (0..200) map 1:1. LR's LensProfileEnable is not
    // read: LR writes 0 into every untouched file, while albedo applies its
    // own lensfun match by default, which is the better start
    const v = {
      distortion: round(-slider('LensManualDistortionAmount', -100, 100, 0, 'Distortion')),
      defringe: round(5 * Math.max(p, gr)),
      profDistortion: round(slider('LensProfileDistortionScale', 0, 200, 100)),
      profVignette: round(slider('LensProfileVignettingScale', 0, 200, 100)),
    }
    put('lens', v, notDefault('lens', v), anyKey(['LensManualDistortionAmount', 'DefringePurpleAmount',
      'DefringeGreenAmount']))
    if (bool('AutoLateralCA') || nonZero('ChromaticAberrationR') || nonZero('ChromaticAberrationB')) {
      report('Chromatic aberration')
    }
    if (nonZero('VignetteAmount')) report('Lens vignetting')
    if (nonZero('Defringe')) report('Defringe (legacy)')
  }

  // --- not representable: calibration, profile/look, local work, misc
  if (['RedHue', 'RedSaturation', 'GreenHue', 'GreenSaturation', 'BlueHue', 'BlueSaturation', 'ShadowTint']
    .some(nonZero)) report('Calibration')
  {
    const prof = isStr(P.CameraProfile) ? P.CameraProfile.trim().toLowerCase() : ''
    const look = P.Look?.struct
    const lookName = look ? (isStr(look.Name) ? look.Name.trim().toLowerCase() : '') : ''
    if (!PROFILE_NEUTRAL.has(prof) || (look && !P.Look.empty && !LOOK_NEUTRAL.has(lookName))) report('Profile/Look')
  }
  if (bool('AutoTone') || bool('AutoExposure')) report('Auto tone')
  const nonEmpty = (v) => (v?.list ? v.list.length > 0 : v?.struct ? !v.empty : isStr(v) && v.trim() !== '')
  if (['MaskGroupBasedCorrections', 'GradientBasedCorrections', 'CircularGradientBasedCorrections', 'PaintBasedCorrections']
    .some((k) => nonEmpty(P[k]))) report('Masks')
  if (nonEmpty(P.RetouchInfo) || nonEmpty(P.RetouchAreas)) report('Spot removal')
  if (nonEmpty(P.RedEyeInfo) || nonEmpty(P.PetEyeInfo)) report('Red eye')
  if (nonEmpty(P.PointColors)) report('Point color')
  if (P.LensBlur?.struct && !P.LensBlur.empty && toBool(P.LensBlur.struct.Active) !== false) report('Lens blur')
  if (nonZero('HDREditMode')) report('HDR editing')

  return { name, modules, unmapped, isPreset, warnings }
}

export function xmpSummary(unmapped) {
  return unmapped?.length ? `Not imported: ${unmapped.join(', ')}` : ''
}
