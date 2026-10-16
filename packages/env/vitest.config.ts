import { defineConfig } from "vitest/config";

// Mirrors packages/chat-runtime/vitest.config.ts. Tests import the schema
// module by relative path (../../src/server) — no package-name alias is
// needed because pnpm does not self-link this package's own name.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
    exclude: ["tests/integration/**", "node_modules/**"],
  },
});
