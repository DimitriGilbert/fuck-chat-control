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
import { OrchestratorErrorCode } from "@fuck-eu-chat-control/chat-runtime/orchestrator/errors";

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
  readonly errors: Array<{ readonly id: number; readonly error: unknown }>;
}

function makeHandlers(
  received: ReceivedFile[],
  summaries: TransferSummary[],
  cancelled: number[],
  errors: Array<{ readonly id: number; readonly error: unknown }>,
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
    onTransferError: (id: number, error: unknown): void => {
      errors.push({ id, error });
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
  const errors: Array<{ readonly id: number; readonly error: unknown }> = [];
  const deps: OrchestratorDeps = {
    brokerUrl: "wss://broker.example",
    baseUrl: SAMPLE_BASE_URL,
    repository,
    socketFactory: mockSocketFactory(socket),
    identity,
    handlers: makeHandlers(received, summaries, cancelled, errors),
  };
  return {
    orchestrator: new ConversationOrchestrator(deps),
    repository,
    identity,
    socket,
    received,
    summaries,
    cancelled,
    errors,
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

    // R2/F3: the cancellation surfaces as EXACTLY ONE onTransferCancelled —
    // emitted by cancelTransfer itself; the rejected sendFile coroutine must
    // NOT emit a second event for the same id.
    expect(initiator.cancelled.filter((id) => id === startedId)).toHaveLength(1);
    // Receiver-side cancel of the same id is a safe no-op when nothing is
    // known yet; assert it does not throw.
    expect(() => responder.orchestrator.cancelTransfer(startedId)).not.toThrow();
  });

  it("R2/F3: cancelling an unknown id is a silent no-op — no emission, no throw", async () => {
    const { initiator } = await makeHandshakePair();
    const unknownId = 4_242_424;

    expect(() => initiator.orchestrator.cancelTransfer(unknownId)).not.toThrow();

    // Neither the sender nor the receiver knows the id, so no event fires.
    expect(initiator.cancelled).toHaveLength(0);
    expect(initiator.errors).toHaveLength(0);
  });

  it("R2/F4: concurrent sendFile calls keep per-transfer id and metadata attribution", async () => {
    const { initiator, responder } = await makeHandshakePair();
    // Two multi-chunk payloads (MAX_CHUNK_BYTES = 16 KiB) so both sends really
    // interleave across the sha256/manifest/chunk awaits, firing progress
    // events whose summaries must be resolved from EACH transfer's own
    // metadata registration.
    const dataA = new Uint8Array(40 * 1024);
    for (let i = 0; i < dataA.length; i++) dataA[i] = (i * 13 + 1) & 0xff;
    const dataB = new Uint8Array(32 * 1024);
    for (let i = 0; i < dataB.length; i++) dataB[i] = (i * 29 + 5) & 0xff;

    // Launch both WITHOUT awaiting in between: the second call reserves its
    // id and registers its metadata while the first is still hashing.
    const sendA = initiator.orchestrator.sendFile(dataA, "a.bin", "application/octet-stream");
    const sendB = initiator.orchestrator.sendFile(dataB, "b.bin", "application/octet-stream");
    const [idA, idB] = await Promise.all([sendA, sendB]);

    expect(idA).not.toBe(idB);

    // Start summaries carry each transfer's own name/size under its own id.
    const startOf = (id: number): TransferSummary | undefined =>
      initiator.summaries.find(
        (s) => s.direction === "sent" && s.transferId === id && s.bytesTransferred === 0,
      );
    expect(startOf(idA)).toMatchObject({ name: "a.bin", size: dataA.length });
    expect(startOf(idB)).toMatchObject({ name: "b.bin", size: dataB.length });

    // Progress summaries (fired from the per-chunk hook, which only carries
    // id + counts) must be attributed via each transfer's own metadata.
    const progressOf = (id: number): TransferSummary[] =>
      initiator.summaries.filter(
        (s) =>
          s.direction === "sent" &&
          s.transferId === id &&
          s.bytesTransferred > 0 &&
          s.bytesTransferred < s.size,
      );
    expect(progressOf(idA).length).toBeGreaterThan(0);
    expect(progressOf(idB).length).toBeGreaterThan(0);
    for (const p of progressOf(idA)) expect(p.name).toBe("a.bin");
    for (const p of progressOf(idB)) expect(p.name).toBe("b.bin");

    // Both completed and both were delivered — no cross-transfer corruption.
    // (Delivery through the loopback transport's async ingest needs a wait,
    // mirroring the single-send test's tick.)
    expect(
      initiator.summaries.some(
        (s) =>
          s.direction === "sent" &&
          s.transferId === idA &&
          s.bytesTransferred === s.size &&
          s.name === "a.bin",
      ),
    ).toBe(true);
    expect(
      initiator.summaries.some(
        (s) =>
          s.direction === "sent" &&
          s.transferId === idB &&
          s.bytesTransferred === s.size &&
          s.name === "b.bin",
      ),
    ).toBe(true);
    const deliveryDeadline = Date.now() + 2000;
    while (responder.received.length < 2 && Date.now() < deliveryDeadline) {
      await tick(10);
    }
    expect(responder.received.map((f) => f.manifest.name).sort()).toEqual(["a.bin", "b.bin"]);
    expect(initiator.cancelled).toHaveLength(0);
    expect(initiator.errors).toHaveLength(0);
  });

  it("R2/F8: the concurrent-transfer cap is enforced at sendFile entry, before hashing", async () => {
    const { initiator, responder } = await makeHandshakePair((t) => backpressuredTransport(t));
    const payload = (): Uint8Array => {
      const data = new Uint8Array(32 * 1024);
      for (let i = 0; i < data.length; i++) data[i] = (i * 17 + 3) & 0xff;
      return data;
    };

    // Saturate all MAX_CONCURRENT_TRANSFERS slots. The backpressured wrapper
    // parks every chunk loop in waitForDrain after its manifest, so all four
    // sends stay in-flight for the whole test.
    const sends: Array<Promise<number>> = [];
    for (let i = 0; i < 4; i++) {
      sends.push(initiator.orchestrator.sendFile(payload(), "big.bin", "application/octet-stream"));
    }
    // All four reservations were made synchronously at each call's entry, so
    // by the time all four start events have fired the cap is fully held.
    const deadline = Date.now() + 2000;
    while (
      initiator.summaries.filter((s) => s.direction === "sent" && s.bytesTransferred === 0).length <
      4
    ) {
      if (Date.now() > deadline) throw new Error("timed out waiting for the four in-flight sends");
      await tick(5);
    }

    // The fifth send must be rejected AT ENTRY (the id reservation counts
    // against the cap from the sendFile call, not from onTransferStart) —
    // pre-fix all five passed the check because registration happened only
    // after the sha256 await.
    await expect(
      initiator.orchestrator.sendFile(payload(), "fifth.bin", "application/octet-stream"),
    ).rejects.toMatchObject({
      code: OrchestratorErrorCode.NotConnected,
      message: expect.stringMatching(/concurrent transfer limit/),
    });
    expect(initiator.cancelled).toHaveLength(0);

    // Tear down: the four parked sends reject with TearingDown and each
    // failure is attributed to its OWN transfer id (no id cross-attribution).
    initiator.orchestrator.leave();
    const settled = await Promise.allSettled(sends);
    expect(settled.every((r) => r.status === "rejected")).toBe(true);
    const erroredIds = new Set(initiator.errors.map((e) => e.id));
    expect(erroredIds.size).toBe(4);
    const startedIds = new Set(
      initiator.summaries
        .filter((s) => s.direction === "sent" && s.bytesTransferred === 0)
        .map((s) => s.transferId),
    );
    for (const id of erroredIds) expect(startedIds.has(id)).toBe(true);
    expect(initiator.errors.every((e) => !initiator.cancelled.includes(e.id))).toBe(true);
    responder.orchestrator.leave();
  });
});
