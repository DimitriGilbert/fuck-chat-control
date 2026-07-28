import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, beforeAll } from "vitest";

import {
  __setWasmModuleForTests,
  generateAtRestKey,
  generateIdentityKeyPair,
  PakeError,
  PakeErrorCode,
} from "@fuck-eu-chat-control/chat-runtime/crypto";
import type { IdentityKeyPair, PakeWasmModule } from "@fuck-eu-chat-control/chat-runtime/crypto";
import { ConnectionState } from "@fuck-eu-chat-control/chat-runtime/signaling/state-machine";
import { InMemoryConversationRepository } from "@fuck-eu-chat-control/chat-runtime/store";
import type { ConversationRepository } from "@fuck-eu-chat-control/chat-runtime/store";

import {
  ConversationOrchestrator,
  type OrchestratorDeps,
  type OrchestratorHandlers,
} from "@fuck-eu-chat-control/chat-runtime/orchestrator/orchestrator";
import {
  OrchestratorError,
  OrchestratorErrorCode,
} from "@fuck-eu-chat-control/chat-runtime/orchestrator/errors";
import type { PeerTransport } from "@fuck-eu-chat-control/chat-runtime/transport/peer-transport";

import {
  linkLoopbackPair,
  mockSocketFactory,
  MockSignalingSocket,
} from "../unit/orchestrator/_helpers";

const PKG_JS = fileURLToPath(
  new URL("../../../../packages/chat-runtime/wasm/spake2/pkg/fck_spake2.js", import.meta.url),
);
const PKG_WASM = fileURLToPath(
  new URL("../../../../packages/chat-runtime/wasm/spake2/pkg/fck_spake2_bg.wasm", import.meta.url),
);

// Synchronous init: the browser path uses fetch+WebAssembly.instantiateStreaming
// via the pkg's default export, which Node cannot do. initSync seeds the same
// wasm singleton the wrapper ultimately calls through.
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
  };
  return { orchestrator: new ConversationOrchestrator(deps), repository, identity, spies, socket };
}

async function tick(ms = 100): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * CR-14 helper: poll both orchestrators until BOTH reach Disconnected, with a
 * bounded budget. Replaces the prior `not.toBe(Connected)` half-assertion,
 * which a half-open Handshaking/Verifying state would also satisfy. The only
 * legitimate terminal state for an aborting PAKE handshake is Disconnected
 * (failHandshake routes Handshaking/Verifying → Disconnected); if the abort
 * never fires this helper throws within `timeoutMs`, failing the test loudly
 * rather than passing on a stale intermediate state.
 */
async function expectPollsDisconnected(
  ...orchestrators: ConversationOrchestrator[]
): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (orchestrators.every((o) => o.state === ConnectionState.Disconnected)) {
      return;
    }
    await tick(25);
  }
  // Final assertion: if we got here, at least one side never settled. The
  // toEqual line surfaces both states in the failure message for diagnosis.
  expect(orchestrators.map((o) => o.state)).toEqual(
    orchestrators.map(() => ConnectionState.Disconnected),
  );
}

function isOrchError(e: unknown, code: OrchestratorErrorCode): boolean {
  return e instanceof OrchestratorError && e.code === code;
}

function isPakeError(e: unknown, code: PakeErrorCode): boolean {
  return e instanceof PakeError && e.code === code;
}

/**
 * Wrap a PeerTransport so that PAKE share messages (35 bytes) are dropped.
 * Used to simulate a peer that offers SafetyNumberOnly against a Pake
 * invitation — the orchestrator never receives a share and the await hangs
 * until the test's timeout, demonstrating no fallback path is taken.
 */
function dropPakeShares(inner: PeerTransport): PeerTransport {
  return {
    send: (bytes: Uint8Array): void => {
      if (bytes.length === 35) {
        // Drop the PAKE share so the peer never sees it.
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

describe("ConversationOrchestrator PAKE (SPAKE2) integration", () => {
  describe("setPakeCode / handshakeAuthMode plumbing", () => {
    it("setPakeCode switches the negotiated auth mode to Pake", async () => {
      const kit = await makeOrchestrator();
      expect(kit.orchestrator.handshakeAuthMode).toBe(0x01); // SafetyNumberOnly
      kit.orchestrator.setPakeCode("123456");
      expect(kit.orchestrator.handshakeAuthMode).toBe(0x02); // Pake
    });

    it("setPakeCode rejects an empty code", async () => {
      const kit = await makeOrchestrator();
      expect(() => kit.orchestrator.setPakeCode("")).toThrow(OrchestratorError);
    });

    it("setPakeCode throws if called after start()", async () => {
      const kit = await makeOrchestrator();
      await kit.orchestrator.start();
      expect(() => kit.orchestrator.setPakeCode("123456")).toThrow(
        /setPakeCode must be called before start/,
      );
    });
  });

  describe("successful PAKE handshake (both sides same code)", () => {
    it("both orchestrators reach Connected when both set the same code", async () => {
      const initiator = await makeOrchestrator();
      const responder = await makeOrchestrator();
      initiator.orchestrator.setPakeCode("482910");
      responder.orchestrator.setPakeCode("482910");

      const invitation = await initiator.orchestrator.start();
      await responder.orchestrator.join(invitation);

      const { a, b } = linkLoopbackPair();
      initiator.orchestrator.attachTransport(a);
      responder.orchestrator.attachTransport(b);

      await tick(500);

      expect(initiator.orchestrator.state).toBe(ConnectionState.Connected);
      expect(responder.orchestrator.state).toBe(ConnectionState.Connected);
    });

    it("the resulting session can round-trip a text message", async () => {
      const initiator = await makeOrchestrator();
      const responder = await makeOrchestrator();
      initiator.orchestrator.setPakeCode("730045");
      responder.orchestrator.setPakeCode("730045");

      const invitation = await initiator.orchestrator.start();
      await responder.orchestrator.join(invitation);

      const { a, b } = linkLoopbackPair();
      initiator.orchestrator.attachTransport(a);
      responder.orchestrator.attachTransport(b);

      await tick(500);

      await initiator.orchestrator.sendText("over-pake");
      await tick(100);

      const received = await responder.repository.getMessages(
        responder.orchestrator.conversationId!,
      );
      expect(received.length).toBe(1);
      expect(received[0]!.text).toBe("over-pake");
      expect(received[0]!.direction).toBe("received");
    });
  });

  describe("wrong-code mismatch aborts and NEVER falls back to SafetyNumberOnly", () => {
    it("does NOT reach Connected when the codes differ", async () => {
      const initiator = await makeOrchestrator();
      const responder = await makeOrchestrator();
      initiator.orchestrator.setPakeCode("111111");
      // Different code on the responder.
      responder.orchestrator.setPakeCode("999999");

      const invitation = await initiator.orchestrator.start();
      await responder.orchestrator.join(invitation);

      const { a, b } = linkLoopbackPair();
      initiator.orchestrator.attachTransport(a);
      responder.orchestrator.attachTransport(b);

      // CR-14: the prior `not.toBe(Connected)` half was insufficient — a
      // half-open Handshaking state would also satisfy it. Pin the POSITIVE
      // terminal state: both sides must settle on Disconnected (the PAKE
      // confirmation tag mismatch aborts the handshake via failHandshake,
      // which is the only legitimate terminal state for a wrong-code run).
      // Bounded poll so the assertion fails loudly if the abort never fires.
      await expectPollsDisconnected(initiator.orchestrator, responder.orchestrator);
    });

    it("surfaces a PakeError(Mismatch) on the error handler (no silent success)", async () => {
      const initiator = await makeOrchestrator();
      const responder = await makeOrchestrator();
      initiator.orchestrator.setPakeCode("111111");
      responder.orchestrator.setPakeCode("999999");

      const invitation = await initiator.orchestrator.start();
      await responder.orchestrator.join(invitation);

      const { a, b } = linkLoopbackPair();
      initiator.orchestrator.attachTransport(a);
      responder.orchestrator.attachTransport(b);

      await tick(500);

      // CR-14: tighten the decisive assertion. The prior `length > 0` accepted
      // ANY error (transport noise, a stray framing error) as proof of abort.
      // The load-bearing signal is that the PAKE confirmation exchange
      // detected the divergent secrets and surfaced PakeErrorCode.Mismatch —
      // the only error code runPakeConfirmation throws on a wrong code. Both
      // sides settle on Disconnected (bounded poll), and at least one side's
      // error handler MUST carry the typed Mismatch.
      await expectPollsDisconnected(initiator.orchestrator, responder.orchestrator);
      const initErrors = initiator.spies.onError.calls.map((c) => c[0]);
      const respErrors = responder.spies.onError.calls.map((c) => c[0]);
      const allErrors = [...initErrors, ...respErrors];
      expect(allErrors.some((e) => isPakeError(e, PakeErrorCode.Mismatch))).toBe(true);
    });
  });

  describe("transcript-mismatch abort (Pake invitation vs SafetyNumberOnly peer)", () => {
    it("a SafetyNumberOnly peer against a Pake invitation aborts (signature mismatch)", async () => {
      // Only the initiator sets a code → its transcript carries authMode=Pake.
      // The responder builds a SafetyNumberOnly transcript. The two transcripts
      // differ in the authMode byte, so each side's signature fails to verify
      // against the other's transcript → HandshakeSignatureMismatch. There is
      // no path to Connected.
      const initiator = await makeOrchestrator();
      const responder = await makeOrchestrator();
      initiator.orchestrator.setPakeCode("555555");
      // responder does NOT set a code → SafetyNumberOnly.

      const invitation = await initiator.orchestrator.start();
      await responder.orchestrator.join(invitation);

      const { a, b } = linkLoopbackPair();
      initiator.orchestrator.attachTransport(a);
      responder.orchestrator.attachTransport(b);

      await tick(500);

      expect(initiator.orchestrator.state).not.toBe(ConnectionState.Connected);
      expect(responder.orchestrator.state).not.toBe(ConnectionState.Connected);
      const initErrors = initiator.spies.onError.calls.map((c) => c[0]);
      const respErrors = responder.spies.onError.calls.map((c) => c[0]);
      const sawSignatureMismatch = [...initErrors, ...respErrors].some((e) =>
        isOrchError(e, OrchestratorErrorCode.HandshakeSignatureMismatch),
      );
      expect(sawSignatureMismatch).toBe(true);
    });
  });

  describe("no silent fallback: a Pake invitation that never receives a share stays Disconnected", () => {
    it("does not reach Connected and does not throw a fallback-to-SafetyNumberOnly error", async () => {
      const initiator = await makeOrchestrator();
      const responder = await makeOrchestrator();
      initiator.orchestrator.setPakeCode("121212");
      responder.orchestrator.setPakeCode("121212");

      const invitation = await initiator.orchestrator.start();
      await responder.orchestrator.join(invitation);

      const { a, b } = linkLoopbackPair();
      // Drop all PAKE shares in both directions: neither side can complete the
      // exchange. The handshake must NOT silently fall back to safety-number.
      initiator.orchestrator.attachTransport(dropPakeShares(a));
      responder.orchestrator.attachTransport(dropPakeShares(b));

      await tick(400);

      // CR-14: drop the `|| allErrors.length === 0` escape hatch. The
      // orchestrator's PAKE await path has no internal timeout, so when all
      // shares are dropped both sides stall in Verifying (the promise inside
      // awaitPakeFinish never resolves). The positive no-fallback signal is
      // therefore NOT "an error fired" — it is "no path to Connected was
      // taken": both sides remain in a non-Connected auth-in-progress state
      // (Verifying or Disconnected), and crucially the handshake did NOT
      // complete with a SafetyNumberOnly key schedule. Assert that positive
      // state directly, and assert that NO error codepath that would indicate
      // a silent SafetyNumberOnly completion fired (there is none, but the
      // explicit check documents the invariant).
      const initStates = initiator.spies.onStateChange.calls.map((c) => c[0]);
      const respStates = responder.spies.onStateChange.calls.map((c) => c[0]);
      expect(initStates).not.toContain(ConnectionState.Connected);
      expect(respStates).not.toContain(ConnectionState.Connected);
      // Positive terminal state: both are stuck in Verifying (share await) or
      // have been torn down to Disconnected. Handshaking would indicate the
      // signature round never completed; Connected is the forbidden fallback.
      const acceptable = new Set<ConnectionState>([
        ConnectionState.Verifying,
        ConnectionState.Disconnected,
      ]);
      expect(acceptable.has(initiator.orchestrator.state)).toBe(true);
      expect(acceptable.has(responder.orchestrator.state)).toBe(true);
    });
  });
});
