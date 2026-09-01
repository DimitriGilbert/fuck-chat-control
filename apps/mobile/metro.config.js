const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// Block the SPAKE2 wasm pkg artifacts so Metro does not try to resolve or
// bundle them. RN v1 is safety-number-only and NEVER calls the PAKE path, so
// the wasm module is dead code in this app. Without blocking, Metro errors on
// the `.wasm`/dynamic `import()` inside packages/chat-runtime/src/crypto/pake.ts
// (the dynamic specifier resolves to a path under pkg/).
//
// NOTE (R8/F1 / Phase 6): this blockList is now a DEFENSE-IN-DEPTH layer, not
// the only gate. PAKE-coded invitations are ALSO rejected in LOGIC, at the
// orchestrator's join parse boundary: the mobile chat provider constructs the
// controller with `enablePake: false`, so the orchestrator throws
// OrchestratorError(PakeDisabled) on any `~code` fragment BEFORE it reaches
// createPakeSession/loadWasm. The logic gate is what prevents the mid-handshake
// crash on a `~code` deep link; this blockList merely keeps the wasm out of the
// bundle (smaller binary + a second layer if the logic gate is ever bypassed).
//
// IMPORTANT: pake.ts itself MUST stay resolvable. crypto/index.ts statically
// re-exports VALUE symbols (createPakeSession, derivePakeConfirmationTag,
// pakeOutgoingShare, pakeFinish, roleToSideByte, __setWasmModuleForTests) from
// "./pake" — TS cannot erase them. A Metro blockList entry makes a file
// "completely unavailable for any import or resolution operation", so blocking
// pake.ts would make the `export {...} from "./pake"` edge unresolvable and
// break the bundle. The pkg block alone is sufficient: pake.ts's loadWasm()
// does `import(specifier)` where `specifier` points into the blocked pkg path,
// so the dynamic-import chunk is never bundled; the static value re-exports
// resolve as dead code and the wasm stays unreachable.
config.resolver.blockList = [
  ...(Array.isArray(config.resolver.blockList) ? config.resolver.blockList : []),
  /packages\/chat-runtime\/wasm\/spake2\/pkg\/.*/,
];

module.exports = config;
