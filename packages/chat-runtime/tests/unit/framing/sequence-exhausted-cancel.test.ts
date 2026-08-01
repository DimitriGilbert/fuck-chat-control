import { describe, expect, it } from "vitest";

import {
  encodeTransferCancelPayload,
  decodeTransferCancelPayload,
} from "@fuck-eu-chat-control/chat-runtime/protocol/codec";
import {
  ControlSubtype,
  CONTROL_SUBTYPE_VALUES,
  FrameType,
} from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import {
  FramingError,
  FramingErrorCode,
  MAX_CHUNK_PLAINTEXT_BYTES,
} from "@fuck-eu-chat-control/chat-runtime/framing";
import type { FrameReceiverHandlers } from "@fuck-eu-chat-control/chat-runtime/framing";

import { bytesEqual, deterministicData, forgeFrame, makePair } from "./_helpers";

/**
 * Build a receiver-handler set that records every control event the receiver
 * surfaces to the host. The R3/F2 fix routes TransferCancel inline (it does
 * NOT propagate through onControl because the receiver handles it as a
 * cancel), so onControl should never fire for the TransferCancel subtype.
 */
function collectHandlers(): {
  controls: { subtype: ControlSubtype; payload: Uint8Array }[];
  handlers: FrameReceiverHandlers;
} {
  const controls: { subtype: ControlSubtype; payload: Uint8Array }[] = [];
  return {
    controls,
    handlers: {
      onText: () => {
        throw new Error("unexpected text");
      },
      onControl: (subtype, payload) => {
        controls.push({ subtype, payload });
      },
      onFileComplete: () => {
        throw new Error("unexpected file complete");
      },
    },
  };
}

describe("TransferCancel control subtype (R3/F2 / Phase 8.2)", () => {
  it("ControlSubtype.TransferCancel is registered in CONTROL_SUBTYPE_VALUES", () => {
    expect(ControlSubtype.TransferCancel).toBe(0x06);
    expect(CONTROL_SUBTYPE_VALUES).toContain(ControlSubtype.TransferCancel);
  });

  it("encodeTransferCancelPayload writes a 4-byte big-endian transferId", () => {
    const payload = encodeTransferCancelPayload(0x01020304);
    expect(payload.length).toBe(4);
    expect(Array.from(payload)).toEqual([0x01, 0x02, 0x03, 0x04]);
  });

  it("decodeTransferCancelPayload round-trips a transferId", () => {
    const id = 0xdeadbeef;
    expect(decodeTransferCancelPayload(encodeTransferCancelPayload(id))).toBe(id);
  });

  it("decodeTransferCancelPayload rejects a too-short payload", () => {
    expect(() => decodeTransferCancelPayload(new Uint8Array(3))).toThrow();
  });

  it("decodeTransferCancelPayload rejects a too-long payload", () => {
    expect(() => decodeTransferCancelPayload(new Uint8Array(5))).toThrow();
  });

  it("encodeTransferCancelPayload rejects a negative or non-integer transferId", () => {
    expect(() => encodeTransferCancelPayload(-1)).toThrow();
    expect(() => encodeTransferCancelPayload(1.5)).toThrow();
  });
});

describe("sender SequenceExhausted emits a receiver-side cancel (R3/F2 / Phase 8.2)", () => {
  it("the receiver drops matching inbound state when a TransferCancel arrives", async () => {
    const rec = collectHandlers();
    const { receiver, recvKeys, peerSessionId } = await makePair(rec.handlers);

    // Drive a manifest + one chunk so the receiver has active state for
    // transferId 1_000_000 (the new FIRST_TRANSFER_ID under Phase 8.5).
    const transferId = 1_000_000;
    const chunkSize = MAX_CHUNK_PLAINTEXT_BYTES;
    const size = chunkSize * 2;
    const data = deterministicData(size, 7);

    // Forge + ingest the manifest using the receiver's recvKey.
    const manifestPayload = await forgeManifestPayload(transferId, size, data);
    await receiver.ingest(
      await forgeFrame(
        recvKeys.recvKey,
        peerSessionId,
        0,
        FrameType.FileManifest,
        transferId,
        0,
        manifestPayload,
      ),
    );
    expect(receiver.activeTransferCount).toBe(1);

    // Ingest one chunk so the receiver has buffered bytes to release.
    await receiver.ingest(
      await forgeFrame(
        recvKeys.recvKey,
        peerSessionId,
        1,
        FrameType.FileChunk,
        transferId,
        0,
        data.subarray(0, chunkSize),
      ),
    );
    expect(receiver.bufferedBytes).toBe(chunkSize);

    // Forge a TransferCancel control frame and ingest it. The receiver must
    // drop the matching transfer state and zero its buffered-byte count
    // WITHOUT surfacing the cancel via onControl (handled inline).
    const cancelPayload = encodeTransferCancelPayload(transferId);
    const controlBody = new Uint8Array(1 + cancelPayload.length);
    controlBody[0] = ControlSubtype.TransferCancel;
    controlBody.set(cancelPayload, 1);
    await receiver.ingest(
      await forgeFrame(recvKeys.recvKey, peerSessionId, 2, FrameType.Control, 0, 0, controlBody),
    );

    expect(receiver.activeTransferCount).toBe(0);
    expect(receiver.bufferedBytes).toBe(0);
    // The handler must NOT have been invoked — the receiver owns the cancel.
    expect(rec.controls).toHaveLength(0);
  });

  it("a TransferCancel for an unknown transferId is a no-op (idempotent)", async () => {
    const rec = collectHandlers();
    const { receiver, recvKeys, peerSessionId } = await makePair(rec.handlers);
    const cancelPayload = encodeTransferCancelPayload(42);
    const controlBody = new Uint8Array(1 + cancelPayload.length);
    controlBody[0] = ControlSubtype.TransferCancel;
    controlBody.set(cancelPayload, 1);
    // Receiver has no transferId=42 state; ingest must not throw and must
    // leave the receiver empty.
    await receiver.ingest(
      await forgeFrame(recvKeys.recvKey, peerSessionId, 0, FrameType.Control, 0, 0, controlBody),
    );
    expect(receiver.activeTransferCount).toBe(0);
    expect(receiver.bufferedBytes).toBe(0);
  });
});

/**
 * Build the encoded manifest payload that the sender would emit for the
 * transfer described by (transferId, size, data). Uses the framing layer's
 * own encoder to ensure byte-for-byte compatibility with the receiver's
 * decoder.
 */
async function forgeManifestPayload(
  transferId: number,
  size: number,
  data: Uint8Array,
): Promise<Uint8Array> {
  // Re-use the framing layer's encoder via the sender's import path.
  const { encodeManifest, sha256, computeChunkCount } =
    await import("@fuck-eu-chat-control/chat-runtime/framing/manifest");
  const contentHash = await sha256(data);
  const chunkCount = computeChunkCount(size);
  return encodeManifest({
    transferId,
    name: "payload.bin",
    mimeType: "application/octet-stream",
    size,
    chunkCount,
    contentHash,
  });
}

describe("framing FramingError carries SequenceExhausted code", () => {
  it("the SequenceExhausted code is exposed on FramingError", () => {
    const err = new FramingError(FramingErrorCode.SequenceExhausted, "transfer id space exhausted");
    expect(err.code).toBe(FramingErrorCode.SequenceExhausted);
    expect(err).toBeInstanceOf(FramingError);
  });

  it("bytesEqual sanity (helper import)", () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 3]);
    expect(bytesEqual(a, b)).toBe(true);
  });
});
