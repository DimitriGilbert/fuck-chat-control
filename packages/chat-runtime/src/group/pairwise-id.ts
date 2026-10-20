import { sha256 } from "../crypto/primitives";
import { encodeConversationId, encodePublicKey } from "../protocol/codec";
import type { ConversationId, PublicKey } from "../protocol/types";

import { encodeGroupId } from "./types";
import type { GroupId } from "./types";

/**
 * Domain separator (protocol-v2 §3): keeps derived pairwise conversation IDs
 * disjoint from CSPRNG-minted v1 conversation IDs and from any future label.
 * ASCII, no trailing NUL.
 */
const PAIRWISE_DOMAIN = new TextEncoder().encode("fck-group-v1/pair");
const DERIVED_CONVERSATION_ID_BYTES = 16;

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/**
 * Derive one member↔member link's v1 conversation ID (protocol-v2 §3):
 *
 *   pairwiseConvId = SHA-256("fck-group-v1/pair" ‖ groupId(16) ‖
 *                            min(idPubA, idPubB) ‖ max(idPubA, idPubB))[0..16]
 *
 * `min`/`max` order the two 65-byte uncompressed SEC1 identity keys by the
 * same lexicographic byte comparison as v1 role derivation (protocol-v1 §3);
 * `[0..16]` takes the first 16 bytes of the digest — a full-width v1
 * conversation ID. The derivation is deterministic and symmetric: both sides
 * compute the same ID from the two identity keys alone, so the frozen v1
 * handshake codec runs untouched and each pair gets a stable, pair-specific
 * v1 safety number.
 */
export async function derivePairwiseConvId(
  groupId: GroupId,
  idPubA: PublicKey,
  idPubB: PublicKey,
): Promise<ConversationId> {
  const gid = encodeGroupId(groupId);
  const a = encodePublicKey(idPubA);
  const b = encodePublicKey(idPubB);
  const [first, second] = compareBytes(a, b) <= 0 ? [a, b] : [b, a];
  const material = new Uint8Array(
    PAIRWISE_DOMAIN.length + gid.length + first.length + second.length,
  );
  let offset = 0;
  material.set(PAIRWISE_DOMAIN, offset);
  offset += PAIRWISE_DOMAIN.length;
  material.set(gid, offset);
  offset += gid.length;
  material.set(first, offset);
  offset += first.length;
  material.set(second, offset);
  const digest = await sha256(material);
  return encodeConversationId(digest.subarray(0, DERIVED_CONVERSATION_ID_BYTES));
}
