import { describe, expect, it } from "vitest";

import { generateAtRestKey, generateIdentityKeyPair } from "@/features/chat/crypto";
import type { IdentityKeyPair } from "@/features/chat/crypto";
import {
  PAKE_CONFIRM_MESSAGE_BYTES,
  PAKE_MESSAGE_BYTES,
  PAKE_ROLE_A,
  PROTOCOL_VERSION,
} from "@/features/chat/protocol/limits";
import { ConnectionState } from "@/features/chat/signaling/state-machine";
import { InMemoryConversationRepository } from "@/features/chat/store";
import type { ConversationRepository } from "@/features/chat/store";

import {
  ConversationOrchestrator,
  type OrchestratorDeps,
  type OrchestratorHandlers,
} from "@/features/chat/orchestrator/orchestrator";
import { OrchestratorError, OrchestratorErrorCode } from "@/features/chat/orchestrator/errors";

import {
  LoopbackPeerTransport,
  mockSocketFactory,
  MockSignalingSocket,
} from "./_helpers";

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
 * Build a syntactically valid PAKE share frame (35 bytes) with the given role
 * byte. The orchestrator's inbound dispatcher routes by length BEFORE decoding,
 * so a 35-byte frame hits the PakeShare branch and trips the CR-2 phase guard
 * (state !== Verifying) before any field-level validation runs. The share body
 * is irrelevant for the guard assertion, so zero-fill is fine.
 */
function buildPakeShareFrame(role: number): Uint8Array {
  const out = new Uint8Array(PAKE_MESSAGE_BYTES);
  out[0] = PROTOCOL_VERSION;
  out[1] = role;
  // share body (33 bytes) left zero — never read because the guard throws first.
  return out;
}

/**
 * Build a syntactically valid PAKE confirm frame (34 bytes) with the given
 * role byte. Same length-routing rationale as the share frame.
 */
function buildPakeConfirmFrame(role: number): Uint8Array {
  const out = new Uint8Array(PAKE_CONFIRM_MESSAGE_BYTES);
  out[0] = PROTOCOL_VERSION;
  out[1] = role;
  // tag body (32 bytes) left zero.
  return out;
}

describe("ConversationOrchestrator PAKE-share phase guard (CR-2)", () => {
  it("a PakeShare received before the peer Hello arrives throws MalformedHandshakeMessage", async () => {
    // CR-2 contract: a PakeShare arriving BEFORE the peer's Hello (so
    // remoteHello is null and no signature could have verified yet) must throw
    // OrchestratorError(MalformedHandshakeMessage, "PAKE frame received before
    // signature verified"). Pre-CR-2 the frame was silently stashed in
    // peerPakeShare (or threw a misleading "authMode is not Pake" only when
    // authMode happened to be SafetyNumberOnly).
    const kit = await makeOrchestrator();
    // Negotiate PAKE so the authMode check in handlePakeShare is NOT the first
    // to throw — the phase guard must be what fires.
    kit.orchestrator.setPakeCode("123456");
    await kit.orchestrator.start();
    // We don't need a real peer; just attach a loopback transport so the
    // orchestrator enters Handshaking and wires its onMessage handler.
    const transport = new LoopbackPeerTransport();
    kit.orchestrator.attachTransport(transport);

    // Allow beginHandshake's async Hello generation to settle so we are firmly
    // in Handshaking (not transitioning). State must NOT be Verifying yet —
    // verifyPeerAndComplete only runs after the peer's signature arrives, and
    // we never deliver one.
    await tick(50);
    expect(kit.orchestrator.state).toBe(ConnectionState.Handshaking);

    // Inject a raw PakeShare frame BEFORE any signature. The frame is delivered
    // synchronously to the orchestrator's onMessage handler via the loopback's
    // deliver() seam.
    transport.deliver(buildPakeShareFrame(PAKE_ROLE_A));
    await tick(150);

    // The guard threw and failHandshake surfaced the error + tore down to
    // Disconnected.
    expect(kit.orchestrator.state).toBe(ConnectionState.Disconnected);
    const errors = kit.spies.onError.calls.map((c) => c[0]);
    expect(errors.length).toBeGreaterThan(0);
    const last = errors[errors.length - 1]!;
    expect(last).toBeInstanceOf(OrchestratorError);
    expect((last as OrchestratorError).code).toBe(
      OrchestratorErrorCode.MalformedHandshakeMessage,
    );
    expect((last as OrchestratorError).message).toContain(
      "PAKE frame received before signature verified",
    );
  });

  it("a PakeConfirm received before the peer Hello arrives throws MalformedHandshakeMessage", async () => {
    // Same guard, second frame type. Confirms the dispatcher covers BOTH PAKE
    // branches, not just PakeShare.
    const kit = await makeOrchestrator();
    kit.orchestrator.setPakeCode("654321");
    await kit.orchestrator.start();
    const transport = new LoopbackPeerTransport();
    kit.orchestrator.attachTransport(transport);

    await tick(50);
    expect(kit.orchestrator.state).toBe(ConnectionState.Handshaking);

    transport.deliver(buildPakeConfirmFrame(PAKE_ROLE_A));
    await tick(150);

    expect(kit.orchestrator.state).toBe(ConnectionState.Disconnected);
    const errors = kit.spies.onError.calls.map((c) => c[0]);
    expect(errors.length).toBeGreaterThan(0);
    const last = errors[errors.length - 1]!;
    expect(last).toBeInstanceOf(OrchestratorError);
    expect((last as OrchestratorError).code).toBe(
      OrchestratorErrorCode.MalformedHandshakeMessage,
    );
    expect((last as OrchestratorError).message).toContain(
      "PAKE frame received before signature verified",
    );
  });
});
