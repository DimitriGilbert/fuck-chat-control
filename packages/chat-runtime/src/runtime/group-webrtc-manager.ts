import { isValidPeerId } from "../broker/room-registry";
import { randomBytes } from "../crypto/primitives";
import { GroupError, GroupErrorCode } from "../group/errors";
import { encodePeerId } from "../group/types";
import type { PeerId } from "../group/types";
import { DEFAULT_MAX_GROUP_MEMBERS, MAX_GROUP_MEMBERS_HARD } from "../protocol/limits";
import type { PublicKey } from "../protocol/types";
import { GroupSignalingClient } from "../signaling/group-signaling-client";
import type { SignalingSocketFactory } from "../signaling/signaling-client";
import { deriveResumeGlareRole, isPolite } from "../signaling/state-machine";
import { toPeerTransport } from "../transport/peer-transport";
import type { PeerTransport } from "../transport/peer-transport";
import type {
  DataChannelTransport,
  IceCandidate,
  IceServer,
  PeerConnection,
  PeerConnectionFactory,
  PeerConnectionState,
  SessionDescription,
} from "../transport/types";

/**
 * The slice of {@link GroupSession} the manager drives. GroupSession
 * satisfies this contract structurally; tests inject a lightweight fake so
 * the signaling/negotiation logic is exercised without the full v1
 * orchestrator stack behind every link.
 */
export interface GroupLinkHost {
  /** Hand a freshly-opened data channel for `peerId` to the session. */
  attachLinkTransport(peerId: PeerId, transport: PeerTransport): void;
  /** Drop the link to `peerId` (seat gone, terminal transport failure). */
  dropLink(peerId: PeerId): void;
  /** The link's authenticated peer identity, or null before Connected. */
  linkPeerIdentity(peerId: PeerId): PublicKey | null;
  /** Tear the whole group session down (leave control on every link). */
  leave(): void;
}

export interface GroupWebrtcManagerOptions {
  /** The broker WebSocket URL the group signaling client dials. */
  readonly brokerUrl: string;
  /** The group id rendered as hex — it IS the broker room id (protocol-v2 §1). */
  readonly roomId: string;
  /**
   * Our own seat label for the broker room. Ephemeral (protocol-v2 §1 —
   * never a cryptographic identity); when omitted the manager mints a
   * CSPRNG 8-byte peerId at construction. Exposed via {@link ownPeerId}.
   */
  readonly peerId?: PeerId;
  /**
   * This device's identity public key — the local end of the pairwise key
   * comparison {@link deriveResumeGlareRole} applies once a link's peer
   * identity is known.
   */
  readonly localIdentityPublicKey: PublicKey;
  /** The group session each open data channel is attached to. */
  readonly session: GroupLinkHost;
  /** Factory for the underlying WebSocket (testability). */
  readonly socketFactory: SignalingSocketFactory;
  /**
   * Platform-supplied factory constructing one peer connection per member
   * pair — the same neutral {@link PeerConnectionFactory} seam the 1:1
   * bridge uses; the web app injects `(opts) => new WebRtcAdapter(opts)`.
   */
  readonly peerConnectionFactory: PeerConnectionFactory;
  /** ICE servers. Empty array = loopback-only. */
  readonly iceServers?: readonly IceServer[];
  /** Configured member cap (GROUP_MAX_MEMBERS); defaults to 8, ceiling 16. */
  readonly maxMembers?: number;
  /** Per-peer transport connectivity transitions, for the controller layer. */
  readonly onPeerLinkState?: (peerId: PeerId, state: PeerConnectionState) => void;
  /** The broker socket closed — every seated link was already surfaced as a leave. */
  readonly onSignalingClosed?: () => void;
  /** Non-fatal manager errors (signaling errors, attach rejections, caps). */
  readonly onError?: (error: unknown) => void;
}

/**
 * One member pair's negotiation state: the peer connection serving that
 * pair, the data channel owned by whichever side created it, and the
 * perfect-negotiation latches mirroring the 1:1 bridge's NegotiationState.
 */
interface PeerLink {
  readonly peerId: PeerId;
  /**
   * The live peer connection for this pair. Not readonly: a seat turnover or
   * a terminal ICE failure swaps in a fresh one (a failed RTCPeerConnection
   * cannot restart ICE — same rationale as the 1:1 bridge's reconnect()).
   * Adapter callbacks are identity-guarded through the links map, so events
   * in flight from a replaced adapter are dropped.
   */
  pc: PeerConnection;
  /** The data channel this negotiation adopted, if any. */
  channel: DataChannelTransport | null;
  /**
   * True when OUR join to the room preceded this peer's — we received the
   * broker's `join` notification and originate (re)offers to them. The
   * newcomer side (link created on an inbound offer) is false. This is the
   * deterministic single-offerer rule: seated members offer to the newcomer
   * (protocol-v2 §2.1), so initial establishment never needs glare
   * resolution.
   */
  seatedByUs: boolean;
  /** A local offer has been initiated; awaiting its answer or a glare outcome. */
  localOfferInFlight: boolean;
  /** True once this pair's channel was handed to the session. */
  attached: boolean;
  /**
   * Per-pair negotiation epoch (the bridge's R7F8 guard): bumped on every
   * rebuild/teardown so an async offer/answer coroutine parked mid-await
   * bails instead of acting on the fresh connection with stale SDP.
   */
  generation: number;
}

/** Own peerId byte length on the wire: 8 CSPRNG bytes → 16 lowercase hex chars. */
const OWN_PEER_ID_BYTES = 8;

/**
 * Owns ONE group's broker seat plus the mesh of per-member peer connections
 * (protocol-v2 §2). The manager multiplexes signaling over a single
 * {@link GroupSignalingClient} socket and runs one peer connection per
 * member pair; each opened data channel is handed to the session via
 * {@link GroupLinkHost.attachLinkTransport} where it becomes a full
 * protocol-v1 link.
 *
 * Offer/answer direction is deterministic: the seated member offers to the
 * newcomer (the broker only notifies already-seated members of a join), so
 * no glare resolver is needed for initial establishment. Renegotiation —
 * seat turnover under the same peerId, or a fresh offer after a terminal
 * ICE failure — can produce crossing offers; the pair then resolves by
 * politeness (docs/plans/group-chat.md Phase 5): identity-key derived
 * ({@link deriveResumeGlareRole}, the same two-key rule the frozen
 * protocol fixes for 1:1 resume) once the pair's peer identity is known,
 * else the deterministic fallback that the larger peerId is polite. Unlike
 * the 1:1 bridge the broker socket stays open for the life of the group —
 * members never vacate their seat — so there is no post-handshake teardown
 * grace here.
 */
export class GroupWebrtcManager {
  private readonly options: GroupWebrtcManagerOptions;
  private readonly signaling: GroupSignalingClient;
  private readonly ownPeerIdValue: PeerId;
  private readonly maxPeers: number;
  private readonly links = new Map<PeerId, PeerLink>();
  /**
   * Last-known authenticated identity per peerId — the glare-role input
   * {@link politeFor} needs on a REBUILT link. The session drops its link
   * (and the handshake-authenticated identity with it) on every rebuild —
   * {@link resetLink} calls `dropLink` — so a live lookup is null exactly
   * when a crossing re-offer produces glare. The manager pins the last
   * non-null identity the session reported for the seat; entries clear
   * only in {@link teardownLink} (the seat itself is gone), never on a
   * link reset.
   */
  private readonly lastKnownPeerIdentities = new Map<PeerId, PublicKey>();
  private closed = false;
  private started = false;

  public constructor(options: GroupWebrtcManagerOptions) {
    const maxMembers = options.maxMembers ?? DEFAULT_MAX_GROUP_MEMBERS;
    if (!Number.isInteger(maxMembers) || maxMembers < 2 || maxMembers > MAX_GROUP_MEMBERS_HARD) {
      throw new GroupError(
        GroupErrorCode.Malformed,
        `maxMembers must be an integer in 2..${MAX_GROUP_MEMBERS_HARD}, got ${maxMembers}`,
      );
    }
    this.options = options;
    // A group of maxMembers seats holds at most maxMembers-1 outbound links
    // — the same bound the session enforces on its link map.
    this.maxPeers = maxMembers - 1;
    this.ownPeerIdValue = options.peerId ?? generatePeerId();
    this.signaling = new GroupSignalingClient({
      brokerUrl: options.brokerUrl,
      roomId: options.roomId,
      socketFactory: options.socketFactory,
      handlers: {
        onPeerJoin: (peerId: string): void => {
          this.handlePeerJoin(peerId);
        },
        onPeerLeave: (peerId: string): void => {
          this.handlePeerLeave(peerId);
        },
        onOffer: (fromPeerId: string, sdp: unknown): void => {
          this.handleRemoteOffer(fromPeerId, sdp);
        },
        onAnswer: (fromPeerId: string, sdp: unknown): void => {
          this.handleAnswer(fromPeerId, sdp);
        },
        onIce: (fromPeerId: string, candidate: unknown): void => {
          this.handleIce(fromPeerId, candidate);
        },
        onClose: (): void => {
          this.options.onSignalingClosed?.();
        },
        onError: (error: unknown): void => {
          this.options.onError?.(error);
        },
      },
    });
  }

  /** Our seat label in the broker room — generated or caller-supplied. */
  public get ownPeerId(): PeerId {
    return this.ownPeerIdValue;
  }

  /** Number of live per-pair peer connections (assertion/test seam). */
  public get peerConnectionCount(): number {
    return this.links.size;
  }

  /**
   * Seat this member in the broker room: the signaling socket dials and, on
   * open, sends `{t:"join", roomId, mode:"group", peerId}`. Idempotent — a
   * second call on a started or closed manager is a no-op (the signaling
   * client itself rejects a double-dial).
   */
  public connect(): void {
    if (this.closed || this.started) return;
    this.started = true;
    this.signaling.connect(this.ownPeerIdValue);
  }

  /**
   * Leave the group: `session.leave()` FIRST (it emits the `leave` control
   * frame on every still-open link, so the data channels must outlive it),
   * then the broker `leave` + socket teardown, then every peer connection.
   * Idempotent.
   */
  public leave(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.options.session.leave();
    } catch (err) {
      this.options.onError?.(err);
    }
    try {
      this.signaling.leaveAndClose();
    } catch {
      // best-effort
    }
    // teardownLink also calls session.dropLink — a no-op after leave(), kept
    // so the single teardown path stays uniform.
    for (const link of Array.from(this.links.values())) {
      this.teardownLink(link);
    }
  }

  /** Idempotent teardown; alias of {@link leave} for bridge parity. */
  public close(): void {
    this.leave();
  }

  // --- signaling handlers ---

  private handlePeerJoin(rawPeerId: string): void {
    if (this.closed) return;
    const peerId = this.toPeerId(rawPeerId);
    if (peerId === null) return;
    let link = this.links.get(peerId);
    if (link === undefined) {
      // Defense in depth: the broker also caps the room, but the manager
      // never holds more than maxMembers-1 peer connections regardless.
      if (this.links.size >= this.maxPeers) {
        this.options.onError?.(
          new GroupError(
            GroupErrorCode.MemberLimitReached,
            `group already holds ${this.links.size} peer connections against the member cap; ignoring join for ${peerId}`,
          ),
        );
        return;
      }
      link = this.createLink(peerId);
    } else {
      // Seat turnover (R5F1, group edition): a join for an already-tracked
      // peerId means the occupant re-seated — its silent leave is never
      // relayed. The existing connection negotiated with the departed
      // socket's peer, so rebuild it before re-offering.
      this.resetLink(link);
    }
    // We were already seated when this peer joined: WE originate the offer —
    // the deterministic single-offerer rule that makes initial establishment
    // glare-free (only one side of the pair ever offers first).
    link.seatedByUs = true;
    void this.initiateOffer(link);
  }

  private handlePeerLeave(rawPeerId: string): void {
    const peerId = this.toPeerId(rawPeerId);
    if (peerId === null) return;
    const link = this.links.get(peerId);
    if (link === undefined) return;
    // The broker says the seat is gone (member left, socket dropped, or —
    // when OUR socket dies — every present peer at once). A peer that loses
    // its seat can no longer be re-signalled, so the pair is torn down
    // wholesale; a rejoin re-seats under a fresh join → offer → new link.
    this.teardownLink(link);
    this.options.onPeerLinkState?.(peerId, "closed");
  }

  private handleRemoteOffer(rawPeerId: string, sdp: unknown): void {
    if (this.closed) return;
    const peerId = this.toPeerId(rawPeerId);
    if (peerId === null) return;
    let link = this.links.get(peerId);
    if (link === undefined) {
      // An addressed offer from an unknown peerId is how the NEWCOMER learns
      // a seated member exists (the broker never echoes the roster — the
      // signaling client auto-promoted this peer a moment ago).
      if (this.links.size >= this.maxPeers) {
        this.options.onError?.(
          new GroupError(
            GroupErrorCode.MemberLimitReached,
            `group already holds ${this.links.size} peer connections against the member cap; ignoring offer from ${peerId}`,
          ),
        );
        return;
      }
      link = this.createLink(peerId);
    }
    void this.answerRemoteOffer(link, sdp as SessionDescription);
  }

  private handleAnswer(rawPeerId: string, sdp: unknown): void {
    const peerId = this.toPeerId(rawPeerId);
    if (peerId === null) return;
    const link = this.links.get(peerId);
    if (link === undefined) return;
    // The matching answer to our in-flight offer arrived — release the
    // in-flight latch so a subsequent remote offer is answered rather than
    // treated as a glare collision. Same unconditional-clear residual as
    // the 1:1 bridge: a stale answer can only arrive for an offer we sent,
    // so the window is bounded and self-limiting.
    link.localOfferInFlight = false;
    // A live answer means the pair is mid-negotiation — pick up the
    // session's authenticated identity if the link handshaked meanwhile.
    this.refreshPeerIdentity(link.peerId);
    void link.pc.setRemoteDescription(sdp as SessionDescription).catch(() => {
      // best-effort; the pair will fail and surface via connection state
    });
  }

  private handleIce(rawPeerId: string, candidate: unknown): void {
    const peerId = this.toPeerId(rawPeerId);
    if (peerId === null) return;
    const link = this.links.get(peerId);
    if (link === undefined) return;
    // addIceCandidate resolves immediately when buffered pre-remote-desc by
    // the adapter; rejections (late/invalid candidates) are swallowed so a
    // bad candidate never becomes an unhandled rejection.
    void link.pc.addIceCandidate(candidate as IceCandidate).catch(() => {
      // best-effort
    });
  }

  // --- per-pair peer connection plumbing ---

  private createLink(peerId: PeerId): PeerLink {
    const link: PeerLink = {
      peerId,
      pc: this.createPeerConnection(peerId),
      channel: null,
      seatedByUs: false,
      localOfferInFlight: false,
      attached: false,
      generation: 0,
    };
    this.links.set(peerId, link);
    return link;
  }

  /**
   * Construct the pair's peer connection with callbacks guarded by adapter
   * identity (mirrors the 1:1 bridge): an event only reaches manager state
   * while the adapter that fired it is still the link's live one — resolved
   * through the links map at fire time. {@link resetLink} swaps the adapter;
   * without the guard a stale `failed`/`closed` from the replaced connection
   * would tear down the fresh negotiation.
   */
  private createPeerConnection(peerId: PeerId): PeerConnection {
    let pc: PeerConnection | null = null;
    const liveLink = (): PeerLink | undefined => {
      const link = this.links.get(peerId);
      if (pc === null || link === undefined || link.pc !== pc) return undefined;
      return link;
    };
    pc = this.options.peerConnectionFactory({
      iceServers: this.options.iceServers,
      onIceCandidate: (candidate: IceCandidate): void => {
        if (liveLink() === undefined) return;
        this.signaling.sendIce(peerId, candidate);
      },
      onConnectionStateChange: (state: PeerConnectionState): void => {
        const link = liveLink();
        if (link === undefined) return;
        this.handleConnectionState(link, state);
      },
      onDataChannel: (transport: DataChannelTransport): void => {
        const link = liveLink();
        if (link === undefined) return;
        this.recordChannel(link, transport);
      },
    });
    return pc;
  }

  /**
   * Swap the pair onto a fresh peer connection and reset its negotiation
   * latches. Shared by the two "this negotiation is dead" edges — seat
   * turnover (fresh join notification) and a terminal connection-state
   * transition — so the re-offer is never swallowed by the guards the dead
   * negotiation enforced.
   */
  private resetLink(link: PeerLink): void {
    // Last chance to pin the pair's authenticated identity: the dropLink
    // below strips it from the session, but glare on the REBUILT
    // connection still wants the identity-derived role.
    this.refreshPeerIdentity(link.peerId);
    link.generation++;
    link.localOfferInFlight = false;
    link.attached = false;
    this.discardChannel(link);
    try {
      link.pc.close();
    } catch {
      // best-effort
    }
    link.pc = this.createPeerConnection(link.peerId);
    // The negotiation that died owned the session's link; drop it now so a
    // fresh attach does not leave a zombie bound to the dead channel, and so
    // link state reflects the drop immediately rather than at re-attach.
    this.options.session.dropLink(link.peerId);
  }

  /**
   * Remove the pair wholesale: close channel + peer connection, drop the
   * record, and tell the session — {@link GroupLinkHost.dropLink} closes the
   * link orchestrator (emitting `leave` when Connected). The map entry is
   * deleted FIRST so the adapter's own close events, resolved through the
   * map, see no live link and drop silently.
   */
  private teardownLink(link: PeerLink): void {
    if (this.links.get(link.peerId) !== link) return;
    this.links.delete(link.peerId);
    // The seat itself is gone — the only point the identity pin is
    // dropped (resetLink deliberately retains it for re-offer glare).
    this.lastKnownPeerIdentities.delete(link.peerId);
    link.generation++;
    link.localOfferInFlight = false;
    this.discardChannel(link);
    try {
      link.pc.close();
    } catch {
      // best-effort
    }
    this.options.session.dropLink(link.peerId);
  }

  private initiateOffer(link: PeerLink): Promise<void> {
    return this.runOffer(link, link.generation);
  }

  private async runOffer(link: PeerLink, generation: number): Promise<void> {
    let channel: DataChannelTransport | null = null;
    // The whole body — including the synchronous createDataChannel section —
    // lives inside the try: a sync throw unwinds through the catch (which
    // disarms the in-flight latch) instead of surfacing as an unhandled
    // rejection from the `void` call sites.
    try {
      // Arm the in-flight latch SYNCHRONOUSLY, before any await (the 1:1
      // bridge's R3F5 discipline): a remote offer arriving while our offer
      // is still being created must be decided by pair politeness — impolite
      // ignores, polite rolls back — not answered unconditionally.
      link.localOfferInFlight = true;
      channel = link.pc.createDataChannel();
      this.recordChannel(link, channel);
      const offer = await link.pc.createOffer();
      // The await can straddle a glare resolution or a rebuild: a parked
      // continuation must not push its stale SDP on top of whatever won
      // meanwhile.
      if (!this.isLiveOffer(link, generation, channel)) {
        this.closeIfUnadopted(link, channel);
        return;
      }
      await link.pc.setLocalDescription(offer);
      if (!this.isLiveOffer(link, generation, channel)) {
        this.closeIfUnadopted(link, channel);
        return;
      }
      this.signaling.sendOffer(link.peerId, offer);
    } catch (err) {
      try {
        channel?.close();
      } catch {
        // best-effort
      }
      if (generation !== link.generation) return;
      if (link.channel === channel) {
        link.channel = null;
      }
      link.localOfferInFlight = false;
      this.options.onError?.(err);
    }
  }

  private isLiveOffer(
    link: PeerLink,
    generation: number,
    channel: DataChannelTransport | null,
  ): boolean {
    return (
      generation === link.generation &&
      link.localOfferInFlight &&
      channel !== null &&
      link.channel === channel
    );
  }

  private async answerRemoteOffer(link: PeerLink, sdp: SessionDescription): Promise<void> {
    const generation = link.generation;
    if (link.localOfferInFlight) {
      // Glare: both sides of the pair hold an in-flight offer — possible
      // only as a crossing re-offer (a link reset or terminal-state rebuild
      // racing the peer's own re-offer). An inbound offer marks presence
      // only and never originates a counter-offer on this side, so initial
      // establishment is glare-free by construction (§2.1). Politeness
      // decides — impolite keeps its offer and ignores the remote one.
      if (!this.politeFor(link)) return;
      try {
        // setLocalDescription({type:"rollback"}) is the perfect-negotiation
        // primitive that returns the pair to a stable state so the remote
        // offer can be applied.
        await link.pc.setLocalDescription({ type: "rollback" });
      } catch {
        // A failed rollback leaves the peer connection in an indeterminate
        // state — fatal to this pair. Tear it down; the peer re-signals.
        if (generation !== link.generation) return;
        this.teardownLink(link);
        return;
      }
      if (generation !== link.generation) return;
      link.localOfferInFlight = false;
      // The rolled-back offer's locally-created channel is dead (its
      // m=application section never reached the wire) — release it BEFORE
      // applying the remote description so the answering side's channel,
      // delivered via onDataChannel, is adopted (recordChannel is
      // first-wins).
      this.discardChannel(link);
    }
    try {
      await link.pc.setRemoteDescription(sdp);
      if (generation !== link.generation) return;
      const answer = await link.pc.createAnswer();
      if (generation !== link.generation) return;
      await link.pc.setLocalDescription(answer);
      if (generation !== link.generation) return;
      // Answering their offer means THEY originated — or won the glare on —
      // this pair's negotiation, so the single-offerer rule hands them the
      // re-offer duty on a drop: only one side ever re-originates from
      // handleLinkFailure. For a link created BY this inbound offer (the
      // newcomer path) the flag is already false; the assignment matters
      // after a polite glare rollback, where the broker's join notification
      // had marked the link seatedByUs before the peer's crossing offer won.
      link.seatedByUs = false;
      this.signaling.sendAnswer(link.peerId, answer);
    } catch {
      // best-effort — the pair will surface the failure through its
      // connection state. If the channel never carried the session, release
      // it so a re-offer is not dropped by the first-wins guard.
      if (generation === link.generation && !link.attached) {
        this.discardChannel(link);
      }
    }
  }

  /**
   * Refresh the seat's identity pin from the session. A non-null answer —
   * the link's v1 handshake authenticated the peer — is (re)stored and
   * returned; a null answer (no link, or not authenticated yet) never
   * clears the pin — the pinned value, if any, is returned instead.
   * Polled wherever authentication may have completed out of band: after
   * link attach, on connection-state transitions, on inbound answers, and
   * inside {@link resetLink} as the last chance before `dropLink` strips
   * the session's copy.
   */
  private refreshPeerIdentity(peerId: PeerId): PublicKey | undefined {
    const live = this.options.session.linkPeerIdentity(peerId);
    if (live !== null) {
      this.lastKnownPeerIdentities.set(peerId, live);
      return live;
    }
    return this.lastKnownPeerIdentities.get(peerId);
  }

  /**
   * Pair politeness for glare resolution. Once the pair's peer identity is
   * known, the role derives from the two identity keys — the same
   * frozen-protocol rule the 1:1 resume path applies via
   * {@link deriveResumeGlareRole} (Initiator = impolite, Responder =
   * polite). The consulted identity is the seat's last-known pin
   * ({@link lastKnownPeerIdentities}), not only a live lookup:
   * {@link resetLink} drops the session link — and its authenticated
   * identity — before the rebuilt connection negotiates, so only a
   * retained pin keeps re-offer glare identity-derived. With no pin,
   * politeness falls back to the peerId ordering — the larger peerId is
   * polite — so glare in the pre-identity window (crossing re-offers on a
   * fresh or rebuilt pair whose v1 handshake has not yet authenticated the
   * peer) still resolves deterministically on both ends: each side reads
   * the same two peerIds off the wire.
   */
  private politeFor(link: PeerLink): boolean {
    const peerIdentity = this.refreshPeerIdentity(link.peerId);
    if (peerIdentity !== undefined) {
      return isPolite(deriveResumeGlareRole(this.options.localIdentityPublicKey, peerIdentity));
    }
    return this.ownPeerIdValue > link.peerId;
  }

  private recordChannel(link: PeerLink, transport: DataChannelTransport): void {
    // First-wins: a second channel on the same negotiation (e.g. the
    // answering side's DCEP channel arriving while our rolled-back channel
    // was still recorded) is released instead of being adopted.
    if (link.channel !== null) {
      try {
        transport.close();
      } catch {
        // best-effort
      }
      return;
    }
    link.channel = transport;
    // Attach the moment the channel can carry bytes — the same rule the 1:1
    // bridge applies in maybeFireTransportReady (channel-ready alone, never
    // gated on the pc's connectionState). The immediate call covers a
    // channel already open when recorded (an onOpen listener registered
    // after the fact never fires); the listener covers the usual
    // still-connecting case. Gating on pc "connected" instead routinely
    // lost the race the other way — the data channel's `open` lands BEFORE
    // the connection-state transition, and inbound bytes (the peer's
    // handshake Hello) arriving in that window hit a transport with no
    // message handler yet and were dropped silently, dead-linking the pair.
    this.maybeAttach(link);
    transport.onOpen((): void => {
      this.maybeAttach(link);
    });
  }

  private handleConnectionState(link: PeerLink, state: PeerConnectionState): void {
    if (this.closed) return;
    // Any transport transition is a chance to pick up a session link that
    // finished its v1 handshake since the last poll.
    this.refreshPeerIdentity(link.peerId);
    this.options.onPeerLinkState?.(link.peerId, state);
    if (state === "connected") {
      this.maybeAttach(link);
      return;
    }
    // "failed"/"closed" = the pair's peer connection is gone.
    // "disconnected" is transient (ICE re-negotiation) and intentionally NOT
    // treated as a drop.
    if (state === "failed" || state === "closed") {
      this.handleLinkFailure(link);
    }
  }

  /**
   * Re-signal a dead pair whose seat is still present: rebuild on a fresh
   * peer connection and let the ORIGINALLY-SEATED member re-originate the
   * offer — the deterministic single-offerer rule applied to link
   * re-establishment, so a failure observed on both ends produces exactly
   * one offer. The newcomer side rebuilds and waits for the re-offer. If
   * the peer is gone the pair is torn down outright.
   */
  private handleLinkFailure(link: PeerLink): void {
    if (this.links.get(link.peerId) !== link) return;
    if (!this.signaling.isPeerPresent(link.peerId)) {
      this.teardownLink(link);
      return;
    }
    this.resetLink(link);
    if (link.seatedByUs) {
      void this.initiateOffer(link);
    }
  }

  /**
   * Hand the pair's open channel to the session. Fires once per link; the
   * session's attach can throw (member cap raced, session already left) —
   * on rejection the pair is dead on arrival and torn down rather than
   * holding an unattached channel.
   */
  private maybeAttach(link: PeerLink): void {
    if (this.closed || link.attached) return;
    const channel = link.channel;
    if (channel === null || !channel.ready) return;
    try {
      this.options.session.attachLinkTransport(link.peerId, toPeerTransport(channel));
    } catch (err) {
      this.options.onError?.(err);
      this.teardownLink(link);
      return;
    }
    link.attached = true;
    // Attach point poll: normally too early (the v1 handshake runs over
    // the just-attached channel), but costs nothing and covers any session
    // implementation that already knows the peer's identity here.
    this.refreshPeerIdentity(link.peerId);
  }

  /** Close and clear the link's recorded channel. Idempotent. */
  private discardChannel(link: PeerLink): void {
    const channel = link.channel;
    if (channel === null) return;
    link.channel = null;
    try {
      channel.close();
    } catch {
      // best-effort
    }
  }

  /** Close a locally-created channel the negotiation never adopted. */
  private closeIfUnadopted(link: PeerLink, channel: DataChannelTransport | null): void {
    if (channel === null || link.channel === channel) return;
    try {
      channel.close();
    } catch {
      // best-effort
    }
  }

  /** Brand an inbound peerId; anything malformed is dropped (the broker validates too — belt and braces). */
  private toPeerId(rawPeerId: string): PeerId | null {
    if (!isValidPeerId(rawPeerId)) return null;
    return encodePeerId(rawPeerId);
  }
}

/** Mint an own seat label: 8 CSPRNG bytes rendered as 16 lowercase hex chars. */
function generatePeerId(): PeerId {
  const bytes = randomBytes(OWN_PEER_ID_BYTES);
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return encodePeerId(hex);
}
