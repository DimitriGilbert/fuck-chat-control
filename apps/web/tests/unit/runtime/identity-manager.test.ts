import { describe, expect, it } from "vitest";

import { signTranscript } from "@/features/chat/crypto";
import {
  AuthMode,
  type ConversationId,
  type PublicKey,
  type SessionId,
  type Transcript,
} from "@/features/chat/protocol/types";
import {
  PROTOCOL_VERSION,
  SESSION_ID_BYTES,
  TRANSCRIPT_VERSION,
} from "@/features/chat/protocol/limits";

import {
  createIdentityManager,
  IDENTITY_STORAGE_KEY,
} from "@/features/chat/runtime/identity-manager";

import { bytesEqual, fakeStorage } from "./_helpers";

const CONVERSATION_ID_BYTES = 16;

function deterministicConversationId(seed: number): ConversationId {
  const bytes = new Uint8Array(CONVERSATION_ID_BYTES);
  for (let i = 0; i < CONVERSATION_ID_BYTES; i++) bytes[i] = (seed * 31 + i) & 0xff;
  return bytes as unknown as ConversationId;
}

function deterministicSessionId(seed: number): SessionId {
  const bytes = new Uint8Array(SESSION_ID_BYTES);
  for (let i = 0; i < SESSION_ID_BYTES; i++) bytes[i] = (seed * 17 + i + 1) & 0xff;
  return bytes as unknown as SessionId;
}

function deterministicPublicKey(seed: number): PublicKey {
  // Use a valid-length placeholder; not a real P-256 point but only used to
  // build a transcript shape for signing.
  const bytes = new Uint8Array(65);
  bytes[0] = 0x04;
  for (let i = 1; i < 65; i++) bytes[i] = (seed * 7 + i) & 0xff;
  return bytes as unknown as PublicKey;
}

function buildTranscript(): Transcript {
  return {
    transcriptVersion: TRANSCRIPT_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    conversationId: deterministicConversationId(1),
    authMode: AuthMode.SafetyNumberOnly,
    initiatorIdentityKey: deterministicPublicKey(1),
    responderIdentityKey: deterministicPublicKey(2),
    initiatorEphemeralKey: deterministicPublicKey(3),
    responderEphemeralKey: deterministicPublicKey(4),
    initiatorSessionId: deterministicSessionId(1),
    responderSessionId: deterministicSessionId(2),
  };
}

describe("createIdentityManager", () => {
  it("throws when get() is called before ensureLoaded()", () => {
    const storage = fakeStorage();
    const manager = createIdentityManager(storage);
    expect(() => manager.get()).toThrowError(/ensureLoaded/i);
  });

  it("generates and persists an identity on first load", async () => {
    const storage = fakeStorage();
    const manager = createIdentityManager(storage);
    await manager.ensureLoaded();
    const identity = manager.get();
    expect(identity.publicKey.length).toBe(65);
    expect(identity.publicKey[0]).toBe(0x04);
    expect(identity.privateKey.length).toBeGreaterThan(0);
    // Persisted as base64 under the well-known storage key.
    expect(storage.store.has(IDENTITY_STORAGE_KEY)).toBe(true);
    const raw = storage.store.get(IDENTITY_STORAGE_KEY);
    expect(typeof raw).toBe("string");
    expect(raw).toContain("publicKeyBase64");
    expect(raw).toContain("privateKeyBase64");
  });

  it("the persisted identity signs transcripts (real crypto)", async () => {
    const storage = fakeStorage();
    const manager = createIdentityManager(storage);
    await manager.ensureLoaded();
    const identity = manager.get();
    const transcript = buildTranscript();
    const signature = await identity.sign(transcript);
    expect(signature.length).toBe(64);
    // Cross-check: the same private key produces the same signature when
    // signing deterministically (P-256 signing here is deterministic, RFC6979).
    const expected = await signTranscript(identity.privateKey, transcript);
    expect(bytesEqual(signature, expected)).toBe(true);
  });

  it("returns the SAME identity across reloads (idempotent)", async () => {
    const storage = fakeStorage();
    const first = createIdentityManager(storage);
    await first.ensureLoaded();
    const identityA = first.get();

    // A second manager sharing the same storage returns the same key.
    const second = createIdentityManager(storage);
    await second.ensureLoaded();
    const identityB = second.get();

    expect(bytesEqual(identityA.publicKey, identityB.publicKey)).toBe(true);
    expect(bytesEqual(identityA.privateKey, identityB.privateKey)).toBe(true);
  });

  it("ensureLoaded is idempotent within a single manager", async () => {
    const storage = fakeStorage();
    const manager = createIdentityManager(storage);
    await manager.ensureLoaded();
    const before = manager.get();
    await manager.ensureLoaded();
    const after = manager.get();
    expect(bytesEqual(before.publicKey, after.publicKey)).toBe(true);
  });

  it("rebuilds a working signer from persisted base64", async () => {
    const storage = fakeStorage();
    const setup = createIdentityManager(storage);
    await setup.ensureLoaded();
    const original = setup.get();
    const transcript = buildTranscript();
    const referenceSignature = await original.sign(transcript);

    // Brand-new manager, same storage — should load the persisted key.
    const reloaded = createIdentityManager(storage);
    await reloaded.ensureLoaded();
    const rebuilt = reloaded.get();
    expect(bytesEqual(rebuilt.publicKey, original.publicKey)).toBe(true);
    const rebuiltSignature = await rebuilt.sign(transcript);
    expect(bytesEqual(rebuiltSignature, referenceSignature)).toBe(true);
  });
});
