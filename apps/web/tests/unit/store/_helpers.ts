import { p256 } from "@noble/curves/p256";

import { encodeConversationId, encodePublicKey } from "@/features/chat/protocol/codec";
import { CONVERSATION_ID_BYTES } from "@/features/chat/protocol/limits";
import type { ConversationId, PublicKey } from "@/features/chat/protocol/types";

export { bytesEqual } from "../crypto/_helpers";

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

export function fingerprintOf(publicKey: PublicKey, seed: number): string {
  let hex = "";
  for (let i = 0; i < publicKey.length; i++) {
    hex += ((publicKey[i] ^ seed) & 0xff).toString(16).padStart(2, "0");
  }
  return hex;
}
