import selectWgsl from './gpu/select.wgsl?raw'
import { CO } from './protocol.js'
import { readFloats, readRaw, uploadBitmap } from './gpu/io.js'
import { findNode } from './model.js'
import { marchingSquares } from './outline.js'

// Selections. The selection is a document-sized single-channel texture held
// in the document (doc.selection = { tex: resource id, bounds }), so every
// selection change is one history step and undo restores it. Shapes are
// rasterised by OffscreenCanvas 2D (antialiased), magic wand floods on the
// CPU over an 8-bit copy of the composite, colour range and refine edge run
// on the GPU. The outline for the marching ants is traced from a reduced
// copy (marching squares) and drawn by the UI in SVG.

const OUTLINE_MAX = 1024

export function selectPlugin() {
  let E
  const outlines = new Map() // resId → { path, bounds }
  let wandCache = null // { sig, data: Uint8Array RGBA, w, h }

  const run = (...a) => E.C.run('select', ...a)
  const selTex = () => (E.doc?.selection?.tex ? E.texOf(E.doc.selection.tex) : null)
  const newMaskRes = () => E.newRes(E.doc.width, E.doc.height, E.mfmt(), true)

  // commit a new selection texture (or null) as one history step
  function setSelection(resId, label) {
    const d = E.doc
    const last = d.selection ?? d.lastSelection ?? null
    if (resId) E.C.genMips(E.texOf(resId))
    const next = { ...d, selection: resId ? { tex: resId } : null, lastSelection: resId ? null : last, rev: d.rev + 1 }
    E.commit(label, next)
    if (resId) traceSoon(resId)
  }

  // rasterise shapes (document px) to a texture through a 2D canvas
  function rasterShapes(shapes, feather = 0) {
    const { width: W, height: H } = E.doc
    const cv = new OffscreenCanvas(W, H)
    const g = cv.getContext('2d')
    g.fillStyle = '#fff'
    for (const sh of shapes) {
      g.globalCompositeOperation = sh.op === 'subtract' ? 'destination-out' : 'source-over'
      const p = new Path2D()
      if (sh.kind === 'rect') {
        const x = Math.min(sh.x0, sh.x1), y = Math.min(sh.y0, sh.y1)
        p.rect(x, y, Math.abs(sh.x1 - sh.x0), Math.abs(sh.y1 - sh.y0))
      } else if (sh.kind === 'ellipse') {
        p.ellipse((sh.x0 + sh.x1) / 2, (sh.y0 + sh.y1) / 2, Math.abs(sh.x1 - sh.x0) / 2, Math.abs(sh.y1 - sh.y0) / 2, 0, 0, Math.PI * 2)
      } else if (sh.pts?.length > 2) {
        p.moveTo(sh.pts[0][0], sh.pts[0][1])
        for (let i = 1; i < sh.pts.length; i++) p.lineTo(sh.pts[i][0], sh.pts[i][1])
        p.closePath()
      }
      g.fill(p)
    }
    const t = E.C.createTex(W, H, 'rgba8unorm', false)
    uploadBitmap(E.device, t, cv)
    const out = E.C.createTex(W, H, E.mfmt(), false)
    // rgba8 → single channel
    E.C.run('util', 'fs_copy', out, [null, E.C.level0(t)])
    t.destroy()
    if (feather > 0) blurInPlace(out, feather)
    return out
  }

  function blurInPlace(tex, sigma) {
    const tmp = E.C.createTex(tex.width, tex.height, tex.format, false)
    const r = Math.min(96, Math.ceil(sigma * 3))
    run('fs_blur', tmp, [null, E.C.level0(tex)], f32(1, 0, sigma, r))
    run('fs_blur', tex, [null, E.C.level0(tmp)], f32(0, 1, sigma, r))
    tmp.destroy()
  }

  // combine a shape texture into the selection with a mode → new res id
  function combine(shapeTex, mode) {
    const id = newMaskRes()
    const cur = selTex()
    const m = { new: 0, add: 1, subtract: 2, intersect: 3 }[mode] ?? 0
    run('fs_combine', E.texOf(id), [null, E.C.level0(cur ?? E.C.dummy.r), E.C.level0(shapeTex)], f32(cur ? m : 0))
    if (!cur && (m === 2)) { // subtracting from nothing leaves nothing
      run('fs_combine', E.texOf(id), [null, E.C.level0(E.C.dummy.r), E.C.level0(E.C.dummy.r)], f32(3))
    }
    return id
  }

  // the composite at document resolution (premultiplied) as a texture
  function compositeTex(nodes = E.doc.nodes) {
    const d = { ...E.doc, nodes }
    const t = E.C.createTex(d.width, d.height, E.accFmt(), true)
    E.C.composite(d, E.resMap(d), E.compositeHost, t, { W: d.width, H: d.height, view: [1, 1, 0, 0] })
    E.C.genMips(t)
    return t
  }

  // ── outline (marching squares on a reduced copy) ─────────────────────────
  let traceTimer = null
  function traceSoon(resId) {
    clearTimeout(traceTimer)
    traceTimer = setTimeout(() => trace(resId).catch((e) => console.warn('[select outline]', e)), 0)
  }
  async function trace(resId) {
    if (outlines.has(resId)) return
    const tex = E.texOf(resId)
    if (!tex) return
    let lvl = 0
    while (Math.max(tex.width >> lvl, tex.height >> lvl) > OUTLINE_MAX && lvl < tex.mipLevelCount - 1) lvl++
    const w = Math.max(1, tex.width >> lvl), h = Math.max(1, tex.height >> lvl)
    const v = await readFloats(E.device, tex, null, lvl)
    const sx = tex.width / w, sy = tex.height / h
    const { path, bounds } = marchingSquares(v, w, h, 0.5, sx, sy)
    outlines.set(resId, { path, bounds })
    if (outlines.size > 64) outlines.delete(outlines.keys().next().value)
    E.changed()
  }

  // ── magic wand ───────────────────────────────────────────────────────────
  async function wandPixels(sampleAll) {
    const sig = `${sampleAll ? 'all' : E.doc.activeId}/${E.doc.rev}`
    if (wandCache?.sig === sig) return wandCache
    const nodes = sampleAll ? E.doc.nodes : [soloActive()].filter(Boolean)
    const t = compositeTex(nodes)
    const t8 = E.C.createTex(t.width, t.height, 'rgba8unorm', false)
    E.C.run('adjust', 'fs_unpremul', t8, [null, E.C.level0(t)])
    t.destroy()
    const data = await readRaw(E.device, t8)
    t8.destroy()
    wandCache = { sig, data, w: E.doc.width, h: E.doc.height }
    return wandCache
  }
  const soloActive = () => {
    const n = E.active()
    return n ? { ...n, opacity: 1, fillOpacity: 1, blend: 'normal', clip: false, blendIf: null, mask: null, styles: null, visible: true } : null
  }

  function wandMask({ data, w, h }, x, y, tol, contiguous) {
    const out = new Uint8Array(w * h * 4)
    x = Math.floor(x); y = Math.floor(y)
    if (x < 0 || y < 0 || x >= w || y >= h) return out
    const i0 = (y * w + x) * 4
    const r0 = data[i0], g0 = data[i0 + 1], b0 = data[i0 + 2], a0 = data[i0 + 3]
    const near = (i) => Math.abs(data[i] - r0) <= tol && Math.abs(data[i + 1] - g0) <= tol &&
      Math.abs(data[i + 2] - b0) <= tol && Math.abs(data[i + 3] - a0) <= tol
    if (!contiguous) {
      for (let p = 0, n = w * h; p < n; p++) if (near(p * 4)) { out[p * 4] = 255; out[p * 4 + 3] = 255 }
      return out
    }
    // scanline flood fill
    const seen = new Uint8Array(w * h)
    const stack = [x, y]
    while (stack.length) {
      const sy = stack.pop(), sx = stack.pop()
      let lx = sx
      while (lx >= 0 && !seen[sy * w + lx] && near((sy * w + lx) * 4)) lx--
      lx++
      let up = false, down = false
      for (let cx = lx; cx < w; cx++) {
        const p = sy * w + cx
        if (seen[p] || !near(p * 4)) break
        seen[p] = 1
        out[p * 4] = 255; out[p * 4 + 3] = 255
        if (sy > 0) {
          const q = p - w
          const ok = !seen[q] && near(q * 4)
          if (ok && !up) { stack.push(cx, sy - 1); up = true } else if (!ok) up = false
        }
        if (sy < h - 1) {
          const q = p + w
          const ok = !seen[q] && near(q * 4)
          if (ok && !down) { stack.push(cx, sy + 1); down = true } else if (!ok) down = false
        }
      }
    }
    return out
  }

  function uploadMask8(rgba, w, h) {
    const t8 = E.C.createTex(w, h, 'rgba8unorm', false)
    E.device.queue.writeTexture({ texture: t8 }, rgba, { bytesPerRow: w * 4 }, [w, h])
    const out = E.C.createTex(E.doc.width, E.doc.height, E.mfmt(), false)
    if (w === E.doc.width && h === E.doc.height) E.C.run('util', 'fs_copy', out, [null, E.C.level0(t8)])
    else E.C.run('util', 'fs_down', out, [E.C.sampler, E.C.level0(t8)]) // bilinear resample
    t8.destroy()
    return out
  }

  // ── refine edge: fast guided filter on the image ────────────────────────
  function refineTex(maskTex, { radius = 12, eps = 0.002, contrast = 0.15, shift = 0, sampleAll = true } = {}) {
    const W = E.doc.width, H = E.doc.height
    const img = compositeTex(sampleAll ? E.doc.nodes : [soloActive()].filter(Boolean))
    const s = Math.max(1, Math.min(8, Math.floor(radius / 3)))
    const lw = Math.max(1, Math.round(W / s)), lh = Math.max(1, Math.round(H / s))
    const lr = Math.max(1, Math.round(radius / s))
    const lod = Math.log2(s)
    const mom = E.C.createTex(lw, lh, 'rgba32float', false)
    const tmp = E.C.createTex(lw, lh, 'rgba32float', false)
    run('fs_gf_prep', mom, [E.C.sampler, img.createView(), maskTex.createView()], f32(lw, lh, lod, maskTex.mipLevelCount > 1 ? lod : 0))
    run('fs_box4', tmp, [null, E.C.level0(mom)], f32(1, 0, lr))
    run('fs_box4', mom, [null, E.C.level0(tmp)], f32(0, 1, lr))
    const ab = E.C.createTex(lw, lh, 'rgba32float', false)
    run('fs_gf_ab', ab, [null, E.C.level0(mom)], f32(eps))
    run('fs_box4', tmp, [null, E.C.level0(ab)], f32(1, 0, lr))
    const ab16 = E.C.createTex(lw, lh, 'rgba16float', false)
    run('fs_box4', ab16, [null, E.C.level0(tmp)], f32(0, 1, lr))
    // the band where the coarse mask is uncertain: widened by a blur
    const band = E.C.createTex(W, H, 'r16float', false)
    E.C.run('util', 'fs_copy', band, [null, E.C.level0(maskTex)])
    blurInPlace(band, Math.max(1, radius / 2))
    const out = E.C.createTex(W, H, E.mfmt(), false)
    const u = new Float32Array(48)
    u.set([0, 0, 0, 0, 0.02, 0.98, contrast, 0])
    E.C.run('select', 'fs_gf_apply', out, [E.C.sampler, E.C.level0(img), ab16.createView(), null, E.C.level0(band)], u)
    if (shift) {
      const o2 = E.C.createTex(W, H, E.mfmt(), false)
      run('fs_contrast', o2, [null, E.C.level0(out)], f32(0.5, 0.02, -shift / 200))
      out.destroy()
      ;[mom, tmp, ab, ab16, band, img].forEach((t) => t.destroy())
      return o2
    }
    ;[mom, tmp, ab, ab16, band, img].forEach((t) => t.destroy())
    return out
  }

  // ── expand / contract via jump flood ─────────────────────────────────────
  function grow(maskTex, radius) {
    const W = maskTex.width, H = maskTex.height
    const a = E.C.createTex(W, H, 'rgba32float', false)
    const b = E.C.createTex(W, H, 'rgba32float', false)
    const expand = radius > 0
    run('fs_jfa_seed', a, [null, E.C.level0(maskTex)], f32(0.5, expand ? 0 : 1))
    let src = a, dst = b
    let step = 1 << Math.ceil(Math.log2(Math.max(1, Math.min(Math.abs(radius) * 2, Math.max(W, H)))))
    for (; step >= 1; step >>= 1) {
      run('fs_jfa_step', dst, [null, E.C.level0(src)], f32(step));
      [src, dst] = [dst, src]
    }
    const out = E.C.createTex(W, H, maskTex.format, false)
    run('fs_jfa_apply', out, [null, E.C.level0(src), E.C.level0(maskTex)], f32(Math.abs(radius), expand ? 1 : 0))
    a.destroy(); b.destroy()
    return out
  }

  // copy a temporary texture into a new selection resource
  function adopt(tex) {
    const id = newMaskRes()
    E.C.run('util', 'fs_copy', E.texOf(id), [null, E.C.level0(tex)])
    tex.destroy()
    return id
  }

  const handles = {
    async [CO.SELECT](data) {
      if (!E.doc) return {}
      switch (data.op) {
        case 'shape': {
          const t = rasterShapes(data.shapes, data.feather ?? 0)
          const id = combine(t, data.mode ?? 'new')
          t.destroy()
          setSelection(id, data.label ?? 'Select')
          return {}
        }
        case 'wand': {
          const px = await wandPixels(data.sampleAll !== false)
          const m = wandMask(px, data.x, data.y, data.tolerance ?? 32, data.contiguous !== false)
          const t = uploadMask8(m, px.w, px.h)
          const id = combine(t, data.mode ?? 'new')
          t.destroy()
          setSelection(id, 'Magic Wand')
          return {}
        }
        case 'colorRange': {
          const img = compositeTex(data.sampleAll === false ? [soloActive()].filter(Boolean) : E.doc.nodes)
          const t = E.C.createTex(E.doc.width, E.doc.height, E.mfmt(), false)
          const u = new Float32Array(48)
          u.set([data.fuzziness ?? 40, Math.min(8, data.colors.length), E.doc.depth === 32 ? 1 : 0, data.invert ? 1 : 0])
          data.colors.slice(0, 8).forEach((c, i) => u.set([...rgbToLab(c), 1], 16 + i * 4))
          run('fs_colorrange', t, [null, E.C.level0(img)], u)
          img.destroy()
          const id = combine(t, data.mode ?? 'new')
          t.destroy()
          setSelection(id, 'Color Range')
          return {}
        }
        case 'ai': {
          // a model's mask (main thread ran it on a reduced composite)
          const rgba = new Uint8Array(data.w * data.h * 4)
          for (let i = 0; i < data.w * data.h; i++) { rgba[i * 4] = data.mask[i]; rgba[i * 4 + 3] = 255 }
          let t = uploadMask8(rgba, data.w, data.h)
          if (data.refine) {
            const r = refineTex(withMips(t), { radius: data.radius ?? Math.max(4, Math.round(Math.max(E.doc.width, E.doc.height) / 400)) })
            t.destroy()
            t = r
          }
          const id = combine(t, data.mode ?? 'new')
          t.destroy()
          setSelection(id, data.label ?? 'Select Subject')
          return {}
        }
        case 'refine': {
          const cur = selTex()
          if (!cur) return {}
          let t = refineTex(cur, data)
          if (data.feather) blurInPlace(t, data.feather)
          if (data.expand) { const g = grow(t, data.expand); t.destroy(); t = g }
          setSelection(adopt(t), 'Refine Edge')
          return {}
        }
        case 'modify': {
          const cur = selTex()
          if (!cur) return {}
          let t
          if (data.kind === 'feather') { t = E.C.createTex(cur.width, cur.height, cur.format, false); E.C.run('util', 'fs_copy', t, [null, E.C.level0(cur)]); blurInPlace(t, data.amount) }
          else if (data.kind === 'expand') t = grow(cur, Math.abs(data.amount))
          else if (data.kind === 'contract') t = grow(cur, -Math.abs(data.amount))
          else if (data.kind === 'smooth') {
            t = E.C.createTex(cur.width, cur.height, cur.format, false)
            const t2 = E.C.createTex(cur.width, cur.height, cur.format, false)
            E.C.run('util', 'fs_copy', t2, [null, E.C.level0(cur)])
            blurInPlace(t2, data.amount)
            run('fs_contrast', t, [null, E.C.level0(t2)], f32(0.5, 0.08, 0))
            t2.destroy()
          } else if (data.kind === 'border') {
            const a = grow(cur, Math.abs(data.amount) / 2)
            const b = grow(cur, -Math.abs(data.amount) / 2)
            t = E.C.createTex(cur.width, cur.height, cur.format, false)
            run('fs_combine', t, [null, E.C.level0(a), E.C.level0(b)], f32(2))
            a.destroy(); b.destroy()
          }
          if (t) setSelection(adopt(t), `${data.kind[0].toUpperCase()}${data.kind.slice(1)} Selection`)
          return {}
        }
        case 'readComposite': {
          // a reduced composite for the AI models (RGBA8, straight)
          const s = Math.min(1, (data.maxSide ?? 1024) / Math.max(E.doc.width, E.doc.height))
          const w = Math.max(1, Math.round(E.doc.width * s)), h = Math.max(1, Math.round(E.doc.height * s))
          const t = E.C.createTex(w, h, E.accFmt(), false)
          E.C.composite(E.doc, E.resMap(E.doc), E.compositeHost, t, { W: w, H: h, view: [s, s, 0, 0] })
          const t8 = E.C.createTex(w, h, 'rgba8unorm', false)
          E.C.run('adjust', 'fs_unpremul', t8, [null, E.C.level0(t)])
          const data8 = await readRaw(E.device, t8)
          t.destroy(); t8.destroy()
          return { rgba: data8, w, h, rev: E.doc.rev }
        }
        default: throw new Error(`select: unknown op ${data.op}`)
      }
    },
  }

  const withMips = (t) => {
    const m = E.C.createTex(t.width, t.height, t.format, true)
    const enc = E.device.createCommandEncoder()
    enc.copyTextureToTexture({ texture: t }, { texture: m }, [t.width, t.height])
    E.device.queue.submit([enc.finish()])
    E.C.genMips(m)
    t.destroy()
    return m
  }

  // fill or clear the active pixel layer (or mask) through the selection
  function paintThrough(color, erase, label) {
    const n = E.active()
    if (!n) return
    const sel = selTex()
    const target = E.paintTarget?.(n) ?? 'pixels'
    if (target === 'mask' && n.mask?.tex) {
      const src = E.texOf(n.mask.tex)
      const nid = E.newRes(src.width, src.height, src.format, true)
      const cov = sel ?? fullCoverage()
      const v = erase ? 0 : (color[0] + color[1] + color[2]) / 3
      const u = f32(v, 1)
      u[8] = -(n.mask.ox ?? 0); u[9] = -(n.mask.oy ?? 0)
      run('fs_paint_value', E.texOf(nid), [null, E.C.level0(src), E.C.level0(cov)], u)
      E.C.genMips(E.texOf(nid))
      if (!sel) cov.destroy()
      E.commit(label, E.patchNode(E.doc, n.id, { mask: { ...n.mask, tex: nid } }))
      return
    }
    if (n.kind !== 'pixel') return
    const src = E.texOf(n.pix)
    if (!src) return
    // painted pixels need the layer to cover the document
    const grown = E.ensureDocCoverage?.(n) ?? n
    const tex = E.texOf(grown.pix)
    const nid = E.newRes(tex.width, tex.height, tex.format, true)
    const cov = sel ?? fullCoverage()
    const u = f32(...color.slice(0, 3), color[3] ?? 1, 1, erase ? 1 : 0)
    u[8] = grown.bounds.x; u[9] = grown.bounds.y
    run('fs_fill_rgba', E.texOf(nid), [null, E.C.level0(tex), E.C.level0(cov)], u)
    E.C.genMips(E.texOf(nid))
    if (!sel) cov.destroy()
    E.commit(label, E.patchNode(E.doc, n.id, { pix: nid, bounds: grown.bounds }))
  }
  const fullCoverage = () => {
    const t = E.C.createTex(E.doc.width, E.doc.height, 'r8unorm', false)
    const enc = E.device.createCommandEncoder()
    enc.beginRenderPass({ colorAttachments: [{ view: E.C.level0(t), loadOp: 'clear', storeOp: 'store', clearValue: [1, 1, 1, 1] }] }).end()
    E.device.queue.submit([enc.finish()])
    return t
  }

  const ops = {
    selectAll() {
      const t = fullCoverage()
      const id = newMaskRes()
      E.C.run('util', 'fs_copy', E.texOf(id), [null, E.C.level0(t)])
      t.destroy()
      setSelection(id, 'Select All')
    },
    deselect() { if (E.doc.selection) setSelection(null, 'Deselect') },
    reselect() {
      const last = E.doc.lastSelection
      if (!last?.tex) return
      setSelection(last.tex, 'Reselect')
    },
    invertSelection() {
      const cur = selTex()
      const id = newMaskRes()
      if (cur) run('fs_invert', E.texOf(id), [null, E.C.level0(cur)])
      else { const t = fullCoverage(); E.C.run('util', 'fs_copy', E.texOf(id), [null, E.C.level0(t)]); t.destroy() }
      setSelection(id, 'Inverse')
    },
    fillSelection({ color }) { paintThrough(E.linColor(color ?? [1, 1, 1, 1]), false, 'Fill') },
    clearSelection() { if (E.doc.selection) paintThrough([0, 0, 0, 0], true, 'Clear') },
    maskToSelection({ nodeId }) {
      const n = findNode(E.doc.nodes, nodeId ?? E.doc.activeId)?.node
      const src = n?.mask?.tex ? E.texOf(n.mask.tex) : null
      if (!src) return
      const id = newMaskRes()
      E.C.run('util', 'fs_copy', E.texOf(id), [null, E.C.level0(src)])
      if (n.mask.invert) {
        const t = E.texOf(id)
        const t2 = E.C.createTex(t.width, t.height, t.format, false)
        run('fs_invert', t2, [null, E.C.level0(t)])
        E.C.run('util', 'fs_copy', t, [null, E.C.level0(t2)])
        t2.destroy()
      }
      setSelection(id, 'Load Selection')
    },
    async refineMask({ nodeId, radius = 12 }) {
      const n = findNode(E.doc.nodes, nodeId ?? E.doc.activeId)?.node
      const src = n?.mask?.tex ? E.texOf(n.mask.tex) : null
      if (!src) return
      const t = refineTex(src, { radius })
      const nid = E.newRes(src.width, src.height, src.format, true)
      E.C.run('util', 'fs_copy', E.texOf(nid), [null, E.C.level0(t)])
      t.destroy()
      E.C.genMips(E.texOf(nid))
      E.commit('Refine Mask', E.patchNode(E.doc, n.id, { mask: { ...n.mask, tex: nid } }))
    },
  }

  return {
    init(e) { E = e; E.C.addModule('select', selectWgsl) },
    handles,
    ops,
    reset() { outlines.clear(); wandCache = null },
    selectionInfo(doc) {
      const id = doc?.selection?.tex
      if (!id) return null
      const o = outlines.get(id)
      if (!o) traceSoon(id)
      return { outline: o?.path ?? null, bounds: o?.bounds ?? null }
    },
    // the selection into a fresh mask texture (Add Mask with a selection)
    selectionToMask(maskTex, invert) {
      const cur = selTex()
      if (!cur) return
      if (invert) run('fs_invert', maskTex, [null, E.C.level0(cur)])
      else E.C.run('util', 'fs_copy', maskTex, [null, E.C.level0(cur)])
    },
    selection: () => selTex(),
    compositeTex,
    blurInPlace,
    grow,
  }
}

// SelU in select.wgsl: 4 vec4 + 8 colour slots = 48 floats
const f32 = (...v) => { const u = new Float32Array(48); u.set(v); return u }

function rgbToLab([r, g, b]) {
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const R = lin(r), G = lin(g), B = lin(b)
  const x = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047
  const y = 0.2126 * R + 0.7152 * G + 0.0722 * B
  const z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))]
}
