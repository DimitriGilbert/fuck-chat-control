import { AuthMode, Role } from "../protocol/types";
import type { ConversationId } from "../protocol/types";
import { ConversationOrchestrator } from "../orchestrator/orchestrator";
import type { OrchestratorHandlers, TransferSummary } from "../orchestrator/orchestrator";
import type { PeerTransport } from "../transport/peer-transport";
import { OrchestratorError, OrchestratorErrorCode } from "../orchestrator/errors";
import { PakeError } from "../crypto";
import { ConnectionState } from "../signaling/state-machine";
import type { SignalingSocketFactory } from "../signaling/signaling-client";
import type { ConversationMessage, ConversationRecord, ConversationRepository } from "../store";
import type { IdentityKeyPair } from "../crypto";
import type { ReceivedFile } from "../framing";
import type { IceServer, PeerConnectionFactory } from "../transport/types";

import type { ChatSession } from "./types";
import { applyTransferEvent, type TransferEvent } from "./transfer-state";
import { WebRtcBridge } from "./webrtc-bridge";

/**
 * R7/F3: classify a handshake error as a durable auth failure. Mirrors the
 * orchestrator's own classifier so the snapshot flag and the repo flag stay in
 * sync. An IdentityChanged error or any PakeError marks the session.
 */
function isAuthFailureError(err: unknown): boolean {
  if (err instanceof OrchestratorError && err.code === OrchestratorErrorCode.IdentityChanged) {
    return true;
  }
  if (err instanceof PakeError) {
    return true;
  }
  return false;
}

/**
 * Inputs needed to build a session. The controller owns the singletons
 * (identity, repository, broker/base URLs, socket factory, ICE servers) and
 * passes them in; the builder wires them to the per-session orchestrator +
 * bridge.
 */
export interface BuildSessionInput {
  readonly brokerUrl: string;
  readonly baseUrl: string;
  /**
   * Public base URL used as the PREFIX of every generated invitation link.
   * MEDIUM-E: distinct from {@link baseUrl} (which is used for asset fetches)
   * because the desktop shell's asset origin (`tauri://localhost`) is unusable
   * as an invitation prefix. Defaults to {@link baseUrl} when unset, so
   * non-desktop callers see no behavior change.
   */
  readonly publicBaseUrl: string;
  readonly repository: ConversationRepository;
  readonly socketFactory: SignalingSocketFactory;
  readonly identity: IdentityKeyPair;
  /** Platform peer-connection factory (web adapter or native adapter). */
  readonly peerConnectionFactory: PeerConnectionFactory;
  readonly iceServers?: readonly IceServer[];
  /**
   * R8/F1 (Phase 6): PAKE feature gate, threaded unchanged to
   * {@link OrchestratorDeps.enablePake}. When `false`, the orchestrator rejects
   * `~code` invitations at the join parse boundary (PakeDisabled) so v1 mobile —
   * whose SPAKE2 wasm is Metro-blocked — does not crash at loadWasm. Defaults to
   * `true` (undefined is treated as true in the orchestrator) so web/desktop are
   * unchanged.
   */
  readonly enablePake?: boolean;
}

/**
 * Callback the session invokes whenever its snapshot mutates. The controller
 * subscribes to this and re-derives its {@link ChatControllerState}.
 */
export type SessionChangeCallback = (session: ChatSession) => void;

/**
 * Mutable holder shared between the orchestrator's construction-time handlers
 * and {@link wireBridge}. The orchestrator accepts handlers only at
 * construction, so the handlers read `holder.session` (initially null) and
 * `wireBridge` populates it once the real session exists.
 */
export type SessionHolder = { session: ChatSession | null };

/**
 * Build the orchestrator + the handlers that route into a {@link SessionHolder}.
 *
 * The orchestrator accepts handlers only at construction time, so the handlers
 * close over a shared holder. The controller runs the orchestrator's entry
 * point (`start()`/`join()`) to resolve the conversation id, then calls
 * {@link wireBridge} which fills in the holder. Until then the handlers see
 * `holder.session === null` and no-op (no state has been seeded yet).
 */
export function buildOrchestrator(
  input: BuildSessionInput,
  holder: SessionHolder,
  onChange: SessionChangeCallback,
): ConversationOrchestrator {
  /**
   * Apply a transfer event to the holder's session and notify. Late events
   * (after the session was torn down) are dropped: holder.session is null'd
   * on teardown. Events are also dropped while `session.detached` is true (set
   * by clearConversation) so a late frame does not repopulate a cleared
   * snapshot.
   */
  function applyTransfer(event: TransferEvent): void {
    const session = holder.session;
    if (session === null) return;
    if (session.detached) return;
    session.transfers = applyTransferEvent(session.transfers, event);
    onChange(session);
  }

  const handlers: OrchestratorHandlers = {
    onStateChange: (next: ConnectionState): void => {
      if (holder.session !== null) {
        holder.session.connectionState = next;
        onChange(holder.session);
      }
    },
    onMessage: (message: ConversationMessage): void => {
      const session = holder.session;
      if (session === null) return;
      // Detach gate: clearConversation sets `detached` so a frame arriving
      // after the snapshot was wiped does NOT repopulate it. The orchestrator
      // has already persisted by this point, but the snapshot mirror is
      // skipped — the next send/resume re-arms the session.
      if (session.detached) return;
      session.messages = session.messages.concat(message);
      session.lastMessagePreview = previewOf(message.text);
      session.lastMessageAt = message.timestamp;
      // R9/F5 (Phase 8.5): advance the separate "last received" cursor only
      // for received-direction messages so the read-marker logic in the
      // controller can advance the cursor independently of sent messages.
      if (message.direction === "received") {
        session.lastReceivedAt = message.timestamp;
      }
      onChange(session);
    },
    onSafetyNumber: (safetyNumber: string, verified: boolean): void => {
      if (holder.session === null) return;
      holder.session.safetyNumber = safetyNumber;
      holder.session.safetyNumberVerified = verified;
      onChange(holder.session);
    },
    onError: (error: unknown): void => {
      // The controller surfaces errors at the top level; we still notify so a
      // future derivation can attach the error to the active session.
      // R7/F3: mirror the durable authFailed flag into the snapshot so the UI
      // shows a "create a fresh invitation" call-to-action and disables retry.
      if (holder.session !== null) {
        if (isAuthFailureError(error)) {
          holder.session.authFailed = true;
        }
        onChange(holder.session);
      }
    },
    onTransferStart: (summary: TransferSummary): void => {
      applyTransfer({
        type: "start",
        id: summary.transferId,
        name: summary.name,
        mimeType: summary.mimeType,
        size: summary.size,
        direction: summary.direction,
      });
    },
    onTransferProgress: (summary: TransferSummary): void => {
      applyTransfer({
        type: "progress",
        id: summary.transferId,
        bytesTransferred: summary.bytesTransferred,
      });
    },
    onTransferComplete: (summary: TransferSummary): void => {
      applyTransfer({ type: "complete", id: summary.transferId });
    },
    onTransferCancelled: (transferId: number): void => {
      applyTransfer({ type: "cancelled", id: transferId });
    },
    onTransferError: (transferId: number, error: unknown): void => {
      applyTransfer({
        type: "error",
        id: transferId,
        error: error instanceof Error ? error.message : String(error),
      });
    },
    onFileReceived: (file: ReceivedFile): void => {
      // The received-direction transfer is already mirrored via the start/
      // complete summaries the orchestrator emits alongside onFileReceived.
      // Stash the bytes on the session (NOT in the snapshot) so the UI can
      // fetch them on demand via the controller's getReceivedFile. Detach
      // gate: skip if clearConversation just wiped the snapshot.
      const session = holder.session;
      if (session !== null && !session.detached) {
        session.receivedFiles.set(file.manifest.transferId, file);
      }
    },
  };

  return new ConversationOrchestrator({
    brokerUrl: input.brokerUrl,
    baseUrl: input.baseUrl,
    publicBaseUrl: input.publicBaseUrl,
    repository: input.repository,
    socketFactory: input.socketFactory,
    identity: input.identity,
    handlers,
    useInternalSignaling: false,
    // R8/F1 (Phase 6): thread the PAKE feature gate to the orchestrator.
    enablePake: input.enablePake,
  });
}

/**
 * Finish constructing a session: build the WebRTC bridge, bind the
 * conversation id, and populate the shared holder so the orchestrator's
 * handlers (built in {@link buildOrchestrator}) start mutating THIS session's
 * snapshot.
 */
export function wireBridge(params: {
  orchestrator: ConversationOrchestrator;
  holder: SessionHolder;
  conversationId: ConversationId;
  role: Role;
  brokerUrl: string;
  socketFactory: SignalingSocketFactory;
  peerConnectionFactory: PeerConnectionFactory;
  iceServers?: readonly IceServer[];
  onPeerJoin: () => void;
  onPeerLeave: () => void;
  onSignalingClosed: () => void;
}): ChatSession {
  const { orchestrator, holder, conversationId, role } = params;

  // The bridge closes over `orchestrator` (not `session`) so it can be built
  // before the session record. The session then references the live bridge.
  const bridge = new WebRtcBridge({
    brokerUrl: params.brokerUrl,
    roomId: conversationId,
    role,
    socketFactory: params.socketFactory,
    peerConnectionFactory: params.peerConnectionFactory,
    iceServers: params.iceServers,
    transportReady: (transport: PeerTransport): void => {
      try {
        orchestrator.attachTransport(transport);
      } catch {
        // best-effort; surfaced via the orchestrator's onError handler.
      }
    },
    onPeerJoin: params.onPeerJoin,
    onPeerLeave: params.onPeerLeave,
    onSignalingClosed: params.onSignalingClosed,
  });

  const session: ChatSession = {
    id: conversationId,
    orchestrator,
    bridge,
    connectionState: orchestrator.state,
    messages: [],
    safetyNumber: null,
    safetyNumberVerified: false,
    unread: 0,
    draft: "",
    invitation: null,
    record: null,
    lastMessagePreview: null,
    lastMessageAt: null,
    // R9/F5 (Phase 8.5): seed the separate "last received" cursor so the
    // read-marker logic can advance it independently of lastMessageAt.
    lastReceivedAt: null,
    transfers: [],
    receivedFiles: new Map<number, ReceivedFile>(),
    detached: false,
    authFailed: false,
    // SEC-4: seed from the orchestrator's own default (SafetyNumberOnly).
    // summarizeSession/activeSessionView read the orchestrator's live getter,
    // but the session field is the source of truth for direct construction.
    authMode: AuthMode.SafetyNumberOnly,
  };

  // Populate the holder BEFORE the caller starts the bridge so any synchronous
  // handler callback sees the live session.
  holder.session = session;

  return session;
}

/**
 * Replace the session's snapshot with the conversation's persisted history and
 * record. Used on resume to seed the snapshot before the peer rejoins.
 */
export function seedSessionFromHistory(
  session: ChatSession,
  record: ConversationRecord | null,
  history: ConversationMessage[],
): void {
  session.record = record;
  session.messages = history.slice();
  // R7/F3: mirror the durable authFailed flag from the record so a resumed
  // conversation still surfaces the "create a fresh invitation" affordance.
  session.authFailed = record?.authFailed === true;
  // R9/F5 (Phase 8.5): seed lastReceivedAt from the most recent RECEIVED
  // message so the read-marker logic advances correctly on resume.
  let lastReceivedAt: number | null = null;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (m.direction === "received") {
      lastReceivedAt = m.timestamp;
      break;
    }
  }
  session.lastReceivedAt = lastReceivedAt;
  if (history.length > 0) {
    const last = history[history.length - 1] as ConversationMessage;
    session.lastMessagePreview = previewOf(last.text);
    session.lastMessageAt = last.timestamp;
  } else {
    session.lastMessagePreview = null;
    session.lastMessageAt = null;
  }
}

/**
 * Idempotent teardown of one session's orchestrator + bridge. After this
 * returns, the session's WebRTC + signaling resources are released; the
 * controller removes it from the map.
 */
export function teardownSession(session: ChatSession): void {
  // R5/F5: idempotency guard. All current callers remove the session from the
  // controller's map before any re-entrant path, but a second teardown (e.g.
  // leaveConversation racing leaveAll) must not re-enter orchestrator.leave()
  // / bridge.close() on an already-torn-down session.
  if (session.connectionState === ConnectionState.Disconnected) {
    return;
  }
  // R9/F7: zero each received-file byte buffer BEFORE releasing the WebRTC +
  // signaling resources. Files are transient (PRD: nothing is persisted on
  // disk); teardown is the last chance to clear the plaintext bytes held in
  // memory for the UI's on-demand download. Mirrors clearConversation's
  // zeroing, applied on the session-disconnect path.
  for (const file of session.receivedFiles.values()) {
    file.data.fill(0);
  }
  session.receivedFiles.clear();
  try {
    session.orchestrator.leave();
  } catch {
    // best-effort
  }
  try {
    session.bridge.close();
  } catch {
    // best-effort
  }
  session.connectionState = ConnectionState.Disconnected;
}

/** Truncate a message body to a sidebar-safe preview length. */
export function previewOf(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= 48) return trimmed;
  return `${trimmed.slice(0, 45)}…`;
}
