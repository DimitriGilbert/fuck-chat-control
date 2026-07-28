import { describe, expect, it } from "vitest";

import {
  generateEphemeralKeyPair,
  generateIdentityKeyPair,
  signTranscript,
  verifyTranscript,
} from "@fuck-eu-chat-control/chat-runtime/crypto";
import { randomBytes } from "@fuck-eu-chat-control/chat-runtime/crypto/primitives";
import {
  deriveRole,
  encodeConversationId,
  encodeSessionId,
  encodeSignature,
  encodeTranscript,
} from "@fuck-eu-chat-control/chat-runtime/protocol/codec";
import {
  PROTOCOL_VERSION,
  PUBLIC_KEY_BYTES,
  SEC1_UNCOMPRESSED_PREFIX,
  SESSION_ID_BYTES,
  SIGNATURE_BYTES,
  TRANSCRIPT_VERSION,
} from "@fuck-eu-chat-control/chat-runtime/protocol/limits";
import { AuthMode, Role } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import type { ConversationId, Signature, Transcript } from "@fuck-eu-chat-control/chat-runtime/protocol/types";

import {
  buildTranscript,
  decodeHello,
  decodeSignatureMessage,
  encodeHello,
  encodeSignatureMessage,
  type HelloComponents,
} from "@fuck-eu-chat-control/chat-runtime/orchestrator/handshake-codec";
import { OrchestratorError, OrchestratorErrorCode } from "@fuck-eu-chat-control/chat-runtime/orchestrator/errors";

// HelloMessage wire layout (frozen by design doc):
//   PROTOCOL_VERSION(1) | identityPublicKey(65) | ephemeralPublicKey(65) | sessionId(32) = 163 bytes
const HELLO_BYTES = 1 + PUBLIC_KEY_BYTES + PUBLIC_KEY_BYTES + SESSION_ID_BYTES;
// SignatureMessage wire layout:
//   PROTOCOL_VERSION(1) | signature(64) = 65 bytes
const SIGNATURE_MESSAGE_BYTES = 1 + SIGNATURE_BYTES;

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function assertMalformed(fn: () => unknown): void {
  try {
    fn();
    throw new Error("expected OrchestratorError(MalformedHandshakeMessage)");
  } catch (err) {
    expect(err).toBeInstanceOf(OrchestratorError);
    expect((err as OrchestratorError).code).toBe(OrchestratorErrorCode.MalformedHandshakeMessage);
  }
}

async function makeHelloFixture(): Promise<HelloComponents> {
  const identity = await generateIdentityKeyPair();
  const ephemeral = await generateEphemeralKeyPair();
  return {
    protocolVersion: PROTOCOL_VERSION,
    identityPublicKey: identity.publicKey,
    ephemeralPublicKey: ephemeral.publicKey,
    sessionId: encodeSessionId(randomBytes(SESSION_ID_BYTES)),
  };
}

describe("encodeHello", () => {
  it("produces exactly 163 bytes with version 0x01 at offset 0", async () => {
    const hello = await makeHelloFixture();
    const bytes = encodeHello(hello);
    expect(bytes.length).toBe(HELLO_BYTES);
    expect(bytes[0]).toBe(PROTOCOL_VERSION);
    expect(bytes[0]).toBe(0x01);
  });

  it("places the identity pubkey at offset 1 (starting with 0x04)", async () => {
    const hello = await makeHelloFixture();
    const bytes = encodeHello(hello);
    const idSlice = bytes.subarray(1, 1 + PUBLIC_KEY_BYTES);
    expect(idSlice.length).toBe(PUBLIC_KEY_BYTES);
    expect(idSlice[0]).toBe(SEC1_UNCOMPRESSED_PREFIX);
    expect(bytesEqual(idSlice, hello.identityPublicKey)).toBe(true);
  });

  it("places the ephemeral pubkey at offset 66 (starting with 0x04)", async () => {
    const hello = await makeHelloFixture();
    const bytes = encodeHello(hello);
    const offset = 1 + PUBLIC_KEY_BYTES;
    const ephSlice = bytes.subarray(offset, offset + PUBLIC_KEY_BYTES);
    expect(ephSlice.length).toBe(PUBLIC_KEY_BYTES);
    expect(ephSlice[0]).toBe(SEC1_UNCOMPRESSED_PREFIX);
    expect(bytesEqual(ephSlice, hello.ephemeralPublicKey)).toBe(true);
  });

  it("places the 32-byte sessionId at offset 131", async () => {
    const hello = await makeHelloFixture();
    const bytes = encodeHello(hello);
    const offset = 1 + PUBLIC_KEY_BYTES + PUBLIC_KEY_BYTES;
    expect(offset).toBe(131);
    const sessionSlice = bytes.subarray(offset, offset + SESSION_ID_BYTES);
    expect(sessionSlice.length).toBe(SESSION_ID_BYTES);
    expect(bytesEqual(sessionSlice, hello.sessionId)).toBe(true);
  });
});

describe("decodeHello round-trip", () => {
  it("round-trips all fields through encode -> decode", async () => {
    const hello = await makeHelloFixture();
    const recovered = decodeHello(encodeHello(hello));
    expect(recovered.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(bytesEqual(recovered.identityPublicKey, hello.identityPublicKey)).toBe(true);
    expect(bytesEqual(recovered.ephemeralPublicKey, hello.ephemeralPublicKey)).toBe(true);
    expect(bytesEqual(recovered.sessionId, hello.sessionId)).toBe(true);
  });

  it("returns Uint8Array instances of the expected widths", async () => {
    const hello = await makeHelloFixture();
    const recovered = decodeHello(encodeHello(hello));
    expect(recovered.identityPublicKey).toBeInstanceOf(Uint8Array);
    expect(recovered.ephemeralPublicKey).toBeInstanceOf(Uint8Array);
    expect(recovered.sessionId).toBeInstanceOf(Uint8Array);
    expect(recovered.identityPublicKey.length).toBe(PUBLIC_KEY_BYTES);
    expect(recovered.ephemeralPublicKey.length).toBe(PUBLIC_KEY_BYTES);
    expect(recovered.sessionId.length).toBe(SESSION_ID_BYTES);
  });
});

describe("decodeHello validation (rejects malformed)", () => {
  it("rejects a length of 162 (one short)", async () => {
    const hello = await makeHelloFixture();
    const truncated = encodeHello(hello).subarray(0, HELLO_BYTES - 1);
    assertMalformed(() => decodeHello(truncated));
  });

  it("rejects a length of 164 (one long)", async () => {
    const hello = await makeHelloFixture();
    const padded = new Uint8Array(HELLO_BYTES + 1);
    padded.set(encodeHello(hello));
    assertMalformed(() => decodeHello(padded));
  });

  it("rejects an unsupported version byte (0x02)", async () => {
    const hello = await makeHelloFixture();
    const bytes = encodeHello(hello);
    bytes[0] = 0x02;
    assertMalformed(() => decodeHello(bytes));
  });

  it("rejects an identity pubkey missing the 0x04 prefix", async () => {
    const hello = await makeHelloFixture();
    const bytes = encodeHello(hello);
    bytes[1] = 0x03;
    assertMalformed(() => decodeHello(bytes));
  });

  it("rejects an ephemeral pubkey missing the 0x04 prefix", async () => {
    const hello = await makeHelloFixture();
    const bytes = encodeHello(hello);
    bytes[1 + PUBLIC_KEY_BYTES] = 0x05;
    assertMalformed(() => decodeHello(bytes));
  });

  it("rejects an identity pubkey that is not on the P-256 curve", async () => {
    const hello = await makeHelloFixture();
    const bytes = encodeHello(hello);
    // Keep the 0x04 prefix but flip a coordinate byte so the point is invalid.
    bytes[1 + PUBLIC_KEY_BYTES - 1] ^= 0xff;
    assertMalformed(() => decodeHello(bytes));
  });
});

describe("encodeSignatureMessage", () => {
  it("produces exactly 65 bytes with version 0x01 at offset 0", () => {
    const sig = encodeSignature(randomBytes(SIGNATURE_BYTES));
    const bytes = encodeSignatureMessage(sig);
    expect(bytes.length).toBe(SIGNATURE_MESSAGE_BYTES);
    expect(bytes[0]).toBe(PROTOCOL_VERSION);
    expect(bytes[0]).toBe(0x01);
  });

  it("places the 64-byte signature at offset 1", () => {
    const sig = encodeSignature(randomBytes(SIGNATURE_BYTES));
    const bytes = encodeSignatureMessage(sig);
    const sigSlice = bytes.subarray(1, 1 + SIGNATURE_BYTES);
    expect(sigSlice.length).toBe(SIGNATURE_BYTES);
    expect(bytesEqual(sigSlice, sig)).toBe(true);
  });
});

describe("decodeSignatureMessage", () => {
  it("round-trips a 64-byte signature", () => {
    const sig = encodeSignature(randomBytes(SIGNATURE_BYTES));
    const recovered = decodeSignatureMessage(encodeSignatureMessage(sig));
    expect(recovered.length).toBe(SIGNATURE_BYTES);
    expect(bytesEqual(recovered, sig)).toBe(true);
  });

  it("rejects a length of 64 (one short)", () => {
    const sig = encodeSignature(randomBytes(SIGNATURE_BYTES));
    const truncated = encodeSignatureMessage(sig).subarray(0, SIGNATURE_MESSAGE_BYTES - 1);
    assertMalformed(() => decodeSignatureMessage(truncated));
  });

  it("rejects a length of 66 (one long)", () => {
    const sig = encodeSignature(randomBytes(SIGNATURE_BYTES));
    const padded = new Uint8Array(SIGNATURE_MESSAGE_BYTES + 1);
    padded.set(encodeSignatureMessage(sig));
    assertMalformed(() => decodeSignatureMessage(padded));
  });

  it("rejects an unsupported version byte (0x02)", () => {
    const sig = encodeSignature(randomBytes(SIGNATURE_BYTES));
    const bytes = encodeSignatureMessage(sig);
    bytes[0] = 0x02;
    assertMalformed(() => decodeSignatureMessage(bytes));
  });
});

describe("buildTranscript", () => {
  async function makeFixture(): Promise<{
    conversationId: ConversationId;
    local: HelloComponents;
    remote: HelloComponents;
  }> {
    const conversationId = encodeConversationId(randomBytes(16));
    const [local, remote] = await Promise.all([makeHelloFixture(), makeHelloFixture()]);
    // Guard against the astronomically unlikely event of equal identity keys
    // (which would make deriveRole throw and invalidate the test).
    if (bytesEqual(local.identityPublicKey, remote.identityPublicKey)) {
      throw new Error("test fixture collision: identical identity keys");
    }
    return { conversationId, local, remote };
  }

  it("produces byte-identical transcript bytes regardless of local/remote swap", async () => {
    const { conversationId, local, remote } = await makeFixture();
    const authMode = AuthMode.SafetyNumberOnly;
    const a = buildTranscript({ conversationId, local, remote, authMode });
    const b = buildTranscript({ conversationId, local: remote, remote: local, authMode });
    expect(bytesEqual(encodeTranscript(a), encodeTranscript(b))).toBe(true);
  });

  it("assigns the initiator identity key per deriveRole (local-initiator case)", async () => {
    const { conversationId, local, remote } = await makeFixture();
    const role = deriveRole(local.identityPublicKey, remote.identityPublicKey);
    const [localInit, remoteResp] = role === Role.Initiator ? [local, remote] : [remote, local];
    const transcript = buildTranscript({
      conversationId,
      local: localInit,
      remote: remoteResp,
      authMode: AuthMode.SafetyNumberOnly,
    });
    expect(bytesEqual(transcript.initiatorIdentityKey, localInit.identityPublicKey)).toBe(true);
    expect(bytesEqual(transcript.responderIdentityKey, remoteResp.identityPublicKey)).toBe(true);
  });

  it("assigns the initiator identity key per deriveRole (local-responder case)", async () => {
    const { conversationId, local, remote } = await makeFixture();
    const role = deriveRole(local.identityPublicKey, remote.identityPublicKey);
    const [localResp, remoteInit] = role === Role.Initiator ? [remote, local] : [local, remote];
    const transcript = buildTranscript({
      conversationId,
      local: localResp,
      remote: remoteInit,
      authMode: AuthMode.SafetyNumberOnly,
    });
    // Here local is the responder, so initiator identity == remote.
    expect(bytesEqual(transcript.initiatorIdentityKey, remoteInit.identityPublicKey)).toBe(true);
    expect(bytesEqual(transcript.responderIdentityKey, localResp.identityPublicKey)).toBe(true);
  });

  it("populates ephemeral keys and session ids in canonical (initiator, responder) order", async () => {
    const { conversationId, local, remote } = await makeFixture();
    const transcript = buildTranscript({
      conversationId,
      local,
      remote,
      authMode: AuthMode.SafetyNumberOnly,
    });
    expect(transcript.transcriptVersion).toBe(TRANSCRIPT_VERSION);
    expect(transcript.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(bytesEqual(transcript.conversationId, conversationId)).toBe(true);
    expect(transcript.authMode).toBe(AuthMode.SafetyNumberOnly);
    const localIsInitiator =
      deriveRole(local.identityPublicKey, remote.identityPublicKey) === Role.Initiator;
    const initEphemeral = localIsInitiator ? local.ephemeralPublicKey : remote.ephemeralPublicKey;
    const initSession = localIsInitiator ? local.sessionId : remote.sessionId;
    const respEphemeral = localIsInitiator ? remote.ephemeralPublicKey : local.ephemeralPublicKey;
    const respSession = localIsInitiator ? remote.sessionId : local.sessionId;
    expect(bytesEqual(transcript.initiatorEphemeralKey, initEphemeral)).toBe(true);
    expect(bytesEqual(transcript.initiatorSessionId, initSession)).toBe(true);
    expect(bytesEqual(transcript.responderEphemeralKey, respEphemeral)).toBe(true);
    expect(bytesEqual(transcript.responderSessionId, respSession)).toBe(true);
  });
});

describe("end-to-end signature over a handshake transcript", () => {
  it("verifies a transcript signed by the local identity, then fails verification when tampered", async () => {
    const alice = await generateIdentityKeyPair();
    const aliceEphemeral = await generateEphemeralKeyPair();
    const bob = await generateIdentityKeyPair();
    const bobEphemeral = await generateEphemeralKeyPair();
    const conversationId = encodeConversationId(randomBytes(16));

    const aliceHello: HelloComponents = {
      protocolVersion: PROTOCOL_VERSION,
      identityPublicKey: alice.publicKey,
      ephemeralPublicKey: aliceEphemeral.publicKey,
      sessionId: encodeSessionId(randomBytes(SESSION_ID_BYTES)),
    };
    const bobHello: HelloComponents = {
      protocolVersion: PROTOCOL_VERSION,
      identityPublicKey: bob.publicKey,
      ephemeralPublicKey: bobEphemeral.publicKey,
      sessionId: encodeSessionId(randomBytes(SESSION_ID_BYTES)),
    };

    const transcript: Transcript = buildTranscript({
      conversationId,
      local: aliceHello,
      remote: bobHello,
      authMode: AuthMode.SafetyNumberOnly,
    });
    const sig: Signature = await signTranscript(alice.privateKey, transcript);
    expect(await verifyTranscript(alice.publicKey, sig, transcript)).toBe(true);

    const tampered: Transcript = buildTranscript({
      conversationId: encodeConversationId(randomBytes(16)),
      local: aliceHello,
      remote: bobHello,
      authMode: AuthMode.SafetyNumberOnly,
    });
    expect(await verifyTranscript(alice.publicKey, sig, tampered)).toBe(false);
  });

  it("both peers build identical transcript bytes, so each can verify the other's signature", async () => {
    const alice = await generateIdentityKeyPair();
    const aliceEphemeral = await generateEphemeralKeyPair();
    const bob = await generateIdentityKeyPair();
    const bobEphemeral = await generateEphemeralKeyPair();
    const conversationId = encodeConversationId(randomBytes(16));

    const aliceHello: HelloComponents = {
      protocolVersion: PROTOCOL_VERSION,
      identityPublicKey: alice.publicKey,
      ephemeralPublicKey: aliceEphemeral.publicKey,
      sessionId: encodeSessionId(randomBytes(SESSION_ID_BYTES)),
    };
    const bobHello: HelloComponents = {
      protocolVersion: PROTOCOL_VERSION,
      identityPublicKey: bob.publicKey,
      ephemeralPublicKey: bobEphemeral.publicKey,
      sessionId: encodeSessionId(randomBytes(SESSION_ID_BYTES)),
    };

    const aliceView = buildTranscript({
      conversationId,
      local: aliceHello,
      remote: bobHello,
      authMode: AuthMode.SafetyNumberOnly,
    });
    const bobView = buildTranscript({
      conversationId,
      local: bobHello,
      remote: aliceHello,
      authMode: AuthMode.SafetyNumberOnly,
    });
    expect(bytesEqual(encodeTranscript(aliceView), encodeTranscript(bobView))).toBe(true);

    const aliceSig = await signTranscript(alice.privateKey, aliceView);
    const bobSig = await signTranscript(bob.privateKey, bobView);

    expect(await verifyTranscript(alice.publicKey, aliceSig, bobView)).toBe(true);
    expect(await verifyTranscript(bob.publicKey, bobSig, aliceView)).toBe(true);

    // Cross-verification must fail: alice's sig must NOT verify against bob's key.
    expect(await verifyTranscript(bob.publicKey, aliceSig, bobView)).toBe(false);
  });
});
