# In-browser editing (ONLYOFFICE Document Server)

Office formats opened as a normal `https://…` download in the browser are almost always saved to **Downloads**. To avoid that, Canary *can* embed **ONLYOFFICE Document Server**: the document loads in an iframe, and saves go to the Canary backend via a server-to-server callback (no copy in `~/Downloads` from that flow).

Set **`VITE_ONLYOFFICE_URL`** so the browser can load the Document Server SDK (e.g. **`/office-ds`** with the Vite proxy). When opening an office file, the user picks **Edit in browser** or **Edit on desktop** (WebDAV link copied); if `VITE_ONLYOFFICE_URL` is unset, the in-browser option is disabled—see `WEBDAV_DESKTOP_EDIT.md`.

## Docker Compose

The root `docker-compose.yml` includes an `onlyoffice` service and wires:

| Variable | Role |
|----------|------|
| `ONLYOFFICE_JWT_SECRET` | Must match `JWT_SECRET` in the Document Server container. |
| `JWT_IN_BODY` (Document Server) | In Docker Compose, set **`"true"`** on the `onlyoffice` service. Default is **false**; the browser SDK often sends the editor JWT in the **request body** instead of only `Authorization`. If this stays false, the editor can stay **blank** and no `GET /webdav/sessions/...` appears in Canary logs. |
| `ONLYOFFICE_DS_PUBLIC_URL` | Legacy / fallback; API still returns this. In compose it tracks **`ONLYOFFICE_HOST_PORT`** (default **18080** on the host; 8080 is often already in use). Prefer loading the SDK via the Vite **`/office-ds`** proxy. |
| `ONLYOFFICE_APP_URL_INTERNAL` | Base URL for **`callbackUrl`** and **`document.url`** in the JWT. **Compose default:** **unset** → **`http://backend:8000`** (Compose DNS). Set **`ONLYOFFICE_PREFER_IPV4_FOR_DS=1`** on the backend to put **`http://<IPv4>:8000`** in the JWT instead (only if `backend` does not resolve from the Document Server container). Override with **`http://host.docker.internal:8000`** etc. if needed. **Never** set arbitrary LAN IPs (e.g. `http://192.168.x.x:8000`) unless **`ONLYOFFICE_ALLOW_LAN_INTERNAL=1`** and you have proven `curl` from the `onlyoffice` container works. |
| `CANARY_PUBLIC_URL` | Used for **WebDAV checkout links** in the browser, **not** for ONLYOFFICE `document.url` (LAN IPs are often unreachable from another container). |
| `ONLYOFFICE_DOCUMENT_URL` | Optional override for **`document.url`** only, after you prove **`curl` from the `onlyoffice` container** to that URL works. |
| `VITE_ONLYOFFICE_URL` | Browser base for ONLYOFFICE. In compose this is **`/office-ds`**: Vite proxies to Document Server (`ONLYOFFICE_PROXY_TARGET`, default **`http://onlyoffice:80`** in Docker). On the **host** (no Docker for Vite), the proxy defaults to **`http://127.0.0.1:${ONLYOFFICE_HOST_PORT:-18080}`** — not port 8080. |
| `ONLYOFFICE_PROXY_TARGET` | **Vite dev server only** (not bundled): upstream for the `/office-ds` proxy. |

Also set **`ALLOW_PRIVATE_IP_ADDRESS=true`** and **`ALLOW_META_IP_ADDRESS=true`** on the Document Server (see [ONLYOFFICE Docker README](https://github.com/ONLYOFFICE/Docker-DocumentServer/blob/master/README.md)). Without both, **Document Server logs** may show `DNS lookup … is not allowed. Because, It is private IP address` when resolving `backend` → `172.x.x.x`, even though `curl http://backend:8000/health` works.

### Troubleshooting: editor area stays blank (no script error)

The shared `.modalOverlay` uses **CSS Grid** with **`place-items: center`**, so the dialog **does not get a full viewport height**. ONLYOFFICE’s iframe / `height: "100%"` then resolves to **0px** and the editor looks blank. The Canary ONLYOFFICE dialog uses **`.modalOverlayEditor`** (flex + explicit **`height: min(900px, calc(100vh - 24px))`**) so the editor host has a real size.

### Troubleshooting: toolbars visible but document area white / not clickable

1. **`html { zoom: 1.2 }` in `index.css`** — browser zoom on the root breaks **iframe pointer coordinates** for many embedded editors. While the ONLYOFFICE modal is open, Canary temporarily sets **`document.documentElement.style.zoom = '1'`**.

2. **Document Server never downloads the file** — you still need **`GET /webdav/sessions/…`** on the **backend** (from the `onlyoffice` container’s IP), not only `onlyoffice-config` from the browser. If that never appears, leave **`ONLYOFFICE_APP_URL_INTERNAL` unset** (IPv4 literal in JWT) or set **`ONLYOFFICE_DOCUMENT_URL`** / **`ONLYOFFICE_APP_URL_INTERNAL`** explicitly after **`curl` from the `onlyoffice` container** to that base returns **200** on `/health`.

3. Open the browser **developer console** while loading the editor — look for **`[ONLYOFFICE onError]`** / **`[ONLYOFFICE onWarning]`** (we log these from the DocsAPI `events` hook).

### Troubleshooting: “Failed to load ONLYOFFICE script”

1. Ensure the `onlyoffice` container is **running**. First boot can take **several minutes** and needs enough RAM (often **≥ 4 GB** for the Document Server container). The compose **healthcheck** probes **port 80** (`/web-apps/.../api.js` or `/`) because with **`JWT_ENABLED=true`**, internal **`http://127.0.0.1:8000/info/info.json`** often returns **401/403** without a JWT and would incorrectly stay **unhealthy** forever.
2. Use **`VITE_ONLYOFFICE_URL="/office-ds"`** with the Vite **`/office-ds` proxy** (see `vite.config.ts`). The proxy **rewrites `Location` headers** on redirects so the browser does not follow broken absolute redirect URLs.
3. **Restart the frontend dev server** after changing env vars. Check **`docker compose logs canary-frontend`** for **`[vite /office-ds proxy → …]`** if the proxy cannot reach Document Server.
4. If you run `npm run dev` **on the host**, Document Server is published on **`127.0.0.1:18080`** by default (see **`ONLYOFFICE_HOST_PORT`**). Set **`ONLYOFFICE_PROXY_TARGET=http://127.0.0.1:18080`** if the default is wrong for your machine.
5. **HTTPS** Canary + **HTTP** Document Server: prefer the same-origin `/office-ds` proxy, or serve Document Server over HTTPS.

### Troubleshooting: editor opens but stays a **blank skeleton** (no document text)

**Desktop / WebDAV checkout is not what blocks the in-browser editor.** WebDAV `GET` does not require a prior `LOCK`; ONLYOFFICE Document Server loads the file with a simple HTTP GET to `document.url`. If you previously used **Edit on desktop**, end the session with **Stop desktop editing** or rely on **re-use** of the same session — that does not prevent Document Server from fetching the file.

The ONLYOFFICE **chrome** loaded, but Document Server **never successfully downloaded** `document.url` from Canary (WebDAV session URL in the JWT). Common with **`host.docker.internal`** on Linux + **VPN** or odd host routing.

The embedded editor must pass **`documentServerUrl`** (browser → Document Server, e.g. same-origin `/office-ds/`) in addition to the signed JWT; the JWT’s **`type`** should be **`embedded`** for iframe use. Legacy **`.doc`** (Word 97–2003) sometimes fails to convert — test with **`.docx`** first.

**1. Confirm the `onlyoffice` container can reach Canary on the Compose network**

```bash
docker compose exec onlyoffice curl -sS -o /dev/null -w "%{http_code}\n" http://backend:8000/health
```

Expect **`200`**. This is the URL Canary puts in the JWT by default (`http://backend:8000`).

**Do not** assume your **host LAN IP** works from inside a container:

```bash
# Often times out or fails — hairpin / routing; NOT required for ONLYOFFICE when backend:8000 works
docker compose exec onlyoffice curl -sS --max-time 5 -o /dev/null -w "%{http_code}\n" http://192.168.1.10:8000/health
```

If **`backend:8000` fails**, fix Docker networking (same `canary` network for `backend` + `onlyoffice`), not LAN URLs in `.env`.

**Strong fix when `GET /webdav` never appears:** leave **`ONLYOFFICE_APP_URL_INTERNAL` unset** (JWT uses **`http://backend:8000`**) and ensure **`docker compose exec onlyoffice curl -sS -o /dev/null -w "%{http_code}\n" http://backend:8000/health`** returns **200**. If the editor shows **invalid token** / stays blank with no `/webdav` hit, confirm the signed config uses **`editorConfig.lang`** as a **two-letter** code (**`en`**, not **`en-US`**) and **`region`** for **`en-US`** — Canary encodes that. Recreate Document Server after changing **`ALLOW_PRIVATE_IP_ADDRESS`** so **`local.json`** is rewritten: **`docker compose up -d --force-recreate onlyoffice`**. Avoid **192.168…** in the JWT unless you have proven `curl` from `onlyoffice` succeeds.

**2. Watch backend logs while opening “Edit in browser”**

You should see **`GET /webdav/sessions/<uuid>/…`** from the Docker network (e.g. `172.x.x.x`), not only `127.0.0.1` health checks. **No** `/webdav` line → Document Server never pulled the file.

**If you see `POST …/release-edit` right after `onlyoffice-config`:** something released the WebDAV session **before** Document Server fetched `document.url` (the JWT token is then invalid). The frontend **defers** `POST …/release-edit` for several seconds after closing the in-browser editor, and **debounces** opening the editor so React Strict Mode does not create two sessions back-to-back. Do not click **Stop desktop editing** for the same file while the ONLYOFFICE iframe is still loading.

**If you see two `onlyoffice-config` lines for the same file:** the backend **reuses** the same WebDAV session when the same user already holds an active session for that file, so the second JWT still matches the same `document.url` token. (Previously each call created a new session and invalidated the previous token while ONLYOFFICE was still loading.)

**3. Document Server logs**

```bash
docker compose logs onlyoffice --tail 120
```

If you see **`private IP address`**, **`not allowed`**, or **`downloadFile`** errors, ensure Compose sets **`ALLOW_PRIVATE_IP_ADDRESS=true`** and **`ALLOW_META_IP_ADDRESS=true`**, then recreate Document Server: `docker compose up -d --force-recreate onlyoffice`.

**4. Legacy `.doc` (Word 97–2003 binary)**

If **`.docx`** opens but **`.doc`** does not, the issue may be format/conversion. Test with a small **`.docx`**.

## Flow

1. User opens a Word/Excel/PowerPoint (etc.) file → frontend requests `GET /cases/{case_id}/files/{file_id}/onlyoffice-config`.
2. Backend creates the same **checkout / WebDAV session** as desktop editing, builds a JWT editor config whose `document.url` points at `ONLYOFFICE_APP_URL_INTERNAL/webdav/sessions/{token}/…`.
3. ONLYOFFICE loads the doc from the API, user edits in the embedded editor.
4. On save/close, Document Server calls `POST /onlyoffice/callback?case_id=…&file_id=…` with a JWT body; Canary downloads the output URL and writes the file (same as a successful WebDAV `PUT`).

## WebDAV desktop

Choose **Edit on desktop — copy WebDAV link** when opening a document, or use **`POST …/checkout-edit`** from the API. Opening that `https` URL in a browser tab will still tend to download—paste the link **inside** the desktop app instead.
