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
 */
const spake2PkgDir = resolve(appsWebRoot, "src/wasm/spake2/pkg");
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
    // SSR split-React fix. The production bundle had TWO React module objects:
    // nitro's `_libs` chunk bundles `react-dom/server` + an inlined React and
    // binds the hook dispatcher (`ReactSharedInternals.H`) on it; the app's
    // `use-sync-external-store/shim` regions (pulled in by Base UI and
    // `@tanstack/react-store`) resolved `require("react")` to a *different*
    // (external node_modules) copy whose dispatcher stays null → SSR crash
    // "Cannot read properties of null (reading 'useSyncExternalStore')".
    // `dedupe` forces every `react`/`react-dom` import onto one resolved file.
    dedupe: ["react", "react-dom", "react/jsx-runtime"],
    alias: {
      // On React 19 the shim is a no-op — it returns `React.useSyncExternalStore`
      // verbatim (`void 0 !== React.useSyncExternalStore ? React.useSyncExternalStore
      // : shim`). Pointing the shim at `react` (which `dedupe` above collapses to
      // the single React) makes its hooks read the same dispatcher-bearing copy
      // that `react-dom/server` writes to. Verified semantically identical.
      "use-sync-external-store/shim/with-selector": "react",
      "use-sync-external-store/shim": "react",
      "use-sync-external-store": "react",
    },
  },
  plugins: [
    tailwindcss(),
    tanstackStart(),
    ...nitro({
      features: { websocket: true },
      handlers: [{ route: "/ws", handler: "./src/server/broker.ts" }],
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
