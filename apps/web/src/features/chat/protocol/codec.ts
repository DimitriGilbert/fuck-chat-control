import { p256 } from "@noble/curves/p256";

import {
  CONVERSATION_ID_BYTES,
  FRAME_AAD_BYTES,
  FRAME_HEADER_BYTES,
  GCM_NONCE_BYTES,
  MAX_CHUNK_BYTES,
  MAX_SEQUENCE,
  MAX_TEXT_FRAME_BYTES,
  PROTOCOL_VERSION,
  PUBLIC_KEY_BYTES,
  SEC1_UNCOMPRESSED_PREFIX,
  SESSION_ID_BYTES,
  SIGNATURE_BYTES,
  TRANSCRIPT_BYTES,
  TRANSCRIPT_VERSION,
} from "./limits";
import { ProtocolError, ProtocolErrorCode } from "./errors";
import {
  AUTH_MODE_VALUES,
  AuthMode,
  type Brand,
  type ConversationId,
  type FrameAad,
  FRAME_TYPE_VALUES,
  FrameType,
  type FrameHeader,
  type PublicKey,
  Role,
  type SessionId,
  type Signature,
  type Transcript,
} from "./types";

const UINT32_MAX = 0xffffffff;
const UINT32_BYTES = 4;
const NONCE_SEQ_BYTES = 12;

type Branded<B extends string> = Brand<Uint8Array, B>;

function assertExactLength(bytes: Uint8Array, expected: number, what: string): void {
  if (bytes.length !== expected) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidLength,
      `${what} must be exactly ${expected} bytes, got ${bytes.length}`,
    );
  }
}

function assertUint32(value: number, what: string): void {
  if (!Number.isInteger(value) || value < 0 || value > UINT32_MAX) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidRange,
      `${what} must be an unsigned uint32 integer, got ${value}`,
    );
  }
}

function writeUint32Be(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function readUint32Be(src: Uint8Array, offset: number): number {
  return (
    (src[offset] * 0x1000000 +
      (src[offset + 1] << 16) +
      (src[offset + 2] << 8) +
      src[offset + 3]) >>>
    0
  );
}

function copyToBranded<B extends string>(
  src: Uint8Array,
  expectedLength: number,
  what: string,
): Branded<B> {
  assertExactLength(src, expectedLength, what);
  const copy = new Uint8Array(expectedLength);
  copy.set(src);
  return copy as unknown as Branded<B>;
}

function ciphertextCapForFrameType(frameType: FrameType): number {
  switch (frameType) {
    case FrameType.FileChunk:
    case FrameType.MediaChunk:
      return MAX_CHUNK_BYTES;
    case FrameType.Text:
    case FrameType.FileManifest:
    case FrameType.MediaManifest:
    case FrameType.Control:
      return MAX_TEXT_FRAME_BYTES;
  }
}

function assertFrameFieldRelations(
  frameType: FrameType,
  transferId: number,
  chunkId: number,
): void {
  switch (frameType) {
    case FrameType.Text:
    case FrameType.Control:
      if (transferId !== 0 || chunkId !== 0) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidFieldRelation,
          `frame type ${frameType} requires transferId=0 and chunkId=0`,
        );
      }
      break;
    case FrameType.FileManifest:
    case FrameType.MediaManifest:
      if (chunkId !== 0) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidFieldRelation,
          `frame type ${frameType} requires chunkId=0`,
        );
      }
      if (transferId === 0) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidFieldRelation,
          `frame type ${frameType} requires transferId!=0`,
        );
      }
      break;
    case FrameType.FileChunk:
    case FrameType.MediaChunk:
      if (transferId === 0) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidFieldRelation,
          `frame type ${frameType} requires transferId!=0`,
        );
      }
      break;
  }
}

export function encodePublicKey(input: Uint8Array): PublicKey {
  assertExactLength(input, PUBLIC_KEY_BYTES, "public key");
  if (input[0] !== SEC1_UNCOMPRESSED_PREFIX) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidEncoding,
      `public key must be uncompressed SEC1 (prefix 0x04), got 0x${input[0]
        .toString(16)
        .padStart(2, "0")}`,
    );
  }
  if (!p256.utils.isValidPublicKey(input, false)) {
    throw new ProtocolError(
      ProtocolErrorCode.PointNotOnCurve,
      "public key point is not on the P-256 curve",
    );
  }
  return copyToBranded<"PublicKey">(input, PUBLIC_KEY_BYTES, "public key");
}

export function decodePublicKey(input: Uint8Array): PublicKey {
  return encodePublicKey(input);
}

export function encodeSignature(input: Uint8Array): Signature {
  return copyToBranded<"Signature">(input, SIGNATURE_BYTES, "signature");
}

export function decodeSignature(input: Uint8Array): Signature {
  return encodeSignature(input);
}

export function encodeConversationId(input: Uint8Array): ConversationId {
  return copyToBranded<"ConversationId">(input, CONVERSATION_ID_BYTES, "conversation id");
}

export function decodeConversationId(input: Uint8Array): ConversationId {
  return encodeConversationId(input);
}

export function encodeSessionId(input: Uint8Array): SessionId {
  return copyToBranded<"SessionId">(input, SESSION_ID_BYTES, "session id");
}

export function decodeSessionId(input: Uint8Array): SessionId {
  return encodeSessionId(input);
}

function assertFrameType(value: number): asserts value is FrameType {
  if (!FRAME_TYPE_VALUES.includes(value as FrameType)) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidEnum,
      `unknown frame type 0x${value.toString(16).padStart(2, "0")}`,
    );
  }
}

function assertAuthMode(value: number): asserts value is AuthMode {
  if (!AUTH_MODE_VALUES.includes(value as AuthMode)) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidEnum,
      `unknown auth mode 0x${value.toString(16).padStart(2, "0")}`,
    );
  }
}

function assertProtocolVersion(value: number): void {
  if (value !== PROTOCOL_VERSION) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidVersion,
      `expected protocol version 0x${PROTOCOL_VERSION.toString(16)}, got 0x${value
        .toString(16)
        .padStart(2, "0")}`,
    );
  }
}

function assertAadFields(aad: FrameAad): void {
  assertProtocolVersion(aad.protocolVersion);
  assertUint32(aad.senderSequence, "sender sequence");
  assertUint32(aad.transferId, "transfer id");
  assertUint32(aad.chunkId, "chunk id");
  assertFrameType(aad.frameType);
  assertFrameFieldRelations(aad.frameType, aad.transferId, aad.chunkId);
}

export function encodeAad(aad: FrameAad): Uint8Array {
  assertAadFields(aad);
  const out = new Uint8Array(FRAME_AAD_BYTES);
  out[0] = aad.protocolVersion;
  out.set(aad.senderSessionId, 1);
  writeUint32Be(out, 1 + SESSION_ID_BYTES, aad.senderSequence);
  out[1 + SESSION_ID_BYTES + UINT32_BYTES] = aad.frameType;
  writeUint32Be(out, 1 + SESSION_ID_BYTES + UINT32_BYTES + 1, aad.transferId);
  writeUint32Be(out, 1 + SESSION_ID_BYTES + UINT32_BYTES + 1 + UINT32_BYTES, aad.chunkId);
  return out;
}

export function decodeAad(bytes: Uint8Array): FrameAad {
  assertExactLength(bytes, FRAME_AAD_BYTES, "frame AAD");
  const protocolVersion = bytes[0];
  assertProtocolVersion(protocolVersion);
  const senderSessionId = encodeSessionId(bytes.subarray(1, 1 + SESSION_ID_BYTES));
  const senderSequence = readUint32Be(bytes, 1 + SESSION_ID_BYTES);
  const frameType = bytes[1 + SESSION_ID_BYTES + UINT32_BYTES];
  assertFrameType(frameType);
  const transferId = readUint32Be(bytes, 1 + SESSION_ID_BYTES + UINT32_BYTES + 1);
  const chunkId = readUint32Be(bytes, 1 + SESSION_ID_BYTES + UINT32_BYTES + 1 + UINT32_BYTES);
  assertUint32(senderSequence, "sender sequence");
  assertUint32(transferId, "transfer id");
  assertUint32(chunkId, "chunk id");
  assertFrameFieldRelations(frameType, transferId, chunkId);
  return {
    protocolVersion,
    senderSessionId,
    senderSequence,
    frameType,
    transferId,
    chunkId,
  };
}

export function encodeFrameHeader(header: FrameHeader): Uint8Array {
  assertAadFields(header);
  assertUint32(header.ciphertextLength, "ciphertext length");
  const cap = ciphertextCapForFrameType(header.frameType);
  if (header.ciphertextLength > cap) {
    throw new ProtocolError(
      ProtocolErrorCode.LimitExceeded,
      `ciphertext length ${header.ciphertextLength} exceeds cap ${cap} for frame type ${header.frameType}`,
    );
  }
  const out = new Uint8Array(FRAME_HEADER_BYTES);
  out.set(encodeAad(header), 0);
  writeUint32Be(out, FRAME_AAD_BYTES, header.ciphertextLength);
  return out;
}

export function decodeFrameHeader(bytes: Uint8Array): FrameHeader {
  assertExactLength(bytes, FRAME_HEADER_BYTES, "frame header");
  const aad = decodeAad(bytes.subarray(0, FRAME_AAD_BYTES));
  const ciphertextLength = readUint32Be(bytes, FRAME_AAD_BYTES);
  assertUint32(ciphertextLength, "ciphertext length");
  const cap = ciphertextCapForFrameType(aad.frameType);
  if (ciphertextLength > cap) {
    throw new ProtocolError(
      ProtocolErrorCode.LimitExceeded,
      `ciphertext length ${ciphertextLength} exceeds cap ${cap} for frame type ${aad.frameType}`,
    );
  }
  return { ...aad, ciphertextLength };
}

export function encodeTranscript(t: Transcript): Uint8Array {
  if (t.transcriptVersion !== TRANSCRIPT_VERSION) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidVersion,
      `expected transcript version 0x${TRANSCRIPT_VERSION.toString(16)}, got 0x${t.transcriptVersion
        .toString(16)
        .padStart(2, "0")}`,
    );
  }
  assertProtocolVersion(t.protocolVersion);
  assertAuthMode(t.authMode);
  const out = new Uint8Array(TRANSCRIPT_BYTES);
  let offset = 0;
  out[offset++] = t.transcriptVersion;
  out[offset++] = t.protocolVersion;
  out.set(t.conversationId, offset);
  offset += CONVERSATION_ID_BYTES;
  out[offset++] = t.authMode;
  out.set(t.initiatorIdentityKey, offset);
  offset += PUBLIC_KEY_BYTES;
  out.set(t.responderIdentityKey, offset);
  offset += PUBLIC_KEY_BYTES;
  out.set(t.initiatorEphemeralKey, offset);
  offset += PUBLIC_KEY_BYTES;
  out.set(t.responderEphemeralKey, offset);
  offset += PUBLIC_KEY_BYTES;
  out.set(t.initiatorSessionId, offset);
  offset += SESSION_ID_BYTES;
  out.set(t.responderSessionId, offset);
  offset += SESSION_ID_BYTES;
  return out;
}

export function decodeTranscript(bytes: Uint8Array): Transcript {
  assertExactLength(bytes, TRANSCRIPT_BYTES, "transcript");
  const transcriptVersion = bytes[0];
  if (transcriptVersion !== TRANSCRIPT_VERSION) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidVersion,
      `expected transcript version 0x${TRANSCRIPT_VERSION.toString(16)}, got 0x${transcriptVersion
        .toString(16)
        .padStart(2, "0")}`,
    );
  }
  const protocolVersion = bytes[1];
  assertProtocolVersion(protocolVersion);
  let offset = 2;
  const conversationId = encodeConversationId(
    bytes.subarray(offset, offset + CONVERSATION_ID_BYTES),
  );
  offset += CONVERSATION_ID_BYTES;
  const authMode = bytes[offset++];
  assertAuthMode(authMode);
  const initiatorIdentityKey = encodePublicKey(bytes.subarray(offset, offset + PUBLIC_KEY_BYTES));
  offset += PUBLIC_KEY_BYTES;
  const responderIdentityKey = encodePublicKey(bytes.subarray(offset, offset + PUBLIC_KEY_BYTES));
  offset += PUBLIC_KEY_BYTES;
  const initiatorEphemeralKey = encodePublicKey(bytes.subarray(offset, offset + PUBLIC_KEY_BYTES));
  offset += PUBLIC_KEY_BYTES;
  const responderEphemeralKey = encodePublicKey(bytes.subarray(offset, offset + PUBLIC_KEY_BYTES));
  offset += PUBLIC_KEY_BYTES;
  const initiatorSessionId = encodeSessionId(bytes.subarray(offset, offset + SESSION_ID_BYTES));
  offset += SESSION_ID_BYTES;
  const responderSessionId = encodeSessionId(bytes.subarray(offset, offset + SESSION_ID_BYTES));
  offset += SESSION_ID_BYTES;
  return {
    transcriptVersion,
    protocolVersion,
    conversationId,
    authMode,
    initiatorIdentityKey,
    responderIdentityKey,
    initiatorEphemeralKey,
    responderEphemeralKey,
    initiatorSessionId,
    responderSessionId,
  };
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) {
      return a[i] - b[i];
    }
  }
  return a.length - b.length;
}

export function deriveRole(localIdentityKey: PublicKey, remoteIdentityKey: PublicKey): Role {
  const cmp = compareBytes(localIdentityKey, remoteIdentityKey);
  if (cmp === 0) {
    throw new ProtocolError(
      ProtocolErrorCode.RoleIndeterminable,
      "local and remote identity keys are identical; cannot derive a role",
    );
  }
  return cmp < 0 ? Role.Initiator : Role.Responder;
}

export function deriveNonce(senderSessionId: SessionId, sequence: number): Uint8Array {
  assertUint32(sequence, "sequence");
  if (sequence > MAX_SEQUENCE) {
    throw new ProtocolError(
      ProtocolErrorCode.LimitExceeded,
      `sequence exceeds MAX_SEQUENCE (${MAX_SEQUENCE})`,
    );
  }
  const nonce = new Uint8Array(GCM_NONCE_BYTES);
  nonce.set(senderSessionId.subarray(0, GCM_NONCE_BYTES));
  const seqOffset = NONCE_SEQ_BYTES - UINT32_BYTES;
  nonce[seqOffset] ^= (sequence >>> 24) & 0xff;
  nonce[seqOffset + 1] ^= (sequence >>> 16) & 0xff;
  nonce[seqOffset + 2] ^= (sequence >>> 8) & 0xff;
  nonce[seqOffset + 3] ^= sequence & 0xff;
  return nonce;
}
