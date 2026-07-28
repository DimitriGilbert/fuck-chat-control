import type {
  DataChannelTransport,
  IceCandidate,
  PeerConnection,
  PeerConnectionFactory,
  PeerConnectionState,
  SessionDescription,
} from "@fuck-eu-chat-control/chat-runtime/transport/types";

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
