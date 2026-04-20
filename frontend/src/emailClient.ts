/**
 * Outlook on the web / Graph-style open helpers (aligned with canarycms.experimental).
 * Uses the same OWA deeplink shapes as ``emailLauncher.ts``; naming matches the experimental UI.
 */

import { buildOutlookWebReadItemUrl, DEFAULT_OUTLOOK_WEB_MAIL_URL } from './emailLauncher'

/**
 * Build OWA “read item” URL from a Microsoft Graph message id or Exchange REST item id.
 * In practice these identifiers use the same ``AAMk…`` shape for mailbox messages.
 */
export function buildOutlookWebReadUrlFromGraphMessageId(
  graphMessageId: string,
  owaBaseFromUser?: string | null,
): string {
  return buildOutlookWebReadItemUrl(owaBaseFromUser ?? null, graphMessageId)
}

/**
 * Open a full ``https://…`` Outlook URL in a new tab; returns whether a window was created.
 * Do not pass ``noopener`` in the features string: many browsers return ``null`` from ``window.open``
 * while still opening the tab, which would falsely imply a popup blocker.
 */
export function openOutlookWebAppFromGraphWebLink(url: string): boolean {
  const w = window.open(url, '_blank')
  return w != null
}

/**
 * Append ``login_hint`` for tenant SSO flows when opening OWA (experimental parity).
 */
export function appendOutlookWebAuthHintsForNav(url: string, loginHint: string | null | undefined): string {
  const h = (loginHint || '').trim()
  if (!h) return url
  try {
    const base = url.startsWith('http://') || url.startsWith('https://') ? url : `https://${url}`
    const u = new URL(base)
    if (!u.searchParams.has('login_hint')) {
      u.searchParams.set('login_hint', h)
    }
    return u.toString()
  } catch {
    return url
  }
}

export function outlookWebMailBase(owaBaseFromUser: string | null | undefined): string {
  const raw = (owaBaseFromUser || '').trim() || DEFAULT_OUTLOOK_WEB_MAIL_URL
  try {
    const u = new URL(raw.includes('://') ? raw : `https://${raw}`)
    return `${u.origin}/mail/`
  } catch {
    return `${new URL(DEFAULT_OUTLOOK_WEB_MAIL_URL).origin}/mail/`
  }
}
