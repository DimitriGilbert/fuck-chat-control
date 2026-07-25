import { decryptAtRest, encryptAtRest } from "../crypto/at-rest";
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

  async createConversation(id: ConversationId, createdAt: number): Promise<ConversationRecord> {
    const key = idKey(id);
    if (!this.conversations.has(key)) {
      this.conversations.set(key, { createdAt, displayName: null, peer: null });
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
