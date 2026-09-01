import { describe, expect, it } from "vitest";

import type { ConversationId } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import {
  InMemoryConversationRepository,
  type ConversationRepository,
} from "@fuck-eu-chat-control/chat-runtime/store";
import type { AESKey } from "@fuck-eu-chat-control/chat-runtime/crypto/types";
import { createAtRestKeyManager } from "@fuck-eu-chat-control/chat-runtime/runtime/at-rest-key-manager";
import {
  createChatController,
  type ChatController,
  type ChatControllerDeps,
} from "@fuck-eu-chat-control/chat-runtime/runtime/chat-controller";
import { stubPeerConnectionFactory, fakeStorage, bytesEqual } from "./_helpers";
import type { PeerConnectionFactory } from "@fuck-eu-chat-control/chat-runtime/transport/types";
import { createIdentityManager } from "@fuck-eu-chat-control/chat-runtime/runtime/identity-manager";

import { MockSignalingSocket } from "../signaling/_helpers";
import { mockSocketFactory } from "../orchestrator/_helpers";

const BASE_URL = "https://app.example";
const BROKER_URL = "wss://broker.example";

type WithGatedRead = {
  repo: ConversationRepository;
  releaseFirstRead: () => void;
};

/**
 * Wraps an in-memory repository and gates the FIRST listConversations call
 * (the boot-hydrate read) on a promise the test controls. Used to force the
 * exact interleaving R5/F2 protects against: a slow boot read resolving while
 * a mutation-triggered refresh wants to run.
 */
function gatedFirstReadRepository(key: AESKey): WithGatedRead {
  const inner = new InMemoryConversationRepository(key);
  let readCount = 0;
  let releaseFirstRead: () => void = () => {};
  const firstReadGate = new Promise<void>((resolve) => {
    releaseFirstRead = resolve;
  });
  const repo: ConversationRepository = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "listConversations") {
        return async () => {
          readCount += 1;
          if (readCount === 1) {
            await firstReadGate;
          }
          return target.listConversations();
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { repo, releaseFirstRead };
}

async function makeController(overrides?: Partial<ChatControllerDeps>): Promise<ChatController> {
  const identityManager = createIdentityManager(fakeStorage());
  await identityManager.ensureLoaded();
  const atRestKeyManager = createAtRestKeyManager(fakeStorage());
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
    ...overrides,
  });
}

describe("chat-controller concurrency hardening (R5/F1, R5/F2, R5/F4, R5/F5)", () => {
  it("R5/F4: two concurrent resumeConversation(sameId) calls start exactly one session (no orphaned peer connection)", async () => {
    let peerConnectionsCreated = 0;
    const baseFactory = stubPeerConnectionFactory();
    const countingFactory = (options: Parameters<PeerConnectionFactory>[0]) => {
      peerConnectionsCreated += 1;
      return baseFactory(options);
    };
    const controller = await makeController({ peerConnectionFactory: countingFactory });

    const { invitation } = await controller.startConversation();
    void invitation;
    const id = controller.getActiveConversationId() as ConversationId;
    await controller.__receiveMessageForTest(id, "persisted");
    controller.leaveConversation(id);
    const baseline = peerConnectionsCreated;

    // Double-tap: both calls run before either's startSession registers.
    await Promise.all([controller.resumeConversation(id), controller.resumeConversation(id)]);

    // Exactly ONE resume session was constructed — the second call deduped
    // onto the in-flight promise instead of orphaning the first session's
    // orchestrator/bridge/peer connection.
    expect(peerConnectionsCreated - baseline).toBe(1);
    const state = controller.getState();
    expect(state.sessions).toHaveLength(1);
    expect(state.active).not.toBeNull();
    expect(state.active!.messages.map((m) => m.text)).toContain("persisted");

    controller.dispose();
  });

  it("R5/F1: a boot-hydrate refresh resolving after dispose never emits to subscribers", async () => {
    let gated: WithGatedRead | null = null;
    const controller = await makeController({
      repositoryFactory: (key) => {
        gated = gatedFirstReadRepository(key);
        return gated.repo;
      },
    });
    let emits = 0;
    controller.subscribe(() => {
      emits += 1;
    });

    // Boot-hydrate read is gated (in flight). Dispose before it resolves.
    controller.dispose();

    // Release the gated read: runRefresh's post-await paths and the hydrate's
    // completion must be no-ops on a disposed controller.
    (gated as unknown as WithGatedRead).releaseFirstRead();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(emits).toBe(0);
    expect(controller.getState().conversations).toEqual([]);
  });

  it("R5/F2: a refresh issued while the boot read is in flight is not answered with the stale snapshot", async () => {
    let gated: WithGatedRead | null = null;
    const controller = await makeController({
      repositoryFactory: (key) => {
        gated = gatedFirstReadRepository(key);
        return gated.repo;
      },
    });

    // The boot-hydrate read is gated in flight; its (eventual) result will
    // NOT include the conversation created below. startConversation awaits
    // its own (chained) refresh, so it cannot resolve until the gate opens —
    // drive it un-awaited and release the gate once the session is live.
    const started = controller.startConversation();
    const deadline = Date.now() + 2000;
    let id: ConversationId | null = null;
    while (Date.now() < deadline) {
      id = controller.getActiveConversationId();
      if (id !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(id).not.toBeNull();
    if (id === null) throw new Error("session never became active");
    // Releasing the gate lets the boot read resolve (stale: no rows) and then
    // the chained refresh re-read AFTER the insert.
    (gated as unknown as WithGatedRead).releaseFirstRead();
    await started;
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The chained refresh re-read after the insert, so the new conversation
    // is in the sidebar — the stale boot snapshot did not overwrite it.
    const conversations = controller.getState().conversations;
    expect(conversations.some((c) => bytesEqual(c.id, id))).toBe(true);

    controller.dispose();
  });

  it("R5/F5: teardownSession is idempotent (leave + leaveAll does not re-teardown)", async () => {
    const controller = await makeController();
    await controller.startConversation();
    const id = controller.getActiveConversationId() as ConversationId;
    controller.leaveConversation(id);
    // The session map is already empty; leaveAll re-entering teardown on any
    // racing path must be a no-op, not a double orchestrator.leave().
    expect(() => controller.leaveAll()).not.toThrow();
    expect(controller.getState().sessions).toHaveLength(0);
    controller.dispose();
  });
});
