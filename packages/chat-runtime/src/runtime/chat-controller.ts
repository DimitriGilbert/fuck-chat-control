import { Role } from "../protocol/types";
import type { ConversationId } from "../protocol/types";
import {
  MAX_CONCURRENT_TRANSFERS,
  MAX_MANIFEST_MIME_BYTES,
  MAX_MANIFEST_NAME_BYTES,
} from "../protocol/limits";
import { randomBytes } from "../crypto/primitives";
import { ConnectionState } from "../signaling/state-machine";
import type { SignalingSocketFactory } from "../signaling/signaling-client";
import { exportBundle, importBundle, ImportMode } from "../store";
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
import type { IceServer, PeerConnectionFactory } from "../transport/types";

import type { AtRestKeyManager } from "./at-rest-key-manager";
import type { AtRestKey } from "../crypto";
import {
  buildOrchestrator,
  seedSessionFromHistory,
  teardownSession,
  wireBridge,
  type SessionChangeCallback,
  type SessionHolder,
} from "./chat-session";
import type { IdentityManager } from "./identity-manager";
import type { ActiveSessionState, ChatFileInput, ChatSession, SessionSummary } from "./types";
import { activeSessionView, summarizeSession } from "./types";

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
  /** Active session id, or null when the controller is in the empty state. */
  readonly activeConversationId: ConversationId | null;
  /** Sidebar summaries; one entry per live session. */
  readonly sessions: readonly SessionSummary[];
  /** Full snapshot of the active session, or null when empty. */
  readonly active: ActiveSessionState | null;
  /** Persisted conversation records (resume list). */
  readonly conversations: readonly ConversationRecord[];
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
  /** Retry the active session's handshake/signaling. */
  retry(id?: ConversationId): void;
  /** Clear persisted messages. No-arg targets the active session. */
  clearConversation(id?: ConversationId): Promise<void>;
  /** Alias for {@link ChatController.leaveConversation} with no id (active). */
  leave(id?: ConversationId): void;

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
  // R5/F4: in-flight resumeConversation attempts keyed by hex id, so a
  // concurrent resume of the same conversation dedupes onto one startSession.
  const resuming = new Map<string, Promise<void>>();
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
    for (const listener of listeners) {
      listener(state);
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
    return {
      activeConversationId,
      sessions: summaries,
      active: activeView,
      conversations: conversationsCache,
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
    const rows = await repository.listConversations();
    // The await can straddle disposal (e.g. a boot-time hydrate resolving after
    // the provider unmounted and called dispose()). Bail before mutating state
    // or emitting into a torn-down controller.
    if (disposed) return;
    conversationsCache = rows.slice();
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
    if (activeConversationId !== session.id) {
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

  function registerSession(session: ChatSession): void {
    sessions.set(keyOf(session.id), session);
    activeConversationId = session.id;
    syncActiveReadMarker(session);
  }

  async function startSession(
    role: Role,
    fragment?: string,
    seed?: (session: ChatSession) => Promise<void>,
    pakeCode?: string,
  ): Promise<{ session: ChatSession; invitation: string | null }> {
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
    holders.set(keyOf(conversationId), holder);
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
      await seed(session);
    }
    session.bridge.start();
    return { session, invitation };
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
   * The single-flight body of resumeConversation (R5/F4): only ever runs once
   * per conversation at a time; concurrent callers await the stored promise.
   */
  async function performResume(conversationId: ConversationId, resumeKey: string): Promise<void> {
    const record = await repository.getConversation(conversationId);
    if (record === null) {
      throw new Error(`cannot resume unknown conversation ${conversationId}`);
    }
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
    const { session } = await startSession(Role.Initiator, fragment, async (s) => {
      const history = await s.orchestrator.getHistory();
      seedSessionFromHistory(s, record, history);
      recomputeUnread(s);
    });
    void session;
    await refreshConversations();
    emit(null);
  }

  return {
    async startConversation(options?: { readonly code?: string }): Promise<{ invitation: string }> {
      assertNotDisposed(disposed);
      const code = options?.code;
      const trimmedCode = code === undefined ? undefined : code.trim();
      const result = await startSession(Role.Initiator, undefined, undefined, trimmedCode);
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
      await startSession(Role.Responder, fragment);
      await refreshConversations();
      emit(null);
    },

    async resumeConversation(conversationId: ConversationId): Promise<void> {
      assertNotDisposed(disposed);
      const resumeKey = keyOf(conversationId);
      if (sessions.has(resumeKey)) {
        // Already live; just select it.
        activeConversationId = conversationId;
        const existing = sessions.get(resumeKey) as ChatSession;
        syncActiveReadMarker(existing);
        // Re-arm inbound handlers on resume.
        existing.detached = false;
        emit(null);
        return;
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
        return inFlight;
      }
      const attempt = performResume(conversationId, resumeKey).finally(() => {
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
      activeConversationId = conversationId;
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
      const session = sessions.get(k);
      if (session === undefined) return;
      teardownSession(session);
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
        teardownSession(session);
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
      // Otherwise delegate to the orchestrator (sender + receiver).
      session.orchestrator.cancelTransfer(transferId);
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
      session.safetyNumberVerified = true;
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
      session.connectionState = session.orchestrator.state;
      emit(null);
    },

    leave(id?: ConversationId): void {
      this.leaveConversation(id);
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
              session.orchestrator.cancelTransfer(transfer.id);
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
      return await repository.listConversations();
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
              session.orchestrator.cancelTransfer(transfer.id);
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
      for (const session of sessions.values()) {
        teardownSession(session);
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
      listeners.clear();
      // R5:F3 / R6:F1: release any backing DB handles (the web provider's
      // OPFS-backed repo holds a wa-sqlite DB + dedicated Worker open for the
      // app's lifetime; without this the handles leaked on every dispose,
      // including the cancelled-init race in the provider). dispose() stays
      // synchronous to honor the ChatController contract, so this is
      // fire-and-forget: close() is itself idempotent and swallow-errors.
      // In-memory and test repos have no close() (optional on the interface).
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

function compareConversationId(a: ConversationId, b: ConversationId): number {
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
 * R9/F3 (Phase 8.5): canonical Map key for a ConversationId. The branded
 * Uint8Array reference is unsuitable as a Map key (two value-equal ids from
 * different producers miss each other under SameValueZero); the lowercase hex
 * string is stable across producers and matches the store's `idKey` convention.
 */
function keyOf(id: ConversationId): string {
  let hex = "";
  for (let i = 0; i < id.length; i++) {
    hex += id[i].toString(16).padStart(2, "0");
  }
  return hex;
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
