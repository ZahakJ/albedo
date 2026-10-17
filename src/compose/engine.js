import { CO } from './protocol.js'
import {
  newDoc, newPixel, newGroup, newAdjust, newFill, newSmart, newId, findNode, walk, allNodes,
  topIndexOf, isDrawable, countLayers,
} from './model.js'
import { createCompositor, storageFormat, maskFormat, texBytes } from './gpu/compositor.js'
import { cornersFor } from './mesh.js'
import { uploadBitmap, readFloats, readRaw, writeRaw, compress, decompress, bytesPerPixel } from './gpu/io.js'
import { writeFileAtomic, readFile, getDir, deleteDir } from '../io/opfs.js'

// Compose engine: owns the open document, its GPU resources and its history.
// Runs inside the render worker; `host` (render.worker.js) lends it the GPU
// device and Develop's machinery (smart objects, Develop adjustment layers).
//
// The document is immutable: every change makes new node objects along the
// path from the changed node to the root, so history entries are just the
// documents before and after, and the compositor's below-cache keys on node
// identity. Pixels live in `res` (id → GPU texture), referenced from nodes by
// id (node.pix, node.mask.tex, node.disp). An operation that changes pixels in
// place records the region before and after; one that replaces a texture
// makes a new id, so the old texture survives for undo until no history
// entry refers to it.

const HISTORY_BUDGET = 1536 << 20 // bytes of VRAM history may hold
const SAVE_DELAY = 2500

export function createComposeEngine(host) {
  const gpu = host.gpu
  const { device } = gpu
  const C = createCompositor(gpu)
  const post = host.post

  let canvas = null
  let gctx = null
  let doc = null
  const res = new Map() // resId → { tex, w, h, dirty }
  const derived = new Map() // nodeId → { tex, key, w, h } (smart objects, text, shapes)
  let view = { cssW: 0, cssH: 0, dpr: 1, zoom: 1, offX: 0, offY: 0, surround: [0.11, 0.11, 0.11] }
  let acc = null
  let history = [] // [{ label, before, after, pix?: [{ resId, rect, before, after }], bytes }]
  let at = -1 // index of the last applied entry
  let interacting = null // nodeId under a live gesture (below-cache anchor)
  let frameStats = { ms: 0, cpuMs: 0, frames: 0 }
  const plugins = [] // paint, select, text, … — each may hook into frames and ops
  const sources = new Map() // photoId → requested
  let saveTimer = null
  let dirty = false

  // ── resources ────────────────────────────────────────────────────────────
  const fmt = () => storageFormat(doc?.depth ?? 16)
  const mfmt = () => maskFormat(doc?.depth ?? 16)
  const accFmt = () => (doc?.depth === 32 ? 'rgba32float' : 'rgba16float')

  function newRes(w, h, format = fmt(), mips = true) {
    const id = newId('r')
    const tex = C.createTex(w, h, format, mips)
    res.set(id, { tex, w, h, dirty: true })
    return id
  }
  const texOf = (id) => res.get(id)?.tex ?? null

  // every resource id referenced by a document
  function refsOf(d, set = new Set()) {
    if (!d) return set
    if (d.selection?.tex) set.add(d.selection.tex)
    if (d.lastSelection?.tex) set.add(d.lastSelection.tex)
    walk(d.nodes, (n) => {
      if (n.pix) set.add(n.pix)
      if (n.mask?.tex) set.add(n.mask.tex)
      if (n.disp) set.add(n.disp)
    })
    return set
  }
  function gc() {
    const keep = refsOf(doc)
    for (const e of history) { refsOf(e.before, keep); refsOf(e.after, keep) }
    for (const p of plugins) p.refs?.(keep)
    for (const [id, r] of res) if (!keep.has(id)) { r.tex.destroy(); res.delete(id) }
    const ids = new Set(doc ? allNodes(doc.nodes).map((n) => n.id) : [])
    for (const e of history) for (const d of [e.before, e.after]) if (d) for (const n of allNodes(d.nodes)) ids.add(n.id)
    for (const [id, d] of derived) if (!ids.has(id)) { d.tex?.destroy(); derived.delete(id) }
  }
  const vramBytes = () => {
    let n = 0
    for (const r of res.values()) n += texBytes(r.tex)
    for (const d of derived.values()) n += texBytes(d.tex)
    for (const e of history) for (const p of e.pix ?? []) n += texBytes(p.before) + texBytes(p.after)
    return n
  }

  // ── immutable updates ────────────────────────────────────────────────────
  // replace node `id` with fn(node) (returning a node, or null to remove it);
  // ancestors are copied; the result is a new document
  function updateNode(d, id, fn) {
    const rec = (list) => {
      let changed = false
      const out = []
      for (const n of list) {
        if (n.id === id) {
          const r = fn(n)
          changed = true
          if (r) out.push(Array.isArray(r) ? r : { ...r, rev: (n.rev ?? 0) + 1 })
          continue
        }
        if (n.kind === 'group') {
          const kids = rec(n.children ?? [])
          if (kids) { out.push({ ...n, children: kids, rev: (n.rev ?? 0) + 1 }); changed = true; continue }
        }
        out.push(n)
      }
      return changed ? out.flat() : null
    }
    const nodes = rec(d.nodes)
    return nodes ? { ...d, nodes, rev: d.rev + 1 } : d
  }
  const patchNode = (d, id, patch) => updateNode(d, id, (n) => ({ ...n, ...(typeof patch === 'function' ? patch(n) : patch) }))
  const touch = (d, id) => updateNode(d, id, (n) => ({ ...n }))

  // insert nodes above `refId` (or at the top of the root when null),
  // inside the same parent
  function insertAbove(d, refId, nodes) {
    if (!refId) return { ...d, nodes: [...d.nodes, ...nodes], rev: d.rev + 1 }
    const hit = findNode(d.nodes, refId)
    if (!hit) return { ...d, nodes: [...d.nodes, ...nodes], rev: d.rev + 1 }
    if (hit.node.kind === 'group' && !hit.node.collapsed && hit.node.children?.length === 0) {
      return patchNode(d, refId, (g) => ({ children: [...nodes] }))
    }
    if (!hit.parent) {
      const list = [...d.nodes]
      list.splice(hit.index + 1, 0, ...nodes)
      return { ...d, nodes: list, rev: d.rev + 1 }
    }
    return patchNode(d, hit.parent.id, (g) => {
      const kids = [...g.children]
      kids.splice(hit.index + 1, 0, ...nodes)
      return { children: kids }
    })
  }
  const removeNode = (d, id) => updateNode(d, id, () => null)

  // ── history ──────────────────────────────────────────────────────────────
  function commit(label, after, pix = null) {
    const before = doc
    history = history.slice(0, at + 1)
    for (const e of history.slice(at + 1)) for (const p of e.pix ?? []) { p.before?.destroy(); p.after?.destroy() }
    history.push({ label, before, after, pix })
    at = history.length - 1
    doc = after
    // trim by VRAM budget, oldest first
    let total = vramBytes()
    while (history.length > 1 && total > HISTORY_BUDGET + baseBytes()) {
      const e = history.shift()
      at--
      for (const p of e.pix ?? []) { total -= texBytes(p.before) + texBytes(p.after); p.before?.destroy(); p.after?.destroy() }
      if (total <= HISTORY_BUDGET + baseBytes()) break
    }
    while (history.length > 200) {
      const e = history.shift()
      at--
      for (const p of e.pix ?? []) { p.before?.destroy(); p.after?.destroy() }
    }
    gc()
    changed()
  }
  const baseBytes = () => {
    let n = 0
    const refs = refsOf(doc)
    for (const id of refs) n += texBytes(res.get(id)?.tex)
    return n
  }

  function restorePix(list, which) {
    for (const p of list ?? []) {
      const r = res.get(p.resId)
      const src = p[which]
      if (!r || !src) continue
      const enc = device.createCommandEncoder()
      enc.copyTextureToTexture({ texture: src }, { texture: r.tex, origin: [p.rect[0], p.rect[1]] }, [p.rect[2], p.rect[3]])
      device.queue.submit([enc.finish()])
      C.genMips(r.tex, p.rect)
      r.dirty = true
    }
  }
  function undo() {
    if (at < 0) return
    const e = history[at--]
    restorePix(e.pix, 'before')
    doc = e.before
    changed()
  }
  function redo() {
    if (at >= history.length - 1) return
    const e = history[++at]
    restorePix(e.pix, 'after')
    doc = e.after
    changed()
  }
  function jump(to) {
    while (at > to && at >= 0) undo()
    while (at < to && at < history.length - 1) redo()
  }

  // snapshot a texture region (level 0) into a new mip-less texture
  function snapRegion(tex, rect) {
    const t = C.createTex(rect[2], rect[3], tex.format, false)
    const enc = device.createCommandEncoder()
    enc.copyTextureToTexture({ texture: tex, origin: [rect[0], rect[1]] }, { texture: t }, [rect[2], rect[3]])
    device.queue.submit([enc.finish()])
    return t
  }

  // ── derived textures: smart objects, text, shapes ───────────────────────
  function smartTex(n) {
    const s = n.smart
    const key = JSON.stringify([s.photoId, s.edit ?? null, host.sessionRev(s.photoId)])
    const d = derived.get(n.id)
    if (d?.key === key) return d
    if (!host.hasSession(s.photoId)) {
      if (!sources.has(s.photoId)) sources.set(s.photoId, 'wanted')
      return d ?? null // last good development stays on screen meanwhile
    }
    const dims = host.smartDims(s.photoId, s.edit)
    let tex = d?.tex
    if (!tex || tex.width !== dims[0] || tex.height !== dims[1]) {
      tex?.destroy()
      tex = C.createTex(dims[0], dims[1], 'rgba16float', true)
    }
    host.developSmart(s.photoId, s.edit, tex)
    C.genMips(tex)
    const out = { tex, key, w: dims[0], h: dims[1] }
    derived.set(n.id, out)
    return out
  }

  // per-frame resolution of node → textures for the compositor
  function resMap(d) {
    const m = new Map()
    walk(d.nodes, (n) => {
      if (n.visible === false && n.kind !== 'group') return
      let tex = null
      if (n.kind === 'pixel') tex = texOf(n.pix)
      else if (n.kind === 'smart') tex = smartTex(n)?.tex ?? null
      else if (n.kind === 'text' || n.kind === 'shape') tex = plugins.find((p) => p.vectorTex)?.vectorTex(n)?.tex ?? null
      const live = plugins.map((p) => p.liveTex?.(n)).find(Boolean)
      m.set(n.id, {
        tex: live ?? tex,
        mask: n.mask?.tex ? (plugins.map((p) => p.liveMask?.(n)).find(Boolean) ?? texOf(n.mask.tex)) : null,
        disp: n.disp ? texOf(n.disp) : null,
        corners: isDrawable(n) ? cornersFor(n) : null,
      })
    })
    return m
  }

  // ── view and frames ──────────────────────────────────────────────────────
  const targetSize = () => [Math.max(1, Math.round(view.cssW * view.dpr)), Math.max(1, Math.round(view.cssH * view.dpr))]
  const viewXf = () => [view.zoom * view.dpr, view.zoom * view.dpr, view.offX * view.dpr, view.offY * view.dpr]

  let pending = false
  const raf = self.requestAnimationFrame?.bind(self) ?? ((f) => setTimeout(f, 8))
  function requestFrame() {
    if (pending) return
    pending = true
    raf(() => { pending = false; try { frame() } catch (err) { console.error('[compose frame]', err) } })
  }

  // signature of the first k top-level nodes (below-cache key)
  const ids = new WeakMap()
  let idSeq = 0
  const sigOf = (n) => { let v = ids.get(n); if (!v) { v = ++idSeq; ids.set(n, v) } return v }
  const prefixSig = (k) => {
    const [W, H] = targetSize()
    return `${W}x${H}/${viewXf().join(',')}/${doc.depth}/` + doc.nodes.slice(0, k).map(sigOf).join(',') +
      '/' + plugins.map((p) => p.sigBelow?.(k) ?? '').join('')
  }

  function frame() {
    if (!gctx) return
    const t0 = performance.now()
    const [W, H] = targetSize()
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H }
    if (!doc) {
      C.resetArena()
      if (!acc || acc.width !== W || acc.height !== H) { acc?.destroy(); acc = C.createTex(W, H, 'rgba16float', false) }
      const enc = device.createCommandEncoder()
      enc.beginRenderPass({ colorAttachments: [{ view: C.level0(acc), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] }).end()
      device.queue.submit([enc.finish()])
      C.present(gctx, acc, { docRect: [0, 0, 0, 0], surround: view.surround })
      return
    }
    if (!acc || acc.width !== W || acc.height !== H || acc.format !== accFmt()) {
      acc?.destroy()
      acc = C.createTex(W, H, accFmt(), false)
      C.trimPool(W, H)
    }
    for (const p of plugins) p.beforeFrame?.()
    const k = interacting ? topIndexOf(doc.nodes, interacting) : -1
    C.composite(doc, resMap(doc), compositeHost, acc, {
      W, H, view: viewXf(), cacheAt: k, sigs: prefixSig,
    })
    const [sx, sy, ox, oy] = viewXf()
    C.present(gctx, acc, {
      docRect: [ox, oy, ox + doc.width * sx, oy + doc.height * sy],
      surround: view.surround,
      checker: 8 * view.dpr,
      linear: doc.depth === 32,
      dither: doc.depth !== 8,
    })
    frameStats = { ms: performance.now() - t0, frames: frameStats.frames + 1 }
    if (sources.size) requestSources()
  }

  const compositeHost = {
    developAdjust: (Ut, modules, ctx) => host.developAdjust(Ut, modules, ctx),
    styles: (ctx, node, L, rect) => plugins.find((p) => p.styles)?.styles(ctx, node, L, rect),
  }

  function requestSources() {
    const want = [...sources].filter(([, v]) => v === 'wanted').map(([k]) => k)
    if (!want.length) return
    for (const k of want) sources.set(k, 'requested')
    changed()
  }

  // ── change notification ──────────────────────────────────────────────────
  let changeQueued = false
  function changed() {
    dirty = true
    requestFrame()
    scheduleSave()
    if (changeQueued) return
    changeQueued = true
    queueMicrotask(() => {
      changeQueued = false
      post({
        type: CO.CHANGED,
        doc,
        history: { labels: history.map((e) => e.label), at },
        selection: plugins.map((p) => p.selectionInfo?.(doc)).find((x) => x !== undefined) ?? null,
        stats: { vram: vramBytes(), layers: doc ? countLayers(doc.nodes) : 0, frameMs: frameStats.ms },
        needSources: [...sources].filter(([, v]) => v === 'requested').map(([k]) => k),
      })
      thumbsSoon()
    })
  }

  // ── layer thumbnails (Layers panel) ──────────────────────────────────────
  let thumbTimer = null
  const thumbKeys = new Map() // nodeId → key last sent
  function thumbsSoon() {
    if (thumbTimer) return
    thumbTimer = setTimeout(() => { thumbTimer = null; sendThumbs().catch((e) => console.warn('[thumbs]', e)) }, 250)
  }
  const THUMB = 48
  async function sendThumbs() {
    if (!doc) return
    const out = []
    const transfer = []
    const ts = Math.min(THUMB / doc.width, THUMB / doc.height)
    const W = Math.max(1, Math.round(doc.width * ts))
    const H = Math.max(1, Math.round(doc.height * ts))
    const rm = resMap(doc)
    const target = C.createTex(W, H, 'rgba16float', false)
    const thumbCanvas = new OffscreenCanvas(W, H)
    const tctx = thumbCanvas.getContext('webgpu')
    tctx.configure({ device, format: gpu.format, alphaMode: 'premultiplied' })
    for (const n of allNodes(doc.nodes)) {
      const key = `${sigOf(n)}/${W}`
      if (thumbKeys.get(n.id) === key) continue
      thumbKeys.set(n.id, key)
      if (n.kind === 'adjust' || n.kind === 'group') {
        if (!n.mask?.tex) continue
      }
      // the node alone (content), and its mask, as separate thumbnails
      const one = { ...doc, nodes: [{ ...n, visible: true, opacity: 1, fillOpacity: 1, blend: 'normal', clip: false, blendIf: null, mask: null, styles: null }] }
      if (n.kind !== 'adjust' && n.kind !== 'group') {
        C.composite(one, rm, compositeHost, target, { W, H, view: [ts, ts, 0, 0] })
        C.present(tctx, target, { docRect: [0, 0, W, H], surround: [0, 0, 0], checker: 4, linear: doc.depth === 32, dither: false })
        const bm = thumbCanvas.transferToImageBitmap()
        out.push({ id: n.id, which: 'content', bitmap: bm })
        transfer.push(bm)
      }
      if (n.mask?.tex) {
        const m = { ...doc, nodes: [{ id: '__m', kind: 'fill', visible: true, opacity: 1, fillOpacity: 1, blend: 'normal', fill: { type: 'solid', color: [1, 1, 1, 1] }, mask: { ...n.mask, enabled: true } }] }
        const r2 = new Map([['__m', { mask: rm.get(n.id)?.mask }]])
        const bg = { id: '__b', kind: 'fill', visible: true, opacity: 1, fillOpacity: 1, blend: 'normal', fill: { type: 'solid', color: [0, 0, 0, 1] } }
        m.nodes.unshift(bg)
        r2.set('__b', {})
        C.composite(m, r2, compositeHost, target, { W, H, view: [ts, ts, 0, 0] })
        C.present(tctx, target, { docRect: [0, 0, W, H], surround: [0, 0, 0], checker: 4, dither: false })
        const bm = thumbCanvas.transferToImageBitmap()
        out.push({ id: n.id, which: 'mask', bitmap: bm })
        transfer.push(bm)
      }
    }
    tctx.unconfigure()
    target.destroy()
    if (out.length) post({ type: CO.THUMBS, thumbs: out }, transfer)
  }

  // ── documents ────────────────────────────────────────────────────────────
  function closeDoc() {
    for (const r of res.values()) r.tex.destroy()
    res.clear()
    for (const d of derived.values()) d.tex?.destroy()
    derived.clear()
    for (const e of history) for (const p of e.pix ?? []) { p.before?.destroy(); p.after?.destroy() }
    history = []
    at = -1
    for (const p of plugins) p.reset?.()
    thumbKeys.clear()
    sources.clear()
    doc = null
    C.dropBelow()
    host.releaseSessions?.()
  }

  function startDoc(d, label = 'New') {
    closeDoc()
    doc = d
    history = [{ label, before: null, after: d }]
    at = 0
    changed()
  }

  // a texture's display-encoded pixels → linear, in place (32-bit documents
  // keep linear light; images and colours arrive display-encoded)
  function linearizeRes(id) {
    const t = texOf(id)
    if (!t || doc?.depth !== 32) return
    const tmp = C.createTex(t.width, t.height, t.format, false)
    C.run('util', 'fs_lin_premul', tmp, [null, C.level0(t)])
    const enc = device.createCommandEncoder()
    enc.copyTextureToTexture({ texture: tmp }, { texture: t }, [t.width, t.height])
    device.queue.submit([enc.finish()])
    tmp.destroy()
    C.genMips(t)
  }
  const linColor = (c) => (doc?.depth === 32 ? [...c.slice(0, 3).map(srgbToLin), c[3] ?? 1] : c)

  function solidLayer(w, h, color, name) {
    color = linColor(color)
    const id = newRes(w, h)
    const tex = texOf(id)
    const enc = device.createCommandEncoder()
    enc.beginRenderPass({ colorAttachments: [{ view: C.level0(tex), loadOp: 'clear', storeOp: 'store', clearValue: color.map((c, i) => (i < 3 ? c * color[3] : c)) }] }).end()
    device.queue.submit([enc.finish()])
    C.genMips(tex)
    return newPixel({ x: 0, y: 0, w, h }, { name, pix: id })
  }

  function bitmapLayer(bitmap, name, x = 0, y = 0) {
    const id = newRes(bitmap.width, bitmap.height)
    uploadBitmap(device, texOf(id), bitmap)
    C.genMips(texOf(id))
    linearizeRes(id)
    return newPixel({ x, y, w: bitmap.width, h: bitmap.height }, { name, pix: id })
  }

  // ── operations ───────────────────────────────────────────────────────────
  // each takes (args) and commits one history entry; names are the protocol's
  const active = () => (doc?.activeId ? findNode(doc.nodes, doc.activeId)?.node : null)
  const setActive = (d, id) => ({ ...d, activeId: id })

  const OPS = {
    select({ nodeId }) { // not undoable
      if (!doc) return
      doc = setActive(doc, nodeId)
      changed()
    },
    props({ nodeId, patch, label = 'Properties' }) {
      commit(label, patchNode(doc, nodeId, patch))
    },
    addLayer({ kind = 'pixel', above, name }) {
      let n
      if (kind === 'pixel') {
        const id = newRes(doc.width, doc.height)
        n = newPixel({ x: 0, y: 0, w: doc.width, h: doc.height }, { name: name ?? `Layer ${countLayers(doc.nodes) + 1}`, pix: id })
      } else if (kind === 'group') n = newGroup([], { name: name ?? 'Group' })
      if (!n) return
      commit(`New ${kind === 'group' ? 'Group' : 'Layer'}`, setActive(insertAbove(doc, above ?? doc.activeId, [n]), n.id))
    },
    addAdjust({ type, above, params, clip }) {
      const n = newAdjust(type, clip ? { clip: true } : {})
      if (params) n.adjust = { ...n.adjust, ...params }
      commit(`New ${n.name}`, setActive(insertAbove(doc, above ?? doc.activeId, [n]), n.id))
    },
    addFill({ fill, above }) {
      const n = newFill(fill)
      commit(`New ${n.name}`, setActive(insertAbove(doc, above ?? doc.activeId, [n]), n.id))
    },
    addNodes({ nodes, above, label = 'Add' }) {
      commit(label, setActive(insertAbove(doc, above ?? doc.activeId, nodes), nodes[nodes.length - 1].id))
    },
    delete({ nodeId }) {
      const id = nodeId ?? doc.activeId
      if (!id) return
      const hit = findNode(doc.nodes, id)
      let d = removeNode(doc, id)
      const sib = hit?.list[hit.index - 1] ?? hit?.list[hit.index + 1] ?? hit?.parent ?? null
      commit('Delete Layer', setActive(d, sib?.id ?? null))
    },
    duplicate({ nodeId }) {
      const hit = findNode(doc.nodes, nodeId ?? doc.activeId)
      if (!hit) return
      const copy = cloneNode(hit.node, true)
      commit('Duplicate Layer', setActive(insertAbove(doc, hit.node.id, [copy]), copy.id))
    },
    // move a node to (parentId | null = root, index in that list, bottom→top)
    move({ nodeId, parentId = null, index }) {
      const hit = findNode(doc.nodes, nodeId)
      if (!hit) return
      if (parentId && (parentId === nodeId || findNode(hit.node.children ?? [], parentId))) return // into itself
      const node = hit.node
      let d = removeNode(doc, nodeId)
      const sameList = (hit.parent?.id ?? null) === parentId
      const idx = sameList && index > hit.index ? index - 1 : index
      if (!parentId) {
        const list = [...d.nodes]
        list.splice(Math.max(0, Math.min(list.length, idx)), 0, node)
        d = { ...d, nodes: list, rev: d.rev + 1 }
      } else {
        d = patchNode(d, parentId, (g) => {
          const kids = [...(g.children ?? [])]
          kids.splice(Math.max(0, Math.min(kids.length, idx)), 0, node)
          return { children: kids }
        })
      }
      commit('Move Layer', d)
    },
    group({ nodeIds }) {
      const ids2 = nodeIds?.length ? nodeIds : [doc.activeId]
      const hits = ids2.map((id) => findNode(doc.nodes, id)).filter(Boolean)
      if (!hits.length) return
      const parentId = hits[0].parent?.id ?? null
      const same = hits.filter((h) => (h.parent?.id ?? null) === parentId).sort((a, b) => a.index - b.index)
      const g = newGroup(same.map((h) => h.node), { name: `Group ${allNodes(doc.nodes).filter((n) => n.kind === 'group').length + 1}` })
      let d = doc
      const top = same[same.length - 1].node.id
      d = updateNode(d, top, () => [g])
      for (const h of same.slice(0, -1)) d = removeNode(d, h.node.id)
      commit('Group Layers', setActive(d, g.id))
    },
    ungroup({ nodeId }) {
      const hit = findNode(doc.nodes, nodeId ?? doc.activeId)
      if (!hit || hit.node.kind !== 'group') return
      const kids = hit.node.children ?? []
      commit('Ungroup', setActive(updateNode(doc, hit.node.id, () => kids), kids[kids.length - 1]?.id ?? null))
    },
    addMask({ nodeId, reveal = true, fromSelection = false }) {
      const id = nodeId ?? doc.activeId
      const hit = findNode(doc.nodes, id)
      if (!hit || hit.node.mask) return
      const mid = newRes(doc.width, doc.height, mfmt())
      const t = texOf(mid)
      const enc = device.createCommandEncoder()
      const v = reveal ? 1 : 0
      enc.beginRenderPass({ colorAttachments: [{ view: C.level0(t), loadOp: 'clear', storeOp: 'store', clearValue: [v, v, v, v] }] }).end()
      device.queue.submit([enc.finish()])
      if (fromSelection && doc.selection?.tex) plugins.find((p) => p.selectionToMask)?.selectionToMask(t, !reveal)
      C.genMips(t)
      commit(fromSelection ? 'Mask from Selection' : 'Add Mask', patchNode(doc, id, { mask: { tex: mid, enabled: true, density: 1, invert: false } }))
    },
    deleteMask({ nodeId, apply = false }) {
      const id = nodeId ?? doc.activeId
      const hit = findNode(doc.nodes, id)
      if (!hit?.node.mask) return
      if (apply && hit.node.kind === 'pixel') {
        const nid = bakeNode(hit.node, { applyMask: true })
        commit('Apply Mask', patchNode(doc, id, { pix: nid, mask: null }))
        return
      }
      commit('Delete Mask', patchNode(doc, id, { mask: null }))
    },
    // merge the active node into the one below (both become one pixel layer)
    mergeDown({ nodeId }) {
      const hit = findNode(doc.nodes, nodeId ?? doc.activeId)
      if (!hit || hit.index === 0) return
      const below = hit.list[hit.index - 1]
      const merged = flattenNodes([below, hit.node], `${below.name}`)
      let d = removeNode(doc, hit.node.id)
      d = updateNode(d, below.id, () => [merged])
      commit('Merge Down', setActive(d, merged.id))
    },
    mergeVisible() {
      const merged = flattenNodes(doc.nodes.filter((n) => n.visible !== false), 'Merged')
      commit('Merge Visible', setActive({ ...doc, nodes: [...doc.nodes.filter((n) => n.visible === false), merged], rev: doc.rev + 1 }, merged.id))
    },
    stampVisible() { // ⌘⌥⇧E: a new layer of the composite, everything kept
      const merged = flattenNodes(doc.nodes, 'Stamp')
      commit('Stamp Visible', setActive(insertAbove(doc, doc.activeId, [merged]), merged.id))
    },
    flatten() {
      const merged = flattenNodes(doc.nodes, 'Background')
      commit('Flatten Image', setActive({ ...doc, nodes: [merged], rev: doc.rev + 1 }, merged.id))
    },
    rasterize({ nodeId }) {
      const hit = findNode(doc.nodes, nodeId ?? doc.activeId)
      if (!hit || hit.node.kind === 'pixel' && !hit.node.xf && !hit.node.disp) return
      const n = hit.node
      const pid = bakeNode(n, { applyMask: false })
      const px = newPixel({ x: 0, y: 0, w: doc.width, h: doc.height }, {
        id: n.id, name: n.name, pix: pid, opacity: n.opacity, fillOpacity: n.fillOpacity, blend: n.blend,
        clip: n.clip, blendIf: n.blendIf, mask: n.mask, styles: n.styles, visible: n.visible,
      })
      commit('Rasterize Layer', updateNode(doc, n.id, () => [px]))
    },
    convertToSmart({ nodeId }) {
      // a group of layers as one node, collapsed: here the closest honest
      // equivalent is grouping; RAW smart objects come from Develop
      OPS.group({ nodeIds: [nodeId ?? doc.activeId] })
    },
    canvasSize({ width, height, anchor = [0.5, 0.5] }) {
      const dx = Math.round((width - doc.width) * anchor[0])
      const dy = Math.round((height - doc.height) * anchor[1])
      const shift = (n) => {
        const out = { ...n, rev: (n.rev ?? 0) + 1 }
        if (n.bounds) out.bounds = { ...n.bounds, x: n.bounds.x + dx, y: n.bounds.y + dy }
        if (n.xf) out.xf = shiftXf(n.xf, dx, dy)
        if (n.kind === 'group') out.children = n.children.map(shift)
        if (n.fill?.line) out.fill = { ...n.fill, line: [n.fill.line[0] + dx, n.fill.line[1] + dy, n.fill.line[2] + dx, n.fill.line[3] + dy] }
        if (n.mask?.tex) out.mask = { ...n.mask, tex: resizeMask(n.mask.tex, width, height, dx, dy) }
        return out
      }
      commit('Canvas Size', { ...doc, width, height, nodes: doc.nodes.map(shift), rev: doc.rev + 1 })
    },
    rename({ nodeId, name }) { commit('Rename Layer', patchNode(doc, nodeId, { name })) },
    docProps({ patch, label = 'Document' }) { commit(label, { ...doc, ...patch, rev: doc.rev + 1 }) },
  }
  // crop = canvas size with an explicit offset
  OPS.crop = ({ x, y, w, h }) => {
    const W = Math.max(1, Math.round(w)), H = Math.max(1, Math.round(h))
    const dx = -Math.round(x), dy = -Math.round(y)
    const shift = (n) => {
      const out = { ...n, rev: (n.rev ?? 0) + 1 }
      if (n.bounds) out.bounds = { ...n.bounds, x: n.bounds.x + dx, y: n.bounds.y + dy }
      if (n.xf) out.xf = shiftXf(n.xf, dx, dy)
      if (n.kind === 'group') out.children = n.children.map(shift)
      if (n.fill?.line) out.fill = { ...n.fill, line: [n.fill.line[0] + dx, n.fill.line[1] + dy, n.fill.line[2] + dx, n.fill.line[3] + dy] }
      if (n.mask?.tex) out.mask = { ...n.mask, tex: resizeMask(n.mask.tex, W, H, dx, dy) }
      return out
    }
    commit('Crop', { ...doc, width: W, height: H, nodes: doc.nodes.map(shift), rev: doc.rev + 1 })
  }

  function shiftXf(xf, dx, dy) {
    if (xf.kind === 'affine') { const m = [...xf.m]; m[4] += dx; m[5] += dy; return { ...xf, m } }
    if (xf.kind === 'quad' || xf.kind === 'mesh') return { ...xf, pts: xf.pts.map(([x, y]) => [x + dx, y + dy]) }
    return xf
  }
  function resizeMask(id, W, H, dx, dy) {
    const src = texOf(id)
    if (!src) return id
    const nid = newRes(W, H, src.format)
    const t = texOf(nid)
    const enc = device.createCommandEncoder()
    enc.beginRenderPass({ colorAttachments: [{ view: C.level0(t), loadOp: 'clear', storeOp: 'store', clearValue: [1, 1, 1, 1] }] }).end()
    const sx = Math.max(0, -dx), sy = Math.max(0, -dy)
    const tx = Math.max(0, dx), ty = Math.max(0, dy)
    const cw = Math.min(src.width - sx, W - tx), ch = Math.min(src.height - sy, H - ty)
    if (cw > 0 && ch > 0) enc.copyTextureToTexture({ texture: src, origin: [sx, sy] }, { texture: t, origin: [tx, ty] }, [cw, ch])
    device.queue.submit([enc.finish()])
    C.genMips(t)
    return nid
  }

  // deep copy of a node with fresh ids and copied textures
  function cloneNode(n, rename = false) {
    const out = { ...n, id: newId(), rev: 1, name: rename ? `${n.name} copy` : n.name }
    if (n.pix) out.pix = copyRes(n.pix)
    if (n.mask?.tex) out.mask = { ...n.mask, tex: copyRes(n.mask.tex) }
    if (n.disp) out.disp = copyRes(n.disp)
    if (n.kind === 'group') out.children = n.children.map((c) => cloneNode(c))
    return out
  }
  function copyRes(id) {
    const src = texOf(id)
    if (!src) return id
    const nid = newRes(src.width, src.height, src.format, src.mipLevelCount > 1)
    const enc = device.createCommandEncoder()
    for (let i = 0; i < src.mipLevelCount; i++) {
      enc.copyTextureToTexture({ texture: src, mipLevel: i }, { texture: texOf(nid), mipLevel: i },
        [Math.max(1, src.width >> i), Math.max(1, src.height >> i)])
    }
    device.queue.submit([enc.finish()])
    return nid
  }

  // render nodes (as a little document) at full resolution into a new
  // document-sized pixel resource
  function renderToRes(nodes) {
    const tmpDoc = { ...doc, nodes }
    const acc2 = C.createTex(doc.width, doc.height, accFmt(), false)
    C.composite(tmpDoc, resMap(tmpDoc), compositeHost, acc2, { W: doc.width, H: doc.height, view: [1, 1, 0, 0] })
    const id = newRes(doc.width, doc.height)
    const t = texOf(id)
    if (t.format === acc2.format) {
      const enc = device.createCommandEncoder()
      enc.copyTextureToTexture({ texture: acc2 }, { texture: t }, [doc.width, doc.height])
      device.queue.submit([enc.finish()])
    } else C.convert(acc2, t)
    acc2.destroy()
    C.genMips(t)
    return id
  }
  function flattenNodes(nodes, name) {
    const id = renderToRes(nodes)
    return newPixel({ x: 0, y: 0, w: doc.width, h: doc.height }, { name, pix: id })
  }
  // a node's own pixels through its transform, liquify and (optionally) mask
  function bakeNode(n, { applyMask }) {
    const solo = { ...n, opacity: 1, fillOpacity: 1, blend: 'normal', clip: false, blendIf: null, styles: null, visible: true }
    if (!applyMask) solo.mask = null
    return renderToRes([solo])
  }

  // ── persistence (OPFS composedocs/<id>/) ─────────────────────────────────
  function scheduleSave() {
    if (!doc) return
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => save().catch((e) => console.warn('[compose save]', e)), SAVE_DELAY)
  }
  let saving = null
  async function save() {
    if (!doc || !dirty) return
    if (saving) { await saving; return save() }
    saving = (async () => {
      dirty = false
      const d = doc
      const dir = `composedocs/${d.id}`
      const refs = [...refsOf(d)]
      const files = {}
      for (const id of refs) {
        const r = res.get(id)
        if (!r) continue
        files[id] = { w: r.tex.width, h: r.tex.height, format: r.tex.format, mips: r.tex.mipLevelCount > 1 }
        if (!r.dirty && r.saved) continue
        const raw = await readRaw(device, r.tex)
        await writeFileAtomic(`${dir}/${id}.bin`, await compress(raw))
        r.dirty = false
        r.saved = true
      }
      for (const p of plugins) await p.save?.(dir, d)
      const meta = { schema: 1, doc: d, files, updatedAt: Date.now() }
      await writeFileAtomic(`${dir}/doc.json`, new TextEncoder().encode(JSON.stringify(meta)))
      await saveThumb(dir)
    })()
    try { await saving } finally { saving = null }
  }
  async function saveThumb(dir) {
    const s = Math.min(256 / doc.width, 256 / doc.height, 1)
    const W = Math.max(1, Math.round(doc.width * s)), H = Math.max(1, Math.round(doc.height * s))
    const t = C.createTex(W, H, 'rgba16float', false)
    C.composite(doc, resMap(doc), compositeHost, t, { W, H, view: [s, s, 0, 0] })
    const cv = new OffscreenCanvas(W, H)
    const c2 = cv.getContext('webgpu')
    c2.configure({ device, format: gpu.format, alphaMode: 'premultiplied' })
    C.present(c2, t, { docRect: [0, 0, W, H], surround: [0, 0, 0], checker: 6, linear: doc.depth === 32, dither: false })
    const bm = cv.transferToImageBitmap()
    c2.unconfigure()
    t.destroy()
    const out = new OffscreenCanvas(W, H)
    out.getContext('2d').drawImage(bm, 0, 0)
    bm.close()
    const blob = await out.convertToBlob({ type: 'image/jpeg', quality: 0.85 })
    await writeFileAtomic(`${dir}/thumb.jpg`, new Uint8Array(await blob.arrayBuffer()))
  }

  async function load(docId) {
    const dir = `composedocs/${docId}`
    const meta = JSON.parse(new TextDecoder().decode(await readFile(`${dir}/doc.json`)))
    closeDoc()
    for (const [id, f] of Object.entries(meta.files ?? {})) {
      const bytes = await decompress(new Uint8Array(await readFile(`${dir}/${id}.bin`)))
      const tex = C.createTex(f.w, f.h, f.format, f.mips)
      writeRaw(device, tex, bytes, f.w, f.h)
      if (f.mips) C.genMips(tex)
      res.set(id, { tex, w: f.w, h: f.h, dirty: false, saved: true })
    }
    doc = meta.doc
    for (const p of plugins) await p.load?.(dir, doc)
    history = [{ label: 'Open', before: null, after: doc }]
    at = 0
    dirty = false
    changed()
    dirty = false
  }

  let migrated = false
  async function list() {
    if (!migrated) {
      migrated = true
      const { migrateCanvasDocs } = await import('./legacy.js')
      // runs from the start screen, where no document is open
      const n = await migrateCanvasDocs(E, (d) => { closeDoc(); doc = d }, async () => { dirty = true; await save() })
      if (n) { closeDoc(); changed() }
    }
    const out = []
    let root
    try { root = await getDir('composedocs', true) } catch { return out }
    for await (const [name, h] of root.entries()) {
      if (h.kind !== 'directory') continue
      try {
        const meta = JSON.parse(new TextDecoder().decode(await readFile(`composedocs/${name}/doc.json`)))
        let thumb = null
        try { thumb = await readFile(`composedocs/${name}/thumb.jpg`) } catch { /* none yet */ }
        out.push({ id: name, name: meta.doc.name, width: meta.doc.width, height: meta.doc.height, depth: meta.doc.depth,
          layers: countLayers(meta.doc.nodes), updatedAt: meta.updatedAt, thumb })
      } catch { /* half-written or foreign: skip */ }
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt)
    return out
  }

  // ── export (flattened) ───────────────────────────────────────────────────
  // full-resolution composite → straight-alpha float RGBA (row 0 = top)
  async function compositeFloats(d = doc, rect = null, { linear = false } = {}) {
    const W = d.width, H = d.height
    const t = C.createTex(W, H, accFmt(), false)
    C.composite(d, resMap(d), compositeHost, t, { W, H, view: [1, 1, 0, 0] })
    const px = await readFloats(device, t, rect)
    t.destroy()
    for (let i = 0; i < px.length; i += 4) {
      const a = px[i + 3]
      if (a > 1e-6 && a < 1) { px[i] /= a; px[i + 1] /= a; px[i + 2] /= a }
    }
    if (d.depth === 32 && !linear) for (let i = 0; i < px.length; i += 4) for (let c = 0; c < 3; c++) px[i + c] = linToSrgb(px[i + c])
    return px
  }

  async function exportFlat({ format = 'jpeg', quality = 0.92 }) {
    const px = await compositeFloats()
    const W = doc.width, H = doc.height
    if (format === 'tiff') {
      const { encodeTiff16Deflate } = await import('../io/tiff.js')
      const alpha = hasAlpha(px)
      const ch = alpha ? 4 : 3
      const out = new Uint16Array(W * H * ch)
      for (let i = 0, o = 0; i < px.length; i += 4) {
        for (let c = 0; c < ch; c++) out[o++] = Math.round(Math.min(1, Math.max(0, px[i + c])) * 65535)
      }
      const bytes = await encodeTiff16Deflate({ width: W, height: H, data: out, channels: ch })
      return new Blob([bytes], { type: 'image/tiff' })
    }
    const img = new ImageData(W, H)
    const jpeg = format === 'jpeg'
    for (let i = 0; i < px.length; i += 4) {
      const a = jpeg ? 1 : px[i + 3]
      const m = jpeg ? px[i + 3] : 1 // JPEG: matte on white, as Photoshop does
      for (let c = 0; c < 3; c++) {
        const v = jpeg ? px[i + c] * m + (1 - m) : px[i + c]
        img.data[i + c] = Math.round(Math.min(1, Math.max(0, v)) * 255)
      }
      img.data[i + 3] = Math.round(Math.min(1, Math.max(0, a)) * 255)
    }
    const cv = new OffscreenCanvas(W, H)
    cv.getContext('2d').putImageData(img, 0, 0)
    return cv.convertToBlob({ type: jpeg ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png', quality })
  }

  // ── messages ─────────────────────────────────────────────────────────────
  async function handle(data) {
    const reply = (payload = {}, transfer) => post({ re: data.id, ok: true, ...payload }, transfer)
    switch (data.type) {
      case CO.INIT: {
        canvas = data.canvas
        gctx = canvas.getContext('webgpu')
        gctx.configure({ device, format: gpu.format, alphaMode: 'opaque' })
        reply({ features: { blend32: C.canBlend32, filter32: C.canFilter32, maxTex: device.limits.maxTextureDimension2D } })
        requestFrame()
        return
      }
      case CO.VIEW: {
        view = { cssW: data.w, cssH: data.h, dpr: data.dpr ?? 1, zoom: data.zoom, offX: data.offX, offY: data.offY, surround: data.surround ?? view.surround }
        requestFrame()
        return
      }
      case CO.NEW: {
        const d = newDoc(data.width, data.height, { depth: data.depth ?? 16, name: data.name ?? 'Untitled' })
        closeDoc()
        doc = d
        const bg = data.background ?? 'white'
        if (bg !== 'transparent') {
          const col = bg === 'white' ? [1, 1, 1, 1] : bg === 'black' ? [0, 0, 0, 1] : bg
          const n = solidLayer(d.width, d.height, col, 'Background')
          doc = { ...doc, nodes: [n], activeId: n.id }
        } else {
          const id = newRes(d.width, d.height)
          const n = newPixel({ x: 0, y: 0, w: d.width, h: d.height }, { name: 'Layer 1', pix: id })
          doc = { ...doc, nodes: [n], activeId: n.id }
        }
        history = [{ label: 'New Document', before: null, after: doc }]
        at = 0
        changed()
        reply({ docId: doc.id })
        return
      }
      case CO.OPEN_IMAGE: {
        const bm = data.bitmap
        const d = newDoc(bm.width, bm.height, { depth: data.depth ?? 16, name: data.name ?? 'Image' })
        closeDoc()
        doc = d
        const n = bitmapLayer(bm, 'Background')
        bm.close()
        doc = { ...doc, nodes: [n], activeId: n.id }
        history = [{ label: 'Open', before: null, after: doc }]
        at = 0
        changed()
        reply({ docId: doc.id })
        return
      }
      case CO.FROM_PHOTO: {
        // Develop → Compose: the photo as a smart object, on the session
        // Develop already holds (no decode, no file)
        if (!host.hasSession(data.photoId)) host.adoptCurrent(data.photoId)
        const [w, h] = host.smartDims(data.photoId, data.editDoc)
        const d = newDoc(w, h, { depth: data.depth ?? 16, name: data.name ?? 'Photo' })
        closeDoc()
        host.retainSession(data.photoId)
        const n = newSmart({ photoId: data.photoId, name: data.name, edit: data.editDoc ?? { modules: {} } }, { x: 0, y: 0, w, h }, { name: data.name ?? 'Photo' })
        doc = { ...d, nodes: [n], activeId: n.id }
        history = [{ label: 'Edit in Compose', before: null, after: doc }]
        at = 0
        changed()
        reply({ docId: doc.id })
        return
      }
      case CO.ADD_IMAGE: {
        const bm = data.bitmap
        const x = data.x ?? Math.round((doc.width - bm.width) / 2)
        const y = data.y ?? Math.round((doc.height - bm.height) / 2)
        const n = bitmapLayer(bm, data.name ?? 'Image', x, y)
        bm.close()
        commit('Place Image', setActive(insertAbove(doc, doc.activeId, [n]), n.id))
        reply({ nodeId: n.id })
        return
      }
      case CO.ADD_SMART: {
        if (!host.hasSession(data.photoId)) {
          if (data.source) host.registerSource(data.photoId, data.source)
          else host.adoptCurrent(data.photoId)
        }
        host.retainSession(data.photoId)
        const [w, h] = host.smartDims(data.photoId, data.editDoc)
        const s = Math.min(1, doc.width / w, doc.height / h)
        const x = (doc.width - w * s) / 2, y = (doc.height - h * s) / 2
        const n = newSmart({ photoId: data.photoId, name: data.name, edit: data.editDoc ?? { modules: {} } }, { x: 0, y: 0, w, h },
          { name: data.name ?? 'Photo', xf: s === 1 && x === 0 && y === 0 ? null : { kind: 'affine', m: [s, 0, 0, s, x, y] } })
        commit('Place Smart Object', setActive(insertAbove(doc, doc.activeId, [n]), n.id))
        reply({ nodeId: n.id })
        return
      }
      case CO.SOURCE: {
        host.registerSource(data.photoId, data.source)
        sources.delete(data.photoId)
        if (doc) { for (const n of allNodes(doc.nodes)) if (n.smart?.photoId === data.photoId) derived.delete(n.id) }
        requestFrame()
        thumbKeys.clear()
        thumbsSoon()
        reply()
        return
      }
      case CO.CLOSE: {
        await save().catch(() => {})
        closeDoc()
        changed()
        reply()
        return
      }
      case CO.LIST: reply({ docs: await list() }); return
      case CO.LOAD: {
        if (doc) await save().catch(() => {})
        await load(data.docId)
        reply({ docId: doc.id })
        return
      }
      case CO.SAVE: { dirty = true; await save(); reply(); return }
      case CO.DELETE: {
        if (doc?.id === data.docId) closeDoc()
        await deleteDir(`composedocs/${data.docId}`).catch(() => {})
        reply()
        return
      }
      case CO.OP: {
        if (!doc && data.op !== 'noop') { reply({ error: 'no document' }); return }
        const fn = OPS[data.op] ?? plugins.map((p) => p.ops?.[data.op]).find(Boolean)
        if (!fn) throw new Error(`unknown op ${data.op}`)
        const r = await fn(data.args ?? {})
        reply(r ?? {})
        return
      }
      case CO.PREVIEW: {
        // live property drag: not in history; the commit (OP props) records it
        if (!doc) return
        interacting = data.nodeId
        doc = patchNode(doc, data.nodeId, data.patch)
        requestFrame()
        if (data.end) interacting = null
        return
      }
      case CO.UNDO: undo(); reply(); return
      case CO.REDO: redo(); reply(); return
      case CO.JUMP: jump(data.to); reply(); return
      case CO.EXPORT: {
        const plug = plugins.find((p) => p.exporters?.[data.format])
        const blob = plug ? await plug.exporters[data.format](data) : await exportFlat(data)
        reply({ blob })
        return
      }
      case CO.GET_DOC: reply({ doc, history: { labels: history.map((e) => e.label), at } }); return
      case CO.GET_PIXEL: {
        const x = Math.max(0, Math.min(doc.width - 1, Math.floor(data.x)))
        const y = Math.max(0, Math.min(doc.height - 1, Math.floor(data.y)))
        const px = await compositeFloats(doc, [x, y, 1, 1])
        reply({ px: Array.from(px) })
        return
      }
      case CO.READ_REGION: {
        const [x, y, w, h] = data.rect.map(Math.round)
        let px
        if (data.source === 'layer' && data.nodeId) {
          const hit = findNode(doc.nodes, data.nodeId)
          const solo = { ...hit.node, opacity: 1, fillOpacity: 1, blend: 'normal', clip: false, blendIf: null, styles: null, visible: true, mask: null }
          px = await compositeFloats({ ...doc, nodes: [solo] }, [x, y, w, h])
        } else px = await compositeFloats(doc, [x, y, w, h])
        reply({ data: px, w, h }, [px.buffer])
        return
      }
      case CO.BENCH: {
        // frames timed to GPU completion; mutate between frames:
        // none | pan | zoom | preview ({ nodeId, patches: [a, b] }) |
        // stroke ({ begin, pts per frame }) — benchmarks only
        const times = []
        const n = data.frames ?? 60
        const v0 = { ...view }
        if (data.mutate === 'stroke') await handle({ type: CO.STROKE_BEGIN, ...data.begin })
        for (let i = 0; i < n; i++) {
          if (data.mutate === 'pan') view = { ...view, offX: v0.offX + ((i % 20) - 10) * 4, offY: v0.offY + ((i % 13) - 6) * 3 }
          else if (data.mutate === 'zoom') view = { ...view, zoom: v0.zoom * (i % 2 ? 1.05 : 0.95) }
          const t0 = performance.now()
          if (data.mutate === 'preview') { interacting = data.nodeId; doc = patchNode(doc, data.nodeId, data.patches[i % 2]) }
          if (data.mutate === 'stroke') await handle({ type: CO.STROKE_PTS, pts: [[data.line[0] + data.line[2] * i, data.line[1] + data.line[3] * i, 1]] })
          frame()
          await device.queue.onSubmittedWorkDone()
          times.push(performance.now() - t0)
        }
        if (data.mutate === 'stroke') await handle({ type: CO.STROKE_END })
        interacting = null
        view = v0
        requestFrame()
        const sorted = [...times].sort((a, b) => a - b)
        reply({ median: sorted[Math.floor(n / 2)], p95: sorted[Math.floor(n * 0.95)], max: sorted[n - 1], mean: times.reduce((a, b) => a + b, 0) / n, vram: vramBytes() })
        return
      }
      case CO.STATS: reply({ vram: vramBytes(), frameMs: frameStats.ms, frames: frameStats.frames, layers: doc ? countLayers(doc.nodes) : 0, res: res.size, history: history.length }); return
      default: {
        for (const p of plugins) if (p.handles?.[data.type]) { const r = await p.handles[data.type](data); if (data.id) reply(r ?? {}); return }
        throw new Error(`compose: unknown message ${data.type}`)
      }
    }
  }

  // ── the engine object plugins see ────────────────────────────────────────
  const E = {
    C, device, gpu, host, post,
    get doc() { return doc },
    set doc(d) { doc = d },
    get view() { return view },
    get interacting() { return interacting },
    set interacting(v) { interacting = v },
    res, derived, newRes, texOf, fmt, mfmt, accFmt, commit, changed, requestFrame, patchNode, updateNode,
    insertAbove, removeNode, setActive, active, snapRegion, resMap, compositeHost, renderToRes, flattenNodes,
    bakeNode, compositeFloats, linearizeRes, linColor, viewXf, targetSize, findNode: (id) => findNode(doc.nodes, id), OPS, touch,
    selectApi: () => plugins.find((p) => p.selectionToMask),
    markDirty: (id) => { const r = res.get(id); if (r) r.dirty = true },
    // replace the open document (file import): resList [[id, texture]] or
    // null to keep the resources already made
    reset(d, resList) {
      if (resList) {
        closeDoc()
        doc = d
        for (const [id, tex] of resList) res.set(id, { tex, w: tex.width, h: tex.height, dirty: true })
      }
      doc = d
      history = [{ label: 'Open', before: null, after: d }]
      at = 0
      dirty = true
      changed()
    },
    use(plugin) { plugins.push(plugin); plugin.init?.(E) },
  }
  return { handle, E }
}

const hasAlpha = (px) => { for (let i = 3; i < px.length; i += 4) if (px[i] < 0.999) return true; return false }
const srgbToLin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
const linToSrgb = (x) => {
  const v = Math.min(1, Math.max(0, x))
  return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055
}
