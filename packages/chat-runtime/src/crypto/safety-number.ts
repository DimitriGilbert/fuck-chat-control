import { CONVERSATION_ID_BYTES, PUBLIC_KEY_BYTES } from "../protocol/limits";
import type { ConversationId, PublicKey } from "../protocol/types";

import { CryptoError, CryptoErrorCode } from "./errors";
import { sha256 } from "./primitives";

const SAFETY_NUMBER_BITS = 40;
const SAFETY_NUMBER_BYTES = SAFETY_NUMBER_BITS / 8;
const SAFETY_NUMBER_DIGITS = 12;
/**
 * Signal-style safety number: a 40-bit truncation rendered in base 10. The
 * raw 40-bit value can reach 2^40 - 1 (13 decimal digits); taking it modulo
 * 10^12 guarantees exactly 12 digits, so the result always formats as six
 * two-digit groups instead of intermittently overflowing into a seventh.
 */
const SAFETY_NUMBER_MODULUS = 10 ** 12;

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

function uint40BigEndian(bytes: Uint8Array): number {
  return (
    bytes[0] * 0x100000000 + bytes[1] * 0x1000000 + bytes[2] * 0x10000 + bytes[3] * 0x100 + bytes[4]
  );
}

function formatSafetyNumber(value: number): string {
  const padded = value.toString(10).padStart(SAFETY_NUMBER_DIGITS, "0");
  const groups: string[] = [];
  for (let i = 0; i < padded.length; i += 2) {
    groups.push(padded.slice(i, i + 2));
  }
  return groups.join(" ");
}

/**
 * Shared rendering tail for both safety-number flavors: truncate the digest
 * to its first 40 bits (big-endian), reduce mod 10^12, format as six
 * space-separated two-digit groups.
 */
function renderSafetyNumber(digest: Uint8Array): string {
  const truncated = digest.subarray(0, SAFETY_NUMBER_BYTES);
  return formatSafetyNumber(uint40BigEndian(truncated) % SAFETY_NUMBER_MODULUS);
}

export async function computeSafetyNumber(
  conversationId: ConversationId,
  idPubA: PublicKey,
  idPubB: PublicKey,
): Promise<string> {
  const [first, second] = compareBytes(idPubA, idPubB) <= 0 ? [idPubA, idPubB] : [idPubB, idPubA];
  const material = new Uint8Array(conversationId.length + first.length + second.length);
  material.set(conversationId, 0);
  material.set(first, conversationId.length);
  material.set(second, conversationId.length + first.length);
  const digest = await sha256(material);
  return renderSafetyNumber(digest);
}

/**
 * Group safety number (protocol-v2 §5): a single number covering the whole
 * member list at one epoch, computed identically on every member's client.
 *
 *   material = "fck-group-v1/safety" ‖ groupId(16) ‖ epoch(4BE) ‖ sorted(memberIdPubs)
 *
 * `sorted(memberIdPubs)` concatenates all member identity public keys — the
 * author's included, each 65-byte uncompressed SEC1 — ordered by the same
 * lexicographic byte comparison as v1. The number changes on every epoch
 * bump, so an out-of-band comparison authenticates the member list AS OF that
 * epoch; each pairwise link additionally retains its own v1 safety number.
 */
const GROUP_SAFETY_DOMAIN = new TextEncoder().encode("fck-group-v1/safety");
const UINT32_MAX = 0xffffffff;

export async function computeGroupSafetyNumber(
  groupId: Uint8Array,
  epoch: number,
  memberPubs: readonly Uint8Array[],
): Promise<string> {
  if (groupId.length !== CONVERSATION_ID_BYTES) {
    throw new CryptoError(
      CryptoErrorCode.InvalidArgument,
      `group id must be ${CONVERSATION_ID_BYTES} bytes, got ${groupId.length}`,
    );
  }
  if (!Number.isInteger(epoch) || epoch < 0 || epoch > UINT32_MAX) {
    throw new CryptoError(
      CryptoErrorCode.InvalidArgument,
      `epoch must be an unsigned uint32 integer, got ${epoch}`,
    );
  }
  for (const pub of memberPubs) {
    if (pub.length !== PUBLIC_KEY_BYTES) {
      throw new CryptoError(
        CryptoErrorCode.InvalidArgument,
        `member identity key must be ${PUBLIC_KEY_BYTES} bytes, got ${pub.length}`,
      );
    }
  }
  const sorted = [...memberPubs].sort(compareBytes);
  let membersLength = 0;
  for (const pub of sorted) membersLength += pub.length;
  const material = new Uint8Array(
    GROUP_SAFETY_DOMAIN.length + CONVERSATION_ID_BYTES + 4 + membersLength,
  );
  let offset = 0;
  material.set(GROUP_SAFETY_DOMAIN, offset);
  offset += GROUP_SAFETY_DOMAIN.length;
  material.set(groupId, offset);
  offset += CONVERSATION_ID_BYTES;
  material[offset] = (epoch >>> 24) & 0xff;
  material[offset + 1] = (epoch >>> 16) & 0xff;
  material[offset + 2] = (epoch >>> 8) & 0xff;
  material[offset + 3] = epoch & 0xff;
  offset += 4;
  for (const pub of sorted) {
    material.set(pub, offset);
    offset += pub.length;
  }
  const digest = await sha256(material);
  return renderSafetyNumber(digest);
}
