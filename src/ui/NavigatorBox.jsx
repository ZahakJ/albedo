import { useRef, useState } from 'react'
import { useEditState } from '../state/editStore.js'
import { useCatalog } from '../state/catalogStore.js'
import { useViewState, setZoom } from '../state/viewStore.js'
import { geometryOf } from '../engine/geometry.js'
import { useThumb } from './useThumb.js'

// Lightroom's navigator: a small preview at the top of the Develop preset
// rail. At loupe zoom a white viewport rectangle mirrors the visible window
// (viewStore zoom/pan + geometry); dragging it pans, clicking jumps, and a
// click at fit dives to 1:1 on that spot. Pure UI — the existing setView
// flow consumes every write; no render-worker involvement.

const NAV_KEY = 'albedo.rail.navigator'

export default function NavigatorBox() {
  const { photo, doc } = useEditState()
  const { photos } = useCatalog()
  const { zoom, panX, panY } = useViewState()
  const boxRef = useRef(null)
  const dragRef = useRef(false)
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(NAV_KEY) !== '0' } catch { return true }
  })
  const rec = photos.find((p) => p.id === photo?.id)
  const { url } = useThumb(photo?.id, rec?.thumbState ?? 0)

  const toggle = () => {
    const next = !open
    setOpen(next)
    try { localStorage.setItem(NAV_KEY, next ? '1' : '0') } catch { /* private mode */ }
  }

  if (!photo) return null

  const g = geometryOf(doc?.modules?.geometry ?? null, photo.width, photo.height)

  // visible-window fractions — the same math fit() uses for the loupe view
  let rect = null
  if (zoom !== 'fit') {
    const mat = document.querySelector('.canvas-mat')?.getBoundingClientRect()
    if (mat?.width) {
      const dpr = Math.min(devicePixelRatio, 2)
      const fw = Math.min(1, (mat.width * dpr) / (zoom * g.outW))
      const fh = Math.min(1, (mat.height * dpr) / (zoom * g.outH))
      const cx = fw >= 1 ? 0.5 : Math.max(fw / 2, Math.min(1 - fw / 2, panX))
      const cy = fh >= 1 ? 0.5 : Math.max(fh / 2, Math.min(1 - fh / 2, panY))
      rect = { l: cx - fw / 2, t: cy - fh / 2, w: fw, h: fh }
    }
  }

  const uv = (e) => {
    const r = boxRef.current.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
      y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
    }
  }

  const onDown = (e) => {
    if (e.button !== 0) return
    const { x, y } = uv(e)
    if (zoom === 'fit') { setZoom(1, x, y); return } // fit → dive to 1:1 here
    dragRef.current = true
    e.currentTarget.setPointerCapture(e.pointerId)
    setZoom(zoom, x, y)
  }
  const onMove = (e) => {
    if (!dragRef.current) return
    const { x, y } = uv(e)
    setZoom(zoom, x, y)
  }
  const onUp = () => { dragRef.current = false }

  return (
    <section className={`navbox${open ? ' is-open' : ''}`}>
      <button type="button" className="rail-head" aria-expanded={open} onClick={toggle}>
        <svg className="sec-caret" width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
          <path d="M2 0.8l4 3.2-4 3.2z" fill="currentColor" />
        </svg>
        <span className="panel-header rail-title">NAVIGATOR</span>
        <span className="navbox-zoom mono">{zoom === 'fit' ? 'FIT' : zoom === 2 ? '2:1' : '1:1'}</span>
      </button>
      {open && (
        <div className="navbox-well">
          <div
            ref={boxRef}
            className="navbox-frame"
            style={{ aspectRatio: `${g.outW} / ${g.outH}` }}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
          >
            {url && <img className="navbox-thumb" src={url} alt="" draggable={false} />}
            {rect && (
              <span
                className="navbox-rect"
                style={{
                  left: `${rect.l * 100}%`,
                  top: `${rect.t * 100}%`,
                  width: `${rect.w * 100}%`,
                  height: `${rect.h * 100}%`,
                }}
                aria-hidden="true"
              />
            )}
          </div>
        </div>
      )}
    </section>
  )
}
