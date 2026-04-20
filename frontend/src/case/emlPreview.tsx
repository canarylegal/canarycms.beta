import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import DOMPurify from 'dompurify'
import type { FileSummary } from '../types'

/**
 * Square dialog size in px from the real window (not CSS vmin alone — avoids cascade / iframe quirks).
 * ~70% of the shorter edge, clamped so the box stays on screen.
 */
function computeEmlPreviewSidePx(): number {
  if (typeof window === 'undefined') return 640
  const w = window.innerWidth
  const h = window.innerHeight
  const short = Math.min(w, h)
  const target = Math.round(short * 0.7)
  const maxAllowed = Math.floor(short * 0.92)
  return Math.max(280, Math.min(target, maxAllowed))
}

export type EmlPreviewData = {
  subject: string
  from: string
  to: string
  cc: string
  date: string
  /** Plain-text fallback (and accessibility when HTML is shown). */
  bodyText: string
  /** Raw HTML from the message when available; sanitized before display. */
  bodyHtml?: string
}

function normalizeNewlines(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

/** Parse RFC822 header block into lower-case keys. */
function parseHeaderBlock(block: string): Record<string, string> {
  const lines = block.split('\n')
  const out: Record<string, string> = {}
  let curKey: string | null = null
  for (const line of lines) {
    if (line.startsWith(' ') || line.startsWith('\t')) {
      if (curKey) out[curKey] += ` ${line.trim()}`
      continue
    }
    const m = /^([^:]+):\s*(.*)$/.exec(line)
    if (!m) continue
    curKey = m[1].trim().toLowerCase()
    out[curKey] = m[2].trim()
  }
  return out
}

function decodeQuotedPrintable(input: string): string {
  const t = input.replace(/=\r?\n/g, '')
  return t.replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
}

function decodeBase64ToUtf8(b64: string): string {
  const clean = b64.replace(/\s+/g, '')
  try {
    const bin = atob(clean)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  } catch {
    return b64
  }
}

function extractBoundary(contentType: string): string | null {
  const m = /boundary\s*=\s*("?)([^";\s]+)\1/i.exec(contentType)
  return m ? m[2].trim() : null
}

function htmlToPlainText(html: string): string {
  if (typeof document === 'undefined') return html.replace(/<[^>]+>/g, ' ')
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    return doc.body?.textContent?.replace(/\s+\n/g, '\n').trim() ?? ''
  } catch {
    return html.replace(/<[^>]+>/g, ' ')
  }
}

function decodeBodyPayload(headers: Record<string, string>, body: string): string {
  const enc = (headers['content-transfer-encoding'] || '').toLowerCase()
  if (enc.includes('quoted-printable')) return decodeQuotedPrintable(body)
  if (enc.includes('base64')) return decodeBase64ToUtf8(body)
  return body
}

type Collected = { plain: string[]; htmlRaw: string[] }

/** Max raw .eml size for preview parse (avoids freezing the tab on huge MIME trees). */
export const MAX_EML_PREVIEW_CHARS = 2_000_000

/** HTML passed to DOMPurify for preview (sanitization can be superlinear on pathological HTML). */
const MAX_HTML_SANITIZE_CHARS = 400_000

/**
 * Split a multipart body on RFC 2046 boundaries in linear time.
 * The previous RegExp-based split could take effectively forever on large or degenerate bodies.
 */
function splitMultipartSegmentsLinear(norm: string, boundaryRaw: string): string[] {
  const b = boundaryRaw.replace(/^["']|["']$/g, '').trim()
  if (!b) return []
  const marker = `\n--${b}`
  const rawParts = norm.split(marker)
  const out: string[] = []
  for (let i = 1; i < rawParts.length; i++) {
    let p = rawParts[i]
    if (p.startsWith('--')) break
    if (p.startsWith('\n')) p = p.slice(1)
    if (p === '--') break
    if (p.endsWith('--')) p = p.slice(0, -2)
    p = p.replace(/\s+$/, '')
    if (p.length) out.push(p)
  }
  return out
}

function collectParts(headers: Record<string, string>, body: string, depth: number, into: Collected): void {
  if (depth > 12) return
  const ct = (headers['content-type'] || '').toLowerCase()

  if (ct.includes('multipart/')) {
    const boundary = extractBoundary(headers['content-type'] || '')
    if (!boundary) return
    const norm = normalizeNewlines(body)
    const segments = splitMultipartSegmentsLinear(norm, boundary)
    for (const seg of segments) {
      const t = seg.trim()
      if (!t || t === '--') continue
      const sep = t.indexOf('\n\n')
      if (sep === -1) continue
      const h = parseHeaderBlock(t.slice(0, sep))
      const payload = t.slice(sep + 2)
      collectParts(h, payload, depth + 1, into)
    }
    return
  }

  const decoded = decodeBodyPayload(headers, body)
  if (ct.includes('text/html')) {
    into.htmlRaw.push(decoded)
  } else if (ct.includes('text/plain') || !ct) {
    into.plain.push(decoded.trim())
  } else {
    into.plain.push(decoded.trim())
  }
}

function headerDisplay(headers: Record<string, string>, key: string): string {
  return (headers[key.toLowerCase()] ?? '').trim()
}

let domPurifyLinkHookAdded = false

function sanitizeEmlHtml(html: string): string {
  if (typeof window === 'undefined' || !html.trim()) return ''
  if (html.length > MAX_HTML_SANITIZE_CHARS) {
    return '<p class="muted">HTML body is too large to preview safely. Use <strong>Download</strong> or <strong>Open</strong>.</p>'
  }
  if (!domPurifyLinkHookAdded) {
    DOMPurify.addHook('afterSanitizeAttributes', (node) => {
      if (node.nodeType !== Node.ELEMENT_NODE || node.nodeName !== 'A') return
      const el = node as Element
      if (el.hasAttribute('href')) {
        el.setAttribute('target', '_blank')
        el.setAttribute('rel', 'noopener noreferrer')
      }
    })
    domPurifyLinkHookAdded = true
  }
  /* Default allow-list keeps most mail tags; allow <style> blocks used by HTML e-mail. */
  return DOMPurify.sanitize(html, { ADD_TAGS: ['style'] })
}

/**
 * Best-effort parse of .eml / RFC822 for in-app preview (not a full MIME stack).
 */
export function parseEmlForPreview(raw: string): EmlPreviewData {
  let truncated = false
  let text = normalizeNewlines(raw)
  if (text.length > MAX_EML_PREVIEW_CHARS) {
    truncated = true
    text = text.slice(0, MAX_EML_PREVIEW_CHARS)
  }
  const splitAt = text.indexOf('\n\n')
  if (splitAt === -1) {
    return {
      subject: '',
      from: '',
      to: '',
      cc: '',
      date: '',
      bodyText: text.trim(),
    }
  }
  const topHeaders = parseHeaderBlock(text.slice(0, splitAt))
  const body = text.slice(splitAt + 2)

  const subject = headerDisplay(topHeaders, 'subject')
  const from = headerDisplay(topHeaders, 'from')
  const to = headerDisplay(topHeaders, 'to')
  const cc = headerDisplay(topHeaders, 'cc')
  const date = headerDisplay(topHeaders, 'date')

  const ct0 = (topHeaders['content-type'] || '').toLowerCase()
  if (ct0.includes('multipart/')) {
    return {
      subject,
      from,
      to,
      cc,
      date,
      bodyText:
        'Multipart message — headers are shown above. Use Open or Download for the full body and attachments.',
    }
  }

  const into: Collected = { plain: [], htmlRaw: [] }
  collectParts(topHeaders, body, 0, into)

  let bodyHtml: string | undefined
  let bodyText = ''

  if (into.htmlRaw.length > 0) {
    bodyHtml = into.htmlRaw.sort((a, b) => b.length - a.length)[0]
    bodyText = htmlToPlainText(bodyHtml)
  }
  if (into.plain.length > 0) {
    const bestPlain = into.plain.sort((a, b) => b.length - a.length)[0]
    if (!bodyHtml) {
      bodyText = bestPlain
    }
  }

  if (!bodyHtml && into.plain.length === 0 && into.htmlRaw.length === 0) {
    const dec = decodeBodyPayload(topHeaders, body)
    const ct = (topHeaders['content-type'] || '').toLowerCase()
    if (ct.includes('text/html')) {
      bodyHtml = dec.trim()
      bodyText = htmlToPlainText(bodyHtml)
    } else {
      bodyText = dec.trim()
    }
  }

  if (!bodyHtml && !bodyText) {
    bodyText = decodeBodyPayload(topHeaders, body).trim()
  }

  if (truncated) {
    const note = '[Preview truncated — file is very large. Use Download for the full message.]\n\n'
    bodyText = bodyHtml ? bodyText : note + bodyText
    if (bodyHtml) {
      bodyHtml = `<p class="muted">${note.trim()}</p>${bodyHtml}`
    }
  }

  return {
    subject,
    from,
    to,
    cc,
    date,
    bodyText,
    ...(bodyHtml ? { bodyHtml } : {}),
  }
}

type EmlPreviewModalProps = {
  file: FileSummary
  data: EmlPreviewData | null
  loading: boolean
  error: string | null
  onClose: () => void
  onOpenExternal: () => void
}

export function EmlPreviewModal({ file, data, loading, error, onClose, onOpenExternal }: EmlPreviewModalProps) {
  const [sidePx, setSidePx] = useState(() => computeEmlPreviewSidePx())

  useEffect(() => {
    function onResize() {
      setSidePx(computeEmlPreviewSidePx())
    }
    onResize()
    window.addEventListener('resize', onResize)
    window.visualViewport?.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      window.visualViewport?.removeEventListener('resize', onResize)
    }
  }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const modalFrameStyle = useMemo(
    () =>
      ({
        width: sidePx,
        height: sidePx,
        maxWidth: 'min(92vw, 92vh)',
        maxHeight: 'min(92vw, 92vh)',
        boxSizing: 'border-box',
      }) as const,
    [sidePx],
  )

  const safeHtml = useMemo(() => {
    if (!data?.bodyHtml?.trim()) return ''
    return sanitizeEmlHtml(data.bodyHtml)
  }, [data?.bodyHtml])

  const title = data?.subject?.trim() || file.original_filename || 'E-mail preview'

  const overlay = (
    <div
      className="modalOverlay emlPreviewOverlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="eml-preview-title"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="card emlPreviewModal" style={modalFrameStyle} onClick={(e) => e.stopPropagation()}>
        <div className="emlPreviewModalHeader">
          <h2 id="eml-preview-title" className="emlPreviewModalTitle">
            {title}
          </h2>
        </div>

        {loading ? <div className="muted emlPreviewModalPad">Loading preview…</div> : null}
        {error ? (
          <div className="emlPreviewModalPad" style={{ color: 'var(--danger, #b91c1c)' }} role="alert">
            {error}
          </div>
        ) : null}

        {!loading && !error && data ? (
          <div className="emlPreviewModalMain">
            <dl className="emlPreviewMeta">
              {data.from ? (
                <>
                  <dt>From</dt>
                  <dd>{data.from}</dd>
                </>
              ) : null}
              {data.to ? (
                <>
                  <dt>To</dt>
                  <dd>{data.to}</dd>
                </>
              ) : null}
              {data.cc ? (
                <>
                  <dt>Cc</dt>
                  <dd>{data.cc}</dd>
                </>
              ) : null}
              {data.date ? (
                <>
                  <dt>Date</dt>
                  <dd>{data.date}</dd>
                </>
              ) : null}
            </dl>
            <div className="emlPreviewBodyWrap">
              {safeHtml ? (
                <div
                  className="emlPreviewHtml"
                  // Sanitized with DOMPurify
                  dangerouslySetInnerHTML={{ __html: safeHtml }}
                />
              ) : (
                <pre className="emlPreviewBody">{data.bodyText || '—'}</pre>
              )}
            </div>
          </div>
        ) : null}

        <div className="emlPreviewModalFooter">
          <button type="button" className="btn primary" onClick={onOpenExternal} disabled={loading}>
            Open
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )

  /* Portal: avoid .caseShell overflow:hidden and nested layout shrinking a position:fixed overlay. */
  if (typeof document !== 'undefined') {
    return createPortal(overlay, document.body)
  }
  return overlay
}
