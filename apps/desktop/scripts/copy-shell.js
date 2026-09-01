#!/usr/bin/env node
/**
 * Tauri expects `index.html` at the root of `build.frontendDist`, but the web
 * build (TanStack Start in SPA mode via the `emitSpake2PkgPlugin` + nitro
 * pipeline in apps/web/vite.config.ts) emits the SSR-prerendered shell as
 * `_shell.html`. Tauri's custom-protocol asset loader will not rewrite the
 * filename, so the desktop build must present `index.html` at the dist root.
 *
 * This script runs in `tauri.conf.json > build.beforeBuildCommand` AFTER
 * `pnpm --filter web build` has produced `.output/public/_shell.html`. It
 * copies `_shell.html` → `index.html` in place (leaving `_shell.html` intact
 * so the web deploy keeps working). Idempotent: a stale `index.html` from a
 * prior run is overwritten on the next.
 *
 * Run from `apps/desktop` (the cwd Tauri sets for beforeBuildCommand):
 *   node scripts/copy-shell.js
 */
import { copyFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, "../../web/.output/public");
const src = resolve(publicDir, "_shell.html");
const dest = resolve(publicDir, "index.html");

try {
  await copyFile(src, dest);
  console.log(`[copy-shell] ${src} -> ${dest}`);
} catch (err) {
  if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
    console.error(
      `[copy-shell] _shell.html not found at ${src}. Run "pnpm --filter web build" first.`,
    );
  }
  throw err;
}
