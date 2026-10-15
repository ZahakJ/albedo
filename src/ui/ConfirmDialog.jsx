import { useEffect, useRef } from 'react'

// Destructive-action confirm (CopyDialog pattern): Enter confirms, Esc cancels,
// scrim click cancels. Confirm button is danger-tinted — deletion is the one
// action albedo cannot undo.

export default function ConfirmDialog({ title, body, confirmLabel, onConfirm, onClose }) {
  const confirmRef = useRef(onConfirm)
  confirmRef.current = onConfirm
  const btnRef = useRef(null)

  // focus the confirm button: Enter lands there natively even when the
  // trigger (a button elsewhere) held focus
  useEffect(() => { btnRef.current?.focus() }, [])

  useEffect(() => {
    const onKey = (e) => {
      if (e.target instanceof Element && e.target.closest('button')) return
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); confirmRef.current() }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
    }
    addEventListener('keydown', onKey, true)
    return () => removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <div
      className="overlay-scrim scrim-palette"
      onPointerDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="copydlg confirmdlg" role="alertdialog" aria-label={title}>
        <h3 className="panel-header">{title}</h3>
        <p className="confirm-body">{body}</p>
        <div className="copy-actions">
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" ref={btnRef} className="btn-primary btn-danger" onClick={onConfirm}>
            {confirmLabel} ↵
          </button>
        </div>
      </div>
    </div>
  )
}
