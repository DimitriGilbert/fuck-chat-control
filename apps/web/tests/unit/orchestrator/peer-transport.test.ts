import { describe, expect, it, vi } from "vitest";

import { DataChannelTransport } from "@/features/chat/signaling/webrtc-adapter";

import { type PeerTransport, toPeerTransport } from "@/features/chat/orchestrator/peer-transport";

/**
 * Minimal RTCDataChannel test double. Only the surface that
 * DataChannelTransport actually reads is implemented.
 *
 * Cast to RTCDataChannel at the construction site via `unknown`
 * (test-only escape hatch — no `any`).
 */
class FakeChannel {
  public binaryType: string = "blob";
  public bufferedAmount = 0;
  public bufferedAmountLowThreshold = 0;
  public readyState: RTCDataChannelState = "open";
  public onmessage: ((ev: MessageEvent) => void) | null = null;
  public onbufferedamountlow: ((ev: Event) => void) | null = null;
  private readonly eventListeners: Map<string, Set<(ev: Event) => void>> = new Map();

  public addEventListener(type: string, listener: (ev: Event) => void): void {
    let set = this.eventListeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.eventListeners.set(type, set);
    }
    set.add(listener);
  }

  public removeEventListener(type: string, listener: (ev: Event) => void): void {
    const set = this.eventListeners.get(type);
    if (set !== undefined) {
      set.delete(listener);
    }
  }

  public send(_data: ArrayBuffer | string): void {
    // No-op for tests; reflection of outgoing bytes is not needed here.
  }

  public close(): void {
    this.readyState = "closed";
  }

  /** Fire the message listeners registered via addEventListener("message", ...). */
  public fireMessage(data: unknown): void {
    const event = new MessageEvent("message", { data });
    const set = this.eventListeners.get("message");
    if (set !== undefined) {
      for (const listener of set) {
        listener(event);
      }
    }
    if (this.onmessage !== null) {
      this.onmessage(event);
    }
  }

  /** Fire the bufferedamountlow listener set by DataChannelTransport. */
  public fireBufferedAmountLow(): void {
    const event = new Event("bufferedamountlow");
    const set = this.eventListeners.get("bufferedamountlow");
    if (set !== undefined) {
      for (const listener of set) {
        listener(event);
      }
    }
    if (this.onbufferedamountlow !== null) {
      this.onbufferedamountlow(event);
    }
  }
}

function makeTransport(): { transport: DataChannelTransport; channel: FakeChannel } {
  const channel = new FakeChannel();
  const transport = new DataChannelTransport({ channel: channel as unknown as RTCDataChannel });
  return { transport, channel };
}

function assertBytesEqual(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual).toBeInstanceOf(Uint8Array);
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    expect(actual[i]).toBe(expected[i]);
  }
}

describe("DataChannelTransport.setOnMessage", () => {
  it("delivers an ArrayBuffer payload to the handler as a Uint8Array", () => {
    const { transport, channel } = makeTransport();
    const received: Uint8Array[] = [];
    transport.setOnMessage((bytes) => {
      received.push(bytes);
    });

    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    channel.fireMessage(payload.buffer);

    expect(received.length).toBe(1);
    assertBytesEqual(received[0]!, payload);
  });

  it("coerces each event's ArrayBuffer independently (no shared backing)", () => {
    const { transport, channel } = makeTransport();
    const received: Uint8Array[] = [];
    transport.setOnMessage((bytes) => {
      received.push(bytes);
    });

    const first = new Uint8Array([10, 20]);
    const second = new Uint8Array([30, 40, 50]);
    channel.fireMessage(first.buffer);
    channel.fireMessage(second.buffer);

    expect(received.length).toBe(2);
    assertBytesEqual(received[0]!, first);
    assertBytesEqual(received[1]!, second);
  });

  it("ignores non-ArrayBuffer payloads (string)", () => {
    const { transport, channel } = makeTransport();
    const handler = vi.fn();
    transport.setOnMessage(handler);

    channel.fireMessage("text-not-binary");
    expect(handler).not.toHaveBeenCalled();
  });

  it("ignores null/undefined payload", () => {
    const { transport, channel } = makeTransport();
    const handler = vi.fn();
    transport.setOnMessage(handler);

    channel.fireMessage(null);
    channel.fireMessage(undefined);
    expect(handler).not.toHaveBeenCalled();
  });

  it("detaches when called with null — subsequent events do not invoke the prior handler", () => {
    const { transport, channel } = makeTransport();
    const handler = vi.fn();
    transport.setOnMessage(handler);
    transport.setOnMessage(null);

    const payload = new Uint8Array([255]);
    channel.fireMessage(payload.buffer);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("toPeerTransport", () => {
  it("returns a PeerTransport that delegates send", () => {
    const { transport, channel } = makeTransport();
    const peer = toPeerTransport(transport);

    const sendSpy = vi.spyOn(channel, "send");
    const payload = new Uint8Array([7, 8, 9]);
    peer.send(payload);

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0]![0]).toBe(payload);
  });

  it("exposes ready === true when channel is open", () => {
    const { transport } = makeTransport();
    const peer = toPeerTransport(transport);
    expect(peer.ready).toBe(true);
  });

  it("exposes ready === false when channel is closed", () => {
    const { transport, channel } = makeTransport();
    channel.readyState = "closed";
    const peer = toPeerTransport(transport);
    expect(peer.ready).toBe(false);
  });

  it("reflects bufferedAmount from the underlying channel", () => {
    const { transport, channel } = makeTransport();
    const peer = toPeerTransport(transport);
    channel.bufferedAmount = 42;
    expect(peer.bufferedAmount).toBe(42);
  });

  it("delegates setOnMessage to the underlying transport", () => {
    const { transport, channel } = makeTransport();
    const peer = toPeerTransport(transport);

    const received: Uint8Array[] = [];
    peer.setOnMessage((bytes) => {
      received.push(bytes);
    });

    const payload = new Uint8Array([11, 22, 33]);
    channel.fireMessage(payload.buffer);
    expect(received.length).toBe(1);
    assertBytesEqual(received[0]!, payload);
  });

  it("routes setOnDrain(fn) to the underlying setDrainListener", () => {
    const { transport, channel } = makeTransport();
    const peer = toPeerTransport(transport);

    const drainHandler = vi.fn();
    peer.setOnDrain(drainHandler);

    channel.fireBufferedAmountLow();
    expect(drainHandler).toHaveBeenCalledTimes(1);
  });

  it("routes setOnDrain(null) to detach the drain listener", () => {
    const { transport, channel } = makeTransport();
    const peer = toPeerTransport(transport);

    const drainHandler = vi.fn();
    peer.setOnDrain(drainHandler);
    peer.setOnDrain(null);

    channel.fireBufferedAmountLow();
    expect(drainHandler).not.toHaveBeenCalled();
  });

  it("closes the underlying channel", () => {
    const { transport, channel } = makeTransport();
    const peer = toPeerTransport(transport);
    peer.close();
    expect(channel.readyState).toBe("closed");
    expect(peer.ready).toBe(false);
  });

  it("the returned value satisfies the PeerTransport shape", () => {
    const { transport } = makeTransport();
    const peer: PeerTransport = toPeerTransport(transport);

    // Touch each member to confirm the surface is present.
    expect(typeof peer.send).toBe("function");
    expect(typeof peer.ready).toBe("boolean");
    expect(typeof peer.bufferedAmount).toBe("number");
    expect(typeof peer.setOnMessage).toBe("function");
    expect(typeof peer.setOnDrain).toBe("function");
    expect(typeof peer.close).toBe("function");
  });
});
