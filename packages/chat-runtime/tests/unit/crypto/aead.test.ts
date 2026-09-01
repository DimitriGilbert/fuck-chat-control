import { describe, expect, it } from "vitest";

import {
  CryptoErrorCode,
  decryptFrame,
  encryptFrame,
  generateAtRestKey,
  ReplayWindow,
} from "@fuck-eu-chat-control/chat-runtime/crypto";
import { deriveNonce } from "@fuck-eu-chat-control/chat-runtime/protocol/codec";
import {
  GCM_NONCE_BYTES,
  PROTOCOL_VERSION,
  REPLAY_WINDOW_SEQUENCES,
} from "@fuck-eu-chat-control/chat-runtime/protocol/limits";
import { FrameType } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import type { FrameAad, SessionId } from "@fuck-eu-chat-control/chat-runtime/protocol/types";

import { bytesEqual, sessionId } from "./_helpers";

function textAad(sender: SessionId, sequence: number): FrameAad {
  return {
    protocolVersion: PROTOCOL_VERSION,
    senderSessionId: sender,
    senderSequence: sequence,
    frameType: FrameType.Text,
    transferId: 0,
    chunkId: 0,
  };
}

const PLAINTEXT = new TextEncoder().encode("hello world");

describe("encryptFrame / decryptFrame (AES-256-GCM, NIST SP 800-38D)", () => {
  it("round-trips a text frame", async () => {
    const key = generateAtRestKey();
    const sender = sessionId(1);
    const aad = textAad(sender, 0);
    const enc = await encryptFrame(key, aad, PLAINTEXT);
    expect(enc.nonce.length).toBe(GCM_NONCE_BYTES);
    const window = new ReplayWindow();
    const dec = await decryptFrame(key, window, aad, enc.nonce, enc.ciphertext);
    expect(dec.length).toBe(PLAINTEXT.length);
    expect(bytesEqual(dec, PLAINTEXT)).toBe(true);
  });

  it("derives the nonce deterministically from sender session id and sequence", async () => {
    const key = generateAtRestKey();
    const sender = sessionId(7);
    const aad = textAad(sender, 42);
    const enc = await encryptFrame(key, aad, PLAINTEXT);
    expect(bytesEqual(enc.nonce, deriveNonce(sender, 42))).toBe(true);
  });

  it("LW-20: identical (senderSessionId, sequence) derive identical nonces (deterministic contract)", async () => {
    // LW-20 (Phase 7b): framing nonces are DETERMINISTIC — derived as a pure
    // function of (senderSessionId, sequence) — NOT random. This is the
    // contract that makes the replay-protection window sound: the receiver
    // derives the same nonce for a given (id, seq) and the AEAD tag binds it.
    // Document the contract by encrypting TWICE with identical (id, seq) and
    // asserting the nonces (and thus the ciphertexts, given the same key and
    // AAD) are byte-equal. A regression that injected randomness here would
    // break nonce uniqueness tracking and must surface loudly.
    const key = generateAtRestKey();
    const sender = sessionId(9);
    const aad = textAad(sender, 17);
    const first = await encryptFrame(key, aad, PLAINTEXT);
    const second = await encryptFrame(key, aad, PLAINTEXT);
    expect(bytesEqual(first.nonce, second.nonce)).toBe(true);
    // Same key + same nonce + same AAD + same plaintext → same ciphertext.
    expect(bytesEqual(first.ciphertext, second.ciphertext)).toBe(true);
    // Cross-check against the explicit derivation to make the contract explicit.
    expect(bytesEqual(first.nonce, deriveNonce(sender, 17))).toBe(true);
  });

  it("rejects a tampered ciphertext (GCM tag)", async () => {
    const key = generateAtRestKey();
    const aad = textAad(sessionId(1), 0);
    const enc = await encryptFrame(key, aad, PLAINTEXT);
    const tampered = new Uint8Array(enc.ciphertext);
    tampered[0] ^= 0xff;
    const window = new ReplayWindow();
    await expect(decryptFrame(key, window, aad, enc.nonce, tampered)).rejects.toMatchObject({
      code: CryptoErrorCode.AuthenticationFailed,
    });
  });

  it("rejects decryption with the wrong key", async () => {
    const key = generateAtRestKey();
    const other = generateAtRestKey();
    const aad = textAad(sessionId(1), 0);
    const enc = await encryptFrame(key, aad, PLAINTEXT);
    const window = new ReplayWindow();
    await expect(decryptFrame(other, window, aad, enc.nonce, enc.ciphertext)).rejects.toMatchObject(
      {
        code: CryptoErrorCode.AuthenticationFailed,
      },
    );
  });

  it("rejects a nonce that does not match the derived nonce", async () => {
    const key = generateAtRestKey();
    const aad = textAad(sessionId(1), 5);
    const enc = await encryptFrame(key, aad, PLAINTEXT);
    const wrongNonce = new Uint8Array(enc.nonce);
    wrongNonce[0] ^= 0xff;
    const window = new ReplayWindow();
    await expect(decryptFrame(key, window, aad, wrongNonce, enc.ciphertext)).rejects.toMatchObject({
      code: CryptoErrorCode.AuthenticationFailed,
    });
  });

  it("rejects an out-of-range sequence", async () => {
    const key = generateAtRestKey();
    const aad = textAad(sessionId(1), 0);
    await expect(
      encryptFrame(key, { ...aad, senderSequence: -1 }, PLAINTEXT),
    ).rejects.toMatchObject({
      code: CryptoErrorCode.InvalidArgument,
    });
  });
});

describe("ReplayWindow (bounded sliding window, size from limits.ts)", () => {
  it("accepts monotonically increasing sequences", () => {
    const w = new ReplayWindow();
    w.observe(0);
    w.observe(1);
    w.observe(2);
    w.observe(REPLAY_WINDOW_SEQUENCES);
  });

  it("rejects a duplicate sequence", () => {
    const w = new ReplayWindow();
    w.observe(5);
    expect(() => w.observe(5)).toThrowError(/replay_duplicate/);
  });

  it("accepts an older but in-window sequence once, then rejects the duplicate", () => {
    const w = new ReplayWindow(8);
    w.observe(10);
    w.observe(7);
    expect(() => w.observe(7)).toThrowError(/replay_duplicate/);
  });

  it("rejects a sequence older than the window", () => {
    const w = new ReplayWindow(8);
    w.observe(100);
    expect(() => w.observe(100 - 8)).toThrowError(/replay_stale/);
  });

  it("rejects an out-of-range sequence value", () => {
    const w = new ReplayWindow();
    expect(() => w.observe(-1)).toThrowError(/invalid_argument/);
    expect(() => w.observe(0x100000000)).toThrowError(/invalid_argument/);
  });

  it("resets the window when a very large advance occurs", () => {
    const w = new ReplayWindow(4);
    w.observe(5);
    w.observe(6);
    w.observe(5 + 100);
    expect(() => w.observe(6)).toThrowError(/replay_stale/);
  });
});

describe("decryptFrame replay rejection (NIST SP 800-38D + anti-replay)", () => {
  it("rejects a replayed sequence number", async () => {
    const key = generateAtRestKey();
    const sender = sessionId(3);
    const aad = textAad(sender, 1);
    const enc = await encryptFrame(key, aad, PLAINTEXT);
    const window = new ReplayWindow();
    await decryptFrame(key, window, aad, enc.nonce, enc.ciphertext);
    await expect(decryptFrame(key, window, aad, enc.nonce, enc.ciphertext)).rejects.toMatchObject({
      code: CryptoErrorCode.ReplayDuplicate,
    });
  });

  it("rejects a stale frame that falls outside the window", async () => {
    const key = generateAtRestKey();
    const sender = sessionId(3);
    const window = new ReplayWindow(8);
    const high = await encryptFrame(key, textAad(sender, 100), PLAINTEXT);
    await decryptFrame(key, window, textAad(sender, 100), high.nonce, high.ciphertext);
    const stale = await encryptFrame(key, textAad(sender, 100 - 8), PLAINTEXT);
    await expect(
      decryptFrame(key, window, textAad(sender, 100 - 8), stale.nonce, stale.ciphertext),
    ).rejects.toMatchObject({ code: CryptoErrorCode.ReplayStale });
  });

  it("does NOT advance the replay window when AEAD auth fails (R1/F1 + R3/F1)", async () => {
    // Discriminating variant. With a SMALL window (size 8), a forged frame at
    // sequence 50 that fails AEAD auth must NOT advance `highest`. If observe()
    // ran before aesGcmDecrypt (the bug), `highest` would jump to 50 and any
    // subsequent legit frame whose sequence falls in [0, 50-size] would be
    // rejected as replay_stale — silently dropping the next real frame.
    // With the fix, `highest` stays -1, so the legit frame at sequence 0 is
    // accepted as new.
    const key = generateAtRestKey();
    const other = generateAtRestKey();
    const sender = sessionId(3);
    const window = new ReplayWindow(8);
    // Forge at sequence 50 with the correct key, then attempt decrypt with the
    // WRONG key so AEAD authentication fails.
    const forgedAad = textAad(sender, 50);
    const forgedEnc = await encryptFrame(key, forgedAad, PLAINTEXT);
    await expect(
      decryptFrame(other, window, forgedAad, forgedEnc.nonce, forgedEnc.ciphertext),
    ).rejects.toMatchObject({ code: CryptoErrorCode.AuthenticationFailed });
    // Under the FIX: `highest` stayed -1, so observe(0) accepts sequence 0 as
    // new and the frame decrypts cleanly.
    // Under the BUG: `highest` was poisoned to 50, so observe(0) throws
    // replay_stale (offset 50 >= size 8) and decryptFrame rejects — the assert
    // below would fail with an unhandled replay_stale rejection.
    const legitAad = textAad(sender, 0);
    const legitEnc = await encryptFrame(key, legitAad, PLAINTEXT);
    const dec = await decryptFrame(key, window, legitAad, legitEnc.nonce, legitEnc.ciphertext);
    expect(bytesEqual(dec, PLAINTEXT)).toBe(true);
  });
});
