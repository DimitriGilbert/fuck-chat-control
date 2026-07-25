import { describe, expect, it } from "vitest";

import { Role } from "@/features/chat/protocol/types";
import { SignalingClient } from "@/features/chat/signaling/signaling-client";
import type {
  SignalingHandlers,
  SignalingSocketFactory,
} from "@/features/chat/signaling/signaling-client";
import { MockSignalingSocket, parse } from "./_helpers";

const ROOM_ID = "00112233445566778899aabbccddeeff";

function roomId(seed: number): string {
  let hex = "";
  for (let i = 0; i < 32; i++) {
    hex += ((seed * 31 + i * 7) & 0xff).toString(16).padStart(2, "0");
  }
  return hex.slice(0, 32);
}

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

describe("SignalingClient — join", () => {
  it("sends a join message with the room id when the socket opens", () => {
    const socket = new MockSignalingSocket();
    const client = createClient(Role.Initiator, recordingHandlers(), socket);
    expect(socket.sent).toHaveLength(1);
    expect(parse(socket.sent[0])).toEqual({ t: "join", roomId: ROOM_ID });
    client.close();
  });

  it("rejects a malformed room id at construction", () => {
    const socket = new MockSignalingSocket();
    expect(
      () =>
        new SignalingClient({
          brokerUrl: "ws://broker.example/ws",
          roomId: "not-hex",
          role: Role.Initiator,
          handlers: recordingHandlers(),
          socketFactory: () => socket,
        }),
    ).toThrow();
  });
});

describe("SignalingClient — relay both ways", () => {
  it("forwards an outbound offer to the wire and an inbound offer to the handler", () => {
    const a = new MockSignalingSocket();
    const b = new MockSignalingSocket();
    const ha = recordingHandlers();
    const hb = recordingHandlers();
    const clientA = createClient(Role.Initiator, ha, a);
    const clientB = createClient(Role.Responder, hb, b);

    const offer = { type: "offer", sdp: "o" };
    clientA.sendOffer(offer);
    expect(a.sent[a.sent.length - 1]).toContain('"offer"');
    b.deliver(a.sent[a.sent.length - 1]);
    expect(hb.offers).toEqual([offer]);

    const answer = { type: "answer", sdp: "ans" };
    clientB.sendAnswer(answer);
    a.deliver(b.sent[b.sent.length - 1]);
    expect(ha.answers).toEqual([answer]);

    clientA.close();
    clientB.close();
  });

  it("fires onPeerJoin on the first peer-originated message", () => {
    const a = new MockSignalingSocket();
    const b = new MockSignalingSocket();
    const ha = recordingHandlers();
    const hb = recordingHandlers();
    const clientA = createClient(Role.Initiator, ha, a);
    createClient(Role.Responder, hb, b);

    clientA.sendOffer({ type: "offer", sdp: "o" });
    b.deliver(a.sent[a.sent.length - 1]);
    expect(hb.events).toContain("join");
    expect(clientA.isPeerPresent()).toBe(false);

    a.deliver(JSON.stringify({ t: "ice", candidate: { candidate: "x" } }));
    expect(ha.events).toContain("join");
    clientA.close();
  });
});

describe("SignalingClient — bidirectional ICE (trickle)", () => {
  it("sends and receives ICE candidates in both directions", () => {
    const a = new MockSignalingSocket();
    const b = new MockSignalingSocket();
    const ha = recordingHandlers();
    const hb = recordingHandlers();
    const clientA = createClient(Role.Initiator, ha, a);
    const clientB = createClient(Role.Responder, hb, b);

    const cA = { candidate: "a->b", sdpMid: "0" };
    clientA.sendIce(cA);
    b.deliver(a.sent[a.sent.length - 1]);
    expect(hb.ices).toEqual([cA]);

    const cB = { candidate: "b->a", sdpMid: "0" };
    clientB.sendIce(cB);
    a.deliver(b.sent[b.sent.length - 1]);
    expect(ha.ices).toEqual([cB]);

    clientA.close();
    clientB.close();
  });
});

describe("SignalingClient — close after P2P open", () => {
  it("sends leave and closes the socket when the P2P channel opens", () => {
    const a = new MockSignalingSocket();
    const ha = recordingHandlers();
    const client = createClient(Role.Initiator, ha, a);

    client.signalP2pOpen();

    expect(a.sent[a.sent.length - 1]).toContain('"leave"');
    expect(parse(a.sent[a.sent.length - 1]).roomId).toBe(ROOM_ID);
    expect(a.closed).toBe(true);
    expect(a.readyState).toBe(3);
  });

  it("emits onClose after P2P-driven teardown", () => {
    const a = new MockSignalingSocket();
    const ha = recordingHandlers();
    const client = createClient(Role.Initiator, ha, a);

    client.signalP2pOpen();

    expect(ha.events).toContain("close");
  });
});

describe("SignalingClient — resumption", () => {
  it("re-joining an existing room works identically to first contact", () => {
    const first = new MockSignalingSocket();
    const client = createClient(Role.Initiator, recordingHandlers(), first);
    client.signalP2pOpen();

    const second = new MockSignalingSocket();
    const resumed = createClient(Role.Initiator, recordingHandlers(), second);

    expect(second.sent[0]).toEqual(first.sent[0]);
    expect(parse(second.sent[0])).toEqual({ t: "join", roomId: ROOM_ID });
    resumed.close();
  });

  it("a fresh room id joins cleanly after a prior id was abandoned", () => {
    const socket = new MockSignalingSocket();
    const client = new SignalingClient({
      brokerUrl: "ws://broker.example/ws",
      roomId: roomId(5),
      role: Role.Responder,
      handlers: recordingHandlers(),
      socketFactory: () => socket,
    });
    client.connect();
    socket.serverOpen();
    expect(parse(socket.sent[0]).roomId).toBe(roomId(5));
    client.close();
  });
});

describe("SignalingClient — glare resolution", () => {
  it("assigns the initiator as impolite and the responder as polite", () => {
    const a = new MockSignalingSocket();
    const b = new MockSignalingSocket();
    const initiator = createClient(Role.Initiator, recordingHandlers(), a);
    const responder = createClient(Role.Responder, recordingHandlers(), b);

    expect(initiator.isPolite()).toBe(false);
    expect(responder.isPolite()).toBe(true);
    initiator.close();
    responder.close();
  });

  it("keeps the initiator's in-flight offer and ignores a remote offer (glare)", () => {
    const a = new MockSignalingSocket();
    const initiator = createClient(Role.Initiator, recordingHandlers(), a);

    initiator.sendOffer({ type: "offer", sdp: "o" });
    expect(initiator.resolveRemoteOffer()).toBe("ignore");

    initiator.endOffer();
    expect(initiator.resolveRemoteOffer()).toBe("answer");
    initiator.close();
  });

  it("rolls back the responder's in-flight offer to answer a remote offer (glare)", () => {
    const b = new MockSignalingSocket();
    const responder = createClient(Role.Responder, recordingHandlers(), b);

    responder.sendOffer({ type: "offer", sdp: "o" });
    expect(responder.resolveRemoteOffer()).toBe("answer");
    responder.close();
  });
});

describe("SignalingClient — peer leave", () => {
  it("reports peer leave when the socket closes after a peer was present", () => {
    const a = new MockSignalingSocket();
    const ha = recordingHandlers();
    const client = createClient(Role.Initiator, ha, a);

    a.deliver(JSON.stringify({ t: "offer", sdp: { type: "offer", sdp: "x" } }));
    expect(ha.events).toContain("join");

    a.serverClose();
    expect(ha.events).toContain("leave");
    client.close();
  });
});
