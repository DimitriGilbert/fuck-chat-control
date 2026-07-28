import { describe, expect, it } from "vitest";

import { generateAtRestKey } from "@fuck-eu-chat-control/chat-runtime/crypto";
import { InMemoryConversationRepository } from "@fuck-eu-chat-control/chat-runtime/store";
import { StoreError, StoreErrorCode } from "@fuck-eu-chat-control/chat-runtime/store";

import {
  bytesEqual,
  conversationId,
  deterministicPublicKey,
  fingerprintOf,
} from "./_helpers";

function newRepo(): InMemoryConversationRepository {
  return new InMemoryConversationRepository(generateAtRestKey());
}

describe("InMemoryConversationRepository — peer identity TOFU pin (R8/F1)", () => {
  it("storePeerIdentity overwrites null on first contact", async () => {
    const repo = newRepo();
    const id = conversationId(1);
    await repo.createConversation(id, 1000);
    const keyA = deterministicPublicKey(1);

    await repo.storePeerIdentity(id, fingerprintOf(keyA, 1), keyA);

    const stored = await repo.getPeerIdentity(id);
    expect(stored).not.toBeNull();
    expect(bytesEqual((stored as { publicKey: Uint8Array }).publicKey, keyA)).toBe(true);
  });

  it("storePeerIdentity re-pinning the SAME key is a no-op (safe)", async () => {
    const repo = newRepo();
    const id = conversationId(2);
    await repo.createConversation(id, 1000);
    const keyA = deterministicPublicKey(2);
    const fingerprintA = fingerprintOf(keyA, 2);

    await repo.storePeerIdentity(id, fingerprintA, keyA);
    // Re-pin the same key with a refreshed fingerprint annotation.
    await repo.storePeerIdentity(id, fingerprintOf(keyA, 99), keyA);

    const stored = await repo.getPeerIdentity(id);
    expect(stored).not.toBeNull();
    expect(bytesEqual((stored as { publicKey: Uint8Array }).publicKey, keyA)).toBe(true);
  });

  it("storePeerIdentity on a DIFFERENT pinned key throws PeerIdentityAlreadyPinned", async () => {
    const repo = newRepo();
    const id = conversationId(3);
    await repo.createConversation(id, 1000);
    const keyA = deterministicPublicKey(3);
    const keyB = deterministicPublicKey(4);

    await repo.storePeerIdentity(id, fingerprintOf(keyA, 3), keyA);

    await expect(repo.storePeerIdentity(id, fingerprintOf(keyB, 4), keyB)).rejects.toMatchObject({
      code: StoreErrorCode.PeerIdentityAlreadyPinned,
    });

    // The pinned key is unchanged: the guard refused to overwrite.
    const stored = await repo.getPeerIdentity(id);
    expect(stored).not.toBeNull();
    expect(bytesEqual((stored as { publicKey: Uint8Array }).publicKey, keyA)).toBe(true);
  });

  it("storePeerIdentity on a different pinned key throws a StoreError instance", async () => {
    const repo = newRepo();
    const id = conversationId(4);
    await repo.createConversation(id, 1000);
    const keyA = deterministicPublicKey(5);
    const keyB = deterministicPublicKey(6);

    await repo.storePeerIdentity(id, fingerprintOf(keyA, 5), keyA);

    let caught: unknown = null;
    try {
      await repo.storePeerIdentity(id, fingerprintOf(keyB, 6), keyB);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StoreError);
    expect((caught as StoreError).code).toBe(StoreErrorCode.PeerIdentityAlreadyPinned);
  });

  it("replacePeerIdentity overwrites a pinned key without throwing (Replace-mode seam)", async () => {
    const repo = newRepo();
    const id = conversationId(5);
    await repo.createConversation(id, 1000);
    const keyA = deterministicPublicKey(7);
    const keyB = deterministicPublicKey(8);

    await repo.storePeerIdentity(id, fingerprintOf(keyA, 7), keyA);
    // The trusted Replace-mode import path uses replacePeerIdentity.
    await repo.replacePeerIdentity(id, fingerprintOf(keyB, 8), keyB);

    const stored = await repo.getPeerIdentity(id);
    expect(stored).not.toBeNull();
    expect(bytesEqual((stored as { publicKey: Uint8Array }).publicKey, keyB)).toBe(true);
  });

  it("replacePeerIdentity on a missing conversation throws ConversationNotFound", async () => {
    const repo = newRepo();
    const key = deterministicPublicKey(9);
    await expect(
      repo.replacePeerIdentity(conversationId(99), fingerprintOf(key, 9), key),
    ).rejects.toMatchObject({ code: StoreErrorCode.ConversationNotFound });
  });
});

describe("InMemoryConversationRepository — durable authFailed flag (R7/F3)", () => {
  it("getAuthFailed defaults to false on a fresh conversation", async () => {
    const repo = newRepo();
    const id = conversationId(10);
    await repo.createConversation(id, 1000);
    expect(await repo.getAuthFailed(id)).toBe(false);
  });

  it("markAuthFailed sets the durable flag", async () => {
    const repo = newRepo();
    const id = conversationId(11);
    await repo.createConversation(id, 1000);

    await repo.markAuthFailed(id);

    expect(await repo.getAuthFailed(id)).toBe(true);
    const record = await repo.getConversation(id);
    expect(record?.authFailed).toBe(true);
    expect(record?.authFailedAt).not.toBeNull();
  });

  it("markAuthFailed is idempotent (refreshes the timestamp)", async () => {
    const repo = newRepo();
    const id = conversationId(12);
    await repo.createConversation(id, 1000);

    await repo.markAuthFailed(id);
    const firstAt = (await repo.getConversation(id))?.authFailedAt;
    expect(firstAt).not.toBeNull();

    // Tiny sleep so Date.now() advances.
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    await repo.markAuthFailed(id);
    const secondAt = (await repo.getConversation(id))?.authFailedAt;
    expect(secondAt).not.toBeNull();
    expect(secondAt!).toBeGreaterThanOrEqual(firstAt!);
  });

  it("markAuthFailed on a missing conversation throws ConversationNotFound", async () => {
    const repo = newRepo();
    await expect(repo.markAuthFailed(conversationId(99))).rejects.toMatchObject({
      code: StoreErrorCode.ConversationNotFound,
    });
  });

  it("authFailed survives serialize → reload (durable)", async () => {
    const repo = newRepo();
    const id = conversationId(13);
    await repo.createConversation(id, 1000);
    await repo.markAuthFailed(id);

    const state = repo.serialize();
    const fresh = new InMemoryConversationRepository(generateAtRestKey());
    // Reload uses a different key but authFailed is not ciphertext — it is plain
    // metadata on the conversation record, so a wrong at-rest key only blocks
    // message reads, not the authFailed flag.
    await fresh.reload(generateAtRestKey(), state);

    expect(await fresh.getAuthFailed(id)).toBe(true);
    const record = await fresh.getConversation(id);
    expect(record?.authFailed).toBe(true);
    expect(record?.authFailedAt).not.toBeNull();
  });

  it("older bundles without authFailed fields load as false (backward compat)", async () => {
    const repo = newRepo();
    const id = conversationId(14);
    await repo.createConversation(id, 1000);
    const state = repo.serialize();
    // Simulate an older bundle: strip the authFailed fields.
    const stripped = {
      ...state,
      conversations: state.conversations.map((c) => {
        const { authFailed: _af, authFailedAt: _at, ...rest } = c;
        return rest;
      }),
    };
    const fresh = new InMemoryConversationRepository(generateAtRestKey());
    await fresh.reload(generateAtRestKey(), stripped);
    expect(await fresh.getAuthFailed(id)).toBe(false);
    const record = await fresh.getConversation(id);
    expect(record?.authFailed).toBe(false);
    expect(record?.authFailedAt).toBeNull();
  });
});
