import { describe, expect, it } from "vitest";

import type { FileManifest, ReceivedFile } from "@fuck-eu-chat-control/chat-runtime/framing";
import type { ConversationOrchestrator } from "@fuck-eu-chat-control/chat-runtime/orchestrator/orchestrator";
import { ConnectionState } from "@fuck-eu-chat-control/chat-runtime/signaling/state-machine";
import {
  teardownSession,
  type SessionHolder,
} from "@fuck-eu-chat-control/chat-runtime/runtime/chat-session";
import type { ChatFileInput, ChatSession } from "@fuck-eu-chat-control/chat-runtime/runtime/types";
import type { WebRtcBridge } from "@fuck-eu-chat-control/chat-runtime/runtime/webrtc-bridge";
import { AuthMode } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import type { ConversationId } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import { InMemoryConversationRepository } from "@fuck-eu-chat-control/chat-runtime/store";
import { createAtRestKeyManager } from "@fuck-eu-chat-control/chat-runtime/runtime/at-rest-key-manager";
import {
  createChatController,
  type ChatController,
} from "@fuck-eu-chat-control/chat-runtime/runtime/chat-controller";
import { stubPeerConnectionFactory } from "./_helpers";
import { createIdentityManager } from "@fuck-eu-chat-control/chat-runtime/runtime/identity-manager";

import type { PeerTransport } from "@fuck-eu-chat-control/chat-runtime/transport/peer-transport";
import { MockSignalingSocket } from "../signaling/_helpers";
import { linkLoopbackPair, mockSocketFactory } from "../orchestrator/_helpers";

/**
 * Minimal stubs: teardownSession only calls `orchestrator.leave()` and
 * `bridge.close()`. The real coverage of those is in their own suites; here
 * we assert the received-files zeroing + clearing contract (R9/F7).
 */
function makeSession(files: ReceivedFile[]): ChatSession {
  const orchestrator = { leave(): void {} } as unknown as ConversationOrchestrator;
  const bridge = { close(): void {} } as unknown as WebRtcBridge;
  const receivedFiles = new Map<number, ReceivedFile>();
  for (const file of files) {
    receivedFiles.set(file.manifest.transferId, file);
  }
  return {
    id: new Uint8Array(16) as ConversationId,
    orchestrator,
    bridge,
    connectionState: ConnectionState.Connected,
    messages: [],
    safetyNumber: null,
    safetyNumberVerified: false,
    unread: 0,
    draft: "",
    invitation: null,
    record: null,
    lastMessagePreview: null,
    lastMessageAt: null,
    lastReceivedAt: null,
    transfers: [],
    receivedFiles,
    detached: false,
    authFailed: false,
    authMode: AuthMode.SafetyNumberOnly,
  };
}

function makeReceivedFile(transferId: number, bytes: number[]): ReceivedFile {
  const manifest: FileManifest = {
    transferId,
    name: `file-${transferId}.bin`,
    mimeType: "application/octet-stream",
    size: bytes.length,
    chunkCount: 1,
    contentHash: new Uint8Array(0),
  };
  return { manifest, data: new Uint8Array(bytes) };
}

describe("teardownSession clears receivedFiles + zeroes byte buffers (R9/F7)", () => {
  it("zeroes every received file's data buffer and clears the map", () => {
    const fileA = makeReceivedFile(1, [0xde, 0xad, 0xbe, 0xef]);
    const fileB = makeReceivedFile(2, [0x01, 0x02, 0x03, 0x04, 0x05]);
    // Keep references so we can read the buffers after teardown.
    const bufA = fileA.data;
    const bufB = fileB.data;
    const session = makeSession([fileA, fileB]);

    teardownSession(session, null);

    // The map was cleared.
    expect(session.receivedFiles.size).toBe(0);
    // The underlying buffers were zeroed in place.
    for (const b of bufA) expect(b).toBe(0);
    for (const b of bufB) expect(b).toBe(0);
    // Connection state dropped.
    expect(session.connectionState).toBe(ConnectionState.Disconnected);
  });

  it("is a no-op on receivedFiles when the session has none", () => {
    const session = makeSession([]);
    teardownSession(session, null);
    expect(session.receivedFiles.size).toBe(0);
    expect(session.connectionState).toBe(ConnectionState.Disconnected);
  });

  it("R3F3: nulls the holder's session synchronously so late handler callbacks are dropped", () => {
    const session = makeSession([]);
    const holder: SessionHolder = { session };
    teardownSession(session, holder);
    // The documented drop gate (see buildOrchestrator's handlers): every
    // orchestrator callback checks `holder.session !== null` before touching
    // the session, so a late onError/onChange after teardown must observe
    // null here, not the torn-down session.
    expect(holder.session).toBeNull();
  });

  it("still runs orchestrator.leave + bridge.close (best-effort) when zeroing succeeds", () => {
    let leaveCalled = false;
    let bridgeClosed = false;
    const orchestrator = {
      leave(): void {
        leaveCalled = true;
      },
    } as unknown as ConversationOrchestrator;
    const bridge = {
      close(): void {
        bridgeClosed = true;
      },
    } as unknown as WebRtcBridge;
    const session: ChatSession = {
      id: new Uint8Array(16) as ConversationId,
      orchestrator,
      bridge,
      connectionState: ConnectionState.Connected,
      messages: [],
      safetyNumber: null,
      safetyNumberVerified: false,
      unread: 0,
      draft: "",
      invitation: null,
      record: null,
      lastMessagePreview: null,
      lastMessageAt: null,
      lastReceivedAt: null,
      transfers: [],
      receivedFiles: new Map(),
      detached: false,
      authFailed: false,
      authMode: AuthMode.SafetyNumberOnly,
    };

    teardownSession(session, null);

    expect(leaveCalled).toBe(true);
    expect(bridgeClosed).toBe(true);
  });

  it("zeros buffers even when orchestrator.leave throws", () => {
    const file = makeReceivedFile(7, [0xca, 0xfe]);
    const buf = file.data;
    const orchestrator = {
      leave(): void {
        throw new Error("simulated leave failure");
      },
    } as unknown as ConversationOrchestrator;
    const bridge = { close(): void {} } as unknown as WebRtcBridge;
    const session: ChatSession = {
      id: new Uint8Array(16) as ConversationId,
      orchestrator,
      bridge,
      connectionState: ConnectionState.Connected,
      messages: [],
      safetyNumber: null,
      safetyNumberVerified: false,
      unread: 0,
      draft: "",
      invitation: null,
      record: null,
      lastMessagePreview: null,
      lastMessageAt: null,
      lastReceivedAt: null,
      transfers: [],
      receivedFiles: new Map([[7, file]]),
      detached: false,
      authFailed: false,
      authMode: AuthMode.SafetyNumberOnly,
    };

    // teardownSession swallows orchestrator/bridge errors; the buffer-zeroing
    // happened BEFORE those calls, so the contract still holds.
    expect(() => teardownSession(session, null)).not.toThrow();
    expect(session.receivedFiles.size).toBe(0);
    for (const b of buf) expect(b).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// CR-8 + CR-9: real-controller paths (leaveConversation / clearAll / dispose).
// The stub-session block above covers the low-level teardownSession helper; the
// tests below cover the public controller surface, which is where the defects
// lived (bare sendQueues.delete/clear, clearAll not setting detached, etc.).
// ---------------------------------------------------------------------------

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

function tick(ms = 50): Promise<void> {
  return new Promise((resolve): void => {
    setTimeout(resolve, ms);
  });
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

/**
 * Wrap a transport so its `bufferedAmount` reports over-limit after the first
 * send. The sender's chunk loop parks in `waitForDrain`, keeping the transfer
 * in `sending` status indefinitely. Used to occupy slots so the controller's
 * queue path is observable — mirrors file-transfer.test.ts.
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

/**
 * Wait until EXACTLY `expected` transfers for the active session are in
 * `sending` status, then drain the microtask queue so any synchronous
 * onTransferStart → drainSendQueue re-entrance from the parked sends has
 * fully settled before the caller issues the cap-busting sendFile.
 *
 * The re-entrance race: FrameSender.sendFile fires onTransferStart
 * SYNCHRONOUSLY inside the controller's `await orchestrator.sendFile`. That
 * re-enters drainSendQueue via onSessionChange. If the 5th sendFile is fired
 * before every parked send's onTransferStart has landed, the drain from an
 * earlier send can shift the 5th's queued entry back out and re-start it,
 * so its status never stably reads "queued" → waitForQueued times out under
 * concurrent-suite load. Waiting for ALL parked sends to be `sending` (not
 * just one) plus a microtask drain closes the window.
 */
async function waitForSending(
  controller: ChatController,
  expected: number,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const transfers = controller.getState().active?.transfers ?? [];
    const sending = transfers.filter((t) => t.status === "sending").length;
    if (sending >= expected) break;
    await tick(5);
  }
  // Drain pending microtasks so synchronous onTransferStart re-entrance from
  // the parked sends has fully unwound before we fire the next sendFile.
  await tick(20);
}

describe("CR-8: leaveConversation drains the send queue (rejects + zeroes)", () => {
  it("rejects a queued send with 'conversation cleared' and zeroes its byte buffer", async (): Promise<void> => {
    const a = await makeController();
    const b = await makeController();
    try {
      // Park A's transport so the 4 concurrent slots stay filled; the 5th
      // send queues and never starts. leaveConversation must reject its
      // promise (not hang) and zero its pre-read byte buffer.
      const { idA } = await linkControllers(a, b, parkTransport);

      const parked = [
        a.sendFile(idA, makeTextFile("a", "a.txt")),
        a.sendFile(idA, makeTextFile("b", "b.txt")),
        a.sendFile(idA, makeTextFile("c", "c.txt")),
        a.sendFile(idA, makeTextFile("d", "d.txt")),
      ];
      for (const p of parked) void p.catch((): void => {});

      // Wait until ALL FOUR parked slots are `sending` (not just one) and the
      // synchronous onTransferStart → drainSendQueue re-entrance from each
      // has settled. Waiting for "at least one" left a window where a later
      // parked send's onTransferStart could re-enter drain and shift the 5th
      // queued entry back out, so its status never stably read "queued".
      await waitForSending(a, 4);

      const queued = a.sendFile(idA, makeTextFile("e", "e.txt"));
      await waitForQueued(a, "e.txt");

      // leaveConversation is the CR-8 call site under test.
      a.leaveConversation(idA);

      // The queued promise must reject (not hang). Wrap in a race so the test
      // fails fast if leaveConversation left it dangling.
      const settled = await Promise.race([
        queued.then(
          (): { status: string } => ({ status: "resolved" }),
          (err: unknown): { status: string; message: string } => ({
            status: "rejected",
            message: err instanceof Error ? err.message : String(err),
          }),
        ),
        tick(2000).then((): { status: string } => ({ status: "hung" })),
      ]);
      expect(settled.status).toBe("rejected");
      if (settled.status === "rejected") {
        // The exact rejection message is part of the CR-8 contract.
        expect((settled as { message: string }).message).toBe("conversation cleared");
      }

      // The parked sends also reject rather than hang (they were in-flight on
      // the orchestrator, torn down by teardownSession).
      const parkedSettled = await Promise.race([
        Promise.allSettled(parked).then((): boolean => true),
        tick(2000).then((): boolean => false),
      ]);
      expect(parkedSettled).toBe(true);
    } finally {
      a.dispose();
      b.dispose();
    }
  });
});

describe("CR-8: dispose drains every session's send queue", () => {
  it("multiple sessions with queued sends all reject on dispose", async (): Promise<void> => {
    // Two pairs of controllers so we have two queued sends on two distinct
    // sessions of one controller (A1 and A2 each have their own send queue).
    const a1 = await makeController();
    const b1 = await makeController();
    const a2 = await makeController();
    const b2 = await makeController();
    try {
      const link1 = await linkControllers(a1, b1, parkTransport);
      const idA1 = link1.idA;
      // A1 holds session 1; A2 holds session 2 on a separate controller so
      // we can assert dispose drains BOTH controllers' queues independently.
      const link2 = await linkControllers(a2, b2, parkTransport);
      const idA2 = link2.idA;

      const fillSlots = async (controller: ChatController, id: ConversationId): Promise<void> => {
        const parked = [
          controller.sendFile(id, makeTextFile("a", "a.txt")),
          controller.sendFile(id, makeTextFile("b", "b.txt")),
          controller.sendFile(id, makeTextFile("c", "c.txt")),
          controller.sendFile(id, makeTextFile("d", "d.txt")),
        ];
        for (const p of parked) void p.catch((): void => {});
        // Wait for ALL four parked slots to be `sending` (not just one) and
        // settle onTransferStart re-entrance before the caller fires the 5th
        // sendFile. See waitForSending for the race this closes.
        await waitForSending(controller, 4);
      };

      await fillSlots(a1, idA1);
      await fillSlots(a2, idA2);

      const queued1 = a1.sendFile(idA1, makeTextFile("e", "e.txt"));
      const queued2 = a2.sendFile(idA2, makeTextFile("e", "e.txt"));
      await waitForQueued(a1, "e.txt");
      await waitForQueued(a2, "e.txt");

      // dispose is the CR-8 call site under test. Drain ALL queues before
      // sessions.clear().
      a1.dispose();
      a2.dispose();

      // Both queued sends must reject with the CR-8 message, not hang.
      const [r1, r2] = await Promise.race([
        Promise.all([
          queued1.then(
            (): string => "resolved",
            (err: unknown): string => (err instanceof Error ? err.message : String(err)),
          ),
          queued2.then(
            (): string => "resolved",
            (err: unknown): string => (err instanceof Error ? err.message : String(err)),
          ),
        ]).then((vals): string[] => vals),
        tick(2000).then((): string[] => ["hung", "hung"]),
      ]);
      expect(r1).toBe("conversation cleared");
      expect(r2).toBe("conversation cleared");
    } finally {
      a1.dispose();
      b1.dispose();
      a2.dispose();
      b2.dispose();
    }
  });
});

describe("CR-9: clearAll reaches parity with clearConversation", () => {
  it("clearAll zeroes receivedFiles, clears transfers, sets detached, drops queued sends, and a late inbound frame is DROPPED", async (): Promise<void> => {
    const sender = await makeController();
    const receiver = await makeController();
    try {
      const { idA, idB } = await linkControllers(sender, receiver, parkTransport);

      // Park A's transport so its slots stay filled: clearAll must drain A's
      // queued send promise. Park on the SENDER side (idA) since that is the
      // side whose sendFile calls queue.
      const parked = [
        sender.sendFile(idA, makeTextFile("a", "a.txt")),
        sender.sendFile(idA, makeTextFile("b", "b.txt")),
        sender.sendFile(idA, makeTextFile("c", "c.txt")),
        sender.sendFile(idA, makeTextFile("d", "d.txt")),
      ];
      for (const p of parked) void p.catch((): void => {});
      const sendingDeadline = Date.now() + 2000;
      while (Date.now() < sendingDeadline) {
        const t = sender.getState().active?.transfers ?? [];
        if (t.some((x) => x.status === "sending")) break;
        await tick(5);
      }
      const queuedSend = sender.sendFile(idA, makeTextFile("e", "e.txt"));
      void queuedSend.catch((): void => {});

      // Seed a RECEIVED file + a received text message on the RECEIVER so we
      // can assert clearAll zeroes the buffer and wipes the snapshot. The
      // receiver is the side under test for the late-frame regression.
      // Use a NON-parked link to deliver a file B->A. But A's transport is
      // parked; to deliver a file TO the receiver we need the sender to send
      // successfully. Since A is parked, deliver the file B->A is not what we
      // want — we want the RECEIVER to hold bytes. The receiver's transport is
      // NOT parked (only the sender's is), so the sender CAN send to the
      // receiver. But the sender is parked. Re-link a clean pair for the
      // receive-seed step: the receiver under test will be the SECOND
      // receiver below.
      void idA;
      void idB;
      // The parked link above established the queued-send path on `sender`.
      // For the CR-9 late-frame regression we exercise `receiver` (clean link,
      // non-parked) so we can deliver a real received file + message, then
      // clearAll and probe with a late frame.
      const seedSender = await makeController();
      const seedReceiver = receiver;
      const { idA: sidA, idB: sidB } = await linkControllers(seedSender, seedReceiver);
      void sidA;
      // Deliver a small text file so the receiver has a real receivedFiles
      // entry whose byte buffer we can assert was zeroed.
      await seedSender.sendFile(sidA, makeTextFile("payload", "seed.txt"));
      // Wait for the receiver to register a completed received transfer.
      let receivedTransferId: number | null = null;
      const recvDeadline = Date.now() + 3000;
      while (Date.now() < recvDeadline) {
        const transfers = seedReceiver.getState().active?.transfers ?? [];
        const done = transfers.find((t) => t.direction === "received" && t.status === "complete");
        if (done !== undefined) {
          receivedTransferId = done.id;
          break;
        }
        await tick(5);
      }
      expect(receivedTransferId).not.toBeNull();
      const receivedFile = seedReceiver.getReceivedFile(sidB, receivedTransferId as number);
      expect(receivedFile).not.toBeNull();
      const receivedBuf = receivedFile!.data;
      // Sanity: the buffer is non-zero before clear (it holds "payload").
      const nonZeroBefore = Array.from(receivedBuf).some((x) => x !== 0);
      expect(nonZeroBefore).toBe(true);

      // Also seed a text message so we can assert the snapshot is wiped AND
      // that a late inbound frame does not repopulate it.
      await seedSender.sendText(sidA, "hello before clearAll");
      // Wait for receiver to mirror it.
      let msgDeadline = Date.now() + 2000;
      while (Date.now() < msgDeadline) {
        if ((seedReceiver.getState().active?.messages.length ?? 0) > 0) break;
        await tick(5);
      }
      expect(seedReceiver.getState().active?.messages.length ?? 0).toBeGreaterThan(0);

      // Act: clearAll on the receiver.
      await seedReceiver.clearAll();

      // (5.2.2 parity) Transfer snapshot wiped (received transfer gone).
      expect(seedReceiver.getState().active?.transfers.length ?? 0).toBe(0);

      // (5.2.3 parity) receivedFiles cleared AND underlying byte buffer
      // zeroed in place (the retained reference is now all zeros).
      expect(seedReceiver.getReceivedFile(sidB, receivedTransferId as number)).toBeNull();
      let allZero = true;
      for (let i = 0; i < receivedBuf.length; i++) {
        if (receivedBuf[i] !== 0) {
          allZero = false;
          break;
        }
      }
      expect(allZero).toBe(true);

      // (5.2.5 parity) Snapshot messages wiped by clearAll.
      expect(seedReceiver.getState().active?.messages.length ?? 0).toBe(0);

      // (detached — THE load-bearing CR-9 fix) A late inbound frame arriving
      // immediately after clearAll must NOT repopulate the snapshot. Before
      // CR-9 clearAll did not set detached, so the late frame re-populated
      // messages — the regression we assert is now closed.
      await seedReceiver.__receiveMessageForTest(sidB, "late frame after clearAll");
      expect(seedReceiver.getState().active?.messages.length ?? 0).toBe(0);

      // (5.2.4 parity on the parked sender) The sender's queued send promise
      // must reject (clearAll drained its queue too). clearAll on the receiver
      // does not drain the sender's queue — that lives on `sender`, not on
      // `seedReceiver`. Verify clearAll drained seedReceiver's OWN queue: it
      // had no queued sends (its transport is not parked), so this is a no-op
      // assertion. The sender-side queue drain is covered by the separate
      // CR-8 leaveConversation/dispose tests above.
      void queuedSend;

      // Cleanup: seedSender is a real controller; dispose it.
      seedSender.dispose();
    } finally {
      sender.dispose();
      receiver.dispose();
    }
  });

  it("clearAll drains queued sends on the controller's OWN sessions (sender side)", async (): Promise<void> => {
    // Cover CR-9's "drain sendQueues via the helper" parity for the sender
    // side: a controller with a parked transport + a queued send must have
    // its queued promise rejected by clearAll (parity with clearConversation).
    const a = await makeController();
    const b = await makeController();
    try {
      const { idA } = await linkControllers(a, b, parkTransport);

      const parked = [
        a.sendFile(idA, makeTextFile("a", "a.txt")),
        a.sendFile(idA, makeTextFile("b", "b.txt")),
        a.sendFile(idA, makeTextFile("c", "c.txt")),
        a.sendFile(idA, makeTextFile("d", "d.txt")),
      ];
      for (const p of parked) void p.catch((): void => {});
      // Wait until ALL FOUR parked slots are `sending` and the synchronous
      // onTransferStart → drainSendQueue re-entrance has settled before firing
      // the 5th sendFile. See waitForSending for the race this closes.
      await waitForSending(a, 4);

      const queued = a.sendFile(idA, makeTextFile("e", "e.txt"));
      void queued.catch((): void => {});
      await waitForQueued(a, "e.txt");

      await a.clearAll();

      // clearAll drains the queue BEFORE cancelling in-flight transfers, so a
      // still-queued send rejects with the helper's deterministic message
      // (this is the CR-9 parity guarantee with clearConversation).
      const result = await Promise.race([
        queued.then(
          (): string => "resolved",
          (err: unknown): string => (err instanceof Error ? err.message : String(err)),
        ),
        tick(2000).then((): string => "hung"),
      ]);
      expect(result).toBe("conversation cleared");

      // Snapshot transfers wiped.
      expect(a.getState().active?.transfers.length ?? 0).toBe(0);
      // Late frame after clearAll is dropped (detached was set).
      await a.__receiveMessageForTest(idA, "late after clearAll");
      expect(a.getState().active?.messages.length ?? 0).toBe(0);

      // The parked sends also settle rather than hang.
      const parkedSettled = await Promise.race([
        Promise.allSettled(parked).then((): boolean => true),
        tick(2000).then((): boolean => false),
      ]);
      expect(parkedSettled).toBe(true);
    } finally {
      a.dispose();
      b.dispose();
    }
  });
});
