import { decryptAtRest, encryptAtRest } from "../crypto/at-rest";
import { ctEqual } from "../crypto/ct-equal";
import { CryptoError, CryptoErrorCode } from "../crypto/errors";
import type { AtRestKey } from "../crypto/types";
import { encodeGroupId } from "../group/types";
import type { GroupId, GroupMember } from "../group/types";
import { encodeConversationId, encodePublicKey } from "../protocol/codec";
import { CONVERSATION_ID_BYTES, PUBLIC_KEY_BYTES } from "../protocol/limits";
import type { ConversationId, PublicKey } from "../protocol/types";

import { bytesToBase64, bytesToHex, base64ToBytes, hexToBytes } from "./encoding";
import { messageRecordAad } from "./message-record-aad";
import { MessageDirection, MESSAGE_DIRECTION_VALUES, StoreError, StoreErrorCode } from "./types";
import type {
  AppendMessageOptions,
  ConversationMessage,
  ConversationRecord,
  GroupRecord,
  PeerIdentityRecord,
  RawStoredMessage,
  ReloadableConversationRepository,
  SerializedConversation,
  SerializedConversationMessages,
  SerializedMessage,
  SerializedPeerIdentity,
  SerializedState,
} from "./types";

interface InternalConversation {
  createdAt: number;
  displayName: string | null;
  peer: PeerIdentityRecord | null;
  authFailed: boolean;
  authFailedAt: number | null;
}

interface InternalMessage {
  id: string;
  direction: MessageDirection;
  timestamp: number;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

/** Mutable stored form of {@link GroupRecord}; members are stored cloned. */
interface InternalGroup {
  epoch: number;
  authorIdentityPub: PublicKey | null;
  members: GroupMember[];
  displayName: string | null;
  createdAt: number;
}

export class InMemoryConversationRepository implements ReloadableConversationRepository {
  private readonly conversations = new Map<string, InternalConversation>();
  private readonly messages = new Map<string, InternalMessage[]>();
  private readonly keyById = new Map<string, ConversationId>();
  /**
   * Group records (protocol-v2), keyed by group-id hex. Runtime-only state —
   * deliberately NOT part of {@link serialize}/{@link reload} (the export
   * bundle stays v1): group rooms cease when empty and membership is
   * re-derived from the author's signed list on rejoin.
   */
  private readonly groups = new Map<string, InternalGroup>();
  private readonly groupIdByKey = new Map<string, GroupId>();
  private atRestKey: AtRestKey | null;

  constructor(atRestKey: AtRestKey) {
    this.atRestKey = atRestKey;
  }

  private requireKey(): AtRestKey {
    if (this.atRestKey === null) {
      throw new StoreError(
        StoreErrorCode.NotInitialized,
        "repository has no at-rest key; reload with a valid key before use",
      );
    }
    return this.atRestKey;
  }

  /**
   * CR-7: defense-in-depth zeroize the inner at-rest key when the
   * {@link LockableRepository} wrapper observes a lock transition. Overwrites
   * the key bytes with zeros and drops the reference, so an attacker who gains
   * heap-read access while the manager is locked cannot recover the live key
   * from this repository's state.
   *
   * THE FUNCTIONAL LOCK IS ELSEWHERE: {@link LockableRepository.assertUnlocked}
   * throws {@link AtRestLockedError} on every ciphertext-touching call while
   * the manager reports locked. This method is defense-in-depth for the
   * "attacker reads the JS heap while locked" threat model — even if the gate
   * is bypassed, there is no key in this object to read.
   *
   * PAIR WITH {@link resetAtRestKey}: the wrapper's `onUnlock` listener calls
   * {@link resetAtRestKey} with the manager's repopulated key so the inner
   * repo resumes operation after unlock. This keeps CR-7's defense-in-depth
   * (key bytes wiped while locked) WITHOUT regressing the post-unlock path:
   * the inner key is null only between lock and the next successful unlock.
   */
  zeroizeAtRestKey(): void {
    if (this.atRestKey !== null) {
      this.atRestKey.fill(0);
      this.atRestKey = null;
    }
  }

  /**
   * CR-7: repopulate the inner at-rest key after a successful unlock. Called
   * by the {@link LockableRepository} wrapper's `onUnlock` listener so the
   * inner repo (whose key was {@link zeroizeAtRestKey}'d on lock) resumes
   * normal operation. The {@link key} argument comes from
   * {@link AtRestKeyManager.get}, which has already repopulated its own
   * reference from storage (auto mode) or unwrapped it from the passphrase
   * KEK (passphrase mode).
   */
  resetAtRestKey(key: AtRestKey): void {
    this.atRestKey = key;
  }

  /**
   * Test seam for CR-7: returns true iff {@link zeroizeAtRestKey} has run and
   * the inner reference has been dropped. Used by the zeroize test to assert
   * the post-lock state without exposing the key itself.
   */
  _atRestKeyIsZeroizedForTest(): boolean {
    return this.atRestKey === null;
  }

  async createConversation(id: ConversationId, createdAt: number): Promise<ConversationRecord> {
    const key = idKey(id);
    if (!this.conversations.has(key)) {
      this.conversations.set(key, {
        createdAt,
        displayName: null,
        peer: null,
        authFailed: false,
        authFailedAt: null,
      });
      this.keyById.set(key, cloneConversationId(id));
      this.messages.set(key, []);
    }
    const internal = this.conversations.get(key) as InternalConversation;
    return toRecord(id, internal);
  }

  async getConversation(id: ConversationId): Promise<ConversationRecord | null> {
    const key = idKey(id);
    const internal = this.conversations.get(key);
    if (internal === undefined) return null;
    return toRecord(id, internal);
  }

  async listConversations(): Promise<ConversationRecord[]> {
    const records: ConversationRecord[] = [];
    for (const [key, internal] of this.conversations) {
      const id = this.keyById.get(key);
      if (id === undefined) continue;
      records.push(toRecord(id, internal));
    }
    records.sort((a, b) => a.createdAt - b.createdAt || idKeyCompare(a.id, b.id));
    return records;
  }

  async appendMessage(
    id: ConversationId,
    plaintext: string,
    direction: MessageDirection,
    timestamp: number,
    options?: AppendMessageOptions,
  ): Promise<ConversationMessage> {
    const convoKey = idKey(id);
    if (!this.conversations.has(convoKey)) {
      throw new StoreError(
        StoreErrorCode.ConversationNotFound,
        "cannot append a message to a conversation that does not exist",
      );
    }
    // R4/F1: resolve the stored id BEFORE sealing so an invalid explicit id is
    // rejected without wasted crypto. Absent option → fresh UUID (unchanged).
    const messageId = messageIdFromOptions(options);
    const atRestKey = this.requireKey();
    const encoded = new TextEncoder().encode(plaintext);
    // R1:F2: bind the sealed body to this row's conversation + direction via
    // GCM AAD, so a stored (nonce, ciphertext) pair cannot be relocated to
    // another conversation or relabeled without failing authentication. Rows
    // sealed before the binding still decrypt via decryptAtRest's legacy
    // empty-AAD fallback.
    const sealed = await encryptAtRest(atRestKey, encoded, messageRecordAad(id, direction));
    // R9/F3: the encrypt await parked this coroutine — a concurrent
    // clearConversation/clearAll may have committed meanwhile. Re-check
    // before writing so the row cannot persist as an orphan under a
    // conversation key that no longer exists (serialize would then emit a
    // message group for an unknown conversation and reload would reject it).
    if (!this.conversations.has(convoKey)) {
      throw new StoreError(
        StoreErrorCode.ConversationNotFound,
        "conversation was deleted while the message was being encrypted",
      );
    }
    const list = this.messages.get(convoKey) ?? [];
    list.push({
      id: messageId,
      direction,
      timestamp,
      nonce: sealed.nonce,
      ciphertext: sealed.ciphertext,
    });
    this.messages.set(convoKey, list);
    return {
      id: messageId,
      conversationId: cloneConversationId(id),
      direction,
      timestamp,
      text: plaintext,
    };
  }

  async getMessages(id: ConversationId): Promise<ConversationMessage[]> {
    const convoKey = idKey(id);
    if (!this.conversations.has(convoKey)) {
      throw new StoreError(
        StoreErrorCode.ConversationNotFound,
        "cannot read messages for a conversation that does not exist",
      );
    }
    const atRestKey = this.requireKey();
    const list = this.messages.get(convoKey) ?? [];
    const out: ConversationMessage[] = [];
    for (let index = 0; index < list.length; index++) {
      const stored = list[index];
      const plaintext = await decryptMessage(atRestKey, id, stored);
      out.push({
        id: stored.id,
        conversationId: cloneConversationId(id),
        direction: stored.direction,
        timestamp: stored.timestamp,
        text: plaintext,
      });
    }
    out.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
    return out;
  }

  async listMessageIds(id: ConversationId): Promise<string[]> {
    const convoKey = idKey(id);
    if (!this.conversations.has(convoKey)) {
      throw new StoreError(
        StoreErrorCode.ConversationNotFound,
        "cannot list message ids for a conversation that does not exist",
      );
    }
    // R8/F6: ids live in cleartext alongside the sealed rows — no at-rest
    // decrypt, so a corrupt row's id is still visible to import dedup.
    return (await this._unsafeGetRawMessages(id)).map((m) => m.id);
  }

  async storePeerIdentity(
    id: ConversationId,
    fingerprint: string,
    publicKey: PublicKey,
  ): Promise<void> {
    const convoKey = idKey(id);
    const internal = this.conversations.get(convoKey);
    if (internal === undefined) {
      throw new StoreError(
        StoreErrorCode.ConversationNotFound,
        "cannot store peer identity for a conversation that does not exist",
      );
    }
    // R8/F1: TOFU guard. Once a peer key is pinned, a caller that arrives with
    // a DIFFERENT key must not silently overwrite it. Callers that intentionally
    // replace the peer (the Replace-mode import path after clearAll) go through
    // replacePeerIdentity. Re-pinning the SAME key is a no-op (safe).
    if (internal.peer !== null) {
      const sameKey = ctEqual(internal.peer.publicKey, publicKey);
      if (!sameKey) {
        throw new StoreError(
          StoreErrorCode.PeerIdentityAlreadyPinned,
          "peer identity already pinned for this conversation; refusing to overwrite " +
            "with a different key (TOFU). Use replacePeerIdentity for the trusted " +
            "Replace-mode import path.",
        );
      }
      // Same key re-pinned: refresh the fingerprint in case the caller's copy
      // has an updated annotation, then no-op.
      internal.peer = { fingerprint, publicKey: clonePublicKey(publicKey) };
      return;
    }
    internal.peer = { fingerprint, publicKey: clonePublicKey(publicKey) };
  }

  async replacePeerIdentity(
    id: ConversationId,
    fingerprint: string,
    publicKey: PublicKey,
  ): Promise<void> {
    const convoKey = idKey(id);
    const internal = this.conversations.get(convoKey);
    if (internal === undefined) {
      throw new StoreError(
        StoreErrorCode.ConversationNotFound,
        "cannot replace peer identity for a conversation that does not exist",
      );
    }
    // Intentional overwrite. Used by the Replace-mode import path after
    // clearAll, where the incoming bundle is the source of truth.
    internal.peer = { fingerprint, publicKey: clonePublicKey(publicKey) };
  }

  async getPeerIdentity(id: ConversationId): Promise<PeerIdentityRecord | null> {
    const convoKey = idKey(id);
    const internal = this.conversations.get(convoKey);
    if (internal === undefined || internal.peer === null) return null;
    return {
      fingerprint: internal.peer.fingerprint,
      publicKey: clonePublicKey(internal.peer.publicKey),
    };
  }

  async setDisplayName(id: ConversationId, name: string): Promise<void> {
    const convoKey = idKey(id);
    const internal = this.conversations.get(convoKey);
    if (internal === undefined) {
      throw new StoreError(
        StoreErrorCode.ConversationNotFound,
        "cannot set a display name for a conversation that does not exist",
      );
    }
    internal.displayName = name;
  }

  async getDisplayName(id: ConversationId): Promise<string | null> {
    const convoKey = idKey(id);
    const internal = this.conversations.get(convoKey);
    if (internal === undefined) return null;
    return internal.displayName;
  }

  async markAuthFailed(id: ConversationId): Promise<void> {
    const convoKey = idKey(id);
    const internal = this.conversations.get(convoKey);
    if (internal === undefined) {
      throw new StoreError(
        StoreErrorCode.ConversationNotFound,
        "cannot mark auth-failed for a conversation that does not exist",
      );
    }
    // Idempotent: refresh the timestamp so the most recent failure is recorded.
    internal.authFailed = true;
    internal.authFailedAt = Date.now();
  }

  async getAuthFailed(id: ConversationId): Promise<boolean> {
    const convoKey = idKey(id);
    const internal = this.conversations.get(convoKey);
    if (internal === undefined) return false;
    return internal.authFailed;
  }

  async clearConversation(id: ConversationId): Promise<void> {
    const convoKey = idKey(id);
    this.conversations.delete(convoKey);
    this.messages.delete(convoKey);
    this.keyById.delete(convoKey);
  }

  async clearAll(): Promise<void> {
    this.conversations.clear();
    this.messages.clear();
    this.keyById.clear();
    this.groups.clear();
    this.groupIdByKey.clear();
  }

  // --- Group records (runtime-only; not serialized — see {@link GroupRecord}) ---

  async storeGroup(record: GroupRecord): Promise<GroupRecord> {
    const key = groupKey(record.groupId);
    const existing = this.groups.get(key);
    // Create-or-replace: a rejoin of the same group id keeps the original
    // createdAt and overwrites the membership/epoch/label fields.
    const internal: InternalGroup = {
      epoch: record.epoch,
      authorIdentityPub:
        record.authorIdentityPub === null ? null : clonePublicKey(record.authorIdentityPub),
      members: cloneGroupMembers(record.members),
      displayName: record.displayName,
      createdAt: existing?.createdAt ?? record.createdAt,
    };
    this.groups.set(key, internal);
    if (!this.groupIdByKey.has(key)) {
      this.groupIdByKey.set(key, encodeGroupId(record.groupId));
    }
    return toGroupRecord(encodeGroupId(record.groupId), internal);
  }

  async getGroup(groupId: GroupId): Promise<GroupRecord | null> {
    const internal = this.groups.get(groupKey(groupId));
    if (internal === undefined) return null;
    return toGroupRecord(encodeGroupId(groupId), internal);
  }

  async updateGroupMembership(
    groupId: GroupId,
    epoch: number,
    members: readonly GroupMember[],
  ): Promise<GroupRecord> {
    const internal = this.groups.get(groupKey(groupId));
    if (internal === undefined) {
      throw new StoreError(
        StoreErrorCode.GroupNotFound,
        "cannot update membership for a group that does not exist",
      );
    }
    internal.epoch = epoch;
    internal.members = cloneGroupMembers(members);
    // The canonical list carries exactly one author-flagged entry (codec
    // invariant); adopt its key as the record's author identity.
    const author = members.find((m) => m.isAuthor);
    if (author !== undefined) {
      internal.authorIdentityPub = clonePublicKey(author.identityPub);
    }
    return toGroupRecord(encodeGroupId(groupId), internal);
  }

  async setGroupDisplayName(groupId: GroupId, name: string | null): Promise<void> {
    const internal = this.groups.get(groupKey(groupId));
    if (internal === undefined) {
      throw new StoreError(
        StoreErrorCode.GroupNotFound,
        "cannot set a display name for a group that does not exist",
      );
    }
    internal.displayName = name;
  }

  async removeGroup(groupId: GroupId): Promise<void> {
    const key = groupKey(groupId);
    this.groups.delete(key);
    this.groupIdByKey.delete(key);
  }

  async listGroups(): Promise<GroupRecord[]> {
    const records: GroupRecord[] = [];
    for (const [key, internal] of this.groups) {
      const id = this.groupIdByKey.get(key);
      if (id === undefined) continue;
      records.push(toGroupRecord(id, internal));
    }
    records.sort((a, b) => a.createdAt - b.createdAt || groupKeyCompare(a.groupId, b.groupId));
    return records;
  }

  serialize(): SerializedState {
    const conversations: SerializedConversation[] = [];
    for (const [key, internal] of this.conversations) {
      conversations.push(serializeConversation(key, internal));
    }
    conversations.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    const messages: SerializedConversationMessages[] = [];
    for (const [key, list] of this.messages) {
      if (list.length === 0) continue;
      const serializedMessages = list.map(serializeMessage);
      serializedMessages.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
      messages.push({ conversationId: key, messages: serializedMessages });
    }
    messages.sort((a, b) => a.conversationId.localeCompare(b.conversationId));
    return { conversations, messages };
  }

  async reload(atRestKey: AtRestKey, state: SerializedState): Promise<void> {
    // R8/F7: validate the ENTIRE incoming state BEFORE touching the maps —
    // the same contract {@link BrowserDbConversationRepository.reload}
    // documents. Decoders surface typed StoreError(MalformedBundle) only (raw
    // Error/TypeError/ProtocolError escapes previously breached the store's
    // error contract), and the maps are swapped only after every row proves
    // out — a mid-loop throw no longer leaves the repo wiped by clearAll but
    // partially repopulated.
    const nextConversations = new Map<string, InternalConversation>();
    const nextKeyById = new Map<string, ConversationId>();
    const nextMessages = new Map<string, InternalMessage[]>();
    for (const convo of state.conversations) {
      if (convo === null || typeof convo !== "object") {
        throw new StoreError(
          StoreErrorCode.MalformedBundle,
          "serialized conversation must be an object",
        );
      }
      const id = decodeConversationIdHex(convo.id);
      const key = idKey(id);
      // A second entry with the same id would silently overwrite the first —
      // reject it like the duplicate message groups below.
      if (nextConversations.has(key)) {
        throw new StoreError(
          StoreErrorCode.MalformedBundle,
          `serialized state contains conversation ${convo.id} more than once`,
        );
      }
      if (typeof convo.createdAt !== "number" || !Number.isFinite(convo.createdAt)) {
        throw new StoreError(
          StoreErrorCode.MalformedBundle,
          `conversation ${convo.id} createdAt must be a finite number`,
        );
      }
      if (convo.displayName !== null && typeof convo.displayName !== "string") {
        throw new StoreError(
          StoreErrorCode.MalformedBundle,
          `conversation ${convo.id} displayName must be a string or null`,
        );
      }
      nextConversations.set(key, {
        createdAt: convo.createdAt,
        displayName: convo.displayName,
        peer: convo.peer === null ? null : deserializePeer(convo.peer),
        // Backward compat: older bundles predate the authFailed fields; treat
        // their absence as false/null (no auth failure recorded).
        authFailed: convo.authFailed === true,
        authFailedAt: convo.authFailedAt ?? null,
      });
      nextKeyById.set(key, id);
      nextMessages.set(key, []);
    }
    const seenMessageGroups = new Set<string>();
    for (const group of state.messages) {
      if (group === null || typeof group !== "object" || !Array.isArray(group.messages)) {
        throw new StoreError(
          StoreErrorCode.MalformedBundle,
          "serialized message group must be an object with a messages array",
        );
      }
      const id = decodeConversationIdHex(group.conversationId);
      const key = idKey(id);
      if (!nextConversations.has(key)) {
        throw new StoreError(
          StoreErrorCode.MalformedBundle,
          `serialized state references messages for an unknown conversation ${group.conversationId}`,
        );
      }
      // R8/F7: a second group for the same conversation previously overwrote
      // the first via messages.set — reject it instead of silently dropping
      // the earlier rows.
      if (seenMessageGroups.has(key)) {
        throw new StoreError(
          StoreErrorCode.MalformedBundle,
          `serialized state lists messages for conversation ${group.conversationId} more than once`,
        );
      }
      seenMessageGroups.add(key);
      const list: InternalMessage[] = group.messages.map((m) =>
        deserializeMessage(m, group.conversationId),
      );
      nextMessages.set(key, list);
    }
    await this.clearAll();
    this.atRestKey = atRestKey;
    for (const [key, internal] of nextConversations) this.conversations.set(key, internal);
    for (const [key, id] of nextKeyById) this.keyById.set(key, id);
    for (const [key, list] of nextMessages) this.messages.set(key, list);
  }

  async _unsafeGetRawMessages(id: ConversationId): Promise<RawStoredMessage[]> {
    const convoKey = idKey(id);
    const list = this.messages.get(convoKey) ?? [];
    return list.map((m) => ({
      id: m.id,
      direction: m.direction,
      timestamp: m.timestamp,
      nonce: new Uint8Array(m.nonce),
      ciphertext: new Uint8Array(m.ciphertext),
    }));
  }
}

function idKey(id: ConversationId): string {
  return bytesToHex(id);
}

function idKeyCompare(a: ConversationId, b: ConversationId): number {
  return bytesToHex(a).localeCompare(bytesToHex(b));
}

function cloneConversationId(id: ConversationId): ConversationId {
  return encodeConversationId(copyBytes(id, CONVERSATION_ID_BYTES));
}

function clonePublicKey(key: PublicKey): PublicKey {
  return encodePublicKey(copyBytes(key, PUBLIC_KEY_BYTES));
}

function groupKey(id: GroupId): string {
  return bytesToHex(id);
}

function groupKeyCompare(a: GroupId, b: GroupId): number {
  return bytesToHex(a).localeCompare(bytesToHex(b));
}

/** Defensive copy of a member list: each identity key is cloned and re-branded. */
function cloneGroupMembers(members: readonly GroupMember[]): GroupMember[] {
  return members.map((m) => ({
    identityPub: clonePublicKey(m.identityPub),
    isAuthor: m.isAuthor,
    displayName: m.displayName,
  }));
}

function toGroupRecord(id: GroupId, internal: InternalGroup): GroupRecord {
  return {
    groupId: encodeGroupId(id),
    epoch: internal.epoch,
    authorIdentityPub:
      internal.authorIdentityPub === null ? null : clonePublicKey(internal.authorIdentityPub),
    members: cloneGroupMembers(internal.members),
    displayName: internal.displayName,
    createdAt: internal.createdAt,
  };
}

function copyBytes(source: Uint8Array, length: number): Uint8Array {
  if (source.length !== length) {
    throw new StoreError(
      StoreErrorCode.MalformedBundle,
      `expected ${length} bytes, got ${source.length}`,
    );
  }
  const out = new Uint8Array(length);
  out.set(source);
  return out;
}

/**
 * R8/F7: validate a serialized conversation-id hex and return the decoded id.
 * Rejects non-hex and wrong-length ids with a typed MalformedBundle instead
 * of letting hexToBytes' raw Error or encodeConversationId's ProtocolError
 * escape the reload path.
 */
function decodeConversationIdHex(hex: string): ConversationId {
  let bytes: Uint8Array;
  try {
    bytes = hexToBytes(hex);
  } catch {
    throw new StoreError(StoreErrorCode.MalformedBundle, `malformed conversation id hex ${hex}`);
  }
  if (bytes.length !== CONVERSATION_ID_BYTES) {
    throw new StoreError(
      StoreErrorCode.MalformedBundle,
      `conversation id must be ${CONVERSATION_ID_BYTES} bytes, got ${bytes.length}`,
    );
  }
  return encodeConversationId(bytes);
}

/**
 * R8/F7: decode a base64 serialized-state field, surfacing both a non-string
 * value and invalid base64 as typed MalformedBundle instead of a raw
 * TypeError/Error.
 */
function decodeStoredBase64(input: string, field: string): Uint8Array {
  if (typeof input !== "string") {
    throw new StoreError(
      StoreErrorCode.MalformedBundle,
      `serialized ${field} must be a base64 string`,
    );
  }
  try {
    return base64ToBytes(input);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new StoreError(
      StoreErrorCode.MalformedBundle,
      `serialized ${field} is not valid base64: ${detail}`,
    );
  }
}

/**
 * R8/F7: run a codec decoder and convert any non-StoreError failure
 * (ProtocolError for a bad key shape, etc.) into a typed MalformedBundle.
 */
function decodeOrMalformed<T>(field: string, decode: () => T): T {
  try {
    return decode();
  } catch (err) {
    if (err instanceof StoreError) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    throw new StoreError(StoreErrorCode.MalformedBundle, `serialized ${field}: ${detail}`);
  }
}

function toRecord(id: ConversationId, internal: InternalConversation): ConversationRecord {
  return {
    id: cloneConversationId(id),
    createdAt: internal.createdAt,
    displayName: internal.displayName,
    peer:
      internal.peer === null
        ? null
        : {
            fingerprint: internal.peer.fingerprint,
            publicKey: clonePublicKey(internal.peer.publicKey),
          },
    authFailed: internal.authFailed,
    authFailedAt: internal.authFailedAt,
  };
}

function serializeConversation(
  key: string,
  internal: InternalConversation,
): SerializedConversation {
  return {
    id: key,
    createdAt: internal.createdAt,
    displayName: internal.displayName,
    peer:
      internal.peer === null
        ? null
        : {
            fingerprint: internal.peer.fingerprint,
            publicKey: bytesToBase64(internal.peer.publicKey),
          },
    authFailed: internal.authFailed,
    authFailedAt: internal.authFailedAt,
  };
}

function serializeMessage(message: InternalMessage): SerializedMessage {
  return {
    id: message.id,
    direction: message.direction,
    timestamp: message.timestamp,
    nonce: bytesToBase64(message.nonce),
    ciphertext: bytesToBase64(message.ciphertext),
  };
}

function deserializePeer(peer: SerializedPeerIdentity): PeerIdentityRecord {
  // R8/F7: validate the runtime shape before dereferencing — a null /
  // non-object peer reached `peer.fingerprint` and threw a raw TypeError.
  if (peer === null || typeof peer !== "object") {
    throw new StoreError(StoreErrorCode.MalformedBundle, "serialized peer must be an object");
  }
  if (typeof peer.fingerprint !== "string") {
    throw new StoreError(
      StoreErrorCode.MalformedBundle,
      "serialized peer fingerprint must be a string",
    );
  }
  const keyBytes = decodeStoredBase64(peer.publicKey, "peer publicKey");
  return {
    fingerprint: peer.fingerprint,
    // Key-shape failures (exact length, SEC1 prefix, on-curve) surface as
    // typed MalformedBundle via the wrapper rather than a raw ProtocolError.
    publicKey: decodeOrMalformed("peer publicKey", () => encodePublicKey(keyBytes)),
  };
}

/**
 * R8/F7: decode one serialized message row for {@link
 * InMemoryConversationRepository.reload}. Every field is validated and every
 * decode failure surfaces as a typed MalformedBundle.
 */
function deserializeMessage(m: SerializedMessage, conversationIdHex: string): InternalMessage {
  if (m === null || typeof m !== "object") {
    throw new StoreError(
      StoreErrorCode.MalformedBundle,
      `serialized message in conversation ${conversationIdHex} must be an object`,
    );
  }
  if (typeof m.id !== "string" || m.id.length === 0) {
    throw new StoreError(
      StoreErrorCode.MalformedBundle,
      `serialized message id in conversation ${conversationIdHex} must be a non-empty string`,
    );
  }
  if (typeof m.timestamp !== "number" || !Number.isFinite(m.timestamp)) {
    throw new StoreError(
      StoreErrorCode.MalformedBundle,
      `serialized message ${m.id} timestamp must be a finite number`,
    );
  }
  return {
    id: m.id,
    direction: assertDirection(m.direction),
    timestamp: m.timestamp,
    nonce: decodeStoredBase64(m.nonce, `message ${m.id} nonce`),
    ciphertext: decodeStoredBase64(m.ciphertext, `message ${m.id} ciphertext`),
  };
}

async function decryptMessage(
  atRestKey: AtRestKey,
  conversationId: ConversationId,
  stored: InternalMessage,
): Promise<string> {
  try {
    // R1:F2: verify the record's conversation + direction binding; rows sealed
    // before the binding existed decrypt via decryptAtRest's legacy empty-AAD
    // fallback.
    const plaintext = await decryptAtRest(
      atRestKey,
      stored.nonce,
      stored.ciphertext,
      messageRecordAad(conversationId, stored.direction),
    );
    return new TextDecoder().decode(plaintext);
  } catch (err) {
    if (err instanceof CryptoError && err.code === CryptoErrorCode.AuthenticationFailed) {
      throw new StoreError(
        StoreErrorCode.WrongPassphrase,
        "at-rest key does not decrypt stored ciphertext",
      );
    }
    throw err;
  }
}

function assertDirection(value: string): MessageDirection {
  const dir = value as MessageDirection;
  if (!MESSAGE_DIRECTION_VALUES.includes(dir)) {
    throw new StoreError(StoreErrorCode.MalformedBundle, `unknown message direction ${value}`);
  }
  return dir;
}

function newMessageId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * R4/F1: resolve the id a newly appended message is stored under. An explicit
 * id (the bundle import/merge path passes the exporter's id so re-importing an
 * overlapping bundle dedups instead of duplicating) is stored verbatim and
 * must be a non-empty string; when the option is absent a fresh UUID is
 * generated, exactly as before the parameter existed.
 */
function messageIdFromOptions(options: AppendMessageOptions | undefined): string {
  const explicit = options?.id;
  if (explicit === undefined) {
    return newMessageId();
  }
  if (typeof explicit !== "string" || explicit.length === 0) {
    throw new StoreError(
      StoreErrorCode.MalformedBundle,
      "explicit message id must be a non-empty string",
    );
  }
  return explicit;
}
