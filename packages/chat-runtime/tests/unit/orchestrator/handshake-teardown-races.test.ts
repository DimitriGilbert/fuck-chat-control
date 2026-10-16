import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  __setWasmModuleForTests,
  generateAtRestKey,
  generateIdentityKeyPair,
} from "@fuck-eu-chat-control/chat-runtime/crypto";
import type { PakeWasmModule } from "@fuck-eu-chat-control/chat-runtime/crypto";
import {
  PAKE_CONFIRM_MESSAGE_BYTES,
  PAKE_MESSAGE_BYTES,
} from "@fuck-eu-chat-control/chat-runtime/protocol/limits";
import type { ConversationId, PublicKey } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import { ConnectionState } from "@fuck-eu-chat-control/chat-runtime/signaling/state-machine";
import {
  getAuthFailedDurable,
  InMemoryConversationRepository,
  setDurableStorage,
} from "@fuck-eu-chat-control/chat-runtime/store";
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

import { MemoryStorage } from "../store/_helpers";
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

/**
 * Gate state shared between the hoisted vi.mock factory below and the test
 * body. `enabled` parks every gated call AFTER the real crypto has run;
 * `parkedCount` lets the test await the park; `waiters` holds the parked
 * coroutines' continuations. `releaseGate` opens the gate permanently so the
 * retry handshake at the end of each scenario passes through untouched.
 */
const cryptoGates = vi.hoisted(() => {
  const makeGate = (): { enabled: boolean; parkedCount: number; waiters: Array<() => void> } => ({
    enabled: false,
    parkedCount: 0,
    waiters: [],
  });
  return {
    verifyTranscript: makeGate(),
    signTranscript: makeGate(),
    createPakeSession: makeGate(),
    deriveSessionKeys: makeGate(),
    computeSafetyNumber: makeGate(),
    derivePakeConfirmationTag: makeGate(),
  };
});

type Gate = (typeof cryptoGates)["verifyTranscript"];

/**
 * Run the real crypto call, then — while the gate is enabled — park the
 * caller's continuation until the test releases it. This places the
 * `verifyPeerAndComplete` coroutine deterministically at a chosen post-await
 * resumption point so a `leave()` fired from the test lands strictly INSIDE
 * that await. Rejections of the underlying call propagate untouched.
 */
function runGated<R>(gate: Gate, call: () => Promise<R>): Promise<R> {
  return call().then(async (result) => {
    if (gate.enabled) {
      gate.parkedCount += 1;
      await new Promise<void>((resolve) => {
        gate.waiters.push(resolve);
      });
    }
    return result;
  });
}

function enableGate(gate: Gate): void {
  gate.enabled = true;
  gate.parkedCount = 0;
  gate.waiters.length = 0;
}

function releaseGate(gate: Gate): void {
  gate.enabled = false;
  for (const waiter of gate.waiters.splice(0)) {
    waiter();
  }
}

// The vi.mock factory is hoisted above every import; it may only reference
// hoisted state (cryptoGates) and hoisted function declarations (runGated).
vi.mock("@fuck-eu-chat-control/chat-runtime/crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fuck-eu-chat-control/chat-runtime/crypto")>();
  return {
    ...actual,
    verifyTranscript: (...args: Parameters<typeof actual.verifyTranscript>) =>
      runGated(cryptoGates.verifyTranscript, () => actual.verifyTranscript(...args)),
    signTranscript: (...args: Parameters<typeof actual.signTranscript>) =>
      runGated(cryptoGates.signTranscript, () => actual.signTranscript(...args)),
    createPakeSession: (...args: Parameters<typeof actual.createPakeSession>) =>
      runGated(cryptoGates.createPakeSession, () => actual.createPakeSession(...args)),
    deriveSessionKeys: (...args: Parameters<typeof actual.deriveSessionKeys>) =>
      runGated(cryptoGates.deriveSessionKeys, () => actual.deriveSessionKeys(...args)),
    computeSafetyNumber: (...args: Parameters<typeof actual.computeSafetyNumber>) =>
      runGated(cryptoGates.computeSafetyNumber, () => actual.computeSafetyNumber(...args)),
    derivePakeConfirmationTag: (...args: Parameters<typeof actual.derivePakeConfirmationTag>) =>
      runGated(cryptoGates.derivePakeConfirmationTag, () =>
        actual.derivePakeConfirmationTag(...args),
      ),
  };
});

/**
 * Invocation counter for the real WASM `pake_finish` export, wired in
 * beforeAll via a wrapper binding handed to {@link __setWasmModuleForTests}.
 * Lets the R6F7 regression tests assert that a stale handshake continuation
 * never reached the wasm call after teardownSession freed the PakeState
 * handle — a use-after-free the onError assertions alone cannot distinguish
 * (the wasm call could theoretically return a value instead of throwing).
 */
const pakeFinishCalls = { count: 0 };

// Synchronous wasm init (mirrors pake-handshake-timeout.test.ts) so the
// createPakeSession scenario runs the real SPAKE2 exchange through the gate.
beforeAll(async () => {
  const wasmBytes = new Uint8Array(readFileSync(PKG_WASM));
  const wasmModule = await WebAssembly.compile(wasmBytes);
  const binding = (await import(PKG_JS)) as unknown as {
    initSync(module: { module: WebAssembly.Module }): void;
    pake_start: PakeWasmModule["pake_start"];
    pake_finish: PakeWasmModule["pake_finish"];
  };
  binding.initSync({ module: wasmModule });
  __setWasmModuleForTests({
    pake_start: binding.pake_start,
    pake_finish: (state, peerShare) => {
      pakeFinishCalls.count += 1;
      return binding.pake_finish(state, peerShare);
    },
  });
});

// A failed assertion inside a scenario must not leak an enabled gate (and a
// parked coroutine) into the next test.
afterEach(() => {
  for (const gate of Object.values(cryptoGates)) {
    releaseGate(gate);
  }
});

const SAMPLE_BASE_URL = "https://app.example";
const PAKE_CODE = "123456";
/**
 * Test-only PAKE await bound (the handshakeTimeoutMsOverride seam): generous
 * for the real wasm handshake (see pake-handshake-timeout.test.ts (c), which
 * completes a full exchange well inside it) while bounding any stray parked
 * await so a regression surfaces as a Timeout error rather than a 30s hang.
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
  readonly onSafetyNumber: ReturnType<typeof makeSpy<(s: string, verified: boolean) => void>>;
}

function makeSpies(): StateSpies {
  const onStateChange = makeSpy<(s: ConnectionState) => void>();
  const onError = makeSpy<(e: unknown) => void>();
  const onSafetyNumber = makeSpy<(s: string, verified: boolean) => void>();
  return { onStateChange, onError, onSafetyNumber };
}

function spiesToHandlers(spies: StateSpies): OrchestratorHandlers {
  return {
    onStateChange: spies.onStateChange.fn,
    onError: spies.onError.fn,
    onSafetyNumber: spies.onSafetyNumber.fn,
  };
}

interface RepoGates {
  readonly getPeerIdentity: Gate;
  readonly storePeerIdentity: Gate;
}

function makeRepoGates(): RepoGates {
  return {
    getPeerIdentity: {
      enabled: false,
      parkedCount: 0,
      waiters: [],
    },
    storePeerIdentity: {
      enabled: false,
      parkedCount: 0,
      waiters: [],
    },
  };
}

/**
 * Delegating repository whose getPeerIdentity/storePeerIdentity awaits run
 * through the same gating mechanism as the mocked crypto — those are two of
 * verifyPeerAndComplete's await points and are the only repo awaits on the
 * handshake path.
 */
class GatedRepository implements ConversationRepository {
  private readonly inner: ConversationRepository;
  private readonly gates: RepoGates;

  constructor(inner: ConversationRepository, gates: RepoGates) {
    this.inner = inner;
    this.gates = gates;
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

  storePeerIdentity(id: ConversationId, fingerprint: string, publicKey: PublicKey): Promise<void> {
    return runGated(this.gates.storePeerIdentity, () =>
      this.inner.storePeerIdentity(id, fingerprint, publicKey),
    );
  }

  replacePeerIdentity(
    id: ConversationId,
    fingerprint: string,
    publicKey: PublicKey,
  ): Promise<void> {
    return this.inner.replacePeerIdentity(id, fingerprint, publicKey);
  }

  getPeerIdentity(id: ConversationId): Promise<PeerIdentityRecord | null> {
    return runGated(this.gates.getPeerIdentity, () => this.inner.getPeerIdentity(id));
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
  readonly repository: ConversationRepository;
  readonly spies: StateSpies;
  readonly socket: MockSignalingSocket;
}

async function makeOrchestrator(
  repoGates: RepoGates,
  handshakeTimeoutMs?: number,
): Promise<OrchestratorKit> {
  const repository = new GatedRepository(
    new InMemoryConversationRepository(generateAtRestKey()),
    repoGates,
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
    ...(handshakeTimeoutMs !== undefined ? { handshakeTimeoutMsOverride: handshakeTimeoutMs } : {}),
  };
  return { orchestrator: new ConversationOrchestrator(deps), repository, spies, socket };
}

async function tick(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
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

async function waitForConnected(orch: ConversationOrchestrator, timeoutMs = 3000): Promise<void> {
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
 * One R2/F2 await point of verifyPeerAndComplete. Each scenario gates exactly
 * one await (crypto via the module mock, repository via the delegating repo),
 * parks BOTH sides' coroutines there, tears both orchestrators down with
 * leave() while they are parked, then releases the gate and asserts the
 * parked coroutines bail out silently — and that a subsequent retry()
 * handshake on a fresh transport pair completes cleanly.
 */
interface Scenario {
  readonly label: string;
  readonly usePake: boolean;
  readonly enable: (repoGates: RepoGates) => void;
  readonly parkedCount: (repoGates: RepoGates) => number;
  readonly release: (repoGates: RepoGates) => void;
}

const scenarios: readonly Scenario[] = [
  {
    label: "verifyTranscript",
    usePake: false,
    enable: () => enableGate(cryptoGates.verifyTranscript),
    parkedCount: () => cryptoGates.verifyTranscript.parkedCount,
    release: () => releaseGate(cryptoGates.verifyTranscript),
  },
  {
    label: "getPeerIdentity",
    usePake: false,
    enable: (repoGates) => enableGate(repoGates.getPeerIdentity),
    parkedCount: (repoGates) => repoGates.getPeerIdentity.parkedCount,
    release: (repoGates) => releaseGate(repoGates.getPeerIdentity),
  },
  {
    label: "createPakeSession",
    usePake: true,
    enable: () => enableGate(cryptoGates.createPakeSession),
    parkedCount: () => cryptoGates.createPakeSession.parkedCount,
    release: () => releaseGate(cryptoGates.createPakeSession),
  },
  {
    // The runPakeConfirmation pre-park crypto await: by the time both sides
    // park here the SPAKE2 share exchange + pakeFinish have ALREADY completed,
    // so the parked coroutines sit exactly between the tag derivation and the
    // outbound confirm send / awaitPakeConfirmBounded resolver+timer install.
    // A leave() in this window must make them bail silently; pre-fix they
    // resumed, installed the resolver+timer on the torn-down orchestrator, and
    // the timer's Timeout rejection surfaced as a spurious onError one
    // handshake-timeout AFTER the teardown.
    label: "derivePakeConfirmationTag",
    usePake: true,
    enable: () => enableGate(cryptoGates.derivePakeConfirmationTag),
    parkedCount: () => cryptoGates.derivePakeConfirmationTag.parkedCount,
    release: () => releaseGate(cryptoGates.derivePakeConfirmationTag),
  },
  {
    label: "deriveSessionKeys",
    usePake: false,
    enable: () => enableGate(cryptoGates.deriveSessionKeys),
    parkedCount: () => cryptoGates.deriveSessionKeys.parkedCount,
    release: () => releaseGate(cryptoGates.deriveSessionKeys),
  },
  {
    label: "computeSafetyNumber",
    usePake: false,
    enable: () => enableGate(cryptoGates.computeSafetyNumber),
    parkedCount: () => cryptoGates.computeSafetyNumber.parkedCount,
    release: () => releaseGate(cryptoGates.computeSafetyNumber),
  },
  {
    label: "storePeerIdentity",
    usePake: false,
    enable: (repoGates) => enableGate(repoGates.storePeerIdentity),
    parkedCount: (repoGates) => repoGates.storePeerIdentity.parkedCount,
    release: (repoGates) => releaseGate(repoGates.storePeerIdentity),
  },
];

describe("verifyPeerAndComplete teardown races (R2/F2)", () => {
  for (const scenario of scenarios) {
    it(
      `teardown during the ${scenario.label} await leaves no error emission and does not interfere with a retry`,
      { timeout: 15_000 },
      async () => {
        const repoGates = makeRepoGates();
        scenario.enable(repoGates);

        const timeoutOverride = scenario.usePake ? TEST_HANDSHAKE_TIMEOUT_MS : undefined;
        const initiator = await makeOrchestrator(repoGates, timeoutOverride);
        const responder = await makeOrchestrator(repoGates, timeoutOverride);
        if (scenario.usePake) {
          initiator.orchestrator.setPakeCode(PAKE_CODE);
          responder.orchestrator.setPakeCode(PAKE_CODE);
        }
        const invitation = await initiator.orchestrator.start();
        await responder.orchestrator.join(invitation);

        const { a, b } = linkLoopbackPair();
        initiator.orchestrator.attachTransport(a);
        responder.orchestrator.attachTransport(b);

        // Both sides' verifyPeerAndComplete coroutines are now parked at the
        // gated await (the handshake reached it — not a timeout).
        await waitUntil(
          `${scenario.label} park on both sides`,
          () => scenario.parkedCount(repoGates) >= 2,
        );
        expect(initiator.orchestrator.state).not.toBe(ConnectionState.Idle);

        // Teardown from the user side while both coroutines are parked.
        initiator.orchestrator.leave();
        responder.orchestrator.leave();
        expect(initiator.orchestrator.state).toBe(ConnectionState.Disconnected);
        expect(responder.orchestrator.state).toBe(ConnectionState.Disconnected);

        // Resume the parked coroutines: they must bail out SILENTLY. Pre-fix
        // they resumed against torn-down state and surfaced an error —
        // InvalidTransitionError (setState(Verifying) from Disconnected) at
        // verifyTranscript, a null-ephemeral TypeError at getPeerIdentity,
        // the FrameSender-on-nulled-transport TypeError at
        // deriveSessionKeys/computeSafetyNumber/storePeerIdentity, and a
        // resurrected PAKE session timing out at createPakeSession. Wait
        // past the PAKE bound so a stray parked await would surface too.
        scenario.release(repoGates);
        await tick(scenario.usePake ? TEST_HANDSHAKE_TIMEOUT_MS * 2 : 200);

        expect(initiator.spies.onError.calls).toHaveLength(0);
        expect(responder.spies.onError.calls).toHaveLength(0);
        expect(initiator.orchestrator.state).toBe(ConnectionState.Disconnected);
        expect(responder.orchestrator.state).toBe(ConnectionState.Disconnected);

        // No interference with a subsequent retry: retry() is not blocked
        // (no auth-failed latch was set) and a fresh handshake over a fresh
        // transport pair completes. The gate is now open, so the retry
        // handshake runs the real crypto untouched. The retry reconnects the
        // SAME two peers — in the storePeerIdentity scenario the gated write
        // already committed first contact, so a fresh identity would (correctly)
        // TOFU-fail with IdentityChanged rather than retry.
        initiator.orchestrator.retry();
        responder.orchestrator.retry();
        expect(initiator.orchestrator.state).toBe(ConnectionState.Signaling);
        expect(responder.orchestrator.state).toBe(ConnectionState.Signaling);

        const { a: retryA, b: retryB } = linkLoopbackPair();
        initiator.orchestrator.attachTransport(retryA);
        responder.orchestrator.attachTransport(retryB);

        await waitForConnected(initiator.orchestrator);
        await waitForConnected(responder.orchestrator);
        expect(initiator.spies.onError.calls).toHaveLength(0);
        expect(responder.spies.onError.calls).toHaveLength(0);

        initiator.orchestrator.leave();
        responder.orchestrator.leave();
      },
    );
  }
});

describe("verifyPeerAndComplete generation advance across a re-attach (R7/F4 + R2/F2)", () => {
  it(
    "a stale coroutine released AFTER a fresh re-attach wires nothing over the new session",
    { timeout: 15_000 },
    async () => {
      const repoGates = makeRepoGates();
      enableGate(cryptoGates.deriveSessionKeys);

      const initiator = await makeOrchestrator(repoGates);
      const responder = await makeOrchestrator(repoGates);
      const invitation = await initiator.orchestrator.start();
      await responder.orchestrator.join(invitation);

      const { a, b } = linkLoopbackPair();
      initiator.orchestrator.attachTransport(a);
      responder.orchestrator.attachTransport(b);

      // Both STALE coroutines park inside the gated deriveSessionKeys await —
      // past every earlier R2/F2 re-check, one resumption step away from
      // wiring framing.
      await waitUntil(
        "stale park on both sides",
        () => cryptoGates.deriveSessionKeys.parkedCount >= 2,
      );

      // Teardown, then — BEFORE releasing the gate — retry() and attach a
      // FRESH transport pair on both sides. The re-attach bumps the handshake
      // generation, so the still-parked stale coroutines are now superseded by
      // the generation condition alone: transport/ephemeral are non-null again
      // but belong to the NEW handshake. The gate is still enabled, so the
      // FRESH handshakes run their real crypto and park at the same await.
      initiator.orchestrator.leave();
      responder.orchestrator.leave();
      initiator.orchestrator.retry();
      responder.orchestrator.retry();
      const { a: freshA, b: freshB } = linkLoopbackPair();
      initiator.orchestrator.attachTransport(freshA);
      responder.orchestrator.attachTransport(freshB);
      await waitUntil(
        "fresh park on both sides",
        () => cryptoGates.deriveSessionKeys.parkedCount >= 4,
      );

      // Release: the stale coroutines parked first, so they resume first and
      // must bail WITHOUT wiring anything — no second FrameSender/FrameReceiver
      // over the fresh transport, no derivedSendKeyForTest mirror overwrite, no
      // safety-number emission. The fresh coroutines then resume and complete
      // exactly one handshake per side.
      releaseGate(cryptoGates.deriveSessionKeys);

      await waitForConnected(initiator.orchestrator);
      await waitForConnected(responder.orchestrator);

      expect(initiator.spies.onError.calls).toHaveLength(0);
      expect(responder.spies.onError.calls).toHaveLength(0);

      // Single completion: exactly one Connected transition and ONE
      // safety-number emission per orchestrator. A stale coroutine that ran to
      // the end of verifyPeerAndComplete would re-emit onSafetyNumber (and
      // overwrite the framing pair) — the second FrameReceiver assignment
      // displaces the fresh session's receiver, i.e. double framing.
      const initiatorConnected = initiator.spies.onStateChange.calls.filter(
        (call) => call[0] === ConnectionState.Connected,
      );
      const responderConnected = responder.spies.onStateChange.calls.filter(
        (call) => call[0] === ConnectionState.Connected,
      );
      expect(initiatorConnected).toHaveLength(1);
      expect(responderConnected).toHaveLength(1);
      expect(initiator.spies.onSafetyNumber.calls).toHaveLength(1);
      expect(responder.spies.onSafetyNumber.calls).toHaveLength(1);

      initiator.orchestrator.leave();
      responder.orchestrator.leave();
    },
  );
});

/**
 * Adjacent Phase 7 hardening: maybeSignAndSend captures the handshake
 * generation before its signTranscript await and bails silently when
 * superseded. A stale sign coroutine parked across a teardown → retry() →
 * re-attach must NOT send its OLD signature on the NEW transport (the honest
 * peer's verifyTranscript would fail and failHandshake would kill the fresh
 * session) and must NOT latch `localSignatureSent` on the fresh handshake
 * (which would stall the fresh signature round entirely).
 */
describe("stale maybeSignAndSend across a re-attach", () => {
  it(
    "a stale sign coroutine released after a fresh re-attach sends nothing and does not stall the fresh handshake",
    { timeout: 15_000 },
    async () => {
      const repoGates = makeRepoGates();
      enableGate(cryptoGates.signTranscript);

      const initiator = await makeOrchestrator(repoGates);
      const responder = await makeOrchestrator(repoGates);
      const invitation = await initiator.orchestrator.start();
      await responder.orchestrator.join(invitation);

      const { a, b } = linkLoopbackPair();
      initiator.orchestrator.attachTransport(a);
      responder.orchestrator.attachTransport(b);

      // Each side's signature round is triggered by the peer's Hello: both
      // maybeSignAndSend coroutines park inside the gated signTranscript await
      // (after the real signature over the OLD transcript has been computed).
      await waitUntil(
        "stale sign park on both sides",
        () => cryptoGates.signTranscript.parkedCount >= 2,
      );

      // Teardown, then — BEFORE releasing the gate — retry() and attach a
      // FRESH transport pair. The fresh handshakes exchange fresh Hellos and
      // park their own maybeSignAndSend coroutines at the same gated await.
      initiator.orchestrator.leave();
      responder.orchestrator.leave();
      initiator.orchestrator.retry();
      responder.orchestrator.retry();
      const { a: freshA, b: freshB } = linkLoopbackPair();
      initiator.orchestrator.attachTransport(freshA);
      responder.orchestrator.attachTransport(freshB);
      await waitUntil(
        "fresh sign park on both sides",
        () => cryptoGates.signTranscript.parkedCount >= 4,
      );

      // Release: the stale coroutines (parked first, woken first) must bail
      // silently; only the fresh coroutines may send signatures. Pre-fix the
      // stale coroutine sent a signature over the OLD transcript on the FRESH
      // transport — the peer's verifyTranscript failed and failHandshake tore
      // down the fresh session.
      releaseGate(cryptoGates.signTranscript);

      await waitForConnected(initiator.orchestrator);
      await waitForConnected(responder.orchestrator);

      expect(initiator.spies.onError.calls).toHaveLength(0);
      expect(responder.spies.onError.calls).toHaveLength(0);

      // Exactly one Connected transition per side, and each side sent exactly
      // one 65-byte signature message on its FRESH transport (the stale
      // coroutine's signature never crossed the wire).
      const initiatorConnected = initiator.spies.onStateChange.calls.filter(
        (call) => call[0] === ConnectionState.Connected,
      );
      const responderConnected = responder.spies.onStateChange.calls.filter(
        (call) => call[0] === ConnectionState.Connected,
      );
      expect(initiatorConnected).toHaveLength(1);
      expect(responderConnected).toHaveLength(1);
      expect(freshA.sent.filter((bytes) => bytes.length === 65)).toHaveLength(1);
      expect(freshB.sent.filter((bytes) => bytes.length === 65)).toHaveLength(1);

      initiator.orchestrator.leave();
      responder.orchestrator.leave();
    },
  );
});

/**
 * Wrap a PeerTransport so every outbound frame of exactly `dropLength` bytes
 * is silently dropped while all other handshake/frame traffic passes through —
 * the same strand-the-peer technique as dropPakeShareTransport in
 * pake-handshake-timeout.test.ts, parameterized over the frame length so it
 * can target either the SPAKE2 share (35B) or the confirmation tag (34B).
 */
function dropFramesOfLength(inner: PeerTransport, dropLength: number): PeerTransport {
  return {
    send: (bytes: Uint8Array): void => {
      if (bytes.length === dropLength) {
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

/**
 * R6F2: teardownSession rejects parked PAKE resolvers with
 * PakeError(Cancelled) — a rejection raised BY the teardown itself. When it
 * propagates through verifyPeerAndComplete into failHandshake it must NOT
 * surface via onError (a phantom post-leave error for a user-initiated
 * teardown). Each scenario strands one side in a resolver-based bounded await
 * by dropping the corresponding peer frame, then leave()s and asserts onError
 * was never called. The await bound is generous so a genuine Timeout (which
 * SHOULD still surface) cannot race the leave().
 */
const PAKE_PARK_TIMEOUT_MS = 10_000;

describe("teardown-driven PAKE cancellation suppresses onError (R6F2)", () => {
  it(
    "awaitPakeShareBounded: leave() while parked for the peer share emits no onError",
    { timeout: 15_000 },
    async () => {
      const repoGates = makeRepoGates();
      const initiator = await makeOrchestrator(repoGates, PAKE_PARK_TIMEOUT_MS);
      const responder = await makeOrchestrator(repoGates, PAKE_PARK_TIMEOUT_MS);
      initiator.orchestrator.setPakeCode(PAKE_CODE);
      responder.orchestrator.setPakeCode(PAKE_CODE);
      const invitation = await initiator.orchestrator.start();
      await responder.orchestrator.join(invitation);

      const { a, b } = linkLoopbackPair();
      initiator.orchestrator.attachTransport(a);
      // The responder's SPAKE2 share (35B) never reaches the initiator, so the
      // initiator parks inside awaitPakeShareBounded. The responder still
      // receives the initiator's share and advances to its own confirm await.
      responder.orchestrator.attachTransport(dropFramesOfLength(b, PAKE_MESSAGE_BYTES));

      await waitUntil(
        "initiator parked in Verifying",
        () => initiator.orchestrator.state === ConnectionState.Verifying,
      );
      // Settle a few ticks so the coroutine is firmly inside the parked await.
      await tick(100);

      initiator.orchestrator.leave();
      responder.orchestrator.leave();
      await tick(100);

      // The teardown-driven PakeError(Cancelled) reached failHandshake on both
      // sides — and was swallowed there: no phantom onError on either.
      expect(initiator.orchestrator.state).toBe(ConnectionState.Disconnected);
      expect(responder.orchestrator.state).toBe(ConnectionState.Disconnected);
      expect(initiator.spies.onError.calls).toHaveLength(0);
      expect(responder.spies.onError.calls).toHaveLength(0);
    },
  );

  it(
    "awaitPakeConfirmBounded: leave() while parked for the peer confirm emits no onError",
    { timeout: 15_000 },
    async () => {
      const repoGates = makeRepoGates();
      const initiator = await makeOrchestrator(repoGates, PAKE_PARK_TIMEOUT_MS);
      const responder = await makeOrchestrator(repoGates, PAKE_PARK_TIMEOUT_MS);
      initiator.orchestrator.setPakeCode(PAKE_CODE);
      responder.orchestrator.setPakeCode(PAKE_CODE);
      const invitation = await initiator.orchestrator.start();
      await responder.orchestrator.join(invitation);

      const { a, b } = linkLoopbackPair();
      initiator.orchestrator.attachTransport(a);
      // The responder's PAKE confirm (34B) never reaches the initiator, so the
      // initiator parks inside awaitPakeConfirmBounded after the share
      // exchange completes. The responder still receives the initiator's
      // confirm and completes its handshake.
      responder.orchestrator.attachTransport(dropFramesOfLength(b, PAKE_CONFIRM_MESSAGE_BYTES));

      await waitUntil(
        "responder connected; initiator parked in Verifying",
        () =>
          responder.orchestrator.state === ConnectionState.Connected &&
          initiator.orchestrator.state === ConnectionState.Verifying,
      );
      await tick(100);

      initiator.orchestrator.leave();
      responder.orchestrator.leave();
      await tick(100);

      expect(initiator.orchestrator.state).toBe(ConnectionState.Disconnected);
      expect(responder.orchestrator.state).toBe(ConnectionState.Disconnected);
      expect(initiator.spies.onError.calls).toHaveLength(0);
      expect(responder.spies.onError.calls).toHaveLength(0);
    },
  );
});

/**
 * Wrap a PeerTransport so every outbound frame of exactly `captureLength`
 * bytes is recorded into `captured` and NOT delivered to the peer — the
 * receiving side stays parked while the test holds the captured frame for
 * manual, timing-controlled re-injection via LoopbackPeerTransport.deliver.
 * This is the deterministic seam for the deliver-then-leave-in-one-tick race:
 * a normal send() hands the frame to the peer synchronously mid-dispatch, so
 * dropping it here and re-delivering by hand lets the test control the exact
 * interleave between the resolver firing and teardownSession running.
 */
function captureAndDropFramesOfLength(
  inner: PeerTransport,
  captureLength: number,
): { transport: PeerTransport; captured: Uint8Array[] } {
  const captured: Uint8Array[] = [];
  return {
    captured,
    transport: {
      send: (bytes: Uint8Array): void => {
        if (bytes.length === captureLength) {
          captured.push(bytes);
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
    },
  };
}

/**
 * R6F7 (use-after-free on the WASM PakeState handle): handlePakeShare and
 * handlePakeConfirm resolve their parked awaits SYNCHRONOUSLY mid-dispatch,
 * so a leave()/notifyPeerLeft() issued in the SAME tick runs teardownSession —
 * which zeroes and .free()s `this.pakeSession.state` — BEFORE the parked
 * continuation drains. The coroutine's captured `session` still references
 * the freed handle; pre-fix it then called `pake_finish` on `__wbg_ptr === 0`
 * and the throw mapped via mapWasmError to a DURABLE Mismatch — a plain
 * leave() racing a share delivery permanently bricked the conversation.
 *
 * These tests drive exactly that interleave: capture the peer frame (dropped
 * on the wire so the receiver stays parked), hand-deliver it via
 * LoopbackPeerTransport.deliver(), then call leave() in the same synchronous
 * block — before the microtask queue drains the resolver's continuation. The
 * fix (a `this.pakeSession !== session` liveness check throwing
 * PakeError(Cancelled), plus detaching the field BEFORE pakeFinish's own
 * inner await) must leave no trace: no onError, no durable auth-failed mark
 * (repo or durable store — a real MemoryStorage is registered so the durable
 * assertion is not vacuous), retry() stays unblocked, and `pakeFinishCalls`
 * proves the wasm export was never invoked on the freed handle.
 */
describe("deliver-then-leave in one tick: stale PAKE continuation (R6F7)", () => {
  beforeAll(() => {
    setDurableStorage(new MemoryStorage());
  });

  it(
    "awaitPakeFinish: share delivered then leave() before the microtask drains emits no onError, no durable mark, no wasm call",
    { timeout: 15_000 },
    async () => {
      const repoGates = makeRepoGates();
      const initiator = await makeOrchestrator(repoGates, PAKE_PARK_TIMEOUT_MS);
      const responder = await makeOrchestrator(repoGates, PAKE_PARK_TIMEOUT_MS);
      initiator.orchestrator.setPakeCode(PAKE_CODE);
      responder.orchestrator.setPakeCode(PAKE_CODE);
      const invitation = await initiator.orchestrator.start();
      await responder.orchestrator.join(invitation);

      const { a, b } = linkLoopbackPair();
      initiator.orchestrator.attachTransport(a);
      // Swallow the responder's SPAKE2 share so the initiator parks inside
      // awaitPakeShareBounded; the captured frame is re-injected by hand below.
      const shareTap = captureAndDropFramesOfLength(b, PAKE_MESSAGE_BYTES);
      responder.orchestrator.attachTransport(shareTap.transport);

      await waitUntil(
        "initiator parked in Verifying and responder share captured",
        () =>
          initiator.orchestrator.state === ConnectionState.Verifying &&
          shareTap.captured.length >= 1,
      );
      // Settle a few ticks so the initiator is firmly inside the parked await
      // and the responder has already run its own (legitimate) pakeFinish —
      // the counter snapshot below must only see the initiator's stale call.
      await tick(100);

      const finishCallsBefore = pakeFinishCalls.count;
      const share = shareTap.captured[0];
      if (share === undefined) {
        throw new Error("responder SPAKE2 share was not captured");
      }
      // THE RACE: deliver the share — the parked resolver resolves and queues
      // the awaitPakeFinish continuation as a microtask — then leave() in the
      // SAME synchronous tick, so teardownSession frees the WASM handle before
      // that continuation drains.
      a.deliver(share);
      initiator.orchestrator.leave();
      responder.orchestrator.leave();
      expect(initiator.orchestrator.state).toBe(ConnectionState.Disconnected);

      await tick(100);

      // The stale continuation must surface as PakeError(Cancelled), swallowed
      // by failHandshake: no phantom post-leave onError on either side.
      expect(initiator.spies.onError.calls).toHaveLength(0);
      expect(responder.spies.onError.calls).toHaveLength(0);
      // The freed WASM handle was never passed to pake_finish.
      expect(pakeFinishCalls.count).toBe(finishCallsBefore);

      // No durable auth-failed mark (repo + durable store): the conversation
      // stays retryable — the pre-fix Mismatch would have bricked it.
      const convoId = initiator.orchestrator.conversationId;
      expect(convoId).not.toBeNull();
      const cid = convoId as NonNullable<typeof convoId>;
      expect(await initiator.repository.getAuthFailed(cid)).toBe(false);
      expect(await getAuthFailedDurable(cid)).toBe(false);
      expect(() => {
        initiator.orchestrator.retry();
      }).not.toThrow();
      // retry() moved the initiator to Signaling; leave() re-settles it to
      // Disconnected so no reconnect attempt dangles into later tests.
      initiator.orchestrator.leave();
    },
  );

  it(
    "runPakeConfirmation: confirm delivered then leave() before the microtask drains emits no onError and no durable mark",
    { timeout: 15_000 },
    async () => {
      // Mismatched codes: both sides complete pakeFinish with DIVERGENT
      // secrets, so the delivered confirm tag genuinely fails verification —
      // pre-fix the post-teardown resumption threw PakeError(Mismatch) into
      // failHandshake, a durable auth failure for a session that was already
      // dead. Post-fix the superseded re-check bails silently. (The responder
      // DOES legitimately fail with Mismatch when the initiator's bad confirm
      // arrives — that is the correct auth-failure path and is not asserted.)
      const repoGates = makeRepoGates();
      const initiator = await makeOrchestrator(repoGates, PAKE_PARK_TIMEOUT_MS);
      const responder = await makeOrchestrator(repoGates, PAKE_PARK_TIMEOUT_MS);
      initiator.orchestrator.setPakeCode(PAKE_CODE);
      responder.orchestrator.setPakeCode("654321");
      const invitation = await initiator.orchestrator.start();
      await responder.orchestrator.join(invitation);

      const { a, b } = linkLoopbackPair();
      initiator.orchestrator.attachTransport(a);
      // Swallow the responder's confirm tag so the initiator parks inside
      // awaitPakeConfirmBounded after the share exchange completes.
      const confirmTap = captureAndDropFramesOfLength(b, PAKE_CONFIRM_MESSAGE_BYTES);
      responder.orchestrator.attachTransport(confirmTap.transport);

      await waitUntil(
        "initiator parked for confirm and responder confirm captured",
        () =>
          initiator.orchestrator.state === ConnectionState.Verifying &&
          confirmTap.captured.length >= 1,
      );
      await tick(100);

      const confirm = confirmTap.captured[0];
      if (confirm === undefined) {
        throw new Error("responder PAKE confirm was not captured");
      }
      a.deliver(confirm);
      initiator.orchestrator.leave();
      responder.orchestrator.leave();
      expect(initiator.orchestrator.state).toBe(ConnectionState.Disconnected);
      await tick(100);

      expect(initiator.spies.onError.calls).toHaveLength(0);

      // Initiator-side durable assertions only: the durable store is a
      // module-level singleton shared by BOTH orchestrators in this process,
      // and the responder legitimately marked it — a wrong code IS a real
      // Mismatch auth failure on its side. In production the two peers write
      // to different devices' stores; here the initiator's own repo and its
      // authFailedCached (via retry()) are the isolatable signals. Pre-fix the
      // stale continuation's Mismatch would have set both.
      const convoId = initiator.orchestrator.conversationId;
      expect(convoId).not.toBeNull();
      const cid = convoId as NonNullable<typeof convoId>;
      expect(await initiator.repository.getAuthFailed(cid)).toBe(false);
      expect(() => {
        initiator.orchestrator.retry();
      }).not.toThrow();
      initiator.orchestrator.leave();
    },
  );
});
