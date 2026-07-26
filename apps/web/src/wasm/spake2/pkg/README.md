# fck-spake2

SPAKE2 (RFC 9383) password-authenticated key exchange, compiled to WebAssembly
for the fuck-eu-chat-control in-band handshake.

## Algorithm and variant

- **Algorithm:** SPAKE2, RFC 9383.
- **Variant:** asymmetric A/B. The two peers must use opposite roles (one calls
  `start_a`, the other `start_b`). Roles are derived deterministically from the
  identity-key comparison already used for ECDH session roles
  (`deriveRole` in `features/chat/crypto/session.ts`), never trusted from the
  broker.
- **Group:** the RustCrypto `spake2` crate's only `Group` impl, `Ed25519Group`
  (Edwards-form Ed25519). Shares are exactly **33 bytes**: one side-identification
  byte (`'A'` = `0x41` for the A role, `'B'` = `0x42` for the B role) followed by
  the 32-byte Edwards-point encoding.
- **Domain separation:** the ASCII tag `fuck-eu-chat-control/v1` is fed to the
  crate as both SPAKE2 identity strings (`idA` and `idB`). The conversation id
  is NOT fed to SPAKE2 directly — it is mixed in later via the transcript hash
  in `deriveSessionKeys`.
- **Crate pinned:** `spake2 = "=0.4.0"` (exact pin; the only released 0.4.x).

## What is committed

The built `pkg/` directory is committed alongside the Rust source so the web
app builds WITHOUT a Rust toolchain. CI never needs `cargo` or `wasm-pack`; it
imports `pkg/fck_spake2.js` directly. The `pkg/` artifact is the source of truth
at build time.

## Rebuilding

Rebuild only when the Rust source changes. From this directory:

```sh
source "$HOME/.cargo/env"
wasm-pack build --target web
```

Or from the repo root / `apps/web`:

```sh
pnpm --filter web build:wasm:spake2
```

The script is defined in `apps/web/package.json`. The `wasm32-unknown-unknown`
target, `rustup`, and `wasm-pack` must be installed on the rebuilding machine.

## Binary size

The `pkg/` output gzips to roughly 30–60 KiB (curve25519-dalek + sha2 + hkdf +
the thin wasm-bindgen shim). It is lazy-loaded only when an invitation carries a
`~code`, so a `SafetyNumberOnly` session never pays the import cost.

## API surface

The JS-facing API is wrapped ergonomically by
`apps/web/src/features/chat/crypto/pake.ts`; callers should use that wrapper
rather than importing the WASM module directly. The raw surface is:

- `pake_start(role, code, protocol_id) -> PakeState`
- `PakeState#side` and `PakeState#outgoingShare` (33-byte `Uint8Array`)
- `pake_finish(state, peer_share) -> Vec<u8>` (32-byte shared secret)

On error the WASM module throws a JS `Error` whose message begins with
`pake_start:` / `pake_finish:` followed by the RustCrypto error name
(`WrongLength`, `BadSide`, `CorruptMessage`, `AlreadyConsumed`).
