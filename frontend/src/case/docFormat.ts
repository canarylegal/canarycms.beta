import type { CaseOut } from '../types'

export function formatDocModified(s: string) {
  const d = new Date(s)
  if (isNaN(d.getTime())) return s
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString()
}

/** Size column: KB under 1 MiB (same min 1 KB for tiny files as before), then MB / GB using 1024-based units. */
export function formatDocFileSize(bytes: number): string {
  const b = Math.max(0, bytes)
  const KB = 1024
  const MB = KB * 1024
  const GB = MB * 1024
  const trim = (n: number) => n.toFixed(2).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
  if (b >= GB) return `${trim(b / GB)} GB`
  if (b >= MB) return `${trim(b / MB)} MB`
  if (b === 0) return '0 KB'
  return `${Math.max(1, Math.round(b / KB))} KB`
}

export function dndEventHasFiles(e: { dataTransfer: DataTransfer | null }): boolean {
  const dt = e.dataTransfer
  if (!dt?.types?.length) return false
  return Array.from(dt.types).includes('Files')
}

/** Head and sub matter labels joined; ignores placeholder dashes from the API. */
export function matterTypeDisplayLine(caseDetail: CaseOut): string {
  const stripEdgeDashes = (s: string) =>
    s
      .replace(/^[\s\u2014\u2013\u2212\u2011\-.:–]+/g, '')
      .replace(/[\s\u2014\u2013\u2212\u2011\-.:–]+$/g, '')
      .trim()

  const clean = (s: string | null | undefined) => {
    let t = (s ?? '').trim()
    if (!t) return ''
    t = stripEdgeDashes(t)
    if (!t || t === '—' || t === '-' || t === '\u2014' || t === '–' || t === '\u2212') return ''
    return t
  }

  let head = clean(caseDetail.matter_head_type_name)
  let sub = clean(caseDetail.matter_sub_type_name)
  sub = stripEdgeDashes(sub)
  if (head && sub && head.toLowerCase() === sub.toLowerCase()) return head

  if (head && sub) {
    const j = head.indexOf(' — ')
    if (j >= 0) {
      const tail = head.slice(j + 3).trim()
      if (tail && tail.toLowerCase() === sub.toLowerCase()) return head
    }
  }

  const parts = [head, sub].filter(Boolean)
  let out = parts.join(' — ')
  while (out.includes(' — — ')) out = out.replace(/ — — /g, ' — ')
  return out || '—'
}
