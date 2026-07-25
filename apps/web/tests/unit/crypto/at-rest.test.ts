import { describe, expect, it } from "vitest";

import {
  CryptoErrorCode,
  decryptAtRest,
  encryptAtRest,
  generateAtRestKey,
  unwrapKey,
  wrapKey,
} from "@/features/chat/crypto";
import type { WrappedKey } from "@/features/chat/crypto";

import { bytesEqual } from "./_helpers";

function asWrappedKey(bytes: Uint8Array): WrappedKey {
  return bytes as unknown as WrappedKey;
}

const PLAINTEXT = new TextEncoder().encode("secret persisted message");

describe("generateAtRestKey (AES-256, extractable raw bytes)", () => {
  it("produces a 32-byte key", () => {
    expect(generateAtRestKey().length).toBe(32);
  });

  it("produces fresh keys on every call", () => {
    const a = generateAtRestKey();
    const b = generateAtRestKey();
    expect(bytesEqual(a, b)).toBe(false);
  });
});

describe("encryptAtRest / decryptAtRest (AES-256-GCM at-rest)", () => {
  it("round-trips plaintext", async () => {
    const key = generateAtRestKey();
    const enc = await encryptAtRest(key, PLAINTEXT);
    expect(enc.nonce.length).toBe(12);
    expect(bytesEqual(enc.ciphertext, PLAINTEXT)).toBe(false);
    const dec = await decryptAtRest(key, enc.nonce, enc.ciphertext);
    expect(bytesEqual(dec, PLAINTEXT)).toBe(true);
  });

  it("uses a fresh random nonce per encryption", async () => {
    const key = generateAtRestKey();
    const a = await encryptAtRest(key, PLAINTEXT);
    const b = await encryptAtRest(key, PLAINTEXT);
    expect(bytesEqual(a.nonce, b.nonce)).toBe(false);
    expect(bytesEqual(a.ciphertext, b.ciphertext)).toBe(false);
  });

  it("fails to decrypt with the wrong key", async () => {
    const key = generateAtRestKey();
    const other = generateAtRestKey();
    const enc = await encryptAtRest(key, PLAINTEXT);
    await expect(decryptAtRest(other, enc.nonce, enc.ciphertext)).rejects.toMatchObject({
      code: CryptoErrorCode.AuthenticationFailed,
    });
  });

  it("fails to decrypt tampered ciphertext", async () => {
    const key = generateAtRestKey();
    const enc = await encryptAtRest(key, PLAINTEXT);
    const tampered = new Uint8Array(enc.ciphertext);
    tampered[0] ^= 0xff;
    await expect(decryptAtRest(key, enc.nonce, tampered)).rejects.toMatchObject({
      code: CryptoErrorCode.AuthenticationFailed,
    });
  });

  it("rejects a malformed nonce length", async () => {
    const key = generateAtRestKey();
    const enc = await encryptAtRest(key, PLAINTEXT);
    await expect(decryptAtRest(key, new Uint8Array(11), enc.ciphertext)).rejects.toMatchObject({
      code: CryptoErrorCode.InvalidArgument,
    });
  });
});

describe("wrapKey / unwrapKey (Argon2id, RFC 9106)", () => {
  it("round-trips an at-rest key under a passphrase", async () => {
    const key = generateAtRestKey();
    const wrapped = await wrapKey("correct horse battery staple", key);
    const recovered = await unwrapKey("correct horse battery staple", wrapped);
    expect(bytesEqual(recovered, key)).toBe(true);
  });

  it("wrapped key bytes differ from the raw key", async () => {
    const key = generateAtRestKey();
    const wrapped = await wrapKey("passphrase", key);
    expect(wrapped.length).not.toBe(key.length);
    expect(bytesEqual(wrapped.subarray(0, key.length), key)).toBe(false);
  });

  it("fails with the wrong passphrase", async () => {
    const key = generateAtRestKey();
    const wrapped = await wrapKey("right passphrase", key);
    await expect(unwrapKey("wrong passphrase", wrapped)).rejects.toMatchObject({
      code: CryptoErrorCode.WrongPassphrase,
    });
  });

  it("produces distinct wrapped blobs for distinct passphrases (random salt)", async () => {
    const key = generateAtRestKey();
    const a = await wrapKey("passphrase one", key);
    const b = await wrapKey("passphrase two", key);
    expect(bytesEqual(a, b)).toBe(false);
  });

  it("rejects a malformed wrapped blob", async () => {
    await expect(unwrapKey("x", asWrappedKey(new Uint8Array(10)))).rejects.toMatchObject({
      code: CryptoErrorCode.InvalidArgument,
    });
  });
});
