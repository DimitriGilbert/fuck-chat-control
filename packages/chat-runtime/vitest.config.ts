import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Tests live inside the package and import it via its public package name
// (`@fuck-eu-chat-control/chat-runtime/...`). pnpm does NOT create a self-link
// for the package's own name in its node_modules, so resolution must be
// explicit: an alias maps the package name to the local `src` tree, mirroring
// the convention in `apps/web/vitest.config.ts`.
export default defineConfig({
  resolve: {
    alias: {
      "@fuck-eu-chat-control/chat-runtime": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    // Unit tests only. Integration tests (which boot a real dev server) live
    // under tests/integration/ and run via `test:integration` so they never
    // tax the unit suite. See package.json.
    include: ["tests/unit/**/*.test.ts"],
    exclude: ["tests/integration/**", "node_modules/**"],
  },
});
