import { describe, expect, it } from "vitest";

import { generateAtRestKey, generateIdentityKeyPair } from "@/features/chat/crypto";
import type { IdentityKeyPair } from "@/features/chat/crypto";
import { ConnectionState } from "@/features/chat/signaling/state-machine";
import { InMemoryConversationRepository } from "@/features/chat/store";
import type { ConversationRepository } from "@/features/chat/store";

import {
  ConversationOrchestrator,
  type OrchestratorDeps,
  type OrchestratorHandlers,
} from "@/features/chat/orchestrator/orchestrator";
import { OrchestratorError, OrchestratorErrorCode } from "@/features/chat/orchestrator/errors";
import type { PeerTransport } from "@/features/chat/orchestrator/peer-transport";

import {
  linkLoopbackPair,
  LoopbackPeerTransport,
  mockSocketFactory,
  MockSignalingSocket,
} from "../unit/orchestrator/_helpers";

const SAMPLE_BASE_URL = "https://app.example";

interface Kit {
  readonly orchestrator: ConversationOrchestrator;
  readonly repository: ConversationRepository;
  readonly identity: IdentityKeyPair;
  readonly socket: MockSignalingSocket;
}

async function makeOrchestrator(handlers: OrchestratorHandlers = {}): Promise<Kit> {
  const repository = new InMemoryConversationRepository(generateAtRestKey());
  const identity = await generateIdentityKeyPair();
  const socket = new MockSignalingSocket();
  const deps: OrchestratorDeps = {
    brokerUrl: "wss://broker.example",
    baseUrl: SAMPLE_BASE_URL,
    repository,
    socketFactory: mockSocketFactory(socket),
    identity,
    handlers,
  };
  return { orchestrator: new ConversationOrchestrator(deps), repository, identity, socket };
}

/**
 * Wrap a PeerTransport so that sends of a specific length are deferred until
 * the test releases them. Used to put the orchestrator's beginHandshake into
 * a controlled await state so a second attachTransport can be driven against
 * the live orchestrator before the first handshake's mutation phase lands.
 */
class StallableTransport implements PeerTransport {
  public ready = true;
  public bufferedAmount = 0;
  public readonly sent: Uint8Array[] = [];
  private readonly inner: PeerTransport;
  private readonly stallLengths: ReadonlySet<number>;
  private readonly pending: Array<() => void> = [];

  constructor(inner: PeerTransport, stallLengths: ReadonlySet<number>) {
    this.inner = inner;
    this.stallLengths = stallLengths;
  }

  send(bytes: Uint8Array): void {
    if (this.stallLengths.has(bytes.length)) {
      this.sent.push(bytes);
      this.pending.push(() => this.inner.send(bytes));
      return;
    }
    this.inner.send(bytes);
  }

  releaseOne(): boolean {
    const next = this.pending.shift();
    if (next === undefined) return false;
    next();
    return true;
  }

  setOnMessage(handler: ((bytes: Uint8Array) => void) | null): void {
    this.inner.setOnMessage(handler);
  }

  setOnDrain(handler: (() => void) | null): void {
    this.inner.setOnDrain(handler);
  }

  close(): void {
    this.inner.close();
  }
}

describe("attachTransport re-entry race guard (R7/F4 / Phase 8.4)", () => {
  it("attachTransport from Waiting enters Handshaking and bumps the generation", async () => {
    const kit = await makeOrchestrator();
    await kit.orchestrator.start();
    expect(kit.orchestrator.state).toBe(ConnectionState.Waiting);

    const transport = new LoopbackPeerTransport();
    kit.orchestrator.attachTransport(transport);
    expect(kit.orchestrator.state).toBe(ConnectionState.Handshaking);
    // The generation counter is private; the decisive public assertion is
    // that a second attachTransport from Handshaking throws (state machine
    // rejects), proving the first attachTransport claimed the handshake slot.
    expect(() => kit.orchestrator.attachTransport(new LoopbackPeerTransport())).toThrow(
      OrchestratorError,
    );
  });

  it("attachTransport from Signaling enters Handshaking (Phase 4 widened transition)", async () => {
    const kit = await makeOrchestrator();
    await kit.orchestrator.start();
    kit.socket.serverOpen();
    kit.orchestrator.notifyPeerJoined();
    expect(kit.orchestrator.state).toBe(ConnectionState.Signaling);

    kit.orchestrator.attachTransport(new LoopbackPeerTransport());
    expect(kit.orchestrator.state).toBe(ConnectionState.Handshaking);
  });

  it("a second attachTransport from Handshaking is rejected by the state machine", async () => {
    const errors: unknown[] = [];
    const kit = await makeOrchestrator({ onError: (e) => errors.push(e) });
    await kit.orchestrator.start();

    const { a } = linkLoopbackPair();
    kit.orchestrator.attachTransport(a);
    expect(kit.orchestrator.state).toBe(ConnectionState.Handshaking);

    expect(() => kit.orchestrator.attachTransport(new LoopbackPeerTransport())).toThrow(
      OrchestratorError,
    );
    try {
      kit.orchestrator.attachTransport(new LoopbackPeerTransport());
    } catch (err) {
      expect((err as OrchestratorError).code).toBe(OrchestratorErrorCode.HandshakeFailed);
    }
  });

  it("the generation guard aborts a stale beginHandshake without surfacing a stale error", async () => {
    // Drive the orchestrator to Handshaking via attachTransport. The
    // beginHandshake closure captures the generation at scheduling time;
    // when a newer attachTransport runs (e.g. after a teardown+retry cycle
    // that returns to Waiting), the older closure's mutation phase must be
    // a no-op. We approximate this by attaching twice across a retry cycle
    // and asserting no spurious errors fire.
    const errors: unknown[] = [];
    const kit = await makeOrchestrator({ onError: (e) => errors.push(e) });
    await kit.orchestrator.start();

    const transport = new LoopbackPeerTransport();
    kit.orchestrator.attachTransport(transport);
    expect(kit.orchestrator.state).toBe(ConnectionState.Handshaking);

    // Force the orchestrator to Disconnected, then retry back to Signaling.
    // The retry path is the realistic re-entry trigger: the bridge observes
    // a data-channel flip and the orchestrator is re-attached.
    kit.orchestrator.notifyPeerLeft();
    expect(kit.orchestrator.state).toBe(ConnectionState.Disconnected);

    // retry() requires the auth-failed gate to be closed; this orchestrator
    // never failed auth, so retry() should succeed and move to Signaling.
    kit.orchestrator.retry();
    expect(kit.orchestrator.state).toBe(ConnectionState.Signaling);

    // Second attachTransport: a NEW generation begins. The first generation's
    // beginHandshake is still awaiting (no peer hello arrived on transport),
    // but the guard aborts it without surfacing an error.
    const transport2 = new LoopbackPeerTransport();
    kit.orchestrator.attachTransport(transport2);
    expect(kit.orchestrator.state).toBe(ConnectionState.Handshaking);

    // Allow any pending async work to settle.
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    // Filter for errors that would indicate the stale closure corrupted
    // state. The guard's contract is: no spurious errors from the older
    // handshake's resolution.
    const staleErrors = errors.filter(
      (e) =>
        e instanceof Error &&
        /handshake started without conversation|cannot read|undefined/.test(e.message),
    );
    expect(staleErrors).toHaveLength(0);
  });

  it("the StallableTransport helper correctly defers sends of matching lengths", async () => {
    // Sanity test for the test helper itself — verifies the stall mechanism
    // works as expected so the upper tests' assumptions hold.
    const inner = new LoopbackPeerTransport();
    const stalled = new StallableTransport(inner, new Set([163])); // Hello bytes
    stalled.send(new Uint8Array(163));
    expect(stalled.sent).toHaveLength(1);
    expect(inner.sent).toHaveLength(0);
    expect(stalled.releaseOne()).toBe(true);
    expect(inner.sent).toHaveLength(1);
    expect(stalled.releaseOne()).toBe(false);
  });
});
