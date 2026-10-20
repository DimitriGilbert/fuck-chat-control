import { describe, expect, it } from "vitest";

import { BrokerConnection } from "@fuck-eu-chat-control/chat-runtime/broker/connection";
import {
  BROKER_CLOSE_CODES,
  BROKER_CLOSE_REASONS,
  BrokerErrorCode,
} from "@fuck-eu-chat-control/chat-runtime/broker/errors";
import { parseMessage } from "@fuck-eu-chat-control/chat-runtime/broker/protocol";
import { RoomRegistry } from "@fuck-eu-chat-control/chat-runtime/broker/room-registry";
import { DEFAULT_MAX_GROUP_MEMBERS } from "@fuck-eu-chat-control/chat-runtime/protocol/limits";

import { MockBrokerSocket } from "./_helpers";

function roomId(seed: number): string {
  let hex = "";
  for (let i = 0; i < 32; i++) {
    hex += ((seed * 31 + i * 7) & 0xff).toString(16).padStart(2, "0");
  }
  return hex.slice(0, 32);
}

/** 16 lowercase hex chars — the wire form of an 8-byte peerId. */
function peerId(n: number): string {
  return n.toString(16).padStart(16, "0");
}

function joinPair(registry: RoomRegistry, socket: MockBrokerSocket, id: string): BrokerConnection {
  const conn = new BrokerConnection(socket, registry);
  conn.onMessage(JSON.stringify({ t: "join", roomId: id }));
  return conn;
}

function joinGroup(
  registry: RoomRegistry,
  socket: MockBrokerSocket,
  id: string,
  peer: string,
): BrokerConnection {
  const conn = new BrokerConnection(socket, registry);
  conn.onMessage(JSON.stringify({ t: "join", roomId: id, mode: "group", peerId: peer }));
  return conn;
}

describe("group room — join and seat cap", () => {
  it("seats up to DEFAULT_MAX_GROUP_MEMBERS and rejects the next join as full", () => {
    const registry = new RoomRegistry();
    const id = roomId(30);
    for (let i = 1; i <= DEFAULT_MAX_GROUP_MEMBERS; i++) {
      const res = registry.join(id, new MockBrokerSocket(), {
        mode: "group",
        peerId: peerId(i),
      });
      expect(res.joined).toBe(true);
      expect(res.mode).toBe("group");
    }
    expect(registry.peerCount(id)).toBe(DEFAULT_MAX_GROUP_MEMBERS);

    const extra = new MockBrokerSocket();
    const res = registry.join(id, extra, { mode: "group", peerId: peerId(99) });
    expect(res.joined).toBe(false);
    expect(res.reason).toBe("full");
    expect(extra.closed).toBe(true);
    expect(extra.closeCode).toBe(1013);
    expect(registry.peerCount(id)).toBe(DEFAULT_MAX_GROUP_MEMBERS);
  });

  it("honours a configured maxGroupPeers cap", () => {
    const registry = new RoomRegistry({ maxGroupPeers: 3 });
    const id = roomId(31);
    for (let i = 1; i <= 3; i++) {
      expect(
        registry.join(id, new MockBrokerSocket(), { mode: "group", peerId: peerId(i) }).joined,
      ).toBe(true);
    }
    const extra = new MockBrokerSocket();
    const res = registry.join(id, extra, { mode: "group", peerId: peerId(4) });
    expect(res.joined).toBe(false);
    expect(res.reason).toBe("full");
  });

  it("notifies every already-seated member with the joiner's peerId, never the joiner", () => {
    const registry = new RoomRegistry();
    const a = new MockBrokerSocket();
    const b = new MockBrokerSocket();
    const c = new MockBrokerSocket();
    const id = roomId(32);
    joinGroup(registry, a, id, peerId(1));
    expect(a.sent).toHaveLength(0);

    joinGroup(registry, b, id, peerId(2));
    expect(a.sent).toHaveLength(1);
    expect(JSON.parse(a.sent[0])).toEqual({ t: "join", roomId: id, peerId: peerId(2) });
    expect(b.sent).toHaveLength(0);

    joinGroup(registry, c, id, peerId(3));
    expect(a.sent).toHaveLength(2);
    expect(b.sent).toHaveLength(1);
    expect(JSON.parse(a.sent[1])).toEqual({ t: "join", roomId: id, peerId: peerId(3) });
    expect(JSON.parse(b.sent[0])).toEqual({ t: "join", roomId: id, peerId: peerId(3) });
    // The joiner learns of existing members by offering, not from an echo.
    expect(c.sent).toHaveLength(0);
  });

  it("rejects a duplicate peerId with the DuplicatePeerId close code", () => {
    const registry = new RoomRegistry();
    const a = new MockBrokerSocket();
    const b = new MockBrokerSocket();
    const id = roomId(33);
    joinGroup(registry, a, id, peerId(1));

    joinGroup(registry, b, id, peerId(1));
    expect(b.closed).toBe(true);
    expect(b.closeCode).toBe(BROKER_CLOSE_CODES[BrokerErrorCode.DuplicatePeerId]);
    expect(b.closeReason).toBe(BROKER_CLOSE_REASONS[BrokerErrorCode.DuplicatePeerId]);
    expect(registry.peerCount(id)).toBe(1);
  });

  it("rejects a group join into a pair room and a pair join into a group room (mode mismatch)", () => {
    const registry = new RoomRegistry();
    const pairRoom = roomId(34);
    const groupRoom = roomId(35);

    const pairA = new MockBrokerSocket();
    joinPair(registry, pairA, pairRoom);
    const groupIntoPair = new MockBrokerSocket();
    joinGroup(registry, groupIntoPair, pairRoom, peerId(1));
    expect(groupIntoPair.closed).toBe(true);
    expect(groupIntoPair.closeCode).toBe(BROKER_CLOSE_CODES[BrokerErrorCode.RoomModeMismatch]);
    expect(groupIntoPair.closeReason).toBe(BROKER_CLOSE_REASONS[BrokerErrorCode.RoomModeMismatch]);
    expect(registry.peerCount(pairRoom)).toBe(1);

    const groupA = new MockBrokerSocket();
    joinGroup(registry, groupA, groupRoom, peerId(1));
    const pairIntoGroup = new MockBrokerSocket();
    joinPair(registry, pairIntoGroup, groupRoom);
    expect(pairIntoGroup.closed).toBe(true);
    expect(pairIntoGroup.closeCode).toBe(BROKER_CLOSE_CODES[BrokerErrorCode.RoomModeMismatch]);
    expect(registry.peerCount(groupRoom)).toBe(1);
  });

  it("rejects malformed or missing peerIds at parse time without seating a socket", () => {
    const id = roomId(36);
    // Malformed peerId shapes.
    expect(
      parseMessage(JSON.stringify({ t: "join", roomId: id, mode: "group", peerId: "xyz" })),
    ).toBeNull();
    expect(
      parseMessage(
        JSON.stringify({ t: "join", roomId: id, mode: "group", peerId: "0123456789ABCDEF" }),
      ),
    ).toBeNull();
    expect(
      parseMessage(
        JSON.stringify({ t: "join", roomId: id, mode: "group", peerId: "0123456789abcde" }),
      ),
    ).toBeNull();
    // peerId required iff mode is "group" — and must not appear otherwise.
    expect(parseMessage(JSON.stringify({ t: "join", roomId: id, mode: "group" }))).toBeNull();
    expect(parseMessage(JSON.stringify({ t: "join", roomId: id, peerId: peerId(1) }))).toBeNull();
    expect(
      parseMessage(JSON.stringify({ t: "join", roomId: id, mode: "pair", peerId: peerId(1) })),
    ).toBeNull();

    // A rejected parse never reaches the registry: no seat, no close.
    const registry = new RoomRegistry();
    const socket = new MockBrokerSocket();
    const conn = new BrokerConnection(socket, registry);
    conn.onMessage(JSON.stringify({ t: "join", roomId: id, mode: "group", peerId: "bad" }));
    expect(socket.closed).toBe(false);
    expect(registry.size()).toBe(0);
  });
});

describe("group room — addressed relay", () => {
  it("delivers an addressed offer to the `to` peer only, with `from` attached", () => {
    const registry = new RoomRegistry();
    const a = new MockBrokerSocket();
    const b = new MockBrokerSocket();
    const c = new MockBrokerSocket();
    const id = roomId(40);
    const connA = joinGroup(registry, a, id, peerId(1));
    joinGroup(registry, b, id, peerId(2));
    joinGroup(registry, c, id, peerId(3));
    a.sent.length = 0;
    b.sent.length = 0;
    c.sent.length = 0;

    const offer = { type: "offer", sdp: "opaque" };
    connA.onMessage(JSON.stringify({ t: "offer", sdp: offer, to: peerId(2) }));

    expect(b.sent).toHaveLength(1);
    expect(JSON.parse(b.sent[0])).toEqual({ t: "offer", sdp: offer, from: peerId(1) });
    expect(c.sent).toHaveLength(0);
    expect(a.sent).toHaveLength(0);
  });

  it("routes answers and ice by `to` and attaches the sender's peerId as `from`", () => {
    const registry = new RoomRegistry();
    const a = new MockBrokerSocket();
    const b = new MockBrokerSocket();
    const id = roomId(41);
    const connA = joinGroup(registry, a, id, peerId(1));
    const connB = joinGroup(registry, b, id, peerId(2));
    a.sent.length = 0;
    b.sent.length = 0;

    connB.onMessage(JSON.stringify({ t: "answer", sdp: { type: "answer" }, to: peerId(1) }));
    expect(JSON.parse(a.sent[0])).toEqual({
      t: "answer",
      sdp: { type: "answer" },
      from: peerId(2),
    });

    connA.onMessage(JSON.stringify({ t: "ice", candidate: { candidate: "k" }, to: peerId(2) }));
    expect(JSON.parse(b.sent[0])).toEqual({
      t: "ice",
      candidate: { candidate: "k" },
      from: peerId(1),
    });
  });

  it("drops a message addressed to an unseated peerId silently (leave race)", () => {
    const registry = new RoomRegistry();
    const a = new MockBrokerSocket();
    const b = new MockBrokerSocket();
    const id = roomId(42);
    const connA = joinGroup(registry, a, id, peerId(1));
    joinGroup(registry, b, id, peerId(2));
    a.sent.length = 0;
    b.sent.length = 0;

    connA.onMessage(JSON.stringify({ t: "offer", sdp: { type: "offer" }, to: peerId(99) }));
    expect(a.sent).toHaveLength(0);
    expect(b.sent).toHaveLength(0);
    expect(a.closed).toBe(false);
    expect(registry.peerCount(id)).toBe(2);
  });

  it("drops an unaddressed message in a group room (`to` is required)", () => {
    const registry = new RoomRegistry();
    const a = new MockBrokerSocket();
    const b = new MockBrokerSocket();
    const id = roomId(43);
    const connA = joinGroup(registry, a, id, peerId(1));
    joinGroup(registry, b, id, peerId(2));
    a.sent.length = 0;
    b.sent.length = 0;

    connA.onMessage(JSON.stringify({ t: "offer", sdp: { type: "offer" } }));
    expect(b.sent).toHaveLength(0);
  });

  it("ignores a client-supplied `from` and attributes the real seat's peerId", () => {
    const registry = new RoomRegistry();
    const a = new MockBrokerSocket();
    const b = new MockBrokerSocket();
    const id = roomId(44);
    const connA = joinGroup(registry, a, id, peerId(1));
    joinGroup(registry, b, id, peerId(2));
    b.sent.length = 0;

    connA.onMessage(
      JSON.stringify({ t: "offer", sdp: { type: "offer" }, to: peerId(2), from: peerId(7) }),
    );
    expect(JSON.parse(b.sent[0])).toEqual({
      t: "offer",
      sdp: { type: "offer" },
      from: peerId(1),
    });
  });
});

describe("group room — leave", () => {
  it("broadcasts {t:leave, roomId, peerId} to remaining members on explicit leave, never to the leaver", () => {
    const registry = new RoomRegistry();
    const a = new MockBrokerSocket();
    const b = new MockBrokerSocket();
    const c = new MockBrokerSocket();
    const id = roomId(50);
    joinGroup(registry, a, id, peerId(1));
    const connB = joinGroup(registry, b, id, peerId(2));
    joinGroup(registry, c, id, peerId(3));
    a.sent.length = 0;
    b.sent.length = 0;
    c.sent.length = 0;

    connB.onMessage(JSON.stringify({ t: "leave", roomId: id }));
    expect(registry.peerCount(id)).toBe(2);
    expect(JSON.parse(a.sent[0])).toEqual({ t: "leave", roomId: id, peerId: peerId(2) });
    expect(JSON.parse(c.sent[0])).toEqual({ t: "leave", roomId: id, peerId: peerId(2) });
    expect(b.sent).toHaveLength(0);
  });

  it("broadcasts {t:leave, roomId, peerId} to remaining members on socket close", () => {
    const registry = new RoomRegistry();
    const a = new MockBrokerSocket();
    const b = new MockBrokerSocket();
    const c = new MockBrokerSocket();
    const id = roomId(51);
    joinGroup(registry, a, id, peerId(1));
    const connB = joinGroup(registry, b, id, peerId(2));
    joinGroup(registry, c, id, peerId(3));
    a.sent.length = 0;
    b.sent.length = 0;
    c.sent.length = 0;

    connB.onClose();
    expect(registry.peerCount(id)).toBe(2);
    expect(JSON.parse(a.sent[0])).toEqual({ t: "leave", roomId: id, peerId: peerId(2) });
    expect(JSON.parse(c.sent[0])).toEqual({ t: "leave", roomId: id, peerId: peerId(2) });
    expect(b.sent).toHaveLength(0);
  });

  it("drops the room entirely when the last member leaves", () => {
    const registry = new RoomRegistry();
    const a = new MockBrokerSocket();
    const b = new MockBrokerSocket();
    const id = roomId(52);
    const connA = joinGroup(registry, a, id, peerId(1));
    const connB = joinGroup(registry, b, id, peerId(2));

    connA.onClose();
    connB.onClose();
    expect(registry.has(id)).toBe(false);
    expect(registry.size()).toBe(0);
  });
});

describe("group room — registry seat lookups", () => {
  it("getPeerById returns the socket seated under a peerId and null for unknowns", () => {
    const registry = new RoomRegistry();
    const a = new MockBrokerSocket();
    const b = new MockBrokerSocket();
    const id = roomId(60);
    registry.join(id, a, { mode: "group", peerId: peerId(1) });
    registry.join(id, b, { mode: "group", peerId: peerId(2) });

    expect(registry.getPeerById(id, peerId(1))).toBe(a);
    expect(registry.getPeerById(id, peerId(2))).toBe(b);
    expect(registry.getPeerById(id, peerId(9))).toBeNull();
    expect(registry.getPeerById(roomId(61), peerId(1))).toBeNull();
  });

  it("listPeers returns every seat with its peerId and honours the exclusion", () => {
    const registry = new RoomRegistry();
    const a = new MockBrokerSocket();
    const b = new MockBrokerSocket();
    const c = new MockBrokerSocket();
    const id = roomId(62);
    registry.join(id, a, { mode: "group", peerId: peerId(1) });
    registry.join(id, b, { mode: "group", peerId: peerId(2) });
    registry.join(id, c, { mode: "group", peerId: peerId(3) });

    expect(registry.listPeers(id)).toEqual([
      { peerId: peerId(1), socket: a },
      { peerId: peerId(2), socket: b },
      { peerId: peerId(3), socket: c },
    ]);
    expect(registry.listPeers(id, b)).toEqual([
      { peerId: peerId(1), socket: a },
      { peerId: peerId(3), socket: c },
    ]);
    expect(registry.listPeers(roomId(63))).toEqual([]);
  });
});

describe("pair room — wire shape unchanged", () => {
  it("emits byte-identical join/relay/leave frames with no peerId fields", () => {
    const registry = new RoomRegistry();
    const a = new MockBrokerSocket();
    const b = new MockBrokerSocket();
    const id = roomId(70);
    const connA = joinPair(registry, a, id);
    joinPair(registry, b, id);

    // Second-peer join notification: exactly the legacy JSON.
    expect(a.sent[0]).toBe(`{"t":"join","roomId":"${id}"}`);

    // Relayed offer: exactly {t, sdp} — no `to`/`from` keys.
    connA.onMessage(JSON.stringify({ t: "offer", sdp: { type: "offer", sdp: "x" } }));
    expect(b.sent[b.sent.length - 1]).toBe('{"t":"offer","sdp":{"type":"offer","sdp":"x"}}');

    // Peer-left notification on close: exactly the legacy JSON.
    connA.onClose();
    expect(b.sent[b.sent.length - 1]).toBe(`{"t":"leave","roomId":"${id}"}`);
  });

  it("strips client-supplied addressing fields on the pair relay path", () => {
    const registry = new RoomRegistry();
    const a = new MockBrokerSocket();
    const b = new MockBrokerSocket();
    const id = roomId(71);
    const connA = joinPair(registry, a, id);
    joinPair(registry, b, id);
    b.sent.length = 0;

    connA.onMessage(
      JSON.stringify({
        t: "offer",
        sdp: { type: "offer", sdp: "x" },
        to: peerId(2),
        from: peerId(9),
      }),
    );
    expect(b.sent[0]).toBe('{"t":"offer","sdp":{"type":"offer","sdp":"x"}}');
  });
});
