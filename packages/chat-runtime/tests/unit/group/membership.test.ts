import { describe, expect, it } from "vitest";

import { generateIdentityKeyPair } from "@fuck-eu-chat-control/chat-runtime/crypto";
import {
  addedMembers,
  decodeMembership,
  encodeGroupId,
  encodeMembership,
  encodeMembershipBody,
  GroupError,
  GroupErrorCode,
  removedMembers,
  signMembership,
  verifyMembership,
} from "@fuck-eu-chat-control/chat-runtime/group";
import type { GroupId, GroupMember } from "@fuck-eu-chat-control/chat-runtime/group";
import {
  CONVERSATION_ID_BYTES,
  DEFAULT_MAX_GROUP_MEMBERS,
  MAX_GROUP_MEMBERS_HARD,
  MAX_MEMBER_DISPLAY_NAME,
  PUBLIC_KEY_BYTES,
  SIGNATURE_BYTES,
} from "@fuck-eu-chat-control/chat-runtime/protocol/limits";

import { bytesEqual, deterministicPublicKey } from "../crypto/_helpers";

const HEADER_BYTES = CONVERSATION_ID_BYTES + 4 + 1;
const ENTRY_FIXED_BYTES = PUBLIC_KEY_BYTES + 1 + 1;

function groupId(seed: number): GroupId {
  const bytes = new Uint8Array(CONVERSATION_ID_BYTES);
  for (let i = 0; i < CONVERSATION_ID_BYTES; i++) bytes[i] = (seed * 13 + i) & 0xff;
  return encodeGroupId(bytes);
}

function expectGroupError(fn: () => unknown, code: GroupErrorCode): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(GroupError);
    expect((err as GroupError).code).toBe(code);
    return;
  }
  throw new Error(`expected GroupError ${code}, but no error was thrown`);
}

async function makeMembership(namePrefix = "m") {
  const author = await generateIdentityKeyPair();
  const bob = await generateIdentityKeyPair();
  const gid = groupId(1);
  const members: GroupMember[] = [
    { identityPub: author.publicKey, isAuthor: true, displayName: `${namePrefix}-author` },
    { identityPub: bob.publicKey, isAuthor: false, displayName: `${namePrefix}-bob` },
  ];
  const body = encodeMembershipBody(gid, 1, members);
  const signature = await signMembership(body, author.privateKey);
  const membership = { groupId: gid, epoch: 1, members, signature };
  return { author, bob, gid, members, body, signature, membership };
}

describe("group_membership codec (protocol-v2 §4.1)", () => {
  it("round-trips encode → decode with all fields preserved", async () => {
    const { members, membership } = await makeMembership();
    const payload = encodeMembership(membership);
    const decoded = decodeMembership(payload);
    expect(bytesEqual(decoded.groupId, membership.groupId)).toBe(true);
    expect(decoded.epoch).toBe(1);
    expect(decoded.members.length).toBe(2);
    for (let i = 0; i < members.length; i++) {
      expect(bytesEqual(decoded.members[i].identityPub, members[i].identityPub)).toBe(true);
      expect(decoded.members[i].isAuthor).toBe(members[i].isAuthor);
      expect(decoded.members[i].displayName).toBe(members[i].displayName);
    }
    expect(bytesEqual(decoded.signature, membership.signature)).toBe(true);
  });

  it("verifies a genuine author signature", async () => {
    const { membership } = await makeMembership();
    const decoded = decodeMembership(encodeMembership(membership));
    await expect(verifyMembership(decoded)).resolves.toBe(true);
  });

  it("fails verification when any body field is tampered", async () => {
    const { membership } = await makeMembership();
    const payload = encodeMembership(membership);
    // Flip one byte in the groupId, the epoch, and a member displayName in
    // turn; each tampered copy still decodes (the fields stay structurally
    // valid — the displayName byte flips an ASCII 'm' to 'l') but MUST fail
    // signature verification.
    for (const offset of [0, CONVERSATION_ID_BYTES, HEADER_BYTES + ENTRY_FIXED_BYTES]) {
      const tampered = new Uint8Array(payload);
      tampered[offset] ^= 0x01;
      const decoded = decodeMembership(tampered);
      await expect(verifyMembership(decoded)).resolves.toBe(false);
    }
    // Tamper inside the signature trailer itself.
    const tamperedSig = new Uint8Array(payload);
    tamperedSig[tamperedSig.length - 1] ^= 0x01;
    await expect(verifyMembership(decodeMembership(tamperedSig))).resolves.toBe(false);
  });

  it("fails verification against a non-author signer", async () => {
    const { bob, gid, members } = await makeMembership();
    // Re-sign the same body with a member (non-author) key: signature is
    // well-formed but does not verify against the author entry's key.
    const body = encodeMembershipBody(gid, 1, members);
    const badSig = await signMembership(body, bob.privateKey);
    await expect(
      verifyMembership({ groupId: gid, epoch: 1, members, signature: badSig }),
    ).resolves.toBe(false);
  });

  it("rejects memberCount above the configured cap before reading entries", async () => {
    const { membership } = await makeMembership();
    const payload = encodeMembership(membership);
    payload[CONVERSATION_ID_BYTES + 4] = 200;
    expectGroupError(
      () => decodeMembership(payload, DEFAULT_MAX_GROUP_MEMBERS),
      GroupErrorCode.MemberLimitReached,
    );
  });

  it("clamps an over-large caller cap to MAX_GROUP_MEMBERS_HARD on decode", async () => {
    const { membership } = await makeMembership();
    const payload = encodeMembership(membership);
    // A caller-supplied cap above the hard ceiling must not admit an
    // oversized memberCount: decodeMembership clamps to
    // MAX_GROUP_MEMBERS_HARD before the memberCount check.
    payload[CONVERSATION_ID_BYTES + 4] = MAX_GROUP_MEMBERS_HARD + 1;
    expectGroupError(
      () => decodeMembership(payload, MAX_GROUP_MEMBERS_HARD + 64),
      GroupErrorCode.MemberLimitReached,
    );
  });

  it("rejects a decoded list whose entries share one identityPub", async () => {
    const { membership } = await makeMembership();
    const payload = encodeMembership(membership);
    // The encode path refuses duplicates, so craft the collision on the wire
    // bytes: overwrite entry 1's identityPub with entry 0's. Entry 1 sits at
    // header + entry0(65 + 1 + 1 + nameLen0).
    const nameLen0 = payload[HEADER_BYTES + PUBLIC_KEY_BYTES + 1];
    const entry1Offset = HEADER_BYTES + ENTRY_FIXED_BYTES + nameLen0;
    payload.set(payload.subarray(HEADER_BYTES, HEADER_BYTES + PUBLIC_KEY_BYTES), entry1Offset);
    expectGroupError(() => decodeMembership(payload), GroupErrorCode.MembershipInvalid);
  });

  it("rejects a list with zero author entries", async () => {
    const { membership, members } = await makeMembership();
    const payload = encodeMembership(membership);
    // Clear the author flag on the first entry (flags byte at entry+65).
    payload[HEADER_BYTES + PUBLIC_KEY_BYTES] = 0;
    expect(members[0].isAuthor).toBe(true);
    expectGroupError(() => decodeMembership(payload), GroupErrorCode.MembershipInvalid);
  });

  it("rejects a list with two author entries", async () => {
    const { membership, members } = await makeMembership();
    const payload = encodeMembership(membership);
    // Set the author flag on the SECOND entry: offset = header +
    // entry0(65+1+1+nameLen0) + 65.
    const nameLen0 = payload[HEADER_BYTES + PUBLIC_KEY_BYTES + 1];
    const entry1Flags = HEADER_BYTES + ENTRY_FIXED_BYTES + nameLen0 + PUBLIC_KEY_BYTES;
    payload[entry1Flags] = 1;
    expect(members[1].isAuthor).toBe(false);
    expectGroupError(() => decodeMembership(payload), GroupErrorCode.MembershipInvalid);
  });

  it("rejects reserved flag bits", async () => {
    const { membership } = await makeMembership();
    const payload = encodeMembership(membership);
    payload[HEADER_BYTES + PUBLIC_KEY_BYTES] = 0x80;
    expectGroupError(() => decodeMembership(payload), GroupErrorCode.Malformed);
  });

  it("rejects displayNameLen above MAX_MEMBER_DISPLAY_NAME on decode", async () => {
    const { membership } = await makeMembership();
    const payload = encodeMembership(membership);
    payload[HEADER_BYTES + PUBLIC_KEY_BYTES + 1] = MAX_MEMBER_DISPLAY_NAME + 1;
    expectGroupError(() => decodeMembership(payload), GroupErrorCode.Malformed);
  });

  it("rejects displayName above MAX_MEMBER_DISPLAY_NAME on encode", async () => {
    const author = await generateIdentityKeyPair();
    const members: GroupMember[] = [
      {
        identityPub: author.publicKey,
        isAuthor: true,
        displayName: "x".repeat(MAX_MEMBER_DISPLAY_NAME + 1),
      },
    ];
    expectGroupError(() => encodeMembershipBody(groupId(2), 1, members), GroupErrorCode.Malformed);
  });

  it("rejects a truncated payload", async () => {
    const { membership } = await makeMembership();
    const payload = encodeMembership(membership);
    const truncated = payload.subarray(0, payload.length - SIGNATURE_BYTES - 1);
    expectGroupError(() => decodeMembership(truncated), GroupErrorCode.Malformed);
  });

  it("rejects duplicate member identities", async () => {
    const author = await generateIdentityKeyPair();
    const members: GroupMember[] = [
      { identityPub: author.publicKey, isAuthor: true, displayName: "a" },
      { identityPub: author.publicKey, isAuthor: false, displayName: "b" },
    ];
    expectGroupError(
      () => encodeMembershipBody(groupId(3), 1, members),
      GroupErrorCode.MembershipInvalid,
    );
  });

  it("computes added/removed member diffs keyed by identityPub", async () => {
    const { members: prev } = await makeMembership();
    const carol = await generateIdentityKeyPair();
    const next: GroupMember[] = [
      prev[0],
      { identityPub: carol.publicKey, isAuthor: false, displayName: "carol" },
    ];
    const added = addedMembers(prev, next);
    expect(added.length).toBe(1);
    expect(bytesEqual(added[0].identityPub, carol.publicKey)).toBe(true);
    const removed = removedMembers(prev, next);
    expect(removed.length).toBe(1);
    expect(bytesEqual(removed[0].identityPub, prev[1].identityPub)).toBe(true);
    // Identical lists produce empty diffs.
    expect(addedMembers(prev, prev).length).toBe(0);
    expect(removedMembers(prev, prev).length).toBe(0);
  });

  it("decodes a full cap-sized list (boundary)", async () => {
    const author = await generateIdentityKeyPair();
    const members: GroupMember[] = [
      { identityPub: author.publicKey, isAuthor: true, displayName: "a" },
    ];
    for (let i = 1; i < DEFAULT_MAX_GROUP_MEMBERS; i++) {
      members.push({
        identityPub: deterministicPublicKey(100 + i),
        isAuthor: false,
        displayName: `m${i}`,
      });
    }
    const gid = groupId(4);
    const body = encodeMembershipBody(gid, 7, members);
    const signature = await signMembership(body, author.privateKey);
    const decoded = decodeMembership(
      encodeMembership({ groupId: gid, epoch: 7, members, signature }),
    );
    expect(decoded.members.length).toBe(DEFAULT_MAX_GROUP_MEMBERS);
    await expect(verifyMembership(decoded)).resolves.toBe(true);
  });
});
