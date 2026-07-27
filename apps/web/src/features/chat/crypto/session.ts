import { p256 } from "@noble/curves/p256";

import { deriveRole, encodePublicKey, encodeTranscript } from "../protocol/codec";
import {
  HKDF_TRAFFIC_KEY_BYTES,
  INIT_TO_RESP_LABEL,
  RESP_TO_INIT_LABEL,
} from "../protocol/limits";
import { ProtocolError, ProtocolErrorCode } from "../protocol/errors";
import { AuthMode, Role } from "../protocol/types";
import type { PublicKey, Transcript } from "../protocol/types";

import { ctEqual } from "./ct-equal";
import { CryptoError, CryptoErrorCode } from "./errors";
import { hkdfSha256, sha256, toAESKey } from "./primitives";
import type { DeriveSessionKeysInput, EphemeralKeyPair, SessionKeys } from "./types";

const ECDH_X_OFFSET = 1;
const ECDH_X_BYTES = 32;

export async function generateEphemeralKeyPair(): Promise<EphemeralKeyPair> {
  const privateKey = p256.utils.randomSecretKey();
  const publicKey = encodePublicKey(p256.getPublicKey(privateKey, false));
  return { publicKey, privateKey };
}

function resolvePeerIdentity(transcript: Transcript, localIdentityPublicKey: PublicKey): PublicKey {
  const isInitiator = ctEqual(transcript.initiatorIdentityKey, localIdentityPublicKey);
  if (isInitiator) return transcript.responderIdentityKey;
  const isResponder = ctEqual(transcript.responderIdentityKey, localIdentityPublicKey);
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

  // Defensive: a Pake session MUST contribute its SPAKE2 shared secret to the
  // key schedule. If `pakeSecret` is null while the transcript authMode is
  // Pake, refuse to derive — this prevents an accidental silent fallback to a
  // safety-number-only key schedule under a Pake invitation.
  const pakeSecret = input.pakeSecret ?? null;
  if (pakeSecret === null && input.transcript.authMode === AuthMode.Pake) {
    throw new CryptoError(
      CryptoErrorCode.InvalidArgument,
      "deriveSessionKeys: authMode is Pake but no pakeSecret was provided (refusing silent fallback)",
    );
  }

  const transcriptHash = await sha256(encodeTranscript(input.transcript));
  // Bind the SPAKE2 shared secret into the HKDF info, alongside the ECDH
  // secret (IKM) and transcript hash (salt). Mixing pakeSecret into the info
  // string means a Pake session's traffic keys are inseparable from the
  // password-derived secret without changing the salt/IKM contract.
  const initInfo = buildTrafficKeyInfo(INIT_TO_RESP_LABEL, pakeSecret);
  const respInfo = buildTrafficKeyInfo(RESP_TO_INIT_LABEL, pakeSecret);
  const initKeyBytes = await hkdfSha256(
    ecdhSecret,
    transcriptHash,
    initInfo,
    HKDF_TRAFFIC_KEY_BYTES,
  );
  const respKeyBytes = await hkdfSha256(
    ecdhSecret,
    transcriptHash,
    respInfo,
    HKDF_TRAFFIC_KEY_BYTES,
  );

  if (role === Role.Initiator) {
    return { sendKey: toAESKey(initKeyBytes), recvKey: toAESKey(respKeyBytes) };
  }
  return { sendKey: toAESKey(respKeyBytes), recvKey: toAESKey(initKeyBytes) };
}

/**
 * Build the HKDF `info` buffer for a directional traffic-key label. When the
 * session ran PAKE, the SPAKE2 shared secret is concatenated onto the label so
 * the derived traffic keys are bound to the password as well as to the ECDH
 * secret and transcript. A null `pakeSecret` (SafetyNumberOnly session) yields
 * the bare label, preserving the pre-PAKE key schedule byte-for-byte.
 */
function buildTrafficKeyInfo(label: string, pakeSecret: Uint8Array | null): Uint8Array {
  const labelBytes = new TextEncoder().encode(label);
  if (pakeSecret === null) {
    return labelBytes;
  }
  const out = new Uint8Array(labelBytes.length + pakeSecret.length);
  out.set(labelBytes, 0);
  out.set(pakeSecret, labelBytes.length);
  return out;
}
