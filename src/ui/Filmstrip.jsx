import { memo, useRef, useState, useEffect } from 'react'
import { useViewState, select } from '../state/viewStore.js'
import { useThumb } from './useThumb.js'
import { uiScale } from './uiScale.js'

// Horizontally-virtualized filmstrip, docked under both surfaces. Fixed-width
// square slots keep the math O(1); items position via transform only. Slot
// sizes are the CSS ones (filmstrip.css) times --ui-scale.

const OVERSCAN = 4

const SCell = memo(function SCell({ p, x, isSel, onOpen, onMenu }) {
  const { url, wasSeen, markSeen, onError } = useThumb(p.id, p.thumbState)
  const [painted, setPainted] = useState(wasSeen)
  return (
    <div
      className={`scell${isSel ? ' is-sel' : ''}${(p.flag ?? 0) === -1 ? ' is-rejected' : ''}`}
      style={{ transform: `translateX(${x}px)` }}
      data-id={p.id}
      onPointerDown={(e) => { if (e.button === 0) select(p.id) }}
      onDoubleClick={() => onOpen(p)}
      onContextMenu={(e) => onMenu?.(e, p)}
    >
      {url && (
        <img
          className={painted ? 'is-in' : ''}
          src={url}
          alt=""
          draggable={false}
          onLoad={() => { markSeen(); setPainted(true) }}
          onError={onError}
        />
      )}
      {p.colorLabel && <span className={`sbar dot-${p.colorLabel}`} aria-hidden="true" />}
    </div>
  )
})

export default function Filmstrip({ photos, onOpen, onMenu }) {
  const { selectedId, selection } = useViewState()
  const scrollerRef = useRef(null)
  const [w, setW] = useState(0)
  const [left, setLeft] = useState(0)
  const rafRef = useRef(0)
  const [scale] = useState(uiScale)
  const ITEM = 64 * scale
  const GAP = 4 * scale
  const PAD = 8 * scale

  useEffect(() => {
    const el = scrollerRef.current
    const obs = new ResizeObserver(([e]) => { if (e.contentRect.width > 0) setW(e.contentRect.width) })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  const onScroll = () => {
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      setLeft(scrollerRef.current.scrollLeft)
    })
  }

  // selection follows the store (instant, no smooth scroll)
  useEffect(() => {
    const el = scrollerRef.current
    const i = photos.findIndex((p) => p.id === selectedId)
    if (i < 0 || !el) return
    const x = PAD + i * (ITEM + GAP)
    if (x < el.scrollLeft + PAD) el.scrollLeft = x - PAD
    else if (x + ITEM > el.scrollLeft + el.clientWidth - PAD)
      el.scrollLeft = x + ITEM + PAD - el.clientWidth
  }, [selectedId, photos, ITEM, GAP, PAD])

  // the focused cell's border is a single sliding box (transform-only, 90ms)
  const selAt = photos.findIndex((p) => p.id === selectedId)

  const first = Math.max(0, Math.floor((left - PAD) / (ITEM + GAP)) - OVERSCAN)
  const last = Math.min(photos.length - 1, Math.ceil((left + w - PAD) / (ITEM + GAP)) + OVERSCAN)
  const items = []
  for (let i = first; i <= last; i++) {
    items.push(
      <SCell
        key={photos[i].id}
        p={photos[i]}
        x={PAD + i * (ITEM + GAP)}
        isSel={selection.has(photos[i].id)}
        onOpen={onOpen}
        onMenu={onMenu}
      />,
    )
  }

  return (
    <div className="filmstrip">
      <div className="strip-scroller" ref={scrollerRef} onScroll={onScroll}>
        <div className="strip-space" style={{ width: PAD * 2 + photos.length * (ITEM + GAP) - GAP }}>
          {items}
          {selAt >= 0 && (
            <span
              className="strip-sel"
              style={{ transform: `translateX(${PAD + selAt * (ITEM + GAP)}px)` }}
              aria-hidden="true"
            />
          )}
        </div>
      </div>
    </div>
  )
}
