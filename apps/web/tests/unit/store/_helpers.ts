import { p256 } from "@noble/curves/p256";

import {
  encodeConversationId,
  encodePublicKey,
} from "@fuck-eu-chat-control/chat-runtime/protocol/codec";
import { CONVERSATION_ID_BYTES } from "@fuck-eu-chat-control/chat-runtime/protocol/limits";
import type { ConversationId, PublicKey } from "@fuck-eu-chat-control/chat-runtime/protocol/types";

/**
 * Web-local store test doubles for the tests that stay in apps/web
 * (`browser-db-repo`).
 *
 * The canonical copy of these helpers now lives in the chat-runtime package
 * (`packages/chat-runtime/tests/unit/store/_helpers.ts`) for the neutral tests
 * that moved there. This file holds only the surface the web-only tests still
 * consume — `conversationId`, and a deterministic on-curve P-256 public key.
 */
export function conversationId(seed: number): ConversationId {
  const bytes = new Uint8Array(CONVERSATION_ID_BYTES);
  for (let i = 0; i < CONVERSATION_ID_BYTES; i++) bytes[i] = (seed * 31 + i) & 0xff;
  return encodeConversationId(bytes);
}

export function deterministicPublicKey(seed: number): PublicKey {
  const sk = new Uint8Array(32);
  for (let i = 0; i < 32; i++) sk[i] = (seed * 7 + i + 1) & 0xff;
  return encodePublicKey(p256.getPublicKey(sk, false));
}
