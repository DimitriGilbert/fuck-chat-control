import type { AtRestKey } from "../crypto/types";
import type { GroupId, GroupMember } from "../group/types";
import type { ConversationId, PublicKey } from "../protocol/types";

export const MessageDirection = {
  Sent: "sent",
  Received: "received",
} as const;
export type MessageDirection = (typeof MessageDirection)[keyof typeof MessageDirection];

export const MESSAGE_DIRECTION_VALUES: readonly MessageDirection[] = [
  MessageDirection.Sent,
  MessageDirection.Received,
];

export interface ConversationMessage {
  readonly id: string;
  readonly conversationId: ConversationId;
  readonly direction: MessageDirection;
  readonly timestamp: number;
  readonly text: string;
}

export interface PeerIdentityRecord {
  readonly fingerprint: string;
  readonly publicKey: PublicKey;
}

export interface ConversationRecord {
  readonly id: ConversationId;
  readonly createdAt: number;
  readonly displayName: string | null;
  readonly peer: PeerIdentityRecord | null;
  /**
   * Durable auth-failed flag (R7/F3). Set by the orchestrator's failHandshake
   * when the failure was an identity-change or a PAKE failure; cleared only by
   * creating a fresh conversation (a new invitation). When true, retry() on the
   * same conversation is rejected with {@link AuthFailedRetryBlocked}.
   */
  readonly authFailed: boolean;
  /** Epoch-ms when {@link authFailed} was last set; null when never set. */
  readonly authFailedAt: number | null;
}

export interface IdentityConflict {
  readonly conversationId: ConversationId;
  readonly existing: PeerIdentityRecord;
  readonly incoming: PeerIdentityRecord;
}

/**
 * A group conversation's durable record (protocol-v2-group). Groups are
 * RUNTIME-ONLY state: the broker room ceases to exist when empty, so a group
 * record cannot outlive participation — there is no "resume group" flow, and
 * membership is re-derived from the author's signed list on rejoin. That is
 * why the export-bundle format stays v1 (no group rows): nothing here is
 * meaningful to a device that is not seated in the room.
 *
 * What the record IS for: it lets the host/controller (a) keep the group's
 * local display-name label, and (b) recognize the group-scoped id namespace
 * and the DERIVED pairwise conversation ids ({@link derivePairwiseConvId})
 * the group's per-link orchestrators resolve internally, so rows written by
 * earlier builds (or re-imported from a bundle) stay out of the sidebar's
 * resumable-conversation list. The current build persists no such rows —
 * link orchestrators run on a non-persisting repository decorator and the
 * group transcript is in-memory — so this masking is defense-in-depth.
 *
 * `authorIdentityPub` is the group author's identity key — the sole list
 * signer. A joiner does not know it until it adopts its first signed list, so
 * it is `null` until then; {@link ConversationRepository.updateGroupMembership}
 * populates it from the member entry flagged `isAuthor`.
 */
export interface GroupRecord {
  /** The 16-byte group id (= the broker room id, protocol-v2 §1). */
  readonly groupId: GroupId;
  /** Latest known membership epoch (0 until a non-author adopts a list). */
  readonly epoch: number;
  /** The group author's identity public key; null while unknown to a joiner. */
  readonly authorIdentityPub: PublicKey | null;
  /** Latest known canonical member list (empty for a pre-list joiner). */
  readonly members: readonly GroupMember[];
  /** Local label for the sidebar; null when the user never named the group. */
  readonly displayName: string | null;
  /** Epoch-ms when the record was created locally. */
  readonly createdAt: number;
}

export interface ImportResult {
  readonly conversationsAdded: number;
  readonly conversationsMerged: number;
  readonly messagesImported: number;
  readonly conflicts: readonly IdentityConflict[];
  readonly deviceIdentity: Uint8Array | null;
}

export const StoreErrorCode = {
  ConversationNotFound: "conversation_not_found",
  WrongPassphrase: "wrong_passphrase",
  MalformedBundle: "malformed_bundle",
  UnsupportedBundleVersion: "unsupported_bundle_version",
  NotInitialized: "not_initialized",
  NotImplemented: "not_implemented",
  /**
   * RAII guard for the storePeerIdentity primitive (R8/F1): the conversation
   * already has a pinned peer identity and the incoming key differs. Callers
   * that intentionally replace the peer (e.g. the Replace-mode import path
   * after clearAll) use {@link ConversationRepository.replacePeerIdentity}.
   */
  PeerIdentityAlreadyPinned: "peer_identity_already_pinned",
  /**
   * Pre-auth size bound hit (R8/F3). Thrown when a bundle envelope or payload
   * exceeds the caps defined in {@link ./limits.ts} BEFORE the AEAD tag is
   * verified, so a hostile bundle cannot wedge the device in a pre-auth
   * memory blow-up.
   */
  SizeLimitExceeded: "size_limit_exceeded",
  /**
   * Argon2id KDF envelope parameters out of range (R8/F4). Thrown when the
   * bundle envelope's m/t/p/version values fall outside the allowed ranges
   * (see {@link ./limits.ts}) on the import path.
   */
  InvalidKdfParams: "invalid_kdf_params",
  /**
   * A group-store call named a group id with no stored record. Mirrors the
   * {@link ConversationNotFound} contract for the group store.
   */
  GroupNotFound: "group_not_found",
} as const;

export type StoreErrorCode = (typeof StoreErrorCode)[keyof typeof StoreErrorCode];

export class StoreError extends Error {
  readonly code: StoreErrorCode;

  constructor(code: StoreErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "StoreError";
    this.code = code;
  }
}

/**
 * R7/F3: thrown by retry() when the conversation has a durable auth-failed
 * flag set. Per the PRD TOFU clause, recovery requires a fresh invitation — a
 * retry on the same conversation must not re-attempt the handshake. Mirrors
 * the typed-error precedent of {@link StoreError} / {@link PakeError}.
 */
export class AuthFailedRetryBlocked extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthFailedRetryBlocked";
  }
}

export interface SerializedState {
  readonly conversations: readonly SerializedConversation[];
  readonly messages: readonly SerializedConversationMessages[];
}

export interface SerializedConversation {
  readonly id: string;
  readonly createdAt: number;
  readonly displayName: string | null;
  readonly peer: SerializedPeerIdentity | null;
  /**
   * Durable auth-failed flag (R7/F3), mirrored from
   * {@link ConversationRecord.authFailed}. Older bundles that predate the field
   * are treated as `false` on load (see {@link InMemoryConversationRepository.reload}).
   */
  readonly authFailed?: boolean;
  readonly authFailedAt?: number | null;
}

export interface SerializedPeerIdentity {
  readonly fingerprint: string;
  readonly publicKey: string;
}

export interface SerializedConversationMessages {
  readonly conversationId: string;
  readonly messages: readonly SerializedMessage[];
}

export interface SerializedMessage {
  readonly id: string;
  readonly direction: MessageDirection;
  readonly timestamp: number;
  readonly nonce: string;
  readonly ciphertext: string;
}

export interface RawStoredMessage {
  readonly id: string;
  readonly direction: MessageDirection;
  readonly timestamp: number;
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
}

/**
 * R4/F1: optional overrides for {@link ConversationRepository.appendMessage}.
 * Purely additive — every pre-existing caller omits the whole object and gets
 * the unchanged default behavior.
 */
export interface AppendMessageOptions {
  /**
   * Store the message under this id VERBATIM instead of generating a fresh
   * UUID. Used by the bundle import/merge path so an imported message keeps
   * its exporting device's id — that is what makes `existingIds.has(id)`
   * dedup effective and re-importing an overlapping bundle idempotent across
   * devices. Must be a non-empty string when provided (implementations
   * reject anything else); when absent, a fresh id is generated exactly as
   * before this option existed.
   */
  readonly id?: string;
}

export interface ConversationRepository {
  createConversation(id: ConversationId, createdAt: number): Promise<ConversationRecord>;
  getConversation(id: ConversationId): Promise<ConversationRecord | null>;
  listConversations(): Promise<ConversationRecord[]>;
  appendMessage(
    id: ConversationId,
    plaintext: string,
    direction: MessageDirection,
    timestamp: number,
    options?: AppendMessageOptions,
  ): Promise<ConversationMessage>;
  getMessages(id: ConversationId): Promise<ConversationMessage[]>;
  /**
   * R8/F6: list the stored message ids for a conversation WITHOUT decrypting
   * the rows — message ids are stored as cleartext columns/keys in every
   * repo, so this never touches the at-rest key. The merge-import path dedups
   * incoming bundle message ids against this seam: reading ids only keeps a
   * single corrupt ciphertext row from aborting the scan (getMessages would
   * surface it as WrongPassphrase on the in-memory repo, or silently omit
   * the id on the browser repo and let a later insert collide as a raw
   * DuplicateKeyError). Same {@link StoreErrorCode.ConversationNotFound}
   * contract as {@link getMessages}.
   */
  listMessageIds(id: ConversationId): Promise<string[]>;
  storePeerIdentity(id: ConversationId, fingerprint: string, publicKey: PublicKey): Promise<void>;
  /**
   * Replace the peer identity even if one is already pinned. Used only by the
   * Replace-mode import path (which runs after {@link clearAll} and is
   * repopulating from a trusted bundle). All other callers must go through
   * {@link storePeerIdentity}, which now refuses to overwrite a pinned key.
   */
  replacePeerIdentity(id: ConversationId, fingerprint: string, publicKey: PublicKey): Promise<void>;
  getPeerIdentity(id: ConversationId): Promise<PeerIdentityRecord | null>;
  setDisplayName(id: ConversationId, name: string): Promise<void>;
  getDisplayName(id: ConversationId): Promise<string | null>;
  /**
   * Durably mark the conversation as auth-failed (R7/F3). Idempotent; once set
   * the flag is only cleared by creating a fresh conversation. Records the
   * epoch-ms timestamp of the failure on {@link ConversationRecord.authFailedAt}.
   */
  markAuthFailed(id: ConversationId): Promise<void>;
  /**
   * True iff the conversation's durable auth-failed flag is set. The
   * orchestrator gates {@link retry} on this; the UI surfaces it via the
   * session snapshot so the user sees an explicit "create a fresh invitation"
   * call-to-action instead of a retry affordance.
   */
  getAuthFailed(id: ConversationId): Promise<boolean>;
  clearConversation(id: ConversationId): Promise<void>;
  clearAll(): Promise<void>;

  // --- Group records (protocol-v2-group; runtime-only, see {@link GroupRecord}) ---

  /**
   * Create-or-replace a group record. Re-storing an existing group id keeps
   * the original `createdAt` and overwrites the rest (a rejoin refreshes the
   * record to the same effect). Members and key material are defensively
   * copied so later mutation of the caller's buffers cannot corrupt the row.
   */
  storeGroup(record: GroupRecord): Promise<GroupRecord>;
  /** The stored record for `groupId`, or null when none exists. */
  getGroup(groupId: GroupId): Promise<GroupRecord | null>;
  /**
   * Land the latest canonical member list on the record: sets `epoch` and
   * `members`, and (re)populates `authorIdentityPub` from the member entry
   * flagged `isAuthor` when one is present. Throws
   * {@link StoreErrorCode.GroupNotFound} for an unknown group id.
   */
  updateGroupMembership(
    groupId: GroupId,
    epoch: number,
    members: readonly GroupMember[],
  ): Promise<GroupRecord>;
  /** The group's local label; null clears it. Unknown id → GroupNotFound. */
  setGroupDisplayName(groupId: GroupId, name: string | null): Promise<void>;
  /** Drop a group record entirely (e.g. clearAll); unknown ids are a no-op. */
  removeGroup(groupId: GroupId): Promise<void>;
  /** Every stored group record, ordered by createdAt then group-id hex. */
  listGroups(): Promise<GroupRecord[]>;
  /**
   * Release any backing resources the repository holds open (e.g. an OPFS
   * SQLite database / Web Worker). Optional so in-memory and test fakes need
   * not implement it; callers feature-check before invoking. Idempotent when
   * implemented: a second call is a no-op. The {@link ChatController}'s
   * dispose() invokes this so the web provider's unmount releases OPFS
   * handles without each provider knowing the store's internals.
   */
  close?(): Promise<void> | void;
}

export interface PersistableConversationRepository extends ConversationRepository {
  serialize(): SerializedState;
}

export interface ReloadableConversationRepository extends PersistableConversationRepository {
  reload(atRestKey: AtRestKey, state: SerializedState): Promise<void>;
  /**
   * CR-7: defense-in-depth zeroize the inner at-rest key reference. Called by
   * the {@link LockableRepository} wrapper when the manager transitions to
   * locked, so an attacker who reads the JS heap while locked cannot recover
   * the live key from the inner repo's state. Optional on the interface so
   * future repository implementations can opt out (the wrapper feature-checks
   * before calling). See {@link InMemoryConversationRepository.zeroizeAtRestKey}.
   */
  zeroizeAtRestKey?(): void;
  /**
   * CR-7: repopulate the inner at-rest key after a successful unlock. Pairs
   * with {@link zeroizeAtRestKey}: the wrapper calls this from its `onUnlock`
   * listener so the inner repo resumes operation after the manager's key has
   * been repopulated. Optional for the same feature-check reason as
   * {@link zeroizeAtRestKey}.
   */
  resetAtRestKey?(key: AtRestKey): void;
}
