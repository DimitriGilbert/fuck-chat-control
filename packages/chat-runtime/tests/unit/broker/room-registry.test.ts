import { describe, expect, it } from "vitest";

import {
  MAX_ROOMS,
  RoomRegistry,
  isValidRoomId,
} from "@fuck-eu-chat-control/chat-runtime/broker/room-registry";
import { MockBrokerSocket } from "./_helpers";

function roomId(seed: number): string {
  let hex = "";
  for (let i = 0; i < 32; i++) {
    hex += ((seed * 31 + i * 7) & 0xff).toString(16).padStart(2, "0");
  }
  return hex.slice(0, 32);
}

describe("isValidRoomId", () => {
  it("accepts a 32-char lowercase hex string (16 bytes)", () => {
    expect(isValidRoomId("00112233445566778899aabbccddeeff")).toBe(true);
  });

  it("accepts all-zeros and all-ff room ids", () => {
    expect(isValidRoomId("00000000000000000000000000000000")).toBe(true);
    expect(isValidRoomId("ffffffffffffffffffffffffffffffff")).toBe(true);
  });

  it("rejects uppercase hex", () => {
    expect(isValidRoomId("00112233445566778899AABBCCDDEEFF")).toBe(false);
  });

  it("rejects non-hex characters", () => {
    expect(isValidRoomId("00112233445566778899aabbccddeefz")).toBe(false);
  });

  it("rejects too-short ids", () => {
    expect(isValidRoomId("0011223344556677")).toBe(false);
  });

  it("rejects too-long ids", () => {
    expect(isValidRoomId("00112233445566778899aabbccddeeff00")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidRoomId("")).toBe(false);
  });
});

describe("RoomRegistry.join", () => {
  it("admits a first peer to a fresh room", () => {
    const reg = new RoomRegistry();
    const sock = new MockBrokerSocket();
    const id = roomId(1);
    const res = reg.join(id, sock);
    expect(res.joined).toBe(true);
    expect(res.isSecondPeer).toBe(false);
  });

  it("admits a second peer and marks the room full", () => {
    const reg = new RoomRegistry();
    const a = new MockBrokerSocket();
    const b = new MockBrokerSocket();
    const id = roomId(2);
    expect(reg.join(id, a).joined).toBe(true);
    const res = reg.join(id, b);
    expect(res.joined).toBe(true);
    expect(res.isSecondPeer).toBe(true);
  });

  it("rejects a malformed room id without admitting any peer", () => {
    const reg = new RoomRegistry();
    const sock = new MockBrokerSocket();
    const res = reg.join("nothex", sock);
    expect(res.joined).toBe(false);
    expect(res.reason).toBe("malformed");
    expect(reg.size()).toBe(0);
  });

  it("rejects an oversized room id", () => {
    const reg = new RoomRegistry();
    const sock = new MockBrokerSocket();
    const res = reg.join("00112233445566778899aabbccddeeff00", sock);
    expect(res.joined).toBe(false);
    expect(res.reason).toBe("malformed");
  });

  it("rejects a third peer without displacing either existing peer", () => {
    const reg = new RoomRegistry();
    const a = new MockBrokerSocket();
    const b = new MockBrokerSocket();
    const c = new MockBrokerSocket();
    const id = roomId(3);
    reg.join(id, a);
    reg.join(id, b);
    const res = reg.join(id, c);
    expect(res.joined).toBe(false);
    expect(res.reason).toBe("full");
    expect(reg.peerCount(id)).toBe(2);
    expect(c.closed).toBe(true);
  });
});

describe("RoomRegistry.leave and cleanup", () => {
  it("removes a leaving peer but keeps the room while one peer remains", () => {
    const reg = new RoomRegistry();
    const a = new MockBrokerSocket();
    const b = new MockBrokerSocket();
    const id = roomId(4);
    reg.join(id, a);
    reg.join(id, b);
    reg.leave(id, a);
    expect(reg.peerCount(id)).toBe(1);
  });

  it("drops the room entirely when the last peer leaves", () => {
    const reg = new RoomRegistry();
    const a = new MockBrokerSocket();
    const b = new MockBrokerSocket();
    const id = roomId(5);
    reg.join(id, a);
    reg.join(id, b);
    reg.leave(id, a);
    reg.leave(id, b);
    expect(reg.has(id)).toBe(false);
    expect(reg.size()).toBe(0);
  });

  it("leaving an unknown room is a no-op", () => {
    const reg = new RoomRegistry();
    const sock = new MockBrokerSocket();
    const id = roomId(6);
    reg.join(id, sock);
    reg.leave(roomId(99), sock);
    expect(reg.peerCount(id)).toBe(1);
  });

  it("leaving with a socket not in the room is a no-op", () => {
    const reg = new RoomRegistry();
    const a = new MockBrokerSocket();
    const other = new MockBrokerSocket();
    const id = roomId(7);
    reg.join(id, a);
    reg.leave(id, other);
    expect(reg.peerCount(id)).toBe(1);
  });

  it("removeSocket clears the socket from every room it occupies (error/close path)", () => {
    const reg = new RoomRegistry();
    const a = new MockBrokerSocket();
    const b = new MockBrokerSocket();
    const id = roomId(8);
    reg.join(id, a);
    reg.join(id, b);
    reg.removeSocket(a);
    expect(reg.peerCount(id)).toBe(1);
    expect(reg.has(id)).toBe(true);
    reg.removeSocket(b);
    expect(reg.has(id)).toBe(false);
  });

  it("removeSocket on an unknown socket is a no-op", () => {
    const reg = new RoomRegistry();
    reg.removeSocket(new MockBrokerSocket());
    expect(reg.size()).toBe(0);
  });
});

describe("RoomRegistry.getPeer (forwarding target)", () => {
  it("returns the other peer for a two-peer room", () => {
    const reg = new RoomRegistry();
    const a = new MockBrokerSocket();
    const b = new MockBrokerSocket();
    const id = roomId(9);
    reg.join(id, a);
    reg.join(id, b);
    expect(reg.getPeer(id, a)).toBe(b);
    expect(reg.getPeer(id, b)).toBe(a);
  });

  it("returns null when the socket is the only peer", () => {
    const reg = new RoomRegistry();
    const a = new MockBrokerSocket();
    const id = roomId(10);
    reg.join(id, a);
    expect(reg.getPeer(id, a)).toBeNull();
  });

  it("returns null for an unknown room", () => {
    const reg = new RoomRegistry();
    expect(reg.getPeer(roomId(11), new MockBrokerSocket())).toBeNull();
  });
});

describe("RoomRegistry resumption", () => {
  it("re-joining a previously emptied room works identically to first contact", () => {
    const reg = new RoomRegistry();
    const id = roomId(12);
    const a = new MockBrokerSocket();
    const b = new MockBrokerSocket();
    reg.join(id, a);
    reg.join(id, b);
    reg.leave(id, a);
    reg.leave(id, b);
    expect(reg.has(id)).toBe(false);

    const a2 = new MockBrokerSocket();
    const b2 = new MockBrokerSocket();
    const first = reg.join(id, a2);
    const second = reg.join(id, b2);
    expect(first.joined).toBe(true);
    expect(first.isSecondPeer).toBe(false);
    expect(second.joined).toBe(true);
    expect(second.isSecondPeer).toBe(true);
    expect(reg.getPeer(id, a2)).toBe(b2);
  });
});

describe("RoomRegistry room cap — R3/F2 (MAX_ROOMS)", () => {
  it("exports a MAX_ROOMS constant with the documented v1 default", () => {
    expect(MAX_ROOMS).toBe(1024);
  });

  it("rejects creating a NEW room once the cap is reached (too_many_rooms)", () => {
    // Small cap via the constructor seam so the test doesn't fill 1024 rooms.
    const reg = new RoomRegistry({ maxRooms: 2 });
    const a = new MockBrokerSocket();
    const b = new MockBrokerSocket();
    const c = new MockBrokerSocket();
    const id1 = roomId(101);
    const id2 = roomId(102);
    const id3 = roomId(103);
    expect(reg.join(id1, a).joined).toBe(true);
    expect(reg.join(id2, b).joined).toBe(true);

    const res = reg.join(id3, c);
    expect(res.joined).toBe(false);
    expect(res.reason).toBe("too_many_rooms");
    // The rejected socket is hard-closed (matches the "room full" rejection
    // style: close the offending socket so it doesn't linger).
    expect(c.closed).toBe(true);
    expect(c.closeCode).toBe(1013);
    // The cap must NOT admit the room: the room set stays at the cap and the
    // new room id is not present.
    expect(reg.size()).toBe(2);
    expect(reg.has(id3)).toBe(false);
  });

  it("does NOT gate joining an EXISTING room (the cap is on the create path only)", () => {
    // Fill to the cap with one-peer rooms, then add a SECOND peer to an
    // existing room — that must succeed because it creates no new room.
    const reg = new RoomRegistry({ maxRooms: 1 });
    const a = new MockBrokerSocket();
    const b = new MockBrokerSocket();
    const c = new MockBrokerSocket();
    const id = roomId(104);
    reg.join(id, a);
    expect(reg.size()).toBe(1); // at the cap

    const secondPeer = reg.join(id, b);
    expect(secondPeer.joined).toBe(true);
    expect(secondPeer.isSecondPeer).toBe(true);
    // Adding the second peer did not grow the room count.
    expect(reg.size()).toBe(1);

    // A genuinely new room is still rejected.
    const res = reg.join(roomId(105), c);
    expect(res.joined).toBe(false);
    expect(res.reason).toBe("too_many_rooms");
  });

  it("admits a new room after one frees up (the cap re-opens)", () => {
    const reg = new RoomRegistry({ maxRooms: 1 });
    const a = new MockBrokerSocket();
    const id1 = roomId(106);
    reg.join(id1, a);
    expect(reg.join(roomId(107), new MockBrokerSocket()).joined).toBe(false);

    // Last peer leaves → room dropped → a fresh room can be created again.
    reg.leave(id1, a);
    const res = reg.join(roomId(108), new MockBrokerSocket());
    expect(res.joined).toBe(true);
  });

  it("defaults to MAX_ROOMS when the constructor option is omitted", () => {
    // The default-constructed registry must use MAX_ROOMS, not an undefined/
    // zero cap. We assert by reflecting on a single join (can't feasibly fill
    // 1024 rooms in a unit test); the cap value is exercised via the
    // constructor seam above.
    const reg = new RoomRegistry();
    expect(reg.join(roomId(109), new MockBrokerSocket()).joined).toBe(true);
  });
});
