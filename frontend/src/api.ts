export type ApiError = {
  status: number
  message: string
  body?: unknown
}

/**
 * Direct API origin (no trailing slash), e.g. http://192.168.1.10:8000
 * When unset/empty, URLs are same-origin `/api/...` so Vite (or your reverse proxy) can forward to the backend.
 * That works when you open the app by LAN IP (`http://192.168.x.x:5173`) from any device.
 *
 * Do not set VITE_API_BASE to http://127.0.0.1:8000 if you need LAN access — other machines would call
 * their own localhost and get "NetworkError when attempting to fetch resource."
 */
function apiBasePointsToLoopback(base: string): boolean {
  try {
    const u = new URL(base.includes('://') ? base : `http://${base}`)
    const h = (u.hostname || '').toLowerCase()
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1'
  } catch {
    return false
  }
}

export function getApiOrigin(): string {
  const v = import.meta.env.VITE_API_BASE
  if (typeof v !== 'string') return ''
  const t = v.trim().replace(/\/$/, '')
  if (!t) return ''
  if (typeof window !== 'undefined') {
    const pageHost = (window.location.hostname || '').toLowerCase()
    const pageIsLoopback = pageHost === 'localhost' || pageHost === '127.0.0.1' || pageHost === '[::1]'
    if (!pageIsLoopback && apiBasePointsToLoopback(t)) {
      console.warn(
        '[Canary] VITE_API_BASE is loopback but the page is opened from another host; using same-origin /api (Vite proxy). ' +
          'Remove VITE_API_BASE or set it to this machine’s LAN URL, e.g. http://192.168.1.10:8000',
      )
      return ''
    }
  }
  return t
}

/** Build URL for an API path like `/auth/login` (must start with `/`). */
export function apiUrl(path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`
  const base = getApiOrigin()
  if (base) return `${base}${p}`
  return `/api${p}`
}

/**
 * ``apiUrl`` often returns a same-origin path (``/api/...``). Assigning that to ``window.open('about:blank').location``
 * is unreliable — resolve against the current page origin so navigation and downloads work from a fresh tab.
 */
export function browserAbsoluteApiUrl(urlFromApiUrl: string): string {
  if (urlFromApiUrl.startsWith('http://') || urlFromApiUrl.startsWith('https://')) return urlFromApiUrl
  if (typeof window === 'undefined') return urlFromApiUrl
  return new URL(urlFromApiUrl, window.location.origin).href
}

async function parseJsonSafe(res: Response): Promise<unknown> {
  const text = await res.text()
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

const API_ERROR_BODY_SNIP_LEN = 2000

/** When proxies (Cloudflare, nginx) return HTML for API errors, show a short message instead of the full document. */
function humanizeHtmlErrorBody(text: string, httpFallback: string): string {
  const t = text.trim()
  const looksHtml =
    /^<\!DOCTYPE\b/i.test(t) ||
    /^<html\b/i.test(t) ||
    (t.startsWith('<') && /<\s*head[\s>]/i.test(t.slice(0, 2500)))

  if (!looksHtml) {
    return t.length > API_ERROR_BODY_SNIP_LEN ? `${t.slice(0, API_ERROR_BODY_SNIP_LEN)}…` : t
  }

  const titleMatch = t.match(/<title[^>]*>([^<]{0,400})<\/title>/i)
  const title = (titleMatch?.[1] ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\s*\|\s*/g, ' — ')
    .trim()

  const low = t.toLowerCase()
  const cloudflare =
    low.includes('cloudflare') || low.includes('cf-error-details') || low.includes('/cdn-cgi/')
  const nginx = low.includes('nginx') && !cloudflare

  let msg: string
  if (cloudflare) {
    msg =
      'Cloudflare returned an HTML error page instead of the Canary API — the origin server is usually unreachable, crashed, timed out, or the request was routed to the wrong host (common with HTTP 502).'
  } else if (nginx) {
    msg =
      'A reverse proxy returned an HTML error page instead of JSON — the upstream API may be down or misconfigured.'
  } else {
    msg =
      'The API returned an HTML error page instead of JSON — a proxy or CDN likely could not reach your backend or the route is wrong.'
  }

  if (title) {
    msg += ` (${title.length > 140 ? `${title.slice(0, 140)}…` : title})`
  } else {
    msg += ` (${httpFallback})`
  }

  msg +=
    ' Check that the FastAPI backend is running, that your deploy forwards /api (or your API base URL) to it, and review container or host logs.'

  return msg
}

/** Readable message from error responses: FastAPI `{ detail: ... }`, plain text, or non-JSON bodies. */
export function formatApiErrorDetail(body: unknown, fallback: string): string {
  if (body == null) return fallback
  if (typeof body === 'string') {
    const t = body.trim()
    if (!t) return fallback
    return humanizeHtmlErrorBody(t, fallback)
  }
  if (typeof body !== 'object' || body === null || !('detail' in body)) return fallback
  const d = (body as { detail: unknown }).detail
  if (typeof d === 'string') return d.trim() || fallback
  if (Array.isArray(d)) {
    const parts: string[] = []
    for (const item of d) {
      if (typeof item === 'string') parts.push(item)
      else if (item && typeof item === 'object' && 'msg' in item) {
        const m = (item as { msg?: unknown }).msg
        if (typeof m === 'string') parts.push(m)
      }
    }
    const joined = parts.join(' ').trim()
    return joined || fallback
  }
  if (d && typeof d === 'object') {
    const o = d as Record<string, unknown>
    if (typeof o.message === 'string') return o.message.trim() || fallback
    if (typeof o.locked_by === 'string') return `This file is already being edited by ${o.locked_by}.`
  }
  return fallback
}

export async function apiFetch<T>(
  path: string,
  opts: RequestInit & { token?: string; json?: unknown } = {},
): Promise<T> {
  const headers = new Headers(opts.headers ?? {})
  if (opts.token) headers.set('Authorization', `Bearer ${opts.token}`)
  if (opts.json !== undefined) headers.set('Content-Type', 'application/json')

  const method = (opts.method ?? (opts.json !== undefined ? 'POST' : 'GET')).toUpperCase()
  const body =
    method === 'GET' || method === 'HEAD'
      ? undefined
      : opts.json !== undefined
        ? JSON.stringify(opts.json)
        : opts.body

  const res = await fetch(apiUrl(path), {
    ...opts,
    method,
    headers,
    body,
  })

  if (!res.ok) {
    if (res.status === 401) {
      // Wrong password / 2FA on POST /auth/login also returns 401 — do not reload or we wipe the inline error.
      const isLoginAttempt = path === '/auth/login' || path.endsWith('/auth/login')
      if (!isLoginAttempt) {
        // Token likely expired/was invalidated; force re-login.
        localStorage.removeItem('token')
        if (typeof window !== 'undefined') window.location.reload()
      }
    }
    const body = await parseJsonSafe(res)
    const statusFallback = (res.statusText || '').trim() || `HTTP ${res.status}`
    const msg = (formatApiErrorDetail(body, statusFallback).trim() || statusFallback)
    const err: ApiError = { status: res.status, message: msg, body }
    throw err
  }

  return (await parseJsonSafe(res)) as T
}
