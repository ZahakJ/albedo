import PanelSection from '../ui/PanelSection.jsx'
import { useCanvasState, cvJump } from '../state/canvasClient.js'

// HISTORY — the worker's undo stack as clickable rows (HistorySection shape).
// Row 0 is the open-document baseline; redo rows sit below, dimmed.

export default function CanvasHistory() {
  const { history } = useCanvasState()
  const done = history.labels
  const redo = history.redoLabels
  const rows = [
    { label: 'Open', at: 0 },
    ...done.map((label, i) => ({ label, at: i + 1 })),
  ]
  const cur = done.length // current depth == rows index of the active row
  return (
    <PanelSection id="cv-history" title="HISTORY">
      <div className="cv-history">
        {rows.map((r, i) => (
          <button
            key={i}
            type="button"
            className={`cv-hist-row${i === cur ? ' is-current' : ''}`}
            onClick={() => cvJump(i - cur)}
          >
            <span className="cv-hist-label">{r.label}</span>
          </button>
        ))}
        {redo.map((label, i) => (
          <button
            key={`r${i}`}
            type="button"
            className="cv-hist-row is-redo"
            onClick={() => cvJump(i + 1)}
          >
            <span className="cv-hist-label">{label}</span>
          </button>
        ))}
      </div>
    </PanelSection>
  )
}
