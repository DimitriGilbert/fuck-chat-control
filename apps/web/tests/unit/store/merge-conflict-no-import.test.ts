import { describe, expect, it } from "vitest";

import { generateAtRestKey } from "@fuck-eu-chat-control/chat-runtime/crypto";
import {
  ImportMode,
  InMemoryConversationRepository,
  exportBundle,
  importBundle,
} from "@fuck-eu-chat-control/chat-runtime/store";

import { bytesEqual, conversationId, deterministicPublicKey, fingerprintOf } from "./_helpers";

const PASSPHRASE = "correct horse battery staple";

function freshRepo(): InMemoryConversationRepository {
  return new InMemoryConversationRepository(generateAtRestKey());
}

describe("import bundle — merge peer-identity conflict does not persist (R8/F2)", () => {
  it("a hostile bundle targeting a pinned conversation surfaces a conflict and imports ZERO of its messages", async () => {
    // Target has a pinned peer on conversation 1 with a seeded display name
    // and one pre-existing local message.
    const target = freshRepo();
    const sharedId = conversationId(1);
    const existingKey = deterministicPublicKey(11);
    await target.createConversation(sharedId, 1000);
    await target.storePeerIdentity(sharedId, fingerprintOf(existingKey, 11), existingKey);
    await target.setDisplayName(sharedId, "Legit");
    await target.appendMessage(sharedId, "local-trusted", "sent", 1100);

    // Source carries a DIFFERENT peer key for the same conversation id plus
    // hostile messages and a hostile display name. Under the old code these
    // would be imported despite the conflict being flagged.
    const hostile = freshRepo();
    const hostileKey = deterministicPublicKey(99);
    await hostile.createConversation(sharedId, 1000);
    await hostile.storePeerIdentity(sharedId, fingerprintOf(hostileKey, 99), hostileKey);
    await hostile.setDisplayName(sharedId, "HostileName");
    await hostile.appendMessage(sharedId, "hostile-msg-1", "received", 2000);
    await hostile.appendMessage(sharedId, "hostile-msg-2", "received", 2100);

    // Unrelated honest conversation in the same bundle: this one MUST still
    // import normally — the continue only skips the conflicting conversation.
    await hostile.createConversation(conversationId(2), 3000);
    await hostile.appendMessage(conversationId(2), "honest-msg", "sent", 3100);

    const bundle = await exportBundle(PASSPHRASE, hostile);

    const result = await importBundle(PASSPHRASE, bundle, target, ImportMode.Merge);

    // Exactly one conflict surfaced, for the shared conversation.
    expect(result.conflicts).toHaveLength(1);
    const conflict = result.conflicts[0];
    expect(bytesEqual(conflict.existing.publicKey, existingKey)).toBe(true);
    expect(bytesEqual(conflict.incoming.publicKey, hostileKey)).toBe(true);

    // The pinned peer is UNCHANGED (existing key, never overwritten).
    const stillPinned = await target.getPeerIdentity(sharedId);
    expect(stillPinned).not.toBeNull();
    expect(
      bytesEqual((stillPinned as { publicKey: Uint8Array }).publicKey, existingKey),
    ).toBe(true);

    // The hostile display name did NOT overwrite the legit one.
    expect(await target.getDisplayName(sharedId)).toBe("Legit");

    // The shared conversation's messages are ONLY the pre-existing local one.
    // The two hostile messages must NOT have been appended.
    const sharedMessages = await target.getMessages(sharedId);
    expect(sharedMessages.map((m) => m.text)).toEqual(["local-trusted"]);

    // The honest conversation and its message imported normally.
    const honestMessages = await target.getMessages(conversationId(2));
    expect(honestMessages.map((m) => m.text)).toEqual(["honest-msg"]);
  });

  it("a bundle with NO conflict still imports display name and messages for the shared conversation", async () => {
    // Regression guard: the `continue` must not fire when the pinned key
    // equals the incoming key (same-peer re-export scenario).
    const target = freshRepo();
    const sharedId = conversationId(1);
    const sameKey = deterministicPublicKey(7);
    await target.createConversation(sharedId, 1000);
    await target.storePeerIdentity(sharedId, fingerprintOf(sameKey, 7), sameKey);

    const source = freshRepo();
    await source.createConversation(sharedId, 1000);
    await source.storePeerIdentity(sharedId, fingerprintOf(sameKey, 7), sameKey);
    await source.setDisplayName(sharedId, "FilledName");
    await source.appendMessage(sharedId, "incoming-msg", "received", 1200);
    const bundle = await exportBundle(PASSPHRASE, source);

    const result = await importBundle(PASSPHRASE, bundle, target, ImportMode.Merge);

    // No conflict — same key — so display name fills in and messages import.
    expect(result.conflicts).toHaveLength(0);
    expect(await target.getDisplayName(sharedId)).toBe("FilledName");
    const messages = await target.getMessages(sharedId);
    expect(messages.map((m) => m.text)).toEqual(["incoming-msg"]);
  });
});
