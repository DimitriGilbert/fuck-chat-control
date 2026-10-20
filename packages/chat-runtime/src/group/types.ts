import { CONVERSATION_ID_BYTES } from "../protocol/limits";
import type { Brand, PublicKey, Signature } from "../protocol/types";

import { GroupError, GroupErrorCode } from "./errors";

/**
 * Group identifier (protocol-v2 §1): 16 CSPRNG bytes minted by the author,
 * exactly like a v1 conversation ID. It IS the broker room ID and rides the
 * invitation URL fragment in the same `<hex>` slot a pair conversation ID
 * occupies (§8) — pair vs group is decided by which join flow the client
 * runs, not by the id bytes.
 */
export type GroupId = Brand<Uint8Array, "GroupId">;

/**
 * Ephemeral signaling label (protocol-v2 §1): 8 client-chosen bytes rendered
 * and validated as exactly 16 lowercase hex chars. Addresses a seated socket
 * inside a group broker room. NOT a cryptographic identity — the identity
 * public key is; a peerId is never trusted for authentication.
 */
export type PeerId = Brand<string, "PeerId">;

const PEER_ID_HEX_LENGTH = 16;
const PEER_ID_PATTERN = /^[0-9a-f]{16}$/;

/**
 * Validate-and-brand a 16-byte group id. Mirrors the codec's
 * `encodeConversationId` contract: exact length, defensive copy so later
 * mutation of the caller's buffer cannot corrupt the id.
 */
export function encodeGroupId(input: Uint8Array): GroupId {
  if (input.length !== CONVERSATION_ID_BYTES) {
    throw new GroupError(
      GroupErrorCode.Malformed,
      `group id must be exactly ${CONVERSATION_ID_BYTES} bytes, got ${input.length}`,
    );
  }
  const copy = new Uint8Array(CONVERSATION_ID_BYTES);
  copy.set(input);
  return copy as unknown as GroupId;
}

/**
 * Validate-and-brand a peerId (protocol-v2 §2.1): exactly 16 lowercase hex
 * chars. Anything else is malformed — the broker applies the identical
 * `^[0-9a-f]{16}$` rule to `peerId` join/addressing fields.
 */
export function encodePeerId(input: string): PeerId {
  if (input.length !== PEER_ID_HEX_LENGTH || !PEER_ID_PATTERN.test(input)) {
    throw new GroupError(
      GroupErrorCode.Malformed,
      "peer id must be exactly 16 lowercase hex characters [0-9a-f]",
    );
  }
  return input as PeerId;
}

/**
 * One row of the `group_membership` member list (protocol-v2 §4.1):
 * an identity public key plus the author flag and display name. The wire
 * flags byte reserves bits 1–7 (must be zero); only bit 0 (author) is modeled
 * here so no reserved bit can be minted through this type.
 */
export interface GroupMember {
  /** 65-byte uncompressed SEC1 P-256 identity public key. */
  readonly identityPub: PublicKey;
  /** flags bit 0: the group creator's entry — the sole admin / list signer. */
  readonly isAuthor: boolean;
  /** UTF-8 display name, byte length `0..MAX_MEMBER_DISPLAY_NAME`. */
  readonly displayName: string;
}

/**
 * A decoded `group_membership` payload (protocol-v2 §4.1): the author-signed,
 * epoch-numbered canonical member list. `signature` is the IEEE P1363
 * (`r ‖ s`, 64-byte) ECDSA signature over the encoded `groupId ‖ epoch ‖
 * memberCount ‖ memberEntry[]` prefix, verifiable against the member entry
 * flagged `isAuthor`.
 */
export interface GroupMembership {
  readonly groupId: GroupId;
  /** uint32 BE list version; strictly increasing within a group. */
  readonly epoch: number;
  readonly members: readonly GroupMember[];
  readonly signature: Signature;
}
