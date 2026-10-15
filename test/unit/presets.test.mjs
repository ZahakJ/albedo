import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  BUILTIN_PRESETS, PRESET_FILE_VERSION, parsePresetFile, presetFileName,
  sanitizeModules, serializePresets,
} from '../../src/state/presetFormat.js'
import { MODULE_DEFAULTS } from '../../src/engine/editdoc.js'

const fx = (n) => readFileSync(new URL(`./fixtures/xmp/${n}`, import.meta.url), 'utf8')

test('export → import round-trips name, group and modules', () => {
  const presets = [
    { id: 'ps_1', name: 'Dusk', group: 'Travel', modules: { wb: { temp: 12, tint: -3 } } },
    { id: 'ps_2', name: 'Plain', group: '', modules: { vibsat: { vibrance: 20, saturation: -5 } } },
  ]
  const text = serializePresets(presets)
  const data = JSON.parse(text)
  assert.equal(data.format, 'albedo-presets')
  assert.equal(data.version, PRESET_FILE_VERSION)
  assert.equal(data.presets[0].id, undefined, 'ids are local, not exported')
  const r = parsePresetFile(text, 'albedo-presets.json')
  assert.equal(r.error, undefined)
  assert.deepEqual(r.presets.map((p) => [p.name, p.group, p.source]), [['Dusk', 'Travel', 'import'], ['Plain', '', 'import']])
  assert.deepEqual(r.presets[0].modules, { wb: { temp: 12, tint: -3 } })
})

test('a newer file version is refused with a reason', () => {
  const r = parsePresetFile(JSON.stringify({ format: 'albedo-presets', version: PRESET_FILE_VERSION + 1, presets: [] }), 'x.json')
  assert.equal(r.presets.length, 0)
  assert.match(r.error, /newer/)
})

test('a bare { name, modules } object is accepted', () => {
  const r = parsePresetFile(JSON.stringify({ name: 'Solo', modules: { tone: { contrast: 30 } } }), 'solo.json')
  assert.equal(r.presets[0].name, 'Solo')
  assert.deepEqual(r.presets[0].modules.tone, { ...MODULE_DEFAULTS.tone, contrast: 30 })
})

test('junk and empty files report an error instead of throwing', () => {
  assert.match(parsePresetFile('not json', 'a.json').error, /not a preset file/)
  assert.match(parsePresetFile('{"format":"albedo-presets","version":1,"presets":[]}', 'b.json').error, /no presets/)
})

test('sanitize keeps known modules and value types only', () => {
  const m = sanitizeModules({
    tone: { contrast: 10, bogus: 5, highlights: 'loud' },
    nope: { x: 1 },
    heal: { spots: [{ dx: 0.5 }] },
    curve: { points: [[0, 0.1], [1, 0.9]] },
  })
  assert.deepEqual(Object.keys(m).sort(), ['curve', 'tone'])
  assert.deepEqual(m.tone, { ...MODULE_DEFAULTS.tone, contrast: 10 })
  assert.deepEqual(m.curve.points, [[0, 0.1], [1, 0.9]])
})

test('an .xmp preset becomes an Imported preset and carries unmapped labels', () => {
  const r = parsePresetFile(fx('preset-bw.xmp'), 'Silver.xmp')
  assert.equal(r.presets.length, 1)
  assert.equal(r.presets[0].group, 'Imported')
  assert.equal(r.presets[0].source, 'xmp')
  assert.equal(r.presets[0].modules.bw.on, 1)
  assert.ok(Array.isArray(r.unmapped))
})

test('a neutral .xmp yields no preset and says why', () => {
  const r = parsePresetFile(fx('neutral.xmp'), 'neutral.xmp')
  assert.equal(r.presets.length, 0)
  assert.match(r.error, /no settings/)
})

test('built-in looks are valid, distinct, and cover the same modules', () => {
  const ids = new Set()
  const keys = JSON.stringify(Object.keys(BUILTIN_PRESETS[0].modules).sort())
  for (const p of BUILTIN_PRESETS) {
    assert.ok(p.id.startsWith('builtin:') && !ids.has(p.id))
    ids.add(p.id)
    assert.equal(p.builtin, true)
    assert.deepEqual(sanitizeModules(p.modules), p.modules, `${p.name} survives sanitize unchanged`)
    assert.equal(JSON.stringify(Object.keys(p.modules).sort()), keys, `${p.name} covers the shared look modules`)
    assert.ok(!('wb' in p.modules) && !('exposure' in p.modules) && !('geometry' in p.modules))
  }
  assert.ok(BUILTIN_PRESETS.length >= 6)
})

test('file names: one preset is named after it, several share a name', () => {
  assert.equal(presetFileName([{ name: 'Dusk / Blue' }]), 'Dusk - Blue.albedo.json')
  assert.equal(presetFileName([{ name: 'a' }, { name: 'b' }]), 'albedo-presets.json')
})
