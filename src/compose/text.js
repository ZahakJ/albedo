import { loadHarfBuzz, FontStore, layoutText } from './type/layout.js'
import { newText, newShape, findNode, textPad } from './model.js'
import { uploadBitmap } from './gpu/io.js'

// Type and shape layers. Their pixels are derived: laid out (layout.js) and
// rasterised from glyph outlines with Path2D at the resolution the layer is
// shown at, cached by content and scale. The node keeps only the text and
// its settings, so type stays editable forever.

const BUNDLED = [
  ['IBM Plex Sans', 400, 'IBMPlexSans-Regular.woff'],
  ['IBM Plex Sans', 700, 'IBMPlexSans-Bold.woff'],
  ['IBM Plex Sans Arabic', 400, 'IBMPlexSansArabic-Regular.woff'],
  ['IBM Plex Sans Arabic', 700, 'IBMPlexSansArabic-Bold.woff'],
]
const WEIGHT_WORDS = [[/thin|hairline/i, 100], [/extra ?light|ultra ?light/i, 200], [/light/i, 300], [/medium/i, 500],
  [/semi ?bold|demi ?bold/i, 600], [/extra ?bold|ultra ?bold/i, 800], [/black|heavy/i, 900], [/bold/i, 700]]


export function textPlugin() {
  let E
  let hb = null
  let store = null
  let loading = null
  const cache = new Map() // nodeId → { key, tex }

  function ensureFonts() {
    if (store) return Promise.resolve(store)
    loading ??= (async () => {
      hb = await loadHarfBuzz()
      const s = new FontStore(hb)
      await Promise.all(BUNDLED.map(async ([fam, w, file]) => {
        const r = await fetch(new URL(`fonts/type/${file}`, E.host.appBase))
        if (!r.ok) throw new Error(`font ${file}: ${r.status}`)
        await s.add(fam, w, new Uint8Array(await r.arrayBuffer()), { fallback: true })
      }))
      store = s
      E.requestFrame()
      E.changed()
      return s
    })()
    return loading
  }

  const scaleOf = (n) => {
    const m = n.xf?.kind === 'affine' ? n.xf.m : null
    const s = m ? Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) : 1
    // raster at the size it is seen (zoomed in, rasterise sharper), capped
    const z = Math.max(1, E.view.zoom * E.view.dpr)
    return Math.min(4, Math.max(0.25, s * Math.min(z, 2)))
  }

  function rasterText(n, k) {
    const t = n.text
    const L = layoutText(hb, store, t)
    if (!L) return null
    const pad = textPad(t.size)
    const W = Math.max(1, Math.ceil((L.width + 2 * pad) * k)), H = Math.max(1, Math.ceil((L.height + 2 * pad) * k))
    const cv = new OffscreenCanvas(W, H)
    const g = cv.getContext('2d')
    const c = t.color ?? [1, 1, 1, 1]
    g.fillStyle = `rgba(${c.slice(0, 3).map((v) => Math.round(v * 255)).join(',')},${c[3] ?? 1})`
    for (const line of L.lines) {
      for (const gl of line.glyphs) {
        const d = store.path(gl.rec, gl.gid)
        if (!d) continue
        const s = t.size / gl.rec.upem
        g.setTransform(k * s, 0, 0, -k * s, (pad + line.x + gl.x) * k, (pad + line.y + gl.y) * k)
        g.fill(new Path2D(d))
      }
    }
    return { cv, w: L.width + 2 * pad, h: L.height + 2 * pad }
  }

  function shapePath(sh, ox, oy) {
    const p = new Path2D()
    const w = sh.w, h = sh.h
    if (sh.type === 'ellipse') p.ellipse(ox + w / 2, oy + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2)
    else if (sh.type === 'polygon') {
      const n = Math.max(3, sh.sides ?? 6)
      const star = Math.min(0.95, Math.max(0, sh.star ?? 0))
      const pts = star > 0 ? n * 2 : n
      for (let i = 0; i < pts; i++) {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / pts
        const r = star > 0 && i % 2 ? 1 - star : 1
        const x = ox + w / 2 + Math.cos(a) * (w / 2) * r, y = oy + h / 2 + Math.sin(a) * (h / 2) * r
        i ? p.lineTo(x, y) : p.moveTo(x, y)
      }
      p.closePath()
    } else if (sh.type === 'line') {
      p.moveTo(ox, oy + h / 2); p.lineTo(ox + w, oy + h / 2)
    } else if (sh.radius > 0) p.roundRect(ox, oy, w, h, Math.min(sh.radius, w / 2, h / 2))
    else p.rect(ox, oy, w, h)
    return p
  }
  const css = (c) => `rgba(${c.slice(0, 3).map((v) => Math.round(v * 255)).join(',')},${c[3] ?? 1})`
  const shapePad = (sh) => Math.ceil(sh.stroke ? (sh.stroke.align === 'inside' ? 0 : sh.stroke.align === 'center' ? sh.stroke.width / 2 : sh.stroke.width) : 0) + 2

  function rasterShape(n, k) {
    const sh = n.shape
    const pad = shapePad(sh)
    const W = Math.max(1, Math.ceil((sh.w + 2 * pad) * k)), H = Math.max(1, Math.ceil((sh.h + 2 * pad) * k))
    const cv = new OffscreenCanvas(W, H)
    const g = cv.getContext('2d')
    g.scale(k, k)
    const p = shapePath(sh, pad, pad)
    if (sh.fill && sh.type !== 'line') { g.fillStyle = css(sh.fill); g.fill(p) }
    const st = sh.stroke ?? (sh.type === 'line' ? { width: 4, color: sh.fill ?? [1, 1, 1, 1], align: 'center' } : null)
    if (st?.width > 0) {
      g.strokeStyle = css(st.color)
      g.lineJoin = 'round'
      if (st.align === 'center' || sh.type === 'line') { g.lineWidth = st.width; g.stroke(p) }
      else {
        g.save()
        g.lineWidth = st.width * 2
        if (st.align === 'inside') g.clip(p)
        else {
          // outside: stroke, then cut out the shape's interior again
          const o = new OffscreenCanvas(W, H)
          const og = o.getContext('2d')
          og.scale(k, k)
          og.strokeStyle = g.strokeStyle
          og.lineWidth = st.width * 2
          og.lineJoin = 'round'
          og.stroke(p)
          og.globalCompositeOperation = 'destination-out'
          og.fill(p)
          g.setTransform(1, 0, 0, 1, 0, 0)
          g.drawImage(o, 0, 0)
          g.restore()
          return { cv, w: sh.w + 2 * pad, h: sh.h + 2 * pad }
        }
        g.stroke(p)
        g.restore()
      }
    }
    return { cv, w: sh.w + 2 * pad, h: sh.h + 2 * pad }
  }

  function vectorTex(n) {
    if (n.kind === 'text' && !store) { ensureFonts().catch((e) => console.error('[type] fonts', e)); return cache.get(n.id) ?? null }
    const k = scaleOf(n)
    const key = JSON.stringify([n.kind, n.text ?? n.shape, k.toFixed(3)])
    const c = cache.get(n.id)
    if (c?.key === key) return c
    const r = n.kind === 'text' ? rasterText(n, k) : rasterShape(n, k)
    if (!r) return c ?? null
    c?.tex.destroy()
    const tex = E.C.createTex(r.cv.width, r.cv.height, 'rgba16float', true)
    uploadBitmap(E.device, tex, r.cv)
    E.C.genMips(tex)
    const out = { key, tex, w: r.w, h: r.h }
    cache.set(n.id, out)
    return out
  }

  // the bounds a text or shape node has with these settings (top-left kept)
  async function boundsFor(kind, x, y, props) {
    if (kind === 'text') {
      await ensureFonts()
      const L = layoutText(hb, store, props)
      const pad = textPad(props.size)
      return { x, y, w: Math.max(1, L.width + 2 * pad), h: Math.max(1, L.height + 2 * pad) }
    }
    const pad = shapePad(props)
    return { x, y, w: props.w + 2 * pad, h: props.h + 2 * pad }
  }

  const ops = {
    // x, y: where the click was — the first baseline starts there
    async addText({ x, y, text = {} }) {
      await ensureFonts()
      const n = newText(0, 0, text)
      const pad = textPad(n.text.size)
      const L = layoutText(hb, store, n.text)
      n.bounds = await boundsFor('text', x - pad, y - pad - (L?.ascent ?? n.text.size * 0.8), n.text)
      E.commit('New Type Layer', E.setActive(E.insertAbove(E.doc, E.doc.activeId, [n]), n.id))
      return { nodeId: n.id }
    },
    // patch: text settings; live: no history (typing), commit later
    async setText({ nodeId, patch, live = false, label = 'Edit Type' }) {
      const n = findNode(E.doc.nodes, nodeId)?.node
      if (n?.kind !== 'text') return
      const text = { ...n.text, ...patch }
      const b = await boundsFor('text', n.bounds.x, n.bounds.y, text)
      const next = E.patchNode(E.doc, nodeId, { text, bounds: b, name: n.nameLocked ? n.name : (text.content || 'Text').slice(0, 24) })
      if (live) { E.doc = next; E.requestFrame(); E.changed() } else E.commit(label, next)
    },
    async addShape({ x, y, shape = {} }) {
      const n = newShape(0, 0, shape)
      const pad = shapePad(n.shape)
      n.bounds = await boundsFor('shape', x - pad, y - pad, n.shape)
      E.commit('New Shape Layer', E.setActive(E.insertAbove(E.doc, E.doc.activeId, [n]), n.id))
      return { nodeId: n.id }
    },
    async setShape({ nodeId, patch, live = false, label = 'Edit Shape' }) {
      const n = findNode(E.doc.nodes, nodeId)?.node
      if (n?.kind !== 'shape') return
      const shape = { ...n.shape, ...patch }
      // keep the geometric top-left where it was while the stroke pad changes
      const p0 = shapePad(n.shape), p1 = shapePad(shape)
      const b = await boundsFor('shape', n.bounds.x + p0 - p1, n.bounds.y + p0 - p1, shape)
      const next = E.patchNode(E.doc, nodeId, { shape, bounds: b })
      if (live) { E.doc = next; E.requestFrame(); E.changed() } else E.commit(label, next)
    },
    // a font file (TTF, OTF, WOFF) or one from the Local Font Access API
    async addFont({ bytes, family, weight }) {
      await ensureFonts()
      const sfnt = new Uint8Array(bytes)
      let fam = family, w = weight
      try {
        const { woffToSfnt } = await import('./type/woff.js')
        const raw = await woffToSfnt(sfnt)
        const face = new hb.Face(new hb.Blob(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)), 0)
        fam ??= face.getName(16, 'en') || face.getName(1, 'en')
        const sub = face.getName(17, 'en') || face.getName(2, 'en') || ''
        w ??= WEIGHT_WORDS.find(([re]) => re.test(sub))?.[1] ?? 400
      } catch { /* names unreadable: keep what we were told */ }
      await store.add(fam ?? 'Font', w ?? 400, sfnt)
      for (const [id, c] of cache) { c.tex.destroy(); cache.delete(id) }
      E.requestFrame()
      return { family: fam, weight: w, families: store.list() }
    },
    async listFonts() {
      await ensureFonts()
      return { families: store.list() }
    },
  }

  return {
    init(e) { E = e; E.textBounds = (x, y, props) => boundsFor('text', x, y, props) },
    ops,
    vectorTex,
    reset() { for (const c of cache.values()) c.tex.destroy(); cache.clear() },
    get ready() { return !!store },
  }
}
