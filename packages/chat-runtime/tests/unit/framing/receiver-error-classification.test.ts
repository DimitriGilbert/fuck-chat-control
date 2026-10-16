import { describe, expect, it } from "vitest";

import { MAX_INCOMPLETE_TRANSFER_BYTES } from "@fuck-eu-chat-control/chat-runtime/protocol/limits";
import { ControlSubtype, FrameType } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import type { SessionId } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import type { SessionKeys } from "@fuck-eu-chat-control/chat-runtime/crypto";

import {
  computeChunkCount,
  encodeManifest,
  FrameReceiver,
  FramingError,
  FramingErrorCode,
  isPerTransferFramingError,
  MAX_CHUNK_PLAINTEXT_BYTES,
  sha256,
} from "@fuck-eu-chat-control/chat-runtime/framing";
import type {
  FileManifest,
  FrameReceiverConfig,
  FrameReceiverHandlers,
} from "@fuck-eu-chat-control/chat-runtime/framing";
import { deterministicData, forgeFrame, makePair, utf8 } from "./_helpers";

// R3/F1 (per-transfer vs session-fatal error classification), R3/F4 (manifest
// admission reserves declared bytes), R3/F5 (host-callback throw containment).

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

function manifestFor(transferId: number, size: number): FileManifest {
  // No chunks are ever delivered for these manifests, so the content hash is
  // never verified — any 32-byte value satisfies the codec.
  return {
    transferId,
    name: "payload.bin",
    mimeType: "application/octet-stream",
    size,
    chunkCount: computeChunkCount(size),
    contentHash: new Uint8Array(32),
  };
}

async function makeReceiver(
  config: Omit<FrameReceiverConfig, "sessionKeys" | "peerSessionId">,
): Promise<{
  readonly receiver: FrameReceiver;
  readonly recvKeys: SessionKeys;
  readonly peerSessionId: SessionId;
}> {
  const { recvKeys, peerSessionId } = await makePair(noopHandlers());
  const receiver = new FrameReceiver({
    sessionKeys: recvKeys,
    peerSessionId,
    ...config,
  });
  return { receiver, recvKeys, peerSessionId };
}

describe("R3/F1: isPerTransferFramingError classification", () => {
  it("classifies transfer-scoped codes as per-transfer and wire/lifecycle codes as fatal", () => {
    const perTransfer: readonly FramingErrorCode[] = [
      FramingErrorCode.UnknownTransfer,
      FramingErrorCode.TransferInactive,
      FramingErrorCode.DuplicateChunk,
      FramingErrorCode.ChunkOutOfRange,
      FramingErrorCode.SizeExceeded,
      FramingErrorCode.ConcurrentTransfersExceeded,
      FramingErrorCode.HashMismatch,
    ];
    const sessionFatal: readonly FramingErrorCode[] = [
      FramingErrorCode.Malformed,
      FramingErrorCode.WrongSession,
      FramingErrorCode.SequenceExhausted,
      FramingErrorCode.UnknownControlSubtype,
      FramingErrorCode.TearingDown,
      FramingErrorCode.Backpressured,
      FramingErrorCode.TransferCancelled,
    ];
    for (const code of perTransfer) {
      expect(isPerTransferFramingError(new FramingError(code, "x", 7))).toBe(true);
    }
    for (const code of sessionFatal) {
      expect(isPerTransferFramingError(new FramingError(code, "x", 7))).toBe(false);
    }
    expect(isPerTransferFramingError(new Error("boom"))).toBe(false);
    expect(isPerTransferFramingError("boom")).toBe(false);
    expect(isPerTransferFramingError(undefined)).toBe(false);
  });
});

describe("R3/F4: manifest admission reserves declared bytes", () => {
  it("a second manifest is rejected when prior manifests already reserve the aggregate budget", async () => {
    const { receiver, recvKeys, peerSessionId } = await makeReceiver(noopHandlers());
    // Manifest A declares the entire budget. Pre-fix the admission check read
    // only `totalBufferedBytes` (0), so a second manifest of any legal size
    // slipped through; the reservation charges declared-but-unreceived bytes.
    const manifestA = manifestFor(1, MAX_INCOMPLETE_TRANSFER_BYTES);
    await receiver.ingest(
      await forgeFrame(
        recvKeys.recvKey,
        peerSessionId,
        0,
        FrameType.FileManifest,
        1,
        0,
        encodeManifest(manifestA),
      ),
    );
    expect(receiver.activeTransferCount).toBe(1);
    expect(receiver.bufferedBytes).toBe(0);

    await expect(
      receiver.ingest(
        await forgeFrame(
          recvKeys.recvKey,
          peerSessionId,
          1,
          FrameType.FileManifest,
          2,
          0,
          encodeManifest(manifestFor(2, 1)),
        ),
      ),
    ).rejects.toMatchObject({
      code: FramingErrorCode.SizeExceeded,
      transferId: 2,
    });
    expect(receiver.activeTransferCount).toBe(1);
    receiver.teardown();
  });

  it("partially-declared reservations still bound a follow-up manifest", async () => {
    const { receiver, recvKeys, peerSessionId } = await makeReceiver(noopHandlers());
    const reserved = 4 * MAX_CHUNK_PLAINTEXT_BYTES;
    await receiver.ingest(
      await forgeFrame(
        recvKeys.recvKey,
        peerSessionId,
        0,
        FrameType.FileManifest,
        1,
        0,
        encodeManifest(manifestFor(1, reserved)),
      ),
    );
    // A manifest whose size fits the budget alone but not on top of the
    // outstanding reservation must be rejected.
    await expect(
      receiver.ingest(
        await forgeFrame(
          recvKeys.recvKey,
          peerSessionId,
          1,
          FrameType.FileManifest,
          2,
          0,
          encodeManifest(manifestFor(2, MAX_INCOMPLETE_TRANSFER_BYTES - reserved + 1)),
        ),
      ),
    ).rejects.toMatchObject({ code: FramingErrorCode.SizeExceeded });
    // One that fits inside the remaining committed budget is admitted.
    await receiver.ingest(
      await forgeFrame(
        recvKeys.recvKey,
        peerSessionId,
        2,
        FrameType.FileManifest,
        3,
        0,
        encodeManifest(manifestFor(3, MAX_INCOMPLETE_TRANSFER_BYTES - reserved)),
      ),
    );
    expect(receiver.activeTransferCount).toBe(2);
    receiver.teardown();
  });

  it("cancelling an admitted transfer releases its reservation", async () => {
    const { receiver, recvKeys, peerSessionId } = await makeReceiver(noopHandlers());
    const reserved = 4 * MAX_CHUNK_PLAINTEXT_BYTES;
    await receiver.ingest(
      await forgeFrame(
        recvKeys.recvKey,
        peerSessionId,
        0,
        FrameType.FileManifest,
        1,
        0,
        encodeManifest(manifestFor(1, reserved)),
      ),
    );
    // Store one chunk: reserved bytes convert to real buffered bytes — the
    // committed total is unchanged, so a max-size manifest still cannot be
    // admitted.
    await receiver.ingest(
      await forgeFrame(
        recvKeys.recvKey,
        peerSessionId,
        1,
        FrameType.FileChunk,
        1,
        0,
        deterministicData(MAX_CHUNK_PLAINTEXT_BYTES, 5),
      ),
    );
    expect(receiver.bufferedBytes).toBe(MAX_CHUNK_PLAINTEXT_BYTES);
    await expect(
      receiver.ingest(
        await forgeFrame(
          recvKeys.recvKey,
          peerSessionId,
          2,
          FrameType.FileManifest,
          2,
          0,
          encodeManifest(manifestFor(2, MAX_INCOMPLETE_TRANSFER_BYTES)),
        ),
      ),
    ).rejects.toMatchObject({ code: FramingErrorCode.SizeExceeded });

    // Cancel releases BOTH the buffered bytes and the remaining declared
    // reservation — the full-budget manifest then fits.
    expect(receiver.cancelTransfer(1)).toBe(true);
    expect(receiver.bufferedBytes).toBe(0);
    await receiver.ingest(
      await forgeFrame(
        recvKeys.recvKey,
        peerSessionId,
        3,
        FrameType.FileManifest,
        3,
        0,
        encodeManifest(manifestFor(3, MAX_INCOMPLETE_TRANSFER_BYTES)),
      ),
    );
    expect(receiver.activeTransferCount).toBe(1);
    receiver.teardown();
  });
});

describe("R3/F5: host-callback throw containment", () => {
  it("a throwing onFileComplete is contained: ingest resolves, onTransferError fires, receiver keeps working", async () => {
    const transferErrors: Array<{ readonly id: number; readonly error: unknown }> = [];
    const completed: FileManifest[] = [];
    const { receiver, recvKeys, peerSessionId } = await makeReceiver({
      onText: () => {},
      onControl: () => {},
      onFileComplete: (file) => {
        if (file.manifest.name === "boom.bin") {
          throw new Error("host boom");
        }
        completed.push(file.manifest);
      },
      onTransferError: (transferId, error) => {
        transferErrors.push({ id: transferId, error });
      },
    });

    const data = deterministicData(1024, 7);
    const manifest: FileManifest = {
      transferId: 5,
      name: "boom.bin",
      mimeType: "application/octet-stream",
      size: data.length,
      chunkCount: 1,
      contentHash: await sha256(data),
    };
    await receiver.ingest(
      await forgeFrame(
        recvKeys.recvKey,
        peerSessionId,
        0,
        FrameType.FileManifest,
        5,
        0,
        encodeManifest(manifest),
      ),
    );
    // The final chunk completes the transfer; the host throw must NOT reject
    // ingest — it surfaces via onTransferError with the completed id.
    await receiver.ingest(
      await forgeFrame(recvKeys.recvKey, peerSessionId, 1, FrameType.FileChunk, 5, 0, data),
    );
    expect(transferErrors).toHaveLength(1);
    expect(transferErrors[0]!.id).toBe(5);
    expect(transferErrors[0]!.error).toBeInstanceOf(Error);
    expect((transferErrors[0]!.error as Error).message).toBe("host boom");
    // The transfer itself was dropped before the callback ran.
    expect(receiver.activeTransferCount).toBe(0);
    expect(receiver.bufferedBytes).toBe(0);

    // And the receiver still completes a subsequent transfer normally.
    const data2 = deterministicData(256, 9);
    const manifest2: FileManifest = {
      transferId: 6,
      name: "fine.bin",
      mimeType: "application/octet-stream",
      size: data2.length,
      chunkCount: 1,
      contentHash: await sha256(data2),
    };
    await receiver.ingest(
      await forgeFrame(
        recvKeys.recvKey,
        peerSessionId,
        2,
        FrameType.FileManifest,
        6,
        0,
        encodeManifest(manifest2),
      ),
    );
    await receiver.ingest(
      await forgeFrame(recvKeys.recvKey, peerSessionId, 3, FrameType.FileChunk, 6, 0, data2),
    );
    expect(completed.map((m) => m.name)).toEqual(["fine.bin"]);
    expect(transferErrors).toHaveLength(1);
    receiver.teardown();
  });

  it("a throwing onText is contained and routed to onError", async () => {
    const callbackErrors: unknown[] = [];
    const { receiver, recvKeys, peerSessionId } = await makeReceiver({
      onText: () => {
        throw new Error("text boom");
      },
      onControl: () => {},
      onFileComplete: () => {},
      onError: (error) => {
        callbackErrors.push(error);
      },
    });
    // ingest resolves — the host throw is not a wire error.
    await receiver.ingest(
      await forgeFrame(recvKeys.recvKey, peerSessionId, 0, FrameType.Text, 0, 0, utf8("hi")),
    );
    expect(callbackErrors).toHaveLength(1);
    expect((callbackErrors[0] as Error).message).toBe("text boom");
    receiver.teardown();
  });

  it("a throwing onControl is contained and routed to onError", async () => {
    const callbackErrors: unknown[] = [];
    const { receiver, recvKeys, peerSessionId } = await makeReceiver({
      onText: () => {},
      onControl: () => {
        throw new Error("control boom");
      },
      onFileComplete: () => {},
      onError: (error) => {
        callbackErrors.push(error);
      },
    });
    const body = new Uint8Array([ControlSubtype.Leave, 1, 2, 3]);
    await receiver.ingest(
      await forgeFrame(recvKeys.recvKey, peerSessionId, 0, FrameType.Control, 0, 0, body),
    );
    expect(callbackErrors).toHaveLength(1);
    expect((callbackErrors[0] as Error).message).toBe("control boom");
    receiver.teardown();
  });

  it("an unknown control subtype still rejects ingest (wire-level violation, not a host throw)", async () => {
    const { receiver, recvKeys, peerSessionId } = await makeReceiver({
      onText: () => {},
      onControl: () => {},
      onFileComplete: () => {},
      onError: () => {
        throw new Error("onError must not fire for wire violations");
      },
    });
    await expect(
      receiver.ingest(
        await forgeFrame(
          recvKeys.recvKey,
          peerSessionId,
          0,
          FrameType.Control,
          0,
          0,
          new Uint8Array([0x99]),
        ),
      ),
    ).rejects.toMatchObject({ code: FramingErrorCode.UnknownControlSubtype });
    receiver.teardown();
  });
});
