/**
 * Unit tests for the MMKV storage adapter. Verifies ONE instance satisfies the
 * chat-runtime storage surface (getItem/setItem) and that the sync contract
 * holds (the value is immediately readable after setItem, no await).
 */
import { chatStorage } from "../src/chat/mmkv-storage";

describe("chatStorage (MMKV adapter)", () => {
  it("writes and reads a value synchronously", () => {
    chatStorage.setItem("fck-test-key", "payload");
    // Synchronous read — no await. This is the load-bearing contract: the
    // managers call storage.getItem() right after ensureLoaded(), and the
    // controller reads atRestKeyManager.get() synchronously at construction.
    const read = chatStorage.getItem("fck-test-key");
    expect(read).toBe("payload");
  });

  it("returns null for missing keys (mirrors localStorage.getItem)", () => {
    const read = chatStorage.getItem("fck-missing-key-" + Date.now());
    expect(read).toBeNull();
  });

  it("overwrites an existing key on subsequent setItem", () => {
    chatStorage.setItem("fck-overwrite", "first");
    chatStorage.setItem("fck-overwrite", "second");
    expect(chatStorage.getItem("fck-overwrite")).toBe("second");
  });
});
