import { useRef, useState, useEffect } from 'react'
import Grid from './Grid.jsx'
import Navigator from './Navigator.jsx'
import MetadataPanel from './MetadataPanel.jsx'
import Compare from './Compare.jsx'
import Survey from './Survey.jsx'
import Cull from './Cull.jsx'
import { useCatalog, setFilter, setSort } from '../state/catalogStore.js'
import { useViewState } from '../state/viewStore.js'

// Filter model: { flag: 1|-1|0|null, minRating: n|null, colorLabel: str|null,
// search, source, smartId }. flag/minRating/search/source are narrowed by the
// catalog worker; colorLabel isn't in its SQL path yet, so the same predicate
// runs client-side over `photos` — it also keeps optimistic setMeta edits and
// the filter view consistent instantly.
export const matchesFilter = (p, f = {}) =>
  (f.flag == null || (p.flag ?? 0) === f.flag) &&
  (f.minRating == null || f.minRating === 0 || (p.rating ?? 0) >= f.minRating) &&
  (f.colorLabel == null || p.colorLabel === f.colorLabel) &&
  (f.keyword == null || (p.keywords ?? []).includes(f.keyword))

export const isFilterActive = (f = {}) =>
  f.flag != null || (f.minRating ?? 0) > 0 || f.colorLabel != null || !!f.search ||
  f.keyword != null

export const CLEAR_FILTER = {
  flag: null, minRating: null, colorLabel: null, search: null, keyword: null,
}

const FLAG_CHIPS = [
  { value: 1, label: 'Picks' },
  { value: 0, label: 'Unflagged' },
  { value: -1, label: 'Rejects' },
]
const LABELS = ['red', 'yellow', 'green', 'blue']

const SORTS = [
  { key: 'takenAt:desc', label: 'Capture ↓', by: 'takenAt', dir: 'desc' },
  { key: 'takenAt:asc', label: 'Capture ↑', by: 'takenAt', dir: 'asc' },
  { key: 'importedAt:desc', label: 'Import order', by: 'importedAt', dir: 'desc' },
  { key: 'rating:desc', label: 'Rating', by: 'rating', dir: 'desc' },
  { key: 'name:asc', label: 'Filename', by: 'name', dir: 'asc' },
]

// search: instant echo in the field, 200ms debounce into the query
function SearchField({ value }) {
  const [text, setText] = useState(value ?? '')
  const timer = useRef(0)
  useEffect(() => setText(value ?? ''), [value])
  const push = (v) => {
    setText(v)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setFilter({ search: v || null }), 200)
  }
  return (
    <input
      className="search-input mono"
      type="search"
      placeholder="Search — ⌘F"
      value={text}
      spellCheck={false}
      aria-label="Search filename, camera or lens"
      onChange={(e) => push(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          if (text) { clearTimeout(timer.current); setText(''); setFilter({ search: null }) }
          else e.currentTarget.blur()
        } else if (e.key === 'Enter') {
          clearTimeout(timer.current)
          setFilter({ search: text || null })
        }
      }}
    />
  )
}

export default function Library({ photos, visible, filter, onOpen, onMenu, onClearRejects }) {
  const { sort } = useCatalog()
  const { mode } = useViewState()
  const f = filter ?? {}

  // view modes replace the grid wholesale; G/Esc land back here
  if (mode === 'compare') return <Compare visible={visible} />
  if (mode === 'survey') return <Survey visible={visible} onOpen={onOpen} />
  if (mode === 'cull') return <Cull visible={visible} />
  const countWith = (patch) =>
    photos.reduce((n, p) => n + matchesFilter(p, { ...f, ...patch }), 0)
  const sortKey = `${sort.by}:${sort.dir}`

  return (
    <div className="library">
      <Navigator onClearRejects={onClearRejects} />
      <div className="lib-main">
        <div className="filterbar" role="toolbar" aria-label="Filter">
          {FLAG_CHIPS.map(({ value, label }) => (
            <button
              key={label}
              className={`chip${f.flag === value ? ' is-on' : ''}`}
              data-tip={`Show ${label.toLowerCase()} only`} data-tip-key={value === 1 ? 'P' : value === -1 ? 'X' : 'U'}
              onClick={() => setFilter({ flag: f.flag === value ? null : value })}
            >
              {label}
              <span className="chip-count mono">{countWith({ flag: value })}</span>
            </button>
          ))}
          <span className="filter-sep" aria-hidden="true" />
          <div
            className={`chip star-chip${(f.minRating ?? 0) > 0 ? ' is-on' : ''}`}
            role="group"
            aria-label="Minimum rating"
          >
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                className={`star-btn${(f.minRating ?? 0) >= n ? ' is-lit' : ''}`}
                data-tip={`Rated ★ ≥ ${n}`} data-tip-key={`${countWith({ minRating: n })}`}
                onClick={() => setFilter({ minRating: f.minRating === n ? null : n })}
              >★</button>
            ))}
          </div>
          <span className="filter-sep" aria-hidden="true" />
          {LABELS.map((c) => (
            <button
              key={c}
              className={`dot-chip${f.colorLabel === c ? ' is-on' : ''}`}
              data-tip={`${c[0].toUpperCase()}${c.slice(1)} label`} data-tip-key={`${countWith({ colorLabel: c })}`}
              onClick={() => setFilter({ colorLabel: f.colorLabel === c ? null : c })}
            >
              <span className={`gdot dot-${c}`} />
            </button>
          ))}
          {isFilterActive(f) && (
            <button
              className="chip chip-clear"
              data-tip="Clear filters" data-tip-key={'⌥\\'}

              onClick={() => setFilter({ ...CLEAR_FILTER })}
            >Clear</button>
          )}
          <span className="filter-flex" aria-hidden="true" />
          <div className="filter-tail">
            <SearchField value={f.search} />
            <select
              className="sort-select"
              data-tip="Sort order"
              aria-label="Sort order"
              value={sortKey}
              onChange={(e) => {
                const s = SORTS.find((x) => x.key === e.target.value) ?? SORTS[0]
                setSort({ by: s.by, dir: s.dir })
              }}
            >
              {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
            <span className="filter-count mono">{visible.length} / {photos.length}</span>
          </div>
        </div>
        <Grid photos={visible} onOpen={onOpen} onMenu={onMenu} />
      </div>
      <MetadataPanel />
    </div>
  )
}
