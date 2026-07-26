import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, beforeAll } from "vitest";

import {
  __setWasmModuleForTests,
  generateAtRestKey,
  generateIdentityKeyPair,
  PakeError,
} from "@/features/chat/crypto";
import type { IdentityKeyPair, PakeWasmModule } from "@/features/chat/crypto";
import { encodePublicKey } from "@/features/chat/protocol/codec";
import { ConnectionState } from "@/features/chat/signaling/state-machine";
import { AuthFailedRetryBlocked } from "@/features/chat/store";
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
  readonly onError: ReturnType<typeof makeSpy<(e: unknown) => void>>;
}

function makeSpies(): StateSpies {
  const onError = makeSpy<(e: unknown) => void>();
  return { onError };
}

function spiesToHandlers(spies: StateSpies): OrchestratorHandlers {
  return { onError: spies.onError.fn };
}

interface OrchestratorKit {
  readonly orchestrator: ConversationOrchestrator;
  readonly repository: ConversationRepository;
  readonly identity: IdentityKeyPair;
  readonly spies: StateSpies;
  readonly socket: MockSignalingSocket;
}

interface KitOptions {
  readonly repository?: ConversationRepository;
  readonly identity?: IdentityKeyPair;
}

async function makeOrchestrator(options?: KitOptions): Promise<OrchestratorKit> {
  const repository = options?.repository ?? new InMemoryConversationRepository(generateAtRestKey());
  const identity = options?.identity ?? (await generateIdentityKeyPair());
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

function isOrchError(e: unknown, code: OrchestratorErrorCode): boolean {
  return e instanceof OrchestratorError && e.code === code;
}

describe("ConversationOrchestrator durable auth-failed (R7/F3)", () => {
  describe("IdentityChanged → authFailed", () => {
    it("marks the conversation authFailed on an IdentityChanged handshake failure", async () => {
      const initiator = await makeOrchestrator();
      const responder = await makeOrchestrator();
      const invitation = await initiator.orchestrator.start();
      await responder.orchestrator.join(invitation);

      // Pre-seed the responder repo with a DIFFERENT peer identity so the
      // handshake aborts with IdentityChanged. The orchestrator has not yet
      // pinned anything (no handshake ran), so storePeerIdentity is safe here.
      const bogusIdentity = await generateIdentityKeyPair();
      const bogusKey = encodePublicKey(bogusIdentity.publicKey);
      await responder.repository.storePeerIdentity(
        responder.orchestrator.conversationId!,
        "00 00 00 00 00 00",
        bogusKey,
      );

      // Sanity: the flag is not set yet.
      expect(
        await responder.repository.getAuthFailed(responder.orchestrator.conversationId!),
      ).toBe(false);

      const { a, b } = linkLoopbackPair();
      initiator.orchestrator.attachTransport(a);
      responder.orchestrator.attachTransport(b);

      await tick(300);

      // The handshake aborted with IdentityChanged...
      const errors = responder.spies.onError.calls.map((c) => c[0]);
      expect(errors.some((e) => isOrchError(e, OrchestratorErrorCode.IdentityChanged))).toBe(true);
      // ...and the durable authFailed flag is now set in the repo.
      expect(
        await responder.repository.getAuthFailed(responder.orchestrator.conversationId!),
      ).toBe(true);
    });

    it("retry() on the same conversation throws AuthFailedRetryBlocked", async () => {
      const initiator = await makeOrchestrator();
      const responder = await makeOrchestrator();
      const invitation = await initiator.orchestrator.start();
      await responder.orchestrator.join(invitation);

      const bogusIdentity = await generateIdentityKeyPair();
      const bogusKey = encodePublicKey(bogusIdentity.publicKey);
      await responder.repository.storePeerIdentity(
        responder.orchestrator.conversationId!,
        "00 00 00 00 00 00",
        bogusKey,
      );

      const { a, b } = linkLoopbackPair();
      initiator.orchestrator.attachTransport(a);
      responder.orchestrator.attachTransport(b);

      await tick(300);

      // Force the orchestrator into Disconnected so retry() is legal by state.
      // The IdentityChanged failure already moved it to Disconnected; verify.
      expect(responder.orchestrator.state).toBe(ConnectionState.Disconnected);

      // retry() must reject with AuthFailedRetryBlocked — the PRD TOFU clause
      // requires recovering via a NEW invitation, not a same-conversation retry.
      expect(() => responder.orchestrator.retry()).toThrow(AuthFailedRetryBlocked);
    });

    it("creating a fresh conversation (new invitation) re-enables the handshake", async () => {
      const initiator = await makeOrchestrator();
      const responder = await makeOrchestrator();
      const invitation = await initiator.orchestrator.start();
      await responder.orchestrator.join(invitation);

      const bogusIdentity = await generateIdentityKeyPair();
      const bogusKey = encodePublicKey(bogusIdentity.publicKey);
      await responder.repository.storePeerIdentity(
        responder.orchestrator.conversationId!,
        "00 00 00 00 00 00",
        bogusKey,
      );

      const { a, b } = linkLoopbackPair();
      initiator.orchestrator.attachTransport(a);
      responder.orchestrator.attachTransport(b);
      await tick(300);

      // After the failure, a NEW pair of orchestrators with a fresh invitation
      // (and thus fresh conversation records) reaches Connected. This is the
      // PRD's "recovering requires a NEW invitation" path.
      const initiator2 = await makeOrchestrator();
      const responder2 = await makeOrchestrator();
      const invitation2 = await initiator2.orchestrator.start();
      await responder2.orchestrator.join(invitation2);

      const { a: a2, b: b2 } = linkLoopbackPair();
      initiator2.orchestrator.attachTransport(a2);
      responder2.orchestrator.attachTransport(b2);

      await waitForConnected(initiator2.orchestrator);
      await waitForConnected(responder2.orchestrator);

      expect(initiator2.orchestrator.state).toBe(ConnectionState.Connected);
      expect(responder2.orchestrator.state).toBe(ConnectionState.Connected);
      // The fresh conversation is NOT auth-failed.
      expect(
        await initiator2.repository.getAuthFailed(initiator2.orchestrator.conversationId!),
      ).toBe(false);
    });

    it("non-auth handshake failures do NOT set the authFailed flag", async () => {
      // Drive a HandshakeSignatureMismatch by tampering with the transcript.
      // The simpler path: send a malformed signature-length message that fails
      // verification. We reuse two orchestrators but the responder never receives
      // a valid signature — the orchestrator's verifyTranscript fails with
      // HandshakeSignatureMismatch, which is NOT in the auth-failure classifier.
      const initiator = await makeOrchestrator();
      const responder = await makeOrchestrator();
      const invitation = await initiator.orchestrator.start();
      await responder.orchestrator.join(invitation);

      const { a, b } = linkLoopbackPair();
      // Tamper with bytes of signature length (65) so verification fails with
      // HandshakeSignatureMismatch — a non-auth-failure error.
      initiator.orchestrator.attachTransport(tamperSignatureLength(a));
      responder.orchestrator.attachTransport(b);

      await tick(300);

      const errors = responder.spies.onError.calls.map((c) => c[0]);
      // We see SOME handshake error, but it must not be IdentityChanged or Pake.
      const sawIdentityChanged = errors.some((e) =>
        isOrchError(e, OrchestratorErrorCode.IdentityChanged),
      );
      const sawPake = errors.some((e) => e instanceof PakeError);
      // If the only errors were non-auth failures, the flag stays clear. If an
      // IdentityChanged fired, this assertion would catch the misclassification.
      expect(sawIdentityChanged || sawPake).toBe(false);
      // The flag is NOT set for non-auth handshake failures.
      expect(
        await responder.repository.getAuthFailed(responder.orchestrator.conversationId!),
      ).toBe(false);
    });
  });

  describe("PakeError → authFailed", () => {
    it("marks the conversation authFailed when a wrong-code PAKE handshake fails", async () => {
      const initiator = await makeOrchestrator();
      const responder = await makeOrchestrator();
      // Different codes → the PAKE confirmation tags will mismatch and the
      // handshake aborts with PakeError(Mismatch).
      initiator.orchestrator.setPakeCode("111111");
      responder.orchestrator.setPakeCode("999999");

      const invitation = await initiator.orchestrator.start();
      await responder.orchestrator.join(invitation);

      const { a, b } = linkLoopbackPair();
      initiator.orchestrator.attachTransport(a);
      responder.orchestrator.attachTransport(b);

      await tick(500);

      // Both sides must have at least one PakeError surfaced.
      const initErrors = initiator.spies.onError.calls.map((c) => c[0]);
      const respErrors = responder.spies.onError.calls.map((c) => c[0]);
      const anyPakeError = [...initErrors, ...respErrors].some((e) => e instanceof PakeError);
      expect(anyPakeError).toBe(true);

      // ...and the durable authFailed flag is set on the side(s) that surfaced
      // a PakeError. At least one of the two repos must carry the flag.
      const initAuthFailed = await initiator.repository.getAuthFailed(
        initiator.orchestrator.conversationId!,
      );
      const respAuthFailed = await responder.repository.getAuthFailed(
        responder.orchestrator.conversationId!,
      );
      expect(initAuthFailed || respAuthFailed).toBe(true);
    });

    it("retry() after a PAKE failure throws AuthFailedRetryBlocked", async () => {
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

      // At least one side is Disconnected with authFailed set; retry must block.
      // Try both — the side that has the flag set will throw AuthFailedRetryBlocked.
      const initAuthFailed = await initiator.repository.getAuthFailed(
        initiator.orchestrator.conversationId!,
      );
      const respAuthFailed = await responder.repository.getAuthFailed(
        responder.orchestrator.conversationId!,
      );
      expect(initAuthFailed || respAuthFailed).toBe(true);

      // If the initiator's flag is set, its retry must block. Same for responder.
      // Both moved to Disconnected by the PAKE abort; force them there if not.
      if (initAuthFailed) {
        if (initiator.orchestrator.state !== ConnectionState.Disconnected) {
          initiator.orchestrator.leave();
        }
        expect(() => initiator.orchestrator.retry()).toThrow(AuthFailedRetryBlocked);
      }
      if (respAuthFailed) {
        if (responder.orchestrator.state !== ConnectionState.Disconnected) {
          responder.orchestrator.leave();
        }
        expect(() => responder.orchestrator.retry()).toThrow(AuthFailedRetryBlocked);
      }
    });
  });

  describe("restart durability (the W1 regression)", () => {
    it("a fresh orchestrator on a previously-auth-failed conversation rejects retry with AuthFailedRetryBlocked", async () => {
      // Phase 1: drive a real handshake to an IdentityChanged failure so the
      // durable repo flag is authFailed=true on the responder side.
      const initiator = await makeOrchestrator();
      const responder = await makeOrchestrator();
      const invitation = await initiator.orchestrator.start();
      await responder.orchestrator.join(invitation);

      // Pre-seed a bogus pinned peer identity so the handshake aborts with
      // IdentityChanged → markAuthFailed.
      const bogusIdentity = await generateIdentityKeyPair();
      const bogusKey = encodePublicKey(bogusIdentity.publicKey);
      await responder.repository.storePeerIdentity(
        responder.orchestrator.conversationId!,
        "00 00 00 00 00 00",
        bogusKey,
      );

      const { a, b } = linkLoopbackPair();
      initiator.orchestrator.attachTransport(a);
      responder.orchestrator.attachTransport(b);
      await tick(300);

      // Confirm the durable flag is set on the responder's conversation record.
      const failedConversationId = responder.orchestrator.conversationId!;
      expect(await responder.repository.getAuthFailed(failedConversationId)).toBe(true);

      // Phase 2: simulate a controller/orchestrator restart. Construct a NEW
      // orchestrator instance (authFailedCached defaults to false) pointed at
      // the SAME repository (the durable state is what survives a restart).
      // The orchestrator re-enters via join() with the existing conversation
      // id — exactly what the controller's resumeConversation path does.
      const restarted = await makeOrchestrator({ repository: responder.repository });
      const fragment = `#${invitation.split("#")[1]}`;
      await restarted.orchestrator.join(fragment);
      expect(restarted.orchestrator.conversationId).toEqual(failedConversationId);

      // Move into Disconnected so retry() is legal by state. The restarted
      // orchestrator never handshake-attached, so we explicitly leave().
      restarted.orchestrator.leave();
      expect(restarted.orchestrator.state).toBe(ConnectionState.Disconnected);

      // THE GAP: before the fix, the fresh orchestrator's authFailedCached was
      // false (it never ran failHandshake), so retry() passed the gate even
      // though the durable repo flag was true. With hydration in join(), the
      // cache is seeded from the durable flag and retry() throws.
      expect(() => restarted.orchestrator.retry()).toThrow(AuthFailedRetryBlocked);
    });
  });
});

/**
 * Wrap a PeerTransport so that any 65-byte message (signature-length) is
 * corrupted before delivery. The peer's `verifyTranscript` then fails with
 * HandshakeSignatureMismatch — a NON-auth-failure error, used to assert the
 * authFailed classifier does not over-trigger.
 */
function tamperSignatureLength(inner: PeerTransport): PeerTransport {
  return {
    send: (bytes: Uint8Array): void => {
      if (bytes.length === 65) {
        // Flip the first byte so verification fails.
        const tampered = new Uint8Array(bytes.length);
        tampered.set(bytes);
        tampered[0] = (tampered[0]! ^ 0xff) & 0xff;
        inner.send(tampered);
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
