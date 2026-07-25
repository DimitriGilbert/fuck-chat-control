import { p256 } from "@noble/curves/p256";

import {
  encodeConversationId,
  encodePublicKey,
  encodeSessionId,
} from "@/features/chat/protocol/codec";
import {
  CONVERSATION_ID_BYTES,
  PROTOCOL_VERSION,
  SESSION_ID_BYTES,
  TRANSCRIPT_VERSION,
} from "@/features/chat/protocol/limits";
import { AuthMode } from "@/features/chat/protocol/types";
import type {
  ConversationId,
  PublicKey,
  SessionId,
  Transcript,
} from "@/features/chat/protocol/types";

export function conversationId(seed: number): ConversationId {
  const bytes = new Uint8Array(CONVERSATION_ID_BYTES);
  for (let i = 0; i < CONVERSATION_ID_BYTES; i++) bytes[i] = (seed * 31 + i) & 0xff;
  return encodeConversationId(bytes);
}

export function sessionId(seed: number): SessionId {
  const bytes = new Uint8Array(SESSION_ID_BYTES);
  for (let i = 0; i < SESSION_ID_BYTES; i++) bytes[i] = (seed * 17 + i + 1) & 0xff;
  return encodeSessionId(bytes);
}

export function deterministicPublicKey(seed: number): PublicKey {
  const sk = new Uint8Array(32);
  for (let i = 0; i < 32; i++) sk[i] = (seed * 7 + i + 1) & 0xff;
  return encodePublicKey(p256.getPublicKey(sk, false));
}

export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export interface PeerHandshake {
  readonly identityPublicKey: PublicKey;
  readonly ecdhPublicKey: PublicKey;
  readonly sessionId: SessionId;
}

export function buildCanonicalTranscript(
  conversation: ConversationId,
  a: PeerHandshake,
  b: PeerHandshake,
): Transcript {
  const [init, resp] =
    compareBytes(a.identityPublicKey, b.identityPublicKey) <= 0 ? [a, b] : [b, a];
  return {
    transcriptVersion: TRANSCRIPT_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    conversationId: conversation,
    authMode: AuthMode.SafetyNumberOnly,
    initiatorIdentityKey: init.identityPublicKey,
    responderIdentityKey: resp.identityPublicKey,
    initiatorEphemeralKey: init.ecdhPublicKey,
    responderEphemeralKey: resp.ecdhPublicKey,
    initiatorSessionId: init.sessionId,
    responderSessionId: resp.sessionId,
  };
}
