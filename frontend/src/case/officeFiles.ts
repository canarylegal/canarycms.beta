import type { FileSummary } from '../types'

/** E-mail stored as .eml / RFC822 — must match backend ``_row_is_eml_like``. */
export function isEmlLikeFileSummary(f: FileSummary): boolean {
  if ((f.outlook_graph_message_id || '').trim() || (f.outlook_web_link || '').trim()) return true
  const name = (f.original_filename || '').toLowerCase()
  const m = (f.mime_type || '').toLowerCase()
  return name.endsWith('.eml') || m.includes('message/rfc822') || m.includes('rfc822')
}

/**
 * Word / Excel / PowerPoint / ODF / RTF: open in ONLYOFFICE. PDFs always open in the browser (blob tab), not the editor.
 */
export function isOfficeLikeFile(f: FileSummary): boolean {
  const name = f.original_filename.toLowerCase()
  const dot = name.lastIndexOf('.')
  const ext = dot >= 0 ? name.slice(dot + 1) : ''
  const officeExt = new Set([
    'doc',
    'docx',
    'dot',
    'dotx',
    'xls',
    'xlsx',
    'xlsm',
    'xlsb',
    'ppt',
    'pptx',
    'pps',
    'ppsx',
    'odt',
    'ods',
    'odp',
    'rtf',
  ])
  if (officeExt.has(ext)) return true
  const m = (f.mime_type || '').toLowerCase()
  return (
    m.includes('wordprocessing') ||
    m.includes('spreadsheetml') ||
    m.includes('presentationml') ||
    m.includes('msword') ||
    m.includes('ms-powerpoint') ||
    m.includes('ms-excel') ||
    m === 'application/vnd.ms-excel' ||
    m === 'application/vnd.ms-powerpoint'
  )
}
