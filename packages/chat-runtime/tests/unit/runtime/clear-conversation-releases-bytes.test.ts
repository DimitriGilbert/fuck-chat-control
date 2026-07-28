import { describe, expect, it } from "vitest";

import { InMemoryConversationRepository } from "@fuck-eu-chat-control/chat-runtime/store";
import type { ConversationId } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import { createAtRestKeyManager } from "@fuck-eu-chat-control/chat-runtime/runtime/at-rest-key-manager";
import { createChatController, type ChatController } from "@fuck-eu-chat-control/chat-runtime/runtime/chat-controller";
import type { ChatFileInput } from "@fuck-eu-chat-control/chat-runtime/runtime/types";
import { stubPeerConnectionFactory } from "./_helpers";
import { createIdentityManager } from "@fuck-eu-chat-control/chat-runtime/runtime/identity-manager";
import { ConnectionState } from "@fuck-eu-chat-control/chat-runtime/signaling/state-machine";

import { MockSignalingSocket } from "../signaling/_helpers";
import { linkLoopbackPair, mockSocketFactory } from "../orchestrator/_helpers";

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

function tick(ms: number): Promise<void> {
  return new Promise((resolve): void => {
    setTimeout(resolve, ms);
  });
}

async function waitForConnected(controller: ChatController, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = controller.getState();
    if (state.connectionState === ConnectionState.Connected) return;
    await tick(5);
  }
  throw new Error("timed out waiting for connected state");
}

async function waitForReceivedFile(
  controller: ChatController,
  id: ConversationId,
  timeoutMs = 3000,
): Promise<{ transferId: number; bytes: Uint8Array }> {
  const deadline = Date.now() + timeoutMs;
  // The received-direction transfer id is the transfer id on the receiver
  // side. Poll the transfer list for a completed received transfer, then read
  // the bytes via getReceivedFile.
  while (Date.now() < deadline) {
    const transfers = controller.getState().active?.transfers ?? [];
    for (const t of transfers) {
      if (t.direction === "received" && t.status === "complete") {
        const file = controller.getReceivedFile(id, t.id);
        if (file !== null) {
          return { transferId: t.id, bytes: file.data };
        }
      }
    }
    await tick(5);
  }
  throw new Error("timed out waiting for a received file");
}

async function linkControllers(
  a: ChatController,
  b: ChatController,
): Promise<{ idA: ConversationId; idB: ConversationId }> {
  const { invitation } = await a.startConversation();
  await b.joinConversation(invitation);
  const idA = a.getActiveConversationId() as ConversationId;
  const idB = b.getActiveConversationId() as ConversationId;
  const { a: ta, b: tb } = linkLoopbackPair();
  a.__attachTransportForTest(idA, ta);
  b.__attachTransportForTest(idB, tb);
  await waitForConnected(a);
  await waitForConnected(b);
  return { idA, idB };
}

function makeImageFile(): ChatFileInput {
  // 1x1 PNG (transparent). Small valid binary payload for an image transfer.
  const png = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
  ]);
  return { data: png, name: "pixel.png", mimeType: "image/png" };
}

describe("clearConversation releases bytes + detaches inbound handlers (R9/F2)", () => {
  it("after clearConversation: transfers empty, receivedFiles cleared + byte buffers zeroed, late inbound frame does NOT repopulate snapshot", async (): Promise<void> => {
    const sender = await makeController();
    const receiver = await makeController();
    try {
      const { idA, idB } = await linkControllers(sender, receiver);

      // Seed a received file on the receiver by sending one from the sender.
      await sender.sendFile(idA, makeImageFile());
      const received = await waitForReceivedFile(receiver, idB);
      // Sanity: the buffer is non-zero before clear (the PNG payload is).
      const nonZeroBefore = Array.from(received.bytes).some((b) => b !== 0);
      expect(nonZeroBefore).toBe(true);

      // Seed a text message too so we can assert the snapshot is cleared AND
      // that a late inbound frame does not repopulate it.
      await sender.sendText(idA, "hello before clear");
      // wait for the receiver to mirror it
      let deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        if (receiver.getState().active?.messages.length ?? 0 > 0) break;
        await tick(5);
      }
      expect(receiver.getState().active?.messages.length ?? 0).toBeGreaterThan(0);

      // Act: clear the receiver's conversation.
      await receiver.clearConversation(idB);

      // (5.2.2) Transfer snapshot wiped.
      const activeAfter = receiver.getState().active;
      expect(activeAfter).not.toBeNull();
      expect(activeAfter?.transfers.length ?? 0).toBe(0);

      // (5.2.3) receivedFiles cleared AND underlying byte buffer zeroed.
      expect(receiver.getReceivedFile(idB, received.transferId)).toBeNull();
      let allZero = true;
      for (let i = 0; i < received.bytes.length; i++) {
        if (received.bytes[i] !== 0) {
          allZero = false;
          break;
        }
      }
      expect(allZero).toBe(true);

      // (5.2.5) Snapshot messages wiped by clear.
      expect(receiver.getState().active?.messages.length ?? 0).toBe(0);

      // (5.2.5 — detach) A late inbound frame arriving immediately after clear
      // must NOT repopulate the snapshot. The receiver's `detached` flag is
      // true, so the inbound handler drops the frame without mirroring it
      // into the snapshot. (The seam honors the same gate.)
      await receiver.__receiveMessageForTest(idB, "late frame after clear");
      expect(receiver.getState().active?.messages.length ?? 0).toBe(0);
    } finally {
      sender.dispose();
      receiver.dispose();
    }
  });

  it("clearConversation cancels in-flight (queued) transfers and drains the send queue", async (): Promise<void> => {
    const a = await makeController();
    const b = await makeController();
    try {
      const { idA } = await linkControllers(a, b);

      // Park the sender transport so transfers occupy a slot indefinitely.
      // We cannot easily re-link with a parked transport after the fact, so
      // instead exercise the queue path by saturating the concurrent cap with
      // large sends and then clearing mid-flight. The simpler, deterministic
      // assertion: after clearConversation, the active snapshot's transfer
      // list is empty (queued entries dropped) and a subsequent getHistory
      // still reflects only persisted text (no transfer rows leak in).
      const big: ChatFileInput = {
        data: new Uint8Array(1024 * 1024),
        name: "big.bin",
        mimeType: "application/octet-stream",
      };
      // Fire several sends without awaiting; the concurrent cap queues the
      // extras. We do NOT need to observe the queued state precisely — the
      // post-clear invariant is what we assert.
      const sends = [
        a.sendFile(idA, big),
        a.sendFile(idA, big),
        a.sendFile(idA, big),
      ];
      // Give the orchestrator a tick to allocate ids / queue.
      await tick(20);

      await a.clearConversation(idA);

      // Transfers wiped from the snapshot.
      expect(a.getState().active?.transfers.length ?? 0).toBe(0);
      // Snapshot messages wiped.
      expect(a.getState().active?.messages.length ?? 0).toBe(0);

      // The pending sendFile promises must settle (reject) rather than hang.
      // Wrap in a race so the test fails fast if clearConversation left them
      // dangling.
      const settled = await Promise.race([
        Promise.allSettled(sends).then((): boolean => true),
        tick(2000).then((): boolean => false),
      ]);
      expect(settled).toBe(true);

      // A late frame after clear is dropped.
      await a.__receiveMessageForTest(idA, "late");
      expect(a.getState().active?.messages.length ?? 0).toBe(0);
    } finally {
      a.dispose();
      b.dispose();
    }
  });
});
