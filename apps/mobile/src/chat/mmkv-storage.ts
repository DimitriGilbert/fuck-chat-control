/**
 * MMKV-backed sync storage satisfying the THREE chat-runtime storage
 * interfaces with a single instance:
 *
 *  - {@link IdentityStorage}        (runtime/identity-manager.ts)
 *  - {@link AtRestStorage}          (runtime/at-rest-key-manager.ts)
 *  - {@link DurableStorage}         (store/durable-storage.ts)
 *
 * All three are structurally `{ getItem(key): string | null; setItem(key,
 * value): void }`. MMKV's `getString`/`set` are SYNCHRONOUS — this is
 * load-bearing: `createChatController` calls `atRestKeyManager.get()`
 * synchronously at construction, and the managers call `storage.getItem`
 * synchronously after `ensureLoaded`. An async store would break the contract.
 *
 * The instance registered here is ALSO the value passed to
 * `setDurableStorage()` at boot — so IdentityStorage, AtRestStorage, and the
 * DurableStorage singleton all read/write through the SAME MMKV instance (one
 * KV store, one set of keys, one sync surface).
 *
 * AT-REST ENCRYPTION (CRITICAL-A remediation): the MMKV file is now encrypted
 * with an AES-256 key generated on first launch and persisted ONLY in the OS
 * keychain/keystore via `expo-secure-store` (iOS Keychain / Android Keystore).
 * The key never lives in the MMKV file or any other plaintext store. MMKV is
 * constructed once via {@link ensureStorageReady}, which the chat provider
 * awaits before handing `chatStorage` to any runtime manager. MMKV defaults to
 * AES-128 (which rejects keys longer than 16 bytes), so `createMMKV` is
 * explicitly passed `encryptionType: "AES-256"`. See {@link
 * MMKV_ENCRYPTION_KEY_RANDOM_BYTES} for why the key is 24 random bytes even
 * though the AES-256 slot is 32 bytes wide.
 *
 * iOS backup-exclusion equivalent: the MMKV file lives under the app's
 * Documents directory (`$(Documents)/mmkv/`). To keep it out of iCloud/iTunes
 * backups, the build should set `NSURLIsExcludedFromBackupKey` on that
 * directory. There is no clean Expo config-plugin route for per-file iOS
 * backup exclusion (the `expo-secure-store` plugin only exposes
 * `configureAndroidBackup` and `faceIDPermission` — it has no
 * `keychainAccessible` or file-attribute field), so this must be applied in
 * the native build: add `NSURLIsExcludedFromBackupKey = YES` for the MMKV
 * directory in `ios/Podfile` post-install or a custom Expo config plugin.
 *
 * KNOWN LIMITATION (native-build step, not applied here): the
 * `NSURLIsExcludedFromBackupKey` flag for the MMKV directory is NOT set by
 * this module or by any Expo config plugin in this repo. There is no `ios/`
 * prebuild directory checked in, so applying it requires a native-build step
 * (Podfile post-install or a config plugin) that is out of scope for this
 * change. Until that step lands, the MMKV file may be included in iCloud/
 * iTunes backups. The MMKV *encryption key* itself is separately sealed in
 * the iOS Keychain with `keychainAccessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY`
 * (see {@link loadOrCreateMmkvEncryptionKey}), which marks it
 * non-migratable and excludes it from backups. The Android side is covered
 * by `android:allowBackup="false"` in AndroidManifest.xml plus the
 * `expo-secure-store` plugin's `configureAndroidBackup: false`.
 */
import * as SecureStore from "expo-secure-store";
import { createMMKV } from "react-native-mmkv";

import type { MMKV } from "react-native-mmkv";

/** MMKV instance id — stable across launches so the same file is reopened. */
const MMKV_ID = "fck-chat-v1";

/**
 * SecureStore key for the MMKV encryption key. The value is the base64 of 24
 * random bytes (192 bits of entropy), which base64-encodes to exactly 32 ASCII
 * characters — the maximum AES-256 key length MMKV accepts.
 */
const MMKV_ENCRYPTION_KEY_SECURE_STORE_KEY = "fck-chat-v1-mmkv-key";

/**
 * The number of random bytes generated for the MMKV encryption key. 24 bytes
 * base64-encode to a 32-character ASCII string, which is the largest key MMKV's
 * AES-256 mode accepts (32 bytes). 192 bits of entropy exceeds AES-128's
 * 128-bit requirement and is well above the brute-force threshold.
 *
 * NOTE: 24 random bytes (not 32) is deliberate and load-bearing. MMKV consumes
 * the {@link createMMKV} `encryptionKey` string VERBATIM as the C++ `std::string`
 * cryptKey, so the byte-length MMKV validates is the LENGTH OF THE STRING,
 * not the entropy it carries. A 32-byte random key base64-encodes to 44 ASCII
 * characters, and MMKV's AES-256 branch throws `runtime_error` at boot for any
 * string longer than 32 bytes (see `HybridMMKV.cpp` in react-native-mmkv: the
 * `encryptionKey.size() > 32` check runs synchronously during `mmkvWithID`).
 * 24 random bytes → 32-char base64 → exactly fills the 32-byte AES-256 slot
 * with 192 bits of entropy. This is also why the silent AES-128 default was a
 * boot-crash bug: AES-128 rejects any string longer than 16 bytes.
 */
const MMKV_ENCRYPTION_KEY_RANDOM_BYTES = 24;

/**
 * Generates a fresh MMKV encryption key: 24 cryptographically-random bytes
 * (via the platform WebCrypto polyfill), base64-encoded to a 32-character ASCII
 * string that fits MMKV's 32-byte AES-256 key slot. The underlying bytes come
 * from `globalThis.crypto.getRandomValues`, which `react-native-quick-crypto`
 * installs as a JSI-backed CSPRNG at app entry (see App.tsx import ordering).
 */
function generateMmkvEncryptionKey(): string {
  const bytes = new Uint8Array(MMKV_ENCRYPTION_KEY_RANDOM_BYTES);
  globalThis.crypto.getRandomValues(bytes);
  return bytesToBase64(bytes);
}

/**
 * Loads the MMKV encryption key from the OS keychain, generating and
 * persisting it on first launch. The key is generated EXACTLY ONCE: a missing
 * SecureStore entry is the only path that calls `generateMmkvEncryptionKey` +
 * `SecureStore.setItemAsync`; every subsequent launch reads the persisted
 * value back. Returns the base64 string to pass as MMKV's `encryptionKey`.
 *
 * ACCESSIBILITY CHOICE: the key is persisted with
 * `keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY`. The
 * `WHEN_UNLOCKED` half matches the "available when the device is unlocked"
 * semantics the MMKV boot path needs (no biometric/prompt gate that could
 * block background reads). The `THIS_DEVICE_ONLY` flag is the security-critical
 * half: it marks the keychain item non-migratable, so it is NOT included in
 * iCloud/iTunes backups and does NOT restore to a new device. This is the M4
 * remediation — without it, the default `WHEN_UNLOCKED` (migratable) class
 * would let the MMKV encryption key ride a backup onto a different device.
 */
async function loadOrCreateMmkvEncryptionKey(): Promise<string> {
  const existing = await SecureStore.getItemAsync(MMKV_ENCRYPTION_KEY_SECURE_STORE_KEY);
  if (existing !== null) {
    return existing;
  }
  const generated = generateMmkvEncryptionKey();
  await SecureStore.setItemAsync(
    MMKV_ENCRYPTION_KEY_SECURE_STORE_KEY,
    generated,
    { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY },
  );
  return generated;
}

/**
 * Base64-encodes a byte array using a fixed alphabet (btoa not available in RN).
 * Handles input lengths that are not multiples of 3 (emits the standard `=`
 * padding) — required because {@link MMKV_ENCRYPTION_KEY_RANDOM_BYTES} (24) is
 * divisible by 3 today, but the encoder must stay correct for any byte length.
 */
function bytesToBase64(bytes: Uint8Array): string {
  const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = i + 1 < bytes.length ? (bytes[i + 1] ?? 0) : -1;
    const b2 = i + 2 < bytes.length ? (bytes[i + 2] ?? 0) : -1;
    output += CHARS[b0 >> 2];
    if (b1 === -1) {
      // 1-byte tail: one more data char + two `=` pad chars.
      output += CHARS[(b0 & 0x03) << 4];
      output += "==";
      break;
    }
    output += CHARS[((b0 & 0x03) << 4) | (b1 >> 4)];
    if (b2 === -1) {
      // 2-byte tail: one more data char + one `=` pad char.
      output += CHARS[(b1 & 0x0f) << 2];
      output += "=";
      break;
    }
    output += CHARS[((b1 & 0x0f) << 2) | (b2 >> 6)];
    output += CHARS[b2 & 0x3f];
  }
  return output;
}

/** The chat-runtime storage surface: sync getItem/setItem, string-only values. */
export interface ChatRuntimeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Lazily-initialized MMKV instance. Assigned exactly once by
 * {@link ensureStorageReady} after the OS-keychain encryption key has been
 * loaded. `null` means "not ready" — any call to {@link chatStorage} before
 * `ensureStorageReady` resolves throws, guarding the sync contract.
 */
let storageInstance: MMKV | null = null;

/**
 * Memoized in-flight {@link ensureStorageReady} promise. Module-level mutable
 * so two concurrent first-launch calls share the same generation/construct
 * pass: the promise is assigned on the first call and reused thereafter. Once
 * it resolves successfully it stays cached for the process lifetime (never
 * reset to null), so subsequent calls no-op without re-entering the body.
 */
let readyPromise: Promise<void> | null = null;

/**
 * Initializes the MMKV instance with the OS-keychain-bound encryption key.
 * Idempotent AND concurrency-safe on first launch: the first call loads (or
 * generates+persists) the key via `expo-secure-store` and constructs the
 * encrypted MMKV instance; concurrent and subsequent calls all await/return
 * the same memoized promise. The chat provider MUST await this before
 * constructing any runtime manager that reads from {@link chatStorage}.
 */
export function ensureStorageReady(): Promise<void> {
  if (readyPromise !== null) return readyPromise;
  readyPromise = (async () => {
    // Re-check inside the in-flight promise: a resolved prior call leaves
    // storageInstance set and readyPromise cached, but the outer null check
    // on readyPromise is the primary gate.
    if (storageInstance !== null) return;
    // FAIL-CLOSED: the v1 threat model treats the keychain-bound MMKV
    // encryption key as a GATE, not a best-effort mitigation. The MMKV file
    // holds the identity private key and the raw at-rest AES key; an
    // UNENCRYPTED MMKV would persist both in plaintext on disk, which is
    // strictly worse than not running chat at all. So if the OS
    // keychain/keystore is unavailable (SecureStore rejects — e.g. Android
    // Keystore not yet unlocked, iOS Keychain auth dismissed, or a transient
    // RN bridge failure), we let loadOrCreateMmkvEncryptionKey()'s rejection
    // PROPAGATE: ensureStorageReady() rejects, storageInstance stays null,
    // and any later requireStorage() call throws the existing
    // "used before ready" error rather than touching plaintext. The chat
    // provider surfaces this to the user as a "secure storage unavailable —
    // cannot start chat" error state (see mobile-chat-provider.tsx). The
    // user can retry: the keychain may become available again on the next
    // launch, and a fresh ensureStorageReady() attempt will re-run because
    // readyPromise is per-process and a new process gets a fresh module.
    const encryptionKey = await loadOrCreateMmkvEncryptionKey();
    storageInstance = createMMKV({
      id: MMKV_ID,
      encryptionKey,
      // Mandatory: MMKV defaults to AES-128, which throws at boot for any
      // encryptionKey string longer than 16 bytes. The 32-char base64 key
      // produced above is only valid under AES-256 (max 32 bytes). See
      // MMKV_ENCRYPTION_KEY_RANDOM_BYTES for the string-vs-entropy distinction.
      encryptionType: "AES-256",
    });
  })();
  return readyPromise;
}

/**
 * Returns the initialized MMKV instance, throwing if
 * {@link ensureStorageReady} has not resolved. The runtime storage contract is
 * synchronous, so every {@link chatStorage} call routes here; the provider's
 * `await ensureStorageReady()` gate makes this safe.
 */
function requireStorage(): MMKV {
  if (storageInstance === null) {
    throw new Error(
      "chatStorage used before ensureStorageReady() resolved — " +
        "the ChatProvider must await ensureStorageReady() before " +
        "constructing any runtime manager.",
    );
  }
  return storageInstance;
}

/**
 * Adapter that wraps the encrypted MMKV instance as the chat-runtime storage
 * surface. `getString` returns `undefined` for missing keys; the runtime
 * expects `null` (mirrors `localStorage.getItem`), so `?? null` normalizes.
 */
export const chatStorage: ChatRuntimeStorage = {
  getItem(key: string): string | null {
    return requireStorage().getString(key) ?? null;
  },
  setItem(key: string, value: string): void {
    requireStorage().set(key, value);
  },
};
