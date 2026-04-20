import { useEffect, useState } from 'react'
import { useModalDrag } from './useModalDrag'

type Props = {
  title: string
  hint?: string
  initial: string
  confirmLabel: string
  busy?: boolean
  onConfirm: (value: string) => void
  onCancel: () => void
}

/** In-app text entry instead of window.prompt (no browser URL chrome). */
export function TextPromptModal({ title, hint, initial, confirmLabel, busy, onConfirm, onCancel }: Props) {
  const [val, setVal] = useState(initial)
  const drag = useModalDrag(true)
  const { style: dragTitleStyle, ...dragTitleRest } = drag.handleProps
  useEffect(() => {
    setVal(initial)
  }, [initial])

  return (
    <div
      className="modalOverlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="text-prompt-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel()
      }}
    >
      <div
        className="modal card textPromptModal modalSurfaceDraggable"
        style={{ maxWidth: 440, width: 'min(440px, 100%)', ...drag.surfaceStyle }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id="text-prompt-title"
          className="modalDragHandle"
          {...dragTitleRest}
          style={{ ...dragTitleStyle, margin: 0, fontSize: 18 }}
        >
          {title}
        </h2>
        {hint ? (
          <p className="muted" style={{ marginTop: 8, marginBottom: 0 }}>
            {hint}
          </p>
        ) : null}
        <label className="field" style={{ marginTop: 12 }}>
          <span>Name</span>
          <input
            className="allow-select"
            value={val}
            autoFocus
            disabled={busy}
            onChange={(e) => setVal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !busy) onConfirm(val)
              if (e.key === 'Escape' && !busy) onCancel()
            }}
          />
        </label>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button type="button" className="btn" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={busy} onClick={() => onConfirm(val)}>
            {busy ? '…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
