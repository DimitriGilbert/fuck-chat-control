import { describe, expect, it, vi } from "vitest";

import { encodeTransferCancelPayload } from "@fuck-eu-chat-control/chat-runtime/protocol/codec";
import { ControlSubtype, FrameType } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import {
  encodeManifest,
  FramingErrorCode,
  MAX_CHUNK_PLAINTEXT_BYTES,
  sha256,
} from "@fuck-eu-chat-control/chat-runtime/framing";
import type {
  FileManifest,
  FrameReceiver,
  FrameReceiverHandlers,
  ReceivedFile,
} from "@fuck-eu-chat-control/chat-runtime/framing";
import { FrameReceiver as FrameReceiverCtor } from "@fuck-eu-chat-control/chat-runtime/framing";

import { deterministicData, forgeFrame, makePair } from "./_helpers";

// R2 (Phase 2): regression coverage for the unserialized async re-entrancy in
// `FrameReceiver.ingest`. The orchestrator fires `ingest` re-entrantly from a
// per-message transport callback with no serialization, and the body `await`s
// WebCrypto (decrypt, sha256). Before the fix, two `ingest` calls interleave at
// every await and corrupt the transfer map / byte counter:
//   - R2:F1 (CRITICAL): double-decrement of `totalBufferedBytes` when a
//     TransferCancel runs in a second ingest while completeTransfer is
//     suspended at `await sha256`, then the resumed call's dropTransfer
//     subtracts again -> counter goes permanently negative.
//   - R2:F2 (HIGH): post-teardown onFileComplete + pinned ~64 MiB reassembly
//     buffers across the await.
//   - R2:F5 (MEDIUM): duplicate empty-file delivery.
// These tests construct frames with `forgeFrame` and drive `ingest` directly so
// they do not depend on the orchestrator or a real transport.

async function manifestFor(
  transferId: number,
  size: number,
  contentHash: Uint8Array,
): Promise<FileManifest> {
  return {
    transferId,
    name: "payload.bin",
    mimeType: "application/octet-stream",
    size,
    chunkCount: size === 0 ? 0 : Math.ceil(size / MAX_CHUNK_PLAINTEXT_BYTES),
    contentHash,
  };
}

function collectHandlers(): {
  files: ReceivedFile[];
  handlers: FrameReceiverHandlers;
} {
  const files: ReceivedFile[] = [];
  return {
    files,
    handlers: {
      onText: () => {
        throw new Error("unexpected text");
      },
      onControl: () => {
        throw new Error("unexpected control");
      },
      onFileComplete: (file) => {
        files.push(file);
      },
    },
  };
}

function transferCancelControlBody(transferId: number): Uint8Array {
  // A control frame body is [subtype byte, ...payload]; TransferCancel's
  // payload is the 4-byte big-endian transferId (see protocol/codec).
  const payload = encodeTransferCancelPayload(transferId);
  const body = new Uint8Array(1 + payload.length);
  body[0] = ControlSubtype.TransferCancel;
  body.set(payload, 1);
  return body;
}

describe("R2: serialized ingest (re-entrancy guard)", () => {
  it("serializes a final-chunk ingest against a TransferCancel ingest: single decrement, single onFileComplete", async () => {
    // R2:F1 regression. Without serialization the TransferCancel ingest would
    // run while completeTransfer is suspended at `await sha256`, drop the
    // transfer (decrement #1), then the resumed completeTransfer would
    // dropTransfer again (decrement #2) -> totalBufferedBytes goes negative
    // and onFileComplete fires for an already-cancelled transfer.
    const rec = collectHandlers();
    const { receiver, recvKeys, peerSessionId } = await makePair(rec.handlers);

    const size = MAX_CHUNK_PLAINTEXT_BYTES; // single-chunk transfer
    const data = deterministicData(size, 7);
    const manifest = await manifestFor(1, size, await sha256(data));
    const seq = { n: 0 };

    await receiver.ingest(
      await forgeFrame(
        recvKeys.recvKey,
        peerSessionId,
        seq.n++,
        FrameType.FileManifest,
        1,
        0,
        encodeManifest(manifest),
      ),
    );

    // Forge the final (only) chunk and the TransferCancel control frame, then
    // fire both WITHOUT awaiting the chunk. Serialization must queue the
    // cancel behind the chunk so they cannot interleave at the sha256 await.
    const finalChunkFrame = await forgeFrame(
      recvKeys.recvKey,
      peerSessionId,
      seq.n++,
      FrameType.FileChunk,
      1,
      0,
      data,
    );
    const cancelFrame = await forgeFrame(
      recvKeys.recvKey,
      peerSessionId,
      seq.n++,
      FrameType.Control,
      0,
      0,
      transferCancelControlBody(1),
    );

    const chunkPromise = receiver.ingest(finalChunkFrame);
    const cancelPromise = receiver.ingest(cancelFrame);

    // Drain the chain. Both promises settle; neither is expected to reject
    // (the cancel is a no-op against a transfer that already completed).
    await Promise.allSettled([chunkPromise, cancelPromise]);
    // Let the transport-attached chain (if any) settle too.
    await Promise.resolve();

    expect(rec.files).toHaveLength(1);
    // Counter never went negative: after completion it is back to zero.
    expect(receiver.bufferedBytes).toBe(0);
    expect(receiver.bufferedBytes).toBeGreaterThanOrEqual(0);
    expect(receiver.activeTransferCount).toBe(0);

    receiver.teardown();
  });

  it("does not invoke onFileComplete for a transfer torn down while completeTransfer is suspended at sha256", async () => {
    // R2:F2 regression. We need completeTransfer to be suspended exactly at the
    // `await sha256(reassembled)` line when teardown runs. To do that
    // deterministically we replace `crypto.subtle.digest` with a deferred that
    // only resolves when the test releases it; then we call teardown() while the
    // digest is pending and only afterwards release it. The manifest's
    // contentHash and all wire frames are built with the REAL digest/crypto
    // BEFORE the spy is installed, so the spy's only observed call is the
    // completeTransfer one.
    const rec = collectHandlers();
    const { receiver, recvKeys, peerSessionId } = await makePair(rec.handlers);

    const size = MAX_CHUNK_PLAINTEXT_BYTES; // single-chunk transfer
    const data = deterministicData(size, 19);
    const manifest = await manifestFor(1, size, await sha256(data));
    const seq = { n: 0 };

    const manifestFrame = await forgeFrame(
      recvKeys.recvKey,
      peerSessionId,
      seq.n++,
      FrameType.FileManifest,
      1,
      0,
      encodeManifest(manifest),
    );
    const finalChunkFrame = await forgeFrame(
      recvKeys.recvKey,
      peerSessionId,
      seq.n++,
      FrameType.FileChunk,
      1,
      0,
      data,
    );
    await receiver.ingest(manifestFrame);

    // Now install the gated digest. Every subsequent `sha256(...)` (only the
    // completeTransfer one, in this single-chunk flow) suspends until released.
    const subtle = globalThis.crypto.subtle;
    const realDigest = subtle.digest.bind(subtle) as (
      ...args: Parameters<typeof subtle.digest>
    ) => Promise<ArrayBuffer>;
    // Holder object so TS control-flow analysis does not narrow the release
    // callback to `never` across the awaited waitFor boundary.
    const gate: { release: (() => void) | null; started: boolean } = {
      release: null,
      started: false,
    };
    const digestSpy = vi.spyOn(subtle, "digest").mockImplementation((...args) => {
      gate.started = true;
      return new Promise<ArrayBuffer>((resolve) => {
        gate.release = () => {
          void realDigest(...args).then((real) => resolve(real as ArrayBuffer));
        };
      }) as Promise<ArrayBuffer>;
    });

    try {
      // Kick off the final chunk; do NOT await. The serialized body runs to
      // completeTransfer and suspends at `await sha256(reassembled)` because
      // our spy holds the promise.
      const chunkPromise = receiver.ingest(finalChunkFrame);
      // Yield until the digest spy has actually been entered (the body has
      // reached the suspended await).
      await vi.waitFor(() => {
        expect(gate.started).toBe(true);
      });

      // Teardown races the suspended sha256. The latch must close every
      // downstream effect: the re-check in completeTransfer and the
      // post-await re-check in _ingestSerialized must both suppress delivery.
      receiver.teardown();
      expect(receiver.activeTransferCount).toBe(0);
      expect(receiver.bufferedBytes).toBe(0);

      // Release the gated digest; the suspended completeTransfer resumes and
      // must NOT call onFileComplete because tornDown is true (and the transfer
      // is no longer in the map).
      const release = gate.release;
      if (release !== null) release();
      await Promise.allSettled([chunkPromise]);

      expect(rec.files).toHaveLength(0);
      // The receiver stays quiescent: no transfers, no buffered bytes, no
      // further callbacks after a microtask flush.
      await Promise.resolve();
      expect(rec.files).toHaveLength(0);
      expect(receiver.activeTransferCount).toBe(0);
      expect(receiver.bufferedBytes).toBe(0);
    } finally {
      digestSpy.mockRestore();
    }
  });

  it("teardown short-circuits a queued (not-yet-started) ingest so onFileComplete never fires", async () => {
    // Companion to the suspended-sha256 case: when teardown lands BEFORE the
    // queued body even starts, the top-of-_ingestSerialized tornDown check must
    // drop the frame without surfacing the file. This is the cheaper, more
    // common path in production (teardown wins the race before any await).
    const rec = collectHandlers();
    const { receiver, recvKeys, peerSessionId } = await makePair(rec.handlers);

    const size = MAX_CHUNK_PLAINTEXT_BYTES;
    const data = deterministicData(size, 23);
    const manifest = await manifestFor(2, size, await sha256(data));
    const seq = { n: 0 };
    await receiver.ingest(
      await forgeFrame(
        recvKeys.recvKey,
        peerSessionId,
        seq.n++,
        FrameType.FileManifest,
        2,
        0,
        encodeManifest(manifest),
      ),
    );

    const finalChunkFrame = await forgeFrame(
      recvKeys.recvKey,
      peerSessionId,
      seq.n++,
      FrameType.FileChunk,
      2,
      0,
      data,
    );

    // Queue the final chunk and teardown synchronously before the body runs.
    const chunkPromise = receiver.ingest(finalChunkFrame);
    receiver.teardown();
    await Promise.allSettled([chunkPromise]);

    expect(rec.files).toHaveLength(0);
    expect(receiver.activeTransferCount).toBe(0);
    expect(receiver.bufferedBytes).toBe(0);
  });

  it("a duplicate manifest for an active transfer is rejected at the transfers.set re-check (R2:F5 defense-in-depth)", async () => {
    // R2:F5 regression (defense-in-depth). The original bug: a zero-chunk
    // manifest awaits completeTransfer, which deletes the map entry mid-await;
    // a duplicate manifest landing in that window then PASSES the
    // `transfers.has` guard and re-delivers. The fix adds a second
    // `transfers.has` re-check immediately before `transfers.set` (and
    // serialization closes the window outright). This test exercises the guard
    // directly: register a multi-chunk transfer (so the manifest does NOT
    // immediately complete and the entry stays present), then fire a duplicate
    // manifest for the same id and assert it rejects with TransferInactive and
    // never delivers.
    const rec = collectHandlers();
    const { recvKeys, peerSessionId } = await makePair(rec.handlers);
    const receiver: FrameReceiver = new FrameReceiverCtor({
      sessionKeys: recvKeys,
      peerSessionId,
      ...rec.handlers,
    });

    const size = MAX_CHUNK_PLAINTEXT_BYTES * 2; // multi-chunk: manifest only registers
    const manifest = await manifestFor(5, size, await sha256(deterministicData(size, 5)));
    const seq = { n: 0 };
    const manifestFrame = (n: number) =>
      forgeFrame(
        recvKeys.recvKey,
        peerSessionId,
        n,
        FrameType.FileManifest,
        5,
        0,
        encodeManifest(manifest),
      );

    // First manifest registers the active transfer; second must hit the
    // re-check and reject. Fire both without awaiting to mimic the re-entrant
    // dispatch shape from the orchestrator.
    const first = receiver.ingest(await manifestFrame(seq.n++));
    const second = receiver.ingest(await manifestFrame(seq.n++));
    const results = await Promise.allSettled([first, second]);

    expect(results[0].status).toBe("fulfilled");
    expect(results[1].status).toBe("rejected");
    expect((results[1] as PromiseRejectedResult).reason).toMatchObject({
      code: FramingErrorCode.TransferInactive,
    });
    // Exactly one active transfer (from the first manifest); no delivery.
    expect(receiver.activeTransferCount).toBe(1);
    expect(receiver.bufferedBytes).toBe(0);
    expect(rec.files).toHaveLength(0);

    receiver.teardown();
  });

  it("a duplicate zero-chunk manifest redelivers only because the first completed and dropped (serialization ordering, not interleaving)", async () => {
    // Companion assertion documenting the residual behavior the serialization
    // fix does NOT change: once a zero-chunk transfer completes and drops its
    // entry, a second manifest with the same id is indistinguishable from a
    // legitimate reuse (no tombstone is kept). The fix closes the INTERLEAVING
    // window (R2:F5's root cause); this test pins the post-fix behavior so a
    // future tombstone change is a deliberate, visible delta. Two deliveries
    // are expected here ONLY because the second manifest arrives strictly
    // AFTER the first fully completes.
    const rec = collectHandlers();
    const { receiver, recvKeys, peerSessionId } = await makePair(rec.handlers);

    const emptyHash = await sha256(new Uint8Array(0));
    const manifest = await manifestFor(7, 0, emptyHash);
    const seq = { n: 0 };
    const manifestFrame = (n: number) =>
      forgeFrame(
        recvKeys.recvKey,
        peerSessionId,
        n,
        FrameType.FileManifest,
        7,
        0,
        encodeManifest(manifest),
      );

    await receiver.ingest(await manifestFrame(seq.n++));
    // The first transfer has completed and dropped its entry. A second manifest
    // for the same id now re-registers and re-delivers.
    await receiver.ingest(await manifestFrame(seq.n++));

    expect(rec.files).toHaveLength(2);
    expect(receiver.activeTransferCount).toBe(0);
    expect(receiver.bufferedBytes).toBe(0);

    receiver.teardown();
  });
});
