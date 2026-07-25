# Phase 9 — UI & Runtime Glue Design

This addendum defines the browser runtime layer that sits between the
`ConversationOrchestrator` (pure logic, `attachTransport` seam) and React. It is
what makes a _real_ conversation work end-to-end in a browser — the unit tests
prove the orchestrator with a loopback transport; this layer wires real WebRTC

- the broker + persistent identity into it.

## Layers

```
React (routes/components)
   │  useChat() hook
   ▼
ChatProvider (React context)  ── owns ChatController
   │
   ▼
ChatController  ── the browser runtime glue (NON-React; testable in isolation)
   ├── IdentityManager   (generate once, persist privateKey to localStorage)
   ├── AtRestKeyManager  (generate at-rest key, persist; optional passphrase wrap)
   ├── ConversationRepository  (InMemoryConversationRepository for v1*)
   └── per-conversation: ConversationOrchestrator + WebRtcBridge
   ▼
WebRtcBridge  ── connects a SignalingClient + WebRtcAdapter to an orchestrator
```

\* v1 persists via `InMemoryConversationRepository` + an at-rest key, with
`serialize()`/`reload()` round-tripped through `localStorage` on changes (the
export-bundle / SerializedState shapes already exist). The `BrowserDbConversationRepository`
(OPFS) remains a documented stub for a later hardening pass — NOT required for
the user's "chat must work" bar.

## IdentityManager (`apps/web/src/features/chat/runtime/identity-manager.ts`)

- On first load: `generateIdentityKeyPair()`, persist `privateKey` (base64) +
  `publicKey` (base64) to `localStorage` under a fixed key.
- On subsequent loads: read the bytes, rebuild `IdentityKeyPair` with
  `sign: (t) => signTranscript(privateKey, t)` (the crypto module exposes
  `signTranscript`; `IdentityKeyPair` is `{ publicKey, privateKey, sign }`).
- `publicKey` is a 65-byte SEC1 `PublicKey`; store/restore via `encodePublicKey`.
- Synchronous after first await; expose `get(): IdentityKeyPair`.

## AtRestKeyManager (`apps/web/src/features/chat/runtime/at-rest-key-manager.ts`)

- `generateAtRestKey()` on first run, persist the raw 32 bytes (base64) to
  `localStorage`.
- Optional passphrase mode: `wrapKey(passphrase, key)` stored instead, unlocked
  via `unwrapKey` on app open (prompts the user). v1 default = auto-key (no
  passphrase) so the app "just works"; passphrase is a settings affordance.

## WebRtcBridge (`apps/web/src/features/chat/runtime/webrtc-bridge.ts`)

This is the missing link. For ONE conversation it:

1. Holds a `ConversationOrchestrator` + a `SignalingClient` (real broker) +
   a `WebRtcAdapter`.
2. Drives perfect negotiation: signaling `onOffer/onAnswer/onIce` →
   `WebRtcAdapter.setRemoteDescription/addIceCandidate`; adapter
   `onIceCandidate` → `signalingClient.sendIce`; adapter connection-state →
   orchestrator state.
3. On data channel open: calls `orchestrator.attachTransport(toPeerTransport(dataChannelTransport))`,
   then `signalingClient.signalP2pOpen()` to drop the broker from the data path.
4. Wires the orchestrator's `onRemoteOffer/onRemoteAnswer/onRemoteIce` (these
   are surfaced FROM the signaling layer THROUGH the orchestrator) — actually,
   since the bridge owns the SignalingClient directly, the bridge feeds
   signaling SDP/ICE straight to the WebRtcAdapter and does NOT rely on the
   orchestrator's remote-signal handlers. The orchestrator only needs the data
   channel (`attachTransport`). (Slice 3c added the remote-signal handlers for
   completeness; the bridge is the consumer.)

Testable without a browser only at the seams that don't need RTCPeerConnection;
the full path is validated by Playwright E2E + the live agent-browser run.

## ChatController (`apps/web/src/features/chat/runtime/chat-controller.ts`)

The single object React talks to. Non-React (plain TS class) so it's testable.

- `startConversation(): Promise<{ invitation: string }>` → new orchestrator
  (initiator), persist conversation, WebRtcBridge begins.
- `joinConversation(fragment: string): Promise<void>` → responder.
- `sendText(text)`, `leave()`, `retry()`, `markSafetyNumberVerified()`.
- `listConversations()`, `getHistory(convId)`, `setDisplayName(convId, name)`,
  `clearConversation(convId)`, `clearAll()`.
- `exportBundle(passphrase)`, `importBundle(passphrase, bundle, mode)`.
- Emits state changes via a subscribe/emit pattern the React provider turns
  into React state.

## ChatProvider (`apps/web/src/features/chat/runtime/chat-provider.tsx`)

- React context exposing a `useChat()` hook returning `{ controller, state }`.
- Constructs the ChatController once (client-side only — guard against SSR;
  TanStack Start SSRs, so identity/repo/WebRTC construction must be in a
  `useEffect` / client-only path).
- Re-renders consumers on controller state changes.

## Routes (TanStack file routes)

- `/` — landing (purpose, security model, no-account, STUN-only limitation,
  link to docs) + conversation list (resume prior conversations).
- `/start` — initiator flow: "Start conversation" button → invitation link +
  copy + QR + waiting state.
- `/c/$conversationId` (or hash-driven `/` view) — chat view. The invitation
  lives in the **fragment**, so joining is `/#<hex>` (same route, hash parsed),
  NOT a new server route (fragment never hits the server — E2E scenario 3).
- Settings sheet: passphrase controls, export/import, clear/wipe.

## Key behavioral rules (from PRD + plan Phase 9)

- Composer: Enter sends, Shift+Enter newline.
- Transcript uses exactly `MessageScroller`, `Message`, `Bubble`, `Marker`.
- Safety number dialog labeled "unverified" until user marks compared;
  dismissal still permits chatting.
- Status always shown: waiting / connecting / handshaking / verification /
  connected / disconnected; safety-number-only vs (no PAKE in v1, so just
  "safety number" mode).
- File selection/drag-drop, transfer progress/cancel/save, ephemeral warning
  (files are NOT persisted).
- Fragment parsing must NOT appear in server route paths (E2E #3).
- Capability/NAT failure state + retry.

## Verification

- Playwright E2E (Phase 9c) against a real dev server, two isolated browser
  contexts, loopback WebRTC (no STUN needed locally).
- Live 2-browser E2E via agent-browser (the user's explicit demand) — proves a
  real conversation works between two profiles.
