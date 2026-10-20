import { describe, expect, it } from "vitest";

import {
  derivePairwiseConvId,
  encodeGroupId,
  GroupError,
} from "@fuck-eu-chat-control/chat-runtime/group";
import type { GroupId } from "@fuck-eu-chat-control/chat-runtime/group";
import { CONVERSATION_ID_BYTES } from "@fuck-eu-chat-control/chat-runtime/protocol/limits";
import type { PublicKey } from "@fuck-eu-chat-control/chat-runtime/protocol/types";

import { bytesEqual, compareBytes, deterministicPublicKey } from "../crypto/_helpers";

function groupId(seed: number) {
  const bytes = new Uint8Array(CONVERSATION_ID_BYTES);
  for (let i = 0; i < CONVERSATION_ID_BYTES; i++) bytes[i] = (seed * 13 + i) & 0xff;
  return encodeGroupId(bytes);
}

/**
 * Independent re-derivation of the pairwise conversation id — WebCrypto
 * SHA-256 over "fck-group-v1/pair" ‖ groupId ‖ min(idPubA, idPubB) ‖
 * max(idPubA, idPubB), truncated to the first 16 bytes. Catches a wrong
 * domain label, a wrong field order, or a wrong truncation offset in the
 * implementation under test.
 */
async function independentPairwiseConvId(
  gid: GroupId,
  a: PublicKey,
  b: PublicKey,
): Promise<Uint8Array> {
  const domain = new TextEncoder().encode("fck-group-v1/pair");
  const [first, second] = compareBytes(a, b) <= 0 ? [a, b] : [b, a];
  const material = new Uint8Array(domain.length + gid.length + first.length + second.length);
  material.set(domain, 0);
  material.set(gid, domain.length);
  material.set(first, domain.length + gid.length);
  material.set(second, domain.length + gid.length + first.length);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", material));
  return digest.subarray(0, CONVERSATION_ID_BYTES);
}

describe("derivePairwiseConvId (protocol-v2 §3)", () => {
  it("is deterministic for the same inputs", async () => {
    const gid = groupId(1);
    const a = deterministicPublicKey(1);
    const b = deterministicPublicKey(2);
    const first = await derivePairwiseConvId(gid, a, b);
    const second = await derivePairwiseConvId(gid, a, b);
    expect(first.length).toBe(CONVERSATION_ID_BYTES);
    expect(bytesEqual(first, second)).toBe(true);
  });

  it("matches an independently computed SHA-256 golden vector", async () => {
    const gid = groupId(7);
    const a = deterministicPublicKey(1);
    const b = deterministicPublicKey(2);
    const expected = await independentPairwiseConvId(gid, a, b);
    const actual = await derivePairwiseConvId(gid, a, b);
    expect(actual.length).toBe(CONVERSATION_ID_BYTES);
    expect(bytesEqual(actual, expected)).toBe(true);
  });

  it("is symmetric in the two identity keys (min/max ordering)", async () => {
    const gid = groupId(1);
    const a = deterministicPublicKey(1);
    const b = deterministicPublicKey(2);
    const ab = await derivePairwiseConvId(gid, a, b);
    const ba = await derivePairwiseConvId(gid, b, a);
    expect(bytesEqual(ab, ba)).toBe(true);
  });

  it("produces distinct ids for distinct pairs", async () => {
    const gid = groupId(1);
    const a = deterministicPublicKey(1);
    const b = deterministicPublicKey(2);
    const c = deterministicPublicKey(3);
    const ab = await derivePairwiseConvId(gid, a, b);
    const ac = await derivePairwiseConvId(gid, a, c);
    const bc = await derivePairwiseConvId(gid, b, c);
    expect(bytesEqual(ab, ac)).toBe(false);
    expect(bytesEqual(ab, bc)).toBe(false);
    expect(bytesEqual(ac, bc)).toBe(false);
  });

  it("produces distinct ids for distinct groups", async () => {
    const a = deterministicPublicKey(1);
    const b = deterministicPublicKey(2);
    const g1 = await derivePairwiseConvId(groupId(1), a, b);
    const g2 = await derivePairwiseConvId(groupId(2), a, b);
    expect(bytesEqual(g1, g2)).toBe(false);
  });

  it("rejects a group id that is not 16 bytes", async () => {
    const a = deterministicPublicKey(1);
    const b = deterministicPublicKey(2);
    const badGroupId = new Uint8Array(8) as unknown as GroupId;
    await expect(derivePairwiseConvId(badGroupId, a, b)).rejects.toThrow(GroupError);
  });

  it("rejects an identity key that is not a valid SEC1 point", async () => {
    const gid = groupId(1);
    const a = deterministicPublicKey(1);
    const badPub = new Uint8Array(65) as unknown as PublicKey;
    await expect(derivePairwiseConvId(gid, a, badPub)).rejects.toThrow();
  });
});
