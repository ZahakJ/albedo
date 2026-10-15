import { useEffect, useState } from 'react'
import { DOC_PRESETS } from './docModel.js'
import {
  useCanvasState, refreshDocsList, loadCanvasDoc, newDocument, deleteCanvasDoc,
} from '../state/canvasClient.js'

// No document open: recent canvas documents grid + the new-document dialog.
// Canvas docs live in their own OPFS home (canvasdocs/) — the photo catalog
// never hears about them.

const when = (t) => {
  if (!t) return ''
  const d = Date.now() - t
  if (d < 60000) return 'just now'
  if (d < 3600000) return `${Math.round(d / 60000)}m ago`
  if (d < 86400000) return `${Math.round(d / 3600000)}h ago`
  return new Date(t).toLocaleDateString()
}

function NewDocDialog({ onClose }) {
  const [w, setW] = useState(1920)
  const [h, setH] = useState(1080)
  const [bg, setBg] = useState('transparent')
  const create = () => {
    const width = Math.max(1, Math.min(8192, Math.round(+w || 0)))
    const height = Math.max(1, Math.min(8192, Math.round(+h || 0)))
    newDocument(width, height, bg).then(onClose)
  }
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); create() }
    }
    addEventListener('keydown', onKey, true)
    return () => removeEventListener('keydown', onKey, true)
  }) // deps intentionally live: create closes over current w/h/bg
  return (
    <div className="overlay-scrim scrim-palette" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="copydlg newdocdlg" role="dialog" aria-label="New document">
        <h3 className="panel-header">NEW DOCUMENT</h3>
        <div className="newdoc-presets">
          {DOC_PRESETS.map(([name, pw, ph]) => (
            <button
              key={name}
              type="button"
              className={`chip newdoc-preset${+w === pw && +h === ph ? ' is-on' : ''}`}
              onClick={() => { setW(pw); setH(ph) }}
            >{name}</button>
          ))}
        </div>
        <div className="newdoc-size">
          <label className="newdoc-field">
            <span>W</span>
            <input className="mono newdoc-px" value={w} inputMode="numeric" onChange={(e) => setW(e.target.value)} />
          </label>
          <span className="newdoc-x" aria-hidden="true">×</span>
          <label className="newdoc-field">
            <span>H</span>
            <input className="mono newdoc-px" value={h} inputMode="numeric" onChange={(e) => setH(e.target.value)} />
          </label>
          <select className="blend-select newdoc-bg" value={bg} aria-label="Background" onChange={(e) => setBg(e.target.value)}>
            <option value="transparent">Transparent</option>
            <option value="white">White</option>
            <option value="black">Black</option>
          </select>
        </div>
        <div className="copy-actions">
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn-primary newdoc-create" onClick={create}>Create ↵</button>
        </div>
      </div>
    </div>
  )
}

export default function RecentDocs({ visible }) {
  const { docsList } = useCanvasState()
  const [dlg, setDlg] = useState(false)
  useEffect(() => { if (visible) refreshDocsList().catch(() => {}) }, [visible])
  return (
    <div className="cv-recent">
      <div className="cv-recent-head">
        <p className="cv-recent-hero">Canvas</p>
        <p className="cv-recent-sub">Layered editing — open a recent document, start blank, or drop an image</p>
        <button type="button" className="btn-primary cv-new-doc" onClick={() => setDlg(true)}>
          New document…
        </button>
      </div>
      {docsList?.length > 0 && (
        <div className="cv-doc-grid">
          {docsList.map((d) => (
            <div key={d.id} className="cv-doc-card" data-id={d.id}>
              <button type="button" className="cv-doc-open" onClick={() => loadCanvasDoc(d.id)}>
                <span className="cv-doc-thumb">
                  {d.thumbUrl && <img src={d.thumbUrl} alt="" />}
                </span>
                <span className="cv-doc-name" title={d.name}>{d.name}</span>
                <span className="cv-doc-meta mono">
                  {d.width} × {d.height} · {d.layerCount} layer{d.layerCount === 1 ? '' : 's'} · {when(d.updatedAt)}
                </span>
              </button>
              <button
                type="button"
                className="cv-doc-del"
                data-tip="Delete document"
                aria-label={`Delete ${d.name}`}
                onClick={() => deleteCanvasDoc(d.id).then(() => refreshDocsList()).catch(() => {})}
              >
                <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
                  <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}
      {docsList && !docsList.length && (
        <p className="cv-recent-empty">No canvas documents yet.</p>
      )}
      {dlg && <NewDocDialog onClose={() => setDlg(false)} />}
    </div>
  )
}
