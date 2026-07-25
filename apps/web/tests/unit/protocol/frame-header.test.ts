import { describe, expect, it } from "vitest";

import { decodeFrameHeader, encodeFrameHeader } from "@/features/chat/protocol/codec";
import { ProtocolError, ProtocolErrorCode } from "@/features/chat/protocol/errors";
import {
  FRAME_AAD_BYTES,
  FRAME_HEADER_BYTES,
  MAX_CHUNK_BYTES,
  MAX_TEXT_FRAME_BYTES,
  PROTOCOL_VERSION,
  SESSION_ID_BYTES,
} from "@/features/chat/protocol/limits";
import { FrameType, type FrameHeader, type SessionId } from "@/features/chat/protocol/types";

function sessionId(seed: number): SessionId {
  const bytes = new Uint8Array(SESSION_ID_BYTES);
  for (let i = 0; i < SESSION_ID_BYTES; i++) bytes[i] = (seed + i) & 0xff;
  return bytes as unknown as SessionId;
}

function baseHeader(overrides: Partial<FrameHeader> = {}): FrameHeader {
  return {
    protocolVersion: PROTOCOL_VERSION,
    senderSessionId: sessionId(1),
    senderSequence: 0,
    frameType: FrameType.Text,
    transferId: 0,
    chunkId: 0,
    ciphertextLength: 12,
    ...overrides,
  };
}

describe("encodeFrameHeader / decodeFrameHeader (50 bytes)", () => {
  it("round-trips a text-frame header", () => {
    const header = baseHeader({ senderSequence: 42, ciphertextLength: 100 });
    const bytes = encodeFrameHeader(header);
    expect(bytes.length).toBe(FRAME_HEADER_BYTES);
    const decoded = decodeFrameHeader(bytes);
    expect(decoded.senderSequence).toBe(42);
    expect(decoded.frameType).toBe(FrameType.Text);
    expect(decoded.ciphertextLength).toBe(100);
    expect(Array.from(decoded.senderSessionId)).toEqual(Array.from(header.senderSessionId));
  });

  it("round-trips a file-chunk header with transfer and chunk ids", () => {
    const header = baseHeader({
      frameType: FrameType.FileChunk,
      transferId: 0x1234,
      chunkId: 0x0009,
      ciphertextLength: MAX_CHUNK_BYTES,
    });
    const decoded = decodeFrameHeader(encodeFrameHeader(header));
    expect(decoded.frameType).toBe(FrameType.FileChunk);
    expect(decoded.transferId).toBe(0x1234);
    expect(decoded.chunkId).toBe(9);
    expect(decoded.ciphertextLength).toBe(MAX_CHUNK_BYTES);
  });

  it("round-trips a file-manifest header (chunk id 0, transfer id set)", () => {
    const header = baseHeader({
      frameType: FrameType.FileManifest,
      transferId: 0x55,
      chunkId: 0,
      ciphertextLength: 400,
    });
    const decoded = decodeFrameHeader(encodeFrameHeader(header));
    expect(decoded.frameType).toBe(FrameType.FileManifest);
    expect(decoded.transferId).toBe(0x55);
    expect(decoded.chunkId).toBe(0);
  });

  it("round-trips a control header", () => {
    const header = baseHeader({
      frameType: FrameType.Control,
      ciphertextLength: 5,
    });
    const decoded = decodeFrameHeader(encodeFrameHeader(header));
    expect(decoded.frameType).toBe(FrameType.Control);
  });

  it("places ciphertextLength as the trailing uint32 BE after the AAD", () => {
    const header = baseHeader({ ciphertextLength: 0x00004000 });
    const bytes = encodeFrameHeader(header);
    expect(bytes.length).toBe(FRAME_HEADER_BYTES);
    expect(bytes[FRAME_AAD_BYTES]).toBe(0x00);
    expect(bytes[FRAME_AAD_BYTES + 1]).toBe(0x00);
    expect(bytes[FRAME_AAD_BYTES + 2]).toBe(0x40);
    expect(bytes[FRAME_AAD_BYTES + 3]).toBe(0x00);
  });

  it("rejects a text ciphertext length above MAX_TEXT_FRAME_BYTES", () => {
    try {
      encodeFrameHeader(
        baseHeader({
          frameType: FrameType.Text,
          ciphertextLength: MAX_TEXT_FRAME_BYTES + 1,
        }),
      );
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ProtocolError).code).toBe(ProtocolErrorCode.LimitExceeded);
    }
  });

  it("rejects a chunk ciphertext length above MAX_CHUNK_BYTES", () => {
    try {
      encodeFrameHeader(
        baseHeader({
          frameType: FrameType.FileChunk,
          transferId: 1,
          chunkId: 1,
          ciphertextLength: MAX_CHUNK_BYTES + 1,
        }),
      );
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ProtocolError).code).toBe(ProtocolErrorCode.LimitExceeded);
    }
  });

  it("rejects a malformed header buffer (wrong length)", () => {
    try {
      decodeFrameHeader(new Uint8Array(FRAME_HEADER_BYTES - 1));
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ProtocolError).code).toBe(ProtocolErrorCode.InvalidLength);
    }
  });

  it("rejects a header whose bytes carry an oversized ciphertext length", () => {
    const header = baseHeader({ frameType: FrameType.Text });
    const bytes = encodeFrameHeader(header);
    writeUint32Be(bytes, FRAME_AAD_BYTES, MAX_TEXT_FRAME_BYTES + 1);
    try {
      decodeFrameHeader(bytes);
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ProtocolError).code).toBe(ProtocolErrorCode.LimitExceeded);
    }
  });
});

function writeUint32Be(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}
