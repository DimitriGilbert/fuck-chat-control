import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  generateAtRestKey,
  generateIdentityKeyPair,
} from "@fuck-eu-chat-control/chat-runtime/crypto";
import { ConversationOrchestrator } from "@fuck-eu-chat-control/chat-runtime/orchestrator/orchestrator";
import { encodeConversationId } from "@fuck-eu-chat-control/chat-runtime/protocol/codec";
import { CONVERSATION_ID_BYTES } from "@fuck-eu-chat-control/chat-runtime/protocol/limits";
import { Role } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import type { ConversationId } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import {
  wireBridge,
  type SessionHolder,
} from "@fuck-eu-chat-control/chat-runtime/runtime/chat-session";
import { InMemoryConversationRepository } from "@fuck-eu-chat-control/chat-runtime/store";
import type {
  DataChannelTransport,
  IceCandidate,
  PeerConnection,
  PeerConnectionFactory,
  PeerConnectionFactoryOptions,
  PeerConnectionState,
  SessionDescription,
} from "@fuck-eu-chat-control/chat-runtime/transport/types";

import { parse } from "../signaling/_helpers";
import { SocketPool } from "./_helpers";

/**
 * Phase 4 fix (R7F7): wireBridge's transportReady callback must let an
 * attachTransport throw PROPAGATE into the bridge's maybeFireTransportReady
 * so the latch-on-success ordering works — the previous best-effort catch
 * armed transportReadyFired + the broker-teardown timer for a channel that
 * could never reach the orchestrator (e.g. a turnover re-offer while the
 * orchestrator is still Connected; attachTransport accepts only
 * Waiting/Signaling).
 *
 * The test wires a REAL orchestrator (Idle — not yet attachable) through
 * wireBridge and a controllable PeerConnection fake, drives the responder
 * channel path to open, and asserts: the throw escapes the channel event,
 * the teardown timer is NOT armed, and a later connection-state event
 * retries the attach once the orchestrator is start()ed.
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
  private readonly handlers: PeerConnectionFactoryOptions;

  public constructor(options: PeerConnectionFactoryOptions) {
    this.handlers = options;
  }

  public createOffer(): Promise<SessionDescription> {
    return Promise.resolve({ type: "offer", sdp: "test-offer-sdp" });
  }

  public createAnswer(): Promise<SessionDescription> {
    return Promise.resolve({ type: "answer", sdp: "test-answer-sdp" });
  }

  public setLocalDescription(_description: SessionDescription): Promise<void> {
    return Promise.resolve();
  }

  public setRemoteDescription(_description: SessionDescription): Promise<void> {
    return Promise.resolve();
  }

  public addIceCandidate(_candidate: IceCandidate): Promise<void> {
    return Promise.resolve();
  }

  public createDataChannel(): DataChannelTransport {
    return new TestDataChannel();
  }

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

function deterministicConversationId(seed: number): ConversationId {
  const bytes = new Uint8Array(CONVERSATION_ID_BYTES);
  for (let i = 0; i < CONVERSATION_ID_BYTES; i++) bytes[i] = (seed * 31 + i) & 0xff;
  return encodeConversationId(bytes);
}

function countKind(socket: { readonly sent: string[] }, kind: string): number {
  return socket.sent.filter((raw) => parse(raw).t === kind).length;
}

describe("wireBridge transportReady propagates attachTransport failure (R7F7)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("a rejected attach does not latch transportReadyFired nor arm broker teardown; a later event retries", async () => {
    const pool = new SocketPool();
    let pc: TestPeerConnection | null = null;
    const factory: PeerConnectionFactory = (options) => {
      pc = new TestPeerConnection(options);
      return pc;
    };
    const repository = new InMemoryConversationRepository(generateAtRestKey());
    const identity = await generateIdentityKeyPair();
    // Bridge-mode orchestrator (no internal signaling socket) left in Idle —
    // start() is deliberately deferred so attachTransport rejects the first
    // channel exactly like a turnover re-offer hitting a Connected session.
    const orchestrator = new ConversationOrchestrator({
      brokerUrl: "wss://broker.example",
      baseUrl: "https://app.example",
      repository,
      socketFactory: pool.factory,
      identity,
      useInternalSignaling: false,
    });
    const holder: SessionHolder = { session: null };
    const session = wireBridge({
      orchestrator,
      holder,
      conversationId: deterministicConversationId(90),
      role: Role.Responder,
      brokerUrl: "wss://broker.example",
      socketFactory: pool.factory,
      peerConnectionFactory: factory,
      onPeerJoin: () => {
        orchestrator.notifyPeerJoined();
      },
      onPeerLeave: () => {
        orchestrator.notifyPeerLeft();
      },
      onSignalingClosed: () => {
        orchestrator.notifySignalingClosed();
      },
    });
    session.bridge.start();
    const socket = pool.sockets[0];
    expect(socket).toBeDefined();
    socket!.serverOpen();
    expect(pc).not.toBeNull();

    // Drive a responder-path channel in and open it. attachTransport throws
    // (orchestrator is Idle) — pre-fix the wireBridge catch swallowed it and
    // maybeFireTransportReady latched success + armed the broker teardown
    // anyway.
    const channel = new TestDataChannel();
    pc!.fireDataChannel(channel);
    expect(() => channel.fireOpen()).toThrow(/attachTransport/);

    // Latch not armed: no teardown timer was set, so the broker socket
    // survives the whole grace window and beyond.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(socket!.closed).toBe(false);
    expect(countKind(socket!, "leave")).toBe(0);

    // Make the orchestrator attachable, then fire a later connection-state
    // event: maybeFireTransportReady retries the attach (only possible
    // because the latch was never set) and arms teardown on success.
    await orchestrator.start();
    pc!.fireConnectionState("connected");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(countKind(socket!, "leave")).toBe(1);
    expect(socket!.closed).toBe(true);

    session.bridge.close();
  });
});
