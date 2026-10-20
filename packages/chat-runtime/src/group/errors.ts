/**
 * Group-conversation error codes (docs/architecture/protocol-v2-group.md).
 * `Malformed` covers structural codec failures (truncated payloads, bad
 * lengths, reserved flag bits set); `MembershipInvalid` covers a decoded list
 * that violates the membership invariants (author-flag count ≠ 1, duplicate
 * identities, an author key that differs from the pinned group author, or a
 * signature that fails to verify — the latter two are surfaced by the caller
 * of `verifyMembership`, not the codec). The session-level codes
 * (`NotAuthor`, `EpochRegression`, `MemberLimitReached`,
 * `UnknownLinkIdentity`, `NoEstablishedLink`) are raised by the group
 * session/orchestration layer; `MemberLimitReached` is also the decode-time
 * code for a `memberCount` above the configured cap, matching the spec's
 * seat-cap semantics. `NoEstablishedLink` is the caller-facing code for
 * addressing a `peerId` that has no live link — distinct from
 * `UnknownLinkIdentity`, which describes a connected link whose authenticated
 * peer is not a member. `GroupNotFound` is the controller-facing code for
 * addressing a group id that has no live session — the runtime analogue of
 * the store-level `StoreErrorCode.GroupNotFound` (missing group record).
 */
export const GroupErrorCode = {
  Malformed: "Malformed",
  NotAuthor: "NotAuthor",
  EpochRegression: "EpochRegression",
  MemberLimitReached: "MemberLimitReached",
  UnknownLinkIdentity: "UnknownLinkIdentity",
  MembershipInvalid: "MembershipInvalid",
  NoEstablishedLink: "NoEstablishedLink",
  GroupNotFound: "GroupNotFound",
} as const;

export type GroupErrorCode = (typeof GroupErrorCode)[keyof typeof GroupErrorCode];

export class GroupError extends Error {
  readonly code: GroupErrorCode;
  readonly cause?: unknown;

  constructor(code: GroupErrorCode, message: string, cause?: unknown) {
    super(`${code}: ${message}`);
    this.name = "GroupError";
    this.code = code;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}
