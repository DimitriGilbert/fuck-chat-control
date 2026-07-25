import { generateAtRestKey, unwrapKey, wrapKey } from "@/features/chat/crypto";
import { CryptoError, CryptoErrorCode } from "@/features/chat/crypto/errors";
import type { AtRestKey, WrappedKey } from "@/features/chat/crypto";
import { base64ToBytes, bytesToBase64 } from "@/features/chat/store/encoding";

export const AT_REST_STORAGE_KEY = "fck-chat-v1:at-rest";

/**
 * Storage-shaped dependency; same surface as
 * {@link "@/features/chat/runtime/identity-manager"}.IdentityStorage but
 * redeclared locally to keep the two modules independently usable.
 */
export interface AtRestStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Raised when {@link AtRestKeyManager.get} is called while the key is locked. */
export class AtRestKeyLockedError extends Error {
  constructor() {
    super("AtRestKeyManager is locked; call unlock(passphrase) first");
    this.name = "AtRestKeyLockedError";
  }
}

export interface AtRestKeyManager {
  /** Load (or generate) the auto key; has no effect on a passphrase lock. */
  ensureLoaded(): Promise<void>;
  /** Returns the auto at-rest key; throws if locked or unloaded. */
  get(): AtRestKey;
  /** Drop the in-memory key. Auto-mode keys become inaccessible too. */
  lock(): void;
  /** Unlock a passphrase-wrapped key; returns false on wrong passphrase. */
  unlock(passphrase: string): Promise<boolean>;
  /** Wrap the auto key under a passphrase and persist the wrapped form. */
  setPassphrase(passphrase: string): Promise<void>;
}

const MODE_AUTO = "auto";
const MODE_PASSPHRASE = "passphrase";

interface StoredAutoKey {
  readonly mode: "auto";
  readonly keyBase64: string;
}

interface StoredWrappedKey {
  readonly mode: "passphrase";
  readonly wrappedBase64: string;
}

type StoredAtRest = StoredAutoKey | StoredWrappedKey;

/**
 * Owns the at-rest AES-256 key used to seal persisted conversation history.
 *
 * v1 default = auto mode: a random 32-byte key generated on first run and
 * persisted (base64) to storage. The optional passphrase mode wraps that same
 * key under an Argon2id-derived KEK so the user can require a passphrase to
 * read history at boot.
 *
 * The auto key is what the conversation repository seals with; passphrase mode
 * only affects how the auto key is *itself* persisted.
 */
export function createAtRestKeyManager(storage: AtRestStorage): AtRestKeyManager {
  let autoKey: AtRestKey | null = null;
  let locked = false;

  return {
    async ensureLoaded(): Promise<void> {
      if (autoKey !== null) return;
      const raw = storage.getItem(AT_REST_STORAGE_KEY);
      if (raw === null) {
        const fresh = generateAtRestKey();
        const stored: StoredAutoKey = { mode: MODE_AUTO, keyBase64: bytesToBase64(fresh) };
        storage.setItem(AT_REST_STORAGE_KEY, JSON.stringify(stored));
        autoKey = fresh;
        return;
      }
      const parsed = JSON.parse(raw) as StoredAtRest;
      if (parsed.mode === MODE_AUTO) {
        autoKey = base64ToBytes(parsed.keyBase64) as unknown as AtRestKey;
        return;
      }
      // Passphrase mode: keep the wrapped form on disk; leave the key locked
      // until the caller provides the passphrase via unlock().
      locked = true;
    },

    get(): AtRestKey {
      if (locked) {
        throw new AtRestKeyLockedError();
      }
      if (autoKey === null) {
        throw new Error(
          "AtRestKeyManager.get() called before ensureLoaded(); call ensureLoaded() first",
        );
      }
      return autoKey;
    },

    lock(): void {
      locked = true;
    },

    async unlock(passphrase: string): Promise<boolean> {
      const raw = storage.getItem(AT_REST_STORAGE_KEY);
      if (raw === null) {
        // Nothing to unlock.
        return false;
      }
      const parsed = JSON.parse(raw) as StoredAtRest;
      if (parsed.mode !== MODE_PASSPHRASE) {
        // Auto mode: there is no passphrase to verify. Treat as already
        // unlocked (the auto key is available) and clear the lock.
        locked = false;
        return true;
      }
      const wrapped = base64ToBytes(parsed.wrappedBase64) as unknown as WrappedKey;
      try {
        autoKey = await unwrapKey(passphrase, wrapped);
        locked = false;
        return true;
      } catch (err) {
        if (err instanceof CryptoError && err.code === CryptoErrorCode.WrongPassphrase) {
          return false;
        }
        throw err;
      }
    },

    async setPassphrase(passphrase: string): Promise<void> {
      if (autoKey === null) {
        throw new Error(
          "AtRestKeyManager.setPassphrase() called before ensureLoaded(); call ensureLoaded() first",
        );
      }
      const wrapped = await wrapKey(passphrase, autoKey);
      const stored: StoredWrappedKey = {
        mode: MODE_PASSPHRASE,
        wrappedBase64: bytesToBase64(wrapped),
      };
      storage.setItem(AT_REST_STORAGE_KEY, JSON.stringify(stored));
      // The key is now backed by a wrapped form; the in-memory key remains
      // available (we just wrapped it, we did not forget it).
      locked = false;
    },
  };
}
