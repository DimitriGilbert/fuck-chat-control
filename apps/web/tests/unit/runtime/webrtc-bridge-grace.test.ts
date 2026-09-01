import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encodeConversationId } from "@fuck-eu-chat-control/chat-runtime/protocol/codec";
import { CONVERSATION_ID_BYTES } from "@fuck-eu-chat-control/chat-runtime/protocol/limits";
import { Role } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import type { ConversationId } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import { WebRtcBridge } from "@fuck-eu-chat-control/chat-runtime/runtime/webrtc-bridge";
import { WebRtcAdapter } from "@/features/chat/signaling/webrtc-adapter";

import { MockSignalingSocket, parse } from "../signaling/_helpers";
import { mockSocketFactory } from "../orchestrator/_helpers";

/**
 * LW-21 (Phase 7b): the bridge fires signalP2pOpen exactly once, after the
 * BROKER_TEARDOWN_GRACE_MS window elapses, to drop the broker from the data
 * path once the P2P data channel is carrying bytes. This is the FIRST use of
 * fake timers in the webrtc-bridge suite area; it pins the grace-timer
 * contract (exactly-once signalP2pOpen, leave + readyState===3) that a
 * regression could easily break (double-fire, never-fire, or fire-before-grace).
 *
 * The bridge constructs a real WebRtcAdapter, which constructs a real
 * RTCPeerConnection. We stub the global RTCPeerConnection with an event-target
 * double whose connectionState is settable and whose listeners we can dispatch
 * to, so we can drive the bridge into `maybeFireTransportReady` without a real
 * ICE exchange. The full P2P path is validated end-to-end via Playwright.
 */

interface StubEventListener {
  readonly type: string;
  readonly fn: (event: unknown) => void;
}

class StubRtcPeerConnection {
  public connectionState: RTCPeerConnectionState = "new";
  public readonly listeners: StubEventListener[] = [];
  public readonly createdChannels: StubDataChannel[] = [];
  public closed = false;

  public addEventListener(type: string, fn: (event: unknown) => void): void {
    this.listeners.push({ type, fn });
  }

  public removeEventListener(type: string, fn: (event: unknown) => void): void {
    const idx = this.listeners.findIndex((l) => l.type === type && l.fn === fn);
    if (idx >= 0) this.listeners.splice(idx, 1);
  }

  public dispatch(type: string, event: unknown): void {
    for (const l of Array.from(this.listeners)) {
      if (l.type === type) l.fn(event);
    }
  }

  public createDataChannel(_label: string, _options?: RTCDataChannelInit): StubDataChannel {
    const channel = new StubDataChannel();
    this.createdChannels.push(channel);
    return channel;
  }

  public close(): void {
    this.closed = true;
  }
}

/**
 * Minimal RTCDataChannel double. The DataChannelTransport wrapper touches
 * `binaryType`, `bufferedAmountLowThreshold`, `readyState`, `addEventListener`,
 * `removeEventListener`, `send`, and `close`. We implement exactly that surface
 * so the wrapper constructs and tears down without a real RTCDataChannel.
 */
class StubDataChannel {
  public binaryType: BinaryType = "arraybuffer";
  public bufferedAmountLowThreshold = 0;
  public bufferedAmount = 0;
  public readyState: RTCDataChannelState = "open";
  public readonly listeners: StubEventListener[] = [];
  public closed = false;

  public addEventListener(type: string, fn: (event: unknown) => void): void {
    this.listeners.push({ type, fn });
  }

  public removeEventListener(type: string, fn: (event: unknown) => void): void {
    const idx = this.listeners.findIndex((l) => l.type === type && l.fn === fn);
    if (idx >= 0) this.listeners.splice(idx, 1);
  }

  public dispatch(type: string): void {
    for (const l of Array.from(this.listeners)) {
      if (l.type === type) l.fn({});
    }
  }

  public send(_data: unknown): void {
    // no-op for the grace-timer test
  }

  public close(): void {
    this.closed = true;
    this.readyState = "closed";
  }
}

const originalRtc = (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;

function installStubRtc(): StubRtcPeerConnection {
  const instance = new StubRtcPeerConnection();
  (globalThis as { RTCPeerConnection: unknown }).RTCPeerConnection = function () {
    return instance;
  } as unknown as typeof RTCPeerConnection;
  return instance;
}

function restoreRtc(): void {
  if (originalRtc === undefined) {
    delete (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
  } else {
    (globalThis as { RTCPeerConnection: unknown }).RTCPeerConnection = originalRtc;
  }
}

function deterministicConversationId(seed: number): ConversationId {
  const bytes = new Uint8Array(CONVERSATION_ID_BYTES);
  for (let i = 0; i < CONVERSATION_ID_BYTES; i++) bytes[i] = (seed * 31 + i) & 0xff;
  return encodeConversationId(bytes);
}

describe("LW-21: WebRtcBridge broker-teardown grace timer (BROKER_TEARDOWN_GRACE_MS)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    restoreRtc();
  });

  it("fires signalP2pOpen exactly once after the grace window; leave + readyState===3 result", () => {
    // Arrange: stub the RTCPeerConnection so we can drive the bridge's
    // maybeFireTransportReady path by dispatching a datachannel event (carrying
    // an already-open channel) and a connectionstatechange to "connected".
    const stubPc = installStubRtc();
    const socket = new MockSignalingSocket();
    const roomId = deterministicConversationId(21);
    let transportReadyCalls = 0;
    const bridge = new WebRtcBridge({
      brokerUrl: "wss://broker.example",
      roomId,
      role: Role.Responder,
      socketFactory: mockSocketFactory(socket),
      iceServers: [],
      peerConnectionFactory: (opts) => new WebRtcAdapter(opts),
      transportReady: () => {
        transportReadyCalls++;
      },
    });
    bridge.start();
    // The signaling client connects synchronously through the mock socket;
    // open it so the join lands and the bridge is ready to negotiate.
    socket.serverOpen();

    // Act: deliver a data channel whose readyState is "open" and flip the
    // peer connection to "connected". The bridge's recordChannel + state
    // change handler cooperate to fire maybeFireTransportReady, which:
    //   1. fires transportReady (exactly once),
    //   2. arms the brokerTeardownTimer for BROKER_TEARDOWN_GRACE_MS.
    const channel = new StubDataChannel();
    channel.readyState = "open";
    stubPc.dispatch("datachannel", { channel });
    // The state change to "connected" is the second trigger; combined with the
    // open channel it satisfies maybeFireTransportReady's guards.
    stubPc.connectionState = "connected";
    stubPc.dispatch("connectionstatechange", {});

    // Assert: transportReady fired exactly once, and BEFORE the grace window
    // the broker socket is still open (no leave sent yet).
    expect(transportReadyCalls).toBe(1);
    expect(socket.closed).toBe(false);
    const leavesBeforeGrace = socket.sent.filter((raw) => {
      const msg = parse(raw);
      return msg.t === "leave";
    });
    expect(leavesBeforeGrace).toHaveLength(0);

    // Advance JUST SHORT of the grace window: still no leave, socket still open.
    vi.advanceTimersByTime(1_999);
    expect(socket.closed).toBe(false);
    expect(socket.readyState).not.toBe(3);

    // Advance PAST the grace window: the timer fires signalP2pOpen, which
    // sends `leave` and tears down the socket (readyState → 3).
    vi.advanceTimersByTime(1);
    const leavesAfterGrace = socket.sent.filter((raw) => {
      const msg = parse(raw);
      return msg.t === "leave";
    });
    expect(leavesAfterGrace).toHaveLength(1);
    expect(socket.closed).toBe(true);
    expect(socket.readyState).toBe(3);

    // Assert exactly-once: advancing further must NOT fire another leave. The
    // timer is one-shot (cleared in its own callback) and transportReadyFired
    // guards re-entry, so a second grace tick is impossible.
    vi.advanceTimersByTime(5_000);
    const leavesAfterExtra = socket.sent.filter((raw) => {
      const msg = parse(raw);
      return msg.t === "leave";
    });
    expect(leavesAfterExtra).toHaveLength(1);
    expect(transportReadyCalls).toBe(1);

    bridge.close();
  });

  it("does NOT fire signalP2pOpen before the grace window even if transportReady fired", () => {
    // Companion assertion: the grace window is a floor, not a hint. Pinning
    // "nothing happens at 1999ms" alongside the positive test makes a
    // regression that fired eagerly (e.g. setTimeout(…, 0)) surface here too.
    const stubPc = installStubRtc();
    const socket = new MockSignalingSocket();
    const roomId = deterministicConversationId(22);
    const bridge = new WebRtcBridge({
      brokerUrl: "wss://broker.example",
      roomId,
      role: Role.Responder,
      socketFactory: mockSocketFactory(socket),
      iceServers: [],
      peerConnectionFactory: (opts) => new WebRtcAdapter(opts),
      transportReady: () => {
        // expected once
      },
    });
    bridge.start();
    socket.serverOpen();

    const channel = new StubDataChannel();
    channel.readyState = "open";
    stubPc.dispatch("datachannel", { channel });
    stubPc.connectionState = "connected";
    stubPc.dispatch("connectionstatechange", {});

    // Half the grace window: definitely no leave yet.
    vi.advanceTimersByTime(1_000);
    const leaves = socket.sent.filter((raw) => parse(raw).t === "leave");
    expect(leaves).toHaveLength(0);
    expect(socket.closed).toBe(false);

    bridge.close();
  });

  it("close() before the grace window cancels the pending signalP2pOpen", () => {
    // If the bridge is torn down mid-grace, the pending leave must NOT fire on
    // a closed bridge (it would send on a socket the bridge no longer owns).
    const stubPc = installStubRtc();
    const socket = new MockSignalingSocket();
    const roomId = deterministicConversationId(23);
    const bridge = new WebRtcBridge({
      brokerUrl: "wss://broker.example",
      roomId,
      role: Role.Responder,
      socketFactory: mockSocketFactory(socket),
      iceServers: [],
      peerConnectionFactory: (opts) => new WebRtcAdapter(opts),
      transportReady: () => {
        // expected
      },
    });
    bridge.start();
    socket.serverOpen();

    const channel = new StubDataChannel();
    channel.readyState = "open";
    stubPc.dispatch("datachannel", { channel });
    stubPc.connectionState = "connected";
    stubPc.dispatch("connectionstatechange", {});

    // Tear down mid-grace. close() clears brokerTeardownTimer.
    bridge.close();
    // Advancing past the grace must not produce a leave — the timer was
    // cancelled by close().
    vi.advanceTimersByTime(3_000);
    const leaves = socket.sent.filter((raw) => parse(raw).t === "leave");
    expect(leaves).toHaveLength(0);
  });
});
