import { describe, expect, it } from "vitest";

import {
  generateAtRestKey,
  generateIdentityKeyPair,
} from "@fuck-eu-chat-control/chat-runtime/crypto";
import type { IdentityKeyPair } from "@fuck-eu-chat-control/chat-runtime/crypto";
import { encodePublicKey } from "@fuck-eu-chat-control/chat-runtime/protocol/codec";
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

import { linkLoopbackPair, mockSocketFactory, MockSignalingSocket } from "./_helpers";

const SAMPLE_BASE_URL = "https://app.example";
const SIGNATURE_MESSAGE_BYTES = 65;

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

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
  readonly onMessage: ReturnType<typeof makeSpy<(m: { text: string; timestamp: number }) => void>>;
  readonly onSafetyNumber: ReturnType<typeof makeSpy<(sn: string, verified: boolean) => void>>;
  readonly onError: ReturnType<typeof makeSpy<(e: unknown) => void>>;
}

function makeSpies(): StateSpies {
  const onStateChange = makeSpy<(s: ConnectionState) => void>();
  const onMessage = makeSpy<(m: { text: string; timestamp: number }) => void>();
  const onSafetyNumber = makeSpy<(sn: string, verified: boolean) => void>();
  const onError = makeSpy<(e: unknown) => void>();
  return { onStateChange, onMessage, onSafetyNumber, onError };
}

function spiesToHandlers(spies: StateSpies): OrchestratorHandlers {
  return {
    onStateChange: spies.onStateChange.fn,
    onMessage: (message) =>
      spies.onMessage.fn({ text: message.text, timestamp: message.timestamp }),
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

async function tick(ms = 50): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
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

/**
 * Wrap a PeerTransport so the FIRST signature message (65 bytes) that passes
 * through has a byte of its signature field corrupted. The receiver then
 * verifies a signature that does not match the canonical transcript signed by
 * the real identity key — a guaranteed HandshakeSignatureMismatch.
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

describe("ConversationOrchestrator", () => {
  describe("start (initiator invitation)", () => {
    it("returns an invitation link with the # fragment and 32 hex chars", async () => {
      const { orchestrator } = await makeOrchestrator();

      const invitation = await orchestrator.start();

      expect(invitation.startsWith(`${SAMPLE_BASE_URL}#`)).toBe(true);
      const frag = invitation.slice(invitation.indexOf("#") + 1);
      expect(frag).toMatch(/^[0-9a-f]{32}$/);
    });

    it("sets conversationId to a 16-byte value and persists the conversation", async () => {
      const { orchestrator, repository } = await makeOrchestrator();

      await orchestrator.start();

      const id = orchestrator.conversationId;
      expect(id).not.toBeNull();
      expect(id!.length).toBe(16);

      const list = await repository.listConversations();
      expect(list.length).toBe(1);
      expect(bytesEqual(list[0]!.id, id!)).toBe(true);
    });

    it("enters the Waiting state and emits onStateChange", async () => {
      const { orchestrator, spies } = await makeOrchestrator();

      await orchestrator.start();

      expect(orchestrator.state).toBe(ConnectionState.Waiting);
      expect(spies.onStateChange.calls).toContainEqual([ConnectionState.Waiting]);
    });

    it("exposes the invitation via getter after start", async () => {
      const { orchestrator } = await makeOrchestrator();

      expect(orchestrator.invitation).toBeNull();
      const invitation = await orchestrator.start();
      expect(orchestrator.invitation).toBe(invitation);
    });
  });

  describe("join (responder)", () => {
    it("parses the invitation fragment and sets the same conversationId", async () => {
      const a = await makeOrchestrator();
      const b = await makeOrchestrator();
      const invitation = await a.orchestrator.start();

      await b.orchestrator.join(invitation);

      expect(b.orchestrator.conversationId).not.toBeNull();
      expect(bytesEqual(b.orchestrator.conversationId!, a.orchestrator.conversationId!)).toBe(true);
    });

    it("persists the conversation on the responder side", async () => {
      const a = await makeOrchestrator();
      const b = await makeOrchestrator();
      const invitation = await a.orchestrator.start();

      await b.orchestrator.join(invitation);

      const list = await b.repository.listConversations();
      expect(list.length).toBe(1);
      expect(bytesEqual(list[0]!.id, a.orchestrator.conversationId!)).toBe(true);
    });

    it("rejects a malformed fragment with OrchestratorError(MalformedInvitation)", async () => {
      const { orchestrator } = await makeOrchestrator();

      await expect(orchestrator.join("#not-hex-at-all!!")).rejects.toMatchObject({
        code: OrchestratorErrorCode.MalformedInvitation,
      });
    });
  });

  describe("first-contact handshake (two orchestrators, real crypto)", () => {
    it("both sides reach Connected when wired via loopback transports", async () => {
      const { initiator, responder } = await makeHandshakePair();

      expect(initiator.orchestrator.state).toBe(ConnectionState.Connected);
      expect(responder.orchestrator.state).toBe(ConnectionState.Connected);
    });

    it("both sides emit the same safety number via onSafetyNumber", async () => {
      const { initiator, responder } = await makeHandshakePair();

      expect(initiator.spies.onSafetyNumber.calls.length).toBeGreaterThan(0);
      expect(responder.spies.onSafetyNumber.calls.length).toBeGreaterThan(0);
      const initSn = initiator.spies.onSafetyNumber.calls[0]![0];
      const respSn = responder.spies.onSafetyNumber.calls[0]![0];
      expect(initSn).toBe(respSn);
      expect(initSn).toMatch(/^\d{2} \d{2} \d{2} \d{2} \d{2} \d{2}$/);
    });

    it("exposes the same safety number via the getter on both sides", async () => {
      const { initiator, responder } = await makeHandshakePair();

      expect(initiator.orchestrator.safetyNumber).not.toBeNull();
      expect(responder.orchestrator.safetyNumber).not.toBeNull();
      expect(initiator.orchestrator.safetyNumber).toBe(responder.orchestrator.safetyNumber);
      expect(initiator.orchestrator.safetyNumber).toBe(initiator.spies.onSafetyNumber.calls[0]![0]);
    });

    it("emits the safety number as unverified (verified=false) by default", async () => {
      const { initiator } = await makeHandshakePair();

      expect(initiator.spies.onSafetyNumber.calls[0]![1]).toBe(false);
    });

    it("enters Verifying after the peer signature verifies and exits to Connected", async () => {
      // R7/F2: the Verifying state must be surfaced between Handshaking and
      // Connected so the UI can show "Verifying" while TOFU + key derivation
      // (and PAKE confirmation, when negotiated) run.
      const { initiator, responder } = await makeHandshakePair();

      const initStates = initiator.spies.onStateChange.calls.map((c) => c[0]);
      const respStates = responder.spies.onStateChange.calls.map((c) => c[0]);
      // Both sides must have entered Verifying at least once during the
      // handshake and then advanced to Connected.
      expect(initStates).toContain(ConnectionState.Verifying);
      expect(respStates).toContain(ConnectionState.Verifying);
      expect(initiator.orchestrator.state).toBe(ConnectionState.Connected);
      expect(responder.orchestrator.state).toBe(ConnectionState.Connected);
      // Verifying must appear before Connected in the emission order.
      const initVerifyingIdx = initStates.indexOf(ConnectionState.Verifying);
      const initConnectedIdx = initStates.indexOf(ConnectionState.Connected);
      expect(initVerifyingIdx).toBeGreaterThanOrEqual(0);
      expect(initConnectedIdx).toBeGreaterThan(initVerifyingIdx);
    });
  });

  describe("text round-trip", () => {
    it("delivers a sent message to the peer's onMessage handler", async () => {
      const { initiator, responder } = await makeHandshakePair();

      await initiator.orchestrator.sendText("hello");
      await tick();

      expect(responder.spies.onMessage.calls.length).toBe(1);
      expect(responder.spies.onMessage.calls[0]![0].text).toBe("hello");
    });

    it("persists the message in the sender's repo as 'sent'", async () => {
      const { initiator } = await makeHandshakePair();

      await initiator.orchestrator.sendText("hello");

      const messages = await initiator.repository.getMessages(
        initiator.orchestrator.conversationId!,
      );
      expect(messages.length).toBe(1);
      expect(messages[0]!.text).toBe("hello");
      expect(messages[0]!.direction).toBe("sent");
    });

    it("persists the message in the receiver's repo as 'received'", async () => {
      const { initiator, responder } = await makeHandshakePair();

      await initiator.orchestrator.sendText("hello");
      await tick();

      const messages = await responder.repository.getMessages(
        responder.orchestrator.conversationId!,
      );
      expect(messages.length).toBe(1);
      expect(messages[0]!.text).toBe("hello");
      expect(messages[0]!.direction).toBe("received");
    });

    it("preserves order across multiple messages in both directions", async () => {
      const { initiator, responder } = await makeHandshakePair();

      await initiator.orchestrator.sendText("one");
      await tick();
      await responder.orchestrator.sendText("two");
      await tick();
      await initiator.orchestrator.sendText("three");
      await tick();

      // responder receives "one" then "three" from initiator.
      const respReceived = (
        await responder.repository.getMessages(responder.orchestrator.conversationId!)
      )
        .filter((m) => m.direction === "received")
        .map((m) => m.text);
      expect(respReceived).toEqual(["one", "three"]);

      // initiator receives "two" from responder.
      const initReceived = (
        await initiator.repository.getMessages(initiator.orchestrator.conversationId!)
      )
        .filter((m) => m.direction === "received")
        .map((m) => m.text);
      expect(initReceived).toEqual(["two"]);

      // Both sent messages persisted on initiator side in send order.
      const initSent = (
        await initiator.repository.getMessages(initiator.orchestrator.conversationId!)
      )
        .filter((m) => m.direction === "sent")
        .map((m) => m.text);
      expect(initSent).toEqual(["one", "three"]);
    });
  });

  describe("unicode and long text", () => {
    it("round-trips a multi-byte string (emoji + non-BMP) byte-perfectly", async () => {
      const { initiator, responder } = await makeHandshakePair();
      const text = "héllo 🌍 𝕏 世界 — ✅";

      await initiator.orchestrator.sendText(text);
      await tick();

      expect(responder.spies.onMessage.calls[0]![0].text).toBe(text);
    });

    it("round-trips a long string", async () => {
      const { initiator, responder } = await makeHandshakePair();
      const text = "a".repeat(10000);

      await initiator.orchestrator.sendText(text);
      await tick();

      expect(responder.spies.onMessage.calls[0]![0].text).toBe(text);
    });
  });

  describe("sendText before connected", () => {
    it("throws OrchestratorError(NotConnected)", async () => {
      const { orchestrator } = await makeOrchestrator();
      await orchestrator.start();

      await expect(orchestrator.sendText("hello")).rejects.toMatchObject({
        code: OrchestratorErrorCode.NotConnected,
      });
    });
  });

  describe("signature tamper fails the handshake", () => {
    it("the receiver throws OrchestratorError(HandshakeSignatureMismatch) and does not connect", async () => {
      const initiator = await makeOrchestrator();
      const responder = await makeOrchestrator();
      const invitation = await initiator.orchestrator.start();
      await responder.orchestrator.join(invitation);

      const { a, b } = linkLoopbackPair();
      // Corrupt the initiator's signature bytes in transit.
      initiator.orchestrator.attachTransport(tamperFirstSignatureByte(a));
      responder.orchestrator.attachTransport(b);

      await tick(100);

      // The responder received a tampered signature → it does NOT reach Connected
      // and reports HandshakeSignatureMismatch. (The initiator may still reach
      // Connected because the responder's signature it received was untampered;
      // the tamper is one-directional in this test.)
      expect(responder.orchestrator.state).not.toBe(ConnectionState.Connected);
      const responderErrors = responder.spies.onError.calls.map((c) => c[0]);
      expect(
        responderErrors.some((e) =>
          isOrchError(e, OrchestratorErrorCode.HandshakeSignatureMismatch),
        ),
      ).toBe(true);
    });
  });

  describe("TOFU first contact", () => {
    it("stores the peer identity in the responder repo after a successful handshake", async () => {
      const { initiator, responder } = await makeHandshakePair();

      const stored = await responder.repository.getPeerIdentity(
        responder.orchestrator.conversationId!,
      );
      expect(stored).not.toBeNull();
      expect(bytesEqual(stored!.publicKey, initiator.identity.publicKey)).toBe(true);
      expect(stored!.fingerprint).toBe(responder.orchestrator.safetyNumber);
    });

    it("stores the peer identity on both sides", async () => {
      const { initiator, responder } = await makeHandshakePair();

      const onResponder = await responder.repository.getPeerIdentity(
        responder.orchestrator.conversationId!,
      );
      const onInitiator = await initiator.repository.getPeerIdentity(
        initiator.orchestrator.conversationId!,
      );
      expect(onResponder).not.toBeNull();
      expect(onInitiator).not.toBeNull();
      expect(bytesEqual(onResponder!.publicKey, initiator.identity.publicKey)).toBe(true);
      expect(bytesEqual(onInitiator!.publicKey, responder.identity.publicKey)).toBe(true);
    });
  });

  describe("identity change blocks handshake", () => {
    it("throws OrchestratorError(IdentityChanged) when the stored key does not match", async () => {
      const initiator = await makeOrchestrator();
      const responder = await makeOrchestrator();
      const invitation = await initiator.orchestrator.start();
      await responder.orchestrator.join(invitation);

      // Generate a real but different identity keypair to seed the stored record.
      const other = await generateIdentityKeyPair();
      const bogusKey = encodePublicKey(other.publicKey);
      await responder.repository.storePeerIdentity(
        responder.orchestrator.conversationId!,
        "00 00 00 00 00 00",
        bogusKey,
      );

      const { a, b } = linkLoopbackPair();
      initiator.orchestrator.attachTransport(a);
      responder.orchestrator.attachTransport(b);

      await tick(100);

      expect(responder.orchestrator.state).not.toBe(ConnectionState.Connected);
      const errors = responder.spies.onError.calls.map((c) => c[0]);
      expect(errors.some((e) => isOrchError(e, OrchestratorErrorCode.IdentityChanged))).toBe(true);
    });
  });

  describe("markSafetyNumberVerified", () => {
    it("flips the verified flag so a subsequent emission reports verified=true", async () => {
      const { initiator } = await makeHandshakePair();

      expect(initiator.spies.onSafetyNumber.calls[0]![1]).toBe(false);
      const before = initiator.spies.onSafetyNumber.calls.length;

      initiator.orchestrator.markSafetyNumberVerified();

      const newCalls = initiator.spies.onSafetyNumber.calls.slice(before);
      expect(newCalls.length).toBe(1);
      expect(newCalls[0]![1]).toBe(true);
      expect(initiator.orchestrator.isSafetyNumberVerified()).toBe(true);
    });
  });

  describe("leave", () => {
    it("transitions to Disconnected and clears the ephemeral state", async () => {
      const { initiator } = await makeHandshakePair();

      initiator.orchestrator.leave();

      expect(initiator.orchestrator.state).toBe(ConnectionState.Disconnected);
      await expect(initiator.orchestrator.sendText("x")).rejects.toMatchObject({
        code: OrchestratorErrorCode.NotConnected,
      });
    });
  });
});
