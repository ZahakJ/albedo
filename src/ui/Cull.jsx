import { useEffect, useRef, useState } from 'react'
import { getViewState, setMode, select } from '../state/viewStore.js'
import { setMeta, getCatalogState } from '../state/catalogStore.js'
import { usePreview, preloadPreview } from '../state/usePreview.js'

// ⇧C — cull: fullscreen single-photo pass on a black stage. EVERY rating/
// flag key stamps the current photo and auto-advances to the next photo still
// awaiting a decision (unrated AND unflagged); ←/→ move manually; Z toggles
// 1:1 on the preview (pure CSS transform — the engine never wakes); Esc/G
// exits to the grid at the current photo. The next 3 previews preload.

const overlayOpen = () => !!document.querySelector('.overlay-scrim, .confirmdlg, .cmenu')

export default function Cull({ visible }) {
  // pool frozen at entry so '12 of 214' stays a stable coordinate system
  const poolRef = useRef(null)
  if (poolRef.current === null) {
    const sel = getViewState().selection
    poolRef.current = (sel.size >= 2 ? visible.filter((p) => sel.has(p.id)) : visible)
      .map((p) => p.id)
  }
  const pool = poolRef.current
  const [at, setAt] = useState(() => Math.max(0, pool.indexOf(getViewState().selectedId)))
  const [zoom, setZoom] = useState(false)
  const imgRef = useRef(null)
  // rapid keystrokes must never act on a stale index while a re-render is
  // pending — the handler goes through this ref, React just paints it
  const atRef = useRef(at)
  const go = (i) => { atRef.current = i; setZoom(false); setAt(i) }

  const cur = visible.find((p) => p.id === pool[at]) ?? null
  const { url, isPreview } = usePreview(cur?.id)
  const undecided = (p) => p && (p.rating ?? 0) === 0 && (p.flag ?? 0) === 0
  const remaining = pool.reduce(
    (n, id) => n + undecided(visible.find((p) => p.id === id)), 0)

  // look-ahead: the next 3 previews are warm before the key lands
  useEffect(() => {
    for (let i = 1; i <= 3; i++) preloadPreview(pool[at + i])
  }, [at, pool])

  // grid selection tracks the pass — Esc lands exactly here
  useEffect(() => { if (cur) select(cur.id) }, [cur?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!pool.length) { setMode('grid'); return }
    const onKey = (e) => {
      // Library stays mounted under Develop — never steal Develop's keys
      if (getViewState().surface !== 'library') return
      if (e.metaKey || e.ctrlKey || e.altKey || overlayOpen()) return
      const t = e.target
      if (t instanceof Element && (t.closest('input, textarea, select') || t.isContentEditable)) return
      const move = (d) => go(Math.max(0, Math.min(pool.length - 1, atRef.current + d)))
      // stamp, then advance to the next photo with no decision yet (wrapping);
      // the optimistic setMeta is already in catalog state, so a live lookup
      // stays honest even for back-to-back keystrokes
      const stamp = (patch) => {
        const here = atRef.current
        const id = pool[here]
        if (id == null) return
        setMeta(id, patch)
        const photos = getCatalogState().photos
        for (let step = 1; step <= pool.length; step++) {
          const i = (here + step) % pool.length
          if (pool[i] !== id && undecided(photos.find((q) => q.id === pool[i]))) { go(i); return }
        }
      }
      switch (e.key) {
        case 'ArrowRight': move(1); break
        case 'ArrowLeft': move(-1); break
        case 'Escape': setMode('grid'); break
        case 'z': case 'Z': setZoom((z) => !z); break
        case 'p': case 'P': stamp({ flag: 1 }); break
        case 'x': case 'X': stamp({ flag: -1 }); break
        case 'u': case 'U': stamp({ flag: 0 }); break
        default:
          if (!/^[0-5]$/.test(e.key)) return // unhandled (incl. G) → app router
          stamp({ rating: +e.key })
      }
      e.preventDefault()
      e.stopPropagation()
    }
    addEventListener('keydown', onKey, true)
    return () => removeEventListener('keydown', onKey, true)
  }, [at, pool, visible])

  if (!cur) return null

  // 1:1 of the preview bitmap: displayed content px → natural px. The img
  // fills the stage with object-fit contain, so the drawn content box must be
  // derived from the natural aspect (offset* is layout size, transform-immune).
  let scale = 0
  const el = imgRef.current
  if (zoom && el?.naturalWidth && el.offsetWidth > 0 && el.offsetHeight > 0) {
    const contentW = Math.min(el.offsetWidth, el.offsetHeight * (el.naturalWidth / el.naturalHeight))
    scale = el.naturalWidth / contentW
  }

  const rating = cur.rating ?? 0
  const flag = cur.flag ?? 0

  return (
    <div className="cull" role="region" aria-label="Cull mode">
      <div className="cull-stage on-image" onDoubleClick={() => setZoom((z) => !z)}>
        {url && (
          <img
            ref={imgRef}
            className={`cull-img${isPreview ? ' is-hi' : ''}`}
            style={scale > 0 ? { transform: `scale(${scale})` } : undefined}
            src={url}
            alt={cur.name}
            draggable={false}
          />
        )}
      </div>
      <div className="cull-hud mono" aria-live="polite">
        <span className={`hud-flag${flag === -1 ? ' is-reject' : ''}`}>
          {flag === 1 ? '⚑' : flag === -1 ? '✕' : '—'}
        </span>
        <span className="hud-dot" aria-hidden="true">·</span>
        <span className="hud-stars">{rating > 0 ? '★'.repeat(rating) : '—'}</span>
        <span className="hud-dot" aria-hidden="true">·</span>
        <span className="hud-pos">{at + 1} of {pool.length}</span>
        <span className="hud-dot" aria-hidden="true">·</span>
        <span className="hud-left">{remaining} remaining</span>
      </div>
    </div>
  )
}
