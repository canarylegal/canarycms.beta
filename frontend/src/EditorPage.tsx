import { useEffect, useRef, useState } from 'react'
import { apiFetch } from './api'
import { signalCaseFilesChanged } from './caseFilesCrossTab'
import { canaryDocumentTitle } from './tabTitle'

type DocsApiEditor = {
  destroyEditor?: () => void
  /** Requires `events.onDownloadAs`; opens conversion pipeline (e.g. format `"pdf"` for print fallback). */
  downloadAs?: (format?: string) => void
}

type OoConfig = {
  document_server_url: string
  token: string
  document_type: string
  document: Record<string, unknown>
  editor_config: Record<string, unknown>
}

type EditorTarget =
  | { mode: 'case'; caseId: string; fileId: string }
  | { mode: 'precedent'; precedentId: string }

function parseEditorPath(): EditorTarget | null {
  const parts = window.location.pathname.split('/').filter(Boolean)
  // /editor/precedent/{precedentId}
  if (parts[0] === 'editor' && parts[1] === 'precedent' && parts[2]) {
    return { mode: 'precedent', precedentId: parts[2] }
  }
  // /editor/{caseId}/{fileId}
  if (parts[0] === 'editor' && parts[1] && parts[2]) {
    return { mode: 'case', caseId: parts[1], fileId: parts[2] }
  }
  return null
}

function resolveOoScriptBase(apiDocServerUrl: string): string {
  const directUrl = (import.meta.env.VITE_ONLYOFFICE_DIRECT_URL as string | undefined)?.trim()
  if (directUrl) return directUrl.replace(/\/$/, '')

  const directPort = (import.meta.env.VITE_ONLYOFFICE_DIRECT_PORT as string | undefined)?.trim()
  if (directPort && /^\d+$/.test(directPort)) {
    const { protocol, hostname } = window.location
    return `${protocol}//${hostname}:${directPort}`.replace(/\/$/, '')
  }

  const v = (import.meta.env.VITE_ONLYOFFICE_URL as string | undefined)?.trim()
  if (v?.startsWith('/')) return `${window.location.origin.replace(/\/$/, '')}${v}`
  if (v) return v.replace(/\/$/, '')
  return apiDocServerUrl.replace(/\/$/, '')
}

function loadOoScript(base: string): Promise<void> {
  const g = window as Window & { DocsAPI?: unknown }
  if (g.DocsAPI) return Promise.resolve()
  const url = `${base}/web-apps/apps/api/documents/api.js`
  return new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = url
    s.async = true
    s.onload = () => resolve()
    s.onerror = () =>
      reject(
        new Error(
          `Failed to load ONLYOFFICE script from ${url}. ` +
            'Ensure the onlyoffice service is running and the /office-ds Vite proxy is reachable.',
        ),
      )
    document.body.appendChild(s)
  })
}

function formatOoError(event: unknown): string {
  try {
    const e = event as {
      data?: { errorCode?: number; errorDescription?: string } | string
      errorCode?: number
      errorDescription?: string
    }
    const d = e?.data
    if (d && typeof d === 'object' && typeof d.errorCode === 'number') {
      return `ONLYOFFICE (${d.errorCode}): ${(d.errorDescription || '').trim() || 'unknown'}`
    }
    if (typeof e?.errorCode === 'number') {
      return `ONLYOFFICE (${e.errorCode}): ${(e.errorDescription || '').trim() || 'unknown'}`
    }
  } catch { /* ignore */ }
  try {
    return typeof event === 'object' ? JSON.stringify(event) : String(event)
  } catch {
    return 'ONLYOFFICE reported an error (see browser console).'
  }
}

export default function EditorPage() {
  const params = parseEditorPath()
  const [cfg, setCfg] = useState<OoConfig | null>(null)
  const [filename, setFilename] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [pdfExportBusy, setPdfExportBusy] = useState(false)
  const apiRef = useRef<DocsApiEditor | null>(null)
  const pdfExportTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  /** After downloadAs('pdf'): open PDF in new tab (export) vs Canary print-ui tab (print). */
  const pendingDownloadAsRef = useRef<'export' | 'print' | null>(null)
  const printTabRef = useRef<Window | null>(null)
  const token = localStorage.getItem('token') ?? undefined

  // Fetch editor config on mount
  useEffect(() => {
    if (!params) {
      setErr('Invalid editor URL — expected /editor/{caseId}/{fileId} or /editor/precedent/{precedentId}')
      return
    }
    const configUrl = params.mode === 'precedent'
      ? `/precedents/${params.precedentId}/onlyoffice-config`
      : `/cases/${params.caseId}/files/${params.fileId}/onlyoffice-config`
    apiFetch<OoConfig>(configUrl, { token })
      .then((data) => {
        setErr(null)
        setCfg(data)
        setFilename((data.document as { title?: string }).title ?? '')
      })
      .catch((e: unknown) => {
        const m = (e as { message?: string }).message?.trim()
        setErr(m || 'Could not load editor config')
      })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const t = filename.trim()
    if (!t) return
    const previous = document.title
    document.title = canaryDocumentTitle(t)
    return () => {
      document.title = previous
    }
  }, [filename])

  // Host Ctrl/Cmd+P → Canary print path (same as toolbar Print); avoids ONLYOFFICE /printfile PDF MIME issues.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const isP = ev.key === 'p' || ev.key === 'P'
      if (!isP || ev.altKey) return
      if (!ev.ctrlKey && !ev.metaKey) return
      if (!cfg || !apiRef.current?.downloadAs || pdfExportBusy || saving || discarding) return
      ev.preventDefault()
      const w = window.open(
        'about:blank',
        'canary_oo_print',
        'popup=yes,width=1080,height=1440,left=60,top=40',
      )
      printTabRef.current = w
      if (!w) {
        setErr('Print needs a new window — allow pop-ups for this site, then try again.')
        return
      }
      pendingDownloadAsRef.current = 'print'
      setPdfExportBusy(true)
      if (pdfExportTimeoutRef.current !== undefined) clearTimeout(pdfExportTimeoutRef.current)
      pdfExportTimeoutRef.current = window.setTimeout(() => {
        pdfExportTimeoutRef.current = undefined
        pendingDownloadAsRef.current = null
        printTabRef.current = null
        setPdfExportBusy(false)
      }, 120_000)
      try {
        apiRef.current.downloadAs('pdf')
      } catch {
        if (pdfExportTimeoutRef.current !== undefined) clearTimeout(pdfExportTimeoutRef.current)
        pdfExportTimeoutRef.current = undefined
        pendingDownloadAsRef.current = null
        printTabRef.current = null
        setPdfExportBusy(false)
        try {
          w.close()
        } catch {
          /* ignore */
        }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [cfg, pdfExportBusy, saving, discarding])

  // Initialise OO DS editor once config is available
  useEffect(() => {
    if (!cfg) return
    const base = resolveOoScriptBase(cfg.document_server_url)
    let active = true

    loadOoScript(base)
      .then(() => {
        if (!active) return
        const g = window as Window & {
          DocsAPI?: { DocEditor: new (id: string, c: Record<string, unknown>) => DocsApiEditor }
        }
        if (!g.DocsAPI) {
          if (active) setErr('ONLYOFFICE script loaded but DocsAPI is missing')
          return
        }
        apiRef.current?.destroyEditor?.()
        try {
          apiRef.current = new g.DocsAPI.DocEditor('oo-editor-page', {
          documentServerUrl: `${base.replace(/\/$/, '')}/`,
          token: cfg.token,
          document: cfg.document,
          editorConfig: cfg.editor_config,
          type: 'desktop',
          documentType: cfg.document_type,
          width: '100%',
          height: '100%',
          events: {
            onAppReady: () => console.info('[ONLYOFFICE] onAppReady'),
            onDocumentReady: () => console.info('[ONLYOFFICE] onDocumentReady — document rendered OK'),
            onWarning: (event: unknown) => console.warn('[ONLYOFFICE onWarning]', event),
            onError: (event: unknown) => {
              const raw = JSON.stringify(event)
              console.error('[ONLYOFFICE onError] RAW:', raw)
              if (active) setErr(`${formatOoError(event)} | raw: ${raw}`)
            },
            // Required for downloadAs(); Canary Print + Export PDF both use conversion URLs under /cache/files/.
            onDownloadAs: (event: unknown) => {
              if (pdfExportTimeoutRef.current !== undefined) {
                clearTimeout(pdfExportTimeoutRef.current)
                pdfExportTimeoutRef.current = undefined
              }
              const e = event as { data?: { url?: string; fileType?: string } }
              const url = e?.data?.url
              const mode = pendingDownloadAsRef.current
              pendingDownloadAsRef.current = null
              const printWin = printTabRef.current
              printTabRef.current = null

              if (mode === 'print') {
                if (typeof url === 'string' && url.length > 0 && printWin && token) {
                  void (async () => {
                    try {
                      const r = await apiFetch<{ sid: string; t: string }>('/onlyoffice/print-stage', {
                        method: 'POST',
                        token,
                        json: { browser_url: url },
                      })
                      const next = new URL('/oo-print', window.location.origin)
                      next.searchParams.set('sid', r.sid)
                      next.searchParams.set('t', r.t)
                      printWin.location.replace(next.href)
                    } catch (err: unknown) {
                      const msg =
                        (err as { message?: string }).message ??
                        'Print staging failed. Try Export PDF instead.'
                      try {
                        printWin.document.body.textContent = msg
                      } catch {
                        printWin.close()
                      }
                    } finally {
                      setPdfExportBusy(false)
                    }
                  })()
                  return
                }
                try {
                  printWin?.close()
                } catch {
                  /* ignore */
                }
                if (!token) setErr('Sign in again to print.')
                else if (!url) setErr('ONLYOFFICE did not return a PDF URL for print.')
                setPdfExportBusy(false)
                return
              }

              if (typeof url === 'string' && url.length > 0 && mode === 'export') {
                window.open(url, '_blank', 'noopener,noreferrer')
              }
              setPdfExportBusy(false)
            },
          },
        })
        } catch (boot: unknown) {
          if (active) {
            const m = (boot as Error).message?.trim()
            setErr(m || 'Failed to start ONLYOFFICE editor (see browser console).')
          }
        }
      })
      .catch((e: unknown) => {
        if (active) {
          const m = (e as { message?: string }).message?.trim()
          setErr(m || 'Failed to load ONLYOFFICE')
        }
      })

    return () => {
      active = false
      apiRef.current?.destroyEditor?.()
      apiRef.current = null
    }
  }, [cfg]) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSaveAndClose() {
    if (!params || !cfg || saving) return
    const docKey = (cfg.document as { key?: string }).key ?? ''
    if (!docKey) {
      setErr('Editor key missing; cannot save safely. Please reload and try again.')
      return
    }
    setSaving(true)
    try {
      if (params.mode === 'case') {
        await apiFetch(
          `/cases/${params.caseId}/files/${params.fileId}/oo-force-save?doc_key=${encodeURIComponent(docKey)}`,
          { method: 'POST', token },
        )
        await apiFetch(`/cases/${params.caseId}/files/${params.fileId}/publish-compose`, {
          method: 'POST',
          token,
        })
        try {
          window.opener?.postMessage(
            { type: 'canary-files-changed', caseId: params.caseId },
            window.location.origin,
          )
        } catch {
          /* ignore */
        }
        signalCaseFilesChanged(params.caseId)
      } else {
        await apiFetch(
          `/precedents/${params.precedentId}/oo-force-save?doc_key=${encodeURIComponent(docKey)}`,
          { method: 'POST', token },
        )
      }
      window.close()
    } catch (e: unknown) {
      setErr((e as { message?: string }).message ?? 'Save failed. Keep this window open and try again.')
    } finally {
      setSaving(false)
    }
  }

  async function handleDiscard() {
    if (!params || discarding) return
    setConfirmDiscard(false)
    setDiscarding(true)
    try {
      if (params.mode === 'case') {
        await apiFetch(`/cases/${params.caseId}/files/${params.fileId}/discard-edit`, {
          method: 'POST',
          token,
        })
        try {
          window.opener?.postMessage(
            { type: 'canary-files-changed', caseId: params.caseId },
            window.location.origin,
          )
        } catch {
          /* ignore */
        }
        signalCaseFilesChanged(params.caseId)
      }
    } catch {
      // best-effort
    }
    window.close()
  }

  if (!params) {
    return <div style={{ color: '#dc2626', padding: 20 }}>Invalid editor URL</div>
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100vw',
        height: '100vh',
        background: 'var(--page-bg)',
        overflow: 'hidden',
      }}
    >
      {/* Minimal toolbar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 12px',
          background: '#ffffff',
          borderBottom: '1px solid rgba(15,23,42,0.1)',
          flexShrink: 0,
          height: 36,
          boxSizing: 'border-box',
        }}
      >
        <span
          style={{
            color: '#64748b',
            fontSize: 13,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1,
          }}
        >
          {filename}
        </span>
        <button
          type="button"
          title="Opens a print dialog via HTML preview (works when the browser treats ONLYOFFICE PDFs as downloads)."
          onClick={() => {
            if (pdfExportBusy || !apiRef.current?.downloadAs || !cfg) return
            const w = window.open(
              'about:blank',
              'canary_oo_print',
              'popup=yes,width=1080,height=1440,left=60,top=40',
            )
            printTabRef.current = w
            if (!w) {
              setErr('Print needs a new window — allow pop-ups for this site, then try again.')
              return
            }
            pendingDownloadAsRef.current = 'print'
            setPdfExportBusy(true)
            if (pdfExportTimeoutRef.current !== undefined) clearTimeout(pdfExportTimeoutRef.current)
            pdfExportTimeoutRef.current = window.setTimeout(() => {
              pdfExportTimeoutRef.current = undefined
              pendingDownloadAsRef.current = null
              printTabRef.current = null
              setPdfExportBusy(false)
            }, 120_000)
            try {
              apiRef.current.downloadAs('pdf')
            } catch {
              if (pdfExportTimeoutRef.current !== undefined) clearTimeout(pdfExportTimeoutRef.current)
              pdfExportTimeoutRef.current = undefined
              pendingDownloadAsRef.current = null
              printTabRef.current = null
              setPdfExportBusy(false)
              try {
                w.close()
              } catch {
                /* ignore */
              }
            }
          }}
          disabled={pdfExportBusy || saving || discarding || !cfg}
          style={{
            background: 'rgba(15,23,42,0.06)',
            border: '1px solid rgba(15,23,42,0.15)',
            color: '#334155',
            cursor: pdfExportBusy || saving || discarding || !cfg ? 'default' : 'pointer',
            fontSize: 12,
            padding: '3px 10px',
            borderRadius: 4,
            flexShrink: 0,
            opacity: pdfExportBusy || saving || discarding || !cfg ? 0.5 : 1,
            whiteSpace: 'nowrap',
          }}
        >
          {pdfExportBusy ? 'Preparing…' : 'Print'}
        </button>
        <button
          type="button"
          title="Download ONLYOFFICE’s PDF in a new tab (browser PDF handler)."
          onClick={() => {
            if (pdfExportBusy || !apiRef.current?.downloadAs) return
            pendingDownloadAsRef.current = 'export'
            setPdfExportBusy(true)
            if (pdfExportTimeoutRef.current !== undefined) clearTimeout(pdfExportTimeoutRef.current)
            pdfExportTimeoutRef.current = window.setTimeout(() => {
              pdfExportTimeoutRef.current = undefined
              pendingDownloadAsRef.current = null
              setPdfExportBusy(false)
            }, 120_000)
            try {
              apiRef.current.downloadAs('pdf')
            } catch {
              if (pdfExportTimeoutRef.current !== undefined) clearTimeout(pdfExportTimeoutRef.current)
              pdfExportTimeoutRef.current = undefined
              pendingDownloadAsRef.current = null
              setPdfExportBusy(false)
            }
          }}
          disabled={pdfExportBusy || saving || discarding || !cfg}
          style={{
            background: 'rgba(15,23,42,0.06)',
            border: '1px solid rgba(15,23,42,0.15)',
            color: '#334155',
            cursor: pdfExportBusy || saving || discarding || !cfg ? 'default' : 'pointer',
            fontSize: 12,
            padding: '3px 10px',
            borderRadius: 4,
            flexShrink: 0,
            opacity: pdfExportBusy || saving || discarding || !cfg ? 0.5 : 1,
            whiteSpace: 'nowrap',
          }}
        >
          {pdfExportBusy ? 'Preparing PDF…' : 'Export PDF'}
        </button>
        <button
          onClick={() => void handleSaveAndClose()}
          disabled={saving || discarding || !cfg}
          style={{
            background: 'rgba(37,99,235,0.12)',
            border: '1px solid rgba(37,99,235,0.45)',
            color: '#1d4ed8',
            cursor: saving || discarding || !cfg ? 'default' : 'pointer',
            fontSize: 12,
            padding: '3px 10px',
            borderRadius: 4,
            flexShrink: 0,
            opacity: saving || discarding || !cfg ? 0.5 : 1,
            whiteSpace: 'nowrap',
          }}
        >
          {saving ? 'Saving…' : 'Save & Close'}
        </button>
        {confirmDiscard ? (
          <>
            <span style={{ color: '#64748b', fontSize: 12, whiteSpace: 'nowrap' }}>
              Discard all changes?
            </span>
            <button
              onClick={() => void handleDiscard()}
              disabled={discarding}
              style={{
                background: 'rgba(255,77,77,0.15)',
                border: '1px solid rgba(255,77,77,0.6)',
                color: '#dc2626',
                cursor: discarding ? 'default' : 'pointer',
                fontSize: 12,
                padding: '3px 10px',
                borderRadius: 4,
                flexShrink: 0,
                opacity: discarding ? 0.5 : 1,
                whiteSpace: 'nowrap',
              }}
            >
              {discarding ? 'Discarding…' : 'Yes, discard'}
            </button>
            <button
              onClick={() => setConfirmDiscard(false)}
              style={{
                background: 'none',
                border: '1px solid rgba(15,23,42,0.1)',
                color: '#64748b',
                cursor: 'pointer',
                fontSize: 12,
                padding: '3px 10px',
                borderRadius: 4,
                flexShrink: 0,
                whiteSpace: 'nowrap',
              }}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            onClick={() => setConfirmDiscard(true)}
            disabled={discarding || saving}
            style={{
              background: 'none',
              border: '1px solid rgba(220,38,38,0.35)',
              color: '#dc2626',
              cursor: discarding || saving ? 'default' : 'pointer',
              fontSize: 12,
              padding: '3px 10px',
              borderRadius: 4,
              flexShrink: 0,
              opacity: discarding || saving ? 0.5 : 1,
              whiteSpace: 'nowrap',
            }}
          >
            Discard Changes
          </button>
        )}
      </div>

      {err ? (
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#dc2626',
            padding: 24,
            textAlign: 'center',
          }}
        >
          {err}
        </div>
      ) : !cfg ? (
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#64748b',
          }}
        >
          Loading editor…
        </div>
      ) : (
        <div id="oo-editor-page" style={{ flex: 1, minHeight: 0 }} />
      )}
    </div>
  )
}
