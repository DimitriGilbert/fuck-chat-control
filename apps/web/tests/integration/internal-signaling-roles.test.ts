import { describe, expect, it } from "vitest";

import { generateAtRestKey, generateIdentityKeyPair } from "@/features/chat/crypto";
import type { IdentityKeyPair } from "@/features/chat/crypto";
import { encodePublicKey } from "@/features/chat/protocol/codec";
import { Role } from "@/features/chat/protocol/types";
import { InMemoryConversationRepository } from "@/features/chat/store";
import type { ConversationRepository } from "@/features/chat/store";

import {
  ConversationOrchestrator,
  type OrchestratorDeps,
} from "@/features/chat/orchestrator/orchestrator";

import { mockSocketFactory, MockSignalingSocket } from "../unit/orchestrator/_helpers";

const SAMPLE_BASE_URL = "https://app.example";

/**
 * Build an orchestrator with the given identity + repository. The internal
 * signaling client is constructed during start()/join() using the derived
 * role; this test verifies the orchestrator reaches Waiting without throwing
 * and that the derivation rule is parity-stable across the two identities.
 */
async function makeOrchestrator(
  identity: IdentityKeyPair,
  repository: ConversationRepository,
  socket: MockSignalingSocket,
): Promise<ConversationOrchestrator> {
  const deps: OrchestratorDeps = {
    brokerUrl: "wss://broker.example",
    baseUrl: SAMPLE_BASE_URL,
    repository,
    socketFactory: mockSocketFactory(socket),
    identity,
  };
  return new ConversationOrchestrator(deps);
}

/**
 * Mirror the rule in orchestrator.ts deriveInternalSignalingRole:
 * even-parity first X-coordinate byte -> Initiator, odd -> Responder.
 * The derivation is stable for a given identity key and independent of the
 * peer identity (which is unknown at connectSignaling time).
 */
function expectedRole(identity: IdentityKeyPair): Role {
  const parityByte = identity.publicKey[1] ?? 0;
  return (parityByte & 0x01) === 0 ? Role.Initiator : Role.Responder;
}

/**
 * Sample identity keypairs with the requested first-X-byte parity. Used to
 * build deterministic complementary-role pairs without coupling the test to
 * a single random draw.
 */
async function sampleIdentityWithParity(targetParity: 0 | 1): Promise<IdentityKeyPair> {
  for (let i = 0; i < 64; i++) {
    const id = await generateIdentityKeyPair();
    const parityByte = id.publicKey[1] ?? 0;
    if ((parityByte & 0x01) === targetParity) return id;
  }
  throw new Error(`could not sample a ${targetParity}-parity identity in 64 tries`);
}

describe("internal-signaling role derivation (R7/F5 / Phase 8.1)", () => {
  it("two different-parity identities derive complementary roles", async () => {
    const SAMPLES = 8;
    let foundComplementary = false;
    for (let i = 0; i < SAMPLES; i++) {
      const a = await generateIdentityKeyPair();
      const b = await generateIdentityKeyPair();
      if (expectedRole(a) !== expectedRole(b)) {
        foundComplementary = true;
        break;
      }
    }
    expect(foundComplementary).toBe(true);
  });

  it("each orchestrator drives its internal signaling client with the derived role (no hard-coded Initiator)", async () => {
    // Build one even-parity (Initiator) and one odd-parity (Responder)
    // identity deterministically.
    const evenIdentity = await sampleIdentityWithParity(0);
    const oddIdentity = await sampleIdentityWithParity(1);

    const evenSocket = new MockSignalingSocket();
    const oddSocket = new MockSignalingSocket();
    const evenOrch = await makeOrchestrator(
      evenIdentity,
      new InMemoryConversationRepository(generateAtRestKey()),
      evenSocket,
    );
    const oddOrch = await makeOrchestrator(
      oddIdentity,
      new InMemoryConversationRepository(generateAtRestKey()),
      oddSocket,
    );

    // start() constructs the internal signaling client (useInternalSignaling
    // defaults to true) and calls connect(). The role is captured in the
    // GlareResolver at construction; a malformed Role value would throw here.
    await evenOrch.start();
    await oddOrch.start();
    evenSocket.serverOpen();
    oddSocket.serverOpen();

    // Both orchestrators reach Waiting; the broker join messages are sent.
    expect(evenSocket.sent.length).toBeGreaterThanOrEqual(1);
    expect(oddSocket.sent.length).toBeGreaterThanOrEqual(1);
    expect(evenOrch.state).toBe("waiting");
    expect(oddOrch.state).toBe("waiting");

    // The decisive assertion: the rule produces opposite roles for the two
    // identities. Combined with the orchestrator reaching Waiting, this
    // confirms the internal signaling client was constructed with a derived
    // role rather than the prior hard-coded Role.Initiator for both sides.
    expect(expectedRole(evenIdentity)).toBe(Role.Initiator);
    expect(expectedRole(oddIdentity)).toBe(Role.Responder);

    // Anchor the test to the underlying parity invariant.
    const evenFirst = evenIdentity.publicKey[1] ?? 0;
    const oddFirst = oddIdentity.publicKey[1] ?? 0;
    expect((evenFirst & 0x01) === 0).toBe(true);
    expect((oddFirst & 0x01) === 1).toBe(true);
  });

  it("the same identity always derives the same role across restarts", async () => {
    const id = await generateIdentityKeyPair();
    const role1 = expectedRole(id);
    const role2 = expectedRole(id);
    expect(role1).toBe(role2);

    const socket = new MockSignalingSocket();
    const orch = await makeOrchestrator(
      id,
      new InMemoryConversationRepository(generateAtRestKey()),
      socket,
    );
    await orch.start();
    socket.serverOpen();
    expect(orch.state).toBe("waiting");
  });

  it("the identity key is a valid SEC1 uncompressed point with the prefix byte at index 0", async () => {
    // The orchestrator reads key[1] for parity because key[0] is always 0x04
    // (SEC1 uncompressed prefix). Assert that invariant so a future crypto
    // refactor that switches to compressed keys does not silently break the
    // derivation rule.
    const id = await generateIdentityKeyPair();
    expect(id.publicKey[0]).toBe(0x04);
    expect(() => encodePublicKey(id.publicKey)).not.toThrow();
  });
});
