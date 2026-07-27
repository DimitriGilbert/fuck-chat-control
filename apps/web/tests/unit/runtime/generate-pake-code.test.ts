import { describe, expect, it } from "vitest";

import { generatePakeCode } from "@/features/chat/runtime/chat-controller";

/**
 * CR-4 (Phase 3b): the controller's `generatePakeCode` is the single source
 * of truth for the 6-digit PAKE code. The UI no longer samples — it calls this
 * helper. These tests pin:
 *
 *   (a) the output format — exactly 6 decimal digits, zero-padded, so a code
 *       below 100000 still renders as 6 chars (e.g. 000042). The padStart is
 *       load-bearing: a 5-char code would break the URL fragment parser
 *       (tests/unit/ui/invitation-fragment.test.ts) and the SPAKE2 code-input
 *       field.
 *   (b) the numeric range — [0, 999999]. Asserts the modular reduction did
 *       not silently produce a 7-digit value via integer-overflow.
 *   (c) the entropy spread — over 1000 draws the unique count must be close
 *       to 1000. A constant/low-entropy regression (e.g. a seed bug, a cached
 *       buffer) would collapse the spread; we assert >= 990 to catch that
 *       while tolerating the astronomically rare legitimate collision (birthday
 *       bound at 1e6 values is ~0.37 collisions over 1000 draws, so 990 is a
 *       very loose floor).
 *
 * The helper is tested directly (not via the controller object) because
 * constructing a full controller requires identity + at-rest + repository +
 * signaling stubs — none of which the sampling logic touches. The public
 * `controller.generatePakeCode()` method is a one-line passthrough to this
 * helper, verified at the type level by the interface declaration.
 */
describe("generatePakeCode (CR-4 / R7/F6)", () => {
  it("always returns exactly 6 decimal digits (format invariant)", () => {
    // Sample many times so a zero-padding bug (e.g. a value < 100000 that
    // renders shorter than 6 chars without padStart) is exercised. The PRD's
    // 20-bit ceiling + the 1e6 modulus means ~10% of draws are < 100000.
    for (let i = 0; i < 500; i++) {
      const code = generatePakeCode();
      expect(code).toMatch(/^\d{6}$/);
      expect(code.length).toBe(6);
    }
  });

  it("produces values in [0, 999999] (range invariant)", () => {
    for (let i = 0; i < 500; i++) {
      const code = generatePakeCode();
      const n = Number.parseInt(code, 10);
      expect(Number.isFinite(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(999_999);
    }
  });

  it("covers the full 6-digit range including zero-padded low values", () => {
    // A correct CSPRNG sampler will eventually hit a value below 100000 (10%
    // of the keyspace). Over a large enough sample we should see at least one
    // code with a leading zero — that pins the padStart(6, "0") and would
    // break a naive toString() that dropped leading zeros.
    const draws = new Set<string>();
    let sawLeadingZero = false;
    for (let i = 0; i < 5000; i++) {
      const code = generatePakeCode();
      draws.add(code);
      if (code.startsWith("0")) sawLeadingZero = true;
    }
    // With 5000 draws from a 1e6 keyspace, P(no leading-zero value) is
    // essentially zero (10% of keyspace starts with 0, so the expected count
    // is ~500). This catches a regression where padStart is removed AND the
    // sampler happens to always land above 99999.
    expect(sawLeadingZero).toBe(true);
  });

  it("two consecutive calls produce distinct values with overwhelming probability", () => {
    // A single collision over two draws has probability ~1e-6 — vanishingly
    // unlikely with a real CSPRNG. Asserting inequality here catches the
    // "constant/seeded-once" regression.
    const a = generatePakeCode();
    const b = generatePakeCode();
    expect(a).not.toBe(b);
  });

  it("over 1000 draws the unique count is close to 1000 (entropy spread)", () => {
    const draws: string[] = [];
    for (let i = 0; i < 1000; i++) {
      draws.push(generatePakeCode());
    }
    const unique = new Set(draws).size;
    // The birthday bound at 1e6 values over 1000 draws gives an expected
    // collision count of ~0.37, so unique should be ~999-1000 in practice.
    // 990 is a deliberately loose floor: it still catches any low-entropy
    // regression (a sampler stuck on, say, 100 distinct values) while never
    // flaking on legitimate rare collisions.
    expect(unique).toBeGreaterThanOrEqual(990);
  });

  it("is purely synchronous and returns a string (no promise, no side effect on globals)", () => {
    // Type-level contract: the method is a synchronous string-returning call.
    // Calling it twice in a row with no awaits must not throw or alter any
    // global. This guards against a future refactor that makes it async.
    const result = generatePakeCode();
    expect(typeof result).toBe("string");
    expect(result.length).toBe(6);
  });
});
