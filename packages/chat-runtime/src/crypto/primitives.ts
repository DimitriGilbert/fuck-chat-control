import { CryptoError, CryptoErrorCode } from "./errors";
import type { AESKey } from "./types";

const AES_KEY_BYTES = 32;
const GCM_TAG_BITS = 128;

function toBuffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

export function randomBytes(length: number): Uint8Array {
  if (!Number.isInteger(length) || length < 0) {
    throw new CryptoError(
      CryptoErrorCode.InvalidArgument,
      `randomBytes length must be a non-negative integer, got ${length}`,
    );
  }
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out);
  return out;
}

export function toAESKey(bytes: Uint8Array): AESKey {
  if (bytes.length !== AES_KEY_BYTES) {
    throw new CryptoError(
      CryptoErrorCode.InvalidArgument,
      `AES-256 key must be ${AES_KEY_BYTES} bytes, got ${bytes.length}`,
    );
  }
  const copy = new Uint8Array(AES_KEY_BYTES);
  copy.set(bytes);
  return copy as unknown as AESKey;
}

/**
 * Best-effort key zeroization: overwrite the byte range backing `buf` with
 * zeros. Operates on the underlying buffer slice the view exposes (honors
 * `byteOffset`/`byteLength`) so it wipes exactly the secret bytes the caller
 * handed in, even for a subarray view of a larger buffer. Best-effort in JS —
 * a copy retained by the GC or by the runtime's buffer management is not
 * reached — but bounds the lifetime of the live secret bytes to the explicit
 * wipe site rather than leaving them in the heap until GC. Reuse this for all
 * local key-bearing `Uint8Array`s that go out of scope after use.
 */
export function zeroize(buf: Uint8Array | ArrayBufferView): void {
  const byteOffset = buf.byteOffset;
  const byteLength = buf.byteLength;
  // Always go through a Uint8Array view over the exact byte range so the call
  // works for any ArrayBufferView (Uint8Array, DataView, typed arrays) and for
  // a subarray view of a larger buffer.
  const view = new Uint8Array(buf.buffer, byteOffset, byteLength);
  for (let i = 0; i < byteLength; i++) {
    view[i] = 0;
  }
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", toBuffer(data));
  return new Uint8Array(digest);
}

export async function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  lengthBytes: number,
): Promise<Uint8Array> {
  if (!Number.isInteger(lengthBytes) || lengthBytes <= 0) {
    throw new CryptoError(
      CryptoErrorCode.InvalidArgument,
      `hkdf length must be a positive integer, got ${lengthBytes}`,
    );
  }
  const baseKey = await globalThis.crypto.subtle.importKey("raw", toBuffer(ikm), "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await globalThis.crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: toBuffer(salt), info: toBuffer(info) },
    baseKey,
    lengthBytes * 8,
  );
  return new Uint8Array(bits);
}

/**
 * HMAC-SHA256. Used for the PAKE confirmation MAC: the tag is computed over
 * the transcript hash, keyed by an HKDF-derived confirmation key seeded with
 * the SPAKE2 shared secret. Because the SPAKE2 secret is identical iff the two
 * codes match, a tag mismatch proves a wrong-code attack.
 */
export async function hmacSha256(key: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    "raw",
    toBuffer(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await globalThis.crypto.subtle.sign("HMAC", cryptoKey, toBuffer(message));
  return new Uint8Array(sig);
}

async function importAesGcmKey(key: AESKey): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey("raw", toBuffer(key), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function aesGcmEncrypt(
  key: AESKey,
  nonce: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const cryptoKey = await importAesGcmKey(key);
  const buf = await globalThis.crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: toBuffer(nonce),
      additionalData: toBuffer(aad),
      tagLength: GCM_TAG_BITS,
    },
    cryptoKey,
    toBuffer(plaintext),
  );
  return new Uint8Array(buf);
}

export async function aesGcmDecrypt(
  key: AESKey,
  nonce: Uint8Array,
  aad: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  const cryptoKey = await importAesGcmKey(key);
  try {
    const buf = await globalThis.crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: toBuffer(nonce),
        additionalData: toBuffer(aad),
        tagLength: GCM_TAG_BITS,
      },
      cryptoKey,
      toBuffer(ciphertext),
    );
    return new Uint8Array(buf);
  } catch {
    throw new CryptoError(
      CryptoErrorCode.AuthenticationFailed,
      "AES-GCM authentication tag verification failed",
    );
  }
}
