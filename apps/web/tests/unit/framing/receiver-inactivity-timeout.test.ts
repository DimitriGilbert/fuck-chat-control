import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FrameType } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import {
  encodeManifest,
  FramingErrorCode,
  MAX_CHUNK_PLAINTEXT_BYTES,
  type FileManifest,
  type FrameReceiver,
  type FrameReceiverHandlers,
  sha256,
} from "@fuck-eu-chat-control/chat-runtime/framing";
import { FrameReceiver as FrameReceiverCtor } from "@fuck-eu-chat-control/chat-runtime/framing";
import { deterministicData, forgeFrame, makePair } from "./_helpers";

// CR-5: per-transfer inactivity timeout. A silent peer must not hold buffer +
// transfer slots for the channel lifetime. The sweep evicts transfers whose
// `Date.now() - lastActivity` exceeds the configured timeout, refreshes the
// clock on every stored chunk, and is cleared by teardown.

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

function noopHandlers(): FrameReceiverHandlers {
  return {
    onText: () => {
      throw new Error("unexpected text");
    },
    onControl: () => {
      throw new Error("unexpected control");
    },
    onFileComplete: () => {
      throw new Error("unexpected onFileComplete");
    },
  };
}

describe("CR-5: FrameReceiver per-transfer inactivity timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("(a) advancing 90s with no chunk does NOT evict", async () => {
    const timedOut: number[] = [];
    const { recvKeys, peerSessionId } = await makePair(noopHandlers());
    const receiver: FrameReceiver = new FrameReceiverCtor({
      sessionKeys: recvKeys,
      peerSessionId,
      ...noopHandlers(),
      onTransferTimeout: (transferId: number) => {
        timedOut.push(transferId);
      },
    });

    const size = MAX_CHUNK_PLAINTEXT_BYTES * 2;
    const manifest = await manifestFor(1, size, await sha256(deterministicData(size, 5)));
    await receiver.ingest(
      await forgeFrame(
        recvKeys.recvKey,
        peerSessionId,
        0,
        FrameType.FileManifest,
        1,
        0,
        encodeManifest(manifest),
      ),
    );
    expect(receiver.activeTransferCount).toBe(1);
    expect(receiver.bufferedBytes).toBe(0);

    vi.advanceTimersByTime(90_000);
    expect(timedOut).toEqual([]);
    expect(receiver.activeTransferCount).toBe(1);
    expect(receiver.bufferedBytes).toBe(0);
    receiver.teardown();
  });

  it("(b) advancing past 120s with no chunk evicts the transfer", async () => {
    const timedOut: number[] = [];
    const { recvKeys, peerSessionId } = await makePair(noopHandlers());
    const receiver: FrameReceiver = new FrameReceiverCtor({
      sessionKeys: recvKeys,
      peerSessionId,
      ...noopHandlers(),
      onTransferTimeout: (transferId: number) => {
        timedOut.push(transferId);
      },
    });

    const size = MAX_CHUNK_PLAINTEXT_BYTES * 2;
    const manifest = await manifestFor(7, size, await sha256(deterministicData(size, 5)));
    await receiver.ingest(
      await forgeFrame(
        recvKeys.recvKey,
        peerSessionId,
        0,
        FrameType.FileManifest,
        7,
        0,
        encodeManifest(manifest),
      ),
    );
    // Store one chunk so receivedBytes is nonzero; verifies the sweep
    // decrements totalBufferedBytes on eviction.
    await receiver.ingest(
      await forgeFrame(
        recvKeys.recvKey,
        peerSessionId,
        1,
        FrameType.FileChunk,
        7,
        0,
        deterministicData(MAX_CHUNK_PLAINTEXT_BYTES, 5),
      ),
    );
    expect(receiver.activeTransferCount).toBe(1);
    expect(receiver.bufferedBytes).toBe(MAX_CHUNK_PLAINTEXT_BYTES);

    // Default timeout is 120_000ms; default tick is 30_000ms. The sweep
    // compares `now - lastActivity > 120_000` (strict), so eviction first
    // fires on the 150s tick (delta=150_000). Advancing to 150s guarantees a
    // tick lands after the threshold.
    vi.advanceTimersByTime(150_000);
    expect(timedOut).toEqual([7]);
    expect(receiver.activeTransferCount).toBe(0);
    expect(receiver.bufferedBytes).toBe(0);
    receiver.teardown();
  });

  it("(c) a chunk received at 100s resets lastActivity; eviction follows only after the full timeout elapses again", async () => {
    const timedOut: number[] = [];
    const { recvKeys, peerSessionId } = await makePair(noopHandlers());
    const receiver: FrameReceiver = new FrameReceiverCtor({
      sessionKeys: recvKeys,
      peerSessionId,
      ...noopHandlers(),
      onTransferTimeout: (transferId: number) => {
        timedOut.push(transferId);
      },
    });

    const size = MAX_CHUNK_PLAINTEXT_BYTES * 3;
    const manifest = await manifestFor(9, size, await sha256(deterministicData(size, 9)));
    await receiver.ingest(
      await forgeFrame(
        recvKeys.recvKey,
        peerSessionId,
        0,
        FrameType.FileManifest,
        9,
        0,
        encodeManifest(manifest),
      ),
    );
    // Advance 100s (under the 120s deadline) and store a chunk — this must
    // refresh lastActivity so the clock effectively restarts at 100s.
    vi.advanceTimersByTime(100_000);
    await receiver.ingest(
      await forgeFrame(
        recvKeys.recvKey,
        peerSessionId,
        1,
        FrameType.FileChunk,
        9,
        0,
        deterministicData(MAX_CHUNK_PLAINTEXT_BYTES, 9),
      ),
    );
    // Advance another 100s (to wall clock 200s, 100s since the chunk). The
    // 100s gap is under the 120s timeout, so the transfer survives.
    vi.advanceTimersByTime(100_000);
    expect(timedOut).toEqual([]);
    expect(receiver.activeTransferCount).toBe(1);
    // The chunk reset lastActivity to the 100s mark. The sweep evicts only
    // when `now - lastActivity > 120_000` (strict), so the 210s tick (delta
    // 110s) is under and the 240s tick (delta 140s) is over. Advancing 40s
    // more (to 240s) lands the eviction tick.
    vi.advanceTimersByTime(40_000);
    expect(timedOut).toEqual([9]);
    expect(receiver.activeTransferCount).toBe(0);
    receiver.teardown();
  });

  it("(d) teardown clears the sweep interval so no further timeout fires", async () => {
    const timedOut: number[] = [];
    const { recvKeys, peerSessionId } = await makePair(noopHandlers());
    const receiver: FrameReceiver = new FrameReceiverCtor({
      sessionKeys: recvKeys,
      peerSessionId,
      ...noopHandlers(),
      onTransferTimeout: (transferId: number) => {
        timedOut.push(transferId);
      },
    });

    const size = MAX_CHUNK_PLAINTEXT_BYTES * 2;
    const manifest = await manifestFor(11, size, await sha256(deterministicData(size, 5)));
    await receiver.ingest(
      await forgeFrame(
        recvKeys.recvKey,
        peerSessionId,
        0,
        FrameType.FileManifest,
        11,
        0,
        encodeManifest(manifest),
      ),
    );
    expect(receiver.activeTransferCount).toBe(1);

    receiver.teardown();
    // After teardown the interval must be gone; advancing far past the
    // timeout must NOT invoke onTransferTimeout.
    vi.advanceTimersByTime(600_000);
    expect(timedOut).toEqual([]);
    expect(receiver.activeTransferCount).toBe(0);
  });

  it("eviction on a transfer with no chunks still decrements zero buffered bytes (no underflow)", async () => {
    const timedOut: number[] = [];
    const { recvKeys, peerSessionId } = await makePair(noopHandlers());
    const receiver: FrameReceiver = new FrameReceiverCtor({
      sessionKeys: recvKeys,
      peerSessionId,
      ...noopHandlers(),
      onTransferTimeout: (transferId: number) => {
        timedOut.push(transferId);
      },
    });

    const size = MAX_CHUNK_PLAINTEXT_BYTES * 2;
    const manifest = await manifestFor(13, size, await sha256(deterministicData(size, 5)));
    await receiver.ingest(
      await forgeFrame(
        recvKeys.recvKey,
        peerSessionId,
        0,
        FrameType.FileManifest,
        13,
        0,
        encodeManifest(manifest),
      ),
    );
    expect(receiver.bufferedBytes).toBe(0);

    vi.advanceTimersByTime(150_000);
    expect(timedOut).toEqual([13]);
    expect(receiver.bufferedBytes).toBe(0);
    receiver.teardown();
  });

  it("a complete transfer is removed before the deadline and never reported as timed out", async () => {
    const timedOut: number[] = [];
    const files: { manifest: FileManifest; data: Uint8Array }[] = [];
    const { recvKeys, peerSessionId } = await makePair(noopHandlers());
    const receiver: FrameReceiver = new FrameReceiverCtor({
      sessionKeys: recvKeys,
      peerSessionId,
      onText: () => {
        throw new Error("unexpected text");
      },
      onControl: () => {
        throw new Error("unexpected control");
      },
      onFileComplete: (file) => {
        files.push(file);
      },
      onTransferTimeout: (transferId: number) => {
        timedOut.push(transferId);
      },
    });

    const data = deterministicData(MAX_CHUNK_PLAINTEXT_BYTES, 42);
    const manifest = await manifestFor(21, data.length, await sha256(data));
    await receiver.ingest(
      await forgeFrame(
        recvKeys.recvKey,
        peerSessionId,
        0,
        FrameType.FileManifest,
        21,
        0,
        encodeManifest(manifest),
      ),
    );
    await receiver.ingest(
      await forgeFrame(
        recvKeys.recvKey,
        peerSessionId,
        1,
        FrameType.FileChunk,
        21,
        0,
        data,
      ),
    );
    // The transfer completed synchronously inside handleChunk and is no
    // longer in the map, so the sweep has nothing to evict even after the
    // timeout elapses.
    expect(files).toHaveLength(1);
    expect(receiver.activeTransferCount).toBe(0);
    vi.advanceTimersByTime(125_000);
    expect(timedOut).toEqual([]);
    receiver.teardown();
  });

  it("handles re-throw from a throwing onTransferTimeout without leaving the transfer behind", async () => {
    const { recvKeys, peerSessionId } = await makePair(noopHandlers());
    const receiver: FrameReceiver = new FrameReceiverCtor({
      sessionKeys: recvKeys,
      peerSessionId,
      ...noopHandlers(),
      onTransferTimeout: () => {
        throw new Error("spy boom");
      },
    });

    const size = MAX_CHUNK_PLAINTEXT_BYTES * 2;
    const manifest = await manifestFor(31, size, await sha256(deterministicData(size, 5)));
    await receiver.ingest(
      await forgeFrame(
        recvKeys.recvKey,
        peerSessionId,
        0,
        FrameType.FileManifest,
        31,
        0,
        encodeManifest(manifest),
      ),
    );
    // The sweep must still drop the transfer from the map even if the
    // callback throws. The throw escapes setInterval's handler (logged by
    // the host), but the eviction is committed before the callback fires.
    expect(() => vi.advanceTimersByTime(150_000)).toThrow("spy boom");
    expect(receiver.activeTransferCount).toBe(0);
    receiver.teardown();
  });

  it("respects a configured short inactivityTimeoutMs", async () => {
    const timedOut: number[] = [];
    const { recvKeys, peerSessionId } = await makePair(noopHandlers());
    const receiver: FrameReceiver = new FrameReceiverCtor({
      sessionKeys: recvKeys,
      peerSessionId,
      ...noopHandlers(),
      inactivityTimeoutMs: 5_000,
      inactivityTickMs: 1_000,
      onTransferTimeout: (transferId: number) => {
        timedOut.push(transferId);
      },
    });

    const size = MAX_CHUNK_PLAINTEXT_BYTES * 2;
    const manifest = await manifestFor(41, size, await sha256(deterministicData(size, 5)));
    await receiver.ingest(
      await forgeFrame(
        recvKeys.recvKey,
        peerSessionId,
        0,
        FrameType.FileManifest,
        41,
        0,
        encodeManifest(manifest),
      ),
    );
    vi.advanceTimersByTime(6_000);
    expect(timedOut).toEqual([41]);
    expect(receiver.activeTransferCount).toBe(0);
    receiver.teardown();
  });

  it("does not arm the sweep in a way that runs before the timeout elapses (no premature eviction)", async () => {
    const timedOut: number[] = [];
    const { recvKeys, peerSessionId } = await makePair(noopHandlers());
    const receiver: FrameReceiver = new FrameReceiverCtor({
      sessionKeys: recvKeys,
      peerSessionId,
      ...noopHandlers(),
      inactivityTimeoutMs: 120_000,
      inactivityTickMs: 30_000,
      onTransferTimeout: (transferId: number) => {
        timedOut.push(transferId);
      },
    });

    const size = MAX_CHUNK_PLAINTEXT_BYTES * 2;
    const manifest = await manifestFor(51, size, await sha256(deterministicData(size, 5)));
    await receiver.ingest(
      await forgeFrame(
        recvKeys.recvKey,
        peerSessionId,
        0,
        FrameType.FileManifest,
        51,
        0,
        encodeManifest(manifest),
      ),
    );
    // Tick once at 30s — must not evict.
    vi.advanceTimersByTime(30_000);
    expect(timedOut).toEqual([]);
    expect(receiver.activeTransferCount).toBe(1);
    receiver.teardown();
  });

  it("eviction surfaces FramingErrorCode for a subsequent chunk to the evicted transfer", async () => {
    const { recvKeys, peerSessionId } = await makePair(noopHandlers());
    const receiver: FrameReceiver = new FrameReceiverCtor({
      sessionKeys: recvKeys,
      peerSessionId,
      ...noopHandlers(),
      inactivityTimeoutMs: 5_000,
      inactivityTickMs: 1_000,
    });

    const size = MAX_CHUNK_PLAINTEXT_BYTES * 2;
    const manifest = await manifestFor(61, size, await sha256(deterministicData(size, 5)));
    await receiver.ingest(
      await forgeFrame(
        recvKeys.recvKey,
        peerSessionId,
        0,
        FrameType.FileManifest,
        61,
        0,
        encodeManifest(manifest),
      ),
    );
    vi.advanceTimersByTime(6_000);
    expect(receiver.activeTransferCount).toBe(0);
    // A late chunk for the evicted transfer must report UnknownTransfer,
    // confirming the eviction actually removed the map entry.
    await expect(
      receiver.ingest(
        await forgeFrame(
          recvKeys.recvKey,
          peerSessionId,
          1,
          FrameType.FileChunk,
          61,
          0,
          deterministicData(MAX_CHUNK_PLAINTEXT_BYTES, 5),
        ),
      ),
    ).rejects.toMatchObject({ code: FramingErrorCode.UnknownTransfer });
    receiver.teardown();
  });
});
