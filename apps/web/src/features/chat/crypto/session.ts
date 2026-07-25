import { p256 } from "@noble/curves/p256";

import { deriveRole, encodePublicKey, encodeTranscript } from "../protocol/codec";
import { HKDF_TRAFFIC_KEY_BYTES, INIT_TO_RESP_LABEL, RESP_TO_INIT_LABEL } from "../protocol/limits";
import { ProtocolError, ProtocolErrorCode } from "../protocol/errors";
import { Role } from "../protocol/types";
import type { PublicKey, Transcript } from "../protocol/types";

import { CryptoError, CryptoErrorCode } from "./errors";
import { hkdfSha256, sha256, toAESKey } from "./primitives";
import type { DeriveSessionKeysInput, EphemeralKeyPair, SessionKeys } from "./types";

const ECDH_X_OFFSET = 1;
const ECDH_X_BYTES = 32;

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export async function generateEphemeralKeyPair(): Promise<EphemeralKeyPair> {
  const privateKey = p256.utils.randomSecretKey();
  const publicKey = encodePublicKey(p256.getPublicKey(privateKey, false));
  return { publicKey, privateKey };
}

function resolvePeerIdentity(transcript: Transcript, localIdentityPublicKey: PublicKey): PublicKey {
  const isInitiator = bytesEqual(transcript.initiatorIdentityKey, localIdentityPublicKey);
  if (isInitiator) return transcript.responderIdentityKey;
  const isResponder = bytesEqual(transcript.responderIdentityKey, localIdentityPublicKey);
  if (isResponder) return transcript.initiatorIdentityKey;
  throw new CryptoError(
    CryptoErrorCode.IdentityNotInTranscript,
    "local identity public key is not a party to the transcript",
  );
}

export async function deriveSessionKeys(input: DeriveSessionKeysInput): Promise<SessionKeys> {
  const peerIdentity = resolvePeerIdentity(input.transcript, input.localIdentityPublicKey);
  let role: ReturnType<typeof deriveRole>;
  try {
    role = deriveRole(input.localIdentityPublicKey, peerIdentity);
  } catch (err) {
    if (err instanceof ProtocolError && err.code === ProtocolErrorCode.RoleIndeterminable) {
      throw new CryptoError(
        CryptoErrorCode.IdentityNotInTranscript,
        "local and peer identity keys are identical",
      );
    }
    throw err;
  }

  const sharedPoint = p256.getSharedSecret(
    input.localEcdhPrivateKey,
    input.peerEcdhPublicKey,
    false,
  );
  const ecdhSecret = sharedPoint.subarray(ECDH_X_OFFSET, ECDH_X_OFFSET + ECDH_X_BYTES);

  const transcriptHash = await sha256(encodeTranscript(input.transcript));
  const initKeyBytes = await hkdfSha256(
    ecdhSecret,
    transcriptHash,
    new TextEncoder().encode(INIT_TO_RESP_LABEL),
    HKDF_TRAFFIC_KEY_BYTES,
  );
  const respKeyBytes = await hkdfSha256(
    ecdhSecret,
    transcriptHash,
    new TextEncoder().encode(RESP_TO_INIT_LABEL),
    HKDF_TRAFFIC_KEY_BYTES,
  );

  if (role === Role.Initiator) {
    return { sendKey: toAESKey(initKeyBytes), recvKey: toAESKey(respKeyBytes) };
  }
  return { sendKey: toAESKey(respKeyBytes), recvKey: toAESKey(initKeyBytes) };
}
