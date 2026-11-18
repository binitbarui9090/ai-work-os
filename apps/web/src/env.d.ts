/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Full origin of a separately-hosted API, e.g. `https://api.example.com`.
   * Unset for the default same-origin deployment (dev proxy, or a reverse
   * proxy in front of both the web app and the API in production).
   */
  readonly VITE_API_BASE_URL?: string;
  /**
   * Full WebSocket origin of a separately-hosted API, e.g.
   * `wss://api.example.com`. Unset for the default same-origin deployment.
   */
  readonly VITE_WS_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
