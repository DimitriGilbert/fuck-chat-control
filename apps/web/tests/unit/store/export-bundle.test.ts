import { describe, expect, it } from "vitest";

import { generateAtRestKey } from "@/features/chat/crypto";
import {
  ImportMode,
  InMemoryConversationRepository,
  StoreErrorCode,
  exportBundle,
  importBundle,
} from "@/features/chat/store";
import type { ImportResult } from "@/features/chat/store";

import { bytesEqual, conversationId, deterministicPublicKey, fingerprintOf } from "./_helpers";

const PASSPHRASE = "correct horse battery staple";

function freshRepo(): InMemoryConversationRepository {
  return new InMemoryConversationRepository(generateAtRestKey());
}

async function seedConversation(
  repo: InMemoryConversationRepository,
  seed: number,
  createdAt: number,
  opts?: {
    readonly displayName?: string;
    readonly peerSeed?: number;
    readonly messages?: ReadonlyArray<{
      readonly text: string;
      readonly dir: "sent" | "received";
      readonly ts: number;
    }>;
  },
): Promise<void> {
  const id = conversationId(seed);
  await repo.createConversation(id, createdAt);
  if (opts?.displayName !== undefined) {
    await repo.setDisplayName(id, opts.displayName);
  }
  if (opts?.peerSeed !== undefined) {
    const publicKey = deterministicPublicKey(opts.peerSeed);
    await repo.storePeerIdentity(id, fingerprintOf(publicKey, opts.peerSeed), publicKey);
  }
  for (const m of opts?.messages ?? []) {
    await repo.appendMessage(id, m.text, m.dir, m.ts);
  }
}

describe("export/import bundle — slice 4 (round trip, wrong passphrase, single blob)", () => {
  it("round-trips conversations, messages, peer identity, and display name", async () => {
    const source = freshRepo();
    await seedConversation(source, 1, 1000, {
      displayName: "Alice",
      peerSeed: 5,
      messages: [
        { text: "hi", dir: "sent", ts: 1100 },
        { text: "hello", dir: "received", ts: 1200 },
      ],
    });
    await seedConversation(source, 2, 2000, {
      messages: [{ text: "second convo", dir: "sent", ts: 2100 }],
    });

    const bundle = await exportBundle(PASSPHRASE, source);

    const target = freshRepo();
    const result = await importBundle(PASSPHRASE, bundle, target, ImportMode.Replace);

    expect(result.conversationsAdded).toBe(2);
    expect(result.messagesImported).toBe(3);
    expect(result.conflicts).toEqual([]);

    const list = await target.listConversations();
    expect(list.length).toBe(2);

    const messages = await target.getMessages(conversationId(1));
    expect(messages.map((m) => m.text)).toEqual(["hi", "hello"]);
    expect(messages[0].direction).toBe("sent");
    expect(messages[1].direction).toBe("received");

    const peer = await target.getPeerIdentity(conversationId(1));
    expect(peer).not.toBeNull();
    expect(
      bytesEqual((peer as { publicKey: Uint8Array }).publicKey, deterministicPublicKey(5)),
    ).toBe(true);

    expect(await target.getDisplayName(conversationId(1))).toBe("Alice");
  });

  it("fails with the wrong passphrase and leaves the target untouched", async () => {
    const source = freshRepo();
    await seedConversation(source, 1, 1000, {
      messages: [{ text: "secret", dir: "sent", ts: 1100 }],
    });
    const bundle = await exportBundle(PASSPHRASE, source);

    const target = freshRepo();
    await seedConversation(target, 9, 9000, {
      messages: [{ text: "preexisting", dir: "sent", ts: 9100 }],
    });

    const before = (await target.listConversations()).length;
    await expect(
      importBundle("wrong passphrase", bundle, target, ImportMode.Replace),
    ).rejects.toMatchObject({
      code: StoreErrorCode.WrongPassphrase,
    });
    const after = (await target.listConversations()).length;
    expect(after).toBe(before);
    const msgs = await target.getMessages(conversationId(9));
    expect(msgs[0].text).toBe("preexisting");
  });

  it("produces a single self-contained JSON blob matching the protocol envelope", async () => {
    const source = freshRepo();
    await seedConversation(source, 1, 1000, {
      messages: [{ text: "x", dir: "sent", ts: 1100 }],
    });
    const bundle = await exportBundle(PASSPHRASE, source);
    expect(typeof bundle).toBe("string");

    const envelope = JSON.parse(bundle) as Record<string, unknown>;
    expect(envelope["v"]).toBe(1);
    const kdf = envelope["kdf"] as Record<string, unknown>;
    expect(kdf["algorithm"]).toBe("argon2id");
    expect(kdf["version"]).toBe(19);
    expect(kdf["m"]).toBe(67108864);
    expect(kdf["t"]).toBe(3);
    expect(kdf["p"]).toBe(1);
    expect(typeof kdf["salt"]).toBe("string");
    const aead = envelope["aead"] as Record<string, unknown>;
    expect(aead["algorithm"]).toBe("aes-256-gcm");
    expect(typeof aead["nonce"]).toBe("string");
    expect(typeof envelope["ciphertext"]).toBe("string");
    expect((kdf["salt"] as string).length).toBeGreaterThanOrEqual(24);
  });

  it("includes and restores the device identity private key", async () => {
    const source = freshRepo();
    await seedConversation(source, 1, 1000);
    const identityKey = new Uint8Array(32);
    for (let i = 0; i < 32; i++) identityKey[i] = (i * 3 + 1) & 0xff;

    const bundle = await exportBundle(PASSPHRASE, source, identityKey);
    const target = freshRepo();
    const result = await importBundle(PASSPHRASE, bundle, target, ImportMode.Replace);
    expect(result.deviceIdentity).not.toBeNull();
    expect(bytesEqual(result.deviceIdentity as Uint8Array, identityKey)).toBe(true);
  });

  it("rejects a malformed bundle without mutating state", async () => {
    const target = freshRepo();
    await seedConversation(target, 1, 1000, {
      messages: [{ text: "keep", dir: "sent", ts: 1100 }],
    });
    const before = await target.getMessages(conversationId(1));

    await expect(
      importBundle(PASSPHRASE, "{not json", target, ImportMode.Replace),
    ).rejects.toMatchObject({
      code: StoreErrorCode.MalformedBundle,
    });
    await expect(
      importBundle(PASSPHRASE, JSON.stringify({ v: 1 }), target, ImportMode.Replace),
    ).rejects.toMatchObject({ code: StoreErrorCode.MalformedBundle });

    const after = await target.getMessages(conversationId(1));
    expect(after.length).toBe(before.length);
    expect(after[0].text).toBe("keep");
  });

  it("rejects an unsupported bundle version without mutating state", async () => {
    const target = freshRepo();
    await seedConversation(target, 1, 1000);
    const bogus = JSON.stringify({ v: 99, kdf: {}, aead: {}, ciphertext: "" });
    await expect(importBundle(PASSPHRASE, bogus, target, ImportMode.Replace)).rejects.toMatchObject(
      {
        code: StoreErrorCode.UnsupportedBundleVersion,
      },
    );
    expect((await target.listConversations()).length).toBe(1);
  });

  it("produces distinct salts per export (fresh randomness)", async () => {
    const source = freshRepo();
    await seedConversation(source, 1, 1000);
    const a = JSON.parse(await exportBundle(PASSPHRASE, source)) as { kdf: { salt: string } };
    const b = JSON.parse(await exportBundle(PASSPHRASE, source)) as { kdf: { salt: string } };
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
  });
});

describe("export/import bundle — slice 5 (merge and replace behavior)", () => {
  it("replace mode overwrites all local data", async () => {
    const target = freshRepo();
    await seedConversation(target, 1, 1000, {
      messages: [{ text: "old", dir: "sent", ts: 1100 }],
    });

    const source = freshRepo();
    await seedConversation(source, 2, 2000, {
      messages: [{ text: "new", dir: "received", ts: 2100 }],
    });
    const bundle = await exportBundle(PASSPHRASE, source);

    const result = await importBundle(PASSPHRASE, bundle, target, ImportMode.Replace);
    expect(result.conversationsAdded).toBe(1);

    const list = await target.listConversations();
    expect(list.length).toBe(1);
    expect(bytesEqual(list[0].id, conversationId(2))).toBe(true);
    expect(await target.getConversation(conversationId(1))).toBeNull();
    const msgs = await target.getMessages(conversationId(2));
    expect(msgs[0].text).toBe("new");
  });

  it("merge mode adds new conversations and unions messages by id", async () => {
    const target = freshRepo();
    const sharedId = conversationId(1);
    await target.createConversation(sharedId, 1000);
    await target.appendMessage(sharedId, "local-only", "sent", 1100);

    const source = freshRepo();
    await source.createConversation(sharedId, 1000);
    await source.appendMessage(sharedId, "incoming-only", "received", 1200);
    await seedConversation(source, 2, 2000, {
      messages: [{ text: "new convo", dir: "sent", ts: 2100 }],
    });
    const bundle = await exportBundle(PASSPHRASE, source);

    const result = await importBundle(PASSPHRASE, bundle, target, ImportMode.Merge);
    expect(result.conversationsAdded).toBe(1);
    expect(result.conversationsMerged).toBe(1);
    expect(result.messagesImported).toBe(2);
    expect(result.conflicts).toEqual([]);

    const merged = await target.getMessages(sharedId);
    expect(merged.map((m) => m.text).sort()).toEqual(["incoming-only", "local-only"]);
    expect(await target.getConversation(conversationId(2))).not.toBeNull();
  });

  it("merge never silently replaces an existing peer identity; reports a conflict", async () => {
    const target = freshRepo();
    const sharedId = conversationId(1);
    const existingKey = deterministicPublicKey(11);
    await target.createConversation(sharedId, 1000);
    await target.storePeerIdentity(sharedId, fingerprintOf(existingKey, 11), existingKey);

    const source = freshRepo();
    const incomingKey = deterministicPublicKey(22);
    await source.createConversation(sharedId, 1000);
    await source.storePeerIdentity(sharedId, fingerprintOf(incomingKey, 22), incomingKey);
    const bundle = await exportBundle(PASSPHRASE, source);

    const result = await importBundle(PASSPHRASE, bundle, target, ImportMode.Merge);
    expect(result.conflicts.length).toBe(1);
    const conflict = result.conflicts[0];
    expect(bytesEqual(conflict.existing.publicKey, existingKey)).toBe(true);
    expect(bytesEqual(conflict.incoming.publicKey, incomingKey)).toBe(true);

    const stillThere = await target.getPeerIdentity(sharedId);
    expect(bytesEqual((stillThere as { publicKey: Uint8Array }).publicKey, existingKey)).toBe(true);
  });

  it("merge stores the incoming peer identity when none exists locally", async () => {
    const target = freshRepo();
    const sharedId = conversationId(1);
    await target.createConversation(sharedId, 1000);

    const source = freshRepo();
    const incomingKey = deterministicPublicKey(33);
    await source.createConversation(sharedId, 1000);
    await source.storePeerIdentity(sharedId, fingerprintOf(incomingKey, 33), incomingKey);
    const bundle = await exportBundle(PASSPHRASE, source);

    const result = await importBundle(PASSPHRASE, bundle, target, ImportMode.Merge);
    expect(result.conflicts).toEqual([]);
    const stored = await target.getPeerIdentity(sharedId);
    expect(bytesEqual((stored as { publicKey: Uint8Array }).publicKey, incomingKey)).toBe(true);
  });

  it("merge keeps the local display name when present, fills it when absent", async () => {
    const target = freshRepo();
    const idLocal = conversationId(1);
    const idAbsent = conversationId(2);
    await target.createConversation(idLocal, 1000);
    await target.setDisplayName(idLocal, "LocalName");
    await target.createConversation(idAbsent, 2000);

    const source = freshRepo();
    await source.createConversation(idLocal, 1000);
    await source.setDisplayName(idLocal, "IncomingName");
    await source.createConversation(idAbsent, 2000);
    await source.setDisplayName(idAbsent, "FilledIn");
    const bundle = await exportBundle(PASSPHRASE, source);

    const result: ImportResult = await importBundle(PASSPHRASE, bundle, target, ImportMode.Merge);
    expect(result.conversationsMerged).toBe(2);
    expect(await target.getDisplayName(idLocal)).toBe("LocalName");
    expect(await target.getDisplayName(idAbsent)).toBe("FilledIn");
  });
});
