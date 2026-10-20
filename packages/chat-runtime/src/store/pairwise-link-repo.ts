import { ctEqual } from "../crypto/ct-equal";
import type { GroupId, GroupMember } from "../group/types";
import { encodePublicKey } from "../protocol/codec";
import { PUBLIC_KEY_BYTES } from "../protocol/limits";
import type { ConversationId, PublicKey } from "../protocol/types";

import { bytesToHex } from "./encoding";
import { StoreError, StoreErrorCode } from "./types";
import type {
  AppendMessageOptions,
  ConversationMessage,
  ConversationRecord,
  ConversationRepository,
  GroupRecord,
  MessageDirection,
  PeerIdentityRecord,
} from "./types";

/**
 * Repository decorator for GROUP-LINK orchestrators (protocol-v2 §3). A
 * pairwise link's orchestrator only ever touches its own derived pairwise
 * conversation id, so EVERY conversation-row/message operation is scoped to
 * bookkeeping the durable store must never hold: pairwise conversations are
 * runtime-only — the broker room ceases when empty, there is no "resume
 * group" flow, and any persisted pairwise row would leak into the resumable
 * sidebar list and the export bundle as a ghost DM. The group transcript
 * likewise lives on the live {@link ChatGroupSession} record, not in the
 * store.
 *
 * What is swallowed (no-op/empty — NEVER throws, so the link flow cannot
 * fail on persistence):
 *
 *   - `createConversation` / `getConversation` / `listConversations`
 *   - `appendMessage` / `getMessages` / `listMessageIds`
 *   - `setDisplayName` / `getDisplayName`
 *   - `clearConversation` / `clearAll` (ephemeral state only — a link has no
 *     authority to wipe the user's durable store)
 *
 * What still reaches the wrapped repository:
 *
 *   - `getPeerIdentity` — a durable pin survives from conversation rows
 *     persisted by earlier builds that DID create pairwise rows; honoring
 *     it keeps the TOFU guarantee against those pins.
 *   - `storePeerIdentity` / `replacePeerIdentity` — attempted against the
 *     wrapped repository so a pin lands wherever a row legitimately exists.
 *     On {@link StoreErrorCode.ConversationNotFound} — the normal case here,
 *     since this decorator never creates rows — the pin falls back to a
 *     session-scoped map, so TOFU still works across link orchestrators
 *     sharing this decorator (a re-signaled link binds the same derived
 *     pairwise id and must see the key the previous link proved).
 *   - `getAuthFailed` — consults the wrapped repository first so a durable
 *     flag on a legacy row is still honored, then the session-scoped set.
 *   - `markAuthFailed` — conversation-row state, so it records only a
 *     session-scoped flag (the durable localStorage flag the orchestrator
 *     writes beside the repo call is outside this interface and unaffected).
 *   - Every GROUP-record method (`storeGroup`/`getGroup`/`listGroups`/...) —
 *     delegated verbatim; group records are the store's own runtime-only
 *     bookkeeping, not per-link state.
 *   - `close` — delegated when the wrapped repository implements it.
 *
 * One instance is shared by every link orchestrator a {@link GroupSession}
 * creates, so the session-scoped pins/flags cover all of that group's links
 * for the session's lifetime.
 */
export class PairwiseLinkRepository implements ConversationRepository {
  private readonly inner: ConversationRepository;
  /** Session-scoped TOFU pins, keyed by the pairwise conversation-id hex. */
  private readonly peerIdentities = new Map<string, PeerIdentityRecord>();
  /** Session-scoped auth-failed flags, keyed the same way. */
  private readonly authFailedIds = new Set<string>();

  constructor(inner: ConversationRepository) {
    this.inner = inner;
  }

  /**
   * No-op: a pairwise link must never persist a conversation row. Returns a
   * synthetic record — the orchestrator ignores the value, but the interface
   * requires one — without touching the store.
   */
  async createConversation(id: ConversationId, createdAt: number): Promise<ConversationRecord> {
    return {
      id,
      createdAt,
      displayName: null,
      peer: null,
      authFailed: false,
      authFailedAt: null,
    };
  }

  /** Always null: pairwise links hold no durable conversation row. */
  async getConversation(id: ConversationId): Promise<ConversationRecord | null> {
    void id;
    return null;
  }

  /** Always empty: pairwise rows are never listable. */
  async listConversations(): Promise<ConversationRecord[]> {
    return [];
  }

  /**
   * No-op: pairwise link traffic is never persisted (the group transcript is
   * the live session's in-memory list). Returns a synthetic message so
   * consumers of the return value — the orchestrator's onMessage dispatch
   * reads `text`/`timestamp` off it — still get a well-formed object.
   */
  async appendMessage(
    id: ConversationId,
    plaintext: string,
    direction: MessageDirection,
    timestamp: number,
    options?: AppendMessageOptions,
  ): Promise<ConversationMessage> {
    return {
      id: messageIdFromOptions(options),
      conversationId: id,
      direction,
      timestamp,
      text: plaintext,
    };
  }

  /** Always empty: no durable history exists for a pairwise link. */
  async getMessages(id: ConversationId): Promise<ConversationMessage[]> {
    void id;
    return [];
  }

  /** Always empty: see {@link getMessages}. */
  async listMessageIds(id: ConversationId): Promise<string[]> {
    void id;
    return [];
  }

  async storePeerIdentity(
    id: ConversationId,
    fingerprint: string,
    publicKey: PublicKey,
  ): Promise<void> {
    const key = bytesToHex(id);
    const pinned = this.peerIdentities.get(key);
    if (pinned !== undefined) {
      // Same TOFU guard as the durable repos: a session-scoped pin must not
      // silently flip to a different key either.
      if (!ctEqual(pinned.publicKey, publicKey)) {
        throw new StoreError(
          StoreErrorCode.PeerIdentityAlreadyPinned,
          "peer identity already pinned for this conversation; refusing to overwrite " +
            "with a different key (TOFU). Use replacePeerIdentity for the trusted " +
            "Replace-mode import path.",
        );
      }
      this.peerIdentities.set(key, { fingerprint, publicKey: clonePublicKey(publicKey) });
      return;
    }
    try {
      // Lands only when the wrapped repo already holds a row for this id
      // (e.g. a pairwise row persisted by an earlier build) — honoring that
      // row keeps the durable pin consistent.
      await this.inner.storePeerIdentity(id, fingerprint, publicKey);
    } catch (err) {
      if (isConversationNotFound(err)) {
        // The normal case: no row exists because this decorator never
        // creates one. Pin session-scoped instead — a later link that
        // re-derives the same pairwise id still gets a TOFU comparison.
        this.peerIdentities.set(key, { fingerprint, publicKey: clonePublicKey(publicKey) });
        return;
      }
      throw err;
    }
  }

  async replacePeerIdentity(
    id: ConversationId,
    fingerprint: string,
    publicKey: PublicKey,
  ): Promise<void> {
    try {
      await this.inner.replacePeerIdentity(id, fingerprint, publicKey);
    } catch (err) {
      if (!isConversationNotFound(err)) throw err;
    }
    this.peerIdentities.set(bytesToHex(id), {
      fingerprint,
      publicKey: clonePublicKey(publicKey),
    });
  }

  async getPeerIdentity(id: ConversationId): Promise<PeerIdentityRecord | null> {
    // The durable pin wins when a row exists (legacy pairwise rows); the
    // session-scoped map covers pins this decorator itself recorded.
    const durable = await this.inner.getPeerIdentity(id);
    if (durable !== null) return durable;
    const pinned = this.peerIdentities.get(bytesToHex(id));
    if (pinned === undefined) return null;
    return { fingerprint: pinned.fingerprint, publicKey: clonePublicKey(pinned.publicKey) };
  }

  /** No-op: a pairwise link has no durable display name. */
  async setDisplayName(id: ConversationId, name: string): Promise<void> {
    void id;
    void name;
  }

  /** Always null: no durable row to label. */
  async getDisplayName(id: ConversationId): Promise<string | null> {
    void id;
    return null;
  }

  /**
   * Session-scoped only: the auth-failed flag is conversation-row state and
   * this decorator never holds rows. The orchestrator's parallel durable
   * write (the localStorage auth-failed store) is NOT routed through this
   * interface, so retry-blocking still survives a reload the same way it
   * does for 1:1.
   */
  async markAuthFailed(id: ConversationId): Promise<void> {
    this.authFailedIds.add(bytesToHex(id));
  }

  async getAuthFailed(id: ConversationId): Promise<boolean> {
    if (this.authFailedIds.has(bytesToHex(id))) return true;
    return await this.inner.getAuthFailed(id);
  }

  /** Drop this id's session-scoped pins/flags; the durable store is untouched. */
  async clearConversation(id: ConversationId): Promise<void> {
    const key = bytesToHex(id);
    this.peerIdentities.delete(key);
    this.authFailedIds.delete(key);
  }

  /**
   * Wipe the decorator's session-scoped state ONLY — a pairwise link has no
   * authority to clear the user's durable store, so this deliberately does
   * not delegate.
   */
  async clearAll(): Promise<void> {
    this.peerIdentities.clear();
    this.authFailedIds.clear();
  }

  // --- Group records: delegated verbatim (runtime-only store metadata) ---

  async storeGroup(record: GroupRecord): Promise<GroupRecord> {
    return await this.inner.storeGroup(record);
  }

  async getGroup(groupId: GroupId): Promise<GroupRecord | null> {
    return await this.inner.getGroup(groupId);
  }

  async updateGroupMembership(
    groupId: GroupId,
    epoch: number,
    members: readonly GroupMember[],
  ): Promise<GroupRecord> {
    return await this.inner.updateGroupMembership(groupId, epoch, members);
  }

  async setGroupDisplayName(groupId: GroupId, name: string | null): Promise<void> {
    await this.inner.setGroupDisplayName(groupId, name);
  }

  async removeGroup(groupId: GroupId): Promise<void> {
    await this.inner.removeGroup(groupId);
  }

  async listGroups(): Promise<GroupRecord[]> {
    return await this.inner.listGroups();
  }

  /** Delegated when the wrapped repository holds releasable resources. */
  close(): Promise<void> | void {
    return this.inner.close?.();
  }
}

/**
 * True iff `err` is the store's typed "no such conversation" signal — the
 * expected rejection when a pass-through write targets a pairwise id that
 * (by design) has no durable row.
 */
function isConversationNotFound(err: unknown): boolean {
  return err instanceof StoreError && err.code === StoreErrorCode.ConversationNotFound;
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

function newMessageId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Same contract as the concrete repos: an explicit id is honored verbatim and
 * must be non-empty; absent, a fresh UUID is generated.
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
