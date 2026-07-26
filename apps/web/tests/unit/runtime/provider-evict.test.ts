import { describe, expect, it } from "vitest";

import {
  createAtRestKeyManager,
  AtRestKeyLockedError,
} from "@/features/chat/runtime/at-rest-key-manager";
import {
  createIdentityManager,
  IDENTITY_STORAGE_KEY,
} from "@/features/chat/runtime/identity-manager";

import { fakeStorage } from "./_helpers";

/**
 * R9/F8: on ChatProvider unmount, the cleanup calls `atRestKeyManager.lock()`
 * and `identityManager.evict()`. The provider hardcodes browser globals
 * (`window.localStorage`, `window.location`, `new WebSocket`), so a full
 * React render test would need to mock all of them — and would only
 * re-assert that two specific methods are called. The load-bearing contract
 * is that those methods actually drop their in-memory secrets while leaving
 * the persisted storage intact for the next mount. That is what these tests
 * pin down.
 */
describe("identityManager.evict() drops in-memory identity but keeps storage (R9/F8)", () => {
  it("get() throws after evict() until ensureLoaded() runs again", async () => {
    const storage = fakeStorage();
    const manager = createIdentityManager(storage);
    await manager.ensureLoaded();
    const before = manager.get();
    expect(before.publicKey.length).toBe(65);

    manager.evict();

    expect(() => manager.get()).toThrowError(/ensureLoaded/i);

    // Re-loading repopulates from the persisted form — storage was NOT touched.
    await manager.ensureLoaded();
    const after = manager.get();
    expect(after.publicKey.length).toBe(65);
    // Same key (deterministic reload from the same persisted base64).
    let same = true;
    for (let i = 0; i < before.publicKey.length; i++) {
      if (before.publicKey[i] !== after.publicKey[i]) {
        same = false;
        break;
      }
    }
    expect(same).toBe(true);
  });

  it("evict() is idempotent and does not touch persisted storage", async () => {
    const storage = fakeStorage();
    const manager = createIdentityManager(storage);
    await manager.ensureLoaded();
    const rawAfterLoad = storage.store.get(IDENTITY_STORAGE_KEY);

    manager.evict();
    manager.evict();

    expect(storage.store.get(IDENTITY_STORAGE_KEY)).toBe(rawAfterLoad);
  });

  it("evict() on a manager that never loaded does not throw and stays unloaded", () => {
    const storage = fakeStorage();
    const manager = createIdentityManager(storage);
    expect(() => manager.evict()).not.toThrow();
    expect(() => manager.get()).toThrowError(/ensureLoaded/i);
  });
});

describe("atRestKeyManager.lock() drops the in-memory key but keeps storage (R9/F8)", () => {
  it("get() throws AtRestKeyLockedError after lock() until unlock()", async () => {
    const storage = fakeStorage();
    const manager = createAtRestKeyManager(storage);
    await manager.ensureLoaded();
    expect(manager.isLocked()).toBe(false);
    const before = manager.get();
    expect(before.length).toBeGreaterThan(0);

    manager.lock();

    expect(manager.isLocked()).toBe(true);
    expect(() => manager.get()).toThrowError(AtRestKeyLockedError);

    // Auto-mode unlock repopulates from storage — persisted form intact.
    const ok = await manager.unlock("anything");
    expect(ok).toBe(true);
    expect(manager.isLocked()).toBe(false);
    const after = manager.get();
    expect(after.length).toBe(before.length);
  });
});

/**
 * Composite: simulate the provider's exact unmount sequence — dispose the
 * controller (not asserted here), then lock() + evict(). After that, fresh
 * managers built on the same storage must rehydrate to the same secrets,
 * which is exactly what the provider needs for its next mount.
 */
describe("provider unmount sequence: lock() + evict() leaves storage re-loadable (R9/F8)", () => {
  it("a fresh pair of managers on the same storage sees the same keys after eviction", async () => {
    const identityStorage = fakeStorage();
    const atRestStorage = fakeStorage();

    const identityManager = createIdentityManager(identityStorage);
    const atRestKeyManager = createAtRestKeyManager(atRestStorage);
    await identityManager.ensureLoaded();
    await atRestKeyManager.ensureLoaded();
    const identityBefore = identityManager.get();
    const atRestBefore = atRestKeyManager.get();

    // The provider's exact cleanup sequence.
    atRestKeyManager.lock();
    identityManager.evict();

    // A new mount builds new managers on the same storage and rehydrates.
    const identityReloaded = createIdentityManager(identityStorage);
    const atRestReloaded = createAtRestKeyManager(atRestStorage);
    await identityReloaded.ensureLoaded();
    await atRestReloaded.ensureLoaded();

    const identityAfter = identityReloaded.get();
    const atRestAfter = atRestReloaded.get();

    // Same identity key.
    let identitySame = identityBefore.publicKey.length === identityAfter.publicKey.length;
    for (let i = 0; identitySame && i < identityBefore.publicKey.length; i++) {
      if (identityBefore.publicKey[i] !== identityAfter.publicKey[i]) identitySame = false;
    }
    expect(identitySame).toBe(true);

    // Same at-rest key.
    let atRestSame = atRestBefore.length === atRestAfter.length;
    for (let i = 0; atRestSame && i < atRestBefore.length; i++) {
      if (atRestBefore[i] !== atRestAfter[i]) atRestSame = false;
    }
    expect(atRestSame).toBe(true);
  });
});
