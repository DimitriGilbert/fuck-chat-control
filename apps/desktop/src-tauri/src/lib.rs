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

/// Builds the JavaScript snippet that primes `window.__FCK_CONFIG__`. The
/// object shape mirrors `FckRuntimeConfig` in
/// `apps/web/src/features/chat/runtime/fck-config.ts` — keep them in sync.
///
/// `serde_json::to_string` is used for the URL so a stray quote/backslash in a
/// configured `FCK_BROKER_URL` cannot break out of the JS string literal.
fn build_init_script() -> String {
    let broker_url = serde_json::to_string(BROKER_URL).expect("broker URL is a finite string");
    let base_url = serde_json::to_string(BASE_URL).expect("base URL is a finite string");
    format!(
        "Object.defineProperty(window, '__FCK_CONFIG__', {{\n  \
           value: {{ brokerUrl: {broker}, baseUrl: {base} }},\n  \
           configurable: false,\n  \
           writable: false,\n  \
           enumerable: true\n  \
         }});\n",
        broker = broker_url,
        base = base_url,
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
