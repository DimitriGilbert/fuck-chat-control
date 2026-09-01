import type { ConversationId, Role } from "../protocol/types";
import { SignalingClient, type SignalingSocketFactory } from "../signaling/signaling-client";
import { conversationIdToHex } from "../orchestrator/invitation";
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
 * Callback the bridge invokes exactly once, when the data channel is open and
 * the orchestrator may safely `attachTransport` and start the handshake.
 */
export type TransportReadyCallback = (transport: PeerTransport) => void;

export interface WebRtcBridgeOptions {
  /** The broker WebSocket URL the signaling client dials. */
  readonly brokerUrl: string;
  /** Conversation id — hashed into the broker room id. */
  readonly roomId: ConversationId;
  /**
   * Signaling role — decides glare POLITENESS only (impolite keeps its offer
   * on collision, polite rolls back). Any role may originate the offer; see
   * {@link WebRtcBridge.handlePeerJoin}.
   */
  readonly role: Role;
  /** Factory for the underlying WebSocket (testability). */
  readonly socketFactory: SignalingSocketFactory;
  /**
   * Platform-supplied factory that constructs the peer connection. The web
   * adapter injects `(opts) => new WebRtcAdapter(opts)`; native adapters inject
   * their own. Keeps the runtime free of any DOM `RTCPeerConnection` reference.
   */
  readonly peerConnectionFactory: PeerConnectionFactory;
  /** ICE servers. Empty array = loopback-only. */
  readonly iceServers?: readonly IceServer[];
  /** Invoked once when the data channel is open. */
  readonly transportReady: TransportReadyCallback;
  /** Optional callbacks that forward broker peer-presence to the orchestrator. */
  readonly onPeerJoin?: () => void;
  readonly onPeerLeave?: () => void;
  readonly onSignalingClosed?: () => void;
}

interface NegotiationState {
  /** A local offer has been created and sent; awaiting answer. */
  localOfferInFlight: boolean;
  /** The data channel owned by this side (initiator-created or responder-received). */
  channel: DataChannelTransport | null;
  /** Whether the transport-ready callback has fired. */
  transportReadyFired: boolean;
}

/** Grace window between data-channel open and broker-socket drop, per PRD. */
const BROKER_TEARDOWN_GRACE_MS = 2_000;

/**
 * Connects ONE conversation's orchestrator to real WebRTC + signaling. The
 * orchestrator owns the application-layer handshake; the bridge owns the
 * SDP/ICE exchange with the broker and the underlying RTCPeerConnection.
 *
 * Perfect-negotiation flow:
 *  - signaling `onPeerJoin` → the seated side offers (role decides
 *    politeness, never offer permission — see handlePeerJoin)
 *  - signaling `onOffer` → polite/impolite glare decides keep vs answer
 *  - signaling `onAnswer` / `onIce` → adapter accepts
 *  - adapter `onIceCandidate` → signaling relays
 *  - data channel `open` → `transportReady(toPeerTransport(channel))`,
 *    then `signaling.signalP2pOpen()` to drop the broker from the path.
 *  - later drop → {@link WebRtcBridge.reconnect} re-dials signaling and
 *    swaps in a fresh peer connection so retry can re-negotiate (R3F6).
 *
 * The initiator must `createDataChannel()` BEFORE `createOffer()` so the offer
 * SDP advertises the channel; the responder receives the channel via
 * `adapter.onDataChannel`.
 *
 * The full RTCPeerConnection path is validated end-to-end via Playwright +
 * the live two-browser run; the unit tests here cover only the parts that do
 * not need a real RTCPeerConnection (construction, idempotent close, room id).
 */
export class WebRtcBridge {
  private readonly signaling: SignalingClient;
  /**
   * The live peer connection. Not readonly: {@link reconnect} swaps in a
   * fresh one (a failed RTCPeerConnection cannot restart ICE, so
   * re-establishing the transport requires rebuilding it). Callbacks are
   * identity-guarded in {@link createAdapter}, so events still in flight from
   * a replaced adapter are dropped instead of surfacing as a fresh peer-leave.
   */
  private adapter: PeerConnection;
  private readonly options: WebRtcBridgeOptions;
  private readonly nego: NegotiationState = {
    localOfferInFlight: false,
    channel: null,
    transportReadyFired: false,
  };
  private closed = false;
  /**
   * Set once the P2P data channel has carried its first open event and the
   * bridge has fired `transportReady`. While true, the broker socket's close
   * is expected (it is the post-handshake teardown) and must not be surfaced
   * to the orchestrator as a peer drop.
   */
  private suppressSignalingClose = false;
  private brokerTeardownTimer: ReturnType<typeof setTimeout> | null = null;

  public constructor(options: WebRtcBridgeOptions) {
    this.options = options;
    this.signaling = new SignalingClient({
      brokerUrl: options.brokerUrl,
      roomId: conversationIdToHex(options.roomId),
      role: options.role,
      socketFactory: options.socketFactory,
      handlers: {
        onPeerJoin: (): void => {
          this.handlePeerJoin();
          this.options.onPeerJoin?.();
        },
        onPeerLeave: (): void => {
          // The broker says the peer left the room. Surface the drop to the
          // orchestrator so it can move to Disconnected and offer retry.
          this.options.onPeerLeave?.();
        },
        onOffer: (sdp: unknown): void => {
          void this.handleRemoteOffer(sdp);
        },
        onAnswer: (sdp: unknown): void => {
          // The matching answer to our in-flight offer arrived; the offer is
          // no longer in flight. Release both the bridge's local flag and the
          // glare resolver's flag so a subsequent remote offer is answered
          // (rather than treated as a glare collision).
          this.nego.localOfferInFlight = false;
          this.signaling.endOffer();
          void this.adapter.setRemoteDescription(sdp as SessionDescription).catch(() => {
            // best-effort; the connection will fail and the orchestrator surfaces it
          });
        },
        onIce: (candidate: unknown): void => {
          // addIceCandidate resolves immediately when buffered pre-remote-desc;
          // any rejection (late/invalid candidate surfacing through the drain
          // path) is swallowed here so it never becomes an unhandled rejection.
          void this.adapter.addIceCandidate(candidate as IceCandidate).catch(() => {
            // best-effort
          });
        },
        onClose: (): void => {
          // Signaling socket closed. If we tore it down ourselves after the P2P
          // data channel opened, this is the expected post-handshake close — do
          // NOT surface it as a peer drop. Otherwise (peer dropped, navigated
          // away, broker restarted) surface so the orchestrator moves to
          // Disconnected and offers retry.
          if (this.suppressSignalingClose) return;
          this.options.onSignalingClosed?.();
        },
        onError: (): void => {
          // Surfaced via the orchestrator's onError handler; nothing to do
          // here that wouldn't double-report.
        },
      },
    });
    this.adapter = this.createAdapter();
  }

  /**
   * Construct a peer connection from the platform factory with handlers
   * guarded by adapter identity (R3F6): a callback only reaches bridge state
   * while the adapter that fired it is still the live one. Reconnect swaps
   * the adapter; without the guard, the replaced adapter's terminal
   * `failed`/`closed` transition would surface as a peer-leave and undo the
   * retry that is mid-flight.
   */
  private createAdapter(): PeerConnection {
    const adapter: PeerConnection = this.options.peerConnectionFactory({
      iceServers: this.options.iceServers,
      onIceCandidate: (candidate: IceCandidate): void => {
        if (this.adapter !== adapter) return;
        this.signaling.sendIce(candidate);
      },
      onConnectionStateChange: (state: PeerConnectionState): void => {
        if (this.adapter !== adapter) return;
        this.handleConnectionState(state);
      },
      onDataChannel: (transport: DataChannelTransport): void => {
        if (this.adapter !== adapter) return;
        this.recordChannel(transport);
      },
    });
    return adapter;
  }

  /** Start signaling: connect the broker; the offer originates on peer-join. */
  public start(): void {
    // R3F1 (Phase 3): never dial on a closed bridge. Every other entry point
    // already gates on `closed`; start() was the one unguarded path, so a late
    // start() (a start/resume completing after teardown) could open a fresh
    // signaling socket on a bridge the controller already released.
    if (this.closed) return;
    this.signaling.connect();
  }

  /**
   * R3F6 (Phase 8): re-establish the bridge's transport for a LIVE session
   * after a drop. After the post-handshake grace teardown there is no
   * signaling socket left and a failed RTCPeerConnection cannot restart ICE,
   * so controller.retry() routes here: reconnect swaps in a fresh peer
   * connection, dials a fresh signaling socket (which re-joins the broker
   * room), and lets the peer-join relay re-initiate the offer under the
   * corrected glare rules — exactly as on the initial start. Leave + resume
   * remains the nuclear option; this path exists so retry is not a dead
   * spinner for bridge-mode sessions.
   */
  public reconnect(): void {
    if (this.closed) return;
    // Cancel a pending post-handshake grace teardown: letting it fire after
    // the fresh dial would relay `leave` and close the NEW connection's
    // socket.
    if (this.brokerTeardownTimer !== null) {
      clearTimeout(this.brokerTeardownTimer);
      this.brokerTeardownTimer = null;
    }
    // Swap in a fresh peer connection. The identity guard in createAdapter
    // drops callbacks still in flight from the dead one.
    try {
      this.nego.channel?.close();
    } catch {
      // best-effort
    }
    this.nego.channel = null;
    try {
      this.adapter.close();
    } catch {
      // best-effort
    }
    this.adapter = this.createAdapter();
    // Reset the negotiation latches so the fresh exchange starts clean. A
    // local offer left latched by the dropped session would make the impolite
    // side ignore the peer's reconnect offer forever — the exact R3F4
    // mutual-ignore deadlock — and a fired transportReady latch would swallow
    // the re-established channel's readiness.
    this.nego.localOfferInFlight = false;
    this.nego.transportReadyFired = false;
    this.signaling.endOffer();
    // Drop any surviving broker socket, relaying `leave` when it is still
    // room-joined so the broker frees the slot before the fresh dial re-joins
    // (room capacity is 2; a surviving member would reject the new join with
    // "room full"). SignalingClient's stale-socket guard keeps this close
    // from surfacing as onClose for the fresh connection.
    this.signaling.leaveAndClose();
    // The post-handshake suppression must not leak across reconnects: a close
    // of the RE-ESTABLISHED socket is a genuine drop and must be surfaced to
    // the orchestrator again.
    this.suppressSignalingClose = false;
    this.signaling.connect();
  }

  /** Idempotent teardown of both signaling and WebRTC resources. */
  public close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.brokerTeardownTimer !== null) {
      clearTimeout(this.brokerTeardownTimer);
      this.brokerTeardownTimer = null;
    }
    try {
      this.signaling.close();
    } catch {
      // best-effort
    }
    // R6/F5: close the responder-path DataChannelTransport explicitly. The
    // adapter's own close() only tears down the channel it created via
    // createDataChannel (the initiator path). The responder receives its
    // channel via onDataChannel and the bridge stashes it in `nego.channel`;
    // without an explicit close here its listeners (bufferedamountlow /
    // message / open) stay attached to the underlying RTCDataChannel until
    // the browser GCs it.
    try {
      this.nego.channel?.close();
    } catch {
      // best-effort
    }
    this.nego.channel = null;
    try {
      this.adapter.close();
    } catch {
      // best-effort
    }
  }

  /** Exposed for tests/assertions only — the broker room this bridge joins. */
  public get roomHexId(): string {
    return conversationIdToHex(this.options.roomId);
  }

  // --- internal handlers ---

  private handlePeerJoin(): void {
    // Any seated side that receives peer-join originates the offer; role
    // determines POLITENESS (glare resolution), never offer permission. The
    // broker notifies ONLY the first-seated peer when a second joins (the
    // joiner receives nothing), so a role gate here deadlocks whenever the
    // derived Responder is the seated side — nobody offers and both peers
    // hang in Signaling. The joining side's glare resolver is NOT unarmed
    // when the relayed offer arrives: auto-promotion (R6/F7) fires onPeerJoin
    // first, which runs initiateOffer → beginOffer() SYNCHRONOUSLY (R3F5) in
    // the same message dispatch, before onOffer runs — so the joiner is
    // already armed and answers because it is POLITE. An impolite joiner
    // instead ignores the inbound offer and keeps its own; convergence still
    // holds because a polite seated side rolls its own offer back and answers
    // the joiner's. In the crossing case (both seated, both holding a join
    // notification from the other's re-entry), both offer and the glare
    // machinery resolves by politeness — the impolite side's offer survives.
    // Offers are ordinary relayed SDP, so this stays within the frozen wire
    // protocol. Create the data channel BEFORE the offer so the SDP
    // advertises it, and offer at most once.
    if (this.nego.channel !== null) return;
    if (this.nego.localOfferInFlight) return;
    void this.initiateOffer();
  }

  private async initiateOffer(): Promise<void> {
    if (this.closed) return;
    // The whole body — including the synchronous createDataChannel/
    // recordChannel section — lives inside the try: a sync throw there must
    // unwind through the catch below (which disarms the resolver) instead of
    // leaving it permanently armed and surfacing as an unhandled rejection
    // from the `void initiateOffer()` call sites.
    try {
      // R3F5 (Phase 8): arm the glare resolver's in-flight flag SYNCHRONOUSLY,
      // before any await. It used to be armed only inside sendOffer — after
      // the createOffer/setLocalDescription awaits — so a remote offer
      // arriving in that window found offerInFlight === false and was
      // answered unconditionally (the resolver consults politeness only when
      // the flag is set), making even the IMPOLITE side roll back its nascent
      // offer and answer. Armed at initiation, the flag covers the whole
      // offer lifecycle: the impolite side ignores a colliding remote offer
      // from the moment its own offer STARTS, not from when it reaches the
      // wire.
      this.signaling.beginOffer();
      // Create the channel first; the offer SDP will reference it.
      const channel = this.adapter.createDataChannel();
      this.recordChannel(channel);
      this.nego.localOfferInFlight = true;
      const offer = await this.adapter.createOffer();
      // R3F5: the awaits above can straddle a glare resolution. If the
      // polite-side rollback in handleRemoteOffer (or the failure path below)
      // cleared localOfferInFlight while we were parked, this nascent offer is
      // superseded — abandon it instead of pushing a stale second offer on top
      // of the exchange that just completed.
      if (!this.nego.localOfferInFlight) return;
      await this.adapter.setLocalDescription(offer);
      if (!this.nego.localOfferInFlight) return;
      // sendOffer re-asserts the glare flag (idempotent — armed at initiation
      // above); it stays true until the matching answer arrives or we roll
      // back — do NOT endOffer() here.
      this.signaling.sendOffer(offer);
    } catch {
      this.nego.localOfferInFlight = false;
      this.nego.channel = null;
      // Reset the glare resolver's in-flight flag too so a later remote offer
      // is answered rather than treated as a glare collision.
      this.signaling.endOffer();
    }
  }

  private async handleRemoteOffer(sdp: unknown): Promise<void> {
    if (this.closed) return;
    const outcome = this.signaling.resolveRemoteOffer();
    if (outcome === "ignore") return;
    // We will answer. If we have a local offer in flight, the glare resolver
    // said we are the polite side — roll back the local SDP, then accept the
    // remote offer. setLocalDescription({type:"rollback"}) is the
    // perfect-negotiation primitive that returns the RTCPeerConnection to a
    // stable state so setRemoteDescription succeeds.
    if (this.nego.localOfferInFlight) {
      try {
        await this.adapter.setLocalDescription({ type: "rollback" });
      } catch {
        // A failed rollback is fatal to the negotiation — the
        // RTCPeerConnection is in an indeterminate state. Surface as a peer
        // drop so the orchestrator moves to Disconnected; do NOT proceed to
        // setRemoteDescription (it would fail with InvalidStateError).
        this.nego.localOfferInFlight = false;
        this.signaling.endOffer();
        this.options.onPeerLeave?.();
        return;
      }
      this.nego.localOfferInFlight = false;
      // The local offer is gone; release the glare resolver's in-flight flag
      // so it answers (not ignores) the next remote offer.
      this.signaling.endOffer();
    }
    try {
      await this.adapter.setRemoteDescription(sdp as SessionDescription);
      const answer = await this.adapter.createAnswer();
      await this.adapter.setLocalDescription(answer);
      this.signaling.sendAnswer(answer);
    } catch {
      // best-effort; the connection will fail and the orchestrator surfaces it
    }
  }

  private recordChannel(transport: DataChannelTransport): void {
    if (this.nego.channel !== null) return;
    this.nego.channel = transport;
    // The peer connection may already be "connected" when the channel arrives
    // (responder path). If so, fire transport-ready now.
    if (this.adapter.connectionState === "connected") {
      this.maybeFireTransportReady();
    }
    // The connection state may already be "connected" BEFORE the channel's
    // `open` event fires (the state machine and the data channel have separate
    // transitions). When that happens, maybeFireTransportReady sees the channel
    // not-yet-ready and bails — and there is no further connectionstatechange
    // to re-trigger it. Listen for the channel's open event so we re-check at
    // the moment bytes can actually flow.
    transport.onOpen((): void => {
      this.maybeFireTransportReady();
    });
  }

  private handleConnectionState(state: PeerConnectionState): void {
    if (this.closed) return;
    if (state === "connected") {
      this.maybeFireTransportReady();
      return;
    }
    // "failed" / "closed" = the peer connection is gone (the peer tore down its
    // RTCPeerConnection on leave, or ICE gave up). Surface the drop to the
    // orchestrator so it can move to Disconnected and offer retry. "disconnected"
    // is intentionally NOT treated as a drop — it can fire transiently during
    // ICE re-negotiation and self-heal without dropping the session.
    if (state === "failed" || state === "closed") {
      this.options.onPeerLeave?.();
    }
  }

  private maybeFireTransportReady(): void {
    if (this.nego.transportReadyFired) return;
    if (this.closed) return;
    const channel = this.nego.channel;
    if (channel === null) {
      // Channel not yet known (responder may receive it on the next
      // `onDataChannel` event after `connected`).
      return;
    }
    if (!channel.ready) {
      // The peer connection reports "connected" but the channel `open` event
      // has not fired yet; the next state change will retry.
      return;
    }
    this.nego.transportReadyFired = true;
    this.options.transportReady(toPeerTransport(channel));
    // Once the data channel is carrying bytes, the broker is out of the data
    // path entirely (PRD: broker is signaling-only). Hold the socket open for
    // a short grace window so a channel that drops instantly can re-signal
    // without a fresh join race, then close it cleanly. The close is
    // initiated locally, so the bridge suppresses the otherwise-spurious
    // onSignalingClosed notification (see onClose above) — a real peer drop
    // later is observed via the data channel's own `failed`/`closed`
    // connection-state transition.
    this.suppressSignalingClose = true;
    this.brokerTeardownTimer = setTimeout(() => {
      this.brokerTeardownTimer = null;
      // The grace expired. signalP2pOpen tells the broker `leave` (the broker
      // explicitly does NOT relay this as a peer-left — see
      // BrokerConnection.handleLeave) and then closes the socket. The
      // resulting socket `onclose` is suppressed by `suppressSignalingClose`
      // so the orchestrator does not treat our own teardown as a drop.
      try {
        this.signaling.signalP2pOpen();
      } catch {
        // best-effort; the data channel is already open so the session is fine
      }
    }, BROKER_TEARDOWN_GRACE_MS);
  }
}
