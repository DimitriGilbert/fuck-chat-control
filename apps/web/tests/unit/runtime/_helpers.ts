/**
 * Web-local runtime test doubles for the tests that stay in apps/web
 * (`provider-evict`).
 *
 * The canonical copy of these helpers now lives in the chat-runtime package
 * (`packages/chat-runtime/tests/unit/runtime/_helpers.ts`) for the neutral
 * tests that moved there. This file holds only the surface the web-only tests
 * still consume — `fakeStorage`, an in-memory `Storage`-shaped double for the
 * persistence managers.
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
