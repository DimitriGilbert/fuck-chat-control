import { decryptAtRest, deriveKeyFromPassphrase, encryptAtRest } from "../crypto/at-rest";
import { CryptoError, CryptoErrorCode } from "../crypto/errors";
import { encodeConversationId, encodePublicKey } from "../protocol/codec";
import { CONVERSATION_ID_BYTES, EXPORT_BUNDLE_VERSION } from "../protocol/limits";
import type { ConversationId } from "../protocol/types";

import { base64ToBytes, bytesToBase64, bytesToHex, hexToBytes } from "./encoding";
import { MessageDirection, MESSAGE_DIRECTION_VALUES, StoreError, StoreErrorCode } from "./types";
import type {
  ConversationMessage,
  ConversationRecord,
  ConversationRepository,
  IdentityConflict,
  ImportResult,
  PeerIdentityRecord,
} from "./types";

const ARGON2_VERSION = 19;
const ARGON2_MEMORY_BYTES = 67108864;
const ARGON2_ITERATIONS = 3;
const ARGON2_PARALLELISM = 1;
const ARGON2_SALT_BYTES = 16;
const KDF_ALGORITHM = "argon2id";
const AEAD_ALGORITHM = "aes-256-gcm";

export const ImportMode = {
  Merge: "merge",
  Replace: "replace",
} as const;
export type ImportMode = (typeof ImportMode)[keyof typeof ImportMode];

interface BundleKdf {
  readonly algorithm: string;
  readonly version: number;
  readonly m: number;
  readonly t: number;
  readonly p: number;
  readonly salt: string;
}

interface BundleAead {
  readonly algorithm: string;
  readonly nonce: string;
}

interface ExportBundle {
  readonly v: number;
  readonly kdf: BundleKdf;
  readonly aead: BundleAead;
  readonly ciphertext: string;
}

interface PayloadPeer {
  readonly fingerprint: string;
  readonly publicKey: string;
}

interface PayloadConversation {
  readonly id: string;
  readonly createdAt: number;
  readonly displayName: string | null;
  readonly peer: PayloadPeer | null;
}

interface PayloadMessage {
  readonly conversationId: string;
  readonly id: string;
  readonly direction: MessageDirection;
  readonly timestamp: number;
  readonly text: string;
}

interface ParsedPayload {
  readonly identity: string | null;
  readonly conversations: readonly PayloadConversation[];
  readonly messages: readonly PayloadMessage[];
}

interface ValidatedConversation {
  readonly id: ConversationId;
  readonly createdAt: number;
  readonly displayName: string | null;
  readonly peer: PeerIdentityRecord | null;
  readonly messages: readonly ConversationMessage[];
}

export async function exportBundle(
  passphrase: string,
  repo: ConversationRepository,
  deviceIdentityPrivateKey?: Uint8Array | null,
): Promise<string> {
  const conversations = await repo.listConversations();
  const payloadConversations: PayloadConversation[] = [];
  const payloadMessages: PayloadMessage[] = [];
  for (const convo of conversations) {
    payloadConversations.push(toPayloadConversation(convo));
    const messages = await repo.getMessages(convo.id);
    const convoHex = bytesToHex(convo.id);
    for (const message of messages) {
      payloadMessages.push({
        conversationId: convoHex,
        id: message.id,
        direction: message.direction,
        timestamp: message.timestamp,
        text: message.text,
      });
    }
  }
  const payload = {
    identity:
      deviceIdentityPrivateKey === undefined || deviceIdentityPrivateKey === null
        ? null
        : bytesToBase64(deviceIdentityPrivateKey),
    conversations: payloadConversations,
    messages: payloadMessages,
  };
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const salt = randomSalt();
  const bundleKey = await deriveKeyFromPassphrase(passphrase, salt);
  const sealed = await encryptAtRest(bundleKey, payloadBytes);
  const bundle: ExportBundle = {
    v: EXPORT_BUNDLE_VERSION,
    kdf: {
      algorithm: KDF_ALGORITHM,
      version: ARGON2_VERSION,
      m: ARGON2_MEMORY_BYTES,
      t: ARGON2_ITERATIONS,
      p: ARGON2_PARALLELISM,
      salt: bytesToBase64(salt),
    },
    aead: { algorithm: AEAD_ALGORITHM, nonce: bytesToBase64(sealed.nonce) },
    ciphertext: bytesToBase64(sealed.ciphertext),
  };
  return JSON.stringify(bundle);
}

export async function importBundle(
  passphrase: string,
  bundle: string,
  repo: ConversationRepository,
  mode: ImportMode,
): Promise<ImportResult> {
  const envelope = parseEnvelope(bundle);
  const salt = base64ToBytes(envelope.kdf.salt);
  const nonce = base64ToBytes(envelope.aead.nonce);
  const ciphertext = base64ToBytes(envelope.ciphertext);
  const bundleKey = await deriveKeyFromPassphrase(passphrase, salt);
  let payloadBytes: Uint8Array;
  try {
    payloadBytes = await decryptAtRest(bundleKey, nonce, ciphertext);
  } catch (err) {
    if (err instanceof CryptoError && err.code === CryptoErrorCode.AuthenticationFailed) {
      throw new StoreError(StoreErrorCode.WrongPassphrase, "wrong passphrase or tampered bundle");
    }
    throw err;
  }
  const payload = parsePayload(payloadBytes);
  const validated = validateConversations(payload);
  if (mode === ImportMode.Replace) {
    await repo.clearAll();
    let messagesImported = 0;
    for (const convo of validated) {
      await repo.createConversation(convo.id, convo.createdAt);
      if (convo.peer !== null) {
        await repo.storePeerIdentity(convo.id, convo.peer.fingerprint, convo.peer.publicKey);
      }
      if (convo.displayName !== null) {
        await repo.setDisplayName(convo.id, convo.displayName);
      }
      for (const message of convo.messages) {
        await repo.appendMessage(convo.id, message.text, message.direction, message.timestamp);
        messagesImported++;
      }
    }
    return {
      conversationsAdded: validated.length,
      conversationsMerged: 0,
      messagesImported,
      conflicts: [],
      deviceIdentity: decodeIdentity(payload.identity),
    };
  }
  const conflicts: IdentityConflict[] = [];
  let conversationsAdded = 0;
  let conversationsMerged = 0;
  let messagesImported = 0;
  for (const convo of validated) {
    const existing = await repo.getConversation(convo.id);
    if (existing === null) {
      await repo.createConversation(convo.id, convo.createdAt);
      if (convo.peer !== null) {
        await repo.storePeerIdentity(convo.id, convo.peer.fingerprint, convo.peer.publicKey);
      }
      if (convo.displayName !== null) {
        await repo.setDisplayName(convo.id, convo.displayName);
      }
      for (const message of convo.messages) {
        await repo.appendMessage(convo.id, message.text, message.direction, message.timestamp);
        messagesImported++;
      }
      conversationsAdded++;
      continue;
    }
    conversationsMerged++;
    const existingPeer = await repo.getPeerIdentity(convo.id);
    if (convo.peer !== null) {
      if (existingPeer === null) {
        await repo.storePeerIdentity(convo.id, convo.peer.fingerprint, convo.peer.publicKey);
      } else if (!peerIdentityEqual(existingPeer, convo.peer)) {
        conflicts.push({
          conversationId: cloneConversationId(convo.id),
          existing: existingPeer,
          incoming: convo.peer,
        });
      }
    }
    if (existing.displayName === null && convo.displayName !== null) {
      await repo.setDisplayName(convo.id, convo.displayName);
    }
    const existingMessages = await repo.getMessages(convo.id);
    const existingIds = new Set(existingMessages.map((m) => m.id));
    for (const message of convo.messages) {
      if (existingIds.has(message.id)) continue;
      await repo.appendMessage(convo.id, message.text, message.direction, message.timestamp);
      messagesImported++;
    }
  }
  return {
    conversationsAdded,
    conversationsMerged,
    messagesImported,
    conflicts,
    deviceIdentity: decodeIdentity(payload.identity),
  };
}

function toPayloadConversation(convo: ConversationRecord): PayloadConversation {
  return {
    id: bytesToHex(convo.id),
    createdAt: convo.createdAt,
    displayName: convo.displayName,
    peer:
      convo.peer === null
        ? null
        : {
            fingerprint: convo.peer.fingerprint,
            publicKey: bytesToBase64(convo.peer.publicKey),
          },
  };
}

function parseEnvelope(bundle: string): ExportBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bundle);
  } catch {
    throw new StoreError(StoreErrorCode.MalformedBundle, "bundle is not valid JSON");
  }
  const obj = parsed as Record<string, unknown>;
  if (obj === null || typeof obj !== "object") {
    throw new StoreError(StoreErrorCode.MalformedBundle, "bundle envelope must be an object");
  }
  const version = obj["v"];
  if (version !== EXPORT_BUNDLE_VERSION) {
    throw new StoreError(
      StoreErrorCode.UnsupportedBundleVersion,
      `unsupported bundle version ${String(version)}, expected ${EXPORT_BUNDLE_VERSION}`,
    );
  }
  const kdf = obj["kdf"] as Record<string, unknown> | undefined;
  const aead = obj["aead"] as Record<string, unknown> | undefined;
  if (kdf === undefined || aead === undefined) {
    throw new StoreError(StoreErrorCode.MalformedBundle, "bundle missing kdf or aead field");
  }
  if (kdf["algorithm"] !== KDF_ALGORITHM) {
    throw new StoreError(
      StoreErrorCode.MalformedBundle,
      `unsupported kdf algorithm ${String(kdf["algorithm"])}`,
    );
  }
  if (aead["algorithm"] !== AEAD_ALGORITHM) {
    throw new StoreError(
      StoreErrorCode.MalformedBundle,
      `unsupported aead algorithm ${String(aead["algorithm"])}`,
    );
  }
  if (typeof kdf["salt"] !== "string" || typeof aead["nonce"] !== "string") {
    throw new StoreError(
      StoreErrorCode.MalformedBundle,
      "bundle kdf.salt and aead.nonce must be strings",
    );
  }
  if (typeof obj["ciphertext"] !== "string") {
    throw new StoreError(StoreErrorCode.MalformedBundle, "bundle ciphertext must be a string");
  }
  return {
    v: version,
    kdf: {
      algorithm: kdf["algorithm"] as string,
      version: ARGON2_VERSION,
      m: ARGON2_MEMORY_BYTES,
      t: ARGON2_ITERATIONS,
      p: ARGON2_PARALLELISM,
      salt: kdf["salt"] as string,
    },
    aead: { algorithm: aead["algorithm"] as string, nonce: aead["nonce"] as string },
    ciphertext: obj["ciphertext"] as string,
  };
}

function parsePayload(bytes: Uint8Array): ParsedPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new StoreError(StoreErrorCode.MalformedBundle, "bundle payload is not valid JSON");
  }
  const obj = parsed as Record<string, unknown>;
  if (obj === null || typeof obj !== "object") {
    throw new StoreError(StoreErrorCode.MalformedBundle, "bundle payload must be an object");
  }
  const identity = obj["identity"];
  if (identity !== null && typeof identity !== "string") {
    throw new StoreError(
      StoreErrorCode.MalformedBundle,
      "payload identity must be a string or null",
    );
  }
  const conversationsRaw = obj["conversations"];
  if (!Array.isArray(conversationsRaw)) {
    throw new StoreError(StoreErrorCode.MalformedBundle, "payload conversations must be an array");
  }
  const messagesRaw = obj["messages"];
  if (!Array.isArray(messagesRaw)) {
    throw new StoreError(StoreErrorCode.MalformedBundle, "payload messages must be an array");
  }
  return {
    identity: identity as string | null,
    conversations: conversationsRaw as readonly PayloadConversation[],
    messages: messagesRaw as readonly PayloadMessage[],
  };
}

function validateConversations(payload: ParsedPayload): ValidatedConversation[] {
  const byHex = new Map<string, MutableConversation>();
  for (const raw of payload.conversations) {
    const id = decodeConversationIdHex(raw.id);
    const peer = raw.peer === null ? null : decodePeerIdentity(raw.peer);
    byHex.set(raw.id, {
      id,
      createdAt: raw.createdAt,
      displayName: raw.displayName,
      peer,
      messages: [],
    });
  }
  for (const raw of payload.messages) {
    const owner = byHex.get(raw.conversationId);
    if (owner === undefined) {
      throw new StoreError(
        StoreErrorCode.MalformedBundle,
        `payload message references unknown conversation ${raw.conversationId}`,
      );
    }
    owner.messages.push({
      id: raw.id,
      conversationId: cloneConversationId(owner.id),
      direction: assertDirection(raw.direction),
      timestamp: raw.timestamp,
      text: raw.text,
    });
  }
  for (const convo of byHex.values()) {
    convo.messages.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
  }
  return Array.from(byHex.values())
    .map(toValidated)
    .sort((a, b) => a.createdAt - b.createdAt || bytesToHex(a.id).localeCompare(bytesToHex(b.id)));
}

interface MutableConversation {
  id: ConversationId;
  createdAt: number;
  displayName: string | null;
  peer: PeerIdentityRecord | null;
  messages: ConversationMessage[];
}

function toValidated(convo: MutableConversation): ValidatedConversation {
  return {
    id: convo.id,
    createdAt: convo.createdAt,
    displayName: convo.displayName,
    peer: convo.peer,
    messages: convo.messages,
  };
}

function decodePeerIdentity(peer: PayloadPeer): PeerIdentityRecord {
  return {
    fingerprint: peer.fingerprint,
    publicKey: encodePublicKey(base64ToBytes(peer.publicKey)),
  };
}

function decodeIdentity(identity: string | null): Uint8Array | null {
  if (identity === null) return null;
  return base64ToBytes(identity);
}

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

function cloneConversationId(id: ConversationId): ConversationId {
  return encodeConversationId(copyBytes(id, CONVERSATION_ID_BYTES));
}

function peerIdentityEqual(a: PeerIdentityRecord, b: PeerIdentityRecord): boolean {
  if (a.fingerprint !== b.fingerprint) return false;
  if (a.publicKey.length !== b.publicKey.length) return false;
  for (let i = 0; i < a.publicKey.length; i++) {
    if (a.publicKey[i] !== b.publicKey[i]) return false;
  }
  return true;
}

function assertDirection(value: string): MessageDirection {
  const dir = value as MessageDirection;
  if (!MESSAGE_DIRECTION_VALUES.includes(dir)) {
    throw new StoreError(StoreErrorCode.MalformedBundle, `unknown message direction ${value}`);
  }
  return dir;
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

function randomSalt(): Uint8Array {
  const salt = new Uint8Array(ARGON2_SALT_BYTES);
  globalThis.crypto.getRandomValues(salt);
  return salt;
}
