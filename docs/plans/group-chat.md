# Plan: Group Chats (Mesh of Pairwise v1 Links)

## Overview

Add group conversations of up to 8 members as a full mesh of existing
pairwise v1 sessions. No new transport cryptography: every member↔member
link is a normal protocol-v1 conversation (Hello → Signature → optional
SPAKE2) over its own WebRTC data channel, using a _derived_ pairwise
conversation ID. Group semantics live in a new membership layer: the
author's ECDSA-signed member list gossiped over pairwise control frames,
plus peerId-addressed broker signaling for N-seat rooms.

Settled decisions (user):

- No MLS / sender-key layer. Pure pairwise mesh.
- New members get **no history** — they see messages from join-time forward.
- PAKE: author mints one 6-digit code at group creation; it is carried in
  the fragment (`#<hex>~NNNNNN`, same format as 1:1) and used as the SPAKE2
  password on **every** pairwise handshake in the group. Groups without a
  code are safety-number-only, same as 1:1.
- No offline delivery. A member who is offline simply misses messages; no
  store-and-forward.
- No total message ordering. Per-sender ordering comes free from each
  link's sequence numbers; display sorts by timestamp.

Orchestrator-chosen defaults (flag in review if unwanted):

- Group member cap is **env-configurable**: `GROUP_MAX_MEMBERS` server env
  var (optional, integer ≥2, default 8). `DEFAULT_MAX_GROUP_MEMBERS = 8`
  lives in `protocol/limits.ts`; the broker registry and the client-side
  group session each take the configured value as an option, and
  `/ice-config` serves it to the client (same pattern as
  `publicBaseUrl`). Codec validation always enforces the _configured_ cap
  at that layer; a hard ceiling `MAX_GROUP_MEMBERS_HARD = 16` bounds the
  env var itself so an operator cannot mint an unbounded room.
- The group **author** (creator's identity key) is the sole admin. Anyone
  holding the invitation link may join (identical bearer-link semantics to
  1:1 — the link is the capability). The author can remove members.
- Group members **stay seated in the broker room** for the life of the
  group (they cannot `signalP2pOpen`-and-leave as in 1:1) so new members
  can join and dropped links can re-signal. The broker still holds only
  signaling metadata — never content.
- Pairwise conversation ID derivation:

  ```
  pairwiseConvId = SHA-256("fck-group-v1/pair" || groupId(16) ||
                           min(idPubA, idPubB) || max(idPubA, idPubB))[0..16]
  ```

  Deterministic per pair, so the frozen v1 handshake codec is untouched
  and each pair gets a stable safety number.

- Group content uses **unmodified v1 frames**: a group text message is a
  `text` frame sent on every connected link; a group file is a normal
  manifest+chunk transfer per link. Sender attribution is the link's peer
  identity. Only NEW wire items are broker `peerId` addressing and the
  `group_membership` control subtypes.
- Group safety number:
  `SHA-256("fck-group-v1/safety" || groupId || epoch(u32be) || sorted(memberIdPubs))`,
  rendered with the existing 12-digit display. Changes every epoch.

## Prerequisites

- `pnpm` workspace; all commands from repo root.
- Read first (all phases): `docs/architecture/protocol-v1.md`,
  `docs/architecture/threat-model.md`, `docs/architecture/orchestrator.md`,
  `docs/architecture/ui-runtime.md`, `AGENTS.md`.
- Gatekeeping for every implementer/fixer, run before reporting done:
  `pnpm run check-types` and `pnpm check`; `pnpm --filter web test:unit`
  and/or `pnpm --filter @fuck-eu-chat-control/chat-runtime test:unit` when
  the phase touches code with unit tests.
- NO-SLOP: no `any`/`as any`/`: any`; `import type` for type-only imports;
  external imports then blank line then local; no TODO/FIXME/placeholders;
  no unused imports/vars; no dev servers.

## Execution logistics

- Work happens on branch `feat/group-chat`, created off `main`.
- **Commit after each phase passes validation** (one commit per main
  phase: 1, 2, 3, 4 [4a+4b together], 5, 6, 7, 8). Commit style follows
  `git log` conventions (`feat(...)`, `fix(...)`, `docs(...)`), with the
  Devin trailer. The plan document itself is committed with Phase 1.
- **Open a PR** (`gh pr create`) after Phase 8 validates.
- `GROUP_MAX_MEMBERS` is added to `packages/env/src/server.ts` (Phase 2)
  and surfaced to the client via `/ice-config` (Phase 6).

---

## Phase 1: ADR-003 + group protocol spec

**Type**: Sequential

**Requirements**:

- Create `docs/adr/003-group-chat.md`: context (frozen v1 is pairwise),
  decision (mesh of v1 links + signed membership list + addressed broker
  relay), the settled decisions and defaults listed above, consequences
  (N−1 IP disclosure, persistent broker seats, equivocation limits —
  author can equivocate on member list, detection via cross-member gossip
  showing conflicting signed lists), and what is explicitly out of scope
  (MLS, sender keys, offline delivery, total ordering, history sync).
- Create `docs/architecture/protocol-v2-group.md` as the normative spec:
  - Terminology: `groupId` (16 bytes, CSPRNG by author, = broker room id,
    carried in fragment), `peerId` (8 bytes / 16 hex chars, client-chosen
    per broker join), `epoch` (u32, bumped on every membership change),
    `author` (identity key that signs member lists).
  - Broker protocol v2: `join` gains `{mode: "group", peerId}`;
    relayed `offer`/`answer`/`ice` gain `to`/`from` peerIds; `leave`
    notifications gain `peerId`. Legacy pair-mode rooms unchanged.
  - Group rooms: cap = `GROUP_MAX_MEMBERS` env (default 8, hard ceiling
    16); on each join the broker notifies every seated member
    `{t:"join", roomId, peerId}`; on socket close/leave it broadcasts
    `{t:"leave", roomId, peerId}`.
  - New control subtypes (protocol error on v1 links — group links only): - `0x07 group_membership` — payload: `groupId(16) || epoch(4BE) ||
memberCount(1) || memberEntry[] || signature(64)` where
    `memberEntry = identityPub(65) || flags(1) || displayNameLen(1) ||
displayName(utf8)`; `flags bit0` = author. Signature covers all
    preceding bytes with the author's identity key. - `0x08 group_membership_request` — empty payload; joiner requests the
    list from an established link.
  - Pairwise derivation formula + group safety number formula (above).
  - Rules: epoch strictly increases; a link's handshake identity key must
    appear in the current member list or the link is flagged; removed
    members' links are closed on receipt of a newer list.
  - New limits: `DEFAULT_MAX_GROUP_MEMBERS = 8`,
    `MAX_GROUP_MEMBERS_HARD = 16`, `MAX_MEMBER_DISPLAY_NAME = 32`; env var
    `GROUP_MAX_MEMBERS` (server, optional, integer 2..16).
- Update `docs/architecture/threat-model.md`: persistent group seats in
  the broker (metadata exposure: room id + online presence of ≤8 sockets,
  still no content), N−1 peer IP disclosure, author-admin trust model,
  bearer-link join semantics, no-offline/no-ordering statements.

**Inputs**: the four docs above.

**Outputs**: Create `docs/adr/003-group-chat.md`,
`docs/architecture/protocol-v2-group.md`; modify
`docs/architecture/threat-model.md`.

**Validation**: Docs consistent with protocol-v1.md terminology; formulas
match this plan exactly; no code touched.

**Dependencies**: None.

---

## Phase 2: Broker — N-peer group rooms + addressed relay

**Type**: Sequential

**Requirements**:

- `packages/chat-runtime/src/broker/room-registry.ts`: seats become
  `Map<peerId, BrokerSocket>`; add room mode (`pair` | `group`); room cap
  2 for pair, `maxGroupPeers` (constructor option, default
  `DEFAULT_MAX_GROUP_MEMBERS`) for group; `getPeer(roomId, socket)`
  generalized to `getPeerById`/`listPeers`; `join()` accepts optional
  `peerId`, rejects duplicates/malformed peerIds (16 lowercase hex);
  first-join determines room mode.
- `packages/env/src/server.ts`: `GROUP_MAX_MEMBERS` — optional
  `z.coerce.number().int().min(2).max(MAX_GROUP_MEMBERS_HARD)`... but
  limits.ts lives in chat-runtime and env is a leaf package — keep the
  hard ceiling literal `16` in env with a comment cross-referencing the
  spec, or duplicate the constant locally; do NOT add a chat-runtime dep
  to packages/env. Wire it into `RoomRegistry` construction in
  `apps/web/src/server/broker.ts`.
- `packages/chat-runtime/src/broker/protocol.ts`: `JoinMessage` gains
  optional `mode` + `peerId`; `OfferMessage`/`AnswerMessage`/`IceMessage`
  gain optional `to`; `LeaveMessage`/`join` notifications gain `peerId`
  on the outbound (broker→client) direction; parser validates; formatter
  emits `from` on relayed messages.
- `packages/chat-runtime/src/broker/connection.ts`: on group join, send
  join notification `{t:"join", roomId, peerId}` to every seated member;
  relay `to`-addressed messages to that peer only (attach sender's
  `peerId` as `from`); pair mode keeps exact current behavior (addressed
  fields absent, `getPeer` fallback); on close, broadcast `leave` +
  `peerId` to remaining group members.
- `packages/chat-runtime/src/broker/errors.ts`: add close codes/reasons
  for `DuplicatePeerId`, `RoomModeMismatch` (group join into pair room or
  vice versa), `PeerNotFound` handling (drop silently, no close — race
  with leave).
- Keep ALL existing pair-room behavior and comments byte-compatible;
  existing broker tests must still pass unmodified.

**Outputs**: Modify the four broker files; extend
`packages/chat-runtime/tests/unit/broker/` with group-room tests (N-peer
join, addressed relay only reaches target, leave broadcast, caps, mode
mismatch, duplicate peerId).

**Validation**: `pnpm --filter @fuck-eu-chat-control/chat-runtime
test:unit` green; `check-types` zero errors; existing broker tests
unmodified and passing.

**Dependencies**: Phase 1.

---

## Phase 3: Signaling client — addressed, multi-peer

**Type**: Sequential

**Requirements**:

- Keep `SignalingClient` (1:1) untouched. Add
  `packages/chat-runtime/src/signaling/group-signaling-client.ts`: same
  socket lifecycle, but `connect({peerId})` sends
  `{t:"join", roomId, mode:"group", peerId}`; `sendOffer(to, sdp)` /
  `sendAnswer(to, sdp)` / `sendIce(to, candidate)` emit addressed
  messages; inbound handlers are per-peer:
  `onPeerJoin(peerId)`, `onPeerLeave(peerId)`, `onOffer(from, sdp)`,
  `onAnswer(from, sdp)`, `onIce(from, candidate)`; tracks
  `Map<peerId, presence>`; `signalAllLinksOpen()` stays seated (groups do
  NOT leave the room); `close()` sends `leave` then tears down.
- No `peerPresent` boolean — per-peer presence map. Glare: not applicable
  here (only seated members offer, to the newcomer — deterministic);
  document that.
- Unit tests: addressed send format, per-peer join/leave dispatch,
  unknown `from` ignored, unaddressed legacy messages ignored in group
  mode.

**Outputs**: Create `group-signaling-client.ts`; extend
`tests/unit/signaling/` with group client tests.

**Validation**: Unit tests green; check-types clean; `SignalingClient`
file unmodified.

**Dependencies**: Phase 2 (message shapes).

---

## Phase 4a: Group core — types, pairwise IDs, membership codec

**Type**: Sequential (sub-phase of Phase 4)

**Requirements**:

- `packages/chat-runtime/src/group/types.ts`: `GroupId` brand (16 bytes),
  `PeerId` brand, `GroupMember { identityPub, flags, displayName }`,
  `GroupMembership { groupId, epoch, members, signature }`, group event
  types.
- `packages/chat-runtime/src/group/pairwise-id.ts`: `derivePairwiseConvId`
  per the formula; unit-tested deterministic + symmetric.
- `packages/chat-runtime/src/group/membership.ts`: canonical binary
  encode/decode of `group_membership` payload (fixed offsets, validate-
  before-allocate, caps from limits); `signMembership` /
  `verifyMembership` using identity signing; epoch/diff helpers
  (`addedMembers`, `removedMembers`).
- `packages/chat-runtime/src/protocol/limits.ts`:
  `DEFAULT_MAX_GROUP_MEMBERS = 8`, `MAX_GROUP_MEMBERS_HARD = 16`,
  `MAX_MEMBER_DISPLAY_NAME = 32` (frozen-style readonly constants). The
  membership codec enforces `memberCount ≤` a caller-supplied cap
  (defaulting to `DEFAULT_MAX_GROUP_MEMBERS`).
- `packages/chat-runtime/src/protocol/types.ts`: add `ControlSubtype`
  values `GroupMembership: 0x07`, `GroupMembershipRequest: 0x08`; the
  codec must accept these ONLY when the caller opts into group mode —
  expose a `groupControlSubtypes` allowance so v1 links still terminal-
  error on them (check how `CONTROL_SUBTYPE_VALUES` is enforced in
  `protocol/codec.ts` and gate the new values behind a flag passed by the
  group session; do NOT silently weaken the v1 decoder).
- `packages/chat-runtime/src/crypto/safety-number.ts`: add
  `computeGroupSafetyNumber(groupId, epoch, memberPubs)`.
- Group invitation: extend `orchestrator/invitation.ts` —
  `formatGroupInvitation`/`parseInvitation` reuse the existing
  `#<hex>[~code]` grammar unchanged (group vs pair is decided by join
  `mode`, which the caller knows from UI action — document that the link
  itself is indistinguishable; joining UI must call the right entry
  point).

**Outputs**: ~6 new/modified files under `src/group/`, `src/protocol/`,
`src/crypto/`, `src/orchestrator/invitation.ts`; unit tests for codec
round-trip, tamper rejection, epoch diffs, pairwise derivation, safety
number.

**Validation**: Unit tests green; check-types clean; v1 control-subtype
rejection still tested.

**Dependencies**: Phase 1.

---

## Phase 4b: Group session — orchestrates N pairwise links

**Type**: Sequential (sub-phase of Phase 4)

**Requirements**:

- `packages/chat-runtime/src/group/group-session.ts`: `GroupSession`
  class. Owns one `ConversationOrchestrator` per member link (reuse —
  do NOT reimplement handshake). For each link it supplies:
  derived `pairwiseConvId`, the group's `authMode`/code, the expected
  peer identity key (from membership list; on a fresh link before the
  list arrives, accept handshake then verify against list when it lands —
  flag/close on mismatch).
- Public API: `attachLinkTransport(peerId, PeerTransport)` (called by the
  WebRTC manager when each data channel opens), `sendText(text)` →
  fan-out `sendText` on every connected link, `sendFile(file)` → one
  transfer per link, `requestMembership(peerId)`, `leave()` → `leave`
  control on all links + teardown, `kickMember(identityPub)` (author
  only) → bump epoch, re-sign, gossip.
- Membership handling: on receiving `group_membership`, verify author
  signature + `epoch > current`; adopt; close links to removed members;
  emit events. Author maintains the list: on each link handshake
  completing for an unknown peer, add member + bump epoch + sign +
  gossip to all links.
- Events for the controller: `onMessage(memberId, text, ts)`,
  `onMemberJoined`, `onMemberLeft`, `onMembershipChanged`,
  `onFileReceived`, per-link state.
- `packages/chat-runtime/src/group/errors.ts`: group error codes
  (`NotAuthor`, `EpochRegression`, `MemberLimitReached`,
  `UnknownLinkIdentity`).
- Members not yet fully linked still count toward `MAX_GROUP_MEMBERS`
  (bounded pending map, timeout).
- Unit tests with loopback `PeerTransport`s: 3-member session, join →
  list gossip → all links connected; sendText fan-out; removal closes
  link + new epoch; non-author cannot mint membership.

**Outputs**: `src/group/group-session.ts`, `src/group/errors.ts`, tests
under `tests/unit/group/` and `tests/integration/group-session.test.ts`.

**Validation**: Unit + integration tests green; check-types; lint.

**Dependencies**: Phases 3 (for wiring shape) and 4a. May reuse
orchestrator seams — if `ConversationOrchestrator` needs an extension
point (expected-identity check, group control frames, link-scoped
callbacks), add it minimally; do not change v1 behavior.

---

## Phase 5: Multi-peer WebRTC bridge

**Type**: Sequential

**Requirements**:

- `packages/chat-runtime/src/runtime/group-webrtc-manager.ts`:
  `GroupWebrtcManager` owning `GroupSignalingClient` (Phase 3) +
  `Map<peerId, WebRtcAdapter-like wrapper>`; on `onPeerJoin(peerId)` →
  create RTCPeerConnection, offer; on `onOffer(from)` → create PC,
  answer; `onAnswer`/`onIce` routed by `from`; each `RTCDataChannel` open
  → `groupSession.attachLinkTransport(peerId, toPeerTransport(channel))`.
- Per-pair perfect negotiation for resumption/drops: pair roles derived
  from the two identity keys (`deriveRole`) which are known from the
  membership list — impolite/polite per pair.
- Reuse `apps/web/src/features/chat/signaling/webrtc-adapter.ts`
  patterns; generalize so one adapter instance = one peer connection.
  Do not regress the existing 1:1 bridge (`webrtc-bridge.ts` stays).
- ICE config injection same as 1:1 (`/ice-config`).

**Outputs**: `group-webrtc-manager.ts` (+ small shared helpers if the
adapter needs a per-connection interface extraction); unit tests where
RTCPeerConnection-free seams allow.

**Validation**: check-types; lint; unit tests for routing/dispatch logic.

**Dependencies**: Phases 3, 4b.

---

## Phase 6: Store + ChatController group API

**Type**: Sequential

**Requirements**:

- `packages/chat-runtime/src/store/`: extend repo interfaces + in-memory
  repo with `storeGroup`, `getGroup`, `updateGroupMembership`,
  `listGroups`; group record `{groupId, epoch, authorKey, members[],
displayName?}`; per-member peer identity reuse of existing
  `storePeerIdentity` keyed by derived pairwise convId. Export-bundle
  schema stays v1 (group membership state is re-derivable; document —
  group rooms cease when empty anyway).
- `packages/chat-runtime/src/runtime/chat-controller.ts`: add
  `startGroup(opts?: {code?, name?}) → {invitation}`,
  `joinGroup(fragment)`, `leaveGroup(id)`, `removeGroupMember(id,
identityPub)`, `sendGroupText(id, text)`, `sendGroupFile(id, file)`,
  group list/active state in emitted state, per-member display names,
  `markGroupSafetyVerified(id)`. Mirror existing conversation API shape.
- `packages/chat-runtime/src/runtime/group-session-host.ts` (or extend
  `chat-session.ts`): lifecycle glue controller↔GroupSession↔manager,
  identity via existing `IdentityManager`.
- Pending-member and member-count enforcement surfaces as typed errors to
  UI.
- Client learns the configured cap: extend `/ice-config` response
  (`apps/web/src/server/ice-config.ts`) with `groupMaxMembers:
env.GROUP_MAX_MEMBERS ?? DEFAULT_MAX_GROUP_MEMBERS`; controller/group
  session accept it as an option (same delivery pattern as
  `publicBaseUrl`).

**Outputs**: repo interface + in-memory impl, controller additions,
session host; unit tests for controller group flows (mocked managers).

**Validation**: `pnpm test:unit` green for touched packages;
check-types.

**Dependencies**: Phases 4b, 5.

---

## Phase 7: Web UI

**Type**: Sequential (may split 7a/7b if >15 files)

**Requirements**:

- `apps/web/src/features/chat/runtime/chat-provider.tsx`: construct group
  plumbing client-side only; expose via `useChat()`.
- Create-group flow on `/`: "New group" action → `startGroup` → show
  invitation link (+ optional PAKE code box, same UX as 1:1).
- Join flow: `use-invitation-join` extended — user chooses join-as-group
  for group links (link bytes are identical; UI affordance decides the
  mode — spec'd in Phase 1).
- Group view: member list panel (identity fingerprint short-form +
  display name + author badge + link state), attributed bubbles (sender
  display name / key prefix), group safety-number dialog (12-digit,
  epoch-bound, "unverified" until marked), author-only "remove member",
  "leave group".
- Session list: group entries with member count; drafts per group.
- Follow existing components/patterns in `features/chat/ui/` (session
  list, safety dialog, bubbles); no new visual language.
- Status line shows per-link connectivity summary (`3/4 members
connected`).

**Outputs**: ~6–8 files in `features/chat/ui/` + `runtime/`, small edits
to `routes/index.tsx`, `use-invitation-join.ts`, `session-list.tsx`,
`testids.ts`.

**Validation**: check-types; `pnpm check`; existing web unit tests green.

**Dependencies**: Phase 6.

---

## Phase 8: E2E + docs finalization

**Type**: Sequential

**Requirements**:

- `apps/web/tests/e2e/group.spec.ts`: Playwright, three browser contexts
  — author creates PAKE group → two members join via link → all pairwise
  links connect → message from each reaches the other two with correct
  attribution → member removal → epoch bump → removed member excluded.
  Follow `_helpers.ts` and `p2p.spec.ts`/`p2p-pake.spec.ts` patterns.
- Integration test: `packages/chat-runtime/tests/integration/` — full
  3-member group session over loopback transports + real crypto/framing.
- Update `docs/architecture/orchestrator.md` + `ui-runtime.md` with the
  group layer; ensure `/docs/*` rendered pages that cite the threat model
  stay accurate.
- Update `AGENTS.md` monorepo table if new package/module layout warrants.

**Outputs**: new e2e spec, integration test, doc updates.

**Validation**: `pnpm test:unit`, `pnpm test:e2e` (group spec),
`pnpm run build` — all green.

**Dependencies**: Phases 6, 7.

---

## Success Criteria

- `pnpm run check-types` zero errors; `pnpm check` clean; `pnpm run
build` succeeds.
- Unit + integration + Playwright group E2E green; all pre-existing tests
  unmodified and passing (1:1 path untouched).
- Three-member group: join via link, PAKE-authenticated links,
  attributed fan-out messaging, signed epoch'd membership, member
  removal enforced by link closure.
- Protocol v1 files' frozen behavior unchanged; group additions live in
  protocol-v2-group doc + ADR-003.
