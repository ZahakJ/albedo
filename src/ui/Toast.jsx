import { useEffect, useRef, useState } from 'react'
import { useToasts, dismissToast } from '../state/toastStore.js'

// Bottom-center toast stack (g-raised, hairline). Click the body to dismiss;
// the optional action button runs then dismisses. Exit is UI-only: a toast
// the store dropped lingers here for one fall+fade beat before unmounting.

export default function ToastHost() {
  const { toasts } = useToasts()
  const [leaving, setLeaving] = useState([])
  const prev = useRef(toasts)

  useEffect(() => {
    const gone = prev.current.filter((t) => !toasts.some((n) => n.id === t.id))
    prev.current = toasts
    if (!gone.length) return
    setLeaving((l) => [...l, ...gone])
    const ids = new Set(gone.map((t) => t.id))
    const ms = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180
    setTimeout(() => setLeaving((l) => l.filter((t) => !ids.has(t.id))), ms)
  }, [toasts])

  if (!toasts.length && !leaving.length) return null
  return (
    <div className="toast-stack" aria-live="polite">
      {[...toasts, ...leaving.filter((t) => !toasts.some((n) => n.id === t.id))].map((t) => {
        const out = !toasts.some((n) => n.id === t.id)
        return (
          <div key={t.id} className={`toast${out ? ' is-leaving' : ''}`} onClick={() => dismissToast(t.id)}>
            <span className="toast-msg">{t.message}</span>
            {t.action && (
              <button
                className="toast-action"
                onClick={(e) => { e.stopPropagation(); dismissToast(t.id); t.action.run() }}
              >{t.action.label}</button>
            )}
          </div>
        )
      })}
    </div>
  )
}
