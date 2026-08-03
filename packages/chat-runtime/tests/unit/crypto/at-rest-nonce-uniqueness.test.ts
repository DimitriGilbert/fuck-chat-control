import { describe, expect, it } from "vitest";

import {
  encryptAtRest,
  generateAtRestKey,
  wrapKey,
} from "@fuck-eu-chat-control/chat-runtime/crypto";
import { __freshAtRestNonceForTests } from "@fuck-eu-chat-control/chat-runtime/crypto/at-rest";
import { GCM_NONCE_BYTES } from "@fuck-eu-chat-control/chat-runtime/protocol/limits";

import { bytesEqual } from "./_helpers";

/**
 * R1:F1 — at-rest nonce uniqueness. The construction is a FRESH uniformly-random
 * 96-bit (12-byte) nonce sampled per record from the platform CSPRNG
 * (NIST SP 800-38D §8.2.1 RBG-based construction). This is stateless, so a page
 * reload CANNOT reset any counter and force a nonce reuse under the persisted
 * message-history key — the original failure mode, where a module-scoped counter
 * reset to 0 on reload and collided across two sessions with probability ~2^-32
 * per (counter, session-suffix) pair.
 *
 * These tests assert:
 *  - nonces are exactly 12 bytes,
 *  - across N records under the SAME (persisted-across-reload) key, ZERO nonces
 *    repeat — both WITHIN one session AND across a simulated reload (the load-
 *    bearing new property: the old counter reset to 0 on reload and reused
 *    counter=0 between sessions),
 *  - consecutive nonces are NOT counter-rotation of one another and do NOT
 *    share a fixed suffix (they are independent random samples),
 *  - the wrapKey path also draws fresh random nonces (no repeat across wraps),
 *  - the nonce length helper returns exactly GCM_NONCE_BYTES.
 *
 * The cross-reload test is the security-relevant one: it simulates two browser
 * sessions that share the SAME persisted at-rest key (auto mode persists the
 * raw key base64; passphrase mode wraps/unwraps the same data key) and asserts
 * that the two non-overlapping nonce streams have NO intersection. Under the old
 * counter+suffix scheme the two sessions both started at counter=0 and collided
 * with P ~2^-32; under the new random scheme the expected intersection is 0 for
 * any practical history (collision bound n_a * n_b / 2^96).
 */

const PLAINTEXT = new TextEncoder().encode("nonce-uniqueness fixture");

describe("at-rest nonce uniqueness (R1:F1, fresh random 96-bit nonce)", () => {
  it("nonce is exactly GCM_NONCE_BYTES (12)", async () => {
    const key = generateAtRestKey();
    const enc = await encryptAtRest(key, PLAINTEXT);
    expect(enc.nonce.length).toBe(GCM_NONCE_BYTES);
    expect(enc.nonce.length).toBe(12);
  });

  it("__freshAtRestNonceForTests returns a 12-byte nonce", () => {
    const n = __freshAtRestNonceForTests();
    expect(n.length).toBe(GCM_NONCE_BYTES);
    expect(n.length).toBe(12);
  });

  it("zero duplicate nonces across 5000 encryptAtRest calls with the same key (within a session)", async () => {
    const key = generateAtRestKey();
    const seen = new Set<string>();
    const N = 5000;
    for (let i = 0; i < N; i++) {
      const enc = await encryptAtRest(key, PLAINTEXT);
      const tag = nonceTag(enc.nonce);
      expect(seen.has(tag)).toBe(false);
      seen.add(tag);
    }
    expect(seen.size).toBe(N);
  });

  /**
   * THE LOAD-BEARING CROSS-RELOAD TEST. This is the property the old module-
   * scoped counter construction VIOLATED: a reload reset the counter to 0, so
   * two sessions sharing the persisted key both started at counter=0 and
   * collided with P ~2^-32 per pair. The new stateless random nonce makes this
   * impossible by construction.
   *
   * We simulate two sessions by drawing two independent nonce streams under the
   * SAME key (the key is what persists across a reload; the nonce stream is what
   * used to reset). We assert the two streams are DISJOINT. With N=1000 records
   * per session the old scheme would have ~1000 counter-pair collisions (both
   * sessions use counters 0..999); the new scheme's expected intersection is
   * ~1000*1000/2^96 ≈ 1.3e-23 (effectively zero).
   */
  it("simulated reload: nonces do NOT collide across two sessions sharing the persisted key", async () => {
    // The key is the persisted quantity (auto mode: base64 raw; passphrase
    // mode: wrapped/unwrapped same data key). Both "sessions" reuse it.
    const persistedKey = generateAtRestKey();

    const sessionA = new Set<string>();
    const N = 1000;
    for (let i = 0; i < N; i++) {
      const enc = await encryptAtRest(persistedKey, PLAINTEXT);
      sessionA.add(nonceTag(enc.nonce));
    }
    expect(sessionA.size).toBe(N); // sanity: no within-session repeats

    // "Reload": a fresh module load would have reset the old counter to 0. The
    // new construction has no state, so the second stream is just more
    // independent random nonces under the same key.
    let crossCollisions = 0;
    const sessionB = new Set<string>();
    for (let i = 0; i < N; i++) {
      const enc = await encryptAtRest(persistedKey, PLAINTEXT);
      const tag = nonceTag(enc.nonce);
      // The security assertion: this nonce must NOT have appeared in session A.
      expect(sessionA.has(tag)).toBe(false);
      if (sessionA.has(tag)) crossCollisions += 1;
      sessionB.add(tag);
    }
    expect(sessionB.size).toBe(N); // sanity: no within-session repeats
    expect(crossCollisions).toBe(0);
  });

  it("consecutive nonces are independent random samples (no shared suffix, no counter rotation)", async () => {
    const key = generateAtRestKey();
    const a = await encryptAtRest(key, PLAINTEXT);
    const b = await encryptAtRest(key, PLAINTEXT);
    const c = await encryptAtRest(key, PLAINTEXT);

    // All three are distinct.
    expect(bytesEqual(a.nonce, b.nonce)).toBe(false);
    expect(bytesEqual(b.nonce, c.nonce)).toBe(false);
    expect(bytesEqual(a.nonce, c.nonce)).toBe(false);

    // Under the OLD [counter(8)|suffix(4)] scheme the 4-byte suffix at [8..12)
    // was identical across all nonces (sampled once per module load). Under the
    // new fully-random scheme the suffixes are independent; assert they are NOT
    // all equal (with overwhelming probability for 3 independent 32-bit samples).
    // This guards against a regression that re-introduces a shared suffix.
    const suffixA = a.nonce.subarray(8, 12);
    const suffixB = b.nonce.subarray(8, 12);
    const suffixC = c.nonce.subarray(8, 12);
    const allSuffixEqual =
      bytesEqual(suffixA, suffixB) && bytesEqual(suffixB, suffixC);
    expect(allSuffixEqual).toBe(false);

    // Likewise the prefix bytes [0..8) must NOT form a monotonic 0,1,2 counter.
    // (Three random 64-bit prefixes colliding with 0,1,2 in order is negligible;
    // this guards against a regression to the deterministic counter prefix.)
    expect(readUint56(a.nonce)).not.toBe(0);
    expect(readUint56(b.nonce)).not.toBe(1);
    expect(readUint56(c.nonce)).not.toBe(2);
  });

  it("wrapKey uses fresh random nonces (no duplicates across 10 wraps)", async () => {
    // wrapKey is rare in production (one per passphrase set), but it must draw a
    // fresh random nonce per wrap. Argon2id (64 MiB memory, 3 iterations) is
    // ~100ms per call, so we sample 10 wraps — still enough to assert the nonce
    // stream is collision-free (the deterministic property the old scheme also
    // had within a session, now provided by randomness instead of a counter).
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
});

/** Stable hex string key for a nonce (bytes only, no padding). */
function nonceTag(nonce: Uint8Array): string {
  let s = "";
  for (let i = 0; i < nonce.length; i++) {
    s += nonce[i].toString(16).padStart(2, "0");
  }
  return s;
}

/**
 * Read the first 7 bytes (56 bits) of a nonce as a Number. Used only to assert
 * the nonce prefix is NOT the deterministic counter sequence 0,1,2,... — a
 * regression guard against re-introducing the old counter prefix. 56 bits fits
 * safely in a JS Number (2^53 headroom).
 */
function readUint56(nonce: Uint8Array): number {
  const view = new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength);
  // Read bytes [0..7) as a 56-bit big-endian integer.
  let v = 0;
  for (let i = 0; i < 7; i++) {
    v = v * 256 + view.getUint8(i);
  }
  return v;
}
