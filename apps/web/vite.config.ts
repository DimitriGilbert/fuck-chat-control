import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Connect, type Plugin } from "vite";

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
 * production output so the dynamic `import("/wasm/spake2/pkg/fck_spake2.js")`
 * in `pake.ts` resolves at runtime. The `pkg/` is pre-built (wasm-pack output,
 * committed so CI needs no Rust toolchain) and lives outside Vite's module
 * graph, so neither `new URL(..., import.meta.url)` nor the lazy `import()`
 * would otherwise emit the files — without this plugin the production deploy
 * 404s on `/wasm/spake2/pkg/fck_spake2.js` and PAKE silently fails.
 *
 * Dev serving is handled by the companion {@link serveSpake2PkgPlugin}.
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

/**
 * Maps a served `pkg/` filename to its HTTP `Content-Type`. The loader only
 * fetches `.js` (the wasm-bindgen entry, served as JavaScript so the dynamic
 * `import()` evaluates it) and `.wasm` (the binary module, served with the
 * streaming MIME so `WebAssembly.instantiateStreaming` accepts it). Other
 * committed artifacts (`.d.ts`, `package.json`, `README.md`) are served as
 * plain text so a stray request never binary-dumps to the console.
 */
function spake2ContentType(fileName: string): string {
  if (fileName.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (fileName.endsWith(".wasm")) return "application/wasm";
  return "text/plain; charset=utf-8";
}

/**
 * Serves the committed SPAKE2 `pkg/` from `packages/chat-runtime/wasm/spake2/pkg/`
 * at the URL `/wasm/spake2/pkg/<file>` during `vp dev`. The runtime loader
 * (`chat-provider.tsx`) pins the import to that absolute URL (the same path
 * {@link emitSpake2PkgPlugin} emits in prod), but the `pkg/` lives outside the
 * apps/web root so Vite's default static serving never reaches it — without
 * this middleware the dev import 404s and PAKE silently fails (the
 * p2p-pake e2e regression).
 *
 * Mirrors `emitSpake2PkgPlugin`'s `apply: "build"` with `apply: "serve"` so
 * the two plugins split cleanly across dev vs prod. Path-traversal is blocked
 * by resolving the requested name under {@link spake2PkgDir} and rejecting
 * anything that escapes it; unknown files fall through to Vite's 404.
 */
function serveSpake2PkgPlugin(): Plugin {
  const route = `/${spake2OutputDir}/`;
  return {
    name: "serve-spake2-pkg",
    apply: "serve",
    configureServer(server) {
      // Mount at the `route` prefix: connect only invokes the handler when the
      // pathname starts with `/wasm/spake2/pkg/`, so unrelated requests pay no
      // cost, and `req.url` is rewritten to the portion AFTER the prefix (per
      // connect's mount semantics — `req.originalUrl` keeps the full path, and
      // `req.url` retains a single leading slash, e.g. `/fck_spake2.js`).
      // The handler signature is Vite's `Connect.NextHandleFunction`.
      const handler: Connect.NextHandleFunction = async (req, res, next) => {
        if (req.method !== "GET" && req.method !== "HEAD") {
          next();
          return;
        }
        // req.url is the suffix after the mount prefix and may carry a query;
        // drop the query and any leading slash so it is a bare file name.
        const url = req.url ?? "";
        const queryIndex = url.indexOf("?");
        const urlPath = queryIndex === -1 ? url : url.slice(0, queryIndex);
        const fileName = urlPath.startsWith("/") ? urlPath.slice(1) : urlPath;
        if (fileName === "" || fileName.includes("..") || fileName.includes("/")) {
          // Empty, escaped, or nested paths are not part of the committed pkg.
          res.statusCode = 404;
          res.end();
          return;
        }
        const absolutePath = resolve(spake2PkgDir, fileName);
        // Defense-in-depth against traversal: the resolved path must stay
        // inside spake2PkgDir even if the `..`/`/` guards above were bypassed.
        if (relative(spake2PkgDir, absolutePath).startsWith("..")) {
          res.statusCode = 404;
          res.end();
          return;
        }
        try {
          const body = await readFile(absolutePath);
          res.setHeader("Content-Type", spake2ContentType(fileName));
          res.setHeader("Content-Length", body.byteLength);
          if (req.method === "HEAD") {
            res.end();
            return;
          }
          res.end(body);
        } catch {
          // Missing file (or unreadable) → let the client see a clean 404.
          res.statusCode = 404;
          res.end();
        }
      };
      server.middlewares.use(route, handler);
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
        // R7/F5: dedicated health probe. Exercises TURN-config consistency +
        // the credential-minting path rather than the static SPA shell, so a
        // broken /ice-config fails the docker healthcheck instead of hiding
        // behind a prerendered page. See src/server/healthz.ts.
        { route: "/healthz", handler: "./src/server/healthz.ts" },
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
    serveSpake2PkgPlugin(),
  ],
});
