import { describe, expect, it } from "vitest";

import {
  applyTransferEvent,
  type TransferEvent,
  type TransferState,
} from "@fuck-eu-chat-control/chat-runtime/runtime/transfer-state";

describe("transfer-state reducer", () => {
  const startSent: TransferEvent = {
    type: "start",
    id: 1,
    name: "notes.txt",
    mimeType: "text/plain",
    size: 100,
    direction: "sent",
  };

  function findTransfer(state: readonly TransferState[], id: number): TransferState | undefined {
    return state.find((t) => t.id === id);
  }

  it("starts a sent transfer in the 'sending' status", () => {
    const next = applyTransferEvent([], startSent);
    expect(next).toHaveLength(1);
    const transfer = next[0]!;
    expect(transfer.id).toBe(1);
    expect(transfer.name).toBe("notes.txt");
    expect(transfer.mimeType).toBe("text/plain");
    expect(transfer.size).toBe(100);
    expect(transfer.direction).toBe("sent");
    expect(transfer.status).toBe("sending");
    expect(transfer.bytesTransferred).toBe(0);
    expect(transfer.error).toBeUndefined();
  });

  it("starts a received transfer in the 'receiving' status", () => {
    const next = applyTransferEvent([], { ...startSent, direction: "received" });
    expect(next[0]!.status).toBe("receiving");
    expect(next[0]!.direction).toBe("received");
  });

  it("advances bytesTransferred on progress without changing status", () => {
    const started = applyTransferEvent([], startSent);
    const next = applyTransferEvent(started, { type: "progress", id: 1, bytesTransferred: 50 });
    const transfer = findTransfer(next, 1);
    expect(transfer?.bytesTransferred).toBe(50);
    expect(transfer?.status).toBe("sending");
  });

  it("clamps bytesTransferred to size on progress", () => {
    const started = applyTransferEvent([], startSent);
    const next = applyTransferEvent(started, { type: "progress", id: 1, bytesTransferred: 999 });
    expect(findTransfer(next, 1)?.bytesTransferred).toBe(100);
  });

  it("marks a transfer complete with full bytesTransferred", () => {
    const started = applyTransferEvent([], startSent);
    const next = applyTransferEvent(started, { type: "complete", id: 1 });
    const transfer = findTransfer(next, 1);
    expect(transfer?.status).toBe("complete");
    expect(transfer?.bytesTransferred).toBe(100);
  });

  it("marks a transfer cancelled", () => {
    const started = applyTransferEvent([], startSent);
    const next = applyTransferEvent(started, { type: "cancelled", id: 1 });
    expect(findTransfer(next, 1)?.status).toBe("cancelled");
  });

  it("records an error message on the transfer", () => {
    const started = applyTransferEvent([], startSent);
    const next = applyTransferEvent(started, { type: "error", id: 1, error: "hash mismatch" });
    const transfer = findTransfer(next, 1);
    expect(transfer?.status).toBe("error");
    expect(transfer?.error).toBe("hash mismatch");
  });

  it("leaves the transfer list untouched for an unknown id", () => {
    const started = applyTransferEvent([], startSent);
    const next = applyTransferEvent(started, { type: "complete", id: 999 });
    expect(next).toBe(started);
  });

  it("does not regress a terminal transfer on a late progress event", () => {
    const started = applyTransferEvent([], startSent);
    const done = applyTransferEvent(started, { type: "complete", id: 1 });
    const next = applyTransferEvent(done, { type: "progress", id: 1, bytesTransferred: 10 });
    expect(findTransfer(next, 1)?.status).toBe("complete");
  });

  it("returns the same reference when nothing changes", () => {
    const started = applyTransferEvent([], startSent);
    const next = applyTransferEvent(started, {
      type: "start",
      id: 2,
      name: "x",
      mimeType: "text/plain",
      size: 1,
      direction: "sent",
    });
    expect(next).toHaveLength(2);
    // The first entry is unchanged by reference.
    expect(next[0]).toBe(started[0]);
  });
});
