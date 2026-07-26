import type { ConversationId, PublicKey } from "@/features/chat/protocol/types";

import { MessageDirection } from "./types";
import type {
  ConversationMessage,
  ConversationRecord,
  ConversationRepository,
  PeerIdentityRecord,
} from "./types";
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
 */
export class LockableRepository implements ConversationRepository {
  private readonly inner: ConversationRepository;
  private readonly manager: AtRestKeyManager;

  constructor(inner: ConversationRepository, manager: AtRestKeyManager) {
    this.inner = inner;
    this.manager = manager;
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
  ): Promise<ConversationMessage> {
    this.assertUnlocked();
    return await this.inner.appendMessage(id, plaintext, direction, timestamp);
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
    this.assertUnlocked();
    await this.inner.markAuthFailed(id);
  }

  async getAuthFailed(id: ConversationId): Promise<boolean> {
    this.assertUnlocked();
    return await this.inner.getAuthFailed(id);
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
