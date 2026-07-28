import { describe, expect, it, vi } from "vitest";

import type { DataChannelTransport } from "@fuck-eu-chat-control/chat-runtime/transport/types";
import { type PeerTransport, toPeerTransport } from "@fuck-eu-chat-control/chat-runtime/transport/peer-transport";

/**
 * Minimal neutral fake of {@link DataChannelTransport}. The real web adapter
 * (`apps/web/.../webrtc-adapter.ts`) implements this surface against
 * `RTCDataChannel`; here we only stub the members {@link toPeerTransport}
 * actually reads so the adaptation logic can be exercised without any platform
 * WebRTC dependency.
 *
 * The drain notification surfaces as a single stored listener (matching how the
 * web adapter wires `bufferedamountlow`), and inbound payloads are buffered
 * until the consumer registers a handler.
 */
class FakeChannelTransport implements DataChannelTransport {
  public bufferedAmount = 0;
  public readyState: "open" | "closed" = "open";
  private readonly sent: Uint8Array[] = [];
  private drainListener: (() => void) | null = null;
  private messageHandler: ((bytes: Uint8Array) => void) | null = null;
  private readonly pendingMessages: Uint8Array[] = [];
  private readonly openListeners: Set<() => void> = new Set();
  private closed = false;

  public get ready(): boolean {
    return this.readyState === "open";
  }

  public send(bytes: Uint8Array): void {
    this.sent.push(bytes);
  }

  public setDrainListener(listener: (() => void) | null): void {
    this.drainListener = listener;
  }

  public setOnMessage(handler: ((bytes: Uint8Array) => void) | null): void {
    this.messageHandler = handler;
    if (handler !== null) {
      for (const pending of this.pendingMessages) {
        handler(pending);
      }
      this.pendingMessages.length = 0;
    }
  }

  public onOpen(listener: () => void): void {
    this.openListeners.add(listener);
  }

  public close(): void {
    this.closed = true;
    this.readyState = "closed";
  }

  /** Test affordance: deliver an inbound payload to the registered handler. */
  public deliver(bytes: Uint8Array): void {
    if (this.messageHandler !== null) {
      this.messageHandler(bytes);
    } else {
      this.pendingMessages.push(bytes);
    }
  }

  /** Test affordance: fire the drain listener registered via setDrainListener. */
  public fireDrain(): void {
    if (this.drainListener !== null) {
      this.drainListener();
    }
  }

  /** Test affordance: snapshots of bytes handed to send(). */
  public sentBytes(): readonly Uint8Array[] {
    return this.sent;
  }

  /** Test affordance: whether close() was invoked. */
  public isClosed(): boolean {
    return this.closed;
  }
}

function makeTransport(): FakeChannelTransport {
  return new FakeChannelTransport();
}

function assertBytesEqual(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual).toBeInstanceOf(Uint8Array);
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    expect(actual[i]).toBe(expected[i]);
  }
}

describe("toPeerTransport", () => {
  it("returns a PeerTransport that delegates send", () => {
    const channel = makeTransport();
    const peer = toPeerTransport(channel);

    const payload = new Uint8Array([7, 8, 9]);
    peer.send(payload);

    expect(channel.sentBytes()).toHaveLength(1);
    expect(channel.sentBytes()[0]).toBe(payload);
  });

  it("exposes ready === true when channel is open", () => {
    const channel = makeTransport();
    const peer = toPeerTransport(channel);
    expect(peer.ready).toBe(true);
  });

  it("exposes ready === false when channel is closed", () => {
    const channel = makeTransport();
    channel.readyState = "closed";
    const peer = toPeerTransport(channel);
    expect(peer.ready).toBe(false);
  });

  it("reflects bufferedAmount from the underlying channel", () => {
    const channel = makeTransport();
    const peer = toPeerTransport(channel);
    channel.bufferedAmount = 42;
    expect(peer.bufferedAmount).toBe(42);
  });

  it("delegates setOnMessage to the underlying transport", () => {
    const channel = makeTransport();
    const peer = toPeerTransport(channel);

    const received: Uint8Array[] = [];
    peer.setOnMessage((bytes) => {
      received.push(bytes);
    });

    const payload = new Uint8Array([11, 22, 33]);
    channel.deliver(payload);
    expect(received).toHaveLength(1);
    assertBytesEqual(received[0]!, payload);
  });

  it("routes setOnDrain(fn) to the underlying setDrainListener", () => {
    const channel = makeTransport();
    const peer = toPeerTransport(channel);

    const drainHandler = vi.fn();
    peer.setOnDrain(drainHandler);

    channel.fireDrain();
    expect(drainHandler).toHaveBeenCalledTimes(1);
  });

  it("routes setOnDrain(null) to detach the drain listener", () => {
    const channel = makeTransport();
    const peer = toPeerTransport(channel);

    const drainHandler = vi.fn();
    peer.setOnDrain(drainHandler);
    peer.setOnDrain(null);

    channel.fireDrain();
    expect(drainHandler).not.toHaveBeenCalled();
  });

  it("closes the underlying channel", () => {
    const channel = makeTransport();
    const peer = toPeerTransport(channel);
    peer.close();
    expect(channel.isClosed()).toBe(true);
    expect(channel.readyState).toBe("closed");
    expect(peer.ready).toBe(false);
  });

  it("the returned value satisfies the PeerTransport shape", () => {
    const channel = makeTransport();
    const peer: PeerTransport = toPeerTransport(channel);

    // Touch each member to confirm the surface is present.
    expect(typeof peer.send).toBe("function");
    expect(typeof peer.ready).toBe("boolean");
    expect(typeof peer.bufferedAmount).toBe("number");
    expect(typeof peer.setOnMessage).toBe("function");
    expect(typeof peer.setOnDrain).toBe("function");
    expect(typeof peer.close).toBe("function");
  });
});
