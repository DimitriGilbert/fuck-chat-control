import { describe, expect, it } from "vitest";

import {
  decodeSignature,
  encodeSignature,
} from "@fuck-eu-chat-control/chat-runtime/protocol/codec";
import {
  ProtocolError,
  ProtocolErrorCode,
} from "@fuck-eu-chat-control/chat-runtime/protocol/errors";
import { SIGNATURE_BYTES } from "@fuck-eu-chat-control/chat-runtime/protocol/limits";

describe("encodeSignature / decodeSignature (IEEE-P1363 r||s, 64 bytes)", () => {
  it("round-trips a 64-byte signature", () => {
    const sig = new Uint8Array(SIGNATURE_BYTES);
    for (let i = 0; i < SIGNATURE_BYTES; i++) sig[i] = (i * 7 + 3) & 0xff;
    const encoded = encodeSignature(sig);
    expect(encoded.length).toBe(SIGNATURE_BYTES);
    expect(Array.from(encoded)).toEqual(Array.from(sig));
    const decoded = decodeSignature(encoded);
    expect(Array.from(decoded)).toEqual(Array.from(sig));
  });

  it("produces a copy that does not alias the input", () => {
    const sig = new Uint8Array(SIGNATURE_BYTES).fill(0xab);
    const encoded = encodeSignature(sig);
    sig[0] ^= 0xff;
    expect(encoded[0]).not.toBe(sig[0]);
  });

  it("rejects a signature that is too short", () => {
    const short = new Uint8Array(SIGNATURE_BYTES - 1);
    try {
      encodeSignature(short);
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ProtocolError).code).toBe(ProtocolErrorCode.InvalidLength);
    }
  });

  it("rejects a signature that is too long", () => {
    const long = new Uint8Array(SIGNATURE_BYTES + 1);
    try {
      encodeSignature(long);
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ProtocolError).code).toBe(ProtocolErrorCode.InvalidLength);
    }
  });
});
