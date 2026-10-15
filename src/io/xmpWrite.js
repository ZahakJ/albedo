// Lightroom / Camera Raw XMP export — albedo edit doc → crs: sidecar or
// preset. Pure ES module (browser + Node). The exact inverse of parseXmp in
// ./xmp.js: every mapping there is undone here, so
// parseXmp(writeXmp(doc)).modules reproduces doc.modules on every mapped
// field (to the slider resolution LR stores).
//
//   writeXmp(doc, meta?) → sidecar text (.xmp next to the photo)
//   writePresetXmp(name, group, modules, opts?) → LR-importable .xmp preset
//   readAlbedoXmp(text) → the embedded albedo edit doc / preset modules, or null
//
// meta: { filename, rating 0..5, flag (-1 reject → Rating -1), label
// ('red'|'yellow'|'green'|'blue'|'purple'), title, caption, keywords [],
// orientation (the ORIGINAL's EXIF orientation, 1..8 — LR's crop is in stored
// sensor coords), isRaw (default: inferred from filename), albedo (default
// true: embed the doc) }.
//
// What Lightroom cannot represent (masks, heal spots, exposure.black, lens
// CA, geometry.flipH, recon) is NOT approximated in crs:, since a near-miss
// would be misread; the whole edit doc travels instead as JSON in one
// attribute of the albedo: namespace, which LR preserves and ignores.

import { MODULE_DEFAULTS, BAND_NAMES } from '../engine/editdoc.js'
import { kelvinToWb, lrHueToOklab, ORIENT, WB_REF, BAND_LR } from './xmp.js'

export const NS_ALBEDO = 'https://albedo.photo/ns/1.0/'
// PV6 (LR Classic 12.4 / ACR 15.4) is the current process version
export const PROCESS_VERSION = '15.4'
const CRS_VERSION = '15.4'

const NS = {
  x: 'adobe:ns:meta/',
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  xmp: 'http://ns.adobe.com/xap/1.0/',
  tiff: 'http://ns.adobe.com/tiff/1.0/',
  dc: 'http://purl.org/dc/elements/1.1/',
  crs: 'http://ns.adobe.com/camera-raw-settings/1.0/',
  albedo: NS_ALBEDO,
}

const NONRAW_EXT = /\.(jpe?g|tiff?|png|heic|heif|webp|psd|avif)$/i
const LABELS = { red: 'Red', yellow: 'Yellow', green: 'Green', blue: 'Blue', purple: 'Purple' }
// inverse of ORIENT's stored → displayed maps (6 and 8 are each other's inverse)
const ORIENT_INV = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 8, 7: 7, 8: 6 }

// ---------------------------------------------------------------------------
// formatting

// attribute values: whitespace as char refs, or attribute-value
// normalisation would turn it into spaces; element text keeps it
const escText = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])
const esc = (s) => String(s).replace(/[&<>"\t\n\r]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\t': '&#x9;', '\n': '&#xA;', '\r': '&#xD;' })[c])
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const num = (v, d = 0) => {
  const k = 10 ** d
  const r = Math.round(v * k) / k
  return r === 0 ? '0' : String(r)
}
// LR writes signed sliders with an explicit '+'
const sgn = (v, d = 0) => { const s = num(v, d); return s !== '0' && s[0] !== '-' ? '+' + s : s }
const bool = (b) => (b ? 'True' : 'False')

const mod = (modules, name) => ({ ...structuredClone(MODULE_DEFAULTS[name]), ...(modules?.[name] ?? {}) })

// ---------------------------------------------------------------------------
// inverses of the parser's non-linear maps

// kelvinToWb is separable and monotonic per axis: temp rises with K, tint
// with LR tint. Search outward from the reference for the integer LR value
// whose (rounded) image is closest to the target; ties and saturated targets
// (±100 covers a whole range of K) resolve toward the reference, so LR gets
// the mildest setting. LR stores both as integers, so tint's resolution is
// ~2.4 albedo units (temp's is far finer than 1).
function searchInt(lo, hi, ref, f, target) {
  let cand
  if (target >= f(ref)) {
    // smallest x ≥ ref with f(x) ≥ target
    let a = ref
    let b = hi
    if (f(b) < target) return b
    while (b - a > 1) { const m = (a + b) >> 1; if (f(m) >= target) b = m; else a = m }
    cand = f(a) >= target ? [a] : [b - 1, b]
  } else {
    // largest x ≤ ref with f(x) ≤ target
    let a = lo
    let b = ref
    if (f(a) > target) return a
    while (b - a > 1) { const m = (a + b) >> 1; if (f(m) <= target) a = m; else b = m }
    cand = f(b) <= target ? [b] : [a, a + 1]
  }
  return cand.reduce((best, x) => {
    const d = Math.abs(f(x) - target) - Math.abs(f(best) - target)
    return d < 0 || (d === 0 && Math.abs(x - ref) < Math.abs(best - ref)) ? x : best
  })
}

export function wbToKelvin({ temp = 0, tint = 0 }) {
  const t = clamp(temp, -100, 100)
  const ti = clamp(tint, -100, 100)
  return {
    kelvin: t === 0 ? WB_REF.k : searchInt(2000, 15000, WB_REF.k, (k) => kelvinToWb(k, WB_REF.tint).temp, t),
    tint: ti === 0 ? WB_REF.tint : searchInt(-150, 150, WB_REF.tint, (x) => kelvinToWb(WB_REF.k, x).tint, ti),
  }
}

// OKLab hue (albedo grading) → LR HSL hue: the integer HSL hue whose
// fully-saturated color lands nearest on the OKLab circle
const HUE_TABLE = Array.from({ length: 360 }, (_, h) => lrHueToOklab(h))
export function oklabHueToLr(deg) {
  const d = ((deg % 360) + 360) % 360
  let best = 0
  let bestErr = Infinity
  for (let h = 0; h < 360; h++) {
    const e = Math.abs(((HUE_TABLE[h] - d + 540) % 360) - 180)
    if (e < bestErr) { bestErr = e; best = h }
  }
  return best
}

// ---------------------------------------------------------------------------
// modules → crs properties. Returns { attrs: [[key, value]], seqs: [[key,
// items]] }. `only` limits output to the modules a preset carries.

function crsSettings(modules, { isRaw = true, orientation = 1, only = null } = {}) {
  const attrs = []
  const seqs = []
  const want = (m) => !only || only.has(m)
  const a = (k, v) => attrs.push([k, v])

  if (want('wb')) {
    // bitmaps always carry the Incremental pair (LR does too), which is also
    // how a reader tells a non-raw sidecar apart
    const wb = mod(modules, 'wb')
    if (wb.temp === 0 && wb.tint === 0) {
      a('WhiteBalance', 'As Shot')
      if (!isRaw) { a('IncrementalTemperature', '0'); a('IncrementalTint', '0') }
    } else if (isRaw) {
      const { kelvin, tint } = wbToKelvin(wb)
      a('WhiteBalance', 'Custom')
      a('Temperature', num(kelvin))
      a('Tint', sgn(tint))
    } else {
      a('WhiteBalance', 'Custom')
      a('IncrementalTemperature', sgn(clamp(wb.temp, -100, 100)))
      a('IncrementalTint', sgn(clamp(wb.tint, -100, 100)))
    }
  }
  if (want('exposure')) a('Exposure2012', sgn(clamp(mod(modules, 'exposure').ev, -5, 5), 2))
  if (want('tone')) {
    const t = mod(modules, 'tone')
    a('Contrast2012', sgn(t.contrast))
    a('Highlights2012', sgn(t.highlights))
    a('Shadows2012', sgn(t.shadows))
    a('Whites2012', sgn(t.whites))
    a('Blacks2012', sgn(t.blacks))
  }
  if (want('localcontrast')) {
    const l = mod(modules, 'localcontrast')
    a('Texture', sgn(l.texture))
    a('Clarity2012', sgn(l.clarity))
    a('Dehaze', sgn(l.dehaze))
  }
  if (want('vibsat')) {
    const v = mod(modules, 'vibsat')
    a('Vibrance', sgn(v.vibrance))
    a('Saturation', sgn(v.saturation))
  }
  if (want('detail')) {
    // bitmaps: an absent detail module means "off" in albedo, so say so
    const d = !isRaw && !modules?.detail
      ? { sharpenAmount: 0, sharpenRadius: 1, sharpenMasking: 0, lumaNR: 0, chromaNR: 0 }
      : mod(modules, 'detail')
    a('Sharpness', num(clamp(d.sharpenAmount, 0, 150)))
    a('SharpenRadius', sgn(clamp(d.sharpenRadius, 0.5, 3), 1))
    a('SharpenDetail', '25')
    a('SharpenEdgeMasking', num(clamp(d.sharpenMasking, 0, 100)))
    a('LuminanceSmoothing', num(clamp(d.lumaNR, 0, 100)))
    a('LuminanceNoiseReductionDetail', '50')
    a('LuminanceNoiseReductionContrast', '0')
    a('ColorNoiseReduction', num(clamp(d.chromaNR, 0, 100)))
    a('ColorNoiseReductionDetail', '50')
    a('ColorNoiseReductionSmoothness', '50')
  }
  if (want('colormix')) {
    const c = mod(modules, 'colormix')
    for (const [k, pre] of [['h', 'HueAdjustment'], ['s', 'SaturationAdjustment'], ['l', 'LuminanceAdjustment']]) {
      BAND_NAMES.forEach((b, i) => a(pre + BAND_LR[i], sgn(c[b]?.[k] ?? 0)))
    }
  }
  if (want('bw')) {
    const bw = mod(modules, 'bw')
    a('ConvertToGrayscale', bool(bw.on))
    BAND_NAMES.forEach((b, i) => a('GrayMixer' + BAND_LR[i], sgn(bw.mix?.[b] ?? 0)))
  }
  if (want('grading')) {
    // LR ≥ 10 keeps the shadow/highlight wheels in the SplitToning* keys and
    // only the midtone wheel in ColorGrade*; hue is always written (even at
    // s 0) so the zone's hue survives the trip
    const g = mod(modules, 'grading')
    a('SplitToningShadowHue', num(oklabHueToLr(g.shadows.h)))
    a('SplitToningShadowSaturation', num(clamp(g.shadows.s, 0, 100)))
    a('SplitToningHighlightHue', num(oklabHueToLr(g.highlights.h)))
    a('SplitToningHighlightSaturation', num(clamp(g.highlights.s, 0, 100)))
    a('SplitToningBalance', sgn(-clamp(g.balance, -100, 100)))
    a('ColorGradeMidtoneHue', num(oklabHueToLr(g.midtones.h)))
    a('ColorGradeMidtoneSat', num(clamp(g.midtones.s, 0, 100)))
    a('ColorGradeShadowLum', '0')
    a('ColorGradeMidtoneLum', '0')
    a('ColorGradeHighlightLum', '0')
    a('ColorGradeBlending', num(clamp(g.blending, 0, 100)))
    a('ColorGradeGlobalHue', '0')
    a('ColorGradeGlobalSat', '0')
    a('ColorGradeGlobalLum', '0')
  }
  if (want('lens')) {
    // defringe = 5·max(purple, green) → both at defringe/5 (0..20 integers)
    const l = mod(modules, 'lens')
    const df = Math.round(clamp(l.defringe, 0, 100) / 5)
    a('LensManualDistortionAmount', sgn(-clamp(l.distortion, -100, 100)))
    a('DefringePurpleAmount', num(df))
    a('DefringePurpleHueLo', '30')
    a('DefringePurpleHueHi', '70')
    a('DefringeGreenAmount', num(df))
    a('DefringeGreenHueLo', '40')
    a('DefringeGreenHueHi', '60')
    a('LensProfileEnable', (l.profile ?? 1) ? '1' : '0')
    a('LensProfileSetup', 'LensDefaults')
    a('LensProfileDistortionScale', num(Math.round(clamp(l.profDistortion ?? 100, 0, 200))))
    a('LensProfileVignettingScale', num(Math.round(clamp(l.profVignette ?? 100, 0, 200))))
  }
  if (want('geometry')) {
    const g = mod(modules, 'geometry')
    a('PerspectiveVertical', sgn(clamp(g.persp.v, -100, 100)))
    a('PerspectiveHorizontal', sgn(clamp(g.persp.h, -100, 100)))
    a('PerspectiveRotate', '0.0')
    a('PerspectiveScale', '100')
    a('PerspectiveAspect', '0')
    a('PerspectiveUpright', '0')
    a('PerspectiveX', '0.00')
    a('PerspectiveY', '0.00')
    // albedo crop is in upright source coords; LR's in stored coords, so map
    // back through the inverse orientation; mirrored orientations also flip
    // the rotation sense (ORIENT's sign)
    const o = ORIENT[orientation] ? orientation : 1
    const inv = ORIENT[ORIENT_INV[o]][0]
    const osign = ORIENT[o][1]
    const { x, y, w, h } = g.crop
    const c1 = inv(x, y)
    const c2 = inv(x + w, y + h)
    const cropped = x !== 0 || y !== 0 || w !== 1 || h !== 1 || g.angle !== 0
    a('CropTop', num(clamp(Math.min(c1[1], c2[1]), 0, 1), 6))
    a('CropLeft', num(clamp(Math.min(c1[0], c2[0]), 0, 1), 6))
    a('CropBottom', num(clamp(Math.max(c1[1], c2[1]), 0, 1), 6))
    a('CropRight', num(clamp(Math.max(c1[0], c2[0]), 0, 1), 6))
    a('CropAngle', num(-osign * clamp(g.angle, -45, 45), 3))
    a('CropConstrainToWarp', '0')
    a('HasCrop', bool(cropped))
  }
  if (want('vignette')) {
    const v = mod(modules, 'vignette')
    a('PostCropVignetteAmount', sgn(clamp(v.amount, -100, 100)))
    a('PostCropVignetteMidpoint', num(clamp(v.midpoint, 0, 100)))
    a('PostCropVignetteFeather', num(clamp(v.feather, 0, 100)))
    a('PostCropVignetteRoundness', sgn(clamp(v.roundness, 0, 100)))
    a('PostCropVignetteStyle', '1')
    a('PostCropVignetteHighlightContrast', '0')
  }
  if (want('grain')) {
    const g = mod(modules, 'grain')
    a('GrainAmount', num(clamp(g.amount, 0, 100)))
    a('GrainSize', num(clamp(g.size, 0, 100)))
    a('GrainFrequency', num(clamp(g.roughness, 0, 100)))
  }
  if (want('curve')) {
    // integer 0..255 points (what LR writes and reads); rounding may merge
    // two close points, keep the first
    const pts = []
    for (const [px, py] of mod(modules, 'curve').points) {
      const p = [Math.round(clamp(px, 0, 1) * 255), Math.round(clamp(py, 0, 1) * 255)]
      if (!pts.length || p[0] > pts[pts.length - 1][0]) pts.push(p)
    }
    const identity = pts.every(([x, y]) => x === y)
    a('ToneCurveName2012', identity ? 'Linear' : 'Custom')
    const lin = ['0, 0', '255, 255']
    seqs.push(['ToneCurvePV2012', identity ? lin : pts.map(([x, y]) => `${x}, ${y}`)])
    seqs.push(['ToneCurvePV2012Red', lin], ['ToneCurvePV2012Green', lin], ['ToneCurvePV2012Blue', lin])
  }
  return { attrs, seqs }
}

// ---------------------------------------------------------------------------
// XMP assembly

const nsDecl = (prefixes) => prefixes.map((p) => `\n    xmlns:${p}="${NS[p]}"`).join('')
const attrLines = (pairs) => pairs.map(([k, v]) => `\n   ${k}="${esc(v)}"`).join('')
const alt = (tag, text) => `   <${tag}>\n    <rdf:Alt>\n     <rdf:li xml:lang="x-default">${escText(text)}</rdf:li>\n    </rdf:Alt>\n   </${tag}>\n`
const seq = (tag, items, kind = 'Seq') => `   <${tag}>\n    <rdf:${kind}>\n${items.map((i) => `     <rdf:li>${escText(i)}</rdf:li>\n`).join('')}    </rdf:${kind}>\n   </${tag}>\n`

const packet = (prefixes, attrs, body) =>
  `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="albedo">
 <rdf:RDF xmlns:rdf="${NS.rdf}">
  <rdf:Description rdf:about=""${nsDecl(prefixes)}${attrLines(attrs)}>
${body}  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
`

export function writeXmp(doc, meta = {}) {
  const modules = doc?.modules ?? {}
  const filename = meta.filename ?? null
  const isRaw = meta.isRaw ?? !(filename && NONRAW_EXT.test(filename))
  const orientation = Number(meta.orientation ?? 1)
  const attrs = [['xmp:CreatorTool', 'albedo']]
  if (meta.flag === -1) attrs.push(['xmp:Rating', '-1'])
  else if (Number.isFinite(meta.rating)) attrs.push(['xmp:Rating', num(clamp(Math.round(meta.rating), 0, 5))])
  if (meta.label && LABELS[String(meta.label).toLowerCase()]) attrs.push(['xmp:Label', LABELS[String(meta.label).toLowerCase()]])
  // only echo an orientation we were told: in a sidecar LR takes it as the
  // photo's orientation
  if (meta.orientation != null && ORIENT[orientation]) attrs.push(['tiff:Orientation', num(orientation)])
  attrs.push(['crs:Version', CRS_VERSION], ['crs:ProcessVersion', PROCESS_VERSION])
  if (filename) attrs.push(['crs:RawFileName', filename])
  const { attrs: crs, seqs } = crsSettings(modules, { isRaw, orientation })
  for (const [k, v] of crs) attrs.push(['crs:' + k, v])
  attrs.push(['crs:HasSettings', 'True'], ['crs:AlreadyApplied', 'False'])
  const prefixes = ['xmp', 'tiff', 'dc', 'crs']
  if (meta.albedo !== false) {
    prefixes.push('albedo')
    attrs.push(['albedo:EditDoc', JSON.stringify(doc)])
  }

  let body = ''
  if (meta.title) body += alt('dc:title', meta.title)
  if (meta.caption) body += alt('dc:description', meta.caption)
  const kw = (meta.keywords ?? []).filter((k) => typeof k === 'string' && k.trim())
  if (kw.length) body += seq('dc:subject', kw, 'Bag')
  for (const [k, items] of seqs) body += seq('crs:' + k, items)
  return packet(prefixes, attrs, body)
}

// Lightroom-importable preset (Develop → Presets → Import, or drop into
// CameraRaw/Settings). Only the given modules are written, so LR applies
// exactly those groups; a module present at defaults means "reset it".
// opts: { isRaw (default true: WB as Kelvin), uuid, albedo (embed modules) }
export function writePresetXmp(name, group, modules, opts = {}) {
  const only = new Set(Object.keys(modules ?? {}))
  const uuid = opts.uuid ?? randomUuidHex()
  const attrs = [
    ['crs:PresetType', 'Normal'],
    ['crs:Cluster', ''],
    ['crs:UUID', uuid],
    ['crs:SupportsAmount', 'False'],
    ['crs:SupportsAmount2', 'True'],
    ['crs:SupportsColor', 'True'],
    ['crs:SupportsMonochrome', 'True'],
    ['crs:SupportsHighDynamicRange', 'True'],
    ['crs:SupportsNormalDynamicRange', 'True'],
    ['crs:SupportsSceneReferred', 'True'],
    ['crs:SupportsOutputReferred', 'True'],
    ['crs:RequiresRGBTables', 'False'],
    ['crs:CameraModelRestriction', ''],
    ['crs:Copyright', ''],
    ['crs:ContactInfo', ''],
    ['crs:Version', CRS_VERSION],
    ['crs:ProcessVersion', PROCESS_VERSION],
  ]
  const { attrs: crs, seqs } = crsSettings(modules, { isRaw: opts.isRaw ?? true, only })
  for (const [k, v] of crs) attrs.push(['crs:' + k, v])
  attrs.push(['crs:HasSettings', 'True'])
  const prefixes = ['crs']
  if (opts.albedo !== false) {
    prefixes.push('albedo')
    attrs.push(['albedo:PresetModules', JSON.stringify(modules ?? {})])
  }
  let body = alt('crs:Name', name ?? 'Untitled') + alt('crs:ShortName', '') + alt('crs:SortName', '')
    + alt('crs:Group', group ?? '') + alt('crs:Description', '')
  for (const [k, items] of seqs) body += seq('crs:' + k, items)
  return packet(prefixes, attrs, body)
}

// 32 uppercase hex chars, the form LR uses for crs:UUID
function randomUuidHex() {
  const b = new Uint8Array(16)
  globalThis.crypto.getRandomValues(b)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('').toUpperCase()
}

// ---------------------------------------------------------------------------
// albedo round-trip: { doc } from a sidecar, { modules } from a preset, or
// null. Reads the attribute form writeXmp emits (any prefix bound to the
// albedo namespace URI).

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const unesc = (s) => s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
  return ENT[e] ?? m
})

export function readAlbedoXmp(text) {
  if (typeof text !== 'string') return null
  const prefixes = [...text.matchAll(/xmlns:([\w.-]+)\s*=\s*["']([^"']*)["']/g)]
    .filter((m) => m[2] === NS_ALBEDO).map((m) => m[1])
  for (const p of prefixes) {
    for (const [key, field] of [['EditDoc', 'doc'], ['PresetModules', 'modules']]) {
      const re = new RegExp(`\\s${p.replace(/[.-]/g, '\\$&')}:${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`)
      const m = re.exec(text)
      if (!m) continue
      try { return { [field]: JSON.parse(unesc(m[1] ?? m[2])) } } catch { return null }
    }
  }
  return null
}
