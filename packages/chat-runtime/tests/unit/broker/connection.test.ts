import { describe, expect, it } from "vitest";

import { BrokerConnection } from "@fuck-eu-chat-control/chat-runtime/broker/connection";
import { RoomRegistry } from "@fuck-eu-chat-control/chat-runtime/broker/room-registry";
import { MockBrokerSocket } from "./_helpers";

function roomId(seed: number): string {
  let hex = "";
  for (let i = 0; i < 32; i++) {
    hex += ((seed * 31 + i * 7) & 0xff).toString(16).padStart(2, "0");
  }
  return hex.slice(0, 32);
}

function join(registry: RoomRegistry, socket: MockBrokerSocket, id: string): BrokerConnection {
  const conn = new BrokerConnection(socket, registry);
  conn.onMessage(JSON.stringify({ t: "join", roomId: id }));
  return conn;
}

describe("BrokerConnection — join", () => {
  it("admits a peer to a room on a join message", () => {
    const registry = new RoomRegistry();
    const socket = new MockBrokerSocket();
    const id = roomId(1);
    join(registry, socket, id);
    expect(registry.peerCount(id)).toBe(1);
  });

  it("notifies the existing peer when a second peer joins the room", () => {
    const registry = new RoomRegistry();
    const a = new MockBrokerSocket();
    const b = new MockBrokerSocket();
    const id = roomId(11);
    join(registry, a, id);
    // No notification yet — a is alone.
    expect(a.sent).toHaveLength(0);
    join(registry, b, id);
    // The existing peer (a) learns a peer has arrived; the newcomer (b) is not
    // notified (it learns presence from SDP/ICE relay or its own join echo).
    expect(a.sent).toHaveLength(1);
    expect(JSON.parse(a.sent[0])).toEqual({ t: "join", roomId: id });
    expect(b.sent).toHaveLength(0);
  });

  it("ignores a join with a malformed room id (rejected by the codec) without closing", () => {
    const registry = new RoomRegistry();
    const socket = new MockBrokerSocket();
    const conn = new BrokerConnection(socket, registry);
    conn.onMessage(JSON.stringify({ t: "join", roomId: "bad" }));
    expect(socket.closed).toBe(false);
    expect(registry.size()).toBe(0);
  });

  it("ignores unparseable messages without changing state", () => {
    const registry = new RoomRegistry();
    const socket = new MockBrokerSocket();
    const conn = new BrokerConnection(socket, registry);
    conn.onMessage("not json");
    conn.onMessage("");
    expect(registry.size()).toBe(0);
  });
});

describe("BrokerConnection — relay", () => {
  it("forwards an offer opaquely to the other peer", () => {
    const registry = new RoomRegistry();
    const a = new MockBrokerSocket();
    const b = new MockBrokerSocket();
    const id = roomId(2);
    const connA = join(registry, a, id);
    join(registry, b, id);
    // The second-peer join notifies a (counted separately from the offer relay).
    const aJoinNotifications = a.sent.length;

    const offer = { type: "offer", sdp: "opaque" };
    connA.onMessage(JSON.stringify({ t: "offer", sdp: offer }));

    expect(b.sent).toHaveLength(1);
    expect(JSON.parse(b.sent[0])).toEqual({ t: "offer", sdp: offer });
    // a only received the join notification, never its own offer back.
    expect(a.sent.length).toBe(aJoinNotifications);
  });

  it("forwards answers and ice candidates in both directions", () => {
    const registry = new RoomRegistry();
    const a = new MockBrokerSocket();
    const b = new MockBrokerSocket();
    const id = roomId(3);
    const connA = join(registry, a, id);
    const connB = join(registry, b, id);
    // Discard the join notification the second peer generated on a, so the
    // assertions below see only relayed SDP/ICE frames.
    a.sent.length = 0;

    connA.onMessage(JSON.stringify({ t: "answer", sdp: { type: "answer", sdp: "y" } }));
    expect(JSON.parse(b.sent[0]).t).toBe("answer");

    connB.onMessage(JSON.stringify({ t: "ice", candidate: { candidate: "k" } }));
    expect(JSON.parse(a.sent[0]).t).toBe("ice");
  });

  it("does not echo a peer's own join/leave back to itself via the relay path", () => {
    const registry = new RoomRegistry();
    const a = new MockBrokerSocket();
    const b = new MockBrokerSocket();
    const id = roomId(4);
    const connA = join(registry, a, id);
    join(registry, b, id);
    // The peer-presence join notification from the second peer's join arrives
    // on a; clear both sides so we assert only the relay-path behavior below.
    a.sent.length = 0;
    b.sent.length = 0;

    // A's own leave is NOT forwarded to b by the relay: forward() filters to
    // offer/answer/ice, so join/leave never take the relay path. (A re-join
    // after leaving would make A the second peer and correctly notify B, which
    // is why this test uses only a leave — the relay-must-not-echo contract.)
    connA.onMessage(JSON.stringify({ t: "leave", roomId: id }));
    expect(b.sent).toHaveLength(0);
  });

  it("drops a relay when the sender is not in a room", () => {
    const registry = new RoomRegistry();
    const a = new MockBrokerSocket();
    const conn = new BrokerConnection(a, registry);
    conn.onMessage(JSON.stringify({ t: "offer", sdp: { type: "offer", sdp: "x" } }));
    expect(a.sent).toHaveLength(0);
  });

  it("drops a relay when no peer is present in the room", () => {
    const registry = new RoomRegistry();
    const a = new MockBrokerSocket();
    const id = roomId(5);
    const conn = join(registry, a, id);
    conn.onMessage(JSON.stringify({ t: "offer", sdp: { type: "offer", sdp: "x" } }));
    expect(a.sent).toHaveLength(0);
  });
});

describe("BrokerConnection — leave and cleanup", () => {
  it("leaves the room on an explicit leave message", () => {
    const registry = new RoomRegistry();
    const a = new MockBrokerSocket();
    const b = new MockBrokerSocket();
    const id = roomId(6);
    const connA = join(registry, a, id);
    join(registry, b, id);

    connA.onMessage(JSON.stringify({ t: "leave", roomId: id }));
    expect(registry.peerCount(id)).toBe(1);
  });

  it("removes the socket mapping on close", () => {
    const registry = new RoomRegistry();
    const a = new MockBrokerSocket();
    const b = new MockBrokerSocket();
    const id = roomId(7);
    const connA = join(registry, a, id);
    join(registry, b, id);

    connA.onClose();
    expect(registry.peerCount(id)).toBe(1);

    const c = new MockBrokerSocket();
    const res = registry.join(id, c);
    expect(res.joined).toBe(true);
    expect(res.isSecondPeer).toBe(true);
  });

  it("drops the room entirely when the last peer closes", () => {
    const registry = new RoomRegistry();
    const a = new MockBrokerSocket();
    const b = new MockBrokerSocket();
    const id = roomId(8);
    const connA = join(registry, a, id);
    const connB = join(registry, b, id);

    connA.onClose();
    connB.onClose();
    expect(registry.has(id)).toBe(false);
    expect(registry.size()).toBe(0);
  });

  it("a third peer is rejected without displacing either existing peer", () => {
    const registry = new RoomRegistry();
    const a = new MockBrokerSocket();
    const b = new MockBrokerSocket();
    const c = new MockBrokerSocket();
    const id = roomId(9);
    join(registry, a, id);
    join(registry, b, id);
    // b's join delivered one presence notification to a; snapshot the count.
    const aNotifications = a.sent.length;
    const connC = join(registry, c, id);

    expect(c.closed).toBe(true);
    connC.onMessage(JSON.stringify({ t: "offer", sdp: { type: "offer", sdp: "z" } }));
    // The rejected third peer neither received nor generated any relay.
    expect(c.sent).toHaveLength(0);
    // No new notifications: a still has only the one from b's join.
    expect(a.sent.length).toBe(aNotifications);
    expect(b.sent).toHaveLength(0);
  });
});

describe("BrokerConnection — resumption", () => {
  it("re-joining a previously emptied room relays to a new peer identically", () => {
    const registry = new RoomRegistry();
    const id = roomId(10);
    const a = new MockBrokerSocket();
    const b = new MockBrokerSocket();
    const connA = join(registry, a, id);
    const connB = join(registry, b, id);
    connA.onClose();
    connB.onClose();
    expect(registry.has(id)).toBe(false);

    const a2 = new MockBrokerSocket();
    const b2 = new MockBrokerSocket();
    const connA2 = join(registry, a2, id);
    join(registry, b2, id);
    connA2.onMessage(JSON.stringify({ t: "offer", sdp: { type: "offer", sdp: "r" } }));
    expect(JSON.parse(b2.sent[0])).toEqual({ t: "offer", sdp: { type: "offer", sdp: "r" } });
  });
});
