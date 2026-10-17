import { CO } from './protocol.js'
import { readRaw } from './gpu/io.js'
import { newPixel } from './model.js'

// Region reads and writes for the AI fills (content-aware fill, spot heal):
// the main thread asks for a scaled crop of the composite and of the hole,
// runs the model, and places the result back as its own layer.
export function patchPlugin() {
  let E
  const ops = {
    // { rect: [x, y, w, h] doc px, w, h (region px), sample: 'all'|'below' }
    // → { rgba (straight RGBA8), hole (Uint8 from the selection, if any) }
    async regionPixels({ rect, w, h, sample = 'all', hole = true }) {
      const k = w / rect[2]
      const nodes = sample === 'below' ? upTo(E.doc.nodes, E.doc.activeId) : E.doc.nodes
      const d = { ...E.doc, nodes }
      const t = E.C.createTex(w, h, E.accFmt(), false)
      E.C.composite(d, E.resMap(d), E.compositeHost, t, { W: w, H: h, view: [k, k, -rect[0] * k, -rect[1] * k] })
      const t8 = E.C.createTex(w, h, 'rgba8unorm', false)
      E.C.run('adjust', 'fs_unpremul', t8, [null, E.C.level0(t)])
      const rgba = await readRaw(E.device, t8)
      t.destroy(); t8.destroy()
      let holeMask = null
      const sel = E.doc.selection?.tex ? E.texOf(E.doc.selection.tex) : null
      if (hole && sel) {
        const m = E.C.createTex(w, h, 'r8unorm', false)
        E.C.run('select', 'fs_region', m, [E.C.sampler, sel.createView()], f32(rect[0], rect[1], k))
        holeMask = await readRaw(E.device, m)
        m.destroy()
      }
      return { rgba, hole: holeMask }
    },
    // { rect (doc px), w, h, rgba (premultiplied RGBA8 of the fill, alpha =
    // feathered hole), name } → a new pixel layer above the active one
    placePatch({ rect, w, h, rgba, name = 'Content-Aware Fill', above }) {
      const id = E.newRes(w, h, E.fmt())
      const tex = E.texOf(id)
      const t8 = E.C.createTex(w, h, 'rgba8unorm', false)
      E.device.queue.writeTexture({ texture: t8 }, rgba, { bytesPerRow: w * 4 }, [w, h])
      E.C.run('util', 'fs_copy', tex, [null, E.C.level0(t8)])
      t8.destroy()
      E.C.genMips(tex)
      E.linearizeRes(id)
      const s = rect[2] / w
      const n = newPixel({ x: 0, y: 0, w, h }, {
        name, pix: id,
        xf: Math.abs(s - 1) < 1e-6 ? null : { kind: 'affine', m: [s, 0, 0, s, rect[0], rect[1]] },
      })
      if (!n.xf) n.bounds = { x: rect[0], y: rect[1], w, h }
      E.commit(name, E.setActive(E.insertAbove(E.doc, above ?? E.doc.activeId, [n]), n.id))
      return { nodeId: n.id }
    },
  }
  return { init(e) { E = e }, ops, handles: {} }
}

// SelU in select.wgsl: 4 vec4 + 8 colour slots = 48 floats
const f32 = (...v) => { const u = new Float32Array(48); u.set(v); return u }
function upTo(nodes, id) {
  const out = []
  for (const n of nodes) {
    out.push(n)
    if (n.id === id) break
  }
  return out
}
