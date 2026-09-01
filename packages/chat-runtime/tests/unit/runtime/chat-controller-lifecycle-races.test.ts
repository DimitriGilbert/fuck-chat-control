import { describe, expect, it } from "vitest";

import type { ConversationId } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import {
  InMemoryConversationRepository,
  type ConversationMessage,
  type ConversationRecord,
  type ConversationRepository,
} from "@fuck-eu-chat-control/chat-runtime/store";
import { generateAtRestKey } from "@fuck-eu-chat-control/chat-runtime/crypto";
import type { AtRestKey } from "@fuck-eu-chat-control/chat-runtime/crypto";
import type {
  SignalingSocket,
  SignalingSocketFactory,
} from "@fuck-eu-chat-control/chat-runtime/signaling/signaling-client";
import type { PeerConnectionFactory } from "@fuck-eu-chat-control/chat-runtime/transport/types";
import { createAtRestKeyManager } from "@fuck-eu-chat-control/chat-runtime/runtime/at-rest-key-manager";
import {
  createChatController,
  type ChatController,
} from "@fuck-eu-chat-control/chat-runtime/runtime/chat-controller";
import { stubPeerConnectionFactory, fakeStorage, bytesEqual } from "./_helpers";
import { createIdentityManager } from "@fuck-eu-chat-control/chat-runtime/runtime/identity-manager";

import { MockSignalingSocket } from "../signaling/_helpers";
import { linkLoopbackPair, mockSocketFactory } from "../orchestrator/_helpers";

const BASE_URL = "https://app.example";
const BROKER_URL = "wss://broker.example";

/** Resource dials observable from a test: peer connections built, sockets dialed. */
interface DialStats {
  peerConnectionsCreated: number;
  socketsDialed: number;
}

interface Harness {
  readonly controller: ChatController;
  readonly stats: DialStats;
}

/**
 * Build a controller whose socket/peer-connection factories count every dial.
 * `socketsDialed` counts SignalingSocketFactory invocations, which happen only
 * inside SignalingClient.connect() — i.e. exactly once per bridge.start() that
 * actually dials. `peerConnectionsCreated` counts wireBridge constructions.
 */
async function makeHarness(repository?: ConversationRepository): Promise<Harness> {
  const identityManager = createIdentityManager(fakeStorage());
  await identityManager.ensureLoaded();
  const atRestKeyManager = createAtRestKeyManager(fakeStorage());
  await atRestKeyManager.ensureLoaded();
  const stats: DialStats = { peerConnectionsCreated: 0, socketsDialed: 0 };
  const basePeers = stubPeerConnectionFactory();
  const baseSockets = mockSocketFactory(new MockSignalingSocket());
  const peerConnectionFactory = (options: Parameters<PeerConnectionFactory>[0]) => {
    stats.peerConnectionsCreated += 1;
    return basePeers(options);
  };
  const socketFactory: SignalingSocketFactory = (url: string): SignalingSocket => {
    stats.socketsDialed += 1;
    return baseSockets(url);
  };
  const controller = createChatController({
    brokerUrl: BROKER_URL,
    baseUrl: BASE_URL,
    identityManager,
    atRestKeyManager,
    repositoryFactory: (key: AtRestKey) => new InMemoryConversationRepository(key),
    repository,
    socketFactory,
    peerConnectionFactory,
    iceServers: [],
  });
  return { controller, stats };
}

interface GatedRepository {
  readonly repo: ConversationRepository;
  /** Resolves once the gated method has been entered (the call is parked). */
  readonly entered: Promise<void>;
  /** Let the parked call proceed. */
  release(): void;
}

/**
 * Wraps an in-memory repository and gates one method on a promise the test
 * controls. Used to park startSession/performResume at a chosen await so a
 * dispose()/leaveConversation() can land mid-flight — the exact interleavings
 * R3F1 protects against. The gated method stays gated for every call; the
 * tests below only ever invoke it on the path under test.
 */
function gatedRepository(
  gated: "createConversation" | "getConversation" | "getMessages",
): GatedRepository {
  const inner = new InMemoryConversationRepository(generateAtRestKey());
  let openGate: () => void = () => {};
  let markEntered: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const repo: ConversationRepository = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "createConversation" && gated === "createConversation") {
        return async (id: ConversationId, createdAt: number): Promise<ConversationRecord> => {
          markEntered();
          await gate;
          return await target.createConversation(id, createdAt);
        };
      }
      if (prop === "getConversation" && gated === "getConversation") {
        return async (id: ConversationId): Promise<ConversationRecord | null> => {
          markEntered();
          await gate;
          return await target.getConversation(id);
        };
      }
      if (prop === "getMessages" && gated === "getMessages") {
        return async (id: ConversationId): Promise<ConversationMessage[]> => {
          markEntered();
          await gate;
          return await target.getMessages(id);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { repo, entered, release: openGate };
}

/** Unread count of a session summary, failing loudly when the session is gone. */
function unreadOf(controller: ChatController, id: ConversationId): number {
  const summary = controller.getState().sessions.find((s) => bytesEqual(s.id, id));
  if (summary === undefined) {
    throw new Error(`no session summary for conversation ${id}`);
  }
  return summary.unread;
}

describe("chat-controller lifecycle races (R3F1, R3F2, R3F3 / Phase 3)", () => {
  it("R3F1: dispose during an in-flight startConversation registers nothing, builds no bridge, dials no socket", async () => {
    const gated = gatedRepository("createConversation");
    const { controller, stats } = await makeHarness(gated.repo);

    // Park orchestrator.start() at its createConversation write...
    const started = controller.startConversation();
    await gated.entered;
    // ...then dispose the controller (provider unmount) before it resolves.
    controller.dispose();
    gated.release();

    await expect(started).rejects.toThrow("controller is disposed");
    // No zombie: wireBridge never ran, bridge.start() never dialed, and
    // nothing was registered on the disposed controller.
    expect(stats.peerConnectionsCreated).toBe(0);
    expect(stats.socketsDialed).toBe(0);
    expect(controller.getState().sessions).toHaveLength(0);
    expect(controller.getActiveConversationId()).toBeNull();
  });

  it("R3F1: leaveConversation during an in-flight resume aborts the resume instead of installing the session", async () => {
    const gated = gatedRepository("getConversation");
    const { controller, stats } = await makeHarness(gated.repo);
    await controller.startConversation();
    const id = controller.getActiveConversationId() as ConversationId;
    await controller.__receiveMessageForTest(id, "persisted");
    // Clean leave: the live session is torn down, the record persists.
    controller.leaveConversation(id);
    const baselinePeers = stats.peerConnectionsCreated;
    const baselineSockets = stats.socketsDialed;

    // Park performResume at its first read...
    const resume = controller.resumeConversation(id);
    await gated.entered;
    // ...then leave the conversation while the resume is in flight. No live
    // session exists, so the leave is recorded ONLY as a lifecycle-epoch bump.
    controller.leaveConversation(id);
    gated.release();
    // The completing resume must resolve quietly — no install, no error.
    await resume;

    expect(controller.getState().sessions).toHaveLength(0);
    expect(controller.getActiveConversationId()).toBeNull();
    // The abort happened before wireBridge: no bridge, no orchestrator-side
    // peer connection, and no socket dialed for the abandoned resume.
    expect(stats.peerConnectionsCreated).toBe(baselinePeers);
    expect(stats.socketsDialed).toBe(baselineSockets);
  });

  it("R3F1: a leave landing while the resume seed read is in flight suppresses bridge.start on the completing session", async () => {
    const gated = gatedRepository("getMessages");
    const { controller, stats } = await makeHarness(gated.repo);
    await controller.startConversation();
    const id = controller.getActiveConversationId() as ConversationId;
    await controller.__receiveMessageForTest(id, "persisted");
    controller.leaveConversation(id);
    const baselineSockets = stats.socketsDialed;

    const resume = controller.resumeConversation(id);
    // The seed read is in flight; the fresh session IS registered by now —
    // this is the interleaving where leaveConversation finds it live.
    await gated.entered;
    expect(controller.getState().sessions).toHaveLength(1);
    // Full teardown of the registered session + the leave-epoch bump.
    controller.leaveConversation(id);
    gated.release();
    await resume;

    expect(controller.getState().sessions).toHaveLength(0);
    expect(controller.getActiveConversationId()).toBeNull();
    // The completing startSession observed the leave after its seed await and
    // never ran bridge.start() — the closed bridge does not re-dial.
    expect(stats.socketsDialed).toBe(baselineSockets);
  });

  it("R3F2: a value-equal but distinct-reference conversation id is detected as active in onSessionChange", async () => {
    const { controller } = await makeHarness();
    await controller.startConversation();
    const idA = controller.getActiveConversationId() as ConversationId;
    // Repository rows hand back freshly deserialized arrays: same bytes, new
    // reference — the exact shape the empty-state/sidebar resume paths feed
    // the controller.
    const foreignA = idA.slice() as ConversationId;
    expect(foreignA).not.toBe(idA);
    expect(bytesEqual(foreignA, idA)).toBe(true);

    // Already-live resume branch with the foreign reference: the session must
    // stay ACTIVE, so a received message does not count as unread.
    await controller.resumeConversation(foreignA);
    await controller.__receiveMessageForTest(idA, "active via foreign-ref resume");
    expect(unreadOf(controller, idA)).toBe(0);

    // Control: a genuinely background session DOES count unread.
    await controller.startConversation();
    const idB = controller.getActiveConversationId() as ConversationId;
    expect(bytesEqual(idB, idA)).toBe(false);
    await controller.__receiveMessageForTest(idA, "background message");
    expect(unreadOf(controller, idA)).toBe(1);

    // selectConversation branch with a fresh foreign reference: selecting the
    // session must take the active branch and clear unread.
    const foreignA2 = idA.slice() as ConversationId;
    controller.selectConversation(foreignA2);
    await controller.__receiveMessageForTest(idA, "active via foreign-ref select");
    expect(unreadOf(controller, idA)).toBe(0);
  });

  it("R3F3: a late orchestrator onError after teardown is dropped (no onSessionChange re-entry)", async () => {
    const { controller } = await makeHarness();
    await controller.startConversation();
    const id = controller.getActiveConversationId() as ConversationId;
    // Attach a loopback transport: the session enters Handshaking and inbound
    // bytes route to the orchestrator's handleInbound.
    const { a, b } = linkLoopbackPair();
    controller.__attachTransportForTest(id, a);

    let emits = 0;
    controller.subscribe(() => {
      emits += 1;
    });

    // Dispatch a malformed inbound frame. Its rejection lands on the parked
    // .catch(failHandshake) as a MICROTASK — i.e. after the synchronous leave
    // below runs — which is exactly the late onError window teardownSession
    // must close by nulling holder.session.
    b.send(new Uint8Array([0x00, 0x01, 0x02]));
    controller.leaveConversation(id);
    const emitsAtLeave = emits;

    await new Promise((resolve) => setTimeout(resolve, 25));
    // failHandshake ran (the parked rejection settled) but its onError →
    // onChange re-entry was dropped at the holder gate: no subscriber sees a
    // resurrected session and no error surfaces for the removed conversation.
    expect(emits).toBe(emitsAtLeave);
    expect(controller.getState().error).toBeNull();
    expect(controller.getState().sessions).toHaveLength(0);
  });
});
