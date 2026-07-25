import type { PeerTransport } from "@/features/chat/orchestrator/peer-transport";
import type { SignalingSocketFactory } from "@/features/chat/signaling/signaling-client";

export { MockSignalingSocket, parse } from "../signaling/_helpers";

/**
 * Build a {@link SignalingSocketFactory} that returns the supplied mock
 * socket. The orchestrator wires signaling through this factory on
 * `start()`/`join()`; tests use it to assert the broker `join` was sent and
 * to simulate peer-leave / socket-close.
 */
export function mockSocketFactory(socket: {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  set onopen(value: (() => void) | null);
  set onmessage(value: ((event: { readonly data: string }) => void) | null);
  set onclose(value: (() => void) | null);
  set onerror(value: (() => void) | null);
}): SignalingSocketFactory {
  return () => socket;
}

/**
 * A loopback {@link PeerTransport} pair: bytes `send()` on one side are
 * delivered synchronously to the paired side's current `onMessage` handler.
 *
 * This is the test seam that lets two {@link ConversationOrchestrator}
 * instances run the full real crypto handshake against each other without
 * WebRTC. Cross-wire a pair via {@link link}: `a.send(bytes)` arrives at
 * `b.onMessage`, and vice versa.
 */
export class LoopbackPeerTransport implements PeerTransport {
  public ready = true;
  public bufferedAmount = 0;
  private peer: LoopbackPeerTransport | null = null;
  private onMessage: ((bytes: Uint8Array) => void) | null = null;
  private closed = false;
  public readonly sent: Uint8Array[] = [];

  public send(bytes: Uint8Array): void {
    if (this.closed) {
      // After close, silently drop outgoing bytes — mirrors a real RTCDataChannel
      // whose buffer has been torn down, and keeps tests deterministic when
      // both sides race to tear down.
      return;
    }
    // Copy so the receiver sees an independent buffer (mirrors a real
    // data channel: bytes cross a process boundary).
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    this.sent.push(copy);
    const peer = this.peer;
    if (peer !== null) {
      peer.deliver(copy);
    }
  }

  public setOnMessage(handler: ((bytes: Uint8Array) => void) | null): void {
    this.onMessage = handler;
  }

  public setOnDrain(_handler: (() => void) | null): void {
    // No backpressure simulation in the loopback double; the drain signal is
    // never raised. Accepted to satisfy the PeerTransport contract.
  }

  public close(): void {
    this.closed = true;
    this.ready = false;
    this.onMessage = null;
  }

  /**
   * Cross-wire this transport to another: each side's `send()` will deliver to
   * the other's `onMessage`. Mutually exclusive — calling twice is undefined.
   */
  public link(other: LoopbackPeerTransport): void {
    this.peer = other;
    other.peer = this;
  }

  /** Deliver an inbound byte stream to this side's current onMessage handler. */
  public deliver(bytes: Uint8Array): void {
    if (this.closed) return;
    const handler = this.onMessage;
    if (handler !== null) {
      handler(bytes);
    }
  }
}

/**
 * Cross-wire two loopback transports into a pair: each side's `send()`
 * delivers to the other's `onMessage`. Returns the pair `{ a, b }`.
 */
export function linkLoopbackPair(): { a: LoopbackPeerTransport; b: LoopbackPeerTransport } {
  const a = new LoopbackPeerTransport();
  const b = new LoopbackPeerTransport();
  a.link(b);
  return { a, b };
}
