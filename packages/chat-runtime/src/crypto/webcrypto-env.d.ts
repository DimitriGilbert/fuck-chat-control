/**
 * Ambient type declarations for the platform-neutral runtime.
 *
 * The chat-runtime package compiles with `lib: ["ES2022"]` (no DOM). The
 * WebCrypto global surface (`globalThis.crypto`, `SubtleCrypto`) is provided
 * by `@types/node`'s conditional `var crypto` declaration, so the crypto
 * modules type-check against it unmodified. Three DOM-origin types are missing
 * and are declared here, inside `declare global` so the file can use
 * `import("node:crypto")` for the canonical `CryptoKey` alias while remaining
 * an ambient module:
 *
 *  - `WebAssembly.Module` — referenced by pake.ts's `initSync` binding shape.
 *    `WebAssembly` is part of ES2017+ and present on every target; `lib:
 *    ES2022` omits the namespace declaration.
 *  - `BufferSource` — the DOM `ArrayBufferView | ArrayBuffer` union used in
 *    the same binding shape.
 *  - `CryptoKey` — the opaque key handle returned by `SubtleCrypto.importKey`.
 *    Aliased to `node:crypto`'s `webcrypto.CryptoKey` (the canonical type
 *    `@types/node` already provides) so values flow through without nominal
 *    friction.
 *
 * ----------------------------------------------------------------------------
 * DELIBERATE RUNTIME COUPLING — READ BEFORE PORTING TO A NEW PLATFORM
 * ----------------------------------------------------------------------------
 * The crypto modules (`primitives.ts`, `export-bundle.ts`, `in-memory-repo.ts`,
 * `orchestrator.ts`) call `globalThis.crypto.subtle` directly at ~9+ sites and
 * NOT through an injectable seam. This is an intentional v1 coupling tracked
 * for a Phase C hardening pass (extracting a `CryptoProvider` interface). The
 * consequence for consuming apps:
 *
 *   - The host platform MUST install a WebCrypto implementation on
 *     `globalThis.crypto` BEFORE importing anything from chat-runtime.
 *   - Web browsers and Tauri (with `tauri-plugin-node`) provide
 *     `globalThis.crypto` natively — no action needed.
 *   - React Native / Hermes does NOT ship WebCrypto. The app entry MUST
 *     install `react-native-quick-crypto` (or an equivalent polyfill) on
 *     `globalThis.crypto` before any chat-runtime import is evaluated.
 *
 * Removing or weakening this coupling is Phase C scope; do NOT refactor it
 * ad-hoc. If you add a new platform, satisfy the `globalThis.crypto.subtle`
 * contract at its entry boundary rather than forking the crypto modules.
 */
declare global {
  namespace WebAssembly {
    interface Module {
      // Opaque — callers only pass compiled modules through.
    }
  }

  type BufferSource = ArrayBufferView | ArrayBuffer;

  type CryptoKey = import("node:crypto").webcrypto.CryptoKey;
}

export {};
