import { describe, expect, it } from "vitest";

import { encryptAtRest, generateAtRestKey, wrapKey } from "@fuck-eu-chat-control/chat-runtime/crypto";
import {
  __buildAtRestNonceForTests,
} from "@fuck-eu-chat-control/chat-runtime/crypto/at-rest";
import { GCM_NONCE_BYTES } from "@fuck-eu-chat-control/chat-runtime/protocol/limits";

import { bytesEqual } from "./_helpers";

/**
 * CR-10: at-rest nonce uniqueness. The deterministic construction composes
 *   `[counter(8) | sessionSuffix(4)]` = 12 bytes.
 *
 * These tests assert:
 *  - nonces are 12 bytes,
 *  - across N=10_000 encryptAtRest calls with the SAME key, ZERO nonces repeat,
 *  - consecutive nonces share the random suffix and increment only the counter
 *    (deterministic property),
 *  - wrapKey nonces also follow the same construction (no repeat across wraps),
 *  - the explicit composition helper rounds-trips for sanity.
 */

const PLAINTEXT = new TextEncoder().encode("nonce-uniqueness fixture");

describe("at-rest nonce uniqueness (CR-10, deterministic counter)", () => {
  it("nonce is exactly GCM_NONCE_BYTES (12)", async () => {
    const key = generateAtRestKey();
    const enc = await encryptAtRest(key, PLAINTEXT);
    expect(enc.nonce.length).toBe(GCM_NONCE_BYTES);
    expect(enc.nonce.length).toBe(12);
  });

  it("zero duplicate nonces across 10_000 encryptAtRest calls with the same key", async () => {
    const key = generateAtRestKey();
    const seen = new Set<string>();
    const N = 10_000;
    for (let i = 0; i < N; i++) {
      const enc = await encryptAtRest(key, PLAINTEXT);
      // Base64 of the nonce bytes; stable string key for the Set.
      const tag = nonceTag(enc.nonce);
      expect(seen.has(tag)).toBe(false);
      seen.add(tag);
    }
    expect(seen.size).toBe(N);
  });

  it("consecutive nonces share the random suffix and differ only in the counter portion", async () => {
    const key = generateAtRestKey();
    const a = await encryptAtRest(key, PLAINTEXT);
    const b = await encryptAtRest(key, PLAINTEXT);
    const c = await encryptAtRest(key, PLAINTEXT);

    // Random suffix is bytes [8..12); it must be identical across all three.
    const suffixA = a.nonce.subarray(8, 12);
    const suffixB = b.nonce.subarray(8, 12);
    const suffixC = c.nonce.subarray(8, 12);
    expect(bytesEqual(suffixA, suffixB)).toBe(true);
    expect(bytesEqual(suffixB, suffixC)).toBe(true);

    // Counter is bytes [0..8); it must be strictly increasing (deterministic).
    expect(readCounter(a.nonce)).toBe(readCounter(a.nonce));
    expect(readCounter(b.nonce)).toBe(readCounter(a.nonce) + 1);
    expect(readCounter(c.nonce)).toBe(readCounter(b.nonce) + 1);

    // Sanity: the three nonces are distinct overall.
    expect(bytesEqual(a.nonce, b.nonce)).toBe(false);
    expect(bytesEqual(b.nonce, c.nonce)).toBe(false);
    expect(bytesEqual(a.nonce, c.nonce)).toBe(false);
  });

  it("wrapKey uses the same nonce construction (no duplicates across 10 wraps)", async () => {
    // wrapKey is rare in production (one per passphrase set), but it must use
    // the same deterministic construction as encryptAtRest. Argon2id (64 MiB
    // memory, 3 iterations) is ~100ms per call, so we sample 10 wraps — still
    // enough to assert uniqueness via the deterministic counter.
    const key = generateAtRestKey();
    const seen = new Set<string>();
    const N = 10;
    // ARGON2_SALT_BYTES (16) | nonce (12) | ciphertext (32 + 16)
    const SALT = 16;
    for (let i = 0; i < N; i++) {
      const wrapped = await wrapKey(`passphrase-${i}`, key);
      const nonce = wrapped.subarray(SALT, SALT + GCM_NONCE_BYTES);
      expect(nonce.length).toBe(GCM_NONCE_BYTES);
      const tag = nonceTag(nonce);
      expect(seen.has(tag)).toBe(false);
      seen.add(tag);
    }
    expect(seen.size).toBe(N);
  }, 30_000);

  it("explicit composition helper produces 12-byte nonces with counter at [0..8) and suffix at [8..12)", () => {
    const suffix = new Uint8Array([0xab, 0xcd, 0xef, 0x01]);
    const n0 = __buildAtRestNonceForTests(0, suffix);
    const n1 = __buildAtRestNonceForTests(1, suffix);
    const nBig = __buildAtRestNonceForTests(0x0102030405060708, suffix);

    expect(n0.length).toBe(12);
    expect(n1.length).toBe(12);
    expect(nBig.length).toBe(12);

    // Counter is big-endian uint64 at [0..8): counter 0 reads all zeros.
    expect(readCounter(n0)).toBe(0);
    expect(readCounter(n1)).toBe(1);
    expect(readCounter(nBig)).toBe(0x0102030405060708);

    // Suffix is verbatim at [8..12).
    expect(bytesEqual(n0.subarray(8, 12), suffix)).toBe(true);
    expect(bytesEqual(n1.subarray(8, 12), suffix)).toBe(true);
    expect(bytesEqual(nBig.subarray(8, 12), suffix)).toBe(true);

    // Two equal counters with the same suffix produce equal nonces
    // (deterministic).
    const n0Again = __buildAtRestNonceForTests(0, suffix);
    expect(bytesEqual(n0, n0Again)).toBe(true);
  });

  it("composition helper rejects a malformed suffix length", () => {
    const badSuffix = new Uint8Array(3); // wrong length
    expect(() => __buildAtRestNonceForTests(0, badSuffix)).toThrow();
  });
});

/** Stable base64-ish string key for a nonce (no padding; bytes only). */
function nonceTag(nonce: Uint8Array): string {
  let s = "";
  for (let i = 0; i < nonce.length; i++) {
    s += nonce[i].toString(16).padStart(2, "0");
  }
  return s;
}

/** Read the big-endian uint64 counter at nonce[0..8) as a Number (safe < 2^53). */
function readCounter(nonce: Uint8Array): number {
  // DataView on the nonce's underlying buffer at the nonce's byteOffset.
  const view = new DataView(
    nonce.buffer,
    nonce.byteOffset,
    nonce.byteLength,
  );
  const hi = view.getUint32(0);
  const lo = view.getUint32(4);
  return hi * 0x100000000 + lo;
}
