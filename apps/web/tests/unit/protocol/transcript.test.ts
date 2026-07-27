import { p256 } from "@noble/curves/p256";
import { describe, expect, it } from "vitest";

import { sha256 } from "@/features/chat/crypto/primitives";
import { decodeTranscript, encodeTranscript } from "@/features/chat/protocol/codec";
import { ProtocolError, ProtocolErrorCode } from "@/features/chat/protocol/errors";
import {
  CONVERSATION_ID_BYTES,
  PROTOCOL_VERSION,
  PUBLIC_KEY_BYTES,
  SESSION_ID_BYTES,
  TRANSCRIPT_BYTES,
  TRANSCRIPT_VERSION,
} from "@/features/chat/protocol/limits";
import {
  AuthMode,
  type ConversationId,
  type PublicKey,
  type SessionId,
  type Transcript,
} from "@/features/chat/protocol/types";

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function pubKey(seed: number): PublicKey {
  return p256.getPublicKey(seedToPrivKey(seed), false) as unknown as PublicKey;
}

function seedToPrivKey(seed: number): Uint8Array {
  const sk = new Uint8Array(32);
  for (let i = 0; i < 32; i++) sk[i] = (seed * 13 + i) & 0xff;
  return sk;
}

function convId(seed: number): ConversationId {
  const bytes = new Uint8Array(CONVERSATION_ID_BYTES);
  for (let i = 0; i < CONVERSATION_ID_BYTES; i++) bytes[i] = (seed + i) & 0xff;
  return bytes as unknown as ConversationId;
}

function sessionId(seed: number): SessionId {
  const bytes = new Uint8Array(SESSION_ID_BYTES);
  for (let i = 0; i < SESSION_ID_BYTES; i++) bytes[i] = (seed + i) & 0xff;
  return bytes as unknown as SessionId;
}

function sampleTranscript(): Transcript {
  return {
    transcriptVersion: TRANSCRIPT_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    conversationId: convId(0x10),
    authMode: AuthMode.SafetyNumberOnly,
    initiatorIdentityKey: pubKey(1),
    responderIdentityKey: pubKey(2),
    initiatorEphemeralKey: pubKey(3),
    responderEphemeralKey: pubKey(4),
    initiatorSessionId: sessionId(0x20),
    responderSessionId: sessionId(0x40),
  };
}

describe("encodeTranscript / decodeTranscript (343 bytes, canonical order)", () => {
  it("round-trips a complete transcript", () => {
    const t = sampleTranscript();
    const bytes = encodeTranscript(t);
    expect(bytes.length).toBe(TRANSCRIPT_BYTES);
    const decoded = decodeTranscript(bytes);
    expect(decoded.transcriptVersion).toBe(TRANSCRIPT_VERSION);
    expect(decoded.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(decoded.authMode).toBe(AuthMode.SafetyNumberOnly);
    expect(Array.from(decoded.conversationId)).toEqual(Array.from(t.conversationId));
    expect(Array.from(decoded.initiatorIdentityKey)).toEqual(Array.from(t.initiatorIdentityKey));
    expect(Array.from(decoded.responderEphemeralKey)).toEqual(Array.from(t.responderEphemeralKey));
    expect(Array.from(decoded.initiatorSessionId)).toEqual(Array.from(t.initiatorSessionId));
  });

  it("places fields at the canonical offsets", () => {
    const t = sampleTranscript();
    const bytes = encodeTranscript(t);
    expect(bytes[0]).toBe(TRANSCRIPT_VERSION);
    expect(bytes[1]).toBe(PROTOCOL_VERSION);
    expect(bytes[18]).toBe(AuthMode.SafetyNumberOnly);
    const initIdStart = 19;
    expect(bytes[initIdStart]).toBe(0x04);
    expect(bytes[initIdStart + PUBLIC_KEY_BYTES]).toBe(0x04);
    expect(bytes[initIdStart + PUBLIC_KEY_BYTES * 2]).toBe(0x04);
    expect(bytes[initIdStart + PUBLIC_KEY_BYTES * 3]).toBe(0x04);
  });

  it("rejects an unknown transcript version on encode", () => {
    const t = sampleTranscript();
    (t as { transcriptVersion: number }).transcriptVersion = 0x02;
    try {
      encodeTranscript(t);
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ProtocolError).code).toBe(ProtocolErrorCode.InvalidVersion);
    }
  });

  it("rejects an unknown protocol version on encode", () => {
    const t = sampleTranscript();
    (t as { protocolVersion: number }).protocolVersion = 0x02;
    try {
      encodeTranscript(t);
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ProtocolError).code).toBe(ProtocolErrorCode.InvalidVersion);
    }
  });

  it("rejects an unknown auth mode on encode", () => {
    const t = sampleTranscript();
    // 0x01 (SafetyNumberOnly) and 0x02 (Pake) are both valid; use 0x03 which
    // is genuinely outside the AUTH_MODE_VALUES set.
    (t as { authMode: number }).authMode = 0x03;
    try {
      encodeTranscript(t);
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ProtocolError).code).toBe(ProtocolErrorCode.InvalidEnum);
    }
  });

  it("rejects a malformed transcript buffer (wrong length)", () => {
    try {
      decodeTranscript(new Uint8Array(TRANSCRIPT_BYTES - 1));
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ProtocolError).code).toBe(ProtocolErrorCode.InvalidLength);
    }
  });

  it("rejects a transcript whose bytes carry an unknown version", () => {
    const bytes = encodeTranscript(sampleTranscript());
    bytes[0] = 0x02;
    try {
      decodeTranscript(bytes);
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ProtocolError).code).toBe(ProtocolErrorCode.InvalidVersion);
    }
  });

  it("rejects a transcript whose identity key bytes are not on the curve", () => {
    const bytes = encodeTranscript(sampleTranscript());
    bytes[19 + PUBLIC_KEY_BYTES - 1] ^= 0x01;
    try {
      decodeTranscript(bytes);
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ProtocolError).code).toBe(ProtocolErrorCode.PointNotOnCurve);
    }
  });

  it("encodes two transcripts differing only in conversation id to distinct bytes", () => {
    const a = encodeTranscript(sampleTranscript());
    const t2 = sampleTranscript();
    (t2 as { conversationId: ConversationId }).conversationId = convId(0x80);
    const b = encodeTranscript(t2);
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  // CR-11: transcript anti-reflection. If two peers could somehow negotiate
  // transcripts that differ ONLY by which peer is the initiator vs responder
  // (same four public keys, same sessions, roles swapped), the resulting
  // encoded transcripts MUST still be byte-distinct — otherwise a reflection
  // attack (or a regression that sorts both sides into the same slot, e.g.
  // ordering by "smaller key first" on BOTH initiator and responder fields)
  // would let the two transcripts collide. We assert byte-distinctness and
  // distinct SHA-256 hashes over the canonical encodings.
  it("produces distinct encodings when initiator/responder roles are swapped (anti-reflection)", async () => {
    // Four fixed public keys shared by both transcripts — the ONLY thing that
    // differs between t1 and t2 is which peer plays initiator vs responder.
    const identityA = pubKey(1);
    const identityB = pubKey(2);
    const ephA = pubKey(3);
    const ephB = pubKey(4);
    const sessionA = sessionId(0x20);
    const sessionB = sessionId(0x40);

    const t1: Transcript = {
      transcriptVersion: TRANSCRIPT_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      conversationId: convId(0x10),
      authMode: AuthMode.SafetyNumberOnly,
      initiatorIdentityKey: identityA,
      responderIdentityKey: identityB,
      initiatorEphemeralKey: ephA,
      responderEphemeralKey: ephB,
      initiatorSessionId: sessionA,
      responderSessionId: sessionB,
    };

    const t2: Transcript = {
      transcriptVersion: TRANSCRIPT_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      conversationId: convId(0x10),
      authMode: AuthMode.SafetyNumberOnly,
      initiatorIdentityKey: identityB,
      responderIdentityKey: identityA,
      initiatorEphemeralKey: ephB,
      responderEphemeralKey: ephA,
      initiatorSessionId: sessionB,
      responderSessionId: sessionA,
    };

    const enc1 = encodeTranscript(t1);
    const enc2 = encodeTranscript(t2);
    // Byte-for-byte distinct encodings — guards against a regression that
    // sorts both initiator and responder into the same slot.
    expect(enc1.length).toBe(TRANSCRIPT_BYTES);
    expect(enc2.length).toBe(TRANSCRIPT_BYTES);
    expect(bytesEqual(enc1, enc2)).toBe(false);
    // Distinct transcript hashes — guards against a collision that only shows
    // up after hashing (defense-in-depth: even if byte-distinct somehow hashed
    // alike, that would be a reflection-class collision worth flagging).
    const h1 = await sha256(enc1);
    const h2 = await sha256(enc2);
    expect(bytesEqual(h1, h2)).toBe(false);
  });
});
