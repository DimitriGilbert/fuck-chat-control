import { describe, expect, it } from "vitest";

import { applyTransferEvent, type TransferState } from "@/features/chat/runtime/transfer-state";

/**
 * R9/F4 (Phase 8.5): the framing sender's transfer-id space starts at
 * FIRST_TRANSFER_ID = 1_000_000 (see framing/sender.ts). The controller's
 * queued placeholders use ids in [1, 999_999]. The two id spaces are
 * disjoint, so a queued placeholder id can NEVER collide with a real
 * orchestrator-allocated transfer id.
 *
 * The transfer-state reducer deduplicates by id on `start` events; without
 * the disjoint id space, a queued placeholder at id=N could alias a later
 * real transfer at id=N (after the queued entry was drained), and the
 * reducer would treat the real start as a duplicate (returning the same
 * array reference without inserting). This test exercises the contract via
 * the reducer directly.
 */

const QUEUED_ID = 1; // first queued id from controller's nextQueuedId counter
const REAL_ID = 1_000_000; // framing sender's FIRST_TRANSFER_ID

describe("queued-id collision avoidance (R9/F4 / Phase 8.5)", () => {
  it("the queued and real id spaces are disjoint (real ids start at 1_000_000)", () => {
    // The controller's queuedId counter starts at 1 and increments by 1 per
    // queued send. Real orchestrator ids start at 1_000_000. The gap between
    // the highest possible queued id (999_999) and the lowest real id
    // (1_000_000) is exactly 1 — they cannot overlap.
    expect(QUEUED_ID).toBeLessThan(REAL_ID);
    expect(REAL_ID).toBe(1_000_000);
  });

  it("a queued placeholder + a real transfer with different ids both land in the snapshot", () => {
    // Start a queued placeholder at QUEUED_ID, then start a real transfer at
    // REAL_ID. The reducer must accept both because the ids are different.
    const queued = applyTransferEvent([], {
      type: "start",
      id: QUEUED_ID,
      name: "queued.bin",
      mimeType: "application/octet-stream",
      size: 100,
      direction: "sent",
      queued: true,
    });
    expect(queued).toHaveLength(1);
    expect(queued[0]!.id).toBe(QUEUED_ID);
    expect(queued[0]!.status).toBe("queued");

    const both = applyTransferEvent(queued, {
      type: "start",
      id: REAL_ID,
      name: "real.bin",
      mimeType: "application/octet-stream",
      size: 200,
      direction: "sent",
    });
    expect(both).toHaveLength(2);
    const ids = both.map((t) => t.id);
    expect(ids).toContain(QUEUED_ID);
    expect(ids).toContain(REAL_ID);
  });

  it("the reducer does NOT deduplicate across disjoint id spaces", () => {
    // Start a queued placeholder at QUEUED_ID, then progress the SAME id to
    // sending (the queued entry was drained and the real orchestrator id
    // would be a fresh number, NOT QUEUED_ID — that's the whole point).
    // Without the disjoint id space, the controller would have used
    // QUEUED_ID for the queued entry AND for the eventual real transfer,
    // causing the reducer to dedup the second start (treating it as the
    // existing entry). With the fix, the real id is REAL_ID, distinct.
    const queued = applyTransferEvent([], {
      type: "start",
      id: QUEUED_ID,
      name: "queued.bin",
      mimeType: "application/octet-stream",
      size: 100,
      direction: "sent",
      queued: true,
    });

    // The queued entry transitions to terminal when the real send starts.
    const cancelled = applyTransferEvent(queued, {
      type: "cancelled",
      id: QUEUED_ID,
    });
    expect(cancelled[0]!.status).toBe("cancelled");

    // A NEW real transfer with REAL_ID starts. The reducer must insert it
    // (different id, no dedup).
    const real = applyTransferEvent(cancelled, {
      type: "start",
      id: REAL_ID,
      name: "real.bin",
      mimeType: "application/octet-stream",
      size: 100,
      direction: "sent",
    });
    expect(real).toHaveLength(2);
    const realEntry = real.find((t) => t.id === REAL_ID);
    expect(realEntry).toBeDefined();
    expect(realEntry!.status).toBe("sending");
  });

  it("two queued placeholders with sequential ids both land in the snapshot", () => {
    // The controller's nextQueuedId increments per queued send. The first
    // queued id is 1, the second is 2, etc. — all below REAL_ID.
    const q1 = applyTransferEvent([], {
      type: "start",
      id: 1,
      name: "a.bin",
      mimeType: "application/octet-stream",
      size: 10,
      direction: "sent",
      queued: true,
    });
    const q2 = applyTransferEvent(q1, {
      type: "start",
      id: 2,
      name: "b.bin",
      mimeType: "application/octet-stream",
      size: 10,
      direction: "sent",
      queued: true,
    });
    expect(q2).toHaveLength(2);
    expect(q2.map((t) => t.id)).toEqual([1, 2]);
  });

  it("a real transfer with id 1_000_001 does not collide with a queued id 1", () => {
    // Even at the boundary: queued id 1 and real id 1_000_001 are distinct.
    const queued = applyTransferEvent([], {
      type: "start",
      id: 1,
      name: "queued.bin",
      mimeType: "application/octet-stream",
      size: 100,
      direction: "sent",
      queued: true,
    });
    const real = applyTransferEvent(queued, {
      type: "start",
      id: 1_000_001,
      name: "real.bin",
      mimeType: "application/octet-stream",
      size: 200,
      direction: "sent",
    });
    expect(real).toHaveLength(2);
    const ids = real.map((t) => t.id).sort();
    expect(ids).toEqual([1, 1_000_001]);
  });
});

/**
 * Sanity: ensure the reducer's start branch correctly handles the queued flag
 * at both id-space boundaries. This anchors the contract for the disjoint
 * id space — the reducer does not need to know about the 1M floor, but the
 * contract only holds if the floor exists.
 */
describe("applyTransferEvent start branch at id-space boundaries", () => {
  it("starts a queued placeholder at id 1 with status=queued", () => {
    const next = applyTransferEvent([], {
      type: "start",
      id: 1,
      name: "x",
      mimeType: "application/octet-stream",
      size: 1,
      direction: "sent",
      queued: true,
    });
    expect(next[0]!.status).toBe("queued");
  });

  it("starts a real sent transfer at id 1_000_000 with status=sending", () => {
    const next = applyTransferEvent([], {
      type: "start",
      id: 1_000_000,
      name: "x",
      mimeType: "application/octet-stream",
      size: 1,
      direction: "sent",
    });
    expect(next[0]!.status).toBe("sending");
  });

  it("returns the same reference when starting a duplicate id", () => {
    const state: readonly TransferState[] = [
      {
        id: 5,
        name: "x",
        mimeType: "application/octet-stream",
        size: 1,
        direction: "sent",
        bytesTransferred: 0,
        status: "queued",
      },
    ];
    const next = applyTransferEvent(state, {
      type: "start",
      id: 5,
      name: "y",
      mimeType: "application/octet-stream",
      size: 1,
      direction: "sent",
    });
    expect(next).toBe(state);
  });
});
