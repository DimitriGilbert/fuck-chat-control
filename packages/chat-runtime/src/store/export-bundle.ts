import { decryptAtRest, deriveKeyFromPassphrase, encryptAtRest } from "../crypto/at-rest";
import type { KdfParams } from "../crypto/at-rest";
import { ctEqual } from "../crypto/ct-equal";
import { CryptoError, CryptoErrorCode } from "../crypto/errors";
import { encodeConversationId, encodePublicKey } from "../protocol/codec";
import { CONVERSATION_ID_BYTES, EXPORT_BUNDLE_VERSION } from "../protocol/limits";
import type { ConversationId } from "../protocol/types";

import { base64ToBytes, bytesToBase64, bytesToHex, hexToBytes } from "./encoding";
import {
  ARGON2_ITERATIONS_MAX,
  ARGON2_ITERATIONS_MIN,
  ARGON2_MEMORY_MAX_BYTES,
  ARGON2_MEMORY_MIN_BYTES,
  ARGON2_PARALLELISM_MAX,
  ARGON2_PARALLELISM_MIN,
  ARGON2_VERSION_ALLOWED,
  MAX_BUNDLE_BYTES,
  MAX_CONVERSATIONS,
  MAX_ENVELOPE_CIPHERTEXT_BYTES,
  MAX_MESSAGES_PER_CONVERSATION,
  MAX_NONCE_BYTES,
  MAX_SALT_BYTES,
} from "./limits";
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
  // R8/F3: cap the raw bundle length up front, before any parsing/allocation.
  if (bundle.length > MAX_BUNDLE_BYTES) {
    throw new StoreError(
      StoreErrorCode.SizeLimitExceeded,
      `bundle length ${bundle.length} exceeds max ${MAX_BUNDLE_BYTES}`,
    );
  }
  const envelope = parseEnvelope(bundle);
  const salt = decodeBoundedBase64(envelope.kdf.salt, MAX_SALT_BYTES, "kdf.salt");
  const nonce = decodeBoundedBase64(envelope.aead.nonce, MAX_NONCE_BYTES, "aead.nonce");
  // R8/F3: cap the decoded ciphertext length BEFORE allocating the
  // Uint8Array — base64ToBytes enforces maxBytes against the pre-decode
  // length calculation, so a hostile envelope cannot wedge the device.
  const ciphertext = decodeBoundedBase64(
    envelope.ciphertext,
    MAX_ENVELOPE_CIPHERTEXT_BYTES,
    "aead.ciphertext",
  );
  // R8/F4: consume the envelope's KDF params (m/t/p/version) instead of
  // silently falling back to module constants. Convert m from BYTES (envelope)
  // to KiB (hash-wasm's memorySize unit) by dividing by 1024.
  const kdfParams = envelopeKdfParams(envelope.kdf);
  const bundleKey = await deriveKeyFromPassphrase(passphrase, salt, kdfParams);
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
    // CR-6: atomic Replace. Snapshot the pre-existing state BEFORE clearAll so
    // a mid-import failure (e.g. an AtRestLockedError thrown by a
    // LockableRepository wrapper mid-loop) can roll the repo back to its
    // pre-import contents. The snapshot is a plaintext in-memory read of the
    // repo (listConversations + getMessages) shaped as ValidatedConversation[];
    // it requires no passphrase and no bundle round-trip, so the restore path
    // is just clearAll + re-populate from the snapshot array.
    const rollback = await snapshotRepoState(repo);
    await repo.clearAll();
    try {
      let messagesImported = 0;
      for (const convo of validated) {
        messagesImported += await populateConversation(repo, convo);
      }
      return {
        conversationsAdded: validated.length,
        conversationsMerged: 0,
        messagesImported,
        conflicts: [],
        deviceIdentity: decodeIdentity(payload.identity),
      };
    } catch (importError) {
      // Rollback: restore the pre-existing state captured before clearAll.
      // Best-effort — if the restore itself throws (e.g. the at-rest key is
      // STILL locked), swallow the restore error and surface the original
      // import error so the caller sees the real root cause.
      try {
        await restoreRepoState(repo, rollback);
      } catch {
        // best-effort; fall through to rethrow the original import error
      }
      throw importError;
    }
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
        // R8/F2: a peer-identity conflict means the incoming conversation is
        // hostile (or at least untrusted). Surface the conflict for UI action
        // but do NOT persist its display name or messages — `continue` skips
        // the setDisplayName + message loop below. The conversation is NOT
        // counted as merged (conversationsMerged stays unchanged) because no
        // incoming content was actually integrated.
        continue;
      }
    }
    conversationsMerged++;
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
  // R8/F4: read m/t/p/version from the envelope (do NOT silently overwrite
  // with module constants). Validation happens in {@link envelopeKdfParams};
  // here we just enforce that they are finite integers so the type narrowing
  // is sound and the validator can apply range checks.
  const mRaw = kdf["m"];
  const tRaw = kdf["t"];
  const pRaw = kdf["p"];
  const versionRaw = kdf["version"];
  if (
    typeof mRaw !== "number" ||
    !Number.isFinite(mRaw) ||
    !Number.isInteger(mRaw) ||
    typeof tRaw !== "number" ||
    !Number.isFinite(tRaw) ||
    !Number.isInteger(tRaw) ||
    typeof pRaw !== "number" ||
    !Number.isFinite(pRaw) ||
    !Number.isInteger(pRaw) ||
    typeof versionRaw !== "number" ||
    !Number.isFinite(versionRaw) ||
    !Number.isInteger(versionRaw)
  ) {
    throw new StoreError(
      StoreErrorCode.MalformedBundle,
      "bundle kdf.m, kdf.t, kdf.p, kdf.version must be integers",
    );
  }
  return {
    v: version,
    kdf: {
      algorithm: kdf["algorithm"] as string,
      version: versionRaw,
      m: mRaw,
      t: tRaw,
      p: pRaw,
      salt: kdf["salt"] as string,
    },
    aead: { algorithm: aead["algorithm"] as string, nonce: aead["nonce"] as string },
    ciphertext: obj["ciphertext"] as string,
  };
}

/**
 * Validate the envelope's Argon2id KDF params against the allowed ranges and
 * return the {@link KdfParams} to feed into {@link deriveKeyFromPassphrase}.
 *
 * NOTE on units: the envelope's `m` is in BYTES (the export path writes
 * ARGON2_MEMORY_BYTES=67108864). hash-wasm's `memorySize` is in KiB. Convert
 * by dividing by 1024. The round-trip test in
 * `bundle-size-limits.test.ts` proves the conversion is correct.
 */
function envelopeKdfParams(kdf: BundleKdf): KdfParams {
  if (kdf.version !== ARGON2_VERSION_ALLOWED) {
    throw new StoreError(
      StoreErrorCode.InvalidKdfParams,
      `unsupported argon2 version ${kdf.version}, expected ${ARGON2_VERSION_ALLOWED}`,
    );
  }
  if (kdf.m < ARGON2_MEMORY_MIN_BYTES || kdf.m > ARGON2_MEMORY_MAX_BYTES) {
    throw new StoreError(
      StoreErrorCode.InvalidKdfParams,
      `argon2 m=${kdf.m} out of range [${ARGON2_MEMORY_MIN_BYTES}, ${ARGON2_MEMORY_MAX_BYTES}]`,
    );
  }
  if (kdf.t < ARGON2_ITERATIONS_MIN || kdf.t > ARGON2_ITERATIONS_MAX) {
    throw new StoreError(
      StoreErrorCode.InvalidKdfParams,
      `argon2 t=${kdf.t} out of range [${ARGON2_ITERATIONS_MIN}, ${ARGON2_ITERATIONS_MAX}]`,
    );
  }
  if (kdf.p < ARGON2_PARALLELISM_MIN || kdf.p > ARGON2_PARALLELISM_MAX) {
    throw new StoreError(
      StoreErrorCode.InvalidKdfParams,
      `argon2 p=${kdf.p} out of range [${ARGON2_PARALLELISM_MIN}, ${ARGON2_PARALLELISM_MAX}]`,
    );
  }
  return {
    memorySizeKiB: Math.trunc(kdf.m / 1024),
    iterations: kdf.t,
    parallelism: kdf.p,
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
  // R8/F3: pre-auth count caps on payload structure. These run AFTER AEAD
  // decryption but BEFORE any persistence, so a (post-auth) large payload is
  // rejected cheaply rather than driving a long appendMessage loop.
  if (payload.conversations.length > MAX_CONVERSATIONS) {
    throw new StoreError(
      StoreErrorCode.SizeLimitExceeded,
      `payload has ${payload.conversations.length} conversations, max ${MAX_CONVERSATIONS}`,
    );
  }
  if (payload.messages.length > MAX_CONVERSATIONS * MAX_MESSAGES_PER_CONVERSATION) {
    throw new StoreError(
      StoreErrorCode.SizeLimitExceeded,
      `payload has ${payload.messages.length} messages, max ${MAX_CONVERSATIONS * MAX_MESSAGES_PER_CONVERSATION}`,
    );
  }
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
    // R8/F3: per-conversation message cap.
    if (owner.messages.length >= MAX_MESSAGES_PER_CONVERSATION) {
      throw new StoreError(
        StoreErrorCode.SizeLimitExceeded,
        `conversation ${raw.conversationId} exceeds ${MAX_MESSAGES_PER_CONVERSATION} messages`,
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

/**
 * CR-6: in-memory plaintext snapshot of the repo's current contents, used as a
 * rollback target for atomic Replace-mode import. Shaped identically to
 * {@link ValidatedConversation} so the restore path can reuse the same
 * populate primitive as the import loop. The snapshot is a pure read of the
 * repo's public interface (listConversations + getMessages) and requires no
 * passphrase; for the in-memory repo this is straightforward. Future durable
 * repos that cannot service a consistent read before clearAll should document
 * the contract (the restore loop calls the same createConversation/
 * appendMessage/replacePeerIdentity primitives the import path uses).
 */
type RepoSnapshot = ValidatedConversation[];

/**
 * Read the repo's current conversations + messages into an in-memory snapshot.
 * Used ONLY by the atomic-Replace path to capture pre-clearAll state.
 */
async function snapshotRepoState(repo: ConversationRepository): Promise<RepoSnapshot> {
  const existing = await repo.listConversations();
  const snapshot: ValidatedConversation[] = [];
  for (const convo of existing) {
    const messages = await repo.getMessages(convo.id);
    snapshot.push({
      id: cloneConversationId(convo.id),
      createdAt: convo.createdAt,
      displayName: convo.displayName,
      peer:
        convo.peer === null
          ? null
          : {
              fingerprint: convo.peer.fingerprint,
              publicKey: encodePublicKey(convo.peer.publicKey),
            },
      messages: messages.map((m) => ({
        id: m.id,
        conversationId: cloneConversationId(m.conversationId),
        direction: m.direction,
        timestamp: m.timestamp,
        text: m.text,
      })),
    });
  }
  return snapshot;
}

/**
 * Restore the repo to the captured snapshot by clearing then re-populating.
 * Called from the atomic-Replace catch path; performs no further snapshotting
 * (the snapshot is already in hand).
 */
async function restoreRepoState(
  repo: ConversationRepository,
  snapshot: RepoSnapshot,
): Promise<void> {
  await repo.clearAll();
  for (const convo of snapshot) {
    await populateConversation(repo, convo);
  }
}

/**
 * Persist a single conversation (create + peer + display name + messages) into
 * the repo via its public interface. Used by both the atomic-Replace import
 * loop and the rollback restore path so the two stay shape-identical. Returns
 * the number of messages appended.
 */
async function populateConversation(
  repo: ConversationRepository,
  convo: ValidatedConversation,
): Promise<number> {
  await repo.createConversation(convo.id, convo.createdAt);
  if (convo.peer !== null) {
    // Replace-mode runs after clearAll (or from a rollback snapshot), so the
    // conversation's peer is null here in practice — but use replacePeerIdentity
    // so the intent is explicit and the call cannot trip the R8/F1 TOFU guard
    // even if a future caller feeds this path a pre-existing conversation.
    await repo.replacePeerIdentity(convo.id, convo.peer.fingerprint, convo.peer.publicKey);
  }
  if (convo.displayName !== null) {
    await repo.setDisplayName(convo.id, convo.displayName);
  }
  let count = 0;
  for (const message of convo.messages) {
    await repo.appendMessage(convo.id, message.text, message.direction, message.timestamp);
    count++;
  }
  return count;
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
  return ctEqual(a.publicKey, b.publicKey);
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

/**
 * Decode a base64 envelope field, enforcing a pre-allocation byte cap and
 * surfacing both malformation and cap violations as typed StoreErrors. R8/F3
 * requires SizeLimitExceeded on cap hits and MalformedBundle on bad base64,
 * so the import path never produces an opaque Error from {@link base64ToBytes}.
 */
function decodeBoundedBase64(input: string, maxBytes: number, field: string): Uint8Array {
  try {
    return base64ToBytes(input, maxBytes);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("exceeding the limit of")) {
      throw new StoreError(
        StoreErrorCode.SizeLimitExceeded,
        `bundle ${field} exceeds max ${maxBytes} bytes: ${message}`,
      );
    }
    throw new StoreError(
      StoreErrorCode.MalformedBundle,
      `bundle ${field} is not valid base64: ${message}`,
    );
  }
}
