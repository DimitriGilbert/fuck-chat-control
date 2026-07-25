import { p256 } from "@noble/curves/p256";
import { describe, expect, it } from "vitest";

import { decodePublicKey, encodePublicKey } from "@/features/chat/protocol/codec";
import { ProtocolError, ProtocolErrorCode } from "@/features/chat/protocol/errors";
import { PUBLIC_KEY_BYTES } from "@/features/chat/protocol/limits";

function validPublicKey(): Uint8Array {
  return p256.getPublicKey(p256.utils.randomSecretKey(), false);
}

describe("encodePublicKey / decodePublicKey (SEC1 uncompressed, 65 bytes)", () => {
  it("round-trips a valid uncompressed P-256 public key", () => {
    const pub = validPublicKey();
    expect(pub.length).toBe(PUBLIC_KEY_BYTES);
    expect(pub[0]).toBe(0x04);
    const encoded = encodePublicKey(pub);
    expect(encoded.length).toBe(PUBLIC_KEY_BYTES);
    expect(Array.from(encoded)).toEqual(Array.from(pub));
    const decoded = decodePublicKey(encoded);
    expect(Array.from(decoded)).toEqual(Array.from(pub));
  });

  it("produces a copy that does not alias the input", () => {
    const pub = validPublicKey();
    const encoded = encodePublicKey(pub);
    pub[1] ^= 0xff;
    expect(encoded[1]).not.toBe(pub[1]);
  });

  it("rejects a key that is too short", () => {
    const short = validPublicKey().subarray(0, PUBLIC_KEY_BYTES - 1);
    expect(() => encodePublicKey(short)).toThrow(ProtocolError);
    try {
      encodePublicKey(short);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ProtocolError);
      expect((err as ProtocolError).code).toBe(ProtocolErrorCode.InvalidLength);
    }
  });

  it("rejects a key that is too long", () => {
    const long = new Uint8Array(PUBLIC_KEY_BYTES + 1);
    long.set(validPublicKey());
    expect(() => encodePublicKey(long)).toThrow(ProtocolError);
    try {
      encodePublicKey(long);
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ProtocolError).code).toBe(ProtocolErrorCode.InvalidLength);
    }
  });

  it("rejects a 65-byte buffer with a compressed prefix", () => {
    const pub = validPublicKey();
    pub[0] = 0x02;
    try {
      encodePublicKey(pub);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ProtocolError);
      expect((err as ProtocolError).code).toBe(ProtocolErrorCode.InvalidEncoding);
    }
  });

  it("rejects a 65-byte uncompressed-prefixed point that is not on the curve", () => {
    const pub = validPublicKey();
    pub[64] ^= 0x01;
    try {
      encodePublicKey(pub);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ProtocolError);
      expect((err as ProtocolError).code).toBe(ProtocolErrorCode.PointNotOnCurve);
    }
  });
});
