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

/**
 * Raised by the {@link LockableRepository} wrapper (or any caller) when a
 * ciphertext-touching repository method is invoked while the at-rest key is
 * locked. Distinct from {@link AtRestKeyLockedError} (which the manager raises
 * from `get()`) so callers can discriminate "key manager itself refused" from
 * "repository blocked because the manager is locked".
 */
export class AtRestLockedError extends Error {
  constructor() {
    super("at-rest key is locked; call controller.unlock(passphrase) first");
    this.name = "AtRestLockedError";
  }
}

export interface AtRestKeyManager {
  /** Load (or generate) the auto key; has no effect on a passphrase lock. */
  ensureLoaded(): Promise<void>;
  /** Returns the auto at-rest key; throws if locked or unloaded. */
  get(): AtRestKey;
  /**
   * Drop the in-memory auto key and mark the manager locked. Auto-mode keys
   * become inaccessible too (a subsequent `get()` throws). Note: in auto mode
   * the key remains persisted to storage in the clear, so this drops the
   * in-memory copy only — see the PRD's at-rest guarantee. Passphrase mode
   * additionally requires the passphrase to repopulate the key on unlock.
   */
  lock(): void;
  /** Unlock a passphrase-wrapped key; returns false on wrong passphrase. */
  unlock(passphrase: string): Promise<boolean>;
  /** Wrap the auto key under a passphrase and persist the wrapped form. */
  setPassphrase(passphrase: string): Promise<void>;
  /** True once {@link lock} has been called and until a successful unlock. */
  isLocked(): boolean;
  /**
   * Register a callback fired after a SUCCESSFUL {@link unlock} (locked →
   * unlocked transition). Used by the {@link LockableRepository} wrapper to
   * flush auth-failed writes that were queued while locked (R7/F3 + SEC-2).
   * The callback is invoked AFTER the manager's own state flips, so
   * `isLocked()` reads false inside the callback. Returning `false` from the
   * callback does nothing; the contract is "you were notified". Registering
   * returns an unsubscribe function.
   */
  onUnlock(callback: () => void): () => void;
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
 *
 * LOCK SEMANTICS: `lock()` drops the in-memory `autoKey` reference and flips
 * the `locked` flag, so `get()` and any seal/unseal through a
 * {@link LockableRepository} wrapper throw until the caller unlocks. In auto
 * mode the key remains on disk in the clear, so lock() does NOT protect
 * against an attacker who can read browser storage — the PRD's at-rest
 * guarantee is explicit about this. Passphrase mode is what makes lock()
 * meaningful: the wrapped form cannot be unsealed without the passphrase.
 */
export function createAtRestKeyManager(storage: AtRestStorage): AtRestKeyManager {
  let autoKey: AtRestKey | null = null;
  let locked = false;
  const unlockListeners = new Set<() => void>();

  function notifyUnlocked(): void {
    // Snapshot to a local array so a callback that (un)subscribes during
    // dispatch does not mutate the set mid-iteration.
    const snapshot = Array.from(unlockListeners);
    for (const cb of snapshot) {
      try {
        cb();
      } catch {
        // A listener throwing must not break the unlock path or block other
        // listeners. The listener owns its own error handling; surfacing here
        // would couple the manager to consumer failures.
      }
    }
  }

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
      // Drop the in-memory key so a subsequent get() throws. The persisted
      // form is unchanged (auto mode keeps the raw key on disk; passphrase
      // mode keeps the wrapped form). The authoritative gate for repository
      // access lives in the LockableRepository wrapper, but nulling autoKey
      // here makes the manager's own lock() honest rather than cosmetic.
      autoKey = null;
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
        // Auto mode: there is no passphrase to verify. Repopulate the
        // in-memory key from storage and clear the lock.
        autoKey = base64ToBytes(parsed.keyBase64) as unknown as AtRestKey;
        locked = false;
        notifyUnlocked();
        return true;
      }
      const wrapped = base64ToBytes(parsed.wrappedBase64) as unknown as WrappedKey;
      try {
        autoKey = await unwrapKey(passphrase, wrapped);
        locked = false;
        notifyUnlocked();
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

    isLocked(): boolean {
      return locked;
    },

    onUnlock(callback: () => void): () => void {
      unlockListeners.add(callback);
      return () => {
        unlockListeners.delete(callback);
      };
    },
  };
}
