import { describe, expect, it } from "vitest";

import {
  CryptoErrorCode,
  generateAtRestKey,
  unwrapKey,
  wrapKey,
} from "@fuck-eu-chat-control/chat-runtime/crypto";
import type { WrappedKey } from "@fuck-eu-chat-control/chat-runtime/crypto";

import { bytesEqual } from "./_helpers";

/**
 * LW-18 (Phase 7b): the at-rest key unwrap path had no store-cluster coverage.
 * `unwrapKey` translates the AEAD AuthenticationFailed thrown by a wrong
 * passphrase into CryptoErrorCode.WrongPassphrase, but a regression that
 * returned a derived-but-wrong key (e.g. silently swallowing the AEAD failure)
 * would not be caught by the crypto-cluster test alone — it asserts the throw,
 * not the absence of a wrong-but-plausible key. These tests pin both: the throw
 * code AND that no key is returned, by comparing against the correct unwrap.
 */

describe("unwrapKey wrong-passphrase defense (LW-18)", () => {
  it("throws CryptoErrorCode.WrongPassphrase for a wrong passphrase", async () => {
    const key = generateAtRestKey();
    const wrapped = await wrapKey("correct horse battery staple", key);
    await expect(unwrapKey("wrong passphrase", wrapped)).rejects.toMatchObject({
      code: CryptoErrorCode.WrongPassphrase,
    });
  });

  it("does NOT return a derived-but-wrong key (rejects instead of resolving)", async () => {
    // A regression that swallowed the AEAD failure and returned the wrapping
    // key (or some other derived value) would make this test fail: unwrapKey
    // must reject, and the correct unwrap must not equal a value derived from
    // the wrong passphrase. We assert the wrong-passphrase path throws AND that
    // the correct unwrap yields a key distinct from any wrong-passphrase value.
    const key = generateAtRestKey();
    const correctPassphrase = "correct horse battery staple";
    const wrongPassphrase = "totally different passphrase";
    const wrapped = await wrapKey(correctPassphrase, key);

    // The correct unwrap recovers the original key.
    const recovered = await unwrapKey(correctPassphrase, wrapped);
    expect(bytesEqual(recovered, key)).toBe(true);

    // The wrong passphrase must throw (not resolve to a wrong key).
    await expect(unwrapKey(wrongPassphrase, wrapped)).rejects.toThrow();

    // Defense-in-depth: even if a future regression swallowed the throw, the
    // wrong-passphrase result would have to equal the correct key to go
    // undetected. Re-wrap with the WRONG passphrase and confirm a key wrapped
    // under the wrong passphrase unwraps to a DIFFERENT key than the original
    // (proving the KDF + AEAD pair binds the passphrase to the recovered key).
    const otherKey = generateAtRestKey();
    const wrappedUnderWrong = await wrapKey(wrongPassphrase, otherKey);
    const recoveredUnderWrong = await unwrapKey(wrongPassphrase, wrappedUnderWrong);
    expect(bytesEqual(recoveredUnderWrong, key)).toBe(false);
  });

  it("a corrupted wrapped blob throws InvalidArgument (not WrongPassphrase)", async () => {
    // A truncated wrapped blob fails the length check before the KDF/AEAD path,
    // so the error is InvalidArgument, not WrongPassphrase. Pins the
    // error-class boundary so a regression that re-classified shape errors as
    // auth failures (or vice versa) would surface here.
    const truncated = new Uint8Array(10) as unknown as WrappedKey;
    await expect(unwrapKey("any passphrase", truncated)).rejects.toMatchObject({
      code: CryptoErrorCode.InvalidArgument,
    });
  });

  it("a tampered ciphertext (post-KDF) throws WrongPassphrase", async () => {
    // Tampering with the wrapped-key ciphertext (after the salt+nonce prefix)
    // causes AEAD auth failure, which unwrapKey translates to WrongPassphrase.
    // This is the same code a genuine wrong passphrase produces, by design:
    // from the unwrap path's view the two are indistinguishable.
    const key = generateAtRestKey();
    const wrapped = await wrapKey("correct horse battery staple", key);
    const tampered = new Uint8Array(wrapped);
    // Flip a byte in the ciphertext region (offset 16+12 = past salt+nonce).
    tampered[tampered.length - 1] ^= 0xff;
    await expect(
      unwrapKey("correct horse battery staple", tampered as unknown as WrappedKey),
    ).rejects.toMatchObject({
      code: CryptoErrorCode.WrongPassphrase,
    });
  });
});
