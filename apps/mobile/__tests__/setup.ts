/**
 * Jest setup: mock the native modules the adapters wrap so the unit tests run
 * under jest-expo without a device. Each mock records calls so tests can
 * assert the adapter correctly maps RN event shapes to the chat-runtime
 * neutral interfaces.
 */

// Mock react-native-quick-crypto's install() so importing the polyfill does
// not touch a native binding. The mock installs a no-op subtle + getRandomValues
// on globalThis so any downstream code that reads globalThis.crypto.subtle
// sees a defined object (the polyfill entry asserts it is populated).
jest.mock("react-native-quick-crypto", () => ({
  install: (): void => {
    const subtle = {
      digest: jest.fn(),
      importKey: jest.fn(),
      deriveBits: jest.fn(),
      exportKey: jest.fn(),
      generateKey: jest.fn(),
      sign: jest.fn(),
      verify: jest.fn(),
      encrypt: jest.fn(),
      decrypt: jest.fn(),
    };
    (globalThis as unknown as { crypto: unknown }).crypto = {
      subtle,
      getRandomValues: <T extends ArrayBufferView>(array: T): T => array,
      randomUUID: (): string => "00000000-0000-0000-0000-000000000000",
    };
  },
}));

// Mock react-native-mmkv with an in-memory sync store mirroring the createMMKV
// getString/set signature the adapter depends on (v4 API: createMMKV returns an
// instance with sync getString/set/delete — no `new MMKV()` constructor). The
// mock records every `createMMKV` call on `mockCreateMMKVCalls` so tests can
// assert the adapter passes `encryptionType` correctly — the AES-128/AES-256
// bug (a 32-byte key with the silent AES-128 default) is otherwise invisible
// because no native AES binding runs under jest. The `encryptionKey`/`id`
// options are otherwise ignored — the store is plaintext in-memory.
interface CreateMMKVConfiguration {
  id: string;
  encryptionKey?: string;
  encryptionType?: "AES-128" | "AES-256";
}
const mockCreateMMKVCalls: CreateMMKVConfiguration[] = [];
jest.mock("react-native-mmkv", () => {
  const store = new Map<string, string>();
  const createMMKV = (configuration: CreateMMKVConfiguration) => {
    mockCreateMMKVCalls.push(configuration);
    return {
      getString(key: string): string | undefined {
        return store.get(key);
      },
      set(key: string, value: string): void {
        store.set(key, value);
      },
      delete(key: string): void {
        store.delete(key);
      },
      contains(key: string): boolean {
        return store.has(key);
      },
      getAllKeys(): string[] {
        return Array.from(store.keys());
      },
    };
  };
  return { createMMKV };
});

// Expose the recorded createMMKV calls to test files via the global object so
// the mmkv-storage regression test can assert on `encryptionType` without a
// dedicated module export from the mock factory.
(globalThis as unknown as {
  __MMKV_CREATE_CALLS__: CreateMMKVConfiguration[];
}).__MMKV_CREATE_CALLS__ = mockCreateMMKVCalls;

// Mock expo-secure-store so mmkv-storage's loadOrCreateMmkvEncryptionKey runs
// under jest without a native keychain. The mock backs getItemAsync with an
// in-memory Map so the "generate once, reuse thereafter" contract is visible
// to tests: the first getItemAsync returns null (forcing generation), the
// setItemAsync captures the generated key, and any subsequent read returns it.
jest.mock("expo-secure-store", () => {
  const store = new Map<string, string>();
  return {
    getItemAsync: (key: string): Promise<string | null> =>
      Promise.resolve(store.get(key) ?? null),
    setItemAsync: (key: string, value: string): Promise<void> => {
      store.set(key, value);
      return Promise.resolve();
    },
    getItem: (key: string): string | null => store.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      store.set(key, value);
    },
  };
});

// Mock expo-constants so config.ts reads a stable shape. The mock factory
// pulls the real `ExecutionEnvironment` enum via requireActual so the mock
// and the source under test agree on the literal ('storeClient' / 'standalone').
jest.mock("expo-constants", () => {
  const { ExecutionEnvironment } = jest.requireActual("expo-constants");
  return {
    executionEnvironment: ExecutionEnvironment.StoreClient,
    ExecutionEnvironment,
    expoConfig: {
      extra: {
        "brokerUrl:dev": "ws://10.0.2.2:8080/ws",
        "brokerUrl:prod": "wss://broker.example/ws",
        "baseUrl:dev": "http://10.0.2.2:8080",
        "baseUrl:prod": "https://example",
      },
    },
  };
});
