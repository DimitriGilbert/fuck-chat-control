import { describe, expect, it } from "vitest";

import { MAX_BUFFERED_DATA_BYTES } from "@fuck-eu-chat-control/chat-runtime/protocol/limits";
import { FrameType } from "@fuck-eu-chat-control/chat-runtime/protocol/types";

import {
  encodeManifest,
  FramingErrorCode,
  MAX_CHUNK_PLAINTEXT_BYTES,
  sha256,
} from "@fuck-eu-chat-control/chat-runtime/framing";
import type {
  FileManifest,
  FrameReceiverHandlers,
  ReceivedFile,
} from "@fuck-eu-chat-control/chat-runtime/framing";
import { bytesEqual, deterministicData, forgeFrame, makePair } from "./_helpers";

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
    await sender.sendFile(
      sender.beginFileTransfer(),
      data,
      "payload.bin",
      "application/octet-stream",
    );
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
    // R2/F4 (Phase 7): the transfer id is reserved SYNCHRONOUSLY via
    // beginFileTransfer (counted in activeTransfers from this instant, before
    // any hashing), so the test cancels the exact reserved id instead of
    // hardcoding FIRST_TRANSFER_ID.
    const transferId = sender.beginFileTransfer();
    const filePromise = sender.sendFile(
      transferId,
      data,
      "payload.bin",
      "application/octet-stream",
    );
    expect(sender.activeTransferCount).toBe(1);
    sender.cancelTransfer(transferId);
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
    const transferId = sender.beginFileTransfer();
    const filePromise = sender.sendFile(
      transferId,
      data,
      "payload.bin",
      "application/octet-stream",
    );
    expect(sender.activeTransferCount).toBe(1);
    sender.teardown();
    await expect(filePromise).rejects.toMatchObject({
      code: FramingErrorCode.TearingDown,
    });
    expect(sender.activeTransferCount).toBe(0);
  });

  it("R2/F8: a cancel issued during the hashing window rejects the send (registration is synchronous)", async () => {
    const rec = collectHandlers();
    const { sender, transport } = await makePair(rec.handlers);
    // No backpressure: the transfer parks only inside sendFile's own
    // `await sha256(data)` over a 32 MiB buffer, which is slow enough that the
    // cancel below lands inside the hashing window — deterministically before
    // the manifest frame is ever sent.
    const data = deterministicData(32 * 1024 * 1024, 9);
    const transferId = sender.beginFileTransfer();
    // The reservation must be observable BEFORE sendFile begins hashing —
    // pre-fix the id joined activeTransfers only after the hash, so this
    // cancel was silently lost and the send ran to completion.
    expect(sender.activeTransferCount).toBe(1);
    const filePromise = sender.sendFile(
      transferId,
      data,
      "payload.bin",
      "application/octet-stream",
    );
    sender.cancelTransfer(transferId);
    await expect(filePromise).rejects.toMatchObject({
      code: FramingErrorCode.TransferCancelled,
    });
    expect(sender.activeTransferCount).toBe(0);
    expect(rec.files).toHaveLength(0);
    await transport.ingestSettled;
    // No manifest frame was ever sent — the cancel landed before hashing
    // completed, so the receiver never saw the transfer.
    expect(transport.sent).toHaveLength(0);
  });
});
