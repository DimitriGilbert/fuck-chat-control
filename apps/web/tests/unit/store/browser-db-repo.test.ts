import { describe, expect, it, vi } from "vitest";

import { createCollection, createTransaction, localOnlyCollectionOptions } from "@tanstack/db";
import type { Collection } from "@tanstack/db";
import { generateAtRestKey } from "@fuck-eu-chat-control/chat-runtime/crypto";
import type { AtRestKey } from "@fuck-eu-chat-control/chat-runtime/crypto";
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
  return makeRepoWithCollections(database).repo;
}

/**
 * Like {@link makeRepoWithDatabase} but also exposes the backing collections
 * and the at-rest key, so tests can inject corrupt rows directly (R6:F3) or
 * reload under the exact key the ciphertext was sealed with.
 */
function makeRepoWithCollections(database: { close?: () => Promise<void> | void } | null = null): {
  repo: BrowserDbConversationRepository;
  atRestKey: AtRestKey;
  conversations: Collection<ConversationRow, string>;
  messages: Collection<MessageRow, string>;
} {
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
  const repo = new BrowserDbConversationRepository(
    { databaseName: "fck-chat-test", atRestKey },
    { databaseName: "fck-chat-test", database, conversations, messages },
  );
  return { repo, atRestKey, conversations, messages };
}

/** Hex key of a ConversationId, matching the repo's row convention. */
function idKeyOf(id: Uint8Array): string {
  return Array.from(id, (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("BrowserDbConversationRepository", () => {
  it("constructs with a database name and a live at-rest key", () => {
    const repo = makeRepo();
    expect(repo.databaseName).toBe("fck-chat-test");
    // R4/F7: the public `atRestKey` field is gone (it aliased a buffer that
    // zeroizeAtRestKey fills and went stale after lock/unlock). The live key
    // is observable only through the CR-7 test seam.
    expect(repo._atRestKeyIsZeroizedForTest()).toBe(false);
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

  it("appendMessage stores a caller-supplied id verbatim (R4/F1)", async () => {
    const repo = makeRepo();
    const id = conversationId(32);
    await repo.createConversation(id, 1);

    const stored = await repo.appendMessage(id, "imported", MessageDirection.Received, 5, {
      id: "bundle-message-id",
    });
    expect(stored.id).toBe("bundle-message-id");
    expect((await repo.getMessages(id)).map((m) => m.id)).toEqual(["bundle-message-id"]);
    // The persisted row key (serialize output) keeps the id — that is what
    // makes the merge path's existingIds dedup effective across devices.
    const state = repo.serialize();
    expect(state.messages[0]?.messages[0]?.id).toBe("bundle-message-id");
  });

  it("appendMessage without an explicit id still generates fresh UUIDs", async () => {
    const repo = makeRepo();
    const id = conversationId(33);
    await repo.createConversation(id, 1);

    const a = await repo.appendMessage(id, "one", MessageDirection.Sent, 1);
    const b = await repo.appendMessage(id, "two", MessageDirection.Sent, 2);
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    expect(a.id).toMatch(uuid);
    expect(b.id).toMatch(uuid);
    expect(a.id).not.toBe(b.id);
  });

  it("appendMessage rejects an explicit empty id", async () => {
    const repo = makeRepo();
    const id = conversationId(34);
    await repo.createConversation(id, 1);
    await expect(
      repo.appendMessage(id, "x", MessageDirection.Sent, 1, { id: "" }),
    ).rejects.toMatchObject({ code: "malformed_bundle" });
    // The rejected write must not have left a row behind.
    expect(await repo.getMessages(id)).toHaveLength(0);
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
    const { repo, atRestKey } = makeRepoWithCollections();
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
    await fresh.reload(atRestKey, state);

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

  it("reload rejects a malformed conversation id hex WITHOUT wiping existing rows (R6/F2/F5)", async () => {
    const repo = makeRepo();
    const id = conversationId(21);
    await repo.createConversation(id, 1);
    await repo.appendMessage(id, "keep me", MessageDirection.Sent, 10);

    const state = {
      conversations: [{ id: "zz-not-hex", createdAt: 1, displayName: null, peer: null }],
      messages: [],
    };
    await expect(repo.reload(generateAtRestKey(), state)).rejects.toMatchObject({
      code: "malformed_bundle",
    });
    // Validation runs BEFORE any mutation: the pre-existing conversation and
    // its message are untouched (previously a mid-loop throw left the repo
    // wiped by clearAll but only partially repopulated).
    const kept = await repo.getConversation(id);
    expect(kept).not.toBeNull();
    expect((await repo.getMessages(id)).map((m) => m.text)).toEqual(["keep me"]);
  });

  it("reload rejects a wrong-length conversation id without mutating (R6/F5)", async () => {
    const repo = makeRepo();
    await repo.createConversation(conversationId(22), 1);
    const state = {
      conversations: [{ id: "aabb", createdAt: 1, displayName: null, peer: null }],
      messages: [],
    };
    await expect(repo.reload(generateAtRestKey(), state)).rejects.toMatchObject({
      code: "malformed_bundle",
    });
    expect(await repo.listConversations()).toHaveLength(1);
  });

  it("reload REPLACES content on surviving keys and drops removed keys (R6:F2 diff)", async () => {
    const { repo, atRestKey } = makeRepoWithCollections();
    const survivor = conversationId(26);
    const removed = conversationId(27);
    const added = conversationId(28);
    await repo.createConversation(survivor, 1);
    await repo.setDisplayName(survivor, "old-name");
    await repo.appendMessage(survivor, "old-message", MessageDirection.Sent, 10);
    await repo.createConversation(removed, 2);

    const state = {
      conversations: [
        {
          id: idKeyOf(survivor),
          createdAt: 1,
          displayName: "new-name",
          peer: null,
        },
        {
          id: idKeyOf(added),
          createdAt: 3,
          displayName: null,
          peer: null,
        },
      ],
      messages: [],
    };
    await repo.reload(atRestKey, state);

    const listed = await repo.listConversations();
    expect(listed).toHaveLength(2);
    const survivorRecord = await repo.getConversation(survivor);
    expect(survivorRecord?.displayName).toBe("new-name");
    // The old message was not in the incoming state, so it must be gone.
    expect(await repo.getMessages(survivor)).toHaveLength(0);
    expect(await repo.getConversation(removed)).toBeNull();
    expect(await repo.getConversation(added)).not.toBeNull();
  });

  it("a single corrupt conversation row does not brick listConversations (R6:F3)", async () => {
    const { repo, conversations } = makeRepoWithCollections();
    const good = conversationId(23);
    await repo.createConversation(good, 1);
    // Inject a row whose id is not valid hex — simulates bit rot / a partial
    // write in the SQLite page.
    conversations.insert({
      id: "!!!corrupt!!!",
      createdAt: 2,
      displayName: null,
      peerFingerprint: null,
      peerPublicKey: null,
      authFailed: false,
      authFailedAt: null,
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const list = await repo.listConversations();
      expect(list).toHaveLength(1);
      expect(list[0]!.id).toEqual(good);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("a single undecryptable message row does not brick getMessages (R6:F3)", async () => {
    const { repo, messages } = makeRepoWithCollections();
    const id = conversationId(24);
    await repo.createConversation(id, 1);
    const first = await repo.appendMessage(id, "good-1", MessageDirection.Sent, 10);
    await repo.appendMessage(id, "good-2", MessageDirection.Sent, 20);
    // Corrupt the FIRST message's ciphertext so its GCM tag check fails.
    messages.update(first.id, (draft) => {
      draft.ciphertext = "AAAAAAAA";
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const list = await repo.getMessages(id);
      expect(list.map((m) => m.text)).toEqual(["good-2"]);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("getMessages still surfaces WrongPassphrase when EVERY row fails to decrypt (R6:F3)", async () => {
    const repo = makeRepo();
    const id = conversationId(25);
    await repo.createConversation(id, 1);
    await repo.appendMessage(id, "a", MessageDirection.Sent, 10);
    await repo.appendMessage(id, "b", MessageDirection.Sent, 20);

    // Reading under a DIFFERENT at-rest key: every row fails — that is a wrong
    // key, not corruption, and must not silently return an empty history.
    repo.zeroizeAtRestKey();
    repo.resetAtRestKey(generateAtRestKey());
    await expect(repo.getMessages(id)).rejects.toMatchObject({
      code: "wrong_passphrase",
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

describe("BrowserDbConversationRepository.close (OPFS handle release, R5:F3 / R6:F1 / R4:F6)", () => {
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

  it("surfaces a driver close failure: logs and rejects (R4:F6)", async () => {
    const failure = new Error("worker gone");
    const close = vi.fn().mockRejectedValue(failure);
    const repo = makeRepoWithDatabase({ close });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // R4/F6: close failures must not be swallowed inside the repo. The
      // production caller (the controller's fire-and-forget dispose()) swallows
      // at its own call site, so the log is what keeps the failure visible
      // there; awaiting callers get the original error.
      await expect(repo.close()).rejects.toBe(failure);
      expect(close).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledTimes(1);
    } finally {
      error.mockRestore();
    }
  });

  it("drains in-flight write persistence before closing the database (R4:F6)", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const { repo, messages } = makeRepoWithCollections({ close });
    const id = conversationId(35);
    await repo.createConversation(id, 1);

    // Gate the message insert's persistence: the repo awaits the returned
    // transaction's isPersisted promise, and this manually-committed
    // transaction settles ONLY when the test commits it.
    const gate = createTransaction({ autoCommit: false, mutationFn: async () => {} });
    const realInsert = messages.insert.bind(messages);
    let signalInsert: () => void = () => {};
    const inserted = new Promise<void>((resolve) => {
      signalInsert = resolve;
    });
    const insertSpy = vi.spyOn(messages, "insert").mockImplementation((data, config) => {
      // Land the row in local state exactly as the real insert would...
      void realInsert(data, config);
      // ...then hand the repo a persistence signal we control.
      signalInsert();
      return gate;
    });

    let appended = false;
    const appending = repo
      .appendMessage(id, "in flight", MessageDirection.Sent, 10)
      .then((message) => {
        appended = true;
        return message;
      });
    // The write registers its persistence synchronously right after insert()
    // returns, so once insert has been observed the drain set is populated.
    await inserted;

    const closing = repo.close();
    // While the commit is still in flight: the DB/Worker must not be released
    // yet, and the write method must not have resolved.
    expect(close).not.toHaveBeenCalled();
    expect(appended).toBe(false);

    await gate.commit(); // release the persistence signal
    await expect(appending).resolves.toBeDefined();
    expect(appended).toBe(true);
    await closing;
    expect(close).toHaveBeenCalledTimes(1);
    insertSpy.mockRestore();
  });
});
