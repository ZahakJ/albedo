import { openContextMenu } from '../../ui/ContextMenu.jsx'
import { exportDoc, getCompose } from '../../state/composeClient.js'
import { loadOriginal } from '../../state/catalogStore.js'
import { zipWrite } from '../../io/zip.js'
import { toast } from '../../state/toastStore.js'

// Export: flattened JPEG, PNG or 16-bit TIFF; layered PSD, TIFF or .albedo.
const FORMATS = [
  ['jpeg', 'JPEG', 'jpg', 'flattened, on white'],
  ['png', 'PNG', 'png', 'flattened, with transparency'],
  ['tiff', 'TIFF, 16-bit', 'tif', 'flattened'],
  ['psd', 'Photoshop (PSD)', 'psd', 'layers, masks, groups, modes'],
  ['psd+', 'Photoshop (PSD) with albedo data', 'psd', 'reopens here fully editable'],
  ['albedo', 'albedo document', 'albedo', 'everything, editable, smart objects embedded'],
]

export async function exportAs(format) {
  const doc = getCompose().doc
  if (!doc) return
  const f = FORMATS.find((x) => x[0] === format)
  const t0 = performance.now()
  try {
    let blob
    if (format === 'albedo') blob = await albedoFile(doc)
    else blob = await exportDoc(format === 'psd+' ? 'psd' : format, { quality: 0.92, withAlbedo: format === 'psd+' })
    const name = `${doc.name.replace(/[\\/:*?"<>|]+/g, '_')}.${f[2]}`
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 30_000)
    toast(`Exported ${name} · ${(blob.size / 2 ** 20).toFixed(1)} MB in ${((performance.now() - t0) / 1000).toFixed(1)} s`)
  } catch (err) {
    toast(`Export failed: ${err.message}`)
  }
}

export function openExport(e) {
  const r = e.currentTarget.getBoundingClientRect()
  openContextMenu(r.left, r.top - 4, FORMATS.map(([k, label, , sub]) => ({ label: `${label} — ${sub}`, run: () => exportAs(k) })))
}

// the worker's entries plus the originals of the smart objects
async function albedoFile(doc) {
  const { entries } = await exportDoc('albedo')
  const ids = new Set()
  const walk = (l) => { for (const n of l) { if (n.kind === 'smart') ids.add(n.smart.photoId); if (n.children) walk(n.children) } }
  walk(doc.nodes)
  for (const id of ids) {
    try {
      const { buffer, name } = await loadOriginal(id)
      entries.push({ name: `originals/${id}/${name}`, data: new Uint8Array(buffer) })
    } catch (err) {
      // not in the catalog: the document still opens, without that source
      console.warn('[compose] smart object original not embedded', id, err)
    }
  }
  return new Blob([zipWrite(entries)], { type: 'application/x-albedo' })
}

// e2e reaches the .albedo writer through here
if (typeof window !== 'undefined') window.__composeUi = { ...(window.__composeUi ?? {}), albedoFile }
