import { describe, expect, it } from "vitest";

import { encryptAtRest, generateAtRestKey } from "@fuck-eu-chat-control/chat-runtime/crypto";
import { bytesToBase64 } from "@fuck-eu-chat-control/chat-runtime/store/encoding";
import {
  InMemoryConversationRepository,
  messageRecordAad,
  MessageDirection,
  StoreErrorCode,
} from "@fuck-eu-chat-control/chat-runtime/store";
import type { SerializedState } from "@fuck-eu-chat-control/chat-runtime/store";

import { bytesEqual, conversationId } from "./_helpers";

/** Hex key of a ConversationId, matching the repo's serialized-state convention. */
function hexOf(id: Uint8Array): string {
  return Array.from(id, (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("messageRecordAad (canonical R1:F2 record AAD encoding)", () => {
  it("encodes [0x01][conversationId][direction UTF-8] deterministically", () => {
    const id = conversationId(3);
    const aadSent = messageRecordAad(id, MessageDirection.Sent);
    // Prefix byte + fixed-width 16-byte conversation id + "sent" (4 bytes).
    expect(aadSent.length).toBe(1 + 16 + 4);
    expect(aadSent[0]).toBe(0x01);
    expect(bytesEqual(aadSent.subarray(1, 17), id)).toBe(true);
    expect(new TextDecoder().decode(aadSent.subarray(17))).toBe("sent");

    const aadReceived = messageRecordAad(id, MessageDirection.Received);
    expect(aadReceived.length).toBe(1 + 16 + 8);
    expect(new TextDecoder().decode(aadReceived.subarray(17))).toBe("received");
    expect(bytesEqual(aadSent, aadReceived)).toBe(false);
  });

  it("binds the conversation id: distinct conversations derive distinct AADs", () => {
    const a = messageRecordAad(conversationId(1), MessageDirection.Sent);
    const b = messageRecordAad(conversationId(2), MessageDirection.Sent);
    expect(bytesEqual(a, b)).toBe(false);
  });

  it("is stable across calls (identical inputs produce identical bytes)", () => {
    const id = conversationId(4);
    const a = messageRecordAad(id, MessageDirection.Received);
    const b = messageRecordAad(id, MessageDirection.Received);
    expect(bytesEqual(a, b)).toBe(true);
  });
});

describe("InMemoryConversationRepository — at-rest record binding (R1:F2)", () => {
  it("still decrypts a legacy row sealed before the AAD binding (migration)", async () => {
    const key = generateAtRestKey();
    const repo = new InMemoryConversationRepository(key);
    const id = conversationId(10);
    // Seal exactly as pre-R1:F2 code did: no AAD.
    const sealed = await encryptAtRest(key, new TextEncoder().encode("legacy secret"));
    const state: SerializedState = {
      conversations: [{ id: hexOf(id), createdAt: 1, displayName: null, peer: null }],
      messages: [
        {
          conversationId: hexOf(id),
          messages: [
            {
              id: "legacy-row",
              direction: MessageDirection.Sent,
              timestamp: 1,
              nonce: bytesToBase64(sealed.nonce),
              ciphertext: bytesToBase64(sealed.ciphertext),
            },
          ],
        },
      ],
    };
    await repo.reload(key, state);
    const messages = await repo.getMessages(id);
    expect(messages.map((m) => m.text)).toEqual(["legacy secret"]);
  });

  it("a current-format row relocated to another conversation fails authentication", async () => {
    const key = generateAtRestKey();
    const repo = new InMemoryConversationRepository(key);
    const source = conversationId(11);
    const target = conversationId(12);
    await repo.createConversation(source, 1);
    await repo.createConversation(target, 2);
    await repo.appendMessage(source, "cut and paste me", MessageDirection.Sent, 10);

    // Store-write attacker: relocate the sealed (nonce, ciphertext) pair from
    // the source conversation's group to the target's in the serialized state.
    const state = repo.serialize();
    const moved: SerializedState = {
      ...state,
      messages: state.messages.map((group) => ({ ...group, conversationId: hexOf(target) })),
    };

    const reloaded = new InMemoryConversationRepository(key);
    await reloaded.reload(key, moved);
    // The GCM tag was computed over the source conversation + direction, so
    // both the AAD attempt and the legacy empty-AAD fallback fail.
    await expect(reloaded.getMessages(target)).rejects.toMatchObject({
      code: StoreErrorCode.WrongPassphrase,
    });
  });

  it("a current-format row with a flipped direction fails authentication", async () => {
    const key = generateAtRestKey();
    const repo = new InMemoryConversationRepository(key);
    const id = conversationId(13);
    await repo.createConversation(id, 1);
    await repo.appendMessage(id, "outbox message", MessageDirection.Sent, 10);

    // Provenance relabel: the sealed pair now claims to be received mail.
    const state = repo.serialize();
    const flipped: SerializedState = {
      ...state,
      messages: state.messages.map((group) => ({
        ...group,
        messages: group.messages.map((m) => ({ ...m, direction: MessageDirection.Received })),
      })),
    };

    const reloaded = new InMemoryConversationRepository(key);
    await reloaded.reload(key, flipped);
    await expect(reloaded.getMessages(id)).rejects.toMatchObject({
      code: StoreErrorCode.WrongPassphrase,
    });
  });

  it("legacy rows remain readable after relocation (documented backward-compat residual)", async () => {
    const key = generateAtRestKey();
    const repo = new InMemoryConversationRepository(key);
    const source = conversationId(14);
    const target = conversationId(15);
    // A pre-binding row that an attacker moved to a DIFFERENT conversation
    // still authenticates under the legacy empty-AAD fallback. That is the
    // accepted residual window of the mandatory backward compatibility —
    // pinned here so any future tightening of the fallback is a conscious
    // decision rather than an accident.
    const sealed = await encryptAtRest(key, new TextEncoder().encode("legacy secret"));
    const state: SerializedState = {
      conversations: [
        { id: hexOf(source), createdAt: 1, displayName: null, peer: null },
        { id: hexOf(target), createdAt: 2, displayName: null, peer: null },
      ],
      messages: [
        {
          conversationId: hexOf(target),
          messages: [
            {
              id: "legacy-row",
              direction: MessageDirection.Sent,
              timestamp: 1,
              nonce: bytesToBase64(sealed.nonce),
              ciphertext: bytesToBase64(sealed.ciphertext),
            },
          ],
        },
      ],
    };
    await repo.reload(key, state);
    const messages = await repo.getMessages(target);
    expect(messages.map((m) => m.text)).toEqual(["legacy secret"]);
  });
});
