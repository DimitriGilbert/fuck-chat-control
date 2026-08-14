# Conversation Orchestrator — Design

The integration layer that ties crypto, framing, signaling, WebRTC, and the
conversation store together. It owns the conversation lifecycle state
machine and the application-layer handshake. It is the only module that
coordinates the others; React never touches keys, frame codecs, data
channels, or the store directly.

All of this lives in `packages/chat-runtime/src/orchestrator/`. The web app
consumes it; it does not implement it.

## Authentication modes

A conversation uses one of two authentication modes, chosen at invitation
time and recorded in the handshake transcript:

- `SafetyNumberOnly` (`0x01`) — the default. The peer is authenticated by
  comparing a safety number out of band.
- `Pake` (`0x02`) — optional, set when the invitation carries a 6-digit
  code. A SPAKE2 exchange is folded into the key derivation, so a wrong code
  blocks the handshake.

Both peers must agree on the mode. A mismatch on the wire is a terminal
protocol error. See the [protocol spec](protocol-v1.md) and
[ADR 001](../adr/001-crypto-dependencies.md).

## Module layout

`packages/chat-runtime/src/orchestrator/`

- `invitation.ts` — CSPRNG conversation-id generation, fragment-URL parsing
  and formatting (including the coded form for PAKE).
- `handshake-codec.ts` — plaintext handshake message encode/decode
  (pre-key): hello, signature, and the PAKE share and confirm messages.
- `orchestrator.ts` — the `ConversationOrchestrator` class and state wiring.
- `errors.ts` — orchestrator error codes.

There is no barrel `index.ts`; callers import the files directly.

Tests live under `packages/chat-runtime/tests/`.

## The receive path

`FrameTransport` (framing) is send-only: it has `send(bytes)` and delivers
inbound bytes to the caller through `FrameReceiver.ingest`. The orchestrator
has to own message routing because, during the handshake, incoming bytes are
plaintext handshake messages, not yet encrypted frames.

The orchestrator takes a `PeerTransport` (a thin receive-capable contract)
defined in `packages/chat-runtime/src/transport/peer-transport.ts`:

```ts
interface PeerTransport {
  send(bytes: Uint8Array): void;
  readonly ready: boolean;
  readonly bufferedAmount: number;
  setOnMessage(handler: (bytes: Uint8Array) => void): void;
  setOnDrain(handler: (() => void) | null): void;
  close(): void;
}
```

`DataChannelTransport` (`apps/web/src/features/chat/signaling/webrtc-adapter.ts`)
gains `setOnMessage`, wired to the underlying `RTCDataChannel` `onmessage`
(`binaryType = "arraybuffer"`). It already has `send`, `ready`,
`bufferedAmount`, `setDrainListener` (mapped to `setOnDrain`), and `close`,
so it satisfies `PeerTransport` through a `toPeerTransport()` adapter.

The orchestrator's single receive handler branches on phase:

```
onMessage(bytes):
  if handshake not complete → parse handshake message
  else                       → frameReceiver.ingest(bytes)
```

After the handshake, the same `DataChannelTransport` instance is handed to
`FrameSender` (it already satisfies `FrameTransport`) and its inbound stream
is routed to `FrameReceiver.ingest`.

For unit tests, `PeerTransport`, `SignalingSocket`, and the repository are
mocked, while crypto and framing are real — matching the plan's
"mock signaling/WebRTC, real crypto + framing" rule.

## Invitation (fragment URL)

- Conversation ID: `randomBytes(16)` (128 bits), formatted as 32 lowercase
  hex characters. Used as the broker room id and in the URL fragment.
- `formatInvitation(conversationId, baseUrl)` → `"<baseUrl>#<hex>"`.
- `formatCodedInvitation(conversationId, baseUrl, code)` →
  `"<baseUrl>#<hex>~<6-digit-code>"`, used for PAKE conversations.
- `parseInvitation(fragment)` validates the hex and returns
  `{ conversationId, code }`, where `code` is `string | null`. The fragment
  matches `^[0-9a-f]{32}(~\d{6})?$`.
- The fragment is never sent in an HTTP request path or query — it lives
  only in `location.hash`.

## Application-layer handshake

Runs in-band over the WebRTC data channel (a DTLS-encrypted transport, not
yet application-authenticated). The safety-number mode is two rounds; PAKE
mode adds two more rounds after the signature.

**Hello.** Each peer sends its unsigned handshake components:

```
HelloMessage = protocolVersion(1) | identityPublicKey(65) | ephemeralPublicKey(65) | sessionId(32)
                                                                                       = 163 bytes
```

**Signature.** Each peer, now knowing both peers' identity keys, ephemeral
keys, and session ids, builds the canonical `Transcript` (canonical
initiator/responder order via `deriveRole`), signs it with its identity
private key, and sends:

```
SignatureMessage = protocolVersion(1) | signature(64) = 65 bytes
```

The receiver builds the identical transcript and verifies the peer's
signature against the peer's identity public key (`verifyTranscript`). A
verification failure is terminal for that attempt. The state moves to
`Verifying` here.

**PAKE exchange (only when `AuthMode = Pake`).** After the signature is
verified, each peer sends its SPAKE2 share, then a confirmation tag:

```
PakeShareMessage   = protocolVersion(1) | sideByte(1) | share(33)   = 35 bytes
PakeConfirmMessage = protocolVersion(1) | sideByte(1) | confirmTag(32) = 34 bytes
```

`sideByte` is `0x41` ('A') for the initiator, `0x42` ('B') for the responder.
The SPAKE2 shared secret and confirmation are described in the protocol spec
(§7); the confirmation tag is keyed by the shared secret over the transcript
hash, so a wrong code makes the tags mismatch and the handshake abort.

Field widths are fixed; decoding rejects the wrong length or version before
any allocation (the same "validate before allocate" rule as the main codec).

### Keying facts

- `deriveSessionKeys({ localEcdhPrivateKey, peerEcdhPublicKey, transcript,
localIdentityPublicKey, pakeSecret? })` resolves role internally by
  matching `localIdentityPublicKey` against the transcript's
  initiator/responder identity keys and returns `{ sendKey, recvKey }`.
- For `AuthMode.Pake`, `pakeSecret` is required — `deriveSessionKeys` refuses
  to fall back to safety-number-only derivation when the mode says PAKE.
- Both peers must build byte-identical `Transcript` objects (same
  `conversationId`, same canonical key/session ordering).
- `FrameReceiver` enforces `aad.senderSessionId === peerSessionId` — set
  `peerSessionId` to the remote's `sessionId`.
- Sequences are uint32, monotonic across all frame types, capped at
  `MAX_SEQUENCE`.

## Lifecycle / states

The orchestrator drives `ConnectionStateMachine`
(`packages/chat-runtime/src/signaling/state-machine.ts`):
`Idle → Waiting → Signaling → Handshaking → Verifying → Connected → Disconnected`.

- Initiator: `start()` → generate invitation → `Waiting`.
- Responder: `join(fragment)` → parse → `Signaling` (connect broker, join
  room).
- Signaling events (offer/answer/ice) → drive `WebRtcAdapter`.
- Data channel open → `Handshaking` → run handshake → `Verifying`.
- Signature verified and keys derived → `Connected`; call
  `signalingClient.signalP2pOpen()` to release the broker room.
- Drop → `Disconnected`; `retry()` → `Disconnected → Signaling`.
- `leave()` → send an encrypted `Leave` control frame, tear down, and clear
  ephemeral session state (keys, nonces, replay windows, SDP/ICE, handshake
  material).

## TOFU and safety number

- First contact: after a verified handshake, store the peer identity via
  `repo.storePeerIdentity(conversationId, fingerprint, peerPublicKey)`.
- `fingerprint` is the safety-number string from
  `computeSafetyNumber(conversationId, localIdPub, peerIdPub)`, used both as
  the human-comparable value and as the stored identity tag.
- Resume: compare the incoming peer identity key against
  `repo.getPeerIdentity`. A mismatch is a blocking identity-change state —
  the orchestrator never silently replaces it.
- The displayed safety number is labelled "unverified" until the user marks
  it compared. (UI concern; the orchestrator exposes the value and a
  `verified` flag.)
- Under `AuthMode.Pake`, the SPAKE2 exchange authenticates the handshake
  directly; the safety number is still computed and shown, but the
  out-of-band comparison is not required.

## Persistence

Plaintext text goes through `repo.appendMessage(id, text, direction,
timestamp)`; the repository applies AES-GCM at rest. Files and media are
ephemeral (framing only) and never persisted.

The repository is in-memory in the current build. `serialize()` and
`reload()` exist on the repository interface for round-tripping through
durable storage, but conversation history is not currently persisted to
`localStorage` on changes — it lives in memory and is lost on reload unless
captured in an export/import bundle. The OPFS-backed repository
(`BrowserDbConversationRepository`) remains an unimplemented stub. Only the
identity-change warning flag uses a durable storage layer today.
