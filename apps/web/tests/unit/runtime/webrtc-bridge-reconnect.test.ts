import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encodeConversationId } from "@fuck-eu-chat-control/chat-runtime/protocol/codec";
import { CONVERSATION_ID_BYTES } from "@fuck-eu-chat-control/chat-runtime/protocol/limits";
import { Role } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import type { ConversationId } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import { WebRtcBridge } from "@fuck-eu-chat-control/chat-runtime/runtime/webrtc-bridge";
import { WebRtcAdapter } from "@/features/chat/signaling/webrtc-adapter";

import { MockSignalingSocket, parse } from "../signaling/_helpers";

/**
 * R3F6 (Phase 8): WebRtcBridge.reconnect() re-establishes the bridge's
 * transport after a drop — fresh signaling socket (re-join), fresh peer
 * connection, offer re-initiation under the corrected glare rules — and
 * resets the post-handshake suppression so a close of the RE-ESTABLISHED
 * socket surfaces again.
 *
 * The fake RTCPeerConnection here combines the surfaces the two prior suites
 * needed: full SDP operations (so the initiator offer path runs) plus
 * listener dispatch and an already-open data channel (so
 * maybeFireTransportReady can be driven into the broker-teardown grace
 * window). A FRESH instance is constructed per adapter so the reconnect's
 * peer-connection swap is observable.
 */
class StubRtcPeerConnection {
  public connectionState: RTCPeerConnectionState = "new";
  public readonly listeners: { type: string; fn: (event: unknown) => void }[] = [];
  public readonly createdChannels: StubDataChannel[] = [];
  public readonly localDescTypes: string[] = [];
  public rollbackCount = 0;
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

  public async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: "stub-offer-sdp" };
  }

  public async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: "stub-answer-sdp" };
  }

  public async setLocalDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this.localDescTypes.push(desc.type);
    if (desc.type === "rollback") this.rollbackCount++;
  }

  public async setRemoteDescription(_desc: RTCSessionDescriptionInit): Promise<void> {
    // no-op: no SDP semantics needed
  }

  public async addIceCandidate(_candidate: RTCIceCandidateInit): Promise<void> {
    // no-op
  }

  public createDataChannel(_label: string): StubDataChannel {
    const channel = new StubDataChannel();
    this.createdChannels.push(channel);
    return channel;
  }

  public close(): void {
    this.closed = true;
  }
}

/** Minimal RTCDataChannel double; channels start OPEN so transportReady is drivable. */
class StubDataChannel {
  public binaryType: BinaryType = "arraybuffer";
  public bufferedAmountLowThreshold = 0;
  public bufferedAmount = 0;
  public readyState: RTCDataChannelState = "open";
  public readonly listeners: { type: string; fn: (event: unknown) => void }[] = [];
  public closed = false;

  public addEventListener(type: string, fn: (event: unknown) => void): void {
    this.listeners.push({ type, fn });
  }

  public removeEventListener(type: string, fn: (event: unknown) => void): void {
    const idx = this.listeners.findIndex((l) => l.type === type && l.fn === fn);
    if (idx >= 0) this.listeners.splice(idx, 1);
  }

  public send(_data: unknown): void {
    // no-op
  }

  public close(): void {
    this.closed = true;
    this.readyState = "closed";
  }
}

const originalRtc = (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;

/** Install a constructor that produces + records a FRESH stub per call. */
function installStubRtc(): StubRtcPeerConnection[] {
  const instances: StubRtcPeerConnection[] = [];
  (globalThis as { RTCPeerConnection: unknown }).RTCPeerConnection = function () {
    const instance = new StubRtcPeerConnection();
    instances.push(instance);
    return instance;
  } as unknown as typeof RTCPeerConnection;
  return instances;
}

function restoreRtc(): void {
  if (originalRtc === undefined) {
    delete (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
  } else {
    (globalThis as { RTCPeerConnection: unknown }).RTCPeerConnection = originalRtc;
  }
}

/** Multi-socket factory: every dial gets a fresh mock, recorded in order. */
function socketPool(): { sockets: MockSignalingSocket[]; factory: () => MockSignalingSocket } {
  const sockets: MockSignalingSocket[] = [];
  return {
    sockets,
    factory: (): MockSignalingSocket => {
      const socket = new MockSignalingSocket();
      sockets.push(socket);
      return socket;
    },
  };
}

function deterministicConversationId(seed: number): ConversationId {
  const bytes = new Uint8Array(CONVERSATION_ID_BYTES);
  for (let i = 0; i < CONVERSATION_ID_BYTES; i++) bytes[i] = (seed * 31 + i) & 0xff;
  return encodeConversationId(bytes);
}

function roomHex(roomId: ConversationId): string {
  let hex = "";
  for (let i = 0; i < roomId.length; i++) {
    hex += roomId[i].toString(16).padStart(2, "0");
  }
  return hex;
}

function countKind(socket: MockSignalingSocket, kind: string): number {
  return socket.sent.filter((raw) => parse(raw).t === kind).length;
}

describe("R3F6: WebRtcBridge.reconnect() after the broker-teardown grace", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    restoreRtc();
  });

  it("re-dials signaling, rebuilds the peer connection, re-joins + re-offers, and surfaces the new socket's close", async () => {
    const pcs = installStubRtc();
    const pool = socketPool();
    const roomId = deterministicConversationId(31);
    let transportReadyCalls = 0;
    let signalingClosedCalls = 0;
    const bridge = new WebRtcBridge({
      brokerUrl: "wss://broker.example",
      roomId,
      role: Role.Initiator,
      socketFactory: pool.factory,
      iceServers: [],
      peerConnectionFactory: (opts) => new WebRtcAdapter(opts),
      transportReady: () => {
        transportReadyCalls++;
      },
      onSignalingClosed: () => {
        signalingClosedCalls++;
      },
    });
    bridge.start();

    // First connection: socket #1 dials, joins, the peer joins, we offer.
    const first = pool.sockets[0];
    expect(first).toBeDefined();
    first.serverOpen();
    expect(countKind(first, "join")).toBe(1);
    first.deliver(JSON.stringify({ t: "join", roomId: roomHex(roomId) }));
    await vi.advanceTimersByTimeAsync(0);
    expect(countKind(first, "offer")).toBe(1);

    // P2P established: drive transportReady (open channel + connected state)
    // and let the grace window elapse so the broker socket is dropped for
    // good — the pre-retry state the finding describes.
    const pc1 = pcs[0];
    expect(pc1).toBeDefined();
    pc1.connectionState = "connected";
    pc1.dispatch("connectionstatechange", {});
    expect(transportReadyCalls).toBe(1);
    vi.advanceTimersByTime(2_000);
    expect(first.closed).toBe(true);
    expect(countKind(first, "leave")).toBe(1);
    // The post-handshake close is suppressed (and the stale socket's close
    // is dropped by the client's identity guard): nothing surfaced.
    expect(signalingClosedCalls).toBe(0);

    // Reconnect: fresh dial + fresh peer connection; the dead adapter is
    // closed and its callbacks orphaned.
    bridge.reconnect();
    expect(pcs.length).toBe(2);
    expect(pc1.closed).toBe(true);

    const second = pool.sockets[1];
    expect(second).toBeDefined();
    second.serverOpen();
    expect(countKind(second, "join")).toBe(1);

    // Peer re-joins: the initiator re-offers on the NEW socket, from the
    // NEW peer connection.
    second.deliver(JSON.stringify({ t: "join", roomId: roomHex(roomId) }));
    await vi.advanceTimersByTimeAsync(0);
    expect(countKind(second, "offer")).toBe(1);
    const pc2 = pcs[1];
    expect(pc2).toBeDefined();
    expect(pc2.createdChannels.length).toBe(1);

    // The suppression was reset: a close of the RE-ESTABLISHED socket (e.g.
    // broker restart) surfaces again instead of being swallowed.
    second.serverClose();
    expect(signalingClosedCalls).toBe(1);

    bridge.close();
  });

  it("reconnect during the grace window cancels the pending broker teardown of the fresh socket", async () => {
    const pcs = installStubRtc();
    const pool = socketPool();
    const roomId = deterministicConversationId(32);
    const bridge = new WebRtcBridge({
      brokerUrl: "wss://broker.example",
      roomId,
      role: Role.Responder,
      socketFactory: pool.factory,
      iceServers: [],
      peerConnectionFactory: (opts) => new WebRtcAdapter(opts),
      transportReady: () => {
        // expected once on the first connection
      },
    });
    bridge.start();
    const first = pool.sockets[0];
    expect(first).toBeDefined();
    first.serverOpen();

    // Transport becomes ready mid-grace (the socket is still open), then
    // the user hits retry before the 2s teardown fires.
    const pc1 = pcs[0];
    expect(pc1).toBeDefined();
    pc1.connectionState = "connected";
    pc1.dispatch("connectionstatechange", {});
    vi.advanceTimersByTime(1_000);
    expect(first.closed).toBe(false);

    bridge.reconnect();
    // The dropped socket is evicted (leave relayed — it was still room
    // joined — then closed) so the capacity-2 room slot is free.
    expect(countKind(first, "leave")).toBe(1);
    expect(first.closed).toBe(true);

    // The pending grace timer must NOT fire against the fresh socket:
    // advancing past the original window leaves the new dial untouched.
    const second = pool.sockets[1];
    expect(second).toBeDefined();
    second.serverOpen();
    vi.advanceTimersByTime(3_000);
    expect(second.closed).toBe(false);
    expect(countKind(second, "leave")).toBe(0);

    bridge.close();
  });
});
