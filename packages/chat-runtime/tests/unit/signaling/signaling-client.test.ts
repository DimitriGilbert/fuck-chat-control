import { describe, expect, it } from "vitest";

import { Role } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import { SignalingClient } from "@fuck-eu-chat-control/chat-runtime/signaling/signaling-client";
import type {
  SignalingHandlers,
  SignalingSocketFactory,
} from "@fuck-eu-chat-control/chat-runtime/signaling/signaling-client";
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

  it("fires onPeerJoin on the first handshake initiation (offer/answer)", () => {
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

    // A pure-ICE frame on a side that has not yet seen offer/answer must NOT
    // auto-promote peerPresent (R6/F7). Previously any peer-originated message
    // flipped presence, which let a third party spoof presence with bare ICE.
    a.deliver(JSON.stringify({ t: "ice", candidate: { candidate: "x" } }));
    expect(ha.events).not.toContain("join");
    expect(clientA.isPeerPresent()).toBe(false);

    // The legitimate path — an answer from the peer — still promotes.
    a.deliver(JSON.stringify({ t: "answer", sdp: { type: "answer", sdp: "y" } }));
    expect(ha.events).toContain("join");
    expect(clientA.isPeerPresent()).toBe(true);
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

  it("does NOT emit onClose for the P2P-driven teardown (R3F6)", () => {
    const a = new MockSignalingSocket();
    const ha = recordingHandlers();
    const client = createClient(Role.Initiator, ha, a);

    client.signalP2pOpen();

    // The teardown DELIBERATELY closed the socket (leave + close pinned
    // above), so its close event must not surface as onClose. Surfacing it
    // forced every consumer to distinguish "we closed it" from "the broker
    // dropped us" — the bridge's suppressSignalingClose flag was exactly
    // that workaround — and with a real (async) WebSocket the late close
    // event of a deliberately replaced socket would tear down the retried
    // session racing the fresh dial. The client's socket-identity guard now
    // makes the distinction structural.
    expect(ha.events).not.toContain("close");
  });

  it("emits onClose when the LIVE socket is closed externally (broker drop)", () => {
    const a = new MockSignalingSocket();
    const ha = recordingHandlers();
    createClient(Role.Initiator, ha, a);

    // The socket is still the current one when the network drops it: the
    // close surfaces, which is what routes the orchestrator to Disconnected.
    a.serverOpen();
    a.serverClose();
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

describe("SignalingClient — join as a fresh presence edge (R5F1)", () => {
  it("fires onPeerJoin again when a second join arrives while a peer is already present", () => {
    // Seat turnover: the departing peer's silent leave is never relayed
    // (BrokerConnection.handleLeave does not notify), so a `join` arriving
    // while `peerPresent` is the first and only signal that the seated peer
    // changed. The bridge's renegotiation handling makes firing again safe.
    const a = new MockSignalingSocket();
    const ha = recordingHandlers();
    const client = createClient(Role.Initiator, ha, a);

    a.deliver(JSON.stringify({ t: "join", roomId: ROOM_ID }));
    expect(ha.events).toEqual(["join"]);
    expect(client.isPeerPresent()).toBe(true);

    // Second join on the same socket with no intervening leave — this must
    // fire onPeerJoin again (pre-fix it was swallowed by the !peerPresent
    // gate, leaving the new peer waiting for an offer that never came).
    a.deliver(JSON.stringify({ t: "join", roomId: ROOM_ID }));
    expect(ha.events).toEqual(["join", "join"]);
    expect(client.isPeerPresent()).toBe(true);
    client.close();
  });
});

describe("SignalingClient — glare flag lifecycle (R5F2)", () => {
  function poolClient(role: Role, sockets: MockSignalingSocket[]): SignalingClient {
    let idx = 0;
    return new SignalingClient({
      brokerUrl: "ws://broker.example/ws",
      roomId: ROOM_ID,
      role,
      handlers: recordingHandlers(),
      socketFactory: () => {
        const socket = sockets[idx];
        if (socket === undefined) throw new Error("socket pool exhausted");
        idx++;
        return socket;
      },
    });
  }

  it("resets offerInFlight when the socket closes — a same-client re-dial answers a remote offer", () => {
    const sockets = [new MockSignalingSocket(), new MockSignalingSocket()];
    const client = poolClient(Role.Initiator, sockets);
    client.connect();
    sockets[0].serverOpen();

    // Impolite side with an offer on the wire ignores a colliding offer.
    client.sendOffer({ type: "offer", sdp: "o" });
    expect(client.resolveRemoteOffer()).toBe("ignore");

    // The socket dies and the SAME client re-dials (leaveAndClose + connect
    // is exactly what the bridge's reconnect does). The dead socket's offer
    // must not latch offerInFlight on the fresh connection.
    sockets[0].serverClose();
    client.connect();
    sockets[1].serverOpen();
    expect(client.resolveRemoteOffer()).toBe("answer");
    client.close();
  });

  it("resets offerInFlight on teardown() — close() then re-dial answers a remote offer", () => {
    const sockets = [new MockSignalingSocket(), new MockSignalingSocket()];
    const client = poolClient(Role.Initiator, sockets);
    client.connect();
    sockets[0].serverOpen();
    client.sendOffer({ type: "offer", sdp: "o" });
    expect(client.resolveRemoteOffer()).toBe("ignore");

    client.close();
    client.connect();
    sockets[1].serverOpen();
    expect(client.resolveRemoteOffer()).toBe("answer");
    client.close();
  });

  it("does not arm offerInFlight when the offer never reaches the wire (dead socket)", () => {
    const socket = new MockSignalingSocket();
    const ha = recordingHandlers();
    const client = createClient(Role.Initiator, ha, socket);
    // Drive the socket back to a non-open state without a close event: a
    // sendOffer now fails the relay, and must not latch the glare flag.
    socket.readyState = 0;
    client.sendOffer({ type: "offer", sdp: "o" });
    expect(ha.events).toContain("error");
    expect(client.resolveRemoteOffer()).toBe("answer");
    client.close();
  });
});
