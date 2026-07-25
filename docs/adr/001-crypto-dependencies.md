# ADR 001: Cryptographic Dependencies for v1

Status: Accepted (Phase 3, protocol freeze)
Date: 2026-07-24

## Context

Phase 3 of the implementation plan requires freezing the cryptographic
dependency set before any crypto code is written. The plan's baseline
constraints (lines 19, 159) require maintained, independently reviewed,
browser-compatible implementations for everything WebCrypto does not
provide natively. This ADR records the approved set and the v1
authentication posture.

The product's "Cryptographic design" (PRD) and "Security closure
decisions" previously left two primitives open: a PAKE implementation
(SPAKE2) and an Argon2 implementation. Both are resolved here. A
separate, superseding decision changes the v1 authentication posture:
v1 ships without PAKE.

## Decision

### ECC primitives: `@noble/curves` (P-256 / secp256r1)

Use `@noble/curves` v1.x for all elliptic-curve operations in v1:

- ECDSA P-256 persistent identity keys (sign and verify).
- ECDH P-256 ephemeral session keys (shared secret derivation).
- Point validation for inbound public keys.

P-256 (secp256r1 / prime256v1) is the single curve for v1. Public keys
are encoded as raw uncompressed SEC1 (`0x04 || X || Y`, 65 bytes).
Signatures are encoded as IEEE-P1363 (`r || s`, 64 bytes) — not DER.

Rationale:

- Audited (independent audits referenced by the project), pure
  TypeScript, no native bindings, ships as ESM consumable by the
  browser bundler, small and tree-shakeable.
- Provides both ECDSA and ECDH over the same curve from one dependency.
- Used widely and inspected by downstream security-conscious projects.

### Symmetric primitives: native WebCrypto

Use `globalThis.crypto.subtle` (WebCrypto) for:

- AES-256-GCM (96-bit nonce, 128-bit authentication tag) for all
  transport AEAD and for at-rest message encryption.
- HKDF-SHA256 for the key schedule (directional traffic keys, base
  nonce, and any derived subkeys).
- SHA-256 for transcript hashing and the safety number.

No third-party dependency is added for these. WebCrypto is the native,
audited, constant-time path in every supported browser and in the
project's test runtime (Node).

### Argon2: `hash-wasm`

Use `hash-wasm` v4.x for Argon2id:

- Wrapping the at-rest key under an optional passphrase.
- Wrapping the export/import bundle under a user-chosen passphrase.

`hash-wasm` ships hand-tuned, audited-ish WebAssembly binaries with no
native bindings, is consumed directly by the browser bundler, and
exposes Argon2 (which WebCrypto does not). The Argon2 variant is
Argon2id (version `0x13`), with parameters (memory `m`, iterations `t`,
parallelism `p`) frozen in `protocol-v1.md` and revisited only via a
new ADR.

### No PAKE in v1 (safety-number-only authentication)

v1 ships **without** PAKE. The "PAKE is mandatory when requested"
closure decision (PRD "Security closure decisions") is **superseded**
for v1. Authentication in v1 is exclusively via safety-number
comparison:

- After the application handshake completes, both peers display the
  per-conversation safety number derived from the canonical identity
  keys and conversation ID.
- Users MUST compare that number over an independent trusted channel
  to authenticate the channel against an active man-in-the-middle on
  the broker.
- Without comparison, the channel is vulnerable to an active MITM on
  the broker. This is the fundamental limitation of unauthenticated
  key exchange and it is stated plainly in the UI and threat model.

Consequences and follow-ups:

- The six-digit verification code is **removed** from v1. Invitations
  are therefore unauthenticated bearer rendezvous handles until and
  unless the users compare the safety number.
- The invitation URL form collapses to `https://app.example/#<conversationId>`.
  The `~<code>` fragment suffix is not produced or parsed in v1.
- No `spake2` package, `libsodium`, or PAKE adapter is added. No PAKE
  material, failure marker, or attempt counter is persisted.
- A future ADR may reintroduce PAKE (SPAKE2 or OPAQUE) as an optional
  hardening layer behind a narrow adapter, mixed into the key schedule
  exactly as the original closure decision specified. That is out of
  scope for v1 and must not be assumed by any v1 module.

## Alternatives considered

- `libsodium.js` / `libsodium-wrappers`: rejected as the primary
  primitive set. It bundles many primitives we do not need, ships a
  larger WASM payload, and overlaps WebCrypto for AES-GCM and SHA-256.
  `@noble/curves` is smaller and scoped to the one thing WebCrypto
  lacks for v1 (P-256 ECDSA/ECDH with our chosen encodings).
- `@noble/curves` v2.x: deferred. v1.x is the audited, stable line
  referenced by the baseline constraint; v2 is newer. Revisit via ADR.
- `argon2-browser` and the native `argon2` binding: rejected. They
  require native bindings or outdated packaging and do not meet the
  "browser-native, no Node-only deps" baseline. `hash-wasm` is the
  browser-native choice.
- `node-forge` / rolled-here crypto: rejected. Violates the
  "maintained, independently reviewed" baseline.
- PAKE in v1 (SPAKE2 via a JS implementation): rejected for v1 scope.
  The library-selection, encoding-binding, KAT, and failure-persistence
  work is non-trivial and is deferred to a hardening PRD. v1's
  safety-number channel is cryptographically sound provided the users
  compare the number.

## Tradeoffs

- `@noble/curves` + WebCrypto + `hash-wasm` is three audited surfaces
  instead of one (`libsodium`). We accept the wider surface because
  each piece is the minimal, best-fit choice for its primitive and
  because WebCrypto is already trusted as the platform AEAD/SHA-256.
- Removing PAKE from v1 means invitations are unauthenticated until
  safety-number comparison. The threat model documents this as the
  residual MITM risk; the UI labels every safety number "unverified"
  until the user marks it compared. This is an acceptable v1 posture
  and the architecture leaves room for PAKE to return without redesign.
- Argon2id in the browser is CPU-bound; the export/import and
  passphrase-set flows must run off the main thread (Web Worker) to
  avoid blocking the UI. This is an implementation constraint on Phase
  6, recorded here so it is not rediscovered late.

## Consequences

- The v1 `package.json` adds exactly two runtime crypto dependencies:
  `@noble/curves` and `hash-wasm`. Everything else uses WebCrypto.
- The protocol codec (Phase 3), crypto module (Phase 4), framing
  (Phase 5), and store (Phase 6) import only from these three sources
  for cryptography. No other crypto library may be introduced without a
  new ADR.
- The `AuthMode` enum has exactly one value in v1 (`SafetyNumberOnly`).
  The type is closed and validated; an unknown value on the wire is a
  terminal protocol error, preserving room for a future
  PAKE-bearing mode without changing the enum width.
