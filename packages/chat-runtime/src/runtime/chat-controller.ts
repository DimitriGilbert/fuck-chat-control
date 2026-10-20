import { AuthMode, Role } from "../protocol/types";
import type { ConversationId, PublicKey } from "../protocol/types";
import {
  CONVERSATION_ID_BYTES,
  MAX_CONCURRENT_TRANSFERS,
  MAX_MANIFEST_MIME_BYTES,
  MAX_MANIFEST_NAME_BYTES,
} from "../protocol/limits";
import { randomBytes } from "../crypto/primitives";
import { ctEqual } from "../crypto/ct-equal";
import { GroupError, GroupErrorCode } from "../group/errors";
import { pubKeyId } from "../group/membership";
import { derivePairwiseConvId } from "../group/pairwise-id";
import { encodeGroupId } from "../group/types";
import type { GroupId, GroupMember, PeerId } from "../group/types";
import { ConnectionState, deriveResumeGlareRole } from "../signaling/state-machine";
import type { SignalingSocketFactory } from "../signaling/signaling-client";
import { exportBundle, importBundle, ImportMode, MessageDirection } from "../store";
import { AuthFailedRetryBlocked } from "../store";
import { clearAllAuthFailedDurable, clearAuthFailedDurable } from "../store/auth-failed-store";
import { LockableRepository } from "../store/lockable-repo";
import type {
  ConversationMessage,
  ConversationRecord,
  ConversationRepository,
  ImportResult,
} from "../store";
import type { ReceivedFile } from "../framing";
import type { PeerTransport } from "../transport/peer-transport";
import type { ConversationOrchestrator } from "../orchestrator/orchestrator";
import { formatGroupInvitation, parseInvitation } from "../orchestrator/invitation";
import { OrchestratorError, OrchestratorErrorCode } from "../orchestrator/errors";
import type { IceServer, PeerConnectionFactory } from "../transport/types";

import type { AtRestKeyManager } from "./at-rest-key-manager";
import type { AtRestKey } from "../crypto";
import {
  createGroupHost,
  groupConversationId,
  receivedFileKey,
  teardownGroup,
} from "./group-session-host";
import type { GroupHostInit } from "./group-session-host";
import {
  buildOrchestrator,
  previewOf,
  seedSessionFromHistory,
  teardownSession,
  wireBridge,
  type SessionChangeCallback,
  type SessionHolder,
} from "./chat-session";
import type { IdentityManager } from "./identity-manager";
import type {
  ActiveGroupState,
  ActiveSessionState,
  ChatFileInput,
  ChatGroupSession,
  ChatSession,
  GroupChatMessage,
  GroupSummary,
  SessionSummary,
} from "./types";
import { activeGroupView, activeSessionView, summarizeGroup, summarizeSession } from "./types";

export { ImportMode };

/**
 * Immutable state snapshot React consumers read. Mutated only by replacing
 * the reference the controller holds (a new object per change).
 *
 * STATE SHAPE DECISION (requirement #5 of Phase 1, PLAN-v2):
 * The flat `connectionState`/`messages`/`safetyNumber`/`invitation` fields
 * are kept at the top level for backward compatibility with the existing UI
 * (`routes/index.tsx`, `ui/chat-view.tsx`, etc.) — they always mirror the
 * ACTIVE session's snapshot (or the empty defaults when there is none). The
 * new multi-session surface lives alongside them:
 *
 *   - `activeConversationId` — which session is currently selected.
 *   - `sessions` — sidebar summaries for every live session.
 *   - `active` — the active session's full snapshot (`ActiveSessionState |
 *     null`), for components that want the whole detail without a second
 *     lookup.
 *
 * Phase 2 migrates the UI to read `sessions` + `active`; until then, the
 * flat fields keep the existing screens compiling and rendering.
 */
export interface ChatControllerState {
  /**
   * Active session id, or null when no conversation is selected. Mutually
   * exclusive with {@link activeGroupId}: the shell renders exactly one
   * active main pane, so selecting a conversation clears the active group
   * (and selecting a group clears this).
   */
  readonly activeConversationId: ConversationId | null;
  /** Sidebar summaries; one entry per live session. */
  readonly sessions: readonly SessionSummary[];
  /** Full snapshot of the active session, or null when empty. */
  readonly active: ActiveSessionState | null;
  /** Persisted conversation records (resume list). */
  readonly conversations: readonly ConversationRecord[];
  /**
   * Sidebar summaries for every live GROUP session (protocol-v2) — the
   * group counterpart of {@link sessions}.
   */
  readonly groups: readonly GroupSummary[];
  /**
   * Active group id, or null when no group is selected. Mutually exclusive
   * with {@link activeConversationId} — see its doc.
   */
  readonly activeGroupId: GroupId | null;
  /** Full snapshot of the active group, or null when none is selected. */
  readonly activeGroup: ActiveGroupState | null;
  /** Controller-level readiness (identity + at-rest key loaded). */
  readonly ready: boolean;
  /** Last controller-level error (orchestrator errors flow through here). */
  readonly error: string | null;

  // --- Backward-compatible active-session mirrors (Phase 2 will drop these) ---
  /** @deprecated read `active.connectionState` instead. */
  readonly connectionState: ConnectionState;
  /** @deprecated read `active.id` instead. */
  readonly conversationId: ConversationId | null;
  /** @deprecated read `active.invitation` instead. */
  readonly invitation: string | null;
  /** @deprecated read `active.safetyNumber` instead. */
  readonly safetyNumber: string | null;
  /** @deprecated read `active.safetyNumberVerified` instead. */
  readonly safetyNumberVerified: boolean;
  /** @deprecated read `active.messages` instead. */
  readonly messages: readonly ConversationMessage[];
}

export interface ChatControllerDeps {
  /** Broker WebSocket URL — the controller passes it to each orchestrator. */
  readonly brokerUrl: string;
  /** Base URL used to format invitation links. */
  readonly baseUrl: string;
  /**
   * Public base URL used as the PREFIX of every generated invitation link.
   * MEDIUM-E: distinct from {@link baseUrl} because the asset-resolution base
   * (used for `/ice-config`, `/wasm/...`) is often NOT a publicly reachable
   * origin — e.g. the desktop shell's `tauri://localhost` asset handler is
   * unusable as an invitation prefix. When unset, the controller falls back to
   * {@link baseUrl} so non-desktop callers (which format invitations from the
   * same origin that serves assets) see no behavior change.
   */
  readonly publicBaseUrl?: string;
  /** Owns the device identity. */
  readonly identityManager: IdentityManager;
  /** Owns the at-rest key used to seal history. */
  readonly atRestKeyManager: AtRestKeyManager;
  /** Factory for the conversation repository, invoked once with the at-rest key. */
  /**
   * Factory for the conversation repository, invoked once with the at-rest key.
   * Ignored when {@link repository} is supplied. Kept for the Node-runnable
   * tests that pass a ready {@link InMemoryConversationRepository}.
   */
  readonly repositoryFactory: (atRestKey: AtRestKey) => ConversationRepository;
  /**
   * A pre-built repository. When set, it is used directly and
   * {@link repositoryFactory} is skipped. The browser provider builds its
   * OPFS-backed repo asynchronously BEFORE constructing the controller and
   * passes it here so the controller itself stays synchronous.
   */
  readonly repository?: ConversationRepository;
  /** Factory for the underlying signaling WebSocket (testability). */
  readonly socketFactory: SignalingSocketFactory;
  /**
   * Platform peer-connection factory. The web app injects an adapter that
   * constructs `RTCPeerConnection`; native apps inject their own. Threaded
   * unchanged down to {@link wireBridge} → {@link WebRtcBridge}.
   */
  readonly peerConnectionFactory: PeerConnectionFactory;
  /** ICE servers for WebRTC. Empty array = loopback-only. */
  readonly iceServers?: readonly IceServer[];
  /**
   * R8/F1 (Phase 6): PAKE feature gate. Threaded unchanged to
   * {@link OrchestratorDeps.enablePake} via {@link BuildSessionInput}. When
   * `false`, the orchestrator rejects `~code` invitations at the join parse
   * boundary with {@link OrchestratorErrorCode.PakeDisabled} — so v1 mobile
   * (whose SPAKE2 wasm is Metro-blocked) does not crash at `loadWasm` on a
   * `~code` deep link. Defaults to `true` (undefined → true in the orchestrator)
   * so web/desktop behavior is unchanged; only the mobile provider passes
   * `false`.
   */
  readonly enablePake?: boolean;
  /**
   * Configured group member cap (protocol-v2 §7). The web provider passes the
   * `groupMaxMembers` value served by `/ice-config` (Phase 7 wires the fetch);
   * other shells and tests leave it unset. Defaults to
   * `DEFAULT_MAX_GROUP_MEMBERS` inside the group session/manager — the
   * controller only plumbs the value through.
   */
  readonly maxGroupMembers?: number;
}

export interface ChatController {
  // --- Multi-session surface ---
  /**
   * Start a fresh conversation as the initiator.
   *
   * R7/F6 / Phase 10: pass an optional `code` to authenticate the handshake
   * via PAKE. The returned invitation link will carry `~<code>` in the URL
   * fragment (never sent to the server); a responder opening that link runs
   * SPAKE2 against the same code and aborts loudly on mismatch.
   */
  startConversation(options?: { readonly code?: string }): Promise<{ invitation: string }>;
  /**
   * Generate a fresh 6-digit PAKE code using the same CSPRNG the crypto layer
   * uses (randomBytes -> crypto.getRandomValues). 6 digits -> [000000, 999999]:
   * sample 4 bytes (32 bits) and reduce mod 1e6. The bias is under 1e-3 of a
   * digit, well below the 20-bit entropy ceiling the PRD calls out for the
   * 6-digit code.
   *
   * R7/F6 / Phase 8: lives on the controller (not the UI) so the sampling +
   * modular reduction stays inside the security-relevant runtime boundary and
   * the UI is a pure render layer over the controller's surface.
   */
  generatePakeCode(): string;
  joinConversation(fragment: string): Promise<void>;
  resumeConversation(conversationId: ConversationId): Promise<void>;
  selectConversation(conversationId: ConversationId): void;
  leaveConversation(conversationId?: ConversationId): void;
  leaveAll(): void;
  /**
   * Store the composer's draft text for a session (R10F2 / Phase 9). The
   * draft is per-session UI state: it survives conversation switches via the
   * {@link ActiveSessionState.draft} snapshot mirror, so text typed in one
   * conversation can never leak into another's composer. Emits a fresh
   * snapshot when the value changes so a controlled composer renders the
   * stored value directly. No-op for an unknown session.
   */
  setDraft(id: ConversationId, draft: string): void;

  /**
   * Per-session text send. The single-argument overload targets the ACTIVE
   * session (kept for the existing UI; throws when there is none). The
   * two-argument form targets a specific session by id.
   */
  sendText(id: ConversationId, text: string): Promise<void>;
  sendText(text: string): Promise<void>;
  /**
   * Per-session file send. Drives the orchestrator's sendFile with a neutral
   * {@link ChatFileInput} payload (the web UI converts its DOM `File` at the
   * call site). Respects the concurrent-transfer cap and the buffered-byte
   * limit: if sending now would exceed either, the file is queued (status
   * `queued`) and starts when a slot frees.
   *
   * Returns the transfer id (allocated immediately for in-flight starts, or
   * assigned later for queued ones — callers should not assume the id is
   * non-null for queue ordering; the snapshot is the source of truth).
   */
  sendFile(id: ConversationId, file: ChatFileInput): Promise<number>;
  /** Cancel an in-flight or queued transfer on a session. */
  cancelTransfer(id: ConversationId, transferId: number): void;
  /**
   * Fetch a received file's bytes by transfer id. Returns null if the file is
   * not present (e.g. already cleared, or not a received-direction transfer).
   * The bytes live in memory for the session's lifetime; they are never
   * persisted (per the threat model).
   */
  getReceivedFile(id: ConversationId, transferId: number): ReceivedFile | null;
  /**
   * Per-session history. No-arg returns the active session's history (empty
   * when there is none); the id form returns that session's history.
   */
  getHistory(id: ConversationId): Promise<ConversationMessage[]>;
  getHistory(): Promise<ConversationMessage[]>;
  /** Per-session safety-number verification. No-arg targets the active session. */
  markSafetyNumberVerified(id: ConversationId): void;
  markSafetyNumberVerified(): void;
  /** Per-session display name. Single-arg form targets the active session. */
  setDisplayName(id: ConversationId, name: string): Promise<void>;
  setDisplayName(name: string): Promise<void>;
  /**
   * Retry the active session's handshake/signaling. For bridge-mode sessions
   * this re-establishes the whole transport: the orchestrator re-enters
   * Signaling AND the bridge re-dials its signaling socket with a fresh peer
   * connection (R3F6), so the retry is not a dead spinner after the broker
   * socket's post-handshake teardown.
   */
  retry(id?: ConversationId): void;
  /** Clear persisted messages. No-arg targets the active session. */
  clearConversation(id?: ConversationId): Promise<void>;
  /** Alias for {@link ChatController.leaveConversation} with no id (active). */
  leave(id?: ConversationId): void;

  // --- Group sessions (protocol-v2) ---
  /**
   * Create a group as its author (the sole member-list signer/admin). Mints
   * a CSPRNG 16-byte group id — also the broker room id — seats this device
   * in the room, and returns the bearer invitation (`#<hex>`, or
   * `#<hex>~NNNNNN` when `code` is supplied for all-PAKE links).
   * `name` sets the local sidebar label; `displayName` is this member's own
   * announced member-entry name (§4.1).
   */
  startGroup(options?: {
    readonly code?: string;
    readonly name?: string;
    readonly displayName?: string;
  }): Promise<{ invitation: string }>;
  /**
   * Join a group via an invitation fragment (`#<hex>` / `#<hex>~NNNNNN`,
   * same grammar as 1:1 — link bytes are identical; the JOIN FLOW decides
   * pair vs group). Seats the member in the broker room; membership is
   * adopted from the author's signed list once a link verifies.
   */
  joinGroup(fragment: string, options?: { readonly displayName?: string }): Promise<void>;
  /** Select a live group (clears its unread count; no re-handshake). */
  selectGroup(groupId: GroupId): void;
  /**
   * Leave a group (no-arg targets the active group): `leave` on every link,
   * vacate the broker seat, and evict the record from the live list. The
   * stored group record is kept — it documents last-known membership so the
   * derived pairwise conversations stay filtered from the sidebar.
   */
  leaveGroup(groupId?: GroupId): void;
  /**
   * Author-only member removal (§4): drops the member, bumps the epoch,
   * re-signs, and gossips the new list (including to the removed member, so
   * it learns of its own removal and self-ejects). Throws
   * {@link GroupError}(NotAuthor) on a non-author session — the typed error
   * is the caller-facing contract for cap/role violations.
   */
  removeGroupMember(groupId: GroupId, identityPub: PublicKey): Promise<void>;
  /** Fan a text frame out over every verified connected link (§6). */
  sendGroupText(groupId: GroupId, text: string): Promise<void>;
  /**
   * One independent v1 file transfer per verified connected link (§6 — no
   * group-wide transfer id space). Returns each link's transfer id keyed by
   * the member's signaling peerId.
   */
  sendGroupFile(groupId: GroupId, file: ChatFileInput): Promise<Map<PeerId, number>>;
  /**
   * The group's in-memory transcript — same plain {@link ConversationMessage}
   * timeline shape as 1:1 history (no sender column; the attributed view is
   * `activeGroup.messages`). Session-scoped: empty for an unknown or ended
   * group — group state is runtime-only and nothing is persisted.
   */
  getGroupHistory(groupId: GroupId): Promise<ConversationMessage[]>;
  /**
   * Fetch a received file's bytes. Per-link transfer-id spaces collide
   * across members, so the sender's identity key scopes the lookup. In
   * memory only; null when absent.
   */
  getGroupReceivedFile(
    groupId: GroupId,
    senderIdentityPub: PublicKey,
    transferId: number,
  ): ReceivedFile | null;
  /** Sidebar summaries for every live group (same data as `state.groups`). */
  listGroups(): GroupSummary[];
  /**
   * Mark the current epoch-bound group safety number as verified
   * out-of-band. In-memory only (groups are runtime-only); a membership
   * change resets it because the number is epoch-bound (§5).
   */
  markGroupSafetyVerified(groupId?: GroupId): void;
  /** The epoch-bound group safety number, or null before one is computed. */
  getGroupSafetyNumber(groupId: GroupId): string | null;
  /**
   * Update OUR OWN member display name and propagate it: re-announced on
   * every connected link and (on the author) folded into our member entry
   * with a re-signed list (§4.1). No-arg groupId targets the active group.
   */
  setGroupDisplayName(groupId: GroupId | undefined, name: string): void;
  /** Store the composer's draft text for a group (same contract as setDraft). */
  setGroupDraft(groupId: GroupId, draft: string): void;
  /**
   * Test seam: hand an open loopback transport to a group session's link
   * orchestrator for `peerId` — the group analogue of
   * {@link __attachTransportForTest}. NOT part of the public contract.
   */
  __attachGroupLinkForTest(groupId: GroupId, peerId: PeerId, transport: PeerTransport): void;

  /**
   * Lock the at-rest key. After this returns, every ciphertext-touching
   * repository call (appendMessage, getHistory, clearConversation, ...) throws
   * {@link AtRestLockedError} until {@link unlock} succeeds. In-memory session
   * snapshots remain readable so the UI can render the sidebar, but no fresh
   * seal/unseal may run.
   */
  lock(): void;
  /**
   * Repopulate the at-rest key from storage. Returns false on a wrong
   * passphrase (passphrase mode) — in that case the controller stays locked.
   * Auto-mode unlock always succeeds because the key is persisted in clear.
   */
  unlock(passphrase: string): Promise<boolean>;
  /** True iff the at-rest key is currently locked. */
  isLocked(): boolean;

  getActiveConversationId(): ConversationId | null;
  listConversations(): Promise<ConversationRecord[]>;

  // --- Repository-level operations (singleton repo; not session-scoped) ---
  clearAll(): Promise<void>;
  exportBundle(passphrase: string): Promise<string>;
  importBundle(passphrase: string, bundle: string, mode: ImportMode): Promise<ImportResult>;

  // --- React subscription / lifecycle ---
  subscribe(listener: (state: ChatControllerState) => void): () => void;
  getState(): ChatControllerState;
  dispose(): void;

  /**
   * Test seam: deliver a synthetic inbound message to a session without going
   * through real WebRTC. Routes through the orchestrator handler so the
   * session's snapshot (messages/preview/unread) updates exactly as a real
   * receive would. NOT part of the public contract.
   */
  __receiveMessageForTest(id: ConversationId, text: string): Promise<void>;
  /**
   * Test seam: mirror a synthetic SENT message into a session's snapshot
   * without driving the orchestrator's crypto path (which would require the
   * session to be Connected). Mutates `lastMessageAt` AND `messages` the same
   * way the real sendText path does, but — critically — does NOT advance
   * `lastReceivedAt`, because sent messages must not push the read marker
   * forward (R9/F5 / Phase 8.5). NOT part of the public contract.
   */
  __sendMessageForTest(id: ConversationId, text: string): Promise<void>;
  /**
   * Test seam: attach a loopback transport to a session's orchestrator so two
   * controllers can run the real crypto handshake against each other without
   * WebRTC. The caller cross-wires a pair via {@link linkLoopbackPair} and
   * attaches each side. NOT part of the public contract.
   */
  __attachTransportForTest(id: ConversationId, transport: PeerTransport): void;
}

const EMPTY_STATE: ChatControllerState = {
  activeConversationId: null,
  sessions: [],
  active: null,
  conversations: [],
  groups: [],
  activeGroupId: null,
  activeGroup: null,
  ready: false,
  error: null,
  connectionState: ConnectionState.Idle,
  conversationId: null,
  invitation: null,
  safetyNumber: null,
  safetyNumberVerified: false,
  messages: [],
};

/** Internal placeholder for SSR/initial renders before the controller exists. */
export const initialChatControllerState: ChatControllerState = EMPTY_STATE;

/**
 * The single object React talks to. Owns identity, the at-rest key, a
 * {@link ConversationRepository}, and a {@link Map} of per-conversation
 * {@link ChatSession}s (each with its own orchestrator + WebRTC bridge).
 *
 * Multiple sessions may be live concurrently: background/idle sessions keep
 * their bridges running so messages still arrive. Selecting a session is a
 * cheap active-id swap (no re-handshake); {@link ChatController.leaveConversation}
 * tears down ONE session only.
 *
 * Non-React (plain TypeScript) so it is testable without a render tree.
 * React subscribes via {@link ChatController.subscribe} and reads
 * {@link ChatController.getState} to render.
 */
export function createChatController(deps: ChatControllerDeps): ChatController {
  const atRestKey = deps.atRestKeyManager.get();
  // A pre-built repository wins over the factory. Both providers that need an
  // async store open (the browser opens its OPFS SQLite DB before building the
  // controller) pass `repository`; the legacy factory path stays for tests.
  const rawRepository = deps.repository ?? deps.repositoryFactory(atRestKey);
  // Wrap the repository so every ciphertext-touching call gates on
  // `manager.isLocked()`. This is the authoritative lock: lock() flips the
  // manager flag, and any subsequent seal/unseal throws AtRestLockedError.
  const repository: ConversationRepository = new LockableRepository(
    rawRepository,
    deps.atRestKeyManager,
  );
  const listeners = new Set<(state: ChatControllerState) => void>();
  /**
   * R9/F3 (Phase 8.5): the session/holder/readMarker/sendQueue maps key by the
   * HEX STRING of the ConversationId, not the branded Uint8Array reference.
   * ConversationId is a `Brand<Uint8Array, "ConversationId">`; without keyOf,
   * `sessions.get(id)` uses SameValueZero reference equality, so two value-
   * equal ids produced by different code paths (e.g. an id round-tripped
   * through `orchestrator.start()` vs. one re-parsed from a fragment during
   * `resumeConversation`) would miss each other in the map. The test seam
   * `__receiveMessageForTest`, the controller's own `resumeConversation`
   * re-entry, and any caller that holds an old id reference all rely on value
   * equality. `keyOf` normalizes to a lowercase hex string (16 bytes → 32
   * chars), matching the store's `idKey` convention; it is O(16) per call,
   * negligible next to the React re-render it gates.
   */
  const sessions = new Map<string, ChatSession>();
  /**
   * Live group sessions keyed by the hex of the GroupId (same keyOf
   * normalization as the session map — both brands are 16-byte ids). The
   * record itself holds the session + manager pair built by
   * {@link createGroupHost}.
   */
  const groupSessions = new Map<string, ChatGroupSession>();
  /** Read markers for group unread counting — same contract as readMarkers. */
  const groupReadMarkers = new Map<string, number>();
  /** In-flight joinGroup attempts keyed by hex group id (same dedup as `joining`). */
  const groupJoining = new Map<string, Promise<void>>();
  let activeGroupId: GroupId | null = null;
  // R5/F4: in-flight resumeConversation attempts keyed by hex id, so a
  // concurrent resume of the same conversation dedupes onto one startSession.
  const resuming = new Map<string, Promise<void>>();
  // R7F3 (Phase 5.2): in-flight joinConversation attempts keyed by the hex
  // conversation id extracted from the fragment up front (the orchestrator
  // resolves the same id inside join(), but only after an await — too late
  // to dedupe a second caller). joinConversation and resumeConversation
  // cross-check each other's map so a join and a resume for the same id can
  // never both reach startSession.
  const joining = new Map<string, Promise<void>>();
  // R3F1 (Phase 3): per-conversation lifecycle epochs, bumped by
  // leaveConversation/leaveAll. An in-flight startSession snapshots the epochs
  // at entry (the resume path captures its target's epoch in performResume
  // BEFORE that function's first await, where the conversation id is already
  // known) and re-checks after every await: if the epoch for its conversation
  // advanced, a leave won the race and the half-built orchestrator/bridge is
  // torn down instead of installed. Disposal is covered globally by the
  // `disposed` flag, which aborts every in-flight start the same way. Entries
  // are deliberately never deleted: a later resume of the same conversation
  // snapshots the post-leave value and proceeds normally.
  const conversationEpochs = new Map<string, number>();

  function bumpConversationEpoch(key: string): void {
    conversationEpochs.set(key, (conversationEpochs.get(key) ?? 0) + 1);
  }

  /**
   * R3F1 (Phase 3): entry-time epoch snapshot for a start attempt. `target`
   * (the resume path) may record an OLDER epoch than the current map value —
   * it is captured in performResume before that function's first await, so a
   * leave landing between the capture and startSession's entry is still
   * detected as an epoch mismatch by the post-await re-checks.
   */
  function snapshotConversationEpochs(target?: ConversationLifecycle): Map<string, number> {
    const snapshot = new Map(conversationEpochs);
    if (target !== undefined) {
      snapshot.set(target.key, target.epoch);
    }
    return snapshot;
  }
  // Holders link each orchestrator's construction-time handlers to its session.
  const holders = new Map<string, SessionHolder>();
  let activeConversationId: ConversationId | null = null;
  let conversationsCache: readonly ConversationRecord[] = [];
  // `ready` is true once the controller is constructed: the deps contract
  // (identity + at-rest key loaded BEFORE construction) is the only readiness
  // gate. Surfaced on every state snapshot so React consumers can gate on it.
  let ready = true;
  let disposed = false;

  /**
   * Re-derive the immutable state snapshot and notify every subscriber. Called
   * after any session change or repository mutation. The derivation is cheap
   * (one pass over the session map + a slice of the conversation cache).
   */
  function emit(error: string | null): void {
    // R5/F1: one shared dispose guard for every async path. Awaiting methods
    // (sendText, clearConversation, boot-hydrate's `.catch(emit)`, …) can
    // straddle disposal; without this they would mutate state and notify
    // subscribers of a torn-down controller.
    if (disposed) return;
    const state = buildState(error);
    // R7F10 (Phase 5.2): per-listener snapshot-and-swallow, matching the
    // at-rest-key-manager notify convention. An unguarded loop lets a
    // throwing subscriber starve the remaining listeners AND propagate into
    // whatever called emit — orchestrator handler chains (where the throw is
    // misreported as DurableStoreWriteFailed) or drainSendQueue's catch (an
    // unhandled rejection). The snapshot also keeps iteration stable if a
    // listener (un)subscribes during dispatch.
    const snapshot = Array.from(listeners);
    for (const listener of snapshot) {
      try {
        listener(state);
      } catch (err: unknown) {
        // The listener owns its own error handling; a controller subscriber
        // throwing must not break the emit path or block other listeners.
        console.warn("chat-controller: a state subscriber threw during emit", err);
      }
    }
  }

  function buildState(error: string | null): ChatControllerState {
    const sessionList = Array.from(sessions.values());
    const summaries = sessionList
      .map((session) => summarizeSession(session))
      .sort(compareSummaries);
    const active =
      activeConversationId !== null ? (sessions.get(keyOf(activeConversationId)) ?? null) : null;
    const activeView = activeSessionView(active);
    const groupSummaries = Array.from(groupSessions.values())
      .map((group) => summarizeGroup(group))
      .sort(compareGroupSummaries);
    const activeGroup =
      activeGroupId !== null ? (groupSessions.get(keyOf(activeGroupId)) ?? null) : null;
    return {
      activeConversationId,
      sessions: summaries,
      active: activeView,
      conversations: conversationsCache,
      groups: groupSummaries,
      activeGroupId,
      activeGroup:
        activeGroup === null
          ? null
          : activeGroupView(activeGroup, deps.identityManager.get().publicKey),
      ready,
      error,
      // Backward-compatible mirrors of the active session (or empty defaults).
      connectionState: active?.connectionState ?? ConnectionState.Idle,
      conversationId: active?.id ?? null,
      invitation: active?.invitation ?? null,
      safetyNumber: active?.safetyNumber ?? null,
      safetyNumberVerified: active?.safetyNumberVerified ?? false,
      messages: active?.messages ?? [],
    };
  }

  // R5/F2: refresh single-flight. Without this, the boot-hydrate refresh and
  // a mutation-triggered refresh (startConversation/resumeConversation/
  // setDisplayName) could run concurrently and resolve out of order, briefly
  // overwriting conversationsCache with a stale snapshot (a just-created
  // conversation disappearing from the sidebar for a tick). Every call is
  // CHAINED onto the tail: concurrent callers never issue overlapping reads,
  // and a refresh requested while one is in flight still re-reads afterwards
  // (its mutations may postdate the in-flight read's snapshot), so the last
  // write is always the freshest.
  let refreshTail: Promise<void> = Promise.resolve();

  function refreshConversations(): Promise<void> {
    const next = refreshTail.then(runRefresh, runRefresh);
    // The tail never retains a rejection: each caller gets `next` directly,
    // and a failed refresh must not poison every subsequent chain.
    refreshTail = next.catch(() => {});
    return next;
  }

  async function runRefresh(): Promise<void> {
    // Fetch the conversation rows AND the group-scoped exclusion set together:
    // group-scoped ids (the group id itself + every pairwise link id derived
    // from a group record's or live session's member list) must never surface
    // in the resumable sidebar list. The current build persists no such rows —
    // link orchestrators run on a PairwiseLinkRepository and the transcript is
    // in-memory — so the mask is defense-in-depth for rows persisted by
    // earlier builds or arriving via export/import.
    const [rows, groupScopedKeys] = await Promise.all([
      repository.listConversations(),
      groupScopedConversationKeys(),
    ]);
    // The await can straddle disposal (e.g. a boot-time hydrate resolving after
    // the provider unmounted and called dispose()). Bail before mutating state
    // or emitting into a torn-down controller.
    if (disposed) return;
    conversationsCache = rows.filter((r) => !groupScopedKeys.has(keyOf(r.id)));
    // Sync each session's cached record so summary derivation stays cheap.
    for (const session of sessions.values()) {
      const updated = conversationsCache.find((r) => r.id === session.id) ?? null;
      session.record = updated;
    }
    emit(null);
  }

  /**
   * The onChange callback every session invokes when its snapshot mutates.
   * Background/idle sessions come through here too: we update the per-session
   * unread (when the session is not active) and emit a fresh snapshot.
   *
   * R9/F5 (Phase 8.5): the active-session branch advances readMarkers ONLY
   * based on RECEIVED messages (session.lastReceivedAt), never sent ones.
   * Previously the cursor tracked lastMessageAt (advanced by sent OR received),
   * which meant a sent message could push the read marker past a peer message
   * that arrived with an earlier timestamp (clock drift, queue ordering),
   * causing the unread count to drop to 0 in the non-active branch even though
   * the user had not actually seen the peer's message.
   */
  const onSessionChange: SessionChangeCallback = (session): void => {
    // R3F2 (Phase 3): VALUE comparison via keyOf — `!==` on the branded
    // Uint8Array was reference equality, so an activeConversationId stored
    // from a caller-supplied reference (a repository record's deserialized
    // id) made the ACTIVE session take the background branch forever (unread
    // climbing, read marker never advancing) while buildState's keyOf lookup
    // rendered it active. The assignment sites normalize to the session's own
    // id; the comparison is value-based so a normalization lapse cannot
    // reintroduce the divergence.
    if (activeConversationId === null || keyOf(activeConversationId) !== keyOf(session.id)) {
      // Non-active session receiving a message: increment unread. The message
      // itself is already mirrored into `session.messages` by the handler; the
      // unread bump reflects "things the user hasn't looked at yet."
      // R9/F5: only RECEIVED-direction messages count toward unread; sent
      // messages by definition are already seen (the user typed them).
      const last = session.lastReceivedAt;
      if (last !== null) {
        // Count RECEIVED messages whose timestamp is past the session's
        // "read up to" marker. The marker is updated whenever the session is
        // selected OR when a received message arrives while active.
        const readUpTo = readMarkers.get(keyOf(session.id)) ?? -Infinity;
        let unread = 0;
        for (const m of session.messages) {
          if (m.timestamp > readUpTo && m.direction === "received") {
            unread++;
          }
        }
        session.unread = unread;
      } else {
        // Never received a message: unread stays at 0.
        session.unread = 0;
      }
    } else {
      // Active session: no unread. Advance the read marker ONLY for RECEIVED
      // messages — a sent message must NOT push the cursor forward, otherwise
      // a peer's message arriving with an earlier timestamp would be skipped
      // by the non-active branch's "m.timestamp > readUpTo" check.
      if (session.lastReceivedAt !== null) {
        const k = keyOf(session.id);
        const prev = readMarkers.get(k) ?? -Infinity;
        if (session.lastReceivedAt > prev) {
          readMarkers.set(k, session.lastReceivedAt);
        }
      }
      session.unread = 0;
    }
    // Drain queued sends whenever a session's transfer list changes: a
    // just-finished send frees a slot. The drain is a no-op when the queue
    // is empty or the cap is saturated.
    drainSendQueue(session.id);
    emit(null);
  };

  // Read markers track "the user has seen up to this timestamp" per session.
  const readMarkers = new Map<string, number>();

  /**
   * Per-session registry of received file bytes, keyed by transfer id. The
   * orchestrator's onFileReceived handler populates this; the UI reads it via
   * {@link getReceivedFile} to render Save/thumbnail. Bytes live in memory
   * only (per the threat model: files are never persisted). Cleared on
   * teardown.
   *
   * Stored on the session object (not the snapshot) so it never reaches React
   * state; the controller reads it from the live session.
   */
  /**
   * Per-session transfer queue. When a send would exceed
   * {@link MAX_CONCURRENT_TRANSFERS}, the request is appended here and
   * started when an in-flight send completes. Each entry carries the
   * pre-read bytes + metadata so the dequeue path is synchronous.
   */
  interface QueuedSend {
    readonly data: Uint8Array;
    readonly name: string;
    readonly mimeType: string;
    readonly size: number;
    /**
     * The synthetic id assigned at queue time so the snapshot has a stable
     * handle before the real orchestrator id is allocated. The orchestrator's
     * real id is recorded in the snapshot when the send eventually starts.
     */
    readonly queuedId: number;
    /** Resolves with the orchestrator id once the send starts; null on drop. */
    readonly resolve: (transferId: number) => void;
    /** Resolves with null if the queued send is cancelled before start. */
    readonly reject: (err: unknown) => void;
  }
  const sendQueues = new Map<string, QueuedSend[]>();
  let nextQueuedId = 1;

  function syncActiveReadMarker(session: ChatSession): void {
    // R9/F5 (Phase 8.5): advance the read marker only as far as the most
    // recent RECEIVED message. Using lastMessageAt here would mark sent-only
    // tails as "read up to T", which then suppresses the unread count for a
    // peer message arriving with an earlier timestamp (clock drift, queue
    // reorder). lastReceivedAt is null when the session has never received a
    // message — fall back to -Infinity so recomputeUnread sees no reads yet.
    const latest = session.lastReceivedAt ?? -Infinity;
    readMarkers.set(keyOf(session.id), latest);
    recomputeUnread(session);
  }

  function recomputeUnread(session: ChatSession): void {
    const readUpTo = readMarkers.get(keyOf(session.id)) ?? -Infinity;
    let unread = 0;
    for (const m of session.messages) {
      if (m.timestamp > readUpTo && m.direction === "received") {
        unread++;
      }
    }
    session.unread = unread;
  }

  /**
   * Construct the per-session orchestrator + holder (no bridge yet). The bridge
   * is wired by the caller after the entry point resolves the conversation id.
   */
  function buildSessionOrchestrator(): {
    orchestrator: ConversationOrchestrator;
    holder: SessionHolder;
  } {
    const holder: SessionHolder = { session: null };
    const orchestrator = buildOrchestrator(
      {
        brokerUrl: deps.brokerUrl,
        baseUrl: deps.baseUrl,
        publicBaseUrl: deps.publicBaseUrl ?? deps.baseUrl,
        repository,
        socketFactory: deps.socketFactory,
        identity: deps.identityManager.get(),
        peerConnectionFactory: deps.peerConnectionFactory,
        iceServers: deps.iceServers,
        // R8/F1 (Phase 6): thread the PAKE feature gate to the orchestrator.
        enablePake: deps.enablePake,
      },
      holder,
      onSessionChange,
    );
    return { orchestrator, holder };
  }

  function bridgePresenceCallbacks(orchestrator: ConversationOrchestrator): {
    onPeerJoin: () => void;
    onPeerLeave: () => void;
    onSignalingClosed: () => void;
  } {
    return {
      onPeerJoin: (): void => {
        orchestrator.notifyPeerJoined();
      },
      onPeerLeave: (): void => {
        orchestrator.notifyPeerLeft();
      },
      onSignalingClosed: (): void => {
        orchestrator.notifySignalingClosed();
      },
    };
  }

  /**
   * Phase 7 (protocol-v2 UI): the shell renders exactly ONE active main pane,
   * keyed off {@link ChatControllerState.activeConversationId} /
   * {@link ChatControllerState.activeGroupId}, so the two selections are
   * mutually exclusive — activating a conversation clears the active group
   * and vice versa. The deselected side stays live in the background (its
   * bridge/manager keeps running and its unread counting falls into the
   * non-active branch automatically); selection is a pointer swap, never a
   * teardown.
   */
  function activateConversation(id: ConversationId): void {
    activeConversationId = id;
    activeGroupId = null;
  }

  function activateGroup(id: GroupId): void {
    activeGroupId = id;
    activeConversationId = null;
  }

  function registerSession(session: ChatSession): void {
    sessions.set(keyOf(session.id), session);
    activateConversation(session.id);
    syncActiveReadMarker(session);
  }

  // -----------------------------------------------------------------------
  // Group sessions (protocol-v2)
  // -----------------------------------------------------------------------

  /**
   * The conversation-id keys that must NEVER surface in the resumable
   * sidebar list because they are group-scoped: the group id itself (the
   * namespace the group's transcript rows carry) plus every DERIVED pairwise
   * conversation id a per-link orchestrator resolves during a link handshake
   * ({@link derivePairwiseConvId} per member). No such rows are persisted by
   * this build — the mask is the defense-in-depth layer for rows written by
   * earlier builds or re-imported from an export bundle.
   *
   * Sources are the union of the stored group records AND the live sessions'
   * member lists — the stored record can lag the live list by a gossip hop
   * (the host's updateGroupMembership write settles asynchronously), and a
   * live session may predate its landed record. Stored records keep their
   * last-known member list after leave, so pairwise ids stay masked for
   * rows a foreign export/import could reintroduce.
   */
  async function groupScopedConversationKeys(): Promise<Set<string>> {
    const excluded = new Set<string>();
    const ownPub = deps.identityManager.get().publicKey;
    const memberPubsByGroup = new Map<string, Map<string, GroupMember>>();
    const groupIds = new Map<string, GroupId>();
    const collect = (groupId: GroupId, members: readonly GroupMember[]): void => {
      const k = keyOf(groupId);
      excluded.add(k); // the group-scoped id itself (transcript namespace)
      groupIds.set(k, groupId);
      let pubs = memberPubsByGroup.get(k);
      if (pubs === undefined) {
        pubs = new Map<string, GroupMember>();
        memberPubsByGroup.set(k, pubs);
      }
      for (const m of members) {
        pubs.set(pubKeyId(m.identityPub), m);
      }
    };
    for (const record of await repository.listGroups()) {
      collect(record.groupId, record.members);
    }
    for (const group of groupSessions.values()) {
      collect(group.id, group.session.memberList);
    }
    for (const [k, pubs] of memberPubsByGroup) {
      const groupId = groupIds.get(k) as GroupId;
      for (const member of pubs.values()) {
        if (ctEqual(member.identityPub, ownPub)) continue;
        excluded.add(keyOf(await derivePairwiseConvId(groupId, ownPub, member.identityPub)));
      }
    }
    return excluded;
  }

  /**
   * The group counterpart of {@link onSessionChange}: advance the active
   * group's read marker on received messages, or count unread on a
   * background group, then emit a fresh snapshot.
   */
  function onGroupSessionChange(group: ChatGroupSession): void {
    if (activeGroupId === null || keyOf(activeGroupId) !== keyOf(group.id)) {
      const last = group.lastReceivedAt;
      if (last !== null) {
        const readUpTo = groupReadMarkers.get(keyOf(group.id)) ?? -Infinity;
        let unread = 0;
        for (const m of group.messages) {
          if (m.timestamp > readUpTo && m.direction === MessageDirection.Received) {
            unread++;
          }
        }
        group.unread = unread;
      } else {
        group.unread = 0;
      }
    } else {
      if (group.lastReceivedAt !== null) {
        const k = keyOf(group.id);
        const prev = groupReadMarkers.get(k) ?? -Infinity;
        if (group.lastReceivedAt > prev) {
          groupReadMarkers.set(k, group.lastReceivedAt);
        }
      }
      group.unread = 0;
    }
    emit(null);
  }

  /** Non-fatal group session/manager errors surface on `state.error`. */
  function onGroupSessionError(group: ChatGroupSession, error: unknown): void {
    void group;
    emitErrorMessage(error);
  }

  /**
   * The group's session ended — leave, kick self-eject, or broker-seat loss.
   * The host has already torn the manager down (the obs-F pairing); we just
   * evict the record. A no-arg delete when the controller already evicted it
   * (leaveGroup deletes first, then tears down) keeps this idempotent.
   */
  function onGroupSessionEnded(group: ChatGroupSession): void {
    const k = keyOf(group.id);
    if (groupSessions.get(k) !== group) return;
    groupSessions.delete(k);
    groupReadMarkers.delete(k);
    if (activeGroupId !== null && keyOf(activeGroupId) === k) {
      activeGroupId = null;
    }
    emit(null);
  }

  /** Construct the session + manager pair with the controller's singletons. */
  function buildGroupHost(init: GroupHostInit): ChatGroupSession {
    return createGroupHost(
      {
        brokerUrl: deps.brokerUrl,
        baseUrl: deps.baseUrl,
        repository,
        socketFactory: deps.socketFactory,
        peerConnectionFactory: deps.peerConnectionFactory,
        iceServers: deps.iceServers,
        identity: deps.identityManager.get(),
        enablePake: deps.enablePake,
        maxMembers: deps.maxGroupMembers,
      },
      init,
      {
        onChange: onGroupSessionChange,
        onError: onGroupSessionError,
        onEnded: onGroupSessionEnded,
      },
    );
  }

  function syncGroupReadMarker(group: ChatGroupSession): void {
    // Same R9/F5 contract as syncActiveReadMarker: the marker tracks the most
    // recent RECEIVED message only, so a sent message never suppresses unread.
    groupReadMarkers.set(keyOf(group.id), group.lastReceivedAt ?? -Infinity);
    group.unread = 0;
  }

  function findGroupOrThrow(id: GroupId): ChatGroupSession {
    const group = groupSessions.get(keyOf(id));
    if (group === undefined) {
      throw new GroupError(GroupErrorCode.GroupNotFound, `no live group session for group ${id}`);
    }
    return group;
  }

  /**
   * Register the group record in the repository — the shared second half of
   * startGroup/joinGroup after the host is built. The group transcript is
   * deliberately NOT persisted: it lives on {@link ChatGroupSession.messages}
   * (in-memory, session-scoped), so no group-scoped conversation row is ever
   * created and nothing group-related can leak into the resumable
   * conversation list or the export bundle. `storeGroup` is the only write
   * left, so there is no partial-write window to order around — a failure
   * leaves the store untouched; the catch then tears the half-registered
   * group down, evicts it, surfaces the error on `state.error`, and rethrows
   * to the caller.
   */
  async function persistGroupRecord(group: ChatGroupSession, label: string | null): Promise<void> {
    const k = keyOf(group.id);
    try {
      await repository.storeGroup({
        groupId: group.id,
        epoch: group.session.memberEpoch,
        // The author knows itself from the start; a joiner learns the author
        // key when it adopts its first signed list (updateGroupMembership
        // populates it from the isAuthor entry).
        authorIdentityPub: group.isAuthor ? deps.identityManager.get().publicKey : null,
        members: group.session.memberList,
        displayName: label,
        createdAt: Date.now(),
      });
    } catch (err: unknown) {
      if (groupSessions.get(k) === group) {
        groupSessions.delete(k);
        groupReadMarkers.delete(k);
        if (activeGroupId !== null && keyOf(activeGroupId) === k) {
          activeGroupId = null;
        }
      }
      teardownGroup(group);
      emitErrorMessage(err);
      throw err;
    }
  }

  /**
   * The single-flight body of joinGroup: build the joiner host, persist the
   * (author-key-unknown) record, then seat in the broker room.
   */
  async function performJoinGroup(
    groupId: GroupId,
    code: string | null,
    options?: { readonly displayName?: string },
  ): Promise<void> {
    const key = keyOf(groupId);
    const group = buildGroupHost({
      groupId,
      isAuthor: false,
      authMode: code === null ? AuthMode.SafetyNumberOnly : AuthMode.Pake,
      pakeCode: code ?? undefined,
      memberName: options?.displayName,
      label: null,
      invitation: null,
    });
    groupSessions.set(key, group);
    activateGroup(group.id);
    syncGroupReadMarker(group);
    await persistGroupRecord(group, null);
    // The awaits above can straddle a leaveGroup/leaveAll/dispose: when the
    // record is gone our entry was already evicted and torn down by that
    // path — connect() on the closed manager is a no-op anyway, but bail
    // before refreshing state the caller no longer owns.
    if (disposed || groupSessions.get(key) !== group) {
      return;
    }
    group.manager.connect();
    await refreshConversations();
    emit(null);
  }

  async function startSession(
    role: Role,
    fragment?: string,
    seed?: (session: ChatSession) => Promise<void>,
    pakeCode?: string,
    targetLifecycle?: ConversationLifecycle,
  ): Promise<{ session: ChatSession | null; invitation: string | null }> {
    // R3F1 (Phase 3): snapshot the lifecycle state BEFORE the first await.
    // Every await below can straddle a dispose() or a leaveConversation() for
    // this conversation; the re-checks compare against this snapshot so a
    // losing start tears its half-built resources down instead of installing
    // a zombie session (live broker socket, RTCPeerConnection, orchestrator)
    // nobody will ever tear down. Until bridge.start() — the LAST statement —
    // an attempt holds no socket and no registered state, so aborting at any
    // check leaks nothing.
    const entryEpochs = snapshotConversationEpochs(targetLifecycle);
    const { orchestrator, holder } = buildSessionOrchestrator();
    let conversationId: ConversationId;
    let invitation: string | null = null;
    if (role === Role.Initiator && fragment === undefined) {
      invitation = await orchestrator.start(pakeCode);
      conversationId = orchestrator.conversationId as ConversationId;
    } else {
      // Responder or resume-via-join: the orchestrator parses the fragment.
      await orchestrator.join(fragment as string);
      conversationId = orchestrator.conversationId as ConversationId;
    }
    const conversationKey = keyOf(conversationId);
    if (startAborted(entryEpochs, conversationKey)) {
      // R3F1: dispose()/leaveConversation() won the race before the session
      // existed. Release the orchestrator (best-effort, mirroring
      // teardownSession's swallow) and bail BEFORE the holder/bridge/session
      // are built — nothing is registered and no socket was dialed.
      try {
        orchestrator.leave();
      } catch {
        // best-effort
      }
      assertNotDisposed(disposed);
      return { session: null, invitation };
    }
    const prior = sessions.get(conversationKey);
    if (prior !== undefined) {
      // R7F3 (Phase 5.2): a session for this conversation is already live —
      // the caller raced past the join/resume single-flight guards (or two
      // fresh starts collided on an id). Letting registerSession run here
      // would silently overwrite sessions/holders and orphan the live
      // session's bridge, which then holds a broker room slot forever
      // (capacity is 2 — the orphan squats a seat and locks the peer out).
      // Release the just-built orchestrator and hand back the live session.
      try {
        orchestrator.leave();
      } catch {
        // best-effort
      }
      // Select the live session like the entry-point "already live" branches
      // do — the caller asked for THIS conversation, and returning it
      // unselected left the UI pointing at whatever was active before (plus
      // a stale read marker and a stuck detached gate after a clear).
      activateConversation(prior.id);
      syncActiveReadMarker(prior);
      prior.detached = false;
      return { session: prior, invitation };
    }
    holders.set(conversationKey, holder);
    const presence = bridgePresenceCallbacks(orchestrator);
    const session = wireBridge({
      orchestrator,
      holder,
      conversationId,
      role,
      brokerUrl: deps.brokerUrl,
      socketFactory: deps.socketFactory,
      peerConnectionFactory: deps.peerConnectionFactory,
      iceServers: deps.iceServers,
      ...presence,
    });
    session.invitation = invitation;
    // R9/F3 (Phase 8.5): register the session in the session map BEFORE
    // bridge.start() so the seed hook (if any) can populate the snapshot
    // before any live inbound frame arrives. The previous ordering started
    // the bridge first, racing a fast peer's onMessage against
    // seedSessionFromHistory — the seed would then overwrite the live frame.
    // The seed hook is optional so startConversation/joinConversation are
    // unaffected; it is invoked between registerSession and bridge.start().
    registerSession(session);
    if (seed !== undefined) {
      try {
        await seed(session);
      } catch (err: unknown) {
        // R7F5 (Phase 5.2): a throwing seed (e.g. AtRestLockedError from
        // getHistory racing lock()) must not leave a phantom registered
        // session — retry()/resumeConversation cannot recover a session whose
        // bridge never started. Tear down + unregister everything
        // registerSession installed (idempotent; a concurrent leave/dispose
        // may have already run parts of it), surface the eviction, and
        // rethrow so the caller sees the seed's failure.
        abortRegisteredStart(session, holder, conversationKey);
        emit(err instanceof Error ? err.message : String(err));
        throw err;
      }
      if (startAborted(entryEpochs, conversationKey)) {
        // R3F1: a leave/dispose landed while the seed read was in flight. The
        // session registered itself, so mirror leaveConversation's eviction:
        // tear the orchestrator + bridge down and remove everything
        // registerSession installed. bridge.start() below is unreachable, so
        // the freshly built bridge never dials.
        abortRegisteredStart(session, holder, conversationKey);
        assertNotDisposed(disposed);
        return { session: null, invitation };
      }
    }
    session.bridge.start();
    return { session, invitation };
  }

  /**
   * R3F1 (Phase 3): true if the controller was disposed or the conversation's
   * lifecycle epoch advanced past the entry snapshot while a start was parked
   * at an await (leaveConversation/leaveAll bump the epoch of the target
   * conversation).
   */
  function startAborted(
    entryEpochs: ReadonlyMap<string, number>,
    conversationKey: string,
  ): boolean {
    if (disposed) return true;
    return (
      (conversationEpochs.get(conversationKey) ?? 0) !== (entryEpochs.get(conversationKey) ?? 0)
    );
  }

  /**
   * R3F1 (Phase 3): evict a start that registered itself and then lost a
   * leave/dispose race during its seed read. Mirrors leaveConversation's
   * teardown + map cleanup so the aborted attempt leaves no trace; every step
   * is idempotent because leaveConversation/dispose may have already run it.
   */
  function abortRegisteredStart(
    session: ChatSession,
    holder: SessionHolder,
    conversationKey: string,
  ): void {
    teardownSession(session, holder);
    sessions.delete(conversationKey);
    holders.delete(conversationKey);
    readMarkers.delete(conversationKey);
    drainSendQueueForTarget(conversationKey);
    if (activeConversationId !== null && keyOf(activeConversationId) === conversationKey) {
      // Do NOT auto-select another session — same contract as leaveConversation.
      activeConversationId = null;
    }
  }

  function findSessionOrThrow(id: ConversationId): ChatSession {
    const session = sessions.get(keyOf(id));
    if (session === undefined) {
      throw new Error(`no live session for conversation ${id}`);
    }
    return session;
  }

  /**
   * Count transfers currently submitted to the orchestrator (sending or
   * receiving). Queued entries are excluded: they have not entered the
   * framing layer yet. Used by {@link drainSendQueue} to decide whether a
   * slot is free for the next queued send.
   */
  function countInFlightTransfers(session: ChatSession): number {
    let n = 0;
    for (const t of session.transfers) {
      if (t.status === "sending" || t.status === "receiving") {
        n++;
      }
    }
    return n;
  }

  /**
   * Try to start the next queued send for a session (if any) now that a slot
   * has freed. Idempotent: a no-op when the queue is empty or the cap is
   * still saturated.
   *
   * Re-entrance note: {@link FrameSender.sendFile} fires `onTransferStart`
   * SYNCHRONOUSLY inside the controller's `await orchestrator.sendFile`, so a
   * drain triggered by a just-started send's onTransferStart can re-enter this
   * function while the original send's orchestrator call is still on the stack.
   * The cap check (`countInFlightTransfers >= MAX_CONCURRENT_TRANSFERS`) guards
   * the happy path; the `.catch` on the scheduled startSend is the safety net
   * that guarantees no orchestrator rejection (e.g. a cap reached again because
   * the in-flight snapshot had not yet reflected the just-started send) ever
   * escapes unhandled. startSend itself routes every orchestrator rejection to
   * `queued.reject` so the caller's await rejects cleanly, then returns without
   * re-throwing; the catch here therefore only fires for truly unexpected
   * throws and swallows them after surfacing via onSessionChange.
   */
  function drainSendQueue(id: ConversationId): void {
    const k = keyOf(id);
    const session = sessions.get(k);
    if (session === undefined) return;
    const queue = sendQueues.get(k);
    if (queue === undefined || queue.length === 0) return;
    if (countInFlightTransfers(session) >= MAX_CONCURRENT_TRANSFERS) return;
    const next = queue.shift()!;
    if (queue.length === 0) {
      sendQueues.delete(k);
    }
    void startSend(id, next).catch((err: unknown) => {
      // startSend routes orchestrator rejections to queued.reject itself and
      // does not re-throw, so reaching this branch means an unexpected throw
      // (e.g. a synchronous throw from onSessionChange). Surface the snapshot
      // update and swallow: the queued promise was already rejected inside
      // startSend, and letting this escape would surface as an unhandled
      // rejection during the onTransferStart re-entrance window.
      const s = sessions.get(k);
      if (s !== undefined) onSessionChange(s);
      void err;
    });
  }

  /**
   * Drain a session's send queue on teardown paths
   * (leaveConversation / leaveAll / dispose / clearConversation / clearAll).
   *
   * Each queued send's promise is rejected with "conversation cleared" so a
   * caller awaiting `sendFile` does not hang forever, and the pre-read byte
   * buffer is zeroed in place before the map entry is dropped (mirrors the
   * receivedFiles zeroing contract: queued bytes never persist beyond their
   * useful lifetime). Faithful extraction of the inline drain that lived in
   * clearConversation — the queued-entry type and the reject/data access are
   * identical.
   */
  function drainSendQueueForTarget(targetKey: string): void {
    const queue = sendQueues.get(targetKey);
    if (queue === undefined) return;
    for (const queued of queue) {
      queued.reject(new Error("conversation cleared"));
      queued.data.fill(0);
    }
    sendQueues.delete(targetKey);
  }

  /**
   * Drive one send through the orchestrator. Reads the bytes, calls
   * sendFile, and reconciles the queued-id placeholder in the snapshot with
   * the real orchestrator id once the send starts.
   *
   * Re-entrance contract: this is invoked as `void startSend(...).catch(...)`
   * from {@link drainSendQueue}, which itself can be re-entered synchronously
   * via `onTransferStart → onSessionChange` while THIS call's
   * `orchestrator.sendFile` is still on the stack. To keep that re-entrance
   * from escaping an unhandled rejection, EVERY failure path here MUST route
   * the error to `queued.reject` and return normally (never re-throw). The
   * promise reject is idempotent in practice — a racing cancel/dispose may
   * have already rejected `queued`; calling it again is a no-op on the
   * settled promise — so the caller's await always settles cleanly.
   */
  async function startSend(id: ConversationId, queued: QueuedSend): Promise<void> {
    const session = sessions.get(keyOf(id));
    if (session === undefined) {
      queued.reject(new Error(`no live session for conversation ${id}`));
      return;
    }
    // Validate name/mime length up front for a clear error before involving
    // the orchestrator (the orchestrator also enforces these, but surfacing
    // the error here keeps queued sends from blocking on a late rejection).
    const nameBytes = utf8Length(queued.name);
    if (nameBytes > MAX_MANIFEST_NAME_BYTES) {
      queued.reject(new Error(`name length ${nameBytes} exceeds ${MAX_MANIFEST_NAME_BYTES}`));
      return;
    }
    const mimeBytes = utf8Length(queued.mimeType);
    if (mimeBytes > MAX_MANIFEST_MIME_BYTES) {
      queued.reject(new Error(`mimeType length ${mimeBytes} exceeds ${MAX_MANIFEST_MIME_BYTES}`));
      return;
    }
    try {
      // Remove the queued placeholder before starting so the snapshot tracks
      // the real transfer via the orchestrator's onTransferStart. The queued
      // entry was added in sendFile; we drop it here and let the start event
      // re-introduce it with direction=sent + status=sending.
      session.transfers = session.transfers.filter((t) => t.id !== queued.queuedId);
      const realId = await session.orchestrator.sendFile(queued.data, queued.name, queued.mimeType);
      queued.resolve(realId);
    } catch (err: unknown) {
      // Remove the queued placeholder if the start never happened. Route the
      // orchestrator rejection (cap reached again under re-entrance,
      // NotConnected, etc.) to the queued promise so the caller's await
      // rejects cleanly, then return WITHOUT re-throwing — drainSendQueue's
      // .catch relies on this to guarantee no rejection escapes unhandled.
      session.transfers = session.transfers.filter((t) => t.id !== queued.queuedId);
      onSessionChange(session);
      queued.reject(err);
    }
  }

  // Boot hydration: the controller is constructed synchronously, but the
  // repository (browser OPFS/SQLite, or in-memory) may hold persisted
  // conversations from a previous session. The first getState() returns before
  // this resolves, so conversationsCache starts empty; we seed it async here
  // and emit once the persisted rows are in. Every subscriber — including the
  // provider attached immediately after construction — receives the populated
  // snapshot when the read resolves. Without this, a fresh boot shows no
  // resumable conversations until the user performs some action, even though
  // the store has them.
  void refreshConversations().catch((err: unknown) => {
    // Persistence is best-effort at boot: a read failure (e.g. a locked
    // at-rest key, OPFS hiccup) must not block the controller. Surface it as
    // a state error so the UI can render an alert, mirroring the load-failure
    // posture in the provider.
    emit(err instanceof Error ? err.message : String(err));
  });

  /**
   * The single-flight body of joinConversation (R7F3 / Phase 5.2): only ever
   * runs once per conversation at a time; concurrent joiners await the stored
   * promise. `lifecycle` is the caller-captured epoch snapshot (see
   * performResume) — captured in joinConversation BEFORE any await so a
   * leave landing while we waited on an in-flight resume still aborts the
   * completing start.
   */
  async function performJoin(fragment: string, lifecycle: ConversationLifecycle): Promise<void> {
    // Guard: an invitation fragment whose 16-byte id is GROUP-SCOPED — a
    // stored/live group id itself, or a pairwise link id derived from any
    // stored group record's or live session's member list — must not be
    // bound as a 1:1 conversation. The join flow decides pair-vs-group (§8),
    // and the pair path here is the wrong one for either id class.
    const bare = fragment.slice(fragment.lastIndexOf("#") + 1);
    const joinIdKey = keyOf(parseInvitation(bare).conversationId);
    if ((await groupScopedConversationKeys()).has(joinIdKey)) {
      throw new GroupError(
        GroupErrorCode.Malformed,
        "invitation identifies a group-scoped id; use joinGroup",
      );
    }
    const { session } = await startSession(
      Role.Responder,
      fragment,
      undefined,
      undefined,
      lifecycle,
    );
    if (session === null) {
      // R3F1: leave/dispose won the race; startSession already tore the
      // half-built orchestrator/bridge down and registered nothing. Resolve
      // quietly — the leave was the user's latest intent.
      return;
    }
    await refreshConversations();
    emit(null);
  }

  /**
   * The single-flight body of resumeConversation (R5/F4): only ever runs once
   * per conversation at a time; concurrent callers await the stored promise.
   *
   * R7F3 (Phase 5.2): `lifecycle` is now captured by resumeConversation at
   * ENTRY — before its join-dedup await — rather than here. A
   * leaveConversation landing while we awaited an in-flight join bumps the
   * epoch past the entry snapshot, so the completing resume still aborts.
   */
  async function performResume(
    conversationId: ConversationId,
    lifecycle: ConversationLifecycle,
  ): Promise<void> {
    const resumeKey = lifecycle.key;
    // Guard FIRST — before the unknown-conversation check: a group-scoped id
    // (a stored/live group id or a pairwise link id derived from any group
    // record's or live session's member list) must reject with the typed
    // GroupError even when no conversation row exists for it — pairwise
    // links deliberately persist no rows, so the record lookup alone cannot
    // distinguish them from a merely-unknown id.
    if ((await groupScopedConversationKeys()).has(resumeKey)) {
      throw new GroupError(
        GroupErrorCode.Malformed,
        `cannot resume group-scoped id ${conversationId} as a pair conversation`,
      );
    }
    const record = await repository.getConversation(conversationId);
    if (record === null) {
      throw new Error(`cannot resume unknown conversation ${conversationId}`);
    }
    // R3F4 (Phase 8): derive the bridge's glare role from the frozen §3 rule
    // (deriveResumeGlareRole → deriveRole: full lexicographic comparison of
    // the two 65-byte identity keys; smaller = Initiator = impolite) instead
    // of hard-coding Role.Initiator for EVERY resuming peer. Two peers
    // resuming simultaneously used to both be impolite, so their colliding
    // offers were mutually ignored with no tie-break, timeout, or re-offer —
    // glare deadlocked by design (with R3F5 fixed, the armed-flag
    // mutual-ignore is actually reachable). Both resuming sides hold the
    // SAME two keys (their own + the peer's TOFU-pinned key from the
    // conversation record), so both compute the same ordering and land on
    // OPPOSITE roles — exactly one side is polite and answers the other's
    // offer. Fallback: a record with no pinned peer (the conversation never
    // completed a handshake) keeps the previous Initiator behavior.
    const peerKey = record.peer?.publicKey ?? null;
    const role =
      peerKey === null
        ? Role.Initiator
        : deriveResumeGlareRole(deps.identityManager.get().publicKey, peerKey);
    // Re-enter the conversation by joining with the existing conversation id
    // (idempotent at the repository level for the in-memory store).
    const fragment = `#${resumeKey}`;
    // R9/F3 (Phase 8.5): seed the session snapshot INSIDE startSession,
    // BEFORE the bridge is started. This closes the race where a fast peer
    // rejoins and delivers a message between startSession returning and
    // seedSessionFromHistory running — that ordering overwrote the live
    // frame with persisted history. With the seed hook, the snapshot is
    // populated first; the bridge opens only after seeding completes, so
    // any inbound frame is APPENDED to the seeded history, not lost.
    const { session } = await startSession(
      role,
      fragment,
      async (s) => {
        const history = await s.orchestrator.getHistory();
        seedSessionFromHistory(s, record, history);
        recomputeUnread(s);
      },
      undefined,
      lifecycle,
    );
    if (session === null) {
      // R3F1: leave won the race; startSession already tore the half-built
      // orchestrator/bridge down and registered nothing. Resolve quietly —
      // the leave was the user's latest intent.
      return;
    }
    await refreshConversations();
    emit(null);
  }

  return {
    async startConversation(options?: { readonly code?: string }): Promise<{ invitation: string }> {
      assertNotDisposed(disposed);
      const code = options?.code;
      const trimmedCode = code === undefined ? undefined : code.trim();
      const result = await startSession(Role.Initiator, undefined, undefined, trimmedCode);
      if (result.session === null) {
        // R3F1: the start was aborted mid-flight. For a fresh conversation
        // only a dispose can abort (startSession already threw for that — its
        // id does not exist anywhere a leave could target it yet); the
        // orchestrator was left and nothing was registered. Fail loudly
        // rather than hand back an invitation whose room was already vacated.
        throw new Error("conversation start aborted before the session was installed");
      }
      // Initiator always produces an invitation link; the orchestrator's
      // `start()` returns it before we wire the bridge.
      const invitation = result.invitation as string;
      await refreshConversations();
      emit(null);
      return { invitation };
    },

    generatePakeCode(): string {
      return generatePakeCode();
    },

    async joinConversation(fragment: string): Promise<void> {
      assertNotDisposed(disposed);
      // R7F3 (Phase 5.2): resolve the conversation id up front so the dedup
      // checks below key on the SAME id the orchestrator will bind inside
      // join(). conversationKeyFromFragment mirrors the orchestrator's own
      // normalization (last `#` split + parseInvitation, which lowercases and
      // strips the `~code` tail), so a malformed fragment throws the same
      // MalformedInvitation error join() would have surfaced.
      const joinKey = conversationKeyFromFragment(fragment);
      const existing = sessions.get(joinKey);
      if (existing !== undefined) {
        // Already live; just select it (same contract as resumeConversation's
        // live branch — R3F2: store the SESSION's own id reference).
        activateConversation(existing.id);
        syncActiveReadMarker(existing);
        // Re-arm inbound handlers: re-joining a cleared conversation
        // re-opens it for live frames.
        existing.detached = false;
        emit(null);
        return;
      }
      // R3F1 (Phase 3): capture the lifecycle epoch BEFORE any await. A leave
      // landing while we wait on an in-flight resume below bumps the epoch
      // past this snapshot, so the completing startSession still aborts.
      const lifecycle: ConversationLifecycle = {
        key: joinKey,
        epoch: conversationEpochs.get(joinKey) ?? 0,
      };
      // R7F3: a resume for the same conversation may be in flight. Await it
      // and select the session it installed instead of double-starting — two
      // startSessions for one id used to orphan the first session's bridge,
      // which keeps its broker room slot forever (capacity is 2). A
      // failed/aborted resume installs nothing, so fall through to our own
      // join in that case.
      const inFlightResume = resuming.get(joinKey);
      if (inFlightResume !== undefined) {
        try {
          await inFlightResume;
        } catch {
          // The resume failed; the join below is the caller's next-best intent.
        }
        const landed = sessions.get(joinKey);
        if (landed !== undefined) {
          activateConversation(landed.id);
          syncActiveReadMarker(landed);
          landed.detached = false;
          emit(null);
          return;
        }
      }
      // R7F3: single-flight guard mirroring `resuming`. Two concurrent
      // joinConversation(sameFragment) calls (e.g. a double-tap on an invite
      // link) both used to pass the sessions check above before either
      // reached registerSession inside startSession.
      const inFlightJoin = joining.get(joinKey);
      if (inFlightJoin !== undefined) {
        try {
          await inFlightJoin;
        } catch {
          // The prior join failed; our own attempt below is the caller's
          // next-best intent.
        }
        // A same-map dedupe can silently resolve an ABORTED attempt: a leave
        // landing while it was in flight bumps the epoch past its snapshot,
        // so it resolves quietly having installed nothing. Re-check that it
        // actually installed a session — select it if so, otherwise fall
        // through to a fresh start under OUR (post-leave) lifecycle epoch,
        // mirroring the cross-map await → re-check → fall-through above.
        const landed = sessions.get(joinKey);
        if (landed !== undefined) {
          activateConversation(landed.id);
          syncActiveReadMarker(landed);
          landed.detached = false;
          emit(null);
          return;
        }
      }
      const attempt = performJoin(fragment, lifecycle).finally(() => {
        joining.delete(joinKey);
      });
      joining.set(joinKey, attempt);
      return attempt;
    },

    async resumeConversation(conversationId: ConversationId): Promise<void> {
      assertNotDisposed(disposed);
      const resumeKey = keyOf(conversationId);
      // R3F1 (Phase 3): capture the target's lifecycle epoch BEFORE the first
      // await — including the join-dedup await R7F3 added below. A
      // leaveConversation(id) landing anywhere between here and
      // startSession's own re-checks (the getConversation read,
      // orchestrator.join, the seed hook) bumps the epoch past this snapshot,
      // so the completing resume tears its half-built session down instead of
      // installing a conversation the user already left.
      const lifecycle: ConversationLifecycle = {
        key: resumeKey,
        epoch: conversationEpochs.get(resumeKey) ?? 0,
      };
      const existing = sessions.get(resumeKey);
      if (existing !== undefined) {
        // Already live; just select it.
        // R3F2 (Phase 3): store the SESSION's own id reference, not the
        // caller's value-equal one — repository rows hand back freshly
        // deserialized arrays, and a foreign reference here used to flip
        // onSessionChange into the background branch (see the keyOf
        // comparison there).
        activateConversation(existing.id);
        syncActiveReadMarker(existing);
        // Re-arm inbound handlers on resume.
        existing.detached = false;
        emit(null);
        return;
      }
      // R7F3 (Phase 5.2): a join for the same conversation may be in flight.
      // Await it and select the session it installed instead of
      // double-starting — two startSessions for one id used to orphan the
      // first session's bridge, which keeps its broker room slot forever
      // (capacity is 2). A failed/aborted join installs nothing, so fall
      // through to our own resume in that case.
      const inFlightJoin = joining.get(resumeKey);
      if (inFlightJoin !== undefined) {
        try {
          await inFlightJoin;
        } catch {
          // The join failed; the resume below is the caller's next-best intent.
        }
        const landed = sessions.get(resumeKey);
        if (landed !== undefined) {
          // A join-installed session never ran a seed hook (performJoin passes
          // none), so its snapshot is empty even when the repository holds
          // history for this conversation. Seed it the same way performResume
          // seeds a fresh session — record + history — before adopting it.
          let record: ConversationRecord | null;
          let history: ConversationMessage[];
          try {
            record = await repository.getConversation(landed.id);
            history = await landed.orchestrator.getHistory();
          } catch (err: unknown) {
            // Same surfacing contract as a throwing startSession seed hook
            // (R7F5): the resume rejects loudly rather than selecting an
            // unseeded session. The live session itself stays — the join owns
            // it; we only failed to decorate it.
            emit(err instanceof Error ? err.message : String(err));
            throw err;
          }
          // Guard like the seed hook inside startSession: the reads above can
          // straddle a leave/dispose/clear, so re-check the session is still
          // registered and not detached before overwriting its snapshot. If it
          // was evicted, fall through to our own resume — it either aborts on
          // the epoch mismatch or adopts whatever landed in the meantime.
          if (sessions.get(resumeKey) === landed && !landed.detached) {
            seedSessionFromHistory(landed, record, history);
            recomputeUnread(landed);
            activateConversation(landed.id);
            syncActiveReadMarker(landed);
            landed.detached = false;
            emit(null);
            return;
          }
        }
      }
      // R5/F4: single-flight guard. Two concurrent resumeConversation(sameId)
      // calls (e.g. a double-tap) both used to pass the synchronous
      // sessions.has check above before either reached registerSession inside
      // startSession — the second startSession orphaned the first session's
      // orchestrator + bridge + signaling socket + RTCPeerConnection. Repeat
      // callers now await the in-flight resume instead of starting a second
      // one.
      const inFlight = resuming.get(resumeKey);
      if (inFlight !== undefined) {
        try {
          await inFlight;
        } catch {
          // The prior resume failed; our own attempt below is the caller's
          // next-best intent.
        }
        // A same-map dedupe can silently resolve an ABORTED attempt: a leave
        // landing while it was in flight bumps the epoch past its snapshot,
        // so it resolves quietly having installed nothing. Re-check that it
        // actually installed a session — select it if so, otherwise fall
        // through to a fresh resume under OUR (post-leave) lifecycle epoch,
        // mirroring the cross-map await → re-check → fall-through above.
        const landed = sessions.get(resumeKey);
        if (landed !== undefined) {
          activateConversation(landed.id);
          syncActiveReadMarker(landed);
          landed.detached = false;
          emit(null);
          return;
        }
      }
      const attempt = performResume(conversationId, lifecycle).finally(() => {
        resuming.delete(resumeKey);
      });
      resuming.set(resumeKey, attempt);
      return attempt;
    },

    selectConversation(conversationId: ConversationId): void {
      assertNotDisposed(disposed);
      const session = sessions.get(keyOf(conversationId));
      if (session === undefined) {
        throw new Error(`cannot select unknown conversation ${conversationId}`);
      }
      // Cheap swap: no re-handshake. Clear unread + advance the read marker.
      // R3F2 (Phase 3): normalize to the session's own id reference (see the
      // resumeConversation already-live branch).
      activateConversation(session.id);
      syncActiveReadMarker(session);
      // Re-arm inbound handlers: selecting a cleared conversation re-opens it
      // for live frames.
      session.detached = false;
      emit(null);
    },

    leaveConversation(conversationId?: ConversationId): void {
      assertNotDisposed(disposed);
      // No-arg form leaves the active session (legacy UI contract).
      const target = conversationId ?? activeConversationId;
      if (target === null) return;
      const k = keyOf(target);
      // R3F1 (Phase 3): record the leave BEFORE the map lookup. When a live
      // session exists this is belt-and-braces (it is torn down below); when
      // it does not — a start/resume for this conversation still in flight —
      // the epoch bump is the ONLY record of the leave, and the completing
      // startSession observes it after its awaits and aborts instead of
      // installing a session the user just left.
      bumpConversationEpoch(k);
      const session = sessions.get(k);
      if (session === undefined) return;
      teardownSession(session, holders.get(k) ?? null);
      sessions.delete(k);
      holders.delete(k);
      readMarkers.delete(k);
      // CR-8: drain queued sends (reject promises + zero buffers) instead of
      // the bare sendQueues.delete that orphaned awaiters and left bytes
      // unzeroed.
      drainSendQueueForTarget(k);
      if (activeConversationId !== null && keyOf(activeConversationId) === k) {
        // Do NOT auto-select another session — the caller decides what to
        // surface next. The empty state is a valid and expected outcome.
        activeConversationId = null;
      }
      emit(null);
    },

    leaveAll(): void {
      assertNotDisposed(disposed);
      for (const session of sessions.values()) {
        // R3F1 (Phase 3): record the leave for every conversation (see
        // leaveConversation) so an in-flight start for any of them aborts.
        const k = keyOf(session.id);
        bumpConversationEpoch(k);
        teardownSession(session, holders.get(k) ?? null);
      }
      // CR-8: drain every session's send queue (reject + zero) before wiping
      // the session map. Collect keys first so we do not mutate sendQueues
      // while iterating a snapshot derived from it.
      for (const k of Array.from(sendQueues.keys())) {
        drainSendQueueForTarget(k);
      }
      sessions.clear();
      holders.clear();
      readMarkers.clear();
      activeConversationId = null;
      // Groups tear down too: every live group session sends `leave` on its
      // links and vacates its broker seat via the host's finishGroup funnel
      // (teardownGroup → manager.leave → session.leave). Eviction is direct
      // — the onEnded callbacks observe already-deleted map entries.
      for (const group of Array.from(groupSessions.values())) {
        const k = keyOf(group.id);
        groupSessions.delete(k);
        groupReadMarkers.delete(k);
        teardownGroup(group);
      }
      activeGroupId = null;
      emit(null);
    },

    setDraft(id: ConversationId, draft: string): void {
      assertNotDisposed(disposed);
      const session = sessions.get(keyOf(id));
      if (session === undefined) return;
      // Skip the emit when nothing changed: the composer calls this on every
      // keystroke, and an unchanged value would only churn subscribers.
      if (session.draft === draft) return;
      session.draft = draft;
      emit(null);
    },

    async sendText(idOrText: ConversationId | string, maybeText?: string): Promise<void> {
      assertNotDisposed(disposed);
      // Overload dispatch: sendText(text) targets the active session;
      // sendText(id, text) targets a specific session.
      const { id, value } = resolveSessionArgPair(idOrText, maybeText, activeConversationId);
      const session = findSessionOrThrow(id);
      // Re-arm inbound handlers: a send re-opens the conversation after a
      // clearConversation, so subsequent inbound frames are mirrored again.
      session.detached = false;
      await session.orchestrator.sendText(value);
      // The orchestrator persisted; onMessage fires only for received bytes,
      // so mirror the sent message into the snapshot manually.
      const history = await session.orchestrator.getHistory();
      session.messages = history;
      const last = history[history.length - 1];
      if (last !== undefined) {
        session.lastMessagePreview = last.text;
        session.lastMessageAt = last.timestamp;
      }
      onSessionChange(session);
    },

    async sendFile(id: ConversationId, file: ChatFileInput): Promise<number> {
      assertNotDisposed(disposed);
      const session = findSessionOrThrow(id);
      // R7F4 (Phase 5.2): re-arm inbound handlers on a file send, mirroring
      // sendText. Without this, a clearConversation-detached session drops
      // every transfer event at the chat-session gate (onTransferStart/
      // Progress/Complete/fileReceived all no-op on `detached`), so the
      // snapshot never shows the send and countInFlightTransfers /
      // drainSendQueue under-count the queue.
      session.detached = false;
      if (session.connectionState !== ConnectionState.Connected) {
        throw new Error("cannot sendFile before the session is connected");
      }
      const data = file.data;
      const name = file.name === "" ? "file.bin" : file.name;
      const mimeType = file.mimeType === "" ? "application/octet-stream" : file.mimeType;
      const nameBytes = utf8Length(name);
      if (nameBytes > MAX_MANIFEST_NAME_BYTES) {
        throw new Error(`name length ${nameBytes} exceeds ${MAX_MANIFEST_NAME_BYTES}`);
      }
      const mimeBytes = utf8Length(mimeType);
      if (mimeBytes > MAX_MANIFEST_MIME_BYTES) {
        throw new Error(`mimeType length ${mimeBytes} exceeds ${MAX_MANIFEST_MIME_BYTES}`);
      }
      // Backpressure gate: the orchestrator is the authority on the
      // concurrent-transfer cap (it tracks active sends synchronously). We
      // attempt the send; if it rejects with the cap, we queue instead. This
      // keeps the controller's view honest with the framing layer's actual
      // in-flight count, even under burst sends.
      try {
        const transferId = await session.orchestrator.sendFile(data, name, mimeType);
        return transferId;
      } catch (err: unknown) {
        if (!isConcurrentCapError(err)) throw err;
        // Queue and start when a slot frees.
        const queuedId = nextQueuedId++;
        session.transfers = session.transfers.concat({
          id: queuedId,
          name,
          mimeType,
          size: data.length,
          direction: "sent",
          bytesTransferred: 0,
          status: "queued",
        });
        onSessionChange(session);
        const qk = keyOf(id);
        const queue = sendQueues.get(qk) ?? [];
        const queued = new Promise<number>((resolve, reject): void => {
          queue.push({ data, name, mimeType, size: data.length, queuedId, resolve, reject });
        });
        sendQueues.set(qk, queue);
        return queued;
      }
    },

    cancelTransfer(id: ConversationId, transferId: number): void {
      assertNotDisposed(disposed);
      const k = keyOf(id);
      const session = sessions.get(k);
      if (session === undefined) return;
      // Cancel a queued send (never entered the orchestrator) by dropping it
      // from the queue and rejecting its promise via a synthetic placeholder.
      const queue = sendQueues.get(k);
      if (queue !== undefined) {
        const idx = queue.findIndex((q) => q.queuedId === transferId);
        if (idx !== -1) {
          const [removed] = queue.splice(idx, 1);
          if (queue.length === 0) sendQueues.delete(k);
          session.transfers = session.transfers
            .filter((t) => t.id !== transferId)
            .concat({
              id: transferId,
              name: removed!.name,
              mimeType: removed!.mimeType,
              size: removed!.size,
              direction: "sent",
              bytesTransferred: 0,
              status: "cancelled",
            });
          onSessionChange(session);
          removed!.reject(new Error("transfer cancelled"));
          return;
        }
      }
      // Otherwise delegate to the orchestrator. R3F2: the orchestrator's
      // cancel is direction-aware over an id space shared between the send
      // and receive sides, so resolve the direction from the snapshot's own
      // TransferState — a "send" cancel must never drop a same-id inbound
      // transfer. A snapshot miss means the id is a send still in its
      // hashing window (inbound transfers only enter the snapshot at
      // completion), so "send" is the correct fallback.
      const tracked = session.transfers.find((t) => t.id === transferId);
      session.orchestrator.cancelTransfer(
        transferId,
        tracked?.direction === "received" ? "receive" : "send",
      );
    },

    getReceivedFile(id: ConversationId, transferId: number): ReceivedFile | null {
      const session = sessions.get(keyOf(id));
      if (session === undefined) return null;
      return session.receivedFiles.get(transferId) ?? null;
    },

    async getHistory(id?: ConversationId): Promise<ConversationMessage[]> {
      const target = id ?? activeConversationId;
      if (target === null) return [];
      const session = sessions.get(keyOf(target));
      if (session === undefined) return [];
      return await session.orchestrator.getHistory();
    },

    markSafetyNumberVerified(id?: ConversationId): void {
      assertNotDisposed(disposed);
      const target = id ?? activeConversationId;
      if (target === null) return;
      const session = sessions.get(keyOf(target));
      if (session === undefined) return;
      session.orchestrator.markSafetyNumberVerified();
      // R13F5 (Phase 5.2): mirror the mark ONLY when the orchestrator
      // actually recorded it. markSafetyNumberVerified no-ops while its
      // safetyNumberValue is null (no handshake has computed one yet), so the
      // previous unconditional `true` reported verified for a session with
      // nothing to verify. isSafetyNumberVerified() is the orchestrator's
      // authoritative post-call state; when it did mark, its onSafetyNumber
      // handler also flips this flag — the explicit sync here keeps the
      // snapshot correct even if that handler is dropped (detached/torn
      // down).
      session.safetyNumberVerified = session.orchestrator.isSafetyNumberVerified();
      emit(null);
    },

    async setDisplayName(idOrName: ConversationId | string, maybeName?: string): Promise<void> {
      assertNotDisposed(disposed);
      const { id, value } = resolveSessionArgPair(idOrName, maybeName, activeConversationId);
      await repository.setDisplayName(id, value);
      await refreshConversations();
      emit(null);
    },

    retry(id?: ConversationId): void {
      assertNotDisposed(disposed);
      const target = id ?? activeConversationId;
      if (target === null) return;
      const session = sessions.get(keyOf(target));
      if (session === undefined) return;
      // LW-13 (Phase 7b): drain any queued sends for this target BEFORE
      // invoking orchestrator.retry(). A stale queued send (rejected with
      // "conversation cleared") must not remain in the per-target queue across
      // the retry boundary, or it would fire on the fresh handshake instead of
      // being rejected. drainSendQueueForTarget rejects each waiter and zeroes
      // its pre-read bytes — a stale queued send is then observed as rejected
      // by its caller instead of silently completing on the new session. This
      // mirrors the teardown-path drain (leaveConversation / clearConversation)
      // that CR-8 introduced; reusing the helper here keeps the two paths at
      // parity.
      drainSendQueueForTarget(keyOf(target));
      try {
        session.orchestrator.retry();
      } catch (err) {
        if (err instanceof AuthFailedRetryBlocked) {
          // R7/F3: explicit "create a fresh invitation" copy per PRD TOFU.
          // The snapshot's authFailed flag (mirrored from the record + the
          // orchestrator's onError classification) is the UI affordance gate;
          // this message tells the user why retry is disabled.
          session.authFailed = true;
          emit(
            "Authentication previously failed for this conversation. " +
              "Recovering requires creating a fresh invitation — start a new " +
              "conversation to re-handshake.",
          );
          return;
        }
        emitErrorMessage(err);
        return;
      }
      // R3F6 (Phase 8): orchestrator.retry() alone is a dead spinner in
      // bridge mode — connectSignaling no-ops when useInternalSignaling is
      // false, and after the post-handshake grace teardown the bridge has no
      // signaling socket at all. Route the retry through the bridge so a
      // dropped bridge-mode session actually re-establishes its transport:
      // fresh signaling socket (re-join room), fresh peer connection, and a
      // re-initiated offer under the corrected glare rules. Ordered AFTER
      // orchestrator.retry() so a blocked/illegal retry never dials a socket
      // for a session that will not re-handshake.
      try {
        session.bridge.reconnect();
      } catch (err) {
        emitErrorMessage(err);
        return;
      }
      session.connectionState = session.orchestrator.state;
      emit(null);
    },

    leave(id?: ConversationId): void {
      this.leaveConversation(id);
    },

    // --- Group sessions (protocol-v2) ---

    async startGroup(options?: {
      readonly code?: string;
      readonly name?: string;
      readonly displayName?: string;
    }): Promise<{ invitation: string }> {
      assertNotDisposed(disposed);
      // Same normalization as startConversation: trim at the boundary, and a
      // code that is empty after trimming counts as NO code — the group runs
      // SafetyNumberOnly and the invitation carries no `~code` tail. (Before
      // this, `"   "` produced a Pake group with an empty code whose
      // invitation omitted the tail, so joiners could never authenticate.)
      const trimmed = options?.code === undefined ? undefined : options.code.trim();
      const code = trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
      // CSPRNG 16-byte group id — the broker room id (protocol-v2 §1).
      const groupId = encodeGroupId(randomBytes(CONVERSATION_ID_BYTES));
      const invitation = formatGroupInvitation(
        keyOf(groupId),
        deps.publicBaseUrl ?? deps.baseUrl,
        code,
      );
      const group = buildGroupHost({
        groupId,
        isAuthor: true,
        authMode: code === undefined ? AuthMode.SafetyNumberOnly : AuthMode.Pake,
        pakeCode: code,
        memberName: options?.displayName,
        label: options?.name ?? null,
        invitation,
      });
      const key = keyOf(groupId);
      groupSessions.set(key, group);
      activateGroup(group.id);
      syncGroupReadMarker(group);
      await persistGroupRecord(group, options?.name ?? null);
      if (disposed || groupSessions.get(key) !== group) {
        // leaveAll/dispose won the race: the record was evicted and torn down
        // by that path. Mirror startConversation — fail loudly rather than
        // hand back an invitation to a room nobody will join.
        throw new Error("group start aborted before the session was installed");
      }
      group.manager.connect();
      await refreshConversations();
      emit(null);
      return { invitation };
    },

    async joinGroup(fragment: string, options?: { readonly displayName?: string }): Promise<void> {
      assertNotDisposed(disposed);
      // Same normalization as joinConversation: everything before the last
      // `#` is the link prefix; parseInvitation handles the leading `#`, the
      // lowercase fold, and the `~code` tail (same grammar as 1:1).
      const hashIndex = fragment.lastIndexOf("#");
      const bare = hashIndex >= 0 ? fragment.slice(hashIndex + 1) : fragment;
      const parsed = parseInvitation(bare);
      if (parsed.code !== null && deps.enablePake === false) {
        // Mirror the 1:1 join gate (R8/F1): a coded group link must not
        // reach the wasm-gated SPAKE2 path on builds without it.
        throw new OrchestratorError(
          OrchestratorErrorCode.PakeDisabled,
          "coded group invitations (PAKE) are not supported in this build",
        );
      }
      const groupId = encodeGroupId(parsed.conversationId);
      const key = keyOf(groupId);
      const existing = groupSessions.get(key);
      if (existing !== undefined) {
        // Already seated — just select it (mirrors joinConversation's
        // already-live branch).
        activateGroup(existing.id);
        syncGroupReadMarker(existing);
        existing.detached = false;
        emit(null);
        return;
      }
      const inFlight = groupJoining.get(key);
      if (inFlight !== undefined) {
        try {
          await inFlight;
        } catch {
          // The prior join failed; our own attempt below is next-best intent.
        }
        const landed = groupSessions.get(key);
        if (landed !== undefined) {
          activateGroup(landed.id);
          syncGroupReadMarker(landed);
          landed.detached = false;
          emit(null);
          return;
        }
      }
      const attempt = performJoinGroup(groupId, parsed.code, options).finally(() => {
        groupJoining.delete(key);
      });
      groupJoining.set(key, attempt);
      return attempt;
    },

    selectGroup(groupId: GroupId): void {
      assertNotDisposed(disposed);
      const group = groupSessions.get(keyOf(groupId));
      if (group === undefined) {
        throw new GroupError(
          GroupErrorCode.GroupNotFound,
          `cannot select unknown group ${groupId}`,
        );
      }
      activateGroup(group.id);
      syncGroupReadMarker(group);
      group.detached = false;
      emit(null);
    },

    leaveGroup(groupId?: GroupId): void {
      assertNotDisposed(disposed);
      const target = groupId ?? activeGroupId;
      if (target === null) return;
      const k = keyOf(target);
      const group = groupSessions.get(k);
      if (group === undefined) return;
      // Evict BEFORE tearing down: finishGroup's onEnded callback then
      // observes the record as already gone and stays a no-op, leaving this
      // path's single emit the only notification.
      groupSessions.delete(k);
      groupReadMarkers.delete(k);
      if (activeGroupId !== null && keyOf(activeGroupId) === k) {
        activeGroupId = null;
      }
      teardownGroup(group);
      emit(null);
    },

    async removeGroupMember(groupId: GroupId, identityPub: PublicKey): Promise<void> {
      assertNotDisposed(disposed);
      const group = findGroupOrThrow(groupId);
      // kickMember throws GroupError(NotAuthor) for non-authors and
      // GroupError(MembershipInvalid) for self-removal — both propagate to
      // the caller as the typed-error contract.
      await group.session.kickMember(identityPub);
      emit(null);
    },

    async sendGroupText(groupId: GroupId, text: string): Promise<void> {
      assertNotDisposed(disposed);
      const group = findGroupOrThrow(groupId);
      group.detached = false;
      // The group transcript is in-memory only (ChatGroupSession.messages) —
      // no durable conversation row exists for a group. Fan out first, then
      // mirror: a failed send records nothing, keeping the transcript aligned
      // with what was actually delivered.
      const timestamp = Date.now();
      await group.session.sendText(text);
      const message: GroupChatMessage = {
        id: globalThis.crypto.randomUUID(),
        groupId: group.id,
        direction: MessageDirection.Sent,
        senderIdentityPub: null,
        timestamp,
        text,
      };
      group.messages = group.messages.concat(message);
      group.lastMessagePreview = previewOf(text);
      group.lastMessageAt = timestamp;
      onGroupSessionChange(group);
    },

    async sendGroupFile(groupId: GroupId, file: ChatFileInput): Promise<Map<PeerId, number>> {
      assertNotDisposed(disposed);
      const group = findGroupOrThrow(groupId);
      group.detached = false;
      const data = file.data;
      const name = file.name === "" ? "file.bin" : file.name;
      const mimeType = file.mimeType === "" ? "application/octet-stream" : file.mimeType;
      const nameBytes = utf8Length(name);
      if (nameBytes > MAX_MANIFEST_NAME_BYTES) {
        throw new Error(`name length ${nameBytes} exceeds ${MAX_MANIFEST_NAME_BYTES}`);
      }
      const mimeBytes = utf8Length(mimeType);
      if (mimeBytes > MAX_MANIFEST_MIME_BYTES) {
        throw new Error(`mimeType length ${mimeBytes} exceeds ${MAX_MANIFEST_MIME_BYTES}`);
      }
      // Per-link fan-out: each link runs its own v1 transfer, so the map is
      // keyed by the peer's signaling peerId (§6 — no group-wide id space).
      return await group.session.sendFile(data, name, mimeType);
    },

    async getGroupHistory(groupId: GroupId): Promise<ConversationMessage[]> {
      // The group transcript is session-scoped and in-memory only: read it
      // off the live record, flattened to the plain ConversationMessage
      // timeline shape 1:1 history uses (the sender column is dropped —
      // attribution lives on the activeGroup.messages view). Empty for an
      // unknown or ended group.
      const group = groupSessions.get(keyOf(groupId));
      if (group === undefined) return [];
      const conversationId = groupConversationId(group.id);
      return group.messages.map((m) => ({
        id: m.id,
        conversationId,
        direction: m.direction,
        timestamp: m.timestamp,
        text: m.text,
      }));
    },

    getGroupReceivedFile(
      groupId: GroupId,
      senderIdentityPub: PublicKey,
      transferId: number,
    ): ReceivedFile | null {
      const group = groupSessions.get(keyOf(groupId));
      if (group === undefined) return null;
      return group.receivedFiles.get(receivedFileKey(senderIdentityPub, transferId)) ?? null;
    },

    listGroups(): GroupSummary[] {
      return Array.from(groupSessions.values())
        .map((group) => summarizeGroup(group))
        .sort(compareGroupSummaries);
    },

    markGroupSafetyVerified(groupId?: GroupId): void {
      assertNotDisposed(disposed);
      const target = groupId ?? activeGroupId;
      if (target === null) return;
      const group = groupSessions.get(keyOf(target));
      if (group === undefined) return;
      // Same R13F5 discipline as the 1:1 mark: only flag verified when a
      // safety number actually exists to verify.
      if (group.session.groupSafetyNumber !== null) {
        group.safetyNumberVerified = true;
      }
      emit(null);
    },

    getGroupSafetyNumber(groupId: GroupId): string | null {
      const group = groupSessions.get(keyOf(groupId));
      if (group === undefined) return null;
      return group.session.groupSafetyNumber;
    },

    setGroupDisplayName(groupId: GroupId | undefined, name: string): void {
      assertNotDisposed(disposed);
      const target = groupId ?? activeGroupId;
      if (target === null) return;
      const group = groupSessions.get(keyOf(target));
      if (group === undefined) return;
      // GroupSession.updateDisplayName validates the byte cap, re-announces
      // on connected links, and (author) re-signs our member entry.
      group.session.updateDisplayName(name);
      emit(null);
    },

    setGroupDraft(groupId: GroupId, draft: string): void {
      assertNotDisposed(disposed);
      const group = groupSessions.get(keyOf(groupId));
      if (group === undefined) return;
      if (group.draft === draft) return;
      group.draft = draft;
      emit(null);
    },

    __attachGroupLinkForTest(groupId: GroupId, peerId: PeerId, transport: PeerTransport): void {
      const group = groupSessions.get(keyOf(groupId));
      if (group === undefined) return;
      group.session.attachLinkTransport(peerId, transport);
    },

    lock(): void {
      // Drop the in-memory key and flip the manager's locked flag. The
      // LockableRepository wrapper observes isLocked() on the next seal/unseal
      // and throws AtRestLockedError, which is the actual revocation.
      deps.atRestKeyManager.lock();
      emit(null);
    },

    async unlock(passphrase: string): Promise<boolean> {
      const ok = await deps.atRestKeyManager.unlock(passphrase);
      emit(null);
      return ok;
    },

    isLocked(): boolean {
      return deps.atRestKeyManager.isLocked();
    },

    async clearConversation(id?: ConversationId): Promise<void> {
      const target = id ?? activeConversationId;
      if (target === null) return;
      const targetKey = keyOf(target);
      await repository.clearConversation(target);
      // R6/F4: reconcile the durable auth-failed record with the cleared
      // conversation — without this the flag would outlive its record and
      // resurface on the next session start for an id that no longer exists.
      await clearAuthFailedDurable(target);
      const session = sessions.get(targetKey);
      if (session !== undefined) {
        // (5.2.1) Drain the session's send queue FIRST, before any transfer
        // cancellation. Ordering matters: cancelling an in-flight transfer
        // fires onTransferCancelled -> onSessionChange -> drainSendQueue, and
        // if the queue still holds an entry at that moment, drainSendQueue
        // will shift and start it (allocating a fresh orchestrator id that
        // the cancellation loop below — iterating a stale snapshot of
        // session.transfers — will never reach), leaving the queued promise
        // hanging. Draining first empties the queue so the subsequent
        // cancel-driven drains are no-ops. Rejects each queued send with
        // "conversation cleared" and zeroes its pre-read byte buffer.
        drainSendQueueForTarget(targetKey);
        // (5.2.2) Cancel every non-terminal transfer through the orchestrator
        // (and the bridge if it grows a cancelSend seam). Queued sends were
        // already dropped above, so we only cancel orchestrator-tracked ids.
        for (const transfer of session.transfers) {
          if (
            transfer.status === "queued" ||
            transfer.status === "sending" ||
            transfer.status === "receiving"
          ) {
            try {
              session.orchestrator.cancelTransfer(
                transfer.id,
                transfer.direction === "received" ? "receive" : "send",
              );
            } catch {
              // best-effort: the orchestrator may have already torn the
              // transfer down (e.g. peer disconnect). The snapshot wipe below
              // is authoritative regardless.
            }
            // Forward-compatible hook: if the WebRtcBridge ever exposes a
            // cancelSend seam, invoke it. Optional-chained through a typed
            // alias so absent methods do not throw or fail typecheck.
            const bridge = session.bridge as BridgeWithOptionalCancelSend;
            bridge.cancelSend?.(transfer.id);
          }
        }
        // (5.2.3) Drop the transfer snapshot.
        session.transfers = [];
        // (5.2.4) Zero received-file byte buffers before clearing the map
        // (PRD: files are transient; clearConversation releases them).
        for (const file of session.receivedFiles.values()) {
          file.data.fill(0);
        }
        session.receivedFiles.clear();
        // (5.2.5) Detach inbound handlers so a late frame does not repopulate
        // the snapshot. Re-armed on the next send/resume/select.
        session.detached = true;
        session.messages = [];
        session.lastMessagePreview = null;
        session.lastMessageAt = null;
        // R9/F5 (Phase 8.5): reset the separate "last received" cursor so the
        // read marker does not survive a clear and accidentally suppress
        // unread counting for messages that arrive after the clear.
        session.lastReceivedAt = null;
        recomputeUnread(session);
      }
      await refreshConversations();
      emit(null);
    },

    getActiveConversationId(): ConversationId | null {
      return activeConversationId;
    },

    async listConversations(): Promise<ConversationRecord[]> {
      // Same group-scoped exclusion as runRefresh: the public list must not
      // surface group-scoped or derived pairwise link records (legacy or
      // imported rows — this build persists none).
      const [rows, excluded] = await Promise.all([
        repository.listConversations(),
        groupScopedConversationKeys(),
      ]);
      return rows.filter((r) => !excluded.has(keyOf(r.id)));
    },

    async clearAll(): Promise<void> {
      await repository.clearAll();
      // R6/F4: the durable auth-failed record must not outlive the
      // conversations it describes.
      await clearAllAuthFailedDurable();
      // CR-9: bring clearAll to parity with clearConversation. Previously
      // clearAll only wiped store + previews and left receivedFiles, transfers,
      // and sendQueues untouched, AND did not set `detached` — so a late
      // inbound frame after clearAll would re-populate the snapshot. Mirror
      // clearConversation's per-session cleanup for EVERY live session, in the
      // same order (sendQueues → transfers → receivedFiles → detached LAST).
      // See clearConversation for why the queue drain runs before transfer
      // cancellation (prevents a cancel-driven drainSendQueue from re-starting
      // a queued send with an id the cancellation loop will never reach).
      for (const session of sessions.values()) {
        const targetKey = keyOf(session.id);
        // Mirror (5.2.1): drain the send queue first.
        drainSendQueueForTarget(targetKey);
        // Mirror (5.2.2): cancel every non-terminal transfer.
        for (const transfer of session.transfers) {
          if (
            transfer.status === "queued" ||
            transfer.status === "sending" ||
            transfer.status === "receiving"
          ) {
            try {
              session.orchestrator.cancelTransfer(
                transfer.id,
                transfer.direction === "received" ? "receive" : "send",
              );
            } catch {
              // best-effort: the orchestrator may have already torn the
              // transfer down. The snapshot wipe below is authoritative.
            }
            const bridge = session.bridge as BridgeWithOptionalCancelSend;
            bridge.cancelSend?.(transfer.id);
          }
        }
        // Mirror (5.2.3): drop the transfer snapshot.
        session.transfers = [];
        // Mirror (5.2.4): zero received-file byte buffers before clearing.
        for (const file of session.receivedFiles.values()) {
          file.data.fill(0);
        }
        session.receivedFiles.clear();
        // Mirror (5.2.5): detach inbound handlers so a late frame does NOT
        // repopulate the snapshot. THIS is the load-bearing CR-9 fix for the
        // late-frame re-population bug — set detached LAST, after every other
        // field is wiped, exactly like clearConversation.
        session.detached = true;
        session.messages = [];
        session.lastMessagePreview = null;
        session.lastMessageAt = null;
        // R9/F5 (Phase 8.5): keep the read-marker and unread cursors in sync
        // with the wiped snapshot.
        session.lastReceivedAt = null;
        session.unread = 0;
      }
      // Same per-session wipe for live group sessions: clearAll already
      // deleted the stored group records (the group's transcript and its
      // pairwise links persist nothing — they are in-memory), so mirror the
      // live snapshot (transcript, received-file bytes, detached gate) —
      // the session itself stays seated.
      for (const group of groupSessions.values()) {
        for (const file of group.receivedFiles.values()) {
          file.data.fill(0);
        }
        group.receivedFiles.clear();
        group.detached = true;
        group.messages = [];
        group.lastMessagePreview = null;
        group.lastMessageAt = null;
        group.lastReceivedAt = null;
        group.unread = 0;
        groupReadMarkers.delete(keyOf(group.id));
      }
      await refreshConversations();
      emit(null);
    },

    async exportBundle(passphrase: string): Promise<string> {
      const identity = deps.identityManager.get();
      return await exportBundle(passphrase, repository, identity.privateKey);
    },

    async importBundle(
      passphrase: string,
      bundle: string,
      mode: ImportMode,
    ): Promise<ImportResult> {
      const result = await importBundle(passphrase, bundle, repository, mode);
      // SEC-3: the bundle carries the exporter's device-identity private scalar
      // (base64 in the payload). When present, adopt it as the active identity
      // BEFORE refreshConversations() so any downstream read of the identity
      // (e.g. a session resume) sees the imported pair. ImportResult.deviceIdentity
      // is the raw privateKey Uint8Array (or null when the exporter held no
      // identity); see export-bundle.ts decodeIdentity + store/types.ts
      // ImportResult. Adoption does NOT rotate the at-rest key.
      if (result.deviceIdentity !== null) {
        await deps.identityManager.adoptImportedIdentity(result.deviceIdentity);
      }
      await refreshConversations();
      return result;
    },

    subscribe(listener: (state: ChatControllerState) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    getState(): ChatControllerState {
      return buildState(null);
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      // R3F1 (Phase 3): `disposed` is the terminal lifecycle epoch for EVERY
      // in-flight startSession. Each re-checks it after every await and tears
      // its half-built orchestrator/bridge down without registering or
      // dialing (until bridge.start() — startSession's last statement — an
      // attempt holds no socket), so iterating sessions.values() below plus
      // those re-checks covers both registered AND in-flight sessions.
      for (const session of sessions.values()) {
        teardownSession(session, holders.get(keyOf(session.id)) ?? null);
      }
      // CR-8: drain every queued send BEFORE sessions.clear() so each queued
      // promise rejects with "conversation cleared" and its byte buffer is
      // zeroed. Collect keys first to avoid mutating sendQueues mid-iteration.
      for (const k of Array.from(sendQueues.keys())) {
        drainSendQueueForTarget(k);
      }
      sessions.clear();
      holders.clear();
      readMarkers.clear();
      activeConversationId = null;
      // Groups too: teardownGroup is idempotent and pairs session.leave()
      // with manager.leave() (the obs-F pairing) — live broker seats and
      // peer connections must not survive disposal.
      for (const group of Array.from(groupSessions.values())) {
        teardownGroup(group);
      }
      groupSessions.clear();
      groupReadMarkers.clear();
      activeGroupId = null;
      listeners.clear();
      // R5:F3 / R6:F1: release any backing DB handles (the web provider's
      // OPFS-backed repo holds a wa-sqlite DB + dedicated Worker open for the
      // app's lifetime; without this the handles leaked on every dispose,
      // including the cancelled-init race in the provider). dispose() stays
      // synchronous to honor the ChatController contract, so this is
      // fire-and-forget: close() drains outstanding persistence, logs and
      // RETHROWS on failure — the swallow lives HERE, at the call site's
      // .catch. In-memory and test repos have no close() (optional on the
      // interface).
      void Promise.resolve(rawRepository.close?.()).catch(() => {});
    },

    async __receiveMessageForTest(id: ConversationId, text: string): Promise<void> {
      const session = sessions.get(keyOf(id));
      if (session === undefined) return;
      // Honor the detach gate so this seam faithfully simulates a real
      // orchestrator onMessage (which is gated in chat-session.ts). A late
      // frame arriving after clearConversation must not repopulate the
      // snapshot.
      if (session.detached) return;
      // Build a synthetic received message and persist it through the repo so
      // the snapshot reflects what a real orchestrator onMessage would have
      // produced. We do NOT drive the orchestrator's crypto path here.
      const { MessageDirection } = await import("../store");
      const timestamp = Date.now();
      const message = await repository.appendMessage(
        id,
        text,
        MessageDirection.Received,
        timestamp,
      );
      session.messages = session.messages.concat(message);
      session.lastMessagePreview = message.text;
      session.lastMessageAt = message.timestamp;
      // R9/F5 (Phase 8.5): mirror the separate "last received" cursor like the
      // real onMessage handler in chat-session.ts does, so the test seam
      // faithfully reproduces the read-marker advancement a live receive
      // would trigger.
      session.lastReceivedAt = message.timestamp;
      onSessionChange(session);
    },

    async __sendMessageForTest(id: ConversationId, text: string): Promise<void> {
      const session = sessions.get(keyOf(id));
      if (session === undefined) return;
      // Honor the detach gate so this seam faithfully simulates a real
      // controller.sendText (which re-arms detached on entry). A late send
      // arriving after clearConversation must not repopulate the snapshot.
      if (session.detached) return;
      // Persist via the repo and mirror into the snapshot — exactly what the
      // real sendText path does. The critical difference from
      // __receiveMessageForTest: we do NOT bump `lastReceivedAt`, because sent
      // messages must not advance the read marker (R9/F5 / Phase 8.5).
      const { MessageDirection } = await import("../store");
      const timestamp = Date.now();
      const message = await repository.appendMessage(id, text, MessageDirection.Sent, timestamp);
      session.messages = session.messages.concat(message);
      session.lastMessagePreview = message.text;
      session.lastMessageAt = message.timestamp;
      // Intentionally NOT touching session.lastReceivedAt: a sent message must
      // not push the read-marker cursor forward.
      onSessionChange(session);
    },

    __attachTransportForTest(id: ConversationId, transport: PeerTransport): void {
      const session = sessions.get(keyOf(id));
      if (session === undefined) return;
      // Notify presence + attach: mirrors what the WebRTC bridge does once
      // the data channel opens. Driving this from a test lets two controllers
      // run the real crypto handshake over a loopback transport pair.
      session.orchestrator.notifyPeerJoined();
      session.orchestrator.attachTransport(transport);
    },
  };

  function emitErrorMessage(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    emit(message);
  }
}

/**
 * Dispatch helper for the {@link ChatController.sendText} /
 * {@link ChatController.setDisplayName} overloads: a `ConversationId` first
 * argument means the two-arg form (`id, value`); a `string` first argument
 * means the one-arg form targeting the active session.
 */
function resolveSessionArgPair(
  idOrValue: ConversationId | string,
  maybeValue: string | undefined,
  activeId: ConversationId | null,
): { id: ConversationId; value: string } {
  if (typeof idOrValue === "string") {
    if (activeId === null) {
      throw new Error("cannot target active session: none is active");
    }
    return { id: activeId, value: idOrValue };
  }
  if (maybeValue === undefined) {
    throw new Error("value argument is required when targeting a session by id");
  }
  return { id: idOrValue, value: maybeValue };
}

function assertNotDisposed(disposed: boolean): void {
  if (disposed) {
    throw new Error("controller is disposed");
  }
}

/** Stable ordering for session summaries: most-recently-active first. */
function compareSummaries(a: SessionSummary, b: SessionSummary): number {
  const aAt = a.lastMessageAt ?? 0;
  const bAt = b.lastMessageAt ?? 0;
  if (aAt !== bAt) return bAt - aAt;
  // Fall back to id comparison for determinism when timestamps tie.
  return compareConversationId(a.id, b.id);
}

/** Stable ordering for group summaries: most-recently-active first. */
function compareGroupSummaries(a: GroupSummary, b: GroupSummary): number {
  const aAt = a.lastMessageAt ?? 0;
  const bAt = b.lastMessageAt ?? 0;
  if (aAt !== bAt) return bAt - aAt;
  return compareConversationId(a.groupId, b.groupId);
}

function compareConversationId(a: Uint8Array, b: Uint8Array): number {
  const la = a.length;
  const lb = b.length;
  const limit = Math.min(la, lb);
  for (let i = 0; i < limit; i++) {
    const da = a[i];
    const db = b[i];
    if (da !== db) return da - db;
  }
  return la - lb;
}

/**
 * R3F1 (Phase 3): a resume target's lifecycle epoch, captured before the
 * resume's first await (the conversation id is known upfront on that path,
 * unlike fresh starts/joins which learn it only after the orchestrator entry
 * point resolves). See `conversationEpochs` in {@link createChatController}.
 */
interface ConversationLifecycle {
  readonly key: string;
  readonly epoch: number;
}

/**
 * R9/F3 (Phase 8.5): canonical Map key for a ConversationId. The branded
 * Uint8Array reference is unsuitable as a Map key (two value-equal ids from
 * different producers miss each other under SameValueZero); the lowercase hex
 * string is stable across producers and matches the store's `idKey` convention.
 */
function keyOf(id: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < id.length; i++) {
    hex += id[i].toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * R7F3 (Phase 5.2): extract the session-map key for an invitation fragment
 * WITHOUT constructing an orchestrator. Mirrors the normalization inside
 * `ConversationOrchestrator.join()`: everything before the last `#` is the
 * initiator's URL prefix, and parseInvitation strips the optional leading
 * `#`, lowercases the hex (LW-8: uppercase pastes still parse), and extracts
 * the `~<code>` PAKE tail — so the key deduped on is exactly the
 * conversation id join() will bind. Malformed fragments throw the same
 * OrchestratorError(MalformedInvitation) join() would surface.
 */
function conversationKeyFromFragment(fragment: string): string {
  const hashIndex = fragment.lastIndexOf("#");
  const bare = hashIndex >= 0 ? fragment.slice(hashIndex + 1) : fragment;
  return keyOf(parseInvitation(bare).conversationId);
}

/** UTF-8 byte length of a string (mirrors how the manifest encoder measures). */
function utf8Length(value: string): number {
  return TEXT_ENCODER.encode(value).length;
}

const TEXT_ENCODER = new TextEncoder();

/**
 * Generate a fresh 6-digit PAKE code using the same CSPRNG the rest of the
 * crypto layer uses (randomBytes -> crypto.getRandomValues). Math.random is
 * explicitly forbidden for security-relevant values.
 *
 * 6 digits -> [000000, 999999]. We sample 4 bytes (32 bits) and reduce mod
 * 1e6; the bias is under 1e-3 of a digit and well below the 20-bit entropy
 * ceiling the PRD calls out for the 6-digit code (PRD ~:262).
 *
 * Exported so the unit suite can assert format + spread properties directly
 * against the helper (the controller's public `generatePakeCode` method is a
 * one-line passthrough to this function).
 */
export function generatePakeCode(): string {
  const bytes = randomBytes(4);
  // Compose a uint32 in unsigned-arithmetic-safe order. Each byte is at most
  // 0xff; multiplying and adding in this order keeps the running total under
  // 2^32 (no sign-bit / int32 wrap surprise).
  const n = bytes[0]! * 0x1000000 + bytes[1]! * 0x10000 + bytes[2]! * 0x100 + bytes[3]!;
  return (n % 1_000_000).toString().padStart(6, "0");
}

/**
 * True if the orchestrator rejected because the concurrent-transfer cap was
 * reached. The controller catches this to queue the send rather than surface
 * the error to the caller.
 */
function isConcurrentCapError(err: unknown): boolean {
  if (err instanceof Error) {
    return /concurrent transfer limit/i.test(err.message);
  }
  return false;
}

/**
 * Forward-compatible alias for the WebRtcBridge's optional cancel-seam. The
 * current bridge has no `cancelSend` method (cancellation is owned by the
 * orchestrator's sender/receiver pair); declaring it here lets clearConversation
 * optional-chain through the bridge without a cast at the call site, and keeps
 * the call site correct if the bridge grows a cancelSend later.
 */
type BridgeWithOptionalCancelSend = {
  cancelSend?(transferId: number): void;
};
