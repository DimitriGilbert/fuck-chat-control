import { describe, expect, it } from "vitest";

// Import the nitro config as a value. `defineConfig` is a passthrough identity
// (nitro's runtime/nitro.mjs exports it as `defineConfig = (config) => config`),
// so `default` is exactly the literal object authored in nitro.config.ts.
import nitroConfig from "../../../nitro.config";

describe("apps/web nitro.config.ts — R3/F1 WebSocket surface", () => {
  it("explicitly enables the WebSocket feature flag", () => {
    expect(nitroConfig.features?.websocket).toBe(true);
  });

  // R3/F1 regression guard: the whole point of this config file is to make the
  // WS surface explicit + documented. If a future edit drops the flag (or the
  // nitro key shape changes), this test fails loudly rather than silently
  // reverting WS support to an implicit vite.config.ts-only dependency.
  it("does not define a deprecated experimental.websocket flag", () => {
    // We deliberately use the non-deprecated `features.websocket` key; ensure
    // the deprecated `experimental.websocket` is not also set (which would be
    // redundant and trigger nitro deprecation warnings).
    expect(nitroConfig.experimental?.websocket).toBeUndefined();
  });
});
