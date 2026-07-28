import { encodeConversationId } from "@fuck-eu-chat-control/chat-runtime/protocol/codec";
import { CONVERSATION_ID_BYTES } from "@fuck-eu-chat-control/chat-runtime/protocol/limits";
import type { ConversationId } from "@fuck-eu-chat-control/chat-runtime/protocol/types";

/**
 * Web-local store test doubles for the tests that stay in apps/web
 * (`browser-db-repo`).
 *
 * The canonical copy of these helpers now lives in the chat-runtime package
 * (`packages/chat-runtime/tests/unit/store/_helpers.ts`) for the neutral tests
 * that moved there. This file holds only the surface the web-only tests still
 * consume — `conversationId`, a deterministic ConversationId factory.
 */
export function conversationId(seed: number): ConversationId {
  const bytes = new Uint8Array(CONVERSATION_ID_BYTES);
  for (let i = 0; i < CONVERSATION_ID_BYTES; i++) bytes[i] = (seed * 31 + i) & 0xff;
  return encodeConversationId(bytes);
}
