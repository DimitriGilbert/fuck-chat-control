import { describe, expect, it } from "vitest";

import { RoomRegistry, isValidRoomId } from "@/features/chat/broker/room-registry";
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
