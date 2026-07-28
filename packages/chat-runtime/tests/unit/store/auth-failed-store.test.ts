import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { encodeConversationId } from "@fuck-eu-chat-control/chat-runtime/protocol/codec";
import type { ConversationId } from "@fuck-eu-chat-control/chat-runtime/protocol/types";

import {
  AUTH_FAILED_STORAGE_KEY,
  getAuthFailedDurable,
  markAuthFailedDurable,
} from "@fuck-eu-chat-control/chat-runtime/store/auth-failed-store";
import { setDurableStorage } from "@fuck-eu-chat-control/chat-runtime/store/durable-storage";
import { MemoryStorage } from "./_helpers";

function conversationIdFromHex(hex: string): ConversationId {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return encodeConversationId(bytes);
}

const ID_A = conversationIdFromHex("00112233445566778899aabbccddeeff");
const ID_B = conversationIdFromHex("ffeeddccbbaa99887766554433221100");

function hexOf(id: ConversationId): string {
  return Array.from(id, (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("auth-failed-store (SEC-1)", () => {
  let storage: MemoryStorage;

  beforeAll(() => {
    // A.6: the store reads/writes through the injectable DurableStorage, not
    // the `localStorage` global. Register an in-memory store for the suite.
    storage = new MemoryStorage();
    setDurableStorage(storage);
  });

  beforeEach(() => {
    storage.clear();
  });

  afterAll(() => {
    // Clear the registration so other suites start from a clean slate.
    setDurableStorage(new MemoryStorage());
  });

  it("persists the flag across a simulated reload (fresh read returns true)", async () => {
    // Write the flag for conversation A.
    await markAuthFailedDurable(ID_A);
    expect(storage.getItem(AUTH_FAILED_STORAGE_KEY)).not.toBeNull();

    // Simulate a "reload": a brand-new read of the store (the module's
    // functions read localStorage fresh on every call — no in-memory cache —
    // so this is exactly what the next session-start sees).
    expect(await getAuthFailedDurable(ID_A)).toBe(true);
  });

  it("isolates conversations: marking A does not set B", async () => {
    await markAuthFailedDurable(ID_A);
    expect(await getAuthFailedDurable(ID_A)).toBe(true);
    expect(await getAuthFailedDurable(ID_B)).toBe(false);
  });

  it("returns false for an unmarked conversation before any write", async () => {
    expect(await getAuthFailedDurable(ID_A)).toBe(false);
  });

  it("writes a JSON-encoded Record<string, true> under the documented key", async () => {
    await markAuthFailedDurable(ID_A);
    await markAuthFailedDurable(ID_B);

    const raw = storage.getItem(AUTH_FAILED_STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string) as Record<string, unknown>;

    // Shape: every value is exactly `true`, keyed by the lowercase hex of the
    // 16-byte ConversationId (32 chars).
    const keys = Object.keys(parsed);
    expect(keys).toHaveLength(2);
    for (const [key, value] of Object.entries(parsed)) {
      expect(value).toBe(true);
      expect(key).toMatch(/^[0-9a-f]{32}$/);
    }
    // The id-key matches the repository's idKey convention (lowercase hex).
    expect(parsed[hexOf(ID_A)]).toBe(true);
  });

  it("marks idempotently: re-marking A is a no-op on the key set", async () => {
    await markAuthFailedDurable(ID_A);
    await markAuthFailedDurable(ID_A);
    expect(await getAuthFailedDurable(ID_A)).toBe(true);

    const parsed = JSON.parse(storage.getItem(AUTH_FAILED_STORAGE_KEY) as string) as Record<
      string,
      true
    >;
    expect(Object.keys(parsed)).toHaveLength(1);
  });

  it("survives a corrupt payload: a bad JSON read yields false, not a throw", async () => {
    storage.setItem(AUTH_FAILED_STORAGE_KEY, "{not valid json");
    // The read must not throw — it degrades to false so session start is safe.
    await expect(getAuthFailedDurable(ID_A)).resolves.toBe(false);

    // And a subsequent write repairs the payload.
    await markAuthFailedDurable(ID_A);
    expect(await getAuthFailedDurable(ID_A)).toBe(true);
  });

  it("survives a malformed payload (non-object JSON): degrades to false", async () => {
    storage.setItem(AUTH_FAILED_STORAGE_KEY, JSON.stringify("a string"));
    await expect(getAuthFailedDurable(ID_A)).resolves.toBe(false);
  });

  it("ignores non-true values when reading (defensive shape check)", async () => {
    // An attacker (or buggy future writer) plants a value that is not `true`.
    storage.setItem(AUTH_FAILED_STORAGE_KEY, JSON.stringify({ [hexOf(ID_A)]: false }));
    // Only the literal `true` value counts as auth-failed.
    expect(await getAuthFailedDurable(ID_A)).toBe(false);
  });

  it("best-effort: getAuthFailedDurable never throws when no durable store is registered", async () => {
    // Simulate the "platform never registered a durable store" path (e.g. a
    // misconfigured native shell). A null-ish store that returns null for every
    // read and ignores writes exercises the same degradation the runtime sees
    // when `getDurableStorage()` returns null.
    const absentStore: MemoryStorage = new MemoryStorage();
    spyOnStorage(absentStore, "getItem", () => null);
    spyOnStorage(absentStore, "setItem", () => undefined);
    setDurableStorage(absentStore);
    try {
      await expect(getAuthFailedDurable(ID_A)).resolves.toBe(false);
      // markAuthFailedDurable must also be a no-op (resolve without writing).
      await expect(markAuthFailedDurable(ID_A)).resolves.toBeUndefined();
    } finally {
      setDurableStorage(storage);
    }
  });
});

/** Replace a method on a MemoryStorage with a stub for the duration of a test. */
function spyOnStorage(
  target: MemoryStorage,
  method: "getItem" | "setItem",
  impl: () => string | null | void,
): void {
  Object.defineProperty(target, method, { value: impl, configurable: true });
}
