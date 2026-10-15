import { memo, useRef, useState, useEffect } from 'react'
import { useViewState, getViewState, select, toggleSelect, setSelection, setGridCols } from '../state/viewStore.js'
import { useThumb, noteScrollSpeed } from './useThumb.js'
import { uiScale } from './uiScale.js'

// Hand-rolled virtualized grid. Fixed row height from thumbSize; cells are
// absolutely positioned via transform only; scroll handler does nothing but
// stash scrollTop inside rAF — no layout work on the scroll path.

const GAP = 4
// badges hold scaled type, so the cell width that fits them scales too
const BADGE_MIN_W = 160 * uiScale()

// thumb-materialize stagger: waves of ≤10 slots, 20ms apart; a quiet gap
// resets the wave so late one-off loads don't inherit a stale delay
const stag = { n: 0, t: 0 }
const staggerSlot = () => {
  const now = performance.now()
  if (now - stag.t > 250) stag.n = 0
  stag.t = now
  return stag.n++ % 10
}

const FlagIcon = () => (
  <svg className="gflag" width="10" height="11" viewBox="0 0 10 11" aria-hidden="true">
    <path d="M2 1v9.5" stroke="currentColor" strokeWidth="1.2" fill="none" />
    <path d="M2 1h6.5L6.6 3.1l1.9 2.1H2Z" fill="currentColor" />
  </svg>
)

const CameraIcon = () => (
  <svg width="10" height="9" viewBox="0 0 12 10" aria-hidden="true">
    <path d="M1 2.5h2.2L4.4 1h3.2l1.2 1.5H11a.6.6 0 0 1 .6.6v5.8a.6.6 0 0 1-.6.6H1a.6.6 0 0 1-.6-.6V3.1A.6.6 0 0 1 1 2.5Z"
      fill="none" stroke="currentColor" strokeWidth="1" />
    <circle cx="6" cy="5.7" r="2" fill="none" stroke="currentColor" strokeWidth="1" />
  </svg>
)

// one formatter, built once: toLocale*String with options builds a new
// Intl.DateTimeFormat per call, which a fling pays for every cell it mounts
const DATE_FMT = new Intl.DateTimeFormat(undefined, {
  month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
})
const fmtTaken = (ms) => (ms ? DATE_FMT.format(ms) : null)

const Cell = memo(function Cell({ p, x, y, w, h, isSel, showBadges, onDown, onUp, onOpen, onMenu, onDragStart }) {
  const { url, wasSeen, markSeen, onError } = useThumb(p.id, p.thumbState)
  const [painted, setPainted] = useState(wasSeen)
  const [riseDelay, setRiseDelay] = useState(null) // ms | null — fresh materialize only
  const flag = p.flag ?? 0
  const rating = p.rating ?? 0
  // pop only on a real rating change, not on virtualization remounts
  const prevRating = useRef(rating)
  const pop = prevRating.current !== rating
  useEffect(() => { prevRating.current = rating })

  const taken = showBadges ? fmtTaken(p.takenAt ?? p.importedAt) : null

  return (
    <div
      className={`gcell${isSel ? ' is-sel' : ''}${flag === -1 ? ' is-rejected' : ''}`}
      style={{ transform: `translate(${x}px,${y}px)`, width: w, height: h }}
      data-id={p.id}
      draggable
      onPointerDown={(e) => onDown(e, p)}
      onClick={(e) => onUp(e, p)}
      onDoubleClick={() => onOpen(p)}
      onContextMenu={(e) => onMenu?.(e, p)}
      onDragStart={(e) => onDragStart(e, p)}
    >
      {url ? (
        <img
          className={`gthumb${painted ? ' is-in' : ''}${riseDelay != null ? ' rise' : ''}`}
          style={riseDelay != null ? { animationDelay: `${riseDelay}ms` } : undefined}
          src={url}
          alt=""
          draggable={false}
          onLoad={() => {
            if (!wasSeen) setRiseDelay(staggerSlot() * 20)
            markSeen()
            setPainted(true)
          }}
          onError={onError}
        />
      ) : (
        <span className="gcell-name mono">{p.thumbState === 2 ? p.name : ''}</span>
      )}
      {flag === -1 && <span className="gtick" aria-hidden="true" />}
      {showBadges && (flag === 1 || rating > 0 || p.colorLabel) && (
        <span className="gbadges">
          {flag === 1 && <FlagIcon />}
          {rating > 0 && (
            <span key={rating} className={`gstars${pop ? ' pop' : ''}`}>{'★'.repeat(rating)}</span>
          )}
          {p.colorLabel && <span className={`gdot dot-${p.colorLabel}`} />}
        </span>
      )}
      {showBadges && (
        <span className="ginfo" aria-hidden="true">
          <span className="ginfo-name mono">{p.name}</span>
          <span className="ginfo-meta">
            {taken}
            {p.camera && <> · <CameraIcon /> {p.camera}</>}
          </span>
        </span>
      )}
    </div>
  )
})

export default function Grid({ photos, onOpen, onMenu }) {
  const { selectedId, selection, thumbSize } = useViewState()
  const scrollerRef = useRef(null)
  const [view, setView] = useState({ w: 0, h: 0 })
  const [scrollTop, setScrollTop] = useState(0)
  const lastTop = useRef(0)
  const rafRef = useRef(0)
  const collapseRef = useRef(null) // deferred plain-click collapse of a multi-selection
  const bandRef = useRef(null) // rubber-band drag state
  const [band, setBand] = useState(null) // { x, y, w, h } in content coords

  useEffect(() => {
    const el = scrollerRef.current
    // the Library pane is display:none while Develop is up — a 0×0 report
    // would collapse the grid; keep the last real geometry instead
    const obs = new ResizeObserver(([e]) => {
      if (e.contentRect.width > 0) setView({ w: e.contentRect.width, h: e.contentRect.height })
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  const onScroll = () => {
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      const top = scrollerRef.current.scrollTop
      noteScrollSpeed(Math.abs(top - lastTop.current), scrollerRef.current.clientHeight)
      lastTop.current = top
      setScrollTop(top)
    })
  }

  const cols = Math.max(1, Math.floor((view.w - GAP) / (thumbSize + GAP)))
  const cellW = Math.max(1, Math.floor((view.w - GAP * (cols + 1)) / cols))
  const rowH = thumbSize + GAP
  const rows = Math.ceil(photos.length / cols)
  const showBadges = cellW >= BADGE_MIN_W

  useEffect(() => { setGridCols(cols) }, [cols])

  // keep keyboard selection in view (instant scroll: an instrument, not a page)
  useEffect(() => {
    const el = scrollerRef.current
    const i = photos.findIndex((p) => p.id === selectedId)
    if (i < 0 || !el) return
    const y = GAP + Math.floor(i / cols) * rowH
    if (y < el.scrollTop + GAP) el.scrollTop = y - GAP
    else if (y + rowH > el.scrollTop + el.clientHeight) el.scrollTop = y + rowH - el.clientHeight
  }, [selectedId, cols, rowH]) // eslint-disable-line react-hooks/exhaustive-deps

  const onDown = (e, p) => {
    collapseRef.current = null
    if (e.button !== 0) return
    if (e.shiftKey) {
      const a = photos.findIndex((q) => q.id === getViewState().selectedId)
      const b = photos.findIndex((q) => q.id === p.id)
      if (a < 0) return select(p.id)
      const [lo, hi] = a < b ? [a, b] : [b, a]
      setSelection(photos.slice(lo, hi + 1).map((q) => q.id), p.id)
    } else if (e.metaKey || e.ctrlKey) toggleSelect(p.id)
    else if (getViewState().selection.size > 1 && getViewState().selection.has(p.id)) {
      // plain press inside a multi-selection: keep it — a drag may follow;
      // the collapse lands on click (which a drag suppresses)
      collapseRef.current = p.id
    } else select(p.id)
  }

  const onUp = (e, p) => {
    if (collapseRef.current === p.id && !e.shiftKey && !e.metaKey && !e.ctrlKey) select(p.id)
    collapseRef.current = null
  }

  // HTML5 drag: whole selection when the pressed cell is in it, else that cell
  const onDragStart = (e, p) => {
    collapseRef.current = null
    const v = getViewState()
    const ids = v.selection.has(p.id) ? [...v.selection] : [p.id]
    e.dataTransfer.setData('application/x-albedo-photos', JSON.stringify(ids))
    e.dataTransfer.effectAllowed = 'copy'
    const ghost = document.createElement('div')
    ghost.className = 'drag-ghost mono'
    ghost.textContent = ids.length === 1 ? '1 photo' : `${ids.length} photos`
    document.body.appendChild(ghost)
    try { e.dataTransfer.setDragImage(ghost, 14, 14) } catch { /* synthetic dnd */ }
    setTimeout(() => ghost.remove(), 0)
  }

  // ── rubber-band select on empty grid space ────────────────────────────────
  const bandIds = (r) => {
    const ids = []
    const c0 = Math.max(0, Math.floor((r.x - GAP) / (cellW + GAP)))
    const c1 = Math.min(cols - 1, Math.floor((r.x + r.w) / (cellW + GAP)))
    const r0 = Math.max(0, Math.floor((r.y - GAP) / rowH))
    const r1 = Math.min(rows - 1, Math.floor((r.y + r.h) / rowH))
    for (let row = r0; row <= r1; row++) {
      const cellY = GAP + row * rowH
      if (cellY > r.y + r.h || cellY + thumbSize < r.y) continue
      for (let col = c0; col <= c1; col++) {
        const cellX = GAP + col * (cellW + GAP)
        if (cellX > r.x + r.w || cellX + cellW < r.x) continue
        const i = row * cols + col
        if (i < photos.length) ids.push(photos[i].id)
      }
    }
    return ids
  }

  const bandRect = (b, cx, cy) => {
    const el = scrollerRef.current
    const rect = el.getBoundingClientRect()
    const x = cx - rect.left
    const y = cy - rect.top + el.scrollTop
    return {
      x: Math.min(b.x0, x), y: Math.min(b.y0, y),
      w: Math.abs(x - b.x0), h: Math.abs(y - b.y0),
    }
  }

  const onBandDown = (e) => {
    if (e.button !== 0) return
    if (e.target instanceof Element && e.target.closest('.gcell')) return
    const el = scrollerRef.current
    const rect = el.getBoundingClientRect()
    bandRef.current = {
      x0: e.clientX - rect.left,
      y0: e.clientY - rect.top + el.scrollTop,
      additive: e.metaKey || e.ctrlKey,
      base: new Set(getViewState().selection),
      live: false,
    }
    el.setPointerCapture(e.pointerId)
  }

  const onBandMove = (e) => {
    const b = bandRef.current
    if (!b) return
    const r = bandRect(b, e.clientX, e.clientY)
    if (!b.live && r.w < 4 && r.h < 4) return
    b.live = true
    setBand(r)
    const hit = bandIds(r)
    const ids = b.additive ? [...new Set([...b.base, ...hit])] : hit
    const v = getViewState()
    if (ids.length) setSelection(ids, hit[hit.length - 1] ?? v.selectedId)
    else if (!b.additive) setSelection(v.selectedId != null ? [v.selectedId] : [], v.selectedId)
  }

  const onBandUp = (e) => {
    const b = bandRef.current
    bandRef.current = null
    if (b?.live) setBand(null)
    try { scrollerRef.current.releasePointerCapture(e.pointerId) } catch { /* not captured */ }
  }

  const first = Math.max(0, Math.floor(scrollTop / rowH) - 2)
  const last = Math.min(rows - 1, Math.ceil((scrollTop + view.h) / rowH) + 2)
  const cells = []
  for (let r = first; r <= last; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c
      if (i >= photos.length) break
      cells.push(
        <Cell
          key={photos[i].id}
          p={photos[i]}
          x={GAP + c * (cellW + GAP)}
          y={GAP + r * rowH}
          w={cellW}
          h={thumbSize}
          isSel={selection.has(photos[i].id)}
          showBadges={showBadges}
          onDown={onDown}
          onUp={onUp}
          onOpen={onOpen}
          onMenu={onMenu}
          onDragStart={onDragStart}
        />,
      )
    }
  }

  return (
    <div
      className="grid-scroller"
      ref={scrollerRef}
      onScroll={onScroll}
      onPointerDown={onBandDown}
      onPointerMove={onBandMove}
      onPointerUp={onBandUp}
      onPointerCancel={onBandUp}
    >
      {photos.length === 0 ? (
        <p className="grid-none">No photos match the filter</p>
      ) : (
        <div className="grid-space" style={{ height: GAP + rows * rowH }}>
          {cells}
          {band && (
            <div
              className="gband"
              style={{ transform: `translate(${band.x}px,${band.y}px)`, width: band.w, height: band.h }}
            />
          )}
        </div>
      )}
    </div>
  )
}
