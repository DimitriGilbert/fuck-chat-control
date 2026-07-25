/**
 * A minimal in-memory `Storage`-shaped double for testing the runtime
 * persistence managers. Only the `getItem`/`setItem` surface is implemented —
 * the runtime never calls `removeItem` or iterates keys.
 */
export interface FakeStorage {
  readonly store: Map<string, string>;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function fakeStorage(): FakeStorage {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (key: string): string | null => store.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      store.set(key, value);
    },
  };
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
