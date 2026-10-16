import { describe, expect, it } from "vitest";

import { unwrapKey, wrapKey } from "@fuck-eu-chat-control/chat-runtime/crypto";
import type { WrappedKey } from "@fuck-eu-chat-control/chat-runtime/crypto";
import {
  AT_REST_STORAGE_KEY,
  createAtRestKeyManager,
} from "@fuck-eu-chat-control/chat-runtime/runtime/at-rest-key-manager";
import { InMemoryConversationRepository } from "@fuck-eu-chat-control/chat-runtime/store";
import { base64ToBytes } from "@fuck-eu-chat-control/chat-runtime/store/encoding";
import { LockableRepository } from "@fuck-eu-chat-control/chat-runtime/store/lockable-repo";

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

  it("R7F6: a lock() landing mid-unlock() supersedes it — stays locked, fires no onUnlock", async () => {
    const storage = fakeStorage();
    const manager = createAtRestKeyManager(storage);
    await manager.ensureLoaded();
    const autoKey = manager.get();
    await manager.setPassphrase("correct horse battery staple");
    manager.lock();

    let unlockNotifications = 0;
    manager.onUnlock(() => {
      unlockNotifications += 1;
    });

    // unlock() parks on the Argon2 KDF await; the synchronous lock() lands
    // before the continuation resumes (the real-world race: an auto-lock
    // firing while the user's passphrase is being verified).
    const pending = manager.unlock("correct horse battery staple");
    manager.lock();
    const ok = await pending;

    expect(ok).toBe(false);
    expect(manager.isLocked()).toBe(true);
    expect(() => manager.get()).toThrowError(/locked/i);
    expect(unlockNotifications).toBe(0);

    // The superseded unlock left the manager coherent: a fresh unlock with
    // the right passphrase still restores the key and notifies once.
    const ok2 = await manager.unlock("correct horse battery staple");
    expect(ok2).toBe(true);
    expect(bytesEqual(manager.get(), autoKey)).toBe(true);
    expect(unlockNotifications).toBe(1);
  });

  it("R7F6: a lock() landing mid-setPassphrase() keeps the manager locked but persists the wrap", async () => {
    const storage = fakeStorage();
    const manager = createAtRestKeyManager(storage);
    await manager.ensureLoaded();
    const autoKey = manager.get();
    // Snapshot the original bytes BEFORE the lock: the CR-7 onLock listener
    // zeroizes this exact buffer in place, so `autoKey` reads zeros
    // afterwards and cannot serve as the comparison reference.
    const originalKeyBytes = autoKey.slice();
    // Wire the real CR-7 pair: LockableRepository's constructor registers the
    // onLock listener that calls repo.zeroizeAtRestKey() → atRestKey.fill(0)
    // on the SAME Uint8Array instance setPassphrase passes into wrapKey. This
    // is what makes the wrap-of-zeros regression actually reachable: without
    // wrapKey's entry-time snapshot, the KDF await resumes over the zeroed
    // buffer and persists a wrap of 32 zero bytes.
    const inner = new InMemoryConversationRepository(autoKey);
    void new LockableRepository(inner, manager);

    // setPassphrase() parks on the wrapKey KDF await; lock() lands
    // mid-await, zeroizing the shared key buffer in place.
    const pending = manager.setPassphrase("hunter2");
    manager.lock();
    await pending;

    // The lock wins: the manager stays locked, get() keeps throwing, and the
    // inner repo's key was zeroized (proves the fill(0) path ran).
    expect(manager.isLocked()).toBe(true);
    expect(() => manager.get()).toThrowError(/locked/i);
    expect(inner._atRestKeyIsZeroizedForTest()).toBe(true);

    // The wrapped form WAS persisted (the caller's protection intent is not
    // silently dropped) — and it must seal the ORIGINAL key bytes, not the
    // zeros the lock listener wrote mid-KDF.
    const stored = storage.store.get(AT_REST_STORAGE_KEY);
    expect(typeof stored).toBe("string");
    const parsed = JSON.parse(stored as string) as { mode: string; wrappedBase64: string };
    expect(parsed.mode).toBe("passphrase");
    const unwrappedRecord = await unwrapKey(
      "hunter2",
      base64ToBytes(parsed.wrappedBase64) as unknown as WrappedKey,
    );
    expect(bytesEqual(unwrappedRecord, originalKeyBytes)).toBe(true);
    expect(bytesEqual(unwrappedRecord, new Uint8Array(AES_KEY_BYTES))).toBe(false);

    const ok = await manager.unlock("hunter2");
    expect(ok).toBe(true);
    expect(bytesEqual(manager.get(), originalKeyBytes)).toBe(true);
  });
});
