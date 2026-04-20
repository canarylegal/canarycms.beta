import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

/** Persisted pixel widths for CSS grid tables (main menu, tasks, contacts). */
export function useColumnWidths(storageKey: string, defaults: number[], min = 48) {
  /** Raw JSON last read from localStorage (used to skip a redundant first write after hydrate). */
  const initialRawRef = useRef<string | null>(null)

  const [widths, setWidths] = useState<number[]>(() => {
    try {
      const raw = localStorage.getItem(storageKey)
      initialRawRef.current = raw
      if (raw) {
        const parsed = JSON.parse(raw) as unknown
        if (
          Array.isArray(parsed) &&
          parsed.length === defaults.length &&
          parsed.every((x) => typeof x === 'number' && Number.isFinite(x))
        ) {
          return parsed.map((w, i) => Math.max(min, Math.min(2000, w || defaults[i])))
        }
      }
    } catch {
      /* ignore */
    }
    return [...defaults]
  })

  useEffect(() => {
    try {
      const next = JSON.stringify(widths)
      // Avoid rewriting the same blob on first paint (helps remounts / strict mode / theme toggles).
      if (initialRawRef.current !== null && initialRawRef.current === next) {
        initialRawRef.current = null
        return
      }
      initialRawRef.current = null
      localStorage.setItem(storageKey, next)
    } catch {
      /* ignore */
    }
  }, [storageKey, widths])

  const gridTemplateColumns = useMemo(() => widths.map((w) => `${Math.round(w)}px`).join(' '), [widths])

  const startResize = useCallback(
    (colIndex: number, startClientX: number) => {
      const startW = widths[colIndex]
      function onMove(ev: MouseEvent) {
        const dx = ev.clientX - startClientX
        setWidths((prev) => {
          const n = [...prev]
          n[colIndex] = Math.max(min, startW + dx)
          return n
        })
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [min, widths],
  )

  return { widths, gridTemplateColumns, startResize }
}
