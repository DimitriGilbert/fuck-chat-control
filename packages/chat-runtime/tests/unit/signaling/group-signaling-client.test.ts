import { describe, expect, it } from "vitest";

import { GroupSignalingClient } from "@fuck-eu-chat-control/chat-runtime/signaling/group-signaling-client";
import type { GroupSignalingHandlers } from "@fuck-eu-chat-control/chat-runtime/signaling/group-signaling-client";
import { MockSignalingSocket, parse } from "./_helpers";

const ROOM_ID = "00112233445566778899aabbccddeeff";
const OTHER_ROOM_ID = "ffeeddccbbaa99887766554433221100";
const OWN_PEER = "aaaaaaaaaaaaaaaa";
const PEER_B = "bbbbbbbbbbbbbbbb";
const PEER_C = "cccccccccccccccc";

interface RecordingHandlers extends GroupSignalingHandlers {
  readonly events: string[];
  readonly offers: Array<{ from: string; sdp: unknown }>;
  readonly answers: Array<{ from: string; sdp: unknown }>;
  readonly ices: Array<{ from: string; candidate: unknown }>;
}

function recordingHandlers(): RecordingHandlers {
  const events: string[] = [];
  const offers: Array<{ from: string; sdp: unknown }> = [];
  const answers: Array<{ from: string; sdp: unknown }> = [];
  const ices: Array<{ from: string; candidate: unknown }> = [];
  return {
    events,
    offers,
    answers,
    ices,
    onPeerJoin: (peerId) => events.push(`join:${peerId}`),
    onPeerLeave: (peerId) => events.push(`leave:${peerId}`),
    onClose: () => events.push("close"),
    onError: () => events.push("error"),
    onOffer: (from, sdp) => offers.push({ from, sdp }),
    onAnswer: (from, sdp) => answers.push({ from, sdp }),
    onIce: (from, candidate) => ices.push({ from, candidate }),
  };
}

function createClient(
  peerId: string,
  handlers: GroupSignalingHandlers,
  socket: MockSignalingSocket,
): GroupSignalingClient {
  const client = new GroupSignalingClient({
    brokerUrl: "ws://broker.example/ws",
    roomId: ROOM_ID,
    handlers,
    socketFactory: () => socket,
  });
  client.connect(peerId);
  socket.serverOpen();
  return client;
}

describe("GroupSignalingClient — join", () => {
  it("sends a group join with roomId, mode and peerId when the socket opens", () => {
    const socket = new MockSignalingSocket();
    const client = createClient(OWN_PEER, recordingHandlers(), socket);
    expect(socket.sent).toHaveLength(1);
    expect(parse(socket.sent[0])).toEqual({
      t: "join",
      roomId: ROOM_ID,
      mode: "group",
      peerId: OWN_PEER,
    });
    client.close();
  });

  it("rejects a malformed room id at construction", () => {
    const socket = new MockSignalingSocket();
    expect(
      () =>
        new GroupSignalingClient({
          brokerUrl: "ws://broker.example/ws",
          roomId: "not-hex",
          handlers: recordingHandlers(),
          socketFactory: () => socket,
        }),
    ).toThrow();
  });

  it("rejects a malformed peer id on connect", () => {
    const socket = new MockSignalingSocket();
    const client = new GroupSignalingClient({
      brokerUrl: "ws://broker.example/ws",
      roomId: ROOM_ID,
      handlers: recordingHandlers(),
      socketFactory: () => socket,
    });
    expect(() => client.connect("not-a-peer-id")).toThrow();
    // Uppercase hex is not a valid peerId either (16 lowercase hex chars).
    expect(() => client.connect("AAAAAAAAAAAAAAAA")).toThrow();
  });

  it("throws on a second connect while connected", () => {
    const socket = new MockSignalingSocket();
    const client = createClient(OWN_PEER, recordingHandlers(), socket);
    expect(() => client.connect(PEER_B)).toThrow();
    client.close();
  });
});

describe("GroupSignalingClient — addressed send", () => {
  it("emits to-addressed offer, answer and ice frames", () => {
    const socket = new MockSignalingSocket();
    const client = createClient(OWN_PEER, recordingHandlers(), socket);

    const offer = { type: "offer", sdp: "v=0" };
    client.sendOffer(PEER_B, offer);
    expect(parse(socket.sent[1])).toEqual({ t: "offer", to: PEER_B, sdp: offer });

    const answer = { type: "answer", sdp: "ans" };
    client.sendAnswer(PEER_B, answer);
    expect(parse(socket.sent[2])).toEqual({ t: "answer", to: PEER_B, sdp: answer });

    const candidate = { candidate: "c1", sdpMid: "0" };
    client.sendIce(PEER_C, candidate);
    expect(parse(socket.sent[3])).toEqual({ t: "ice", to: PEER_C, candidate });
    client.close();
  });

  it("rejects a malformed target peer id", () => {
    const socket = new MockSignalingSocket();
    const client = createClient(OWN_PEER, recordingHandlers(), socket);
    expect(() => client.sendOffer("nope", { type: "offer" })).toThrow();
    expect(() => client.sendAnswer("nope", { type: "answer" })).toThrow();
    expect(() => client.sendIce("nope", { candidate: "x" })).toThrow();
    client.close();
  });

  it("reports an error instead of throwing when the socket is not open", () => {
    const socket = new MockSignalingSocket();
    const handlers = recordingHandlers();
    const client = createClient(OWN_PEER, handlers, socket);
    // Drive the socket back to a non-open state without a close event.
    socket.readyState = 0;
    client.sendOffer(PEER_B, { type: "offer", sdp: "o" });
    client.sendAnswer(PEER_B, { type: "answer", sdp: "a" });
    client.sendIce(PEER_B, { candidate: "x" });
    expect(handlers.events).toEqual(["error", "error", "error"]);
    expect(socket.sent).toHaveLength(1); // only the join went out
    client.close();
  });
});

describe("GroupSignalingClient — peer presence", () => {
  it("dispatches onPeerJoin/onPeerLeave per peerId and tracks presence", () => {
    const socket = new MockSignalingSocket();
    const handlers = recordingHandlers();
    const client = createClient(OWN_PEER, handlers, socket);

    socket.deliver(JSON.stringify({ t: "join", roomId: ROOM_ID, peerId: PEER_B }));
    socket.deliver(JSON.stringify({ t: "join", roomId: ROOM_ID, peerId: PEER_C }));
    expect(handlers.events).toEqual([`join:${PEER_B}`, `join:${PEER_C}`]);
    expect(client.isPeerPresent(PEER_B)).toBe(true);
    expect(client.isPeerPresent(PEER_C)).toBe(true);
    expect(client.presentPeers()).toEqual([PEER_B, PEER_C]);

    socket.deliver(JSON.stringify({ t: "leave", roomId: ROOM_ID, peerId: PEER_B }));
    expect(handlers.events).toEqual([`join:${PEER_B}`, `join:${PEER_C}`, `leave:${PEER_B}`]);
    expect(client.isPeerPresent(PEER_B)).toBe(false);
    expect(client.presentPeers()).toEqual([PEER_C]);
    client.close();
  });

  it("ignores a join notification echoing our own peerId", () => {
    const socket = new MockSignalingSocket();
    const handlers = recordingHandlers();
    const client = createClient(OWN_PEER, handlers, socket);

    socket.deliver(JSON.stringify({ t: "join", roomId: ROOM_ID, peerId: OWN_PEER }));
    expect(handlers.events).toEqual([]);
    expect(client.presentPeers()).toEqual([]);
    client.close();
  });

  it("ignores a leave for a peer that is not present", () => {
    const socket = new MockSignalingSocket();
    const handlers = recordingHandlers();
    const client = createClient(OWN_PEER, handlers, socket);

    socket.deliver(JSON.stringify({ t: "leave", roomId: ROOM_ID, peerId: PEER_B }));
    expect(handlers.events).toEqual([]);
    client.close();
  });

  it("promotes an unknown peer to present on a first offer/answer, but not on pure ICE", () => {
    const socket = new MockSignalingSocket();
    const handlers = recordingHandlers();
    const client = createClient(OWN_PEER, handlers, socket);

    // The newcomer learns of seated members only via their addressed offers —
    // the broker never echoes the roster — so the first offer promotes.
    // Promotion is presence-only: onPeerJoin must NOT fire here, or the
    // consumer would originate a counter-offer the same instant the inbound
    // offer is dispatched — a crossing-offer glare (§2.1 seats offer; the
    // newcomer answers).
    const offer = { type: "offer", sdp: "v=0" };
    socket.deliver(JSON.stringify({ t: "offer", sdp: offer, from: PEER_B }));
    expect(handlers.events).toEqual([]);
    expect(client.isPeerPresent(PEER_B)).toBe(true);
    expect(handlers.offers).toEqual([{ from: PEER_B, sdp: offer }]);

    // Pure ICE from an unknown peer is dispatched but does NOT promote.
    const candidate = { candidate: "x" };
    socket.deliver(JSON.stringify({ t: "ice", candidate, from: PEER_C }));
    expect(handlers.ices).toEqual([{ from: PEER_C, candidate }]);
    expect(client.isPeerPresent(PEER_C)).toBe(false);
    client.close();
  });

  it("ignores join and leave notifications addressed to a different roomId", () => {
    const socket = new MockSignalingSocket();
    const handlers = recordingHandlers();
    const client = createClient(OWN_PEER, handlers, socket);

    // A join for another room neither promotes nor fires onPeerJoin.
    socket.deliver(JSON.stringify({ t: "join", roomId: OTHER_ROOM_ID, peerId: PEER_B }));
    expect(handlers.events).toEqual([]);
    expect(client.isPeerPresent(PEER_B)).toBe(false);

    // Seat PEER_B in OUR room, then a leave addressed to another room must
    // neither evict it nor fire onPeerLeave.
    socket.deliver(JSON.stringify({ t: "join", roomId: ROOM_ID, peerId: PEER_B }));
    handlers.events.length = 0;
    socket.deliver(JSON.stringify({ t: "leave", roomId: OTHER_ROOM_ID, peerId: PEER_B }));
    expect(handlers.events).toEqual([]);
    expect(client.isPeerPresent(PEER_B)).toBe(true);
    client.close();
  });

  it("promotes an unknown peer to present on a first answer, not just an offer", () => {
    const socket = new MockSignalingSocket();
    const handlers = recordingHandlers();
    const client = createClient(OWN_PEER, handlers, socket);

    // isHandshakeInitiation covers both offer and answer: an answer from an
    // unknown peerId is still proof of intent to establish a session. Same
    // presence-only promotion rule as the offer case — no onPeerJoin fire.
    const answer = { type: "answer", sdp: "ans" };
    socket.deliver(JSON.stringify({ t: "answer", sdp: answer, from: PEER_B }));
    expect(handlers.events).toEqual([]);
    expect(client.isPeerPresent(PEER_B)).toBe(true);
    expect(handlers.answers).toEqual([{ from: PEER_B, sdp: answer }]);
    client.close();
  });

  it("re-fires onPeerJoin when a join repeats for an already-present peerId (seat turnover)", () => {
    const socket = new MockSignalingSocket();
    const handlers = recordingHandlers();
    const client = createClient(OWN_PEER, handlers, socket);

    socket.deliver(JSON.stringify({ t: "join", roomId: ROOM_ID, peerId: PEER_B }));
    // A second join for the same label can only mean seat turnover — a
    // dropped socket re-seated under the same peerId — so the handler
    // re-fires while the presence set still holds a single entry.
    socket.deliver(JSON.stringify({ t: "join", roomId: ROOM_ID, peerId: PEER_B }));
    expect(handlers.events).toEqual([`join:${PEER_B}`, `join:${PEER_B}`]);
    expect(client.presentPeers()).toEqual([PEER_B]);
    client.close();
  });
});

describe("GroupSignalingClient — inbound dispatch", () => {
  it("routes addressed offer/answer/ice to the per-peer handlers", () => {
    const socket = new MockSignalingSocket();
    const handlers = recordingHandlers();
    const client = createClient(OWN_PEER, handlers, socket);

    const offer = { type: "offer", sdp: "o" };
    socket.deliver(JSON.stringify({ t: "offer", sdp: offer, from: PEER_B }));
    expect(handlers.offers).toEqual([{ from: PEER_B, sdp: offer }]);

    const answer = { type: "answer", sdp: "a" };
    socket.deliver(JSON.stringify({ t: "answer", sdp: answer, from: PEER_C }));
    expect(handlers.answers).toEqual([{ from: PEER_C, sdp: answer }]);

    const candidate = { candidate: "c" };
    socket.deliver(JSON.stringify({ t: "ice", candidate, from: PEER_B }));
    expect(handlers.ices).toEqual([{ from: PEER_B, candidate }]);
    client.close();
  });

  it("ignores messages with a missing, malformed or own-peerId from", () => {
    const socket = new MockSignalingSocket();
    const handlers = recordingHandlers();
    const client = createClient(OWN_PEER, handlers, socket);

    // Missing `from` — includes unaddressed legacy pair-mode frames.
    socket.deliver(JSON.stringify({ t: "offer", sdp: { type: "offer" } }));
    // Malformed `from` — fails parseMessage, so nothing is dispatched.
    socket.deliver(JSON.stringify({ t: "offer", sdp: { type: "offer" }, from: "not-hex" }));
    // Our own peerId as sender.
    socket.deliver(JSON.stringify({ t: "answer", sdp: { type: "answer" }, from: OWN_PEER }));
    socket.deliver(JSON.stringify({ t: "ice", candidate: { candidate: "x" }, from: OWN_PEER }));

    expect(handlers.events).toEqual([]);
    expect(handlers.offers).toEqual([]);
    expect(handlers.answers).toEqual([]);
    expect(handlers.ices).toEqual([]);
    expect(client.presentPeers()).toEqual([]);
    client.close();
  });
});

describe("GroupSignalingClient — leave and close", () => {
  it("close() relays a leave for the room, tears the socket down and fires onClose", () => {
    const socket = new MockSignalingSocket();
    const handlers = recordingHandlers();
    const client = createClient(OWN_PEER, handlers, socket);

    client.close();

    expect(parse(socket.sent[1])).toEqual({ t: "leave", roomId: ROOM_ID });
    expect(socket.closed).toBe(true);
    expect(socket.readyState).toBe(3);
    expect(handlers.events).toEqual(["close"]);
  });

  it("leaveAndClose() sends leave and surfaces a leave per present peer, then onClose", () => {
    const socket = new MockSignalingSocket();
    const handlers = recordingHandlers();
    const client = createClient(OWN_PEER, handlers, socket);

    socket.deliver(JSON.stringify({ t: "join", roomId: ROOM_ID, peerId: PEER_B }));
    handlers.events.length = 0;

    client.leaveAndClose();

    expect(parse(socket.sent[socket.sent.length - 1])).toEqual({ t: "leave", roomId: ROOM_ID });
    expect(socket.closed).toBe(true);
    expect(client.presentPeers()).toEqual([]);
    expect(handlers.events).toEqual([`leave:${PEER_B}`, "close"]);
  });

  it("does not send leave when the socket never opened", () => {
    const socket = new MockSignalingSocket();
    const client = new GroupSignalingClient({
      brokerUrl: "ws://broker.example/ws",
      roomId: ROOM_ID,
      handlers: recordingHandlers(),
      socketFactory: () => socket,
    });
    client.connect(OWN_PEER);
    client.leaveAndClose();
    expect(socket.sent).toEqual([]);
    expect(socket.closed).toBe(true);
  });

  it("emits per-peer leaves and onClose when the broker drops the socket", () => {
    const socket = new MockSignalingSocket();
    const handlers = recordingHandlers();
    const client = createClient(OWN_PEER, handlers, socket);

    socket.deliver(JSON.stringify({ t: "join", roomId: ROOM_ID, peerId: PEER_B }));
    socket.deliver(JSON.stringify({ t: "join", roomId: ROOM_ID, peerId: PEER_C }));
    handlers.events.length = 0;

    socket.serverClose();
    expect(handlers.events).toEqual([`leave:${PEER_B}`, `leave:${PEER_C}`, "close"]);
    expect(client.presentPeers()).toEqual([]);
  });
});

describe("GroupSignalingClient — socket staleness", () => {
  it("ignores events from a socket that was deliberately replaced", () => {
    const sockets = [new MockSignalingSocket(), new MockSignalingSocket()];
    let idx = 0;
    const handlers = recordingHandlers();
    const client = new GroupSignalingClient({
      brokerUrl: "ws://broker.example/ws",
      roomId: ROOM_ID,
      handlers,
      socketFactory: () => {
        const socket = sockets[idx];
        if (socket === undefined) throw new Error("socket pool exhausted");
        idx++;
        return socket;
      },
    });
    client.connect(OWN_PEER);
    sockets[0].serverOpen();

    // The bridge reconnects by tearing down and re-dialing on a fresh socket.
    client.leaveAndClose();
    handlers.events.length = 0;
    client.connect(OWN_PEER);
    sockets[1].serverOpen();
    expect(parse(sockets[1].sent[0])).toEqual({
      t: "join",
      roomId: ROOM_ID,
      mode: "group",
      peerId: OWN_PEER,
    });

    // Late events from the replaced socket must not touch the new session.
    sockets[0].deliver(JSON.stringify({ t: "join", roomId: ROOM_ID, peerId: PEER_B }));
    sockets[0].emitError();
    sockets[0].serverClose();
    expect(handlers.events).toEqual([]);
    client.close();
  });
});
