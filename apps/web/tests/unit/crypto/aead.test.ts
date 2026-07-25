import { describe, expect, it } from "vitest";

import {
  CryptoErrorCode,
  decryptFrame,
  encryptFrame,
  generateAtRestKey,
  ReplayWindow,
} from "@/features/chat/crypto";
import { deriveNonce } from "@/features/chat/protocol/codec";
import {
  GCM_NONCE_BYTES,
  PROTOCOL_VERSION,
  REPLAY_WINDOW_SEQUENCES,
} from "@/features/chat/protocol/limits";
import { FrameType } from "@/features/chat/protocol/types";
import type { FrameAad, SessionId } from "@/features/chat/protocol/types";

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
});
