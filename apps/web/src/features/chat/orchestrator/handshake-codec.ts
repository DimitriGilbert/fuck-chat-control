import { deriveRole, encodePublicKey, encodeSessionId, encodeSignature } from "../protocol/codec";
import {
  PROTOCOL_VERSION,
  PUBLIC_KEY_BYTES,
  SESSION_ID_BYTES,
  SIGNATURE_BYTES,
  TRANSCRIPT_VERSION,
} from "../protocol/limits";
import { ProtocolError } from "../protocol/errors";
import { Role } from "../protocol/types";
import type {
  AuthMode,
  ConversationId,
  PublicKey,
  SessionId,
  Signature,
  Transcript,
} from "../protocol/types";

import { OrchestratorError, OrchestratorErrorCode } from "./errors";

/**
 * HelloMessage wire layout (frozen, big-endian / fixed-width):
 *   PROTOCOL_VERSION(1) | identityPublicKey(65) | ephemeralPublicKey(65) | sessionId(32)
 * Total = 163 bytes. Public keys are uncompressed SEC1 P-256 (0x04 prefix).
 */
const HELLO_BYTES = 1 + PUBLIC_KEY_BYTES + PUBLIC_KEY_BYTES + SESSION_ID_BYTES;
const HELLO_IDENTITY_OFFSET = 1;
const HELLO_EPHEMERAL_OFFSET = HELLO_IDENTITY_OFFSET + PUBLIC_KEY_BYTES;
const HELLO_SESSION_OFFSET = HELLO_EPHEMERAL_OFFSET + PUBLIC_KEY_BYTES;

/**
 * SignatureMessage wire layout (frozen):
 *   PROTOCOL_VERSION(1) | signature(64)
 * Total = 65 bytes. Signature is IEEE-P1363 P-256 compact (r||s).
 */
const SIGNATURE_MESSAGE_BYTES = 1 + SIGNATURE_BYTES;
const SIGNATURE_OFFSET = 1;

export interface HelloComponents {
  readonly protocolVersion: number;
  readonly identityPublicKey: PublicKey;
  readonly ephemeralPublicKey: PublicKey;
  readonly sessionId: SessionId;
}

export interface HandshakePeers {
  readonly conversationId: ConversationId;
  readonly local: HelloComponents;
  readonly remote: HelloComponents;
  readonly authMode: AuthMode;
}

function toMalformed(err: unknown, what: string): OrchestratorError {
  if (err instanceof ProtocolError) {
    return new OrchestratorError(
      OrchestratorErrorCode.MalformedHandshakeMessage,
      `${what}: ${err.message}`,
    );
  }
  if (err instanceof OrchestratorError) {
    return err;
  }
  return new OrchestratorError(
    OrchestratorErrorCode.MalformedHandshakeMessage,
    `${what}: ${String(err)}`,
  );
}

function assertHelloShape(bytes: Uint8Array): void {
  if (bytes.length !== HELLO_BYTES) {
    throw new OrchestratorError(
      OrchestratorErrorCode.MalformedHandshakeMessage,
      `HelloMessage must be exactly ${HELLO_BYTES} bytes, got ${bytes.length}`,
    );
  }
  if (bytes[0] !== PROTOCOL_VERSION) {
    throw new OrchestratorError(
      OrchestratorErrorCode.MalformedHandshakeMessage,
      `HelloMessage version must be 0x${PROTOCOL_VERSION.toString(16).padStart(2, "0")}, got 0x${bytes[0]
        .toString(16)
        .padStart(2, "0")}`,
    );
  }
}

function assertSignatureShape(bytes: Uint8Array): void {
  if (bytes.length !== SIGNATURE_MESSAGE_BYTES) {
    throw new OrchestratorError(
      OrchestratorErrorCode.MalformedHandshakeMessage,
      `SignatureMessage must be exactly ${SIGNATURE_MESSAGE_BYTES} bytes, got ${bytes.length}`,
    );
  }
  if (bytes[0] !== PROTOCOL_VERSION) {
    throw new OrchestratorError(
      OrchestratorErrorCode.MalformedHandshakeMessage,
      `SignatureMessage version must be 0x${PROTOCOL_VERSION.toString(16).padStart(2, "0")}, got 0x${bytes[0]
        .toString(16)
        .padStart(2, "0")}`,
    );
  }
}

export function encodeHello(components: HelloComponents): Uint8Array {
  const out = new Uint8Array(HELLO_BYTES);
  out[0] = components.protocolVersion;
  out.set(components.identityPublicKey, HELLO_IDENTITY_OFFSET);
  out.set(components.ephemeralPublicKey, HELLO_EPHEMERAL_OFFSET);
  out.set(components.sessionId, HELLO_SESSION_OFFSET);
  return out;
}

export function decodeHello(bytes: Uint8Array): HelloComponents {
  assertHelloShape(bytes);
  try {
    const identityPublicKey = encodePublicKey(
      bytes.subarray(HELLO_IDENTITY_OFFSET, HELLO_IDENTITY_OFFSET + PUBLIC_KEY_BYTES),
    );
    const ephemeralPublicKey = encodePublicKey(
      bytes.subarray(HELLO_EPHEMERAL_OFFSET, HELLO_EPHEMERAL_OFFSET + PUBLIC_KEY_BYTES),
    );
    const sessionId = encodeSessionId(
      bytes.subarray(HELLO_SESSION_OFFSET, HELLO_SESSION_OFFSET + SESSION_ID_BYTES),
    );
    return {
      protocolVersion: bytes[0],
      identityPublicKey,
      ephemeralPublicKey,
      sessionId,
    };
  } catch (err) {
    throw toMalformed(err, "HelloMessage field");
  }
}

export function encodeSignatureMessage(signature: Signature): Uint8Array {
  const out = new Uint8Array(SIGNATURE_MESSAGE_BYTES);
  out[0] = PROTOCOL_VERSION;
  out.set(signature, SIGNATURE_OFFSET);
  return out;
}

export function decodeSignatureMessage(bytes: Uint8Array): Signature {
  assertSignatureShape(bytes);
  try {
    return encodeSignature(bytes.subarray(SIGNATURE_OFFSET, SIGNATURE_OFFSET + SIGNATURE_BYTES));
  } catch (err) {
    throw toMalformed(err, "SignatureMessage field");
  }
}

/**
 * Build the canonical `Transcript` from both peers' hello components. Both
 * peers MUST call this with their local/remote pair so they assemble
 * byte-identical transcripts: fields are written in canonical (initiator,
 * responder) order derived from `deriveRole`, which orders by lexicographic
 * comparison of identity public keys.
 *
 * `deriveRole` throws `RoleIndeterminable` if both identity keys are equal;
 * that propagates as-is (it indicates a fundamentally broken or malicious
 * peer pairing).
 */
export function buildTranscript(peers: HandshakePeers): Transcript {
  const role = deriveRole(peers.local.identityPublicKey, peers.remote.identityPublicKey);
  const initiator = role === Role.Initiator ? peers.local : peers.remote;
  const responder = role === Role.Initiator ? peers.remote : peers.local;
  return {
    transcriptVersion: TRANSCRIPT_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    conversationId: peers.conversationId,
    authMode: peers.authMode,
    initiatorIdentityKey: initiator.identityPublicKey,
    responderIdentityKey: responder.identityPublicKey,
    initiatorEphemeralKey: initiator.ephemeralPublicKey,
    responderEphemeralKey: responder.ephemeralPublicKey,
    initiatorSessionId: initiator.sessionId,
    responderSessionId: responder.sessionId,
  };
}
