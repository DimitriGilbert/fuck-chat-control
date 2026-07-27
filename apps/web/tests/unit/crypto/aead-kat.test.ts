import { describe, expect, it } from "vitest";

import { aesGcmEncrypt, toAESKey } from "@/features/chat/crypto/primitives";

// CR-12: AES-256-GCM known-answer test against a published NIST/CAVP vector.
// A KAT is only meaningful if the expected ciphertext is a literal from a
// reference source (not computed by the project's own encrypt at test time).
//
// Vector source: NIST CAVP GCM Test Vectors, gcmEncryptExtIV256.rsp, first
// vector (count = 0) — the all-zeros AES-256-GCM reference. The same value is
// reproduced by the reference implementation in RFC 5288 §3 and by every
// audited AES-GCM implementation (e.g. OpenSSL / node:crypto).
// Cross-checked against node:crypto `createCipheriv("aes-256-gcm", ...)` which
// emits the identical ciphertext+tag (independent of this project's code).
//
// Inputs (all fixed; AES-GCM is deterministic given (key, IV, AAD, plaintext),
// so there is no randomness to inject):
//   K  = 32 zero octets
//   IV = 12 zero octets
//   H  = "" (empty AAD)
//   P  = 16 zero octets
// Expected output (ciphertext || 16-byte tag, 32 octets total):
//   C = cea7403d4d606b6e074ec5d3baf39d18 (16-byte ciphertext)
//   T = d0d1c8a799996bf0265b98b5d48ab919 (16-byte tag, 128-bit GCM tag)
const KEY_HEX = "0000000000000000000000000000000000000000000000000000000000000000";
const IV_HEX = "000000000000000000000000";
const PT_HEX = "00000000000000000000000000000000";
const EXPECTED_HEX =
  "cea7403d4d606b6e074ec5d3baf39d18" + // 16-byte ciphertext
  "d0d1c8a799996bf0265b98b5d48ab919"; // 16-byte tag

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

describe("AES-256-GCM known-answer test (NIST CAVP gcmEncryptExtIV256.rsp, count=0)", () => {
  it("reproduces the published ciphertext+tag for the all-zeros 256-bit vector", async () => {
    const key = toAESKey(hexToBytes(KEY_HEX));
    const iv = hexToBytes(IV_HEX);
    const plaintext = hexToBytes(PT_HEX);
    const aad = new Uint8Array(0); // empty AAD per the CAVP vector

    const out = await aesGcmEncrypt(key, iv, aad, plaintext);

    // AES-GCM emits ciphertext (same length as plaintext) || 16-byte tag.
    expect(out.length).toBe(plaintext.length + 16);
    expect(bytesToHex(out)).toBe(EXPECTED_HEX);
  });
});
