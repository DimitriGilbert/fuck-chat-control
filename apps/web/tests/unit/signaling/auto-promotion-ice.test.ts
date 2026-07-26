import { describe, expect, it } from "vitest";

import { Role } from "@/features/chat/protocol/types";
import { SignalingClient } from "@/features/chat/signaling/signaling-client";
import type {
  SignalingHandlers,
  SignalingSocketFactory,
} from "@/features/chat/signaling/signaling-client";
import { MockSignalingSocket } from "./_helpers";

const ROOM_ID = "00112233445566778899aabbccddeeff";

interface RecordingHandlers extends SignalingHandlers {
  readonly events: string[];
  readonly offers: unknown[];
  readonly answers: unknown[];
  readonly ices: unknown[];
}

function recordingHandlers(): RecordingHandlers {
  const events: string[] = [];
  const offers: unknown[] = [];
  const answers: unknown[] = [];
  const ices: unknown[] = [];
  return {
    events,
    offers,
    answers,
    ices,
    onPeerJoin: () => events.push("join"),
    onPeerLeave: () => events.push("leave"),
    onClose: () => events.push("close"),
    onError: () => events.push("error"),
    onOffer: (sdp) => offers.push(sdp),
    onAnswer: (sdp) => answers.push(sdp),
    onIce: (c) => ices.push(c),
  };
}

function createClient(
  role: Role,
  handlers: SignalingHandlers,
  socket: MockSignalingSocket,
): SignalingClient {
  const factory: SignalingSocketFactory = () => socket;
  const client = new SignalingClient({
    brokerUrl: "ws://broker.example/ws",
    roomId: ROOM_ID,
    role,
    handlers,
    socketFactory: factory,
  });
  client.connect();
  socket.serverOpen();
  return client;
}

describe("SignalingClient — auto-promotion gating (R6/F7)", () => {
  it("a pure-ICE frame from an unknown peer does NOT flip peerPresent", () => {
    const socket = new MockSignalingSocket();
    const handlers = recordingHandlers();
    const client = createClient(Role.Initiator, handlers, socket);

    socket.deliver(JSON.stringify({ t: "ice", candidate: { candidate: "x" } }));
    expect(client.isPeerPresent()).toBe(false);
    expect(handlers.events).not.toContain("join");
    // The ICE candidate is still forwarded to the application layer so a real
    // peer's trickle ICE (arriving milliseconds before the answer due to
    // scheduling) is not silently dropped. Promotion is gated; delivery is not.
    expect(handlers.ices).toEqual([{ candidate: "x" }]);
    client.close();
  });

  it("an offer from an unknown peer DOES flip peerPresent", () => {
    const socket = new MockSignalingSocket();
    const handlers = recordingHandlers();
    const client = createClient(Role.Responder, handlers, socket);

    socket.deliver(JSON.stringify({ t: "offer", sdp: { type: "offer", sdp: "o" } }));
    expect(client.isPeerPresent()).toBe(true);
    expect(handlers.events).toContain("join");
    expect(handlers.offers).toEqual([{ type: "offer", sdp: "o" }]);
    client.close();
  });

  it("an answer from an unknown peer DOES flip peerPresent", () => {
    const socket = new MockSignalingSocket();
    const handlers = recordingHandlers();
    const client = createClient(Role.Initiator, handlers, socket);

    socket.deliver(JSON.stringify({ t: "answer", sdp: { type: "answer", sdp: "y" } }));
    expect(client.isPeerPresent()).toBe(true);
    expect(handlers.events).toContain("join");
    client.close();
  });

  it("does not double-promote on a subsequent ICE after an offer promoted", () => {
    const socket = new MockSignalingSocket();
    const handlers = recordingHandlers();
    const client = createClient(Role.Responder, handlers, socket);

    socket.deliver(JSON.stringify({ t: "offer", sdp: { type: "offer", sdp: "o" } }));
    expect(handlers.events.filter((e) => e === "join")).toHaveLength(1);

    socket.deliver(JSON.stringify({ t: "ice", candidate: { candidate: "z" } }));
    // peerPresent already true — no second join event.
    expect(handlers.events.filter((e) => e === "join")).toHaveLength(1);
    expect(handlers.ices).toEqual([{ candidate: "z" }]);
    client.close();
  });
});
