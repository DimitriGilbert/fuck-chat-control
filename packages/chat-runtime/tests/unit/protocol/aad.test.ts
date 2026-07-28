import { describe, expect, it } from "vitest";

import { decodeAad, encodeAad } from "@fuck-eu-chat-control/chat-runtime/protocol/codec";
import {
  ProtocolError,
  ProtocolErrorCode,
} from "@fuck-eu-chat-control/chat-runtime/protocol/errors";
import {
  FRAME_AAD_BYTES,
  PROTOCOL_VERSION,
  SESSION_ID_BYTES,
} from "@fuck-eu-chat-control/chat-runtime/protocol/limits";
import {
  FrameType,
  type FrameAad,
  type SessionId,
} from "@fuck-eu-chat-control/chat-runtime/protocol/types";

function sessionId(seed: number): SessionId {
  const bytes = new Uint8Array(SESSION_ID_BYTES);
  for (let i = 0; i < SESSION_ID_BYTES; i++) bytes[i] = (seed + i) & 0xff;
  return bytes as unknown as SessionId;
}

function baseAad(overrides: Partial<FrameAad> = {}): FrameAad {
  return {
    protocolVersion: PROTOCOL_VERSION,
    senderSessionId: sessionId(1),
    senderSequence: 7,
    frameType: FrameType.Text,
    transferId: 0,
    chunkId: 0,
    ...overrides,
  };
}

describe("encodeAad / decodeAad (46 bytes, canonical order)", () => {
  it("round-trips a text-frame AAD", () => {
    const aad = baseAad();
    const bytes = encodeAad(aad);
    expect(bytes.length).toBe(FRAME_AAD_BYTES);
    const decoded = decodeAad(bytes);
    expect(decoded.protocolVersion).toBe(aad.protocolVersion);
    expect(decoded.senderSequence).toBe(aad.senderSequence);
    expect(decoded.frameType).toBe(aad.frameType);
    expect(decoded.transferId).toBe(aad.transferId);
    expect(decoded.chunkId).toBe(aad.chunkId);
    expect(Array.from(decoded.senderSessionId)).toEqual(Array.from(aad.senderSessionId));
  });

  it("places fields in the canonical order version||sid||seq||type||xfer||chunk", () => {
    const aad = baseAad({
      senderSequence: 0x01020304,
      frameType: FrameType.FileChunk,
      transferId: 0xaabbccdd,
      chunkId: 0x11223344,
    });
    const bytes = encodeAad(aad);
    expect(bytes[0]).toBe(PROTOCOL_VERSION);
    expect(bytes[1 + SESSION_ID_BYTES]).toBe(0x01);
    expect(bytes[1 + SESSION_ID_BYTES + 1]).toBe(0x02);
    expect(bytes[1 + SESSION_ID_BYTES + 2]).toBe(0x03);
    expect(bytes[1 + SESSION_ID_BYTES + 3]).toBe(0x04);
    expect(bytes[1 + SESSION_ID_BYTES + 4]).toBe(FrameType.FileChunk);
  });

  it("rejects an unknown protocol version", () => {
    try {
      encodeAad(baseAad({ protocolVersion: 0x02 }));
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ProtocolError).code).toBe(ProtocolErrorCode.InvalidVersion);
    }
  });

  it("rejects an unknown frame type on encode", () => {
    try {
      encodeAad(baseAad({ frameType: 0xff as FrameType }));
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ProtocolError).code).toBe(ProtocolErrorCode.InvalidEnum);
    }
  });

  it("rejects a negative or non-integer sequence", () => {
    try {
      encodeAad(baseAad({ senderSequence: -1 }));
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ProtocolError).code).toBe(ProtocolErrorCode.InvalidRange);
    }
  });

  it("rejects a sequence that overflows uint32", () => {
    try {
      encodeAad(baseAad({ senderSequence: 0x100000000 }));
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ProtocolError).code).toBe(ProtocolErrorCode.InvalidRange);
    }
  });

  it("rejects a text frame that carries a transfer id", () => {
    try {
      encodeAad(baseAad({ frameType: FrameType.Text, transferId: 5 }));
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ProtocolError).code).toBe(ProtocolErrorCode.InvalidFieldRelation);
    }
  });

  it("rejects a manifest frame whose transfer id is zero", () => {
    try {
      encodeAad(baseAad({ frameType: FrameType.FileManifest, transferId: 0 }));
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ProtocolError).code).toBe(ProtocolErrorCode.InvalidFieldRelation);
    }
  });

  it("rejects a chunk frame whose transfer id is zero", () => {
    try {
      encodeAad(
        baseAad({
          frameType: FrameType.FileChunk,
          transferId: 0,
          chunkId: 3,
        }),
      );
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ProtocolError).code).toBe(ProtocolErrorCode.InvalidFieldRelation);
    }
  });
});

describe("decodeAad malformed-input rejection", () => {
  it("rejects a buffer that is too short", () => {
    try {
      decodeAad(new Uint8Array(FRAME_AAD_BYTES - 1));
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ProtocolError).code).toBe(ProtocolErrorCode.InvalidLength);
    }
  });

  it("rejects a buffer that is too long", () => {
    try {
      decodeAad(new Uint8Array(FRAME_AAD_BYTES + 1));
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ProtocolError).code).toBe(ProtocolErrorCode.InvalidLength);
    }
  });

  it("rejects an unknown protocol version on decode", () => {
    const bytes = encodeAad(baseAad());
    bytes[0] = 0x02;
    try {
      decodeAad(bytes);
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ProtocolError).code).toBe(ProtocolErrorCode.InvalidVersion);
    }
  });

  it("rejects an unknown frame type on decode", () => {
    const bytes = encodeAad(baseAad());
    bytes[1 + SESSION_ID_BYTES + 4] = 0x09;
    try {
      decodeAad(bytes);
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ProtocolError).code).toBe(ProtocolErrorCode.InvalidEnum);
    }
  });
});
