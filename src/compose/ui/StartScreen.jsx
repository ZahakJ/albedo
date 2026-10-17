import { useState } from 'react'
import { useCompose, newDocument, loadDocument, deleteDocument, openImage, importFile } from '../../state/composeClient.js'
import { getViewState } from '../../state/viewStore.js'
import { getCatalogState } from '../../state/catalogStore.js'
import { placeFromLibrary } from './library.js'

// No document open: recent documents, a new blank document, or open a file.
const PRESETS = [
  ['From Library photo', null, null],
  ['4000 × 3000', 4000, 3000],
  ['6000 × 4000 (24 MP)', 6000, 4000],
  ['1920 × 1080', 1920, 1080],
  ['2048 × 2048', 2048, 2048],
  ['1080 × 1350 (4:5)', 1080, 1350],
]

export default function StartScreen() {
  const { docs } = useCompose()
  const [w, setW] = useState(4000)
  const [h, setH] = useState(3000)
  const [depth, setDepth] = useState(16)
  const [bg, setBg] = useState('white')
  const sel = getViewState().selectedId
  const selPhoto = getCatalogState().photos.find((p) => p.id === sel)
  const open = async () => {
    const [fh] = await (window.showOpenFilePicker?.({
      types: [{ description: 'Images and layered files', accept: { 'image/*': ['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.psd', '.psb', '.albedo'] } }],
    }) ?? Promise.resolve([]))
    if (!fh) return
    const file = await fh.getFile()
    await openFileInCompose(file)
  }
  return (
    <div className="co-start">
      <div className="co-start-head">
        <h2 className="co-start-hero">Compose</h2>
        <p className="co-start-sub">Layers, masks, retouching and type, on the GPU. Drop an image or a PSD here, or start from a photo.</p>
      </div>
      <div className="co-start-cards">
        <section className="co-start-new" aria-label="New document">
          <h3 className="co-start-h">New document</h3>
          <div className="newdoc-size">
            <label className="newdoc-field">W <input className="newdoc-px mono" type="number" min="1" max="16384" value={w} onChange={(e) => setW(+e.target.value)} /></label>
            <span className="newdoc-x">×</span>
            <label className="newdoc-field">H <input className="newdoc-px mono" type="number" min="1" max="16384" value={h} onChange={(e) => setH(+e.target.value)} /></label>
          </div>
          <div className="newdoc-presets">
            {PRESETS.slice(1).map(([l, pw, ph]) => (
              <button key={l} type="button" className="chip" onClick={() => { setW(pw); setH(ph) }}>{l}</button>
            ))}
          </div>
          <div className="co-start-row">
            <span className="co-ctl-label">Depth</span>
            <div className="seg co-seg">
              {[8, 16, 32].map((d) => (
                <button key={d} type="button" className={`seg-btn${depth === d ? ' is-on' : ''}`} onClick={() => setDepth(d)}>{d}-bit</button>
              ))}
            </div>
          </div>
          <div className="co-start-row">
            <span className="co-ctl-label">Background</span>
            <div className="seg co-seg">
              {['white', 'black', 'transparent'].map((b) => (
                <button key={b} type="button" className={`seg-btn${bg === b ? ' is-on' : ''}`} onClick={() => setBg(b)}>{b[0].toUpperCase() + b.slice(1)}</button>
              ))}
            </div>
          </div>
          <button type="button" className="btn-primary co-start-go" onClick={() => newDocument(w, h, { depth, background: bg })}>Create</button>
        </section>
        <section className="co-start-new" aria-label="Open">
          <h3 className="co-start-h">Open</h3>
          <button type="button" className="btn-quick" onClick={open}>Open a file…</button>
          <p className="co-hint">JPEG, PNG, TIFF (with Photoshop layers), PSD and .albedo documents.</p>
          <button type="button" className="btn-quick" disabled={!selPhoto} onClick={() => placeFromLibrary(selPhoto, { newDoc: true })}>
            {selPhoto ? `Open “${selPhoto.name}” as a smart object` : 'Select a photo in the Library'}
          </button>
          <p className="co-hint">From Develop, ⌘⇧E opens the photo you are editing, with its edit.</p>
        </section>
      </div>
      {docs?.length > 0 && <h3 className="co-start-h co-recent-h">Recent</h3>}
      <div className="cv-doc-grid">
        {(docs ?? []).map((d) => (
          <div key={d.id} className="cv-doc-card">
            <button type="button" className="cv-doc-open" onClick={() => loadDocument(d.id)}>
              <span className="cv-doc-thumb">{d.thumbUrl && <img src={d.thumbUrl} alt="" />}</span>
              <span className="cv-doc-name">{d.name}</span>
              <span className="cv-doc-meta mono">{d.width} × {d.height} · {d.depth}-bit · {d.layers} layer{d.layers === 1 ? '' : 's'}</span>
            </button>
            <button type="button" className="cv-doc-del" aria-label={`Delete ${d.name}`} onClick={() => deleteDocument(d.id)}>×</button>
          </div>
        ))}
      </div>
    </div>
  )
}

export async function openFileInCompose(file) {
  const name = file.name.replace(/\.[^.]+$/, '')
  if (/\.(psd|psb)$/i.test(file.name)) return importFile(new Uint8Array(await file.arrayBuffer()), name, 'psd')
  if (/\.albedo$/i.test(file.name)) return importFile(new Uint8Array(await file.arrayBuffer()), name, 'albedo')
  if (/\.tiff?$/i.test(file.name)) return importFile(new Uint8Array(await file.arrayBuffer()), name, 'tiff')
  return openImage(file, name)
}
