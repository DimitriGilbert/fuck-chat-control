/**
 * Unit tests for the rn-crypto-polyfill entry (R12F1). The module
 * SELF-INSTALLS at evaluation: the bare `import` below must populate
 * globalThis.crypto with no call — that is what lets the first-edge
 * `import "./rn-crypto-polyfill"` in index.ts/App.tsx beat the
 * @noble/hashes crypto snapshot. setup.ts mocks
 * react-native-quick-crypto's install() to install a no-op subtle +
 * getRandomValues on globalThis.
 */
import { installCryptoPolyfill } from "../src/chat/rn-crypto-polyfill";

describe("rn-crypto-polyfill module side effect", () => {
  it("populates globalThis.crypto at module evaluation — no call required", () => {
    // Deliberately NO installCryptoPolyfill() call in this test: the import
    // above already ran the module body, which must itself have installed
    // the polyfill. (Order matters: this assertion runs before the test
    // below calls the exported function, so it cannot pass off a manual
    // call as a module-eval install.)
    const crypto = (
      globalThis as unknown as {
        crypto: { subtle: unknown; getRandomValues: unknown };
      }
    ).crypto;
    expect(crypto).toBeDefined();
    expect(crypto.subtle).toBeDefined();
    expect(typeof crypto.getRandomValues).toBe("function");
  });
});

describe("installCryptoPolyfill", () => {
  it("is idempotent when called after module evaluation", () => {
    // The module already installed at evaluation, so these calls are no-ops;
    // the crypto object identity must not change.
    const before = (globalThis as unknown as { crypto: unknown }).crypto;
    installCryptoPolyfill();
    installCryptoPolyfill();
    const after = (globalThis as unknown as { crypto: unknown }).crypto;
    expect(after).toBe(before);
  });
});
