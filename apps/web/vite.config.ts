import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

// All plugin factories above (tanstackStart, tailwindcss, nitro, viteReact)
// return the real `vite` package's `Plugin` type. `defineConfig` is imported
// from `vite` (not `vite-plus`) so its `UserConfig.plugins: PluginOption[]`
// accepts those plugins directly — `vite-plus`'s `UserConfig` is sourced from
// `@voidzero-dev/vite-plus-core`, a structurally-identical but nominally
// distinct package, which triggers TS2321/TS2769 when mixing the two. At
// runtime `vite-plus`'s `defineConfig` is itself a re-export of `vite`'s, so
// the config object is identical and `vp dev`/`vp build` load it unchanged.
export default defineConfig({
  server: {
    port: 3001,
  },
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [
    tailwindcss(),
    tanstackStart(),
    ...nitro({
      features: { websocket: true },
      handlers: [{ route: "/ws", handler: "./src/server/broker.ts" }],
    }),
    viteReact(),
  ],
});
