import { MODULE_DEFAULTS } from '../engine/editdoc.js'
import { stripOrientation, spliceExifJpeg } from './exif.js'

// Export post-processing on the main thread. The render worker always renders
// full resolution; resize happens here on the encoded blob so the worker needs
// no export-path changes. JPEG exports re-attach the original's APP1 Exif
// segment via attachExif (orientation neutralized — pixels are already
// oriented); PNG stays metadata-free.

// Long-edge resize with two-step halving: for >2× downscales, repeated 50%
// draws before the final resize keep high frequencies from aliasing —
// visibly better than a one-shot bilinear at e.g. 6000→1024.
export async function resizeToLongEdge(blob, longEdge, type, quality) {
  if (!longEdge) return blob
  let src = await createImageBitmap(blob)
  let w = src.width
  let h = src.height
  if (Math.max(w, h) <= longEdge) { src.close?.(); return blob } // never upscale
  const draw = (from, tw, th) => {
    const c = new OffscreenCanvas(tw, th)
    const ctx = c.getContext('2d')
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(from, 0, 0, tw, th)
    from.close?.()
    return c
  }
  while (Math.max(w, h) >= longEdge * 2) {
    w = Math.max(1, Math.round(w / 2))
    h = Math.max(1, Math.round(h / 2))
    src = draw(src, w, h)
  }
  const scale = longEdge / Math.max(w, h)
  const ow = Math.max(1, Math.round(w * scale))
  const oh = Math.max(1, Math.round(h * scale))
  if (ow !== w || oh !== h) src = draw(src, ow, oh)
  const out = await src.convertToBlob({ type, quality })
  return out
}

// Pattern + photo filename → safe output filename with extension.
// Tokens: {name} (source basename), {seq} (001…, batch position), {date}
// (capture date YYYYMMDD, import date fallback), {rating} (0–5).
export function filenameFor(pattern, photoName, ext, ctx = {}) {
  const base = photoName.replace(/\.[^.]+$/, '')
  const d = ctx.date != null ? new Date(ctx.date) : null
  const date = d && !Number.isNaN(d.getTime())
    ? `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
    : ''
  const name = (pattern || '{name}')
    .replaceAll('{name}', base)
    .replaceAll('{seq}', String(ctx.seq ?? 1).padStart(3, '0'))
    .replaceAll('{date}', date)
    .replaceAll('{rating}', String(ctx.rating ?? 0))
    .replace(/[/\\:*?"<>|]/g, '-').trim() || base
  return `${name}.${ext}`
}

// ── watermark: text onto the encoded blob, post-resize ─────────────────────
// 50% white + soft shadow, IBM Plex Sans from the document fonts, size keyed
// to the long edge so S/M/L read the same at any output resolution.
const WM_SCALE = { s: 0.018, m: 0.028, l: 0.042 }

export async function applyWatermark(blob, { text, corner = 'se', size = 'm' }, type, quality) {
  if (!text) return blob
  const bmp = await createImageBitmap(blob)
  const c = new OffscreenCanvas(bmp.width, bmp.height)
  const ctx = c.getContext('2d')
  ctx.drawImage(bmp, 0, 0)
  bmp.close()
  const px = Math.max(11, Math.round(Math.max(c.width, c.height) * (WM_SCALE[size] ?? WM_SCALE.m)))
  const font = `500 ${px}px 'IBM Plex Sans', system-ui, sans-serif`
  try { await document.fonts?.load(font) } catch { /* fallback stack still draws */ }
  ctx.font = font
  ctx.fillStyle = 'rgba(255, 255, 255, 0.5)'
  ctx.shadowColor = 'rgba(0, 0, 0, 0.4)'
  ctx.shadowBlur = Math.max(1, px * 0.15)
  ctx.shadowOffsetY = Math.max(1, px * 0.05)
  const pad = Math.round(px * 0.9)
  ctx.textAlign = corner === 'c' ? 'center' : corner.endsWith('w') ? 'left' : 'right'
  ctx.textBaseline = corner === 'c' ? 'middle' : corner.startsWith('n') ? 'top' : 'alphabetic'
  const x = corner === 'c' ? c.width / 2 : corner.endsWith('w') ? pad : c.width - pad
  const y = corner === 'c' ? c.height / 2 : corner.startsWith('n') ? pad : c.height - pad
  ctx.fillText(text, x, y)
  return c.convertToBlob({ type, quality })
}

// ── EXIF carry-over: splice the original's APP1 into the exported JPEG ─────
// app1: Uint8Array payload from exifApp1(originalBuffer). Orientation is
// neutralized first — the exported pixels are already upright.
export async function attachExif(blob, app1) {
  if (!app1) return blob
  try {
    const bytes = spliceExifJpeg(new Uint8Array(await blob.arrayBuffer()), stripOrientation(app1))
    return new Blob([bytes], { type: 'image/jpeg' })
  } catch { return blob } // metadata is best-effort; pixels always ship
}

// 'Output sharpen' off: force sharpenAmount 0 in the export doc. Non-RAW
// without an explicit detail module already ships with the family off — an
// explicit module there would switch chroma NR on, so leave it untouched.
export function stripOutputSharpen(doc, isRaw) {
  if (!doc.modules?.detail && !isRaw) return doc
  const detail = { ...MODULE_DEFAULTS.detail, ...doc.modules?.detail, sharpenAmount: 0 }
  return { ...doc, modules: { ...doc.modules, detail } }
}

// One picked directory per batch (File System Access API); null = downloads.
export async function pickExportDir() {
  if (typeof window.showDirectoryPicker !== 'function') return null
  try {
    return await window.showDirectoryPicker({ mode: 'readwrite', id: 'albedo-export' })
  } catch { return null } // dismissed or unavailable (headless)
}

export async function saveBlob(blob, filename, dirHandle) {
  if (dirHandle) {
    const fh = await dirHandle.getFileHandle(filename, { create: true })
    const w = await fh.createWritable()
    await w.write(blob)
    await w.close()
  } else {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = filename
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 4000)
  }
}
