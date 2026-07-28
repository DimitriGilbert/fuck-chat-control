import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { generateAtRestKey } from "@fuck-eu-chat-control/chat-runtime/crypto";
import { encodeConversationId } from "@fuck-eu-chat-control/chat-runtime/protocol/codec";
import { CONVERSATION_ID_BYTES } from "@fuck-eu-chat-control/chat-runtime/protocol/limits";
import type { ConversationId } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import type { AtRestKeyManager } from "@fuck-eu-chat-control/chat-runtime/runtime/at-rest-key-manager";
import { AtRestLockedError } from "@fuck-eu-chat-control/chat-runtime/runtime/at-rest-key-manager";
import { InMemoryConversationRepository } from "@fuck-eu-chat-control/chat-runtime/store/in-memory-repo";
import { LockableRepository } from "@fuck-eu-chat-control/chat-runtime/store/lockable-repo";
import { MessageDirection } from "@fuck-eu-chat-control/chat-runtime/store/types";
import { AUTH_FAILED_STORAGE_KEY } from "@fuck-eu-chat-control/chat-runtime/store/auth-failed-store";
import { setDurableStorage } from "@fuck-eu-chat-control/chat-runtime/store/durable-storage";
import { MemoryStorage } from "./_helpers";

let storage: MemoryStorage;

function conversationId(seed: number): ConversationId {
  const bytes = new Uint8Array(CONVERSATION_ID_BYTES);
  for (let i = 0; i < CONVERSATION_ID_BYTES; i++) bytes[i] = (seed * 31 + i) & 0xff;
  return encodeConversationId(bytes);
}

/**
 * Minimal in-process AtRestKeyManager stub whose lock state we can flip
 * directly, mirroring {@link createAtRestKeyManager}'s surface but without
 * storage/crypto. The {@link onUnlock} callback set matches the real manager
 * so the {@link LockableRepository} registers its flush callback against it.
 */
function makeManager(initiallyLocked: boolean): AtRestKeyManager {
  let locked = initiallyLocked;
  const listeners = new Set<() => void>();
  const lockListeners = new Set<() => void>();
  const key = generateAtRestKey();
  return {
    async ensureLoaded(): Promise<void> {},
    get() {
      return key;
    },
    lock(): void {
      const was = locked;
      locked = true;
      // CR-7: mirror the real manager — fire onLock only on the unlocked→
      // locked edge. The pending-auth-failed tests do not assert on the
      // zeroize behavior (see lockable-repo-zeroize.test.ts), but the stub
      // must honor the interface contract so the wrapper's onLock
      // registration does not throw.
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
      for (const cb of Array.from(listeners)) {
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
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
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

function newRepo(manager: AtRestKeyManager): LockableRepository {
  const inner = new InMemoryConversationRepository(generateAtRestKey());
  return new LockableRepository(inner, manager);
}

/** Pre-seed the durable localStorage store with an auth-failed entry for id. */
function seedDurable(id: ConversationId): void {
  const hex = Array.from(id, (b) => b.toString(16).padStart(2, "0")).join("");
  const existing = storage.getItem(AUTH_FAILED_STORAGE_KEY);
  const record: Record<string, true> =
    existing === null ? {} : (JSON.parse(existing) as Record<string, true>);
  record[hex] = true;
  storage.setItem(AUTH_FAILED_STORAGE_KEY, JSON.stringify(record));
}

describe("LockableRepository pending auth-failed (SEC-2)", () => {
  beforeAll(() => {
    // A.6: the durable auth-failed store reads/writes through the injectable
    // DurableStorage. Register an in-memory store so the fallback path in
    // getAuthFailed can run.
    storage = new MemoryStorage();
    setDurableStorage(storage);
  });

  beforeEach(() => {
    storage.clear();
  });

  afterAll(() => {
    setDurableStorage(new MemoryStorage());
  });

  it("markAuthFailed while LOCKED queues the id (does not throw, does not hit inner repo)", async () => {
    const manager = makeManager(true);
    const inner = new InMemoryConversationRepository(generateAtRestKey());
    // Spy on the inner repo's markAuthFailed to prove it is NOT called while
    // locked. We wrap with a Proxy that records calls.
    let innerCalls = 0;
    const spyingInner: typeof inner = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === "markAuthFailed") {
          return async (id: ConversationId): Promise<void> => {
            innerCalls += 1;
            await target.markAuthFailed(id);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const repo = new LockableRepository(spyingInner, manager);

    const id = conversationId(1);
    await inner.createConversation(id, 0);

    // While locked: markAuthFailed must NOT throw AtRestLockedError, and must
    // NOT reach the inner repo.
    await expect(repo.markAuthFailed(id)).resolves.toBeUndefined();
    expect(innerCalls).toBe(0);
  });

  it("getAuthFailed while LOCKED returns durable truth when the durable store has the flag", async () => {
    const manager = makeManager(true);
    const repo = newRepo(manager);
    const id = conversationId(2);

    // The inner repo never recorded the flag (locked), but the durable
    // localStorage store carries the cross-session truth.
    seedDurable(id);

    await expect(repo.getAuthFailed(id)).resolves.toBe(true);
  });

  it("getAuthFailed while LOCKED returns false when neither the queue nor durable store has it", async () => {
    const manager = makeManager(true);
    const repo = newRepo(manager);
    const id = conversationId(3);
    await expect(repo.getAuthFailed(id)).resolves.toBe(false);
  });

  it("getAuthFailed while LOCKED returns true when the id was queued by markAuthFailed this session", async () => {
    const manager = makeManager(true);
    const repo = newRepo(manager);
    const id = conversationId(4);
    // Queue the id via markAuthFailed (locked); the pending set must make
    // getAuthFailed report true even without a durable-store entry.
    await repo.markAuthFailed(id);
    await expect(repo.getAuthFailed(id)).resolves.toBe(true);
  });

  it("flushPendingAuthFailed on unlock writes the queued id to the inner repo", async () => {
    const manager = makeManager(true);
    const inner = new InMemoryConversationRepository(generateAtRestKey());
    const repo = new LockableRepository(inner, manager);
    const id = conversationId(5);
    await inner.createConversation(id, 0);

    // Queue while locked.
    await repo.markAuthFailed(id);
    // Inner repo does NOT yet carry the flag.
    expect(await inner.getAuthFailed(id)).toBe(false);

    // Unlock → manager fires onUnlock → LockableRepository.flushPendingAuthFailed
    // runs → the queued write lands in the inner repo.
    await manager.unlock("any");

    // The flush is async (fire-and-forget inside the wrapper); let it settle.
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(await inner.getAuthFailed(id)).toBe(true);
  });

  it("non-AtRestLockedError failures during flush are forwarded to the flushErrorSink", async () => {
    const manager = makeManager(true);
    const inner = new InMemoryConversationRepository(generateAtRestKey());
    // Make the inner markAuthFailed throw a NON-lock error to simulate a
    // genuine storage failure during replay.
    let sinkCalls = 0;
    let sinkErr: unknown = null;
    const failingInner: typeof inner = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === "markAuthFailed") {
          return async (): Promise<void> => {
            throw new Error("simulated storage failure");
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const repo = new LockableRepository(failingInner, manager);
    repo.setFlushErrorSink((err) => {
      sinkCalls += 1;
      sinkErr = err;
    });

    const id = conversationId(6);
    await inner.createConversation(id, 0);
    await repo.markAuthFailed(id);

    await manager.unlock("any");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(sinkCalls).toBe(1);
    expect(sinkErr).toBeInstanceOf(Error);
    expect((sinkErr as Error).message).toBe("simulated storage failure");
  });

  it("ciphertext-touching methods still throw AtRestLockedError while locked (unchanged behavior)", async () => {
    const manager = makeManager(true);
    const repo = newRepo(manager);
    const id = conversationId(7);
    // appendMessage touches ciphertext and must still throw the lock error.
    await expect(
      repo.appendMessage(id, "text", MessageDirection.Sent, 0),
    ).rejects.toBeInstanceOf(AtRestLockedError);
  });
});
