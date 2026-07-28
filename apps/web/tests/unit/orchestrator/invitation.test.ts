import { describe, expect, it } from "vitest";

import { randomBytes } from "@fuck-eu-chat-control/chat-runtime/crypto/primitives";
import { encodeConversationId } from "@fuck-eu-chat-control/chat-runtime/protocol/codec";
import { CONVERSATION_ID_BYTES } from "@fuck-eu-chat-control/chat-runtime/protocol/limits";
import type { ConversationId } from "@fuck-eu-chat-control/chat-runtime/protocol/types";

import {
  conversationIdToHex,
  formatInvitation,
  generateConversationId,
  hexToConversationId,
  parseInvitation,
} from "@fuck-eu-chat-control/chat-runtime/orchestrator/invitation";
import { OrchestratorError, OrchestratorErrorCode } from "@fuck-eu-chat-control/chat-runtime/orchestrator/errors";

const HEX_PATTERN = /^[0-9a-f]{32}$/;
const SAMPLE_BASE_URL = "https://app.example";

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

describe("generateConversationId", () => {
  it("returns a 16-byte ConversationId", () => {
    const id = generateConversationId();
    expect(id).toBeInstanceOf(Uint8Array);
    expect(id.length).toBe(CONVERSATION_ID_BYTES);
  });

  it("round-trips through conversationIdToHex -> hexToConversationId to the same bytes", () => {
    const id = generateConversationId();
    const hex = conversationIdToHex(id);
    const recovered = hexToConversationId(hex);
    expect(bytesEqual(recovered, id)).toBe(true);
  });

  it("is non-deterministic across calls", () => {
    const SAMPLES = 16;
    const ids: ConversationId[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      ids.push(generateConversationId());
    }
    const firstBytes = Array.from(ids[0]);
    const allEqual = ids.every((id) => bytesEqual(id, ids[0]));
    expect(allEqual).toBe(false);
    void firstBytes;
  });

  it("does not use Math.random", () => {
    const original = Math.random;
    Math.random = function throwIfUsed(): number {
      throw new Error("generateConversationId must not use Math.random");
    };
    try {
      const id = generateConversationId();
      expect(id.length).toBe(CONVERSATION_ID_BYTES);
    } finally {
      Math.random = original;
    }
  });
});

describe("conversationIdToHex", () => {
  it("produces exactly 32 lowercase hex chars matching [0-9a-f]{32}", () => {
    const id = generateConversationId();
    const hex = conversationIdToHex(id);
    expect(hex).toMatch(HEX_PATTERN);
    expect(hex.length).toBe(32);
    expect(hex.toLowerCase()).toBe(hex);
  });

  it("matches a manual byte-by-byte rendering", () => {
    const id = encodeConversationId(randomBytes(CONVERSATION_ID_BYTES));
    const hex = conversationIdToHex(id);
    const expected = Array.from(id, (b) => b.toString(16).padStart(2, "0")).join("");
    expect(hex).toBe(expected);
  });
});

describe("hexToConversationId", () => {
  it("accepts a valid 32-char lowercase hex string", () => {
    const id = generateConversationId();
    const hex = conversationIdToHex(id);
    const recovered = hexToConversationId(hex);
    expect(bytesEqual(recovered, id)).toBe(true);
  });

  it("rejects a wrong-length string (too short)", () => {
    try {
      hexToConversationId("abc");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OrchestratorError);
      expect((err as OrchestratorError).code).toBe(OrchestratorErrorCode.MalformedInvitation);
    }
  });

  it("rejects a wrong-length string (too long)", () => {
    try {
      hexToConversationId("a".repeat(33));
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OrchestratorError);
      expect((err as OrchestratorError).code).toBe(OrchestratorErrorCode.MalformedInvitation);
    }
  });

  it("rejects uppercase hex letters", () => {
    const id = generateConversationId();
    const upper = conversationIdToHex(id).toUpperCase();
    try {
      hexToConversationId(upper);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OrchestratorError);
      expect((err as OrchestratorError).code).toBe(OrchestratorErrorCode.MalformedInvitation);
    }
  });

  it("rejects non-hex characters", () => {
    try {
      hexToConversationId("z".repeat(32));
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OrchestratorError);
      expect((err as OrchestratorError).code).toBe(OrchestratorErrorCode.MalformedInvitation);
    }
  });

  it("rejects an empty string", () => {
    try {
      hexToConversationId("");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OrchestratorError);
      expect((err as OrchestratorError).code).toBe(OrchestratorErrorCode.MalformedInvitation);
    }
  });
});

describe("formatInvitation", () => {
  it("formats as `${baseUrl}#${hex}` for a clean baseUrl", () => {
    const id = generateConversationId();
    const url = formatInvitation(id, SAMPLE_BASE_URL);
    expect(url).toBe(`${SAMPLE_BASE_URL}#${conversationIdToHex(id)}`);
  });

  it("strips a single trailing '#' on baseUrl", () => {
    const id = generateConversationId();
    const url = formatInvitation(id, `${SAMPLE_BASE_URL}#`);
    expect(url).toBe(`${SAMPLE_BASE_URL}#${conversationIdToHex(id)}`);
    const fragmentCount = (url.match(/#/g) ?? []).length;
    expect(fragmentCount).toBe(1);
  });
});

describe("parseInvitation", () => {
  it("accepts a fragment with a leading '#'", () => {
    const id = generateConversationId();
    const hex = conversationIdToHex(id);
    const { conversationId } = parseInvitation(`#${hex}`);
    expect(bytesEqual(conversationId, id)).toBe(true);
  });

  it("accepts a fragment without a leading '#'", () => {
    const id = generateConversationId();
    const hex = conversationIdToHex(id);
    const { conversationId: withHash } = parseInvitation(`#${hex}`);
    const { conversationId: noHash } = parseInvitation(hex);
    expect(bytesEqual(withHash, noHash)).toBe(true);
    expect(bytesEqual(noHash, id)).toBe(true);
  });

  it("accepts uppercase hex (LW-8 case-normalizes to lowercase)", () => {
    const id = generateConversationId();
    const upper = conversationIdToHex(id).toUpperCase();
    const { conversationId } = parseInvitation(upper);
    expect(bytesEqual(conversationId, id)).toBe(true);
  });

  it("rejects a wrong-length fragment", () => {
    try {
      parseInvitation("#abc");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OrchestratorError);
      expect((err as OrchestratorError).code).toBe(OrchestratorErrorCode.MalformedInvitation);
    }
  });

  it("rejects garbage input", () => {
    try {
      parseInvitation("#not-a-real-invitation");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OrchestratorError);
      expect((err as OrchestratorError).code).toBe(OrchestratorErrorCode.MalformedInvitation);
    }
  });
});

describe("round-trip (initiator formats, responder parses)", () => {
  it("recovers the original conversation id end-to-end", () => {
    const initiatorId = generateConversationId();
    const url = formatInvitation(initiatorId, SAMPLE_BASE_URL);
    const hashIndex = url.indexOf("#");
    expect(hashIndex).toBeGreaterThan(-1);
    const fragment = url.slice(hashIndex);
    const { conversationId: responderId } = parseInvitation(fragment);
    expect(bytesEqual(responderId, initiatorId)).toBe(true);
  });
});
