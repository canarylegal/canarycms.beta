import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'

type Offset = { x: number; y: number }

/**
 * Pointer-drag repositioning for modals centered in `.modalOverlay` (grid).
 * Apply `surfaceStyle` to the draggable card and spread `handleProps` on `.modalDragHandle`.
 */
export function useModalDrag(active: boolean) {
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 })
  const offsetRef = useRef<Offset>(offset)
  offsetRef.current = offset

  useEffect(() => {
    if (!active) {
      setOffset({ x: 0, y: 0 })
    }
  }, [active])

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)

    const startX = e.clientX
    const startY = e.clientY
    const ox = offsetRef.current.x
    const oy = offsetRef.current.y

    function move(ev: PointerEvent) {
      setOffset({
        x: ox + ev.clientX - startX,
        y: oy + ev.clientY - startY,
      })
    }

    function up() {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      try {
        handle.releasePointerCapture(e.pointerId)
      } catch {
        /* already released */
      }
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }, [])

  const surfaceStyle: CSSProperties =
    offset.x !== 0 || offset.y !== 0
      ? { transform: `translate(${offset.x}px, ${offset.y}px)` }
      : {}

  return {
    handleProps: {
      onPointerDown,
      style: { touchAction: 'none' as const },
    },
    surfaceStyle,
  }
}
