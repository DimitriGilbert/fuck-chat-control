import { describe, expect, it } from "vitest";

import { runSweep, startZombieSweep } from "@/features/chat/broker/sweep";

import { MockBrokerSocket } from "./_helpers";

describe("runSweep", () => {
  it("evicts sockets whose readyState > 1 (CLOSING/CLOSED)", () => {
    const open = new MockBrokerSocket(); // readyState 1 (OPEN)
    open.readyState = 1;
    const closing = new MockBrokerSocket();
    closing.readyState = 2; // CLOSING
    const closed = new MockBrokerSocket();
    closed.readyState = 3; // CLOSED

    const evicted: MockBrokerSocket[] = [];
    const count = runSweep([open, closing, closed], (s) => {
      evicted.push(s as MockBrokerSocket);
    });

    expect(count).toBe(2);
    expect(evicted).toEqual([closing, closed]);
  });

  it("leaves OPEN sockets untouched", () => {
    const a = new MockBrokerSocket();
    a.readyState = 1;
    const b = new MockBrokerSocket();
    b.readyState = 1;
    const evicted: unknown[] = [];
    const count = runSweep([a, b], (s) => evicted.push(s));
    expect(count).toBe(0);
    expect(evicted).toEqual([]);
  });

  it("reports zero evictions for an empty socket set", () => {
    const evicted: unknown[] = [];
    expect(runSweep([], (s) => evicted.push(s))).toBe(0);
    expect(evicted).toEqual([]);
  });
});

describe("startZombieSweep", () => {
  it("invokes evict on a short cadence and stops cleanly", async () => {
    const socket = new MockBrokerSocket();
    socket.readyState = 3;
    const evicted: MockBrokerSocket[] = [];
    const handle = startZombieSweep(
      () => [socket],
      (s) => evicted.push(s as MockBrokerSocket),
      { intervalMs: 20 },
    );

    // Wait long enough for at least one tick.
    await new Promise((resolve) => setTimeout(resolve, 60));

    handle.stop();
    expect(evicted.length).toBeGreaterThanOrEqual(1);
    expect(evicted.every((s) => s === socket)).toBe(true);
  });

  it("does not evict healthy sockets on tick", async () => {
    const socket = new MockBrokerSocket();
    socket.readyState = 1;
    const evicted: unknown[] = [];
    const handle = startZombieSweep(
      () => [socket],
      (s) => evicted.push(s),
      { intervalMs: 20 },
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    handle.stop();
    expect(evicted).toEqual([]);
  });

  it("stop() prevents further evictions", async () => {
    const socket = new MockBrokerSocket();
    socket.readyState = 3;
    const evicted: unknown[] = [];
    const handle = startZombieSweep(
      () => [socket],
      (s) => evicted.push(s),
      { intervalMs: 20 },
    );
    handle.stop();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(evicted).toEqual([]);
  });
});
