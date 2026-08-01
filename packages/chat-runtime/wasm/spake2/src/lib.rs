//! SPAKE2 (RFC 9383) asymmetric variant, compiled to WASM.
//!
//! Thin byte-oriented wrapper over the RustCrypto `spake2` crate. Exposes a
//! state object plus two free functions: `pake_start` produces a {@link PakeState}
//! carrying the outgoing 33-byte share, `pake_finish` consumes the peer share
//! and returns the 32-byte shared secret.
//!
//! Design notes:
//! - Variant: asymmetric A/B (the two sides must use opposite roles). Roles are
//!   derived deterministically from the identity-key comparison in
//!   `crypto/session.ts` (`deriveRole`) and never trusted from the broker.
//! - Group: the crate's only Group impl, `Ed25519Group`. Shares are exactly
//!   33 bytes: 1 side-identification byte ('A'=0x41 / 'B'=0x42) followed by
//!   the 32-byte Edwards-point encoding.
//! - Domain separation: the ASCII tag `fuck-eu-chat-control/v1` is fed as both
//!   SPAKE2 identity strings (`idA` and `idB`) so the exchange is bound to this
//!   protocol. The conversation id is NOT fed to SPAKE2 directly — it is mixed
//!   in later via the transcript hash in `deriveSessionKeys`.
//! - Secret hygiene: the 6-digit code slice is zeroized after the crate copies
//!   it into its internal `Password` (which is dropped with the `Spake2` state).

use std::sync::Mutex;

use js_sys::Uint8Array;
use spake2::{Ed25519Group, Identity, Password, Spake2};
use wasm_bindgen::prelude::*;
use zeroize::Zeroize;

/// SPAKE2 side byte for role A (the crate emits 0x41 = 'A').
pub const SIDE_A: u8 = 0x41;
/// SPAKE2 side byte for role B (the crate emits 0x42 = 'B').
pub const SIDE_B: u8 = 0x42;

/// Wire length of a SPAKE2 share: 1 side byte + 32 element bytes.
pub const SHARE_BYTES: usize = 33;

/// Opaque PAKE state handed back to JS.
///
/// The inner `Spake2` is consumed by `pake_finish`, so the option is `take`n on
/// completion (a second `pake_finish` call returns the `AlreadyConsumed`
/// error). The outgoing share is exposed as a getter so JS does not have to
/// touch the state's interior.
#[wasm_bindgen]
pub struct PakeState {
    inner: Mutex<Option<Spake2<Ed25519Group>>>,
    side: u8,
    outgoing_share: Vec<u8>,
}

#[wasm_bindgen]
impl PakeState {
    /// Which SPAKE2 side this state was started as ('A' or 'B').
    #[wasm_bindgen(getter)]
    pub fn side(&self) -> u8 {
        self.side
    }

    /// The 33-byte outgoing share to send to the peer. Returned as a fresh copy
    /// so JS owns the buffer.
    #[wasm_bindgen(getter)]
    pub fn outgoing_share(&self) -> Uint8Array {
        let js = Uint8Array::new_with_length(SHARE_BYTES as u32);
        js.copy_from(&self.outgoing_share);
        js
    }
}

/// Begin a SPAKE2 exchange for the given role.
///
/// `role` must be {@link SIDE_A} (0x41) or {@link SIDE_B} (0x42). `code` is the
/// 6-digit shared password (the SPAKE2 password). `protocol_id` is the ASCII
/// domain-separation tag (e.g. `fuck-eu-chat-control/v1`); it is fed to the
/// crate as both `idA` and `idB`.
///
/// Returns a {@link PakeState} whose `outgoingShare` getter yields the 33-byte
/// share to send to the peer. The exchange is completed with {@link pake_finish}.
#[wasm_bindgen]
pub fn pake_start(role: u8, code: &[u8], protocol_id: &[u8]) -> Result<PakeState, JsValue> {
    if code.is_empty() {
        return Err(JsValue::from_str("pake_start: code must be non-empty"));
    }
    if protocol_id.is_empty() {
        return Err(JsValue::from_str(
            "pake_start: protocol_id must be non-empty",
        ));
    }

    // Copy the code into a zeroizing buffer so the password does not linger on
    // the WASM heap after the crate has copied it into its internal Password.
    let mut code_buf = code.to_vec();
    let password = Password::new(&code_buf);
    code_buf.zeroize();

    let id = Identity::new(protocol_id);

    let (spake, outgoing) = match role {
        SIDE_A => Spake2::<Ed25519Group>::start_a(&password, &id, &id),
        SIDE_B => Spake2::<Ed25519Group>::start_b(&password, &id, &id),
        other => {
            return Err(JsValue::from_str(&format!(
                "pake_start: role must be 0x41 ('A') or 0x42 ('B'), got 0x{:02x}",
                other
            )));
        }
    };

    if outgoing.len() != SHARE_BYTES {
        return Err(JsValue::from_str(&format!(
            "pake_start: internal error, outgoing share is {} bytes (expected {})",
            outgoing.len(),
            SHARE_BYTES
        )));
    }

    Ok(PakeState {
        inner: Mutex::new(Some(spake)),
        side: role,
        outgoing_share: outgoing,
    })
}

/// Complete a SPAKE2 exchange, returning the 32-byte shared secret.
///
/// Throws a JS `Error` if the peer share is malformed (wrong length / corrupt
/// point), carries the wrong side byte, or the state was already consumed. The
/// thrown message carries a stable prefix (`pake_finish:`) followed by the
/// RustCrypto error name so JS can map it to a typed `PakeError`.
#[wasm_bindgen]
pub fn pake_finish(state: &PakeState, peer_share: &[u8]) -> Result<Vec<u8>, JsValue> {
    if peer_share.len() != SHARE_BYTES {
        return Err(JsValue::from_str(&format!(
            "pake_finish: peer share must be {} bytes, got {}",
            SHARE_BYTES,
            peer_share.len()
        )));
    }

    let mut guard = state
        .inner
        .lock()
        .map_err(|_| JsValue::from_str("pake_finish: state mutex poisoned"))?;
    let spake = guard
        .take()
        .ok_or_else(|| JsValue::from_str("pake_finish: AlreadyConsumed"))?;

    spake
        .finish(peer_share)
        .map_err(|e| JsValue::from_str(&format!("pake_finish: {}", error_name(&e))))
}

fn error_name(e: &spake2::Error) -> &'static str {
    match e {
        spake2::Error::WrongLength => "WrongLength",
        spake2::Error::BadSide => "BadSide",
        spake2::Error::CorruptMessage => "CorruptMessage",
    }
}
