import type { ConversationId, PublicKey } from "../protocol/types";

import { getAuthFailedDurable } from "./auth-failed-store";
import { MessageDirection } from "./types";
import type {
  AppendMessageOptions,
  ConversationMessage,
  ConversationRecord,
  ConversationRepository,
  PeerIdentityRecord,
} from "./types";
import type { AtRestKey } from "../crypto/types";
import type { AtRestKeyManager } from "../runtime/at-rest-key-manager";
import { AtRestLockedError } from "../runtime/at-rest-key-manager";

/**
 * Authoritative at-rest lock gate. Every ciphertext-touching
 * {@link ConversationRepository} call is routed through this wrapper, which
 * throws {@link AtRestLockedError} while the {@link AtRestKeyManager} reports
 * the key is locked.
 *
 * WHY A WRAPPER (not key rotation): reconstructing the repository on every
 * unlock would either drop the in-memory store (InMemoryConversationRepository)
 * or re-query TanStack DB, and it would scatter lock checks across every
 * caller. The wrapper keeps the lock check in one auditable place and lets the
 * underlying repository stay constructed for the controller's lifetime.
 *
 * The wrapper delegates to the real repository, so it intentionally does NOT
 * implement {@link PersistableConversationRepository} — serialization is a
 * repository-lifetime operation owned by the bundle exporter, which holds the
 * real repo reference and is only invoked while unlocked by contract.
 *
 * AUTH-FAILED HANDLING (SEC-2): the auth-failed flag is plain metadata, not
 * ciphertext, so writing it does not require the at-rest key. To avoid
 * crashing session-start hydration with {@link AtRestLockedError} when the
 * manager is locked, {@link markAuthFailed} and {@link getAuthFailed} are
 * special-cased: while locked, `markAuthFailed` queues the id into
 * {@link pendingAuthFailedWrites} (the durable store from
 * `auth-failed-store.ts` carries the cross-session truth regardless), and
 * `getAuthFailed` falls back to the durable store. On unlock, the manager's
 * `onUnlock` callback fires {@link flushPendingAuthFailed}, which replays the
 * queued ids into the inner repo.
 *
 * HEAP-READ-WHILE-LOCKED (CR-7): the inner repository holds the at-rest key
 * in a mutable field (see {@link InMemoryConversationRepository.atRestKey}).
 * The functional lock above prevents the repo from being USED while locked,
 * but the key bytes remain live in the JS heap — an attacker who can read the
 * heap while the manager is locked could recover them. The constructor
 * registers an `onLock` listener that calls
 * {@link InMemoryConversationRepository.zeroizeAtRestKey} on the unlocked→
 * locked transition, overwriting the bytes with zeros and dropping the
 * reference. The paired `onUnlock` listener calls
 * {@link InMemoryConversationRepository.resetAtRestKey} with the manager's
 * repopulated key, so the inner repo resumes operation after unlock. This is
 * defense-in-depth: the authoritative gate stays in {@link assertUnlocked}.
 */
export class LockableRepository implements ConversationRepository {
  private readonly inner: ConversationRepository;
  private readonly manager: AtRestKeyManager;
  /**
   * Conversation ids whose `markAuthFailed` was queued while the manager was
   * locked. Flushed by {@link flushPendingAuthFailed} on the locked→unlocked
   * transition. Plain metadata only — the durable localStorage store is the
   * cross-session source of truth.
   */
  private readonly pendingAuthFailedWrites = new Set<ConversationId>();
  /**
   * Optional sink for unexpected (non-lock) errors encountered while flushing
   * pending auth-failed writes. Wired by the controller/orchestrator to
   * surface genuine storage failures instead of swallowing them.
   */
  private flushErrorSink: ((err: unknown) => void) | null = null;

  constructor(inner: ConversationRepository, manager: AtRestKeyManager) {
    this.inner = inner;
    this.manager = manager;
    // Register for the locked→unlocked transition once. The manager owns the
    // callback set; the unsubscribe is implicitly the lifetime of this wrapper
    // (the wrapper and manager share the controller's lifetime).
    manager.onUnlock(() => {
      // CR-7: re-acquire the at-rest key BEFORE flushing pending writes. The
      // manager has already repopulated its own reference from storage (auto
      // mode) or unwrapped it from the passphrase KEK (passphrase mode); we
      // hand the fresh key to the inner repo so its previously-zeroized
      // reference is restored. This keeps CR-7's defense-in-depth (key bytes
      // wiped while locked) WITHOUT regressing the post-unlock path.
      this.resetInnerAtRestKey();
      this.flushPendingAuthFailed();
    });
    // CR-7: register the unlocked→locked listener that zeroizes the inner
    // repo's at-rest key. The inner repo is constructed with the at-rest key
    // (InMemoryConversationRepository holds it in a mutable field); while the
    // functional lock is enforced by {@link assertUnlocked} below, the inner
    // key stays stale-but-live in the JS heap. Zeroizing it on lock is
    // defense-in-depth: an attacker who reads the heap while the manager is
    // locked cannot recover the live key from the inner repo. The paired
    // onUnlock listener above repopulates the key on the next successful
    // unlock, so the inner repo resumes operation cleanly.
    manager.onLock(() => {
      this.zeroizeInnerAtRestKey();
    });
  }

  /**
   * Wire a sink for unexpected (non-{@link AtRestLockedError}) failures during
   * {@link flushPendingAuthFailed}. Called by the orchestrator/controller so a
   * genuine storage failure during replay is surfaced to `handlers.onError`
   * instead of swallowed.
   */
  setFlushErrorSink(sink: (err: unknown) => void): void {
    this.flushErrorSink = sink;
  }

  /** True iff the underlying at-rest key is currently locked. */
  isLocked(): boolean {
    return this.manager.isLocked();
  }

  /** Throws {@link AtRestLockedError} when the manager is locked. */
  private assertUnlocked(): void {
    if (this.manager.isLocked()) {
      throw new AtRestLockedError();
    }
  }

  async createConversation(id: ConversationId, createdAt: number): Promise<ConversationRecord> {
    this.assertUnlocked();
    return await this.inner.createConversation(id, createdAt);
  }

  async getConversation(id: ConversationId): Promise<ConversationRecord | null> {
    this.assertUnlocked();
    return await this.inner.getConversation(id);
  }

  async listConversations(): Promise<ConversationRecord[]> {
    this.assertUnlocked();
    return await this.inner.listConversations();
  }

  async appendMessage(
    id: ConversationId,
    plaintext: string,
    direction: MessageDirection,
    timestamp: number,
    options?: AppendMessageOptions,
  ): Promise<ConversationMessage> {
    this.assertUnlocked();
    return await this.inner.appendMessage(id, plaintext, direction, timestamp, options);
  }

  async getMessages(id: ConversationId): Promise<ConversationMessage[]> {
    this.assertUnlocked();
    return await this.inner.getMessages(id);
  }

  async storePeerIdentity(
    id: ConversationId,
    fingerprint: string,
    publicKey: PublicKey,
  ): Promise<void> {
    this.assertUnlocked();
    await this.inner.storePeerIdentity(id, fingerprint, publicKey);
  }

  async replacePeerIdentity(
    id: ConversationId,
    fingerprint: string,
    publicKey: PublicKey,
  ): Promise<void> {
    this.assertUnlocked();
    await this.inner.replacePeerIdentity(id, fingerprint, publicKey);
  }

  async getPeerIdentity(id: ConversationId): Promise<PeerIdentityRecord | null> {
    this.assertUnlocked();
    return await this.inner.getPeerIdentity(id);
  }

  async setDisplayName(id: ConversationId, name: string): Promise<void> {
    this.assertUnlocked();
    await this.inner.setDisplayName(id, name);
  }

  async getDisplayName(id: ConversationId): Promise<string | null> {
    this.assertUnlocked();
    return await this.inner.getDisplayName(id);
  }

  async markAuthFailed(id: ConversationId): Promise<void> {
    if (this.manager.isLocked()) {
      // SEC-2: the auth-failed flag is plain metadata; do not crash hydration
      // or fail the handshake by rethrowing AtRestLockedError. Queue the id;
      // the durable store from auth-failed-store.ts already carries the
      // cross-session truth, and {@link flushPendingAuthFailed} will land the
      // in-repo flag on unlock.
      this.pendingAuthFailedWrites.add(id);
      return;
    }
    try {
      await this.inner.markAuthFailed(id);
    } catch (err) {
      if (err instanceof AtRestLockedError) {
        // The manager re-locked between our isLocked() check and the inner
        // write (concurrent lock()). Queue and let the next unlock flush it.
        this.pendingAuthFailedWrites.add(id);
        return;
      }
      throw err;
    }
  }

  async getAuthFailed(id: ConversationId): Promise<boolean> {
    if (this.manager.isLocked()) {
      // SEC-2: hydration must not throw while locked. Fall back to the durable
      // store (the cross-session truth) plus any write queued in this session.
      return this.pendingAuthFailedWrites.has(id) || (await getAuthFailedDurable(id));
    }
    try {
      return await this.inner.getAuthFailed(id);
    } catch (err) {
      if (err instanceof AtRestLockedError) {
        return this.pendingAuthFailedWrites.has(id) || (await getAuthFailedDurable(id));
      }
      throw err;
    }
  }

  /**
   * Replay queued `markAuthFailed` ids into the inner repo once the manager has
   * unlocked. Called automatically from the manager's `onUnlock` callback.
   * Best-effort: non-{@link AtRestLockedError} failures are forwarded to the
   * {@link flushErrorSink} (when wired); a concurrent re-lock re-queues an id
   * for the next unlock instead of dropping it.
   */
  /**
   * CR-7: zeroize the inner repo's at-rest key reference on the unlocked→
   * locked transition. Feature-checks for the optional
   * {@link ReloadableConversationRepository.zeroizeAtRestKey} method so a
   * future repository implementation that does not hold an at-rest key in a
   * mutable field can opt out cleanly. The authoritative lock continues to
   * live in {@link assertUnlocked}; this is defense-in-depth for the
   * heap-read-while-locked threat.
   */
  private zeroizeInnerAtRestKey(): void {
    const maybe = this.inner as { zeroizeAtRestKey?(): void };
    if (typeof maybe.zeroizeAtRestKey === "function") {
      maybe.zeroizeAtRestKey();
    }
  }

  /**
   * CR-7: repopulate the inner repo's at-rest key reference on the locked→
   * unlocked transition. Pairs with {@link zeroizeInnerAtRestKey}: the manager
   * has already repopulated its own key reference; we hand the fresh key to
   * the inner repo so its previously-zeroized reference is restored.
   * Feature-checks the optional {@link ReloadableConversationRepository.resetAtRestKey}
   * method; the authoritative key source is {@link AtRestKeyManager.get},
   * which throws if the manager is still locked (the unlock listener only
   * fires after the manager flips to unlocked, so this is safe).
   */
  private resetInnerAtRestKey(): void {
    const maybe = this.inner as { resetAtRestKey?(key: AtRestKey): void };
    if (typeof maybe.resetAtRestKey === "function") {
      maybe.resetAtRestKey(this.manager.get());
    }
  }

  flushPendingAuthFailed(): void {
    if (this.pendingAuthFailedWrites.size === 0) return;
    // Snapshot then clear: subsequent markAuthFailed calls during this dispatch
    // (or a concurrent re-lock) re-queue cleanly.
    const queued = Array.from(this.pendingAuthFailedWrites);
    this.pendingAuthFailedWrites.clear();
    for (const id of queued) {
      void this.inner
        .markAuthFailed(id)
        .then(() => {
          // success: nothing to surface. The flag is now durable in the repo.
        })
        .catch((err: unknown) => {
          if (err instanceof AtRestLockedError) {
            // Re-locked mid-flush: re-queue for the next unlock.
            this.pendingAuthFailedWrites.add(id);
            return;
          }
          // Unexpected storage failure: forward to the sink if wired.
          this.flushErrorSink?.(err);
        });
    }
  }

  async clearConversation(id: ConversationId): Promise<void> {
    this.assertUnlocked();
    await this.inner.clearConversation(id);
  }

  async clearAll(): Promise<void> {
    this.assertUnlocked();
    await this.inner.clearAll();
  }
}
