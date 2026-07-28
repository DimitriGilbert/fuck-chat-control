import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InMemoryConversationRepository } from "@fuck-eu-chat-control/chat-runtime/store";
import type { ConversationId } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import { createAtRestKeyManager } from "@fuck-eu-chat-control/chat-runtime/runtime/at-rest-key-manager";
import {
  createChatController,
  type ChatController,
} from "@fuck-eu-chat-control/chat-runtime/runtime/chat-controller";
import type { ChatFileInput } from "@fuck-eu-chat-control/chat-runtime/runtime/types";
import { stubPeerConnectionFactory } from "./_helpers";
import { createIdentityManager } from "@fuck-eu-chat-control/chat-runtime/runtime/identity-manager";
import { ConnectionState } from "@fuck-eu-chat-control/chat-runtime/signaling/state-machine";

import type { PeerTransport } from "@fuck-eu-chat-control/chat-runtime/transport/peer-transport";
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

async function tick(ms = 50): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitForConnected(controller: ChatController, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = controller.getState();
    if (state.connectionState === ConnectionState.Connected) return;
    await tick(10);
  }
  throw new Error("timed out waiting for Connected");
}

function makeTextFile(text: string, name = "notes.txt", type = "text/plain"): ChatFileInput {
  return { data: new TextEncoder().encode(text), name, mimeType: type };
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

/**
 * Wrap a transport so its `bufferedAmount` reports over-limit after the first
 * send. The sender's chunk loop then parks in `waitForDrain`, keeping the
 * transfer in `sending` status indefinitely. Used to occupy slots so the
 * controller's queue path is observable.
 */
function parkTransport(inner: PeerTransport): PeerTransport {
  let tripped = false;
  return {
    ready: true,
    get bufferedAmount(): number {
      return tripped ? Number.MAX_SAFE_INTEGER : 0;
    },
    send: (bytes: Uint8Array): void => {
      tripped = true;
      inner.send(bytes);
    },
    setOnMessage: (h): void => {
      inner.setOnMessage(h);
    },
    setOnDrain: (): void => {
      // Intentionally never release: keep the transfer parked.
    },
    close: (): void => {
      inner.close();
    },
  };
}

async function linkControllers(
  a: ChatController,
  b: ChatController,
): Promise<{ idA: ConversationId; idB: ConversationId }>;
async function linkControllers(
  a: ChatController,
  b: ChatController,
  wrapA: (t: PeerTransport) => PeerTransport,
): Promise<{ idA: ConversationId; idB: ConversationId }>;
async function linkControllers(
  a: ChatController,
  b: ChatController,
  wrapA?: (t: PeerTransport) => PeerTransport,
): Promise<{ idA: ConversationId; idB: ConversationId }> {
  const { invitation } = await a.startConversation();
  await b.joinConversation(invitation);
  const idA = a.getActiveConversationId() as ConversationId;
  const idB = b.getActiveConversationId() as ConversationId;
  const { a: ta, b: tb } = linkLoopbackPair();
  a.__attachTransportForTest(idA, wrapA !== undefined ? wrapA(ta) : ta);
  b.__attachTransportForTest(idB, tb);
  await waitForConnected(a);
  await waitForConnected(b);
  return { idA, idB };
}

async function waitForQueued(
  controller: ChatController,
  name: string,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const transfers = controller.getState().active?.transfers ?? [];
    if (transfers.some((t) => t.name === name && t.status === "queued")) return;
    await tick(5);
  }
  throw new Error(`timed out waiting for queued transfer ${name}`);
}

describe("createChatController / file transfer", () => {
  let controllerA: ChatController;
  let controllerB: ChatController;

  beforeEach(async () => {
    controllerA = await makeController();
    controllerB = await makeController();
  });

  afterEach(() => {
    controllerA.dispose();
    controllerB.dispose();
  });

  it("delivers a small text file A->B; receiver snapshot reaches complete and bytes match", async () => {
    const { idA, idB } = await linkControllers(controllerA, controllerB);
    const payload = "hello file world";
    await controllerA.sendFile(idA, makeTextFile(payload));
    await tick(150);

    const transfersB = controllerB.getState().active?.transfers ?? [];
    const received = transfersB.find((t) => t.direction === "received");
    expect(received?.status).toBe("complete");
    expect(received?.bytesTransferred).toBe(payload.length);

    const file = controllerB.getReceivedFile(idB, received!.id);
    expect(file).not.toBeNull();
    expect(new TextDecoder().decode(file!.data)).toBe(payload);
  });

  it("image file reaches complete and is fetchable via getReceivedFile", async () => {
    const { idA, idB } = await linkControllers(controllerA, controllerB);
    const img = makeImageFile();
    await controllerA.sendFile(idA, img);
    await tick(150);

    const transfersB = controllerB.getState().active?.transfers ?? [];
    const received = transfersB.find(
      (t) => t.direction === "received" && t.mimeType === "image/png",
    );
    expect(received?.status).toBe("complete");
    const file = controllerB.getReceivedFile(idB, received!.id);
    expect(file).not.toBeNull();
    expect(file!.data.length).toBe(img.data.length);
  });

  it("a send that exceeds MAX_CONCURRENT_TRANSFERS is queued, not dropped", async () => {
    // Park A's transport so in-flight sends stay in `sending` status, holding
    // their slots. The 5th send must then queue rather than start.
    const { idA } = await linkControllers(controllerA, controllerB, parkTransport);

    // Fill the 4 concurrent slots. These promises reject on teardown (afterEach);
    // attach a catch so the rejection does not surface as an unhandled error.
    const parked = [
      controllerA.sendFile(idA, makeTextFile("a", "a.txt")),
      controllerA.sendFile(idA, makeTextFile("b", "b.txt")),
      controllerA.sendFile(idA, makeTextFile("c", "c.txt")),
      controllerA.sendFile(idA, makeTextFile("d", "d.txt")),
    ];
    for (const p of parked) void p.catch(() => {});

    // Wait until at least one send registers as `sending` so the orchestrator's
    // active count reflects the in-flight transfers.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const t = controllerA.getState().active?.transfers ?? [];
      if (t.some((x) => x.status === "sending")) break;
      await tick(5);
    }

    // The 5th send must queue.
    const fifth = controllerA.sendFile(idA, makeTextFile("e", "e.txt"));
    void fifth.catch(() => {});
    await waitForQueued(controllerA, "e.txt");

    const transfers = controllerA.getState().active?.transfers ?? [];
    const queued = transfers.find((t) => t.name === "e.txt");
    expect(queued?.status).toBe("queued");
  });

  it("cancelTransfer on an in-flight send moves its snapshot status to cancelled", async () => {
    const { idA, idB } = await linkControllers(controllerA, controllerB, parkTransport);
    void idB;

    // Start a send (parked in `sending`), then cancel by the observed id.
    const sendPromise = controllerA.sendFile(idA, makeImageFile());
    void sendPromise.catch(() => {});

    // Wait for the transfer to appear in the snapshot as sending.
    const deadline = Date.now() + 2000;
    let transferId: number | null = null;
    while (Date.now() < deadline) {
      const transfers = controllerA.getState().active?.transfers ?? [];
      const found = transfers.find((t) => t.name === "pixel.png" && t.status === "sending");
      if (found !== undefined) {
        transferId = found.id;
        break;
      }
      await tick(5);
    }
    expect(transferId).not.toBeNull();
    controllerA.cancelTransfer(idA, transferId!);

    // The snapshot should reflect cancelled status for that id.
    const after = controllerA.getState().active?.transfers ?? [];
    const cancelled = after.find((t) => t.id === transferId);
    expect(cancelled?.status).toBe("cancelled");
  });
});
