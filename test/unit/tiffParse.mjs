// Minimal TIFF reader for the tests: IFD chain + SubIFDs (330) + ExifIFD
// (34665), either byte order. Not part of the app.
const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 }

export function parseTiff(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const le = bytes[0] === 0x49 && bytes[1] === 0x49
  if (!le && !(bytes[0] === 0x4d && bytes[1] === 0x4d)) throw new Error('not TIFF')
  if (dv.getUint16(2, le) !== 42) throw new Error('bad magic')
  const seen = new Set()
  const readIfd = (off) => {
    if (seen.has(off)) throw new Error('IFD loop')
    seen.add(off)
    if (off & 1) throw new Error(`odd IFD offset ${off}`)
    const n = dv.getUint16(off, le)
    const tags = new Map()
    let prev = -1
    for (let i = 0; i < n; i++) {
      const p = off + 2 + 12 * i
      const tag = dv.getUint16(p, le)
      if (tag <= prev) throw new Error(`tags not ascending at ${tag}`)
      prev = tag
      const type = dv.getUint16(p + 2, le)
      const count = dv.getUint32(p + 4, le)
      const size = SIZE[type] * count
      const at = size > 4 ? dv.getUint32(p + 8, le) : p + 8
      if (at + size > bytes.length) throw new Error(`tag ${tag} out of bounds`)
      let values
      if (type === 2) values = new TextDecoder().decode(bytes.subarray(at, at + count)).replace(/\0+$/, '')
      else if (type === 1 || type === 7) values = bytes.slice(at, at + count)
      else {
        values = []
        for (let k = 0; k < count; k++) {
          const q = at + k * SIZE[type]
          switch (type) {
            case 3: values.push(dv.getUint16(q, le)); break
            case 8: values.push(dv.getInt16(q, le)); break
            case 4: case 13: values.push(dv.getUint32(q, le)); break
            case 9: values.push(dv.getInt32(q, le)); break
            case 5: values.push(dv.getUint32(q, le) / dv.getUint32(q + 4, le)); break
            case 10: values.push(dv.getInt32(q, le) / dv.getInt32(q + 4, le)); break
            case 11: values.push(dv.getFloat32(q, le)); break
            case 12: values.push(dv.getFloat64(q, le)); break
          }
        }
      }
      tags.set(tag, { type, count, values })
    }
    const ifd = { offset: off, tags, next: dv.getUint32(off + 2 + 12 * n, le) }
    ifd.get = (t) => tags.get(t)?.values
    ifd.subIfds = (ifd.get(330) ?? []).map(readIfd)
    ifd.exif = tags.has(34665) ? readIfd(ifd.get(34665)[0]) : null
    return ifd
  }
  const ifds = []
  for (let off = dv.getUint32(4, le); off;) { const ifd = readIfd(off); ifds.push(ifd); off = ifd.next }
  return { le, ifds }
}

// concatenated strip bytes of an IFD
export function stripData(bytes, ifd) {
  const offs = ifd.get(273)
  const lens = ifd.get(279)
  const out = new Uint8Array(lens.reduce((a, b) => a + b, 0))
  let p = 0
  offs.forEach((o, i) => { out.set(bytes.subarray(o, o + lens[i]), p); p += lens[i] })
  return out
}

// external validator on PATH (or at one of the given absolute paths), else null
export async function findTool(cmd, paths = []) {
  const { execFileSync } = await import('node:child_process')
  const { existsSync } = await import('node:fs')
  try { return execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'pipe' }).toString().trim() || null } catch {}
  return paths.find((p) => existsSync(p)) ?? null
}
