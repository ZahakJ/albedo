import { useEffect } from 'react'
import { registry, CATEGORIES } from '../state/commands.js'

// '?' overlay. Single source of truth: the same registry the palette runs.
// Any key (or click) dismisses; capture-phase so the router never hears it.

export default function CheatSheet({ onClose }) {
  useEffect(() => {
    const onKey = (e) => {
      if (['Shift', 'Meta', 'Control', 'Alt'].includes(e.key)) return
      if (!(e.metaKey || e.ctrlKey)) e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    addEventListener('keydown', onKey, true)
    return () => removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <div className="overlay-scrim scrim-sheet" onPointerDown={onClose}>
      <div className="cheat-card" role="dialog" aria-label="Keyboard shortcuts">
        {CATEGORIES.map(([id, label]) => {
          const rows = registry.filter((c) => c.category === id && c.shortcut && !c.noSheet)
          if (!rows.length) return null
          return (
            <section className="cheat-group" key={id}>
              <h3 className="panel-header">{label}</h3>
              {rows.map((c) => (
                <div className="cheat-row" key={c.id}>
                  <span className="cheat-title">{c.title}</span>
                  <span className="cheat-key mono">{c.shortcut}</span>
                </div>
              ))}
            </section>
          )
        })}
      </div>
    </div>
  )
}
