import { describe, expect, it } from "vitest";

import { BrokerConnection } from "@fuck-eu-chat-control/chat-runtime/broker/connection";
import {
  BROKER_CLOSE_CODES,
  BROKER_CLOSE_REASONS,
  BrokerErrorCode,
} from "@fuck-eu-chat-control/chat-runtime/broker/errors";
import { RoomRegistry } from "@fuck-eu-chat-control/chat-runtime/broker/room-registry";

import { MockBrokerSocket } from "./_helpers";

function roomId(seed: number): string {
  let hex = "";
  for (let i = 0; i < 32; i++) {
    hex += ((seed * 31 + i * 7) & 0xff).toString(16).padStart(2, "0");
  }
  return hex.slice(0, 32);
}

describe("BrokerConnection.handleJoin — AlreadySeated rejection (R5/F1)", () => {
  it("rejects a second join from an already-seated socket with the AlreadySeated close code", () => {
    const registry = new RoomRegistry();
    const a = new MockBrokerSocket();
    const id = roomId(1);
    const connA = new BrokerConnection(a, registry);
    connA.onMessage(JSON.stringify({ t: "join", roomId: id }));
    expect(a.closed).toBe(false);

    connA.onMessage(JSON.stringify({ t: "join", roomId: id }));
    expect(a.closed).toBe(true);
    expect(a.closeCode).toBe(BROKER_CLOSE_CODES[BrokerErrorCode.AlreadySeated]);
    expect(a.closeReason).toBe(BROKER_CLOSE_REASONS[BrokerErrorCode.AlreadySeated]);
  });

  it("rejects a second join even when addressed to a DIFFERENT room", () => {
    const registry = new RoomRegistry();
    const a = new MockBrokerSocket();
    const id1 = roomId(2);
    const id2 = roomId(3);
    const connA = new BrokerConnection(a, registry);
    connA.onMessage(JSON.stringify({ t: "join", roomId: id1 }));

    connA.onMessage(JSON.stringify({ t: "join", roomId: id2 }));
    expect(a.closed).toBe(true);
    expect(a.closeCode).toBe(BROKER_CLOSE_CODES[BrokerErrorCode.AlreadySeated]);
  });

  it("does NOT silently leave the first room on a second join", () => {
    // Critical invariant: the abandoned peer's peerPresent stays correct
    // because the offender's first seat is NOT released. The legitimate
    // reconnect path is a fresh socket.
    const registry = new RoomRegistry();
    const a = new MockBrokerSocket();
    const b = new MockBrokerSocket();
    const id = roomId(4);
    const connA = new BrokerConnection(a, registry);
    const connB = new BrokerConnection(b, registry);
    connA.onMessage(JSON.stringify({ t: "join", roomId: id }));
    connB.onMessage(JSON.stringify({ t: "join", roomId: id }));

    // Both peers are seated; a gets the join notification from b's arrival.
    expect(registry.peerCount(id)).toBe(2);

    // a attempts a second join — must be rejected, NOT silently leave + rejoin.
    connA.onMessage(JSON.stringify({ t: "join", roomId: id }));
    expect(a.closed).toBe(true);

    // The registry still has both original seats (the rejected second join
    // did not evict a). The offender's socket is closed but the seat is
    // reclaimed via onClose when the runtime delivers the close event.
    connA.onClose();
    expect(registry.peerCount(id)).toBe(1);

    // b — the abandoned partner — can still get a fresh peer via a NEW socket.
    const c = new MockBrokerSocket();
    const connC = new BrokerConnection(c, registry);
    connC.onMessage(JSON.stringify({ t: "join", roomId: id }));
    expect(registry.peerCount(id)).toBe(2);

    // b must have received a join notification for the fresh peer c.
    const lastToB = b.sent[b.sent.length - 1];
    expect(JSON.parse(lastToB)).toEqual({ t: "join", roomId: id });
  });

  it("relay/handleLeave paths are unchanged for a single-seated socket", () => {
    const registry = new RoomRegistry();
    const a = new MockBrokerSocket();
    const b = new MockBrokerSocket();
    const id = roomId(5);
    const connA = new BrokerConnection(a, registry);
    const connB = new BrokerConnection(b, registry);
    connA.onMessage(JSON.stringify({ t: "join", roomId: id }));
    connB.onMessage(JSON.stringify({ t: "join", roomId: id }));
    a.sent.length = 0;

    // handleLeave still works, and still does NOT notifyPeerLeft (Phase 2).
    connA.onMessage(JSON.stringify({ t: "leave", roomId: id }));
    expect(b.sent).toHaveLength(0);
    expect(registry.peerCount(id)).toBe(1);
  });
});
