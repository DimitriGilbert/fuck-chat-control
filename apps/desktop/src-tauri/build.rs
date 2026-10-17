//! Build-time validation for the desktop shell's compile-time env config.
//!
//! `FCK_ICE_SERVERS` is baked verbatim into the binary via `option_env!` in
//! `src/lib.rs` and was historically only JSON-parsed at app launch — where
//! a malformed value `eprintln!`-ed into a console-less release binary and
//! silently shipped host-candidate-only ICE (the desktop shell has no
//! runtime `/ice-config` fetch to fall back on). Validating here instead
//! makes a malformed value fail the release build loudly, matching the
//! `BROKER_URL` const-panic precedent in `src/lib.rs`. Debug builds only
//! emit `cargo:warning`, mirroring the runtime's fail-open `[]` fallback so
//! a stray dev value does not brick `tauri dev`/`cargo test`.

use serde::Deserialize;

/// One or many ICE server URIs — mirror of `IceServerUrls` in `src/lib.rs`.
/// Build scripts cannot import the lib crate, so the serde shape is
/// duplicated here; keep both in sync.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
#[allow(dead_code)]
enum IceServerUrls {
    One(String),
    Many(Vec<String>),
}

/// ICE server descriptor — mirror of `IceServer` in `src/lib.rs`; an exact
/// serde-contract duplicate so a value rejected here is precisely the value
/// the runtime parse would have rejected at launch. `#[allow(dead_code)]`
/// because the fields exist for shape validation only — deserialization
/// success IS the check; nothing reads them afterwards.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct IceServer {
    urls: IceServerUrls,
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    credential: Option<String>,
}

/// Parse `FCK_ICE_SERVERS` as the typed `Vec<IceServer>` `src/lib.rs` bakes.
/// Unset, empty, or non-Unicode counts as unset (the lib's `is_empty()`
/// gate on `ICE_SERVERS_JSON`) and bakes `[]`. A malformed value panics the
/// build script on `PROFILE=release` and warns otherwise.
fn validate_ice_servers() {
    let raw = match std::env::var("FCK_ICE_SERVERS") {
        Ok(raw) if !raw.is_empty() => raw,
        _ => return,
    };
    if let Err(err) = serde_json::from_str::<Vec<IceServer>>(&raw) {
        // Content-free diagnostics only — FCK_ICE_SERVERS carries long-lived
        // TURN username/credential pairs, and serde_json::Error's Display can
        // embed the offending JSON value verbatim (for `invalid type` it is
        // the whole raw string). Same rule as the runtime fallback log in
        // src/lib.rs > build_init_script.
        let message = format!(
            "FCK_ICE_SERVERS is not a JSON array of {{ urls, username?, credential? }} objects \
             (parse error: category {:?} at line {} column {}; value length: {} bytes). The \
             desktop shell has no runtime /ice-config fetch, so a binary built this way \
             silently falls back to [] (host-candidate-only ICE). Fix or unset the variable.",
            err.classify(),
            err.line(),
            err.column(),
            raw.len(),
        );
        if std::env::var("PROFILE").as_deref() == Ok("release") {
            panic!("{message}");
        }
        println!("cargo:warning={message}");
    }
}

fn main() {
    // Keep the build script's rerun cache honest about the compile-time
    // input it reads (the lib's `option_env!` separately forces rustc to
    // rebuild when the same var changes).
    println!("cargo:rerun-if-env-changed=FCK_ICE_SERVERS");
    validate_ice_servers();
    tauri_build::build()
}
