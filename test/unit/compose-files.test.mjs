import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writePsd, readPsd, readTiffLayers } from '../../src/compose/files/psd.js'
import { parseTiff, decodePage } from '../../src/compose/files/tiff.js'
import { writeTiff, T } from '../../src/io/tiff.js'

// a 6×4 layer: red ramp, half transparent on the right
function layer(w = 6, h = 4) {
  const rgba = new Float32Array(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4
    rgba.set([x / (w - 1), 0.25, 1 - y / (h - 1), x < w / 2 ? 1 : 0.5], i)
  }
  return rgba
}
const doc = (depth) => ({
  width: 10, height: 8, depth,
  composite: new Float32Array(10 * 8 * 4).fill(1),
  layers: [
    { kind: 'pixel', name: 'Background', x: 0, y: 0, w: 10, h: 8, rgba: new Float32Array(10 * 8 * 4).fill(1), opacity: 1, blend: 'normal' },
    { kind: 'groupEnd' },
    { kind: 'pixel', name: 'Ramp ✓', x: 2, y: 3, w: 6, h: 4, rgba: layer(), opacity: 0.6, fill: 0.8, blend: 'multiply', clip: false, visible: true,
      blendIf: { channel: 0, this: [0, 0.1, 0.9, 1], under: [0, 0, 1, 1] },
      mask: { x: 0, y: 0, w: 10, h: 8, data: new Float32Array(80).map((_, i) => (i % 10) / 9), default: 255 } },
    { kind: 'groupStart', name: 'Group', blend: 'screen', opacity: 0.5, visible: false, collapsed: true },
  ],
})

for (const depth of [8, 16, 32]) {
  test(`PSD ${depth}-bit: layers, groups, modes, masks and Blend If survive a round trip`, async () => {
    const d = doc(depth)
    const bytes = await writePsd(d)
    const r = await readPsd(bytes)
    assert.equal(r.width, 10); assert.equal(r.height, 8); assert.equal(r.depth, depth)
    assert.deepEqual(r.layers.map((l) => l.kind), ['pixel', 'groupEnd', 'pixel', 'groupStart'])
    const ramp = r.layers[2]
    assert.equal(ramp.name, 'Ramp ✓')
    assert.equal(ramp.blend, 'multiply')
    assert.ok(Math.abs(ramp.opacity - 0.6) < 1 / 255 + 1e-6)
    assert.ok(Math.abs(ramp.fill - 0.8) < 1 / 255 + 1e-6)
    assert.deepEqual([ramp.x, ramp.y, ramp.w, ramp.h], [2, 3, 6, 4])
    const tol = depth === 8 ? 0.5 / 255 + 1e-6 : depth === 16 ? 0.5 / 65535 + 1e-6 : 1e-7
    const src = layer()
    for (let i = 0; i < src.length; i++) assert.ok(Math.abs(ramp.rgba[i] - src[i]) <= tol, `pixel ${i}: ${ramp.rgba[i]} vs ${src[i]}`)
    assert.ok(ramp.mask && Math.abs(ramp.mask.data[9] - 1) <= tol && ramp.mask.data[0] <= tol)
    assert.ok(ramp.blendIf && Math.abs(ramp.blendIf.this[1] - 0.1) < 1 / 255 + 1e-6)
    const g = r.layers[3]
    assert.equal(g.name, 'Group'); assert.equal(g.blend, 'screen'); assert.equal(g.visible, false); assert.equal(g.collapsed, true)
    assert.ok(r.composite && Math.abs(r.composite[0] - 1) < 1e-3)
  })
}

test('PSD from albedo carries its private payload', async () => {
  const d = doc(16)
  const bytes = await writePsd({ ...d, privateData: new TextEncoder().encode('albedo payload') })
  const r = await readPsd(bytes)
  assert.equal(new TextDecoder().decode(r.private), 'albedo payload')
})

for (const inner of [true, false]) test(`a layered TIFF (Photoshop ImageSourceData) opens with its layers${inner ? ', block with an inner length' : ''}`, async () => {
  const d = doc(16)
  // the layer info section of a PSD, wrapped the way Photoshop writes it
  // into TIFF tag 37724
  const psd = await writePsd(d)
  const dv = new DataView(psd.buffer, psd.byteOffset)
  let p = 26
  p += 4 + dv.getUint32(p) // colour mode data
  p += 4 + dv.getUint32(p) // image resources
  p += 4 // layer & mask section length
  p += 4 + dv.getUint32(p) // empty layer info (16-bit layers are in Lr16)
  p += 4 // global mask info length (0)
  assert.equal(String.fromCharCode(...psd.subarray(p + 4, p + 8)), 'Lr16')
  const len = dv.getUint32(p + 8)
  const info = psd.subarray(p + 12, p + 12 + len)
  const head = new TextEncoder().encode('Adobe Photoshop Document Data Block\0')
  const extra = inner ? 4 : 0
  const blk = new Uint8Array(12 + extra + info.length)
  const bv = new DataView(blk.buffer)
  blk.set(new TextEncoder().encode('8BIMLr16'), 0)
  bv.setUint32(8, info.length + extra)
  if (inner) bv.setUint32(12, info.length)
  blk.set(info, 12 + extra)
  const source = new Uint8Array(head.length + blk.length)
  source.set(head); source.set(blk, head.length)
  const w = 10, h = 8
  const strip = new Uint8Array(w * h * 6)
  const tiff = writeTiff([{
    tags: {
      256: [T.LONG, w], 257: [T.LONG, h], 258: [T.SHORT, [16, 16, 16]], 259: [T.SHORT, 1], 262: [T.SHORT, 2],
      277: [T.SHORT, 3], 278: [T.LONG, h], 284: [T.SHORT, 1], 37724: [T.UNDEFINED, source],
    },
    strips: [strip],
  }])
  const pages = parseTiff(tiff)
  assert.equal(pages.length, 1)
  const first = await decodePage(tiff, pages[0])
  assert.equal(first.width, 10)
  const layers = await readTiffLayers(pages[0].tags[37724], 16)
  assert.ok(layers, 'layers found')
  assert.deepEqual(layers.map((l) => l.kind), ['pixel', 'groupEnd', 'pixel', 'groupStart'])
  assert.equal(layers[2].name, 'Ramp ✓')
})

test('baseline TIFF: LZW with a predictor, and pages as layers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'albedo-tiff-'))
  const f = join(dir, 'p.tif')
  try {
    execSync(`magick -size 64x40 gradient:red-blue -compress LZW -define tiff:predictor=2 \\( -size 64x40 xc:'#336699' \\) -compress LZW ${f}`, { stdio: 'ignore' })
  } catch { return } // ImageMagick missing: nothing to compare with
  const bytes = new Uint8Array(readFileSync(f))
  const pages = parseTiff(bytes)
  assert.equal(pages.length, 2)
  return Promise.all(pages.map((pg) => decodePage(bytes, pg))).then(([a, b]) => {
    assert.equal(a.width, 64); assert.equal(a.height, 40)
    assert.ok(a.rgba[0] > 0.9 && a.rgba[2] < 0.1, `top is red: ${a.rgba.slice(0, 3)}`)
    const last = (40 * 64 - 1) * 4
    assert.ok(a.rgba[last + 2] > 0.9 && a.rgba[last] < 0.1, 'bottom is blue')
    assert.ok(Math.abs(b.rgba[0] - 0x33 / 255) < 1 / 255 && Math.abs(b.rgba[2] - 0x99 / 255) < 1 / 255)
  })
})

// an independent implementation in both directions: ImageMagick reads and
// writes layered PSD
test('PSD interop with ImageMagick: it reads ours, we read its', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'albedo-psd-'))
  try { execSync('magick -version', { stdio: 'ignore' }) } catch { return }
  for (const depth of [8, 16]) {
    const ours = join(dir, `ours${depth}.psd`)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(ours, await writePsd(doc(depth)))
    // ImageMagick lists the merged image, then one frame per layer
    const info = execSync(`magick identify -format "%w %h %z %[label]\\n" ${ours}`).toString().trim().split('\n')
    assert.ok(info.length >= 3, `frames: ${info.join(' | ')}`)
    assert.ok(info[0].startsWith(`10 8 ${depth}`), info[0])
    assert.ok(info.some((l) => l.includes('Ramp')), `layer names: ${info.join(' | ')}`)
    // theirs: a merged image and two layers, 16 bits
    const theirs = join(dir, `theirs${depth}.psd`)
    execSync(`magick -size 40x30 xc:'#fff0e0' \\( -size 40x30 xc:'#204080' -set label Base \\) \\( -size 20x10 xc:'#c03010' -set label Patch -repage +5+7 \\) -depth ${depth} ${theirs}`)
    const r = await readPsd(new Uint8Array(readFileSync(theirs)))
    const px = r.layers.filter((l) => l.kind === 'pixel')
    assert.equal(r.depth, depth)
    assert.ok(px.length >= 2, `layers: ${px.length}`)
    const patch = px.find((l) => l.w === 20 && l.h === 10)
    assert.ok(patch, `layer sizes: ${px.map((l) => `${l.w}x${l.h}@${l.x},${l.y}`)}`)
    assert.deepEqual([patch.x, patch.y], [5, 7])
    assert.ok(Math.abs(patch.rgba[0] - 0xc0 / 255) < 2 / 255 && Math.abs(patch.rgba[2] - 0x10 / 255) < 2 / 255, `patch colour ${patch.rgba.slice(0, 4)}`)
  }
})
