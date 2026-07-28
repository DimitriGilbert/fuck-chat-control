import { describe, expect, it } from "vitest";

import { generateAtRestKey } from "@fuck-eu-chat-control/chat-runtime/crypto";
import { AtRestLockedError } from "@fuck-eu-chat-control/chat-runtime/runtime/at-rest-key-manager";
import {
  ImportMode,
  InMemoryConversationRepository,
  StoreErrorCode,
  exportBundle,
  importBundle,
} from "@fuck-eu-chat-control/chat-runtime/store";
import type {
  ConversationMessage,
  ConversationRecord,
  ConversationRepository,
  PeerIdentityRecord,
} from "@fuck-eu-chat-control/chat-runtime/store";
import type { ConversationId, PublicKey } from "@fuck-eu-chat-control/chat-runtime/protocol/types";

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

/**
 * CR-6 test wrapper: delegates every {@link ConversationRepository} call to the
 * inner repo, but throws {@link AtRestLockedError} on the Nth `appendMessage`
 * call. Simulates a mid-import lock by the real {@link LockableRepository}
 * wrapper without requiring a full AtRestKeyManager rig.
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
  ): Promise<ConversationMessage> {
    this.appendCount++;
    if (this.appendCount === this.throwOnNth) {
      throw new AtRestLockedError();
    }
    return await this.inner.appendMessage(id, plaintext, direction, timestamp);
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

describe("export/import bundle — CR-6 atomic Replace-mode import", () => {
  it("rolls back pre-existing conversations when a mid-import throw occurs", async () => {
    // Target has TWO pre-existing conversations with messages + a peer + a name.
    const base = freshRepo();
    await seedConversation(base, 1, 1000, {
      displayName: "Alice",
      peerSeed: 5,
      messages: [
        { text: "pre-1", dir: "sent", ts: 1100 },
        { text: "pre-2", dir: "received", ts: 1200 },
      ],
    });
    await seedConversation(base, 2, 2000, {
      messages: [{ text: "pre-convo-2", dir: "sent", ts: 2100 }],
    });

    // Build a Replace bundle carrying TWO incoming conversations, the first of
    // which has THREE messages. With the wrapper throwing on the THIRD
    // appendMessage, the throw lands mid-import (after clearAll).
    const source = freshRepo();
    await seedConversation(source, 7, 7000, {
      messages: [
        { text: "in-1", dir: "sent", ts: 7100 },
        { text: "in-2", dir: "received", ts: 7200 },
        { text: "in-3", dir: "sent", ts: 7300 },
      ],
    });
    await seedConversation(source, 8, 8000, {
      messages: [{ text: "in-convo-2", dir: "sent", ts: 8100 }],
    });
    const bundle = await exportBundle(PASSPHRASE, source);

    // Wrap so the THIRD appendMessage throws AtRestLockedError.
    const wrapped = new AppendMessageFlakeWrapper(base, 3);

    await expect(
      importBundle(PASSPHRASE, bundle, wrapped, ImportMode.Replace),
    ).rejects.toBeInstanceOf(AtRestLockedError);

    // CR-6 assertion: the pre-existing conversations SURVIVE the failed import.
    const survivors = await base.listConversations();
    expect(survivors.length).toBe(2);

    // Conversation 1: messages, peer, display name all intact.
    const c1 = await base.getConversation(conversationId(1));
    expect(c1).not.toBeNull();
    expect((c1 as ConversationRecord).displayName).toBe("Alice");
    const msgs1 = await base.getMessages(conversationId(1));
    expect(msgs1.map((m) => m.text)).toEqual(["pre-1", "pre-2"]);
    expect(msgs1[0].direction).toBe("sent");
    expect(msgs1[1].direction).toBe("received");
    const peer1 = await base.getPeerIdentity(conversationId(1));
    expect(peer1).not.toBeNull();
    expect(
      bytesEqual((peer1 as PeerIdentityRecord).publicKey, deterministicPublicKey(5)),
    ).toBe(true);

    // Conversation 2: message intact.
    const msgs2 = await base.getMessages(conversationId(2));
    expect(msgs2.map((m) => m.text)).toEqual(["pre-convo-2"]);

    // No incoming conversation ids leaked into the repo.
    expect(await base.getConversation(conversationId(7))).toBeNull();
    expect(await base.getConversation(conversationId(8))).toBeNull();
  });

  it("positive control: a clean Replace import (no injection) replaces correctly", async () => {
    const base = freshRepo();
    await seedConversation(base, 1, 1000, {
      messages: [{ text: "old", dir: "sent", ts: 1100 }],
    });

    const source = freshRepo();
    await seedConversation(source, 2, 2000, {
      displayName: "Bob",
      peerSeed: 9,
      messages: [
        { text: "fresh-1", dir: "received", ts: 2100 },
        { text: "fresh-2", dir: "sent", ts: 2200 },
      ],
    });
    const bundle = await exportBundle(PASSPHRASE, source);

    const result = await importBundle(PASSPHRASE, bundle, base, ImportMode.Replace);
    expect(result.conversationsAdded).toBe(1);
    expect(result.messagesImported).toBe(2);
    expect(result.conflicts).toEqual([]);

    const list = await base.listConversations();
    expect(list.length).toBe(1);
    expect(bytesEqual(list[0].id, conversationId(2))).toBe(true);
    expect(await base.getConversation(conversationId(1))).toBeNull();

    const msgs = await base.getMessages(conversationId(2));
    expect(msgs.map((m) => m.text)).toEqual(["fresh-1", "fresh-2"]);
    expect(await base.getDisplayName(conversationId(2))).toBe("Bob");
    const peer = await base.getPeerIdentity(conversationId(2));
    expect(peer).not.toBeNull();
    expect(
      bytesEqual((peer as PeerIdentityRecord).publicKey, deterministicPublicKey(9)),
    ).toBe(true);
  });

  it("rejects a malformed bundle without mutating state (regression guard for CR-6)", async () => {
    const base = freshRepo();
    await seedConversation(base, 1, 1000, {
      messages: [{ text: "keep", dir: "sent", ts: 1100 }],
    });

    await expect(
      importBundle(PASSPHRASE, "{not json", base, ImportMode.Replace),
    ).rejects.toMatchObject({ code: StoreErrorCode.MalformedBundle });

    // Untouched: rollback snapshot path is never reached because validation
    // throws BEFORE clearAll.
    const msgs = await base.getMessages(conversationId(1));
    expect(msgs.map((m) => m.text)).toEqual(["keep"]);
  });
});
