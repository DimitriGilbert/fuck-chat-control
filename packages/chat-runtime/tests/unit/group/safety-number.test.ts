import { describe, expect, it } from "vitest";

import { computeGroupSafetyNumber } from "@fuck-eu-chat-control/chat-runtime/crypto";
import { encodeGroupId } from "@fuck-eu-chat-control/chat-runtime/group";
import type { GroupId } from "@fuck-eu-chat-control/chat-runtime/group";
import { CONVERSATION_ID_BYTES } from "@fuck-eu-chat-control/chat-runtime/protocol/limits";

import { compareBytes, deterministicPublicKey } from "../crypto/_helpers";

const SAFETY_NUMBER_PATTERN = /^(\d{2} ){5}\d{2}$/;

function groupId(seed: number): GroupId {
  const bytes = new Uint8Array(CONVERSATION_ID_BYTES);
  for (let i = 0; i < CONVERSATION_ID_BYTES; i++) bytes[i] = (seed * 13 + i) & 0xff;
  return encodeGroupId(bytes);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function uint40Be(bytes: Uint8Array): number {
  return (
    bytes[0] * 0x100000000 + bytes[1] * 0x1000000 + bytes[2] * 0x10000 + bytes[3] * 0x100 + bytes[4]
  );
}

/**
 * Independent re-derivation of the group safety number — WebCrypto SHA-256
 * over "fck-group-v1/safety" ‖ groupId ‖ epoch(u32 BE) ‖ sorted member pubs,
 * then first-5-bytes uint40 BE mod 10^12 rendered as six two-digit groups.
 * Catches a wrong domain label, a wrong epoch encoding, or unsorted member
 * ordering in the implementation under test.
 */
async function independentGroupSafetyNumber(
  gid: Uint8Array,
  epoch: number,
  pubs: readonly Uint8Array[],
): Promise<string> {
  const domain = new TextEncoder().encode("fck-group-v1/safety");
  const epochBytes = new Uint8Array(4);
  new DataView(epochBytes.buffer).setUint32(0, epoch, false);
  const material = concat(domain, gid, epochBytes, ...[...pubs].sort(compareBytes));
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", material));
  const value = uint40Be(digest.subarray(0, 5)) % 10 ** 12;
  const padded = value.toString(10).padStart(12, "0");
  const groups: string[] = [];
  for (let i = 0; i < padded.length; i += 2) groups.push(padded.slice(i, i + 2));
  return groups.join(" ");
}

describe("computeGroupSafetyNumber (protocol-v2 §5)", () => {
  it("renders the same 12-digit grouped display as the pairwise flavor", async () => {
    const gid = groupId(1);
    const pubs = [deterministicPublicKey(1), deterministicPublicKey(2)];
    const value = await computeGroupSafetyNumber(gid, 1, pubs);
    expect(value).toMatch(SAFETY_NUMBER_PATTERN);
  });

  it("matches an independently computed SHA-256 golden vector", async () => {
    const gid = groupId(3);
    // Deliberately unsorted input order and a non-trivial epoch so a wrong
    // sort order or epoch encoding flips the digest.
    const pubs = [deterministicPublicKey(3), deterministicPublicKey(1), deterministicPublicKey(2)];
    const epoch = 0x01020304;
    const expected = await independentGroupSafetyNumber(gid, epoch, pubs);
    const actual = await computeGroupSafetyNumber(gid, epoch, pubs);
    expect(actual).toBe(expected);
    expect(actual).toMatch(SAFETY_NUMBER_PATTERN);
  });

  it("is stable for identical inputs", async () => {
    const gid = groupId(1);
    const pubs = [deterministicPublicKey(1), deterministicPublicKey(2)];
    const first = await computeGroupSafetyNumber(gid, 3, pubs);
    const second = await computeGroupSafetyNumber(gid, 3, pubs);
    expect(first).toBe(second);
  });

  it("is insensitive to member-list input order (sorted internally)", async () => {
    const gid = groupId(1);
    const a = deterministicPublicKey(1);
    const b = deterministicPublicKey(2);
    const c = deterministicPublicKey(3);
    const abc = await computeGroupSafetyNumber(gid, 1, [a, b, c]);
    const cba = await computeGroupSafetyNumber(gid, 1, [c, b, a]);
    expect(abc).toBe(cba);
  });

  it("changes on every epoch bump", async () => {
    const gid = groupId(1);
    const pubs = [deterministicPublicKey(1), deterministicPublicKey(2)];
    const e1 = await computeGroupSafetyNumber(gid, 1, pubs);
    const e2 = await computeGroupSafetyNumber(gid, 2, pubs);
    expect(e1).not.toBe(e2);
  });

  it("changes when the member set changes", async () => {
    const gid = groupId(1);
    const a = deterministicPublicKey(1);
    const b = deterministicPublicKey(2);
    const c = deterministicPublicKey(3);
    const ab = await computeGroupSafetyNumber(gid, 1, [a, b]);
    const abc = await computeGroupSafetyNumber(gid, 1, [a, b, c]);
    const ac = await computeGroupSafetyNumber(gid, 1, [a, c]);
    expect(ab).not.toBe(abc);
    expect(ab).not.toBe(ac);
  });

  it("changes when the group id changes", async () => {
    const pubs = [deterministicPublicKey(1), deterministicPublicKey(2)];
    const g1 = await computeGroupSafetyNumber(groupId(1), 1, pubs);
    const g2 = await computeGroupSafetyNumber(groupId(2), 1, pubs);
    expect(g1).not.toBe(g2);
  });
});
