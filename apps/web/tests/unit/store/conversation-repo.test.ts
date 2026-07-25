import { describe, expect, it } from "vitest";

import { CryptoErrorCode, decryptAtRest, generateAtRestKey } from "@/features/chat/crypto";
import { InMemoryConversationRepository } from "@/features/chat/store";
import { MessageDirection } from "@/features/chat/store";
import { StoreErrorCode } from "@/features/chat/store";
import type { AtRestKey } from "@/features/chat/crypto";

import { bytesEqual, conversationId, deterministicPublicKey, fingerprintOf } from "./_helpers";

const PLAINTEXT_A = "hello world";
const PLAINTEXT_B = "second message, a bit longer";

function newRepo(): InMemoryConversationRepository {
  return new InMemoryConversationRepository(generateAtRestKey());
}

interface KeyedRepo {
  readonly repo: InMemoryConversationRepository;
  readonly key: AtRestKey;
}

function newKeyedRepo(): KeyedRepo {
  const key = generateAtRestKey();
  return { repo: new InMemoryConversationRepository(key), key };
}

describe("InMemoryConversationRepository — slice 1 (conversation + encrypted text round trip)", () => {
  it("creates and reads back a conversation record", async () => {
    const repo = newRepo();
    const id = conversationId(1);
    const created = await repo.createConversation(id, 1000);
    expect(bytesEqual(created.id, id)).toBe(true);
    expect(created.createdAt).toBe(1000);
    expect(created.displayName).toBeNull();
    expect(created.peer).toBeNull();

    const fetched = await repo.getConversation(id);
    expect(fetched).not.toBeNull();
    expect(bytesEqual((fetched as { id: Uint8Array }).id, id)).toBe(true);

    const missing = await repo.getConversation(conversationId(2));
    expect(missing).toBeNull();
  });

  it("listConversations returns all records ordered by creation time", async () => {
    const repo = newRepo();
    const idB = conversationId(2);
    const idA = conversationId(1);
    await repo.createConversation(idB, 2000);
    await repo.createConversation(idA, 1000);
    const list = await repo.listConversations();
    expect(list.length).toBe(2);
    expect(bytesEqual(list[0].id, idA)).toBe(true);
    expect(bytesEqual(list[1].id, idB)).toBe(true);
  });

  it("round-trips appended messages as plaintext to the caller", async () => {
    const repo = newRepo();
    const id = conversationId(1);
    await repo.createConversation(id, 1000);
    const m1 = await repo.appendMessage(id, PLAINTEXT_A, MessageDirection.Sent, 1100);
    const m2 = await repo.appendMessage(id, PLAINTEXT_B, MessageDirection.Received, 1200);

    expect(m1.text).toBe(PLAINTEXT_A);
    expect(m1.direction).toBe(MessageDirection.Sent);
    expect(m2.text).toBe(PLAINTEXT_B);

    const messages = await repo.getMessages(id);
    expect(messages.length).toBe(2);
    expect(messages[0].text).toBe(PLAINTEXT_A);
    expect(messages[0].direction).toBe(MessageDirection.Sent);
    expect(messages[1].text).toBe(PLAINTEXT_B);
    expect(bytesEqual(messages[0].conversationId, id)).toBe(true);
  });

  it("stores ciphertext internally, not plaintext", async () => {
    const { repo, key } = newKeyedRepo();
    const id = conversationId(1);
    await repo.createConversation(id, 1000);
    await repo.appendMessage(id, PLAINTEXT_A, MessageDirection.Sent, 1100);

    const raw = await repo._unsafeGetRawMessages(id);
    expect(raw.length).toBe(1);
    const storedText = new TextDecoder().decode(raw[0].ciphertext);
    expect(storedText).not.toBe(PLAINTEXT_A);
    expect(raw[0].nonce.length).toBe(12);

    const roundTripped = await decryptAtRest(key, raw[0].nonce, raw[0].ciphertext);
    expect(new TextDecoder().decode(roundTripped)).toBe(PLAINTEXT_A);
  });

  it("uses a fresh nonce per stored message", async () => {
    const repo = newRepo();
    const id = conversationId(1);
    await repo.createConversation(id, 1000);
    await repo.appendMessage(id, PLAINTEXT_A, MessageDirection.Sent, 1100);
    await repo.appendMessage(id, PLAINTEXT_A, MessageDirection.Sent, 1200);
    const raw = await repo._unsafeGetRawMessages(id);
    expect(bytesEqual(raw[0].nonce, raw[1].nonce)).toBe(false);
  });

  it("reloads from a serialized state under the same at-rest key", async () => {
    const { repo, key } = newKeyedRepo();
    const id = conversationId(1);
    await repo.createConversation(id, 1000);
    await repo.appendMessage(id, PLAINTEXT_A, MessageDirection.Sent, 1100);
    await repo.appendMessage(id, PLAINTEXT_B, MessageDirection.Received, 1200);
    const state = repo.serialize();

    const reloaded = new InMemoryConversationRepository(key);
    expect((await reloaded.listConversations()).length).toBe(0);

    await reloaded.reload(key, state);
    const messages = await reloaded.getMessages(id);
    expect(messages.length).toBe(2);
    expect(messages[0].text).toBe(PLAINTEXT_A);
    expect(messages[1].text).toBe(PLAINTEXT_B);
  });

  it("cannot read a reloaded state with a different at-rest key", async () => {
    const { repo } = newKeyedRepo();
    const id = conversationId(1);
    await repo.createConversation(id, 1000);
    await repo.appendMessage(id, PLAINTEXT_A, MessageDirection.Sent, 1100);
    const state = repo.serialize();

    const reloaded = new InMemoryConversationRepository(generateAtRestKey());
    await reloaded.reload(generateAtRestKey(), state);
    await expect(reloaded.getMessages(id)).rejects.toMatchObject({
      code: StoreErrorCode.WrongPassphrase,
    });
  });

  it("appending to an unknown conversation fails", async () => {
    const repo = newRepo();
    await expect(
      repo.appendMessage(conversationId(9), PLAINTEXT_A, MessageDirection.Sent, 1100),
    ).rejects.toMatchObject({ code: StoreErrorCode.ConversationNotFound });
  });

  it("reading messages of an unknown conversation fails", async () => {
    const repo = newRepo();
    await expect(repo.getMessages(conversationId(9))).rejects.toMatchObject({
      code: StoreErrorCode.ConversationNotFound,
    });
  });
});

describe("InMemoryConversationRepository — slice 2 (TOFU identity + display name)", () => {
  it("stores and looks up a peer identity by fingerprint", async () => {
    const repo = newRepo();
    const id = conversationId(1);
    await repo.createConversation(id, 1000);
    const publicKey = deterministicPublicKey(5);
    const fingerprint = fingerprintOf(publicKey, 1);

    expect(await repo.getPeerIdentity(id)).toBeNull();

    await repo.storePeerIdentity(id, fingerprint, publicKey);
    const stored = await repo.getPeerIdentity(id);
    expect(stored).not.toBeNull();
    expect((stored as { fingerprint: string }).fingerprint).toBe(fingerprint);
    expect(bytesEqual((stored as { publicKey: Uint8Array }).publicKey, publicKey)).toBe(true);
  });

  it("updates the display name and reads it back", async () => {
    const repo = newRepo();
    const id = conversationId(1);
    await repo.createConversation(id, 1000);
    expect(await repo.getDisplayName(id)).toBeNull();

    await repo.setDisplayName(id, "Alice");
    expect(await repo.getDisplayName(id)).toBe("Alice");

    await repo.setDisplayName(id, "Alicia");
    expect(await repo.getDisplayName(id)).toBe("Alicia");
  });

  it("persists identity and display name across reload", async () => {
    const { repo, key } = newKeyedRepo();
    const id = conversationId(1);
    await repo.createConversation(id, 1000);
    const publicKey = deterministicPublicKey(7);
    await repo.storePeerIdentity(id, fingerprintOf(publicKey, 2), publicKey);
    await repo.setDisplayName(id, "Bob");
    const state = repo.serialize();

    const reloaded = new InMemoryConversationRepository(key);
    await reloaded.reload(key, state);

    const peer = await reloaded.getPeerIdentity(id);
    expect(peer).not.toBeNull();
    expect(bytesEqual((peer as { publicKey: Uint8Array }).publicKey, publicKey)).toBe(true);
    expect(await reloaded.getDisplayName(id)).toBe("Bob");
    const convo = await reloaded.getConversation(id);
    expect((convo as { displayName: string }).displayName).toBe("Bob");
  });

  it("rejects peer-identity and display-name writes for unknown conversations", async () => {
    const repo = newRepo();
    const publicKey = deterministicPublicKey(3);
    await expect(repo.storePeerIdentity(conversationId(9), "fp", publicKey)).rejects.toMatchObject({
      code: StoreErrorCode.ConversationNotFound,
    });
    await expect(repo.setDisplayName(conversationId(9), "x")).rejects.toMatchObject({
      code: StoreErrorCode.ConversationNotFound,
    });
  });

  it("wrong-key reload surfaces a store error distinct from the crypto auth code", async () => {
    const { repo } = newKeyedRepo();
    const id = conversationId(1);
    await repo.createConversation(id, 1000);
    await repo.appendMessage(id, PLAINTEXT_A, MessageDirection.Sent, 1100);
    const state = repo.serialize();

    const otherKey = generateAtRestKey();
    const reloaded = new InMemoryConversationRepository(otherKey);
    await reloaded.reload(otherKey, state);
    try {
      await reloaded.getMessages(id);
      throw new Error("expected getMessages to throw");
    } catch (err) {
      const code = (err as { code?: string }).code;
      expect(code).toBe(StoreErrorCode.WrongPassphrase);
      expect(code).not.toBe(CryptoErrorCode.AuthenticationFailed);
    }
  });
});

describe("InMemoryConversationRepository — slice 3 (per-conversation and full wipe)", () => {
  it("clearConversation removes only that conversation's messages and peer record", async () => {
    const repo = newRepo();
    const idKeep = conversationId(1);
    const idWipe = conversationId(2);
    await repo.createConversation(idKeep, 1000);
    await repo.createConversation(idWipe, 2000);
    const keyWipe = deterministicPublicKey(11);
    await repo.storePeerIdentity(idWipe, fingerprintOf(keyWipe, 4), keyWipe);
    await repo.appendMessage(idKeep, PLAINTEXT_A, MessageDirection.Sent, 1100);
    await repo.appendMessage(idWipe, PLAINTEXT_B, MessageDirection.Received, 2100);

    await repo.clearConversation(idWipe);

    expect(await repo.getConversation(idWipe)).toBeNull();
    expect(await repo.getPeerIdentity(idWipe)).toBeNull();
    await expect(repo.getMessages(idWipe)).rejects.toMatchObject({
      code: StoreErrorCode.ConversationNotFound,
    });

    expect(await repo.getConversation(idKeep)).not.toBeNull();
    const kept = await repo.getMessages(idKeep);
    expect(kept.length).toBe(1);
    expect(kept[0].text).toBe(PLAINTEXT_A);
  });

  it("clearConversation is a no-op for an unknown conversation", async () => {
    const repo = newRepo();
    await repo.clearConversation(conversationId(404));
    expect(await repo.listConversations()).toEqual([]);
  });

  it("clearAll wipes every conversation, message, and peer record", async () => {
    const repo = newRepo();
    const idA = conversationId(1);
    const idB = conversationId(2);
    await repo.createConversation(idA, 1000);
    await repo.createConversation(idB, 2000);
    await repo.appendMessage(idA, PLAINTEXT_A, MessageDirection.Sent, 1100);
    await repo.appendMessage(idB, PLAINTEXT_B, MessageDirection.Received, 2100);
    await repo.storePeerIdentity(idA, "fp", deterministicPublicKey(2));

    await repo.clearAll();

    expect(await repo.listConversations()).toEqual([]);
    expect(await repo.getConversation(idA)).toBeNull();
    expect(await repo.getPeerIdentity(idA)).toBeNull();
    expect(repo.serialize().conversations).toEqual([]);
    expect(repo.serialize().messages).toEqual([]);
  });
});
