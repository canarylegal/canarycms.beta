import type { FileSummary } from '../types'

/** Vimix-doder (regular / non-dark theme) icons in `public/icons/vimix/`. */
export function DocMimeIcon({ mime, filename }: { mime: string; filename?: string }) {
  const m = (mime || '').toLowerCase()
  const ext = (filename || '').toLowerCase().split('.').pop() ?? ''
  let src = '/icons/vimix/file-generic.svg'

  const excelExts = new Set(['xls', 'xlsx', 'xlsm', 'xlsb'])
  const wordExts = new Set(['doc', 'docx', 'dot', 'dotx', 'odt', 'rtf'])

  if (m.includes('pdf')) src = '/icons/vimix/file-pdf.svg'
  else if (m.startsWith('image/')) src = '/icons/vimix/file-image.svg'
  else if (excelExts.has(ext) || m.includes('spreadsheet') || m === 'application/vnd.ms-excel') {
    src = '/icons/vimix/file-office-green.svg'
  } else if (ext === 'xml' || (m.includes('xml') && !m.includes('wordprocessing'))) {
    src = '/icons/vimix/file-office-green.svg'
  } else if (m.startsWith('text/')) src = '/icons/vimix/file-text.svg'
  else if (wordExts.has(ext) || m.includes('wordprocessing') || m.includes('msword')) {
    src = '/icons/vimix/file-office.svg'
  } else if (m.includes('ms-powerpoint') || m.includes('presentation')) src = '/icons/vimix/file-office.svg'
  else if (m.includes('zip') || m.includes('archive')) src = '/icons/vimix/file-archive.svg'

  return <img className="docsVimixIcon" src={src} alt="" aria-hidden />
}

/** Parent .eml row: envelope icon, coloured by sent vs received (distinct from office blue / image green). */
function DocMailIcon({ outbound }: { outbound: boolean }) {
  return (
    <svg
      className={`docsMailGlyph${outbound ? ' docsMailGlyph--out' : ' docsMailGlyph--in'}`}
      viewBox="0 0 24 24"
      width="24"
      height="24"
      aria-hidden
    >
      <path
        fill="currentColor"
        d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"
      />
    </svg>
  )
}

function isCaseMailRootFile(f: FileSummary): boolean {
  if (f.parent_file_id) return false
  const m = (f.mime_type || '').toLowerCase()
  const name = (f.original_filename || '').toLowerCase()
  return m.includes('message/rfc822') || m.includes('rfc822') || name.endsWith('.eml')
}

function caseMailIconOutbound(f: FileSummary): boolean {
  if (f.source_mail_is_outbound === true) return true
  if (f.source_mail_is_outbound === false) return false
  const mbox = (f.source_imap_mbox || '').toLowerCase()
  if (mbox.includes('sent') || mbox.includes('outbox')) {
    if (mbox.includes('unsent')) return false
    return true
  }
  return false
}

export function DocFolderIcon() {
  return (
    <span className="docsFolderIconWrap" aria-hidden>
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" className="docsFolderIconSvg">
        <path
          fill="currentColor"
          d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8c0-1.1-.9-1.99-2-1.99h-8l-2-2z"
        />
      </svg>
    </span>
  )
}

function DocPinIcon() {
  return <img className="docsVimixIcon" src="/icons/vimix/pin.svg" alt="" title="Pinned" aria-hidden />
}

/** Second line in the documents Description column for filed parent .eml (parsed on upload). */
function fileMailFromSubline(f: FileSummary): string | null {
  const n = f.source_mail_from_name?.trim()
  const e = f.source_mail_from_email?.trim()
  if (n && e) return `${n} · ${e}`
  if (e) return e
  if (n) return n
  return null
}

export function DocsFileDescCell({ f, showPin }: { f: FileSummary; showPin: boolean }) {
  const sub = fileMailFromSubline(f)
  const mailRoot = isCaseMailRootFile(f)
  return (
    <div className={sub ? 'docsDescWrapper docsDescWrapper--hasSub' : 'docsDescWrapper'}>
      {mailRoot ? (
        <span className="docsMailIconSlot" aria-hidden>
          <DocMailIcon outbound={caseMailIconOutbound(f)} />
        </span>
      ) : null}
      <div
        className={`docsDescCell${showPin ? ' docsDescCell--pinnedHead' : ''}${sub ? ' docsDescCell--hasSub' : ''}${mailRoot ? ' docsDescCell--mailRoot' : ''}`}
      >
        <div className="docsDescStack">
          <div className="docsDescInner">
            {showPin ? (
              <span className="docsPinIcon">
                <DocPinIcon />
              </span>
            ) : null}
            {mailRoot ? null : (
              <span className="docsTypeIcon" aria-hidden>
                <DocMimeIcon mime={f.mime_type} filename={f.original_filename} />
              </span>
            )}
            <span className="docsDescName">{f.parent_file_id ? `↳ ${f.original_filename}` : f.original_filename}</span>
          </div>
          {sub ? <div className="docsDescSub muted">{sub}</div> : null}
        </div>
      </div>
    </div>
  )
}

export function DocsFolderDescCell({ name }: { name: string }) {
  return (
    <div className="docsDescWrapper">
      <div className="docsDescCell">
        <div className="docsDescStack">
          <div className="docsDescInner">
            <span className="docsTypeIcon" aria-hidden>
              <DocFolderIcon />
            </span>
            <span className="docsDescName">{name}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
