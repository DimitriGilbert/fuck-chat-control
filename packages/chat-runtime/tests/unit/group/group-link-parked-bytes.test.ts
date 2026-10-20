import { describe, expect, it } from "vitest";

import {
  generateAtRestKey,
  generateEphemeralKeyPair,
  generateIdentityKeyPair,
} from "@fuck-eu-chat-control/chat-runtime/crypto";
import type { IdentityKeyPair } from "@fuck-eu-chat-control/chat-runtime/crypto";
import { derivePairwiseConvId, encodeGroupId } from "@fuck-eu-chat-control/chat-runtime/group";
import type { GroupId } from "@fuck-eu-chat-control/chat-runtime/group";
import {
  OrchestratorError,
  OrchestratorErrorCode,
} from "@fuck-eu-chat-control/chat-runtime/orchestrator/errors";
import {
  encodeHello,
  type HelloComponents,
} from "@fuck-eu-chat-control/chat-runtime/orchestrator/handshake-codec";
import { ConversationOrchestrator } from "@fuck-eu-chat-control/chat-runtime/orchestrator/orchestrator";
import { encodeSessionId } from "@fuck-eu-chat-control/chat-runtime/protocol/codec";
import {
  CONVERSATION_ID_BYTES,
  PROTOCOL_VERSION,
} from "@fuck-eu-chat-control/chat-runtime/protocol/limits";
import type { PublicKey } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import { ConnectionState } from "@fuck-eu-chat-control/chat-runtime/signaling/state-machine";
import { InMemoryConversationRepository } from "@fuck-eu-chat-control/chat-runtime/store";

import {
  linkLoopbackPair,
  LoopbackPeerTransport,
  mockSocketFactory,
  MockSignalingSocket,
} from "../orchestrator/_helpers";

function groupId(seed: number): GroupId {
  const bytes = new Uint8Array(CONVERSATION_ID_BYTES);
  for (let i = 0; i < CONVERSATION_ID_BYTES; i++) bytes[i] = (seed * 13 + i) & 0xff;
  return encodeGroupId(bytes);
}

async function makePeerHello(identity: IdentityKeyPair): Promise<Uint8Array> {
  const ephemeral = await generateEphemeralKeyPair();
  const components: HelloComponents = {
    protocolVersion: PROTOCOL_VERSION,
    identityPublicKey: identity.publicKey,
    ephemeralPublicKey: ephemeral.publicKey,
    sessionId: encodeSessionId(globalThis.crypto.getRandomValues(new Uint8Array(32))),
  };
  return encodeHello(components);
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

describe("group-link deferred conversation resolution", () => {
  it("fails the handshake when a peer floods the parked-byte buffer past 64 messages", async () => {
    const identity = await generateIdentityKeyPair();
    const peerIdentity = await generateIdentityKeyPair();
    const errors: unknown[] = [];
    // A resolver that never settles keeps the link parked in the deferred
    // conversation-id resolution window, so every subsequent inbound message
    // lands in groupLinkPendingBytes.
    const orchestrator = new ConversationOrchestrator({
      brokerUrl: "wss://broker.example",
      baseUrl: "https://app.example",
      repository: new InMemoryConversationRepository(generateAtRestKey()),
      socketFactory: mockSocketFactory(new MockSignalingSocket()),
      identity,
      useInternalSignaling: false,
      handlers: { onError: (e: unknown) => errors.push(e) },
      groupLinkConversationId: () =>
        new Promise<never>(() => {
          // Never resolves: holds the resolution window open for the test.
        }),
    });
    orchestrator.beginGroupLinkSession();
    const transport = new LoopbackPeerTransport();
    orchestrator.attachTransport(transport);

    // A valid peer Hello enters the deferred-resolution path; the resolver
    // parks, so all further inbound bytes are buffered.
    transport.deliver(await makePeerHello(peerIdentity));
    for (let i = 0; i < 65; i++) {
      transport.deliver(new Uint8Array([0xee]));
    }

    await waitFor(
      () => orchestrator.state === ConnectionState.Disconnected,
      "parked-byte overflow fails the handshake",
    );
    expect(
      errors.some(
        (e) =>
          e instanceof OrchestratorError &&
          e.code === OrchestratorErrorCode.MalformedHandshakeMessage,
      ),
    ).toBe(true);
  });

  it("parks and replays bytes that arrive mid-resolution, then completes the handshake", async () => {
    const gid = groupId(2);
    const alice = await generateIdentityKeyPair();
    const bob = await generateIdentityKeyPair();
    const aErrors: unknown[] = [];
    const bErrors: unknown[] = [];
    let resolveA: (() => void) | null = null;
    const a = new ConversationOrchestrator({
      brokerUrl: "wss://broker.example",
      baseUrl: "https://app.example",
      repository: new InMemoryConversationRepository(generateAtRestKey()),
      socketFactory: mockSocketFactory(new MockSignalingSocket()),
      identity: alice,
      useInternalSignaling: false,
      handlers: { onError: (e: unknown) => aErrors.push(e) },
      // Delayed (not never-resolving) resolver: the window stays open until
      // the test releases it, so bytes sent mid-resolution must be parked.
      groupLinkConversationId: async (peerIdentityKey: PublicKey) => {
        await new Promise<void>((resolve) => {
          resolveA = (): void => resolve();
        });
        return derivePairwiseConvId(gid, alice.publicKey, peerIdentityKey);
      },
    });
    const b = new ConversationOrchestrator({
      brokerUrl: "wss://broker.example",
      baseUrl: "https://app.example",
      repository: new InMemoryConversationRepository(generateAtRestKey()),
      socketFactory: mockSocketFactory(new MockSignalingSocket()),
      identity: bob,
      useInternalSignaling: false,
      handlers: { onError: (e: unknown) => bErrors.push(e) },
      groupLinkConversationId: (peerIdentityKey: PublicKey) =>
        derivePairwiseConvId(gid, bob.publicKey, peerIdentityKey),
    });
    a.beginGroupLinkSession();
    b.beginGroupLinkSession();
    const { a: ta, b: tb } = linkLoopbackPair();
    a.attachTransport(ta);
    b.attachTransport(tb);

    // B's Hello + signature reach A while A's resolver is still gated —
    // they are parked, then replayed once the gate opens.
    await waitFor(() => resolveA !== null, "A's resolver entered");
    resolveA!();
    await waitFor(
      () => a.state === ConnectionState.Connected && b.state === ConnectionState.Connected,
      "both sides connect after the resolution gate opens",
    );
    expect(aErrors.length).toBe(0);
    expect(bErrors.length).toBe(0);
    a.leave();
    b.leave();
  });
});
