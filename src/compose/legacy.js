import { readFile, getDir, writeFile } from '../io/opfs.js'
import { newDoc, newPixel, newText } from './model.js'
import { uploadBitmap } from './gpu/io.js'

// Documents from the Canvas surface Compose replaced (OPFS canvasdocs/):
// opened once, saved as Compose documents, and marked migrated. Their raster
// layers were document-sized PNGs drawn at the layer's offset; their text
// layers become type layers.
const BLEND = {
  'source-over': 'normal', multiply: 'multiply', screen: 'screen', overlay: 'overlay', darken: 'darken',
  lighten: 'lighten', 'color-dodge': 'colorDodge', 'color-burn': 'colorBurn', 'hard-light': 'hardLight',
  'soft-light': 'softLight', difference: 'difference', exclusion: 'exclusion', hue: 'hue',
  saturation: 'saturation', color: 'color', luminosity: 'luminosity',
}
const hexColor = (h) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(h ?? '')
  if (!m) return [1, 1, 1, 1]
  const v = parseInt(m[1], 16)
  return [(v >> 16) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255, 1]
}

export async function migrateCanvasDocs(E, open, save) {
  let root
  try { root = await getDir('canvasdocs', false) } catch { return 0 }
  let n = 0
  for await (const [id, h] of root.entries()) {
    if (h.kind !== 'directory') continue
    try {
      await readFile(`canvasdocs/${id}/migrated.txt`)
      continue
    } catch { /* not yet */ }
    try {
      const json = JSON.parse(new TextDecoder().decode(await readFile(`canvasdocs/${id}/doc.json`)))
      const d = newDoc(json.width, json.height, { depth: 8, name: json.name ?? 'Canvas document' })
      open(d)
      const nodes = []
      for (const l of json.layers ?? []) {
        const common = { name: l.name, visible: l.visible !== false, opacity: l.opacity ?? 1, blend: BLEND[l.blend] ?? 'normal' }
        if (l.kind === 'text') {
          const t = { content: l.text?.content ?? '', size: l.text?.size ?? 48, weight: l.text?.weight ?? 400, color: hexColor(l.text?.color) }
          const b = await E.textBounds(l.x ?? 0, l.y ?? 0, { ...newText(0, 0, t).text })
          nodes.push(newText(0, 0, t, { ...common, bounds: b }))
          continue
        }
        let bmp = null
        try { bmp = await createImageBitmap(new Blob([await readFile(`canvasdocs/${id}/${l.id}.png`)], { type: 'image/png' })) } catch { /* empty */ }
        const rid = E.newRes(json.width, json.height)
        if (bmp) { uploadBitmap(E.device, E.texOf(rid), bmp); bmp.close() }
        E.C.genMips(E.texOf(rid))
        nodes.push(newPixel({ x: l.x ?? 0, y: l.y ?? 0, w: json.width, h: json.height }, { ...common, pix: rid }))
      }
      E.reset({ ...E.doc, nodes, activeId: nodes[nodes.length - 1]?.id ?? null }, null)
      await save()
      await writeFile(`canvasdocs/${id}/migrated.txt`, new TextEncoder().encode(`now Compose document ${d.id}\n`))
      n++
    } catch (err) { console.warn('[compose] could not migrate Canvas document', id, err) }
  }
  return n
}
