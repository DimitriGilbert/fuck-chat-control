/**
 * Runtime configuration the desktop shell (Tauri v2) injects before the SPA
 * boots. On the web app, nothing sets this and `resolveBrowserDeps()` falls
 * back to `window.location`; the desktop shell's init script
 * (`apps/desktop/src-tauri/src/lib.rs > build_init_script`) defines
 * `window.__FCK_CONFIG__` with a deployed broker URL so the page can dial a
 * remote broker from inside a `tauri://` webview (where `window.location.host`
 * is meaningless for deriving a signaling endpoint).
 *
 * The shape here MUST mirror the object built on the Rust side:
 *   Object.defineProperty(window, '__FCK_CONFIG__', {
 *     value: { brokerUrl: "...", baseUrl: "..." }, ...
 *   });
 * Keep both sides in sync.
 */
export interface FckRuntimeConfig {
  /** Absolute WebSocket URL of the signaling broker, e.g. `wss://host/ws`. */
  readonly brokerUrl?: string;
  /**
   * Base URL the SPA uses to resolve same-origin relative fetches
   * (`/ice-config`, `/wasm/...`). The desktop shell sets this to the literal
   * `"self"` to mean "same-origin" (assets ship inside `frontendDist`); the
   * web build leaves it unset so `resolveBrowserDeps` falls back to
   * `window.location.origin`.
   */
  readonly baseUrl?: string;
}

declare global {
  interface Window {
    readonly __FCK_CONFIG__?: FckRuntimeConfig;
  }
}

/**
 * Reads the injected runtime config, if any. Returns `undefined` on the web
 * build (no injection) and a typed {@link FckRuntimeConfig} inside the desktop
 * shell. SSR-safe: guards `typeof window` so TanStack Start's prerender pass
 * (which evaluates this module on the server) does not touch a DOM global.
 */
export function getFckConfig(): FckRuntimeConfig | undefined {
  if (typeof window === "undefined") return undefined;
  return window.__FCK_CONFIG__;
}
