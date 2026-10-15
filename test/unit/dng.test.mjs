// Unit tests for src/io/dng.js — raw CFA and linear DNG writers. Re-parses
// the IFDs here; when installed, exiftool and LibRaw's own sample tools
// (raw-identify, unprocessed_raw — the library albedo decodes with) read the
// files too, otherwise those tests skip. Artefacts go to os.tmpdir().
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  encodeRawDng, encodeLinearDng, colorMatrixFromCamToSrgb, asShotNeutralFromCamMul,
  cfaPatternFromPhase, inv3, SRGB_TO_XYZ, XYZ_TO_SRGB,
} from '../../src/io/dng.js'
import { parseTiff, stripData, findTool } from './tiffParse.mjs'

const tmp = mkdtempSync(join(tmpdir(), 'albedo-dng-'))
test.after(() => rmSync(tmp, { recursive: true, force: true }))
const exiftool = await findTool('exiftool', ['/usr/bin/vendor_perl/exiftool'])
const rawIdentify = await findTool('raw-identify')
const unprocessedRaw = await findTool('unprocessed_raw')

// Canon EOS 5D Mark II XYZ → camera (Adobe's ColorMatrix2, D65), as in LibRaw
const CAM_XYZ = [[0.4716, 0.0603, -0.083], [-0.7798, 1.5474, 0.248], [-0.1496, 0.1937, 0.6651]]
const mul = (a, b) => a.map((r) => b[0].map((_, j) => r[0] * b[0][j] + r[1] * b[1][j] + r[2] * b[2][j]))

// LibRaw's cam_xyz_coeff, verbatim in spirit: what albedo receives as camToSrgb
function libraw(camXyz) {
  const camRgb = mul(camXyz, SRGB_TO_XYZ)
  const preMul = camRgb.map((r) => 1 / (r[0] + r[1] + r[2]))
  const norm = camRgb.map((r, i) => r.map((v) => v * preMul[i]))
  return { rgbCam: inv3(norm), preMul }
}

// visible 1000×700 inside a 1032×716 frame at (16, 8), like albedo's payload
const W = 1000
const H = 700
const RW = 1032
const LEFT = 16
const TOP = 8
const frame = new Uint16Array(RW * 716)
for (let y = 0; y < 716; y++) {
  for (let x = 0; x < RW; x++) frame[y * RW + x] = 600 + ((x * 13 + y * 29 + ((x ^ y) & 7) * 100) % 15000)
}
const visible = () => {
  const v = new Uint16Array(W * H)
  for (let y = 0; y < H; y++) v.set(frame.subarray((y + TOP) * RW + LEFT, (y + TOP) * RW + LEFT + W), y * W)
  return v
}
const le16 = (b, le = true) => {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  return Uint16Array.from({ length: b.length / 2 }, (_, i) => dv.getUint16(2 * i, le))
}

const { rgbCam, preMul } = libraw(CAM_XYZ)
const camMul = [2.1, 1, 1.45]
const XMP = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><!-- albedo --></x:xmpmeta>'
const rawOpts = (extra = {}) => ({
  width: W, height: H, buffer: frame, rawWidth: RW, left: LEFT, top: TOP,
  cfa: [1, 0], black: 512, white: 16383,
  colorMatrix1: colorMatrixFromCamToSrgb(rgbCam, preMul),
  asShotNeutral: asShotNeutralFromCamMul(camMul),
  make: 'Canon', model: 'EOS 5D Mark II', orientation: 8,
  exif: { iso: 800, shutter: 1 / 60, aperture: 2.8, focal: 50, lens: 'EF50mm f/1.4 USM', takenAt: '2026-03-02T10:00:00Z' },
  xmp: XMP, ...extra,
})

const near = (a, b, eps, msg) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) <= eps, `${msg}[${i}]: ${v} vs ${b[i]}`))

test('colorMatrixFromCamToSrgb inverts LibRaw\'s rgb_cam back to cam_xyz', () => {
  const cm = colorMatrixFromCamToSrgb(Float32Array.from(rgbCam.flat()), preMul)
  // same matrix up to the DNG normalisation (D65 white → max component 1)
  const k = cm[0][0] / CAM_XYZ[0][0]
  near(cm.flat(), CAM_XYZ.flat().map((v) => v * k), 1e-6, 'cm')
  const w = cm.map((r) => r[0] * 0.95047 + r[1] + r[2] * 1.08883)
  assert.ok(Math.abs(Math.max(...w) - 1) < 1e-9)
  // sRGB "camera": rgb_cam = identity → XYZ→sRGB
  const id = colorMatrixFromCamToSrgb([1, 0, 0, 0, 1, 0, 0, 0, 1])
  const s = id[0][0] / XYZ_TO_SRGB[0][0]
  near(id.flat(), XYZ_TO_SRGB.flat().map((v) => v * s), 1e-9, 'srgb')
})

test('CFA phase → pattern follows the decode worker\'s convention', () => {
  assert.equal(cfaPatternFromPhase([0, 0]), 'RGGB')
  assert.equal(cfaPatternFromPhase([1, 0]), 'GRBG')
  assert.equal(cfaPatternFromPhase([0, 1]), 'GBRG')
  assert.equal(cfaPatternFromPhase([1, 1]), 'BGGR')
  assert.deepEqual(asShotNeutralFromCamMul([2, 1, 1.25]), [0.5, 1, 0.8])
})

test('raw DNG: IFD0 tags and the cropped mosaic re-parse exactly', () => {
  const bytes = encodeRawDng(rawOpts())
  const { ifds } = parseTiff(bytes)
  assert.equal(ifds.length, 1)
  const [d] = ifds
  assert.equal(d.get(254)[0], 0)
  assert.equal(d.get(256)[0], W)
  assert.equal(d.get(257)[0], H)
  assert.deepEqual(d.get(258), [16])
  assert.equal(d.get(259)[0], 1)
  assert.equal(d.get(262)[0], 32803)
  assert.equal(d.get(274)[0], 8)
  assert.equal(d.get(277)[0], 1)
  assert.deepEqual(d.get(33421), [2, 2])
  assert.deepEqual([...d.get(33422)], [1, 0, 2, 1]) // GRBG
  assert.deepEqual([...d.get(50706)], [1, 4, 0, 0])
  assert.equal(d.get(50708), 'Canon EOS 5D Mark II')
  assert.deepEqual(d.get(50714), [512])
  assert.deepEqual(d.get(50717), [16383])
  assert.deepEqual(d.get(50720), [W, H])
  near(d.get(50721), rawOpts().colorMatrix1.flat(), 1e-6, 'ColorMatrix1')
  near(d.get(50728), [1 / 2.1, 1, 1 / 1.45], 1e-6, 'AsShotNeutral')
  assert.equal(d.get(50778)[0], 21)
  assert.equal(new TextDecoder().decode(d.get(700)), XMP)
  assert.equal(d.exif.get(34855)[0], 800)
  assert.equal(d.exif.get(42036), 'EF50mm f/1.4 USM')
  assert.deepEqual(le16(stripData(bytes, d)), visible())
})

test('per-site black, preview IFD0 + raw SubIFD', () => {
  const preview = { width: 100, height: 70, data: new Uint8Array(100 * 70 * 3).fill(90) }
  const bytes = encodeRawDng(rawOpts({ black: [510, 512, 514, 516], preview, cfa: undefined, cfaPattern: 'BGGR' }))
  const { ifds } = parseTiff(bytes)
  assert.equal(ifds.length, 1)
  const [p] = ifds
  assert.equal(p.get(254)[0], 1)
  assert.equal(p.get(256)[0], 100)
  assert.deepEqual([...p.get(50706)], [1, 4, 0, 0])
  assert.equal(p.subIfds.length, 1)
  const r = p.subIfds[0]
  assert.equal(r.get(254)[0], 0)
  assert.equal(r.get(262)[0], 32803)
  assert.deepEqual([...r.get(33422)], [2, 1, 1, 0])
  assert.deepEqual(r.get(50713), [2, 2])
  assert.deepEqual(r.get(50714), [510, 512, 514, 516])
  assert.deepEqual(le16(stripData(bytes, r)), visible())
  assert.deepEqual(stripData(bytes, p), preview.data)
})

test('linear DNG: LinearRaw, 3 samples, default sRGB camera matrix', () => {
  const data = new Uint16Array(64 * 48 * 4).map((_, i) => (i * 97) & 0xffff)
  const bytes = encodeLinearDng({ width: 64, height: 48, data, channels: 4, make: 'albedo', model: 'Linear' })
  const [d] = parseTiff(bytes).ifds
  assert.equal(d.get(262)[0], 34892)
  assert.equal(d.get(277)[0], 3)
  assert.deepEqual(d.get(258), [16, 16, 16])
  assert.deepEqual(d.get(50714), [0, 0, 0])
  assert.deepEqual(d.get(50717), [65535, 65535, 65535])
  assert.equal(d.get(33422), undefined)
  const rgb = data.filter((_, i) => i % 4 !== 3)
  assert.deepEqual(le16(stripData(bytes, d)), rgb)
})

test('rejects bad input', () => {
  assert.throws(() => encodeRawDng(rawOpts({ cfa: undefined, cfaPattern: 'RGBX' })), /cfaPattern/)
  assert.throws(() => encodeRawDng(rawOpts({ top: 100 })), /too short/)
  assert.throws(() => encodeRawDng(rawOpts({ colorMatrix1: undefined })), /colorMatrix1/)
})

test('exiftool identifies a DNG with the right size and CFA', { skip: !exiftool && 'exiftool not found' }, () => {
  const f = join(tmp, 'raw.dng')
  writeFileSync(f, encodeRawDng(rawOpts()))
  const [j] = JSON.parse(execFileSync(exiftool, ['-j', '-n', f]).toString())
  assert.equal(j.FileType, 'DNG')
  assert.equal(j.DNGVersion, '1 4 0 0')
  assert.equal(j.ImageWidth, W)
  assert.equal(j.ImageHeight, H)
  assert.equal(j.PhotometricInterpretation, 32803)
  assert.equal(j.CFAPattern2, '1 0 2 1')
  assert.equal(j.CalibrationIlluminant1, 21)
  assert.equal(j.ISO, 800)
  assert.equal(j.LensModel, 'EF50mm f/1.4 USM')
  assert.ok(!j.Warning, j.Warning)
  const fp = join(tmp, 'preview.dng')
  writeFileSync(fp, encodeRawDng(rawOpts({ preview: { width: 10, height: 7, data: new Uint8Array(210) } })))
  const [k] = JSON.parse(execFileSync(exiftool, ['-j', '-n', '-a', '-G1', fp]).toString())
  assert.equal(k['SubIFD:ImageWidth'], W)
  assert.equal(k['SubIFD:PhotometricInterpretation'], 32803)
  assert.ok(!k['ExifTool:Warning'], k['ExifTool:Warning'])
})

test('LibRaw opens it: size, CFA, matrices, and the raw values', { skip: !(rawIdentify && unprocessedRaw) && 'LibRaw samples not installed' }, () => {
  const f = join(tmp, 'libraw.dng')
  writeFileSync(f, encodeRawDng(rawOpts()))
  const info = execFileSync(rawIdentify, ['-v', f]).toString()
  assert.match(info, /DNG Version: 1\.4\.0\.0/)
  assert.match(info, new RegExp(`Image size:\\s+${W} x ${H}`))
  assert.match(info, /Filter pattern: GRBGGRBG/)
  assert.match(info, /Image flip: 5/) // EXIF 8 → LibRaw flip 5 (90° CCW)
  assert.match(info, /DNG Illuminant 1: D65/)
  // LibRaw's own camRGB → sRGB from our ColorMatrix1 = the rgb_cam we started from
  const m = /camRGB -> sRGB Matrix:\n([^\n]+)\n([^\n]+)\n([^\n]+)/.exec(info)
  near(m.slice(1).join(' ').trim().split(/\s+/).map(Number), rgbCam.flat(), 1e-4, 'rgb_cam')
  execFileSync(unprocessedRaw, ['-q', '-T', f], { cwd: tmp })
  const out = new Uint8Array(readFileSync(`${f}.tiff`))
  const { le, ifds } = parseTiff(out)
  assert.deepEqual(le16(stripData(out, ifds[0]), le), visible())
})
