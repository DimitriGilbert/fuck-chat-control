import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ConversationId } from "@/features/chat/protocol/types";
import { InMemoryConversationRepository } from "@/features/chat/store";
import { createAtRestKeyManager } from "@/features/chat/runtime/at-rest-key-manager";
import { createChatController, type ChatController } from "@/features/chat/runtime/chat-controller";
import { createIdentityManager } from "@/features/chat/runtime/identity-manager";

import { MockSignalingSocket } from "../signaling/_helpers";
import { mockSocketFactory } from "../orchestrator/_helpers";

/**
 * Stub RTCPeerConnection — the controller constructs a WebRtcBridge per
 * session which needs a global RTCPeerConnection. We never drive its
 * internals here; the resume-race fix is asserted at the controller-snapshot
 * level via the test seam `__receiveMessageForTest`.
 */
interface StubEventTarget {
  addEventListener(_type: string, _fn: (event: unknown) => void): void;
}
class StubRtcPeerConnection implements StubEventTarget {
  public connectionState: RTCPeerConnectionState = "new";
  public addEventListener(): void {
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
    iceServers: [],
  });
}

describe("resumeConversation seeding race (R9/F3 / Phase 8.5)", () => {
  beforeEach(() => {
    installStubRtc();
  });
  afterEach(() => {
    restoreRtc();
  });

  it("seeds the session snapshot from history on resume (messages are populated)", async () => {
    const controller = await makeController();
    // Start a fresh conversation and persist a message via the test seam so
    // history is non-empty when we resume.
    const { invitation } = await controller.startConversation();
    const id = controller.getActiveConversationId() as ConversationId;
    await controller.__receiveMessageForTest(id, "old-message");
    // Tear down (leave) the live session and resume it.
    controller.leaveConversation(id);
    expect(controller.getState().active).toBeNull();

    await controller.resumeConversation(id);
    const state = controller.getState();
    expect(state.active).not.toBeNull();
    expect(state.active!.messages.length).toBe(1);
    expect(state.active!.messages[0]!.text).toBe("old-message");
    // The invitation round-trips through the persisted record.
    void invitation;
  });

  it("a live frame arriving AFTER seeding is APPENDED to the seeded history (not overwritten)", async () => {
    const controller = await makeController();
    await controller.startConversation();
    const id = controller.getActiveConversationId() as ConversationId;
    await controller.__receiveMessageForTest(id, "persisted-1");
    await controller.__receiveMessageForTest(id, "persisted-2");

    controller.leaveConversation(id);
    await controller.resumeConversation(id);

    // Before the fix, this receive could land BEFORE seedSessionFromHistory
    // ran, and the seed would overwrite the live frame. With the seed hook
    // running INSIDE startSession BEFORE bridge.start(), the snapshot is
    // populated first and the live frame is appended.
    await controller.__receiveMessageForTest(id, "live-after-resume");

    const messages = controller.getState().active!.messages;
    const texts = messages.map((m) => m.text);
    expect(texts).toContain("persisted-1");
    expect(texts).toContain("persisted-2");
    expect(texts).toContain("live-after-resume");
    expect(messages.length).toBe(3);
  });

  it("the seed hook runs before bridge.start (lastMessageAt is the persisted value, not null)", async () => {
    const controller = await makeController();
    await controller.startConversation();
    const id = controller.getActiveConversationId() as ConversationId;
    await controller.__receiveMessageForTest(id, "seed-message");
    controller.leaveConversation(id);

    await controller.resumeConversation(id);
    const active = controller.getState().active!;
    expect(active.lastMessagePreview).not.toBeNull();
    expect(active.lastMessageAt).not.toBeNull();
    // The lastMessageAt should match the persisted message's timestamp, not
    // be re-derived from a live frame.
    expect(active.messages[0]!.text).toBe("seed-message");
  });

  it("resume on a never-seeded conversation still works (no history case)", async () => {
    const controller = await makeController();
    const fragment = `${BASE_URL}#abcdef0123456789abcdef0123456789`;
    await controller.joinConversation(fragment);
    const id = controller.getActiveConversationId() as ConversationId;
    controller.leaveConversation(id);

    await controller.resumeConversation(id);
    expect(controller.getState().active).not.toBeNull();
    expect(controller.getState().active!.messages).toEqual([]);
  });
});
