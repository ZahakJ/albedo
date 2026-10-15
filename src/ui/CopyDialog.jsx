import { useEffect, useRef, useState } from 'react'
import { getState as getEditState } from '../state/editStore.js'
import { GROUPS, nonDefaultGroupIds, pickGroups, setClipboard } from '../state/presetStore.js'

// ⌘C module picker (LR-style). Prechecked to the doc's non-default groups;
// Enter = copy exactly what's checked. A checked-but-default group copies
// defaults, so pasting it resets that group on the target.

export default function CopyDialog({ onClose }) {
  const doc = getEditState().doc // static read: dialog is modal + short-lived
  const [checked, setChecked] = useState(() => new Set(nonDefaultGroupIds(doc)))

  const confirm = () => {
    if (checked.size) setClipboard(pickGroups(doc, [...checked]))
    onClose()
  }
  const confirmRef = useRef(confirm)
  confirmRef.current = confirm

  useEffect(() => {
    const onKey = (e) => {
      // native Enter on a focused button must win (Cancel stays cancel)
      if (e.target instanceof Element && e.target.closest('button')) return
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); confirmRef.current() }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
    }
    addEventListener('keydown', onKey, true)
    return () => removeEventListener('keydown', onKey, true)
  }, [onClose])

  const toggle = (id) => setChecked((s) => {
    const n = new Set(s)
    n.has(id) ? n.delete(id) : n.add(id)
    return n
  })

  return (
    <div
      className="overlay-scrim scrim-palette"
      onPointerDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="copydlg" role="dialog" aria-label="Copy settings">
        <h3 className="panel-header">COPY SETTINGS</h3>
        <div className="copy-groups">
          {GROUPS.map((g) => (
            <label key={g.id} className="copy-check">
              <input
                type="checkbox"
                checked={checked.has(g.id)}
                onChange={() => toggle(g.id)}
              />
              {g.label}
            </label>
          ))}
        </div>
        <div className="copy-actions">
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn-primary" disabled={!checked.size} onClick={confirm}>
            Copy ↵
          </button>
        </div>
      </div>
    </div>
  )
}
