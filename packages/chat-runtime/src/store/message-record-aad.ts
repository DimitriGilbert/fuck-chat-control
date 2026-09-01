import { CONVERSATION_ID_BYTES } from "../protocol/limits";
import type { ConversationId } from "../protocol/types";

import type { MessageDirection } from "./types";

/**
 * R1:F2 — domain-separation prefix and encoding version for the message-record
 * AAD. Any future change to which fields are bound (or how they are encoded)
 * MUST pick a new prefix byte so an AAD produced by one version can never be
 * confused with an AAD produced by another.
 */
const MESSAGE_RECORD_AAD_PREFIX = 0x01;

/**
 * R1:F2 — canonical, versioned AAD encoding for a stored message record.
 *
 * RECORD LAYOUT + MIGRATION (the one mechanism: try-AAD-then-empty on decrypt,
 * implemented in `decryptAtRest` in `crypto/at-rest.ts`).
 *
 * Both repositories persist a message as cleartext metadata — id,
 * conversationId, direction, timestamp — next to base64(nonce) +
 * base64(ciphertext). Since R1:F2 the ciphertext is sealed with AES-256-GCM
 * AAD built by this function:
 *
 *   byte 0      : the {@link MESSAGE_RECORD_AAD_PREFIX} domain-separation byte
 *   bytes 1..16 : the conversation id (fixed width, CONVERSATION_ID_BYTES)
 *   bytes 17..  : the direction string ("sent" | "received") as UTF-8
 *
 * The conversation id's fixed width makes the concatenation unambiguous, and
 * the encoding is deterministic: the same (conversationId, direction) always
 * produces identical AAD bytes in BOTH repositories (in-memory and browser
 * DB), which is what lets records cross serialize()/reload()/bundle import
 * unchanged. The GCM tag then authenticates the linkage between the sealed
 * body and the row's conversation + provenance — moving a (nonce, ciphertext)
 * pair to a different conversation, or flipping its direction, fails
 * verification.
 *
 * LEGACY RECORDS: rows written before this binding were sealed with empty AAD
 * and MUST still decrypt (the backward-compatibility requirement).
 * `decryptAtRest` verifies against this AAD first and falls back to the
 * empty-AAD binding exactly once for those rows; a relocated CURRENT-format
 * row fails both attempts. Legacy rows are not re-sealed — they age out as
 * history is rewritten naturally.
 */
export function messageRecordAad(
  conversationId: ConversationId,
  direction: MessageDirection,
): Uint8Array {
  const directionBytes = new TextEncoder().encode(direction);
  const aad = new Uint8Array(1 + CONVERSATION_ID_BYTES + directionBytes.length);
  aad[0] = MESSAGE_RECORD_AAD_PREFIX;
  aad.set(conversationId, 1);
  aad.set(directionBytes, 1 + CONVERSATION_ID_BYTES);
  return aad;
}
