import { describe, expect, it } from "vitest";

import { MAX_CHUNK_BYTES } from "@/features/chat/protocol/limits";
import { FrameType } from "@/features/chat/protocol/types";

import {
  encodeManifest,
  FramingErrorCode,
  MAX_CHUNK_PLAINTEXT_BYTES,
  sha256,
} from "@/features/chat/framing";
import type { FileManifest, FrameReceiverHandlers, ReceivedFile } from "@/features/chat/framing";
import { bytesEqual, forgeFrame, makePair, utf8 } from "./_helpers";

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

function deterministicData(size: number): Uint8Array {
  const data = new Uint8Array(size);
  for (let i = 0; i < size; i++) data[i] = (i * 7 + 3) & 0xff;
  return data;
}

async function buildManifest(transferId: number, size: number): Promise<FileManifest> {
  const chunkCount = size === 0 ? 0 : Math.ceil(size / MAX_CHUNK_PLAINTEXT_BYTES);
  return {
    transferId,
    name: "payload.bin",
    mimeType: "application/octet-stream",
    size,
    chunkCount,
    contentHash: await sha256(deterministicData(size)),
  };
}

describe("slice 4: bounded chunking and reassembly (end-to-end)", () => {
  it("reassembles a single-chunk file", async () => {
    const rec = collectHandlers();
    const { sender, transport } = await makePair(rec.handlers);
    const data = deterministicData(100);
    await sender.sendFile(data, "payload.bin", "application/octet-stream");
    await transport.ingestSettled;
    expect(rec.files).toHaveLength(1);
    expect(bytesEqual(rec.files[0].data, data)).toBe(true);
    expect(rec.files[0].manifest.size).toBe(100);
  });

  it("reassembles a multi-chunk file (size > MAX_CHUNK_PLAINTEXT_BYTES)", async () => {
    const rec = collectHandlers();
    const { sender, transport } = await makePair(rec.handlers);
    const data = deterministicData(MAX_CHUNK_PLAINTEXT_BYTES * 2 + 500);
    await sender.sendFile(data, "big.bin", "application/octet-stream");
    await transport.ingestSettled;
    expect(rec.files).toHaveLength(1);
    expect(rec.files[0].data.length).toBe(data.length);
    expect(bytesEqual(rec.files[0].data, data)).toBe(true);
    expect(rec.files[0].manifest.chunkCount).toBe(3);
    expect(sender.activeTransferCount).toBe(0);
  });

  it("keeps each chunk ciphertext within MAX_CHUNK_BYTES (tag inclusive)", async () => {
    const rec = collectHandlers();
    const { sender, transport } = await makePair(rec.handlers);
    const data = deterministicData(MAX_CHUNK_PLAINTEXT_BYTES * 3);
    await sender.sendFile(data, "big.bin", "application/octet-stream");
    await transport.ingestSettled;
    const chunkCiphertextLens = transport.sent.slice(1).map((wire) => wire.length - 50 - 12);
    for (const len of chunkCiphertextLens) {
      expect(len).toBeLessThanOrEqual(MAX_CHUNK_BYTES);
    }
    expect(rec.files[0].data.length).toBe(data.length);
  });

  it("reassembles an empty file (size 0, chunkCount 0)", async () => {
    const rec = collectHandlers();
    const { sender, transport } = await makePair(rec.handlers);
    await sender.sendFile(new Uint8Array(0), "empty.bin", "application/octet-stream");
    await transport.ingestSettled;
    expect(rec.files).toHaveLength(1);
    expect(rec.files[0].data.length).toBe(0);
    expect(rec.files[0].manifest.chunkCount).toBe(0);
  });
});

describe("slice 4: chunk rejection rules", () => {
  async function receiverWithTransfer(transferId: number, size: number) {
    const rec = collectHandlers();
    const pair = await makePair(rec.handlers);
    const manifest = await buildManifest(transferId, size);
    const seq = { n: 0 };
    const manifestFrame = await forgeFrame(
      pair.recvKeys.recvKey,
      pair.peerSessionId,
      seq.n++,
      FrameType.FileManifest,
      transferId,
      0,
      encodeManifest(manifest),
    );
    await pair.receiver.ingest(manifestFrame);
    expect(pair.receiver.activeTransferCount).toBe(1);
    return { pair, manifest, seq };
  }

  it("rejects a chunk for an unknown transfer", async () => {
    const rec = collectHandlers();
    const { receiver, recvKeys, peerSessionId } = await makePair(rec.handlers);
    const chunk = await forgeFrame(
      recvKeys.recvKey,
      peerSessionId,
      0,
      FrameType.FileChunk,
      42,
      0,
      utf8("data"),
    );
    await expect(receiver.ingest(chunk)).rejects.toMatchObject({
      code: FramingErrorCode.UnknownTransfer,
    });
  });

  it("rejects a chunk for a cancelled transfer", async () => {
    const { pair, seq } = await receiverWithTransfer(1, MAX_CHUNK_PLAINTEXT_BYTES * 2);
    pair.receiver.cancelTransfer(1);
    expect(pair.receiver.activeTransferCount).toBe(0);
    const chunk = await forgeFrame(
      pair.recvKeys.recvKey,
      pair.peerSessionId,
      seq.n++,
      FrameType.FileChunk,
      1,
      0,
      deterministicData(10),
    );
    await expect(pair.receiver.ingest(chunk)).rejects.toMatchObject({
      code: FramingErrorCode.UnknownTransfer,
    });
  });

  it("rejects a duplicate chunk id (distinct sequence numbers)", async () => {
    const { pair, seq } = await receiverWithTransfer(1, MAX_CHUNK_PLAINTEXT_BYTES * 2);
    const chunkA = await forgeFrame(
      pair.recvKeys.recvKey,
      pair.peerSessionId,
      seq.n++,
      FrameType.FileChunk,
      1,
      0,
      deterministicData(10),
    );
    await pair.receiver.ingest(chunkA);
    const chunkB = await forgeFrame(
      pair.recvKeys.recvKey,
      pair.peerSessionId,
      seq.n++,
      FrameType.FileChunk,
      1,
      0,
      deterministicData(10),
    );
    await expect(pair.receiver.ingest(chunkB)).rejects.toMatchObject({
      code: FramingErrorCode.DuplicateChunk,
    });
  });

  it("rejects a chunk whose id is out of range", async () => {
    const { pair, seq } = await receiverWithTransfer(1, 100);
    const chunk = await forgeFrame(
      pair.recvKeys.recvKey,
      pair.peerSessionId,
      seq.n++,
      FrameType.FileChunk,
      1,
      99,
      deterministicData(10),
    );
    await expect(pair.receiver.ingest(chunk)).rejects.toMatchObject({
      code: FramingErrorCode.ChunkOutOfRange,
    });
  });

  it("rejects a chunk that would exceed the declared size", async () => {
    const { pair, seq } = await receiverWithTransfer(1, 100);
    const chunk = await forgeFrame(
      pair.recvKeys.recvKey,
      pair.peerSessionId,
      seq.n++,
      FrameType.FileChunk,
      1,
      0,
      deterministicData(101),
    );
    await expect(pair.receiver.ingest(chunk)).rejects.toMatchObject({
      code: FramingErrorCode.SizeExceeded,
    });
  });

  it("drops the transfer after complete reassembly; a stray chunk is unknown", async () => {
    const rec = collectHandlers();
    const { sender, transport, receiver, recvKeys, peerSessionId } = await makePair(rec.handlers);
    await sender.sendFile(deterministicData(100), "payload.bin", "application/octet-stream");
    await transport.ingestSettled;
    expect(rec.files).toHaveLength(1);
    expect(receiver.activeTransferCount).toBe(0);
    const stray = await forgeFrame(
      recvKeys.recvKey,
      peerSessionId,
      999,
      FrameType.FileChunk,
      1,
      0,
      deterministicData(10),
    );
    await expect(receiver.ingest(stray)).rejects.toMatchObject({
      code: FramingErrorCode.UnknownTransfer,
    });
  });
});
