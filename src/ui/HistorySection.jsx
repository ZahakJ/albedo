import { useMemo, useState } from 'react'
import PanelSection from './PanelSection.jsx'
import { useEditState, jumpTo, saveSnapshot, restoreSnapshot } from '../state/editStore.js'
import { describeDiff } from '../engine/docDiff.js'

// HISTORY panel section — the editStore undo ring rendered newest-first, one
// terse docDiff label per step. Click a row to jump anywhere in the ring
// (rows above the current one are the redo side, dimmed). Snapshots (named
// states, stored in the doc) sit above the history rows; the header '+'
// names the current state inline, clicking a snapshot row restores it as one
// ordinary commit.

export default function HistorySection() {
  const { photo, doc, history, historyAt } = useEditState()
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')

  // label i describes history[i-1] → history[i]; row 0 is the opened state
  const labels = useMemo(
    () => history.map((d, i) => (i === 0 ? 'Original' : describeDiff(history[i - 1], d))),
    [history])

  const snapshots = doc?.snapshots ?? []
  const commitName = () => {
    const n = name.trim()
    if (n) saveSnapshot(n)
    setNaming(false)
    setName('')
  }

  return (
    <PanelSection
      id="history"
      title="HISTORY"
      action={photo && doc && (
        <button
          type="button"
          className="sec-btn"
          data-tip="Save snapshot of the current state"
          onClick={() => setNaming(true)}
        >+</button>
      )}
    >
      {!photo || !doc ? <p className="ver-empty">No photo open</p> : (
        <div className="hist-list">
          {naming && (
            <input
              className="hist-input mono"
              autoFocus
              placeholder="Snapshot name"
              value={name}
              aria-label="Snapshot name"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitName()
                else if (e.key === 'Escape') { setNaming(false); setName('') }
                e.stopPropagation()
              }}
              onBlur={() => { setNaming(false); setName('') }}
            />
          )}
          {[...snapshots].reverse().map((s, i) => (
            <div
              key={`${s.at}-${snapshots.length - 1 - i}`}
              className="hist-row hist-snap"
              title="Restore snapshot"
              onClick={() => restoreSnapshot(s)}
            >
              <span className="hist-tick" aria-hidden="true" />
              <svg className="hist-snap-icon" width="9" height="9" viewBox="0 0 9 9" aria-hidden="true">
                <path d="M4.5 0.6l1.2 2.4 2.7.4-2 1.9.5 2.7-2.4-1.3-2.4 1.3.5-2.7-2-1.9 2.7-.4z"
                  fill="none" stroke="currentColor" strokeWidth="0.9" strokeLinejoin="round" />
              </svg>
              <span className="hist-label">{s.name}</span>
            </div>
          ))}
          {labels.map((label, i) => ({ label, i })).reverse().map(({ label, i }) => (
            <div
              key={i}
              className={`hist-row${i === historyAt ? ' is-current' : ''}${i > historyAt ? ' is-ahead' : ''}`}
              onClick={() => jumpTo(i)}
            >
              <span className="hist-tick" aria-hidden="true" />
              <span className="hist-label">{label}</span>
            </div>
          ))}
        </div>
      )}
    </PanelSection>
  )
}
