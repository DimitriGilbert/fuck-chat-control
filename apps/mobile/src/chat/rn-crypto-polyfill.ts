/**
 * WebCrypto polyfill entry — SELF-INSTALLING AT MODULE EVALUATION.
 *
 * Importing this module IS the install: the top-level statement at the
 * bottom of this file runs `react-native-quick-crypto`'s `install()`, which
 * patches `global.crypto` and `global.Buffer` with the JSI-backed
 * implementations (see
 * https://github.com/margelo/react-native-quick-crypto/blob/main/docs/content/docs/guides/migration.mdx
 * — Global Crypto Polyfill).
 *
 * WHY MODULE SCOPE, NOT AN EXPORTED CALL (R12F1):
 * `@noble/hashes/crypto.js` snapshots `globalThis.crypto` into a
 * module-scoped const the first time the noble module graph evaluates:
 *
 *   exports.crypto = 'crypto' in globalThis ? globalThis.crypto : undefined;
 *
 * On Hermes (no WebCrypto), a snapshot taken before this file runs stays
 * `undefined` FOR THE PROCESS LIFETIME — every later
 * `p256.utils.randomSecretKey()` throws `crypto.getRandomValues must be
 * defined` and chat never starts. Installing from the IMPORTER's body (the
 * previous App.tsx pattern) can never win that race: all of a module's
 * import edges evaluate depth-first BEFORE the importing module's own
 * statements run, so the chat-runtime → @noble graph had already snapshotted
 * `undefined` by the time `installCryptoPolyfill()` executed.
 *
 * This module MUST therefore be the FIRST import of both entry points —
 * `index.ts` (the Metro `main`, the true first module) and `App.tsx` — and
 * it is imported for its side effect only:
 *
 *   import "./src/chat/rn-crypto-polyfill";
 *
 * chat-runtime's crypto modules (`primitives.ts`, `export-bundle.ts`,
 * `in-memory-repo.ts`, `orchestrator.ts`) call `globalThis.crypto.subtle`
 * directly at ~9 sites; see
 * packages/chat-runtime/src/crypto/webcrypto-env.d.ts.
 */
import { install } from "react-native-quick-crypto";

import type { Crypto } from "./crypto-types";

let installed = false;

/**
 * Install the WebCrypto polyfill on `globalThis`. Idempotent — the module
 * already invokes it at evaluation (see the bottom of this file); the export
 * remains so tests and future embedders can re-assert the invariant without
 * re-importing the module.
 */
export function installCryptoPolyfill(): void {
  if (installed) return;
  // `install()` is provided by react-native-quick-crypto; it patches
  // `global.crypto` and `global.Buffer` with the JSI-backed implementations.
  install();
  // Ensure `globalThis.crypto` is set: quick-crypto's install may attach to
  // `global` (Hermes global object) without assigning to the `globalThis`
  // alias some call sites use. Read it back from the global and assign.
  const globalWithCrypto = globalThis as unknown as { crypto?: Crypto };
  if (globalWithCrypto.crypto === undefined) {
    // If install did not surface `global.crypto`, throw loudly rather than
    // let chat-runtime dereference `undefined.subtle` later — and rather than
    // let @noble/hashes snapshot `undefined` into its module-scoped crypto.
    throw new Error("react-native-quick-crypto install() did not populate globalThis.crypto");
  }
  installed = true;
}

// THE actual install. Runs as this module's top-level statement — i.e. while
// the entry file's FIRST import edge is being evaluated, before any
// subsequent import (chat-runtime → @noble/curves → @noble/hashes) evaluates
// and snapshots `globalThis.crypto`. Do NOT move the import of this module
// below any other import in index.ts or App.tsx.
installCryptoPolyfill();
