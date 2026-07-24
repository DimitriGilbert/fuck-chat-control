# Implementation Plan: Serverless E2E-Encrypted P2P Chat

## Baseline Constraints

- Do not scaffold, initialize, replace, or otherwise redo the existing application setup.
- Retain the existing pnpm workspace, Better-T-Stack/Vite Plus setup, TanStack Start app, routes, Docker files, UI package, and generated route-tree workflow.
- The detected package manager is `pnpm@10.33.4`.
- The app is `apps/web`; the shared shadcn package is `packages/ui`.
- Root commands already include `build`, `check-types`, `check`, `lint`, and `format`.
- There are currently no direct Vitest or Playwright test harnesses. Add them without changing the application scaffold.
- Non-UI code uses strict TDD vertical slices: one public behavior test fails, the smallest implementation makes it pass, then refactor while green.
- Do not write DOM-shim, jsdom, Testing Library, or component unit tests for the UI. UI behavior is verified only through Playwright in real browsers.
- Every implementation sub-phase has a separate implementer and validator. Validators read changed code, run gates independently, and do not modify it. Fixers address all reported findings at once. Maximum three fix-and-revalidate loops per phase.

## Architectural Boundaries

- “Serverless” means the server leaves the data path after a WebRTC data channel opens. It does not mean no HTTP/WebSocket broker or UDP STUN listener exists.
- The broker and STUN listener are operated by the same deployment. No third-party STUN or TURN service is used.
- WebCrypto does not provide SPAKE2 or Argon2. Approve maintained, independently reviewed browser-compatible implementations before crypto code begins.
- TanStack Start HTTP route support is not by itself proof of WebSocket-upgrade support. Prove the selected Nitro/h3/runtime upgrade integration before building the broker.
- The broker has no persistence, presence record, completed-room history, analytics, telemetry, or application logging. Infrastructure logs are outside application code control and must be minimized operationally.
- STUN is stateless and sees a source IP only long enough to return a NAT mapping. It never receives a room ID, identity, invitation, or chat payload.
- Two participants in E2E testing require separate browser contexts with isolated browser storage and identities.
- Auto-key at-rest encryption does not protect an unlocked browser profile. The UI and security documentation must say this plainly.
- A six-digit PAKE code is limited entropy. A failed PAKE attempt permanently blocks that invitation locally; recovery requires a fresh invitation.
- Persist only encrypted text history and permitted local metadata. Never persist file content, transfer buffers, traffic keys, PAKE material, SDP, ICE candidates, signaling frames, or diagnostics.

## Phase 1: Baseline Validation And Test Harnesses

**Type:** Sequential. No dependency.

### Scope

Add verification infrastructure only around the existing workspace.

### Files

- Modify root and `apps/web` package scripts as necessary.
- Add `apps/web/vitest.config.ts`.
- Add `apps/web/playwright.config.ts`.
- Add Playwright smoke tests under `apps/web/tests/e2e/`.
- Add non-UI `*.test.ts` files only as vertical slices start.
- Optionally add Playwright artifacts to `.gitignore`.

### Requirements

- Add direct `vitest` and `@playwright/test` dependencies to `apps/web`.
- Add `test:unit`, `test:e2e`, and aggregate `test` scripts.
- Configure Vitest with the Node environment only. No jsdom.
- Configure Playwright to use the existing application command on a fixed local port.
- Run Chromium, Firefox, and WebKit.
- Retain trace, screenshot, and video artifacts only for failed E2E tests.
- Add a real-browser smoke test that loads `/` and verifies the current page renders.
- Install browser binaries with:

```sh
pnpm --filter web exec playwright install --with-deps chromium firefox webkit
```

### TDD And Acceptance

- RED: tests/configuration cannot run.
- GREEN: one Node behavior test and one real-browser smoke test pass.
- REFACTOR: normalize helpers and artifact paths only after green.
- No React component is imported by Vitest tests.

### Gate

```sh
pnpm check
pnpm build
pnpm --filter web test:unit
pnpm --filter web test:e2e
```

## Phase 2: Fixed shadcn Installation

**Type:** Sequential. Depends on Phase 1. Complete before application UI work.

### Existing Components

The shared UI package already includes:

- `message-scroller`
- `message`
- `marker`
- `bubble`
- `attachment`
- `input-group`
- `button`
- `input`
- `textarea`
- `empty`
- `sonner`
- `card`
- `label`
- `tooltip`
- `dropdown-menu`
- `checkbox`

### Fixed Component Selection

| Purpose | Components |
| --- | --- |
| Chat transcript | `message-scroller`, `message`, `bubble`, `marker` |
| Attachments and progress | `attachment`, `progress` |
| Composer | `input-group`, `textarea`, `button`, `tooltip` |
| Conversation list and empty states | `card`, `empty`, `skeleton` |
| Confirmations | `dialog`, `alert-dialog` |
| Settings and import/export | `sheet`, `tabs` |
| Menus and labels | `dropdown-menu`, `checkbox`, `label` |
| Notifications | `sonner` |

### Exact Install Commands

```sh
pnpm --dir packages/ui exec shadcn add -y message-scroller message marker bubble attachment input-group button input textarea empty sonner card label tooltip dropdown-menu checkbox skeleton
pnpm --dir packages/ui exec shadcn add -y dialog alert-dialog progress sheet tabs
pnpm --dir packages/ui exec shadcn view message-scroller message marker bubble attachment input-group dialog alert-dialog progress sheet tabs
pnpm --dir packages/ui run check-types
```

### Decisions

- `message-scroller`, `message`, `marker`, `bubble`, and `attachment` are fixed official shadcn registry choices.
- `InvitationQrCode` is a minimal app-owned wrapper around an approved QR encoder because QR generation is product behavior, not a shadcn primitive.
- Use browser file input and drag/drop APIs; do not add an upload block.
- Do not install AI chat blocks, AI SDK components, streaming, tool-call, or reasoning UI.

### Gate

```sh
pnpm --dir packages/ui run check-types
pnpm check
pnpm build
```

## Phase 3: Protocol Specification And Dependency Decisions

**Type:** Sequential. Depends on Phases 1 and 2.

### Outputs

- `docs/architecture/protocol-v1.md`
- `docs/architecture/threat-model.md`
- `docs/adr/00x-pake-and-argon2-dependencies.md`
- Protocol types, canonical codec, and immutable known-answer fixtures under `apps/web/src/features/chat/`.

### Freeze Before Implementation

- Canonical binary transcript version and field ordering.
- P-256 public-key and signature encodings.
- Initiator/responder role derivation and perfect-negotiation tie breaker.
- HKDF labels for directional traffic keys.
- Per-direction nonce derivation from session ID plus sequence number.
- Frame AAD: version, session ID, sender sequence, frame type, transfer ID, and chunk ID.
- Hard limits for room ID, text frame, manifest, file, chunk, transfer count, buffered bytes, replay window, handshake time, and parsing time.
- Export-bundle version and canonical serialization.
- Exact SPAKE2 variant, group, encoding, library, Argon2 parameters, and PAKE-failure persistence behavior.

### TDD And Acceptance

- RED: malformed data is accepted because no validating codec exists.
- GREEN: canonical codec rejects invalid versions, lengths, enums, and limit violations.
- REFACTOR: isolate byte and validation helpers.
- Cite KAT sources; self-consistency tests alone are insufficient.
- Parsing must prevent unbounded allocation before application payload allocation.

### Gate

```sh
pnpm --filter web test:unit -- protocol
pnpm check
```

## Phase 4: Crypto And Local Key Management

**Type:** Sequential. Depends on Phase 3.

### Modules

- Identity generation/import/export/sign/verify.
- ECDH session key agreement, transcript construction, and directional HKDF keys.
- AES-256-GCM encryption and deterministic nonce derivation.
- Safety number calculation and rendering.
- PAKE adapter using the approved SPAKE2 library.
- At-rest key management, Argon2 wrapping, and lock state.

### TDD Vertical Slices

1. Identity: RED invalid sign/verify behavior; GREEN P-256 public byte API; REFACTOR hides `CryptoKey` details.
2. Session keys: RED peers cannot derive matching directional keys; GREEN ECDH plus transcript hash and HKDF; REFACTOR makes one canonical transcript source.
3. AEAD: RED tampered/repeated sequence is accepted; GREEN encryption, decryption, unique nonce, and replay rejection; REFACTOR centralizes AAD/nonce construction.
4. Safety number: RED not symmetric or stable; GREEN per-conversation 40-bit grouped decimal number.
5. PAKE: RED matching/mismatched behavior absent; GREEN matching code succeeds and mismatch is terminal with failure marker; REFACTOR hides implementation behind a narrow adapter.
6. At rest: RED round-trip/wrong-passphrase failure absent; GREEN auto key and Argon2 wrapped key with explicit lock state.

### Mandatory Tests

- AES-GCM, HKDF, ECDSA, and SPAKE2 KATs.
- P-256 validity for identities and ephemeral keys.
- Transcript substitutions for room ID, role, mode, session ID, identity, and ephemeral key.
- No requested-PAKE fallback to ECDH-only keys.
- Fresh session keys on reconnection.
- Wrong key, signature, and ciphertext failure.
- Safety number symmetry, stability, and change behavior.
- Wrong passphrase rejection.

### Acceptance

- Crypto accepts and returns bytes/plain data only.
- Crypto imports no React, DOM, WebRTC, signaling, or storage implementation.
- No `Math.random`, caller nonces, implicit encoding, or mutable transcript objects.

### Gate

```sh
pnpm --filter web test:unit -- crypto
pnpm check
pnpm build
```

## Phase 5: Encrypted Frames And Ephemeral Transfers

**Type:** Sequential. Depends on Phase 4. Can run in parallel with Phase 6 after Phase 4 passes.

### TDD Vertical Slices

1. Encrypted text frame round-trip.
2. Replay-window and wrong-session rejection.
3. Authenticated manifest before allocation.
4. Bounded chunking and reassembly.
5. Hash verification, cancellation, and teardown cleanup.
6. Backpressure that reserves capacity for text and control frames.

### Acceptance

- Reject replayed, stale, duplicate, wrong-session, malformed, oversize, and bad-signature frames.
- A manifest authenticates name, size, MIME type, transfer ID, chunk count, and content hash.
- File data never reaches the conversation persistence API.
- Cancellation, failure, and teardown release transfer buffers.
- Preserve ordered, reliable, single-data-channel v1 behavior.

### Gate

```sh
pnpm --filter web test:unit -- framing
pnpm check
pnpm build
```

## Phase 6: Encrypted Local Store And Export/Import

**Type:** Sequential. Depends on Phase 4. Parallel with Phase 5 only after Phase 4 validation.

### Scope

- Use `@tanstack/db`, `@tanstack/browser-db-sqlite-persistence`, wa-sqlite/OPFS, IndexedDB fallback, and a dedicated persistence worker.
- Persist conversation metadata, encrypted text, peer fingerprint, display name, PAKE-failure marker, and locally protected identity/at-rest key material.
- Do not persist files, transfer buffers, traffic keys, diagnostics, SDP, ICE, or signaling messages.
- Implement per-conversation clear, full wipe, encrypted export, import merge, and import replace.

### TDD Vertical Slices

1. Conversation and encrypted-text round trip.
2. TOFU identity and display-name update.
3. Per-conversation and full wipe.
4. Export/import and wrong passphrase.
5. Merge and replace behavior for duplicate/conflicting data.

### Acceptance

- Test repositories through public APIs against in-memory TanStack DB, never SQLite internals.
- Demonstrate stored text is ciphertext rather than plaintext.
- Malformed, unauthenticated, and wrong-passphrase imports fail atomically.

### Gate

```sh
pnpm --filter web test:unit -- store export
pnpm check
pnpm build
```

## Phase 7: Broker, STUN, Signaling, And WebRTC

**Type:** Sequential. Depends on Phases 3 through 5.

### TDD Vertical Slices

1. Broker room registry: enforce room-ID validation, two sockets maximum, immediate cleanup.
2. Broker protocol: accept only `join`, `offer`, `answer`, `ice`, and `leave`; forward SDP/ICE opaquely.
3. Signaling client: mock-broker join, relay, bidirectional ICE, close after P2P opening, and resumption.
4. Pure state machine: valid transitions and deterministic offer-collision handling without WebRTC.
5. Thin WebRTC adapter: STUN-only configuration, trickle ICE, ordered reliable channel, and clean teardown.
6. STUN: standards-compliant stateless UDP binding response without logging.

### Acceptance

- No database, files, room history, presence API, analytics, or app logs.
- Close, leave, error, timeout, failed handshake, and P2P success remove mappings immediately.
- Broker never relays application frames.
- The deployment exposes UDP `3478`, HTTPS/WSS, and documents both.
- Do not assume normal TanStack HTTP routes handle WebSocket upgrades.

### Gate

```sh
pnpm --filter web test:unit -- broker signaling webrtc stun
pnpm check
pnpm build
pnpm docker:build
```

## Phase 8: Conversation Orchestrator

**Type:** Sequential. Depends on Phases 4 through 7.

### Required Behaviors

- Generate CSPRNG conversation IDs of at least 128 bits.
- Generate optional six-digit verification codes.
- Parse only fragment invitations: `/#<conversationId>` and `/#<conversationId>~<code>`.
- Implement initiator and participant flows.
- Implement states: `idle`, `waiting`, `signaling`, `handshaking`, `verifying`, `connected`, `disconnected`.
- Use real crypto/framing with mock signaling/WebRTC adapters.
- Store TOFU identity only after complete authenticated handshake.
- Block identity changes during resumption.
- Reload local history, re-signal, establish fresh keys, and revalidate identity on resumption.
- Handle drop, retry, leave, capability failure, and cleanup.

### TDD Vertical Slices

1. Invitation generation and parsing.
2. ECDH-only first contact.
3. PAKE-authenticated handshake and terminal mismatch.
4. Text send, receive, and persistence.
5. Resume with fresh keys.
6. Identity mismatch blocks continuation.
7. Drop, retry, leave, and cleanup.

### Acceptance

- Only the orchestrator coordinates crypto, frames, signaling, WebRTC, and persistence.
- React does not access keys, frame codecs, data channels, or DB collections directly.
- Broker loss after P2P opening does not break an open chat.
- PAKE code never enters server requests, broker messages, logs, persistence, or exports.

### Gate

```sh
pnpm --filter web test:unit -- orchestrator
pnpm check
pnpm build
```

## Phase 9: Thin UI And Documentation

**Type:** Sequential. Depends on Phases 2, 6, and 8.

### UI Requirements

- Landing page explaining the purpose, limitations, no-account model, direct peer model, STUN-only limitation, and security documentation.
- Conversation list with display names and local history.
- Start flow with optional PAKE code, copy link, QR code, and waiting state.
- Automatic join and resume from URL fragment.
- Persistent status: waiting, connecting, handshaking, verification, connected, disconnected; PAKE-authenticated versus safety-number-only.
- Safety number dialog labeled unverified until independently compared; dismissal still permits chatting.
- Transcript uses exactly `MessageScroller`, `Message`, `Bubble`, and `Marker`.
- Composer uses `InputGroup` and `Textarea`; Enter sends and Shift+Enter creates a newline.
- File selection/drag-drop, transfer progress/cancel/save, and ephemeral-file warning.
- Clear-history/all-data confirmations, passphrase controls, export/import merge-or-replace flow.
- Capability/NAT failure state and retry.
- Audio and visual peer-join notification with an accessible non-audio fallback.

### Playwright E2E Coverage

1. Landing, docs, and mobile layout.
2. Create conversation, optional code, copy link, QR visibility.
3. Fragment parsing does not appear in server route paths.
4. Two isolated browser contexts establish a real P2P session.
5. Connection/PAKE state, safety dialog, dismissal, and keyboard flow.
6. Enter send, Shift+Enter newline, transcript ordering, timestamps, and sender indication.
7. File transfer progress, cancel, download affordance, and ephemeral warning.
8. Conversation list, reload/resume/history, and display-name update.
9. Identity change, PAKE failure, unavailable APIs, NAT failure, retry, and leave.
10. Clear/wipe warnings and export/import UX.
11. Broker disconnection after P2P opening does not interrupt text exchange.
12. Browser smoke in Chromium, Firefox, and WebKit.

### Acceptance

- React renders orchestrator state and delegates actions only.
- No duplicated security rules in components.
- No UI component unit tests.
- All UI requirements are real-browser Playwright tests.

### Gate

```sh
pnpm check
pnpm build
pnpm --filter web test:e2e
```

## Phase 10: Deployment Hardening And Release Verification

**Type:** Sequential. Depends on all previous phases.

### Requirements

- Docker exposes configured HTTP/HTTPS/WSS and UDP `3478`.
- Health checks do not produce application-level chat or broker logs.
- Runtime config contains only public endpoint details; no server-side message-key config exists.
- Document TLS, WSS, UDP reachability, reverse proxy WebSocket support, minimized infrastructure access logs, NAT limits, and no TURN.
- Confirm no telemetry, analytics, error-reporting service, or client data exfiltration was introduced.
- Run release E2E with two clean browser profiles and a containerized deployment.
- Do not add CI platform scaffolding unless separately approved.

### Gate

```sh
pnpm check
pnpm build
pnpm --filter web test:unit
pnpm --filter web test:e2e
pnpm docker:build
```

## Execution Rules

For every phase:

1. The implementer receives the complete phase requirements, file scope, tests, and gates.
2. Every non-UI behavior follows RED, GREEN, REFACTOR vertical TDD slices.
3. The implementer runs the gate before reporting completion.
4. A different validator reads all modified code, checks requirements and boundaries, and independently runs the gate.
5. A different fixer addresses every validator finding in one pass when needed.
6. Revalidate after each fix, up to three loops.
7. Phase 5 and Phase 6 require individual validation plus a phase-wide integration validation if run in parallel.
8. Never use `any`, `as any`, placeholder code, TODO/FIXME markers, unused imports/variables, console suppression, or `void` hacks.
9. Use `import type` for type-only imports.
10. Do not start a development server as part of implementation work.

## Decisions Required Before Implementation

1. Approve the SPAKE2 library, exact group/encoding, license, KAT source, and browser/WASM delivery model.
2. Approve the Argon2 implementation, parameters, worker strategy, and version/migration policy.
3. Approve the proven Nitro/h3/runtime WebSocket-upgrade mechanism for the installed versions.
4. Approve an audited STUN implementation. Do not hand-roll production STUN without protocol review.
5. Confirm hosting/proxy/container access logs can be disabled or minimized operationally.
6. Confirm failed PAKE invitations are permanently blocked locally and require fresh invitations.
7. Define merge handling for identity conflicts; never silently replace an identity.
8. Confirm the production-facing product name and metadata.
