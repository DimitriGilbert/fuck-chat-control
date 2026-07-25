import type { ConversationId, PublicKey } from "../protocol/types";

import { sha256 } from "./primitives";

const SAFETY_NUMBER_BITS = 40;
const SAFETY_NUMBER_BYTES = SAFETY_NUMBER_BITS / 8;
const SAFETY_NUMBER_DIGITS = 12;

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
  const truncated = digest.subarray(0, SAFETY_NUMBER_BYTES);
  return formatSafetyNumber(uint40BigEndian(truncated));
}
