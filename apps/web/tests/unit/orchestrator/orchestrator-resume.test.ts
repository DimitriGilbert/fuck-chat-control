import { describe, expect, it } from "vitest";

import { generateAtRestKey, generateIdentityKeyPair } from "@/features/chat/crypto";
import type { IdentityKeyPair } from "@/features/chat/crypto";
import { encodePublicKey } from "@/features/chat/protocol/codec";
import { ConnectionState } from "@/features/chat/signaling/state-machine";
import { InMemoryConversationRepository } from "@/features/chat/store";
import type { ConversationMessage, ConversationRepository } from "@/features/chat/store";

import {
  ConversationOrchestrator,
  type OrchestratorDeps,
  type OrchestratorHandlers,
} from "@/features/chat/orchestrator/orchestrator";
import { OrchestratorError, OrchestratorErrorCode } from "@/features/chat/orchestrator/errors";

import { linkLoopbackPair, mockSocketFactory, MockSignalingSocket, parse } from "./_helpers";

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
  readonly onMessage: ReturnType<typeof makeSpy<(m: ConversationMessage) => void>>;
  readonly onSafetyNumber: ReturnType<typeof makeSpy<(sn: string, verified: boolean) => void>>;
  readonly onError: ReturnType<typeof makeSpy<(e: unknown) => void>>;
}

function makeSpies(): StateSpies {
  const onStateChange = makeSpy<(s: ConnectionState) => void>();
  const onMessage = makeSpy<(m: ConversationMessage) => void>();
  const onSafetyNumber = makeSpy<(sn: string, verified: boolean) => void>();
  const onError = makeSpy<(e: unknown) => void>();
  return { onStateChange, onMessage, onSafetyNumber, onError };
}

function spiesToHandlers(spies: StateSpies): OrchestratorHandlers {
  return {
    onStateChange: spies.onStateChange.fn,
    onMessage: spies.onMessage.fn,
    onSafetyNumber: spies.onSafetyNumber.fn,
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

async function tick(ms = 50): Promise<void> {
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

async function makeHandshakePair(): Promise<{
  initiator: OrchestratorKit;
  responder: OrchestratorKit;
}> {
  const initiator = await makeOrchestrator();
  const responder = await makeOrchestrator();
  const invitation = await initiator.orchestrator.start();
  await responder.orchestrator.join(invitation);

  const { a, b } = linkLoopbackPair();
  initiator.orchestrator.attachTransport(a);
  responder.orchestrator.attachTransport(b);

  await waitForConnected(initiator.orchestrator);
  await waitForConnected(responder.orchestrator);
  return { initiator, responder };
}

function isOrchError(e: unknown, code: OrchestratorErrorCode): boolean {
  return e instanceof OrchestratorError && e.code === code;
}

describe("ConversationOrchestrator — resume, signaling, drop/retry (slice 3c)", () => {
  describe("getHistory", () => {
    it("returns persisted messages in chronological order after an exchange", async () => {
      const { initiator, responder } = await makeHandshakePair();

      await initiator.orchestrator.sendText("one");
      await tick();
      await responder.orchestrator.sendText("two");
      await tick();
      await initiator.orchestrator.sendText("three");
      await tick();

      const history = await initiator.orchestrator.getHistory();
      expect(history.map((m) => ({ text: m.text, direction: m.direction }))).toEqual([
        { text: "one", direction: "sent" },
        { text: "two", direction: "received" },
        { text: "three", direction: "sent" },
      ]);
    });

    it("resume: a NEW orchestrator reading the SAME repo returns prior messages", async () => {
      const { initiator, responder } = await makeHandshakePair();
      await initiator.orchestrator.sendText("hello");
      await tick();
      // The responder's repo holds the message as 'received'.
      const responderRepo = responder.repository;
      const responderIdentity = responder.identity;

      // Simulate a reconnect: brand-new orchestrator, same identity+repo.
      // The resumed orchestrator join()s the original invitation so its
      // conversation id matches the persisted one; the repo (shared) already
      // holds the prior messages.
      const resumed = await makeOrchestrator({
        repository: responderRepo,
        identity: responderIdentity,
      });
      await resumed.orchestrator.join(initiator.orchestrator.invitation!);
      const history = await resumed.orchestrator.getHistory();
      expect(history.length).toBeGreaterThanOrEqual(1);
      expect(history.some((m) => m.text === "hello" && m.direction === "received")).toBe(true);
    });
  });

  describe("resume identity match (TOFU resume)", () => {
    it("a second handshake round on the same identities connects with NO IdentityChanged", async () => {
      const { initiator, responder } = await makeHandshakePair();
      const firstSafetyNumber = initiator.orchestrator.safetyNumber;
      expect(firstSafetyNumber).not.toBeNull();
      // Both repos now store each other's identity.
      const initStored = await initiator.repository.getPeerIdentity(
        initiator.orchestrator.conversationId!,
      );
      const respStored = await responder.repository.getPeerIdentity(
        responder.orchestrator.conversationId!,
      );
      expect(initStored).not.toBeNull();
      expect(respStored).not.toBeNull();

      // Tear down both sides.
      initiator.orchestrator.leave();
      responder.orchestrator.leave();
      await tick();

      // Build fresh orchestrators sharing identities + repos (the resume case).
      const initiator2 = await makeOrchestrator({
        repository: initiator.repository,
        identity: initiator.identity,
      });
      const responder2 = await makeOrchestrator({
        repository: responder.repository,
        identity: responder.identity,
      });
      // Drive both sides via join() with the original invitation fragment so
      // they converge on the same conversation id as round 1. (start() would
      // mint a new id, which is wrong for resume.)
      const invitation = initiator.orchestrator.invitation!;
      await responder2.orchestrator.join(invitation);
      await initiator2.orchestrator.join(invitation);

      const { a, b } = linkLoopbackPair();
      initiator2.orchestrator.attachTransport(a);
      responder2.orchestrator.attachTransport(b);

      await waitForConnected(initiator2.orchestrator);
      await waitForConnected(responder2.orchestrator);

      // No IdentityChanged error fired on either side.
      const initErrors = initiator2.spies.onError.calls.map((c) => c[0]);
      const respErrors = responder2.spies.onError.calls.map((c) => c[0]);
      expect(initErrors.some((e) => isOrchError(e, OrchestratorErrorCode.IdentityChanged))).toBe(
        false,
      );
      expect(respErrors.some((e) => isOrchError(e, OrchestratorErrorCode.IdentityChanged))).toBe(
        false,
      );

      // Safety number is identical to round 1.
      expect(initiator2.orchestrator.safetyNumber).toBe(firstSafetyNumber);
      expect(responder2.orchestrator.safetyNumber).toBe(firstSafetyNumber);
    });
  });

  describe("resume fresh keys (safety number stable, session keys fresh)", () => {
    it("safety number is identical across two handshake rounds on the same orchestrator identity", async () => {
      // Round 1: two orchestrators handshake.
      const { initiator, responder } = await makeHandshakePair();
      const firstSafetyNumber = initiator.orchestrator.safetyNumber;
      expect(firstSafetyNumber).not.toBeNull();
      await initiator.orchestrator.sendText("round-one");
      await tick();

      // Tear down BOTH sides so we can re-handshake cleanly.
      initiator.orchestrator.leave();
      responder.orchestrator.leave();
      await tick();

      // Round 2: fresh orchestrators, same identities + repos (resume).
      const initiator2 = await makeOrchestrator({
        repository: initiator.repository,
        identity: initiator.identity,
      });
      const responder2 = await makeOrchestrator({
        repository: responder.repository,
        identity: responder.identity,
      });
      const invitation = initiator.orchestrator.invitation!;
      await initiator2.orchestrator.join(invitation);
      await responder2.orchestrator.join(invitation);

      const { a, b } = linkLoopbackPair();
      initiator2.orchestrator.attachTransport(a);
      responder2.orchestrator.attachTransport(b);

      await waitForConnected(initiator2.orchestrator);
      await waitForConnected(responder2.orchestrator);

      // Safety number is stable across resumption (derived from identity keys
      // + conversation id, not session keys).
      expect(initiator2.orchestrator.safetyNumber).toBe(firstSafetyNumber);

      // Session keys are fresh: a new encrypted frame decrypts correctly,
      // proving the receiver's recvKey changed with the sender's new ephemeral
      // sendKey (otherwise decryption would fail).
      await initiator2.orchestrator.sendText("round-two-fresh-keys");
      await tick();
      const received = responder2.spies.onMessage.calls
        .map((c) => c[0].text)
        .filter((t) => t === "round-two-fresh-keys");
      expect(received).toEqual(["round-two-fresh-keys"]);
    });
  });

  describe("identity change on resume blocks", () => {
    it("reconnecting with a DIFFERENT peer identity throws IdentityChanged", async () => {
      const { initiator, responder } = await makeHandshakePair();
      const invitation = initiator.orchestrator.invitation!;
      const responderRepo = responder.repository;

      // Pre-seed the responder repo with a DIFFERENT peer identity (P2) than
      // the real initiator identity (P1). On reconnect, the stored key will
      // not match the incoming identity.
      const bogusIdentity = await generateIdentityKeyPair();
      const bogusKey = encodePublicKey(bogusIdentity.publicKey);
      await responderRepo.storePeerIdentity(
        responder.orchestrator.conversationId!,
        "00 00 00 00 00 00",
        bogusKey,
      );

      // New responder orchestrator sharing the repo (now seeded with P2).
      const responder2 = await makeOrchestrator({
        repository: responderRepo,
        identity: responder.identity,
      });
      // New initiator orchestrator with the REAL P1 identity.
      const initiator2 = await makeOrchestrator({
        repository: initiator.repository,
        identity: initiator.identity,
      });

      await initiator2.orchestrator.join(invitation);
      await responder2.orchestrator.join(invitation);

      const { a, b } = linkLoopbackPair();
      initiator2.orchestrator.attachTransport(a);
      responder2.orchestrator.attachTransport(b);

      await tick(100);

      expect(responder2.orchestrator.state).not.toBe(ConnectionState.Connected);
      const errors = responder2.spies.onError.calls.map((c) => c[0]);
      expect(errors.some((e) => isOrchError(e, OrchestratorErrorCode.IdentityChanged))).toBe(true);
    });
  });

  describe("leave clears ephemeral state + persists history", () => {
    it("after leave(), getHistory() still returns prior messages (history survives)", async () => {
      const { initiator } = await makeHandshakePair();
      await initiator.orchestrator.sendText("persisted");
      await tick();
      const conversationId = initiator.orchestrator.conversationId!;

      initiator.orchestrator.leave();

      const messages = await initiator.repository.getMessages(conversationId);
      expect(messages.map((m) => m.text)).toContain("persisted");
    });

    it("after leave(), sendText throws NotConnected (session torn down)", async () => {
      const { initiator } = await makeHandshakePair();

      initiator.orchestrator.leave();

      await expect(initiator.orchestrator.sendText("x")).rejects.toMatchObject({
        code: OrchestratorErrorCode.NotConnected,
      });
    });

    it("leave() is idempotent (safe to call twice)", async () => {
      const { initiator } = await makeHandshakePair();

      expect(() => {
        initiator.orchestrator.leave();
        initiator.orchestrator.leave();
      }).not.toThrow();
      expect(initiator.orchestrator.state).toBe(ConnectionState.Disconnected);
    });
  });

  describe("retry from Disconnected", () => {
    it("moves state back to Signaling after a drop", async () => {
      const { initiator } = await makeHandshakePair();
      initiator.orchestrator.leave();
      expect(initiator.orchestrator.state).toBe(ConnectionState.Disconnected);

      initiator.orchestrator.retry();

      expect(initiator.orchestrator.state).toBe(ConnectionState.Signaling);
    });

    it("retry() from Connected throws (illegal)", async () => {
      const { initiator } = await makeHandshakePair();
      expect(initiator.orchestrator.state).toBe(ConnectionState.Connected);

      expect(() => initiator.orchestrator.retry()).toThrow(OrchestratorError);
    });
  });

  describe("signaling wired (no void hack)", () => {
    it("start() constructs a SignalingClient and sends a broker join with the conversation hex", async () => {
      const { orchestrator, socket } = await makeOrchestrator();

      await orchestrator.start();
      // The SignalingClient only sends `join` once the socket is open.
      socket.serverOpen();

      expect(socket.sent.length).toBeGreaterThanOrEqual(1);
      const joinMessage = parse(socket.sent[0]!);
      expect(joinMessage.t).toBe("join");
      expect(joinMessage.roomId).toMatch(/^[0-9a-f]{32}$/);
      // The roomId equals the conversation id hex.
      const expectedHex = toHex(orchestrator.conversationId!);
      expect(joinMessage.roomId).toBe(expectedHex);
    });

    it("join() also sends a broker join with the parsed conversation hex", async () => {
      const a = await makeOrchestrator();
      const invitation = await a.orchestrator.start();
      a.socket.serverOpen();

      const b = await makeOrchestrator();
      await b.orchestrator.join(invitation);
      b.socket.serverOpen();

      expect(b.socket.sent.length).toBeGreaterThanOrEqual(1);
      const joinMessage = parse(b.socket.sent[0]!);
      expect(joinMessage.t).toBe("join");
      expect(joinMessage.roomId).toBe(parse(a.socket.sent[0]!).roomId);
    });
  });

  describe("onPeerLeave / socket close -> Disconnected", () => {
    it("broker signaling peer-leave transitions the orchestrator to Disconnected", async () => {
      const { orchestrator, socket, spies } = await makeOrchestrator();
      await orchestrator.start();
      socket.serverOpen();
      await tick();
      expect(orchestrator.state).toBe(ConnectionState.Waiting);

      // Deliver a peer-join (offer) so the client marks the peer present,
      // then deliver a close — the SignalingClient.handleClose fires onPeerLeave.
      socket.deliver(JSON.stringify({ t: "offer", sdp: { fake: "sdp" } }));
      await tick();
      // Now simulate the broker closing the socket (peer left).
      socket.serverClose();
      await tick();

      expect(orchestrator.state).toBe(ConnectionState.Disconnected);
      const states = spies.onStateChange.calls.map((c) => c[0]);
      expect(states).toContain(ConnectionState.Disconnected);
    });
  });
});

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}
