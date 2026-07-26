import { Role } from "@/features/chat/protocol/types";
import type { ConversationId } from "@/features/chat/protocol/types";
import { ConnectionState } from "@/features/chat/signaling/state-machine";
import type { SignalingSocketFactory } from "@/features/chat/signaling/signaling-client";
import { exportBundle, importBundle, ImportMode } from "@/features/chat/store";
import type {
  ConversationMessage,
  ConversationRecord,
  ConversationRepository,
  ImportResult,
} from "@/features/chat/store";

import type { AtRestKeyManager } from "./at-rest-key-manager";
import type { AtRestKey } from "@/features/chat/crypto";
import {
  buildOrchestrator,
  seedSessionFromHistory,
  teardownSession,
  wireBridge,
  type SessionChangeCallback,
  type SessionHolder,
} from "./chat-session";
import type { IdentityManager } from "./identity-manager";
import type {
  ActiveSessionState,
  ChatSession,
  SessionSummary,
} from "./types";
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
  /** Owns the device identity. */
  readonly identityManager: IdentityManager;
  /** Owns the at-rest key used to seal history. */
  readonly atRestKeyManager: AtRestKeyManager;
  /** Factory for the conversation repository, invoked once with the at-rest key. */
  readonly repositoryFactory: (atRestKey: AtRestKey) => ConversationRepository;
  /** Factory for the underlying signaling WebSocket (testability). */
  readonly socketFactory: SignalingSocketFactory;
  /** ICE servers for WebRTC. Empty array = loopback-only. */
  readonly iceServers?: RTCIceServer[];
}

export interface ChatController {
  // --- Multi-session surface ---
  startConversation(): Promise<{ invitation: string }>;
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
  const repository = deps.repositoryFactory(atRestKey);
  const listeners = new Set<(state: ChatControllerState) => void>();
  const sessions = new Map<ConversationId, ChatSession>();
  // Holders link each orchestrator's construction-time handlers to its session.
  const holders = new Map<ConversationId, SessionHolder>();
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
    const active = activeConversationId !== null ? sessions.get(activeConversationId) ?? null : null;
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

  async function refreshConversations(): Promise<void> {
    conversationsCache = (await repository.listConversations()).slice();
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
   */
  const onSessionChange: SessionChangeCallback = (session): void => {
    if (activeConversationId !== session.id) {
      // Non-active session receiving a message: increment unread. The message
      // itself is already mirrored into `session.messages` by the handler; the
      // unread bump reflects "things the user hasn't looked at yet."
      // We bump unread only for received-direction messages; the handler does
      // not distinguish, so we conservatively bump on every change after the
      // first message arrives. To stay correct, we only bump when the session
      // has a brand-new last-message timestamp that advanced.
      // (Simulated/test receives set lastMessageAt; the controller's test seam
      // drives this path explicitly.)
      const last = session.lastMessageAt;
      if (last !== null) {
        // Count messages whose timestamp is >= the session's "read up to"
        // marker. The marker is updated whenever the session is selected.
        const readUpTo = readMarkers.get(session.id) ?? -Infinity;
        let unread = 0;
        for (const m of session.messages) {
          if (m.timestamp > readUpTo && m.direction === "received") {
            unread++;
          }
        }
        session.unread = unread;
      }
    } else {
      // Active session: no unread, advance the read marker to the latest.
      if (session.lastMessageAt !== null) {
        readMarkers.set(session.id, session.lastMessageAt);
      }
      session.unread = 0;
    }
    emit(null);
  };

  // Read markers track "the user has seen up to this timestamp" per session.
  const readMarkers = new Map<ConversationId, number>();

  function syncActiveReadMarker(session: ChatSession): void {
    const latest = session.lastMessageAt ?? -Infinity;
    readMarkers.set(session.id, latest);
    recomputeUnread(session);
  }

  function recomputeUnread(session: ChatSession): void {
    const readUpTo = readMarkers.get(session.id) ?? -Infinity;
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
    orchestrator: import("@/features/chat/orchestrator/orchestrator").ConversationOrchestrator;
    holder: SessionHolder;
  } {
    const holder: SessionHolder = { session: null };
    const orchestrator = buildOrchestrator(
      {
        brokerUrl: deps.brokerUrl,
        baseUrl: deps.baseUrl,
        repository,
        socketFactory: deps.socketFactory,
        identity: deps.identityManager.get(),
        iceServers: deps.iceServers,
      },
      holder,
      onSessionChange,
    );
    return { orchestrator, holder };
  }

  function bridgePresenceCallbacks(
    orchestrator: import("@/features/chat/orchestrator/orchestrator").ConversationOrchestrator,
  ): {
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
    sessions.set(session.id, session);
    activeConversationId = session.id;
    syncActiveReadMarker(session);
  }

  async function startSession(
    role: Role,
    fragment?: string,
  ): Promise<{ session: ChatSession; invitation: string | null }> {
    const { orchestrator, holder } = buildSessionOrchestrator();
    let conversationId: ConversationId;
    let invitation: string | null = null;
    if (role === Role.Initiator && fragment === undefined) {
      invitation = await orchestrator.start();
      conversationId = orchestrator.conversationId as ConversationId;
    } else {
      // Responder or resume-via-join: the orchestrator parses the fragment.
      await orchestrator.join(fragment as string);
      conversationId = orchestrator.conversationId as ConversationId;
    }
    holders.set(conversationId, holder);
    const presence = bridgePresenceCallbacks(orchestrator);
    const session = wireBridge({
      orchestrator,
      holder,
      conversationId,
      role,
      brokerUrl: deps.brokerUrl,
      socketFactory: deps.socketFactory,
      iceServers: deps.iceServers,
      ...presence,
    });
    session.invitation = invitation;
    session.bridge.start();
    registerSession(session);
    return { session, invitation };
  }

  function findSessionOrThrow(id: ConversationId): ChatSession {
    const session = sessions.get(id);
    if (session === undefined) {
      throw new Error(`no live session for conversation ${id}`);
    }
    return session;
  }

  return {
    async startConversation(): Promise<{ invitation: string }> {
      assertNotDisposed(disposed);
      const result = await startSession(Role.Initiator);
      // Initiator always produces an invitation link; the orchestrator's
      // `start()` returns it before we wire the bridge.
      const invitation = result.invitation as string;
      await refreshConversations();
      emit(null);
      return { invitation };
    },

    async joinConversation(fragment: string): Promise<void> {
      assertNotDisposed(disposed);
      await startSession(Role.Responder, fragment);
      await refreshConversations();
      emit(null);
    },

    async resumeConversation(conversationId: ConversationId): Promise<void> {
      assertNotDisposed(disposed);
      if (sessions.has(conversationId)) {
        // Already live; just select it.
        activeConversationId = conversationId;
        syncActiveReadMarker(sessions.get(conversationId) as ChatSession);
        emit(null);
        return;
      }
      const record = await repository.getConversation(conversationId);
      if (record === null) {
        throw new Error(`cannot resume unknown conversation ${conversationId}`);
      }
      // Re-enter the conversation by joining with the existing conversation id
      // (idempotent at the repository level for the in-memory store).
      const fragment = `#${hexFromId(conversationId)}`;
      const { session } = await startSession(Role.Initiator, fragment);
      const history = await session.orchestrator.getHistory();
      seedSessionFromHistory(session, record, history);
      recomputeUnread(session);
      await refreshConversations();
      emit(null);
    },

    selectConversation(conversationId: ConversationId): void {
      assertNotDisposed(disposed);
      const session = sessions.get(conversationId);
      if (session === undefined) {
        throw new Error(`cannot select unknown conversation ${conversationId}`);
      }
      // Cheap swap: no re-handshake. Clear unread + advance the read marker.
      activeConversationId = conversationId;
      syncActiveReadMarker(session);
      emit(null);
    },

    leaveConversation(conversationId?: ConversationId): void {
      assertNotDisposed(disposed);
      // No-arg form leaves the active session (legacy UI contract).
      const target = conversationId ?? activeConversationId;
      if (target === null) return;
      const session = sessions.get(target);
      if (session === undefined) return;
      teardownSession(session);
      sessions.delete(target);
      holders.delete(target);
      readMarkers.delete(target);
      if (activeConversationId === target) {
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

    async getHistory(id?: ConversationId): Promise<ConversationMessage[]> {
      const target = id ?? activeConversationId;
      if (target === null) return [];
      const session = sessions.get(target);
      if (session === undefined) return [];
      return await session.orchestrator.getHistory();
    },

    markSafetyNumberVerified(id?: ConversationId): void {
      assertNotDisposed(disposed);
      const target = id ?? activeConversationId;
      if (target === null) return;
      const session = sessions.get(target);
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
      const session = sessions.get(target);
      if (session === undefined) return;
      try {
        session.orchestrator.retry();
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

    async clearConversation(id?: ConversationId): Promise<void> {
      const target = id ?? activeConversationId;
      if (target === null) return;
      await repository.clearConversation(target);
      const session = sessions.get(target);
      if (session !== undefined) {
        session.messages = [];
        session.lastMessagePreview = null;
        session.lastMessageAt = null;
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
      for (const session of sessions.values()) {
        session.messages = [];
        session.lastMessagePreview = null;
        session.lastMessageAt = null;
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
      sessions.clear();
      holders.clear();
      readMarkers.clear();
      activeConversationId = null;
      listeners.clear();
    },

    async __receiveMessageForTest(id: ConversationId, text: string): Promise<void> {
      const session = sessions.get(id);
      if (session === undefined) return;
      // Build a synthetic received message and persist it through the repo so
      // the snapshot reflects what a real orchestrator onMessage would have
      // produced. We do NOT drive the orchestrator's crypto path here.
      const { MessageDirection } = await import("@/features/chat/store");
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
      onSessionChange(session);
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

function hexFromId(id: ConversationId): string {
  let hex = "";
  for (let i = 0; i < id.length; i++) {
    hex += id[i].toString(16).padStart(2, "0");
  }
  return hex;
}
