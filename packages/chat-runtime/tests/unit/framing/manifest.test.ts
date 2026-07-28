import { describe, expect, it } from "vitest";

import {
  MAX_CONCURRENT_TRANSFERS,
  MAX_INCOMPLETE_TRANSFER_BYTES,
  MAX_MANIFEST_MIME_BYTES,
  MAX_MANIFEST_NAME_BYTES,
} from "@fuck-eu-chat-control/chat-runtime/protocol/limits";
import { FrameType } from "@fuck-eu-chat-control/chat-runtime/protocol/types";

import {
  decodeManifest,
  encodeManifest,
  FrameReceiver,
  FramingError,
  FramingErrorCode,
  sha256,
} from "@fuck-eu-chat-control/chat-runtime/framing";
import type { FileManifest, FrameReceiverHandlers } from "@fuck-eu-chat-control/chat-runtime/framing";
import { forgeFrame, makePair, utf8 } from "./_helpers";

function countingHandlers(): { count: number; handlers: FrameReceiverHandlers } {
  let count = 0;
  return {
    get count() {
      return count;
    },
    handlers: {
      onText: () => {
        throw new Error("unexpected text");
      },
      onControl: () => {
        throw new Error("unexpected control");
      },
      onFileComplete: () => {
        count += 1;
      },
    },
  };
}

async function manifestFor(
  transferId: number,
  size: number,
  name = "file.bin",
  mimeType = "application/octet-stream",
): Promise<FileManifest> {
  const chunkCount = size === 0 ? 0 : Math.ceil(size / 16384);
  const contentHash = await sha256(new Uint8Array(size));
  return { transferId, name, mimeType, size, chunkCount, contentHash };
}

function patchSizeInManifestBody(
  body: Uint8Array,
  name: string,
  mimeType: string,
  newSize: number,
): Uint8Array {
  const nameBytes = utf8(name);
  const mimeBytes = utf8(mimeType);
  const sizeOffset = 4 + 1 + nameBytes.length + 1 + mimeBytes.length;
  const patched = new Uint8Array(body);
  patched[sizeOffset] = (newSize >>> 24) & 0xff;
  patched[sizeOffset + 1] = (newSize >>> 16) & 0xff;
  patched[sizeOffset + 2] = (newSize >>> 8) & 0xff;
  patched[sizeOffset + 3] = newSize & 0xff;
  return patched;
}

describe("slice 3: authenticated manifest before allocation (encoding)", () => {
  it("round-trips a manifest through encode/decode", async () => {
    const manifest = await manifestFor(7, 100, "photo.jpg", "image/jpeg");
    const decoded = decodeManifest(encodeManifest(manifest), 7);
    expect(decoded.transferId).toBe(7);
    expect(decoded.name).toBe("photo.jpg");
    expect(decoded.mimeType).toBe("image/jpeg");
    expect(decoded.size).toBe(100);
    expect(decoded.chunkCount).toBe(1);
  });

  it("rejects a manifest whose body transferId disagrees with the frame transferId", async () => {
    const manifest = await manifestFor(7, 100);
    expect(() => decodeManifest(encodeManifest(manifest), 999)).toThrow(FramingError);
  });

  it("rejects an empty name", async () => {
    const manifest = await manifestFor(1, 10, "");
    expect(() => encodeManifest(manifest)).toThrow(FramingError);
  });

  it("rejects an oversize name", async () => {
    const manifest = await manifestFor(1, 10, "x".repeat(MAX_MANIFEST_NAME_BYTES + 1));
    expect(() => encodeManifest(manifest)).toThrow(FramingError);
  });

  it("rejects an oversize mimeType", async () => {
    const manifest = await manifestFor(1, 10, "f", "a".repeat(MAX_MANIFEST_MIME_BYTES + 1));
    expect(() => encodeManifest(manifest)).toThrow(FramingError);
  });

  it("rejects a size exceeding MAX_INCOMPLETE_TRANSFER_BYTES", async () => {
    const manifest = await manifestFor(1, MAX_INCOMPLETE_TRANSFER_BYTES + 1);
    expect(() => encodeManifest(manifest)).toThrow(FramingError);
  });

  it("rejects an inconsistent chunkCount", async () => {
    const manifest = { ...(await manifestFor(1, 100)), chunkCount: 5 };
    expect(() => encodeManifest(manifest)).toThrow(FramingError);
  });

  it("rejects a truncated manifest body", async () => {
    const manifest = await manifestFor(1, 100);
    expect(() => decodeManifest(encodeManifest(manifest).subarray(0, 10), 1)).toThrow(FramingError);
  });

  it("rejects a manifest body with trailing bytes", async () => {
    const manifest = await manifestFor(1, 100);
    const plaintext = encodeManifest(manifest);
    const padded = new Uint8Array(plaintext.length + 3);
    padded.set(plaintext, 0);
    expect(() => decodeManifest(padded, 1)).toThrow(FramingError);
  });
});

describe("slice 3: authenticated manifest before allocation (receiver)", () => {
  it("accepts a valid manifest and allocates no chunk buffer yet", async () => {
    const rec = countingHandlers();
    const { sender, transport, recvKeys, peerSessionId } = await makePair(rec.handlers);
    await sender.sendFile(new Uint8Array(100), "file.bin", "application/octet-stream");
    const standalone = new FrameReceiver({
      sessionKeys: recvKeys,
      peerSessionId,
      ...rec.handlers,
    });
    await standalone.ingest(transport.sent[0]);
    expect(standalone.activeTransferCount).toBe(1);
    expect(standalone.bufferedBytes).toBe(0);
  });

  it("rejects a manifest declaring a size over MAX_INCOMPLETE_TRANSFER_BYTES", async () => {
    const rec = countingHandlers();
    const { receiver, recvKeys, peerSessionId } = await makePair(rec.handlers);
    const manifest = await manifestFor(1, 100, "file.bin", "application/octet-stream");
    const body = patchSizeInManifestBody(
      encodeManifest(manifest),
      "file.bin",
      "application/octet-stream",
      MAX_INCOMPLETE_TRANSFER_BYTES + 1,
    );
    const frame = await forgeFrame(
      recvKeys.recvKey,
      peerSessionId,
      0,
      FrameType.FileManifest,
      1,
      0,
      body,
    );
    await expect(receiver.ingest(frame)).rejects.toMatchObject({
      code: FramingErrorCode.SizeExceeded,
    });
    expect(receiver.activeTransferCount).toBe(0);
  });

  it("rejects a new manifest when MAX_CONCURRENT_TRANSFERS is reached", async () => {
    const rec = countingHandlers();
    const { receiver, recvKeys, peerSessionId } = await makePair(rec.handlers);
    for (let i = 0; i < MAX_CONCURRENT_TRANSFERS; i++) {
      const manifest = await manifestFor(i + 1, 10);
      const frame = await forgeFrame(
        recvKeys.recvKey,
        peerSessionId,
        i,
        FrameType.FileManifest,
        i + 1,
        0,
        encodeManifest(manifest),
      );
      await receiver.ingest(frame);
    }
    expect(receiver.activeTransferCount).toBe(MAX_CONCURRENT_TRANSFERS);
    const extra = await manifestFor(99, 10);
    const extraFrame = await forgeFrame(
      recvKeys.recvKey,
      peerSessionId,
      MAX_CONCURRENT_TRANSFERS,
      FrameType.FileManifest,
      99,
      0,
      encodeManifest(extra),
    );
    await expect(receiver.ingest(extraFrame)).rejects.toMatchObject({
      code: FramingErrorCode.ConcurrentTransfersExceeded,
    });
    expect(receiver.activeTransferCount).toBe(MAX_CONCURRENT_TRANSFERS);
  });

  it("rejects a manifest whose ciphertext was tampered (not authenticated)", async () => {
    const rec = countingHandlers();
    const { sender, transport, recvKeys, peerSessionId } = await makePair(rec.handlers);
    await sender.sendFile(new Uint8Array(100), "file.bin", "application/octet-stream");
    const standalone = new FrameReceiver({
      sessionKeys: recvKeys,
      peerSessionId,
      ...rec.handlers,
    });
    const tampered = new Uint8Array(transport.sent[0]);
    tampered[tampered.length - 1] ^= 0xff;
    await expect(standalone.ingest(tampered)).rejects.toBeInstanceOf(FramingError);
    expect(standalone.activeTransferCount).toBe(0);
  });
});
