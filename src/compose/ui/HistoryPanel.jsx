import { useEffect, useRef } from 'react'
import PanelSection from '../../ui/PanelSection.jsx'
import { useCompose, jump } from '../../state/composeClient.js'

// HISTORY — every operation is one row; click a row to step there. Steps
// after the current one stay (greyed) until a new operation replaces them.
export default function HistoryPanel() {
  const { history } = useCompose()
  const ref = useRef(null)
  useEffect(() => {
    ref.current?.querySelector('.is-current')?.scrollIntoView({ block: 'nearest' })
  }, [history.at, history.labels.length])
  return (
    <PanelSection id="co-history" title="HISTORY">
      <div className="co-history" ref={ref}>
        {history.labels.map((l, i) => (
          <button
            key={i}
            type="button"
            className={`co-hist${i === history.at ? ' is-current' : ''}${i > history.at ? ' is-redo' : ''}`}
            onClick={() => jump(i)}
          ><span className="co-hist-label">{l}</span></button>
        ))}
      </div>
    </PanelSection>
  )
}
