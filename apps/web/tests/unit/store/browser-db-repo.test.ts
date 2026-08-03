import { describe, expect, it, vi } from "vitest";

import { createCollection, localOnlyCollectionOptions } from "@tanstack/db";
import { generateAtRestKey } from "@fuck-eu-chat-control/chat-runtime/crypto";
import { MessageDirection } from "@fuck-eu-chat-control/chat-runtime/store";

import { BrowserDbConversationRepository } from "@/features/chat/store/browser-db-repo";
import type { ConversationRow, MessageRow } from "@/features/chat/store/browser-db-repo";

import { conversationId, deterministicPublicKey } from "./_helpers";

/**
 * Unit tests for {@link BrowserDbConversationRepository}.
 *
 * The repo's backing store is two TanStack DB collections. In a browser it
 * opens them over wa-sqlite/OPFS via {@link BrowserDbConversationRepository.create};
 * here we build the SAME collection types with `localOnlyCollectionOptions`
 * and hand them to the constructor directly, so every line of repo logic
 * (at-rest encryption, TOFU peer pinning, serialize/reload, auth-failed
 * durability, clear) is exercised without a browser/Worker/OPFS. The
 * cross-reload OPFS survival is proven by the Playwright e2e suite.
 */
function makeRepo(): BrowserDbConversationRepository {
  return makeRepoWithDatabase(null);
}

/**
 * Build a repo backed by local-only collections but carrying an optional
 * `database` handle, mirroring what {@link BrowserDbConversationRepository.create}
 * wires in production. Tests pass a fake `database` with a spy `close` to
 * verify the OPFS-handle release path without a browser/Worker/OPFS.
 */
function makeRepoWithDatabase(
  database: { close?: () => Promise<void> | void } | null,
): BrowserDbConversationRepository {
  const atRestKey = generateAtRestKey();
  const conversations = createCollection(
    localOnlyCollectionOptions<ConversationRow, string>({
      getKey: (row) => row.id,
    }),
  );
  const messages = createCollection(
    localOnlyCollectionOptions<MessageRow, string>({
      getKey: (row) => row.id,
    }),
  );
  return new BrowserDbConversationRepository(
    { databaseName: "fck-chat-test", atRestKey },
    { databaseName: "fck-chat-test", database, conversations, messages },
  );
}

describe("BrowserDbConversationRepository", () => {
  it("constructs with a database name and at-rest key", () => {
    const repo = makeRepo();
    expect(repo.databaseName).toBe("fck-chat-test");
    expect(repo.atRestKey).toBeInstanceOf(Uint8Array);
  });

  it("creates, lists, and reads back a conversation", async () => {
    const repo = makeRepo();
    const id = conversationId(1);
    const created = await repo.createConversation(id, 1000);
    expect(created.createdAt).toBe(1000);
    expect(created.displayName).toBeNull();
    expect(created.peer).toBeNull();
    expect(created.authFailed).toBe(false);

    const fetched = await repo.getConversation(id);
    expect(fetched).not.toBeNull();
    expect(fetched?.id).toEqual(id);

    const list = await repo.listConversations();
    expect(list).toHaveLength(1);
    expect(list[0].id).toEqual(id);
  });

  it("returns null for an unknown conversation", async () => {
    const repo = makeRepo();
    expect(await repo.getConversation(conversationId(99))).toBeNull();
  });

  it("appends a message and decrypts it on read (at-rest round-trip)", async () => {
    const repo = makeRepo();
    const id = conversationId(2);
    await repo.createConversation(id, 1);

    const sent = await repo.appendMessage(id, "hello world", MessageDirection.Sent, 100);
    expect(sent.text).toBe("hello world");
    expect(sent.direction).toBe(MessageDirection.Sent);

    const received = await repo.appendMessage(id, "hi there", MessageDirection.Received, 200);
    const messages = await repo.getMessages(id);
    expect(messages.map((m) => m.text)).toEqual(["hello world", "hi there"]);
    expect(messages.map((m) => m.direction)).toEqual([
      MessageDirection.Sent,
      MessageDirection.Received,
    ]);
    // The persisted rows must NOT contain the plaintext: verify the serialize()
    // output carries ciphertext/nonces, never the cleartext.
    const state = repo.serialize();
    for (const group of state.messages) {
      for (const m of group.messages) {
        expect(m.ciphertext.length).toBeGreaterThan(0);
        expect(m.nonce.length).toBeGreaterThan(0);
        expect(m).not.toHaveProperty("text");
        expect(JSON.stringify(m)).not.toContain("hello world");
        expect(JSON.stringify(m)).not.toContain("hi there");
      }
    }
    void sent;
    void received;
  });

  it("rejects appending to a non-existent conversation", async () => {
    const repo = makeRepo();
    await expect(
      repo.appendMessage(conversationId(3), "x", MessageDirection.Sent, 1),
    ).rejects.toMatchObject({ code: "conversation_not_found" });
  });

  it("pins a peer identity and rejects a different key (TOFU)", async () => {
    const repo = makeRepo();
    const id = conversationId(4);
    await repo.createConversation(id, 1);
    await repo.storePeerIdentity(id, "fp-1", deterministicPublicKey(1));

    const stored = await repo.getPeerIdentity(id);
    expect(stored?.fingerprint).toBe("fp-1");

    // Re-pinning the SAME key is a no-op (safe).
    await expect(
      repo.storePeerIdentity(id, "fp-1-refresh", deterministicPublicKey(1)),
    ).resolves.toBeUndefined();

    // A DIFFERENT key must be refused.
    await expect(
      repo.storePeerIdentity(id, "fp-2", deterministicPublicKey(2)),
    ).rejects.toMatchObject({
      code: "peer_identity_already_pinned",
    });
  });

  it("replacePeerIdentity overwrites a pinned key (trusted import path)", async () => {
    const repo = makeRepo();
    const id = conversationId(5);
    await repo.createConversation(id, 1);
    await repo.storePeerIdentity(id, "fp-1", deterministicPublicKey(1));
    await repo.replacePeerIdentity(id, "fp-2", deterministicPublicKey(2));
    const stored = await repo.getPeerIdentity(id);
    expect(stored?.fingerprint).toBe("fp-2");
  });

  it("sets and reads a display name", async () => {
    const repo = makeRepo();
    const id = conversationId(6);
    await repo.createConversation(id, 1);
    await repo.setDisplayName(id, "Alice");
    expect(await repo.getDisplayName(id)).toBe("Alice");
  });

  it("marks auth-failed idempotently and records a timestamp", async () => {
    const repo = makeRepo();
    const id = conversationId(7);
    await repo.createConversation(id, 1);
    expect(await repo.getAuthFailed(id)).toBe(false);

    await repo.markAuthFailed(id);
    expect(await repo.getAuthFailed(id)).toBe(true);
    const first = (await repo.getConversation(id))?.authFailedAt;
    expect(first).not.toBeNull();

    // A second mark refreshes the timestamp (most recent failure recorded).
    await repo.markAuthFailed(id);
    expect(await repo.getAuthFailed(id)).toBe(true);
  });

  it("clears a single conversation (messages + metadata)", async () => {
    const repo = makeRepo();
    const id = conversationId(8);
    await repo.createConversation(id, 1);
    await repo.appendMessage(id, "msg", MessageDirection.Sent, 10);
    await repo.clearConversation(id);
    expect(await repo.getConversation(id)).toBeNull();
    await expect(repo.getMessages(id)).rejects.toMatchObject({
      code: "conversation_not_found",
    });
  });

  it("clears all conversations", async () => {
    const repo = makeRepo();
    await repo.createConversation(conversationId(10), 1);
    await repo.createConversation(conversationId(11), 2);
    await repo.clearAll();
    expect(await repo.listConversations()).toHaveLength(0);
  });

  it("serialize/reload round-trips conversations, messages, and peer pins", async () => {
    const repo = makeRepo();
    const id = conversationId(12);
    await repo.createConversation(id, 5000);
    await repo.setDisplayName(id, "Bob");
    await repo.storePeerIdentity(id, "fp-x", deterministicPublicKey(9));
    await repo.appendMessage(id, "persist me", MessageDirection.Received, 42);
    await repo.markAuthFailed(id);

    const state = repo.serialize();
    // Reload into a fresh repo with the SAME at-rest key: the serialized
    // ciphertext was sealed under it, so a different key would (correctly)
    // fail to decrypt.
    const fresh = makeRepo();
    await fresh.reload(repo.atRestKey, state);

    const convo = await fresh.getConversation(id);
    expect(convo?.displayName).toBe("Bob");
    expect(convo?.peer?.fingerprint).toBe("fp-x");
    expect(convo?.authFailed).toBe(true);

    const messages = await fresh.getMessages(id);
    expect(messages.map((m) => m.text)).toEqual(["persist me"]);
  });

  it("reload refuses messages for an unknown conversation", async () => {
    const repo = makeRepo();
    const state = {
      conversations: [],
      messages: [
        {
          conversationId: "deadbeefdeadbeefdeadbeefdeadbeef",
          messages: [
            {
              id: "x",
              direction: MessageDirection.Sent,
              timestamp: 1,
              nonce: "AAAA",
              ciphertext: "AAAA",
            },
          ],
        },
      ],
    };
    await expect(repo.reload(generateAtRestKey(), state)).rejects.toMatchObject({
      code: "malformed_bundle",
    });
  });

  it("zeroizeAtRestKey drops the live key, resetAtRestKey restores it (CR-7)", async () => {
    const repo = makeRepo();
    expect(repo._atRestKeyIsZeroizedForTest()).toBe(false);
    repo.zeroizeAtRestKey();
    expect(repo._atRestKeyIsZeroizedForTest()).toBe(true);

    const id = conversationId(13);
    await repo.createConversation(id, 1);
    // Without a key, ciphertext-touching calls must refuse to encrypt.
    await expect(
      repo.appendMessage(id, "should fail", MessageDirection.Sent, 1),
    ).rejects.toMatchObject({ code: "not_initialized" });

    const freshKey = generateAtRestKey();
    repo.resetAtRestKey(freshKey);
    expect(repo._atRestKeyIsZeroizedForTest()).toBe(false);
    await expect(
      repo.appendMessage(id, "now works", MessageDirection.Sent, 2),
    ).resolves.toBeDefined();
  });
});

describe("BrowserDbConversationRepository.close (OPFS handle release, R5:F3 / R6:F1)", () => {
  it("invokes the database close() exactly once and is idempotent", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const repo = makeRepoWithDatabase({ close });

    await repo.close();
    expect(close).toHaveBeenCalledTimes(1);

    // A second close() must be a no-op: the underlying handle was already
    // released, and re-invoking the driver close could double-free the Worker.
    await repo.close();
    await repo.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when the repo was built without a backing database", async () => {
    const repo = makeRepoWithDatabase(null);
    // Must not throw and must resolve. Local-only test repos pass no DB.
    await expect(repo.close()).resolves.toBeUndefined();
  });

  it("still resolves (swallows) when the driver close rejects", async () => {
    const close = vi.fn().mockRejectedValue(new Error("worker gone"));
    const repo = makeRepoWithDatabase({ close });
    // dispose() must never throw on a failed close.
    await expect(repo.close()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
