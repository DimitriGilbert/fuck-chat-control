import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encodeConversationId } from "@fuck-eu-chat-control/chat-runtime/protocol/codec";
import { CONVERSATION_ID_BYTES } from "@fuck-eu-chat-control/chat-runtime/protocol/limits";
import { Role } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import type { ConversationId } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import type { PeerTransport } from "@fuck-eu-chat-control/chat-runtime/transport/peer-transport";
import type {
  DataChannelTransport,
  IceCandidate,
  PeerConnection,
  PeerConnectionFactory,
  PeerConnectionFactoryOptions,
  PeerConnectionState,
  SessionDescription,
} from "@fuck-eu-chat-control/chat-runtime/transport/types";
import { WebRtcBridge } from "@fuck-eu-chat-control/chat-runtime/runtime/webrtc-bridge";

import { parse } from "../signaling/_helpers";
import { SocketPool } from "./_helpers";

/**
 * Phase 4 (R7F1 / R7F8 / R7F9 / R7F7): bridge-side negotiation-lifecycle
 * tests built on a controllable {@link PeerConnection} fake — gated SDP
 * promises (so a coroutine can be parked mid-await), a data channel that
 * records close() and can fire `open`, and direct access to the handlers
 * the bridge registered so the test can drive onDataChannel /
 * onConnectionStateChange exactly like a real adapter.
 */

class TestDataChannel implements DataChannelTransport {
  public readonly bufferedAmount = 0;
  public ready = false;
  public closed = false;
  public readonly sentBytes: Uint8Array[] = [];
  private openListener: (() => void) | null = null;

  public send(bytes: Uint8Array): void {
    this.sentBytes.push(bytes);
  }

  public setDrainListener(_listener: (() => void) | null): void {
    // no-op
  }

  public setOnMessage(_handler: ((bytes: Uint8Array) => void) | null): void {
    // no-op
  }

  public onOpen(listener: () => void): void {
    this.openListener = listener;
  }

  public fireOpen(): void {
    this.ready = true;
    this.openListener?.();
  }

  public close(): void {
    this.closed = true;
    this.ready = false;
  }
}

class TestPeerConnection implements PeerConnection {
  public connectionState: PeerConnectionState = "new";
  public closed = false;
  public readonly localDescTypes: string[] = [];
  public readonly remoteDescTypes: string[] = [];
  public readonly createdChannels: TestDataChannel[] = [];
  /** Park every createOffer()/setRemoteDescription() on a manual gate. */
  public parkOffers = false;
  public parkRemoteDescriptions = false;
  private readonly handlers: PeerConnectionFactoryOptions;
  private readonly offerWaiters: Array<(desc: SessionDescription) => void> = [];
  private readonly remoteWaiters: Array<() => void> = [];

  public constructor(options: PeerConnectionFactoryOptions) {
    this.handlers = options;
  }

  public createOffer(): Promise<SessionDescription> {
    if (!this.parkOffers) {
      return Promise.resolve({ type: "offer", sdp: "test-offer-sdp" });
    }
    return new Promise<SessionDescription>((resolve) => {
      this.offerWaiters.push(resolve);
    });
  }

  public releaseOffer(): void {
    this.offerWaiters.shift()?.({ type: "offer", sdp: "test-offer-sdp" });
  }

  public createAnswer(): Promise<SessionDescription> {
    return Promise.resolve({ type: "answer", sdp: "test-answer-sdp" });
  }

  public setLocalDescription(description: SessionDescription): Promise<void> {
    this.localDescTypes.push(description.type);
    return Promise.resolve();
  }

  public setRemoteDescription(description: SessionDescription): Promise<void> {
    if (!this.parkRemoteDescriptions) {
      this.remoteDescTypes.push(description.type);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.remoteWaiters.push(() => {
        this.remoteDescTypes.push(description.type);
        resolve();
      });
    });
  }

  public releaseRemote(): void {
    this.remoteWaiters.shift()?.();
  }

  public addIceCandidate(_candidate: IceCandidate): Promise<void> {
    return Promise.resolve();
  }

  public createDataChannel(): DataChannelTransport {
    const channel = new TestDataChannel();
    this.createdChannels.push(channel);
    return channel;
  }

  /** Drive the responder-side channel event like a real adapter would. */
  public fireDataChannel(channel: DataChannelTransport): void {
    this.handlers.onDataChannel?.(channel);
  }

  public fireConnectionState(state: PeerConnectionState): void {
    this.connectionState = state;
    this.handlers.onConnectionStateChange?.(state);
  }

  public close(): void {
    this.closed = true;
  }
}

function testPeerConnectionFactory(): {
  readonly factory: PeerConnectionFactory;
  readonly instances: TestPeerConnection[];
} {
  const instances: TestPeerConnection[] = [];
  return {
    factory: (options) => {
      const instance = new TestPeerConnection(options);
      instances.push(instance);
      return instance;
    },
    instances,
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

function countKind(socket: { readonly sent: string[] }, kind: string): number {
  return socket.sent.filter((raw) => parse(raw).t === kind).length;
}

function flush(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve));
}

describe("R7F1: polite-glare rollback adopts the answering-side channel", () => {
  it("closes the losing local channel and routes bytes over the channel delivered by onDataChannel", async () => {
    const pool = new SocketPool();
    const pcs = testPeerConnectionFactory();
    const roomId = deterministicConversationId(41);
    const transports: PeerTransport[] = [];
    const bridge = new WebRtcBridge({
      brokerUrl: "wss://broker.example",
      roomId,
      // Responder = polite: a remote offer colliding with its in-flight
      // offer rolls the local one back.
      role: Role.Responder,
      socketFactory: pool.factory,
      iceServers: [],
      peerConnectionFactory: pcs.factory,
      transportReady: (t) => {
        transports.push(t);
      },
    });
    bridge.start();
    const socket = pool.sockets[0];
    expect(socket).toBeDefined();
    socket.serverOpen();
    const pc = pcs.instances[0];
    expect(pc).toBeDefined();
    pc.parkOffers = true;

    // Peer joins → initiateOffer creates and records the LOSING local
    // channel, then parks inside createOffer.
    socket.deliver(JSON.stringify({ t: "join", roomId: roomHex(roomId) }));
    await flush();
    expect(pc.createdChannels).toHaveLength(1);
    const losingChannel = pc.createdChannels[0];
    expect(losingChannel).toBeDefined();
    expect(losingChannel.closed).toBe(false);

    // The colliding remote offer arrives mid-window: polite side rolls back
    // its local description AND — the R7F1 fix — closes/clears the losing
    // channel so the answering side's channel can be adopted.
    socket.deliver(JSON.stringify({ t: "offer", sdp: { type: "offer", sdp: "remote-offer" } }));
    await flush();
    expect(pc.localDescTypes).toContain("rollback");
    expect(losingChannel.closed).toBe(true);
    expect(countKind(socket, "answer")).toBe(1);

    // The peer's DCEP-created channel arrives via onDataChannel and must be
    // adopted — pre-fix, recordChannel's first-wins guard dropped it because
    // nego.channel still pointed at the losing channel, leaving the two ends
    // on disjoint SCTP streams.
    const adopted = new TestDataChannel();
    pc.fireDataChannel(adopted);
    adopted.fireOpen();
    pc.fireConnectionState("connected");

    expect(transports).toHaveLength(1);
    transports[0]?.send(new Uint8Array([1, 2, 3]));
    expect(adopted.sentBytes).toHaveLength(1);
    expect(losingChannel.sentBytes).toHaveLength(0);

    // Releasing the still-parked local createOffer must NOT push the stale
    // offer — the superseded attempt bails on its superseded checks.
    pc.releaseOffer();
    await flush();
    expect(countKind(socket, "offer")).toBe(0);
    expect(countKind(socket, "answer")).toBe(1);

    bridge.close();
  });
});

describe("R7F8: negotiation-generation guard vs reconnect()/close()", () => {
  it("a parked initiateOffer continuation bails after reconnect() — nothing lands on the fresh adapter/socket", async () => {
    const pool = new SocketPool();
    const pcs = testPeerConnectionFactory();
    const roomId = deterministicConversationId(42);
    const bridge = new WebRtcBridge({
      brokerUrl: "wss://broker.example",
      roomId,
      role: Role.Initiator,
      socketFactory: pool.factory,
      iceServers: [],
      peerConnectionFactory: pcs.factory,
      transportReady: () => {
        // not exercised
      },
    });
    bridge.start();
    const first = pool.sockets[0];
    expect(first).toBeDefined();
    first.serverOpen();
    const pc1 = pcs.instances[0];
    expect(pc1).toBeDefined();
    pc1.parkOffers = true;

    first.deliver(JSON.stringify({ t: "join", roomId: roomHex(roomId) }));
    await flush();
    expect(pc1.createdChannels).toHaveLength(1);

    // Reconnect while the offer coroutine is parked: fresh socket + fresh
    // peer connection; the parked continuation must not act on either.
    bridge.reconnect();
    expect(pcs.instances).toHaveLength(2);
    const second = pool.sockets[1];
    expect(second).toBeDefined();
    second.serverOpen();

    pc1.releaseOffer();
    await flush();

    const pc2 = pcs.instances[1];
    expect(pc2).toBeDefined();
    // Without the generation guard the stale continuation would have pushed
    // setLocalDescription(offer) onto the NEW adapter and sent a second
    // offer over the NEW socket.
    expect(pc2.localDescTypes).toHaveLength(0);
    expect(countKind(second, "offer")).toBe(0);
    expect(countKind(first, "offer")).toBe(0);

    bridge.close();
  });

  it("a parked handleRemoteOffer continuation bails after reconnect() — no stale answer on the fresh socket", async () => {
    const pool = new SocketPool();
    const pcs = testPeerConnectionFactory();
    const roomId = deterministicConversationId(43);
    const bridge = new WebRtcBridge({
      brokerUrl: "wss://broker.example",
      roomId,
      role: Role.Responder,
      socketFactory: pool.factory,
      iceServers: [],
      peerConnectionFactory: pcs.factory,
      transportReady: () => {
        // not exercised
      },
    });
    bridge.start();
    const first = pool.sockets[0];
    expect(first).toBeDefined();
    first.serverOpen();
    const pc1 = pcs.instances[0];
    expect(pc1).toBeDefined();
    pc1.parkRemoteDescriptions = true;

    // The inbound offer auto-promotes the peer to present (no join event —
    // the joiner never counter-offers) and parks handleRemoteOffer inside
    // setRemoteDescription.
    first.deliver(JSON.stringify({ t: "offer", sdp: { type: "offer", sdp: "remote-offer" } }));
    await flush();

    bridge.reconnect();
    const second = pool.sockets[1];
    expect(second).toBeDefined();
    second.serverOpen();
    const pc2 = pcs.instances[1];
    expect(pc2).toBeDefined();

    // The stale continuation wakes — it must not create/set/send an answer
    // through the fresh adapter and socket.
    pc1.releaseRemote();
    await flush();
    expect(pc2.localDescTypes).toHaveLength(0);
    expect(countKind(second, "answer")).toBe(0);
    expect(countKind(first, "answer")).toBe(0);

    bridge.close();
  });

  it("a parked initiateOffer continuation bails after close()", async () => {
    const pool = new SocketPool();
    const pcs = testPeerConnectionFactory();
    const roomId = deterministicConversationId(44);
    const bridge = new WebRtcBridge({
      brokerUrl: "wss://broker.example",
      roomId,
      role: Role.Initiator,
      socketFactory: pool.factory,
      iceServers: [],
      peerConnectionFactory: pcs.factory,
      transportReady: () => {
        // not exercised
      },
    });
    bridge.start();
    const socket = pool.sockets[0];
    expect(socket).toBeDefined();
    socket.serverOpen();
    const pc = pcs.instances[0];
    expect(pc).toBeDefined();
    pc.parkOffers = true;

    socket.deliver(JSON.stringify({ t: "join", roomId: roomHex(roomId) }));
    await flush();

    bridge.close();
    pc.releaseOffer();
    await flush();
    expect(pc.localDescTypes).toHaveLength(0);
    expect(countKind(socket, "offer")).toBe(0);
  });
});

describe("R7F9: stale nego.channel cleared on peer leave / turnover", () => {
  it("peer leave closes the recorded channel so a rejoin gets a fresh offer", async () => {
    const pool = new SocketPool();
    const pcs = testPeerConnectionFactory();
    const roomId = deterministicConversationId(45);
    const bridge = new WebRtcBridge({
      brokerUrl: "wss://broker.example",
      roomId,
      role: Role.Initiator,
      socketFactory: pool.factory,
      iceServers: [],
      peerConnectionFactory: pcs.factory,
      transportReady: () => {
        // not exercised
      },
    });
    bridge.start();
    const socket = pool.sockets[0];
    expect(socket).toBeDefined();
    socket.serverOpen();
    const pc = pcs.instances[0];
    expect(pc).toBeDefined();

    socket.deliver(JSON.stringify({ t: "join", roomId: roomHex(roomId) }));
    await flush();
    expect(countKind(socket, "offer")).toBe(1);
    expect(pc.createdChannels).toHaveLength(1);
    const firstChannel = pc.createdChannels[0];
    expect(firstChannel).toBeDefined();

    // Complete the exchange, then the peer leaves.
    socket.deliver(JSON.stringify({ t: "answer", sdp: { type: "answer", sdp: "peer-answer" } }));
    await flush();
    socket.deliver(JSON.stringify({ t: "leave", roomId: roomHex(roomId) }));
    await flush();
    // R7F9: the dead channel is closed and cleared — pre-fix it stayed
    // recorded and the rejoin below hit the `nego.channel !== null` guard,
    // silently dropping the re-offer.
    expect(firstChannel.closed).toBe(true);

    socket.deliver(JSON.stringify({ t: "join", roomId: roomHex(roomId) }));
    await flush();
    expect(countKind(socket, "offer")).toBe(2);
    expect(pc.createdChannels).toHaveLength(2);

    bridge.close();
  });

  it("a join while seated (silent-leave turnover) releases the stale channel and re-offers", async () => {
    const pool = new SocketPool();
    const pcs = testPeerConnectionFactory();
    const roomId = deterministicConversationId(46);
    const bridge = new WebRtcBridge({
      brokerUrl: "wss://broker.example",
      roomId,
      role: Role.Initiator,
      socketFactory: pool.factory,
      iceServers: [],
      peerConnectionFactory: pcs.factory,
      transportReady: () => {
        // not exercised
      },
    });
    bridge.start();
    const socket = pool.sockets[0];
    expect(socket).toBeDefined();
    socket.serverOpen();
    const pc = pcs.instances[0];
    expect(pc).toBeDefined();

    socket.deliver(JSON.stringify({ t: "join", roomId: roomHex(roomId) }));
    await flush();
    expect(countKind(socket, "offer")).toBe(1);
    const staleChannel = pc.createdChannels[0];
    expect(staleChannel).toBeDefined();

    // Seat turnover: the old peer's silent leave is never relayed; the new
    // peer's join is the only signal. R5F1 fires onPeerJoin again; the
    // bridge releases the departed peer's channel and re-offers to the new
    // seat occupant.
    socket.deliver(JSON.stringify({ t: "join", roomId: roomHex(roomId) }));
    await flush();
    expect(staleChannel.closed).toBe(true);
    expect(countKind(socket, "offer")).toBe(2);
    expect(pc.createdChannels).toHaveLength(2);

    bridge.close();
  });
});

describe("R7F7: transportReady latch only on confirmed attach", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("a throwing attach callback leaves the latches unarmed — a later channel event retries", async () => {
    const pool = new SocketPool();
    const pcs = testPeerConnectionFactory();
    const roomId = deterministicConversationId(47);
    let transportReadyCalls = 0;
    let failNextAttach = true;
    const bridge = new WebRtcBridge({
      brokerUrl: "wss://broker.example",
      roomId,
      role: Role.Responder,
      socketFactory: pool.factory,
      iceServers: [],
      peerConnectionFactory: pcs.factory,
      transportReady: () => {
        transportReadyCalls++;
        if (failNextAttach) {
          failNextAttach = false;
          throw new Error("attachTransport rejected the state");
        }
      },
    });
    bridge.start();
    const socket = pool.sockets[0];
    expect(socket).toBeDefined();
    socket.serverOpen();
    const pc = pcs.instances[0];
    expect(pc).toBeDefined();

    // Drive a channel in via the responder path, then open it. The first
    // readiness check runs the attach callback, which throws — pre-fix the
    // latches (transportReadyFired, suppressSignalingClose, teardown timer)
    // were set BEFORE the callback, so the throw was permanent and the
    // broker socket could never be released.
    const channel = new TestDataChannel();
    pc.fireDataChannel(channel);
    expect(() => channel.fireOpen()).toThrow("attachTransport rejected the state");
    expect(transportReadyCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(socket.closed).toBe(false);

    // A later connection-state event retries: the attach succeeds, the
    // latch is set, and the broker teardown arms on success only.
    pc.fireConnectionState("connected");
    expect(transportReadyCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(socket.closed).toBe(true);
    expect(countKind(socket, "leave")).toBe(1);

    bridge.close();
  });
});
