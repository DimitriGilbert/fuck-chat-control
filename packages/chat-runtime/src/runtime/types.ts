import type { GroupSession } from "../group/group-session";
import type { GroupId } from "../group/types";
import type { AuthMode, ConversationId, PublicKey } from "../protocol/types";
import { ConnectionState } from "../signaling/state-machine";
import type { ConversationOrchestrator } from "../orchestrator/orchestrator";
import type { ConversationMessage, ConversationRecord, MessageDirection } from "../store";
import type { ReceivedFile } from "../framing";

import type { GroupWebrtcManager } from "./group-webrtc-manager";
import type { TransferState } from "./transfer-state";
import type { WebRtcBridge } from "./webrtc-bridge";

/**
 * Platform-neutral file payload for outgoing transfers. Replaces the DOM
 * `File` the web UI used to pass in — callers on every platform read their
 * platform's file handle into a `Uint8Array` and pass {data, name, mimeType}
 * here. The runtime never touches the DOM `File` type.
 */
export interface ChatFileInput {
  /** Raw file bytes. Read into memory by the caller before sending. */
  readonly data: Uint8Array;
  /** Original filename; defaults to `file.bin` when the caller passes `""`. */
  readonly name: string;
  /** MIME type; defaults to `application/octet-stream` when the caller passes `""`. */
  readonly mimeType: string;
}

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
  /**
   * SEC-4: the negotiated auth mode for this session. Mirrors
   * {@link ConversationOrchestrator.handshakeAuthMode} so the UI can show
   * PAKE-protected sessions distinctly from safety-number-only ones. Defaults
   * to {@link AuthMode.SafetyNumberOnly}; becomes {@link AuthMode.Pake} once a
   * PAKE code is supplied (Phase 8/10 invitation fragment or `setPakeCode`).
   */
  authMode: AuthMode;
  /**
   * R7F2 (Phase 5.1): teardown idempotency latch. Set by `teardownSession`
   * (chat-session.ts) on its FIRST run so a second call — leaveConversation
   * racing leaveAll/dispose — is a no-op. This must NOT be derived from
   * {@link connectionState}: the orchestrator reaches Disconnected on its own
   * (notifyPeerLeft / notifySignalingClosed / failHandshake) without
   * teardownSession ever running, and conflating the two skipped the resource
   * release entirely — leaking the bridge's signaling socket (a held broker
   * room slot), the RTCPeerConnection + adapter listeners, and leaving
   * received-file plaintext resident in memory.
   */
  tornDown: boolean;
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
  /**
   * SEC-4: the negotiated auth mode surfaced to the sidebar so PAKE-protected
   * sessions render a distinct affordance. Mirrors
   * {@link ChatSession.authMode}.
   */
  readonly authMode: AuthMode;
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
  /**
   * SEC-4: the negotiated auth mode for the active session. Mirrors
   * {@link ChatSession.authMode}; the status bar / security sheet read this
   * to surface "PAKE" vs "Safety number" provenance.
   */
  readonly authMode: AuthMode;
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
    // SEC-4: surface the orchestrator's negotiated auth mode so the sidebar
    // can distinguish PAKE-protected sessions. The orchestrator defaults to
    // SafetyNumberOnly; this getter flips to Pake once a code is supplied.
    authMode: session.orchestrator.handshakeAuthMode,
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
    // SEC-4: mirror the negotiated auth mode so the status bar and security
    // sheet can show PAKE vs safety-number provenance for the active session.
    authMode: session.orchestrator.handshakeAuthMode,
  };
}

// ---------------------------------------------------------------------------
// Group sessions (protocol-v2)
// ---------------------------------------------------------------------------

/**
 * One entry of a group's in-memory attributed transcript. Unlike a 1:1
 * {@link ConversationMessage}, a group message needs sender attribution:
 * `senderIdentityPub` is the AUTHENTICATED identity key of the sending
 * member's link (protocol-v2 §6 — attribution is the link's peer identity,
 * never the ephemeral signaling peerId). `null` marks our own sent messages.
 *
 * Nothing is persisted: group history is session-scoped and memory-only,
 * readable via the controller's `getGroupHistory` (flattened to the plain
 * {@link ConversationMessage} timeline — the sender column is dropped
 * there; attribution is a live-session view only).
 */
export interface GroupChatMessage {
  readonly id: string;
  readonly groupId: GroupId;
  readonly direction: MessageDirection;
  /** Authenticated sender identity key; null for our own sent messages. */
  readonly senderIdentityPub: PublicKey | null;
  readonly timestamp: number;
  readonly text: string;
}

/**
 * The per-group record held in the controller's group map. Each entry owns
 * one {@link GroupSession} (membership + per-link orchestrators) plus one
 * {@link GroupWebrtcManager} (the broker seat + per-member peer
 * connections). Mirrors the role {@link ChatSession} plays for 1:1.
 */
export interface ChatGroupSession {
  /** The 16-byte group id — also the broker room id (protocol-v2 §1). */
  readonly id: GroupId;
  /** The membership layer: canonical list, epochs, content fan-out. */
  readonly session: GroupSession;
  /** The broker seat + per-member peer connections feeding the session. */
  readonly manager: GroupWebrtcManager;
  /** True when this device authored the group (sole list signer/admin). */
  readonly isAuthor: boolean;
  /** The negotiated link auth mode (uniform across every pairwise link). */
  readonly authMode: AuthMode;
  /** Local group label (the `name` given at creation; sidebar display). */
  displayName: string | null;
  /** In-memory attributed transcript for the live session. */
  messages: GroupChatMessage[];
  /**
   * Whether the user accepted the current epoch-bound group safety number
   * out-of-band. Reset to false on every membership change — the number is
   * epoch-bound (§5), so a new epoch is a new number needing re-verification.
   */
  safetyNumberVerified: boolean;
  /** Unread message count for non-active groups; cleared on select. */
  unread: number;
  /** Composer draft restored when the user switches back to this group. */
  draft: string;
  /** Initiator invitation link (null on the joiner side). */
  invitation: string | null;
  /** Preview of the most recent message, for the sidebar. */
  lastMessagePreview: string | null;
  /** Timestamp of the most recent message; null when there are none. */
  lastMessageAt: number | null;
  /** Timestamp of the most recent RECEIVED message; null when none. */
  lastReceivedAt: number | null;
  /**
   * Received file bytes keyed by `<senderKeyId>:<transferId>` — per-link
   * transfer id spaces collide across members, so the key pairs the sender's
   * identity key with the link-local transfer id. In memory only.
   */
  readonly receivedFiles: Map<string, ReceivedFile>;
  /**
   * Inbound gate, same contract as {@link ChatSession.detached}: set by a
   * group history clear so a late frame does not repopulate the transcript.
   */
  detached: boolean;
  /**
   * Teardown idempotency latch (same discipline as {@link ChatSession.tornDown}):
   * set once the group is torn down — by leaveGroup/leaveAll/dispose or by the
   * session's own self-eject via the host's onClosed wiring.
   */
  tornDown: boolean;
}

/** One member row in the active-group view. */
export interface GroupMemberView {
  /** The member's authenticated identity public key (65-byte SEC1). */
  readonly identityPub: PublicKey;
  /** Identity key rendered as hex — the stable React key / testid input. */
  readonly identityPubHex: string;
  /** True for the list's author-flagged entry (the sole admin). */
  readonly isAuthor: boolean;
  /** True for this device's own entry. */
  readonly isSelf: boolean;
  /** The member's announced/signed display name ("" when unset). */
  readonly displayName: string;
  /**
   * The v1 connection state of our link to this member (pending-verify links
   * included), or null when no link exists — the self entry reports null.
   */
  readonly linkState: ConnectionState | null;
}

/** Sidebar-facing summary of one live group — mirrors {@link SessionSummary}. */
export interface GroupSummary {
  readonly groupId: GroupId;
  /** Group id rendered as hex — the stable React key / testid input. */
  readonly groupIdHex: string;
  /** Local label (creation `name`), else a member-count fallback. */
  readonly label: string;
  readonly epoch: number;
  readonly memberCount: number;
  /**
   * Members whose pairwise link is currently {@link ConnectionState.Connected}
   * — the local member is never counted (it holds no link to itself), so this
   * tops out at `memberCount - 1`. The sidebar renders it as the "k/n
   * connected" connectivity summary alongside {@link memberCount}.
   */
  readonly connectedLinks: number;
  readonly isAuthor: boolean;
  readonly unread: number;
  readonly lastMessagePreview: string | null;
  readonly lastMessageAt: number | null;
  readonly safetyNumberVerified: boolean;
}

/**
 * The active group's full snapshot — mirrors {@link ActiveSessionState}.
 * Members/safety number/epoch are read LIVE from the session, so the view
 * always reflects the latest adopted list.
 */
export interface ActiveGroupState {
  readonly groupId: GroupId;
  readonly groupIdHex: string;
  readonly isAuthor: boolean;
  readonly epoch: number;
  readonly members: readonly GroupMemberView[];
  readonly safetyNumber: string | null;
  readonly safetyNumberVerified: boolean;
  readonly authMode: AuthMode;
  readonly displayName: string | null;
  readonly messages: readonly GroupChatMessage[];
  readonly invitation: string | null;
  readonly unread: number;
  readonly draft: string;
  readonly lastMessagePreview: string | null;
  readonly lastMessageAt: number | null;
}

function bytesToHexString(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

function sameKey(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Build a {@link GroupSummary} view from a live group session record. */
export function summarizeGroup(group: ChatGroupSession): GroupSummary {
  const memberCount = group.session.memberList.length;
  // Count member links that are currently Connected. Self is skipped
  // implicitly: memberLinkState returns null for the local member (it has
  // no link to itself). Pending/handshaking links count toward the member
  // total but not toward connected — matching the "k/n connected" contract.
  let connectedLinks = 0;
  for (const member of group.session.memberList) {
    if (group.session.memberLinkState(member.identityPub) === ConnectionState.Connected) {
      connectedLinks++;
    }
  }
  return {
    groupId: group.id,
    groupIdHex: bytesToHexString(group.id),
    label: group.displayName ?? `Group · ${memberCount} member${memberCount === 1 ? "" : "s"}`,
    epoch: group.session.memberEpoch,
    memberCount,
    connectedLinks,
    isAuthor: group.isAuthor,
    unread: group.unread,
    lastMessagePreview: group.lastMessagePreview,
    lastMessageAt: group.lastMessageAt,
    safetyNumberVerified: group.safetyNumberVerified,
  };
}

/**
 * Build an {@link ActiveGroupState} view from a live group record. `selfPub`
 * is the device identity public key used to flag the caller's own member
 * entry.
 */
export function activeGroupView(group: ChatGroupSession, selfPub: PublicKey): ActiveGroupState {
  const members: GroupMemberView[] = group.session.memberList.map((m) => {
    const isSelf = sameKey(m.identityPub, selfPub);
    return {
      identityPub: m.identityPub,
      identityPubHex: bytesToHexString(m.identityPub),
      isAuthor: m.isAuthor,
      isSelf,
      displayName: m.displayName,
      linkState: isSelf ? null : group.session.memberLinkState(m.identityPub),
    };
  });
  return {
    groupId: group.id,
    groupIdHex: bytesToHexString(group.id),
    isAuthor: group.isAuthor,
    epoch: group.session.memberEpoch,
    members,
    safetyNumber: group.session.groupSafetyNumber,
    safetyNumberVerified: group.safetyNumberVerified,
    authMode: group.authMode,
    displayName: group.displayName,
    messages: group.messages,
    invitation: group.invitation,
    unread: group.unread,
    draft: group.draft,
    lastMessagePreview: group.lastMessagePreview,
    lastMessageAt: group.lastMessageAt,
  };
}
