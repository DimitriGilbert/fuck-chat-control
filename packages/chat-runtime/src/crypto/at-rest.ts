import { argon2id } from "hash-wasm";

import { GCM_NONCE_BYTES } from "../protocol/limits";

import { CryptoError, CryptoErrorCode } from "./errors";
import { aesGcmDecrypt, aesGcmEncrypt, randomBytes, toAESKey, zeroize } from "./primitives";
import type { AtRestKey, WrappedKey } from "./types";

const ARGON2_MEMORY_KIB = 65536;
const ARGON2_ITERATIONS = 3;
const ARGON2_PARALLELISM = 1;
const ARGON2_SALT_BYTES = 16;
const AES_KEY_BYTES = 32;
const GCM_TAG_BYTES = 16;
const WRAPPED_SALT_OFFSET = 0;
const WRAPPED_NONCE_OFFSET = ARGON2_SALT_BYTES;
const WRAPPED_CIPHERTEXT_OFFSET = ARGON2_SALT_BYTES + GCM_NONCE_BYTES;
const WRAPPED_TOTAL_BYTES = ARGON2_SALT_BYTES + GCM_NONCE_BYTES + AES_KEY_BYTES + GCM_TAG_BYTES;
const EMPTY_AAD = new Uint8Array(0);

/**
 * R1:F1 — at-rest nonce uniqueness. Each {@link encryptAtRest}/{@link wrapKey}
 * call samples a FRESH uniformly-random 96-bit (12-byte) nonce from
 * `crypto.getRandomValues`. This is the NIST SP 800-38D §8.2.1 RBG-based
 * construction: it is stateless, so a page reload CANNOT reset any counter and
 * force a nonce reuse under the persisted message-history key (the original
 * failure mode, where a module-scoped counter reset to 0 on reload and collided
 * across two sessions with probability ~2^-32 per pair). The nonce is stored
 * per-record in the at-rest envelope, so decryption needs no shared state.
 *
 * Collision bound: for n records under one key the expected number of colliding
 * pairs is n(n-1)/2^97. At n = 10^6 messages that is ~8e-15 — for all practical
 * histories this is dominated by every other risk in the system. AES-GCM's
 * documented safety ceiling under random nonces is 2^32 encryptions per key
 * (96-bit tag-collision + birthday on the 96-bit nonce space); a chat history
 * will never approach that, and the key is per-install anyway.
 *
 * Why this over a persisted per-key counter (Option B): the only in-scope
 * callers (`in-memory-repo.appendMessage`, `export-bundle`) have NO stable
 * monotonic per-record id at encryption time, and threading a persisted
 * counter through them would require modifying the store layer (out of scope).
 * A stateless random nonce has the smallest blast radius (no new state, no
 * signature changes, no durability-before-write ordering hazard) while making
 * the reload-reuse class of bugs impossible by construction.
 *
 * Why this over the previous `[counter(8) | sessionSuffix(4)]` construction:
 * the old counter was module-scoped and reset on reload, so two reloads shared
 * counter=0 and relied on a 4-byte random suffix for separation (2^-32). The
 * new construction has 96 bits of freshness per record and zero dependence on
 * in-memory or persisted state.
 */

/**
 * Sample a fresh 12-byte at-rest nonce from the platform CSPRNG. The nonce is
 * unique-by-randomness per record; no module-scoped counter is involved.
 *
 * @internal exported for tests so the nonce length can be asserted directly.
 */
export function __freshAtRestNonceForTests(): Uint8Array {
  return randomBytes(GCM_NONCE_BYTES);
}

/**
 * Allocate a fresh at-rest nonce: 12 uniformly-random bytes. Each call draws
 * new randomness, so two calls (even after a reload) collide with probability
 * ~2^-96 — making GCM nonce reuse under the persistent message-history key
 * impossible by construction rather than merely unlikely.
 */
function nextAtRestNonce(): Uint8Array {
  return randomBytes(GCM_NONCE_BYTES);
}

export interface AtRestCiphertext {
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
}

export function generateAtRestKey(): AtRestKey {
  return toAESKey(randomBytes(AES_KEY_BYTES));
}

export async function encryptAtRest(
  key: AtRestKey,
  plaintext: Uint8Array,
  aad?: Uint8Array,
): Promise<AtRestCiphertext> {
  // R1:F1: fresh random 96-bit nonce per record. Stateless → survives reload
  // without reusing a nonce under the persisted key. See the file-level doc.
  const nonce = nextAtRestNonce();
  // R1:F2: when the caller supplies record-binding AAD, the GCM tag
  // authenticates the linkage between the sealed body and that metadata; no
  // `aad` seals against EMPTY_AAD (the legacy v0 record format, still used by
  // the key-wrap and export-bundle envelope paths, which bind nothing).
  const ciphertext = await aesGcmEncrypt(key, nonce, aad ?? EMPTY_AAD, plaintext);
  return { nonce, ciphertext };
}

/**
 * R1:F2 — record-binding AAD with a mandatory legacy fallback (the ONE
 * migration mechanism; documented here and pinned by unit tests in both
 * directions).
 *
 * Stored message records written since R1:F2 are sealed with a caller-supplied
 * AAD that canonically binds the row's conversation id + direction (built by
 * `messageRecordAad` in `store/message-record-aad.ts`). Records written before
 * the binding exist were sealed against EMPTY_AAD and MUST still decrypt, so
 * when `aad` is provided this function:
 *
 *   1. verifies against `aad` first (the v1 binding), and
 *   2. on an authentication failure retries ONCE against EMPTY_AAD (the
 *      legacy v0 binding), re-throwing the AuthenticationFailed error if that
 *      also fails.
 *
 * The fallback is one-directional and does NOT weaken the v1 binding: a record
 * sealed WITH an AAD was not sealed under EMPTY_AAD, so relocating it to a
 * different conversation/direction fails BOTH attempts. Only genuine legacy
 * rows authenticate under the fallback (they remain relocatable — the
 * documented residual window of the backward-compatibility requirement).
 */
export async function decryptAtRest(
  key: AtRestKey,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  aad?: Uint8Array,
): Promise<Uint8Array> {
  if (nonce.length !== GCM_NONCE_BYTES) {
    throw new CryptoError(
      CryptoErrorCode.InvalidArgument,
      `at-rest nonce must be ${GCM_NONCE_BYTES} bytes, got ${nonce.length}`,
    );
  }
  if (aad === undefined) {
    return aesGcmDecrypt(key, nonce, EMPTY_AAD, ciphertext);
  }
  try {
    return await aesGcmDecrypt(key, nonce, aad, ciphertext);
  } catch (err) {
    if (err instanceof CryptoError && err.code === CryptoErrorCode.AuthenticationFailed) {
      // R1:F2 migration: pre-binding records were sealed with empty AAD; give
      // them exactly one legacy attempt before surfacing the failure.
      return aesGcmDecrypt(key, nonce, EMPTY_AAD, ciphertext);
    }
    throw err;
  }
}

/**
 * Argon2id KDF parameters. When undefined, the module constants below are
 * used. The export/import bundle path passes the envelope's m/t/p (after
 * validation) so that bundles encrypted with different costs decrypt
 * correctly; the at-rest key wrap/unwrap path leaves this undefined to keep
 * the historical defaults.
 *
 * NOTE on units: {@link memorySizeKiB} is in KiB (hash-wasm's units). The
 * bundle envelope writes m in BYTES; the export-bundle caller converts
 * bytes→KiB (m / 1024) before constructing this object.
 */
export interface KdfParams {
  readonly memorySizeKiB: number;
  readonly iterations: number;
  readonly parallelism: number;
}

export async function deriveKeyFromPassphrase(
  passphrase: string,
  salt: Uint8Array,
  params?: KdfParams,
): Promise<AtRestKey> {
  const memorySize = params?.memorySizeKiB ?? ARGON2_MEMORY_KIB;
  const iterations = params?.iterations ?? ARGON2_ITERATIONS;
  const parallelism = params?.parallelism ?? ARGON2_PARALLELISM;
  const raw = await argon2id({
    password: passphrase,
    salt,
    memorySize,
    iterations,
    parallelism,
    hashLength: AES_KEY_BYTES,
    outputType: "binary",
  });
  // R1:F3: toAESKey copies its input, so wipe the argon2 raw output that is no
  // longer needed after the AESKey copy is produced.
  const key = toAESKey(raw);
  zeroize(raw);
  return key;
}

export async function wrapKey(passphrase: string, key: AtRestKey): Promise<WrappedKey> {
  const salt = randomBytes(ARGON2_SALT_BYTES);
  const wrappingKey = await deriveKeyFromPassphrase(passphrase, salt);
  // R1:F1: same fresh-random-nonce construction as encryptAtRest — one wrap per
  // passphrase set, so a random nonce makes reload reuse impossible and the
  // per-record envelope stores it for unwrap.
  const nonce = nextAtRestNonce();
  const ciphertext = await aesGcmEncrypt(wrappingKey, nonce, EMPTY_AAD, key);
  // R1:F3: the wrapping KEK is no longer needed after the single GCM seal
  // above; wipe it so it does not linger on the heap.
  zeroize(wrappingKey);
  const out = new Uint8Array(WRAPPED_TOTAL_BYTES);
  out.set(salt, WRAPPED_SALT_OFFSET);
  out.set(nonce, WRAPPED_NONCE_OFFSET);
  out.set(ciphertext, WRAPPED_CIPHERTEXT_OFFSET);
  return out as unknown as WrappedKey;
}

export async function unwrapKey(passphrase: string, wrapped: WrappedKey): Promise<AtRestKey> {
  if (wrapped.length !== WRAPPED_TOTAL_BYTES) {
    throw new CryptoError(
      CryptoErrorCode.InvalidArgument,
      `wrapped key must be ${WRAPPED_TOTAL_BYTES} bytes, got ${wrapped.length}`,
    );
  }
  const salt = wrapped.subarray(WRAPPED_SALT_OFFSET, WRAPPED_NONCE_OFFSET);
  const nonce = wrapped.subarray(WRAPPED_NONCE_OFFSET, WRAPPED_CIPHERTEXT_OFFSET);
  const ciphertext = wrapped.subarray(WRAPPED_CIPHERTEXT_OFFSET);
  const wrappingKey = await deriveKeyFromPassphrase(passphrase, salt);
  try {
    const raw = await aesGcmDecrypt(wrappingKey, nonce, EMPTY_AAD, ciphertext);
    // R1:F3: toAESKey copies its input, so wipe the decrypted raw key material
    // once the AESKey copy is produced.
    const key = toAESKey(raw);
    zeroize(raw);
    return key;
  } catch (err) {
    if (err instanceof CryptoError && err.code === CryptoErrorCode.AuthenticationFailed) {
      throw new CryptoError(
        CryptoErrorCode.WrongPassphrase,
        "wrong passphrase or corrupted wrapped key",
      );
    }
    throw err;
  } finally {
    // R1:F3: the wrapping KEK is no longer needed once the unwrap (or its auth
    // failure) has resolved; wipe it on every path.
    zeroize(wrappingKey);
  }
}
