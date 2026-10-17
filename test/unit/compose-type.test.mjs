import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { loadHarfBuzz, FontStore, layoutText } from '../../src/compose/type/layout.js'
import { TEXT_DEFAULTS } from '../../src/compose/model.js'

const fonts = new URL('../../public/fonts/type/', import.meta.url)
async function store() {
  const hb = await loadHarfBuzz()
  const s = new FontStore(hb)
  await s.add('IBM Plex Sans', 400, await readFile(new URL('IBMPlexSans-Regular.woff', fonts)), { fallback: true })
  await s.add('IBM Plex Sans', 700, await readFile(new URL('IBMPlexSans-Bold.woff', fonts)), { fallback: true })
  await s.add('IBM Plex Sans Arabic', 400, await readFile(new URL('IBMPlexSansArabic-Regular.woff', fonts)), { fallback: true })
  return { hb, s }
}
const T = (p) => ({ ...TEXT_DEFAULTS, size: 100, ...p })

test('Arabic joins: contextual forms and the lam-alef ligature', async () => {
  const { hb, s } = await store()
  const L = layoutText(hb, s, T({ content: 'سلام', font: 'IBM Plex Sans Arabic' }))
  const rec = s.resolve('IBM Plex Sans Arabic', 400)
  const shaped = L.lines[0].glyphs
  const iso = [...'سلام'].map((c) => rec.font.nominalGlyph(c.codePointAt(0)))
  // س ل ا م: lam + alef form one mandatory ligature → 3 glyphs
  assert.equal(shaped.length, 3)
  // RTL: the first logical letter (س) is drawn rightmost
  const first = shaped.find((g) => g.cluster === 0)
  assert.equal(first, shaped.reduce((a, b) => (b.x > a.x ? b : a)))
  // at least the initial and medial forms are contextual alternates
  const diff = shaped.filter((g) => g.gid !== iso[g.cluster]).length
  assert.ok(diff >= 2, `contextual forms: ${diff}`)
  assert.ok(shaped.some((g) => g.cluster === 1 && g.gid !== iso[1]), 'lam-alef ligature glyph')
})

test('Arabic in a Latin font falls back to Plex Sans Arabic', async () => {
  const { hb, s } = await store()
  const L = layoutText(hb, s, T({ content: 'Hi سلام', font: 'IBM Plex Sans' }))
  const fams = new Set(L.lines[0].glyphs.map((g) => g.rec.family))
  assert.ok(fams.has('IBM Plex Sans') && fams.has('IBM Plex Sans Arabic'))
  assert.ok(L.lines[0].glyphs.every((g) => g.gid !== 0), 'no .notdef')
})

test('bidi: a Latin word inside an Arabic paragraph keeps its order, right of nothing', async () => {
  const { hb, s } = await store()
  const L = layoutText(hb, s, T({ content: 'سلام abc سلام', font: 'IBM Plex Sans Arabic' }))
  const g = L.lines[0].glyphs
  const xa = g.find((q) => q.cluster === 5).x, xb = g.find((q) => q.cluster === 6).x, xc = g.find((q) => q.cluster === 7).x
  assert.ok(xa < xb && xb < xc, 'abc reads left to right')
  const firstArabic = g.find((q) => q.cluster === 0).x
  assert.ok(firstArabic > xc, 'the paragraph starts at the right')
  assert.equal(L.baseRtl, true)
})

test('kerning changes the advance of AV; tracking adds space', async () => {
  const { hb, s } = await store()
  const kern = layoutText(hb, s, T({ content: 'AVAV' })).lines[0].width
  const noKern = layoutText(hb, s, T({ content: 'AVAV', kerning: false })).lines[0].width
  assert.ok(kern < noKern - 1, `kern ${kern} vs ${noKern}`)
  const tracked = layoutText(hb, s, T({ content: 'AVAV', tracking: 100 })).lines[0].width
  assert.ok(Math.abs(tracked - kern - 3 * 10) < 0.5, `tracking: ${tracked - kern}`)
})

test('box text wraps at spaces', async () => {
  const { hb, s } = await store()
  const L = layoutText(hb, s, T({ content: 'one two three four five six', width: 400 }))
  assert.ok(L.lines.length >= 3, `${L.lines.length} lines`)
  assert.ok(L.lines.every((l) => l.visible <= 400.5), 'every line fits')
})
