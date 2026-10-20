import type { IdentityKeyPair } from "../crypto";
import type { ReceivedFile } from "../framing";
import { GroupSession } from "../group/group-session";
import type { GroupId, GroupMember, GroupMembership, PeerId } from "../group/types";
import { encodeConversationId } from "../protocol/codec";
import { AuthMode } from "../protocol/types";
import type { ConversationId, PublicKey } from "../protocol/types";
import type { SignalingSocketFactory } from "../signaling/signaling-client";
import type { ConnectionState } from "../signaling/state-machine";
import { MessageDirection } from "../store";
import type { ConversationRepository } from "../store";
import type { IceServer, PeerConnectionFactory } from "../transport/types";

import { GroupWebrtcManager } from "./group-webrtc-manager";
import { previewOf } from "./chat-session";
import type { ChatGroupSession, GroupChatMessage } from "./types";

/**
 * Controller-owned singletons threaded into every group host. Mirrors the
 * 1:1 `BuildSessionInput` (chat-session.ts): the controller passes its
 * identity, repository, socket/peer-connection factories, ICE servers, and
 * the configured group member cap.
 */
export interface GroupHostDeps {
  readonly brokerUrl: string;
  readonly baseUrl: string;
  readonly repository: ConversationRepository;
  readonly socketFactory: SignalingSocketFactory;
  readonly peerConnectionFactory: PeerConnectionFactory;
  readonly iceServers?: readonly IceServer[];
  readonly identity: IdentityKeyPair;
  /** PAKE feature gate, threaded to each link orchestrator (R8/F1). */
  readonly enablePake?: boolean;
  /** Configured member cap (GROUP_MAX_MEMBERS); defaults inside the session/manager. */
  readonly maxMembers?: number;
}

/** Per-group construction parameters (what startGroup/joinGroup supply). */
export interface GroupHostInit {
  readonly groupId: GroupId;
  /** True on the group creator — the sole list signer/admin (§4). */
  readonly isAuthor: boolean;
  /** Uniform auth mode across every pairwise link (§8). */
  readonly authMode: AuthMode;
  /** The author-minted 6-digit SPAKE2 code; required iff authMode is Pake. */
  readonly pakeCode?: string;
  /**
   * This member's OWN display name, announced on every link and folded into
   * the canonical member entry (§4.1). Distinct from {@link label}, which is
   * the local-only sidebar name for the group itself.
   */
  readonly memberName?: string;
  /** Local group label (startGroup's `name`); not part of the wire protocol. */
  readonly label?: string | null;
  /** The invitation minted by the author; null for joiners. */
  readonly invitation?: string | null;
}

/**
 * Host→controller callbacks. `onChange` asks the controller to re-derive the
 * state snapshot; `onError` surfaces non-fatal session/manager errors;
 * `onEnded` fires exactly once when the group session has fully ended — by
 * local leave, self-eject on a kick (§4.2), or broker-seat loss — AFTER the
 * manager was torn down in the same call stack.
 */
export interface GroupHostHandlers {
  readonly onChange?: (group: ChatGroupSession) => void;
  readonly onError?: (group: ChatGroupSession, error: unknown) => void;
  readonly onEnded?: (group: ChatGroupSession) => void;
}

/**
 * The handlers each host was constructed with, so {@link teardownGroup} can
 * drive the same finish path a self-eject takes (onClosed → finishGroup →
 * manager.leave → onEnded). Keyed by the record itself; entries die with it.
 */
const groupHandlers = new WeakMap<ChatGroupSession, GroupHostHandlers>();

/**
 * The group-scoped conversation id a group's transcript rows are namespaced
 * under when they are surfaced as plain {@link ConversationMessage}s (the
 * controller's `getGroupHistory`). The 16-byte group id occupies the same id
 * space as a v1 conversation id, so it is re-branded verbatim. No durable row
 * is ever created under this id — this namespace, plus every DERIVED pairwise
 * conversation id the per-link orchestrators resolve internally, is excluded
 * from the controller's resumable-conversation list as defense-in-depth for
 * rows persisted by earlier builds.
 */
export function groupConversationId(groupId: GroupId): ConversationId {
  return encodeConversationId(groupId);
}

/** Composite key for {@link ChatGroupSession.receivedFiles}. */
export function receivedFileKey(senderIdentityPub: PublicKey, transferId: number): string {
  return `${bytesToHexText(senderIdentityPub)}:${transferId}`;
}

function bytesToHexText(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

function newGroupMessageId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * The single teardown funnel for a group: zero received-file bytes, then
 * `manager.leave()` — which sends `leave` on every open link, leaves the
 * broker seat, and closes every peer connection — and finally `onEnded` so
 * the controller evicts the record.
 *
 * OBS-F PAIRING (Phase 5 review): session teardown and manager teardown MUST
 * happen together in BOTH directions. `session.leave()` fires `onClosed`,
 * which funnels HERE — so a session that ends on its own (self-eject after a
 * kick, or the broker-socket-close path below) still drains the manager's
 * seats and RTCPeerConnections. Conversely this function is what
 * controller-initiated leaves call, and `manager.leave()` drives
 * `session.leave()` FIRST (the `leave` control frame must go out while the
 * data channels are still open). The `tornDown` latch makes the re-entrant
 * cycles (manager.leave → session.leave → onClosed → finishGroup) converge
 * on exactly one pass.
 */
function finishGroup(group: ChatGroupSession): void {
  if (group.tornDown) return;
  group.tornDown = true;
  const handlers = groupHandlers.get(group);
  for (const file of group.receivedFiles.values()) {
    file.data.fill(0);
  }
  group.receivedFiles.clear();
  try {
    group.manager.leave();
  } catch (err: unknown) {
    handlers?.onError?.(group, err);
  }
  handlers?.onEnded?.(group);
}

/**
 * Idempotent teardown of one group session (leaveGroup/leaveAll/dispose).
 * Mirrors `teardownSession` (chat-session.ts) for the 1:1 path.
 */
export function teardownGroup(group: ChatGroupSession): void {
  finishGroup(group);
}

/**
 * Build a live group: the {@link GroupSession} (membership + per-link
 * orchestrators), the {@link GroupWebrtcManager} (broker seat + per-member
 * peer connections), and the {@link ChatGroupSession} record the controller
 * keeps. Wiring detail: session handlers run through a holder because the
 * handlers are bound at construction, before the record exists — the same
 * pattern `buildOrchestrator`/`wireBridge` uses for 1:1 sessions.
 *
 * The caller registers the record, persists the repo group record, and then
 * calls `group.manager.connect()` to seat the member in the broker room.
 */
export function createGroupHost(
  deps: GroupHostDeps,
  init: GroupHostInit,
  handlers: GroupHostHandlers,
): ChatGroupSession {
  const holder: { group: ChatGroupSession | null } = { group: null };

  /**
   * Mirror an inbound member message into the in-memory transcript
   * ({@link ChatGroupSession.messages}). The entry carries sender
   * attribution (the link's authenticated identity, §6). Nothing is
   * persisted — the group transcript is session-scoped, so a store failure
   * can never wedge the receive path.
   */
  function recordInboundMessage(
    group: ChatGroupSession,
    memberPub: PublicKey,
    text: string,
    timestamp: number,
  ): void {
    const message: GroupChatMessage = {
      id: newGroupMessageId(),
      groupId: group.id,
      direction: MessageDirection.Received,
      senderIdentityPub: memberPub,
      timestamp,
      text,
    };
    group.messages = group.messages.concat(message);
    group.lastMessagePreview = previewOf(text);
    group.lastMessageAt = timestamp;
    group.lastReceivedAt = timestamp;
    handlers.onChange?.(group);
  }

  const session = new GroupSession({
    groupId: init.groupId,
    identity: deps.identity,
    authMode: init.authMode,
    pakeCode: init.pakeCode,
    isAuthor: init.isAuthor,
    repository: deps.repository,
    displayName: init.memberName,
    maxMembers: deps.maxMembers,
    brokerUrl: deps.brokerUrl,
    baseUrl: deps.baseUrl,
    socketFactory: deps.socketFactory,
    enablePake: deps.enablePake,
    handlers: {
      onMessage: (memberPub: PublicKey, text: string, timestamp: number): void => {
        const group = holder.group;
        if (group === null || group.detached) return;
        recordInboundMessage(group, memberPub, text, timestamp);
      },
      onMemberJoined: (_member: GroupMember): void => {
        const group = holder.group;
        if (group !== null) handlers.onChange?.(group);
      },
      onMemberLeft: (_identityPub: PublicKey): void => {
        const group = holder.group;
        if (group !== null) handlers.onChange?.(group);
      },
      onMembershipChanged: (membership: GroupMembership): void => {
        const group = holder.group;
        if (group === null) return;
        // The group safety number is epoch-bound (§5): a new epoch is a new
        // number, so any prior verification must not carry over.
        group.safetyNumberVerified = false;
        // Land the canonical list on the stored group record (fire-and-forget;
        // a store failure surfaces via onError). Also covers the author-key
        // field for joiners, populated from the isAuthor entry.
        void deps.repository
          .updateGroupMembership(group.id, membership.epoch, membership.members)
          .catch((err: unknown) => {
            handlers.onError?.(group, err);
          });
        handlers.onChange?.(group);
      },
      onFileReceived: (memberPub: PublicKey, file: ReceivedFile): void => {
        const group = holder.group;
        if (group === null || group.detached) return;
        group.receivedFiles.set(receivedFileKey(memberPub, file.manifest.transferId), file);
        handlers.onChange?.(group);
      },
      onLinkState: (_peerId: PeerId, _state: ConnectionState): void => {
        const group = holder.group;
        if (group !== null) handlers.onChange?.(group);
      },
      onClosed: (): void => {
        const group = holder.group;
        if (group === null) return;
        // OBS-F: the session ended (local leave, kick self-eject, or the
        // manager's signaling-close path below). Pair it with the manager's
        // teardown — without this the broker seat and peer connections would
        // keep running on a dead session.
        finishGroup(group);
      },
      onError: (error: unknown): void => {
        const group = holder.group;
        if (group !== null) handlers.onError?.(group, error);
      },
    },
  });

  // The manager's callbacks reach the record through the same holder — it is
  // constructed before the record exists but cannot fire handlers before
  // connect() (its socket only dials then), by which point the holder is
  // populated.
  const manager = new GroupWebrtcManager({
    brokerUrl: deps.brokerUrl,
    roomId: bytesToHexText(init.groupId),
    localIdentityPublicKey: deps.identity.publicKey,
    session,
    socketFactory: deps.socketFactory,
    peerConnectionFactory: deps.peerConnectionFactory,
    iceServers: deps.iceServers,
    maxMembers: deps.maxMembers,
    onPeerLinkState: (): void => {
      const live = holder.group;
      if (live !== null) handlers.onChange?.(live);
    },
    onSignalingClosed: (): void => {
      // The broker socket is gone: the manager already surfaced every seated
      // peer as a leave and tore the links down, so the session cannot re-
      // signal or admit anyone new — ending it keeps session and manager
      // lifetimes paired (the onClosed path above then runs the full finish).
      session.leave();
    },
    onError: (error: unknown): void => {
      const live = holder.group;
      if (live !== null) handlers.onError?.(live, error);
    },
  });

  const group: ChatGroupSession = {
    id: init.groupId,
    session,
    manager,
    isAuthor: init.isAuthor,
    authMode: init.authMode,
    displayName: init.label ?? null,
    messages: [],
    safetyNumberVerified: false,
    unread: 0,
    draft: "",
    invitation: init.invitation ?? null,
    lastMessagePreview: null,
    lastMessageAt: null,
    lastReceivedAt: null,
    receivedFiles: new Map<string, ReceivedFile>(),
    detached: false,
    tornDown: false,
  };
  holder.group = group;
  groupHandlers.set(group, handlers);

  return group;
}
