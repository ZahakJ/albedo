import bidiFactory from 'bidi-js'
import { woffToSfnt } from './woff.js'

// Text layout for type layers: HarfBuzz shapes, bidi-js orders (Unicode
// Bidirectional Algorithm), and this file breaks lines, falls back across
// fonts per run (an Arabic run in a Latin-only font takes IBM Plex Sans
// Arabic), applies tracking, and places glyphs. The result is glyph ids with
// positions in px; draw.js turns them into outlines.

let hbP = null
export const loadHarfBuzz = () => (hbP ??= import('harfbuzzjs'))

let bidi = null
const getBidi = () => (bidi ??= bidiFactory())

// fonts: family → [{ weight, style, font (hb.Font), face, upem, ext }]
export class FontStore {
  constructor(hb) { this.hb = hb; this.families = new Map(); this.fallback = [] }
  async add(family, weight, bytes, { style = 'normal', fallback = false } = {}) {
    const sfnt = await woffToSfnt(bytes)
    const hb = this.hb
    const blob = new hb.Blob(sfnt.buffer.slice(sfnt.byteOffset, sfnt.byteOffset + sfnt.byteLength))
    const face = new hb.Face(blob, 0)
    const font = new hb.Font(face)
    const ext = font.hExtents()
    const rec = { family, weight, style, font, face, upem: face.upem, ext, paths: new Map() }
    if (!this.families.has(family)) this.families.set(family, [])
    this.families.get(family).push(rec)
    if (fallback) this.fallback.push(rec)
    return rec
  }
  has(family) { return this.families.has(family) }
  list() { return [...this.families.keys()] }
  resolve(family, weight = 400) {
    const recs = this.families.get(family) ?? this.families.get(this.fallback[0]?.family) ?? [...this.families.values()][0]
    if (!recs) return null
    let best = recs[0]
    for (const r of recs) if (Math.abs(r.weight - weight) < Math.abs(best.weight - weight)) best = r
    return best
  }
  // same weight from each fallback family, for runs the primary can't show
  fallbacksFor(weight) {
    const fams = [...new Set(this.fallback.map((r) => r.family))]
    return fams.map((f) => this.resolve(f, weight))
  }
  path(rec, gid) {
    let p = rec.paths.get(gid)
    if (p === undefined) { p = rec.font.glyphToPath(gid); rec.paths.set(gid, p) }
    return p
  }
}

const SPACE = /\s/
const isBreak = (ch) => ch === ' ' || ch === '　' || ch === '\t' || ch === '​'

// shape one run with a font; returns glyphs (visual order) and whether any
// glyph is missing (.notdef) for a non-space character
function shapeRun(hb, rec, text, start, end, rtl, features) {
  const buf = new hb.Buffer()
  buf.addText(text.slice(start, end))
  buf.guessSegmentProperties()
  buf.setDirection(rtl ? hb.Direction.RTL : hb.Direction.LTR)
  hb.shape(rec.font, buf, features)
  const infos = buf.getGlyphInfos()
  const pos = buf.getGlyphPositions()
  let missing = false
  const glyphs = infos.map((g, i) => {
    const ch = text[start + g.cluster]
    if (g.codepoint === 0 && ch && !SPACE.test(ch)) missing = true
    return { gid: g.codepoint, cluster: start + g.cluster, ax: pos[i].xAdvance, dx: pos[i].xOffset, dy: pos[i].yOffset, rec }
  })
  return { glyphs, missing }
}

// split a run where the primary font lacks glyphs: per character, the first
// font of [primary, ...fallbacks] that has it (by nominal glyph), grouped
function fontRuns(store, primary, fallbacks, text, start, end) {
  const pick = (cp) => {
    if (primary.font.nominalGlyph?.(cp)) return primary
    for (const f of fallbacks) if (f?.font.nominalGlyph?.(cp)) return f
    return primary
  }
  const out = []
  let i = start
  let cur = null
  let runStart = start
  while (i < end) {
    const cp = text.codePointAt(i)
    const n = cp > 0xffff ? 2 : 1
    // combining marks and spaces stay with the run they are in
    const f = SPACE.test(text[i]) || /\p{M}/u.test(text[i]) ? (cur ?? pick(cp)) : pick(cp)
    if (cur && f !== cur) { out.push({ start: runStart, end: i, rec: cur }); runStart = i }
    cur = f
    i += n
  }
  if (cur) out.push({ start: runStart, end, rec: cur })
  return out
}

// t: the text props of a node (model.js TEXT_DEFAULTS)
export function layoutText(hb, store, t) {
  const size = t.size
  const primary = store.resolve(t.font, t.weight)
  if (!primary) return null
  const fallbacks = store.fallbacksFor(t.weight).filter((r) => r && r !== primary)
  const features = []
  if (t.kerning === false) features.push(hb.Feature.fromString('-kern'))
  if (t.ligatures === false) { features.push(hb.Feature.fromString('-liga')); features.push(hb.Feature.fromString('-clig')) }
  const track = (t.tracking ?? 0) / 1000 * size
  const B = getBidi()
  const lineH = size * (t.leading ?? 1.2)
  const lines = []
  const paragraphs = (t.content ?? '').split('\n')
  let baseRtl = false
  let firstAscent = 0
  for (const para of paragraphs) {
    const dir = t.direction === 'rtl' ? 'rtl' : t.direction === 'ltr' ? 'ltr' : 'auto'
    const emb = B.getEmbeddingLevels(para, dir === 'auto' ? undefined : dir)
    const paraRtl = emb.paragraphs[0]?.level % 2 === 1
    if (!lines.length) baseRtl = paraRtl
    const levels = emb.levels
    // level runs (logical), then font runs inside them, shaped
    const shaped = [] // { start, end, level, glyphs }
    let i = 0
    while (i < para.length) {
      let j = i + 1
      while (j < para.length && levels[j] === levels[i]) j++
      const rtl = levels[i] % 2 === 1
      for (const fr of fontRuns(store, primary, fallbacks, para, i, j)) {
        const r = shapeRun(hb, fr.rec, para, fr.start, fr.end, rtl, features)
        shaped.push({ start: fr.start, end: fr.end, level: levels[i], glyphs: r.glyphs, rec: fr.rec })
      }
      i = j
    }
    // per-character advance (px) for line breaking, from the shaped glyphs
    const adv = new Float32Array(para.length + 1)
    for (const run of shaped) {
      for (const g of run.glyphs) adv[g.cluster] += (g.ax * size) / g.rec.upem + track
    }
    // greedy breaking at spaces when the box has a width
    const breaks = []
    if (t.width > 0 && para.length) {
      let lineStart = 0, w = 0, lastBreak = -1
      for (let c = 0; c < para.length; c++) {
        w += adv[c]
        if (isBreak(para[c])) lastBreak = c + 1
        if (w > t.width && c > lineStart && !isBreak(para[c])) {
          const at = lastBreak > lineStart ? lastBreak : c
          breaks.push([lineStart, at])
          lineStart = at
          lastBreak = -1
          w = 0
          for (let k = at; k <= c; k++) w += adv[k]
        }
      }
      breaks.push([lineStart, para.length])
    } else breaks.push([0, para.length])
    for (const [ls, le] of breaks) {
      // the runs of this line, clipped and reshaped where they were split
      const runs = []
      for (const run of shaped) {
        const s = Math.max(run.start, ls), e = Math.min(run.end, le)
        if (e <= s) continue
        let glyphs = run.glyphs
        if (s !== run.start || e !== run.end) glyphs = shapeRun(hb, run.rec, para, s, e, run.level % 2 === 1, features).glyphs
        runs.push({ level: run.level, glyphs })
      }
      // trailing spaces don't count towards the line's width (alignment)
      // visual order of runs: reverse sequences at each level ≥ k (UAX #9 L2)
      const maxL = runs.reduce((m, r) => Math.max(m, r.level), 0)
      const minOdd = runs.reduce((m, r) => (r.level % 2 ? Math.min(m, r.level) : m), 99)
      for (let k = maxL; k >= Math.min(minOdd, maxL); k--) {
        for (let a = 0; a < runs.length;) {
          if (runs[a].level < k) { a++; continue }
          let b = a
          while (b < runs.length && runs[b].level >= k) b++
          const seg = runs.slice(a, b).reverse()
          runs.splice(a, b - a, ...seg)
          a = b
        }
      }
      let x = 0
      const glyphs = []
      for (const r of runs) {
        for (const g of r.glyphs) {
          const s = size / g.rec.upem
          glyphs.push({ gid: g.gid, rec: g.rec, x: x + g.dx * s, y: -g.dy * s, cluster: g.cluster })
          x += g.ax * s + track
        }
      }
      let trail = 0
      for (let c = le - 1; c >= ls && isBreak(para[c]); c--) trail += adv[c]
      const asc = (primary.ext.ascender * size) / primary.upem
      const desc = (-primary.ext.descender * size) / primary.upem
      if (!lines.length) firstAscent = asc
      lines.push({ glyphs, width: x - track, visible: x - track - trail, rtl: paraRtl, asc, desc })
    }
  }
  const width = t.width > 0 ? t.width : Math.max(0, ...lines.map((l) => l.visible))
  // place lines: baseline y, x by alignment (start/end follow the direction)
  lines.forEach((l, i) => {
    l.y = firstAscent + i * lineH
    const free = width - l.visible
    const al = t.align ?? 'start'
    const right = (al === 'end' && !l.rtl) || (al === 'start' && l.rtl)
    l.x = al === 'center' ? free / 2 : right ? free : 0
  })
  const last = lines[lines.length - 1]
  const height = lines.length ? last.y + last.desc : size
  return { lines, width, height, ascent: firstAscent, baseRtl, size }
}
