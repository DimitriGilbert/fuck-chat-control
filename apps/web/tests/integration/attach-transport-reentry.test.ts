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

  it("LW-22: after a stale-closure re-entry, the NEW generation's handshake is the one that completes", async () => {
    // LW-22 (Phase 7b): the previous version of this test relied on a brittle
    // regex over error messages to detect stale-closure corruption, and its
    // replacement used positive assertions that were too weak — the orphaned
    // first transport was never link()ed to a peer, so no bytes ever arrived on
    // it and the generation guard's rejection path was never exercised. A
    // regression that removed the guard entirely would still pass.
    //
    // The real guard lives in beginHandshake (orchestrator.ts ~line 773): it
    // captures `this.handshakeGeneration` SYNCHRONOUSLY when beginHandshake's
    // body starts running, then — after the `await generateEphemeralKeyPair()`
    // — aborts if the generation advanced. attachTransport schedules
    // beginHandshake via `void this.beginHandshake()`; an async function runs
    // its body up to the first await synchronously inside that call. So the
    // generation capture for gen-1 happens inline during the FIRST
    // attachTransport, BEFORE control returns to the caller. If the caller then
    // re-attaches (gen-2) in the SAME synchronous tick — the realistic "bridge
    // observes a data-channel flip and re-attaches immediately" path — gen-2's
    // attachTransport bumps the generation to 2 while gen-1's beginHandshake is
    // still suspended at the crypto await. When gen-1 resumes, the guard
    // `generation(1) !== this.handshakeGeneration(2)` fires and aborts it
    // WITHOUT sending. The new generation owns the slot.
    //
    // The decisive regression check: if the line-773 guard were removed, gen-1
    // would NOT abort — after its await it would call
    // `this.transport.send(encodeHello(localHello))`, and `this.transport` is
    // now transport2 (reassigned by gen-2's attachTransport). So transport2
    // would receive TWO Hello sends (one from each generation) instead of one.
    // Asserting `transport2.sent.length === 1` pins the guard: it fails the
    // moment the guard is removed.
    const errors: unknown[] = [];
    const kit = await makeOrchestrator({ onError: (e) => errors.push(e) });
    await kit.orchestrator.start();

    // First generation: attach a transport that will be orphaned. We do NOT
    // link it to a peer — its beginHandshake awaits a peer Hello that never
    // arrives. `void this.beginHandshake()` runs gen-1's body synchronously up
    // to `await generateEphemeralKeyPair()`, capturing generation = 1 before
    // control returns here.
    const orphanedTransport = new LoopbackPeerTransport();
    kit.orchestrator.attachTransport(orphanedTransport);
    expect(kit.orchestrator.state).toBe(ConnectionState.Handshaking);

    // Synchronous re-entry in the SAME tick — the path that puts gen-1's
    // beginHandshake in the guard's window. notifyPeerLeft tears the session
    // down (state -> Disconnected), retry() re-opens signaling (state ->
    // Signaling), and the second attachTransport bumps the generation to 2 and
    // reassigns this.transport to transport2. Gen-1 is still awaiting the
    // crypto op; when it resumes the guard must abort it.
    kit.orchestrator.notifyPeerLeft();
    expect(kit.orchestrator.state).toBe(ConnectionState.Disconnected);

    // retry() requires the auth-failed gate to be closed; this orchestrator
    // never failed auth, so retry() should succeed and move to Signaling.
    kit.orchestrator.retry();
    expect(kit.orchestrator.state).toBe(ConnectionState.Signaling);

    // Second attachTransport: a NEW generation begins. NO `await` between this
    // and the first attachTransport — that is what places gen-1 inside the
    // guard's rejection window.
    const transport2 = new LoopbackPeerTransport();
    kit.orchestrator.attachTransport(transport2);
    expect(kit.orchestrator.state).toBe(ConnectionState.Handshaking);

    // Allow the suspended beginHandshake closures (both generations) to resume.
    // Gen-1's await resolves first; the guard must abort it. Gen-2's await
    // resolves and sends its Hello on transport2.
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    // DECISIVE assertion — pins the generation guard at orchestrator.ts:773.
    // Exactly ONE Hello (gen-2's) was sent on the active transport. If the
    // guard were removed, gen-1's post-await send would land here too (it
    // resolves against this.transport, which is now transport2), making this
    // count 2. This is the load-bearing check that fails-under-regression.
    expect(transport2.sent.length).toBe(1);
    expect(transport2.sent[0]?.length).toBe(163); // HelloMessage wire size

    // The orphaned first transport must NOT have been driven by gen-1's
    // closure either: gen-1 captured generation = 1 before the re-attach, so
    // when the guard was reached it had already aborted before any send. (With
    // the guard removed, gen-1 would send on transport2 — the NEW transport —
    // not here; this assertion guards against gen-1 sending on the orphaned
    // transport before the re-attach as well, locking down both branches of the
    // stale-closure invariant.)
    expect(orphanedTransport.sent.length).toBe(0);

    // The stale-closure guard's contract: no spurious errors from the older
    // handshake's resolution, AND the orchestrator stayed in Handshaking
    // (owned by the new generation) rather than being driven to an illegal
    // state by the orphaned closure.
    expect(kit.orchestrator.state).toBe(ConnectionState.Handshaking);
    expect(errors).toHaveLength(0);
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
