# Plan v2 — Multi-chat, file transfer, real UI, fixed demo script

This plan closes the gaps the user called out after v1 shipped:
- **Multiple concurrent chats** with a sidebar (today: one active conversation, no sidebar).
- **File transfer UI** (today: the protocol/framing/orchestrator already support it end-to-end; only the controller surface + UI are missing).
- **A real app shell** — sidebar + main pane, responsive, designed colors (the centered single-column "trash" goes).
- **A demo script that emits the final artifact** (GIF + WebM) end-to-end, no server booting.

Built to the `subagent-orchestration` skill: phases sized to fit one agent context,
implementer → validator → fixer per phase, NO-SLOP enforced, complete requirements
per dispatch.

---

## GROUNDING FACTS (do not re-derive — read these before any dispatch)

- **File transfer already works at the layer below the UI.** The framing layer
  exposes `FrameSender.sendFile(data, name, mimeType): Promise<number>` (returns
  transferId) and `FrameReceiverConfig.onFileComplete(file: ReceivedFile)`.
  `FileManifest` + chunked `FileChunk` frames, hash-verified reassembly, and
  the backpressure/cancel surface (`cancelTransfer`, `isFileBackpressured`,
  `activeTransferCount`, `bufferedBytes`) are all implemented and unit-tested.
  The orchestrator constructs the sender/receiver. So file transfer = wire the
  controller + UI to surfaces that EXIST; no crypto/framing work.
  Files: `apps/web/src/features/chat/framing/{sender,receiver,types,manifest}.ts`,
  `apps/web/src/features/chat/orchestrator/orchestrator.ts`.

- **Multi-conversation is half-built.** `ChatController`
  (`apps/web/src/features/chat/runtime/chat-controller.ts`) has
  `startConversation`/`resumeConversation`/`listConversations`/`setDisplayName`,
  and the repo persists many conversations. BUT it holds a SINGLE
  `orchestrator`/`bridge` pair and a single `state` snapshot
  (`conversationId: ConversationId | null`). There is no sidebar and no way to
  keep >1 conversation live or switch between live ones.

- **Current UI** (`apps/web/src/features/chat/ui/`, `routes/index.tsx`):
  `index.tsx` switches between `Landing` and a single `ChatView` based on
  `state.conversationId`. No sidebar. Centered max-width column. Tokens are the
  redesigned teal/slate palette in `packages/ui/src/styles/globals.css`.

- **Design system tokens** live in `packages/ui/src/styles/globals.css`
  (`:root` + `.dark` oklch custom properties). The app hardcodes
  `<html className="dark">` in `routes/__root.tsx`. shadcn primitives in
  `packages/ui/src/components/*` consume tokens via `bg-*`/`text-*` classes.

- **Gates (run from repo root, ALL must pass before any phase reports done):**
  1. `cd apps/web && npx tsc --noEmit` → 0 errors  (the REAL type gate; `pnpm check` now includes it)
  2. `pnpm --filter web test:unit` → green (currently 427)
  3. `pnpm --filter web test:integration` → 5 green
  4. `pnpm --filter web test:e2e -- --project=chromium` → green (24)
  5. `pnpm check` → 0 warnings (format + lint + tsc)
  6. `pnpm build` → succeeds

- **The dev server binds IPv6 `localhost` (`::1`) only.** Always probe
  `http://localhost:PORT/`, never `127.0.0.1`. Do NOT boot the dev server from
  any script that runs under this harness's background-task reaper — it kills
  the embedded `&`. The demo script must NOT boot/stop the server (caller's job).

## 🚨 HARD RULES FOR EVERY DISPATCH (paste the relevant ones into each prompt)

1. **NO images / NO base64 / NO Read-of-PNG in any message.** A prior agent
   crashed with `400 messages.content.type is invalid` by inlining an image.
   To "see" rendered output, use `curl`+`grep` on HTML text, or `ffprobe`. To
   verify a screenshot/video frame, the ORCHESTRATOR inspects it via the
   **vision MCP** (`mcp__zai-mcp-server__analyze_image`), NEVER a subagent
   reading the file. Subagents are TEXT-ONLY.
2. **NO-SLOP**: no `any`/`as any`/`: any`; no TODO/FIXME; no unused
   imports/vars; no `void`-hack silencers; `import type` for type-only imports
   (verbatimModuleSyntax); external imports first, blank line, then local.
3. **Don't touch working layers.** Crypto/protocol/framing/signaling/broker/
  orchestrator-core are DONE. This plan touches: `runtime/chat-controller.ts`,
  `runtime/*` (new session manager), `ui/*` (shell, sidebar, chat-view, file
  UI), `routes/index.tsx`, `routes/__root.tsx`, `packages/ui/src/styles/globals.css`
  (tokens only), and tests + the demo script. If a primitive needs a token fix,
  fix the token usage — don't rewrite component logic.
4. **Implementers run all 6 gates before reporting done.** Validators
   ACTUALLY READ the code + run gates; they do not just trust the report.
5. **`design-taste-frontend` + `not-ai-writer` skills** load for any UI/copy
  phase. Path: `/home/didi/.agents/skills/<name>/SKILL.md`.

---

## Phase 1 — Multi-session controller (logic, no UI)
**Type:** Sequential. TDD (RED → GREEN → refactor). Mock signaling/WebRTC, real crypto+framing+repo.

**Requirements:**
- Refactor `ChatController` from a single `(orchestrator, bridge, state)` triple
  to a **session map**: `Map<ConversationId, ChatSession>` where each session
  holds its own `orchestrator`, `bridge`, and per-session snapshot
  (`connectionState`, `messages`, `safetyNumber`, `safetyNumberVerified`,
  `unread`, `draft`, `transfers`). The controller exposes:
  - `startConversation()`, `joinConversation(fragment)`, `resumeConversation(id)`,
    `selectConversation(id)` (switch active without tearing down others),
    `leaveConversation(id)` (tear down ONE session), `leaveAll()`.
  - `sendText(id, text)`, `sendFile(id, file)` (Phase 3 wires sendFile), plus
    per-session `getHistory`, `markSafetyNumberVerified(id)`, `setDisplayName`.
  - `getActiveConversationId()`, `listConversations()`, and a `sessions` view
    in the state for the sidebar (id, displayName/peer-label, connectionState,
    unread count, lastMessagePreview).
- **Background/idle sessions stay alive** (their WebRTC bridge keeps running so
  messages still arrive). Receiving a message on a non-active session
  increments its `unread` and updates `lastMessagePreview` without switching
  the active view. Receiving on the active session appends to its `messages`.
- `selectConversation` is cheap (no re-handshake) — just swaps the active id and
  surfaces that session's snapshot; clears its `unread`.
- `ChatControllerState` gains `activeConversationId`, `sessions: SessionSummary[]`.
- Identity + at-rest key + repo stay singletons shared across sessions.
- SSR-safe: no `window`/`RTCPeerConnection` at module top level (the provider
  still constructs the controller client-side only).

**Inputs (read):** `runtime/chat-controller.ts`, `runtime/webrtc-bridge.ts`,
`runtime/chat-provider.tsx`, `orchestrator/orchestrator.ts`, `store/types.ts`.

**Outputs:**
- Create `runtime/chat-session.ts` (the per-session record + its handler wiring),
  `runtime/types.ts` (`ChatSession`, `SessionSummary`).
- Modify `runtime/chat-controller.ts` (session map), `runtime/chat-provider.tsx`
  (expose `sessions` + `activeConversationId` + new methods).
- Tests: `tests/unit/runtime/chat-controller-multisession.test.ts` — start 2
  convos, both connect via loopback pairs (reuse `_helpers` LoopbackPeerTransport),
  send text in each independently, assert the OTHER session's messages don't
  bleed; `selectConversation` swaps active; `unread` increments on background
  receive; `leaveConversation(id)` tears down only that one.

**Validation:** gates 1–3,6. Unit count goes up; integration/e2e unchanged.
**Dependencies:** none.

---

## Phase 2 — App shell + sidebar (UI structure, responsive, designed)
**Type:** Sequential. Loads `design-taste-frontend` + `not-ai-writer`.

**Requirements:**
- Replace the centered single-column shell with a real **app layout**:
  - **Desktop (≥768px):** persistent left **sidebar** (conversation list with
    active highlight, unread badges, connection-state dot, last-message preview,
    "New conversation" button at top, settings entry at bottom) + main pane
    (active chat view or empty state). Resizable or fixed ~280–320px.
  - **Mobile (<768px):** sidebar collapses to a drawer/sheet toggled by a
    hamburger; the active chat takes the full viewport. Must not overflow
    horizontally (keep the existing mobile-overflow e2e green; extend it).
- **Color & type:** refine the token system in `globals.css` so the shell,
  sidebar, and chat feel designed — not cramped, not the default template.
  Honor the user's stance: no builtin Tailwind palette literals, no red/brown,
  no muddy green. The current teal/slate is the starting point; the orchestrator
  will visually QC via the vision MCP and iterate if it reads as "trash."
  Comfortable spacing scale, clear hierarchy, inviting not clinical.
- Sidebar items: peer display name (or "New chat" / truncated id), connection
  state pill, unread count badge, timestamp of last message. Clicking selects
  (`selectConversation`). A small per-item menu: rename, clear, leave.
- Empty state (no active conversation): a warm, on-brand prompt to start or
  resume — not the old full landing wall. Keep a one-line security stance +
  link to `/docs/security`.
- The docs routes (`/docs/*`) keep working under the new shell (or stay
  standalone — decide; don't break them).

**Inputs (read):** `ui/landing.tsx`, `ui/chat-view.tsx`, `ui/chat-status.ts`,
`routes/index.tsx`, `routes/__root.tsx`, `packages/ui/src/styles/globals.css`,
shadcn primitives in `packages/ui/src/components/*` (especially `sheet`,
`dialog`, `dropdown-menu`, `card`, `button`).

**Outputs:**
- Create `ui/app-shell.tsx` (layout), `ui/sidebar.tsx` (conversation list),
  `ui/empty-state.tsx`.
- Modify `routes/index.tsx` (render the shell; shell decides sidebar vs chat),
  `routes/__root.tsx` (if the shell moves up to root), `packages/ui/src/styles/globals.css`
  (token/spacing refinements).
- Tests: extend `tests/e2e/landing.spec.ts` (mobile drawer toggle, sidebar item
  count after starting 2 convos, active highlight, no horizontal overflow at
  390px AND 1920px). Unit-test any pure helpers (e.g. sidebar sort/group).

**Validation:** gates 1–6. Vision-MCP QC by the orchestrator on a live
screenshot AFTER the phase passes gates — iterate via a fixer dispatch if it
still reads as cramped/templatey.
**Dependencies:** Phase 1 (needs `sessions` + `selectConversation`).

---

## Phase 3 — File transfer UI + controller surface
**Type:** Sequential. TDD the controller surface; UI follows.

**Requirements:**
- **Controller:** expose `sendFile(id, file: File)` and per-session transfer
  state (`transfers: TransferState[]` with id, name, size, mimeType, direction,
  bytesTransferred, status: queued|sending|receiving|complete|cancelled|error).
  Wire `orchestrator`/`framing` `sendFile` and `onFileComplete`/progress into
  the session snapshot. Respect `MAX_CONCURRENT_TRANSFERS` (4) and
  `MAX_BUFFERED_DATA_BYTES` backpressure (queue, don't drop silently).
- **UI (chat view):**
  - Composer gains an **attach affordance** (paperclip button → native file
    picker; accept multiple). Drag-and-drop onto the transcript/composer.
  - Transfers render inline in the transcript as **attachment cards** with
    progress bar (`progress.tsx` primitive), name, size, cancel button while
    in-flight, and a **save/download** action on complete (received files).
  - **Ephemeral warning:** files are NOT persisted (per the threat model) —
    show a clear one-line note that received files live only in this session.
  - MIME-type-appropriate icon/preview where cheap (image thumbnail for
    `image/*`; generic file icon otherwise). No new heavy deps — use the
    existing `attachment.tsx` primitive.
- Cancel a transfer mid-flight (sender or receiver) → `cancelTransfer(id)`.
- Received-file save uses a Blob URL + anchor download (client-only).

**Inputs (read):** `framing/sender.ts`, `framing/receiver.ts`,
`framing/types.ts` (`FileManifest`, `ReceivedFile`), `framing/manifest.ts`
(`MAX_CHUNK_*`, `computeChunkCount`), `protocol/limits.ts`
(`MAX_CONCURRENT_TRANSFERS`, `MAX_INCOMPLETE_TRANSFER_BYTES`,
`MAX_BUFFERED_DATA_BYTES`, `MAX_MANIFEST_NAME_BYTES`, `MAX_MANIFEST_MIME_BYTES`),
`ui/chat-view.tsx`, `ui/chat-status.ts`, primitives `attachment.tsx`,
`progress.tsx`.

**Outputs:**
- Modify `runtime/chat-controller.ts` (+ `chat-session.ts`) for `sendFile` +
  transfer state; `ui/chat-view.tsx` (composer attach, drag-drop, transfer
  cards); create `ui/file-transfer-card.tsx`, `runtime/transfer-state.ts`
  (types + reducers).
- Tests: unit `tests/unit/runtime/file-transfer.test.ts` (send a small file
  over a loopback pair, assert complete + hash match on receiver; cancel
  mid-flight; concurrent-limit enforced). e2e: add a scenario to
  `tests/e2e/p2p.spec.ts` — send a tiny text file A→B, assert B's transcript
  shows the card + can save; send an image, assert thumbnail.

**Validation:** gates 1–6.
**Dependencies:** Phase 1 (session map) — file state is per-session.

---

## Phase 4 — Polish pass + demo script fix
**Type:** Sequential (small). Loads `design-taste-frontend`.

**Requirements:**
- **Demo script (`scripts/demo-video.sh`) emits the FINAL artifacts:** after
  capturing the raw WebM and burning captions, ALSO render the captioned
  animated GIF (`docs/media/chat-demo.gif`, ffmpeg two-pass palette, ≤ ~600 KB,
  960 wide) and keep the WebM. The script must produce BOTH in one run against
  an already-running server (it must NOT boot/stop the server — fail fast if
  `BASE_URL` isn't up). Update the script's beats to showcase the NEW shell +
  multi-chat + file transfer (open a 2nd conversation in the sidebar; send a
  file). Keep captions accurate to the new flow.
- **README:** the GIF embed stays (it renders on GitHub); refresh the demo
  section copy if the flow changed; mention multi-chat + file transfer in the
  feature list (accurately — no overclaiming).
- **Final design QC:** orchestrator vision-MCP check of the live shell at
  desktop + mobile widths; fixer dispatch for any remaining cramped/templatey
  spots.
- Re-record `docs/media/chat-demo.gif` + `.webm` via the fixed script against
  the running redesigned app; commit both + refreshed README.

**Inputs (read):** `scripts/demo-video.sh`, `README.md`, the new shell/sidebar
from Phase 2, file UI from Phase 3.

**Outputs:** modify `scripts/demo-video.sh`, `README.md`; regenerate
`docs/media/chat-demo.{gif,webm}`.

**Validation:** gates 1–6; `bash -n scripts/demo-video.sh`; the script run
produces both artifacts (verified by the orchestrator via `ffprobe` + file
size, NOT by a subagent reading images). Vision-MCP QC of a sampled frame.

**Dependencies:** Phases 1–3.

---

## EXECUTION NOTES (for the orchestrator — that's me)

- Dispatch ONE phase at a time (sequential deps). Within a phase: implementer →
  validator → fixer loop (max 3) per the skill.
- After Phase 2 and Phase 4, **I** (orchestrator) do the vision-MCP visual QC
  on a live screenshot — never delegate image reading to a subagent.
- Keep the dev server as a `run_in_background` Bash task when *I* need it for
  QC; never put server boot/stop inside a subagent's script or a reaped
  background task.
- Commit per phase to `main` after gates pass; push. Commit messages end with
  `Co-Authored-By: Claude <noreply@anthropic.com>`.
- If a phase fails after 3 fix attempts: HALT, report to the user with the
  validator's findings — do not paper over it.

## OUT OF SCOPE (v1.1 — not this plan)
- TURN relay / symmetric-NAT fallback (still STUN-only).
- OPFS / TanStack DB persistence (still InMemoryConversationRepository +
  localStorage at-rest key).
- Group chat (>2 peers) — the broker room cap is 2; this plan is many
  independent 1:1 chats, not multi-party.
- Media calls / voice.
