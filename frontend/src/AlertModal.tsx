import { useEffect } from 'react'
import { useModalDrag } from './useModalDrag'

interface Props {
  open: boolean
  title: string
  message: string
  onClose: () => void
}

export function AlertModal({ open, title, message, onClose }: Props) {
  const drag = useModalDrag(open)

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const { style: dragTitleStyle, ...dragTitleRest } = drag.handleProps

  return (
    <div
      className="modalOverlay"
      style={{ zIndex: 35 }}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="alertModalTitle"
    >
      <div className="modal card modalSurfaceDraggable" style={{ maxWidth: 420, padding: 20, ...drag.surfaceStyle }}>
        <h2
          id="alertModalTitle"
          className="modalDragHandle"
          {...dragTitleRest}
          style={{ ...dragTitleStyle, margin: '0 0 12px', fontSize: 18 }}
        >
          {title}
        </h2>
        <p style={{ margin: '0 0 20px', lineHeight: 1.45, whiteSpace: 'pre-wrap' }}>{message}</p>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn primary" onClick={onClose}>
            OK
          </button>
        </div>
      </div>
    </div>
  )
}
