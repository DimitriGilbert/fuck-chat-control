import { describe, expect, it } from "vitest";

import { generateAtRestKey } from "@/features/chat/crypto";
import {
  ImportMode,
  InMemoryConversationRepository,
  StoreError,
  StoreErrorCode,
  exportBundle,
  importBundle,
} from "@/features/chat/store";
import { base64ToBytes, bytesToBase64 } from "@/features/chat/store/encoding";
import {
  ARGON2_ITERATIONS_MAX,
  ARGON2_MEMORY_MAX_BYTES,
  ARGON2_MEMORY_MIN_BYTES,
  ARGON2_PARALLELISM_MAX,
  MAX_BUNDLE_BYTES,
  MAX_CONVERSATIONS,
  MAX_ENVELOPE_CIPHERTEXT_BYTES,
  MAX_MESSAGES_PER_CONVERSATION,
  MAX_NONCE_BYTES,
  MAX_SALT_BYTES,
} from "@/features/chat/store/limits";

import { conversationId } from "./_helpers";

const PASSPHRASE = "correct horse battery staple";

function freshRepo(): InMemoryConversationRepository {
  return new InMemoryConversationRepository(generateAtRestKey());
}

/**
 * Read the envelope object out of an exported bundle string. The export path
 * produces a real envelope we can mutate to construct hostile variants.
 */
function parseEnvelopeObject(bundle: string): {
  v: number;
  kdf: {
    algorithm: string;
    version: number;
    m: number;
    t: number;
    p: number;
    salt: string;
  };
  aead: { algorithm: string; nonce: string };
  ciphertext: string;
} {
  return JSON.parse(bundle) as {
    v: number;
    kdf: {
      algorithm: string;
      version: number;
      m: number;
      t: number;
      p: number;
      salt: string;
    };
    aead: { algorithm: string; nonce: string };
    ciphertext: string;
  };
}

describe("import bundle — pre-auth size bounds (R8/F3)", () => {
  it("rejects a bundle whose raw length exceeds MAX_BUNDLE_BYTES with SizeLimitExceeded", async () => {
    const target = freshRepo();
    // 1 conversation so the export path produces a valid baseline envelope.
    const source = freshRepo();
    await source.createConversation(conversationId(1), 1000);

    const bundle = await exportBundle(PASSPHRASE, source);
    const padding = "X".repeat(MAX_BUNDLE_BYTES);
    const hostile = bundle + padding;

    await expect(
      importBundle(PASSPHRASE, hostile, target, ImportMode.Replace),
    ).rejects.toMatchObject({ code: StoreErrorCode.SizeLimitExceeded });

    // Nothing imported.
    expect((await target.listConversations()).length).toBe(0);
  });

  it("rejects an envelope whose decoded ciphertext exceeds MAX_ENVELOPE_CIPHERTEXT_BYTES", async () => {
    const target = freshRepo();
    const source = freshRepo();
    await source.createConversation(conversationId(1), 1000);
    const bundle = await exportBundle(PASSPHRASE, source);
    const envelope = parseEnvelopeObject(bundle);

    // Construct a base64 string whose decoded length is one byte over the cap.
    // base64 decodes 3 bytes per 4 input chars; pad so decoded length is
    // MAX_ENVELOPE_CIPHERTEXT_BYTES + 1.
    const overBy = MAX_ENVELOPE_CIPHERTEXT_BYTES + 1;
    const inputChars = Math.ceil((overBy * 4) / 3);
    // Round up to a multiple of 4 and pad with 'A' (decodes as 0). The
    // resulting decoded length is >= overBy, so the cap is tripped.
    const chars = inputChars + ((4 - (inputChars % 4)) % 4);
    const huge = "A".repeat(chars);
    envelope.ciphertext = huge;

    await expect(
      importBundle(PASSPHRASE, JSON.stringify(envelope), target, ImportMode.Replace),
    ).rejects.toMatchObject({ code: StoreErrorCode.SizeLimitExceeded });
  });

  it("rejects an envelope whose salt exceeds MAX_SALT_BYTES", async () => {
    const target = freshRepo();
    const source = freshRepo();
    await source.createConversation(conversationId(1), 1000);
    const bundle = await exportBundle(PASSPHRASE, source);
    const envelope = parseEnvelopeObject(bundle);

    // Salt cap is small (64); pad well past it.
    envelope.kdf.salt = bytesToBase64(new Uint8Array(MAX_SALT_BYTES + 1));

    await expect(
      importBundle(PASSPHRASE, JSON.stringify(envelope), target, ImportMode.Replace),
    ).rejects.toMatchObject({ code: StoreErrorCode.SizeLimitExceeded });
  });

  it("rejects an envelope whose nonce exceeds MAX_NONCE_BYTES", async () => {
    const target = freshRepo();
    const source = freshRepo();
    await source.createConversation(conversationId(1), 1000);
    const bundle = await exportBundle(PASSPHRASE, source);
    const envelope = parseEnvelopeObject(bundle);

    envelope.aead.nonce = bytesToBase64(new Uint8Array(MAX_NONCE_BYTES + 1));

    await expect(
      importBundle(PASSPHRASE, JSON.stringify(envelope), target, ImportMode.Replace),
    ).rejects.toMatchObject({ code: StoreErrorCode.SizeLimitExceeded });
  });

  it("base64ToBytes throws WITHOUT allocating when maxBytes is exceeded", () => {
    // The pre-allocation guard: a 64 MiB decoded length would OOM if we
    // allocated first. base64ToBytes must throw before `new Uint8Array`.
    const inputChars = Math.ceil(((MAX_ENVELOPE_CIPHERTEXT_BYTES + 1) * 4) / 3);
    const chars = inputChars + ((4 - (inputChars % 4)) % 4);
    const huge = "A".repeat(chars);
    expect(() => base64ToBytes(huge, MAX_ENVELOPE_CIPHERTEXT_BYTES)).toThrow();
  });

  it("base64ToBytes still round-trips when maxBytes is not exceeded", () => {
    const payload = new Uint8Array([0, 1, 2, 3, 250, 251, 252]);
    const encoded = bytesToBase64(payload);
    const decoded = base64ToBytes(encoded, payload.length);
    expect(Array.from(decoded)).toEqual(Array.from(payload));
  });

  it("rejects a payload with too many conversations", async () => {
    // The conversationId() helper only cycles through 256 distinct ids, so
    // to drive the payload past MAX_CONVERSATIONS we hand-build a bundle
    // payload with MAX_CONVERSATIONS+1 distinct 16-byte ids and re-encrypt
    // it under the same passphrase. The export path round-trip is the proof
    // that the structure is well-formed (the only mutation is the count).
    const target = freshRepo();
    const source = freshRepo();
    await source.createConversation(conversationId(1), 1000);
    const validBundle = await exportBundle(PASSPHRASE, source);
    const envelope = parseEnvelopeObject(validBundle);

    // Decrypt the existing payload to recover a valid structure, then
    // hand-build a hostile payload that exceeds the cap. We re-encrypt with
    // the SAME kdf params so the import path's key derivation matches.
    const { decryptAtRest, deriveKeyFromPassphrase, encryptAtRest } = await import(
      "@/features/chat/crypto/at-rest"
    );
    const salt = base64ToBytes(envelope.kdf.salt, MAX_SALT_BYTES);
    const nonce = base64ToBytes(envelope.aead.nonce, MAX_NONCE_BYTES);
    const ciphertext = base64ToBytes(envelope.ciphertext, MAX_ENVELOPE_CIPHERTEXT_BYTES);
    const kdfParams = {
      memorySizeKiB: Math.trunc(envelope.kdf.m / 1024),
      iterations: envelope.kdf.t,
      parallelism: envelope.kdf.p,
    };
    const key = await deriveKeyFromPassphrase(PASSPHRASE, salt, kdfParams);
    const plain = await decryptAtRest(key, nonce, ciphertext);
    const parsed = JSON.parse(new TextDecoder().decode(plain)) as {
      identity: string | null;
      conversations: unknown[];
      messages: unknown[];
    };

    // Build MAX_CONVERSATIONS+1 distinct conversation entries. Each id is a
    // unique 16-byte hex string (32 hex chars).
    const hostileConversations: { id: string; createdAt: number; displayName: null; peer: null }[] =
      [];
    for (let i = 0; i < MAX_CONVERSATIONS + 1; i++) {
      const hex = i.toString(16).padStart(32, "0");
      hostileConversations.push({ id: hex, createdAt: 1000 + i, displayName: null, peer: null });
    }
    const hostilePayload = new TextEncoder().encode(
      JSON.stringify({ ...parsed, conversations: hostileConversations }),
    );
    const sealed = await encryptAtRest(key, hostilePayload);
    const hostileBundle = JSON.stringify({
      ...envelope,
      aead: { ...envelope.aead, nonce: bytesToBase64(sealed.nonce) },
      ciphertext: bytesToBase64(sealed.ciphertext),
    });

    await expect(
      importBundle(PASSPHRASE, hostileBundle, target, ImportMode.Replace),
    ).rejects.toMatchObject({ code: StoreErrorCode.SizeLimitExceeded });
  });

  it("rejects a payload whose single conversation exceeds MAX_MESSAGES_PER_CONVERSATION", async () => {
    // Same hand-built-payload approach: avoid the multi-second cost of
    // appending MAX+1 messages through the source repo.
    const target = freshRepo();
    const source = freshRepo();
    await source.createConversation(conversationId(1), 1000);
    const validBundle = await exportBundle(PASSPHRASE, source);
    const envelope = parseEnvelopeObject(validBundle);

    const { decryptAtRest, deriveKeyFromPassphrase, encryptAtRest } = await import(
      "@/features/chat/crypto/at-rest"
    );
    const salt = base64ToBytes(envelope.kdf.salt, MAX_SALT_BYTES);
    const nonce = base64ToBytes(envelope.aead.nonce, MAX_NONCE_BYTES);
    const ciphertext = base64ToBytes(envelope.ciphertext, MAX_ENVELOPE_CIPHERTEXT_BYTES);
    const kdfParams = {
      memorySizeKiB: Math.trunc(envelope.kdf.m / 1024),
      iterations: envelope.kdf.t,
      parallelism: envelope.kdf.p,
    };
    const key = await deriveKeyFromPassphrase(PASSPHRASE, salt, kdfParams);
    const plain = await decryptAtRest(key, nonce, ciphertext);
    const parsed = JSON.parse(new TextDecoder().decode(plain)) as {
      identity: string | null;
      conversations: unknown[];
      messages: unknown[];
    };

    const convoId = "00".repeat(16);
    const hostileMessages = [];
    for (let i = 0; i <= MAX_MESSAGES_PER_CONVERSATION; i++) {
      hostileMessages.push({
        conversationId: convoId,
        id: `m-${i}`,
        direction: "sent",
        timestamp: 1100 + i,
        text: `m-${i}`,
      });
    }
    const hostilePayload = new TextEncoder().encode(
      JSON.stringify({
        ...parsed,
        conversations: [{ id: convoId, createdAt: 1000, displayName: null, peer: null }],
        messages: hostileMessages,
      }),
    );
    const sealed = await encryptAtRest(key, hostilePayload);
    const hostileBundle = JSON.stringify({
      ...envelope,
      aead: { ...envelope.aead, nonce: bytesToBase64(sealed.nonce) },
      ciphertext: bytesToBase64(sealed.ciphertext),
    });

    await expect(
      importBundle(PASSPHRASE, hostileBundle, target, ImportMode.Replace),
    ).rejects.toMatchObject({ code: StoreErrorCode.SizeLimitExceeded });
  });
});

describe("import bundle — KDF envelope params consumed (R8/F4)", () => {
  it("round-trips a bundle and proves the bytes→KiB conversion is correct", async () => {
    // The export path writes m in BYTES (ARGON2_MEMORY_BYTES = 67108864).
    // The import path reads m from the envelope, converts BYTES → KiB
    // (m / 1024), and feeds the result into deriveKeyFromPassphrase. If the
    // conversion were wrong, the derived key would differ and AEAD auth would
    // fail with WrongPassphrase. A successful round-trip proves the
    // conversion is correct.
    const source = freshRepo();
    await source.createConversation(conversationId(1), 1000);
    await source.appendMessage(conversationId(1), "round-trip", "sent", 1100);
    const bundle = await exportBundle(PASSPHRASE, source);

    const envelope = parseEnvelopeObject(bundle);
    // The envelope writes m in BYTES. Convert and assert it equals the KiB
    // constant the at-rest module uses (65536 KiB == 67108864 bytes).
    expect(envelope.kdf.m).toBe(67108864);
    expect(Math.trunc(envelope.kdf.m / 1024)).toBe(65536);

    const target = freshRepo();
    const result = await importBundle(PASSPHRASE, bundle, target, ImportMode.Replace);
    expect(result.messagesImported).toBe(1);
    expect(result.conversationsAdded).toBe(1);
    const messages = await target.getMessages(conversationId(1));
    expect(messages.map((m) => m.text)).toEqual(["round-trip"]);
  });

  it("rejects an out-of-range m (below min) with InvalidKdfParams", async () => {
    const target = freshRepo();
    const source = freshRepo();
    await source.createConversation(conversationId(1), 1000);
    const bundle = await exportBundle(PASSPHRASE, source);
    const envelope = parseEnvelopeObject(bundle);
    envelope.kdf.m = ARGON2_MEMORY_MIN_BYTES - 1;
    await expect(
      importBundle(PASSPHRASE, JSON.stringify(envelope), target, ImportMode.Replace),
    ).rejects.toMatchObject({ code: StoreErrorCode.InvalidKdfParams });
  });

  it("rejects an out-of-range m (above max) with InvalidKdfParams", async () => {
    const target = freshRepo();
    const source = freshRepo();
    await source.createConversation(conversationId(1), 1000);
    const bundle = await exportBundle(PASSPHRASE, source);
    const envelope = parseEnvelopeObject(bundle);
    envelope.kdf.m = ARGON2_MEMORY_MAX_BYTES + 1;
    await expect(
      importBundle(PASSPHRASE, JSON.stringify(envelope), target, ImportMode.Replace),
    ).rejects.toMatchObject({ code: StoreErrorCode.InvalidKdfParams });
  });

  it("rejects t below min with InvalidKdfParams", async () => {
    const target = freshRepo();
    const source = freshRepo();
    await source.createConversation(conversationId(1), 1000);
    const bundle = await exportBundle(PASSPHRASE, source);
    const envelope = parseEnvelopeObject(bundle);
    envelope.kdf.t = 0;
    await expect(
      importBundle(PASSPHRASE, JSON.stringify(envelope), target, ImportMode.Replace),
    ).rejects.toMatchObject({ code: StoreErrorCode.InvalidKdfParams });
  });

  it("rejects t above max with InvalidKdfParams", async () => {
    const target = freshRepo();
    const source = freshRepo();
    await source.createConversation(conversationId(1), 1000);
    const bundle = await exportBundle(PASSPHRASE, source);
    const envelope = parseEnvelopeObject(bundle);
    envelope.kdf.t = ARGON2_ITERATIONS_MAX + 1;
    await expect(
      importBundle(PASSPHRASE, JSON.stringify(envelope), target, ImportMode.Replace),
    ).rejects.toMatchObject({ code: StoreErrorCode.InvalidKdfParams });
  });

  it("rejects p above max with InvalidKdfParams", async () => {
    const target = freshRepo();
    const source = freshRepo();
    await source.createConversation(conversationId(1), 1000);
    const bundle = await exportBundle(PASSPHRASE, source);
    const envelope = parseEnvelopeObject(bundle);
    envelope.kdf.p = ARGON2_PARALLELISM_MAX + 1;
    await expect(
      importBundle(PASSPHRASE, JSON.stringify(envelope), target, ImportMode.Replace),
    ).rejects.toMatchObject({ code: StoreErrorCode.InvalidKdfParams });
  });

  it("rejects an unsupported argon2 version with InvalidKdfParams", async () => {
    const target = freshRepo();
    const source = freshRepo();
    await source.createConversation(conversationId(1), 1000);
    const bundle = await exportBundle(PASSPHRASE, source);
    const envelope = parseEnvelopeObject(bundle);
    // 0x10 = 16, a real Argon2 variant but not the v1.9 (19) we allow.
    envelope.kdf.version = 0x10;
    await expect(
      importBundle(PASSPHRASE, JSON.stringify(envelope), target, ImportMode.Replace),
    ).rejects.toMatchObject({ code: StoreErrorCode.InvalidKdfParams });
  });

  it("rejects non-integer KDF params with MalformedBundle", async () => {
    const target = freshRepo();
    const source = freshRepo();
    await source.createConversation(conversationId(1), 1000);
    const bundle = await exportBundle(PASSPHRASE, source);
    const envelope = parseEnvelopeObject(bundle);
    // Mutate m to a non-integer (the JSON round-trip supports it; the parser
    // type-narrows with Number.isInteger).
    const hostile = JSON.stringify({ ...envelope, kdf: { ...envelope.kdf, m: 1.5 } });
    await expect(
      importBundle(PASSPHRASE, hostile, target, ImportMode.Replace),
    ).rejects.toMatchObject({ code: StoreErrorCode.MalformedBundle });
  });

  it("throws a StoreError instance (typed-error precedent)", async () => {
    const target = freshRepo();
    const source = freshRepo();
    await source.createConversation(conversationId(1), 1000);
    const bundle = await exportBundle(PASSPHRASE, source);
    const envelope = parseEnvelopeObject(bundle);
    envelope.kdf.t = 0;
    let caught: unknown = null;
    try {
      await importBundle(PASSPHRASE, JSON.stringify(envelope), target, ImportMode.Replace);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StoreError);
    expect((caught as StoreError).code).toBe(StoreErrorCode.InvalidKdfParams);
  });
});
