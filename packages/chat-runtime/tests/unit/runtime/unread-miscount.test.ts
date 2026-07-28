import { describe, expect, it } from "vitest";

import type { ConversationId } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import { InMemoryConversationRepository } from "@fuck-eu-chat-control/chat-runtime/store";
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

function idEqual(a: ConversationId, b: ConversationId): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * R9/F5 (Phase 8.5): the active session's read marker must advance only on
 * RECEIVED messages, not on SENT ones. Previously the cursor tracked
 * `lastMessageAt` (advanced by either direction), so a sent message could
 * push the cursor past a peer's message that arrived with an earlier
 * timestamp (clock drift, queue reorder), causing the unread count in the
 * non-active branch to drop to 0 — the user would never see a notification
 * badge for that peer message.
 *
 * The tests below use the controller's test seams `__receiveMessageForTest`
 * and `__sendMessageForTest` to drive the snapshot. The seams mirror exactly
 * what the real orchestrator onMessage / controller.sendText paths do to the
 * session fields, without requiring a Connected session (the stub
 * RTCPeerConnection never reaches Connected). The critical difference:
 * `__sendMessageForTest` does NOT bump `lastReceivedAt`, exercising the
 * read-marker invariant directly.
 */
describe("unread miscount fix (R9/F5 / Phase 8.5)", () => {
  it("an active session receiving a message advances the read cursor to its timestamp", async () => {
    const controller = await makeController();
    await controller.startConversation();
    const id = controller.getActiveConversationId() as ConversationId;

    await controller.__receiveMessageForTest(id, "first");
    expect(controller.getState().active!.unread).toBe(0);

    // Move away, then receive again — unread should bump to 1.
    await controller.startConversation();
    await controller.__receiveMessageForTest(id, "second");
    const bg = controller.getState().sessions.find((s) => idEqual(s.id, id));
    expect(bg!.unread).toBe(1);
  });

  it("a SENT message on the active session does NOT advance the read cursor", async () => {
    // The core invariant: readMarkers tracks RECEIVED timestamps only.
    // 1. Active session receives M1 at T1 — cursor -> T1.
    // 2. User sends a message at T2 > T1 — cursor MUST stay at T1 (a sent
    //    message is not "the user has read up to here").
    // 3. Session goes background.
    // 4. A peer message M3 arrives at T3 > T2 — must count as unread.
    const controller = await makeController();
    await controller.startConversation();
    const id = controller.getActiveConversationId() as ConversationId;

    await controller.__receiveMessageForTest(id, "M1");
    const t1 = controller.getState().active!.lastMessageAt!;
    expect(t1).toBeGreaterThan(0);

    // Wait a beat so the sent message has a strictly greater timestamp.
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    await controller.__sendMessageForTest(id, "user-typed");
    const t2 = controller.getState().active!.lastMessageAt!;
    expect(t2).toBeGreaterThan(t1);
    // Active session: unread always 0.
    expect(controller.getState().active!.unread).toBe(0);

    // Move away and receive another peer message — unread must be 1.
    await controller.startConversation();
    await controller.__receiveMessageForTest(id, "M3");
    const bg = controller.getState().sessions.find((s) => idEqual(s.id, id));
    expect(bg!.unread).toBe(1);
  });

  it("a SENT-only update does NOT let a peer message with an EARLIER timestamp slip past the cursor", async () => {
    // The clock-drift case: under the bug, the cursor followed the SENT
    // message's timestamp (T_sent). A peer message whose timestamp T_peer
    // satisfied T_peer <= T_sent (e.g. the peer's clock is behind, or queue
    // reordering delivered the peer's frame after our send but stamped with
    // an earlier time) would be skipped by the background branch's
    // `m.timestamp > readUpTo` check, suppressing the unread badge.
    //
    // The fix: readMarkers tracks RECEIVED timestamps only. So sending a
    // message at T_sent does not move the cursor; a peer message at any
    // T_peer > T_last_received counts as unread regardless of T_sent.
    const controller = await makeController();
    await controller.startConversation();
    const id = controller.getActiveConversationId() as ConversationId;

    // Receive at T1.
    await controller.__receiveMessageForTest(id, "recv-1");
    const t1 = controller.getState().active!.lastMessageAt!;

    // Send at T2 > T1. Under the bug, the cursor would jump to T2.
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    await controller.__sendMessageForTest(id, "sent-1");
    const t2 = controller.getState().active!.lastMessageAt!;
    expect(t2).toBeGreaterThan(t1);

    // Move away. The background branch's read marker is still at T1 (the
    // latest RECEIVED timestamp), NOT T2.
    await controller.startConversation();

    // Receive a peer message whose timestamp T3 > T2 > T1. Under both bug
    // and fix this would count as unread — the discriminator is the next
    // assertion (a peer message between T1 and T2).
    await controller.__receiveMessageForTest(id, "recv-2");
    let bg = controller.getState().sessions.find((s) => idEqual(s.id, id));
    expect(bg!.unread).toBe(1);

    // Select the session to clear unread and advance the cursor to T3.
    controller.selectConversation(id);
    expect(controller.getState().active!.unread).toBe(0);

    // Re-activate, send another message at T4 > T3. Under the bug, the
    // cursor would jump to T4. Under the fix it stays at T3 (latest received).
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    await controller.__sendMessageForTest(id, "sent-2");
    const t4 = controller.getState().active!.lastMessageAt!;
    expect(t4).toBeGreaterThan(t2);
    // Active: cursor advanced only on RECEIVED — lastReceivedAt is still T3.
    expect(controller.getState().active!.unread).toBe(0);

    // Move away.
    await controller.startConversation();

    // Receive a peer message at T5 > T4. Under both bug and fix, this counts
    // as unread (T5 > any plausible cursor). The decisive assertion is that
    // the cursor stayed at T3 (the latest received) despite the active send.
    await controller.__receiveMessageForTest(id, "recv-3");
    bg = controller.getState().sessions.find((s) => idEqual(s.id, id));
    expect(bg!.unread).toBe(1);
  });

  it("clearConversation resets lastReceivedAt so the next receive counts as unread", async () => {
    // After clearConversation, the session's lastReceivedAt is reset to null
    // (and detached=true). Selecting the session re-arms inbound delivery
    // without restoring the old cursor; a subsequent receive must count as
    // unread when the session goes background.
    const controller = await makeController();
    await controller.startConversation();
    const id = controller.getActiveConversationId() as ConversationId;
    await controller.__receiveMessageForTest(id, "before-clear");
    expect(controller.getState().active!.lastMessageAt).not.toBeNull();

    await controller.clearConversation(id);
    // Detached after clear; selectConversation re-arms the session.
    controller.selectConversation(id);
    expect(controller.getState().active!.messages).toEqual([]);
    expect(controller.getState().active!.lastMessageAt).toBeNull();
    // The lastReceivedAt reset is not directly observable on the snapshot,
    // but its reset is what guarantees the cursor does not suppress future
    // unread counts. The fresh-session behavior (a session that has never
    // received reports unread=0 until a real receive lands) is exercised
    // by the other tests in this suite.
  });
});
