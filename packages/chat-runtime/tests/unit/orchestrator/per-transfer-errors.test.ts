import { describe, expect, it } from "vitest";

import {
  encryptFrame,
  generateAtRestKey,
  generateIdentityKeyPair,
} from "@fuck-eu-chat-control/chat-runtime/crypto";
import type { AESKey, IdentityKeyPair } from "@fuck-eu-chat-control/chat-runtime/crypto";
import {
  computeChunkCount,
  decodeWireFrame,
  encodeManifest,
  encodeWireFrame,
  FramingError,
  FramingErrorCode,
} from "@fuck-eu-chat-control/chat-runtime/framing";
import type { FileManifest, ReceivedFile } from "@fuck-eu-chat-control/chat-runtime/framing";
import {
  MAX_CONCURRENT_TRANSFERS,
  MAX_INCOMPLETE_TRANSFER_BYTES,
  PROTOCOL_VERSION,
} from "@fuck-eu-chat-control/chat-runtime/protocol/limits";
import { FrameType } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import type { FrameAad, SessionId } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import { ConnectionState } from "@fuck-eu-chat-control/chat-runtime/signaling/state-machine";
import { InMemoryConversationRepository } from "@fuck-eu-chat-control/chat-runtime/store";
import type {
  ConversationMessage,
  ConversationRepository,
} from "@fuck-eu-chat-control/chat-runtime/store";

import {
  ConversationOrchestrator,
  type OrchestratorDeps,
  type OrchestratorHandlers,
  type TransferSummary,
} from "@fuck-eu-chat-control/chat-runtime/orchestrator/orchestrator";
import type { PeerTransport } from "@fuck-eu-chat-control/chat-runtime/transport/peer-transport";
import {
  linkLoopbackPair,
  LoopbackPeerTransport,
  mockSocketFactory,
  MockSignalingSocket,
} from "../orchestrator/_helpers";

// R3/F1: per-transfer framing failures (an error scoped to a single
// transferId) are surfaced via onTransferError and MUST NOT tear the session
// down. Wire-level violations (malformed frames, AEAD/AAD failures) remain
// session-fatal. R3/F5: a throwing host callback inside the receiver is
// contained and resurfaced as a non-fatal event.
//
// The adversarial frames are forged with the initiator's real derived send key
// (exposed via the __getSendKeyForTest seam) and session id (decoded from a
// frame the initiator actually sent), so they authenticate and decrypt
// correctly and reach the receiver's transfer-state checks.

const SAMPLE_BASE_URL = "https://app.example";

interface OrchKit {
  readonly orchestrator: ConversationOrchestrator;
  readonly repository: ConversationRepository;
  readonly identity: IdentityKeyPair;
  readonly socket: MockSignalingSocket;
  readonly received: ReceivedFile[];
  readonly summaries: TransferSummary[];
  readonly cancelled: number[];
  /** onTransferError events: { id, error }. */
  readonly transferErrors: Array<{ readonly id: number; readonly error: unknown }>;
  /** onError events (the session-fatal / generic hook). */
  readonly errors: unknown[];
  readonly messages: ConversationMessage[];
}

function makeHandlers(
  kit: Pick<
    OrchKit,
    "received" | "summaries" | "cancelled" | "transferErrors" | "errors" | "messages"
  >,
  overrides?: Partial<OrchestratorHandlers>,
): OrchestratorHandlers {
  return {
    onFileReceived: (file: ReceivedFile): void => {
      kit.received.push(file);
    },
    onTransferStart: (s: TransferSummary): void => {
      kit.summaries.push(s);
    },
    onTransferProgress: (s: TransferSummary): void => {
      kit.summaries.push(s);
    },
    onTransferComplete: (s: TransferSummary): void => {
      kit.summaries.push(s);
    },
    onTransferCancelled: (id: number): void => {
      kit.cancelled.push(id);
    },
    onTransferError: (id: number, error: unknown): void => {
      kit.transferErrors.push({ id, error });
    },
    onError: (error: unknown): void => {
      kit.errors.push(error);
    },
    onMessage: (message: ConversationMessage): void => {
      kit.messages.push(message);
    },
    ...overrides,
  };
}

async function makeOrchestrator(overrides?: Partial<OrchestratorHandlers>): Promise<OrchKit> {
  const repository = new InMemoryConversationRepository(generateAtRestKey());
  const identity = await generateIdentityKeyPair();
  const socket = new MockSignalingSocket();
  const received: ReceivedFile[] = [];
  const summaries: TransferSummary[] = [];
  const cancelled: number[] = [];
  const transferErrors: Array<{ readonly id: number; readonly error: unknown }> = [];
  const errors: unknown[] = [];
  const messages: ConversationMessage[] = [];
  const deps: OrchestratorDeps = {
    brokerUrl: "wss://broker.example",
    baseUrl: SAMPLE_BASE_URL,
    repository,
    socketFactory: mockSocketFactory(socket),
    identity,
    handlers: makeHandlers(
      { received, summaries, cancelled, transferErrors, errors, messages },
      overrides,
    ),
  };
  return {
    orchestrator: new ConversationOrchestrator(deps),
    repository,
    identity,
    socket,
    received,
    summaries,
    cancelled,
    transferErrors,
    errors,
    messages,
  };
}

interface LinkedOrchPair {
  readonly initiator: OrchKit;
  readonly responder: OrchKit;
  /** Transport the initiator attached (its send() delivers to the responder). */
  readonly initiatorTransport: LoopbackPeerTransport;
  /** Transport the responder attached (its send() delivers to the initiator). */
  readonly responderTransport: LoopbackPeerTransport;
}

async function tick(ms = 50): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
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

async function makeLinkedPair(
  wrapInitiator?: (transport: PeerTransport) => PeerTransport,
  responderHandlers?: Partial<OrchestratorHandlers>,
): Promise<LinkedOrchPair> {
  const initiator = await makeOrchestrator();
  const responder = await makeOrchestrator(responderHandlers);
  const invitation = await initiator.orchestrator.start();
  await responder.orchestrator.join(invitation);
  const { a, b } = linkLoopbackPair();
  initiator.orchestrator.attachTransport(wrapInitiator !== undefined ? wrapInitiator(a) : a);
  responder.orchestrator.attachTransport(b);
  await waitForConnected(initiator.orchestrator);
  await waitForConnected(responder.orchestrator);
  return { initiator, responder, initiatorTransport: a, responderTransport: b };
}

interface ForgeryContext {
  readonly sendKey: AESKey;
  readonly sessionId: SessionId;
  nextSequence: number;
}

/**
 * Send a real text frame from the initiator and return the context needed to
 * forge further authenticated frames as the initiator: its derived send key,
 * its session id (decoded from the wire frame), and the next unused sequence
 * number (the responder's replay window rejects re-observed sequences).
 */
async function initiatorForgeryContext(
  initiator: OrchKit,
  transport: LoopbackPeerTransport,
): Promise<ForgeryContext> {
  await initiator.orchestrator.sendText("seq probe");
  const last = transport.sent[transport.sent.length - 1]!;
  const aad = decodeWireFrame(last).aad;
  const sendKey = initiator.orchestrator.__getSendKeyForTest();
  if (sendKey === null) {
    throw new Error("no derived send key — handshake did not complete");
  }
  // The test seam widens the derived key to Uint8Array; it IS the AESKey the
  // FrameSender encrypts with, so the brand cast is faithful.
  return {
    sendKey: sendKey as AESKey,
    sessionId: aad.senderSessionId,
    nextSequence: aad.senderSequence + 1,
  };
}

async function forgeFrame(
  ctx: ForgeryContext,
  frameType: FrameType,
  transferId: number,
  chunkId: number,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const aad: FrameAad = {
    protocolVersion: PROTOCOL_VERSION,
    senderSessionId: ctx.sessionId,
    senderSequence: ctx.nextSequence,
    frameType,
    transferId,
    chunkId,
  };
  ctx.nextSequence += 1;
  const enc = await encryptFrame(ctx.sendKey, aad, plaintext);
  return encodeWireFrame(
    { ...aad, ciphertextLength: enc.ciphertext.length },
    enc.nonce,
    enc.ciphertext,
  );
}

function fakeManifest(transferId: number, size: number): FileManifest {
  // No chunks are ever delivered, so the content hash is never verified.
  return {
    transferId,
    name: `forge-${transferId}.bin`,
    mimeType: "application/octet-stream",
    size,
    chunkCount: computeChunkCount(size),
    contentHash: new Uint8Array(32),
  };
}

/**
 * Wrap a transport so the first send trips the sender's backpressure gate:
 * the manifest crosses, then the chunk loop parks in waitForDrain — leaving a
 * genuinely in-flight inbound transfer on the responder's receiver.
 */
function backpressuredTransport(inner: PeerTransport): PeerTransport {
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
      // Intentionally never invokes: the transfer stays parked.
    },
    close: (): void => {
      inner.close();
    },
  };
}

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

describe("R3/F1: per-transfer ingest errors do not tear the session down", () => {
  it("a late chunk for a dropped inbound transfer produces a per-transfer error event, not teardown", async () => {
    const { initiator, responder, initiatorTransport, responderTransport } = await makeLinkedPair(
      (t) => backpressuredTransport(t),
    );
    const data = new Uint8Array(64 * 1024);
    for (let i = 0; i < data.length; i++) data[i] = (i * 31 + 7) & 0xff;
    const sendPromise = initiator.orchestrator.sendFile(
      data,
      "big.bin",
      "application/octet-stream",
    );
    const transferId = await waitForStart(initiator);
    await tick(100); // let the manifest land so the responder's receiver admits it

    // Drop the inbound transfer on the responder — the observable, deterministic
    // equivalent of the inactivity sweep's eviction (both run dropTransfer and
    // remove the map entry; the sweep's own eviction is covered by
    // receiver-inactivity-timeout.test.ts). The cancel event proves the drop.
    responder.orchestrator.cancelTransfer(transferId, "receive");
    expect(responder.cancelled).toContain(transferId);
    expect(responder.orchestrator.state).toBe(ConnectionState.Connected);

    // Forge the late chunk: authenticated under the initiator's real send key,
    // with the real session id and a fresh sequence, for the dropped id.
    const ctx = await initiatorForgeryContext(initiator, initiatorTransport);
    const forged = await forgeFrame(ctx, FrameType.FileChunk, transferId, 0, new Uint8Array(16));
    responderTransport.deliver(forged);
    await tick(50);

    // R3/F1: UnknownTransfer is scoped to transferId — a per-transfer error
    // event, NOT failHandshake. Pre-fix this rejection reached the
    // attachTransport catch and tore the session down.
    expect(
      responder.transferErrors.some(
        (e) =>
          e.id === transferId &&
          e.error instanceof FramingError &&
          e.error.code === FramingErrorCode.UnknownTransfer,
      ),
    ).toBe(true);
    expect(responder.orchestrator.state).toBe(ConnectionState.Connected);
    expect(responder.errors).toHaveLength(0);

    // The session still works in both directions.
    await responder.orchestrator.sendText("still alive");
    await tick(50);
    expect(initiator.messages.some((m) => m.text === "still alive")).toBe(true);

    // Cleanup: responder tears down first so the initiator's Leave control
    // frame (which would reuse a forged-consumed sequence number and correctly
    // read as a replay) lands on a dead channel; then the parked send is
    // released by teardown.
    responder.orchestrator.leave();
    initiator.orchestrator.leave();
    await expect(sendPromise).rejects.toBeDefined();
  });

  it("a manifest exceeding the aggregate declared-bytes budget is a per-transfer error, not teardown", async () => {
    const { initiator, responder, initiatorTransport, responderTransport } = await makeLinkedPair();
    const ctx = await initiatorForgeryContext(initiator, initiatorTransport);

    // Admit a manifest reserving nearly the whole 64 MiB budget...
    const big = fakeManifest(0x0f0f_0001, MAX_INCOMPLETE_TRANSFER_BYTES - 100);
    responderTransport.deliver(
      await forgeFrame(ctx, FrameType.FileManifest, big.transferId, 0, encodeManifest(big)),
    );
    await tick(50);
    expect(responder.orchestrator.state).toBe(ConnectionState.Connected);
    expect(responder.transferErrors).toHaveLength(0);

    // ...then a second manifest that over-commits the budget is rejected at
    // admission — R3/F4 reservation — and demoted to a per-transfer error.
    const overflow = fakeManifest(0x0f0f_0002, 200);
    responderTransport.deliver(
      await forgeFrame(
        ctx,
        FrameType.FileManifest,
        overflow.transferId,
        0,
        encodeManifest(overflow),
      ),
    );
    await tick(50);
    expect(
      responder.transferErrors.some(
        (e) =>
          e.id === overflow.transferId &&
          e.error instanceof FramingError &&
          e.error.code === FramingErrorCode.SizeExceeded,
      ),
    ).toBe(true);
    expect(responder.orchestrator.state).toBe(ConnectionState.Connected);
    expect(responder.errors).toHaveLength(0);

    // A well-formed forged manifest that fits the remaining budget is still
    // admitted — the receiver is undamaged by the rejected one.
    const fits = fakeManifest(0x0f0f_0003, 50);
    responderTransport.deliver(
      await forgeFrame(ctx, FrameType.FileManifest, fits.transferId, 0, encodeManifest(fits)),
    );
    await tick(50);
    expect(responder.transferErrors.filter((e) => e.id === fits.transferId)).toHaveLength(0);
    expect(responder.orchestrator.state).toBe(ConnectionState.Connected);

    // Liveness proof in the intact direction: forging consumed
    // initiator→responder sequence numbers (a subsequent honest send reusing
    // one would correctly fail as a replay), so a real file goes
    // responder→initiator instead — the session is fully functional.
    const payload = new TextEncoder().encode("post-error file");
    await responder.orchestrator.sendFile(payload, "after.txt", "text/plain");
    const deadline = Date.now() + 2000;
    while (
      !initiator.received.some((f) => f.manifest.name === "after.txt") &&
      Date.now() < deadline
    ) {
      await tick(10);
    }
    expect(initiator.received.some((f) => f.manifest.name === "after.txt")).toBe(true);

    responder.orchestrator.leave();
    initiator.orchestrator.leave();
  });

  it("ConcurrentTransfersExceeded at admission is a per-transfer error, not teardown", async () => {
    const { initiator, responder, initiatorTransport, responderTransport } = await makeLinkedPair();
    const ctx = await initiatorForgeryContext(initiator, initiatorTransport);

    // Fill all MAX_CONCURRENT_TRANSFERS receiver slots with tiny manifests
    // that never complete (their single chunks never arrive).
    for (let i = 0; i < MAX_CONCURRENT_TRANSFERS; i++) {
      const manifest = fakeManifest(0x1a2b_0000 + i, 1);
      responderTransport.deliver(
        await forgeFrame(
          ctx,
          FrameType.FileManifest,
          manifest.transferId,
          0,
          encodeManifest(manifest),
        ),
      );
    }
    await tick(50);
    expect(responder.transferErrors).toHaveLength(0);

    // The fifth manifest exceeds the concurrent cap — non-fatal.
    const extra = fakeManifest(0x1a2b_00ff, 1);
    responderTransport.deliver(
      await forgeFrame(ctx, FrameType.FileManifest, extra.transferId, 0, encodeManifest(extra)),
    );
    await tick(50);
    expect(
      responder.transferErrors.some(
        (e) =>
          e.id === extra.transferId &&
          e.error instanceof FramingError &&
          e.error.code === FramingErrorCode.ConcurrentTransfersExceeded,
      ),
    ).toBe(true);
    expect(responder.orchestrator.state).toBe(ConnectionState.Connected);
    expect(responder.errors).toHaveLength(0);

    // Freeing a slot admits a new manifest again — the receiver is undamaged.
    responder.orchestrator.cancelTransfer(0x1a2b_0000, "receive");
    const admitted = fakeManifest(0x1a2b_0100, 1);
    responderTransport.deliver(
      await forgeFrame(
        ctx,
        FrameType.FileManifest,
        admitted.transferId,
        0,
        encodeManifest(admitted),
      ),
    );
    await tick(50);
    expect(responder.transferErrors.filter((e) => e.id === admitted.transferId)).toHaveLength(0);

    // Responder first: the initiator's Leave frame would otherwise reuse a
    // forged-consumed sequence number and correctly read as a replay.
    responder.orchestrator.leave();
    initiator.orchestrator.leave();
  });

  it("R3/F5: a throwing onFileReceived leaves the session Connected", async () => {
    const { initiator, responder } = await makeLinkedPair(undefined, {
      onFileReceived: () => {
        throw new Error("ui handler boom");
      },
    });
    const payload = new TextEncoder().encode("delivered bytes");
    const transferId = await initiator.orchestrator.sendFile(payload, "doc.txt", "text/plain");
    await tick(100);

    // The file was verified + reassembled, so the received-direction transfer
    // events fired; the host throw is contained and resurfaced via
    // onTransferError — never via failHandshake.
    expect(
      responder.summaries.some(
        (s) => s.direction === "received" && s.transferId === transferId && s.name === "doc.txt",
      ),
    ).toBe(true);
    expect(
      responder.transferErrors.some(
        (e) =>
          e.id === transferId && e.error instanceof Error && e.error.message === "ui handler boom",
      ),
    ).toBe(true);
    expect(responder.orchestrator.state).toBe(ConnectionState.Connected);
    expect(responder.errors).toHaveLength(0);

    // Bidirectional liveness check.
    await responder.orchestrator.sendText("still here");
    await tick(50);
    expect(initiator.messages.some((m) => m.text === "still here")).toBe(true);

    initiator.orchestrator.leave();
    responder.orchestrator.leave();
  });

  it("a wire-level violation (tampered ciphertext) remains session-fatal", async () => {
    const { initiator, responder, initiatorTransport, responderTransport } = await makeLinkedPair();
    const ctx = await initiatorForgeryContext(initiator, initiatorTransport);
    const forged = await forgeFrame(ctx, FrameType.FileChunk, 0x7777, 0, new Uint8Array(16));
    // Flip a ciphertext bit: AEAD authentication fails → FramingError
    // (Malformed) → session-fatal via failHandshake.
    forged[forged.length - 1] ^= 0xff;
    responderTransport.deliver(forged);
    await tick(50);
    expect(responder.orchestrator.state).toBe(ConnectionState.Disconnected);
    expect(responder.errors.length).toBeGreaterThan(0);
    expect(responder.transferErrors).toHaveLength(0);

    initiator.orchestrator.leave();
  });
});
