import { decryptAtRest, encryptAtRest } from "../crypto/at-rest";
import { ctEqual } from "../crypto/ct-equal";
import { CryptoError, CryptoErrorCode } from "../crypto/errors";
import type { AtRestKey } from "../crypto/types";
import { encodeConversationId, encodePublicKey } from "../protocol/codec";
import { CONVERSATION_ID_BYTES, PUBLIC_KEY_BYTES } from "../protocol/limits";
import type { ConversationId, PublicKey } from "../protocol/types";

import { bytesToBase64, bytesToHex, base64ToBytes, hexToBytes } from "./encoding";
import { MessageDirection, MESSAGE_DIRECTION_VALUES, StoreError, StoreErrorCode } from "./types";
import type {
  ConversationMessage,
  ConversationRecord,
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

export class InMemoryConversationRepository implements ReloadableConversationRepository {
  private readonly conversations = new Map<string, InternalConversation>();
  private readonly messages = new Map<string, InternalMessage[]>();
  private readonly keyById = new Map<string, ConversationId>();
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
  ): Promise<ConversationMessage> {
    const convoKey = idKey(id);
    if (!this.conversations.has(convoKey)) {
      throw new StoreError(
        StoreErrorCode.ConversationNotFound,
        "cannot append a message to a conversation that does not exist",
      );
    }
    const atRestKey = this.requireKey();
    const encoded = new TextEncoder().encode(plaintext);
    const sealed = await encryptAtRest(atRestKey, encoded);
    const messageId = newMessageId();
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
      const plaintext = await decryptMessage(atRestKey, stored);
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
    await this.clearAll();
    this.atRestKey = atRestKey;
    for (const convo of state.conversations) {
      const id = decodeConversationIdHex(convo.id);
      const internal: InternalConversation = {
        createdAt: convo.createdAt,
        displayName: convo.displayName,
        peer: convo.peer === null ? null : deserializePeer(convo.peer),
        // Backward compat: older bundles predate the authFailed fields; treat
        // their absence as false/null (no auth failure recorded).
        authFailed: convo.authFailed === true,
        authFailedAt: convo.authFailedAt ?? null,
      };
      const key = idKey(id);
      this.conversations.set(key, internal);
      this.keyById.set(key, id);
      if (!this.messages.has(key)) this.messages.set(key, []);
    }
    for (const group of state.messages) {
      const id = decodeConversationIdHex(group.conversationId);
      const key = idKey(id);
      if (!this.conversations.has(key)) {
        throw new StoreError(
          StoreErrorCode.MalformedBundle,
          `serialized state references messages for an unknown conversation ${group.conversationId}`,
        );
      }
      const list: InternalMessage[] = group.messages.map((m) => ({
        id: m.id,
        direction: assertDirection(m.direction),
        timestamp: m.timestamp,
        nonce: base64ToBytes(m.nonce),
        ciphertext: base64ToBytes(m.ciphertext),
      }));
      this.messages.set(key, list);
    }
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

function decodeConversationIdHex(hex: string): ConversationId {
  return encodeConversationId(hexToBytes(hex));
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
  return {
    fingerprint: peer.fingerprint,
    publicKey: encodePublicKey(base64ToBytes(peer.publicKey)),
  };
}

async function decryptMessage(atRestKey: AtRestKey, stored: InternalMessage): Promise<string> {
  try {
    const plaintext = await decryptAtRest(atRestKey, stored.nonce, stored.ciphertext);
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
