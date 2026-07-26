import type { AtRestKey } from "../crypto/types";
import type { ConversationId, PublicKey } from "../protocol/types";

import { MessageDirection, StoreError, StoreErrorCode } from "./types";
import type {
  ConversationMessage,
  ConversationRecord,
  ConversationRepository,
  PeerIdentityRecord,
} from "./types";

export interface BrowserDbRepositoryConfig {
  readonly databaseName: string;
  readonly atRestKey: AtRestKey;
}

export class BrowserDbConversationRepository implements ConversationRepository {
  readonly databaseName: string;
  readonly atRestKey: AtRestKey;

  constructor(config: BrowserDbRepositoryConfig) {
    this.databaseName = config.databaseName;
    this.atRestKey = config.atRestKey;
  }

  async createConversation(_id: ConversationId, _createdAt: number): Promise<ConversationRecord> {
    throw this.notImplemented("createConversation");
  }

  async getConversation(_id: ConversationId): Promise<ConversationRecord | null> {
    throw this.notImplemented("getConversation");
  }

  async listConversations(): Promise<ConversationRecord[]> {
    throw this.notImplemented("listConversations");
  }

  async appendMessage(
    _id: ConversationId,
    _plaintext: string,
    _direction: MessageDirection,
    _timestamp: number,
  ): Promise<ConversationMessage> {
    throw this.notImplemented("appendMessage");
  }

  async getMessages(_id: ConversationId): Promise<ConversationMessage[]> {
    throw this.notImplemented("getMessages");
  }

  async storePeerIdentity(
    _id: ConversationId,
    _fingerprint: string,
    _publicKey: PublicKey,
  ): Promise<void> {
    throw this.notImplemented("storePeerIdentity");
  }

  async replacePeerIdentity(
    _id: ConversationId,
    _fingerprint: string,
    _publicKey: PublicKey,
  ): Promise<void> {
    throw this.notImplemented("replacePeerIdentity");
  }

  async getPeerIdentity(_id: ConversationId): Promise<PeerIdentityRecord | null> {
    throw this.notImplemented("getPeerIdentity");
  }

  async setDisplayName(_id: ConversationId, _name: string): Promise<void> {
    throw this.notImplemented("setDisplayName");
  }

  async getDisplayName(_id: ConversationId): Promise<string | null> {
    throw this.notImplemented("getDisplayName");
  }

  async markAuthFailed(_id: ConversationId): Promise<void> {
    throw this.notImplemented("markAuthFailed");
  }

  async getAuthFailed(_id: ConversationId): Promise<boolean> {
    throw this.notImplemented("getAuthFailed");
  }

  async clearConversation(_id: ConversationId): Promise<void> {
    throw this.notImplemented("clearConversation");
  }

  async clearAll(): Promise<void> {
    throw this.notImplemented("clearAll");
  }

  private notImplemented(method: string): StoreError {
    return new StoreError(
      StoreErrorCode.NotImplemented,
      `BrowserDbConversationRepository.${method} is not wired in this phase ` +
        `(database "${this.databaseName}"). Browser persistence uses TanStack DB ` +
        "collections backed by @tanstack/browser-db-sqlite-persistence over " +
        "wa-sqlite/OPFS in a dedicated Web Worker, introduced in Phase 9/10. " +
        "Use InMemoryConversationRepository for Node-runnable tests.",
    );
  }
}
