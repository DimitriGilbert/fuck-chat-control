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

/**
 * Sign an arbitrary byte string with an identity private key, producing the
 * 64-byte IEEE P1363 (`r ‖ s`) signature the protocol carries (protocol-v1
 * §2.2). This is the exact primitive {@link signTranscript} applies to the
 * encoded transcript — factored out so the group-membership layer can sign
 * its canonical payload (protocol-v2 §4.1) through the same code path.
 */
export async function signMessage(privateKey: Uint8Array, message: Uint8Array): Promise<Signature> {
  const digest = await sha256(message);
  const signature = p256.sign(digest, privateKey);
  return encodeSignature(signature.toBytes("compact"));
}

/**
 * Verify a {@link signMessage} signature against an identity public key.
 * Mirrors {@link verifyTranscript}: a wrong-length signature is a usage error
 * (throws), a well-formed signature that fails verification returns `false`.
 */
export async function verifyMessage(
  publicKey: PublicKey,
  signature: Signature,
  message: Uint8Array,
): Promise<boolean> {
  if (signature.length !== SIGNATURE_BYTES) {
    throw new CryptoError(
      CryptoErrorCode.InvalidArgument,
      `signature must be ${SIGNATURE_BYTES} bytes, got ${signature.length}`,
    );
  }
  const digest = await sha256(message);
  return p256.verify(signature, digest, publicKey, { format: "compact" });
}

export async function signTranscript(
  privateKey: Uint8Array,
  transcript: Transcript,
): Promise<Signature> {
  return signMessage(privateKey, encodeTranscript(transcript));
}

export async function verifyTranscript(
  publicKey: PublicKey,
  signature: Signature,
  transcript: Transcript,
): Promise<boolean> {
  return verifyMessage(publicKey, signature, encodeTranscript(transcript));
}
