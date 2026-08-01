import { argon2id } from "hash-wasm";

import { GCM_NONCE_BYTES } from "../protocol/limits";

import { CryptoError, CryptoErrorCode } from "./errors";
import { aesGcmDecrypt, aesGcmEncrypt, randomBytes, toAESKey } from "./primitives";
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
 * CR-10: nonce-uniqueness for the at-rest key. The nonce is composed as
 *   `[counterBytes(8) | randomBytes(4)]`  (12 bytes total = GCM_NONCE_BYTES)
 *
 * The 8-byte counter is a per-module monotonic value that increments on every
 * {@link encryptAtRest} and {@link wrapKey} call, guaranteeing uniqueness
 * WITHIN a session/key (the property the PRD's "uniqueness enforced" clause
 * calls out for at-rest). The 4-byte random suffix is sampled ONCE per module
 * load and makes the counter's starting output unpredictable across sessions,
 * so two sessions that both encrypt their first message do not produce
 * identical counter-prefixed nonces (cross-session collision resistance).
 *
 * v1 trade-off (documented honestly): the counter is module-scoped, not
 * persisted alongside the at-rest key, so a page reload resets it to 0. The
 * random 4-byte suffix is re-sampled on each load, so the cross-session
 * collision probability is ~2^-32 per (counter, session-suffix) pair —
 * astronomically unlikely for the rare wrapKey path (one wrap per passphrase
 * set) and the moderate encryptAtRest path (one encrypt per appended message).
 * The WITHIN-session uniqueness — the property that turns a catastrophic
 * GCM-nonce-reuse into an impossibility — is enforced loudly by the counter.
 *
 * Why the deterministic counter over an in-memory dedup Set: the counter
 * guarantees uniqueness by construction (no RNG-failure path that produces a
 * duplicate can exist), whereas the Set approach only DETECTS a duplicate
 * after the RNG already returned one. The framing path already uses a
 * deterministic counter+random-suffix nonce; this brings at-rest to parity.
 */
const NONCE_COUNTER_BYTES = 8;
const NONCE_RANDOM_SUFFIX_BYTES = GCM_NONCE_BYTES - NONCE_COUNTER_BYTES; // 4

/**
 * Per-module monotonic counter. Incremented on every at-rest encryption.
 * Number.isSafeInteger tops out at 2^53 - 1; the counter is serialized to 8
 * bytes (52 bits of headroom), so wrap-around is not a practical concern.
 */
let atRestNonceCounter = 0;
/**
 * Per-module-load random suffix. Re-sampled on every page reload so two
 * sessions cannot produce identical counter-prefixed nonces for the same key.
 */
const nonceSessionSuffix = randomBytes(NONCE_RANDOM_SUFFIX_BYTES);

/**
 * Build a 12-byte at-rest nonce from the monotonic counter and the
 * per-module-load random suffix. Returns a fresh Uint8Array each call.
 *
 * @internal exported for tests so the nonce-composition can be asserted.
 */
export function __buildAtRestNonceForTests(counter: number, suffix: Uint8Array): Uint8Array {
  if (suffix.length !== NONCE_RANDOM_SUFFIX_BYTES) {
    throw new CryptoError(
      CryptoErrorCode.InvalidArgument,
      `nonce suffix must be ${NONCE_RANDOM_SUFFIX_BYTES} bytes, got ${suffix.length}`,
    );
  }
  const out = new Uint8Array(GCM_NONCE_BYTES);
  // Write the counter as 8 big-endian bytes into [0..8). Big-endian keeps the
  // high bytes stable for a long time (counter grows from 0), so the prefix
  // is monotonic and the uniqueness property is obvious from inspection.
  const view = new DataView(out.buffer);
  view.setUint32(0, Math.floor(counter / 0x100000000));
  view.setUint32(4, counter >>> 0);
  out.set(suffix, NONCE_COUNTER_BYTES);
  return out;
}

/**
 * Allocate the next at-rest nonce: compose `[counter(8) | sessionSuffix(4)]`
 * and increment the counter. The returned nonce is guaranteed unique within
 * this module's lifetime (the counter is monotonic); the session-suffix makes
 * cross-session collisions astronomically unlikely (2^-32 per pair).
 */
function nextAtRestNonce(): Uint8Array {
  const nonce = __buildAtRestNonceForTests(atRestNonceCounter, nonceSessionSuffix);
  atRestNonceCounter += 1;
  return nonce;
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
): Promise<AtRestCiphertext> {
  // CR-10: deterministic per-key nonce = [counter(8) | sessionSuffix(4)].
  // See {@link nextAtRestNonce} for the uniqueness argument.
  const nonce = nextAtRestNonce();
  const ciphertext = await aesGcmEncrypt(key, nonce, EMPTY_AAD, plaintext);
  return { nonce, ciphertext };
}

export async function decryptAtRest(
  key: AtRestKey,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  if (nonce.length !== GCM_NONCE_BYTES) {
    throw new CryptoError(
      CryptoErrorCode.InvalidArgument,
      `at-rest nonce must be ${GCM_NONCE_BYTES} bytes, got ${nonce.length}`,
    );
  }
  return aesGcmDecrypt(key, nonce, EMPTY_AAD, ciphertext);
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
  return toAESKey(raw);
}

export async function wrapKey(passphrase: string, key: AtRestKey): Promise<WrappedKey> {
  const salt = randomBytes(ARGON2_SALT_BYTES);
  const wrappingKey = await deriveKeyFromPassphrase(passphrase, salt);
  // CR-10: same deterministic nonce construction as encryptAtRest. wrapKey is
  // rare (one wrap per passphrase set) so counter pressure is negligible, but
  // applying the same composition keeps the at-rest nonce story uniform.
  const nonce = nextAtRestNonce();
  const ciphertext = await aesGcmEncrypt(wrappingKey, nonce, EMPTY_AAD, key);
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
    return toAESKey(raw);
  } catch (err) {
    if (err instanceof CryptoError && err.code === CryptoErrorCode.AuthenticationFailed) {
      throw new CryptoError(
        CryptoErrorCode.WrongPassphrase,
        "wrong passphrase or corrupted wrapped key",
      );
    }
    throw err;
  }
}
