import { p256 } from "@noble/curves/p256";

import { encodePublicKey, encodeSignature, encodeTranscript } from "../protocol/codec";
import { SIGNATURE_BYTES } from "../protocol/limits";
import type { PublicKey, Signature, Transcript } from "../protocol/types";

import { CryptoError, CryptoErrorCode } from "./errors";
import { sha256 } from "./primitives";
import type { IdentityKeyPair } from "./types";

export async function generateIdentityKeyPair(): Promise<IdentityKeyPair> {
  const privateKey = p256.utils.randomSecretKey();
  const publicKey = derivePublicKeyFromPrivate(privateKey);
  return {
    publicKey,
    privateKey,
    sign: (transcript: Transcript): Promise<Signature> => signTranscript(privateKey, transcript),
  };
}

/**
 * Derive the 65-byte uncompressed SEC1 P-256 public key from a private scalar.
 * Used to recompute the public half when only the private key is available —
 * e.g. when adopting an imported bundle's device identity (the bundle stores
 * only the private scalar; the public key is reproducible from the curve).
 *
 * Mirrors the path used by {@link generateIdentityKeyPair} and the ephemeral
 * keypair generator in `session.ts`: `p256.getPublicKey(secret, false)` yields
 * the uncompressed point, then {@link encodePublicKey} validates on-curve and
 * brands it.
 */
export function derivePublicKeyFromPrivate(privateKey: Uint8Array): PublicKey {
  return encodePublicKey(p256.getPublicKey(privateKey, false));
}

export async function signTranscript(
  privateKey: Uint8Array,
  transcript: Transcript,
): Promise<Signature> {
  const digest = await sha256(encodeTranscript(transcript));
  const signature = p256.sign(digest, privateKey);
  return encodeSignature(signature.toBytes("compact"));
}

export async function verifyTranscript(
  publicKey: PublicKey,
  signature: Signature,
  transcript: Transcript,
): Promise<boolean> {
  if (signature.length !== SIGNATURE_BYTES) {
    throw new CryptoError(
      CryptoErrorCode.InvalidArgument,
      `signature must be ${SIGNATURE_BYTES} bytes, got ${signature.length}`,
    );
  }
  const digest = await sha256(encodeTranscript(transcript));
  return p256.verify(signature, digest, publicKey, { format: "compact" });
}
