import { describe, expect, it } from "vitest";

import type { ReceivedFile } from "@fuck-eu-chat-control/chat-runtime/framing";
import { InMemoryConversationRepository } from "@fuck-eu-chat-control/chat-runtime/store";
import {
  generateAtRestKey,
  generateIdentityKeyPair,
} from "@fuck-eu-chat-control/chat-runtime/crypto";
import type { IdentityKeyPair } from "@fuck-eu-chat-control/chat-runtime/crypto";
import { ConnectionState } from "@fuck-eu-chat-control/chat-runtime/signaling/state-machine";
import type { ConversationRepository } from "@fuck-eu-chat-control/chat-runtime/store";

import {
  ConversationOrchestrator,
  type OrchestratorDeps,
  type OrchestratorHandlers,
  type TransferSummary,
} from "@fuck-eu-chat-control/chat-runtime/orchestrator/orchestrator";

import type { PeerTransport } from "@fuck-eu-chat-control/chat-runtime/transport/peer-transport";
import { linkLoopbackPair, mockSocketFactory, MockSignalingSocket } from "../orchestrator/_helpers";

const SAMPLE_BASE_URL = "https://app.example";

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

interface OrchKit {
  readonly orchestrator: ConversationOrchestrator;
  readonly repository: ConversationRepository;
  readonly identity: IdentityKeyPair;
  readonly socket: MockSignalingSocket;
  readonly received: ReceivedFile[];
  readonly summaries: TransferSummary[];
  readonly cancelled: number[];
}

function makeHandlers(
  received: ReceivedFile[],
  summaries: TransferSummary[],
  cancelled: number[],
): OrchestratorHandlers {
  return {
    onFileReceived: (file: ReceivedFile): void => {
      received.push(file);
    },
    onTransferStart: (s: TransferSummary): void => {
      summaries.push(s);
    },
    onTransferProgress: (s: TransferSummary): void => {
      summaries.push(s);
    },
    onTransferComplete: (s: TransferSummary): void => {
      summaries.push(s);
    },
    onTransferCancelled: (id: number): void => {
      cancelled.push(id);
    },
  };
}

async function makeOrchestrator(): Promise<OrchKit> {
  const repository = new InMemoryConversationRepository(generateAtRestKey());
  const identity = await generateIdentityKeyPair();
  const socket = new MockSignalingSocket();
  const received: ReceivedFile[] = [];
  const summaries: TransferSummary[] = [];
  const cancelled: number[] = [];
  const deps: OrchestratorDeps = {
    brokerUrl: "wss://broker.example",
    baseUrl: SAMPLE_BASE_URL,
    repository,
    socketFactory: mockSocketFactory(socket),
    identity,
    handlers: makeHandlers(received, summaries, cancelled),
  };
  return {
    orchestrator: new ConversationOrchestrator(deps),
    repository,
    identity,
    socket,
    received,
    summaries,
    cancelled,
  };
}

async function tick(ms = 50): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve the transfer id once the orchestrator's onTransferStart hook fires.
 * The deferred-delivery transport means start is observable before the chunk
 * loop completes, giving the test a real in-flight window to cancel.
 */
async function waitForStart(kit: OrchKit, timeoutMs = 2000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const started = kit.summaries.find(
      (s) => s.direction === "sent" && s.bytesTransferred === 0 && s.name === "big.bin",
    );
    if (started !== undefined) return started.transferId;
    await tick(5);
  }
  throw new Error("timed out waiting for onTransferStart");
}

async function waitForConnected(orch: ConversationOrchestrator, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (orch.state !== ConnectionState.Connected) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for Connected; state = ${orch.state}`);
    }
    await tick(10);
  }
}

async function makeHandshakePair(): Promise<{ initiator: OrchKit; responder: OrchKit }>;
async function makeHandshakePair(
  wrap: (transport: PeerTransport) => PeerTransport,
): Promise<{ initiator: OrchKit; responder: OrchKit }>;
async function makeHandshakePair(
  wrap?: (transport: PeerTransport) => PeerTransport,
): Promise<{ initiator: OrchKit; responder: OrchKit }> {
  const initiator = await makeOrchestrator();
  const responder = await makeOrchestrator();
  const invitation = await initiator.orchestrator.start();
  await responder.orchestrator.join(invitation);
  const { a, b } = linkLoopbackPair();
  initiator.orchestrator.attachTransport(wrap !== undefined ? wrap(a) : a);
  responder.orchestrator.attachTransport(b);
  await waitForConnected(initiator.orchestrator);
  await waitForConnected(responder.orchestrator);
  return { initiator, responder };
}

/**
 * Wrap a transport so the FIRST chunk send trips the framing layer's
 * backpressure gate (`bufferedAmount` >= MAX_BUFFERED_DATA_BYTES). The
 * sender's chunk loop then blocks in `waitForDrain` after chunk 0, giving the
 * test a stable in-flight transfer to cancel. The drain listener is captured
 * so a caller can release it; the cancel test never does, so the transfer
 * stays parked until cancelTransfer rejects the waiter.
 */
function backpressuredTransport(inner: PeerTransport): PeerTransport {
  let tripped = false;
  return {
    ready: true,
    get bufferedAmount(): number {
      // Once the first chunk send has run, report an over-limit buffer so the
      // sender's waitForDrain (checked at the top of every iteration AFTER
      // the first send) blocks indefinitely.
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
      // Intentionally never invoke: the test wants the transfer parked.
    },
    close: (): void => {
      inner.close();
    },
  };
}

describe("ConversationOrchestrator file transfer", () => {
  it("sendFile before Connected throws NotConnected", async () => {
    const kit = await makeOrchestrator();
    await kit.orchestrator.start();
    await expect(
      kit.orchestrator.sendFile(new Uint8Array([1, 2, 3]), "x.bin", "application/octet-stream"),
    ).rejects.toThrow(/connect/i);
  });

  it("rejects a name exceeding MAX_MANIFEST_NAME_BYTES", async () => {
    const { initiator } = await makeHandshakePair();
    const tooLong = "a".repeat(256);
    await expect(
      initiator.orchestrator.sendFile(new Uint8Array([1]), tooLong, "text/plain"),
    ).rejects.toThrow(/name/i);
  });

  it("rejects a mimeType exceeding MAX_MANIFEST_MIME_BYTES", async () => {
    const { initiator } = await makeHandshakePair();
    const tooLong = "a".repeat(128);
    await expect(
      initiator.orchestrator.sendFile(new Uint8Array([1]), "ok.txt", tooLong),
    ).rejects.toThrow(/mime/i);
  });

  it("delivers a file A->B and emits matching summaries; bytes match", async () => {
    const { initiator, responder } = await makeHandshakePair();
    const data = new TextEncoder().encode("hello file world");
    const transferId = await initiator.orchestrator.sendFile(data, "notes.txt", "text/plain");
    await tick(100);

    expect(responder.received).toHaveLength(1);
    const file = responder.received[0]!;
    expect(bytesEqual(file.data, data)).toBe(true);
    expect(file.manifest.name).toBe("notes.txt");
    expect(file.manifest.mimeType).toBe("text/plain");
    expect(file.manifest.size).toBe(data.length);

    // Sender emits start + complete (progress may be 0 for a small file).
    const initStart = initiator.summaries.find(
      (s) => s.direction === "sent" && s.bytesTransferred === 0 && s.name === "notes.txt",
    );
    expect(initStart).toBeDefined();
    const initComplete = initiator.summaries.find(
      (s) => s.direction === "sent" && s.name === "notes.txt" && s.bytesTransferred === s.size,
    );
    expect(initComplete).toBeDefined();

    // Receiver emits a received-direction complete summary.
    const recvComplete = responder.summaries.find(
      (s) => s.direction === "received" && s.name === "notes.txt" && s.bytesTransferred === s.size,
    );
    expect(recvComplete).toBeDefined();

    expect(transferId).toBeGreaterThan(0);
  });

  it("cancelTransfer delegates to sender + receiver and emits cancelled", async () => {
    const { initiator, responder } = await makeHandshakePair((t) => backpressuredTransport(t));
    // Use a transfer that will be in-flight: a multi-chunk payload big enough
    // to span multiple awaits but small enough to stay fast.
    const data = new Uint8Array(64 * 1024);
    for (let i = 0; i < data.length; i++) data[i] = (i * 31 + 7) & 0xff;

    // Kick off the send without awaiting. The backpressured transport stalls
    // the chunk loop in `waitForDrain` once the buffer fills, so the transfer
    // is genuinely in-flight.
    const sendPromise = initiator.orchestrator.sendFile(
      data,
      "big.bin",
      "application/octet-stream",
    );
    // Wait for the sender's start hook to record the id (so cancel targets a
    // real in-flight transfer rather than racing with allocation).
    const startedId = await waitForStart(initiator);
    initiator.orchestrator.cancelTransfer(startedId);
    await expect(sendPromise).rejects.toBeDefined();

    expect(initiator.cancelled).toContain(startedId);
    // Receiver-side cancel of the same id is a safe no-op when nothing is
    // known yet; assert it does not throw.
    expect(() => responder.orchestrator.cancelTransfer(startedId)).not.toThrow();
  });
});
