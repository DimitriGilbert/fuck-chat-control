import { afterEach, describe, expect, it } from "vitest";

import { encodeConversationId } from "@fuck-eu-chat-control/chat-runtime/protocol/codec";
import { CONVERSATION_ID_BYTES } from "@fuck-eu-chat-control/chat-runtime/protocol/limits";
import { Role } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import type { ConversationId } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import { WebRtcBridge } from "@fuck-eu-chat-control/chat-runtime/runtime/webrtc-bridge";
import { WebRtcAdapter } from "@/features/chat/signaling/webrtc-adapter";

import { MockSignalingSocket, parse } from "../signaling/_helpers";
import { mockSocketFactory } from "../orchestrator/_helpers";

/**
 * Minimal stub for the global `RTCPeerConnection`. We provide ONLY the surface
 * the WebRtcAdapter touches at construction + close time (addEventListener,
 * connectionState, close). The bridge's actual negotiation flow is validated
 * end-to-end via Playwright + the live two-browser run; here we install just
 * enough to let the adapter construct so the bridge's own construction-time
 * behavior (correct room id, idempotent close) can be asserted.
 */
interface StubEventTarget {
  addEventListener(_type: string, _fn: (event: unknown) => void): void;
}

class StubRtcPeerConnection implements StubEventTarget {
  public connectionState: RTCPeerConnectionState = "new";
  public readonly addEventListenerCalls: string[] = [];
  public closed = false;
  public addEventListener(_type: string, _fn: (event: unknown) => void): void {
    this.addEventListenerCalls.push(_type);
  }
  public close(): void {
    this.closed = true;
  }
}

const originalRtc = (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;

function installStubRtc(): StubRtcPeerConnection {
  const instance = new StubRtcPeerConnection();
  (globalThis as { RTCPeerConnection: unknown }).RTCPeerConnection = function () {
    return instance;
  };
  return instance;
}

function restoreRtc(): void {
  if (originalRtc === undefined) {
    delete (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
  } else {
    (globalThis as { RTCPeerConnection: unknown }).RTCPeerConnection = originalRtc;
  }
}

afterEach(() => {
  restoreRtc();
});

function deterministicConversationId(seed: number): ConversationId {
  const bytes = new Uint8Array(CONVERSATION_ID_BYTES);
  for (let i = 0; i < CONVERSATION_ID_BYTES; i++) bytes[i] = (seed * 31 + i) & 0xff;
  return encodeConversationId(bytes);
}

describe("WebRtcBridge", () => {
  it("constructs a SignalingClient for the conversation's room id", () => {
    const stubPc = installStubRtc();
    const socket = new MockSignalingSocket();
    const roomId = deterministicConversationId(7);
    const expectedHex = roomHex(roomId);
    const bridge = new WebRtcBridge({
      brokerUrl: "wss://broker.example",
      roomId,
      role: Role.Initiator,
      socketFactory: mockSocketFactory(socket),
      iceServers: [],
      peerConnectionFactory: (opts) => new WebRtcAdapter(opts),
      transportReady: () => {
        // Not expected to fire in this test.
      },
    });
    expect(bridge.roomHexId).toBe(expectedHex);
    // The adapter should have subscribed to the three events the bridge cares
    // about. (Construction-time behavior; we do not drive any events.)
    expect(stubPc.addEventListenerCalls).toContain("icecandidate");
    expect(stubPc.addEventListenerCalls).toContain("connectionstatechange");
    expect(stubPc.addEventListenerCalls).toContain("datachannel");
    bridge.close();
  });

  it("start() connects the signaling client and joins the broker room", () => {
    installStubRtc();
    const socket = new MockSignalingSocket();
    const roomId = deterministicConversationId(11);
    const bridge = new WebRtcBridge({
      brokerUrl: "wss://broker.example",
      roomId,
      role: Role.Initiator,
      socketFactory: mockSocketFactory(socket),
      iceServers: [],
      peerConnectionFactory: (opts) => new WebRtcAdapter(opts),
      transportReady: () => {
        // not expected
      },
    });
    bridge.start();
    // The socket was handed to the signaling client; simulate the server
    // accepting the connection so `handleOpen` fires the join.
    socket.serverOpen();
    expect(socket.sent.length).toBeGreaterThanOrEqual(1);
    const join = parse(socket.sent[0]);
    expect(join.t).toBe("join");
    expect(join.roomId).toBe(roomHex(roomId));
    bridge.close();
  });

  it("close() is idempotent", () => {
    installStubRtc();
    const socket = new MockSignalingSocket();
    const roomId = deterministicConversationId(13);
    const bridge = new WebRtcBridge({
      brokerUrl: "wss://broker.example",
      roomId,
      role: Role.Responder,
      socketFactory: mockSocketFactory(socket),
      iceServers: [],
      peerConnectionFactory: (opts) => new WebRtcAdapter(opts),
      transportReady: () => {
        // not expected
      },
    });
    bridge.start();
    socket.serverOpen();
    bridge.close();
    // Calling close again must be a safe no-op (no throw, no double-close of
    // resources).
    expect(() => bridge.close()).not.toThrow();
    expect(socket.closed).toBe(true);
  });

  it("does not fire transportReady when never connected", () => {
    installStubRtc();
    const socket = new MockSignalingSocket();
    const roomId = deterministicConversationId(17);
    let fired = 0;
    const bridge = new WebRtcBridge({
      brokerUrl: "wss://broker.example",
      roomId,
      role: Role.Initiator,
      socketFactory: mockSocketFactory(socket),
      iceServers: [],
      peerConnectionFactory: (opts) => new WebRtcAdapter(opts),
      transportReady: (): void => {
        fired++;
      },
    });
    bridge.start();
    socket.serverOpen();
    expect(fired).toBe(0);
    bridge.close();
  });
});

function roomHex(roomId: ConversationId): string {
  let hex = "";
  for (let i = 0; i < roomId.length; i++) {
    hex += roomId[i].toString(16).padStart(2, "0");
  }
  return hex;
}
