/**
 * Regression tests for the prod channel selection bug. The original code
 * compared a non-existent `Constants.executionContext` to the invented value
 * `'store'`, so every build reported the `:dev` keys. These tests pin:
 *   - default (StoreClient)            → :dev keys
 *   - ExecutionEnvironment.Standalone  → :prod keys  (the bug)
 *   - EXPO_PUBLIC_* overrides win regardless of channel
 *
 * The `:dev` / `:prod` key VALUES asserted below mirror apps/mobile/app.json
 * `expo.extra` and __tests__/setup.ts (whose mock pins the same extra block).
 */
import Constants, { ExecutionEnvironment } from "expo-constants";

import { resolveRuntimeConfig } from "../src/chat/config";

type ConstantsMock = {
  executionEnvironment: ExecutionEnvironment;
  expoConfig: { readonly extra: Record<string, string | undefined> };
};

function constantsMock(): ConstantsMock {
  return Constants as unknown as ConstantsMock;
}

const DEV_BROKER = "ws://10.0.2.2:8080/ws";
const DEV_BASE = "http://10.0.2.2:8080";
const PROD_BROKER = "wss://broker.example/ws";
const PROD_BASE = "https://example";

describe("resolveRuntimeConfig channel selection", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    // Restore the setup.ts default so test ordering can't bleed state.
    constantsMock().executionEnvironment = ExecutionEnvironment.StoreClient;
  });

  it("uses the :dev keys under the default StoreClient execution environment", () => {
    constantsMock().executionEnvironment = ExecutionEnvironment.StoreClient;
    const config = resolveRuntimeConfig();
    expect(config.brokerUrl).toBe(DEV_BROKER);
    expect(config.baseUrl).toBe(DEV_BASE);
  });

  it("uses the :prod keys when executionEnvironment is Standalone", () => {
    // This is the assertion that would have caught the original bug: the old
    // code read `executionContext` (undefined) and compared to `'store'`,
    // so Standalone builds silently fell through to :dev.
    constantsMock().executionEnvironment = ExecutionEnvironment.Standalone;
    const config = resolveRuntimeConfig();
    expect(config.brokerUrl).toBe(PROD_BROKER);
    expect(config.baseUrl).toBe(PROD_BASE);
  });

  it("EXPO_PUBLIC_* overrides win over both channels", () => {
    process.env.EXPO_PUBLIC_BROKER_URL = "wss://override-broker.example/ws";
    process.env.EXPO_PUBLIC_BASE_URL = "https://override-base.example";

    constantsMock().executionEnvironment = ExecutionEnvironment.StoreClient;
    const devConfig = resolveRuntimeConfig();
    expect(devConfig.brokerUrl).toBe("wss://override-broker.example/ws");
    expect(devConfig.baseUrl).toBe("https://override-base.example");

    constantsMock().executionEnvironment = ExecutionEnvironment.Standalone;
    const prodConfig = resolveRuntimeConfig();
    expect(prodConfig.brokerUrl).toBe("wss://override-broker.example/ws");
    expect(prodConfig.baseUrl).toBe("https://override-base.example");
  });
});

describe("resolveRuntimeConfig release-channel scheme validation (R8:F2)", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    constantsMock().executionEnvironment = ExecutionEnvironment.StoreClient;
    delete process.env.EXPO_PUBLIC_BROKER_URL;
    delete process.env.EXPO_PUBLIC_BASE_URL;
  });

  it("accepts the prod extra defaults under Standalone (wss/https)", () => {
    constantsMock().executionEnvironment = ExecutionEnvironment.Standalone;
    expect(() => resolveRuntimeConfig()).not.toThrow();
  });

  it("THROWS under Standalone when EXPO_PUBLIC_BROKER_URL is cleartext ws://", () => {
    constantsMock().executionEnvironment = ExecutionEnvironment.Standalone;
    process.env.EXPO_PUBLIC_BROKER_URL = "ws://cleartext.example/ws";
    expect(() => resolveRuntimeConfig()).toThrow(/brokerUrl must start with "wss:\/\//);
  });

  it("THROWS under Standalone when EXPO_PUBLIC_BASE_URL is cleartext http://", () => {
    constantsMock().executionEnvironment = ExecutionEnvironment.Standalone;
    process.env.EXPO_PUBLIC_BASE_URL = "http://cleartext.example";
    expect(() => resolveRuntimeConfig()).toThrow(/baseUrl must start with "https:\/\//);
  });

  it("the redacted error names the scheme but NOT the host or URL", () => {
    constantsMock().executionEnvironment = ExecutionEnvironment.Standalone;
    process.env.EXPO_PUBLIC_BROKER_URL = "ws://secret-host.example/ws";
    let message = "";
    try {
      resolveRuntimeConfig();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('scheme "ws:"');
    expect(message).not.toContain("secret-host.example");
  });

  it("still ALLOWS cleartext in dev (StoreClient) for the loopback workflow", () => {
    constantsMock().executionEnvironment = ExecutionEnvironment.StoreClient;
    process.env.EXPO_PUBLIC_BROKER_URL = "ws://10.0.2.2:8080/ws";
    process.env.EXPO_PUBLIC_BASE_URL = "http://10.0.2.2:8080";
    expect(() => resolveRuntimeConfig()).not.toThrow();
  });
});
