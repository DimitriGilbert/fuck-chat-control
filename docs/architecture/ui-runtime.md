# UI & Runtime Glue Design

The browser runtime layer that sits between the `ConversationOrchestrator`
(pure logic, `attachTransport` seam) and React. The unit tests prove the
orchestrator with a loopback transport; this layer wires real WebRTC, the
broker, and persistent identity into it so a real conversation works
end-to-end in a browser.

The runtime core lives in `packages/chat-runtime/src/runtime/`. The React
glue that consumes it lives in `apps/web/src/features/chat/runtime/`.

## Layers

```
React (routes/components)
   │  useChat() hook
   ▼
ChatProvider (React context)  ── owns ChatController
   │
   ▼
ChatController  ── browser runtime glue (non-React; testable in isolation)
   ├── IdentityManager   (generate once, persist privateKey + publicKey to localStorage)
   ├── AtRestKeyManager  (generate at-rest key, persist; optional passphrase wrap)
   ├── ConversationRepository  (in-memory; serialize()/reload() available, not yet wired to localStorage)
   └── per-conversation: ConversationOrchestrator + WebRtcBridge
   ▼
WebRtcBridge  ── connects a SignalingClient + WebRtcAdapter to an orchestrator
```

The repository is in-memory in the current build. `serialize()` and
`reload()` are defined on the repository interface, but conversation history
is not round-tripped through `localStorage` on changes — it is held in
memory and lost on reload unless captured in an export/import bundle. The
OPFS-backed `BrowserDbConversationRepository` is still an unimplemented stub.
Only the identity-change warning flag currently uses the durable storage
layer.

## IdentityManager (`packages/chat-runtime/src/runtime/identity-manager.ts`)

- On first load: `generateIdentityKeyPair()`, persist both `privateKey`
  (base64) and `publicKey` (base64) to `localStorage` under a fixed key.
- On subsequent loads: read the bytes, rebuild `IdentityKeyPair` with
  `sign: (t) => signTranscript(privateKey, t)`. (`IdentityKeyPair` is
  `{ publicKey, privateKey, sign }`.)
- `publicKey` is a 65-byte SEC1 `PublicKey`; stored and restored via
  `encodePublicKey`.
- Synchronous after the first await; expose `get(): IdentityKeyPair`.

## AtRestKeyManager (`packages/chat-runtime/src/runtime/at-rest-key-manager.ts`)

- `generateAtRestKey()` on first run; persist the raw 32 bytes (base64) to
  `localStorage`.
- Optional passphrase mode: `wrapKey(passphrase, key)` is stored instead,
  unlocked with `unwrapKey` on app open (prompts the user). The default is
  an auto key (no passphrase) so the app works without setup; passphrase is
  a settings affordance.

## WebRtcBridge (`packages/chat-runtime/src/runtime/webrtc-bridge.ts`)

For one conversation it:

1. Holds a `ConversationOrchestrator`, a `SignalingClient` (real broker),
   and a `WebRtcAdapter`.
2. Drives perfect negotiation: signaling `onOffer` / `onAnswer` / `onIce`
   → `WebRtcAdapter.setRemoteDescription` / `addIceCandidate`; adapter
   `onIceCandidate` → `signalingClient.sendIce`; adapter connection-state
   → orchestrator state.
3. On data channel open: calls
   `orchestrator.attachTransport(toPeerTransport(dataChannelTransport))`,
   then `signalingClient.signalP2pOpen()` after a short grace to drop the
   broker from the data path.
4. Feeds signaling SDP/ICE straight to the `WebRtcAdapter`. The bridge owns
   the `SignalingClient` directly, so it does not rely on the orchestrator's
   remote-signal handlers; the orchestrator only needs the data channel
   (`attachTransport`).

Testable without a browser only at the seams that do not need an
`RTCPeerConnection`. The full path is validated by Playwright E2E and the
live two-browser run.

## ChatController (`packages/chat-runtime/src/runtime/chat-controller.ts`)

The single object React talks to. A plain TypeScript class (not React) so it
is testable in isolation. Its public API:

- `startConversation(options?: { code?: string }): Promise<{ invitation: string }>`
  — new orchestrator as initiator. Pass `{ code }` to start a PAKE
  conversation.
- `generatePakeCode(): string` — mint a 6-digit code for a PAKE invitation.
- `joinConversation(fragment)`, `resumeConversation(id)`,
  `selectConversation(id)`, `leaveConversation(id?)`, `leaveAll()`.
- `sendText(id, text)` (and a `sendText(text)` overload for the active
  conversation), `sendFile(id, file): Promise<number>`,
  `cancelTransfer(id, transferId)`, `getReceivedFile(id, transferId)`.
- `getHistory(id)` / `getHistory()`, `setDisplayName(id?, name)`,
  `markSafetyNumberVerified(id?)`, `retry(id?)`, `clearConversation(id?)`,
  `leave(id?)`, `clearAll()`.
- `lock()`, `unlock(passphrase): Promise<boolean>`, `isLocked()`.
- `getActiveConversationId()`, `listConversations()`,
  `exportBundle(passphrase)`, `importBundle(passphrase, bundle, mode)`.
- `subscribe(listener)`, `getState()`, `dispose()`.

It emits state changes through a subscribe/emit pattern that the React
provider turns into React state.

## ChatProvider (`apps/web/src/features/chat/runtime/chat-provider.tsx`)

- React context exposing a `useChat()` hook that returns
  `{ controller, state }`.
- Constructs the `ChatController` once, client-side only — guarded against
  SSR (TanStack Start SSRs, so identity/repository/WebRTC construction must
  be in a `useEffect` or client-only path).
- Re-renders consumers on controller state changes.
- Resolves browser dependencies at runtime: the broker URL is derived from
  `window.location` as `${https ? "wss" : "ws"}://${host}/ws`, and the ICE
  servers are fetched from `/ice-config` (falling back to `[]` on failure).
  The SPAKE2 WASM module URL is configured here.

## Routes (TanStack file routes)

Routes live in `apps/web/src/routes/`.

- `/` — landing page (purpose, security model, no-account, STUN/TURN
  coverage, link to docs) plus the conversation list and the conversation
  view. The conversation view is hash-driven on `/`: joining is `/#<hex>`
  (or `/#<hex>~<code>` for PAKE), parsed from `window.location.hash`. There
  is no `/start` route and no `/c/$conversationId` server route — the
  invitation lives entirely in the fragment and never reaches the server.
- `/docs/`, `/docs/protocol`, `/docs/security`, `/docs/deployment`,
  `/docs/threat-model` — the rendered documentation pages.
- Settings sheet: passphrase controls, export/import, clear/wipe.

## Key behavioral rules

- Composer: Enter sends, Shift+Enter adds a newline.
- The transcript uses exactly `MessageScroller`, `Message`, `Bubble`,
  `Marker`.
- The safety-number dialog is labelled "unverified" until the user marks it
  compared; dismissing it still permits chatting.
- Status is always shown (waiting / connecting / handshaking / verifying /
  connected / disconnected), with the authentication provenance
  ("safety number" vs "PAKE") surfaced in the status bar.
- File selection and drag-drop; transfer progress, cancel, and save; an
  ephemeral warning that files are not stored.
- Fragment parsing must not appear in server route paths.
- A NAT/connection failure shows a state with a retry.

## Verification

- Playwright E2E against a real dev server, two isolated browser contexts,
  loopback WebRTC (no STUN needed locally). Includes a dedicated suite for
  PAKE-coded invitations.
- Live two-browser E2E (via agent-browser), proving a real conversation
  works between two profiles.
