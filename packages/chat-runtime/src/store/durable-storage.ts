/**
 * Platform-neutral durable key/value backing store (the subset of the DOM
 * `Storage` interface the runtime touches). The runtime core never accesses
 * `localStorage` or any other DOM global directly; instead, each platform
 * registers its concrete implementation at boot via {@link setDurableStorage}
 * and the runtime reads/writes through the registered instance.
 *
 * Web app: `setDurableStorage(window.localStorage)` (or a MemoryStorage in SSR
 * tests). Native apps: the platform's persisted KV surface.
 */

/**
 * Durable key/value store mirroring the `getItem`/`setItem` subset of the DOM
 * `Storage` interface. Values are plain strings; callers JSON-encode structured
 * payloads. A `null` read means "no value" (same semantics as `Storage.getItem`).
 */
export interface DurableStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Registered durable store. Populated by {@link setDurableStorage}; read by
 * `getDurableStorage`. `null` until the platform registers one at boot.
 */
let durableStorage: DurableStorage | null = null;

/**
 * Register the platform's durable KV store. Each app calls this ONCE at boot,
 * BEFORE any runtime module that persists flags (today: the auth-failed store)
 * reads or writes. Web: `setDurableStorage(window.localStorage)`; native: the
 * platform's equivalent.
 *
 * The runtime treats persistence as best-effort: if no store is registered,
 * reads return `null` (no flag present) and writes no-op, so an unconfigured
 * platform degrades gracefully rather than throwing.
 */
export function setDurableStorage(store: DurableStorage): void {
  durableStorage = store;
}

/**
 * Access the registered durable store. Returns `null` when no store has been
 * registered — callers must handle that case (the auth-failed store treats a
 * null store as "persist nothing, read everything as absent").
 */
export function getDurableStorage(): DurableStorage | null {
  return durableStorage;
}
