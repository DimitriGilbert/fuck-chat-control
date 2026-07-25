import { generateIdentityKeyPair, signTranscript } from "@/features/chat/crypto";
import type { IdentityKeyPair } from "@/features/chat/crypto";
import { decodePublicKey } from "@/features/chat/protocol/codec";
import type { PublicKey, Signature, Transcript } from "@/features/chat/protocol/types";
import { base64ToBytes, bytesToBase64 } from "@/features/chat/store/encoding";

export const IDENTITY_STORAGE_KEY = "fck-chat-v1:identity";

/**
 * Storage-shaped dependency. Mirrors the `localStorage` subset the manager
 * uses (`getItem`/`setItem`). Injected so tests can substitute an in-memory
 * double without touching the real `localStorage`.
 */
export interface IdentityStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Persisted identity, stored as base64 to keep the value JSON-serializable
 * and survive `localStorage`'s string-only contract.
 */
export interface StoredIdentity {
  readonly publicKeyBase64: string;
  readonly privateKeyBase64: string;
}

export interface IdentityManager {
  /**
   * Returns the loaded {@link IdentityKeyPair}. Throws if called before
   * {@link ensureLoaded} has resolved — the key is NOT lazily generated here
   * to keep the contract explicit and the synchronous path side-effect free.
   */
  get(): IdentityKeyPair;
  /** Loads the persisted identity, or generates and persists a fresh one. */
  ensureLoaded(): Promise<void>;
}

/**
 * Owns the long-lived device identity key pair. Generates once on first run,
 * persists both keys (base64) to the injected storage, and rebuilds the
 * {@link IdentityKeyPair.sign} closure from the persisted private key on
 * subsequent loads.
 *
 * The public key is a 65-byte uncompressed SEC1 P-256 point; `encodePublicKey`
 * validates that shape and the on-curve property on reload.
 */
export function createIdentityManager(storage: IdentityStorage): IdentityManager {
  let identity: IdentityKeyPair | null = null;

  async function loadFrom(stored: StoredIdentity): Promise<IdentityKeyPair> {
    const publicKeyBytes = base64ToBytes(stored.publicKeyBase64);
    const publicKey: PublicKey = decodePublicKey(publicKeyBytes);
    const privateKey = base64ToBytes(stored.privateKeyBase64);
    return {
      publicKey,
      privateKey,
      sign: (transcript: Transcript): Promise<Signature> => signTranscript(privateKey, transcript),
    };
  }

  return {
    get(): IdentityKeyPair {
      if (identity === null) {
        throw new Error(
          "IdentityManager.get() called before ensureLoaded(); call ensureLoaded() first",
        );
      }
      return identity;
    },
    async ensureLoaded(): Promise<void> {
      if (identity !== null) return;
      const raw = storage.getItem(IDENTITY_STORAGE_KEY);
      if (raw !== null) {
        const parsed = JSON.parse(raw) as StoredIdentity;
        identity = await loadFrom(parsed);
        return;
      }
      const fresh = await generateIdentityKeyPair();
      const stored: StoredIdentity = {
        publicKeyBase64: bytesToBase64(fresh.publicKey),
        privateKeyBase64: bytesToBase64(fresh.privateKey),
      };
      storage.setItem(IDENTITY_STORAGE_KEY, JSON.stringify(stored));
      identity = fresh;
    },
  };
}
