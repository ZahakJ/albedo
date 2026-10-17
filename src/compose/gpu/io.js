// GPU uploads and readbacks for Compose. Readback goes through mapAsync in
// strips of at most 64 MB, so no full-size staging buffer exists at once.

// mapAsync, once more after the queue drains if it fails: Dawn has been
// seen to refuse a map ("external Instance reference") right after another
// context in the worker released its device
async function mapRead(device, buf) {
  try {
    await buf.mapAsync(GPUMapMode.READ)
  } catch (err) {
    await device.queue.onSubmittedWorkDone().catch(() => {})
    try {
      await buf.mapAsync(GPUMapMode.READ)
    } catch {
      throw new Error(`GPU readback failed: ${err.message}`)
    }
  }
}

const BPP = { rgba8unorm: 4, rgba16float: 8, rgba32float: 16, r8unorm: 1, r16float: 2, r32float: 4, rg16float: 4, rg32float: 8 }
const CH = { rgba8unorm: 4, rgba16float: 4, rgba32float: 4, r8unorm: 1, r16float: 1, r32float: 1, rg16float: 2, rg32float: 2 }

// ImageBitmap / canvas → premultiplied texture (level 0)
export function uploadBitmap(device, tex, bitmap, x = 0, y = 0) {
  device.queue.copyExternalImageToTexture(
    { source: bitmap, flipY: false },
    { texture: tex, origin: [x, y], premultipliedAlpha: true },
    [bitmap.width, bitmap.height])
}

// float data (one value per channel, any layout matching the format's channel
// count) → texture region. Converts to the texture's storage type.
export function uploadFloats(device, tex, data, w, h, x = 0, y = 0) {
  const f = tex.format
  const ch = CH[f]
  let buf
  if (f === 'rgba8unorm' || f === 'r8unorm') {
    buf = new Uint8Array(w * h * ch)
    for (let i = 0; i < buf.length; i++) buf[i] = Math.round(Math.min(1, Math.max(0, data[i])) * 255)
  } else if (f.endsWith('16float')) {
    buf = data instanceof Float16Array ? data : new Float16Array(data)
  } else {
    buf = data instanceof Float32Array ? data : new Float32Array(data)
  }
  device.queue.writeTexture({ texture: tex, origin: [x, y] }, buf, { bytesPerRow: w * BPP[f] }, [w, h])
}

// texture region (level 0) → Float32Array of channel values (RGBA or R),
// rows top to bottom, tightly packed
export async function readFloats(device, tex, rect = null, mipLevel = 0) {
  const [x, y, w, h] = rect ?? [0, 0, Math.max(1, tex.width >> mipLevel), Math.max(1, tex.height >> mipLevel)]
  const f = tex.format
  const bpp = BPP[f]
  const ch = CH[f]
  const bytesPerRow = Math.ceil((w * bpp) / 256) * 256
  const rows = Math.max(1, Math.floor((64 << 20) / bytesPerRow))
  const out = new Float32Array(w * h * ch)
  for (let y0 = 0; y0 < h; y0 += rows) {
    const n = Math.min(rows, h - y0)
    const buf = device.createBuffer({ size: bytesPerRow * n, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
    const enc = device.createCommandEncoder()
    enc.copyTextureToBuffer({ texture: tex, mipLevel, origin: [x, y + y0] }, { buffer: buf, bytesPerRow }, [w, n])
    device.queue.submit([enc.finish()])
    await mapRead(device, buf)
    const raw = buf.getMappedRange()
    for (let r = 0; r < n; r++) {
      const o = (y0 + r) * w * ch
      const s = r * bytesPerRow
      if (f === 'rgba8unorm' || f === 'r8unorm') {
        const v = new Uint8Array(raw, s, w * ch)
        for (let i = 0; i < w * ch; i++) out[o + i] = v[i] / 255
      } else if (f.endsWith('16float')) {
        out.set(new Float16Array(raw, s, w * ch), o)
      } else {
        out.set(new Float32Array(raw, s, w * ch), o)
      }
    }
    buf.unmap()
    buf.destroy()
  }
  return out
}

// raw bytes of a texture region in its own storage type (for saving)
export async function readRaw(device, tex, rect = null) {
  const [x, y, w, h] = rect ?? [0, 0, tex.width, tex.height]
  const bpp = BPP[tex.format]
  const bytesPerRow = Math.ceil((w * bpp) / 256) * 256
  const rows = Math.max(1, Math.floor((64 << 20) / bytesPerRow))
  const out = new Uint8Array(w * h * bpp)
  for (let y0 = 0; y0 < h; y0 += rows) {
    const n = Math.min(rows, h - y0)
    const buf = device.createBuffer({ size: bytesPerRow * n, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
    const enc = device.createCommandEncoder()
    enc.copyTextureToBuffer({ texture: tex, origin: [x, y + y0] }, { buffer: buf, bytesPerRow }, [w, n])
    device.queue.submit([enc.finish()])
    await mapRead(device, buf)
    const raw = new Uint8Array(buf.getMappedRange())
    for (let r = 0; r < n; r++) out.set(raw.subarray(r * bytesPerRow, r * bytesPerRow + w * bpp), (y0 + r) * w * bpp)
    buf.unmap()
    buf.destroy()
  }
  return out
}

export function writeRaw(device, tex, bytes, w, h) {
  device.queue.writeTexture({ texture: tex }, bytes, { bytesPerRow: w * BPP[tex.format] }, [w, h])
}

export const bytesPerPixel = (f) => BPP[f]
export const channels = (f) => CH[f]

export async function compress(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'))
  return new Uint8Array(await new Response(s).arrayBuffer())
}
export async function decompress(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'))
  return new Uint8Array(await new Response(s).arrayBuffer())
}
