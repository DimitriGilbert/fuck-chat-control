/**
 * Installs `react-native-quick-crypto`'s WebCrypto (`crypto.subtle`) onto
 * `globalThis.crypto` BEFORE any chat-runtime module is imported.
 *
 * chat-runtime's crypto modules (`primitives.ts`, `export-bundle.ts`,
 * `in-memory-repo.ts`, `orchestrator.ts`) call `globalThis.crypto.subtle`
 * directly at ~9 sites (documented in
 * packages/chat-runtime/src/crypto/webcrypto-env.d.ts). Hermes does NOT ship
 * WebCrypto, so the app entry MUST install this polyfill before the first
 * chat-runtime import is evaluated.
 *
 * `react-native-quick-crypto`'s `install()` patches `global.crypto` and
 * `global.Buffer`; see
 * https://github.com/margelo/react-native-quick-crypto/blob/main/docs/content/docs/guides/migration.mdx
 * (Global Crypto Polyfill). We additionally pin the `crypto.subtle` object
 * onto `globalThis.crypto` so subsequent reads (the runtime accesses
 * `globalThis.crypto.subtle`) resolve to the JSI-backed implementation.
 */
import { install } from "react-native-quick-crypto";

import type { Crypto } from "./crypto-types";

let installed = false;

/**
 * Install the WebCrypto polyfill on `globalThis`. Idempotent — safe to call
 * more than once (the entry imports it once). MUST be invoked at the very top
 * of the app entry, before any `import ... from '@fuck-eu-chat-control/...'`.
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
    // let chat-runtime dereference `undefined.subtle` later.
    throw new Error("react-native-quick-crypto install() did not populate globalThis.crypto");
  }
  installed = true;
}
