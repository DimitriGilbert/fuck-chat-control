import { p256 } from "@noble/curves/p256";
import { describe, expect, it } from "vitest";

import { derivePublicKeyFromPrivate, verifyTranscript } from "@/features/chat/crypto";
import { encodePublicKey } from "@/features/chat/protocol/codec";
import {
  PROTOCOL_VERSION,
  PUBLIC_KEY_BYTES,
  SESSION_ID_BYTES,
  TRANSCRIPT_VERSION,
} from "@/features/chat/protocol/limits";
import { AuthMode } from "@/features/chat/protocol/types";
import type {
  ConversationId,
  PublicKey,
  SessionId,
  Signature,
  Transcript,
} from "@/features/chat/protocol/types";
import { encodeConversationId, encodeSessionId } from "@/features/chat/protocol/codec";

import {
  createIdentityManager,
  IDENTITY_STORAGE_KEY,
} from "@/features/chat/runtime/identity-manager";

import { bytesEqual, fakeStorage } from "./_helpers";

const CONVERSATION_ID_BYTES = 16;

function deterministicConversationId(seed: number): ConversationId {
  const bytes = new Uint8Array(CONVERSATION_ID_BYTES);
  for (let i = 0; i < CONVERSATION_ID_BYTES; i++) bytes[i] = (seed * 31 + i) & 0xff;
  return encodeConversationId(bytes);
}

function deterministicSessionId(seed: number): SessionId {
  const bytes = new Uint8Array(SESSION_ID_BYTES);
  for (let i = 0; i < SESSION_ID_BYTES; i++) bytes[i] = (seed * 17 + i + 1) & 0xff;
  return encodeSessionId(bytes);
}

/**
 * Real on-curve P-256 public key for transcript shaping. We derive from a
 * deterministic private scalar so the test is reproducible while still
 * exercising the real EC math (the signature path hashes and verifies against
 * a valid curve point).
 */
function realPublicKey(seed: number): PublicKey {
  const sk = new Uint8Array(32);
  for (let i = 0; i < 32; i++) sk[i] = (seed * 7 + i + 1) & 0xff;
  return encodePublicKey(p256.getPublicKey(sk, false));
}

function buildTranscript(): Transcript {
  return {
    transcriptVersion: TRANSCRIPT_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    conversationId: deterministicConversationId(1),
    authMode: AuthMode.SafetyNumberOnly,
    initiatorIdentityKey: realPublicKey(1),
    responderIdentityKey: realPublicKey(2),
    initiatorEphemeralKey: realPublicKey(3),
    responderEphemeralKey: realPublicKey(4),
    initiatorSessionId: deterministicSessionId(1),
    responderSessionId: deterministicSessionId(2),
  };
}

/**
 * Generate a real P-256 keypair via the same path the production code uses
 * (`p256.utils.randomSecretKey` + `getPublicKey`). Returns the raw scalar so
 * we can pass it to `adoptImportedIdentity` exactly as the bundle decoder
 * would (a 32-byte Uint8Array).
 */
async function freshKeyPair(): Promise<{ privateKey: Uint8Array; publicKey: PublicKey }> {
  const privateKey = p256.utils.randomSecretKey();
  const publicKey = derivePublicKeyFromPrivate(privateKey);
  return { privateKey, publicKey };
}

describe("IdentityManager.adoptImportedIdentity (SEC-3)", () => {
  it("overwrites the persisted identity (storage holds the NEW key after adoption)", async () => {
    const storage = fakeStorage();
    const manager = createIdentityManager(storage);
    await manager.ensureLoaded();
    const original = manager.get();

    const imported = await freshKeyPair();
    await manager.adoptImportedIdentity(imported.privateKey);

    const raw = storage.getItem(IDENTITY_STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as {
      publicKeyBase64: string;
      privateKeyBase64: string;
    };
    // The persisted private key is the IMPORTED one, not the original.
    expect(parsed.privateKeyBase64).not.toBe(
      bytesToBase64Hex(original.privateKey),
    );
    // And it round-trips back to the imported scalar exactly.
    const storedPrivate = base64ToBytesHelper(parsed.privateKeyBase64);
    expect(bytesEqual(storedPrivate, imported.privateKey)).toBe(true);
    const storedPublic = base64ToBytesHelper(parsed.publicKeyBase64);
    expect(bytesEqual(storedPublic, imported.publicKey)).toBe(true);
  });

  it("derives publicKey from the imported privateKey (round-trip a real P-256 keypair)", async () => {
    const storage = fakeStorage();
    const manager = createIdentityManager(storage);
    await manager.ensureLoaded();

    const imported = await freshKeyPair();
    await manager.adoptImportedIdentity(imported.privateKey);

    const after = manager.get();
    expect(after.privateKey.length).toBe(imported.privateKey.length);
    expect(bytesEqual(after.privateKey, imported.privateKey)).toBe(true);
    // The publicKey returned by get() MUST equal derivePublicKeyFromPrivate()
    // for the same scalar — proves the manager rebuilt the SEC1 point from
    // the curve rather than re-using a stale stored value.
    const expectedPublic = derivePublicKeyFromPrivate(imported.privateKey);
    expect(after.publicKey.length).toBe(PUBLIC_KEY_BYTES);
    expect(bytesEqual(after.publicKey, expectedPublic)).toBe(true);
    // Sanity: the expectedPublic itself is the canonical uncompressed point.
    expect(expectedPublic[0]).toBe(0x04);
    expect(p256.utils.isValidPublicKey(expectedPublic, false)).toBe(true);
  });

  it("returns the imported pair WITHOUT an ensureLoaded round-trip (overwrites a pre-existing identity)", async () => {
    // Seed storage with a DIFFERENT identity first, then adopt on a manager
    // that has NOT called ensureLoaded() — proving the adoption is the
    // source of truth, not the stored value.
    const storage = fakeStorage();
    const seeder = createIdentityManager(storage);
    await seeder.ensureLoaded();
    const storedBeforeAdoption = seeder.get();
    // New manager instance, fresh in-memory state, sharing the seeded storage.
    const manager = createIdentityManager(storage);

    const imported = await freshKeyPair();
    // Critically, imported must differ from the seeded identity or this test
    // proves nothing.
    expect(bytesEqual(imported.privateKey, storedBeforeAdoption.privateKey)).toBe(false);

    await manager.adoptImportedIdentity(imported.privateKey);
    const after = manager.get();
    expect(bytesEqual(after.privateKey, imported.privateKey)).toBe(true);
    expect(bytesEqual(after.publicKey, imported.publicKey)).toBe(true);
    // And the returned pair is NOT the previously-stored one.
    expect(bytesEqual(after.privateKey, storedBeforeAdoption.privateKey)).toBe(false);
    expect(bytesEqual(after.publicKey, storedBeforeAdoption.publicKey)).toBe(false);
  });

  it("the adopted sign closure produces a signature that verifies against its publicKey", async () => {
    const storage = fakeStorage();
    const manager = createIdentityManager(storage);
    await manager.ensureLoaded();

    const imported = await freshKeyPair();
    await manager.adoptImportedIdentity(imported.privateKey);
    const after = manager.get();

    const transcript = buildTranscript();
    const signature: Signature = await after.sign(transcript);
    // 64-byte IEEE P1363 / compact signature (matches SIGNATURE_BYTES).
    expect(signature.length).toBe(64);
    // The signature MUST verify against the adopted public key.
    expect(await verifyTranscript(after.publicKey, signature, transcript)).toBe(true);
    // And MUST NOT verify against an unrelated key (tamper check).
    const other = await freshKeyPair();
    expect(await verifyTranscript(other.publicKey, signature, transcript)).toBe(false);
  });
});

// ---- local helpers (kept private to avoid polluting the shared _helpers) ----

function bytesToBase64Hex(bytes: Uint8Array): string {
  // Mirror the storage encoding (base64) so the comparison is apples-to-apples
  // with the original key's persisted form. Implemented locally rather than
  // reaching into the store/encoding module so this test stays self-contained
  // for the equality assertion.
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToBytesHelper(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
