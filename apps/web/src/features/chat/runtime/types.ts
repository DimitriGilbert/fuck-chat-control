import type { ConversationId } from "@/features/chat/protocol/types";
import type { ConnectionState } from "@/features/chat/signaling/state-machine";
import type { ConversationOrchestrator } from "@/features/chat/orchestrator/orchestrator";
import type { ConversationMessage, ConversationRecord } from "@/features/chat/store";
import type { ReceivedFile } from "@/features/chat/framing";

import type { TransferState } from "./transfer-state";
import type { WebRtcBridge } from "./webrtc-bridge";

/**
 * The per-session record held in the controller's session map. Each entry owns
 * its own orchestrator + bridge and a snapshot of the fields that previously
 * lived flat on {@link ChatControllerState}.
 *
 * Background/idle sessions keep their bridge running so messages still arrive;
 * the controller mutates these fields from THAT session's orchestrator handlers
 * and notifies listeners exactly once per change.
 */
export interface ChatSession {
  /** Stable id of the conversation this session drives. */
  readonly id: ConversationId;
  /** The application-layer orchestrator (handshake, send/receive, persist). */
  readonly orchestrator: ConversationOrchestrator;
  /** The WebRTC + signaling bridge that owns this session's RTCPeerConnection. */
  readonly bridge: WebRtcBridge;
  /** Last reported signaling/handshake state. */
  connectionState: ConnectionState;
  /** Chronological message list for this conversation. */
  messages: ConversationMessage[];
  /** Safety number once the handshake reaches the verifying/connected phases. */
  safetyNumber: string | null;
  /** Whether the user has accepted the safety number out-of-band. */
  safetyNumberVerified: boolean;
  /** Unread message count for non-active sessions; cleared on select. */
  unread: number;
  /** Composer draft restored when the user switches back to this session. */
  draft: string;
  /** Initiator invitation link (null on responder/resume). */
  invitation: string | null;
  /** Cached repository record so summary derivation stays synchronous. */
  record: ConversationRecord | null;
  /**
   * Preview of the most recent message (sent or received), used by the sidebar.
   * Null only when the conversation has no messages at all.
   */
  lastMessagePreview: string | null;
  /** Timestamp of the most recent message; null when there are none. */
  lastMessageAt: number | null;
  /**
   * R9/F5 (Phase 8.5): timestamp of the most recent RECEIVED message; null
   * when the conversation has never received one. Tracked SEPARATELY from
   * {@link lastMessageAt} (which advances on sent OR received) so the
   * read-marker logic can advance the cursor only on RECEIVED messages —
   * a sent message must NOT count as "the user has read up to here",
   * otherwise a peer's message that arrives with an earlier timestamp
   * (clock drift, queue ordering) would be silently miscounted as read.
   */
  lastReceivedAt: number | null;
  /**
   * Live transfer state for this session: queued/sending/receiving/complete/
   * cancelled/error entries for every file sent or received. The controller
   * mutates this array (immutably) as the orchestrator emits transfer events.
   */
  transfers: readonly TransferState[];
  /**
   * Side-store (NOT in the React snapshot) of received file bytes keyed by
   * transfer id. Populated by the orchestrator's onFileReceived handler; read
   * by the controller's getReceivedFile for the UI's Save/thumbnail action.
   * Bytes live in memory only and are cleared on teardown.
   */
  receivedFiles: Map<number, ReceivedFile>;
  /**
   * Inbound gate. Set to true by {@link ChatController.clearConversation} so a
   * late orchestrator frame (onMessage/onFileReceived/transfer events) arriving
   * after the snapshot was wiped does NOT repopulate it. Re-armed (set to
   * false) when the user sends the next message or the conversation is
   * resumed/selected.
   *
   * The orchestrator's handlers close over a {@link SessionHolder} that points
   * at THIS session; checking `session.detached` inside the controller-level
   * routing (rather than in orchestrator.ts) is what detaches inbound frames
   * without touching the orchestrator.
   */
  detached: boolean;
  /**
   * Durable auth-failed mirror (R7/F3). Set by the controller when the
   * orchestrator's onError surfaces an IdentityChanged or PakeError failure,
   * which durably wrote the flag via {@link ConversationRepository.markAuthFailed}.
   * Surfaced on the snapshot so the UI shows a "create a fresh invitation"
   * call-to-action and disables the retry affordance.
   */
  authFailed: boolean;
}

/**
 * Sidebar-facing summary of one session. Derived from a {@link ChatSession} and
 * its cached {@link ConversationRecord}; the controller surfaces an array of
 * these on {@link ChatControllerState.sessions}.
 *
 * `label` resolves as: the record's `displayName`, else a truncated peer
 * fingerprint, else "New chat" — whichever is first available.
 */
export interface SessionSummary {
  readonly id: ConversationId;
  readonly label: string;
  readonly connectionState: ConnectionState;
  readonly unread: number;
  readonly lastMessagePreview: string | null;
  readonly lastMessageAt: number | null;
  readonly safetyNumberVerified: boolean;
  /** Durable auth-failed flag (R7/F3). When true, retry is blocked. */
  readonly authFailed: boolean;
}

/**
 * The active session's full snapshot, surfaced at the top of
 * {@link ChatControllerState} so React consumers can read the active view's
 * fields without a second lookup. Mirrors the fields on {@link ChatSession};
 * null when there is no active conversation.
 */
export interface ActiveSessionState {
  readonly id: ConversationId;
  readonly connectionState: ConnectionState;
  readonly messages: readonly ConversationMessage[];
  readonly safetyNumber: string | null;
  readonly safetyNumberVerified: boolean;
  readonly invitation: string | null;
  readonly unread: number;
  readonly draft: string;
  readonly lastMessagePreview: string | null;
  readonly lastMessageAt: number | null;
  /** Live transfer list mirror of {@link ChatSession.transfers}. */
  readonly transfers: readonly TransferState[];
  /** Durable auth-failed flag (R7/F3). When true, retry is blocked. */
  readonly authFailed: boolean;
}

/**
 * Derive the human-readable label for a session summary. The display name wins
 * when set; otherwise a truncated peer fingerprint; otherwise "New chat".
 */
export function deriveSessionLabel(
  record: ConversationRecord | null,
  fallbackPeerFingerprint: string | null,
): string {
  if (record !== null && record.displayName !== null && record.displayName.length > 0) {
    return record.displayName;
  }
  if (record !== null && record.peer !== null && record.peer.fingerprint.length > 0) {
    return truncateFingerprint(record.peer.fingerprint);
  }
  if (fallbackPeerFingerprint !== null && fallbackPeerFingerprint.length > 0) {
    return truncateFingerprint(fallbackPeerFingerprint);
  }
  return "New chat";
}

/** Truncate a fingerprint to the first and last 4 chars separated by an ellipsis. */
function truncateFingerprint(fingerprint: string): string {
  if (fingerprint.length <= 12) return fingerprint;
  return `${fingerprint.slice(0, 4)}…${fingerprint.slice(-4)}`;
}

/**
 * Build a {@link SessionSummary} view from a session and its cached record.
 * Pure function; safe to call on every state change.
 */
export function summarizeSession(session: ChatSession): SessionSummary {
  return {
    id: session.id,
    label: deriveSessionLabel(session.record, session.safetyNumber),
    connectionState: session.connectionState,
    unread: session.unread,
    lastMessagePreview: session.lastMessagePreview,
    lastMessageAt: session.lastMessageAt,
    safetyNumberVerified: session.safetyNumberVerified,
    authFailed: session.authFailed,
  };
}

/**
 * Build an {@link ActiveSessionState} view from a session. Returns null when
 * the caller hands it an undefined session (i.e. no active conversation).
 */
export function activeSessionView(session: ChatSession | null): ActiveSessionState | null {
  if (session === null) return null;
  return {
    id: session.id,
    connectionState: session.connectionState,
    messages: session.messages,
    safetyNumber: session.safetyNumber,
    safetyNumberVerified: session.safetyNumberVerified,
    invitation: session.invitation,
    unread: session.unread,
    draft: session.draft,
    lastMessagePreview: session.lastMessagePreview,
    lastMessageAt: session.lastMessageAt,
    transfers: session.transfers,
    authFailed: session.authFailed,
  };
}
