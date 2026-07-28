/**
 * Minimal structural typing for the WebCrypto surface chat-runtime consumes.
 *
 * The runtime touches `globalThis.crypto.subtle` (~9 sites, see
 * packages/chat-runtime/src/crypto/webcrypto-env.d.ts) and
 * `globalThis.crypto.getRandomValues` (CSPRNG in crypto/primitives.ts).
 * `react-native-quick-crypto`'s `install()` provides a JSI-backed
 * implementation; we type only the members the app reads so the polyfill
 * entry stays free of `any` without depending on quick-crypto's internal
 * types (which are not exported as a stable surface).
 *
 * The `subtle` object is intentionally opaque: callers route through the
 * named algorithms (`digest`, `importKey`, `deriveBits`, `exportKey`,
 * `generateKey`, `sign`, `verify`, `encrypt`, `decrypt`, ...) and the runtime
 * already declares its own `CryptoKey` alias in
 * packages/chat-runtime/src/crypto/webcrypto-env.d.ts.
 */
export interface SubtleCrypto {
  digest(algorithm: string, data: BufferSource): Promise<ArrayBuffer>;
  importKey(
    format: string,
    keyData: BufferSource,
    algorithm: unknown,
    extractable: boolean,
    keyUsages: readonly string[],
  ): Promise<CryptoKey>;
  deriveBits(
    algorithm: unknown,
    baseKey: CryptoKey,
    length: number,
  ): Promise<ArrayBuffer>;
  exportKey(format: string, key: CryptoKey): Promise<JsonWebKey | ArrayBuffer>;
  generateKey(
    algorithm: unknown,
    extractable: boolean,
    keyUsages: readonly string[],
  ): Promise<CryptoKey | CryptoKeyPair>;
  sign(
    algorithm: unknown,
    key: CryptoKey,
    data: BufferSource,
  ): Promise<ArrayBuffer>;
  verify(
    algorithm: unknown,
    key: CryptoKey,
    signature: BufferSource,
    data: BufferSource,
  ): Promise<boolean>;
  encrypt(
    algorithm: unknown,
    key: CryptoKey,
    data: BufferSource,
  ): Promise<ArrayBuffer>;
  decrypt(
    algorithm: unknown,
    key: CryptoKey,
    data: BufferSource,
  ): Promise<ArrayBuffer>;
}

export interface Crypto {
  readonly subtle: SubtleCrypto;
  getRandomValues<T extends ArrayBufferView>(array: T): T;
  randomUUID(): string;
}
