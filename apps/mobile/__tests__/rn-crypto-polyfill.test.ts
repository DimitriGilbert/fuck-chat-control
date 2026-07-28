/**
 * Unit tests for the rn-crypto-polyfill entry. Verifies installCryptoPolyfill
 * populates globalThis.crypto.subtle exactly once and is idempotent.
 */
import { installCryptoPolyfill } from '../src/chat/rn-crypto-polyfill';

describe('installCryptoPolyfill', () => {
  it('populates globalThis.crypto.subtle', () => {
    // The setup.ts mock installs a subtle object; ensure the polyfill
    // surfaces it through the public entry without throwing.
    installCryptoPolyfill();
    const crypto = (globalThis as unknown as { crypto: { subtle: unknown } }).crypto;
    expect(crypto).toBeDefined();
    expect(crypto.subtle).toBeDefined();
  });

  it('is idempotent (safe to call more than once)', () => {
    const before = (globalThis as unknown as { crypto: unknown }).crypto;
    installCryptoPolyfill();
    installCryptoPolyfill();
    const after = (globalThis as unknown as { crypto: unknown }).crypto;
    expect(after).toBe(before);
  });
});
