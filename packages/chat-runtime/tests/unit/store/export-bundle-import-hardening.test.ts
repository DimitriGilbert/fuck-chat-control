import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { generateAtRestKey } from "@fuck-eu-chat-control/chat-runtime/crypto";
import {
  decryptAtRest,
  deriveKeyFromPassphrase,
  encryptAtRest,
} from "@fuck-eu-chat-control/chat-runtime/crypto/at-rest";
import { AtRestLockedError } from "@fuck-eu-chat-control/chat-runtime/runtime/at-rest-key-manager";
import {
  ImportMode,
  InMemoryConversationRepository,
  StoreError,
  StoreErrorCode,
  exportBundle,
  getAuthFailedDurable,
  importBundle,
  markAuthFailedDurable,
} from "@fuck-eu-chat-control/chat-runtime/store";
import { setDurableStorage } from "@fuck-eu-chat-control/chat-runtime/store/durable-storage";
import {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
} from "@fuck-eu-chat-control/chat-runtime/store/encoding";
import {
  ARGON2_ITERATIONS_MAX,
  ARGON2_MEMORY_MAX_BYTES,
  ARGON2_PARALLELISM_MAX,
  MAX_ENVELOPE_CIPHERTEXT_BYTES,
  MAX_NONCE_BYTES,
  MAX_SALT_BYTES,
} from "@fuck-eu-chat-control/chat-runtime/store/limits";
import type {
  AppendMessageOptions,
  ConversationMessage,
  ConversationRecord,
  ConversationRepository,
  PeerIdentityRecord,
} from "@fuck-eu-chat-control/chat-runtime/store";
import type { ConversationId, PublicKey } from "@fuck-eu-chat-control/chat-runtime/protocol/types";

import { MemoryStorage, conversationId, deterministicPublicKey, fingerprintOf } from "./_helpers";

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

/**
 * Envelope shape the export path produces. Reading it back via JSON.parse lets
 * tests mutate hostile variants (null kdf, out-of-range params) while keeping
 * the rest of the envelope authentic.
 */
interface EnvelopeObject {
  v: number;
  kdf: {
    algorithm: string;
    version: number;
    m: number;
    t: number;
    p: number;
    salt: string;
  };
  aead: { algorithm: string; nonce: string };
  ciphertext: string;
}

function parseEnvelopeObject(bundle: string): EnvelopeObject {
  return JSON.parse(bundle) as EnvelopeObject;
}

/** Export a one-conversation repo and return its envelope for mutation. */
async function singleConversationEnvelope(): Promise<EnvelopeObject> {
  const source = freshRepo();
  await source.createConversation(conversationId(1), 1000);
  return parseEnvelopeObject(await exportBundle(PASSPHRASE, source));
}

/**
 * Import a hostile bundle and pin that the rejection is a typed
 * {@link StoreError} with {@link StoreErrorCode.MalformedBundle} — never a raw
 * TypeError escaping the import pipeline (the R4/F4 + R4/F5 contract).
 */
async function expectMalformedBundle(hostileBundle: string): Promise<void> {
  let caught: unknown = null;
  try {
    await importBundle(PASSPHRASE, hostileBundle, freshRepo(), ImportMode.Replace);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(StoreError);
  expect((caught as StoreError).code).toBe(StoreErrorCode.MalformedBundle);
}

/**
 * Decrypt a real bundle's payload, apply a mutation, and re-encrypt it under
 * the same passphrase + KDF params. The result is a bundle that passes the
 * AEAD authenticity check but carries a malformed (post-auth) payload — the
 * R4/F5 input class.
 */
async function withMutatedPayload(
  envelope: EnvelopeObject,
  mutate: (payload: Record<string, unknown>) => void,
): Promise<string> {
  const salt = base64ToBytes(envelope.kdf.salt, MAX_SALT_BYTES);
  const nonce = base64ToBytes(envelope.aead.nonce, MAX_NONCE_BYTES);
  const ciphertext = base64ToBytes(envelope.ciphertext, MAX_ENVELOPE_CIPHERTEXT_BYTES);
  const key = await deriveKeyFromPassphrase(PASSPHRASE, salt, {
    memorySizeKiB: Math.trunc(envelope.kdf.m / 1024),
    iterations: envelope.kdf.t,
    parallelism: envelope.kdf.p,
  });
  const plain = await decryptAtRest(key, nonce, ciphertext);
  const payload = JSON.parse(new TextDecoder().decode(plain)) as Record<string, unknown>;
  mutate(payload);
  const sealed = await encryptAtRest(key, new TextEncoder().encode(JSON.stringify(payload)));
  return JSON.stringify({
    ...envelope,
    aead: { ...envelope.aead, nonce: bytesToBase64(sealed.nonce) },
    ciphertext: bytesToBase64(sealed.ciphertext),
  });
}

function conversationAt(payload: Record<string, unknown>, index = 0): Record<string, unknown> {
  return (payload["conversations"] as Record<string, unknown>[])[index];
}

function messageAt(payload: Record<string, unknown>, index = 0): Record<string, unknown> {
  return (payload["messages"] as Record<string, unknown>[])[index];
}

/**
 * Delegates every {@link ConversationRepository} call to the inner repo but
 * throws {@link AtRestLockedError} on the Nth `appendMessage` — the CR-6 seam
 * for simulating a mid-Replace-import failure that triggers the rollback path.
 * The `appendMessage` options parameter is forwarded verbatim so the wrapper
 * does not silently drop the preserved message id (R4/F1).
 */
class AppendMessageFlakeWrapper implements ConversationRepository {
  private appendCount = 0;
  private readonly throwOnNth: number;

  constructor(
    private readonly inner: ConversationRepository,
    throwOnNth: number,
  ) {
    this.throwOnNth = throwOnNth;
  }

  async createConversation(id: ConversationId, createdAt: number): Promise<ConversationRecord> {
    return await this.inner.createConversation(id, createdAt);
  }

  async getConversation(id: ConversationId): Promise<ConversationRecord | null> {
    return await this.inner.getConversation(id);
  }

  async listConversations(): Promise<ConversationRecord[]> {
    return await this.inner.listConversations();
  }

  async appendMessage(
    id: ConversationId,
    plaintext: string,
    direction: "sent" | "received",
    timestamp: number,
    options?: AppendMessageOptions,
  ): Promise<ConversationMessage> {
    this.appendCount++;
    if (this.appendCount === this.throwOnNth) {
      throw new AtRestLockedError();
    }
    return await this.inner.appendMessage(id, plaintext, direction, timestamp, options);
  }

  async getMessages(id: ConversationId): Promise<ConversationMessage[]> {
    return await this.inner.getMessages(id);
  }

  async storePeerIdentity(
    id: ConversationId,
    fingerprint: string,
    publicKey: PublicKey,
  ): Promise<void> {
    await this.inner.storePeerIdentity(id, fingerprint, publicKey);
  }

  async replacePeerIdentity(
    id: ConversationId,
    fingerprint: string,
    publicKey: PublicKey,
  ): Promise<void> {
    await this.inner.replacePeerIdentity(id, fingerprint, publicKey);
  }

  async getPeerIdentity(id: ConversationId): Promise<PeerIdentityRecord | null> {
    return await this.inner.getPeerIdentity(id);
  }

  async setDisplayName(id: ConversationId, name: string): Promise<void> {
    await this.inner.setDisplayName(id, name);
  }

  async getDisplayName(id: ConversationId): Promise<string | null> {
    return await this.inner.getDisplayName(id);
  }

  async markAuthFailed(id: ConversationId): Promise<void> {
    await this.inner.markAuthFailed(id);
  }

  async getAuthFailed(id: ConversationId): Promise<boolean> {
    return await this.inner.getAuthFailed(id);
  }

  async clearConversation(id: ConversationId): Promise<void> {
    await this.inner.clearConversation(id);
  }

  async clearAll(): Promise<void> {
    await this.inner.clearAll();
  }
}

describe("import bundle — R4/F1 merge dedup via preserved message ids", () => {
  it("overlapping re-import from a second device appends zero duplicates", async () => {
    // Device A owns the conversation history and exports two overlapping
    // bundles; device B imports both in Merge mode.
    const deviceA = freshRepo();
    const deviceB = freshRepo();
    const sharedId = conversationId(1);
    await deviceA.createConversation(sharedId, 1000);
    await deviceA.appendMessage(sharedId, "m1", "sent", 1100);
    await deviceA.appendMessage(sharedId, "m2", "received", 1200);

    const firstImport = await importBundle(
      PASSPHRASE,
      await exportBundle(PASSPHRASE, deviceA),
      deviceB,
      ImportMode.Merge,
    );
    expect(firstImport.conversationsAdded).toBe(1);
    expect(firstImport.messagesImported).toBe(2);

    // The bundle's message ids are stored VERBATIM — without this, B's rows
    // get fresh UUIDs and no later bundle from A can ever dedup against them.
    const onA = await deviceA.getMessages(sharedId);
    const onB = await deviceB.getMessages(sharedId);
    expect(onB.map((m) => m.id)).toEqual(onA.map((m) => m.id));

    // Overlapping bundle: A keeps the conversation and appends one message.
    await deviceA.appendMessage(sharedId, "m3", "sent", 1300);
    const secondImport = await importBundle(
      PASSPHRASE,
      await exportBundle(PASSPHRASE, deviceA),
      deviceB,
      ImportMode.Merge,
    );
    expect(secondImport.conversationsMerged).toBe(1);
    expect(secondImport.messagesImported).toBe(1); // only the new m3

    const merged = await deviceB.getMessages(sharedId);
    expect(merged.map((m) => m.text)).toEqual(["m1", "m2", "m3"]); // no duplicates
  });

  it("re-importing the identical bundle is a no-op", async () => {
    const deviceA = freshRepo();
    const deviceB = freshRepo();
    const sharedId = conversationId(1);
    await deviceA.createConversation(sharedId, 1000);
    await deviceA.appendMessage(sharedId, "m1", "sent", 1100);
    await deviceA.appendMessage(sharedId, "m2", "received", 1200);
    const bundle = await exportBundle(PASSPHRASE, deviceA);

    await importBundle(PASSPHRASE, bundle, deviceB, ImportMode.Merge);
    const reimport = await importBundle(PASSPHRASE, bundle, deviceB, ImportMode.Merge);
    expect(reimport.conversationsAdded).toBe(0);
    expect(reimport.conversationsMerged).toBe(1);
    expect(reimport.messagesImported).toBe(0);

    const merged = await deviceB.getMessages(sharedId);
    expect(merged.map((m) => m.text)).toEqual(["m1", "m2"]);
  });

  it("Replace import stores the bundle's message ids verbatim", async () => {
    const source = freshRepo();
    await seedConversation(source, 4, 4000, {
      messages: [
        { text: "s1", dir: "sent", ts: 4100 },
        { text: "s2", dir: "received", ts: 4200 },
      ],
    });
    // A pre-existing conversation that Replace must wipe.
    const target = freshRepo();
    await seedConversation(target, 9, 9000, {
      messages: [{ text: "old", dir: "sent", ts: 9100 }],
    });

    const result = await importBundle(
      PASSPHRASE,
      await exportBundle(PASSPHRASE, source),
      target,
      ImportMode.Replace,
    );
    expect(result.conversationsAdded).toBe(1);
    expect(result.messagesImported).toBe(2);
    expect(await target.getConversation(conversationId(9))).toBeNull();

    // R4/F1: the imported rows carry the bundle's ids verbatim — fresh UUIDs
    // here would break a later overlapping Merge of the same source bundle.
    const sourceIds = (await source.getMessages(conversationId(4))).map((m) => m.id);
    const targetIds = (await target.getMessages(conversationId(4))).map((m) => m.id);
    expect(targetIds).toEqual(sourceIds);
  });
});

describe("import bundle — R4/F2 rollback restores authFailed flags", () => {
  let storage: MemoryStorage;

  beforeAll(() => {
    storage = new MemoryStorage();
    setDurableStorage(storage);
  });

  beforeEach(() => {
    storage.clear();
  });

  afterAll(() => {
    setDurableStorage(new MemoryStorage());
  });

  it("a failed Replace import re-applies the repo flag AND the durable record", async () => {
    // Pre-import state: one hostile-peer conversation with BOTH auth-failed
    // sources set, plus one clean conversation.
    const hostile = conversationId(1);
    const clean = conversationId(2);
    const base = freshRepo();
    await base.createConversation(hostile, 1000);
    const hostileKey = deterministicPublicKey(11);
    await base.storePeerIdentity(hostile, fingerprintOf(hostileKey, 11), hostileKey);
    await base.appendMessage(hostile, "hostile history", "sent", 1100);
    await base.markAuthFailed(hostile);
    await markAuthFailedDurable(hostile);
    await base.createConversation(clean, 2000);
    await base.appendMessage(clean, "clean history", "sent", 2100);

    expect(await base.getAuthFailed(hostile)).toBe(true);
    expect(await getAuthFailedDurable(hostile)).toBe(true);

    // R4/F1: capture the pre-import message ids so the rollback assertions
    // below can pin that the restore re-populates with the ORIGINAL ids, not
    // fresh UUIDs.
    const hostileIdsBefore = (await base.getMessages(hostile)).map((m) => m.id);
    const cleanIdsBefore = (await base.getMessages(clean)).map((m) => m.id);

    // A Replace bundle whose import fails mid-loop (second appendMessage
    // throws AFTER clearAll + clearAllAuthFailedDurable already ran).
    const source = freshRepo();
    await seedConversation(source, 7, 7000, {
      messages: [
        { text: "in-1", dir: "sent", ts: 7100 },
        { text: "in-2", dir: "received", ts: 7200 },
      ],
    });
    const bundle = await exportBundle(PASSPHRASE, source);
    const wrapped = new AppendMessageFlakeWrapper(base, 2);
    await expect(
      importBundle(PASSPHRASE, bundle, wrapped, ImportMode.Replace),
    ).rejects.toBeInstanceOf(AtRestLockedError);

    // The repo record is restored WITH its auth-failed flag: the TOFU retry
    // gate (repo.getAuthFailed) stays blocked for the hostile peer.
    const restored = await base.getConversation(hostile);
    expect(restored).not.toBeNull();
    expect((restored as ConversationRecord).authFailed).toBe(true);
    expect((restored as ConversationRecord).authFailedAt).not.toBeNull();
    expect(await base.getAuthFailed(hostile)).toBe(true);

    // The durable record that clearAllAuthFailedDurable() wiped on the import
    // path is re-populated — a reload must not lose the block either.
    expect(await getAuthFailedDurable(hostile)).toBe(true);

    // The restored hostile history carries its ORIGINAL message ids — the
    // rollback restore path must pass the snapshot's ids through verbatim.
    const hostileMessages = await base.getMessages(hostile);
    expect(hostileMessages.map((m) => m.id)).toEqual(hostileIdsBefore);
    expect(hostileMessages.map((m) => m.text)).toEqual(["hostile history"]);

    // The clean conversation comes back unflagged in both sources.
    expect(await base.getAuthFailed(clean)).toBe(false);
    expect(await getAuthFailedDurable(clean)).toBe(false);
    const cleanMessages = await base.getMessages(clean);
    expect(cleanMessages.map((m) => m.id)).toEqual(cleanIdsBefore);
    expect(cleanMessages.map((m) => m.text)).toEqual(["clean history"]);
  });
});

describe("import bundle — R4/F4 envelope kdf/aead object guards", () => {
  it("rejects kdf: null with MalformedBundle instead of a raw TypeError", async () => {
    const envelope = await singleConversationEnvelope();
    await expectMalformedBundle(JSON.stringify({ ...envelope, kdf: null }));
  });

  it("rejects aead: null with MalformedBundle instead of a raw TypeError", async () => {
    const envelope = await singleConversationEnvelope();
    await expectMalformedBundle(JSON.stringify({ ...envelope, aead: null }));
  });

  it("rejects a non-object kdf (string) with MalformedBundle", async () => {
    const envelope = await singleConversationEnvelope();
    await expectMalformedBundle(JSON.stringify({ ...envelope, kdf: "argon2id" }));
  });

  it("still rejects a missing kdf/aead field with MalformedBundle", async () => {
    const envelope = await singleConversationEnvelope();
    const withoutKdf = {
      v: envelope.v,
      aead: envelope.aead,
      ciphertext: envelope.ciphertext,
    };
    await expectMalformedBundle(JSON.stringify(withoutKdf));
    const withoutAead = {
      v: envelope.v,
      kdf: envelope.kdf,
      ciphertext: envelope.ciphertext,
    };
    await expectMalformedBundle(JSON.stringify(withoutAead));
  });
});

describe("import bundle — R4/F5 post-auth payload field validation", () => {
  let envelope: EnvelopeObject;

  beforeAll(async () => {
    // One conversation with a peer + display name + one message: gives every
    // field below a legitimate value to mutate away from.
    const source = freshRepo();
    await seedConversation(source, 1, 1000, {
      displayName: "Alice",
      peerSeed: 5,
      messages: [{ text: "hi", dir: "sent", ts: 1100 }],
    });
    envelope = parseEnvelopeObject(await exportBundle(PASSPHRASE, source));
  });

  it("rejects a null conversation element with MalformedBundle (not a TypeError)", async () => {
    await expectMalformedBundle(
      await withMutatedPayload(envelope, (payload) => {
        (payload["conversations"] as unknown[])[0] = null;
      }),
    );
  });

  it("rejects a null message element with MalformedBundle (not a TypeError)", async () => {
    await expectMalformedBundle(
      await withMutatedPayload(envelope, (payload) => {
        (payload["messages"] as unknown[])[0] = null;
      }),
    );
  });

  it("rejects a non-string message id with MalformedBundle", async () => {
    await expectMalformedBundle(
      await withMutatedPayload(envelope, (payload) => {
        messageAt(payload).id = 42;
      }),
    );
  });

  it("rejects a non-numeric message timestamp with MalformedBundle", async () => {
    await expectMalformedBundle(
      await withMutatedPayload(envelope, (payload) => {
        messageAt(payload).timestamp = "1100";
      }),
    );
  });

  it("rejects a non-string message text with MalformedBundle", async () => {
    await expectMalformedBundle(
      await withMutatedPayload(envelope, (payload) => {
        messageAt(payload).text = { greedy: "object" };
      }),
    );
  });

  it("rejects a non-finite-number conversation createdAt with MalformedBundle", async () => {
    await expectMalformedBundle(
      await withMutatedPayload(envelope, (payload) => {
        conversationAt(payload).createdAt = "1000";
      }),
    );
  });

  it("rejects a non-string conversation displayName with MalformedBundle", async () => {
    await expectMalformedBundle(
      await withMutatedPayload(envelope, (payload) => {
        conversationAt(payload).displayName = 42;
      }),
    );
  });

  it("rejects a non-string peer publicKey with MalformedBundle (not a TypeError)", async () => {
    await expectMalformedBundle(
      await withMutatedPayload(envelope, (payload) => {
        (conversationAt(payload)["peer"] as Record<string, unknown>)["publicKey"] = 12345;
      }),
    );
  });

  it("rejects a missing peer field with MalformedBundle (not a TypeError)", async () => {
    await expectMalformedBundle(
      await withMutatedPayload(envelope, (payload) => {
        delete conversationAt(payload)["peer"];
      }),
    );
  });

  it("rejects an invalid-base64 peer publicKey with MalformedBundle (not a raw Error)", async () => {
    await expectMalformedBundle(
      await withMutatedPayload(envelope, (payload) => {
        (conversationAt(payload)["peer"] as Record<string, unknown>)["publicKey"] = "not!base64";
      }),
    );
  });

  it("rejects an invalid-base64 identity with MalformedBundle (not a raw Error)", async () => {
    await expectMalformedBundle(
      await withMutatedPayload(envelope, (payload) => {
        payload["identity"] = "not!base64";
      }),
    );
  });
});

describe("import bundle — message id uniqueness within the payload and against stored rows", () => {
  let envelope: EnvelopeObject;

  beforeAll(async () => {
    // One conversation carrying one message: gives the duplicate-id tests a
    // legitimate message entry to duplicate.
    const source = freshRepo();
    await seedConversation(source, 1, 1000, {
      messages: [{ text: "hi", dir: "sent", ts: 1100 }],
    });
    envelope = parseEnvelopeObject(await exportBundle(PASSPHRASE, source));
  });

  it("rejects two payload messages sharing an id with MalformedBundle (not a raw DuplicateKeyError)", async () => {
    // Durable repos key message rows by id GLOBALLY, so a duplicate id in the
    // payload would otherwise reach a second insert with the same key.
    await expectMalformedBundle(
      await withMutatedPayload(envelope, (payload) => {
        (payload["messages"] as unknown[]).push({ ...messageAt(payload) });
      }),
    );
  });

  it("rejects the same message id under two different payload conversations with MalformedBundle", async () => {
    // Pins that uniqueness is enforced payload-WIDE, not per conversation —
    // the browser repo's messages collection keys rows by id alone, so an id
    // reused across conversations collides exactly like a same-conversation
    // duplicate.
    await expectMalformedBundle(
      await withMutatedPayload(envelope, (payload) => {
        const secondHex = bytesToHex(conversationId(9));
        (payload["conversations"] as unknown[]).push({
          id: secondHex,
          createdAt: 2000,
          displayName: null,
          peer: null,
        });
        (payload["messages"] as unknown[]).push({
          ...messageAt(payload),
          conversationId: secondHex,
        });
      }),
    );
  });

  it("merge skips a bundle message whose id is stored under a different conversation — added branch, dedup not a raw error", async () => {
    // Chosen semantics: a bundle id equal to a stored id is an
    // already-imported duplicate and is SKIPPED (never re-appended), exactly
    // like `existingIds` dedup within one conversation. Appending instead
    // would insert against the globally-keyed stored row and throw a raw
    // DuplicateKeyError from the browser repo's messages collection.
    const target = freshRepo();
    const owner = conversationId(1);
    await target.createConversation(owner, 1000);
    await target.appendMessage(owner, "stored", "sent", 1100, { id: "shared-message-id" });

    const source = freshRepo();
    const incoming = conversationId(2);
    await source.createConversation(incoming, 2000);
    await source.appendMessage(incoming, "incoming", "received", 2100, {
      id: "shared-message-id",
    });

    const result = await importBundle(
      PASSPHRASE,
      await exportBundle(PASSPHRASE, source),
      target,
      ImportMode.Merge,
    );

    expect(result.conversationsAdded).toBe(1);
    expect(result.messagesImported).toBe(0);
    // The stored row is untouched and the new conversation stays empty.
    expect((await target.getMessages(owner)).map((m) => m.id)).toEqual(["shared-message-id"]);
    expect(await target.getMessages(incoming)).toEqual([]);
  });

  it("merge skips a bundle message whose id is stored under a different conversation — merged branch, dedup not a raw error", async () => {
    const target = freshRepo();
    const owner = conversationId(1);
    await target.createConversation(owner, 1000);
    await target.appendMessage(owner, "stored", "sent", 1100, { id: "shared-message-id" });
    const shared = conversationId(2);
    await target.createConversation(shared, 2000);
    await target.appendMessage(shared, "local-only", "sent", 2100);

    const source = freshRepo();
    await source.createConversation(shared, 2000);
    await source.appendMessage(shared, "colliding", "received", 2200, {
      id: "shared-message-id",
    });
    await source.appendMessage(shared, "fresh", "received", 2300, { id: "fresh-message-id" });

    const result = await importBundle(
      PASSPHRASE,
      await exportBundle(PASSPHRASE, source),
      target,
      ImportMode.Merge,
    );

    // Only the non-colliding id is appended; the collision is skipped as a
    // duplicate instead of throwing.
    expect(result.conversationsMerged).toBe(1);
    expect(result.messagesImported).toBe(1);
    const merged = await target.getMessages(shared);
    expect(merged.map((m) => m.text)).toEqual(["local-only", "fresh"]);
    expect(merged.map((m) => m.id)).not.toContain("shared-message-id");
    expect((await target.getMessages(owner)).map((m) => m.id)).toEqual(["shared-message-id"]);
  });
});

describe("import bundle — R4/F3 tightened KDF bounds (exporter's exact parameters)", () => {
  it("rejects m above the exporter's 64 MiB with InvalidKdfParams", async () => {
    const envelope = await singleConversationEnvelope();
    envelope.kdf.m = ARGON2_MEMORY_MAX_BYTES + 1;
    await expect(
      importBundle(PASSPHRASE, JSON.stringify(envelope), freshRepo(), ImportMode.Replace),
    ).rejects.toMatchObject({ code: StoreErrorCode.InvalidKdfParams });
  });

  it("rejects t above the exporter's 3 with InvalidKdfParams", async () => {
    const envelope = await singleConversationEnvelope();
    envelope.kdf.t = ARGON2_ITERATIONS_MAX + 1;
    await expect(
      importBundle(PASSPHRASE, JSON.stringify(envelope), freshRepo(), ImportMode.Replace),
    ).rejects.toMatchObject({ code: StoreErrorCode.InvalidKdfParams });
  });

  it("rejects p above the exporter's 1 with InvalidKdfParams", async () => {
    const envelope = await singleConversationEnvelope();
    envelope.kdf.p = ARGON2_PARALLELISM_MAX + 1;
    await expect(
      importBundle(PASSPHRASE, JSON.stringify(envelope), freshRepo(), ImportMode.Replace),
    ).rejects.toMatchObject({ code: StoreErrorCode.InvalidKdfParams });
  });

  it("accepts the exporter's exact parameters (m = 64 MiB, t = 3, p = 1)", async () => {
    // The bounds are INCLUSIVE at the exporter's values — this pins that the
    // maxima can never tighten below what the export path itself writes.
    const envelope = await singleConversationEnvelope();
    expect(envelope.kdf.m).toBe(ARGON2_MEMORY_MAX_BYTES);
    expect(envelope.kdf.t).toBe(ARGON2_ITERATIONS_MAX);
    expect(envelope.kdf.p).toBe(ARGON2_PARALLELISM_MAX);

    const result = await importBundle(
      PASSPHRASE,
      JSON.stringify(envelope),
      freshRepo(),
      ImportMode.Replace,
    );
    expect(result.conversationsAdded).toBe(1);
  });
});
