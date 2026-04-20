# Canary troubleshooting (Docker dev)

## “Bad Gateway” (502) on `http://localhost:5173` (often login or `/api`)

The Vite dev server **proxies** `/api` and `/webdav` to the FastAPI backend. **502** means the proxy could not reach the upstream (usually `http://backend:8000` inside Compose).

1. **Check containers**

   ```bash
   docker compose ps
   docker compose logs --tail=80 backend
   docker compose logs --tail=40 frontend
   ```

   The frontend log line **`[Canary vite] proxy: /api /webdav → …`** shows the target. If you see **`[vite /api → http://backend:8000] connect ECONNREFUSED`**, the backend is down or not on the same Docker network.

2. **Test backend from the frontend container**

   ```bash
   docker compose exec frontend wget -qO- http://backend:8000/health
   ```

   Expect `{"status":"ok"}`. If this fails, fix the backend (migrations, crash loop, `docker compose up -d backend`).

3. **Test backend on the host** (published port)

   ```bash
   curl -sS http://127.0.0.1:8000/health
   ```

4. **Do not point the browser at port 8000 for the SPA** unless you run a production build served by something else. In dev, use **`:5173`**; the UI loads from Vite and calls **`/api`** on the same origin.

---

## “Connection timed out” on `http://<LAN-IP>:5173` (but `localhost` / `127.0.0.1` works)

The browser never completes TCP to port **5173**. Two very different cases:

### A) You open the URL **on the same PC** that runs Docker (hairpin)

Using **this machine’s own LAN IP** in the browser (e.g. `http://192.168.1.10:5173` on the same ThinkPad) often **times out** on Linux: the packet never reaches the published port the way you expect (“hairpin” / routing).

**Fix:** On that PC, use:

- `http://127.0.0.1:5173` or `http://localhost:5173`

**To verify real LAN access**, open Canary from **another device** on the same Wi‑Fi (phone, tablet, second PC) using `http://<server-LAN-IP>:5173`.

---

### B) You open the URL **from another device** on the LAN and it still times out

Then it is almost always **firewall** or **wrong IP/subnet**.

1. **Confirm Docker is listening on all interfaces on the host**

   ```bash
   ss -tlnp | grep 5173
   ```

   You want something like `0.0.0.0:5173` (not only `127.0.0.1:5173`).

2. **From the server, curl its own LAN IP** (may still fail on the same machine due to hairpin — use another device for a definitive test):

   ```bash
   curl -v --connect-timeout 3 "http://$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}'):5173/"
   ```

3. **UFW (Ubuntu) — allow the port and reload**

   ```bash
   sudo ufw status
   sudo ufw allow 5173/tcp comment 'canary vite'
   sudo ufw allow 8000/tcp comment 'canary api'
   sudo ufw reload
   ```

   **Docker + UFW:** If rules look correct but other devices still time out, Docker’s iptables rules can interact badly with UFW. See [Docker and UFW](https://docs.docker.com/engine/network/packet-filtering-firewalls/) — you may need extra `DOCKER-USER` chain rules or `ufw` policy adjustments so **forwarded** ports are accepted.

4. **Wrong IP** — use the Canary host’s address on the **same** network as the client (`ip -br a`).

5. **Vite listens on all interfaces in the container** — `vite.config.ts` sets `server.host: true`, the Dockerfile uses `--host 0.0.0.0`, and Compose publishes `0.0.0.0:5173:5173`. After edits:  
   `docker compose up -d --force-recreate frontend`.

---

## `VITE_API_BASE` and LAN

If `.env` sets **`VITE_API_BASE=http://127.0.0.1:8000`**, other devices on the network will try to reach **their own** loopback and fail. For LAN testing, either **omit** `VITE_API_BASE` (use same-origin `/api` through Vite) or set it to **`http://<this-host-LAN-IP>:8000`** and open the app via that IP.
