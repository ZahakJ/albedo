import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { getViewState, setMode, select } from '../state/viewStore.js'
import { setMeta } from '../state/catalogStore.js'
import { usePreview } from '../state/usePreview.js'
import { flagGlyph } from './Compare.jsx'

// N — survey: every selected photo tiled at once (the whole filtered grid
// when fewer than 2 are selected). Hover shows ✕ (drops the tile from the
// survey, never from disk) + the cull badges; keys act on the hovered (else
// focused) tile; click focuses, double-click opens Develop. Removals reflow
// with a 160ms transform-only FLIP. Esc/G exits.

const overlayOpen = () => !!document.querySelector('.overlay-scrim, .confirmdlg, .cmenu')

function Tile({ p, isFocus, onFocus, onHover, onOpen, onDrop }) {
  const { url, isPreview } = usePreview(p.id)
  const rating = p.rating ?? 0
  const glyph = flagGlyph(p.flag ?? 0)
  return (
    <div
      className={`svy-tile on-image${isFocus ? ' is-focus' : ''}`}
      data-id={p.id}
      onPointerEnter={() => onHover(p.id)}
      onPointerLeave={() => onHover(null)}
      onClick={() => onFocus(p.id)}
      onDoubleClick={() => onOpen(p)}
    >
      {url && <img className={`svy-img${isPreview ? ' is-hi' : ''}`} src={url} alt={p.name} draggable={false} />}
      {(glyph || rating > 0) && (
        <span className="svy-badges mono" aria-hidden="true">
          {glyph && <span className={p.flag === -1 ? 'is-reject' : ''}>{glyph}</span>}
          {rating > 0 && <span>{'★'.repeat(rating)}</span>}
        </span>
      )}
      <button
        type="button"
        className="svy-x"
        title="Remove from survey"
        aria-label={`Remove ${p.name} from survey`}
        onClick={(e) => { e.stopPropagation(); onDrop(p.id) }}
      >✕</button>
    </div>
  )
}

export default function Survey({ visible, onOpen }) {
  const [ids, setIds] = useState(() => {
    const sel = getViewState().selection
    return (sel.size >= 2 ? visible.filter((p) => sel.has(p.id)) : visible).map((p) => p.id)
  })
  const [focusId, setFocusId] = useState(() => getViewState().selectedId)
  const hoverRef = useRef(null)
  const focusRef = useRef(null) // mirrors the effective focus for rapid keys
  const gridRef = useRef(null)
  const rectsRef = useRef(new Map())
  const [box, setBox] = useState({ w: 0, h: 0 })

  const alive = ids.filter((id) => visible.some((p) => p.id === id))
  const focus = alive.includes(focusId) ? focusId : alive[0]
  focusRef.current = focus

  const drop = (id) => {
    const rest = ids.filter((x) => x !== id)
    if (!rest.length) { setMode('grid'); return }
    setIds(rest)
    if (id === focus) setFocusId(rest[0])
  }

  useEffect(() => {
    const el = gridRef.current
    const obs = new ResizeObserver(([e]) => {
      if (e.contentRect.width > 0) setBox({ w: e.contentRect.width, h: e.contentRect.height })
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  // FLIP-ish reflow: invert each surviving tile from its previous rect, then
  // release — transform-only, 160ms, skipped under reduced motion
  useLayoutEffect(() => {
    const prev = rectsRef.current
    const next = new Map()
    const animate = !matchMedia('(prefers-reduced-motion: reduce)').matches
    for (const el of gridRef.current?.querySelectorAll('.svy-tile') ?? []) {
      const r = el.getBoundingClientRect()
      next.set(el.dataset.id, r)
      const o = prev.get(el.dataset.id)
      if (animate && o && (Math.abs(o.left - r.left) > 1 || Math.abs(o.top - r.top) > 1 ||
          Math.abs(o.width - r.width) > 1)) {
        el.animate(
          [{ transform: `translate(${o.left - r.left}px,${o.top - r.top}px) scale(${o.width / r.width},${o.height / r.height})` }, { transform: 'none' }],
          { duration: 160, easing: 'cubic-bezier(.2,.8,.2,1)' })
      }
    }
    rectsRef.current = next
  })

  useEffect(() => {
    if (!alive.length) { setMode('grid'); return }
    const onKey = (e) => {
      // Library stays mounted under Develop — never steal Develop's keys
      if (getViewState().surface !== 'library') return
      if (e.metaKey || e.ctrlKey || e.altKey || overlayOpen()) return
      const t = e.target
      if (t instanceof Element && (t.closest('input, textarea, select') || t.isContentEditable)) return
      const target = hoverRef.current ?? focusRef.current
      const move = (d) => {
        const at = alive.indexOf(focusRef.current)
        const to = alive[Math.max(0, Math.min(alive.length - 1, (at < 0 ? 0 : at) + d))]
        if (to != null) { focusRef.current = to; setFocusId(to); select(to) }
      }
      switch (e.key) {
        case 'ArrowRight': move(1); break
        case 'ArrowLeft': move(-1); break
        case 'Escape': setMode('grid'); break
        case 'p': case 'P': if (target) setMeta(target, { flag: 1 }); break
        case 'x': case 'X': if (target) setMeta(target, { flag: -1 }); break
        case 'u': case 'U': if (target) setMeta(target, { flag: 0 }); break
        default:
          if (!/^[0-5]$/.test(e.key) || !target) return // unhandled → app router
          setMeta(target, { rating: +e.key })
      }
      e.preventDefault()
      e.stopPropagation()
    }
    addEventListener('keydown', onKey, true)
    return () => removeEventListener('keydown', onKey, true)
  }, [alive.join(','), focus]) // eslint-disable-line react-hooks/exhaustive-deps

  // best-fit: the column count that draws the most image pixels — a trailing
  // hole costs area, so 4 photos land 2×2, not 3+1
  const n = alive.length
  const ar = (() => {
    let s = 0, k = 0
    for (const id of alive) {
      const p = visible.find((q) => q.id === id)
      if (p?.width && p?.height) { s += p.width / p.height; k++ }
    }
    return k ? s / k : 1.5
  })()
  let cols = Math.max(1, Math.ceil(Math.sqrt(n)))
  if (n > 1 && box.w > 0 && box.h > 0) {
    let best = 0
    for (let c = 1; c <= n; c++) {
      const tw = box.w / c
      const th = box.h / Math.ceil(n / c)
      const w = Math.min(tw, th * ar)
      if (w * (w / ar) > best) { best = w * (w / ar); cols = c }
    }
  }

  return (
    <div className="survey">
      <div
        className="svy-grid"
        ref={gridRef}
        style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}
      >
        {alive.map((id) => (
          <Tile
            key={id}
            p={visible.find((p) => p.id === id)}
            isFocus={id === focus}
            onFocus={(x) => { setFocusId(x); select(x) }}
            onHover={(x) => { hoverRef.current = x }}
            onOpen={onOpen}
            onDrop={drop}
          />
        ))}
      </div>
      <p className="view-hint mono">{n} photos · ✕ removes from survey · P X U 0–5 on hovered · Esc grid</p>
    </div>
  )
}
