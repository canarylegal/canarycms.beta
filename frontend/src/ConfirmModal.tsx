import { useEffect } from 'react'
import { useModalDrag } from './useModalDrag'

interface Props {
  open: boolean
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmModal({
  open,
  title,
  message,
  confirmLabel = 'OK',
  cancelLabel = 'Cancel',
  danger,
  busy,
  onConfirm,
  onCancel,
}: Props) {
  const drag = useModalDrag(open)

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onCancel])

  if (!open) return null

  const { style: dragTitleStyle, ...dragTitleRest } = drag.handleProps

  return (
    <div
      className="modalOverlay"
      style={{ zIndex: 30 }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirmModalTitle"
    >
      <div className="modal card modalSurfaceDraggable" style={{ maxWidth: 420, padding: 20, ...drag.surfaceStyle }}>
        <h2
          id="confirmModalTitle"
          className="modalDragHandle"
          {...dragTitleRest}
          style={{ ...dragTitleStyle, margin: '0 0 12px', fontSize: 18 }}
        >
          {title}
        </h2>
        <p style={{ margin: '0 0 20px', lineHeight: 1.45, whiteSpace: 'pre-wrap' }}>{message}</p>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`btn${danger ? ' danger' : ' primary'}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
