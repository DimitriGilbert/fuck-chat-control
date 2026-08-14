# ADR 001: Cryptographic Dependencies

Status: Accepted (Phase 3, protocol freeze), amended for PAKE
Date: 2026-07-26 (amended 2026-07-30)

## Context

The crypto dependency set was frozen before any crypto code was written.
The constraint from the implementation plan was that anything WebCrypto does
not provide natively must be a maintained, browser-compatible, independently
reviewed implementation. This ADR records the approved set.

Two primitives were left open by the product design: a PAKE implementation
and an Argon2 implementation. The first version of this ADR resolved them
by removing PAKE entirely and shipping Argon2 via `hash-wasm`. That held
for the initial safety-number-only release. It no longer holds: PAKE has
since been implemented and shipped. This amendment records that change.

## Decision

### ECC primitives: `@noble/curves` (P-256 / secp256r1)

`@noble/curves` (currently `^1.9.7`) for all elliptic-curve operations:

- ECDSA P-256 persistent identity keys (sign and verify).
- ECDH P-256 ephemeral session keys (shared-secret derivation).
- Point validation for inbound public keys.

P-256 (secp256r1 / prime256v1) is the only curve for these. Public keys are
raw uncompressed SEC1 (`0x04 || X || Y`, 65 bytes). Signatures are
IEEE-P1363 (`r || s`, 64 bytes), not DER.

Reasons: it is pure TypeScript with no native bindings, ships as ESM the
browser bundler consumes, is small and tree-shakeable, has been
independently audited, and provides both ECDSA and ECDH over the one curve
from one dependency.

### Symmetric primitives: native WebCrypto

`globalThis.crypto.subtle` for:

- AES-256-GCM (96-bit nonce, 128-bit tag) for transport AEAD and at-rest
  message encryption.
- HKDF-SHA256 for the key schedule (directional traffic keys, derived
  subkeys).
- SHA-256 for transcript hashing and the safety number.

No third-party dependency is added for these. WebCrypto is the native,
constant-time path in every supported browser and in the test runtime (Node).

### Argon2: `hash-wasm`

`hash-wasm` (currently `^4.12.0`) for Argon2id, used to wrap the at-rest key
under an optional passphrase and to wrap the export/import bundle under a
user-chosen passphrase. It ships audited WebAssembly binaries with no native
bindings and exposes Argon2, which WebCrypto does not. The variant is
Argon2id (version `0x13`); parameters are frozen in the
[protocol spec](../architecture/protocol-v1.md) and revisited only via a new
ADR.

### PAKE: SPAKE2 (amendment — previously "no PAKE")

The original decision shipped without PAKE. PAKE has since been added as an
**optional** second authentication mode (`AuthMode.Pake = 0x02`), alongside
the default safety-number mode (`AuthMode.SafetyNumberOnly = 0x01`).

Implementation: SPAKE2 (RFC 9383) over Ed25519, built as a Rust crate
compiled to WASM and shipped at `packages/chat-runtime/wasm/spake2/`
(prebuilt `pkg/fck_spake2_bg.wasm`). The web app builds and serves it. The
SPAKE2 shared secret is folded into the transport-key HKDF derivation for
PAKE sessions, so a man-in-the-middle who does not know the shared code
cannot complete the handshake or derive the traffic keys.

This does not displace the safety-number mode. Both modes are first-class:
the conversation picks one at invitation time, the handshake records the
mode in the transcript, and both peers must agree on it or the handshake
fails. The exact wire layout, message sequence, and key mixing are in the
[protocol spec](../architecture/protocol-v1.md).

Reasons for choosing SPAKE2: it is a balanced PAKE (neither side learns
whether the other's password was correct beyond both deriving a key), and a
wrong code produces a key-derivation failure rather than a usable but
insecure channel. It runs over Ed25519, a separate curve from the P-256 used
for the ECDH/ECDSA identity layer; housing it in Rust→WASM keeps the
constant-time group arithmetic out of JavaScript and lets it run off the
main thread.

## Alternatives considered

- `libsodium.js` / `libsodium-wrappers`: rejected as the primary primitive
  set. It bundles many primitives not needed here, ships a larger WASM
  payload, and overlaps WebCrypto for AES-GCM and SHA-256. `@noble/curves`
  is smaller and covers the one thing WebCrypto lacks for the core (P-256
  ECDSA/ECDH with the chosen encodings).
- `@noble/curves` v2.x: deferred. v1.x is the audited, stable line.
- `argon2-browser` and the native `argon2` binding: rejected. They need
  native bindings or outdated packaging and do not meet the
  browser-native baseline. `hash-wasm` is the browser-native choice.
- `node-forge` or hand-rolled crypto: rejected. Violates the
  "maintained, independently reviewed" baseline. (`node-forge` does appear
  in the lockfile, but only as a transitive dependency of the mobile Expo
  toolchain — it is not used by the app's crypto.)
- A different PAKE (OPAQUE) or a different SPAKE2 group: deferred. The
  Ed25519 SPAKE2 crate covers the requirement.

## Tradeoffs

- `@noble/curves` plus WebCrypto plus `hash-wasm` plus the SPAKE2 crate is
  four audited surfaces rather than one (`libsodium`). The wider surface is
  accepted because each piece is the minimal choice for its primitive and
  WebCrypto is already the platform AEAD/SHA-256.
- PAKE is opt-in. A conversation started without a code still relies on
  safety-number comparison for authentication, with the MITM gap that
  implies. The threat model states this directly; the UI labels the safety
  number "unverified" until the user marks it compared. Adding PAKE closed
  that gap for conversations that opt in, without changing the default
  experience.
- Argon2id in the browser is CPU-bound. The export/import and
  passphrase-set flows run off the main thread (Web Worker) to avoid
  blocking the UI.

## Consequences

- The runtime adds exactly two runtime crypto dependencies —
  `@noble/curves` and `hash-wasm` — plus the SPAKE2 WASM crate. Everything
  else uses WebCrypto.
- The protocol codec, crypto module, framing, and store import only from
  these sources for cryptography. No other crypto library may be introduced
  without a new ADR.
- `AuthMode` has two values: `SafetyNumberOnly` (`0x01`) and `Pake`
  (`0x02`). The type is closed and validated; an unknown value on the wire
  is a terminal protocol error, which leaves room for a further mode
  without changing the enum width.
