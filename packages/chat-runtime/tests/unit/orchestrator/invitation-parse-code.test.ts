import { describe, expect, it } from "vitest";

import { randomBytes } from "@fuck-eu-chat-control/chat-runtime/crypto/primitives";
import { encodeConversationId } from "@fuck-eu-chat-control/chat-runtime/protocol/codec";
import { CONVERSATION_ID_BYTES } from "@fuck-eu-chat-control/chat-runtime/protocol/limits";

import {
  conversationIdToHex,
  formatInvitation,
  generateConversationId,
  hexToConversationId,
  parseInvitation,
} from "@fuck-eu-chat-control/chat-runtime/orchestrator/invitation";
import { OrchestratorError, OrchestratorErrorCode } from "@fuck-eu-chat-control/chat-runtime/orchestrator/errors";

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

const SAMPLE_BASE_URL = "https://app.example";

describe("invitation parser accepts ~code (R7/F6 / Phase 8.3)", () => {
  describe("parseInvitation: bare hex still works (backward compatibility)", () => {
    it("accepts a bare 32-char hex string", () => {
      const id = generateConversationId();
      const hex = conversationIdToHex(id);
      const parsed = parseInvitation(hex);
      expect(bytesEqual(parsed.conversationId, id)).toBe(true);
      expect(parsed.code).toBeNull();
    });

    it("accepts a leading-# bare fragment", () => {
      const id = generateConversationId();
      const hex = conversationIdToHex(id);
      const parsed = parseInvitation(`#${hex}`);
      expect(bytesEqual(parsed.conversationId, id)).toBe(true);
      expect(parsed.code).toBeNull();
    });

    it("accepts a full URL fragment", () => {
      const id = generateConversationId();
      const url = formatInvitation(id, SAMPLE_BASE_URL);
      const hashIndex = url.lastIndexOf("#");
      const parsed = parseInvitation(url.slice(hashIndex));
      expect(bytesEqual(parsed.conversationId, id)).toBe(true);
      expect(parsed.code).toBeNull();
    });
  });

  describe("parseInvitation: hex + ~code", () => {
    it("accepts a hex~code fragment and returns the conversationId + code", () => {
      const id = generateConversationId();
      const hex = conversationIdToHex(id);
      const parsed = parseInvitation(`${hex}~123456`);
      expect(bytesEqual(parsed.conversationId, id)).toBe(true);
      expect(parsed.code).toBe("123456");
    });

    it("accepts a leading-# fragment with code", () => {
      const id = generateConversationId();
      const hex = conversationIdToHex(id);
      const parsed = parseInvitation(`#${hex}~000042`);
      expect(bytesEqual(parsed.conversationId, id)).toBe(true);
      expect(parsed.code).toBe("000042");
    });

    it("accepts a 6-digit code with leading zeros (lower bound)", () => {
      const id = generateConversationId();
      const hex = conversationIdToHex(id);
      const parsed = parseInvitation(`${hex}~000000`);
      expect(parsed.code).toBe("000000");
    });

    it("accepts a 6-digit code (upper bound)", () => {
      const id = generateConversationId();
      const hex = conversationIdToHex(id);
      const parsed = parseInvitation(`${hex}~999999`);
      expect(parsed.code).toBe("999999");
    });

    it("rejects a 1..5-digit code (PRD #90 requires exactly 6 digits)", () => {
      const id = generateConversationId();
      const hex = conversationIdToHex(id);
      expect(() => parseInvitation(`${hex}~7`)).toThrow(OrchestratorError);
      expect(() => parseInvitation(`${hex}~42`)).toThrow(OrchestratorError);
      expect(() => parseInvitation(`${hex}~12345`)).toThrow(OrchestratorError);
    });

    it("rejects a 7-digit code (above the upper bound)", () => {
      const id = generateConversationId();
      const hex = conversationIdToHex(id);
      expect(() => parseInvitation(`${hex}~1234567`)).toThrow(OrchestratorError);
      try {
        parseInvitation(`${hex}~1234567`);
      } catch (err) {
        expect(err).toBeInstanceOf(OrchestratorError);
        expect((err as OrchestratorError).code).toBe(OrchestratorErrorCode.MalformedInvitation);
      }
    });

    it("rejects an empty code (just ~)", () => {
      const id = generateConversationId();
      const hex = conversationIdToHex(id);
      expect(() => parseInvitation(`${hex}~`)).toThrow(OrchestratorError);
    });

    it("rejects a non-numeric code", () => {
      const id = generateConversationId();
      const hex = conversationIdToHex(id);
      expect(() => parseInvitation(`${hex}~abcdef`)).toThrow(OrchestratorError);
    });

    it("accepts uppercase hex in the hex+code form (LW-8 case normalization)", () => {
      const id = generateConversationId();
      const upper = conversationIdToHex(id).toUpperCase();
      const parsed = parseInvitation(`${upper}~123456`);
      expect(bytesEqual(parsed.conversationId, id)).toBe(true);
      expect(parsed.code).toBe("123456");
    });

    it("rejects a wrong-length hex part even with a valid ~code tail", () => {
      expect(() => parseInvitation(`abc~123456`)).toThrow(OrchestratorError);
    });
  });

  describe("parseInvitation: error compatibility", () => {
    it("rejects an empty fragment", () => {
      expect(() => parseInvitation("")).toThrow(OrchestratorError);
    });

    it("rejects a fragment with a stray ~ in the wrong place", () => {
      expect(() => parseInvitation("~123456")).toThrow(OrchestratorError);
    });

    it("rejects a fragment with multiple ~ separators", () => {
      const id = generateConversationId();
      const hex = conversationIdToHex(id);
      expect(() => parseInvitation(`${hex}~12~34`)).toThrow(OrchestratorError);
    });
  });

  describe("round-trip with code", () => {
    it("the responder parses the initiator's hex~code and recovers both fields", () => {
      const initiatorId = encodeConversationId(randomBytes(CONVERSATION_ID_BYTES));
      const hex = conversationIdToHex(initiatorId);
      const code = "654321";
      // Initiator ships the fragment (out-of-band channel; formatInvitation
      // itself does not append a code — the controller/appended layer adds it).
      const fragment = `${hex}~${code}`;
      const parsed = parseInvitation(fragment);
      expect(bytesEqual(parsed.conversationId, initiatorId)).toBe(true);
      expect(parsed.code).toBe(code);
    });
  });
});

describe("hexToConversationId backward compatibility", () => {
  it("continues to reject ~code input (the bare-hex parser is unchanged)", () => {
    const id = generateConversationId();
    const hex = conversationIdToHex(id);
    expect(() => hexToConversationId(`${hex}~123456`)).toThrow(OrchestratorError);
  });
});
