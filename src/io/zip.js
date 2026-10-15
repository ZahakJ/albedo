// Hand-rolled STORE-only zip (no deps, no compression): local headers +
// central directory + EOCD, and a reader for the same subset. Used by the
// catalog backup (sidecars/presets/smarts are small JSON — deflate would buy
// little and cost a dependency). Names are UTF-8 (flag bit 11).

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(bytes) {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// entries: [{ name: string, data: Uint8Array }] → Uint8Array of the whole zip.
export function zipWrite(entries) {
  const enc = new TextEncoder()
  const now = new Date()
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff

  const locals = []
  const centrals = []
  let offset = 0
  for (const { name, data } of entries) {
    const nameB = enc.encode(name)
    const crc = crc32(data)
    const local = new Uint8Array(30 + nameB.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)          // version needed
    lv.setUint16(6, 0x0800, true)      // UTF-8 names
    lv.setUint16(8, 0, true)           // method: STORE
    lv.setUint16(10, dosTime, true)
    lv.setUint16(12, dosDate, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, data.length, true) // csize (= size, STORE)
    lv.setUint32(22, data.length, true)
    lv.setUint16(26, nameB.length, true)
    lv.setUint16(28, 0, true)          // extra len
    local.set(nameB, 30)
    locals.push(local, data)

    const cen = new Uint8Array(46 + nameB.length)
    const cv = new DataView(cen.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)          // made by
    cv.setUint16(6, 20, true)          // needed
    cv.setUint16(8, 0x0800, true)
    cv.setUint16(10, 0, true)
    cv.setUint16(12, dosTime, true)
    cv.setUint16(14, dosDate, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, data.length, true)
    cv.setUint32(24, data.length, true)
    cv.setUint16(28, nameB.length, true)
    cv.setUint32(42, offset, true)     // local header offset
    cen.set(nameB, 46)
    centrals.push(cen)
    offset += local.length + data.length
  }

  const cdSize = centrals.reduce((n, c) => n + c.length, 0)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, cdSize, true)
  ev.setUint32(16, offset, true)      // cd start

  const total = offset + cdSize + 22
  const out = new Uint8Array(total)
  let at = 0
  for (const part of [...locals, ...centrals, eocd]) { out.set(part, at); at += part.length }
  return out
}

// Uint8Array zip → [{ name, data: Uint8Array }]. STORE entries only; anything
// compressed (foreign zip) is skipped rather than mis-read.
export function zipRead(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const dec = new TextDecoder()
  // EOCD: scan back over a possible trailing comment (≤64KB)
  let eocd = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('not a zip (no end-of-central-directory)')
  const count = view.getUint16(eocd + 10, true)
  let at = view.getUint32(eocd + 16, true)
  const out = []
  for (let n = 0; n < count; n++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) break
    const method = view.getUint16(at + 10, true)
    const csize = view.getUint32(at + 20, true)
    const nameLen = view.getUint16(at + 28, true)
    const extraLen = view.getUint16(at + 30, true)
    const commentLen = view.getUint16(at + 32, true)
    const localAt = view.getUint32(at + 42, true)
    const name = dec.decode(bytes.subarray(at + 46, at + 46 + nameLen))
    at += 46 + nameLen + extraLen + commentLen
    if (method !== 0) continue // STORE only
    if (localAt + 30 > bytes.length || view.getUint32(localAt, true) !== 0x04034b50) continue
    const lName = view.getUint16(localAt + 26, true)
    const lExtra = view.getUint16(localAt + 28, true)
    const start = localAt + 30 + lName + lExtra
    if (start + csize > bytes.length) continue
    out.push({ name, data: bytes.slice(start, start + csize) })
  }
  return out
}
