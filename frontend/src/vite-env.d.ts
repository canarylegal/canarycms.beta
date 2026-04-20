/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE?: string
  /**
   * ONLYOFFICE script/editor base URL for the browser.
   * - Prefer `/office-ds` with Vite proxy (see vite.config.ts) when using docker-compose.
   * - Or full URL e.g. `http://localhost:8080` if the Document Server is directly reachable.
   */
  readonly VITE_ONLYOFFICE_URL?: string
  /**
   * Dev: document server port on the **same hostname** as the app (e.g. 18080 when ONLYOFFICE is
   * published on host). When set, the editor loads from `protocol//hostname:port` instead of
   * same-origin `/office-ds`, so print preview iframes never receive the Vite SPA shell.
   */
  readonly VITE_ONLYOFFICE_DIRECT_PORT?: string
  /** Full override for direct DS URL (rare; prefer VITE_ONLYOFFICE_DIRECT_PORT for LAN). */
  readonly VITE_ONLYOFFICE_DIRECT_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

export {}
