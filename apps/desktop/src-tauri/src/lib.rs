//! fuck-chat-control desktop shell (Tauri v2).
//!
//! This crate is a thin wrapper around the web build: the system webview
//! serves `frontendDist` (the committed `apps/web/.output/public` bundle) and
//! the SPA boots unchanged. The only seam is `window.__FCK_CONFIG__`, which the
//! desktop app injects before the SPA boots so `resolveBrowserDeps()` in
//! `apps/web/src/features/chat/runtime/chat-provider.tsx` can dial a deployed
//! broker instead of deriving one from `window.location` (which, inside a
//! `tauri://` webview, has no meaningful host).
//!
//! The broker URL is compile-time config, resolved here in priority order:
//!   1. `FCK_BROKER_URL` env var (CI/release builds pass `-`) — the deployed
//!      broker, e.g. `wss://chat.example.com/ws`.
//!   2. The dev fallback `ws://localhost:3001/ws`, matching `build.devUrl` so
//!      `tauri dev` talks to the `pnpm --filter web dev` server's `/ws` route.
//!
//! Operator-configured STUN/TURN/TURNS servers are read from the
//! `FCK_ICE_SERVERS` env var at compile time. It holds a JSON array string
//! (e.g. `'[{ "urls": "stun:stun.example.com:3478" }]'`). The desktop shell
//! has no channel to fetch `/ice-config` at runtime (inside a `tauri://`
//! webview `window.location.origin` is the custom-protocol asset handler, not
//! a real HTTP server), so the list MUST be baked in here for an operator
//! deployment. When unset the array is `[]` — preserving the loopback-only
//! posture so dev/LAN builds keep working with host-candidate WebRTC.
//!
//! The init script is registered on the `WebviewWindowBuilder` (NOT in JSON
//! config — `initialization_script` is a builder method only; see
//! https://docs.rs/tauri/latest/tauri/webview/struct.WebviewWindowBuilder.html#method.initialization_script).
//! It runs after the global object is created and before the HTML document is
//! parsed, so `__FCK_CONFIG__` is in place before any SPA module reads it.

/// The broker URL the desktop app dials. See the module docs for the resolution
/// rules. Inline so a `const` (not a `String`) — it is interpolated into the
/// init script as a JSON string literal via `serde_json` to avoid ad-hoc
/// escaping bugs.
const BROKER_URL: &str = match option_env!("FCK_BROKER_URL") {
    Some(url) => url,
    None => "ws://localhost:3001/ws",
};

/// The base URL the SPA uses to resolve same-origin relative fetches
/// (`/ice-config`, `/wasm/...`). In the desktop shell these assets ship inside
/// `frontendDist`, so `'self'` is the correct base. Kept as a separate field
/// (not derived from `BROKER_URL`) so a future build can point at a CDN
/// independently of the signaling broker.
const BASE_URL: &str = "self";

/// Operator-configured ICE servers as a JSON array string, read from
/// `FCK_ICE_SERVERS` at compile time. Defaults to `"[]"` so loopback/LAN/CI
/// builds keep working with host-candidate-only WebRTC. See the module docs
/// for why this is baked in rather than fetched at runtime.
const ICE_SERVERS_JSON: &str = match option_env!("FCK_ICE_SERVERS") {
    Some(s) if !s.is_empty() => s,
    _ => "[]",
};

/// Builds the JavaScript snippet that primes `window.__FCK_CONFIG__`. The
/// object shape mirrors `FckRuntimeConfig` in
/// `apps/web/src/features/chat/runtime/fck-config.ts` — keep them in sync.
///
/// `serde_json` is used for the URL and base so a stray quote/backslash in a
/// configured `FCK_BROKER_URL` cannot break out of the JS string literal. The
/// ICE servers string is parsed first: `FCK_ICE_SERVERS` holds an already-JSON
/// array, so `from_str` validates it and `to_string` re-emits canonical JSON —
/// safe to interpolate as a bare JS array literal.
fn build_init_script() -> String {
    let broker_url = serde_json::to_string(BROKER_URL).expect("broker URL is a finite string");
    let base_url = serde_json::to_string(BASE_URL).expect("base URL is a finite string");
    let ice_servers = match serde_json::from_str::<serde_json::Value>(ICE_SERVERS_JSON) {
        Ok(v) => serde_json::to_string(&v).expect("ICE servers re-serializes"),
        Err(_) => panic!("FCK_ICE_SERVERS must be a JSON array, got: {ICE_SERVERS_JSON}"),
    };
    format!(
        "Object.defineProperty(window, '__FCK_CONFIG__', {{\n  \
           value: {{ brokerUrl: {broker}, baseUrl: {base}, iceServers: {ice} }},\n  \
           configurable: false,\n  \
           writable: false,\n  \
           enumerable: true\n  \
         }});\n",
        broker = broker_url,
        base = base_url,
        ice = ice_servers,
    )
}

/// Desktop entry point. Mobile is not targeted by this crate, but the
/// `#[cfg_attr(mobile, tauri::mobile_entry_point)]` + lib split follows the v2
/// canonical structure so a future mobile target needs no refactor.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // The window is declared in `tauri.conf.json` with `"create": false`
            // so we can attach the init script here before it is realized.
            // `from_config` reads the declarative window spec (title, size,
            // theme) so this stays the ONLY Rust-side window logic.
            let window_config = app
                .config()
                .app
                .windows
                .first()
                .cloned()
                .ok_or(::tauri::Error::from(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "no window declared in tauri.conf.json (app.windows is empty)",
                )))?;
            ::tauri::WebviewWindowBuilder::from_config(app.handle(), &window_config)?
                .initialization_script(build_init_script())
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
