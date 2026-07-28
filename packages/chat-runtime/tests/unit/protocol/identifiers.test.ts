import { describe, expect, it } from "vitest";

import {
  decodeConversationId,
  decodeSessionId,
  encodeConversationId,
  encodeSessionId,
} from "@fuck-eu-chat-control/chat-runtime/protocol/codec";
import { ProtocolError, ProtocolErrorCode } from "@fuck-eu-chat-control/chat-runtime/protocol/errors";
import { CONVERSATION_ID_BYTES, SESSION_ID_BYTES } from "@fuck-eu-chat-control/chat-runtime/protocol/limits";

describe("encodeConversationId / decodeConversationId (16 bytes)", () => {
  it("round-trips a 128-bit conversation id", () => {
    const id = new Uint8Array(CONVERSATION_ID_BYTES);
    for (let i = 0; i < CONVERSATION_ID_BYTES; i++) id[i] = (i + 1) & 0xff;
    const encoded = encodeConversationId(id);
    expect(encoded.length).toBe(CONVERSATION_ID_BYTES);
    expect(Array.from(encoded)).toEqual(Array.from(id));
    const decoded = decodeConversationId(encoded);
    expect(Array.from(decoded)).toEqual(Array.from(id));
  });

  it("rejects a too-short conversation id", () => {
    try {
      encodeConversationId(new Uint8Array(CONVERSATION_ID_BYTES - 1));
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ProtocolError).code).toBe(ProtocolErrorCode.InvalidLength);
    }
  });

  it("rejects a too-long conversation id", () => {
    try {
      encodeConversationId(new Uint8Array(CONVERSATION_ID_BYTES + 1));
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ProtocolError).code).toBe(ProtocolErrorCode.InvalidLength);
    }
  });
});

describe("encodeSessionId / decodeSessionId (32 bytes)", () => {
  it("round-trips a 256-bit session id", () => {
    const id = new Uint8Array(SESSION_ID_BYTES);
    for (let i = 0; i < SESSION_ID_BYTES; i++) id[i] = (0x10 + i) & 0xff;
    const encoded = encodeSessionId(id);
    expect(encoded.length).toBe(SESSION_ID_BYTES);
    expect(Array.from(encoded)).toEqual(Array.from(id));
    const decoded = decodeSessionId(encoded);
    expect(Array.from(decoded)).toEqual(Array.from(id));
  });

  it("rejects a too-short session id", () => {
    try {
      encodeSessionId(new Uint8Array(SESSION_ID_BYTES - 1));
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ProtocolError).code).toBe(ProtocolErrorCode.InvalidLength);
    }
  });

  it("rejects a too-long session id", () => {
    try {
      encodeSessionId(new Uint8Array(SESSION_ID_BYTES + 1));
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ProtocolError).code).toBe(ProtocolErrorCode.InvalidLength);
    }
  });
});
