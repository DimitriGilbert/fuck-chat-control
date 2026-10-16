import { describe, expect, it } from "vitest";

import {
  generateAtRestKey,
  generateEphemeralKeyPair,
  generateIdentityKeyPair,
  PakeError,
  PakeErrorCode,
} from "@fuck-eu-chat-control/chat-runtime/crypto";
import type { IdentityKeyPair } from "@fuck-eu-chat-control/chat-runtime/crypto";
import { encodeSessionId } from "@fuck-eu-chat-control/chat-runtime/protocol/codec";
import { PROTOCOL_VERSION } from "@fuck-eu-chat-control/chat-runtime/protocol/limits";
import { ConnectionState } from "@fuck-eu-chat-control/chat-runtime/signaling/state-machine";
import { InMemoryConversationRepository } from "@fuck-eu-chat-control/chat-runtime/store";
import type { ConversationRepository } from "@fuck-eu-chat-control/chat-runtime/store";

import {
  OrchestratorError,
  OrchestratorErrorCode,
} from "@fuck-eu-chat-control/chat-runtime/orchestrator/errors";
import {
  encodeHello,
  type HelloComponents,
} from "@fuck-eu-chat-control/chat-runtime/orchestrator/handshake-codec";
import {
  ConversationOrchestrator,
  type OrchestratorDeps,
  type OrchestratorHandlers,
} from "@fuck-eu-chat-control/chat-runtime/orchestrator/orchestrator";
import type { PeerTransport } from "@fuck-eu-chat-control/chat-runtime/transport/peer-transport";

import {
  linkLoopbackPair,
  LoopbackPeerTransport,
  mockSocketFactory,
  MockSignalingSocket,
} from "./_helpers";

const SAMPLE_BASE_URL = "https://app.example";
const HELLO_BYTES = 163;
const SIGNATURE_MESSAGE_BYTES = 65;
/**
 * Test-only handshake bound injected via the `handshakeTimeoutMsOverride`
 * seam: small enough that the silent-peer scenario does not wait the real
 * 30 seconds, large enough that the real async crypto completes well inside it.
 */
const TEST_HANDSHAKE_TIMEOUT_MS = 500;

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

async function makeOrchestrator(handshakeTimeoutMs?: number): Promise<OrchestratorKit> {
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
    ...(handshakeTimeoutMs !== undefined ? { handshakeTimeoutMsOverride: handshakeTimeoutMs } : {}),
  };
  return { orchestrator: new ConversationOrchestrator(deps), repository, identity, spies, socket };
}

async function waitUntil(what: string, predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve));
  }
}

/**
 * Build a wire-valid HelloMessage for a freshly generated attacker keypair —
 * the bytes a malicious broker/MITM would inject. Each call produces a
 * DIFFERENT identity + ephemeral key + session id.
 */
async function makeAttackerHello(): Promise<Uint8Array> {
  const identity = await generateIdentityKeyPair();
  const ephemeral = await generateEphemeralKeyPair();
  const sessionId = encodeSessionId(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  const components: HelloComponents = {
    protocolVersion: PROTOCOL_VERSION,
    identityPublicKey: identity.publicKey,
    ephemeralPublicKey: ephemeral.publicKey,
    sessionId,
  };
  return encodeHello(components);
}

describe("ConversationOrchestrator duplicate-Hello guard (R6F1)", () => {
  it("a second Hello after the local signature was sent aborts the handshake (non-durable)", async () => {
    // MITM scenario: the victim's transcript froze when it sent its signature;
    // a second Hello carrying a substituted ephemeral key must NOT overwrite
    // remoteHello — it must fail the handshake instead.
    const kit = await makeOrchestrator();
    await kit.orchestrator.start();
    const transport = new LoopbackPeerTransport();
    kit.orchestrator.attachTransport(transport);

    // Our Hello goes out; deliver the (first) peer Hello to trigger the
    // signature round.
    await waitUntil("local Hello sent", () => transport.sent.some((b) => b.length === HELLO_BYTES));
    transport.deliver(await makeAttackerHello());

    // Wait for our signature — localSignatureSent is now latched and the
    // transcript is frozen.
    await waitUntil("local signature sent", () =>
      transport.sent.some((b) => b.length === SIGNATURE_MESSAGE_BYTES),
    );

    // Inject the second Hello — the ephemeral-key substitution attempt.
    transport.deliver(await makeAttackerHello());
    await waitUntil(
      "handshake failure",
      () => kit.orchestrator.state === ConnectionState.Disconnected,
    );

    // The duplicate-Hello guard failed the handshake with a NON-durable
    // OrchestratorError — not a durable auth failure, so retry() stays usable.
    const errors = kit.spies.onError.calls.map((c) => c[0]);
    expect(errors.length).toBe(1);
    const last = errors[errors.length - 1]!;
    expect(last).toBeInstanceOf(OrchestratorError);
    expect((last as OrchestratorError).code).toBe(OrchestratorErrorCode.MalformedHandshakeMessage);

    const convoId = kit.orchestrator.conversationId;
    expect(convoId).not.toBeNull();
    expect(await kit.repository.getAuthFailed(convoId!)).toBe(false);
    expect(() => kit.orchestrator.retry()).not.toThrow();
    expect(kit.orchestrator.state).toBe(ConnectionState.Signaling);
    kit.orchestrator.leave();
  });

  it("an ephemeral-key substitution via a second Hello cannot alter the session the peer derives", async () => {
    // Live two-orchestrator handshake: the responder accepts the initiator's
    // real Hello (freezing it into the transcript), then a MITM-injected
    // second Hello carrying a different ephemeral key arrives. The responder
    // must abort — it must never reach Connected and never derive key
    // material influenced by the substituted Hello.
    const initiator = await makeOrchestrator();
    const responder = await makeOrchestrator();
    const invitation = await initiator.orchestrator.start();
    await responder.orchestrator.join(invitation);

    const { a, b } = linkLoopbackPair();
    const attackerHello = await makeAttackerHello();
    // Wrap the initiator's transport: right after the real Hello is delivered
    // to the responder (whose remoteHello is set synchronously on delivery),
    // inject the attacker's second Hello on the same channel — the exact
    // post-transcript substitution window.
    let injected = false;
    const wrapped: PeerTransport = {
      send: (bytes: Uint8Array): void => {
        a.send(bytes);
        if (!injected && bytes.length === HELLO_BYTES) {
          injected = true;
          b.deliver(attackerHello);
        }
      },
      get ready(): boolean {
        return a.ready;
      },
      get bufferedAmount(): number {
        return a.bufferedAmount;
      },
      setOnMessage: (h): void => {
        a.setOnMessage(h);
      },
      setOnDrain: (h): void => {
        a.setOnDrain(h);
      },
      close: (): void => {
        a.close();
      },
    };
    initiator.orchestrator.attachTransport(wrapped);
    responder.orchestrator.attachTransport(b);

    await waitUntil(
      "responder handshake failure",
      () => responder.orchestrator.state === ConnectionState.Disconnected,
    );

    // The substitution was rejected before any key derivation: no Connected
    // transition and no derived send key on the victim side.
    const responderConnected = responder.spies.onStateChange.calls.filter(
      (call) => call[0] === ConnectionState.Connected,
    );
    expect(responderConnected).toHaveLength(0);
    expect(responder.orchestrator.__getSendKeyForTest()).toBeNull();

    const errors = responder.spies.onError.calls.map((c) => c[0]);
    expect(errors.length).toBe(1);
    const last = errors[errors.length - 1]!;
    expect(last).toBeInstanceOf(OrchestratorError);
    expect((last as OrchestratorError).code).toBe(OrchestratorErrorCode.MalformedHandshakeMessage);

    // The initiator is stranded in Handshaking (its peer tore down); it never
    // derived keys either. Clean both up.
    expect(initiator.orchestrator.state).toBe(ConnectionState.Handshaking);
    expect(initiator.orchestrator.__getSendKeyForTest()).toBeNull();
    initiator.orchestrator.leave();
    responder.orchestrator.leave();
  });
});

describe("ConversationOrchestrator whole-handshake timeout (R6F5)", () => {
  it("a peer that never sends a Hello is bounded by the handshake timeout (non-durable)", async () => {
    // Silent-peer remote DoS bound: before R6F5 only the PAKE share/confirm
    // awaits were bounded; a peer that never sent ANY handshake message parked
    // the session in Handshaking forever. The whole-phase timer must fire and
    // fail the handshake with a non-durable PakeError(Timeout).
    const kit = await makeOrchestrator(TEST_HANDSHAKE_TIMEOUT_MS);
    await kit.orchestrator.start();
    const transport = new LoopbackPeerTransport();
    kit.orchestrator.attachTransport(transport);
    expect(kit.orchestrator.state).toBe(ConnectionState.Handshaking);

    await waitUntil(
      "handshake timeout",
      () => kit.orchestrator.state === ConnectionState.Disconnected,
      TEST_HANDSHAKE_TIMEOUT_MS + 2000,
    );

    const errors = kit.spies.onError.calls.map((c) => c[0]);
    expect(errors.length).toBe(1);
    const last = errors[errors.length - 1]!;
    expect(last).toBeInstanceOf(PakeError);
    expect((last as PakeError).code).toBe(PakeErrorCode.Timeout);

    // Non-durable: retry() is not blocked by an auth-failed latch.
    const convoId = kit.orchestrator.conversationId;
    expect(convoId).not.toBeNull();
    expect(await kit.repository.getAuthFailed(convoId!)).toBe(false);
    expect(() => kit.orchestrator.retry()).not.toThrow();
    kit.orchestrator.leave();
  });
});
