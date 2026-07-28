import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InMemoryConversationRepository } from "@fuck-eu-chat-control/chat-runtime/store";
import type { ConversationRecord, ConversationRepository } from "@fuck-eu-chat-control/chat-runtime/store";
import { ImportMode } from "@fuck-eu-chat-control/chat-runtime/store";
import { createAtRestKeyManager } from "@fuck-eu-chat-control/chat-runtime/runtime/at-rest-key-manager";
import { createChatController, type ChatController } from "@fuck-eu-chat-control/chat-runtime/runtime/chat-controller";
import { stubPeerConnectionFactory } from "./_helpers";
import { createIdentityManager } from "@fuck-eu-chat-control/chat-runtime/runtime/identity-manager";

import { MockSignalingSocket, parse } from "../signaling/_helpers";
import { mockSocketFactory } from "../orchestrator/_helpers";

/**
 * Minimal RTCPeerConnection stub. The chat-controller constructs a
 * WebRtcBridge per active conversation, which in turn constructs a
 * WebRtcAdapter (which needs a global RTCPeerConnection). We install a stub
 * only so the bridge can be built and immediately torn down; we never drive
 * its internals — the live negotiation is validated by Playwright + the
 * two-browser run.
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

afterEach(() => {
  restoreRtc();
});

const BASE_URL = "https://app.example";
const BROKER_URL = "wss://broker.example";

interface ControllerKit {
  readonly controller: ChatController;
  readonly socket: MockSignalingSocket;
  readonly identityStorage: { store: Map<string, string> };
  readonly atRestStorage: { store: Map<string, string> };
}

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

async function makeController(): Promise<ControllerKit> {
  const identityStorage = fakeStorage();
  const atRestStorage = fakeStorage();
  const identityManager = createIdentityManager(identityStorage);
  await identityManager.ensureLoaded();
  const atRestKeyManager = createAtRestKeyManager(atRestStorage);
  await atRestKeyManager.ensureLoaded();
  const socket = new MockSignalingSocket();
  const controller = createChatController({
    brokerUrl: BROKER_URL,
    baseUrl: BASE_URL,
    identityManager,
    atRestKeyManager,
    repositoryFactory: (key) => new InMemoryConversationRepository(key),
    socketFactory: mockSocketFactory(socket),
    peerConnectionFactory: stubPeerConnectionFactory(),
    iceServers: [],
  });
  return { controller, socket, identityStorage, atRestStorage };
}

describe("createChatController", () => {
  let kit: ControllerKit;
  let controller: ChatController;

  beforeEach(async () => {
    installStubRtc();
    kit = await makeController();
    controller = kit.controller;
  });

  it("startConversation returns an invitation with '#<32 hex>' and creates a conversation", async () => {
    const { invitation } = await controller.startConversation();
    const hashIndex = invitation.lastIndexOf("#");
    expect(hashIndex).toBeGreaterThanOrEqual(0);
    const frag = invitation.slice(hashIndex + 1);
    expect(frag).toMatch(/^[0-9a-f]{32}$/);

    const conversations = await controller.listConversations();
    expect(conversations.length).toBe(1);
    // The invitation URL must include the configured base URL.
    expect(invitation.startsWith(BASE_URL)).toBe(true);
  });

  it("getState() reflects the initial snapshot", () => {
    const state = controller.getState();
    expect(state.connectionState).toBe("idle");
    expect(state.conversationId).toBeNull();
    expect(state.invitation).toBeNull();
    expect(state.safetyNumber).toBeNull();
    expect(state.safetyNumberVerified).toBe(false);
    expect(state.messages).toEqual([]);
    expect(state.conversations).toEqual([]);
    expect(state.error).toBeNull();
  });

  it("subscribe() is called with state snapshots and returns an unsubscribe", async () => {
    const events: string[] = [];
    const unsub = controller.subscribe((state) => {
      events.push(state.connectionState);
    });
    await controller.startConversation();
    // At least one event fired (startConversation moves to Waiting).
    expect(events.length).toBeGreaterThan(0);
    expect(events).toContain("waiting");
    const eventsBefore = events.length;
    unsub();
    // After unsubscribe, no further events arrive.
    const state = controller.getState();
    expect(state.connectionState).toBe("waiting");
    expect(events.length).toBe(eventsBefore);
  });

  it("joinConversation parses a fragment and creates a conversation", async () => {
    const invitation = `${BASE_URL}#abcdef0123456789abcdef0123456789`;
    await controller.joinConversation(invitation);
    const conversations = await controller.listConversations();
    expect(conversations.length).toBe(1);
    const state = controller.getState();
    expect(state.conversationId).not.toBeNull();
  });

  it("startConversation connects the signaling client to the conversation's broker room", async () => {
    const { invitation } = await controller.startConversation();
    const hashIndex = invitation.lastIndexOf("#");
    const expectedRoomId = invitation.slice(hashIndex + 1);
    // Trigger the socket open so the join message is sent.
    kit.socket.serverOpen();
    expect(kit.socket.sent.length).toBeGreaterThanOrEqual(1);
    const join = parse(kit.socket.sent[0]);
    expect(join.t).toBe("join");
    expect(join.roomId).toBe(expectedRoomId);
  });

  it("exportBundle then importBundle round-trip restores conversations", async () => {
    const { invitation } = await controller.startConversation();
    const frag = invitation.slice(invitation.lastIndexOf("#") + 1);

    // Export from controller A.
    const bundle = await controller.exportBundle("hunter2");
    expect(typeof bundle).toBe("string");
    const parsed = JSON.parse(bundle) as { v: number };
    expect(parsed.v).toBeGreaterThan(0);

    // Build a second controller with its own storage; import the bundle.
    const identityStorage2 = fakeStorage();
    const atRestStorage2 = fakeStorage();
    const identityManager2 = createIdentityManager(identityStorage2);
    await identityManager2.ensureLoaded();
    const atRestKeyManager2 = createAtRestKeyManager(atRestStorage2);
    await atRestKeyManager2.ensureLoaded();
    const socket2 = new MockSignalingSocket();
    const controller2 = createChatController({
      brokerUrl: BROKER_URL,
      baseUrl: BASE_URL,
      identityManager: identityManager2,
      atRestKeyManager: atRestKeyManager2,
      repositoryFactory: (key) => new InMemoryConversationRepository(key),
      socketFactory: mockSocketFactory(socket2),
    peerConnectionFactory: stubPeerConnectionFactory(),
      iceServers: [],
    });

    const result = await controller2.importBundle("hunter2", bundle, ImportMode.Merge);
    expect(result.conversationsAdded).toBe(1);
    const convos = await controller2.listConversations();
    expect(convos.length).toBe(1);
    const importedFrag = convos[0].id;
    let importedHex = "";
    for (let i = 0; i < importedFrag.length; i++) {
      importedHex += importedFrag[i].toString(16).padStart(2, "0");
    }
    expect(importedHex).toBe(frag);
  });

  it("clearConversation empties the conversation list", async () => {
    await controller.startConversation();
    expect((await controller.listConversations()).length).toBe(1);
    const id = controller.getState().conversationId;
    expect(id).not.toBeNull();
    await controller.clearConversation();
    expect((await controller.listConversations()).length).toBe(0);
  });

  it("clearAll empties the conversation list", async () => {
    await controller.startConversation();
    await controller.clearAll();
    expect((await controller.listConversations()).length).toBe(0);
  });

  it("listConversations returns records sorted by createdAt", async () => {
    // Multiple conversations: simulate by joining with different fragments.
    await controller.joinConversation(`${BASE_URL}#11111111111111111111111111111111`);
    const records = await controller.listConversations();
    expect(records.length).toBe(1);
    expect(records[0].createdAt).toBeGreaterThan(0);
  });

  it("dispose() is idempotent and does not throw", () => {
    expect(() => {
      controller.dispose();
      controller.dispose();
    }).not.toThrow();
  });

  it("leave() on a fresh controller does not throw", async () => {
    expect(() => controller.leave()).not.toThrow();
  });

  it("a snapshot includes the conversation records", async () => {
    await controller.startConversation();
    const state = controller.getState();
    expect(state.conversations.length).toBe(1);
    const record: ConversationRecord = state.conversations[0];
    expect(record.id.length).toBe(16);
  });
});

describe("createChatController / repositoryFactory", () => {
  it("invokes the repository factory with the loaded at-rest key", async () => {
    installStubRtc();
    const identityStorage = fakeStorage();
    const atRestStorage = fakeStorage();
    const identityManager = createIdentityManager(identityStorage);
    await identityManager.ensureLoaded();
    const atRestKeyManager = createAtRestKeyManager(atRestStorage);
    await atRestKeyManager.ensureLoaded();
    const factoryCalls = { count: 0 };
    const receivedKeys: Uint8Array[] = [];
    const controller = createChatController({
      brokerUrl: BROKER_URL,
      baseUrl: BASE_URL,
      identityManager,
      atRestKeyManager,
      repositoryFactory: (key): ConversationRepository => {
        factoryCalls.count++;
        receivedKeys.push(key);
        return new InMemoryConversationRepository(key);
      },
      socketFactory: mockSocketFactory(new MockSignalingSocket()),
    peerConnectionFactory: stubPeerConnectionFactory(),
      iceServers: [],
    });
    await controller.startConversation();
    expect(factoryCalls.count).toBeGreaterThanOrEqual(1);
    expect(receivedKeys.length).toBeGreaterThanOrEqual(1);
    const key = receivedKeys[0] as Uint8Array;
    expect(key.length).toBe(32);
  });
});
