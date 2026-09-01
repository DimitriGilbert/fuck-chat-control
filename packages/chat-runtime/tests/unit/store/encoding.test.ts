import { describe, expect, it } from "vitest";

import {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  hexToBytes,
} from "@fuck-eu-chat-control/chat-runtime/store/encoding";

import { bytesEqual } from "./_helpers";

describe("bytesToHex / hexToBytes", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 15, 16, 255, 128, 1]);
    const hex = bytesToHex(bytes);
    expect(hex).toBe("000f10ff8001");
    expect(bytesEqual(hexToBytes(hex), bytes)).toBe(true);
  });

  it("round-trips an empty byte array", () => {
    expect(bytesToHex(new Uint8Array(0))).toBe("");
    expect(hexToBytes("").length).toBe(0);
  });

  it("rejects an odd-length hex string", () => {
    expect(() => hexToBytes("abc")).toThrow();
  });
});

describe("bytesToBase64 / base64ToBytes", () => {
  it("round-trips arbitrary bytes including padding cases", () => {
    const cases = [
      new Uint8Array([]),
      new Uint8Array([255]),
      new Uint8Array([255, 0]),
      new Uint8Array([255, 0, 128]),
      new Uint8Array([255, 0, 128, 1, 2, 3, 4, 5]),
    ];
    for (const bytes of cases) {
      const encoded = bytesToBase64(bytes);
      expect(encoded).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
      expect(encoded.length % 4).toBe(0);
      expect(bytesEqual(base64ToBytes(encoded), bytes)).toBe(true);
    }
  });

  it("round-trips the RFC 4648 vector", () => {
    const bytes = new TextEncoder().encode("foobar");
    expect(bytesToBase64(bytes)).toBe("Zm9vYmFy");
    expect(bytesEqual(base64ToBytes("Zm9vYmFy"), bytes)).toBe(true);
  });

  it("rejects malformed base64", () => {
    expect(() => base64ToBytes("!!!!")).toThrow();
    expect(() => base64ToBytes("abc")).toThrow();
  });
});
