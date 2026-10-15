import { useState } from 'react'
import { useEditState, resetModules, isModulesDefault } from '../state/editStore.js'

// Per-section reset. Appears only when the section actually holds an edit, so
// a clean panel stays clean — and one click is one undoable history entry.
function ResetBtn({ names }) {
  const { doc } = useEditState()
  if (!doc || isModulesDefault(doc, names)) return null
  return (
    <button
      type="button"
      className="sec-btn sec-icon reset-btn"
      data-tip="Reset this section" data-tip-key="⌘Z undoes"
      onClick={(e) => { e.stopPropagation(); resetModules(names) }}
    >
      <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M2.4 6a3.6 3.6 0 1 1 1.06 2.55" fill="none" stroke="currentColor"
          strokeWidth="1.3" strokeLinecap="round" />
        <path d="M1 3.4v2.9h2.9" fill="none" stroke="currentColor"
          strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  )
}

// Collapsible panel section; open state persists per-id in localStorage.
// Body stays mounted (canvases keep their bitmaps) — collapse height-animates
// via the grid-template-rows 1fr↔0fr trick (panels.css); the [hidden] attr
// stays on .sec-body as the state hook for CSS and tests.
// action (optional): header-row controls (AUTO buttons, TAT crosshairs, the
// B&W chip) rendered OUTSIDE the collapse button — clicks never toggle.

const KEY = (id) => `albedo.sec.${id}`

export default function PanelSection({ id, title, action, resets, children }) {
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(KEY(id)) !== '0' } catch { return true }
  })
  const toggle = () => {
    const next = !open
    setOpen(next)
    try { localStorage.setItem(KEY(id), next ? '1' : '0') } catch { /* private mode */ }
  }
  return (
    <section className={`panel-section sec${open ? ' is-open' : ''}`} data-sec={id}>
      <div className="sec-row">
        <button type="button" className="sec-head" aria-expanded={open} onClick={toggle}>
          <svg className="sec-caret" width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
            <path d="M2 0.8l4 3.2-4 3.2z" fill="currentColor" />
          </svg>
          <span className="panel-header sec-title">{title}</span>
        </button>
        {(action != null || resets) && (
          <span className="sec-actions">
            {action}
            {resets && <ResetBtn names={resets} />}
          </span>
        )}
      </div>
      <div className="sec-body" hidden={!open}>
        <div className="sec-inner">{children}</div>
      </div>
    </section>
  )
}
