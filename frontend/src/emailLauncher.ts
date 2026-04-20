import type { UserPublic } from './types'

/** Default Outlook on the web inbox (user may override in settings). */
export const DEFAULT_OUTLOOK_WEB_MAIL_URL = 'https://outlook.office.com/mail'

/**
 * Unfold RFC 822 header lines (continuation lines begin with space or tab).
 */
function unfoldHeaderBlock(block: string): string[] {
  const lines = block.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  for (const line of lines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] = `${out[out.length - 1].trimEnd()} ${line.trim()}`.trim()
    } else {
      out.push(line.trimEnd())
    }
  }
  return out
}

/**
 * Read the first `Message-ID` / `Message-Id` header value from raw RFC822 / .eml text.
 * Returns the trimmed header value (often including angle brackets).
 */
export function extractInternetMessageIdFromEmlText(raw: string): string | null {
  let s = raw.replace(/\r\n/g, '\n')
  /* Skip leading mbox "From sender Thu ..." line if present */
  if (s.startsWith('From ') && s.includes('\n')) {
    const nl = s.indexOf('\n')
    s = s.slice(nl + 1)
  }
  const idx = s.indexOf('\n\n')
  const headerBlock = idx === -1 ? s : s.slice(0, idx)
  if (!headerBlock.trim()) return null
  for (const line of unfoldHeaderBlock(headerBlock)) {
    const m = /^message-id\s*:\s*(.+)$/i.exec(line)
    if (m) {
      const v = m[1].trim()
      return v || null
    }
  }
  return null
}

/**
 * Outlook / Exchange KQL: search by Internet Message ID so OWA can jump to that message
 * if it exists in the user’s mailbox (same ID as in the .eml headers).
 *
 * @see https://learn.microsoft.com/en-us/microsoftsearch/reference-syntax
 */
function kqlInternetMessageId(messageIdHeaderValue: string): string {
  const t = messageIdHeaderValue.trim()
  if (t.startsWith('<') && t.endsWith('>')) {
    return `internetmessageid:${t}`
  }
  return `internetmessageid:<${t}>`
}

/**
 * Build an Outlook on the web URL that opens mailbox search scoped to this Message-ID.
 * The message must exist in the user’s Exchange / M365 mailbox for a result to appear.
 */
export function buildOutlookWebMessageSearchUrl(owaBaseFromUser: string | null | undefined, messageIdHeaderValue: string): string {
  const base = (owaBaseFromUser || '').trim() || DEFAULT_OUTLOOK_WEB_MAIL_URL
  let origin: string
  try {
    const u = new URL(base.includes('://') ? base : `https://${base}`)
    origin = u.origin
  } catch {
    origin = new URL(DEFAULT_OUTLOOK_WEB_MAIL_URL).origin
  }
  const kql = kqlInternetMessageId(messageIdHeaderValue)
  /* “Deeplink search” opens OWA with the search box pre-filled (tenant UI may vary slightly). */
  return `${origin}/mail/deeplink/search?query=${encodeURIComponent(kql)}`
}

/**
 * OWA “open by item” deeplink using the Exchange REST id from Office.context.mailbox.item.itemId.
 * Shape matches current outlook.cloud.microsoft behaviour; adjust if Microsoft changes routing.
 */
export function buildOutlookWebReadItemUrl(owaBaseFromUser: string | null | undefined, restItemId: string): string {
  const base = (owaBaseFromUser || '').trim() || DEFAULT_OUTLOOK_WEB_MAIL_URL
  let origin: string
  try {
    const u = new URL(base.includes('://') ? base : `https://${base}`)
    origin = u.origin
  } catch {
    origin = new URL(DEFAULT_OUTLOOK_WEB_MAIL_URL).origin
  }
  const id = restItemId.trim()
  const enc = encodeURIComponent(id)
  return `${origin}/mail/deeplink/read/${enc}?ItemID=${enc}&exvsurl=1`
}

/**
 * Opens the user's preferred e-mail experience: OS default mail client (`mailto:`) or a web URL.
 */
export function openCanaryEmailLauncher(me: UserPublic | null | undefined): void {
  const pref = me?.email_launch_preference ?? 'desktop'
  if (pref === 'outlook_web') {
    const raw = (me?.email_outlook_web_url ?? '').trim() || DEFAULT_OUTLOOK_WEB_MAIL_URL
    try {
      const u = new URL(raw)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('unsupported scheme')
      window.open(u.toString(), '_blank', 'noopener,noreferrer')
    } catch {
      window.open(DEFAULT_OUTLOOK_WEB_MAIL_URL, '_blank', 'noopener,noreferrer')
    }
    return
  }
  const a = document.createElement('a')
  a.href = 'mailto:'
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}
