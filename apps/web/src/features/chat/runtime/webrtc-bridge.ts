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
          void this.adapter.setRemoteDescription(sdp as RTCSessionDescriptionInit);
        },
        onIce: (candidate: unknown): void => {
          void this.adapter.addIceCandidate(candidate as RTCIceCandidateInit);
        },
        onClose: (): void => {
          // Signaling socket closed (peer dropped, navigated away, or broker
          // restarted). Surface so the orchestrator can move to Disconnected.
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
    try {
      this.signaling.close();
    } catch {
      // best-effort
    }
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
      // beginOffer is implicit in sendOffer; endOffer after local desc settles.
      this.signaling.sendOffer(offer);
      this.signaling.endOffer();
    } catch {
      this.nego.localOfferInFlight = false;
      this.nego.channel = null;
    }
  }

  private async handleRemoteOffer(sdp: unknown): Promise<void> {
    if (this.closed) return;
    const outcome = this.signaling.resolveRemoteOffer();
    if (outcome === "ignore") return;
    // We will answer. If we have a local offer in flight, the glare resolver
    // said we are the polite side — roll back, then accept the remote offer.
    if (this.nego.localOfferInFlight) {
      // Rollback: signal an empty local description to the adapter. The
      // signaling glare resolver already transitioned; we just reset our
      // local SDP so setRemoteDescription succeeds.
      this.nego.localOfferInFlight = false;
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
    // v1 keeps the broker signaling socket open after the p2p data channel
    // opens, so that a real peer-leave (broker socket close) is detected
    // promptly and surfaces Disconnected + Retry. The data path is still
    // purely p2p — the broker only relays SDP/ICE, never application bytes.
    // (Dropping the broker from the signaling path post-handshake is tracked
    // as scenario 10 / a follow-up; it requires a controllable broker and a
    // distinct leave-detection mechanism.)
  }
}
