# Handoff — fuck-chat-control (Serverless E2E-Encrypted P2P Chat)

**Date:** 2026-07-25
**Previous session duration:** ~6 hours
**Result of previous session:** PARTIAL. 6 of 10 phases solid, 1 broken on disk, 3 not started. Chat does not work yet. Homepage is still the ASCII banner placeholder.

---

## 1. What this project is

Serverless, no-account, E2E-encrypted 1:1 P2P chat over WebRTC. The server's only role is a stateless signaling broker (WebSocket) that relays SDP offer/answer + ICE between two peers, then drops out of the data path. Messages persist locally, encrypted at rest. TanStack Start monorepo (pnpm workspaces), React 19 SSR, shadcn/ui primitives.

**Read these first (do not re-derive):**

- `/home/didi/workspace/fck-chat-control/fuck-eu-chat-control.md` — the PRD (407 lines). Full product spec, threat model, user stories, cryptographic design.
- `/home/didi/workspace/fck-chat-control/IMPLEMENTATION_PLAN.md` — the 10-phase plan (454 lines). Phases, gates, TDD slices, constraints.
- `/home/didi/workspace/fck-chat-control/docs/architecture/protocol-v1.md` — frozen wire protocol (frame types, AAD, transcript, HKDF labels, nonce derivation, limits).
- `/home/didi/workspace/fck-chat-control/docs/architecture/threat-model.md`
- `/home/didi/workspace/fck-chat-control/docs/adr/001-crypto-dependencies.md`

---

## 2. Hard decisions already locked (do NOT revisit)

These were decided by the user and are non-negotiable:

- **NO PAKE / NO SPAKE2.** v1 uses safety-number comparison only (Signal-style). Drop all PAKE code, deps, tests, doc claims. Six-digit verification code does not exist in v1.
- **Crypto stack:** `@noble/curves` (P-256 ECDH + ECDSA), native WebCrypto (AES-256-GCM, HKDF-SHA256, SHA-256), `hash-wasm` (Argon2id for at-rest passphrase + export bundle). NO libsodium, NO argon2-browser, NO spake2 package.
- **WebKit browser tests are SKIPPED** (missing system libs in this sandbox; cannot sudo). Chromium + Firefox only locally. WebKit config can be re-added in CI.
- **STUN is NOT implemented** (plan forbids hand-rolling). WebRTC adapter accepts operator-configured STUN. Loopback dev/CI works without STUN. Document operator deploys coturn on UDP 3478.
- **No JSdom / Testing Library / component unit tests.** UI verified via Playwright only. Non-UI code is strict TDD.
- **User rejected the full plan's "Decisions Required Before Implementation" list** — those are resolved by the decisions above.

---

## 3. Phase-by-phase status

| Phase                           | Status                              | Tests                | Notes                                                                                                                                                                                                                                     |
| ------------------------------- | ----------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Test harnesses               | DONE                                | 2 unit + 1 e2e smoke | vitest (node env) + playwright (chromium+firefox).                                                                                                                                                                                        |
| 2. shadcn components            | DONE                                | —                    | 5 added: dialog, alert-dialog, progress, sheet, tabs.                                                                                                                                                                                     |
| 3. Protocol + codec             | DONE                                | 61                   | `src/features/chat/protocol/`. Canonical binary codec, validation-before-allocate.                                                                                                                                                        |
| 4. Crypto module                | DONE                                | 118                  | `src/features/chat/crypto/`. Identity, ECDH session keys, AEAD+replay, safety number, at-rest+Argon2. Bytes-only API.                                                                                                                     |
| 5. Framing                      | DONE                                | 44                   | `src/features/chat/framing/`. Encrypted frames, manifest, chunking, hash verify, backpressure.                                                                                                                                            |
| 6. Store + export/import        | DONE                                | 38                   | `src/features/chat/store/`. In-memory repo (ciphertext at rest), export bundle (Argon2-wrapped), merge/replace. `@tanstack/db` + `@tanstack/browser-db-sqlite-persistence` added as deps but browser-db-repo.ts is a NotImplemented stub. |
| 7. Broker/Signaling/WebRTC      | **BROKEN — on disk, gates failing** | 292 unit pass        | See §4 below.                                                                                                                                                                                                                             |
| 8. Orchestrator                 | NOT STARTED                         | —                    | Depends on 7.                                                                                                                                                                                                                             |
| 9. UI + routes + Playwright E2E | NOT STARTED                         | —                    | Homepage still ASCII banner.                                                                                                                                                                                                              |
| 10. Deployment hardening        | NOT STARTED                         | —                    |                                                                                                                                                                                                                                           |
| Live 2-browser E2E              | NOT STARTED                         | —                    | Was promised to user; never reached it.                                                                                                                                                                                                   |

**Total tests in the suite when last green:** 292 passing, 5 skipped (Phase 7 unit subset). Full suite fails only because of `tests/integration/broker-ws.test.ts`.

---

## 4. Phase 7 — exactly what's on disk and what's broken

**Files present (read before doing anything):**

- `apps/web/src/features/chat/broker/room-registry.ts` — in-memory room→sockets map, 2-peer max, cleanup. Unit-tested, PASS.
- `apps/web/src/features/chat/broker/protocol.ts` — broker JSON message codec (join/offer/answer/ice/leave). Unit-tested, PASS.
- `apps/web/src/features/chat/broker/connection.ts` — per-socket connection wrapper (assumed present, verify).
- `apps/web/src/server/broker.ts` — Nitro WebSocket handler using `defineWebSocketHandler` from `nitro`. Wraps crossws peers into BrokerSocket.
- `apps/web/src/features/chat/signaling/state-machine.ts` — idle/waiting/signaling/handshaking/verifying/connected/disconnected + glare handling.
- `apps/web/src/features/chat/signaling/signaling-client.ts` — broker client, WS abstracted for mock injection.
- `apps/web/src/features/chat/signaling/webrtc-adapter.ts` — RTCPeerConnection + RTCDataChannel wrapper, adapts to framing's FrameTransport interface.
- `apps/web/vite.config.ts` — modified: `nitro({ features: { websocket: true }, handlers: [{ route: "/ws", handler: "./src/server/broker.ts" }] })`.

**Tests present:**

- `apps/web/tests/unit/broker/` (room-registry, protocol) — PASS
- `apps/web/tests/unit/signaling/` (state-machine, signaling-client) — PASS
- `apps/web/tests/integration/broker-ws.test.ts` — **FAILING. This is the critical bug.**

**The bug:** `broker-ws.test.ts` has `BOOT_TIMEOUT_MS = 120_000`. Its `beforeAll` spawns the dev server via `spawn(VP_BIN, ["dev"])` and polls `http://127.0.0.1:3001/` for up to 2 minutes. The dev server never becomes ready within that window, so the test (and therefore the whole `pnpm test:unit` run) fails after burning 120 seconds.

**Why this poisoned the whole session:** the file lives under `tests/integration/` but vitest's include glob picks it up on every `test:unit` run. So every phase gate after Phase 7 paid a 2-minute tax and ended in failure. Subagents dispatched to fix it ran gates → 2-min wait → fail → retry → 2-min wait → fail, burning an hour per dispatch.

**What the next agent must do FIRST:**

1. Boot the dev server manually (`pnpm --filter web dev` from repo root) and read its actual output. Determine whether:
   (a) the Nitro `features: { websocket: true }` + `handlers: [...]` wiring is even valid for the installed nitro version (check `apps/web/package.json` — nitro is `^3.0.260610-beta`, a beta);
   (b) the server boots at all on port 3001;
   (c) `/ws` actually upgrades to WebSocket.
2. Either fix the broker wiring so the server boots and `/ws` upgrades, OR fix the test (e.g. move it out of the unit glob into a separate `test:integration` script with a shorter boot timeout, AND make it skip cleanly when the server can't start).
3. The unit-test glob (`apps/web/vitest.config.ts` → `include: ["tests/unit/**/*.test.ts"]`) must NOT pick up integration tests. This separation is the structural fix.

**Suspected root cause to investigate first:** `nitro/vite` plugin `handlers` option shape may not match the installed version, or `defineWebSocketHandler` / crossws peer shape differs. The `wrapPeer` in `broker.ts:10-19` defines its own `CrosswsPeer` interface (suspicious — suggests the real crossws types weren't importable or didn't match).

---

## 5. Honest notes on what went wrong in the previous session

(Read this so you don't repeat it.)

- **Oversized dispatches.** Phases 5, 6, 7 were each sent as single subagent prompts with 6 TDD slices + multiple investigations. They hit context limits and got killed. The orchestration skill explicitly says: "Every phase must fit comfortably in a single agent's context window. If too large, MUST be split." Violated repeatedly.
- **Trust status over disk.** When a dispatch returned "cancelled," the previous agent assumed "nothing happened" and re-dispatched the same oversized prompt. In reality, work had often partially landed. Always `ls`/`glob` the expected output paths before re-dispatching.
- **No review of test infrastructure.** The 120s boot-timeout integration test was dropped into the unit glob and never caught. Every subsequent gate run paid the tax.
- **User set a hard expectation of "don't come back before done" + "live E2E yourself."** The previous agent optimized for looking busy (dispatching subagents) instead of for working software. Six hours produced a lot of unit tests and zero working chat.

---

## 6. Suggested execution order for the next session

1. **Fix Phase 7 first.** Boot dev server manually, read output, fix broker wiring + move integration test out of unit glob. Get `pnpm --filter web test:unit` fully green in under 30 seconds.
2. **Validate Phase 7 with a real WS smoke.** A 10-line node script using the `ws` client: connect to `ws://localhost:3001/ws`, send `{t:"join",roomId:"..."}`, confirm it doesn't get kicked. This proves the broker works before building the orchestrator on top of it.
3. **Phase 8 — Orchestrator.** Wires crypto + framing + signaling + store. TDD slices from the plan. Mock signaling/WebRTC, real crypto+framing. ~7 slices.
4. **Phase 9 — UI.** This is where the homepage stops being an ASCII banner. Routes: `/` (landing + conversation list), `/start`, `/join/#<convId>`, chat view. Use the shadcn primitives already in packages/ui (message, bubble, marker, message-scroller, input-group, etc.). Composer: Enter sends, Shift+Enter newline. Then the Playwright E2E suite (12 scenarios in the plan).
5. **Live 2-browser E2E.** The user explicitly wants the assistant to run agent-browser with two isolated profiles and prove a real conversation works end-to-end. Loopback WebRTC works without STUN.
6. **Phase 10 — Deployment docs.** Document STUN/coturn, TLS, WSS, no-telemetry, minimized logs.

---

## 7. Gate commands (run from repo root)

- `pnpm install`
- `pnpm check` (format + lint + tsc)
- `pnpm build`
- `pnpm --filter web test:unit` — **currently broken due to the Phase 7 integration test**
- `pnpm --filter web test:e2e` — Playwright (chromium + firefox; webkit skipped)
- `pnpm test` (root) — runs both via vp
- `pnpm docker:build` — only if docker daemon is available

---

## 8. Suggested skills for the next agent

- **subagent-orchestration** — only for phases that genuinely warrant it (8 and 9 are large). When you do dispatch: **small slices, one concern per agent, hard cap on gate-cycle count.** A subagent that re-runs a 120s test 5 times = 10 minutes burned before it does anything useful.
- **tdd** — for Phases 8 and 9 non-UI logic.
- **agent-browser** — for the live 2-profile E2E the user expects.
- **diagnosing-bugs** — for the Phase 7 broker boot failure (this is the immediate blocker).

Do NOT use subagent-review or grill-me — not what the user wants right now.

---

## 9. User expectations (take these seriously)

- The user is (justifiably) furious about wasted time. Show working software, not dispatch logs.
- "Don't come back before done" means: the chat must actually work between two browser profiles by the time you report back.
- The user wants the assistant to **run the E2E itself** with agent-browser, not hand the user a test script.
- No bullshit status reports. If something is broken, say so and show the fix.
- Previous agent was fired for: false "done" claims, oversized subagent dispatches, trusting status over disk, and not catching the 120s-test-in-unit-glob trap.

---

## 10. First concrete action

**Fix Phase 7.** Specifically:

1. `pnpm --filter web dev`, read the output, find out why the server doesn't boot on :3001 within 120s.
2. Fix the Nitro WebSocket wiring in `apps/web/vite.config.ts` + `apps/web/src/server/broker.ts` for the installed nitro beta version.
3. Move `tests/integration/broker-ws.test.ts` out of the unit-test include glob (either into a separate `test:integration` script, or rename so it's not matched, or update vitest config to exclude `tests/integration/**`).
4. Get `pnpm --filter web test:unit` green in under 30s.
5. Prove `/ws` upgrades with a manual `ws` client smoke.

Until that's done, nothing downstream can proceed.
