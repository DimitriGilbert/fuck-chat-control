import { computeGroupSafetyNumber } from "../crypto";
import { ctEqual } from "../crypto/ct-equal";
import type { IdentityKeyPair } from "../crypto";
import type { ReceivedFile } from "../framing";
import { ConversationOrchestrator } from "../orchestrator/orchestrator";
import type { OrchestratorHandlers } from "../orchestrator/orchestrator";
import {
  DEFAULT_MAX_GROUP_MEMBERS,
  MAX_GROUP_MEMBERS_HARD,
  MAX_MEMBER_DISPLAY_NAME,
} from "../protocol/limits";
import { AuthMode, ControlSubtype } from "../protocol/types";
import type { PublicKey } from "../protocol/types";
import type { SignalingSocketFactory } from "../signaling/signaling-client";
import { ConnectionState } from "../signaling/state-machine";
import { PairwiseLinkRepository } from "../store";
import type { ConversationMessage, ConversationRepository } from "../store";
import type { PeerTransport } from "../transport/peer-transport";

import { GroupError, GroupErrorCode } from "./errors";
import {
  addedMembers,
  decodeMembership,
  encodeMembership,
  encodeMembershipBody,
  pubKeyId,
  removedMembers,
  signMembership,
  verifyMembership,
} from "./membership";
import { derivePairwiseConvId } from "./pairwise-id";
import type { GroupId, GroupMember, GroupMembership, PeerId } from "./types";

/**
 * How long a link may sit in the pending-verify state — Connected at the v1
 * layer but not yet proven against the member list — before the session
 * closes it as {@link GroupErrorCode.UnknownLinkIdentity}. Matches the v1
 * handshake bound: a group link that cannot be verified within one handshake
 * budget is treated as an unresolvable identity, not a slow peer.
 */
const DEFAULT_PENDING_VERIFY_TIMEOUT_MS = 30_000;

/** PRD #90: the group PAKE code is exactly 6 decimal digits on every link. */
const PAKE_CODE_PATTERN = /^\d{6}$/;

/** Shared encoder for display names (member entries + identity_announcement). */
const utf8Encoder = new TextEncoder();

/**
 * Inert fallback for the orchestrator's required socketFactory dep. Group
 * links never open signaling sockets (`useInternalSignaling: false` — the
 * group signaling client stays seated in the broker room on their behalf),
 * so this can only fire if a future code path misconfigures a link.
 */
const neverSocketFactory: SignalingSocketFactory = () => {
  throw new GroupError(GroupErrorCode.Malformed, "group links do not open signaling sockets");
};

export interface GroupSessionHandlers {
  /**
   * A decrypted text frame arrived on a verified member link. Attribution is
   * the link's authenticated peer identity (protocol-v2 §6), NOT the
   * signaling `peerId` — text from pending-verify links is dropped and never
   * reaches this handler.
   */
  readonly onMessage?: (memberIdentityPub: PublicKey, text: string, timestamp: number) => void;
  /** A member entry was added to the list (author-side add or list adoption). */
  readonly onMemberJoined?: (member: GroupMember) => void;
  /** A member entry was removed (kick gossip or a newer adopted list). */
  readonly onMemberLeft?: (identityPub: PublicKey) => void;
  /** The canonical member list changed; carries the author's signed list. */
  readonly onMembershipChanged?: (membership: GroupMembership) => void;
  /** A file transfer completed on a verified member link. */
  readonly onFileReceived?: (memberIdentityPub: PublicKey, file: ReceivedFile) => void;
  /** Per-link v1 connection-state transitions, keyed by signaling peerId. */
  readonly onLinkState?: (peerId: PeerId, state: ConnectionState) => void;
  /**
   * The session ended: {@link GroupSession.leave} ran — locally (host-initiated
   * leave) OR internally (self-eject on a kick, §4.2). The host MUST pair this
   * with the WebRTC manager's teardown (its `leave()` releases the broker seat
   * and every peer connection); firing it here, inside leave(), is what makes
   * self-ejection observable to the host instead of silently dropping links
   * while the manager keeps its seat and PCs up.
   */
  readonly onClosed?: () => void;
  /** Non-fatal session errors (bad gossip, unknown link identity, I/O). */
  readonly onError?: (error: unknown) => void;
}

export interface GroupSessionDeps {
  /** The 16-byte group id (= broker room id, protocol-v2 §1). */
  readonly groupId: GroupId;
  /** This device's long-lived identity keypair — signs lists when author. */
  readonly identity: IdentityKeyPair;
  /**
   * Uniform auth mode for EVERY pairwise link (protocol-v2 §8): groups are
   * either all-PAKE or all-safety-number. When {@link AuthMode.Pake},
   * `pakeCode` is required and is used as the SPAKE2 password on every link.
   */
  readonly authMode: AuthMode;
  /** The author-minted 6-digit SPAKE2 code; required iff authMode is Pake. */
  readonly pakeCode?: string;
  /** True on the group creator's session — the sole list signer/admin. */
  readonly isAuthor: boolean;
  /**
   * The conversation repository the session's link orchestrators are wired
   * to. The session wraps it in a {@link PairwiseLinkRepository} at
   * construction, so no link can persist conversation rows, message rows, or
   * display-name rows — pairwise link state is runtime-only — while
   * TOFU-identity and group-record calls still reach the real store.
   */
  readonly repository: ConversationRepository;
  /** This member's display name on its own member entry (≤32 UTF-8 bytes). */
  readonly displayName?: string;
  /** Configured member cap (GROUP_MAX_MEMBERS); defaults to 8, ceiling 16. */
  readonly maxMembers?: number;
  /**
   * Pass-throughs for the per-link orchestrators' required deps. Group links
   * never open signaling sockets or mint invitations, so these are inert and
   * optional; hosts that already hold real values may pass them anyway.
   */
  readonly brokerUrl?: string;
  readonly baseUrl?: string;
  readonly socketFactory?: SignalingSocketFactory;
  /** Mirrors OrchestratorDeps.enablePake (mobile wasm-gated builds). */
  readonly enablePake?: boolean;
  /** Test seam: forwarded to each link orchestrator's handshake bound. */
  readonly handshakeTimeoutMsOverride?: number;
  /** Bound on the pending-verify state; default 30s. */
  readonly pendingVerifyTimeoutMs?: number;
  readonly handlers?: GroupSessionHandlers;
}

/**
 * One member↔member link: a full protocol-v1 conversation (Hello →
 * Signature → optional SPAKE2) over its own data channel, coordinated by a
 * dedicated {@link ConversationOrchestrator} in group-link mode.
 *
 * `verified` means the link's authenticated peer identity was proven to be
 * in the current member list (§4.2 "link identity must be listed"). A link
 * that is Connected but not yet verified is "pending-verify": it may carry
 * group control traffic (that is how the list arrives) but content frames
 * from it are dropped until it verifies.
 */
interface GroupLink {
  readonly peerId: PeerId;
  readonly orchestrator: ConversationOrchestrator;
  peerIdentity: PublicKey | null;
  verified: boolean;
  /**
   * §4.2 flag: the link's authenticated peer is absent from the currently
   * held member list. Flagged links stay open — a just-joined member's link
   * must survive until the epoch covering it lands — and are closed only
   * when the NEXT adopted list still excludes them (or when the
   * pending-verify timer fires as the backstop). Cleared on verification.
   */
  unlisted: boolean;
  /** Display name carried by the peer's identity_announcement, if any. */
  announcedName: string | null;
  /** True once this link has been asked for the member list. */
  membershipRequested: boolean;
  /** Timer bounding the pending-verify state; null once verified/closed. */
  pendingTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Coordinates one group conversation as a mesh of pairwise v1 links
 * (protocol-v2). Owns one {@link ConversationOrchestrator} per member link —
 * the handshake, crypto, and framing are entirely the orchestrator's; this
 * layer adds membership semantics on top: the author's signed member list,
 * epoch-gated adoption, link↔member identity binding, and content fan-out.
 *
 * The author seeds the list with its own entry at epoch 1 and mutates it on
 * every join/kick; members verify the author's signature and adopt the
 * newest epoch. Sender attribution everywhere is the link's authenticated
 * identity public key, never the ephemeral signaling `peerId`.
 */
export class GroupSession {
  private readonly groupIdValue: GroupId;
  private readonly identity: IdentityKeyPair;
  private readonly authModeValue: AuthMode;
  private readonly pakeCode: string | null;
  private readonly author: boolean;
  private readonly repository: ConversationRepository;
  private readonly maxMembers: number;
  private readonly brokerUrl: string;
  private readonly baseUrl: string;
  private readonly socketFactory: SignalingSocketFactory;
  private readonly enablePake: boolean;
  private readonly handshakeTimeoutMsOverride: number | undefined;
  private readonly pendingVerifyTimeoutMs: number;
  private readonly handlers: GroupSessionHandlers;

  private readonly links = new Map<PeerId, GroupLink>();
  /** Secondary index: member identity key-id → its link, once verified. */
  private readonly linksByIdentity = new Map<string, GroupLink>();
  private members: GroupMember[] = [];
  /**
   * TOFU pin of the group author's identity public key (protocol-v2 §4.1).
   * `verifyMembership` proves a list is signed by whoever it FLAGS as
   * author — without a pin, a member could forge a self-authored list at a
   * huge epoch and take over or brick the group. The first adopted list's
   * flagged-author key is pinned; every subsequently adopted list must
   * carry the same author key or it is rejected as
   * {@link GroupErrorCode.MembershipInvalid} BEFORE adoption — so a forged
   * max-epoch list can never wedge the epoch gate against later honest
   * lists. Unused on the author's own session (it never adopts).
   */
  private pinnedAuthorKey: PublicKey | null = null;
  /**
   * This member's display name, announced on every link that connects.
   * Mutable via {@link updateDisplayName}, which re-announces on every
   * connected link (and, on the author, re-signs this member's list entry).
   */
  private localDisplayName: string;
  private epoch = 0;
  private membershipValue: GroupMembership | null = null;
  private groupSafetyNumberValue: string | null = null;
  private closed = false;
  /**
   * Serializes author-side list mutations (member add on link connect,
   * kickMember) so concurrent link completions cannot mint two lists at the
   * same epoch — epoch strictly increases (§4.2).
   */
  private authorMutationQueue: Promise<void> = Promise.resolve();

  constructor(deps: GroupSessionDeps) {
    const maxMembers = deps.maxMembers ?? DEFAULT_MAX_GROUP_MEMBERS;
    if (!Number.isInteger(maxMembers) || maxMembers < 2 || maxMembers > MAX_GROUP_MEMBERS_HARD) {
      throw new GroupError(
        GroupErrorCode.Malformed,
        `maxMembers must be an integer in 2..${MAX_GROUP_MEMBERS_HARD}, got ${maxMembers}`,
      );
    }
    if (deps.authMode === AuthMode.Pake) {
      if (deps.pakeCode === undefined || !PAKE_CODE_PATTERN.test(deps.pakeCode)) {
        throw new GroupError(
          GroupErrorCode.Malformed,
          "a PAKE group requires pakeCode to be exactly 6 decimal digits",
        );
      }
      this.pakeCode = deps.pakeCode;
    } else {
      if (deps.pakeCode !== undefined) {
        throw new GroupError(
          GroupErrorCode.Malformed,
          "pakeCode must not be set on a safety-number group",
        );
      }
      this.pakeCode = null;
    }
    this.groupIdValue = deps.groupId;
    this.identity = deps.identity;
    this.authModeValue = deps.authMode;
    this.author = deps.isAuthor;
    // Every link orchestrator this session constructs (attachLinkTransport)
    // is wired to this decorator — ONE instance, shared across links, so its
    // session-scoped TOFU pins cover re-signaled links binding the same
    // derived pairwise id, and no link can ever write a conversation or
    // message row into the durable store (group state is runtime-only).
    this.repository = new PairwiseLinkRepository(deps.repository);
    this.maxMembers = maxMembers;
    this.brokerUrl = deps.brokerUrl ?? "";
    this.baseUrl = deps.baseUrl ?? "";
    this.socketFactory = deps.socketFactory ?? neverSocketFactory;
    this.enablePake = deps.enablePake ?? true;
    this.handshakeTimeoutMsOverride = deps.handshakeTimeoutMsOverride;
    this.pendingVerifyTimeoutMs = deps.pendingVerifyTimeoutMs ?? DEFAULT_PENDING_VERIFY_TIMEOUT_MS;
    this.handlers = deps.handlers ?? {};
    // Fail fast on an oversized display name: it is encoded into this
    // member's entry (author seed) or announced on every link, and the
    // membership codec would reject it at signing time.
    const localDisplayName = deps.displayName ?? "";
    const displayNameBytes = utf8Encoder.encode(localDisplayName);
    if (displayNameBytes.length > MAX_MEMBER_DISPLAY_NAME) {
      throw new GroupError(
        GroupErrorCode.Malformed,
        `displayName is ${displayNameBytes.length} UTF-8 bytes; cap is ${MAX_MEMBER_DISPLAY_NAME}`,
      );
    }
    this.localDisplayName = localDisplayName;
    if (deps.isAuthor) {
      // The author is canonical from the start: its first emitted list is
      // epoch 1 containing only itself (§4). The signature is produced
      // lazily on first gossip/request — signMembership is async and the
      // constructor is not.
      this.epoch = 1;
      this.members = [
        {
          identityPub: deps.identity.publicKey,
          isAuthor: true,
          displayName: localDisplayName,
        },
      ];
      void this.refreshGroupSafetyNumber().catch((err: unknown) => {
        this.handlers.onError?.(err);
      });
    }
  }

  get groupId(): GroupId {
    return this.groupIdValue;
  }

  get isAuthor(): boolean {
    return this.author;
  }

  /** The uniform auth mode negotiated on every link (§8). */
  get authMode(): AuthMode {
    return this.authModeValue;
  }

  /** Current membership epoch (0 until a non-author adopts its first list). */
  get memberEpoch(): number {
    return this.epoch;
  }

  /** The latest signed/verified member list, or null before one exists. */
  get membership(): GroupMembership | null {
    return this.membershipValue;
  }

  /** The canonical member entries of the current list. */
  get memberList(): readonly GroupMember[] {
    return this.members;
  }

  /** The epoch-bound group safety number (§5); null until one is computed. */
  get groupSafetyNumber(): string | null {
    return this.groupSafetyNumberValue;
  }

  /** Number of live links (connected or still handshaking). */
  get linkCount(): number {
    return this.links.size;
  }

  /** The v1 connection state of the link to `peerId`, or null if none. */
  linkState(peerId: PeerId): ConnectionState | null {
    return this.links.get(peerId)?.orchestrator.state ?? null;
  }

  /**
   * The authenticated identity key of the peer behind `peerId`'s link — set
   * once the link's v1 handshake reaches Connected; null when no link exists
   * or it has not authenticated yet. The group WebRTC manager consults this
   * for per-pair glare-role derivation on link renegotiation
   * (docs/plans/group-chat.md Phase 5) — it pins the last non-null answer
   * per seat so the identity-derived role survives the link reset that
   * precedes a re-offer. Before the identity is known, the
   * seated-member-offers rule holds.
   */
  linkPeerIdentity(peerId: PeerId): PublicKey | null {
    return this.links.get(peerId)?.peerIdentity ?? null;
  }

  /**
   * Drop the link to `peerId` if one exists (idempotent — an unknown peerId
   * is a no-op). Invoked by the WebRTC manager when the peer's signaling seat
   * or data channel is gone; membership itself is untouched — a re-seated
   * peer re-links and re-verifies against the list.
   */
  dropLink(peerId: PeerId): void {
    const link = this.links.get(peerId);
    if (link !== undefined) {
      this.closeLink(link);
    }
  }

  /**
   * Hand a freshly-opened data channel for `peerId` to a new link
   * orchestrator (protocol-v2 §3): the pairwise conversation id derives from
   * the peer's Hello identity inside the v1 handshake, so the peer's public
   * key need not be known here. Re-attaching an existing `peerId` first
   * closes the old link (re-signal after a drop).
   */
  attachLinkTransport(peerId: PeerId, transport: PeerTransport): void {
    if (this.closed) return;
    const existing = this.links.get(peerId);
    if (existing !== undefined) {
      this.closeLink(existing);
    }
    // A group of maxMembers members holds at most maxMembers-1 outbound
    // links; pending-verify links count toward the bound so an attacker
    // cannot park unbounded half-verified links (§7).
    if (this.links.size >= this.maxMembers - 1) {
      throw new GroupError(
        GroupErrorCode.MemberLimitReached,
        `group already holds ${this.links.size} links against the member cap ${this.maxMembers}`,
      );
    }
    const orchestrator = new ConversationOrchestrator({
      brokerUrl: this.brokerUrl,
      baseUrl: this.baseUrl,
      repository: this.repository,
      socketFactory: this.socketFactory,
      identity: this.identity,
      handlers: this.linkHandlers(peerId),
      useInternalSignaling: false,
      enablePake: this.enablePake,
      handshakeTimeoutMsOverride: this.handshakeTimeoutMsOverride,
      groupLinkConversationId: (peerIdentityKey: PublicKey) =>
        derivePairwiseConvId(this.groupIdValue, this.identity.publicKey, peerIdentityKey),
    });
    if (this.pakeCode !== null) {
      orchestrator.setPakeCode(this.pakeCode);
    }
    const link: GroupLink = {
      peerId,
      orchestrator,
      peerIdentity: null,
      verified: false,
      unlisted: false,
      announcedName: null,
      membershipRequested: false,
      pendingTimer: null,
    };
    this.links.set(peerId, link);
    link.pendingTimer = setTimeout(() => {
      this.onPendingVerifyTimeout(link);
    }, this.pendingVerifyTimeoutMs);
    try {
      orchestrator.beginGroupLinkSession();
      orchestrator.attachTransport(transport);
    } catch (err) {
      this.links.delete(peerId);
      if (link.pendingTimer !== null) {
        clearTimeout(link.pendingTimer);
        link.pendingTimer = null;
      }
      throw err;
    }
  }

  /**
   * Fan a text frame out over every VERIFIED connected link (§6). Members
   * that are offline or still pending simply miss the message — there is no
   * offline delivery.
   */
  async sendText(text: string): Promise<void> {
    if (this.closed) return;
    await Promise.all(this.sendTargets().map((link) => link.orchestrator.sendText(text)));
  }

  /**
   * One independent v1 file transfer per verified connected link (§6 — no
   * group-wide transfer id space). Returns each link's transfer id keyed by
   * peerId.
   */
  async sendFile(data: Uint8Array, name: string, mimeType: string): Promise<Map<PeerId, number>> {
    const results = new Map<PeerId, number>();
    if (this.closed) return results;
    await Promise.all(
      this.sendTargets().map(async (link) => {
        results.set(link.peerId, await link.orchestrator.sendFile(data, name, mimeType));
      }),
    );
    return results;
  }

  /** Ask the member behind `peerId`'s link for the current member list. */
  async requestMembership(peerId: PeerId): Promise<void> {
    const link = this.links.get(peerId);
    if (link === undefined || link.orchestrator.state !== ConnectionState.Connected) {
      throw new GroupError(
        GroupErrorCode.NoEstablishedLink,
        `no established link for peerId ${peerId}`,
      );
    }
    link.membershipRequested = true;
    try {
      await link.orchestrator.sendControlFrame(
        ControlSubtype.GroupMembershipRequest,
        new Uint8Array(0),
      );
    } catch (err) {
      // Reset the latch so a later request can re-ask — the same failure
      // discipline as requestMembershipOnLink. The rejection still
      // propagates to the caller of this public method.
      link.membershipRequested = false;
      throw err;
    }
  }

  /**
   * Author-only removal (§4): drop the member, bump epoch, re-sign, gossip
   * the new list, then close the removed member's link. The removed member
   * learns of its own removal from the gossiped list and leaves. A missing
   * identity is an idempotent no-op; removing the author itself is refused
   * (the list must always carry exactly one author entry).
   */
  async kickMember(identityPub: PublicKey): Promise<void> {
    if (!this.author) {
      throw new GroupError(GroupErrorCode.NotAuthor, "only the group author may remove members");
    }
    if (this.closed) return;
    if (ctEqual(identityPub, this.identity.publicKey)) {
      throw new GroupError(
        GroupErrorCode.MembershipInvalid,
        "the author cannot remove itself from the group",
      );
    }
    await this.enqueueAuthorMutation(async () => {
      if (this.closed) return;
      const target = this.findMember(identityPub);
      if (target === undefined) return; // already gone — idempotent
      const next = this.members.filter((m) => !ctEqual(m.identityPub, identityPub));
      await this.applyMembershipChange(next, { joined: [], removed: [target] });
    });
  }

  /**
   * Send `leave` on every link and tear the whole session down. Idempotent;
   * post-leave mutating calls are no-ops. Fires {@link GroupSessionHandlers.onClosed}
   * once the links are closed so the host can pair this with the WebRTC
   * manager's teardown — including on self-eject (kick), which otherwise
   * leaves the manager's broker seat and peer connections running.
   */
  leave(): void {
    if (this.closed) return;
    this.closed = true;
    for (const link of Array.from(this.links.values())) {
      this.closeLink(link);
    }
    this.handlers.onClosed?.();
  }

  /**
   * The v1 connection state of the link to the member whose identity key is
   * `identityPub`, or null when no live link carries that identity. Covers
   * pending-verify links too (the verified-link index is consulted first,
   * then the authenticated-but-unverified links), so the UI can render a
   * member's link state before verification completes.
   */
  memberLinkState(identityPub: PublicKey): ConnectionState | null {
    const keyId = pubKeyId(identityPub);
    const verified = this.linksByIdentity.get(keyId);
    if (verified !== undefined) {
      return verified.orchestrator.state;
    }
    for (const link of this.links.values()) {
      if (link.peerIdentity !== null && pubKeyId(link.peerIdentity) === keyId) {
        return link.orchestrator.state;
      }
    }
    return null;
  }

  /**
   * Change this member's own display name (protocol-v2 §4.1): validate the
   * byte cap, re-announce on every connected link, and — on the author —
   * fold the new name into our own member entry and re-sign the list so the
   * canonical entry converges instead of relying on announcements alone.
   * No-op when the name is unchanged or the session has left.
   *
   * Note on clearing: an empty name is a valid local value, but the codec
   * treats a 0-length `identity_announcement` payload as "no announcement",
   * so clearing the name does not propagate to peers' stored entries — only
   * non-empty renames are gossiped.
   */
  updateDisplayName(name: string): void {
    const bytes = utf8Encoder.encode(name);
    if (bytes.length > MAX_MEMBER_DISPLAY_NAME) {
      throw new GroupError(
        GroupErrorCode.Malformed,
        `displayName is ${bytes.length} UTF-8 bytes; cap is ${MAX_MEMBER_DISPLAY_NAME}`,
      );
    }
    if (name === this.localDisplayName) return;
    // Post-leave the session must be fully inert: check `closed` BEFORE
    // mutating localDisplayName so a rename after leave() cannot quietly
    // diverge the member entry from what was last announced/signed.
    if (this.closed) return;
    this.localDisplayName = name;
    for (const link of this.links.values()) {
      if (link.orchestrator.state === ConnectionState.Connected) {
        this.announceDisplayName(link);
      }
    }
    if (this.author) {
      this.enqueueAuthorMutation(async () => {
        if (this.closed) return;
        const self = this.findMember(this.identity.publicKey);
        if (self === undefined || self.displayName === name) return;
        const keyId = pubKeyId(this.identity.publicKey);
        const next = this.members.map((m) =>
          pubKeyId(m.identityPub) === keyId ? { ...m, displayName: name } : m,
        );
        await this.applyMembershipChange(next, { joined: [], removed: [] });
      }).catch((err: unknown) => {
        this.handlers.onError?.(err);
      });
    }
  }

  // --- internal link bookkeeping ---

  private sendTargets(): GroupLink[] {
    const targets: GroupLink[] = [];
    for (const link of this.links.values()) {
      if (link.verified && link.orchestrator.state === ConnectionState.Connected) {
        targets.push(link);
      }
    }
    return targets;
  }

  /**
   * Per-link orchestrator handlers. Each closure resolves the link record
   * from the map at fire time (by immutable peerId) so events that arrive
   * after the link was replaced or closed are dropped instead of mutating
   * the wrong record.
   */
  private linkHandlers(peerId: PeerId): OrchestratorHandlers {
    const lookup = (): GroupLink | undefined => this.links.get(peerId);
    return {
      onStateChange: (state: ConnectionState): void => {
        this.handlers.onLinkState?.(peerId, state);
        const link = lookup();
        if (link === undefined) return;
        if (state === ConnectionState.Connected) {
          this.onLinkConnected(link);
        } else if (state === ConnectionState.Disconnected) {
          this.onLinkDisconnected(link);
        }
      },
      onMessage: (message: ConversationMessage): void => {
        const link = lookup();
        // Content is only ever attributed to a verified member identity;
        // frames from a pending-verify link are dropped (§4.2/§6).
        if (link === undefined || link.peerIdentity === null || !link.verified) return;
        this.handlers.onMessage?.(link.peerIdentity, message.text, message.timestamp);
      },
      onFileReceived: (file: ReceivedFile): void => {
        const link = lookup();
        if (link === undefined || link.peerIdentity === null || !link.verified) return;
        this.handlers.onFileReceived?.(link.peerIdentity, file);
      },
      onControlFrame: (subtype: ControlSubtype, payload: Uint8Array): void => {
        const link = lookup();
        if (link === undefined) return;
        this.onLinkControlFrame(link, subtype, payload);
      },
      onError: (error: unknown): void => {
        this.handlers.onError?.(error);
      },
    };
  }

  private onLinkConnected(link: GroupLink): void {
    const peerIdentity = link.orchestrator.peerIdentityPublicKey;
    if (peerIdentity === null) {
      // Defensive: peerIdentityPublicKey is populated before Connected —
      // this should be unreachable, but never bind a link without it.
      this.handlers.onError?.(
        new GroupError(
          GroupErrorCode.UnknownLinkIdentity,
          "link reached Connected without an authenticated peer identity",
        ),
      );
      this.closeLink(link);
      return;
    }
    link.peerIdentity = peerIdentity;
    const keyId = pubKeyId(peerIdentity);
    const occupant = this.linksByIdentity.get(keyId);
    if (occupant !== undefined && occupant !== link) {
      this.handlers.onError?.(
        new GroupError(
          GroupErrorCode.UnknownLinkIdentity,
          "a second link authenticated the same member identity; closing it",
        ),
      );
      this.closeLink(link);
      return;
    }
    // Announce our display name on every established link (protocol-v2 §4.1):
    // the author folds the peer's announcement into the member entry it
    // signs; members store it for attribution. Fire-and-forget — a send
    // failure on a fresh link must not tear the link down here.
    this.announceDisplayName(link);
    if (this.author) {
      if (this.isMemberIdentity(peerIdentity)) {
        // Re-signal of a seated member: no membership change.
        this.markVerified(link, keyId);
        return;
      }
      if (this.members.length >= this.maxMembers) {
        this.handlers.onError?.(
          new GroupError(
            GroupErrorCode.MemberLimitReached,
            `group already holds ${this.maxMembers} members; refusing new link`,
          ),
        );
        this.closeLink(link);
        return;
      }
      // A completed link handshake IS the join (§4): the bearer-link
      // semantics are identical to 1:1 — whoever completes a link is a
      // member. Add them, bump epoch, sign, gossip to every connected link.
      this.markVerified(link, keyId);
      this.enqueueAuthorMutation(async () => {
        if (this.closed || this.links.get(link.peerId) !== link) return;
        await this.authorAddMember(link);
      }).catch((err: unknown) => {
        this.handlers.onError?.(err);
      });
      return;
    }
    if (this.membershipValue !== null) {
      if (this.isMemberIdentity(peerIdentity)) {
        this.markVerified(link, keyId);
      } else {
        // §4.2 "link identity must be listed": FLAG, do not close — this may
        // be a just-joined member whose covering epoch has not reached us
        // yet. Ask the peer for its (possibly newer) list; the next adopted
        // list either graduates the link or evicts it, and the
        // pending-verify timer remains the backstop.
        link.unlisted = true;
        void this.requestMembershipOnLink(link);
      }
      return;
    }
    // Pending-verify (§4.2): the link stays open — group control traffic may
    // flow — but content is gated until the author's list lands and proves
    // this peer a member. Ask for the list on this link; the pending timer
    // armed at attach bounds the wait.
    void this.requestMembershipOnLink(link);
  }

  private onLinkDisconnected(link: GroupLink): void {
    this.unlink(link);
  }

  private onLinkControlFrame(link: GroupLink, subtype: ControlSubtype, payload: Uint8Array): void {
    if (subtype === ControlSubtype.GroupMembership) {
      void this.handleInboundMembership(payload).catch((err: unknown) => {
        this.handlers.onError?.(err);
      });
      return;
    }
    if (subtype === ControlSubtype.GroupMembershipRequest) {
      void this.answerMembershipRequest(link).catch((err: unknown) => {
        this.handlers.onError?.(err);
      });
      return;
    }
    if (subtype === ControlSubtype.IdentityAnnouncement) {
      const name = decodeDisplayName(payload);
      if (name === null) return;
      link.announcedName = name;
      // The author owns the member list: fold the announced name into the
      // member's entry, re-sign, and gossip — but only when it changed (an
      // unchanged or unlisted announcement is a no-op).
      if (this.author && link.peerIdentity !== null) {
        const member = this.findMember(link.peerIdentity);
        if (member !== undefined && member.displayName !== name) {
          this.refreshMemberDisplayName(link, name);
        }
      }
      return;
    }
    if (subtype === ControlSubtype.Leave) {
      this.closeLink(link);
      return;
    }
    // SessionKeyExchange / SafetyNumberAnnouncement / PakeShare are not
    // session-owned; TransferCancel is consumed inside the framing layer.
  }

  /**
   * Send our display name as an `identity_announcement` control frame on a
   * freshly-Connected link. The peer's announcement arrives the same way and
   * is folded into the member list by the author (see onLinkControlFrame),
   * so every member's `memberEntry.displayName` converges on what each
   * member announced. Nothing is sent for an empty name — it is the wire
   * default.
   */
  private announceDisplayName(link: GroupLink): void {
    if (this.localDisplayName.length === 0) return;
    link.orchestrator
      .sendControlFrame(
        ControlSubtype.IdentityAnnouncement,
        utf8Encoder.encode(this.localDisplayName),
      )
      .catch((err: unknown) => {
        this.handlers.onError?.(err);
      });
  }

  /**
   * Author-side display-name refresh: rewrite the member's entry with the
   * announced name and run the standard mutation path (encode + sign + bump
   * + gossip). Serialized with joins/kicks on {@link authorMutationQueue}
   * and re-checked inside the mutation — a stale rename landing after the
   * member left (or after a newer name already won) is a no-op.
   */
  private refreshMemberDisplayName(link: GroupLink, name: string): void {
    const identityPub = link.peerIdentity;
    if (identityPub === null) return;
    this.enqueueAuthorMutation(async () => {
      if (this.closed || this.links.get(link.peerId) !== link) return;
      const member = this.findMember(identityPub);
      if (member === undefined || member.displayName === name) return;
      const keyId = pubKeyId(identityPub);
      const next = this.members.map((m) =>
        pubKeyId(m.identityPub) === keyId ? { ...m, displayName: name } : m,
      );
      await this.applyMembershipChange(next, { joined: [], removed: [] });
    }).catch((err: unknown) => {
      this.handlers.onError?.(err);
    });
  }

  private onPendingVerifyTimeout(link: GroupLink): void {
    link.pendingTimer = null;
    if (this.closed || this.links.get(link.peerId) !== link || link.verified) {
      return;
    }
    this.handlers.onError?.(
      new GroupError(
        GroupErrorCode.UnknownLinkIdentity,
        `link to peerId ${link.peerId} stayed unverified for ${this.pendingVerifyTimeoutMs}ms; closing`,
      ),
    );
    this.closeLink(link);
  }

  // --- membership ---

  private async requestMembershipOnLink(link: GroupLink): Promise<void> {
    if (link.membershipRequested || this.links.get(link.peerId) !== link) return;
    link.membershipRequested = true;
    try {
      await link.orchestrator.sendControlFrame(
        ControlSubtype.GroupMembershipRequest,
        new Uint8Array(0),
      );
    } catch (err) {
      link.membershipRequested = false;
      this.handlers.onError?.(err);
    }
  }

  /**
   * §4.2 epoch gate: strictly increasing — regressed or replayed lists are
   * discarded. Equality is routine (the same list arriving over two links)
   * and quiet; strictly-lower is a replay signal worth surfacing. Runs twice
   * per inbound list — before signature verification AND again after the
   * verify await, which suspends long enough for a newer list to land.
   */
  private acceptsEpoch(epoch: number): boolean {
    if (epoch > this.epoch) return true;
    if (epoch < this.epoch) {
      this.handlers.onError?.(
        new GroupError(
          GroupErrorCode.EpochRegression,
          `received membership epoch ${epoch} regresses below current epoch ${this.epoch}; discarded`,
        ),
      );
    }
    return false;
  }

  /**
   * Inbound `group_membership` (§4.1): decode structurally, gate on group id
   * and epoch, verify the author's signature, then adopt wholesale. The
   * author ignores inbound lists entirely — its own list is canonical.
   */
  private async handleInboundMembership(payload: Uint8Array): Promise<void> {
    if (this.closed || this.author) return;
    const decoded = decodeMembership(payload, this.maxMembers);
    if (!ctEqual(decoded.groupId, this.groupIdValue)) return;
    if (!this.acceptsEpoch(decoded.epoch)) return;
    if (!(await verifyMembership(decoded))) {
      this.handlers.onError?.(
        new GroupError(
          GroupErrorCode.MembershipInvalid,
          "group_membership signature failed verification; list discarded",
        ),
      );
      return;
    }
    // Re-check after the verify suspension: a higher-epoch list adopted
    // meanwhile (or the session left) makes this valid-but-stale list a
    // regression — adopting it now would move the epoch backwards, replay
    // reversed join/leave diffs, and spuriously close links.
    if (this.closed || !this.acceptsEpoch(decoded.epoch)) return;
    // Author-key TOFU pin: verifyMembership only proves the list is signed
    // by its own flagged-author entry — a member can forge a self-authored
    // list that verifies cleanly. Pin the flagged-author key at the first
    // adoption and require every later adopted list to carry it, else a
    // forged high-epoch list could take over (or, at epoch UINT32_MAX, brick
    // the group against all honest lists). Rejection happens BEFORE adoption
    // so the forged epoch never moves this.epoch.
    const authorEntry = decoded.members.find((m) => m.isAuthor);
    if (authorEntry === undefined) {
      // Unreachable: decodeMembership enforces exactly one author entry.
      this.handlers.onError?.(
        new GroupError(
          GroupErrorCode.MembershipInvalid,
          "group_membership carries no author-flagged entry; list discarded",
        ),
      );
      return;
    }
    if (this.pinnedAuthorKey !== null && !ctEqual(this.pinnedAuthorKey, authorEntry.identityPub)) {
      this.handlers.onError?.(
        new GroupError(
          GroupErrorCode.MembershipInvalid,
          `group_membership epoch ${decoded.epoch} is authored by a different identity than the pinned group author; list discarded`,
        ),
      );
      return;
    }
    this.adoptMembership(decoded);
  }

  /**
   * Adopt a verified list (§4.2 "newest list wins"): replace the member
   * set, emit diffs, close links to removed members, verify every connected
   * link against the new list, recompute the group safety number. If the
   * author dropped us, the session leaves.
   */
  private adoptMembership(membership: GroupMembership): void {
    const prev = this.members;
    // TOFU: the first adopted list pins the group author's identity key;
    // handleInboundMembership already enforced the pin for every later list.
    if (this.pinnedAuthorKey === null) {
      const authorEntry = membership.members.find((m) => m.isAuthor);
      if (authorEntry !== undefined) {
        this.pinnedAuthorKey = authorEntry.identityPub;
      }
    }
    this.members = [...membership.members];
    this.epoch = membership.epoch;
    this.membershipValue = membership;
    const removed = removedMembers(prev, this.members);
    for (const removedMember of removed) {
      const victim = this.linksByIdentity.get(pubKeyId(removedMember.identityPub));
      if (victim !== undefined) {
        this.closeLink(victim);
      }
      this.handlers.onMemberLeft?.(removedMember.identityPub);
    }
    for (const added of addedMembers(prev, this.members)) {
      this.handlers.onMemberJoined?.(added);
    }
    // Reconcile connected links against the new list (§4.2 "link identity
    // must be listed"): pending-verify links whose peer is now listed
    // graduate. Peers absent from the list are FLAGGED on first sight and
    // closed only when a newer list still excludes them — a just-joined
    // member's link must survive until the epoch covering it lands (the
    // pending-verify timer is the backstop).
    for (const link of Array.from(this.links.values())) {
      // Skip links already closed by the removal pass above: the loop
      // iterates a snapshot of the map taken before those closes.
      if (this.links.get(link.peerId) !== link) continue;
      const peer = link.peerIdentity;
      if (peer === null) continue;
      if (this.isMemberIdentity(peer)) {
        if (!link.verified) {
          this.markVerified(link, pubKeyId(peer));
        }
        continue;
      }
      if (!link.verified && !link.unlisted) {
        link.unlisted = true;
        continue;
      }
      this.handlers.onError?.(
        new GroupError(
          GroupErrorCode.UnknownLinkIdentity,
          `link peer identity is still absent from the adopted member list (epoch ${membership.epoch}); closing link`,
        ),
      );
      this.closeLink(link);
    }
    void this.refreshGroupSafetyNumber().catch((err: unknown) => {
      this.handlers.onError?.(err);
    });
    this.handlers.onMembershipChanged?.(membership);
    // Self-eject only on a genuine kick: we were IN the previous list and
    // are absent from the new one. A fresh joiner adopting a stale pre-join
    // list (a `group_membership_request` answered before the author's add
    // committed, or a member's older copy) must NOT leave — it holds the
    // list and waits for the epoch containing itself, which the author's
    // gossip-on-bump delivers. Re-asking every connected link is the
    // accelerant for a responder that already holds the covering epoch.
    const selfRemoved = removed.some((m) => ctEqual(m.identityPub, this.identity.publicKey));
    if (selfRemoved) {
      this.leave();
      return;
    }
    if (!this.isMemberIdentity(this.identity.publicKey)) {
      for (const link of this.links.values()) {
        if (link.orchestrator.state !== ConnectionState.Connected) continue;
        link.membershipRequested = false;
        void this.requestMembershipOnLink(link);
      }
    }
  }

  /**
   * Any member holding a list answers a `group_membership_request` (§4.1).
   * Members re-encode the last verified list — byte-identical to what was
   * received because decodeMembership rejects non-canonical input; the
   * author signs the current list on demand.
   */
  private async answerMembershipRequest(link: GroupLink): Promise<void> {
    let membership = this.membershipValue;
    if (membership === null) {
      if (!this.author || this.members.length === 0) return;
      membership = await this.signCurrentMembership();
    }
    if (
      this.links.get(link.peerId) !== link ||
      link.orchestrator.state !== ConnectionState.Connected
    ) {
      return;
    }
    await link.orchestrator.sendControlFrame(
      ControlSubtype.GroupMembership,
      encodeMembership(membership),
    );
  }

  /**
   * Produce the author's signed list for the CURRENT members/epoch. Reuses
   * the cached signed list when the epoch has not moved, and never lets an
   * in-flight signing overwrite a newer list that landed meanwhile.
   */
  private async signCurrentMembership(): Promise<GroupMembership> {
    const existing = this.membershipValue;
    if (existing !== null && existing.epoch === this.epoch) {
      return existing;
    }
    const epoch = this.epoch;
    const members = this.members;
    const body = encodeMembershipBody(this.groupIdValue, epoch, members, this.maxMembers);
    const signature = await signMembership(body, this.identity.privateKey);
    const membership: GroupMembership = {
      groupId: this.groupIdValue,
      epoch,
      members,
      signature,
    };
    const current = this.membershipValue;
    if (current === null || membership.epoch > current.epoch) {
      this.membershipValue = membership;
    }
    return membership;
  }

  /** Author-side join: append the link's peer, re-sign, gossip. */
  private async authorAddMember(link: GroupLink): Promise<void> {
    const peerIdentity = link.peerIdentity;
    if (peerIdentity === null || this.isMemberIdentity(peerIdentity)) return;
    if (this.members.length >= this.maxMembers) {
      // Re-check inside the serialized mutation: a second link completing
      // while this add was queued may have already consumed the last seat.
      this.handlers.onError?.(
        new GroupError(
          GroupErrorCode.MemberLimitReached,
          `group already holds ${this.maxMembers} members; refusing new link`,
        ),
      );
      this.closeLink(link);
      return;
    }
    const member: GroupMember = {
      identityPub: peerIdentity,
      isAuthor: false,
      displayName: link.announcedName ?? "",
    };
    await this.applyMembershipChange([...this.members, member], {
      joined: [member],
      removed: [],
    });
  }

  /**
   * Author-side list mutation: encode + sign FIRST (so a cap violation fails
   * before any state moves), then swap the member set, bump epoch, emit
   * diffs, gossip the signed list to every connected link — INCLUDING a
   * removed member's, so it learns of its own removal — and only then close
   * removed members' links and recompute the group safety number.
   */
  private async applyMembershipChange(
    next: GroupMember[],
    diff: { joined: GroupMember[]; removed: GroupMember[] },
  ): Promise<void> {
    const body = encodeMembershipBody(this.groupIdValue, this.epoch + 1, next, this.maxMembers);
    const signature = await signMembership(body, this.identity.privateKey);
    this.members = next;
    this.epoch += 1;
    const membership: GroupMembership = {
      groupId: this.groupIdValue,
      epoch: this.epoch,
      members: next,
      signature,
    };
    this.membershipValue = membership;
    for (const joined of diff.joined) {
      this.handlers.onMemberJoined?.(joined);
    }
    await this.gossipMembership(membership);
    for (const removed of diff.removed) {
      const victim = this.linksByIdentity.get(pubKeyId(removed.identityPub));
      if (victim !== undefined) {
        this.closeLink(victim);
      }
      this.handlers.onMemberLeft?.(removed.identityPub);
    }
    await this.refreshGroupSafetyNumber();
    this.handlers.onMembershipChanged?.(membership);
  }

  private async gossipMembership(membership: GroupMembership): Promise<void> {
    const payload = encodeMembership(membership);
    const sends: Promise<void>[] = [];
    for (const link of this.links.values()) {
      if (link.orchestrator.state !== ConnectionState.Connected) continue;
      sends.push(
        link.orchestrator
          .sendControlFrame(ControlSubtype.GroupMembership, payload)
          .catch((err: unknown) => {
            this.handlers.onError?.(err);
          }),
      );
    }
    await Promise.all(sends);
  }

  /**
   * Serialized author mutations: tasks run one at a time in arrival order so
   * concurrent link completions and kicks cannot mint two lists at one
   * epoch. A rejected task does not poison the queue.
   */
  private enqueueAuthorMutation(task: () => Promise<void>): Promise<void> {
    const run = this.authorMutationQueue.then(task, task);
    this.authorMutationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async refreshGroupSafetyNumber(): Promise<void> {
    this.groupSafetyNumberValue = await computeGroupSafetyNumber(
      this.groupIdValue,
      this.epoch,
      this.members.map((m) => m.identityPub),
    );
  }

  // --- small shared helpers ---

  private markVerified(link: GroupLink, keyId: string): void {
    link.verified = true;
    link.unlisted = false;
    this.linksByIdentity.set(keyId, link);
    if (link.pendingTimer !== null) {
      clearTimeout(link.pendingTimer);
      link.pendingTimer = null;
    }
  }

  private isMemberIdentity(identityPub: Uint8Array): boolean {
    return this.findMember(identityPub) !== undefined;
  }

  private findMember(identityPub: Uint8Array): GroupMember | undefined {
    const keyId = pubKeyId(identityPub);
    return this.members.find((m) => pubKeyId(m.identityPub) === keyId);
  }

  /** Drop the link record from both indexes and disarm its pending timer. */
  private unlink(link: GroupLink): void {
    if (this.links.get(link.peerId) !== link) return;
    this.links.delete(link.peerId);
    if (link.peerIdentity !== null) {
      const keyId = pubKeyId(link.peerIdentity);
      if (this.linksByIdentity.get(keyId) === link) {
        this.linksByIdentity.delete(keyId);
      }
    }
    if (link.pendingTimer !== null) {
      clearTimeout(link.pendingTimer);
      link.pendingTimer = null;
    }
  }

  /**
   * Remove the link and tell its orchestrator to leave: when Connected this
   * emits the encrypted `leave` control frame first, then tears down — the
   * resulting Disconnected state transition still fires onLinkState for
   * observers.
   */
  private closeLink(link: GroupLink): void {
    if (this.links.get(link.peerId) !== link) return;
    this.unlink(link);
    try {
      link.orchestrator.leave();
    } catch (err) {
      this.handlers.onError?.(err);
    }
  }
}

/**
 * Decode an `identity_announcement` payload as a member display name: UTF-8,
 * at most {@link MAX_MEMBER_DISPLAY_NAME} bytes. Anything else (invalid
 * UTF-8, oversized) yields null — the author falls back to an empty name.
 */
function decodeDisplayName(payload: Uint8Array): string | null {
  if (payload.length === 0 || payload.length > MAX_MEMBER_DISPLAY_NAME) {
    return null;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(payload);
  } catch {
    return null;
  }
}
