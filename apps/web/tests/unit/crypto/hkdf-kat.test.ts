import { describe, expect, it } from "vitest";

import { hkdfSha256 } from "@fuck-eu-chat-control/chat-runtime/crypto/primitives";

// CR-12: HKDF-SHA256 known-answer test against RFC 5869 Appendix A.1
// "Test Case 1" (the canonical HKDF-SHA256 reference vector). A KAT is only
// meaningful if the expected OKM is a literal from the RFC, not a value
// computed by the project's own hkdfSha256 at test time.
//
// Source: RFC 5869, Appendix A, Test Case 1
// (https://www.rfc-editor.org/rfc/rfc5869#section-A.1).
//   IKM  = 0x0b*22  (22 octets)
//   salt = 0x000102030405060708090a0b0c  (13 octets)
//   info = 0xf0f1f2f3f4f5f6f7f8f9  (10 octets)
//   L    = 42
//   OKM  = 0x3cb25f25faacd57a90434f64d0362f2a
//          2d2d0a90cf1a5a4c5db02d56ecc4c5bf
//          34007208d5b887185865  (42 octets)
const IKM_HEX = "0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b";
const SALT_HEX = "000102030405060708090a0b0c";
const INFO_HEX = "f0f1f2f3f4f5f6f7f8f9";
const L = 42;
const EXPECTED_OKM_HEX =
  "3cb25f25faacd57a90434f64d0362f2a" +
  "2d2d0a90cf1a5a4c5db02d56ecc4c5bf" +
  "34007208d5b887185865";

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, "0");
  }
  return s;
}

describe("HKDF-SHA256 known-answer test (RFC 5869 Appendix A.1, Test Case 1)", () => {
  it("reproduces the published OKM for the RFC 5869 TC1 vector", async () => {
    const ikm = hexToBytes(IKM_HEX);
    const salt = hexToBytes(SALT_HEX);
    const info = hexToBytes(INFO_HEX);

    const okm = await hkdfSha256(ikm, salt, info, L);

    expect(okm.length).toBe(L);
    expect(bytesToHex(okm)).toBe(EXPECTED_OKM_HEX);
  });
});
