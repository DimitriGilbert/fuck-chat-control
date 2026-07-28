import { describe, expect, it } from "vitest";

import {
  CryptoErrorCode,
  deriveSessionKeys,
  generateEphemeralKeyPair,
  generateIdentityKeyPair,
} from "@fuck-eu-chat-control/chat-runtime/crypto";
import type {
  ConversationId,
  PublicKey,
  SessionId,
} from "@fuck-eu-chat-control/chat-runtime/protocol/types";

import { buildCanonicalTranscript, bytesEqual, conversationId, sessionId } from "./_helpers";

interface PeerMaterial {
  readonly identityPublicKey: PublicKey;
  readonly ecdhPrivateKey: Uint8Array;
  readonly ecdhPublicKey: PublicKey;
  readonly session: SessionId;
}

async function makePeer(seed: number): Promise<PeerMaterial> {
  const identity = await generateIdentityKeyPair();
  const ecdh = await generateEphemeralKeyPair();
  return {
    identityPublicKey: identity.publicKey,
    ecdhPrivateKey: ecdh.privateKey,
    ecdhPublicKey: ecdh.publicKey,
    session: sessionId(seed),
  };
}

function handshakeOf(p: PeerMaterial) {
  return {
    identityPublicKey: p.identityPublicKey,
    ecdhPublicKey: p.ecdhPublicKey,
    sessionId: p.session,
  };
}

async function deriveFor(a: PeerMaterial, b: PeerMaterial, conv: ConversationId) {
  const transcript = buildCanonicalTranscript(conv, handshakeOf(a), handshakeOf(b));
  return deriveSessionKeys({
    localEcdhPrivateKey: a.ecdhPrivateKey,
    peerEcdhPublicKey: b.ecdhPublicKey,
    transcript,
    localIdentityPublicKey: a.identityPublicKey,
  });
}

describe("deriveSessionKeys (ECDH P-256 + HKDF-SHA256, RFC 5869)", () => {
  it("both peers derive matching directional keys (A.send == B.recv)", async () => {
    const conv = conversationId(10);
    const a = await makePeer(1);
    const b = await makePeer(2);
    const aKeys = await deriveFor(a, b, conv);
    const bKeys = await deriveFor(b, a, conv);
    expect(bytesEqual(aKeys.sendKey, bKeys.recvKey)).toBe(true);
    expect(bytesEqual(aKeys.recvKey, bKeys.sendKey)).toBe(true);
  });

  it("send and recv keys differ within one peer (directional labels)", async () => {
    const conv = conversationId(11);
    const a = await makePeer(1);
    const b = await makePeer(2);
    const aKeys = await deriveFor(a, b, conv);
    expect(bytesEqual(aKeys.sendKey, aKeys.recvKey)).toBe(false);
  });

  it("swapping roles swaps send/recv", async () => {
    const conv = conversationId(12);
    const a = await makePeer(1);
    const b = await makePeer(2);
    const aKeys = await deriveFor(a, b, conv);
    const bKeys = await deriveFor(b, a, conv);
    expect(bytesEqual(aKeys.sendKey, bKeys.sendKey)).toBe(false);
    expect(bytesEqual(aKeys.sendKey, bKeys.recvKey)).toBe(true);
  });

  it("fresh ephemeral keys per generation produce distinct session keys", async () => {
    const conv = conversationId(13);
    const a = await makePeer(1);
    const b = await makePeer(2);
    const first = await deriveFor(a, b, conv);
    const a2 = await makePeer(3);
    const second = await deriveFor(
      { ...a, ecdhPrivateKey: a2.ecdhPrivateKey, ecdhPublicKey: a2.ecdhPublicKey },
      b,
      conv,
    );
    expect(bytesEqual(first.sendKey, second.sendKey)).toBe(false);
  });

  it("two independent ECDH pairs derive different keys", async () => {
    const conv = conversationId(14);
    const a = await makePeer(1);
    const b = await makePeer(2);
    const c = await makePeer(3);
    const ab = await deriveFor(a, b, conv);
    const ac = await deriveFor(a, c, conv);
    expect(bytesEqual(ab.sendKey, ac.sendKey)).toBe(false);
  });

  it("a changed conversation id produces different keys", async () => {
    const a = await makePeer(1);
    const b = await makePeer(2);
    const k1 = await deriveFor(a, b, conversationId(20));
    const k2 = await deriveFor(a, b, conversationId(21));
    expect(bytesEqual(k1.sendKey, k2.sendKey)).toBe(false);
  });

  it("a changed session id produces different keys", async () => {
    const conv = conversationId(22);
    const a = await makePeer(1);
    const b = await makePeer(2);
    const first = await deriveFor(a, b, conv);
    const second = await deriveFor(a, { ...b, session: sessionId(7777) }, conv);
    expect(bytesEqual(first.sendKey, second.sendKey)).toBe(false);
  });

  it("a changed identity key produces different keys", async () => {
    const conv = conversationId(23);
    const a = await makePeer(1);
    const b = await makePeer(2);
    const first = await deriveFor(a, b, conv);
    const aPrime = await makePeer(3);
    const second = await deriveFor(aPrime, b, conv);
    expect(bytesEqual(first.sendKey, second.sendKey)).toBe(false);
  });

  it("throws when the local identity is not a party to the transcript", async () => {
    const conv = conversationId(24);
    const a = await makePeer(1);
    const b = await makePeer(2);
    const c = await makePeer(3);
    const transcript = buildCanonicalTranscript(conv, handshakeOf(a), handshakeOf(b));
    await expect(
      deriveSessionKeys({
        localEcdhPrivateKey: c.ecdhPrivateKey,
        peerEcdhPublicKey: b.ecdhPublicKey,
        transcript,
        localIdentityPublicKey: c.identityPublicKey,
      }),
    ).rejects.toMatchObject({ code: CryptoErrorCode.IdentityNotInTranscript });
  });

  it("a different peer ephemeral public key produces different keys", async () => {
    const conv = conversationId(25);
    const a = await makePeer(1);
    const b = await makePeer(2);
    const other = await generateEphemeralKeyPair();
    const transcript = buildCanonicalTranscript(conv, handshakeOf(a), handshakeOf(b));
    const k1 = await deriveSessionKeys({
      localEcdhPrivateKey: a.ecdhPrivateKey,
      peerEcdhPublicKey: b.ecdhPublicKey,
      transcript,
      localIdentityPublicKey: a.identityPublicKey,
    });
    const k2 = await deriveSessionKeys({
      localEcdhPrivateKey: a.ecdhPrivateKey,
      peerEcdhPublicKey: other.publicKey,
      transcript,
      localIdentityPublicKey: a.identityPublicKey,
    });
    expect(bytesEqual(k1.sendKey, k2.sendKey)).toBe(false);
  });
});

describe("generateEphemeralKeyPair (ECDH P-256)", () => {
  it("produces a valid 65-byte on-curve public key", async () => {
    const ecdh = await generateEphemeralKeyPair();
    expect(ecdh.publicKey.length).toBe(65);
    expect(ecdh.publicKey[0]).toBe(0x04);
    expect(ecdh.privateKey.length).toBe(32);
  });

  it("produces fresh keys on every call", async () => {
    const a = await generateEphemeralKeyPair();
    const b = await generateEphemeralKeyPair();
    expect(bytesEqual(a.privateKey, b.privateKey)).toBe(false);
    expect(bytesEqual(a.publicKey, b.publicKey)).toBe(false);
  });
});
