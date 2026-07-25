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
  const nonce = randomBytes(GCM_NONCE_BYTES);
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

export async function deriveKeyFromPassphrase(
  passphrase: string,
  salt: Uint8Array,
): Promise<AtRestKey> {
  const raw = await argon2id({
    password: passphrase,
    salt,
    memorySize: ARGON2_MEMORY_KIB,
    iterations: ARGON2_ITERATIONS,
    parallelism: ARGON2_PARALLELISM,
    hashLength: AES_KEY_BYTES,
    outputType: "binary",
  });
  return toAESKey(raw);
}

export async function wrapKey(passphrase: string, key: AtRestKey): Promise<WrappedKey> {
  const salt = randomBytes(ARGON2_SALT_BYTES);
  const wrappingKey = await deriveKeyFromPassphrase(passphrase, salt);
  const nonce = randomBytes(GCM_NONCE_BYTES);
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
