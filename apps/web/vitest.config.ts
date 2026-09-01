import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@fuck-eu-chat-control/chat-runtime": fileURLToPath(
        new URL("../../packages/chat-runtime/src", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    // Unit tests only. Integration tests (which boot a real dev server) live
    // under tests/integration/ and run via `test:integration` so they never
    // tax the unit suite. See package.json.
    include: ["tests/unit/**/*.test.ts"],
    exclude: ["tests/integration/**", "tests/e2e/**", "node_modules/**"],
  },
});
