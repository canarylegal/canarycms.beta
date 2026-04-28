/** `/oo-print`: PDF.js preview + `window.print()` for staged ONLYOFFICE PDF (see `EditorPage`, backend `onlyoffice`). */
import { useEffect, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { apiUrl, browserAbsoluteApiUrl } from './api'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker

function fetchErrorMessage(res: Response): string {
  return `Could not load print preview (HTTP ${res.status}). Close this tab and try Print again from the editor.`
}

export default function OnlyOfficePrintPage() {
  const hostRef = useRef<HTMLDivElement>(null)
  const [err, setErr] = useState<string | null>(null)
  const [phase, setPhase] = useState<'loading' | 'rendering' | 'ready'>('loading')

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const sp = new URLSearchParams(window.location.search)
    const sid = sp.get('sid')
    const t = sp.get('t')
    if (!sid || !t) {
      setErr('Missing print session. Close this tab and use Print from the in-browser editor again.')
      return
    }

    const pdfHref = browserAbsoluteApiUrl(
      apiUrl(`/onlyoffice/print-staged-pdf?${new URLSearchParams({ sid, t }).toString()}`),
    )

    let cancelled = false

    void (async () => {
      try {
        const res = await fetch(pdfHref, { credentials: 'include' })
        if (!res.ok) {
          if (!cancelled) setErr(fetchErrorMessage(res))
          return
        }
        const buf = await res.arrayBuffer()
        if (cancelled) return

        setPhase('rendering')
        const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise
        if (cancelled) return

        const dpr = Math.min(window.devicePixelRatio || 1, 2)
        for (let p = 1; p <= pdf.numPages; p += 1) {
          const page = await pdf.getPage(p)
          const base = page.getViewport({ scale: 1 })
          const screenScale = Math.min(1.25, (window.innerWidth - 32) / base.width)
          const viewport = page.getViewport({ scale: screenScale * dpr })

          const canvas = document.createElement('canvas')
          canvas.className = 'oo-print-page-canvas'
          canvas.style.display = 'block'
          canvas.style.margin = '0 auto 16px'
          canvas.style.width = `${viewport.width / dpr}px`
          canvas.style.height = `${viewport.height / dpr}px`

          const ctx = canvas.getContext('2d')
          if (!ctx) {
            if (!cancelled) setErr('Canvas is unavailable in this browser.')
            return
          }
          canvas.width = viewport.width
          canvas.height = viewport.height

          const task = page.render({ canvasContext: ctx, viewport })
          await task.promise
          if (cancelled) return
          host.appendChild(canvas)
        }

        if (cancelled) return
        setPhase('ready')
        requestAnimationFrame(() => {
          setTimeout(() => {
            if (!cancelled) window.print()
          }, 200)
        })
      } catch (e: unknown) {
        if (!cancelled) {
          const m = (e as Error)?.message?.trim()
          setErr(m || 'Failed to prepare print preview.')
        }
      }
    })()

    return () => {
      cancelled = true
      host.replaceChildren()
    }
  }, [])

  if (err) {
    return (
      <div style={{ minHeight: '100vh', padding: 24, fontFamily: 'system-ui, sans-serif', color: '#b91c1c' }}>
        {err}
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100vh', background: '#fff', color: '#0f172a', fontFamily: 'system-ui, sans-serif' }}>
      <style>{`
        @media print {
          .oo-print-screen-hint { display: none !important; }
          @page { margin: 10mm; }
          .oo-print-page-canvas {
            page-break-after: always;
            max-width: 100% !important;
            height: auto !important;
          }
          .oo-print-page-canvas:last-child { page-break-after: auto; }
        }
      `}</style>
      {phase !== 'ready' ? (
        <p className="oo-print-screen-hint" style={{ padding: 16, color: '#64748b' }}>
          {phase === 'loading' ? 'Loading PDF…' : 'Rendering for print…'}
        </p>
      ) : null}
      <div id="oo-print-host" ref={hostRef} />
    </div>
  )
}
