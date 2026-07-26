import { Role } from "@/features/chat/protocol/types";
import type { ConversationId } from "@/features/chat/protocol/types";
import { ConversationOrchestrator } from "@/features/chat/orchestrator/orchestrator";
import type {
  OrchestratorHandlers,
  TransferSummary,
} from "@/features/chat/orchestrator/orchestrator";
import type { PeerTransport } from "@/features/chat/orchestrator/peer-transport";
import { ConnectionState } from "@/features/chat/signaling/state-machine";
import type { SignalingSocketFactory } from "@/features/chat/signaling/signaling-client";
import type {
  ConversationMessage,
  ConversationRecord,
  ConversationRepository,
} from "@/features/chat/store";
import type { IdentityKeyPair } from "@/features/chat/crypto";
import type { ReceivedFile } from "@/features/chat/framing";

import type { ChatSession } from "./types";
import { applyTransferEvent, type TransferEvent } from "./transfer-state";
import { WebRtcBridge } from "./webrtc-bridge";

/**
 * Inputs needed to build a session. The controller owns the singletons
 * (identity, repository, broker/base URLs, socket factory, ICE servers) and
 * passes them in; the builder wires them to the per-session orchestrator +
 * bridge.
 */
export interface BuildSessionInput {
  readonly brokerUrl: string;
  readonly baseUrl: string;
  readonly repository: ConversationRepository;
  readonly socketFactory: SignalingSocketFactory;
  readonly identity: IdentityKeyPair;
  readonly iceServers?: RTCIceServer[];
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
      void error;
      if (holder.session !== null) {
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
    repository: input.repository,
    socketFactory: input.socketFactory,
    identity: input.identity,
    handlers,
    useInternalSignaling: false,
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
  iceServers?: RTCIceServer[];
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
    transfers: [],
    receivedFiles: new Map<number, ReceivedFile>(),
    detached: false,
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
