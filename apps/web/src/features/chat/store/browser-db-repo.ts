import {
  createBrowserWASQLitePersistence,
  openBrowserWASQLiteOPFSDatabase,
  persistedCollectionOptions,
} from "@tanstack/browser-db-sqlite-persistence";
import { createCollection, createTransaction } from "@tanstack/db";
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
  AppendMessageOptions,
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
 * The subset of a @tanstack/db Transaction the repo needs from a write's
 * return value: the persistence signal only. Kept structural (instead of the
 * concrete `Transaction<...>` generics, which differ per collection and per
 * operation) so one helper covers the insert/update/delete transactions of
 * BOTH collections.
 */
interface PersistableTransaction {
  readonly isPersisted: { readonly promise: Promise<unknown> };
}

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
  /**
   * R4/F6: persistence signals for writes this repo has started but whose
   * OPFS/SQLite commit has not settled yet. Every write method awaits its own
   * entry (durable-write contract); {@link close} drains the set before
   * releasing the DB/Worker so a concurrent write cannot be torn down
   * mid-commit.
   */
  private readonly pendingPersistence = new Set<Promise<unknown>>();

  constructor(config: BrowserDbRepositoryConfig, handles: BrowserDbHandles) {
    this.databaseName = handles.databaseName;
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
   * R4/F6: before touching the DB/Worker, DRAINS every outstanding write's
   * persistence signal ({@link pendingPersistence}) so in-flight commits land
   * instead of being torn down mid-flight; the drained writes' own methods
   * surface their failures. A failing driver close is surfaced, not swallowed:
   * it is logged AND rethrown (the production caller — the ChatController's
   * fire-and-forget dispose() — swallows at its own call site, so without the
   * log the failure would vanish; awaiting callers get the original error).
   *
   * This is the single seam the {@link ChatController}'s dispose() reaches for;
   * providers should NOT call it directly. Repository methods must not be used
   * after close() — the collections will reject once the backing store is gone.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // R4/F6: drain before releasing the DB/Worker. allSettled, not all: a
    // failed concurrent write must not abort the teardown — that write's own
    // method (which awaits the same promise) reports the failure.
    const outstanding = Array.from(this.pendingPersistence);
    if (outstanding.length > 0) {
      await Promise.allSettled(outstanding);
    }
    const db = this.database;
    if (db === null) return;
    // The driver declares `close` optional; guard for forward-compat.
    try {
      await db.close?.();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`failed to close OPFS database ${this.databaseName}`, err);
      throw err;
    }
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

  /**
   * R4/F6: await a write's OPFS/SQLite persistence signal and register it in
   * {@link pendingPersistence} for {@link close} to drain. This is the same
   * durability contract `reload()` already established (R6/F2): a write method
   * resolves only once the commit landed in the backing store, not on
   * optimistic in-memory collection state.
   */
  private async awaitPersistence(tx: PersistableTransaction): Promise<void> {
    const promise = tx.isPersisted.promise;
    this.pendingPersistence.add(promise);
    try {
      await promise;
    } finally {
      this.pendingPersistence.delete(promise);
    }
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
      // R4/F6: await the SQLite commit, not just the optimistic local insert.
      await this.awaitPersistence(this.conversations.insert(row));
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
    const records: ConversationRecord[] = [];
    // R6/F3: per-row resilience. A single corrupt row (non-hex / wrong-length
    // id — SQLite never scrubs deleted pages, so bit rot or a partial write
    // can leave one) must not brick the whole sidebar listing: skip it, log
    // it, return the rest.
    for (const row of rows) {
      try {
        records.push(this.toRecord(decodeRowConversationId(row.id), row));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`listConversations: skipping corrupt conversation row (id=${row.id})`, err);
      }
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
    // R4/F1: resolve the stored row id BEFORE sealing so an invalid explicit
    // id is rejected without wasted crypto. Absent option → fresh UUID
    // (unchanged default; the row id is the messages collection key).
    const messageId = messageIdFromOptions(options);
    const atRestKey = this.requireKey();
    const encoded = new TextEncoder().encode(plaintext);
    const sealed = await encryptAtRest(atRestKey, encoded);
    const row: MessageRow = {
      id: messageId,
      conversationId: convoKey,
      direction,
      timestamp,
      nonce: bytesToBase64(sealed.nonce),
      ciphertext: bytesToBase64(sealed.ciphertext),
    };
    // R4/F6: await the SQLite commit, not just the optimistic local insert.
    await this.awaitPersistence(this.messages.insert(row));
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
    // R6/F3: per-row resilience. A single ciphertext that fails to decrypt
    // (corrupt nonce/ciphertext) must not brick the entire history: skip it,
    // log it, return the rest. The all-rows-fail case is NOT corruption — it
    // means the at-rest key itself is wrong (e.g. unlocked with the wrong
    // passphrase), so surface the WrongPassphrase error instead of silently
    // returning an empty history.
    let decryptFailures = 0;
    let firstFailure: unknown = null;
    for (const row of rows) {
      try {
        const plaintext = await this.decryptMessage(atRestKey, row);
        out.push({
          id: row.id,
          conversationId: cloneConversationId(id),
          direction: row.direction,
          timestamp: row.timestamp,
          text: plaintext,
        });
      } catch (err) {
        decryptFailures += 1;
        firstFailure ??= err;
        // eslint-disable-next-line no-console
        console.warn(`getMessages: skipping undecryptable message row (id=${row.id})`, err);
      }
    }
    if (rows.length > 0 && decryptFailures === rows.length && firstFailure !== null) {
      throw firstFailure;
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
      // R4/F6: await the SQLite commit, not just the optimistic local update.
      await this.awaitPersistence(
        this.conversations.update(convoKey, (draft) => {
          draft.peerFingerprint = fingerprint;
          draft.peerPublicKey = pubB64;
        }),
      );
      return;
    }
    await this.awaitPersistence(
      this.conversations.update(convoKey, (draft) => {
        draft.peerFingerprint = fingerprint;
        draft.peerPublicKey = pubB64;
      }),
    );
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
    // R4/F6: await the SQLite commit, not just the optimistic local update.
    await this.awaitPersistence(
      this.conversations.update(convoKey, (draft) => {
        draft.peerFingerprint = fingerprint;
        draft.peerPublicKey = pubB64;
      }),
    );
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
    // R4/F6: await the SQLite commit, not just the optimistic local update.
    await this.awaitPersistence(
      this.conversations.update(convoKey, (draft) => {
        draft.displayName = name;
      }),
    );
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
    // R4/F6: await the SQLite commit, not just the optimistic local update.
    await this.awaitPersistence(
      this.conversations.update(convoKey, (draft) => {
        draft.authFailed = true;
        draft.authFailedAt = epochMillis();
      }),
    );
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
      // R4/F6: await the SQLite commit, not just the optimistic local delete.
      await this.awaitPersistence(this.messages.delete(messageRows.map((m) => m.id)));
    }
    await this.awaitPersistence(this.conversations.delete(convoKey));
  }

  async clearAll(): Promise<void> {
    const messageKeys = this.messages.toArray.map((m) => m.id);
    const conversationKeys = this.conversations.toArray.map((c) => c.id);
    // R4/F6: await the SQLite commit, not just the optimistic local delete.
    if (messageKeys.length > 0) await this.awaitPersistence(this.messages.delete(messageKeys));
    if (conversationKeys.length > 0) {
      await this.awaitPersistence(this.conversations.delete(conversationKeys));
    }
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
    // R6/F5: validate the ENTIRE incoming state BEFORE touching the
    // collections — every conversation id must be well-formed hex of exactly
    // CONVERSATION_ID_BYTES bytes, and every message group must reference a
    // known conversation. Validation failures must reject the reload outright
    // rather than half-applying.
    const conversationRows: ConversationRow[] = [];
    const conversationIds = new Set<string>();
    for (const convo of state.conversations) {
      // Throws StoreError(MalformedBundle) on bad hex / wrong length.
      decodeRowConversationId(convo.id);
      conversationIds.add(convo.id);
      conversationRows.push({
        id: convo.id,
        createdAt: convo.createdAt,
        displayName: convo.displayName,
        peerFingerprint: convo.peer?.fingerprint ?? null,
        peerPublicKey: convo.peer?.publicKey ?? null,
        authFailed: convo.authFailed === true,
        authFailedAt: convo.authFailedAt ?? null,
      });
    }
    const messageRows: MessageRow[] = [];
    for (const group of state.messages) {
      if (!conversationIds.has(group.conversationId)) {
        throw new StoreError(
          StoreErrorCode.MalformedBundle,
          `serialized state references messages for an unknown conversation ${group.conversationId}`,
        );
      }
      for (const m of group.messages) {
        messageRows.push({
          id: m.id,
          conversationId: group.conversationId,
          direction: assertDirection(m.direction),
          timestamp: m.timestamp,
          nonce: m.nonce,
          ciphertext: m.ciphertext,
        });
      }
    }

    this.atRestKeyField = atRestKey;
    // R6/F2: apply the whole replace as ONE TanStack DB transaction so the
    // persistence layer commits a single SQLite transaction. The previous
    // clearAll-then-insert-loop shape committed each insert separately — a
    // crash mid-reload left a partially wiped/partially populated database.
    //
    // The transaction is DIFFED per collection (delete keys leaving the store,
    // update keys present in both, insert new keys) because TanStack DB
    // forbids delete+insert of the same key inside one transaction — a raw
    // wipe+repopulate would throw "Unhandled mutation combination:
    // delete-insert" whenever a key survives the reload. The update branch is
    // a full-row replacement, so a surviving key ends up byte-identical to the
    // incoming row either way.
    const incomingConversations = new Map(conversationRows.map((r) => [r.id, r]));
    const existingConversationKeys = new Set(this.conversations.toArray.map((c) => c.id));
    const incomingMessages = new Map(messageRows.map((r) => [r.id, r]));
    const existingMessageKeys = new Set(this.messages.toArray.map((m) => m.id));

    const tx = createTransaction({
      mutationFn: async ({ transaction }) => {
        // Local-only/persisted collections only durably apply mutations that
        // the mutationFn explicitly accepts; each call filters the tx down to
        // that collection's mutations and persists them in one applyCommittedTx.
        await Promise.all([
          this.conversations.utils.acceptMutations(transaction),
          this.messages.utils.acceptMutations(transaction),
        ]);
      },
    });
    tx.mutate(() => {
      for (const key of existingConversationKeys) {
        if (!incomingConversations.has(key)) {
          this.conversations.delete(key);
        }
      }
      for (const row of conversationRows) {
        if (existingConversationKeys.has(row.id)) {
          this.conversations.update(row.id, (draft) => {
            draft.createdAt = row.createdAt;
            draft.displayName = row.displayName;
            draft.peerFingerprint = row.peerFingerprint;
            draft.peerPublicKey = row.peerPublicKey;
            draft.authFailed = row.authFailed;
            draft.authFailedAt = row.authFailedAt;
          });
        } else {
          this.conversations.insert(row);
        }
      }
      for (const key of existingMessageKeys) {
        if (!incomingMessages.has(key)) {
          this.messages.delete(key);
        }
      }
      for (const row of messageRows) {
        if (existingMessageKeys.has(row.id)) {
          this.messages.update(row.id, (draft) => {
            draft.conversationId = row.conversationId;
            draft.direction = row.direction;
            draft.timestamp = row.timestamp;
            draft.nonce = row.nonce;
            draft.ciphertext = row.ciphertext;
          });
        } else {
          this.messages.insert(row);
        }
      }
    });
    // R4/F6: route through awaitPersistence so a close() racing the reload's
    // commit also drains it.
    await this.awaitPersistence(tx);
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

/**
 * R6/F5: validate a stored/incoming conversation-id hex and return the decoded
 * id. Mirrors the in-memory repo's `decodeConversationIdHex`: rejects non-hex
 * and wrong-length ids with MalformedBundle instead of copying them verbatim.
 */
function decodeRowConversationId(hex: string): ConversationId {
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
 * R4/F1: resolve the id a newly appended message row is stored under (the
 * `messages` collection key). An explicit id (the bundle import/merge path
 * passes the exporter's id so re-importing an overlapping bundle dedups
 * instead of duplicating) is stored verbatim and must be a non-empty string;
 * when the option is absent a fresh UUID is generated, exactly as before the
 * parameter existed.
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

// epochMillis is isolated so tests/reload can stub the clock without touching
// the crypto randomUUID path above.
function epochMillis(): number {
  return Date.now();
}
