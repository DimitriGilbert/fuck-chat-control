import type { FrameTransport } from "@fuck-eu-chat-control/chat-runtime/framing/types";
import type {
  DataChannelTransport as DataChannelTransportInterface,
  IceCandidate,
  IceServer,
  PeerConnection as PeerConnectionInterface,
  PeerConnectionState,
  SessionDescription,
} from "@fuck-eu-chat-control/chat-runtime/transport/types";

export const DATA_CHANNEL_LABEL = "fck-chat-v1";
export const DATA_CHANNEL_ORDERED = true;
export const DATA_CHANNEL_MAX_RETRANSMITS = 0;

export interface DataChannelTransportOptions {
  readonly channel: RTCDataChannel;
}

export interface WebRtcAdapterHandlers {
  readonly onIceCandidate?: (candidate: IceCandidate) => void;
  readonly onConnectionStateChange?: (state: PeerConnectionState) => void;
  readonly onDataChannel?: (transport: DataChannelTransportInterface) => void;
}

export interface WebRtcAdapterOptions extends WebRtcAdapterHandlers {
  /**
   * ICE servers to use for candidate gathering. Pass an empty array for
   * loopback-only development (no STUN/TURN). In production the operator
   * configures their own standards-compliant STUN listener, e.g.
   * `{ urls: "stun:app.example:3478" }`. No third-party STUN is ever
   * hardcoded here.
   *
   * Accepts the neutral {@link IceServer} shape; the adapter maps it to the
   * DOM `RTCIceServer` at the RTCPeerConnection boundary.
   */
  readonly iceServers?: readonly IceServer[];
}

export class DataChannelTransport implements FrameTransport, DataChannelTransportInterface {
  private readonly channel: RTCDataChannel;
  private drainListener: (() => void) | null = null;
  private messageHandler: ((bytes: Uint8Array) => void) | null = null;
  private openListener: (() => void) | null = null;
  /**
   * Bound listeners added in the constructor and removed in {@link close} so
   * the underlying RTCDataChannel can release its JS-side references. Without
   * explicit removal the channel keeps the closures (and through them, this
   * transport) alive until the RTCDataChannel itself is GC'd — which on some
   * browsers is not prompt even after `.close()`.
   */
  private readonly handleBufferedAmountLow: () => void;
  private readonly handleMessage: (event: MessageEvent) => void;
  private readonly handleOpen: () => void;

  public constructor(options: DataChannelTransportOptions) {
    this.channel = options.channel;
    this.channel.binaryType = "arraybuffer";
    this.channel.bufferedAmountLowThreshold = 0;
    this.handleBufferedAmountLow = (): void => {
      const listener = this.drainListener;
      if (listener !== null) {
        listener();
      }
    };
    this.handleMessage = (event: MessageEvent): void => {
      const handler = this.messageHandler;
      if (handler === null) {
        return;
      }
      const data = event.data;
      if (!(data instanceof ArrayBuffer)) {
        return;
      }
      handler(new Uint8Array(data));
    };
    this.handleOpen = (): void => {
      const listener = this.openListener;
      if (listener !== null) {
        listener();
      }
    };
    this.channel.addEventListener("bufferedamountlow", this.handleBufferedAmountLow);
    this.channel.addEventListener("message", this.handleMessage);
    this.channel.addEventListener("open", this.handleOpen);
  }

  public get bufferedAmount(): number {
    return this.channel.bufferedAmount;
  }

  public get ready(): boolean {
    return this.channel.readyState === "open";
  }

  /**
   * Register a one-shot listener invoked when the underlying data channel
   * transitions to `open`. The bridge uses this to re-check transport-readiness
   * because the RTCPeerConnection may report "connected" before the channel's
   * open event fires (or vice versa).
   */
  public onOpen(listener: () => void): void {
    this.openListener = listener;
  }

  public send(bytes: Uint8Array): void {
    if (this.channel.readyState !== "open") {
      throw new Error("Cannot send on a data channel that is not open");
    }
    // RTCDataChannel.send's ArrayBufferView overload requires a view backed by
    // a real ArrayBuffer (not SharedArrayBuffer). A Uint8Array<ArrayBufferLike>
    // may be backed by a SharedArrayBuffer, so when the backing buffer is a
    // plain ArrayBuffer we forward the view as-is (no copy); otherwise we copy
    // into a fresh ArrayBuffer-backed view. The runtime `instanceof ArrayBuffer`
    // check is sound, but TS cannot narrow the view's generic parameter from
    // it, so the safe branch casts to the overload's expected view type.
    if (bytes.buffer instanceof ArrayBuffer) {
      this.channel.send(bytes as Uint8Array<ArrayBuffer>);
      return;
    }
    this.channel.send(new Uint8Array(bytes));
  }

  public setDrainListener(listener: (() => void) | null): void {
    this.drainListener = listener;
  }

  public setOnMessage(handler: ((bytes: Uint8Array) => void) | null): void {
    this.messageHandler = handler;
  }

  public close(): void {
    // R6/F5: remove the listeners added in the constructor so the underlying
    // RTCDataChannel can release its closures. Then null the handler refs so
    // a late event arriving on a not-yet-closed channel sees no listener to
    // invoke.
    this.channel.removeEventListener("bufferedamountlow", this.handleBufferedAmountLow);
    this.channel.removeEventListener("message", this.handleMessage);
    this.channel.removeEventListener("open", this.handleOpen);
    this.drainListener = null;
    this.messageHandler = null;
    this.openListener = null;
    this.channel.close();
  }
}

export class WebRtcAdapter implements PeerConnectionInterface {
  private readonly peerConnection: RTCPeerConnection;
  private handlers: WebRtcAdapterHandlers;
  private dataChannel: RTCDataChannel | null = null;
  /**
   * ICE candidates that arrived before the remote SDP was applied. The browser
   * rejects `addIceCandidate` until `setRemoteDescription` has settled, so any
   * candidate trickled during that window is buffered here and drained once the
   * remote description is in place.
   */
  private pendingIceCandidates: IceCandidate[] = [];
  /**
   * Bound listeners added in the constructor and removed in {@link close} so
   * the RTCPeerConnection can release its closures (R6/F5). Same rationale as
   * DataChannelTransport: without explicit removal the PC keeps the closures
   * (and through them, this adapter + its handlers) alive.
   */
  private readonly handleIceCandidate: (event: RTCPeerConnectionIceEvent) => void;
  private readonly handleConnectionStateChange: () => void;
  private readonly handleDataChannel: (event: RTCDataChannelEvent) => void;

  public constructor(options: WebRtcAdapterOptions = {}) {
    this.handlers = options;
    // Map the neutral IceServer[] to the DOM RTCIceServer[] the
    // RTCPeerConnection constructor expects. The shapes are structurally
    // identical ({urls, username?, credential?}); the mapping is explicit so
    // the adapter is the single boundary that touches the DOM WebRTC types.
    const rtcIceServers: RTCIceServer[] = (options.iceServers ?? []).map((server) => {
      const mapped: RTCIceServer = { urls: server.urls as string | string[] };
      if (server.username !== undefined) mapped.username = server.username;
      if (server.credential !== undefined) mapped.credential = server.credential;
      return mapped;
    });
    this.peerConnection = new RTCPeerConnection({
      iceServers: rtcIceServers,
      bundlePolicy: "max-bundle",
    });
    this.handleIceCandidate = (event: RTCPeerConnectionIceEvent): void => {
      if (event.candidate !== null) {
        const init = event.candidate.toJSON();
        // RTCIceCandidateInit.candidate is `string | undefined` (an end-of-
        // gathering candidate has an empty string); the neutral IceCandidate
        // shape requires a string. Drop the candidate if it is missing rather
        // than forwarding a malformed one.
        if (typeof init.candidate === "string") {
          const candidate: IceCandidate = {
            candidate: init.candidate,
            sdpMid: init.sdpMid,
            sdpMLineIndex: init.sdpMLineIndex,
            // DOM allows `null`; the neutral type treats absent as undefined.
            usernameFragment: init.usernameFragment ?? undefined,
          };
          this.handlers.onIceCandidate?.(candidate);
        }
      }
    };
    this.handleConnectionStateChange = (): void => {
      this.handlers.onConnectionStateChange?.(this.peerConnection.connectionState);
    };
    this.handleDataChannel = (event: RTCDataChannelEvent): void => {
      this.handlers.onDataChannel?.(new DataChannelTransport({ channel: event.channel }));
    };
    this.peerConnection.addEventListener("icecandidate", this.handleIceCandidate);
    this.peerConnection.addEventListener("connectionstatechange", this.handleConnectionStateChange);
    this.peerConnection.addEventListener("datachannel", this.handleDataChannel);
  }

  public async createOffer(): Promise<SessionDescription> {
    return (await this.peerConnection.createOffer()) as SessionDescription;
  }

  public async createAnswer(): Promise<SessionDescription> {
    return (await this.peerConnection.createAnswer()) as SessionDescription;
  }

  public async setLocalDescription(description: SessionDescription): Promise<void> {
    await this.peerConnection.setLocalDescription(description);
  }

  public async setRemoteDescription(description: SessionDescription): Promise<void> {
    await this.peerConnection.setRemoteDescription(description);
    // Now that the remote description is set, any ICE candidates that arrived
    // early can be applied. Late or invalid candidates (e.g. from a stale
    // renegotiation) are swallowed so a bad candidate never fails the whole
    // handshake — the ICE agent will simply keep gathering.
    const buffered = this.pendingIceCandidates;
    this.pendingIceCandidates = [];
    for (const candidate of buffered) {
      try {
        await this.peerConnection.addIceCandidate(candidate);
      } catch {
        // Swallow: late/invalid candidates must not fail the handshake.
      }
    }
  }

  public async addIceCandidate(candidate: IceCandidate): Promise<void> {
    // If the remote description has not been applied yet, the browser will
    // reject the candidate; buffer it and apply it from setRemoteDescription.
    if (this.peerConnection.remoteDescription === null) {
      this.pendingIceCandidates.push(candidate);
      return;
    }
    await this.peerConnection.addIceCandidate(candidate);
  }

  public createDataChannel(): DataChannelTransport {
    if (this.dataChannel !== null) {
      throw new Error("A data channel has already been created");
    }
    const channel = this.peerConnection.createDataChannel(DATA_CHANNEL_LABEL, {
      ordered: DATA_CHANNEL_ORDERED,
      negotiated: false,
    });
    this.dataChannel = channel;
    return new DataChannelTransport({ channel });
  }

  public get connectionState(): PeerConnectionState {
    return this.peerConnection.connectionState;
  }

  public close(): void {
    // R6/F5: remove the listeners added in the constructor so the
    // RTCPeerConnection can release its closures, then null `this.handlers`
    // defensively so any listener that fires before the PC actually closes
    // (or after, on a misbehaving impl) sees no handler to invoke.
    this.peerConnection.removeEventListener("icecandidate", this.handleIceCandidate);
    this.peerConnection.removeEventListener(
      "connectionstatechange",
      this.handleConnectionStateChange,
    );
    this.peerConnection.removeEventListener("datachannel", this.handleDataChannel);
    this.handlers = {};
    if (this.dataChannel !== null) {
      this.dataChannel.close();
      this.dataChannel = null;
    }
    this.peerConnection.close();
  }
}
