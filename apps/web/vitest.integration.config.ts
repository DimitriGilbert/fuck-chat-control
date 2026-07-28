import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Dedicated config for integration tests. These boot a real dev server and
// therefore need a longer per-test timeout; they are deliberately excluded from
// the unit suite (`vitest.config.ts`) so `pnpm run test:unit` stays fast.
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
    include: ["tests/integration/**/*.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
