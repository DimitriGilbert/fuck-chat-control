import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InMemoryConversationRepository } from "@fuck-eu-chat-control/chat-runtime/store";
import type { ConversationRepository } from "@fuck-eu-chat-control/chat-runtime/store";
import { MessageDirection } from "@fuck-eu-chat-control/chat-runtime/store";
import { LockableRepository } from "@fuck-eu-chat-control/chat-runtime/store/lockable-repo";
import type { ConversationId } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import { AtRestLockedError } from "@fuck-eu-chat-control/chat-runtime/runtime/at-rest-key-manager";
import { createAtRestKeyManager } from "@fuck-eu-chat-control/chat-runtime/runtime/at-rest-key-manager";
import { createChatController, type ChatController } from "@fuck-eu-chat-control/chat-runtime/runtime/chat-controller";
import { stubPeerConnectionFactory } from "./_helpers";
import { createIdentityManager } from "@fuck-eu-chat-control/chat-runtime/runtime/identity-manager";

import { MockSignalingSocket } from "../signaling/_helpers";
import { mockSocketFactory } from "../orchestrator/_helpers";

/**
 * Stub RTCPeerConnection: the controller constructs a WebRtcBridge per
 * session, which needs a global RTCPeerConnection. We never drive its
 * internals here — the lock contract is asserted at the repository + state
 * level, mirroring chat-controller.test.ts.
 */
interface StubEventTarget {
  addEventListener(_type: string, _fn: (event: unknown) => void): void;
}

class StubRtcPeerConnection implements StubEventTarget {
  public connectionState: RTCPeerConnectionState = "new";
  public addEventListener(_type: string, _fn: (event: unknown) => void): void {
    // no-op
  }
  public close(): void {
    // no-op
  }
}

const originalRtc = (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;

function installStubRtc(): void {
  (globalThis as { RTCPeerConnection: unknown }).RTCPeerConnection = function () {
    return new StubRtcPeerConnection();
  };
}

function restoreRtc(): void {
  if (originalRtc === undefined) {
    delete (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
  } else {
    (globalThis as { RTCPeerConnection: unknown }).RTCPeerConnection = originalRtc;
  }
}

const BASE_URL = "https://app.example";
const BROKER_URL = "wss://broker.example";

function fakeStorage() {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (k: string): string | null => store.get(k) ?? null,
    setItem: (k: string, v: string): void => {
      store.set(k, v);
    },
  };
}

async function makeController(): Promise<ChatController> {
  const identityStorage = fakeStorage();
  const atRestStorage = fakeStorage();
  const identityManager = createIdentityManager(identityStorage);
  await identityManager.ensureLoaded();
  const atRestKeyManager = createAtRestKeyManager(atRestStorage);
  await atRestKeyManager.ensureLoaded();
  const socket = new MockSignalingSocket();
  return createChatController({
    brokerUrl: BROKER_URL,
    baseUrl: BASE_URL,
    identityManager,
    atRestKeyManager,
    repositoryFactory: (key) => new InMemoryConversationRepository(key),
    socketFactory: mockSocketFactory(socket),
    peerConnectionFactory: stubPeerConnectionFactory(),
    iceServers: [],
  });
}

describe("lock() revokes repository access (R9/F1)", () => {
  beforeEach((): void => {
    installStubRtc();
  });

  afterEach((): void => {
    restoreRtc();
  });

  it("LockableRepository throws AtRestLockedError on every ciphertext-touching method while locked", async (): Promise<void> => {
    const storage = fakeStorage();
    const manager = createAtRestKeyManager(storage);
    await manager.ensureLoaded();
    const inner: ConversationRepository = new InMemoryConversationRepository(manager.get());
    const repo = new LockableRepository(inner, manager);

    const id = new Uint8Array(16) as ConversationId;
    // Sanity: works while unlocked.
    await repo.createConversation(id, Date.now());
    const appended = await repo.appendMessage(id, "hello", MessageDirection.Sent, 1);
    expect(appended.text).toBe("hello");
    expect(await repo.getMessages(id)).toHaveLength(1);

    manager.lock();
    expect(repo.isLocked()).toBe(true);

    await expect(repo.appendMessage(id, "x", MessageDirection.Sent, 2)).rejects.toBeInstanceOf(
      AtRestLockedError,
    );
    await expect(repo.getMessages(id)).rejects.toBeInstanceOf(AtRestLockedError);
    await expect(repo.getConversation(id)).rejects.toBeInstanceOf(AtRestLockedError);
    await expect(repo.listConversations()).rejects.toBeInstanceOf(AtRestLockedError);
    await expect(repo.clearConversation(id)).rejects.toBeInstanceOf(AtRestLockedError);
    await expect(repo.clearAll()).rejects.toBeInstanceOf(AtRestLockedError);

    // Auto-mode unlock repopulates the key and clears the lock.
    const ok = await manager.unlock("anything");
    expect(ok).toBe(true);
    expect(repo.isLocked()).toBe(false);
    // Now the same calls succeed again.
    await repo.appendMessage(id, "after-unlock", MessageDirection.Sent, 3);
    expect((await repo.getMessages(id)).length).toBe(2);
  });

  it("controller.lock() makes repository.appendMessage/getHistory throw AtRestLockedError; unlock restores them", async (): Promise<void> => {
    const controller = await makeController();
    const { invitation } = await controller.startConversation();
    const id = controller.getActiveConversationId();
    if (id === null) throw new Error("expected an active conversation after startConversation");
    // invitation is unused but proves the start succeeded.
    expect(invitation.length).toBeGreaterThan(0);

    // Seed one message via the test-receive seam (appends straight through
    // the wrapped repository) so getHistory is non-empty while unlocked. We
    // avoid sendText here because it requires the orchestrator handshake,
    // which the stub-RTC fixture does not complete.
    await controller.__receiveMessageForTest(id, "seed message");
    const before = await controller.getHistory(id);
    expect(before.length).toBe(1);

    expect(controller.isLocked()).toBe(false);
    controller.lock();
    expect(controller.isLocked()).toBe(true);

    // Every repository-touching path now throws.
    await expect(controller.getHistory(id)).rejects.toBeInstanceOf(AtRestLockedError);
    await expect(controller.clearConversation(id)).rejects.toBeInstanceOf(AtRestLockedError);
    await expect(controller.listConversations()).rejects.toBeInstanceOf(AtRestLockedError);
    await expect(controller.__receiveMessageForTest(id, "locked")).rejects.toBeInstanceOf(
      AtRestLockedError,
    );

    // Auto-mode unlock: any passphrase is accepted (key persisted in clear).
    const ok = await controller.unlock("any-passphrase");
    expect(ok).toBe(true);
    expect(controller.isLocked()).toBe(false);

    // Restored: history is readable again and new appends succeed.
    const after = await controller.getHistory(id);
    expect(after.length).toBe(1);
    await controller.__receiveMessageForTest(id, "after unlock");
    const final = await controller.getHistory(id);
    expect(final.length).toBe(2);

    controller.dispose();
  });

  it("passphrase-mode unlock with the wrong passphrase stays locked", async (): Promise<void> => {
    // Build a manager and wrap the auto key under a passphrase so lock() is
    // meaningful (the wrapper's isLocked() gate is the same regardless, but
    // this exercises the real passphrase path).
    const storage = fakeStorage();
    const manager = createAtRestKeyManager(storage);
    await manager.ensureLoaded();
    await manager.setPassphrase("the-real-passphrase");

    const inner: ConversationRepository = new InMemoryConversationRepository(manager.get());
    const repo = new LockableRepository(inner, manager);
    const id = new Uint8Array(16) as ConversationId;
    await repo.createConversation(id, Date.now());

    manager.lock();
    expect(repo.isLocked()).toBe(true);

    const ok = await manager.unlock("wrong-passphrase");
    expect(ok).toBe(false);
    expect(repo.isLocked()).toBe(true);
    await expect(repo.getMessages(id)).rejects.toBeInstanceOf(AtRestLockedError);

    // Right passphrase unlocks.
    const ok2 = await manager.unlock("the-real-passphrase");
    expect(ok2).toBe(true);
    expect(repo.isLocked()).toBe(false);
    await repo.getMessages(id);
  });
});
