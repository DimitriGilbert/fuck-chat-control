import { Role } from "@/features/chat/protocol/types";
import type { ConversationId } from "@/features/chat/protocol/types";
import {
  SignalingClient,
  type SignalingSocketFactory,
} from "@/features/chat/signaling/signaling-client";
import { DataChannelTransport, WebRtcAdapter } from "@/features/chat/signaling/webrtc-adapter";
import { conversationIdToHex } from "@/features/chat/orchestrator/invitation";
import { toPeerTransport } from "@/features/chat/orchestrator/peer-transport";
import type { PeerTransport } from "@/features/chat/orchestrator/peer-transport";

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
  /** Signaling role — used by the glare resolver. */
  readonly role: Role;
  /** Factory for the underlying WebSocket (testability). */
  readonly socketFactory: SignalingSocketFactory;
  /** ICE servers. Empty array = loopback-only. */
  readonly iceServers?: RTCIceServer[];
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
 *  - signaling `onPeerJoin` → initiator offers (if glare allows)
 *  - signaling `onOffer` → polite/impolite glare decides keep vs answer
 *  - signaling `onAnswer` / `onIce` → adapter accepts
 *  - adapter `onIceCandidate` → signaling relays
 *  - data channel `open` → `transportReady(toPeerTransport(channel))`,
 *    then `signaling.signalP2pOpen()` to drop the broker from the path.
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
  private readonly adapter: WebRtcAdapter;
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
          void this.adapter
            .setRemoteDescription(sdp as RTCSessionDescriptionInit)
            .catch(() => {
              // best-effort; the connection will fail and the orchestrator surfaces it
            });
        },
        onIce: (candidate: unknown): void => {
          // addIceCandidate resolves immediately when buffered pre-remote-desc;
          // any rejection (late/invalid candidate surfacing through the drain
          // path) is swallowed here so it never becomes an unhandled rejection.
          void this.adapter.addIceCandidate(candidate as RTCIceCandidateInit).catch(() => {
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
    this.adapter = new WebRtcAdapter({
      iceServers: options.iceServers,
      onIceCandidate: (candidate: RTCIceCandidateInit): void => {
        this.signaling.sendIce(candidate);
      },
      onConnectionStateChange: (state: RTCPeerConnectionState): void => {
        this.handleConnectionState(state);
      },
      onDataChannel: (transport: DataChannelTransport): void => {
        this.recordChannel(transport);
      },
    });
  }

  /** Start signaling: connect the broker and, for the initiator, offer. */
  public start(): void {
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
    // Initiator side: create the data channel BEFORE the offer so the SDP
    // advertises it. Glare is decided by the signaling client's resolver
    // (beginOffer/endOffer/resolveRemoteOffer). Only offer once.
    if (this.options.role !== Role.Initiator) return;
    if (this.nego.channel !== null) return;
    if (this.nego.localOfferInFlight) return;
    void this.initiateOffer();
  }

  private async initiateOffer(): Promise<void> {
    if (this.closed) return;
    // Create the channel first; the offer SDP will reference it.
    const channel = this.adapter.createDataChannel();
    this.recordChannel(channel);
    this.nego.localOfferInFlight = true;
    try {
      const offer = await this.adapter.createOffer();
      await this.adapter.setLocalDescription(offer);
      // sendOffer marks the glare resolver's in-flight flag as true so a
      // colliding remote offer is decided by the perfect-negotiation policy
      // (impolite ignores, polite rolls back). The flag stays true until the
      // matching answer arrives or we roll back — do NOT endOffer() here.
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
      await this.adapter.setRemoteDescription(sdp as RTCSessionDescriptionInit);
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

  private handleConnectionState(state: RTCPeerConnectionState): void {
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
