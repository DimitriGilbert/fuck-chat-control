import { randomBytes } from "@/features/chat/crypto/primitives";
import { encodeConversationId } from "@/features/chat/protocol/codec";
import { CONVERSATION_ID_BYTES } from "@/features/chat/protocol/limits";
import type { ConversationId } from "@/features/chat/protocol/types";

import { OrchestratorError, OrchestratorErrorCode } from "./errors";

const HEX_CHARS_PATTERN = /^[0-9a-f]{32}$/;

export function generateConversationId(): ConversationId {
  return encodeConversationId(randomBytes(CONVERSATION_ID_BYTES));
}

export function conversationIdToHex(id: ConversationId): string {
  let hex = "";
  for (let i = 0; i < id.length; i++) {
    hex += id[i].toString(16).padStart(2, "0");
  }
  return hex;
}

export function hexToConversationId(hex: string): ConversationId {
  if (!HEX_CHARS_PATTERN.test(hex)) {
    throw new OrchestratorError(
      OrchestratorErrorCode.MalformedInvitation,
      "invitation fragment must be exactly 32 lowercase hex characters [0-9a-f]",
    );
  }
  const out = new Uint8Array(CONVERSATION_ID_BYTES);
  for (let i = 0; i < CONVERSATION_ID_BYTES; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return encodeConversationId(out);
}

export function formatInvitation(id: ConversationId, baseUrl: string): string {
  const trimmed = baseUrl.endsWith("#") ? baseUrl.slice(0, -1) : baseUrl;
  return `${trimmed}#${conversationIdToHex(id)}`;
}

export function parseInvitation(fragment: string): { conversationId: ConversationId } {
  const stripped = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  return { conversationId: hexToConversationId(stripped) };
}
