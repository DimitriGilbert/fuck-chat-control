import { describe, expect, it } from "vitest";

import type { ConversationId } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import { generateAtRestKey } from "@fuck-eu-chat-control/chat-runtime/crypto";
import { InMemoryConversationRepository } from "@fuck-eu-chat-control/chat-runtime/store";
import { createAtRestKeyManager } from "@fuck-eu-chat-control/chat-runtime/runtime/at-rest-key-manager";
import {
  createChatController,
  type ChatController,
} from "@fuck-eu-chat-control/chat-runtime/runtime/chat-controller";
import { createIdentityManager } from "@fuck-eu-chat-control/chat-runtime/runtime/identity-manager";

import { parse } from "../signaling/_helpers";
import { negotiatingPeerConnectionFactory, SocketPool } from "./_helpers";

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

/** Macrotask flush so the bridge's async offer path settles between deliveries. */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve));
}

function roomHex(id: ConversationId): string {
  let hex = "";
  for (let i = 0; i < id.length; i++) hex += id[i].toString(16).padStart(2, "0");
  return hex;
}

function messagesOfKind(socket: { readonly sent: string[] }, kind: string): number {
  return socket.sent.filter((raw) => parse(raw).t === kind).length;
}

async function makeController(): Promise<{
  controller: ChatController;
  pool: SocketPool;
  peers: ReturnType<typeof negotiatingPeerConnectionFactory>["instances"];
}> {
  const identityManager = createIdentityManager(fakeStorage());
  await identityManager.ensureLoaded();
  const atRestKeyManager = createAtRestKeyManager(fakeStorage());
  await atRestKeyManager.ensureLoaded();
  const pool = new SocketPool();
  const peers = negotiatingPeerConnectionFactory();
  const repository = new InMemoryConversationRepository(generateAtRestKey());
  const controller = createChatController({
    brokerUrl: BROKER_URL,
    baseUrl: BASE_URL,
    identityManager,
    atRestKeyManager,
    repository,
    // Factory is required by the type but unused when `repository` is set.
    repositoryFactory: () => repository,
    socketFactory: pool.factory,
    peerConnectionFactory: peers.factory,
    iceServers: [],
  });
  return { controller, pool, peers: peers.instances };
}

describe("controller.retry() re-establishes bridge-mode transport (R3F6 / Phase 8)", () => {
  it("retry on a dropped session dials a fresh signaling socket, re-joins the room, and re-offers", async () => {
    const { controller, pool, peers } = await makeController();
    await controller.startConversation();
    const id = controller.getActiveConversationId() as ConversationId;

    // First connection: socket #1 dials, joins, and offers when the peer
    // joins (any role offers on peer-join; this session happens to be
    // Initiator).
    const first = pool.sockets[0];
    expect(first).toBeDefined();
    first.serverOpen();
    expect(messagesOfKind(first, "join")).toBe(1);
    first.deliver(JSON.stringify({ t: "join", roomId: roomHex(id) }));
    await flush();
    expect(messagesOfKind(first, "offer")).toBe(1);

    // Drop: the broker relays the peer's leave. The bridge surfaces it, the
    // orchestrator tears the session down and moves to Disconnected — the
    // state whose only UI affordance is retry().
    first.deliver(JSON.stringify({ t: "leave", roomId: roomHex(id) }));
    await flush();
    expect(controller.getState().active?.connectionState).toBe("disconnected");

    // Retry. Before R3F6 this flipped the orchestrator to Signaling but
    // dialed nothing — connectSignaling no-ops in bridge mode and the
    // bridge's socket was long gone, leaving a dead spinner.
    controller.retry(id);

    // The bridge re-dialed a FRESH socket (socket #2), re-joined the room,
    // and the dropped socket was cleanly evicted (leave relayed so the
    // broker frees the capacity-2 room slot before the re-join).
    const second = pool.sockets[1];
    expect(second).toBeDefined();
    expect(messagesOfKind(first, "leave")).toBe(1);
    expect(first.closed).toBe(true);
    second.serverOpen();
    expect(messagesOfKind(second, "join")).toBe(1);

    // The retry also rebuilt the peer connection (a failed
    // RTCPeerConnection cannot restart ICE) and re-initiates the offer
    // under the corrected glare rules.
    expect(peers.length).toBe(2);
    expect(peers[0]?.closed).toBe(true);
    const peerJoin = JSON.stringify({ t: "join", roomId: roomHex(id) });
    second.deliver(peerJoin);
    await flush();
    expect(messagesOfKind(second, "offer")).toBe(1);

    // The controller surfaced the re-established Signaling state.
    expect(controller.getState().active?.connectionState).toBe("signaling");

    controller.dispose();
  });

  it("a close of the RE-ESTABLISHED socket is surfaced again (suppression reset by reconnect)", async () => {
    const { controller, pool } = await makeController();
    await controller.startConversation();
    const id = controller.getActiveConversationId() as ConversationId;

    const first = pool.sockets[0];
    first.serverOpen();
    // Promote peer presence first (the broker's leave relay only surfaces
    // for a known peer), then drop: session goes Disconnected.
    first.deliver(JSON.stringify({ t: "join", roomId: roomHex(id) }));
    await flush();
    first.deliver(JSON.stringify({ t: "leave", roomId: roomHex(id) }));
    await flush();
    expect(controller.getState().active?.connectionState).toBe("disconnected");

    controller.retry(id);
    const second = pool.sockets[1];
    expect(second).toBeDefined();
    second.serverOpen();

    // The broker now drops OUR re-established socket (broker restart). The
    // suppression flag was reset by reconnect, so the close must surface as
    // a peer drop (Disconnected), not be swallowed as the expected
    // post-handshake teardown.
    second.serverClose();
    await flush();
    expect(controller.getState().active?.connectionState).toBe("disconnected");

    controller.dispose();
  });

  it("retry on a non-Disconnected session is rejected without dialing a new socket", async () => {
    const { controller, pool } = await makeController();
    await controller.startConversation();
    const id = controller.getActiveConversationId() as ConversationId;

    const first = pool.sockets[0];
    first.serverOpen();
    // Still Waiting (never dropped): orchestrator.retry() rejects the
    // illegal state, the controller surfaces it to subscribers as a state
    // error (getState() itself always reports error: null), and the bridge
    // must NOT dial a second socket for the blocked retry.
    let latest = controller.getState();
    controller.subscribe((state) => {
      latest = state;
    });
    controller.retry(id);
    expect(latest.error).toContain("retry called from state");
    expect(pool.sockets.length).toBe(1);

    controller.dispose();
  });
});
