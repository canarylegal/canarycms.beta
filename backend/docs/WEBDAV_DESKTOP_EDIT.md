# Desktop editing via WebDAV

Canary can issue a **short-lived WebDAV session** so users edit case files in **LibreOffice**, a **WebDAV mount**, or other clients that accept a **paste-this-https/http WebDAV URL**. Saves go straight back to the server; the case file version is incremented on each successful `PUT`. For **ONLYOFFICE**, the practical path in this stack is usually **Edit in browser** (Document Server)—see `ONLYOFFICE_BROWSER_EDIT.md`.

**Important:** Opening the WebDAV `https://…` file URL in a normal browser tab usually **downloads** the file to **Downloads**. Paste the URL **inside** a desktop app, or use the **LibreOffice terminal command** returned by `checkout-edit` (see below)—do not rely on the browser navigating to the raw file URL.

## Can the web app open ONLYOFFICE Desktop or LibreOffice automatically?

**Not in a generic, zero-setup way.** A normal website cannot silently launch a desktop program or “pull” a WebDAV session into an office suite: browsers block that for security. Canary **copies the WebDAV URL** and then **probes custom URL schemes** (hidden iframes) such as `onlyoffice://` / `oo-office://`, or schemes you configure with **`VITE_ONLYOFFICE_DESKTOP_URI`** / **`VITE_ONLYOFFICE_DESKTOP_LAUNCH_URIS`** — these are **no-ops** unless your OS or IT registers a handler. ONLYOFFICE does **not** document a generic “paste this WebDAV URL” handoff from a browser; desktop builds often lack that menu entirely—use **Edit in browser**, **LibreOffice**, or a **WebDAV mount**.

Practical options if you need one-click behavior:

- **Windows + Microsoft Office:** some setups support `ms-word:ofe|u|https://…`-style links from the browser (Canary does not emit these today).
- **Custom protocol / `.desktop` handler:** register a URL scheme or MIME handler on each workstation that runs a small script (`libreoffice …` or ONLYOFFICE) with the URL—requires IT packaging.
- **Local helper app:** a desktop wrapper around Canary could call `xdg-open` or spawn the editor with the WebDAV URL.
- **ONLYOFFICE “Connect to cloud” / DMS:** browse Canary from inside ONLYOFFICE Desktop’s web UI (if you expose a compatible portal)—different product integration than “click in Chrome.”

**LibreOffice on Linux:** use **File → Open Remote** (WebDAV) and paste the **file** URL, or run **`libreoffice_cli_hint`** from `POST …/checkout-edit` in a terminal. **ONLYOFFICE Desktop:** many builds **do not** ship a LibreOffice-style “paste this WebDAV `http(s)` URL” entry in the File menu; integration is aimed at **cloud/DMS** (`AscDesktopEditor.execCommand`, Workspace “Add account”, etc.). So you may see **no** `/webdav` hits in Canary logs—not a server bug. Prefer **Edit in browser (ONLYOFFICE)** in Canary, or mount the **folder** URL (below) and open the file in ONLYOFFICE from disk. The **`desktopeditors` CLI only accepts local paths**, not URLs.

## LibreOffice without using the remote dialog

The web UI **copies the WebDAV file URL** to the clipboard after checkout. Paste that into **LibreOffice → File → Open Remote** (WebDAV). For ONLYOFFICE Desktop, use **Edit in browser** or a **WebDAV mount** instead.

Power users can call `POST …/checkout-edit` and run **`libreoffice_cli_hint`** in a terminal: it uses **`lowriter` / `localc` / `limpress`**, not the generic `libreoffice` binary—on some Linux setups `libreoffice` is wired (alternatives/wrapper) to **ONLYOFFICE** or another app. There is **no** equivalent ONLYOFFICE terminal script for remote URLs.

**True one-click from the browser** (no paste, no terminal) still needs extra setup: a **custom URL scheme** + OS handler, a **dedicated desktop Canary client** that spawns the editor, or (on some Windows setups) **Microsoft Office** protocol links—not something a plain HTTPS site can do alone.

## Flow

1. For **Word / Excel / PowerPoint / ODF / RTF**, **Open** shows a small dialog: **Edit in browser (ONLYOFFICE)** if **`VITE_ONLYOFFICE_URL`** is set (loads Document Server; see `ONLYOFFICE_BROWSER_EDIT.md`), or **Edit on desktop** which checks out and **copies the WebDAV URL** to the clipboard.
2. For PDFs, images, etc., **Open in browser** still uses a tab preview when the browser supports it.
3. The file context menu still offers **Stop desktop editing** (and similar) to release a checkout when finished.
4. The app creates a **checkout** (other users get `409` if they try to check out the same file).
5. Edit and **Save** in the desktop app (do not “Save as” to Downloads if you want changes in Canary).
6. Use **Stop desktop editing** when finished (optional but recommended so the lock is cleared before expiry).

## Configuration

| Variable | Description |
|----------|-------------|
| `CANARY_PUBLIC_URL` | Origin embedded in WebDAV URLs (e.g. `https://canary.example.com` or `http://192.168.1.10:8000`). Must be reachable from the machine running ONLYOFFICE Desktop. **Avoid `http://localhost:8000` for desktop open** if ONLYOFFICE is installed as **Flatpak** or **snap**: those sandboxes use their *own* loopback, so `localhost` is not your Docker host and the app can sit on “Opening…” forever while **no** `GET`/`PROPFIND` `/webdav/…` lines appear in Canary logs. Use the host’s **LAN IP** (and ensure port `8000` is published). |
| `WEBDAV_SESSION_HOURS` | Session lifetime (1–72), default `8`. |

## API

- `POST /cases/{case_id}/files/{file_id}/checkout-edit` — Bearer auth; returns WebDAV URLs + expiry + **`libreoffice_cli_hint`** (shell) and **`onlyoffice_cli_hint`** (always empty; ONLYOFFICE CLI does not open http(s) URLs; many desktop builds also lack a paste-WebDAV-URL menu).
- `GET /cases/{case_id}/files/{file_id}/edit-session` — Whether the current user has an active session (includes file URL again).
- `POST /cases/{case_id}/files/{file_id}/release-edit` — End the session.
- WebDAV (no Bearer; **token is in the path** — treat like a password):  
  `GET|PUT|PROPFIND|… /webdav/sessions/{token}/{filename}`

## Database

Run Alembic after deploy (merge revision `c8d1e2f3a4b5`):

```bash
alembic upgrade head
```

## Security notes

- Use **HTTPS** in production; the URL is a bearer capability.
- Folder markers / system files cannot be checked out.
- One active checkout per file across users; same user superseding their own session is allowed.

## ONLYOFFICE Desktop vs WebDAV

**Expectation check:** If your ONLYOFFICE build has **no** entry to paste a raw WebDAV `http(s)` URL, that matches current product positioning: Desktop Editors focus on **cloud/DMS** (`execCommand` / provider APIs), not LibreOffice-style **Open Remote**.

**What works without extra integration:**

1. **Edit in browser (ONLYOFFICE)** in Canary — uses Document Server; no WebDAV URL paste required.
2. **LibreOffice** — **File → Open Remote** → paste the **file** URL from checkout.
3. **Linux: mount the folder URL**, then open the file in ANY office app from the mount point, e.g. **davfs2** (token is already in the path; username/password are often unused—try blank or any placeholder if the client insists):

   ```bash
   # Example: mount webdav_folder_url from checkout (ends with .../sessions/<token>/)
   sudo mkdir -p /mnt/canary-webdav
   sudo mount -t davfs -o noexec <webdav_folder_url> /mnt/canary-webdav
   xdg-open /mnt/canary-webdav/<filename>
   ```

   Unmount when done: `sudo umount /mnt/canary-webdav`. Adjust options (`gid=`, `use_locks`) per `davfs2` docs.

**Curl note:** `curl …/webdav/sessions/TOKEN/…` returns **404** if `TOKEN` is still the literal word `TOKEN` — substitute the **UUID** from the checkout JSON (`token` field) or copy the full URL from the UI.

### ONLYOFFICE stuck on “Opening…”

**Check backend access logs first.** After `POST …/checkout-edit` you should see **at least one** request to `/webdav/sessions/<token>/…` (`PROPFIND`, `HEAD`, `GET`, or `LOCK`) from an address other than your test `curl`. If **checkout succeeds but there are zero `/webdav` lines** when ONLYOFFICE tries to open, the editor **never reached Canary** (wrong URL, wrong host, firewall, or sandbox `localhost` — see `CANARY_PUBLIC_URL` above).

The API also logs **`checkout_edit … webdav_origin=…`** at INFO: that origin must match what you paste (e.g. `http://192.168.x.x:8000`). The Web UI shows **file + folder** links after checkout—confirm the host is **port 8000** (API), not **5173** (Vite). Middleware may log lines like **`"WEBDAV PROPFIND /webdav/…"`** so `/webdav` traffic is easy to spot.

Common causes:

1. **CORS / embedded browser (fixed in app):** ONLYOFFICE Desktop may fetch your WebDAV URL through an **embedded web view** that applies **browser CORS** rules. Canary adds permissive CORS headers on **`/webdav`**: it **echoes the request `Origin`** when the client sends one (and sets `Vary: Origin`), otherwise `Access-Control-Allow-Origin: *`. It also **removes `Access-Control-Allow-Credentials`** on those responses so browsers do not reject the illegal combination of `credentials: true` with `*`.

2. **`CANARY_PUBLIC_URL` vs PROPFIND `href`s (fixed in app):** After **PROPFIND**, WebDAV clients often **follow absolute `href`s** from the XML response—not only the URL you pasted. If those pointed at `http://127.0.0.1:8000` or a **Docker-only hostname** while you opened `https://your-host/…`, ONLYOFFICE may try to reach an address that is wrong from the desktop machine and appear to hang. Canary now builds multistatus **`href`s from `CANARY_PUBLIC_URL`** when it is set (same base as checkout links). Set **`CANARY_PUBLIC_URL`** to the exact origin ONLYOFFICE can reach (LAN IP, public hostname, `https` + correct port) and restart the API.

3. **`localhost` vs `127.0.0.1`:** Use **one hostname consistently**. If `CANARY_PUBLIC_URL` is `http://localhost:8000` but you paste `http://127.0.0.1:8000/webdav/…` (or the reverse), PROPFIND may return `href`s with the other form; some stacks treat them differently. Prefer the same host string everywhere (or set `CANARY_PUBLIC_URL` to your **LAN IP** when ONLYOFFICE runs on another PC).

4. **Unreachable URL from the PC running ONLYOFFICE:** The WebDAV link must use a host/IP that resolves from that machine (not `localhost` on the server, not a container-only name). From that machine: `curl -sI 'http://…/webdav/sessions/<real-uuid-token>/file.docx'` should return **200** (not **404**). A literal path segment `TOKEN` always 404s.

5. **HTTPS / certificate:** Self-signed or corporate TLS interception can make some clients stall. Try HTTP on a trusted LAN or fix the cert chain.

6. **Proxy / firewall:** Outbound HTTP(S) from the workstation to Canary must be allowed.

7. **Expired checkout:** You would normally get **404**, not an endless spinner—but refresh the link with a new checkout if unsure.

**Debug PROPFIND:** `curl -sX PROPFIND -H 'Depth: 1' 'http://…/webdav/sessions/<real-token>/' | head` — check that every **`href`** uses the same host/scheme you expect clients to use.

**Debug HTTP sequence (backend logs):** With log level **INFO**, Canary logs each `PROPFIND` / `GET` / `HEAD` / `LOCK` under `/webdav` (path, `Depth`, `Range`, `User-Agent`). Restart the API, reproduce “Opening…”, then check `docker compose logs backend` (or your uvicorn output). If you see **PROPFIND** but **no GET**, the client is still failing before download; if **GET** appears with **`status=206`**, partial-content / range handling is in use.

**Curl checks:** use the **real session UUID** from checkout (not the literal text `TOKEN`). Example:

```bash
# Full HEAD (expect 200)
curl -sI 'http://192.168.1.10:8000/webdav/sessions/<uuid-from-checkout>/YourFile.docx'

# Range (many desktop editors use this)
curl -sI -H 'Range: bytes=0-1023' 'http://192.168.1.10:8000/webdav/sessions/<uuid-from-checkout>/YourFile.docx'
# Expect 206 and Content-Range when the file is larger than the range
```

### “Could not copy WebDAV URL” / clipboard on LAN

Browsers only allow **`navigator.clipboard`** on **HTTPS** or **`http://localhost`** (secure context). On **`http://192.168.x.x`** automatic copy is blocked. The Canary UI falls back to a **dialog with the link** and a **Copy** button (and selects the text so you can Ctrl+C). For seamless auto-copy on a LAN, use **HTTPS** or open the app via **localhost** on the same machine.

### “File type is not supported” with ONLYOFFICE

1. **If you used the terminal** (`desktopeditors 'https://…'`): ONLYOFFICE treats CLI arguments as **local file paths**, not URLs—that error is expected. Use **Edit in browser**, **LibreOffice Open Remote**, or a **WebDAV mount** instead.

2. **If a client did reach `/webdav`:** it may infer format from HTTP **`Content-Type`**. Canary’s WebDAV **`GET`** maps common Office extensions to canonical MIME types when the stored upload type is generic. Ensure the file has a normal extension. Check:

`curl -sI 'https://…/webdav/sessions/TOKEN/YourFile.docx' | grep -i content-type`

## LibreOffice: “The folder contents could not be displayed” / “operation not supported” when saving

Opening with **`libreoffice --writer 'https://…/file.docx'`** sometimes uses a **plain HTTP** document context. **Save** can then open a remote folder browser that **PROPFIND**s the session collection; if that fails or hrefs are wrong, you see this error.

**Try in order:**

1. **Upgrade Canary** (WebDAV now returns **absolute** `href` values and **`displayname`** in PROPFIND, and **405** instead of **404** for `GET` on the session folder—helps LibreOffice/GVfs).

2. Prefer **File → Open Remote…** → **WebDAV** (or **HTTP**), paste the **full WebDAV file URL**, open, then **Save**—this keeps the document on the WebDAV UCP and usually saves with **PUT** reliably.

3. If it still fails: **File → Save as…** to a local path, then **re-upload** the file in Canary (or use **Download** / **Import** as your workflow allows).
