/**
 * Dynamic-import loader for the committed SPAKE2 wasm pkg — the bundler-friendly
 * half of a platform-split pair (see `pake-loader.native.ts`).
 *
 * THIS file is the one resolved by Vite (web + desktop), Node, and vitest: an
 * import of `./pake-loader` has no `.native` platform suffix, so Metro is the
 * only bundler that rewrites it to `pake-loader.native.ts` (Metro resolves
 * `pake-loader.native.ts` ahead of `pake-loader.ts` for native platforms).
 * Vite/Rollup, Node, and tsc resolve this plain `.ts` file directly and never
 * even see the `.native` sibling.
 *
 * Here the import is a REAL dynamic `import()` guarded with `@vite-ignore` so
 * Vite's build leaves it as a native runtime import instead of trying to
 * resolve the (variable) specifier at build time. A native dynamic import is a
 * script FETCH subject to `script-src`, not an eval — it runs fine under the
 * desktop production CSP (`script-src 'self' ... 'wasm-unsafe-eval'`, no
 * `'unsafe-eval'`). The specifier is either the absolute URL registered via
 * `setSpake2ModuleUrl` (web/desktop) or the source-tree-relative default used
 * by Node tooling.
 *
 * Metro cannot use this form: its transformer rejects `import(variable)`
 * outright, and its resolver fails on a literal specifier that hits a
 * blockList entry (the mobile app blockLists the wasm pkg). Hence the
 * `new Function` indirection in `pake-loader.native.ts`.
 */
export async function dynamicImport(specifier: string): Promise<unknown> {
  return await import(/* @vite-ignore */ specifier);
}
