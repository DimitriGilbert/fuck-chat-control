import { describe, expect, it } from "vitest";

import { MAX_BUFFERED_DATA_BYTES } from "@/features/chat/protocol/limits";
import { FrameType } from "@/features/chat/protocol/types";

import {
  encodeManifest,
  FramingErrorCode,
  MAX_CHUNK_PLAINTEXT_BYTES,
  sha256,
} from "@/features/chat/framing";
import type { FileManifest, FrameReceiverHandlers, ReceivedFile } from "@/features/chat/framing";
import { bytesEqual, deterministicData, forgeFrame, makePair, waitFor } from "./_helpers";

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

async function manifestWithHash(
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

function chunkSlices(size: number): { start: number; end: number }[] {
  const slices: { start: number; end: number }[] = [];
  let start = 0;
  while (start < size) {
    const end = Math.min(start + MAX_CHUNK_PLAINTEXT_BYTES, size);
    slices.push({ start, end });
    start = end;
  }
  return slices;
}

describe("slice 5: hash verification", () => {
  it("completes a transfer whose reassembled hash matches the manifest", async () => {
    const rec = collectHandlers();
    const { sender, transport } = await makePair(rec.handlers);
    const data = deterministicData(250, 11);
    await sender.sendFile(data, "payload.bin", "application/octet-stream");
    await transport.ingestSettled;
    expect(rec.files).toHaveLength(1);
    expect(bytesEqual(rec.files[0].data, data)).toBe(true);
  });

  it("rejects and drops a transfer whose reassembled hash mismatches", async () => {
    const rec = collectHandlers();
    const { receiver, recvKeys, peerSessionId } = await makePair(rec.handlers);
    const size = MAX_CHUNK_PLAINTEXT_BYTES * 2;
    const declaredHash = await sha256(deterministicData(size, 11));
    const manifest = await manifestWithHash(1, size, declaredHash);
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
    const tampered = deterministicData(size, 99);
    const slices = chunkSlices(size);
    for (let i = 0; i < slices.length - 1; i++) {
      await receiver.ingest(
        await forgeFrame(
          recvKeys.recvKey,
          peerSessionId,
          seq.n++,
          FrameType.FileChunk,
          1,
          i,
          tampered.subarray(slices[i].start, slices[i].end),
        ),
      );
    }
    const lastIndex = slices.length - 1;
    await expect(
      receiver.ingest(
        await forgeFrame(
          recvKeys.recvKey,
          peerSessionId,
          seq.n++,
          FrameType.FileChunk,
          1,
          lastIndex,
          tampered.subarray(slices[lastIndex].start, slices[lastIndex].end),
        ),
      ),
    ).rejects.toMatchObject({ code: FramingErrorCode.HashMismatch });
    expect(rec.files).toHaveLength(0);
    expect(receiver.activeTransferCount).toBe(0);
  });
});

describe("slice 5: cancellation releases buffers", () => {
  it("sender cancel releases sender-side transfer state", async () => {
    const rec = collectHandlers();
    const { sender, transport } = await makePair(rec.handlers);
    transport.setBufferedAmount(MAX_BUFFERED_DATA_BYTES);
    const data = deterministicData(MAX_CHUNK_PLAINTEXT_BYTES * 2, 5);
    const filePromise = sender.sendFile(data, "payload.bin", "application/octet-stream");
    await waitFor(() => sender.activeTransferCount === 1);
    // R9/F4 (Phase 8.5): the sender allocates transfer ids starting at
    // FIRST_TRANSFER_ID = 1_000_000 (see framing/sender.ts). The first
    // sendFile call yields id = 1_000_000; cancel that id.
    sender.cancelTransfer(1_000_000);
    await expect(filePromise).rejects.toMatchObject({
      code: FramingErrorCode.TransferCancelled,
    });
    expect(sender.activeTransferCount).toBe(0);
    expect(rec.files).toHaveLength(0);
  });

  it("receiver cancel releases buffered chunk bytes", async () => {
    const rec = collectHandlers();
    const { receiver, recvKeys, peerSessionId } = await makePair(rec.handlers);
    const size = MAX_CHUNK_PLAINTEXT_BYTES * 2;
    const manifest = await manifestWithHash(1, size, await sha256(deterministicData(size, 5)));
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
    await receiver.ingest(
      await forgeFrame(
        recvKeys.recvKey,
        peerSessionId,
        seq.n++,
        FrameType.FileChunk,
        1,
        0,
        deterministicData(MAX_CHUNK_PLAINTEXT_BYTES, 5),
      ),
    );
    expect(receiver.bufferedBytes).toBe(MAX_CHUNK_PLAINTEXT_BYTES);
    expect(receiver.activeTransferCount).toBe(1);
    receiver.cancelTransfer(1);
    expect(receiver.activeTransferCount).toBe(0);
    expect(receiver.bufferedBytes).toBe(0);
    expect(rec.files).toHaveLength(0);
  });
});

describe("slice 5: teardown releases all transfer buffers", () => {
  it("receiver teardown clears every active transfer", async () => {
    const rec = collectHandlers();
    const { receiver, recvKeys, peerSessionId } = await makePair(rec.handlers);
    const seq = { n: 0 };
    for (const transferId of [1, 2]) {
      const size = MAX_CHUNK_PLAINTEXT_BYTES * 2;
      const manifest = await manifestWithHash(
        transferId,
        size,
        await sha256(deterministicData(size, transferId)),
      );
      await receiver.ingest(
        await forgeFrame(
          recvKeys.recvKey,
          peerSessionId,
          seq.n++,
          FrameType.FileManifest,
          transferId,
          0,
          encodeManifest(manifest),
        ),
      );
      await receiver.ingest(
        await forgeFrame(
          recvKeys.recvKey,
          peerSessionId,
          seq.n++,
          FrameType.FileChunk,
          transferId,
          0,
          deterministicData(MAX_CHUNK_PLAINTEXT_BYTES, transferId),
        ),
      );
    }
    expect(receiver.activeTransferCount).toBe(2);
    expect(receiver.bufferedBytes).toBe(MAX_CHUNK_PLAINTEXT_BYTES * 2);
    receiver.teardown();
    expect(receiver.activeTransferCount).toBe(0);
    expect(receiver.bufferedBytes).toBe(0);
    expect(rec.files).toHaveLength(0);
  });

  it("sender teardown rejects an in-flight send and clears state", async () => {
    const rec = collectHandlers();
    const { sender, transport } = await makePair(rec.handlers);
    transport.setBufferedAmount(MAX_BUFFERED_DATA_BYTES);
    const data = deterministicData(MAX_CHUNK_PLAINTEXT_BYTES * 2, 8);
    const filePromise = sender.sendFile(data, "payload.bin", "application/octet-stream");
    await waitFor(() => sender.activeTransferCount === 1);
    sender.teardown();
    await expect(filePromise).rejects.toMatchObject({
      code: FramingErrorCode.TearingDown,
    });
    expect(sender.activeTransferCount).toBe(0);
  });
});
