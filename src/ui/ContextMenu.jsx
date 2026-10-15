import { useSyncExternalStore, useLayoutEffect, useRef, useState } from 'react'

// Generic right-click menu, styled like the palette (g-raised, hairline).
// One instance app-wide: openContextMenu(x, y, items) from anywhere; App
// mounts <ContextMenuHost/>. Item shapes:
//   { label, run, key?, danger?, disabled? }        — plain row
//   { sep: true }                                   — hairline
//   { stars: n, onStars(n) }                        — ★1–5 quick row (0 clears)
//   { colors: c|null, onColor(c|null) }             — 4 label dots
//   { label, items: [...] }                         — submenu (▸)
// Esc / click-away / scroll closes; ↑↓ move, Enter runs, → opens a submenu.

let menu = null // { x, y, items } | null
const listeners = new Set()
const emit = () => { for (const fn of listeners) fn() }
const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn) }

export function openContextMenu(x, y, items) {
  menu = { x, y, items: items.filter(Boolean) }
  emit()
}

export function closeContextMenu() {
  if (!menu) return
  menu = null
  emit()
}

const LABELS = ['red', 'yellow', 'green', 'blue']
const isNav = (it) => !it.sep && !it.disabled

function MenuList({ items, onRun, depth = 0 }) {
  const [at, setAt] = useState(-1)
  const [subAt, setSubAt] = useState(-1) // index whose submenu is open
  const ref = useRef(null)

  // whichever list is deepest owns the keyboard; closing a submenu returns it
  useLayoutEffect(() => { ref.current?.focus() }, [])
  useLayoutEffect(() => { if (subAt === -1) ref.current?.focus() }, [subAt])

  const move = (dir) => {
    const n = items.length
    let i = at
    for (let step = 0; step < n; step++) {
      i = (i + dir + n) % n
      if (isNav(items[i])) break
    }
    setAt(i)
    setSubAt(-1)
  }

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
    else if (e.key === 'ArrowRight') {
      if (items[at]?.items) { e.preventDefault(); setSubAt(at) }
    } else if (e.key === 'ArrowLeft' && depth > 0) { e.preventDefault(); onRun(null) }
    else if (e.key === 'Enter') {
      e.preventDefault()
      const it = items[at]
      if (!it) return
      if (it.items) setSubAt(at)
      else if (it.run) onRun(it)
    } else if (e.key === 'Escape') { e.preventDefault(); closeContextMenu() }
    else if (/^[0-5]$/.test(e.key)) {
      const st = items.find((it) => it.onStars)
      if (st) { e.preventDefault(); onRun({ run: () => st.onStars(+e.key) }) }
    }
    e.stopPropagation()
  }

  return (
    <div className="cmenu" role="menu" tabIndex={-1} ref={ref} onKeyDown={onKeyDown}>
      {items.map((it, i) => {
        if (it.sep) return <div key={i} className="cmenu-sep" aria-hidden="true" />
        if (it.onStars) {
          return (
            <div key={i} className={`cmenu-row cmenu-stars${at === i ? ' is-at' : ''}`}
              role="menuitem" onPointerEnter={() => { setAt(i); setSubAt(-1) }}>
              <span className="cmenu-label">Rate</span>
              <span className="cmenu-starset">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button key={n}
                    className={`star-btn${(it.stars ?? 0) >= n ? ' is-lit' : ''}`}
                    title={`Rate ${'★'.repeat(n)}`}
                    onClick={() => onRun({ run: () => it.onStars(it.stars === n ? 0 : n) })}
                  >★</button>
                ))}
              </span>
            </div>
          )
        }
        if (it.onColor) {
          return (
            <div key={i} className={`cmenu-row cmenu-colors${at === i ? ' is-at' : ''}`}
              role="menuitem" onPointerEnter={() => { setAt(i); setSubAt(-1) }}>
              <span className="cmenu-label">Label</span>
              <span className="cmenu-dotset">
                {LABELS.map((c) => (
                  <button key={c}
                    className={`dot-chip${it.colors === c ? ' is-on' : ''}`}
                    title={`${c} label`}
                    onClick={() => onRun({ run: () => it.onColor(it.colors === c ? null : c) })}
                  ><span className={`gdot dot-${c}`} /></button>
                ))}
              </span>
            </div>
          )
        }
        if (it.items) {
          return (
            <div key={i} className={`cmenu-row cmenu-parent${at === i ? ' is-at' : ''}`}
              role="menuitem" aria-haspopup="menu"
              onPointerEnter={() => { setAt(i); setSubAt(i) }}
              onClick={() => setSubAt(i)}
            >
              <span className="cmenu-label">{it.label}</span>
              <span className="cmenu-caret" aria-hidden="true">▸</span>
              {subAt === i && (
                <div className="cmenu-subwrap">
                  <MenuList items={it.items} depth={1}
                    onRun={(sub) => (sub ? onRun(sub) : setSubAt(-1))} />
                </div>
              )}
            </div>
          )
        }
        return (
          <button key={i}
            className={`cmenu-row${at === i ? ' is-at' : ''}${it.danger ? ' is-danger' : ''}`}
            role="menuitem" disabled={it.disabled}
            onPointerEnter={() => { setAt(i); setSubAt(-1) }}
            onClick={() => { if (!it.disabled) onRun(it) }}
          >
            <span className="cmenu-label">{it.label}</span>
            {it.key && <span className="cmenu-key mono">{it.key}</span>}
          </button>
        )
      })}
    </div>
  )
}

export function ContextMenuHost() {
  const m = useSyncExternalStore(subscribe, () => menu)
  const wrapRef = useRef(null)
  const [pos, setPos] = useState(null)

  // clamp to viewport after first paint (8px margin)
  useLayoutEffect(() => {
    if (!m) { setPos(null); return }
    const el = wrapRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      x: Math.max(8, Math.min(m.x, innerWidth - r.width - 8)),
      y: Math.max(8, Math.min(m.y, innerHeight - r.height - 8)),
    })
  }, [m])

  if (!m) return null
  const run = (it) => { closeContextMenu(); it?.run?.() }

  return (
    <div className="cmenu-scrim"
      onPointerDown={(e) => { if (e.target === e.currentTarget) closeContextMenu() }}
      onContextMenu={(e) => { e.preventDefault(); if (e.target === e.currentTarget) closeContextMenu() }}
      onWheel={closeContextMenu}
    >
      <div ref={wrapRef} className="cmenu-anchor"
        style={{ left: (pos ?? m).x, top: (pos ?? m).y, visibility: pos ? 'visible' : 'hidden' }}>
        <MenuList items={m.items} onRun={run} />
      </div>
    </div>
  )
}
