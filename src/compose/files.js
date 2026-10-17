import { CO } from './protocol.js'
import { writePsd, readPsd, readTiffLayers } from './files/psd.js'
import { parseTiff, decodePage } from './files/tiff.js'
import { zipWrite, zipRead } from '../io/zip.js'
import { readFloats, readRaw, writeRaw, compress, decompress, uploadFloats } from './gpu/io.js'
import { SRGB_ICC } from '../io/tiff.js'
import { newDoc, newPixel, newGroup, newAdjust, allNodes, walk, countLayers } from './model.js'

// Layered files: PSD (read and write), layered and multi-page TIFF (read),
// and .albedo, Compose's own document — a zip of the document, every texture
// at full precision, and the originals of its smart objects, so it opens on
// any machine exactly as it was saved.
//
// What PSD can't hold is rendered into pixels on export, with its blend
// mode, opacity, mask and clipping kept: Develop adjustments, smart objects
// (RAW stays here), type, shapes, fills, layer styles. "PSD with albedo data"
// adds the whole .albedo document in a plug-in resource, so reopening the
// PSD in albedo brings back everything.

export function filesPlugin() {
  let E

  const premul = (px) => { for (let i = 0; i < px.length; i += 4) { const a = px[i + 3]; px[i] *= a; px[i + 1] *= a; px[i + 2] *= a } return px }
  const unpremul = (px) => {
    for (let i = 0; i < px.length; i += 4) { const a = px[i + 3]; if (a > 1e-6) { px[i] /= a; px[i + 1] /= a; px[i + 2] /= a } else { px[i] = px[i + 1] = px[i + 2] = 0 } }
    return px
  }

  // ── export: PSD ──────────────────────────────────────────────────────────
  // the nodes up to (and including) id, inside the context an adjustment
  // sees: the nearest isolated group, or the document
  function contextUpTo(id) {
    const path = []
    const find = (list) => {
      for (const n of list) {
        if (n.id === id) { path.push(n); return true }
        if (n.kind === 'group' && find(n.children ?? [])) { path.unshift(n); return true }
      }
      return false
    }
    find(E.doc.nodes)
    let ctxList = E.doc.nodes
    let start = 0
    for (let i = path.length - 2; i >= 0; i--) {
      if (path[i].kind === 'group' && path[i].blend !== 'pass') { start = i + 1; ctxList = path[i].children; break }
    }
    const trunc = (list, depth) => {
      const out = []
      for (const n of list) {
        if (depth < path.length - 1 && n.id === path[depth].id) {
          out.push({ ...n, children: trunc(n.children ?? [], depth + 1) })
          return out
        }
        if (n.id === id) { out.push(n); return out }
        out.push(n)
      }
      return out
    }
    return trunc(ctxList, start)
  }

  // a node's own pixels (doc-sized when transformed), straight
  async function nodePixels(n, { withStyles = false } = {}) {
    if (n.kind === 'pixel' && !n.xf && !n.disp) {
      const tex = E.texOf(n.pix)
      const px = unpremul(await readFloats(E.device, tex))
      return { x: Math.round(n.bounds.x), y: Math.round(n.bounds.y), w: tex.width, h: tex.height, rgba: px }
    }
    const solo = { ...n, opacity: 1, fillOpacity: withStyles ? n.fillOpacity : 1, blend: 'normal', clip: false, blendIf: null, mask: null, styles: withStyles ? n.styles : null, visible: true }
    const id = E.renderToRes([solo])
    const tex = E.texOf(id)
    const px = unpremul(await readFloats(E.device, tex))
    tex.destroy(); E.res.delete(id)
    return cropAlpha({ x: 0, y: 0, w: tex.width, h: tex.height, rgba: px })
  }
  async function adjustPixels(n) {
    const ctx = contextUpTo(n.id)
    const last = ctx.length - 1
    const flatAdj = (list) => list.map((m, i) => {
      if (m.id === n.id) return { ...m, opacity: 1, blend: 'normal', mask: null, blendIf: null, clip: false }
      if (m.kind === 'group' && i === list.length - 1) return { ...m, children: flatAdj(m.children ?? []) }
      return m
    })
    void last
    const id = E.renderToRes(flatAdj(ctx))
    const tex = E.texOf(id)
    const px = unpremul(await readFloats(E.device, tex))
    tex.destroy(); E.res.delete(id)
    return { x: 0, y: 0, w: tex.width, h: tex.height, rgba: px }
  }
  async function maskOf(n) {
    if (!n.mask?.tex) return null
    const t = E.texOf(n.mask.tex)
    const v = await readFloats(E.device, t)
    let data = v
    if (n.mask.invert) { data = new Float32Array(v.length); for (let i = 0; i < v.length; i++) data[i] = 1 - v[i] }
    if ((n.mask.density ?? 1) < 1) { const k = n.mask.density; for (let i = 0; i < data.length; i++) data[i] = 1 - k * (1 - data[i]) }
    return { x: Math.round(n.mask.ox ?? 0), y: Math.round(n.mask.oy ?? 0), w: t.width, h: t.height, data, default: 255, disabled: n.mask.enabled === false }
  }

  async function psdLayers() {
    const out = []
    const visit = async (list) => {
      for (const n of list) {
        if (n.kind === 'group') {
          out.push({ kind: 'groupEnd' })
          await visit(n.children ?? [])
          out.push({ kind: 'groupStart', name: n.name, blend: n.blend ?? 'pass', opacity: n.opacity, visible: n.visible !== false, collapsed: !!n.collapsed, mask: await maskOf(n) })
          continue
        }
        // 32-bit: textures and renders are linear already, as PSD wants
        const p = n.kind === 'adjust' ? await adjustPixels(n) : await nodePixels(n, { withStyles: !!n.styles?.length })
        const label = n.kind === 'pixel' ? n.name
          : n.kind === 'adjust' ? `${n.name} (albedo adjustment, rendered)`
            : n.kind === 'smart' ? `${n.name} (albedo smart object, rendered)`
              : n.kind === 'text' ? `${n.name} (albedo type, rendered)` : `${n.name} (rendered)`
        out.push({
          kind: 'pixel', name: label, ...p,
          opacity: n.opacity, fill: n.styles?.length ? 1 : n.fillOpacity ?? 1, blend: n.blend ?? 'normal',
          clip: !!n.clip, visible: n.visible !== false, blendIf: n.blendIf, mask: await maskOf(n),
        })
      }
    }
    await visit(E.doc.nodes)
    return out
  }

  async function exportPsd({ withAlbedo = false } = {}) {
    const layers = await psdLayers()
    const composite = await E.compositeFloats(E.doc, null, { linear: true })
    const privateData = withAlbedo ? zipWrite(await albedoEntries({ originals: false })) : null
    const bytes = await writePsd({ width: E.doc.width, height: E.doc.height, depth: E.doc.depth, layers, composite, icc: E.doc.depth === 32 ? null : SRGB_ICC, privateData })
    return new Blob([bytes], { type: 'image/vnd.adobe.photoshop' })
  }

  // ── .albedo ──────────────────────────────────────────────────────────────
  async function albedoEntries() {
    const refs = new Set()
    walk(E.doc.nodes, (n) => { if (n.pix) refs.add(n.pix); if (n.mask?.tex) refs.add(n.mask.tex); if (n.disp) refs.add(n.disp) })
    if (E.doc.selection?.tex) refs.add(E.doc.selection.tex)
    const files = {}
    const entries = []
    for (const id of refs) {
      const r = E.res.get(id)
      if (!r) continue
      files[id] = { w: r.tex.width, h: r.tex.height, format: r.tex.format, mips: r.tex.mipLevelCount > 1 }
      entries.push({ name: `res/${id}.z`, data: await compress(await readRaw(E.device, r.tex)) })
    }
    const smart = [...new Set(allNodes(E.doc.nodes).filter((n) => n.kind === 'smart').map((n) => n.smart.photoId))]
    const meta = { format: 'albedo-compose', schema: 1, doc: E.doc, files, smart }
    entries.unshift({ name: 'doc.json', data: new TextEncoder().encode(JSON.stringify(meta)) })
    return entries
  }

  async function loadAlbedo(entries) {
    const byName = new Map(entries.map((e) => [e.name, e.data]))
    const meta = JSON.parse(new TextDecoder().decode(byName.get('doc.json')))
    if (meta.format !== 'albedo-compose') throw new Error('Not an albedo document')
    const res = []
    for (const [id, f] of Object.entries(meta.files)) {
      const z = byName.get(`res/${id}.z`)
      if (!z) continue
      res.push({ id, f, bytes: await decompress(z) })
    }
    return { doc: meta.doc, res, smart: meta.smart ?? [] }
  }

  function adoptDoc(doc, res) {
    E.reset(doc, res.map(({ id, f, bytes }) => {
      const tex = E.C.createTex(f.w, f.h, f.format, f.mips)
      writeRaw(E.device, tex, bytes, f.w, f.h)
      if (f.mips) E.C.genMips(tex)
      return [id, tex]
    }))
  }

  // ── import: a PSD's layers → a document ──────────────────────────────────
  async function fromLayers({ width, height, depth, layers, composite }, name) {
    const d = newDoc(width, height, { depth: depth === 32 ? 32 : depth === 16 ? 16 : 8, name })
    E.reset(d, [])
    const stack = [[]]
    const skipped = []
    for (const L of layers) {
      if (L.kind === 'groupEnd') { stack.push([]); continue }
      let node = null
      if (L.kind === 'groupStart') {
        const kids = stack.length > 1 ? stack.pop() : []
        node = newGroup(kids, { name: L.name || 'Group', collapsed: L.collapsed, blend: L.blend === 'normal' ? 'normal' : L.blend ?? 'pass' })
      } else if (L.kind === 'adjust') {
        node = newAdjust(L.adjust.type, { name: L.name })
        node.adjust = { ...node.adjust, ...L.adjust, params: { ...node.adjust.params, ...L.adjust.params } }
      } else {
        if (L.unsupported) skipped.push(`${L.name} (${L.unsupported})`)
        if (!L.rgba || !L.w || !L.h) {
          if (L.unsupported) continue
          node = newPixel({ x: 0, y: 0, w: 1, h: 1 }, { name: L.name || 'Layer', pix: E.newRes(1, 1) })
        } else {
          const px = L.rgba
          const id = E.newRes(L.w, L.h)
          uploadFloats(E.device, E.texOf(id), premul(px), L.w, L.h)
          E.C.genMips(E.texOf(id))
          node = newPixel({ x: L.x, y: L.y, w: L.w, h: L.h }, { name: L.name || 'Layer', pix: id })
        }
      }
      node.opacity = L.opacity ?? 1
      node.fillOpacity = L.fill ?? 1
      if (L.kind !== 'groupStart') node.blend = L.blend ?? 'normal'
      node.clip = !!L.clip
      node.visible = L.visible !== false
      node.blendIf = L.blendIf ?? null
      if (L.mask?.data) node.mask = placeMask(L.mask, width, height)
      stack[stack.length - 1].push(node)
    }
    while (stack.length > 1) { const kids = stack.pop(); stack[stack.length - 1].push(...kids) }
    let nodes = stack[0]
    if (!nodes.length && composite) {
      const px = composite
      const id = E.newRes(width, height)
      uploadFloats(E.device, E.texOf(id), premul(px), width, height)
      E.C.genMips(E.texOf(id))
      nodes = [newPixel({ x: 0, y: 0, w: width, h: height }, { name: 'Background', pix: id })]
    }
    const doc = { ...d, nodes, activeId: nodes[nodes.length - 1]?.id ?? null }
    E.reset(doc, null)
    return { skipped }
  }
  function placeMask(m, W, H) {
    const id = E.newRes(W, H, E.mfmt())
    const t = E.texOf(id)
    const v = (m.default ?? 255) / 255
    const full = new Float32Array(W * H).fill(v)
    for (let y = 0; y < m.h; y++) {
      const dy = y + m.y
      if (dy < 0 || dy >= H) continue
      for (let x = 0; x < m.w; x++) {
        const dx = x + m.x
        if (dx >= 0 && dx < W) full[dy * W + dx] = m.data[y * m.w + x]
      }
    }
    uploadFloats(E.device, t, full, W, H)
    E.C.genMips(t)
    return { tex: id, enabled: !m.disabled, density: 1, invert: false }
  }

  const handles = {
    async [CO.IMPORT]({ bytes, name, kind }) {
      const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
      if (kind === 'albedo') {
        const a = await loadAlbedo(zipRead(u8))
        adoptDoc(a.doc, a.res)
        return { docId: E.doc.id, smart: a.smart }
      }
      if (kind === 'psd') {
        const p = await readPsd(u8)
        if (p.private) {
          try {
            const a = await loadAlbedo(zipRead(p.private))
            adoptDoc(a.doc, a.res)
            return { docId: E.doc.id, smart: a.smart, restored: true }
          } catch { /* not ours, or damaged: read the layers */ }
        }
        const r = await fromLayers(p, name)
        return { docId: E.doc.id, skipped: r.skipped, layers: countLayers(E.doc.nodes) }
      }
      if (kind === 'tiff') {
        const pages = parseTiff(u8)
        if (!pages.length) throw new Error('No image in this TIFF')
        const first = await decodePage(u8, pages[0])
        const src = pages[0].tags[37724]
        if (src) {
          const layers = await readTiffLayers(src, first.depth)
          if (layers?.length) {
            const r = await fromLayers({ width: first.width, height: first.height, depth: first.depth, layers, composite: first.rgba }, name)
            return { docId: E.doc.id, skipped: r.skipped, layers: countLayers(E.doc.nodes), layered: true }
          }
        }
        // pages as layers (GIMP and others write layers as pages)
        const all = [first]
        for (const pg of pages.slice(1)) {
          try { const d = await decodePage(u8, pg); if (d.width <= first.width && d.height <= first.height) all.push(d) } catch { /* thumbnails, masks */ }
        }
        const layers = all.map((d, i) => ({ kind: 'pixel', name: i ? `Page ${i + 1}` : 'Background', x: 0, y: 0, w: d.width, h: d.height, rgba: d.rgba, opacity: 1, visible: true }))
        const r = await fromLayers({ width: first.width, height: first.height, depth: first.float ? 32 : first.depth, layers, composite: null }, name)
        return { docId: E.doc.id, skipped: r.skipped, layers: layers.length }
      }
      throw new Error(`Unknown file kind ${kind}`)
    },
  }

  return {
    init(e) { E = e },
    handles,
    exporters: {
      psd: (d) => exportPsd({ withAlbedo: !!d.withAlbedo }),
      albedo: async () => ({ entries: await albedoEntries() }),
    },
  }
}

function cropAlpha(p) {
  const { w, h, rgba } = p
  let x0 = w, y0 = h, x1 = -1, y1 = -1
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (rgba[(y * w + x) * 4 + 3] <= 0) continue
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y
  }
  if (x1 < 0) return { x: 0, y: 0, w: 0, h: 0, rgba: new Float32Array(0) }
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1
  const out = new Float32Array(cw * ch * 4)
  for (let y = 0; y < ch; y++) out.set(rgba.subarray(((y + y0) * w + x0) * 4, ((y + y0) * w + x0 + cw) * 4), y * cw * 4)
  return { x: p.x + x0, y: p.y + y0, w: cw, h: ch, rgba: out }
}
