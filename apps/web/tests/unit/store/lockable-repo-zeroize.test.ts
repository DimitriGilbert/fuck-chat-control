import { describe, expect, it } from "vitest";

import { generateAtRestKey } from "@fuck-eu-chat-control/chat-runtime/crypto";
import type { AtRestKeyManager } from "@fuck-eu-chat-control/chat-runtime/runtime/at-rest-key-manager";
import { InMemoryConversationRepository } from "@fuck-eu-chat-control/chat-runtime/store/in-memory-repo";
import { LockableRepository } from "@fuck-eu-chat-control/chat-runtime/store/lockable-repo";

/**
 * CR-7: when the {@link AtRestKeyManager} transitions to locked, the
 * {@link LockableRepository} wrapper must zeroize the inner
 * {@link InMemoryConversationRepository}'s at-rest key reference (overwrite
 * bytes with zeros, then null the field) so an attacker reading the JS heap
 * while locked cannot recover the live key.
 *
 * These tests use a minimal in-process manager stub whose `lock()` fires the
 * `onLock` listeners exactly as the real
 * {@link createAtRestKeyManager} does. The authoritative functional lock
 * (assertUnlocked throwing {@link AtRestLockedError}) is covered by
 * `lock-revokes-repo.test.ts`; here we assert the defense-in-depth zeroize.
 */

function makeManager(initiallyLocked: boolean): AtRestKeyManager {
  let locked = initiallyLocked;
  const lockListeners = new Set<() => void>();
  const unlockListeners = new Set<() => void>();
  const key = generateAtRestKey();
  return {
    async ensureLoaded(): Promise<void> {},
    get(): ReturnType<AtRestKeyManager["get"]> {
      return key;
    },
    lock(): void {
      const was = locked;
      locked = true;
      // Mirror the real manager: only fire on the unlocked → locked edge so a
      // no-op re-lock does not re-zeroize.
      if (!was) {
        for (const cb of Array.from(lockListeners)) {
          try {
            cb();
          } catch {
            // mirror the real manager's defensive swallow
          }
        }
      }
    },
    async unlock(): Promise<boolean> {
      locked = false;
      for (const cb of Array.from(unlockListeners)) {
        try {
          cb();
        } catch {
          // mirror the real manager's defensive swallow
        }
      }
      return true;
    },
    async setPassphrase(): Promise<void> {},
    isLocked(): boolean {
      return locked;
    },
    onUnlock(callback: () => void): () => void {
      unlockListeners.add(callback);
      return () => {
        unlockListeners.delete(callback);
      };
    },
    onLock(callback: () => void): () => void {
      lockListeners.add(callback);
      return () => {
        lockListeners.delete(callback);
      };
    },
  };
}

describe("LockableRepository zeroize on lock (CR-7)", () => {
  it("inner at-rest key is null after manager.lock()", () => {
    const manager = makeManager(false);
    const inner = new InMemoryConversationRepository(generateAtRestKey());
    // The wrapper is constructed for its side effect (registering onLock
    // against the manager); it is held only via `inner`, which the test
    // asserts against after lock.
    new LockableRepository(inner, manager);

    // Precondition: inner repo has a live key reference.
    expect(inner._atRestKeyIsZeroizedForTest()).toBe(false);

    manager.lock();

    // Post-lock: the inner reference has been dropped (zeroized + nulled).
    expect(inner._atRestKeyIsZeroizedForTest()).toBe(true);
  });

  it("inner at-rest key bytes are overwritten with zeros before the reference drops", () => {
    const manager = makeManager(false);
    // Hold the key outside so we can read it after the inner reference drops.
    // The InMemoryConversationRepository stores the AtRestKey reference
    // directly (no copy in the constructor), so `key` and the inner repo's
    // field point at the SAME underlying buffer. zeroizeAtRestKey calls
    // `this.atRestKey.fill(0)`, which mutates that buffer in place — so the
    // external `key` reference observes the zeros after lock. This proves the
    // bytes were actually wiped, not just the reference nulled.
    const key = generateAtRestKey();
    const inner = new InMemoryConversationRepository(key);
    new LockableRepository(inner, manager);

    manager.lock();

    expect(inner._atRestKeyIsZeroizedForTest()).toBe(true);
    // The buffer we held from construction must now read all zeros (the
    // underlying ArrayBuffer was filled with zeros before the reference drop).
    let allZero = true;
    for (let i = 0; i < key.length; i++) {
      if (key[i] !== 0) {
        allZero = false;
        break;
      }
    }
    expect(allZero).toBe(true);
  });

  it("lock() before unlock (already locked) does NOT re-fire zeroize or throw", () => {
    const manager = makeManager(false);
    const inner = new InMemoryConversationRepository(generateAtRestKey());
    new LockableRepository(inner, manager);

    manager.lock();
    expect(inner._atRestKeyIsZeroizedForTest()).toBe(true);

    // A second lock() is a no-op edge (already locked). The wrapper must not
    // throw and the inner state stays zeroized (idempotent).
    expect(() => manager.lock()).not.toThrow();
    expect(inner._atRestKeyIsZeroizedForTest()).toBe(true);
  });

  it("onLock listener is isolated from throwing peers (defensive swallow)", () => {
    const manager = makeManager(false);
    const inner = new InMemoryConversationRepository(generateAtRestKey());
    // Register a throwing listener BEFORE the wrapper registers its own; both
    // must run (the manager snapshots the set), and the throw must not stop
    // the wrapper's zeroize from firing.
    manager.onLock(() => {
      throw new Error("listener peer failure");
    });
    new LockableRepository(inner, manager);

    expect(() => manager.lock()).not.toThrow();
    // The wrapper's zeroize still ran despite the earlier listener throwing.
    expect(inner._atRestKeyIsZeroizedForTest()).toBe(true);
  });

  it("constructing the wrapper does NOT immediately zeroize (only on the lock edge)", () => {
    const manager = makeManager(false);
    const inner = new InMemoryConversationRepository(generateAtRestKey());
    new LockableRepository(inner, manager);
    expect(inner._atRestKeyIsZeroizedForTest()).toBe(false);
  });
});
