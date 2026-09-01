import type { SignalingSocketFactory } from "@fuck-eu-chat-control/chat-runtime/signaling/signaling-client";
import type {
  DataChannelTransport,
  IceCandidate,
  PeerConnection,
  PeerConnectionFactory,
  PeerConnectionState,
  SessionDescription,
} from "@fuck-eu-chat-control/chat-runtime/transport/types";

import { MockSignalingSocket } from "../signaling/_helpers";

/**
 * A minimal in-memory `Storage`-shaped double for testing the runtime
 * persistence managers. Only the `getItem`/`setItem` surface is implemented —
 * the runtime never calls `removeItem` or iterates keys.
 */
export interface FakeStorage {
  readonly store: Map<string, string>;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function fakeStorage(): FakeStorage {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (key: string): string | null => store.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      store.set(key, value);
    },
  };
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * A no-op {@link PeerConnection} stub for controller-level tests that never
 * reach a live WebRTC handshake. Every method rejects so a test that
 * accidentally drives the bridge surfaces a clear failure rather than a hang.
 */
class StubPeerConnection implements PeerConnection {
  createOffer(): Promise<SessionDescription> {
    return Promise.reject(new Error("StubPeerConnection.createOffer: not implemented"));
  }
  createAnswer(): Promise<SessionDescription> {
    return Promise.reject(new Error("StubPeerConnection.createAnswer: not implemented"));
  }
  setLocalDescription(): Promise<void> {
    return Promise.reject(new Error("StubPeerConnection.setLocalDescription: not implemented"));
  }
  setRemoteDescription(): Promise<void> {
    return Promise.reject(new Error("StubPeerConnection.setRemoteDescription: not implemented"));
  }
  addIceCandidate(_candidate: IceCandidate): Promise<void> {
    return Promise.reject(new Error("StubPeerConnection.addIceCandidate: not implemented"));
  }
  createDataChannel(): DataChannelTransport {
    throw new Error("StubPeerConnection.createDataChannel: not implemented");
  }
  get connectionState(): PeerConnectionState {
    return "new";
  }
  close(): void {
    // no-op
  }
}

/**
 * Peer-connection factory that returns a {@link StubPeerConnection}. Inject
 * this into `createChatController` for tests that exercise controller logic
 * without a real WebRTC peer.
 */
export function stubPeerConnectionFactory(): PeerConnectionFactory {
  return () => new StubPeerConnection();
}

/**
 * A never-opening data channel double. The bridge records it (so the offer
 * path can create it) but `ready` stays false and no `open` event fires, so
 * `maybeFireTransportReady` never fires and the orchestrator handshake is
 * never started — these fakes exist to observe the SDP/signaling SEQUENCE,
 * not to run the crypto layer.
 */
class DormantDataChannel implements DataChannelTransport {
  public readonly bufferedAmount = 0;
  public readonly ready = false;
  public send(_bytes: Uint8Array): void {
    // no-op: the channel never opens
  }
  public setDrainListener(_listener: (() => void) | null): void {
    // no-op
  }
  public setOnMessage(_handler: ((bytes: Uint8Array) => void) | null): void {
    // no-op
  }
  public onOpen(_listener: () => void): void {
    // never fires
  }
  public close(): void {
    // no-op
  }
}

/**
 * A {@link PeerConnection} whose SDP operations resolve immediately and
 * record their sequence. Used by the bridge-negotiation controller tests
 * (R3F4 role parity, R3F6 retry-reconnect): `handlePeerJoin` can run the
 * full `initiateOffer` path against it and the test asserts on the wire
 * messages the signaling socket observed.
 */
export class NegotiatingPeerConnection implements PeerConnection {
  public connectionState: PeerConnectionState = "new";
  public closed = false;
  public readonly localDescTypes: string[] = [];
  public readonly remoteDescTypes: string[] = [];

  public async createOffer(): Promise<SessionDescription> {
    return { type: "offer", sdp: "fake-offer-sdp" };
  }

  public async createAnswer(): Promise<SessionDescription> {
    return { type: "answer", sdp: "fake-answer-sdp" };
  }

  public async setLocalDescription(description: SessionDescription): Promise<void> {
    this.localDescTypes.push(description.type);
  }

  public async setRemoteDescription(description: SessionDescription): Promise<void> {
    this.remoteDescTypes.push(description.type);
  }

  public async addIceCandidate(_candidate: IceCandidate): Promise<void> {
    // no-op: no ICE simulation
  }

  public createDataChannel(): DataChannelTransport {
    return new DormantDataChannel();
  }

  public close(): void {
    this.closed = true;
  }
}

/**
 * Build a {@link PeerConnectionFactory} that hands out a fresh
 * {@link NegotiatingPeerConnection} per call and records every instance, so
 * tests can assert the bridge built (R3F6 reconnect) or reused a peer
 * connection.
 */
export function negotiatingPeerConnectionFactory(): {
  readonly factory: PeerConnectionFactory;
  readonly instances: NegotiatingPeerConnection[];
} {
  const instances: NegotiatingPeerConnection[] = [];
  return {
    factory: (): NegotiatingPeerConnection => {
      const instance = new NegotiatingPeerConnection();
      instances.push(instance);
      return instance;
    },
    instances,
  };
}

/**
 * Multi-socket signaling factory: each `connect()` the bridge performs dials
 * a FRESH {@link MockSignalingSocket} (recorded in dial order). The
 * single-socket `mockSocketFactory` cannot express a reconnect; this pool
 * lets a test drive the first connection, drop it, and observe the re-dial.
 */
export class SocketPool {
  public readonly sockets: MockSignalingSocket[] = [];

  public readonly factory: SignalingSocketFactory = (): MockSignalingSocket => {
    const socket = new MockSignalingSocket();
    this.sockets.push(socket);
    return socket;
  };
}
