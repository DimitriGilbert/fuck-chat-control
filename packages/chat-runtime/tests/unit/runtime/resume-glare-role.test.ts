import { describe, expect, it } from "vitest";

import type { ConversationId } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import { generateAtRestKey } from "@fuck-eu-chat-control/chat-runtime/crypto";
import { InMemoryConversationRepository } from "@fuck-eu-chat-control/chat-runtime/store";
import type { ConversationRepository } from "@fuck-eu-chat-control/chat-runtime/store";
import { createAtRestKeyManager } from "@fuck-eu-chat-control/chat-runtime/runtime/at-rest-key-manager";
import {
  createChatController,
  type ChatController,
} from "@fuck-eu-chat-control/chat-runtime/runtime/chat-controller";
import { createIdentityManager } from "@fuck-eu-chat-control/chat-runtime/runtime/identity-manager";
import type { IdentityManager } from "@fuck-eu-chat-control/chat-runtime/runtime/identity-manager";

import { parse, type MockSignalingSocket } from "../signaling/_helpers";
import {
  negotiatingPeerConnectionFactory,
  SocketPool,
  type NegotiatingPeerConnection,
} from "./_helpers";

const BASE_URL = "https://app.example";
const BROKER_URL = "wss://broker.example";

function fakeStorage() {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (k: string): string | null => store.get(k) ?? null,
    setItem: (k: string, v: string): void => {
      store.set(k, v);
    },
  };
}

/** Macrotask flush so the bridge's async offer path settles between deliveries. */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve));
}

/** Byte-wise lexicographic comparison; sign mirrors `a - b` at the first difference. */
function compareKeys(a: Uint8Array, b: Uint8Array): number {
  const limit = Math.min(a.length, b.length);
  for (let i = 0; i < limit; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}

async function loadedIdentityManager(): Promise<IdentityManager> {
  const manager = createIdentityManager(fakeStorage());
  await manager.ensureLoaded();
  return manager;
}

/**
 * Sample a PAIR of fresh identities and return them in the §3 lexicographic
 * order the resume derivation reads (smaller key = Initiator = impolite).
 * Assigning sides by the OBSERVED ordering of two fresh draws cannot fail:
 * distinct keys always compare one way or the other, so there is no retry
 * budget racing a FIXED peer key's magnitude (a random fixed key may sit at
 * an extreme of the key space, where a requested ordering is rare and a
 * bounded sampler eventually loses the race). Only exact equality — a
 * cryptographic impossibility between fresh P-256 draws — resamples.
 */
async function identityPairSorted(): Promise<{
  smaller: IdentityManager;
  larger: IdentityManager;
}> {
  for (;;) {
    const first = createIdentityManager(fakeStorage());
    await first.ensureLoaded();
    const second = createIdentityManager(fakeStorage());
    await second.ensureLoaded();
    const cmp = compareKeys(first.get().publicKey, second.get().publicKey);
    if (cmp < 0) return { smaller: first, larger: second };
    if (cmp > 0) return { smaller: second, larger: first };
  }
}

interface Side {
  readonly controller: ChatController;
  readonly repository: ConversationRepository;
  readonly pool: SocketPool;
  readonly identity: IdentityManager;
  /** Every peer connection the bridge built, in build order. */
  readonly peers: readonly NegotiatingPeerConnection[];
}

async function makeSide(identity: IdentityManager): Promise<Side> {
  const atRestKeyManager = createAtRestKeyManager(fakeStorage());
  await atRestKeyManager.ensureLoaded();
  const pool = new SocketPool();
  const factory = negotiatingPeerConnectionFactory();
  const repository = new InMemoryConversationRepository(generateAtRestKey());
  const controller = createChatController({
    brokerUrl: BROKER_URL,
    baseUrl: BASE_URL,
    identityManager: identity,
    atRestKeyManager,
    repository,
    // Factory is required by the type but unused when `repository` is set.
    repositoryFactory: () => repository,
    socketFactory: pool.factory,
    peerConnectionFactory: factory.factory,
    iceServers: [],
  });
  return { controller, repository, pool, identity, peers: factory.instances };
}

function roomHex(id: ConversationId): string {
  let hex = "";
  for (let i = 0; i < id.length; i++) hex += id[i].toString(16).padStart(2, "0");
  return hex;
}

function joinMessage(id: ConversationId): string {
  return JSON.stringify({ t: "join", roomId: roomHex(id) });
}

function messagesOfKind(socket: { readonly sent: string[] }, kind: string): number {
  return socket.sent.filter((raw) => parse(raw).t === kind).length;
}

function rawOfKind(socket: { readonly sent: string[] }, kind: string): string | undefined {
  return socket.sent.find((raw) => parse(raw).t === kind);
}

/**
 * Establish the shared conversation on both sides and pin each side's peer
 * identity (TOFU) — the input the §3 resume-role derivation reads — then drop
 * both live sessions and resume both. Returns each side's resume socket (its
 * pool's SECOND dial; the first was the initial start/join).
 */
async function resumePair(sideA: Side, sideB: Side): Promise<{
  aResume: MockSignalingSocket;
  bResume: MockSignalingSocket;
}> {
  const { invitation } = await sideA.controller.startConversation();
  const idA = sideA.controller.getActiveConversationId() as ConversationId;
  await sideB.controller.joinConversation(invitation);
  const idB = sideB.controller.getActiveConversationId() as ConversationId;
  expect(roomHex(idA)).toBe(roomHex(idB));

  await sideA.repository.storePeerIdentity(idA, "fp-peer-b", sideB.identity.get().publicKey);
  await sideB.repository.storePeerIdentity(idB, "fp-peer-a", sideA.identity.get().publicKey);

  sideA.controller.leaveConversation(idA);
  sideB.controller.leaveConversation(idB);
  await sideA.controller.resumeConversation(idA);
  await sideB.controller.resumeConversation(idB);

  const aResume = sideA.pool.sockets[1];
  const bResume = sideB.pool.sockets[1];
  expect(aResume).toBeDefined();
  expect(bResume).toBeDefined();
  aResume.serverOpen();
  bResume.serverOpen();
  expect(messagesOfKind(aResume, "join")).toBe(1);
  expect(messagesOfKind(bResume, "join")).toBe(1);
  return { aResume, bResume };
}

describe("resume glare role derivation (R3F4 / Phase 8) — real broker semantics", () => {
  it("sequential resume where the SEATED side is the derived Responder: an offer originates and the exchange completes", async () => {
    // Real broker semantics: only the FIRST-seated peer is notified when the
    // second joins — the joiner receives nothing. Deliberately seat the
    // derived RESPONDER first (side A is the LARGER key, so §3 derives
    // A = Responder = polite, B = Initiator = impolite). With the
    // offer gated on role === Initiator this exact interleaving deadlocked:
    // the seated Responder never offered and the joiner was never notified —
    // both sides hung in Signaling with no offer on the wire at all.
    const { smaller, larger } = await identityPairSorted();
    const sideA = await makeSide(larger);
    const sideB = await makeSide(smaller);
    const { aResume, bResume } = await resumePair(sideA, sideB);
    const resumedA = sideA.controller.getActiveConversationId() as ConversationId;

    // A is seated (its join landed first); B joins second. The broker
    // notifies ONLY the seated A. B receives nothing.
    aResume.deliver(joinMessage(resumedA));
    await flush();

    // The seated RESPONDER offered. Pre-fix this was 0 — the deadlock: no
    // offer ever existed for anyone to answer.
    expect(messagesOfKind(aResume, "offer")).toBe(1);

    // The broker relays A's offer to B. B never saw a join notification, so
    // the offer itself promotes the peer (R6/F7 auto-promotion) — which
    // fires onPeerJoin and, post-fix, B originates its own offer too. B is
    // the IMPOLITE side with an offer now in flight, so perfect negotiation
    // makes it IGNORE A's offer: the impolite side's offer is the one that
    // survives a collision.
    bResume.deliver(rawOfKind(aResume, "offer") as string);
    await flush();
    expect(messagesOfKind(bResume, "offer")).toBe(1);
    expect(messagesOfKind(bResume, "answer")).toBe(0);

    // B's offer crosses back to A. A is the POLITE side with its own offer
    // in flight: it rolls its own back and answers B's.
    aResume.deliver(rawOfKind(bResume, "offer") as string);
    await flush();
    expect(messagesOfKind(aResume, "answer")).toBe(1);
    const aPeer = sideA.peers[1];
    expect(aPeer).toBeDefined();
    expect(aPeer?.localDescTypes).toContain("rollback");
    expect(aPeer?.remoteDescTypes).toEqual(["offer"]);

    // A's answer returns to B; B's exchange completes. Exactly one offer
    // survived the collision — B's — and it was answered exactly once.
    bResume.deliver(rawOfKind(aResume, "answer") as string);
    await flush();
    const bPeer = sideB.peers[1];
    expect(bPeer).toBeDefined();
    expect(bPeer?.remoteDescTypes).toEqual(["answer"]);

    sideA.controller.dispose();
    sideB.controller.dispose();
  });

  it("crossing rejoin (both seated, both notified): both offer and glare resolves with exactly ONE surviving offer", async () => {
    // The crossing case: each side re-entered the room while the other was
    // seated, so each holds the broker's join notification for the other's
    // re-entry — both sides are seated AND notified, and their offers cross
    // on the wire. Both originate offers (any role may); the glare machinery
    // must leave exactly one exchange standing: the IMPOLITE side (§3
    // smaller key = Initiator) keeps its offer and ignores the polite side's;
    // the POLITE side (Responder) rolls its own back and answers.
    const { smaller, larger } = await identityPairSorted();
    const sideA = await makeSide(smaller);
    const sideB = await makeSide(larger);
    const { aResume, bResume } = await resumePair(sideA, sideB);
    const resumedA = sideA.controller.getActiveConversationId() as ConversationId;

    // Both sides hold their (real) seated-side notification; both offer.
    // Pre-fix only A (the derived Initiator) offered; the fix lets the
    // notified Responder originate too.
    aResume.deliver(joinMessage(resumedA));
    bResume.deliver(joinMessage(resumedA));
    await flush();
    expect(messagesOfKind(aResume, "offer")).toBe(1);
    expect(messagesOfKind(bResume, "offer")).toBe(1);

    // The offers cross: each side receives the other's while its own is
    // still in flight (armed).
    aResume.deliver(rawOfKind(bResume, "offer") as string);
    bResume.deliver(rawOfKind(aResume, "offer") as string);
    await flush();
    await flush();

    // A = Initiator = impolite: it ignored B's offer — no rollback, no
    // answer, nothing applied.
    expect(messagesOfKind(aResume, "answer")).toBe(0);
    const aPeer = sideA.peers[1];
    expect(aPeer).toBeDefined();
    expect(aPeer?.localDescTypes).not.toContain("rollback");
    expect(aPeer?.remoteDescTypes).toHaveLength(0);

    // B = Responder = polite: it rolled its own offer back and answered A's.
    expect(messagesOfKind(bResume, "answer")).toBe(1);
    const bPeer = sideB.peers[1];
    expect(bPeer).toBeDefined();
    expect(bPeer?.localDescTypes).toContain("rollback");
    expect(bPeer?.remoteDescTypes).toContain("offer");

    // Exactly one offer survived — A's; B's died in the rollback. B's answer
    // completes A's exchange.
    aResume.deliver(rawOfKind(bResume, "answer") as string);
    await flush();
    expect(aPeer?.remoteDescTypes).toEqual(["answer"]);

    sideA.controller.dispose();
    sideB.controller.dispose();
  });

  it("retry() where the RE-DIALING side is the derived Responder: the seated peer offers, the re-dialer answers", async () => {
    // A live session drops on both sides. retry() re-dials signaling on each
    // — B first (it becomes the seated peer again), then A. The real broker
    // then notifies ONLY the seated B when A re-joins: B originates the
    // offer, and the re-dialing A (the derived Responder here, its glare
    // latches reset by reconnect) answers the inbound offer instead of
    // putting its own on the wire. §3 ordering: A is the LARGER key, so
    // A = Responder (re-dialer, polite), B = Initiator (seated, impolite).
    const { smaller, larger } = await identityPairSorted();
    const sideA = await makeSide(larger);
    const sideB = await makeSide(smaller);
    const { aResume, bResume } = await resumePair(sideA, sideB);
    const resumedA = sideA.controller.getActiveConversationId() as ConversationId;

    // Phase 1: A seated, B joins → A (Responder) offers. B auto-promotes on
    // the inbound offer and originates its own; the collision resolves in
    // favor of impolite B's offer (A rolls back and answers), as in the
    // sequential test above.
    aResume.deliver(joinMessage(resumedA));
    await flush();
    expect(messagesOfKind(aResume, "offer")).toBe(1);
    bResume.deliver(rawOfKind(aResume, "offer") as string);
    await flush();
    expect(messagesOfKind(bResume, "offer")).toBe(1);
    aResume.deliver(rawOfKind(bResume, "offer") as string);
    await flush();
    expect(messagesOfKind(aResume, "answer")).toBe(1);
    bResume.deliver(rawOfKind(aResume, "answer") as string);
    await flush();

    // Phase 2: A's signaling socket dies (network drop). Real broker
    // semantics: the onClose path notifies the remaining peer — B receives
    // `leave` — and both sides observe the drop and go Disconnected.
    aResume.serverClose();
    bResume.deliver(JSON.stringify({ t: "leave", roomId: roomHex(resumedA) }));
    await flush();
    expect(sideA.controller.getState().active?.connectionState).toBe("disconnected");
    expect(sideB.controller.getState().active?.connectionState).toBe("disconnected");

    // B retries first: fresh signaling socket, fresh peer connection, and it
    // takes the empty room's first seat.
    const resumedB = sideB.controller.getActiveConversationId() as ConversationId;
    sideB.controller.retry(resumedB);
    const bRetry = sideB.pool.sockets[2];
    expect(bRetry).toBeDefined();
    bRetry.serverOpen();
    expect(messagesOfKind(bRetry, "join")).toBe(1);

    // A retries second: it re-joins while B is seated, so the broker
    // notifies ONLY B — B originates the offer. A receives nothing.
    sideA.controller.retry(resumedA);
    const aRetry = sideA.pool.sockets[2];
    expect(aRetry).toBeDefined();
    aRetry.serverOpen();
    expect(messagesOfKind(aRetry, "join")).toBe(1);
    bRetry.deliver(joinMessage(resumedB));
    await flush();
    expect(messagesOfKind(bRetry, "offer")).toBe(1);
    expect(messagesOfKind(aRetry, "offer")).toBe(0);

    // The broker relays B's offer to the re-dialer. A's socket is fresh, so
    // the offer itself promotes the peer (R6/F7) — A briefly originates a
    // nascent offer, but A is POLITE with the inbound offer pending, so it
    // rolls the nascent one back (abandoned before the wire) and answers B.
    aRetry.deliver(rawOfKind(bRetry, "offer") as string);
    await flush();
    expect(messagesOfKind(aRetry, "answer")).toBe(1);
    expect(messagesOfKind(aRetry, "offer")).toBe(0);
    const retryPeer = sideA.peers[2];
    expect(retryPeer).toBeDefined();
    expect(retryPeer?.localDescTypes).toContain("rollback");
    expect(retryPeer?.remoteDescTypes).toEqual(["offer"]);
    expect(sideA.controller.getState().active?.connectionState).toBe("signaling");

    // A's answer returns to B; the re-established exchange completes.
    bRetry.deliver(rawOfKind(aRetry, "answer") as string);
    await flush();
    const bRetryPeer = sideB.peers[2];
    expect(bRetryPeer).toBeDefined();
    expect(bRetryPeer?.remoteDescTypes).toEqual(["answer"]);

    sideA.controller.dispose();
    sideB.controller.dispose();
  });

  it("resuming a conversation with no pinned peer keeps the historical Initiator role", async () => {
    // A record without a TOFU pin (the conversation never completed a
    // handshake) cannot run the §3 two-key derivation — the peer's key is
    // unknown — so the fallback preserves the pre-R3F4 behavior: resume
    // keeps Role.Initiator and offers on peer-join.
    const side = await makeSide(await loadedIdentityManager());
    await side.controller.startConversation();
    const id = side.controller.getActiveConversationId() as ConversationId;
    expect(id).toBeDefined();
    // No storePeerIdentity: record.peer stays null.
    const record = await side.repository.getConversation(id);
    expect(record?.peer).toBeNull();
    side.controller.leaveConversation(id);
    await side.controller.resumeConversation(id);

    const resumeSocket = side.pool.sockets[1];
    expect(resumeSocket).toBeDefined();
    resumeSocket.serverOpen();
    // We are seated; the peer joins second → the broker notifies us.
    resumeSocket.deliver(joinMessage(id));
    await flush();
    expect(messagesOfKind(resumeSocket, "offer")).toBe(1);

    side.controller.dispose();
  });
});
