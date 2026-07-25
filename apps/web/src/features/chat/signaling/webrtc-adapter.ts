import type { FrameTransport } from "../framing/types";

export const DATA_CHANNEL_LABEL = "fck-chat-v1";
export const DATA_CHANNEL_ORDERED = true;
export const DATA_CHANNEL_MAX_RETRANSMITS = 0;

export interface DataChannelTransportOptions {
  readonly channel: RTCDataChannel;
}

export interface WebRtcAdapterHandlers {
  readonly onIceCandidate?: (candidate: RTCIceCandidateInit) => void;
  readonly onConnectionStateChange?: (state: RTCPeerConnectionState) => void;
  readonly onDataChannel?: (transport: DataChannelTransport) => void;
}

export interface WebRtcAdapterOptions extends WebRtcAdapterHandlers {
  /**
   * ICE servers to use for candidate gathering. Pass an empty array for
   * loopback-only development (no STUN/TURN). In production the operator
   * configures their own standards-compliant STUN listener, e.g.
   * `{ urls: "stun:app.example:3478" }`. No third-party STUN is ever
   * hardcoded here.
   */
  readonly iceServers?: RTCIceServer[];
}

export class DataChannelTransport implements FrameTransport {
  private readonly channel: RTCDataChannel;
  private drainListener: (() => void) | null = null;
  private messageHandler: ((bytes: Uint8Array) => void) | null = null;
  private openListener: (() => void) | null = null;

  public constructor(options: DataChannelTransportOptions) {
    this.channel = options.channel;
    this.channel.binaryType = "arraybuffer";
    this.channel.bufferedAmountLowThreshold = 0;
    this.channel.addEventListener("bufferedamountlow", () => {
      const listener = this.drainListener;
      if (listener !== null) {
        listener();
      }
    });
    this.channel.addEventListener("message", (event) => {
      const handler = this.messageHandler;
      if (handler === null) {
        return;
      }
      const data = (event as MessageEvent).data;
      if (!(data instanceof ArrayBuffer)) {
        return;
      }
      handler(new Uint8Array(data));
    });
    this.channel.addEventListener("open", () => {
      const listener = this.openListener;
      if (listener !== null) {
        listener();
      }
    });
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
    this.drainListener = null;
    this.messageHandler = null;
    this.openListener = null;
    this.channel.close();
  }
}

export class WebRtcAdapter {
  private readonly peerConnection: RTCPeerConnection;
  private readonly handlers: WebRtcAdapterHandlers;
  private dataChannel: RTCDataChannel | null = null;

  public constructor(options: WebRtcAdapterOptions = {}) {
    this.handlers = options;
    this.peerConnection = new RTCPeerConnection({
      iceServers: options.iceServers ?? [],
      bundlePolicy: "max-bundle",
    });
    this.peerConnection.addEventListener("icecandidate", (event) => {
      if (event.candidate !== null) {
        this.handlers.onIceCandidate?.(event.candidate.toJSON());
      }
    });
    this.peerConnection.addEventListener("connectionstatechange", () => {
      this.handlers.onConnectionStateChange?.(this.peerConnection.connectionState);
    });
    this.peerConnection.addEventListener("datachannel", (event) => {
      this.handlers.onDataChannel?.(new DataChannelTransport({ channel: event.channel }));
    });
  }

  public async createOffer(): Promise<RTCSessionDescriptionInit> {
    return await this.peerConnection.createOffer();
  }

  public async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return await this.peerConnection.createAnswer();
  }

  public async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    await this.peerConnection.setLocalDescription(description);
  }

  public async setRemoteDescription(
    description: RTCSessionDescription | RTCSessionDescriptionInit,
  ): Promise<void> {
    await this.peerConnection.setRemoteDescription(description);
  }

  public async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
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

  public get connectionState(): RTCPeerConnectionState {
    return this.peerConnection.connectionState;
  }

  public close(): void {
    if (this.dataChannel !== null) {
      this.dataChannel.close();
      this.dataChannel = null;
    }
    this.peerConnection.close();
  }
}
