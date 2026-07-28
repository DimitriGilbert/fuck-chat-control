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
 */
import { createMMKV } from "react-native-mmkv";

/**
 * The single MMKV instance backing identity, the at-rest key, and the runtime
 * DurableStorage. Created once at module load.
 *
 * `react-native-mmkv`'s MMKV constructor accepts an optional id + encryption
 * key; v1 uses the default instance (no encryption at the storage layer — the
 * runtime seals its secrets via the at-rest key before they reach storage).
 */
const storage = createMMKV({ id: "fck-chat-v1" });

/** The chat-runtime storage surface: sync getItem/setItem, string-only values. */
export interface ChatRuntimeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Adapter that wraps {@link storage} as the chat-runtime storage surface.
 * `getString` returns `undefined` for missing keys; the runtime expects
 * `null` (mirrors `localStorage.getItem`), so `?? null` normalizes.
 */
export const chatStorage: ChatRuntimeStorage = {
  getItem(key: string): string | null {
    return storage.getString(key) ?? null;
  },
  setItem(key: string, value: string): void {
    storage.set(key, value);
  },
};
