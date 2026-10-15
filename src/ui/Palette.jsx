import { useEffect, useMemo, useRef, useState } from 'react'
import { getAllCommands, scoreMatch } from '../state/commands.js'

// ⌘K palette. The registry is re-read per keystroke — rows carry their own
// `when`, so what's listed is exactly what can run right now. Max 12 rows,
// no virtualization needed.

export default function Palette({ onClose }) {
  const [q, setQ] = useState('')
  const [at, setAt] = useState(0)
  const inputRef = useRef(null)
  useEffect(() => { inputRef.current?.focus() }, [])

  const matches = useMemo(() => (
    getAllCommands()
      .map((c) => [scoreMatch(q, c), c])
      .filter(([s]) => s > 0)
      .sort((a, b) => b[0] - a[0]) // stable: registry order breaks ties
      .slice(0, 12)
      .map(([, c]) => c)
  ), [q])
  const sel = Math.max(0, Math.min(at, matches.length - 1))

  const run = (c) => { onClose(); c.run?.() }

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setAt(Math.min(sel + 1, matches.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setAt(Math.max(sel - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); if (matches[sel]) run(matches[sel]) }
    else if (e.key === 'Escape' || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k')) {
      e.preventDefault()
      onClose()
    }
  }

  return (
    <div
      className="overlay-scrim scrim-palette"
      onPointerDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="palette" role="dialog" aria-label="Command palette">
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Type a command…"
          value={q}
          spellCheck={false}
          onChange={(e) => { setQ(e.target.value); setAt(0) }}
          onKeyDown={onKeyDown}
        />
        {matches.length ? (
          <ul className="palette-list">
            {matches.map((c, i) => (
              <li
                key={c.id}
                className={`pal-row${i === sel ? ' is-at' : ''}`}
                onPointerEnter={() => setAt(i)}
                onPointerDown={(e) => { e.preventDefault(); run(c) }}
              >
                <span className="pal-tick" aria-hidden="true" />
                <span className="pal-title">{c.title}</span>
                {c.shortcut && <span className="pal-key mono">{c.shortcut}</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="pal-none">No matching command</p>
        )}
      </div>
    </div>
  )
}
