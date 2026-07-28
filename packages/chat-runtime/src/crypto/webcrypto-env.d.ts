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
