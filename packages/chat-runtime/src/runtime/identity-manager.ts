import { derivePublicKeyFromPrivate, generateIdentityKeyPair, signTranscript } from "../crypto";
import type { IdentityKeyPair } from "../crypto";
import { decodePublicKey } from "../protocol/codec";
import type { PublicKey, Signature, Transcript } from "../protocol/types";
import { base64ToBytes, bytesToBase64 } from "../store/encoding";

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
  /**
   * Adopt an imported private key, persisting it as the active identity.
   *
   * SEC-3: previously the {@link ImportResult.deviceIdentity} returned by
   * `importBundle` was silently discarded — the controller never propagated it
   * into the manager, so the next page load rehydrated the OLD identity and
   * the imported key was lost. This method overwrites both the in-memory
   * identity AND the persisted storage entry, then rebuilds the `sign` closure
   * so subsequent `get()` calls return the imported pair without an
   * `ensureLoaded` round-trip.
   *
   * The public key is re-derived from the private scalar via
   * {@link derivePublicKeyFromPrivate} (P-256; the bundle stores only the
   * private half because the public point is reproducible from the curve).
   *
   * NOTE: this does NOT rotate the at-rest key. The caller (chat-controller)
   * invokes adoption AFTER the bundle's conversation history has already been
   * decrypted under the passphrase-derived at-rest key, so the freshly adopted
   * identity sits on top of the existing sealed store without re-keying it.
   */
  adoptImportedIdentity(privateKey: Uint8Array): Promise<void>;
  /**
   * Drop the in-memory identity reference (R9/F8). The persisted form on disk
   * is unchanged — the next manager that calls `ensureLoaded` on the same
   * storage rehydrates the key — but evicting here means a long-lived tab
   * that loses its ChatProvider does not keep the private key resident. The
   * next `get()` on THIS manager throws until `ensureLoaded()` runs again.
   */
  evict(): void;
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
    async adoptImportedIdentity(privateKey: Uint8Array): Promise<void> {
      // SEC-3: re-derive the public point from the imported private scalar and
      // build the same {publicKey, privateKey, sign} shape `ensureLoaded`
      // produces, then overwrite both the in-memory identity AND the persisted
      // storage entry. The at-rest key is NOT rotated — see interface doc.
      const publicKey = derivePublicKeyFromPrivate(privateKey);
      const adopted: IdentityKeyPair = {
        publicKey,
        privateKey,
        sign: (transcript: Transcript): Promise<Signature> => signTranscript(privateKey, transcript),
      };
      const stored: StoredIdentity = {
        publicKeyBase64: bytesToBase64(publicKey),
        privateKeyBase64: bytesToBase64(privateKey),
      };
      storage.setItem(IDENTITY_STORAGE_KEY, JSON.stringify(stored));
      identity = adopted;
    },
    evict(): void {
      // Drop the closure-captured identity so the private key is no longer
      // reachable from this manager. A subsequent get() throws until
      // ensureLoaded() repopulates it from storage.
      identity = null;
    },
  };
}
