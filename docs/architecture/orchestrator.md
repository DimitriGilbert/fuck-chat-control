# Conversation Orchestrator — Design

This is the integration layer that ties together crypto, framing, signaling,
WebRTC, and the conversation store. It owns the conversation lifecycle state
machine and the application-layer handshake. It is the **only** module that
coordinates the others; React never touches keys, frame codecs, data channels,
or the DB directly.

Auth in v1 is **safety-number-only** (no PAKE — see HANDOFF.md §2 and ADR 001).

## Module layout

`apps/web/src/features/chat/orchestrator/`

- `invitation.ts` — CSPRNG conversation-id generation + fragment-URL parsing.
- `handshake-codec.ts` — plaintext handshake message encode/decode (pre-key).
- `orchestrator.ts` — the `ConversationOrchestrator` class + state wiring.
- `errors.ts` — orchestrator error codes.
- `index.ts` — barrel.

Tests live under `apps/web/tests/unit/orchestrator/`.

## The receive-path gap and how we close it

`FrameTransport` (framing) is **send-only**: it has `send(bytes)` but delivers
inbound bytes to the caller via `FrameReceiver.ingest`. The orchestrator must
own message routing because, during the handshake phase, incoming bytes are
**plaintext handshake messages**, not yet encrypted frames.

The orchestrator accepts a `PeerTransport` (a thin receive-capable contract):

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

`DataChannelTransport` (signaling/webrtc-adapter.ts) gains `setOnMessage`,
wired to the underlying `RTCDataChannel` `onmessage` (`binaryType =
"arraybuffer"`). It already has `send`, `ready`, `bufferedAmount`,
`setDrainListener`, `close` — so it satisfies `PeerTransport` after that
one-method addition.

The orchestrator's single receive handler then branches on phase:

```
onMessage(bytes):
  if handshake not complete → parse handshake message
  else                       → frameReceiver.ingest(bytes)
```

After the handshake, the same `DataChannelTransport` instance is handed to
`FrameSender` (it already satisfies `FrameTransport`) and its inbound stream is
routed to `FrameReceiver.ingest`.

For unit tests we mock `PeerTransport` + `SignalingSocket` + the repo (real
crypto + framing), per the plan's "mock signaling/WebRTC, real crypto+framing"
rule.

## Invitation (fragment URL)

- Conversation ID: `randomBytes(16)` (128 bits), wrapped via
  `encodeConversationId`. Formatted as 32 lowercase hex chars for the broker
  room id and the URL fragment.
- URL fragment forms (PRD §Link structure):
  - `#<32-hex-conversationId>` — safety-number only (v1).
- `parseInvitation(fragment)` validates the hex and returns
  `{ conversationId }`. The fragment is **never** sent in an HTTP request path
  or query — it lives only in `location.hash`.
- `formatInvitation(conversationId, baseUrl)` → `"<baseUrl>#<hex>"`.

(No `~<code>` form exists in v1 — PAKE was dropped.)

## Application-layer handshake (in-band over the data channel)

Runs over the WebRTC data channel (DTLS-encrypted transport, not yet
application-authenticated). Two rounds:

**Round 1 — Hello.** Each peer sends its unsigned handshake components:

```
HelloMessage = protocolVersion(1) | identityPublicKey(65) | ephemeralPublicKey(65) | sessionId(32)
                                                                                       = 163 bytes
```

**Round 2 — Signature.** Each peer, now knowing BOTH peers' identity keys,
ephemeral keys, and session ids, builds the canonical `Transcript` (canonical
initiator/responder order via `deriveRole`), signs it with its identity private
key, and sends:

```
SignatureMessage = protocolVersion(1) | signature(64) = 65 bytes
```

Receiver builds the identical transcript, verifies the peer's signature against
the peer's identity public key (`verifyTranscript`), then both call
`deriveSessionKeys`. A verification failure is terminal for that attempt.

Field widths are fixed; decoding rejects the wrong length / version before any
allocation (same "validate before allocate" rule as the main codec).

### Keying facts (from the API reference — do not re-derive)

- `deriveSessionKeys({ localEcdhPrivateKey, peerEcdhPublicKey, transcript,
localIdentityPublicKey })` resolves role internally by matching
  `localIdentityPublicKey` against the transcript's initiator/responder identity
  keys and returns `{ sendKey, recvKey }`.
- Both peers MUST build byte-identical `Transcript` objects (same
  `conversationId`, same canonical key/session ordering).
- `FrameReceiver` enforces `aad.senderSessionId === peerSessionId` — set
  `peerSessionId` to the remote's `sessionId`.
- Sequences are uint32, monotonic across all frame types, cap at
  `MAX_SEQUENCE`.

## Lifecycle / states

Drives `ConnectionStateMachine` (`signaling/state-machine.ts`):
`Idle → Waiting → Signaling → Handshaking → Verifying → Connected → Disconnected`.

- Initiator: `start()` → generate invitation → `Waiting`.
- Responder: `join(fragment)` → parse → `Signaling` (connect broker, join room).
- Signaling events (offer/answer/ice) → drive `WebRtcAdapter`.
- Data channel open → `Handshaking` → run handshake → `Verifying`.
- Signature verified + keys derived → `Connected`; call
  `signalingClient.signalP2pOpen()` to release the broker room.
- Drop → `Disconnected`; `retry()` → `Disconnected → Signaling`.
- `leave()` → send encrypted `Leave` control frame, teardown, clear ephemeral
  session state (keys, nonces, replay windows, SDP/ICE, handshake material).

## TOFU + safety number

- First contact: after a verified handshake, store the peer identity via
  `repo.storePeerIdentity(conversationId, fingerprint, peerPublicKey)`.
- The `fingerprint` is the safety-number string from
  `computeSafetyNumber(conversationId, localIdPub, peerIdPub)` (used as the
  human-comparable + stored identity tag).
- Resume: compare the incoming peer identity key against
  `repo.getPeerIdentity`. A mismatch is a **blocking** identity-change state —
  never silently replace.
- The displayed safety number is labeled "unverified" until the user marks it
  compared (UI concern; orchestrator exposes the value + a `verified` flag).

## Persistence

Plaintext text goes through `repo.appendMessage(id, text, direction,
timestamp)`; the repo applies AES-GCM at rest. Files/media are ephemeral
(framing only) and never persisted.
