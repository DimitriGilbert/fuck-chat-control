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
 *     value: { brokerUrl: "...", baseUrl: "...", iceServers: [...] }, ...
 *   });
 * Keep both sides in sync.
 */
import type { IceServer } from "@fuck-eu-chat-control/chat-runtime/transport/types";

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
  /**
   * Operator-configured ICE server list (STUN/TURN/TURNS) injected by the
   * desktop shell at build time via `FCK_ICE_SERVERS`. When present and
   * non-empty, `resolveBrowserDeps` threads it through and the provider skips
   * the `/ice-config` network fetch (which is a dead path inside a
   * `tauri://` webview — `window.location.origin` is the custom-protocol
   * asset handler, not a real HTTP server). When absent, the SPA falls back
   * to fetching `/ice-config` at runtime. The neutral {@link IceServer} type
   * keeps the DOM `RTCIceServer` shape out of the runtime contract.
   */
  readonly iceServers?: readonly IceServer[];
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
