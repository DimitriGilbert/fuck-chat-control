import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import {
  __setWasmModuleForTests,
  generateAtRestKey,
  generateIdentityKeyPair,
  PakeError,
  PakeErrorCode,
} from "@fuck-eu-chat-control/chat-runtime/crypto";
import type { IdentityKeyPair, PakeWasmModule } from "@fuck-eu-chat-control/chat-runtime/crypto";
import {
  HANDSHAKE_TIMEOUT_MS,
  PAKE_MESSAGE_BYTES,
} from "@fuck-eu-chat-control/chat-runtime/protocol/limits";
import { ConnectionState } from "@fuck-eu-chat-control/chat-runtime/signaling/state-machine";
import {
  getAuthFailedDurable,
  InMemoryConversationRepository,
} from "@fuck-eu-chat-control/chat-runtime/store";
import type { ConversationRepository } from "@fuck-eu-chat-control/chat-runtime/store";

import {
  ConversationOrchestrator,
  type OrchestratorDeps,
  type OrchestratorHandlers,
} from "@fuck-eu-chat-control/chat-runtime/orchestrator/orchestrator";

import { linkLoopbackPair, mockSocketFactory, MockSignalingSocket } from "./_helpers";

const PKG_JS = fileURLToPath(
  new URL("../../../../../packages/chat-runtime/wasm/spake2/pkg/fck_spake2.js", import.meta.url),
);
const PKG_WASM = fileURLToPath(
  new URL(
    "../../../../../packages/chat-runtime/wasm/spake2/pkg/fck_spake2_bg.wasm",
    import.meta.url,
  ),
);

// Synchronous init: the browser path uses fetch+WebAssembly.instantiateStreaming
// via the pkg's default export, which Node cannot do. initSync seeds the same
// wasm singleton the wrapper ultimately calls through. Mirrors the setup in
// handshake-error-reset.test.ts so the loopback handshake runs the real SPAKE2
// exchange.
beforeAll(async () => {
  const wasmBytes = new Uint8Array(readFileSync(PKG_WASM));
  const wasmModule = await WebAssembly.compile(wasmBytes);
  const binding = (await import(PKG_JS)) as unknown as {
    initSync(module: { module: WebAssembly.Module }): void;
    pake_start: PakeWasmModule["pake_start"];
    pake_finish: PakeWasmModule["pake_finish"];
  };
  binding.initSync({ module: wasmModule });
  __setWasmModuleForTests(binding);
});

const SAMPLE_BASE_URL = "https://app.example";

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
  readonly onError: ReturnType<typeof makeSpy<(e: unknown) => void>>;
}

function makeSpies(): StateSpies {
  const onStateChange = makeSpy<(s: ConnectionState) => void>();
  const onError = makeSpy<(e: unknown) => void>();
  return { onStateChange, onError };
}

function spiesToHandlers(spies: StateSpies): OrchestratorHandlers {
  return {
    onStateChange: spies.onStateChange.fn,
    onError: spies.onError.fn,
  };
}

interface OrchestratorKit {
  readonly orchestrator: ConversationOrchestrator;
  readonly repository: ConversationRepository;
  readonly identity: IdentityKeyPair;
  readonly spies: StateSpies;
  readonly socket: MockSignalingSocket;
}

/**
 * Test-only PAKE timeout, injected via the `handshakeTimeoutMsOverride` seam.
 * Small enough that the test does not wait the real 30 seconds, large enough
 * that the real async WASM handshake crypto (ECDH + SPAKE2 + signature verify)
 * comfortably reaches the Verifying await before the timer fires.
 */
const TEST_HANDSHAKE_TIMEOUT_MS = 500;

async function makeOrchestrator(): Promise<OrchestratorKit> {
  const repository = new InMemoryConversationRepository(generateAtRestKey());
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
    handshakeTimeoutMsOverride: TEST_HANDSHAKE_TIMEOUT_MS,
  };
  return { orchestrator: new ConversationOrchestrator(deps), repository, identity, spies, socket };
}

async function tick(ms = 50): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait until the orchestrator leaves the given set of states or the deadline
 * elapses. Used to detect the Verifying park (state settles before the timeout
 * fires) without busy-spinning.
 */
async function waitForStateBeyond(
  orch: ConversationOrchestrator,
  beyond: ConnectionState[],
  timeoutMs = 3000,
): Promise<ConnectionState> {
  const deadline = Date.now() + timeoutMs;
  while (beyond.includes(orch.state)) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting to leave ${beyond.join("/")}; state=${orch.state}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve));
  }
  return orch.state;
}

/**
 * Wrap a PeerTransport so every outbound PAKE-share frame
 * (PAKE_MESSAGE_BYTES = 35 bytes) is silently dropped, while Hello/Signature/
 * Confirm frames pass through. Used to strand the peer (initiator) in
 * `awaitPakeFinish`: the signature exchange completes and both sides enter
 * Verifying, but the wrapped side never delivers its SPAKE2 share, so the
 * initiator's bounded await hits the handshake timeout instead of parking
 * forever.
 */
function dropPakeShareTransport(inner: {
  send(bytes: Uint8Array): void;
  readonly ready: boolean;
  readonly bufferedAmount: number;
  setOnMessage(h: ((bytes: Uint8Array) => void) | null): void;
  setOnDrain(h: (() => void) | null): void;
  close(): void;
}): typeof inner {
  return {
    send: (bytes: Uint8Array): void => {
      if (bytes.length === PAKE_MESSAGE_BYTES) {
        // Silent drop — mirrors a peer that goes quiet after the signature.
        return;
      }
      inner.send(bytes);
    },
    get ready(): boolean {
      return inner.ready;
    },
    get bufferedAmount(): number {
      return inner.bufferedAmount;
    },
    setOnMessage: (h): void => {
      inner.setOnMessage(h);
    },
    setOnDrain: (h): void => {
      inner.setOnDrain(h);
    },
    close: (): void => {
      inner.close();
    },
  };
}

describe("ConversationOrchestrator PAKE handshake timeout (HIGH-A)", () => {
  it("(a) awaitPakeFinish rejects with PakeError(Timeout) after the handshake timeout when no peer share arrives", async () => {
    // Build a real PAKE-coded initiator/responder pair wired via loopback
    // transports, but wrap the responder's transport so its PAKE share never
    // reaches the initiator. Both sides still exchange Hello + Signature, so
    // both reach Verifying and park in awaitPakeFinish. The initiator's await
    // is bounded; after TEST_HANDSHAKE_TIMEOUT_MS it must reject with
    // PakeError(Timeout) and the orchestrator must end up Disconnected.
    const initiator = await makeOrchestrator();
    const responder = await makeOrchestrator();
    initiator.orchestrator.setPakeCode("123456");
    responder.orchestrator.setPakeCode("123456");

    const invitation = await initiator.orchestrator.start();
    await responder.orchestrator.join(invitation);

    const { a, b } = linkLoopbackPair();
    initiator.orchestrator.attachTransport(a);
    // Wrap the responder side so the initiator never receives a PAKE share.
    responder.orchestrator.attachTransport(dropPakeShareTransport(b));

    // Let the async Hello/Signature exchange run. The handshake parks in
    // awaitPakeFinish once both signatures verify (Verifying). Confirm the
    // park BEFORE the (short) test timeout fires.
    await tick(50);
    expect(initiator.orchestrator.state).toBe(ConnectionState.Verifying);

    // Wait for the bounded await to reject with PakeError(Timeout) and drive
    // failHandshake -> Disconnected. Allow margin beyond the test timeout.
    const finalState = await waitForStateBeyond(
      initiator.orchestrator,
      [ConnectionState.Verifying],
      TEST_HANDSHAKE_TIMEOUT_MS + 2000,
    );
    expect(finalState).toBe(ConnectionState.Disconnected);

    const errors = initiator.spies.onError.calls.map((c) => c[0]);
    expect(errors.length).toBeGreaterThan(0);
    const last = errors[errors.length - 1]!;
    expect(last).toBeInstanceOf(PakeError);
    expect((last as PakeError).code).toBe(PakeErrorCode.Timeout);

    // No dangling timer: waiting well past the timeout must not surface a
    // second error (the timer was cleared on the timeout path).
    const errorCountBefore = initiator.spies.onError.calls.length;
    await tick(TEST_HANDSHAKE_TIMEOUT_MS + 100);
    expect(initiator.spies.onError.calls.length).toBe(errorCountBefore);

    // Best-effort cleanup of the responder (its await is also parked; its
    // shorter timer fired too and surfaced Disconnected).
    initiator.orchestrator.leave();
    responder.orchestrator.leave();
  });

  it("(b) teardownSession rejects a parked PAKE resolver instead of leaving it dangling", async () => {
    // Strand the initiator in awaitPakeFinish as above, then tear it down
    // explicitly (via leave()) BEFORE the timeout fires. The parked resolver
    // must be rejected with PakeError(Cancelled) so the coroutine settles
    // promptly; no dangling timer may remain to fire later.
    const initiator = await makeOrchestrator();
    const responder = await makeOrchestrator();
    initiator.orchestrator.setPakeCode("654321");
    responder.orchestrator.setPakeCode("654321");

    const invitation = await initiator.orchestrator.start();
    await responder.orchestrator.join(invitation);

    const { a, b } = linkLoopbackPair();
    initiator.orchestrator.attachTransport(a);
    responder.orchestrator.attachTransport(dropPakeShareTransport(b));

    await tick(50);
    expect(initiator.orchestrator.state).toBe(ConnectionState.Verifying);

    // Tear down BEFORE the timeout. leave() -> teardownSession() must reject
    // the parked resolver with PakeError(Cancelled) and clear the timer.
    initiator.orchestrator.leave();
    expect(initiator.orchestrator.state).toBe(ConnectionState.Disconnected);

    // Let the teardown-driven rejection propagate through the parked
    // verifyPeerAndComplete await -> failHandshake. The Cancelled error is
    // expected to surface here via onError (the rejection has to go somewhere);
    // capture the baseline AFTER it settles so the leak assertion below measures
    // only LATE activity, not this legitimate one-shot emission.
    await tick(50);
    const cancelledErrors = initiator.spies.onError.calls
      .map((c) => c[0])
      .filter((e): e is PakeError => e instanceof PakeError)
      .filter((e) => e.code === PakeErrorCode.Cancelled);
    expect(cancelledErrors.length).toBe(1);

    // H1 regression: a teardown-driven PakeError(Cancelled) must NOT be
    // classified as a durable auth failure. Before the fix, isAuthFailureError
    // returned true for ANY PakeError, so failHandshake set authFailedCached +
    // persisted markAuthFailed/markAuthFailedDurable — bricking the conversation
    // so a subsequent retry() threw AuthFailedRetryBlocked across reloads.
    // Assert the durable flag was never written (repo + durable store) and that
    // retry() does NOT throw AuthFailedRetryBlocked. retry() needs a settled
    // Disconnected state and the conversation id; both hold after leave().
    const convoId = initiator.orchestrator.conversationId;
    expect(convoId).not.toBeNull();
    const cid = convoId as NonNullable<typeof convoId>;
    // Allow the fire-and-forget markAuthFailed write (if it had fired) to land
    // before reading the flags back.
    await tick(20);
    expect(await initiator.repository.getAuthFailed(cid)).toBe(false);
    expect(await getAuthFailedDurable(cid)).toBe(false);
    expect(() => {
      initiator.orchestrator.retry();
    }).not.toThrow();
    // retry() transitions to Signaling; cancel that to avoid a dangling
    // reconnect attempt polluting later assertions in this test process.
    initiator.orchestrator.leave();

    // The contract under test: the coroutine SETTLED (no leak) and no timer
    // fires afterward. Wait well past the timeout; a leaked/dangling timer
    // would fire here and surface a Timeout error or an extra state transition.
    const errorCountBefore = initiator.spies.onError.calls.length;
    const stateChangesBefore = initiator.spies.onStateChange.calls.length;
    await tick(TEST_HANDSHAKE_TIMEOUT_MS + 200);
    expect(initiator.spies.onError.calls.length).toBe(errorCountBefore);
    expect(initiator.spies.onStateChange.calls.length).toBe(stateChangesBefore);

    responder.orchestrator.leave();
  });

  it("(c) a normal PAKE handshake completes within the timeout (no false positive)", async () => {
    // Regression guard: the bounded await must NOT fire when a real peer
    // delivers its share promptly. Two unmodified orchestrators cross-wired
    // via loopback must reach Connected well inside the test timeout — proving
    // the timer is cleared on the normal-delivery path (success path).
    const initiator = await makeOrchestrator();
    const responder = await makeOrchestrator();
    initiator.orchestrator.setPakeCode("999999");
    responder.orchestrator.setPakeCode("999999");

    const invitation = await initiator.orchestrator.start();
    await responder.orchestrator.join(invitation);

    const { a, b } = linkLoopbackPair();
    initiator.orchestrator.attachTransport(a);
    responder.orchestrator.attachTransport(b);

    // Wait for Connected (or timeout-out rejection). Must be Connected. Await
    // BOTH sides before asserting on either: under event-loop contention the
    // responder's final transition can lag the initiator's by a tick, so a
    // synchronous read of the responder's state immediately after the
    // initiator settles can race the responder's settle.
    const initFinal = await waitForStateBeyond(
      initiator.orchestrator,
      [ConnectionState.Handshaking, ConnectionState.Verifying],
      3000,
    );
    const respFinal = await waitForStateBeyond(
      responder.orchestrator,
      [ConnectionState.Handshaking, ConnectionState.Verifying],
      3000,
    );
    expect(initFinal).toBe(ConnectionState.Connected);
    expect(respFinal).toBe(ConnectionState.Connected);

    // No errors emitted on a clean handshake.
    expect(initiator.spies.onError.calls.length).toBe(0);

    initiator.orchestrator.leave();
    responder.orchestrator.leave();
  });

  it("HANDSHAKE_TIMEOUT_MS is the documented 30s constant (default production bound)", () => {
    // Guards against an accidental change to the production default. The test
    // seam overrides it for unit tests, but production uses the constant.
    expect(HANDSHAKE_TIMEOUT_MS).toBe(30_000);
  });
});
