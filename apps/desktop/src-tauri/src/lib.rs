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
//! MEDIUM-E (Dokploy fix): the invitation-link public base URL is NO LONGER a
//! compile-time `option_env!("FCK_PUBLIC_BASE_URL")` value. That mechanism
//! baked the URL into the binary at build time, which is incompatible with
//! Dokploy's runtime-env-injection model (the secret/URL is injected into the
//! web CONTAINER after the image is built, not into the Rust build). The web
//! SPA now reads `PUBLIC_BASE_URL` from the server's `/ice-config` response at
//! runtime (see apps/web/src/server/ice-config.ts). The desktop shell injects
//! the literal `"self"` for `publicBaseUrl` so `resolveBrowserDeps()` in
//! chat-provider.tsx translates it to `window.location.origin` — the web
//! runtime then overrides it from `/ice-config` when the server is configured.
//! If the desktop webview ever needs a baked-in public origin (e.g. for an
//! air-gapped operator deployment with no reachable `/ice-config`), it can be
//! threaded back through a compile-time const without touching the web path.
//!
//! The init script is registered on the `WebviewWindowBuilder` (NOT in JSON
//! config — `initialization_script` is a builder method only; see
//! https://docs.rs/tauri/latest/tauri/webview/struct.WebviewWindowBuilder.html#method.initialization_script).
//! It runs after the global object is created and before the HTML document is
//! parsed, so `__FCK_CONFIG__` is in place before any SPA module reads it.

use serde::{Deserialize, Serialize};

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

/// The invitation-link public base URL. MEDIUM-E (Dokploy fix): this is no
/// longer a compile-time `option_env!("FCK_PUBLIC_BASE_URL")` read — the web
/// SPA now gets the public origin from the RUNTIME `/ice-config` response
/// (served by the web container from its `PUBLIC_BASE_URL` env, which Dokploy
/// injects at container start). The desktop shell injects `"self"` here so
/// `resolveBrowserDeps()` in chat-provider.tsx translates it to
/// `window.location.origin` as a fallback; the SPA then overrides it from
/// `/ice-config` when the server is configured. See the module-level docs for
/// the rationale.
const PUBLIC_BASE_URL: &str = BASE_URL;

/// Operator-configured ICE servers as a JSON array string, read from
/// `FCK_ICE_SERVERS` at compile time. Defaults to `"[]"` so loopback/LAN/CI
/// builds keep working with host-candidate-only WebRTC. See the module docs
/// for why this is baked in rather than fetched at runtime.
const ICE_SERVERS_JSON: &str = match option_env!("FCK_ICE_SERVERS") {
    Some(s) if !s.is_empty() => s,
    _ => "[]",
};

/// One or many ICE server URIs. `#[serde(untagged)]` picks the variant from
/// the JSON shape: a JSON string deserializes to [`One`] and a JSON array to
/// [`Many`]. On serialize each variant emits its native JSON form, so the
/// re-emitted `__FCK_CONFIG__.iceServers` preserves the single-string-vs-array
/// distinction the TypeScript `IceServer.urls: string | readonly string[]`
/// union (`packages/chat-runtime/src/transport/types.ts`) requires — the web
/// adapter reads it back as `server.urls as string | string[]`
/// (`apps/web/src/features/chat/signaling/webrtc-adapter.ts`).
#[derive(Debug, Deserialize, Serialize)]
#[serde(untagged)]
enum IceServerUrls {
    One(String),
    Many(Vec<String>),
}

/// ICE server descriptor (STUN/TURN) matching the TypeScript `IceServer`
/// contract in `packages/chat-runtime/src/transport/types.ts`. The desktop
/// shell deserializes the compile-time `FCK_ICE_SERVERS` JSON into this typed
/// shape — rejecting non-arrays and malformed elements at the Rust boundary
/// (a `serde_json::Value` target would accept any JSON) — before
/// re-serializing it into `window.__FCK_CONFIG__` for the SPA.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct IceServer {
    /// Required. Single URI or array of URIs; see [`IceServerUrls`].
    urls: IceServerUrls,
    /// Optional TURN username. `#[serde(default)]` so its absence in JSON
    /// deserializes to `None`; `skip_serializing_if` omits it on re-emit so
    /// the SPA never sees `"username": null`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    username: Option<String>,
    /// Optional TURN credential. Same optionality rules as [`username`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    credential: Option<String>,
}

/// Builds the JavaScript snippet that primes `window.__FCK_CONFIG__`. The
/// object shape mirrors `FckRuntimeConfig` in
/// `apps/web/src/features/chat/runtime/fck-config.ts` — keep them in sync.
///
/// `serde_json` is used for the URL and base so a stray quote/backslash in a
/// configured `FCK_BROKER_URL` cannot break out of the JS string literal. The
/// ICE servers string is parsed first: `FCK_ICE_SERVERS` holds an already-JSON
/// array, so `from_str` validates it and `to_string` re-emits canonical JSON —
/// safe to interpolate as a bare JS array literal.
///
/// ICE servers parse into a TYPED `Vec<IceServer>` (not `serde_json::Value`)
/// so serde rejects non-arrays and any element that does not match the
/// TypeScript `IceServer` contract (`urls: string | readonly string[]`,
/// optional `username`/`credential`). On any parse error the list falls back
/// to `[]` AND emits a warning rather than panicking — `build_init_script` runs
/// on every launch from `tauri::Builder::setup`, so a malformed env value must
/// degrade to the same loopback-only posture as the unset case (see the
/// module-level docs) instead of bricking the binary.
fn build_init_script() -> String {
    let broker_url = serde_json::to_string(BROKER_URL).expect("broker URL is a finite string");
    let base_url = serde_json::to_string(BASE_URL).expect("base URL is a finite string");
    let public_base_url =
        serde_json::to_string(PUBLIC_BASE_URL).expect("public base URL is a finite string");
    let ice_servers: Vec<IceServer> = serde_json::from_str(ICE_SERVERS_JSON).unwrap_or_else(|e| {
        eprintln!(
            "FCK_ICE_SERVERS must be a JSON array of {{ urls, username?, credential? }} objects, \
             falling back to [] (loopback-only). Parse error: {e}; raw value: {ICE_SERVERS_JSON}"
        );
        Vec::new()
    });
    // Re-serialize the typed list so the init script gets canonical JSON in
    // the exact `{ urls, username?, credential? }` shape the SPA reads; this
    // also escapes any string contents safe for embedding as a JS literal.
    // Infallible: `IceServer` only contains `String`/`Option<String>`/`Vec<String>`,
    // all of which always serialize, so `to_string` cannot fail.
    let ice_servers = serde_json::to_string(&ice_servers).expect(
        "IceServer only contains serializable primitives (String/Option<String>/Vec<String>)",
    );
    format!(
        "Object.defineProperty(window, '__FCK_CONFIG__', {{\n  \
           value: {{ brokerUrl: {broker}, baseUrl: {base}, publicBaseUrl: {pbase}, iceServers: {ice} }},\n  \
           configurable: false,\n  \
           writable: false,\n  \
           enumerable: true\n  \
         }});\n",
        broker = broker_url,
        base = base_url,
        pbase = public_base_url,
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
