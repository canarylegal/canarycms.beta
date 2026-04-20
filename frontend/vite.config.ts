import fs from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * API proxy target for `npm run dev` (only used when the browser uses relative `/api/...` URLs).
 * Leave VITE_API_BASE unset (or use a LAN-reachable URL) so devices on the network can log in; loopback
 * VITE_API_BASE breaks fetch when the app is opened via http://<LAN-IP>:5173.
 */
function devProxyTarget(): string {
  const fromEnv = process.env.VITE_DEV_PROXY_TARGET?.trim()
  if (fromEnv) return fromEnv
  try {
    if (fs.existsSync('/.dockerenv')) return 'http://backend:8000'
  } catch {
    /* ignore */
  }
  return 'http://127.0.0.1:8000'
}

const proxyTarget = devProxyTarget()

/** http-proxy instance from Vite's `configure(proxy)` — typed loosely so `tsc` accepts proxyReq / proxyRes. */
type ViteDevProxy = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches http-proxy's untyped event API
  on(event: string, listener: (...args: any[]) => void): void
}

function logProxyUpstreamErrors(proxy: ViteDevProxy, pathLabel: string, target: string) {
  proxy.on('error', (err: Error) => {
    console.error('[vite %s → %s] %s', pathLabel, target, err.message)
  })
}

/** Headers Document Server uses to build same-origin URLs (print, cache, conversion). */
function onlyofficeForwardHeaders(proxy: ViteDevProxy) {
  proxy.on('proxyReq', (proxyReq: any, req: any) => {
    const host = req.headers?.host as string | undefined
    if (host) {
      proxyReq.setHeader('X-Forwarded-Host', host)
      proxyReq.setHeader('X-Forwarded-Proto', 'http')
    }
  })
  proxy.on('proxyReqWs', (proxyReq: any, req: any) => {
    const host = req.headers?.host as string | undefined
    if (host) {
      proxyReq.setHeader('X-Forwarded-Host', host)
      proxyReq.setHeader('X-Forwarded-Proto', 'http')
    }
  })
}

/** ONLYOFFICE Document Server (browser loads /office-ds/web-apps/... through this proxy). */
function onlyofficeProxyTarget(): string {
  const fromEnv = process.env.ONLYOFFICE_PROXY_TARGET?.trim()
  if (fromEnv) return fromEnv
  try {
    if (fs.existsSync('/.dockerenv')) return 'http://onlyoffice:80'
  } catch {
    /* ignore */
  }
  // Match docker-compose default host mapping (${ONLYOFFICE_HOST_PORT:-18080}:80), not 8080.
  const port = process.env.ONLYOFFICE_HOST_PORT?.trim() || '18080'
  return `http://127.0.0.1:${port}`
}

const onlyofficeTarget = onlyofficeProxyTarget()

// One-line hint in `docker compose logs frontend` when debugging 502 / connection errors.
console.log(
  `[Canary vite] proxy: /api /webdav → ${proxyTarget} | ONLYOFFICE /office-ds + root DS paths → ${onlyofficeTarget}`,
)

/*
 * Production (no Vite): your reverse proxy must forward the same paths to Document Server:
 *   /office-ds, /coauthoring, /doc, /web-apps, /sdkjs, /sdkjs-plugins, /fonts, /dictionaries, /cache,
 *   /ConvertService.ashx, and paths starting with /\\d+.\\d+.\\d+ (versioned DS assets).
 * Set X-Forwarded-Host and X-Forwarded-Proto on those proxies so ONLYOFFICE builds correct URLs.
 */

/**
 * ONLYOFFICE nginx often 302-redirects web-apps assets to a versioned path on the *upstream* host.
 * The browser would follow that to e.g. http://onlyoffice:80/... (unreachable). Rewrite to our prefix.
 */
function rewriteDocServerLocation(locationHeader: string, upstreamBase: string): string | null {
  try {
    const base = new URL(upstreamBase.endsWith('/') ? upstreamBase : `${upstreamBase}/`)
    const resolved = new URL(locationHeader.trim(), base)
    const p = resolved.pathname
    const needsOfficeDsPrefix =
      p.startsWith('/web-apps') ||
      p.startsWith('/sdkjs') ||
      p.startsWith('/sdkjs-plugins') ||
      p.startsWith('/fonts') ||
      p.startsWith('/dictionaries') ||
      p.startsWith('/doc') ||
      /^\/\d+\.\d+\.\d+/.test(p)
    if (needsOfficeDsPrefix) {
      return `/office-ds${p}${resolved.search}${resolved.hash}`
    }
  } catch {
    /* ignore */
  }
  return null
}

/**
 * ONLYOFFICE is mounted under `/office-ds` in this app, but the editor often resolves assets as
 * `origin + /web-apps/...`, `origin + /sdkjs/...`, etc. (as if DS were at the site root).
 * Those requests must hit Document Server — otherwise Vite's SPA fallback returns `index.html`, print
 * preview iframes boot the React app + HMR (`[vite] connected from window …`) and stay on "Loading…".
 */
function onlyofficeAtRootProxy(pathLabel: string) {
  return {
    target: onlyofficeTarget,
    changeOrigin: false,
    ws: true,
    timeout: 120_000,
    proxyTimeout: 120_000,
    configure(proxy: ViteDevProxy) {
      const upstream = onlyofficeTarget
      proxy.on('error', (err: Error) => {
        console.error('[vite %s → %s]', pathLabel, upstream, err.message)
      })
      onlyofficeForwardHeaders(proxy)
      proxy.on('proxyRes', (proxyRes: { headers: { location?: string | string[] } }) => {
        const raw = proxyRes.headers.location
        const loc = Array.isArray(raw) ? raw[0] : raw
        if (!loc || typeof loc !== 'string') return
        const next = rewriteDocServerLocation(loc, upstream)
        if (next) proxyRes.headers.location = next
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Listen on all interfaces so http://<LAN-IP>:5173 works (Dockerfile also passes --host 0.0.0.0).
    host: true,
    port: 5173,
    proxy: {
      '/api': {
        target: proxyTarget,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
        configure(proxy) {
          logProxyUpstreamErrors(proxy, '/api', proxyTarget)
          // Preserve the browser origin so the backend can build ONLYOFFICE document.url for client-side
          // fetches (print preview). Without this, changeOrigin makes Host=backend:8000 and links stay on localhost:8000.
          proxy.on('proxyReq', (proxyReq: any, req: any) => {
            const host = req.headers?.host as string | undefined
            if (host) {
              proxyReq.setHeader('X-Forwarded-Host', host)
              proxyReq.setHeader('X-Forwarded-Proto', 'http')
            }
          })
        },
      },
      '/webdav': {
        target: proxyTarget,
        changeOrigin: true,
        configure(proxy) {
          logProxyUpstreamErrors(proxy, '/webdav', proxyTarget)
          proxy.on('proxyReq', (proxyReq: any, req: any) => {
            const host = req.headers?.host as string | undefined
            if (host) {
              proxyReq.setHeader('X-Forwarded-Host', host)
              proxyReq.setHeader('X-Forwarded-Proto', 'http')
            }
          })
        },
      },
      /**
       * ONLYOFFICE sometimes builds absolute URLs as origin + `/doc/...` (document / co-editing WS) instead of
       * `/office-ds/doc/...`. Without this rule, Vite serves the SPA HTML for `/doc/*` → print preview stuck on "Loading…"
       * with no obvious failed requests (200 + HTML).
       */
      '/doc': {
        target: onlyofficeTarget,
        changeOrigin: false,
        ws: true,
        timeout: 120_000,
        proxyTimeout: 120_000,
        configure(proxy) {
          const upstream = onlyofficeTarget
          proxy.on('error', (err: Error) => {
            console.error('[vite /doc → %s]', upstream, err.message)
          })
          onlyofficeForwardHeaders(proxy)
        },
      },
      // Docservice (Node): CommandService, etc. — without this, SPA fallback breaks print preview ("Loading…").
      '/coauthoring': {
        target: onlyofficeTarget,
        changeOrigin: false,
        ws: true,
        timeout: 120_000,
        proxyTimeout: 120_000,
        configure(proxy) {
          const upstream = onlyofficeTarget
          proxy.on('error', (err: Error) => {
            console.error('[vite /coauthoring → %s]', upstream, err.message)
          })
          onlyofficeForwardHeaders(proxy)
        },
      },
      '/web-apps': onlyofficeAtRootProxy('/web-apps'),
      '/sdkjs': onlyofficeAtRootProxy('/sdkjs'),
      '/sdkjs-plugins': onlyofficeAtRootProxy('/sdkjs-plugins'),
      '/fonts': onlyofficeAtRootProxy('/fonts'),
      '/dictionaries': onlyofficeAtRootProxy('/dictionaries'),
      // Same-origin ONLYOFFICE SDK + editor assets (avoids blocked cross-origin script loads).
      '/office-ds': {
        target: onlyofficeTarget,
        // Keep the original Host header from the browser so ONLYOFFICE can build correct absolute URLs
        // for things like `Editor.bin` (otherwise it may fall back to `localhost`).
        changeOrigin: false,
        ws: true,
        timeout: 120_000,
        proxyTimeout: 120_000,
        rewrite: (path) => path.replace(/^\/office-ds/, ''),
        configure(proxy) {
          const upstream = onlyofficeTarget
          proxy.on('error', (err: Error) => {
            console.error('[vite /office-ds proxy → %s]', upstream, err.message)
          })
          // changeOrigin sets Host: onlyoffice, so DS generates http://onlyoffice/cache/… URLs
          // that the browser cannot resolve.  DS uses x-forwarded-host (then host) from the
          // *WebSocket* handshake to build cache URLs via getBaseUrlByConnection — proxyReq covers
          // plain HTTP requests, proxyReqWs covers the WebSocket upgrade where it actually matters.
          // The /cache proxy rule below routes the resulting http://<browser-host>/cache/… URLs.
          function _setForwardedHost(proxyReq: any, req: any) {
            const host = req.headers?.host as string | undefined
            if (!host) return
            // Generate cache URLs against the browser-origin so Editor.bin requests become same-origin
            // (avoid CORS blocks from ONLYOFFICE /cache endpoints).
            proxyReq.setHeader('X-Forwarded-Host', host)
            // We proxy over plain HTTP in docker dev; keep proto stable for DS URL generation.
            proxyReq.setHeader('X-Forwarded-Proto', 'http')
          }
          proxy.on('proxyReq', _setForwardedHost)
          proxy.on('proxyReqWs', _setForwardedHost)
          proxy.on('proxyRes', (proxyRes) => {
            const raw = proxyRes.headers.location
            const loc = Array.isArray(raw) ? raw[0] : raw
            if (!loc || typeof loc !== 'string') return
            const next = rewriteDocServerLocation(loc, upstream)
            if (next) proxyRes.headers.location = next
          })
        },
      },
      // ONLYOFFICE DS embeds absolute cache URLs (http://<X-Forwarded-Host>/cache/…) in editor
      // data.  The service worker fetches those; proxy them back to the DS container.
      '/cache': {
        target: onlyofficeTarget,
        // Preserve original browser host so ONLYOFFICE cache URLs (Editor.bin) generated with that
        // host signature don't get rejected with 403.
        changeOrigin: false,
        configure(proxy) {
          logProxyUpstreamErrors(proxy, '/cache', onlyofficeTarget)
          const _setForwardedHost = (proxyReq: any, req: any) => {
            const host = req.headers?.host
            if (host) {
              proxyReq.setHeader('X-Forwarded-Host', host)
              proxyReq.setHeader('X-Forwarded-Proto', 'http')
            }
          }
          proxy.on('proxyReq', _setForwardedHost)
        },
      },
      // Print / conversion requests from the editor sometimes hit these at the dev origin root.
      '/ConvertService.ashx': {
        target: onlyofficeTarget,
        changeOrigin: false,
        timeout: 120_000,
        proxyTimeout: 120_000,
        configure(proxy) {
          const upstream = onlyofficeTarget
          proxy.on('error', (err: Error) => {
            console.error('[vite /ConvertService.ashx proxy → %s]', upstream, err.message)
          })
          onlyofficeForwardHeaders(proxy)
        },
      },
      /**
       * Document Server 302-redirects some editor requests to a *versioned* path at the site root
       * (e.g. `/7.5.1-23/web-apps/...`) without the `/office-ds` prefix. Those must still reach DS or
       * print preview / assets hang on "Loading…".
       */
      '^/\\d+\\.\\d+\\.\\d+': {
        target: onlyofficeTarget,
        changeOrigin: false,
        ws: true,
        timeout: 120_000,
        proxyTimeout: 120_000,
        configure(proxy) {
          const upstream = onlyofficeTarget
          proxy.on('error', (err: Error) => {
            console.error('[vite ONLYOFFICE version path → %s]', upstream, err.message)
          })
          onlyofficeForwardHeaders(proxy)
          proxy.on('proxyRes', (proxyRes) => {
            const raw = proxyRes.headers.location
            const loc = Array.isArray(raw) ? raw[0] : raw
            if (!loc || typeof loc !== 'string') return
            const next = rewriteDocServerLocation(loc, upstream)
            if (next) proxyRes.headers.location = next
          })
        },
      },
    },
  },
})
