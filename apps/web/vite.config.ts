import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

// All plugin factories above (tanstackStart, tailwindcss, nitro, viteReact)
// return the real `vite` package's `Plugin` type. `defineConfig` is imported
// from `vite` (not `vite-plus`) so its `UserConfig.plugins: PluginOption[]`
// accepts those plugins directly — `vite-plus`'s `UserConfig` is sourced from
// `@voidzero-dev/vite-plus-core`, a structurally-identical but nominally
// distinct package, which triggers TS2321/TS2769 when mixing the two. At
// runtime `vite-plus`'s `defineConfig` is itself a re-export of `vite`'s, so
// the config object is identical and `vp dev`/`vp build` load it unchanged.

const appsWebRoot = dirname(fileURLToPath(import.meta.url));
/**
 * Source-of-truth directory for the committed wasm-bindgen `--target web`
 * artifacts. `wasm-pack` rebuilds here; the build step below copies them into
 * the production output so the runtime dynamic import resolves in prod.
 *
 * The WASM source lives in `packages/chat-runtime/wasm/spake2/` (moved out of
 * apps/web in Phase A.3 when the runtime became a shared package). The built
 * `pkg/` stays committed there so CI needs no Rust toolchain.
 */
const spake2PkgDir = resolve(appsWebRoot, "../../packages/chat-runtime/wasm/spake2/pkg");
/**
 * Output path the SPAKE2 loader resolves at runtime. `pake.ts` does
 * `import("../wasm/spake2/pkg/fck_spake2.js")` relative to its own chunk; in
 * the production bundle that chunk lives under `/assets/<hash>.js`, so the
 * relative specifier resolves to `/wasm/spake2/pkg/fck_spake2.js`. The four
 * files below are emitted at exactly that path so the dynamic import and the
 * wasm-bindgen `new URL('fck_spake2_bg.wasm', import.meta.url)` loader both
 * resolve against the same deployed directory.
 */
const spake2OutputDir = "wasm/spake2/pkg";
const spake2PkgFiles = [
  "fck_spake2.js",
  "fck_spake2.d.ts",
  "fck_spake2_bg.wasm",
  "fck_spake2_bg.wasm.d.ts",
  "package.json",
] as const;

/**
 * Emits the committed SPAKE2 wasm-bindgen `pkg/` artifacts into the
 * production output so the dynamic `import("../wasm/spake2/pkg/fck_spake2.js")`
 * in `pake.ts` resolves at runtime. The `pkg/` is pre-built (wasm-pack output,
 * committed so CI needs no Rust toolchain) and lives outside Vite's module
 * graph, so neither `new URL(..., import.meta.url)` nor the lazy `import()`
 * would otherwise emit the files — without this plugin the production deploy
 * 404s on `/wasm/spake2/pkg/fck_spake2.js` and PAKE silently fails.
 *
 * Dev is unaffected: `vp dev` serves the source `pkg/` directly via the
 * filesystem, so the relative import resolves to the committed file.
 */
function emitSpake2PkgPlugin(): Plugin {
  return {
    name: "emit-spake2-pkg",
    apply: "build",
    async generateBundle(): Promise<void> {
      for (const fileName of spake2PkgFiles) {
        const sourcePath = resolve(spake2PkgDir, fileName);
        const source = await readFile(sourcePath);
        this.emitFile({
          type: "asset",
          fileName: `${spake2OutputDir}/${fileName}`,
          source,
        });
      }
    },
  };
}
export default defineConfig({
  server: {
    port: 3001,
  },
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [
    tailwindcss(),
    // SPA mode: the app routes serve a static shell and render client-side —
    // they never hit the runtime SSR renderer. We don't need SSR here, and the
    // SSR pass was shipping a split-React bundle that crashed
    // ("Cannot read properties of null (reading 'useSyncExternalStore')").
    // SPA mode keeps prerender enabled, so the docs routes below still emit
    // static HTML at build time via nitro's `routeRules`.
    tanstackStart({ spa: { enabled: true } }),
    ...nitro({
      features: { websocket: true },
      handlers: [
        { route: "/ws", handler: "./src/server/broker.ts" },
        // Phase 0: GET /ice-config mints time-limited TURN credentials from the
        // server-held TURN_SHARED_SECRET and returns the public STUN/TURN/TURNS
        // endpoints. The client fetches this at boot and passes the result into
        // createChatController. See src/server/ice-config.ts.
        { route: "/ice-config", handler: "./src/server/ice-config.ts" },
      ],
      // Pre-compress every public asset >1KB (the ~1MB JS/CSS/WASM bundle +
      // prerendered HTML) to gzip + brotli at build time. Nitro negotiates the
      // best encoding per request via Accept-Encoding, so the client downloads
      // the brotli/gzip file directly with zero runtime CPU cost. Without this
      // the full ~1MB ships uncompressed before the app is interactive.
      compressPublicAssets: { gzip: true, brotli: true },
      // Prerender the docs routes at build time. These are content-only SSR
      // pages with no per-request state, so we emit static HTML for them and
      // skip the runtime SSR pass on each hit. Mechanism: Nitro `routeRules`
      // per-route prerender flag (verified in nitro's index.d.mts: the
      // `NitroRouteRules` type exposes `prerender?: boolean`). Crawling is
      // off; we list the routes explicitly so a stray link never pulls the
      // broker or chat shell into the prerender queue.
      routeRules: {
        "/docs": { prerender: true },
        "/docs/": { prerender: true },
        "/docs/security": { prerender: true },
        "/docs/threat-model": { prerender: true },
        "/docs/protocol": { prerender: true },
        "/docs/deployment": { prerender: true },
      },
      prerender: {
        crawlLinks: false,
        failOnError: true,
      },
    }),
    viteReact(),
    emitSpake2PkgPlugin(),
  ],
});
