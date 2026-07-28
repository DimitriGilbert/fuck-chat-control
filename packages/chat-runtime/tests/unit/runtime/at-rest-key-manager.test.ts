import { describe, expect, it } from "vitest";

import { unwrapKey, wrapKey } from "@fuck-eu-chat-control/chat-runtime/crypto";
import {
  AT_REST_STORAGE_KEY,
  createAtRestKeyManager,
} from "@fuck-eu-chat-control/chat-runtime/runtime/at-rest-key-manager";

import { bytesEqual, fakeStorage } from "./_helpers";

const AES_KEY_BYTES = 32;

describe("createAtRestKeyManager", () => {
  it("throws when get() is called before ensureLoaded()", () => {
    const storage = fakeStorage();
    const manager = createAtRestKeyManager(storage);
    expect(() => manager.get()).toThrowError(/ensureLoaded/i);
  });

  it("generates and persists an auto at-rest key on first load", async () => {
    const storage = fakeStorage();
    const manager = createAtRestKeyManager(storage);
    await manager.ensureLoaded();
    const key = manager.get();
    expect(key.length).toBe(AES_KEY_BYTES);
    expect(storage.store.has(AT_REST_STORAGE_KEY)).toBe(true);
  });

  it("returns the SAME key across reloads (auto mode)", async () => {
    const storage = fakeStorage();
    const first = createAtRestKeyManager(storage);
    await first.ensureLoaded();
    const keyA = first.get();

    const second = createAtRestKeyManager(storage);
    await second.ensureLoaded();
    const keyB = second.get();

    expect(bytesEqual(keyB, keyA)).toBe(true);
  });

  it("ensureLoaded is idempotent within a single manager", async () => {
    const storage = fakeStorage();
    const manager = createAtRestKeyManager(storage);
    await manager.ensureLoaded();
    const before = manager.get();
    await manager.ensureLoaded();
    const after = manager.get();
    expect(bytesEqual(after, before)).toBe(true);
  });

  it("setPassphrase wraps the auto key; unlock with the right passphrase restores it", async () => {
    const storage = fakeStorage();
    const manager = createAtRestKeyManager(storage);
    await manager.ensureLoaded();
    const autoKey = manager.get();

    // Wrap the auto key under a passphrase. After this the stored value is
    // the wrapped form, not the raw key.
    await manager.setPassphrase("correct horse battery staple");
    const stored = storage.store.get(AT_REST_STORAGE_KEY);
    expect(typeof stored).toBe("string");
    const parsed = JSON.parse(stored as string) as { mode: string };
    expect(parsed.mode).toBe("passphrase");

    // lock() then unlock() must restore the original key.
    manager.lock();
    expect(() => manager.get()).toThrowError(/locked/i);

    const ok = await manager.unlock("correct horse battery staple");
    expect(ok).toBe(true);
    expect(bytesEqual(manager.get(), autoKey)).toBe(true);
  });

  it("unlock with the wrong passphrase returns false and leaves the key locked", async () => {
    const storage = fakeStorage();
    const manager = createAtRestKeyManager(storage);
    await manager.ensureLoaded();
    await manager.setPassphrase("the-real-passphrase");

    manager.lock();
    const ok = await manager.unlock("not-the-real-passphrase");
    expect(ok).toBe(false);
    expect(() => manager.get()).toThrowError(/locked/i);
  });

  it("a wrapped key persists across reloads; the second manager must unlock to use it", async () => {
    const storage = fakeStorage();
    const first = createAtRestKeyManager(storage);
    await first.ensureLoaded();
    const autoKey = first.get();
    await first.setPassphrase("shared-passphrase");

    // New manager, same storage: ensureLoaded sees the wrapped form, stays
    // locked until unlock() provides the passphrase.
    const second = createAtRestKeyManager(storage);
    await second.ensureLoaded();
    expect(() => second.get()).toThrowError(/locked/i);
    const ok = await second.unlock("shared-passphrase");
    expect(ok).toBe(true);
    expect(bytesEqual(second.get(), autoKey)).toBe(true);
  });

  it("lock() on an auto-mode key still throws get() while locked", async () => {
    const storage = fakeStorage();
    const manager = createAtRestKeyManager(storage);
    await manager.ensureLoaded();
    manager.lock();
    expect(() => manager.get()).toThrowError(/locked/i);
  });

  it("round-trip a key under passphrase via wrapKey/unwrapKey directly", async () => {
    const storage = fakeStorage();
    const manager = createAtRestKeyManager(storage);
    await manager.ensureLoaded();
    const autoKey = manager.get();
    const wrapped = await wrapKey("hunter2", autoKey);
    const restored = await unwrapKey("hunter2", wrapped);
    expect(bytesEqual(restored, autoKey)).toBe(true);
  });
});
