import type { AtRestKey } from "../crypto/types";
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
}

export interface IdentityConflict {
  readonly conversationId: ConversationId;
  readonly existing: PeerIdentityRecord;
  readonly incoming: PeerIdentityRecord;
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

export interface SerializedState {
  readonly conversations: readonly SerializedConversation[];
  readonly messages: readonly SerializedConversationMessages[];
}

export interface SerializedConversation {
  readonly id: string;
  readonly createdAt: number;
  readonly displayName: string | null;
  readonly peer: SerializedPeerIdentity | null;
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

export interface ConversationRepository {
  createConversation(id: ConversationId, createdAt: number): Promise<ConversationRecord>;
  getConversation(id: ConversationId): Promise<ConversationRecord | null>;
  listConversations(): Promise<ConversationRecord[]>;
  appendMessage(
    id: ConversationId,
    plaintext: string,
    direction: MessageDirection,
    timestamp: number,
  ): Promise<ConversationMessage>;
  getMessages(id: ConversationId): Promise<ConversationMessage[]>;
  storePeerIdentity(id: ConversationId, fingerprint: string, publicKey: PublicKey): Promise<void>;
  getPeerIdentity(id: ConversationId): Promise<PeerIdentityRecord | null>;
  setDisplayName(id: ConversationId, name: string): Promise<void>;
  getDisplayName(id: ConversationId): Promise<string | null>;
  clearConversation(id: ConversationId): Promise<void>;
  clearAll(): Promise<void>;
}

export interface PersistableConversationRepository extends ConversationRepository {
  serialize(): SerializedState;
}

export interface ReloadableConversationRepository extends PersistableConversationRepository {
  reload(atRestKey: AtRestKey, state: SerializedState): Promise<void>;
}
