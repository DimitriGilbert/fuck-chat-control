/**
 * Dynamic-import loader for the committed SPAKE2 wasm pkg — the Metro/React
 * Native half of a platform-split pair (see `pake-loader.ts`).
 *
 * Metro rewrites an import of `./pake-loader` to THIS file on native platforms
 * (`.native.ts` beats `.ts` in Metro's platform-suffixed resolution order), so
 * the web/desktop bundle never contains this code and the RN bundle never
 * contains the real `import(variable)` syntax that Metro's transformer
 * rejects. Vite, Node, vitest, and tsc all resolve `./pake-loader` to the
 * plain `pake-loader.ts` and never load this module.
 *
 * The dynamic `import()` is hidden behind `new Function` so Metro's static
 * analyzer treats it as an opaque runtime eval it cannot see. That matters
 * twice: Metro's transformer rejects `import(variable)` outright, AND Metro's
 * resolver fails on `import(literalPathOnBlockList)` instead of dropping it —
 * `apps/mobile/metro.config.js` blockLists the `wasm/spake2/pkg/` artifacts,
 * so routing through `new Function` sidesteps both.
 *
 * React Native v1 is safety-number-only: `enablePake: false` means no `~code`
 * invitation ever reaches `createPakeSession`, so this function is dead code
 * that is never invoked on native. The `new Function` is constructed lazily
 * inside the call so even its creation only happens if the impossible
 * invocation happens.
 */
export function dynamicImport(specifier: string): Promise<unknown> {
  const importer = new Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<unknown>;
  return importer(specifier);
}
