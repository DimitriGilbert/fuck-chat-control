import { signMessage, verifyMessage } from "../crypto/identity";
import { decodePublicKey, encodePublicKey, encodeSignature } from "../protocol/codec";
import {
  CONVERSATION_ID_BYTES,
  DEFAULT_MAX_GROUP_MEMBERS,
  MAX_GROUP_MEMBERS_HARD,
  MAX_MEMBER_DISPLAY_NAME,
  PUBLIC_KEY_BYTES,
  SIGNATURE_BYTES,
} from "../protocol/limits";
import type { PublicKey, Signature } from "../protocol/types";

import { GroupError, GroupErrorCode } from "./errors";
import { encodeGroupId } from "./types";
import type { GroupId, GroupMember, GroupMembership } from "./types";

/**
 * Canonical binary codec for the `group_membership` control payload
 * (protocol-v2 §4.1):
 *
 *   groupId(16) ‖ epoch(u32 BE) ‖ memberCount(u8) ‖ memberEntry[] ‖ signature(64)
 *   memberEntry = identityPub(65) ‖ flags(1) ‖ displayNameLen(1) ‖ displayName(utf8)
 *
 * flags bit 0 = author; bits 1–7 are reserved and MUST be zero. `signature`
 * is IEEE P1363 (`r ‖ s`, 64 bytes) over ALL preceding payload bytes, made
 * with the author's identity private key. Decoding is validate-before-
 * allocate per protocol-v1 §12: `memberCount` is checked against the caller's
 * configured cap AND against the bytes that remain before any entry storage
 * is allocated, and every variable-length field is bounds-checked before it
 * is copied.
 */

const MEMBER_ENTRY_FIXED_BYTES = PUBLIC_KEY_BYTES + 1 + 1;
const MEMBERSHIP_HEADER_BYTES = CONVERSATION_ID_BYTES + 4 + 1;
const MEMBER_FLAG_AUTHOR = 0x01;
const MEMBER_FLAGS_RESERVED_MASK = 0xfe;
const UINT32_MAX = 0xffffffff;
const UINT8_MAX = 0xff;

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function writeUint32Be(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function readUint32Be(src: Uint8Array, offset: number): number {
  return (
    (src[offset] * 0x1000000 +
      (src[offset + 1] << 16) +
      (src[offset + 2] << 8) +
      src[offset + 3]) >>>
    0
  );
}

/**
 * Map/diff key for an identity public key: the raw bytes as a string. Shared
 * by the codec's duplicate detection and the group session's link↔member
 * indexing so both key members by the identical byte string.
 */
export function pubKeyId(pub: Uint8Array): string {
  let s = "";
  for (let i = 0; i < pub.length; i++) s += String.fromCharCode(pub[i]);
  return s;
}

function countAuthors(members: readonly GroupMember[]): number {
  let authors = 0;
  for (const m of members) {
    if (m.isAuthor) authors += 1;
  }
  return authors;
}

function memberDisplayNameBytes(displayName: string): Uint8Array {
  const bytes = utf8Encoder.encode(displayName);
  if (bytes.length > MAX_MEMBER_DISPLAY_NAME) {
    throw new GroupError(
      GroupErrorCode.Malformed,
      `member display name is ${bytes.length} bytes; cap is ${MAX_MEMBER_DISPLAY_NAME}`,
    );
  }
  return bytes;
}

/**
 * Encode the unsigned prefix of a `group_membership` payload — `groupId ‖
 * epoch ‖ memberCount ‖ memberEntry[]` — the exact byte range the author
 * signs (protocol-v2 §4.1). Enforces the canonical form on the way out:
 * exactly one author entry, every `identityPub` a valid uncompressed SEC1
 * point, no duplicate identities, every display name within
 * {@link MAX_MEMBER_DISPLAY_NAME} UTF-8 bytes, and `members.length` within
 * `maxMembers` (default {@link MAX_GROUP_MEMBERS_HARD}, the absolute ceiling).
 */
export function encodeMembershipBody(
  groupId: GroupId,
  epoch: number,
  members: readonly GroupMember[],
  maxMembers: number = MAX_GROUP_MEMBERS_HARD,
): Uint8Array {
  const gid = encodeGroupId(groupId);
  if (!Number.isInteger(epoch) || epoch < 0 || epoch > UINT32_MAX) {
    throw new GroupError(
      GroupErrorCode.Malformed,
      `membership epoch must be an unsigned uint32 integer, got ${epoch}`,
    );
  }
  if (members.length === 0 || members.length > UINT8_MAX) {
    throw new GroupError(
      GroupErrorCode.MembershipInvalid,
      `member count must be in 1..${UINT8_MAX}, got ${members.length}`,
    );
  }
  if (members.length > maxMembers) {
    throw new GroupError(
      GroupErrorCode.MemberLimitReached,
      `member count ${members.length} exceeds the configured cap ${maxMembers}`,
    );
  }
  if (countAuthors(members) !== 1) {
    throw new GroupError(
      GroupErrorCode.MembershipInvalid,
      "membership must carry exactly one author-flagged member entry",
    );
  }
  const entryBytes: Uint8Array[] = [];
  const seen = new Set<string>();
  let entriesLength = 0;
  for (const member of members) {
    const pub = encodePublicKey(member.identityPub);
    const key = pubKeyId(pub);
    if (seen.has(key)) {
      throw new GroupError(
        GroupErrorCode.MembershipInvalid,
        "membership contains a duplicate member identityPub",
      );
    }
    seen.add(key);
    const name = memberDisplayNameBytes(member.displayName);
    const entry = new Uint8Array(MEMBER_ENTRY_FIXED_BYTES + name.length);
    entry.set(pub, 0);
    entry[PUBLIC_KEY_BYTES] = member.isAuthor ? MEMBER_FLAG_AUTHOR : 0;
    entry[PUBLIC_KEY_BYTES + 1] = name.length;
    entry.set(name, PUBLIC_KEY_BYTES + 2);
    entryBytes.push(entry);
    entriesLength += entry.length;
  }
  const out = new Uint8Array(MEMBERSHIP_HEADER_BYTES + entriesLength);
  out.set(gid, 0);
  writeUint32Be(out, CONVERSATION_ID_BYTES, epoch);
  out[CONVERSATION_ID_BYTES + 4] = members.length;
  let offset = MEMBERSHIP_HEADER_BYTES;
  for (const entry of entryBytes) {
    out.set(entry, offset);
    offset += entry.length;
  }
  return out;
}

/**
 * Sign an unsigned membership body produced by {@link encodeMembershipBody}
 * with the author's identity private key, producing the 64-byte P1363
 * signature that trails the payload (protocol-v2 §4.1). Accepts the raw key
 * bytes (`IdentityKeyPair.privateKey`) so the identity's `sign` method —
 * which is bound to v1 transcripts — stays untouched.
 */
export async function signMembership(
  unsignedBytes: Uint8Array,
  privateKey: Uint8Array,
): Promise<Signature> {
  return signMessage(privateKey, unsignedBytes);
}

/**
 * Encode a complete `group_membership` payload: the canonical body plus the
 * 64-byte signature. Structural validation is the same as
 * {@link encodeMembershipBody}; `signature` must already be exactly
 * {@link SIGNATURE_BYTES} bytes.
 */
export function encodeMembership(membership: GroupMembership): Uint8Array {
  const signature = encodeSignature(membership.signature);
  const body = encodeMembershipBody(membership.groupId, membership.epoch, membership.members);
  const out = new Uint8Array(body.length + SIGNATURE_BYTES);
  out.set(body, 0);
  out.set(signature, body.length);
  return out;
}

/**
 * Decode and structurally validate a `group_membership` payload. Validates
 * `memberCount` against the caller-supplied `maxMembers` cap (default
 * {@link DEFAULT_MAX_GROUP_MEMBERS}) clamped to {@link MAX_GROUP_MEMBERS_HARD}
 * — a caller can only narrow the hard ceiling, never widen it — and the
 * remaining byte length BEFORE
 * allocating entry storage; enforces exactly one author-flagged entry, zero
 * reserved flag bits, valid SEC1 identity keys, no duplicate identities, a
 * `displayNameLen` within {@link MAX_MEMBER_DISPLAY_NAME} that matches the
 * bytes present, valid UTF-8 names, and an exact 64-byte signature trailer.
 *
 * Structural only: signature VERIFICATION is {@link verifyMembership}'s job.
 */
export function decodeMembership(
  payload: Uint8Array,
  maxMembers: number = DEFAULT_MAX_GROUP_MEMBERS,
): GroupMembership {
  // Clamp FIRST: a misconfigured or hostile caller passing a cap above the
  // hard ceiling must not decode an oversized member list.
  const cap = Math.min(maxMembers, MAX_GROUP_MEMBERS_HARD);
  if (payload.length < MEMBERSHIP_HEADER_BYTES + SIGNATURE_BYTES) {
    throw new GroupError(
      GroupErrorCode.Malformed,
      `membership payload too short: ${payload.length} bytes`,
    );
  }
  const groupId = encodeGroupId(payload.subarray(0, CONVERSATION_ID_BYTES));
  const epoch = readUint32Be(payload, CONVERSATION_ID_BYTES);
  const memberCount = payload[CONVERSATION_ID_BYTES + 4];
  if (memberCount > cap) {
    throw new GroupError(
      GroupErrorCode.MemberLimitReached,
      `member count ${memberCount} exceeds the configured cap ${cap}`,
    );
  }
  const entriesBytes = payload.length - MEMBERSHIP_HEADER_BYTES - SIGNATURE_BYTES;
  if (entriesBytes < memberCount * MEMBER_ENTRY_FIXED_BYTES) {
    throw new GroupError(
      GroupErrorCode.Malformed,
      `membership payload declares ${memberCount} entries but only ${entriesBytes} entry bytes remain`,
    );
  }
  const members: GroupMember[] = [];
  const seen = new Set<string>();
  let authorCount = 0;
  let offset = MEMBERSHIP_HEADER_BYTES;
  for (let i = 0; i < memberCount; i++) {
    if (payload.length - offset < MEMBER_ENTRY_FIXED_BYTES) {
      throw new GroupError(
        GroupErrorCode.Malformed,
        `member entry ${i} truncated: ${payload.length - offset} bytes remain`,
      );
    }
    let identityPub: PublicKey;
    try {
      identityPub = decodePublicKey(payload.subarray(offset, offset + PUBLIC_KEY_BYTES));
    } catch (err) {
      throw new GroupError(
        GroupErrorCode.Malformed,
        `member entry ${i} carries an invalid identity public key`,
        err,
      );
    }
    offset += PUBLIC_KEY_BYTES;
    const flags = payload[offset];
    offset += 1;
    if ((flags & MEMBER_FLAGS_RESERVED_MASK) !== 0) {
      throw new GroupError(
        GroupErrorCode.Malformed,
        `member entry ${i} sets reserved flag bits 0x${(flags & MEMBER_FLAGS_RESERVED_MASK)
          .toString(16)
          .padStart(2, "0")}`,
      );
    }
    const displayNameLen = payload[offset];
    offset += 1;
    if (displayNameLen > MAX_MEMBER_DISPLAY_NAME) {
      throw new GroupError(
        GroupErrorCode.Malformed,
        `member entry ${i} display name length ${displayNameLen} exceeds cap ${MAX_MEMBER_DISPLAY_NAME}`,
      );
    }
    if (payload.length - offset < displayNameLen + SIGNATURE_BYTES) {
      throw new GroupError(
        GroupErrorCode.Malformed,
        `member entry ${i} display name truncated: ${displayNameLen} bytes declared`,
      );
    }
    let displayName: string;
    try {
      displayName = utf8Decoder.decode(payload.subarray(offset, offset + displayNameLen));
    } catch (err) {
      throw new GroupError(
        GroupErrorCode.Malformed,
        `member entry ${i} display name is not valid UTF-8`,
        err,
      );
    }
    offset += displayNameLen;
    const isAuthor = (flags & MEMBER_FLAG_AUTHOR) !== 0;
    if (isAuthor) authorCount += 1;
    const key = pubKeyId(identityPub);
    if (seen.has(key)) {
      throw new GroupError(
        GroupErrorCode.MembershipInvalid,
        `member entry ${i} duplicates an earlier identityPub`,
      );
    }
    seen.add(key);
    members.push({ identityPub, isAuthor, displayName });
  }
  if (payload.length - offset !== SIGNATURE_BYTES) {
    throw new GroupError(
      GroupErrorCode.Malformed,
      `membership payload has ${payload.length - offset} trailing bytes; signature must be exactly ${SIGNATURE_BYTES}`,
    );
  }
  if (authorCount !== 1) {
    throw new GroupError(
      GroupErrorCode.MembershipInvalid,
      `membership must carry exactly one author-flagged entry, got ${authorCount}`,
    );
  }
  const signature = encodeSignature(payload.subarray(offset, offset + SIGNATURE_BYTES));
  return { groupId, epoch, members, signature };
}

/**
 * Verify a decoded membership's signature against the member entry flagged
 * as author (protocol-v2 §4.1). The signed byte range is the canonical
 * re-encoding of `groupId ‖ epoch ‖ memberCount ‖ memberEntry[]` — identical
 * to the wire prefix because {@link decodeMembership} rejects every
 * non-canonical input. Returns `false` for a signature that fails to verify
 * or a list without exactly one author entry; a list that fails verification
 * MUST be discarded entirely.
 */
export async function verifyMembership(membership: GroupMembership): Promise<boolean> {
  const authors = membership.members.filter((m) => m.isAuthor);
  if (authors.length !== 1) {
    return false;
  }
  const body = encodeMembershipBody(membership.groupId, membership.epoch, membership.members);
  return verifyMessage(authors[0].identityPub, membership.signature, body);
}

/** Members present in `next` whose identityPub was not in `prev` (§4.2). */
export function addedMembers(
  prev: readonly GroupMember[],
  next: readonly GroupMember[],
): GroupMember[] {
  const prevKeys = new Set(prev.map((m) => pubKeyId(m.identityPub)));
  return next.filter((m) => !prevKeys.has(pubKeyId(m.identityPub)));
}

/** Members present in `prev` whose identityPub is absent from `next` (§4.2). */
export function removedMembers(
  prev: readonly GroupMember[],
  next: readonly GroupMember[],
): GroupMember[] {
  const nextKeys = new Set(next.map((m) => pubKeyId(m.identityPub)));
  return prev.filter((m) => !nextKeys.has(pubKeyId(m.identityPub)));
}
