import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InMemoryConversationRepository } from "@fuck-eu-chat-control/chat-runtime/store";
import type { ConversationId } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import { createAtRestKeyManager } from "@fuck-eu-chat-control/chat-runtime/runtime/at-rest-key-manager";
import { createChatController, type ChatController } from "@fuck-eu-chat-control/chat-runtime/runtime/chat-controller";
import { stubPeerConnectionFactory } from "./_helpers";
import { createIdentityManager } from "@fuck-eu-chat-control/chat-runtime/runtime/identity-manager";

import { MockSignalingSocket } from "../signaling/_helpers";
import { mockSocketFactory } from "../orchestrator/_helpers";

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

/**
 * Drive a synthetic background receive on a session without going through real
 * WebRTC. The controller routes inbound messages through the session's
 * orchestrator handler `onMessage`; we invoke it via the controller's
 * test-facing seam `__receiveMessageForTest(id, message)`.
 *
 * This mirrors how the existing controller-kit tests assert at the state
 * level: we exercise the controller's contract (state derivation, unread,
 * active id), not the orchestrator's crypto path.
 */
async function deliverBackgroundMessage(
  controller: ChatController,
  id: ConversationId,
  text: string,
): Promise<void> {
  await controller.__receiveMessageForTest(id, text);
}

describe("createChatController / multi-session", () => {
  let controller: ChatController;

  beforeEach(async () => {
    controller = await makeController();
  });

  afterEach(() => {
    controller.dispose();
  });

  it("starts two conversations concurrently on one controller", async () => {
    expect(controller.getActiveConversationId()).toBeNull();
    expect(controller.getState().sessions.length).toBe(0);

    await controller.startConversation();
    const idA = controller.getActiveConversationId();
    expect(idA).not.toBeNull();

    await controller.startConversation();
    const idB = controller.getActiveConversationId();

    // After starting B, B is active but A is still alive in the sessions map.
    expect(idB).not.toBeNull();
    expect(idB).not.toEqual(idA);
    expect(controller.getState().sessions.length).toBe(2);
    const ids = controller.getState().sessions.map((s) => s.id);
    expect(ids).toContain(idA);
    expect(ids).toContain(idB);
  });

  it("startConversation({ code }) produces a coded invitation link in the snapshot", async () => {
    // The uncoded baseline: a bare hex fragment after the #.
    const { invitation: bare } = await controller.startConversation();
    expect(bare).toMatch(/^https:\/\/app\.example#[0-9a-f]{32}$/);
    // Leaving the active session frees the broker room so the next start can
    // begin fresh.
    controller.leaveConversation();

    // The coded form: same hex shape but with the `~<code>` suffix. The code
    // rides in the URL fragment, which browsers do not send to the server.
    const { invitation: coded } = await controller.startConversation({ code: "123456" });
    expect(coded).toMatch(/^https:\/\/app\.example#[0-9a-f]{32}~123456$/);

    // An empty/whitespace code falls back to the bare form (the orchestrator
    // treats an empty code as no-PAKE).
    controller.leaveConversation();
    const { invitation: trimmed } = await controller.startConversation({ code: "   " });
    expect(trimmed).toMatch(/^https:\/\/app\.example#[0-9a-f]{32}$/);
  });

  it("a message delivered to session A does NOT bleed into session B", async () => {
    await controller.startConversation();
    const idA = controller.getActiveConversationId() as ConversationId;
    await controller.startConversation();
    const idB = controller.getActiveConversationId() as ConversationId;

    // Active is B; deliver a message into A's session via the receive seam
    // (the stub-RTC kit cannot drive a real handshake, so we exercise the
    // controller's persistence + snapshot path directly — that is the
    // isolation contract that matters here).
    controller.selectConversation(idA);
    expect(controller.getActiveConversationId()).toEqual(idA);

    await deliverBackgroundMessage(controller, idA, "hello only for A");

    const messagesA = await controller.getHistory(idA);
    const messagesB = await controller.getHistory(idB);
    expect(messagesA.length).toBe(1);
    expect(messagesA[0]?.text).toBe("hello only for A");
    expect(messagesB.length).toBe(0);
  });

  it("selectConversation swaps activeConversationId without tearing down others", async () => {
    await controller.startConversation();
    const idA = controller.getActiveConversationId() as ConversationId;
    await controller.startConversation();
    const idB = controller.getActiveConversationId() as ConversationId;

    // Switch to A; both sessions remain.
    controller.selectConversation(idA);
    expect(controller.getActiveConversationId()).toEqual(idA);
    expect(sortIds(controller.getState().sessions.map((s) => s.id))).toEqual(sortIds([idA, idB]));

    // Switch back to B.
    controller.selectConversation(idB);
    expect(controller.getActiveConversationId()).toEqual(idB);
    expect(sortIds(controller.getState().sessions.map((s) => s.id))).toEqual(sortIds([idA, idB]));
  });

  it("background receive on a non-active session increments unread and leaves active id unchanged", async () => {
    await controller.startConversation();
    const idA = controller.getActiveConversationId() as ConversationId;
    await controller.startConversation();
    const idB = controller.getActiveConversationId() as ConversationId;

    // A is non-active; deliver a background message to it.
    await deliverBackgroundMessage(controller, idA, "hi in the background");

    expect(controller.getActiveConversationId()).toEqual(idB);
    const summaryA = controller.getState().sessions.find((s) => s.id === idA);
    expect(summaryA?.unread).toBe(1);
    expect(summaryA?.lastMessagePreview).toBe("hi in the background");
    const summaryB = controller.getState().sessions.find((s) => s.id === idB);
    expect(summaryB?.unread).toBe(0);
  });

  it("selectConversation on a session with unread clears its unread to 0", async () => {
    await controller.startConversation();
    const idA = controller.getActiveConversationId() as ConversationId;
    await controller.startConversation();
    const idB = controller.getActiveConversationId() as ConversationId;

    await deliverBackgroundMessage(controller, idA, "background 1");
    await deliverBackgroundMessage(controller, idA, "background 2");
    expect(controller.getState().sessions.find((s) => s.id === idA)?.unread).toBe(2);

    controller.selectConversation(idA);
    expect(controller.getActiveConversationId()).toEqual(idA);
    expect(controller.getState().sessions.find((s) => s.id === idA)?.unread).toBe(0);
    // B's unread is still 0.
    expect(controller.getState().sessions.find((s) => s.id === idB)?.unread).toBe(0);
  });

  it("leaveConversation(id) tears down ONLY that session; others remain live", async () => {
    await controller.startConversation();
    const idA = controller.getActiveConversationId() as ConversationId;
    await controller.startConversation();
    const idB = controller.getActiveConversationId() as ConversationId;
    await controller.startConversation();
    const idC = controller.getActiveConversationId() as ConversationId;

    // Leave the middle session. C remains active; A is untouched.
    controller.leaveConversation(idB);

    expect(sortIds(controller.getState().sessions.map((s) => s.id))).toEqual(sortIds([idA, idC]));
    expect(controller.getActiveConversationId()).toEqual(idC);

    // A's history is still readable.
    const historyA = await controller.getHistory(idA);
    expect(Array.isArray(historyA)).toBe(true);
    // C's history too.
    const historyC = await controller.getHistory(idC);
    expect(Array.isArray(historyC)).toBe(true);
  });

  it("leaving the active session clears activeConversationId (empty state)", async () => {
    await controller.startConversation();
    const idA = controller.getActiveConversationId() as ConversationId;
    await controller.startConversation();
    const idB = controller.getActiveConversationId() as ConversationId;

    controller.leaveConversation(idB);
    // One session remains; we did not auto-select it.
    expect(controller.getState().sessions.length).toBe(1);
    expect(controller.getActiveConversationId()).toBeNull();
    // Selecting A again is cheap and works.
    controller.selectConversation(idA);
    expect(controller.getActiveConversationId()).toEqual(idA);
  });

  it("leaveAll tears down every session", async () => {
    await controller.startConversation();
    await controller.startConversation();
    await controller.startConversation();
    expect(controller.getState().sessions.length).toBe(3);

    controller.leaveAll();
    expect(controller.getState().sessions.length).toBe(0);
    expect(controller.getActiveConversationId()).toBeNull();
  });

  it("the active snapshot mirrors the active session's fields", async () => {
    await controller.startConversation();
    const idA = controller.getActiveConversationId() as ConversationId;
    // Drive content into the active session via the receive seam (stub RTC
    // cannot complete a handshake). The active snapshot should mirror what
    // landed in the session.
    await deliverBackgroundMessage(controller, idA, "top-level mirrors active");

    const state = controller.getState();
    expect(state.activeConversationId).toEqual(idA);
    expect(state.active?.id).toEqual(idA);
    // Backward-compat: flat top-level fields mirror the active session.
    expect(state.conversationId).toEqual(idA);
    expect(state.messages.length).toBe(1);
    expect(state.messages[0]?.text).toBe("top-level mirrors active");
  });
});

/**
 * Deterministic comparator for ConversationId arrays where the ids are opaque
 * Uint8Array brands (not sortable by `<`). Used to compare session-id sets
 * regardless of iteration order.
 */
function sortIds(ids: ConversationId[]): ConversationId[] {
  return ids.slice().sort((a, b) => compareBytes(a, b));
}

function compareBytes(a: ConversationId, b: ConversationId): number {
  const limit = Math.min(a.length, b.length);
  for (let i = 0; i < limit; i++) {
    const da = a[i];
    const db = b[i];
    if (da !== db) return da - db;
  }
  return a.length - b.length;
}
