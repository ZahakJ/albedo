// Adobe DCP (DNG Camera Profile) reader. A .dcp is a one-IFD TIFF whose magic
// is 'IIRC' (0x4352 in place of 42); a DNG carries the same tags in IFD0, so
// both go through one IFD walker. Pure ES module, no DOM, runs in Node too.
// Tag numbers: DNG Specification 1.6 (cross-checked against real RawTherapee
// DCPs: 51107/51108 are the HueSatMap/LookTable encodings, 51109 is
// BaselineExposureOffset, 51110 DefaultBlackRender).

export const DCP_TAGS = {
  UniqueCameraModel: 50708,
  ColorMatrix1: 50721,
  ColorMatrix2: 50722,
  CameraCalibration1: 50723,
  CameraCalibration2: 50724,
  CalibrationIlluminant1: 50778,
  CalibrationIlluminant2: 50779,
  ProfileCalibrationSignature: 50932,
  ProfileName: 50936,
  ProfileHueSatMapDims: 50937,
  ProfileHueSatMapData1: 50938,
  ProfileHueSatMapData2: 50939,
  ProfileToneCurve: 50940,
  ProfileEmbedPolicy: 50941,
  ProfileCopyright: 50942,
  ForwardMatrix1: 50964,
  ForwardMatrix2: 50965,
  ProfileLookTableDims: 50981,
  ProfileLookTableData: 50982,
  ProfileHueSatMapEncoding: 51107,
  ProfileLookTableEncoding: 51108,
  BaselineExposureOffset: 51109,
  DefaultBlackRender: 51110,
}

const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8]

function readIfd(dv, le, off) {
  const n = dv.getUint16(off, le)
  const tags = new Map()
  for (let i = 0; i < n; i++) {
    const e = off + 2 + i * 12
    const tag = dv.getUint16(e, le)
    const type = dv.getUint16(e + 2, le)
    const count = dv.getUint32(e + 4, le)
    const size = (TYPE_SIZE[type] || 0) * count
    if (!size) continue
    const at = size <= 4 ? e + 8 : dv.getUint32(e + 8, le)
    if (at + size > dv.byteLength) continue // truncated entry: skip, don't throw
    tags.set(tag, { type, count, at })
  }
  return tags
}

function values(dv, le, t) {
  const { type, count, at } = t
  const out = new Array(count)
  for (let i = 0; i < count; i++) {
    const p = at + i * TYPE_SIZE[type]
    switch (type) {
      case 1: case 7: out[i] = dv.getUint8(p); break
      case 6: out[i] = dv.getInt8(p); break
      case 3: out[i] = dv.getUint16(p, le); break
      case 8: out[i] = dv.getInt16(p, le); break
      case 4: out[i] = dv.getUint32(p, le); break
      case 9: out[i] = dv.getInt32(p, le); break
      case 5: { const d = dv.getUint32(p + 4, le); out[i] = d ? dv.getUint32(p, le) / d : 0; break }
      case 10: { const d = dv.getInt32(p + 4, le); out[i] = d ? dv.getInt32(p, le) / d : 0; break }
      case 11: out[i] = dv.getFloat32(p, le); break
      case 12: out[i] = dv.getFloat64(p, le); break
      default: out[i] = 0
    }
  }
  return out
}

function text(dv, t) {
  const bytes = new Uint8Array(dv.buffer, dv.byteOffset + t.at, t.count)
  const end = bytes.indexOf(0)
  // ProfileName may be BYTE-typed UTF-8 (DNG 1.4+); ASCII is a subset
  return new TextDecoder('utf-8').decode(end < 0 ? bytes : bytes.subarray(0, end)).trim()
}

// Parse a .dcp (or a DNG's IFD0) from an ArrayBuffer / TypedArray. Throws on
// a non-TIFF; returns null-filled fields for absent tags.
export function parseDcp(input) {
  const u8 = input instanceof ArrayBuffer ? new Uint8Array(input)
    : new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  if (u8.length < 8) throw new Error('dcp: file too short')
  const bo = String.fromCharCode(u8[0], u8[1])
  if (bo !== 'II' && bo !== 'MM') throw new Error('dcp: not a TIFF/DCP')
  const le = bo === 'II'
  const magic = dv.getUint16(2, le)
  if (magic !== 42 && magic !== 0x4352) throw new Error(`dcp: bad magic 0x${magic.toString(16)}`)
  const tags = readIfd(dv, le, dv.getUint32(4, le))

  const num = (id) => tags.has(id) ? values(dv, le, tags.get(id)) : null
  const one = (id) => num(id)?.[0] ?? null
  const str = (id) => tags.has(id) ? text(dv, tags.get(id)) : null
  const f32 = (id) => tags.has(id) ? Float32Array.from(values(dv, le, tags.get(id))) : null
  const T = DCP_TAGS

  const cm1 = num(T.ColorMatrix1)
  const channels = cm1 ? cm1.length / 3 : 3

  let hueSatMap = null
  const hsd = num(T.ProfileHueSatMapDims)
  if (hsd && (tags.has(T.ProfileHueSatMapData1) || tags.has(T.ProfileHueSatMapData2))) {
    const dims = [hsd[0], hsd[1], hsd[2] ?? 1]
    const n = dims[0] * dims[1] * dims[2] * 3
    const d1 = f32(T.ProfileHueSatMapData1)
    const d2 = f32(T.ProfileHueSatMapData2)
    hueSatMap = {
      dims,
      data1: d1?.length === n ? d1 : null,
      data2: d2?.length === n ? d2 : null,
      encoding: one(T.ProfileHueSatMapEncoding) ?? 0,
    }
    if (!hueSatMap.data1 && !hueSatMap.data2) hueSatMap = null
  }

  let lookTable = null
  const ltd = num(T.ProfileLookTableDims)
  const ltData = f32(T.ProfileLookTableData)
  if (ltd && ltData) {
    const dims = [ltd[0], ltd[1], ltd[2] ?? 1]
    if (ltData.length === dims[0] * dims[1] * dims[2] * 3) {
      lookTable = { dims, data: ltData, encoding: one(T.ProfileLookTableEncoding) ?? 0 }
    }
  }

  let toneCurve = null
  const tc = num(T.ProfileToneCurve)
  if (tc && tc.length >= 4) {
    toneCurve = []
    for (let i = 0; i + 1 < tc.length; i += 2) toneCurve.push([tc[i], tc[i + 1]])
  }

  return {
    name: str(T.ProfileName),
    uniqueCameraModel: str(T.UniqueCameraModel),
    channels,
    illuminants: [one(T.CalibrationIlluminant1) ?? 0, one(T.CalibrationIlluminant2) ?? 0],
    colorMatrix1: cm1,
    colorMatrix2: num(T.ColorMatrix2),
    forwardMatrix1: num(T.ForwardMatrix1),
    forwardMatrix2: num(T.ForwardMatrix2),
    hueSatMap,
    lookTable,
    toneCurve,
    baselineExposureOffset: one(T.BaselineExposureOffset) ?? 0,
    defaultBlackRender: one(T.DefaultBlackRender) ?? 0, // 0 auto, 1 none
    embedPolicy: one(T.ProfileEmbedPolicy),
    copyright: str(T.ProfileCopyright),
  }
}
