import { p256 } from "@noble/curves/p256";
import { describe, expect, it } from "vitest";

import {
  CryptoError,
  CryptoErrorCode,
  generateIdentityKeyPair,
  signTranscript,
  verifyTranscript,
} from "@fuck-eu-chat-control/chat-runtime/crypto";
import { encodeSignature } from "@fuck-eu-chat-control/chat-runtime/protocol/codec";
import { ProtocolError, ProtocolErrorCode } from "@fuck-eu-chat-control/chat-runtime/protocol/errors";
import { PUBLIC_KEY_BYTES, SIGNATURE_BYTES } from "@fuck-eu-chat-control/chat-runtime/protocol/limits";
import type { Signature } from "@fuck-eu-chat-control/chat-runtime/protocol/types";

import {
  buildCanonicalTranscript,
  conversationId,
  deterministicPublicKey,
  sessionId,
} from "./_helpers";

function peerHandshake(seed: number) {
  return {
    identityPublicKey: deterministicPublicKey(seed),
    ecdhPublicKey: deterministicPublicKey(seed + 100),
    sessionId: sessionId(seed + 200),
  };
}

function asSignature(bytes: Uint8Array): Signature {
  return bytes as unknown as Signature;
}

async function sampleTranscript() {
  return buildCanonicalTranscript(conversationId(1), peerHandshake(3), peerHandshake(5));
}

describe("generateIdentityKeyPair (ECDSA P-256, SEC 1 §2.3.3)", () => {
  it("produces a 65-byte uncompressed SEC1 public key on the P-256 curve", async () => {
    const id = await generateIdentityKeyPair();
    expect(id.publicKey.length).toBe(PUBLIC_KEY_BYTES);
    expect(id.publicKey[0]).toBe(0x04);
    expect(p256.utils.isValidPublicKey(id.publicKey, false)).toBe(true);
    expect(id.privateKey.length).toBe(32);
  });

  it("produces fresh keys on every call", async () => {
    const a = await generateIdentityKeyPair();
    const b = await generateIdentityKeyPair();
    expect(Array.from(a.publicKey)).not.toEqual(Array.from(b.publicKey));
    expect(Array.from(a.privateKey)).not.toEqual(Array.from(b.privateKey));
  });
});

describe("sign / verify transcript (ECDSA over SHA-256(transcript), IEEE P1363)", () => {
  it("verifies a signature produced by the same identity", async () => {
    const id = await generateIdentityKeyPair();
    const transcript = await sampleTranscript();
    const signature = await id.sign(transcript);
    expect(signature.length).toBe(SIGNATURE_BYTES);
    expect(await verifyTranscript(id.publicKey, signature, transcript)).toBe(true);
  });

  it("verifies a signature produced by signTranscript with an imported private key", async () => {
    const id = await generateIdentityKeyPair();
    const transcript = await sampleTranscript();
    const signature = await signTranscript(id.privateKey, transcript);
    expect(await verifyTranscript(id.publicKey, signature, transcript)).toBe(true);
  });

  it("rejects a signature verified against a different identity key", async () => {
    const a = await generateIdentityKeyPair();
    const b = await generateIdentityKeyPair();
    const transcript = await sampleTranscript();
    const signature = await a.sign(transcript);
    expect(await verifyTranscript(b.publicKey, signature, transcript)).toBe(false);
  });

  it("rejects a signature over a tampered transcript (changed conversation id)", async () => {
    const id = await generateIdentityKeyPair();
    const transcript = await sampleTranscript();
    const signature = await id.sign(transcript);
    const tampered = buildCanonicalTranscript(
      conversationId(2),
      peerHandshake(3),
      peerHandshake(5),
    );
    expect(await verifyTranscript(id.publicKey, signature, tampered)).toBe(false);
  });

  it("rejects a tampered signature byte", async () => {
    const id = await generateIdentityKeyPair();
    const transcript = await sampleTranscript();
    const signature = await id.sign(transcript);
    const tampered = new Uint8Array(signature);
    tampered[0] ^= 0xff;
    expect(await verifyTranscript(id.publicKey, asSignature(tampered), transcript)).toBe(false);
  });

  it("rejects a malformed signature length at the codec boundary", () => {
    try {
      encodeSignature(new Uint8Array(SIGNATURE_BYTES - 1));
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ProtocolError).code).toBe(ProtocolErrorCode.InvalidLength);
    }
  });

  it("rejects a malformed signature length passed to verify", async () => {
    const id = await generateIdentityKeyPair();
    const transcript = await sampleTranscript();
    try {
      await verifyTranscript(
        id.publicKey,
        asSignature(new Uint8Array(SIGNATURE_BYTES - 1)),
        transcript,
      );
      throw new Error("expected throw");
    } catch (err) {
      expect((err as CryptoError).code).toBe(CryptoErrorCode.InvalidArgument);
    }
  });
});
