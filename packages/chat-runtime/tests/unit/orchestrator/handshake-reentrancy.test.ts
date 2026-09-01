import { describe, expect, it, vi } from "vitest";

import {
  generateAtRestKey,
  generateIdentityKeyPair,
} from "@fuck-eu-chat-control/chat-runtime/crypto";
import type { ConversationId, PublicKey } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import { ConnectionState } from "@fuck-eu-chat-control/chat-runtime/signaling/state-machine";
import { InMemoryConversationRepository } from "@fuck-eu-chat-control/chat-runtime/store";
import type {
  AppendMessageOptions,
  ConversationMessage,
  ConversationRecord,
  ConversationRepository,
  MessageDirection,
  PeerIdentityRecord,
} from "@fuck-eu-chat-control/chat-runtime/store";

import {
  ConversationOrchestrator,
  type OrchestratorDeps,
  type OrchestratorHandlers,
} from "@fuck-eu-chat-control/chat-runtime/orchestrator/orchestrator";
import type { PeerTransport } from "@fuck-eu-chat-control/chat-runtime/transport/peer-transport";

import { linkLoopbackPair, mockSocketFactory, MockSignalingSocket } from "./_helpers";

const SAMPLE_BASE_URL = "https://app.example";
const SIGNATURE_MESSAGE_BYTES = 65;
/**
 * FrameReceiver's default inactivity sweep tick (receiver.ts
 * DEFAULT_TRANSFER_INACTIVITY_TICK_MS). The constant is module-private, so it
 * is mirrored here to identify setInterval calls that construct a receiver.
 * The orchestrator constructs FrameReceiver without tick overrides, so every
 * receiver built by a handshake registers exactly one 30s interval.
 */
const RECEIVER_SWEEP_TICK_MS = 30_000;

function makeSpy<T extends (...args: never[]) => void>(): {
  fn: T;
  calls: Parameters<T>[];
} {
  const calls: Parameters<T>[] = [];
  const fn = ((...args: Parameters<T>) => {
    calls.push(args);
  }) as T;
  return { fn, calls };
}

interface StateSpies {
  readonly onStateChange: ReturnType<typeof makeSpy<(s: ConnectionState) => void>>;
  readonly onSafetyNumber: ReturnType<typeof makeSpy<(sn: string, verified: boolean) => void>>;
  readonly onError: ReturnType<typeof makeSpy<(e: unknown) => void>>;
}

function makeSpies(): StateSpies {
  const onStateChange = makeSpy<(s: ConnectionState) => void>();
  const onSafetyNumber = makeSpy<(sn: string, verified: boolean) => void>();
  const onError = makeSpy<(e: unknown) => void>();
  return { onStateChange, onSafetyNumber, onError };
}

function spiesToHandlers(spies: StateSpies): OrchestratorHandlers {
  return {
    onStateChange: spies.onStateChange.fn,
    onSafetyNumber: spies.onSafetyNumber.fn,
    onError: spies.onError.fn,
  };
}

/**
 * Delegating repository that counts {@link storePeerIdentity} invocations —
 * the observable for "TOFU identity written exactly once" in the duplicate
 * SignatureMessage regression below.
 */
class CountingRepository implements ConversationRepository {
  public storePeerIdentityCalls = 0;
  private readonly inner: ConversationRepository;

  constructor(inner: ConversationRepository) {
    this.inner = inner;
  }

  createConversation(id: ConversationId, createdAt: number): Promise<ConversationRecord> {
    return this.inner.createConversation(id, createdAt);
  }

  getConversation(id: ConversationId): Promise<ConversationRecord | null> {
    return this.inner.getConversation(id);
  }

  listConversations(): Promise<ConversationRecord[]> {
    return this.inner.listConversations();
  }

  appendMessage(
    id: ConversationId,
    plaintext: string,
    direction: MessageDirection,
    timestamp: number,
    options?: AppendMessageOptions,
  ): Promise<ConversationMessage> {
    return this.inner.appendMessage(id, plaintext, direction, timestamp, options);
  }

  getMessages(id: ConversationId): Promise<ConversationMessage[]> {
    return this.inner.getMessages(id);
  }

  async storePeerIdentity(
    id: ConversationId,
    fingerprint: string,
    publicKey: PublicKey,
  ): Promise<void> {
    this.storePeerIdentityCalls += 1;
    await this.inner.storePeerIdentity(id, fingerprint, publicKey);
  }

  replacePeerIdentity(
    id: ConversationId,
    fingerprint: string,
    publicKey: PublicKey,
  ): Promise<void> {
    return this.inner.replacePeerIdentity(id, fingerprint, publicKey);
  }

  getPeerIdentity(id: ConversationId): Promise<PeerIdentityRecord | null> {
    return this.inner.getPeerIdentity(id);
  }

  setDisplayName(id: ConversationId, name: string): Promise<void> {
    return this.inner.setDisplayName(id, name);
  }

  getDisplayName(id: ConversationId): Promise<string | null> {
    return this.inner.getDisplayName(id);
  }

  markAuthFailed(id: ConversationId): Promise<void> {
    return this.inner.markAuthFailed(id);
  }

  getAuthFailed(id: ConversationId): Promise<boolean> {
    return this.inner.getAuthFailed(id);
  }

  clearConversation(id: ConversationId): Promise<void> {
    return this.inner.clearConversation(id);
  }

  clearAll(): Promise<void> {
    return this.inner.clearAll();
  }
}

interface OrchestratorKit {
  readonly orchestrator: ConversationOrchestrator;
  readonly repository: CountingRepository;
  readonly spies: StateSpies;
  readonly socket: MockSignalingSocket;
}

async function makeOrchestrator(): Promise<OrchestratorKit> {
  const repository = new CountingRepository(
    new InMemoryConversationRepository(generateAtRestKey()),
  );
  const identity = await generateIdentityKeyPair();
  const spies = makeSpies();
  const socket = new MockSignalingSocket();
  const deps: OrchestratorDeps = {
    brokerUrl: "wss://broker.example",
    baseUrl: SAMPLE_BASE_URL,
    repository,
    socketFactory: mockSocketFactory(socket),
    identity,
    handlers: spiesToHandlers(spies),
  };
  return {
    orchestrator: new ConversationOrchestrator(deps),
    repository,
    spies,
    socket,
  };
}

async function waitForConnected(orch: ConversationOrchestrator, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (orch.state !== ConnectionState.Connected) {
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for Connected; state = ${orch.state}; safetyNumber = ${orch.safetyNumber}`,
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve));
  }
}

/**
 * Wrap a PeerTransport so every outbound SignatureMessage (65 bytes) is
 * delivered TWICE, synchronously back-to-back. attachTransport dispatches
 * each inbound message via `void this.handleInbound(bytes).catch(...)` with
 * no serialization, so the two copies spawn two verifyPeerAndComplete
 * coroutines in the same tick — exactly the re-entrancy window of R2/F1.
 * LoopbackPeerTransport.send copies the bytes, so re-sending the same view
 * is safe. Hello (163 bytes) and everything else pass through once.
 */
function duplicateSignatureSends(inner: PeerTransport): PeerTransport {
  return {
    send: (bytes: Uint8Array): void => {
      inner.send(bytes);
      if (bytes.length === SIGNATURE_MESSAGE_BYTES) {
        inner.send(bytes);
      }
    },
    get ready(): boolean {
      return inner.ready;
    },
    get bufferedAmount(): number {
      return inner.bufferedAmount;
    },
    setOnMessage: (handler: ((bytes: Uint8Array) => void) | null): void => {
      inner.setOnMessage(handler);
    },
    setOnDrain: (handler: (() => void) | null): void => {
      inner.setOnDrain(handler);
    },
    close: (): void => {
      inner.close();
    },
  };
}

describe("verifyPeerAndComplete re-entrancy (R2/F1)", () => {
  it("a duplicated SignatureMessage produces exactly one completion, one FrameReceiver, and one storePeerIdentity/onSafetyNumber", async () => {
    // R2/F1 regression: the handshakeCompleting latch used to be armed only
    // AFTER the verifyTranscript/getPeerIdentity awaits, so both coroutines
    // spawned by a duplicated SignatureMessage ran to completion — the second
    // FrameReceiver's construction orphaned the first receiver's setInterval
    // sweep (teardownSession only tears down the last-assigned receiver),
    // onSafetyNumber/storePeerIdentity fired twice, and in PAKE mode the
    // duplicate SPAKE2 share aborted the honest peer. With the latch armed at
    // the FIRST synchronous statement, the second coroutine returns before
    // touching anything.
    //
    // setInterval is spied (call-through) to count FrameReceiver
    // constructions: the receiver constructor is the only setInterval user on
    // the loopback-handshake path (the orchestrator's PAKE bounds use
    // setTimeout; the broker sweep and webrtc bridge are not in play).
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    try {
      const initiator = await makeOrchestrator();
      const responder = await makeOrchestrator();
      const invitation = await initiator.orchestrator.start();
      await responder.orchestrator.join(invitation);

      const { a, b } = linkLoopbackPair();
      // Duplicate the INITIATOR's signature in transit: the responder receives
      // two copies and is the side whose re-entrancy guard is under test.
      initiator.orchestrator.attachTransport(duplicateSignatureSends(a));
      responder.orchestrator.attachTransport(b);

      await waitForConnected(initiator.orchestrator);
      await waitForConnected(responder.orchestrator);

      // Exactly one handshake completion on the duplicate-receiving side:
      // onSafetyNumber fires only at the end of verifyPeerAndComplete.
      expect(responder.spies.onSafetyNumber.calls).toHaveLength(1);
      expect(initiator.spies.onSafetyNumber.calls).toHaveLength(1);
      const connectedTransitions = responder.spies.onStateChange.calls.filter(
        (call) => call[0] === ConnectionState.Connected,
      );
      expect(connectedTransitions).toHaveLength(1);

      // TOFU identity stored exactly once (pre-fix: twice).
      expect(responder.repository.storePeerIdentityCalls).toBe(1);

      // Exactly one FrameReceiver per side (pre-fix: three sweep timers — the
      // responder's first receiver was orphaned with a live interval).
      const sweepTimers = setIntervalSpy.mock.calls.filter(
        (call) => call[1] === RECEIVER_SWEEP_TICK_MS,
      );
      expect(sweepTimers).toHaveLength(2);

      // Both sides agree on the safety number and neither saw an error.
      expect(responder.orchestrator.safetyNumber).toBe(initiator.orchestrator.safetyNumber);
      expect(initiator.spies.onError.calls).toHaveLength(0);
      expect(responder.spies.onError.calls).toHaveLength(0);

      initiator.orchestrator.leave();
      responder.orchestrator.leave();
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it("the duplicated-signature session still round-trips text (the surviving framing pair is wired correctly)", async () => {
    // Belt-and-braces: the single surviving FrameSender/FrameReceiver pair
    // must be wired to the transport with matching keys — a regression that
    // silenced the duplicate but also broke the completion path would fail
    // the send/receive round-trip.
    const initiator = await makeOrchestrator();
    const responder = await makeOrchestrator();
    const invitation = await initiator.orchestrator.start();
    await responder.orchestrator.join(invitation);

    const { a, b } = linkLoopbackPair();
    initiator.orchestrator.attachTransport(duplicateSignatureSends(a));
    responder.orchestrator.attachTransport(b);

    await waitForConnected(initiator.orchestrator);
    await waitForConnected(responder.orchestrator);

    await initiator.orchestrator.sendText("after duplicate signature");
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    const received = await responder.repository.getMessages(responder.orchestrator.conversationId!);
    expect(received.filter((m) => m.direction === "received").map((m) => m.text)).toEqual([
      "after duplicate signature",
    ]);
    expect(initiator.spies.onError.calls).toHaveLength(0);
    expect(responder.spies.onError.calls).toHaveLength(0);

    initiator.orchestrator.leave();
    responder.orchestrator.leave();
  });
});
