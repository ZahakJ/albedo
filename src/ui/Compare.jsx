import { useEffect, useRef, useState } from 'react'
import { getViewState, setMode } from '../state/viewStore.js'
import { setMeta } from '../state/catalogStore.js'
import { usePreview } from '../state/usePreview.js'

// C — two-up compare: left = SELECT (pinned), right = CANDIDATE. ←/→ cycle
// the candidate through the pool (the multi-selection in grid order, else the
// whole filtered grid), ↑ promotes the candidate to select, pick/reject/rate
// keys act on the CANDIDATE. Esc/G returns to the grid. Capture-phase keys:
// handled ones never reach the app router.

const overlayOpen = () => !!document.querySelector('.overlay-scrim, .confirmdlg, .cmenu')

export const flagGlyph = (flag) => (flag === 1 ? '⚑' : flag === -1 ? '✕' : null)

function Pane({ p, role }) {
  const { url, isPreview } = usePreview(p.id)
  const rating = p.rating ?? 0
  const glyph = flagGlyph(p.flag ?? 0)
  return (
    <figure className="cmp-pane" data-role={role} data-id={p.id}>
      <div className="cmp-stage on-image">
        {url && <img className={`cmp-img${isPreview ? ' is-hi' : ''}`} src={url} alt={p.name} />}
        <span className="view-tag mono" aria-hidden="true">{role}</span>
      </div>
      <figcaption className="cmp-info mono">
        <span className="cmp-name">{p.name}</span>
        <span className="cmp-meta">
          {glyph && <span className={`cmp-flag${p.flag === -1 ? ' is-reject' : ''}`}>{glyph}</span>}
          <span className="cmp-stars">{rating > 0 ? '★'.repeat(rating) : '—'}</span>
        </span>
      </figcaption>
    </figure>
  )
}

export default function Compare({ visible }) {
  // pool frozen at entry — culling the candidate must not reshuffle the deck
  const poolRef = useRef(null)
  if (poolRef.current === null) {
    const sel = getViewState().selection
    const pool = (sel.size >= 2 ? visible.filter((p) => sel.has(p.id)) : visible).map((p) => p.id)
    const at = pool.indexOf(getViewState().selectedId)
    const s = at >= 0 ? pool[at] : pool[0]
    poolRef.current = { pool, s, c: pool[(pool.indexOf(s) + 1) % pool.length] }
  }
  const [{ pool, s, c }, setIds] = useState(poolRef.current)
  // key handler mutates through the ref so back-to-back keystrokes (→ then 4)
  // never act on a stale candidate while React's re-render is still pending
  const apply = (fn) => { poolRef.current = fn(poolRef.current); setIds(poolRef.current) }

  useEffect(() => {
    if (pool.length < 2) { setMode('grid'); return }
    const onKey = (e) => {
      // Library stays mounted under Develop — never steal Develop's keys
      if (getViewState().surface !== 'library') return
      if (e.metaKey || e.ctrlKey || e.altKey || overlayOpen()) return
      const t = e.target
      if (t instanceof Element && (t.closest('input, textarea, select') || t.isContentEditable)) return
      const cand = poolRef.current.c
      const cycle = (d) => apply((v) => {
        let i = v.pool.indexOf(v.c)
        do { i = (i + d + v.pool.length) % v.pool.length } while (v.pool[i] === v.s)
        return { ...v, c: v.pool[i] }
      })
      switch (e.key) {
        case 'ArrowRight': case 'ArrowDown': cycle(1); break
        case 'ArrowLeft': cycle(-1); break
        case 'ArrowUp':
          // promote: candidate becomes the pinned select, next challenger steps up
          apply((v) => {
            let i = v.pool.indexOf(v.c)
            do { i = (i + 1) % v.pool.length } while (v.pool[i] === v.c)
            return { ...v, s: v.c, c: v.pool[i] }
          })
          break
        case 'Escape': setMode('grid'); break
        case 'p': case 'P': setMeta(cand, { flag: 1 }); break
        case 'x': case 'X': setMeta(cand, { flag: -1 }); break
        case 'u': case 'U': setMeta(cand, { flag: 0 }); break
        default:
          if (!/^[0-5]$/.test(e.key)) return // unhandled → app router
          setMeta(cand, { rating: +e.key })
      }
      e.preventDefault()
      e.stopPropagation()
    }
    addEventListener('keydown', onKey, true)
    return () => removeEventListener('keydown', onKey, true)
  }, [pool.length]) // eslint-disable-line react-hooks/exhaustive-deps

  const sp = visible.find((p) => p.id === s)
  const cp = visible.find((p) => p.id === c)
  if (!sp || !cp) return null

  return (
    <div className="compare">
      <div className="cmp-panes">
        <Pane p={sp} role="SELECT" />
        <Pane p={cp} role="CANDIDATE" />
      </div>
      <p className="view-hint mono">← → candidate · ↑ promote · P X U 0–5 rate candidate · Esc grid</p>
    </div>
  )
}
