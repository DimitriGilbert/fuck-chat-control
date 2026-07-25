import { p256 } from "@noble/curves/p256";

import { encodePublicKey, encodeSignature, encodeTranscript } from "../protocol/codec";
import { SIGNATURE_BYTES } from "../protocol/limits";
import type { PublicKey, Signature, Transcript } from "../protocol/types";

import { CryptoError, CryptoErrorCode } from "./errors";
import { sha256 } from "./primitives";
import type { IdentityKeyPair } from "./types";

export async function generateIdentityKeyPair(): Promise<IdentityKeyPair> {
  const privateKey = p256.utils.randomSecretKey();
  const publicKey = encodePublicKey(p256.getPublicKey(privateKey, false));
  return {
    publicKey,
    privateKey,
    sign: (transcript: Transcript): Promise<Signature> => signTranscript(privateKey, transcript),
  };
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
