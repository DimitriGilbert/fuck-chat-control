import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, beforeAll } from "vitest";

import {
  __setWasmModuleForTests,
  generateAtRestKey,
  generateIdentityKeyPair,
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
  LoopbackPeerTransport,
  mockSocketFactory,
  MockSignalingSocket,
} from "./_helpers";

const PKG_JS = fileURLToPath(
  new URL("../../../src/wasm/spake2/pkg/fck_spake2.js", import.meta.url),
);
const PKG_WASM = fileURLToPath(
  new URL("../../../src/wasm/spake2/pkg/fck_spake2_bg.wasm", import.meta.url),
);

// Synchronous init: the browser path uses fetch+WebAssembly.instantiateStreaming
// via the pkg's default export, which Node cannot do. initSync seeds the same
// wasm singleton the wrapper ultimately calls through. Mirrors the integration
// PAKE test's setup so the loopback handshake can run the real SPAKE2 exchange.
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
const SIGNATURE_MESSAGE_BYTES = 65;

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
 * Wrap a PeerTransport so the FIRST signature message (65 bytes) that passes
 * through has a byte of its signature field corrupted. The receiver then
 * verifies a signature that does not match the canonical transcript — a
 * guaranteed HandshakeSignatureMismatch. Each instance only tampers once, so
 * to drive TWO consecutive failures on the SAME orchestrator we re-wrap on
 * every retry (the orchestrator's transport field is replaced by the fresh
 * wrapper on attachTransport).
 */
function tamperFirstSignatureByte(inner: PeerTransport): PeerTransport {
  let tampered = false;
  return {
    send: (bytes: Uint8Array): void => {
      if (!tampered && bytes.length === SIGNATURE_MESSAGE_BYTES) {
        const copy = new Uint8Array(bytes.length);
        copy.set(bytes);
        copy[1] = copy[1]! ^ 0x01;
        tampered = true;
        inner.send(copy);
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

function isOrchError(e: unknown, code: OrchestratorErrorCode): boolean {
  return e instanceof OrchestratorError && e.code === code;
}

describe("ConversationOrchestrator handshakeError reset (CR-1)", () => {
  it("a second failure on a fresh retry path surfaces instead of silently no-op'ing", async () => {
    // Pre-CR-1 bug: failHandshake guards with `if (this.handshakeError !== null)
    // return;`, and nothing ever reset the field. So a second failure after
    // retry() (which only re-enters Signaling; attachTransport does the fresh
    // handshake) was silently dropped. CR-1 resets handshakeError on every
    // attachTransport so the second failure surfaces via onError and the state
    // transitions to Disconnected.
    const initiator = await makeOrchestrator();
    const responder = await makeOrchestrator();
    // SafetyNumberOnly is enough to surface HandshakeSignatureMismatch — no
    // PAKE machinery needed for this regression.
    const invitation = await initiator.orchestrator.start();
    await responder.orchestrator.join(invitation);

    // First attempt: tamper the initiator's first signature so verification
    // fails on the responder (HandshakeSignatureMismatch) AND wrap the
    // responder so the initiator ALSO sees a mismatch — both sides fail.
    const { a: a1Raw, b: b1Raw } = linkLoopbackPair();
    initiator.orchestrator.attachTransport(tamperFirstSignatureByte(a1Raw));
    responder.orchestrator.attachTransport(tamperFirstSignatureByte(b1Raw));

    await tick(500);

    // FIRST failure surfaced on both sides and both landed in Disconnected.
    expect(initiator.orchestrator.state).toBe(ConnectionState.Disconnected);
    expect(responder.orchestrator.state).toBe(ConnectionState.Disconnected);
    const initFirstErrors = initiator.spies.onError.calls.map((c) => c[0]);
    const respFirstErrors = responder.spies.onError.calls.map((c) => c[0]);
    expect(initFirstErrors.length).toBeGreaterThan(0);
    expect(respFirstErrors.length).toBeGreaterThan(0);

    // Move ONLY the initiator through retry for an isolated assertion of the
    // second failure on a single orchestrator. The responder stays
    // Disconnected; we cross-wire a fresh loopback pair to a SECOND responder
    // so the initiator actually exchanges Hello + tampered signature.
    initiator.orchestrator.retry();
    expect(initiator.orchestrator.state).toBe(ConnectionState.Signaling);

    const secondResponder = await makeOrchestrator();
    // Re-derive the conversation id from the initiator's invitation; join
    // shares the same room. We then attach a fresh tampered transport pair.
    await secondResponder.orchestrator.join(invitation);

    const { a: a2Raw, b: b2Raw } = linkLoopbackPair();
    initiator.orchestrator.attachTransport(tamperFirstSignatureByte(a2Raw));
    secondResponder.orchestrator.attachTransport(tamperFirstSignatureByte(b2Raw));

    await tick(500);

    // CR-1 contract: the SECOND failure surfaces. Pre-CR-1 this was silently
    // swallowed because handshakeError was set-once.
    expect(initiator.orchestrator.state).toBe(ConnectionState.Disconnected);
    const initAllErrors = initiator.spies.onError.calls.map((c) => c[0]);
    // At least two error emissions on the initiator: one from the first
    // attempt, one from the second.
    expect(initAllErrors.length).toBeGreaterThanOrEqual(2);
    // The most recent error is the second-attempt failure.
    const secondError = initAllErrors[initAllErrors.length - 1]!;
    expect(
      isOrchError(secondError, OrchestratorErrorCode.HandshakeSignatureMismatch) ||
        isOrchError(secondError, OrchestratorErrorCode.HandshakeFailed),
    ).toBe(true);
  });

  it("handshakeError is reset on attachTransport even without a prior failure", async () => {
    // Belt-and-braces: the reset line is unconditional, so a first-ever
    // attachTransport on a fresh orchestrator (handshakeError starts null)
    // must still be a no-op rather than throw. Drives the line directly.
    const kit = await makeOrchestrator();
    await kit.orchestrator.start();
    expect(kit.orchestrator.state).toBe(ConnectionState.Waiting);

    const transport = new LoopbackPeerTransport();
    expect(() => kit.orchestrator.attachTransport(transport)).not.toThrow();
    expect(kit.orchestrator.state).toBe(ConnectionState.Handshaking);
    // No error should fire from the unconditional reset itself.
    expect(kit.spies.onError.calls.length).toBe(0);
  });
});
