import {
  createBrowserWASQLitePersistence,
  openBrowserWASQLiteOPFSDatabase,
  persistedCollectionOptions,
} from "@tanstack/browser-db-sqlite-persistence";
import { createCollection } from "@tanstack/db";
import type { Collection } from "@tanstack/db";
import { decryptAtRest, encryptAtRest } from "@fuck-eu-chat-control/chat-runtime/crypto/at-rest";
import { ctEqual } from "@fuck-eu-chat-control/chat-runtime/crypto/ct-equal";
import { CryptoError, CryptoErrorCode } from "@fuck-eu-chat-control/chat-runtime/crypto/errors";
import type { AtRestKey } from "@fuck-eu-chat-control/chat-runtime/crypto/types";
import {
  encodeConversationId,
  encodePublicKey,
} from "@fuck-eu-chat-control/chat-runtime/protocol/codec";
import {
  CONVERSATION_ID_BYTES,
  PUBLIC_KEY_BYTES,
} from "@fuck-eu-chat-control/chat-runtime/protocol/limits";
import type { ConversationId, PublicKey } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import {
  bytesToBase64,
  bytesToHex,
  base64ToBytes,
  hexToBytes,
} from "@fuck-eu-chat-control/chat-runtime/store/encoding";
import {
  MessageDirection,
  MESSAGE_DIRECTION_VALUES,
  StoreError,
  StoreErrorCode,
} from "@fuck-eu-chat-control/chat-runtime/store/types";
import type {
  ConversationMessage,
  ConversationRecord,
  PeerIdentityRecord,
  PersistableConversationRepository,
  ReloadableConversationRepository,
  SerializedConversation,
  SerializedConversationMessages,
  SerializedMessage,
  SerializedState,
} from "@fuck-eu-chat-control/chat-runtime/store/types";

/**
 * A persisted {@link ConversationRepository} backed by TanStack DB collections
 * over wa-sqlite/OPFS. This is the browser's real store: conversations and
 * messages survive reloads.
 *
 * STORAGE. One OPFS SQLite database (opened in a dedicated Web Worker by
 * {@link openBrowserWASQLiteOPFSDatabase}) backs two TanStack DB collections:
 *
 *   - `conversations`: keyed by conversation-id hex. Holds createdAt,
 *     displayName, peer fingerprint + public key (base64), and the durable
 *     auth-failed flag + timestamp.
 *   - `messages`: keyed by message id. Holds conversationId (hex), direction,
 *     timestamp, nonce (base64), and ciphertext (base64). Message TEXT is
 *     never stored in the clear: {@link appendMessage} encrypts it with the
 *     at-rest key (AES-256-GCM) exactly as the in-memory repo does, and
 *     {@link getMessages} decrypts on read. The database at rest holds only
 *     ciphertext + nonce.
 *
 * The repo is a drop-in for {@link InMemoryConversationRepository}: it keeps
 * the same TOFU peer-pinning guard, the same idempotent auth-failed flag, and
 * the same serialize()/reload() shape. It also implements
 * {@link zeroizeAtRestKey}/{@link resetAtRestKey} so the {@link LockableRepository}
 * wrapper's CR-7 heap-read-while-locked defense keeps working.
 *
 * NODE. This needs OPFS + Web Workers, so it only constructs in a browser. The
 * Node-runnable tests use {@link InMemoryConversationRepository}. The single
 * {@link createBrowserDbRepository} factory does the async DB open + collection
 * creation; the class constructor itself takes the already-open collections so
 * it can be cheaply rebuilt (e.g. on at-rest-key reset).
 */

/** Serialized row shape of the `conversations` collection. */
export interface ConversationRow {
  /** Conversation id as lowercase hex (the collection key). */
  readonly id: string;
  readonly createdAt: number;
  readonly displayName: string | null;
  readonly peerFingerprint: string | null;
  /** Peer identity public key as base64 (uncompressed SEC1), or null. */
  readonly peerPublicKey: string | null;
  readonly authFailed: boolean;
  readonly authFailedAt: number | null;
}

/** Serialized row shape of the `messages` collection. */
export interface MessageRow {
  /** Message id (UUID). The collection key. */
  readonly id: string;
  /** Conversation id as lowercase hex (foreign reference into `conversations`). */
  readonly conversationId: string;
  readonly direction: MessageDirection;
  readonly timestamp: number;
  /** AES-256-GCM nonce as base64. */
  readonly nonce: string;
  /** AES-256-GCM ciphertext (incl. 16-byte tag) as base64. Text is NOT stored in the clear. */
  readonly ciphertext: string;
}

const CONVERSATIONS_COLLECTION_ID = "fck-chat-v1/conversations";
const MESSAGES_COLLECTION_ID = "fck-chat-v1/messages";
const SCHEMA_VERSION = 1;

export interface BrowserDbRepositoryConfig {
  readonly databaseName: string;
  readonly atRestKey: AtRestKey;
}

/**
 * The subset of a wa-sqlite {@link BrowserWASQLiteDatabase} the repo needs to
 * RETAIN for teardown: just the optional `close()`. We do not run queries
 * through the retained handle (the {@link Collection}s own the driver), so the
 * field is typed narrowly — this also lets tests pass a minimal `{ close }`
 * fake without stubbing `execute`.
 */
type CloseableDatabase = { close?: () => Promise<void> | void };

/**
 * The opened persistence + collections, shared between the repo and any
 * rebuild. {@link databaseName} is retained so error messages can name it.
 * {@link database} is the wa-sqlite handle (with an optional `close()`) so the
 * repo can release the underlying OPFS file + Worker when the controller is
 * disposed. Stored as a separate field rather than derived from `persistence`
 * because `persistence` is local to {@link BrowserDbConversationRepository.create}.
 */
interface BrowserDbHandles {
  readonly databaseName: string;
  readonly database: CloseableDatabase | null;
  readonly conversations: Collection<ConversationRow, string>;
  readonly messages: Collection<MessageRow, string>;
}

export class BrowserDbConversationRepository
  implements ReloadableConversationRepository, PersistableConversationRepository
{
  readonly databaseName: string;
  readonly atRestKey: AtRestKey;
  private readonly conversations: Collection<ConversationRow, string>;
  private readonly messages: Collection<MessageRow, string>;
  private atRestKeyField: AtRestKey | null;
  /**
   * The wa-sQLite handle backing the collections (null when the repo was built
   * from pre-existing collections without a DB, e.g. the local-only test
   * harness). Retained so {@link close} can release the OPFS file + Worker.
   */
  private readonly database: CloseableDatabase | null;
  private closed = false;

  constructor(config: BrowserDbRepositoryConfig, handles: BrowserDbHandles) {
    this.databaseName = handles.databaseName;
    this.atRestKey = config.atRestKey;
    this.atRestKeyField = config.atRestKey;
    this.conversations = handles.conversations;
    this.messages = handles.messages;
    this.database = handles.database;
  }

  /**
   * Open the OPFS database and build the two persisted collections, then return
   * a ready repository. Async because both the DB open and the collections'
   * first hydration are awaited via {@link Collection.toArrayWhenReady} (so the
   * caller never reads a half-loaded store). Throws if OPFS is unavailable
   * (Safari private mode, sandboxed iframes, etc.) — callers should fall back
   * to {@link InMemoryConversationRepository} on that failure.
   */
  static async create(config: BrowserDbRepositoryConfig): Promise<BrowserDbConversationRepository> {
    const database = await openBrowserWASQLiteOPFSDatabase({
      databaseName: config.databaseName,
    });
    const persistence = createBrowserWASQLitePersistence({ database });

    const conversations = createCollection(
      persistedCollectionOptions<ConversationRow, string>({
        id: CONVERSATIONS_COLLECTION_ID,
        getKey: (row) => row.id,
        persistence,
        schemaVersion: SCHEMA_VERSION,
      }),
    );
    const messages = createCollection(
      persistedCollectionOptions<MessageRow, string>({
        id: MESSAGES_COLLECTION_ID,
        getKey: (row) => row.id,
        persistence,
        schemaVersion: SCHEMA_VERSION,
      }),
    );

    // Block construction until both collections have replayed their persisted
    // state. Without this the first listConversations()/getMessages() could
    // race the async hydration and return empty.
    await Promise.all([conversations.toArrayWhenReady(), messages.toArrayWhenReady()]);

    return new BrowserDbConversationRepository(config, {
      databaseName: config.databaseName,
      database,
      conversations,
      messages,
    });
  }

  /**
   * Release the underlying OPFS SQLite database + its dedicated Worker.
   * Idempotent: a second (or later) call resolves immediately without
   * re-invoking the driver's close. Safe to call even when this repo was built
   * from local-only collections (no `database`): it is a no-op then.
   *
   * This is the single seam the {@link ChatController}'s dispose() reaches for;
   * providers should NOT call it directly. Repository methods must not be used
   * after close() — the collections will reject once the backing store is gone.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const db = this.database;
    if (db === null) return;
    // The driver declares `close` optional; guard for forward-compat.
    await Promise.resolve(db.close?.()).catch(() => {
      // Swallow: dispose must never throw. A failed close (e.g. the Worker is
      // already gone) leaves the OPFS file to the browser's normal teardown.
    });
  }

  private requireKey(): AtRestKey {
    if (this.atRestKeyField === null) {
      throw new StoreError(
        StoreErrorCode.NotInitialized,
        "repository has no at-rest key; reset with a valid key before use",
      );
    }
    return this.atRestKeyField;
  }

  async createConversation(id: ConversationId, createdAt: number): Promise<ConversationRecord> {
    const key = idKey(id);
    if (!this.conversations.has(key)) {
      const row: ConversationRow = {
        id: key,
        createdAt,
        displayName: null,
        peerFingerprint: null,
        peerPublicKey: null,
        authFailed: false,
        authFailedAt: null,
      };
      this.conversations.insert(row);
    }
    return this.toRecord(id, this.conversations.get(key) as ConversationRow);
  }

  async getConversation(id: ConversationId): Promise<ConversationRecord | null> {
    const key = idKey(id);
    const row = this.conversations.get(key);
    if (row === undefined) return null;
    return this.toRecord(id, row);
  }

  async listConversations(): Promise<ConversationRecord[]> {
    const rows = this.conversations.toArray;
    const records = rows.map((row) => this.toRecord(hexToConversationId(row.id), row));
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
    const row: MessageRow = {
      id: messageId,
      conversationId: convoKey,
      direction,
      timestamp,
      nonce: bytesToBase64(sealed.nonce),
      ciphertext: bytesToBase64(sealed.ciphertext),
    };
    this.messages.insert(row);
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
    const rows = this.messages.toArray.filter((m) => m.conversationId === convoKey);
    const out: ConversationMessage[] = [];
    for (const row of rows) {
      const plaintext = await this.decryptMessage(atRestKey, row);
      out.push({
        id: row.id,
        conversationId: cloneConversationId(id),
        direction: row.direction,
        timestamp: row.timestamp,
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
    const row = this.conversations.get(convoKey);
    if (row === undefined) {
      throw new StoreError(
        StoreErrorCode.ConversationNotFound,
        "cannot store peer identity for a conversation that does not exist",
      );
    }
    const pubB64 = bytesToBase64(publicKey);
    if (row.peerPublicKey !== null) {
      const sameKey = ctEqual(base64ToBytes(row.peerPublicKey), publicKey);
      if (!sameKey) {
        throw new StoreError(
          StoreErrorCode.PeerIdentityAlreadyPinned,
          "peer identity already pinned for this conversation; refusing to overwrite " +
            "with a different key (TOFU). Use replacePeerIdentity for the trusted " +
            "Replace-mode import path.",
        );
      }
      // Same key re-pinned: refresh the fingerprint and no-op otherwise.
      this.conversations.update(convoKey, (draft) => {
        draft.peerFingerprint = fingerprint;
        draft.peerPublicKey = pubB64;
      });
      return;
    }
    this.conversations.update(convoKey, (draft) => {
      draft.peerFingerprint = fingerprint;
      draft.peerPublicKey = pubB64;
    });
  }

  async replacePeerIdentity(
    id: ConversationId,
    fingerprint: string,
    publicKey: PublicKey,
  ): Promise<void> {
    const convoKey = idKey(id);
    if (!this.conversations.has(convoKey)) {
      throw new StoreError(
        StoreErrorCode.ConversationNotFound,
        "cannot replace peer identity for a conversation that does not exist",
      );
    }
    const pubB64 = bytesToBase64(publicKey);
    this.conversations.update(convoKey, (draft) => {
      draft.peerFingerprint = fingerprint;
      draft.peerPublicKey = pubB64;
    });
  }

  async getPeerIdentity(id: ConversationId): Promise<PeerIdentityRecord | null> {
    const convoKey = idKey(id);
    const row = this.conversations.get(convoKey);
    if (row === undefined || row.peerPublicKey === null || row.peerFingerprint === null) {
      return null;
    }
    return {
      fingerprint: row.peerFingerprint,
      publicKey: clonePublicKey(base64ToBytes(row.peerPublicKey)),
    };
  }

  async setDisplayName(id: ConversationId, name: string): Promise<void> {
    const convoKey = idKey(id);
    if (!this.conversations.has(convoKey)) {
      throw new StoreError(
        StoreErrorCode.ConversationNotFound,
        "cannot set a display name for a conversation that does not exist",
      );
    }
    this.conversations.update(convoKey, (draft) => {
      draft.displayName = name;
    });
  }

  async getDisplayName(id: ConversationId): Promise<string | null> {
    const convoKey = idKey(id);
    const row = this.conversations.get(convoKey);
    if (row === undefined) return null;
    return row.displayName;
  }

  async markAuthFailed(id: ConversationId): Promise<void> {
    const convoKey = idKey(id);
    if (!this.conversations.has(convoKey)) {
      throw new StoreError(
        StoreErrorCode.ConversationNotFound,
        "cannot mark auth-failed for a conversation that does not exist",
      );
    }
    // Idempotent: refresh the timestamp so the most recent failure is recorded.
    this.conversations.update(convoKey, (draft) => {
      draft.authFailed = true;
      draft.authFailedAt = epochMillis();
    });
  }

  async getAuthFailed(id: ConversationId): Promise<boolean> {
    const convoKey = idKey(id);
    const row = this.conversations.get(convoKey);
    if (row === undefined) return false;
    return row.authFailed;
  }

  async clearConversation(id: ConversationId): Promise<void> {
    const convoKey = idKey(id);
    const messageRows = this.messages.toArray.filter((m) => m.conversationId === convoKey);
    if (messageRows.length > 0) {
      this.messages.delete(messageRows.map((m) => m.id));
    }
    this.conversations.delete(convoKey);
  }

  async clearAll(): Promise<void> {
    const messageKeys = this.messages.toArray.map((m) => m.id);
    const conversationKeys = this.conversations.toArray.map((c) => c.id);
    if (messageKeys.length > 0) this.messages.delete(messageKeys);
    if (conversationKeys.length > 0) this.conversations.delete(conversationKeys);
  }

  serialize(): SerializedState {
    const conversationRows = this.conversations.toArray;
    const messageRows = this.messages.toArray;

    const conversations: SerializedConversation[] = conversationRows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      displayName: row.displayName,
      peer:
        row.peerPublicKey === null || row.peerFingerprint === null
          ? null
          : { fingerprint: row.peerFingerprint, publicKey: row.peerPublicKey },
      authFailed: row.authFailed,
      authFailedAt: row.authFailedAt,
    }));
    conversations.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));

    const grouped = new Map<string, SerializedMessage[]>();
    for (const row of messageRows) {
      const list = grouped.get(row.conversationId) ?? [];
      list.push({
        id: row.id,
        direction: row.direction,
        timestamp: row.timestamp,
        nonce: row.nonce,
        ciphertext: row.ciphertext,
      });
      grouped.set(row.conversationId, list);
    }
    const messages: SerializedConversationMessages[] = [];
    for (const [conversationId, list] of grouped) {
      const sorted = [...list].sort(
        (a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id),
      );
      if (sorted.length === 0) continue;
      messages.push({ conversationId, messages: sorted });
    }
    messages.sort((a, b) => a.conversationId.localeCompare(b.conversationId));

    return { conversations, messages };
  }

  async reload(atRestKey: AtRestKey, state: SerializedState): Promise<void> {
    await this.clearAll();
    this.atRestKeyField = atRestKey;
    for (const convo of state.conversations) {
      const row: ConversationRow = {
        id: convo.id,
        createdAt: convo.createdAt,
        displayName: convo.displayName,
        peerFingerprint: convo.peer?.fingerprint ?? null,
        peerPublicKey: convo.peer?.publicKey ?? null,
        authFailed: convo.authFailed === true,
        authFailedAt: convo.authFailedAt ?? null,
      };
      this.conversations.insert(row);
    }
    for (const group of state.messages) {
      if (!this.conversations.has(group.conversationId)) {
        throw new StoreError(
          StoreErrorCode.MalformedBundle,
          `serialized state references messages for an unknown conversation ${group.conversationId}`,
        );
      }
      for (const m of group.messages) {
        this.messages.insert({
          id: m.id,
          conversationId: group.conversationId,
          direction: assertDirection(m.direction),
          timestamp: m.timestamp,
          nonce: m.nonce,
          ciphertext: m.ciphertext,
        });
      }
    }
  }

  /** CR-7: zeroize the live at-rest key when the {@link LockableRepository} observes a lock. */
  zeroizeAtRestKey(): void {
    if (this.atRestKeyField !== null) {
      this.atRestKeyField.fill(0);
      this.atRestKeyField = null;
    }
  }

  /** CR-7: repopulate the live at-rest key after a successful unlock. */
  resetAtRestKey(key: AtRestKey): void {
    this.atRestKeyField = key;
  }

  /** Test seam for CR-7: true iff the key has been zeroized (lock observed). */
  _atRestKeyIsZeroizedForTest(): boolean {
    return this.atRestKeyField === null;
  }

  private toRecord(id: ConversationId, row: ConversationRow): ConversationRecord {
    return {
      id: cloneConversationId(id),
      createdAt: row.createdAt,
      displayName: row.displayName,
      peer:
        row.peerPublicKey === null || row.peerFingerprint === null
          ? null
          : {
              fingerprint: row.peerFingerprint,
              publicKey: clonePublicKey(base64ToBytes(row.peerPublicKey)),
            },
      authFailed: row.authFailed,
      authFailedAt: row.authFailedAt,
    };
  }

  private async decryptMessage(atRestKey: AtRestKey, row: MessageRow): Promise<string> {
    try {
      const plaintext = await decryptAtRest(
        atRestKey,
        base64ToBytes(row.nonce),
        base64ToBytes(row.ciphertext),
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

function clonePublicKey(key: Uint8Array): PublicKey {
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

function hexToConversationId(hex: string): ConversationId {
  return encodeConversationId(hexToBytes(hex));
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

// epochMillis is isolated so tests/reload can stub the clock without touching
// the crypto randomUUID path above.
function epochMillis(): number {
  return Date.now();
}
