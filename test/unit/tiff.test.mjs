// Unit tests for src/io/tiff.js — 16-bit TIFF writer. Re-parses the IFDs and
// pixel data here; if ImageMagick / exiftool are installed, they get the file
// too (skipped otherwise). Artefacts go to os.tmpdir().
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeTiff16, encodeTiff16Deflate, SRGB_ICC, toRational } from '../../src/io/tiff.js'
import { parseTiff, stripData, findTool } from './tiffParse.mjs'

const W = 300
const H = 400 // 1800-byte rows → several 256 KB strips
const image = (ch) => {
  const d = new Uint16Array(W * H * ch)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * ch
      d[i] = (x * 218) & 0xffff
      d[i + 1] = (y * 163 + x * 7) & 0xffff
      d[i + 2] = (x * y * 31) & 0xffff // wraps: exercises mod-2^16 prediction
      if (ch === 4) d[i + 3] = 65535 - y * 100
    }
  }
  return d
}
const EXIF = { make: 'Canon', model: 'EOS R5', lens: 'RF24-70mm F2.8 L IS USM', iso: 400, shutter: 1 / 250, aperture: 5.6, focal: 35, takenAt: '2026-05-04T13:14:15.000Z' }

const tmp = mkdtempSync(join(tmpdir(), 'albedo-tiff-'))
test.after(() => rmSync(tmp, { recursive: true, force: true }))
const magick = await findTool('magick')
const exiftool = await findTool('exiftool', ['/usr/bin/vendor_perl/exiftool'])

const le16 = (bytes) => {
  const out = new Uint16Array(bytes.length / 2)
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let i = 0; i < out.length; i++) out[i] = dv.getUint16(2 * i, true)
  return out
}
const inflate = async (b) => new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer())

function checkTags(ifd, ch, compression) {
  assert.equal(ifd.get(256)[0], W)
  assert.equal(ifd.get(257)[0], H)
  assert.deepEqual(ifd.get(258), new Array(ch).fill(16))
  assert.equal(ifd.get(259)[0], compression)
  assert.equal(ifd.get(262)[0], 2)
  assert.equal(ifd.get(277)[0], ch)
  assert.equal(ifd.get(284)[0], 1)
  assert.deepEqual(ifd.get(339), new Array(ch).fill(1))
  assert.equal(ifd.get(317)?.[0], compression === 8 ? 2 : undefined)
  assert.deepEqual(ifd.get(338), ch === 4 ? [2] : undefined)
  const rps = ifd.get(278)[0]
  assert.equal(ifd.get(273).length, Math.ceil(H / rps))
  assert.ok(ifd.get(273).length > 1, 'multi-strip')
}

test('uncompressed RGB: tags, EXIF, ICC and pixels re-parse exactly', () => {
  const data = image(3)
  const bytes = encodeTiff16({ width: W, height: H, data, exif: EXIF })
  const { le, ifds } = parseTiff(bytes)
  assert.ok(le)
  assert.equal(ifds.length, 1)
  const [ifd] = ifds
  checkTags(ifd, 3, 1)
  assert.equal(ifd.get(271), 'Canon')
  assert.equal(ifd.get(272), 'EOS R5')
  assert.equal(ifd.get(306), '2026:05:04 13:14:15')
  assert.deepEqual(ifd.get(34675), SRGB_ICC)
  assert.equal(ifd.exif.get(33434)[0], 1 / 250)
  assert.equal(ifd.exif.get(33437)[0], 5.6)
  assert.deepEqual(ifd.exif.get(34855), [400])
  assert.equal(ifd.exif.get(42036), EXIF.lens)
  assert.deepEqual(le16(stripData(bytes, ifd)), data)
  // no ICC when asked
  assert.equal(parseTiff(encodeTiff16({ width: 2, height: 2, data: new Uint16Array(12), iccProfile: null })).ifds[0].get(34675), undefined)
})

test('Deflate + predictor 2 (RGBA): strips inflate and un-predict to the input', async () => {
  const data = image(4)
  const bytes = await encodeTiff16Deflate({ width: W, height: H, data })
  const [ifd] = parseTiff(bytes).ifds
  checkTags(ifd, 4, 8)
  const rps = ifd.get(278)[0]
  const offs = ifd.get(273)
  const lens = ifd.get(279)
  const out = new Uint16Array(W * H * 4)
  for (let s = 0; s < offs.length; s++) {
    const px = le16(await inflate(bytes.subarray(offs[s], offs[s] + lens[s])))
    for (let r = 0; r < px.length / (W * 4); r++) {
      for (let i = 4; i < W * 4; i++) px[r * W * 4 + i] = (px[r * W * 4 + i] + px[r * W * 4 + i - 4]) & 0xffff
    }
    out.set(px, s * rps * W * 4)
  }
  assert.deepEqual(out, data)
  assert.ok(bytes.length < W * H * 8, 'compressed')
})

test('sRGB ICC profile is a well-formed v2 display profile', () => {
  const dv = new DataView(SRGB_ICC.buffer)
  assert.equal(dv.getUint32(0), SRGB_ICC.length)
  assert.equal(String.fromCharCode(...SRGB_ICC.subarray(36, 40)), 'acsp')
  assert.equal(String.fromCharCode(...SRGB_ICC.subarray(12, 24)), 'mntrRGB XYZ ')
  assert.equal(dv.getUint32(8) >>> 24, 2)
  const n = dv.getUint32(128)
  const sigs = []
  for (let i = 0; i < n; i++) {
    const p = 132 + 12 * i
    sigs.push(String.fromCharCode(...SRGB_ICC.subarray(p, p + 4)))
    const off = dv.getUint32(p + 4)
    assert.equal(off % 4, 0)
    assert.ok(off + dv.getUint32(p + 8) <= SRGB_ICC.length)
  }
  assert.deepEqual(sigs.sort(), ['bTRC', 'bXYZ', 'cprt', 'desc', 'gTRC', 'gXYZ', 'rTRC', 'rXYZ', 'wtpt'])
})

test('rationals', () => {
  assert.deepEqual(toRational(5.6), [28, 5])
  assert.deepEqual(toRational(-0.3333333333333333, true), [-1, 3])
  assert.deepEqual(toRational(72), [72, 1])
})

test('ImageMagick reads both encodings back pixel-exact', { skip: !magick && 'magick not on PATH' }, async () => {
  for (const [name, bytes, ch] of [
    ['rgb.tif', encodeTiff16({ width: W, height: H, data: image(3), exif: EXIF }), 3],
    ['rgba-deflate.tif', await encodeTiff16Deflate({ width: W, height: H, data: image(4) }), 4],
  ]) {
    const f = join(tmp, name)
    writeFileSync(f, bytes)
    const id = execFileSync(magick, ['identify', '-format', '%m %w %h %z %[channels]', f], { stdio: ['ignore', 'pipe', 'pipe'] }).toString()
    assert.match(id, new RegExp(`^TIFF ${W} ${H} 16 srgba?`), id)
    const raw = execFileSync(magick, [f, '-depth', '16', '-endian', 'LSB', `${ch === 4 ? 'rgba' : 'rgb'}:-`], { maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'] })
    assert.deepEqual(le16(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)), image(ch), name)
  }
})

test('exiftool sees the EXIF and the ICC profile', { skip: !exiftool && 'exiftool not found' }, () => {
  const f = join(tmp, 'exif.tif')
  writeFileSync(f, encodeTiff16({ width: 8, height: 8, data: new Uint16Array(192), exif: EXIF }))
  const [j] = JSON.parse(execFileSync(exiftool, ['-j', '-n', f]).toString())
  assert.equal(j.FileType, 'TIFF')
  assert.equal(j.BitsPerSample, '16 16 16')
  assert.equal(j.Make, 'Canon')
  assert.equal(j.ISO, 400)
  assert.equal(j.FNumber, 5.6)
  assert.equal(j.LensModel, EXIF.lens)
  assert.equal(j.ProfileDescription, 'sRGB IEC61966-2.1 (albedo)')
  assert.equal(j.ProfileClass, 'mntr')
  assert.ok(!j.Warning, j.Warning)
})
