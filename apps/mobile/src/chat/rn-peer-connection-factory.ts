/**
 * react-native-webrtc adapter implementing the chat-runtime neutral transport
 * interfaces:
 *
 *  - {@link PeerConnection}        (7 methods + connectionState + close)
 *  - {@link DataChannelTransport}  (bufferedAmount/ready/send/setDrainListener/
 *                                  setOnMessage/onOpen/close)
 *  - {@link PeerConnectionFactory} (factory entry point)
 *
 * API mapping (react-native-webrtc 124.x — see Context7
 * /react-native-webrtc/react-native-webrtc, BasicUsage.md):
 *
 *  - RTCPeerConnection extends EventTarget and exposes BOTH addEventListener
 *    AND the `on*` handler properties. The published types ship the `on*`
 *    properties with full typing but the vendor EventTarget .d.ts is not
 *    always emitted in the published package, so we register via the `on*`
 *    setters (onicecandidate / onconnectionstatechange / ondatachannel) which
 *    the RN docs document as equivalent. Each handler receives a typed event
 *    with `.candidate` (icecandidate) or `.channel` (datachannel).
 *  - createOffer()/createAnswer() return `Promise<any>`; the runtime payload
 *    is `{ type, sdp }`. We narrow via a local `RnSessionDescriptionInit` and
 *    surface the neutral `SessionDescription`.
 *  - RTCIceCandidate.toJSON() returns `{ candidate, sdpMLineIndex, sdpMid }`
 *    (NO `usernameFragment` in RN — the neutral field is left `undefined`).
 *  - RTCDataChannel exposes the `on*` handler properties (onopen / onmessage /
 *    onbufferedamountlow), `.send(ArrayBuffer | ArrayBufferView | string)`,
 *    `.readyState`, `.bufferedAmount`, `.binaryType = 'arraybuffer'`,
 *    `.bufferedAmountLowThreshold`. The message handler receives a MessageEvent
 *    whose `.data` is an ArrayBuffer when `binaryType` is 'arraybuffer'.
 *
 * The neutral `PeerConnectionState` is the DOM state set (`new|connecting|
 * connected|disconnected|failed|closed`) — RN's `connectionState` uses the
 * same vocabulary, so the mapping is identity.
 */
import { RTCPeerConnection } from 'react-native-webrtc';
import type {
  DataChannelTransport as DataChannelTransportInterface,
  IceCandidate,
  PeerConnection as PeerConnectionInterface,
  PeerConnectionFactory,
  PeerConnectionFactoryOptions,
  PeerConnectionState,
  SessionDescription,
} from '@fuck-eu-chat-control/chat-runtime/transport/types';

/**
 * Structural view of the react-native-webrtc RTCDataChannel we depend on.
 * The published types reference a vendor EventTarget shim that is not always
 * emitted, so we type only the members we touch. This keeps the adapter free
 * of `any` while tolerating the library's type packaging.
 */
interface RnDataChannel {
  binaryType: string;
  bufferedAmountLowThreshold: number;
  readonly readyState: string;
  readonly bufferedAmount: number;
  send(data: ArrayBuffer | ArrayBufferView | string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onbufferedamountlow: ((event: unknown) => void) | null;
}

/**
 * Structural view of the RTCPeerConnection we depend on. The `on*` handler
 * properties are the typed event-registration surface; the addEventListener
 * surface depends on the vendor EventTarget shim which is not always shipped.
 */
interface RnPeerConnectionInstance {
  readonly connectionState: string;
  readonly remoteDescription: { readonly type: string | null; readonly sdp: string } | null;
  createOffer(options?: unknown): Promise<unknown>;
  createAnswer(): Promise<unknown>;
  setLocalDescription(description: unknown): Promise<void>;
  setRemoteDescription(description: unknown): Promise<void>;
  addIceCandidate(candidate: unknown): Promise<void>;
  createDataChannel(label: string, options?: unknown): RnDataChannel;
  onicecandidate: ((event: { readonly candidate: { toJSON(): { readonly candidate: string; readonly sdpMLineIndex?: number | null; readonly sdpMid?: string | null } } | null }) => void) | null;
  onconnectionstatechange: ((event: unknown) => void) | null;
  ondatachannel: ((event: { readonly channel: RnDataChannel }) => void) | null;
  close(): void;
}

/** RN RTCIceServer shape (forwarded from the neutral IceServer). */
interface RnIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** RN session-description payload (createOffer/Answer return this shape). */
interface RnSessionDescriptionInit {
  readonly type: string | null;
  readonly sdp: string;
}

/** Data-channel label mirroring the web adapter. */
const DATA_CHANNEL_LABEL = 'fck-chat-v1';

/**
 * Adapts a react-native-webrtc RTCDataChannel to the neutral
 * {@link DataChannelTransportInterface}. Mirrors the web adapter's lifecycle:
 * handler refs are registered on construction and nulled in `close` so a late
 * event on a not-yet-closed channel sees no listener.
 */
class RnDataChannelTransport implements DataChannelTransportInterface {
  private readonly channel: RnDataChannel;
  private drainListener: (() => void) | null = null;
  private messageHandler: ((bytes: Uint8Array) => void) | null = null;
  private openListener: (() => void) | null = null;

  public constructor(channel: RnDataChannel) {
    this.channel = channel;
    // RN's RTCDataChannel accepts `binaryType = 'arraybuffer'` so message
    // events surface ArrayBuffer payloads (mirrors the web adapter).
    this.channel.binaryType = 'arraybuffer';
    this.channel.bufferedAmountLowThreshold = 0;
    this.channel.onbufferedamountlow = (): void => {
      const listener = this.drainListener;
      if (listener !== null) {
        listener();
      }
    };
    this.channel.onmessage = (event: { readonly data: unknown }): void => {
      const handler = this.messageHandler;
      if (handler === null) {
        return;
      }
      const data = event.data;
      if (data instanceof ArrayBuffer) {
        handler(new Uint8Array(data));
        return;
      }
      if (ArrayBuffer.isView(data)) {
        const view = data as ArrayBufferView;
        handler(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
      }
      // Non-binary payloads are ignored — the runtime only ever sends bytes.
    };
    this.channel.onopen = (): void => {
      const listener = this.openListener;
      if (listener !== null) {
        listener();
      }
    };
  }

  public get bufferedAmount(): number {
    return this.channel.bufferedAmount;
  }

  public get ready(): boolean {
    return this.channel.readyState === 'open';
  }

  public onOpen(listener: () => void): void {
    this.openListener = listener;
  }

  public send(bytes: Uint8Array): void {
    if (this.channel.readyState !== 'open') {
      throw new Error('Cannot send on a data channel that is not open');
    }
    this.channel.send(bytes);
  }

  public setDrainListener(listener: (() => void) | null): void {
    this.drainListener = listener;
  }

  public setOnMessage(handler: ((bytes: Uint8Array) => void) | null): void {
    this.messageHandler = handler;
  }

  public close(): void {
    this.channel.onopen = null;
    this.channel.onmessage = null;
    this.channel.onbufferedamountlow = null;
    this.drainListener = null;
    this.messageHandler = null;
    this.openListener = null;
    this.channel.close();
  }
}

/**
 * Adapts a react-native-webrtc RTCPeerConnection to the neutral
 * {@link PeerConnectionInterface}. Maps ICE/connectionstate/datachannel events
 * (via the `on*` handler properties) to the neutral handler callbacks, and
 * buffers early ICE candidates until `setRemoteDescription` settles.
 */
class RnPeerConnection implements PeerConnectionInterface {
  private readonly peerConnection: RnPeerConnectionInstance;
  private handlers: PeerConnectionFactoryOptions;
  private dataChannel: RnDataChannel | null = null;
  private pendingIceCandidates: IceCandidate[] = [];

  public constructor(options: PeerConnectionFactoryOptions) {
    this.handlers = options;
    const iceServers: RnIceServer[] = (options.iceServers ?? []).map((server) => {
      const urls = server.urls;
      // RN's RTCIceServer.urls is `string | string[]` (mutable); the neutral
      // IceServer.urls is `string | readonly string[]`. Normalize a readonly
      // array into a mutable copy so the RN type accepts it.
      const mappedUrls: string | string[] = Array.isArray(urls)
        ? urls.slice()
        : (urls as string);
      const mapped: RnIceServer = { urls: mappedUrls };
      if (server.username !== undefined) mapped.username = server.username;
      if (server.credential !== undefined) mapped.credential = server.credential;
      return mapped;
    });
    this.peerConnection = new RTCPeerConnection({
      iceServers,
      bundlePolicy: 'max-bundle',
    }) as unknown as RnPeerConnectionInstance;
    this.peerConnection.onicecandidate = (event): void => {
      const candidate = event.candidate;
      if (candidate === null) {
        return;
      }
      // RN's RTCIceCandidate.toJSON() returns { candidate, sdpMLineIndex,
      // sdpMid } — no usernameFragment (the DOM-only field is absent in RN).
      const init = candidate.toJSON();
      if (typeof init.candidate !== 'string') {
        return;
      }
      const neutral: IceCandidate = {
        candidate: init.candidate,
        sdpMid: init.sdpMid ?? null,
        sdpMLineIndex: init.sdpMLineIndex ?? null,
      };
      this.handlers.onIceCandidate?.(neutral);
    };
    this.peerConnection.onconnectionstatechange = (): void => {
      const state = this.peerConnection.connectionState as PeerConnectionState;
      this.handlers.onConnectionStateChange?.(state);
    };
    this.peerConnection.ondatachannel = (event): void => {
      this.handlers.onDataChannel?.(new RnDataChannelTransport(event.channel));
    };
  }

  public async createOffer(): Promise<SessionDescription> {
    const offer = (await this.peerConnection.createOffer()) as RnSessionDescriptionInit;
    return { type: (offer.type ?? 'offer') as SessionDescription['type'], sdp: offer.sdp };
  }

  public async createAnswer(): Promise<SessionDescription> {
    const answer = (await this.peerConnection.createAnswer()) as RnSessionDescriptionInit;
    return { type: (answer.type ?? 'answer') as SessionDescription['type'], sdp: answer.sdp };
  }

  public async setLocalDescription(description: SessionDescription): Promise<void> {
    await this.peerConnection.setLocalDescription(description);
  }

  public async setRemoteDescription(description: SessionDescription): Promise<void> {
    await this.peerConnection.setRemoteDescription(description);
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
    if (this.peerConnection.remoteDescription === null) {
      this.pendingIceCandidates.push(candidate);
      return;
    }
    await this.peerConnection.addIceCandidate(candidate);
  }

  public createDataChannel(): DataChannelTransportInterface {
    if (this.dataChannel !== null) {
      throw new Error('A data channel has already been created');
    }
    const channel = this.peerConnection.createDataChannel(DATA_CHANNEL_LABEL, {
      ordered: true,
      negotiated: false,
    });
    this.dataChannel = channel;
    return new RnDataChannelTransport(channel);
  }

  public get connectionState(): PeerConnectionState {
    return this.peerConnection.connectionState as PeerConnectionState;
  }

  public close(): void {
    this.peerConnection.onicecandidate = null;
    this.peerConnection.onconnectionstatechange = null;
    this.peerConnection.ondatachannel = null;
    this.handlers = {};
    if (this.dataChannel !== null) {
      this.dataChannel.close();
      this.dataChannel = null;
    }
    this.peerConnection.close();
  }
}

/**
 * PeerConnectionFactory over react-native-webrtc. Registered with
 * `createChatController` so the runtime core never references the native
 * RTCPeerConnection directly.
 */
export const rnPeerConnectionFactory: PeerConnectionFactory = (options) =>
  new RnPeerConnection(options);
