import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, beforeAll } from "vitest";

import {
  __setWasmModuleForTests,
  generateAtRestKey,
  generateIdentityKeyPair,
  PakeError,
  PakeErrorCode,
} from "@/features/chat/crypto";
import type { IdentityKeyPair, PakeWasmModule } from "@/features/chat/crypto";
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
  mockSocketFactory,
  MockSignalingSocket,
} from "../unit/orchestrator/_helpers";

const PKG_JS = fileURLToPath(
  new URL("../../src/wasm/spake2/pkg/fck_spake2.js", import.meta.url),
);
const PKG_WASM = fileURLToPath(
  new URL("../../src/wasm/spake2/pkg/fck_spake2_bg.wasm", import.meta.url),
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

      await tick(500);

      // Neither side reaches Connected — the PAKE-derived traffic keys differ,
      // so the first encrypted frame each side sends fails to decrypt on the
      // other side (or the shares themselves yield different secrets that
      // surface as a framing error). Critically: there is no fallback.
      expect(initiator.orchestrator.state).not.toBe(ConnectionState.Connected);
      expect(responder.orchestrator.state).not.toBe(ConnectionState.Connected);
    });

    it("surfaces a PakeError or handshake failure on the error handler (no silent success)", async () => {
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

      // At least one side must have surfaced an error. The exact code depends
      // on which side's framed send surfaces the mismatch first, but it is
      // never silent — Connected is not reached without a matching secret.
      const initErrors = initiator.spies.onError.calls.map((c) => c[0]);
      const respErrors = responder.spies.onError.calls.map((c) => c[0]);
      const allErrors = [...initErrors, ...respErrors];
      expect(allErrors.length).toBeGreaterThan(0);
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

      expect(initiator.orchestrator.state).not.toBe(ConnectionState.Connected);
      expect(responder.orchestrator.state).not.toBe(ConnectionState.Connected);
      // No SafetyNumberOnly completion: the PAKE await path is the only route
      // to Connected under a Pake invitation, and it cannot complete. The
      // orchestrator stays in Handshaking/Disconnected.
      const allErrors = [
        ...initiator.spies.onError.calls.map((c) => c[0]),
        ...responder.spies.onError.calls.map((c) => c[0]),
      ];
      // No PakeError mismatches should fire (no shares exchanged at all); the
      // session simply never completes. This is the no-fallback guarantee.
      const sawPakeAbort = allErrors.some((e) => isPakeError(e, PakeErrorCode.Abort));
      // An abort is acceptable (e.g. transport teardown); a silent Connected is not.
      expect(sawPakeAbort || allErrors.length === 0).toBe(true);
    });
  });
});
