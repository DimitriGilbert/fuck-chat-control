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
// instance with sync getString/set/delete — no `new MMKV()` constructor).
jest.mock("react-native-mmkv", () => {
  const store = new Map<string, string>();
  return {
    createMMKV: () => ({
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
    }),
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
