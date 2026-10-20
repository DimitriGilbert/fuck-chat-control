import { afterEach, describe, expect, it, vi } from "vitest";

import {
  generateAtRestKey,
  generateIdentityKeyPair,
} from "@fuck-eu-chat-control/chat-runtime/crypto";
import type { IdentityKeyPair } from "@fuck-eu-chat-control/chat-runtime/crypto";
import type { ReceivedFile } from "@fuck-eu-chat-control/chat-runtime/framing";
import {
  derivePairwiseConvId,
  encodeGroupId,
  encodeMembership,
  encodeMembershipBody,
  encodePeerId,
  GroupError,
  GroupErrorCode,
  GroupSession,
  signMembership,
} from "@fuck-eu-chat-control/chat-runtime/group";
import type {
  GroupId,
  GroupMember,
  GroupMembership,
  PeerId,
} from "@fuck-eu-chat-control/chat-runtime/group";
import { ConversationOrchestrator } from "@fuck-eu-chat-control/chat-runtime/orchestrator/orchestrator";
import { CONVERSATION_ID_BYTES } from "@fuck-eu-chat-control/chat-runtime/protocol/limits";
import { AuthMode, ControlSubtype } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import type { PublicKey } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import { ConnectionState } from "@fuck-eu-chat-control/chat-runtime/signaling/state-machine";
import { InMemoryConversationRepository } from "@fuck-eu-chat-control/chat-runtime/store";

import { bytesEqual } from "../crypto/_helpers";
import { linkLoopbackPair, mockSocketFactory, MockSignalingSocket } from "../orchestrator/_helpers";

/**
 * Epoch-gate TOCTOU seam: `handleInboundMembership` suspends on
 * `verifyMembership`, so a higher-epoch list can be adopted while a
 * lower-epoch list's signature check is still in flight. A test may arm
 * `membershipVerifyGate.override` to hold a chosen list's verify open;
 * returning null falls through to the real verifier. Every other export —
 * and every call while the override is unset — passes through untouched.
 */
const membershipVerifyGate = vi.hoisted(() => ({
  override: null as null | ((membership: GroupMembership) => Promise<boolean> | null),
}));

vi.mock("@fuck-eu-chat-control/chat-runtime/group/membership", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@fuck-eu-chat-control/chat-runtime/group/membership")>();
  return {
    ...actual,
    verifyMembership: (membership: GroupMembership): Promise<boolean> =>
      membershipVerifyGate.override?.(membership) ?? actual.verifyMembership(membership),
  };
});

afterEach(() => {
  membershipVerifyGate.override = null;
});

const PEER_AUTHOR = encodePeerId("000000000000000a");
const PEER_B = encodePeerId("000000000000000b");
const PEER_C = encodePeerId("000000000000000c");
const PEER_D = encodePeerId("000000000000000d");
const PEER_X = encodePeerId("00000000000000ff");

function groupId(seed: number): GroupId {
  const bytes = new Uint8Array(CONVERSATION_ID_BYTES);
  for (let i = 0; i < CONVERSATION_ID_BYTES; i++) bytes[i] = (seed * 17 + i) & 0xff;
  return encodeGroupId(bytes);
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

interface SessionSpies {
  readonly onMessage: ReturnType<typeof makeSpy<(p: PublicKey, t: string, ts: number) => void>>;
  readonly onMemberJoined: ReturnType<typeof makeSpy<(m: GroupMember) => void>>;
  readonly onMemberLeft: ReturnType<typeof makeSpy<(p: PublicKey) => void>>;
  readonly onMembershipChanged: ReturnType<typeof makeSpy<(m: GroupMembership) => void>>;
  readonly onFileReceived: ReturnType<typeof makeSpy<(p: PublicKey, f: ReceivedFile) => void>>;
  readonly onLinkState: ReturnType<typeof makeSpy<(p: PeerId, s: ConnectionState) => void>>;
  readonly onError: ReturnType<typeof makeSpy<(e: unknown) => void>>;
}

function makeSpies(): SessionSpies {
  return {
    onMessage: makeSpy<(p: PublicKey, t: string, ts: number) => void>(),
    onMemberJoined: makeSpy<(m: GroupMember) => void>(),
    onMemberLeft: makeSpy<(p: PublicKey) => void>(),
    onMembershipChanged: makeSpy<(m: GroupMembership) => void>(),
    onFileReceived: makeSpy<(p: PublicKey, f: ReceivedFile) => void>(),
    onLinkState: makeSpy<(p: PeerId, s: ConnectionState) => void>(),
    onError: makeSpy<(e: unknown) => void>(),
  };
}

interface MemberKit {
  readonly session: GroupSession;
  readonly identity: IdentityKeyPair;
  readonly repository: InMemoryConversationRepository;
  readonly spies: SessionSpies;
}

async function makeMember(
  gid: GroupId,
  isAuthor: boolean,
  overrides: {
    readonly maxMembers?: number;
    readonly authMode?: AuthMode;
    readonly pakeCode?: string;
    readonly pendingVerifyTimeoutMs?: number;
    readonly displayName?: string;
  } = {},
): Promise<MemberKit> {
  const identity = await generateIdentityKeyPair();
  const repository = new InMemoryConversationRepository(generateAtRestKey());
  const spies = makeSpies();
  const session = new GroupSession({
    groupId: gid,
    identity,
    authMode: overrides.authMode ?? AuthMode.SafetyNumberOnly,
    pakeCode: overrides.pakeCode,
    isAuthor,
    repository,
    maxMembers: overrides.maxMembers,
    pendingVerifyTimeoutMs: overrides.pendingVerifyTimeoutMs,
    displayName: overrides.displayName,
    handlers: {
      onMessage: spies.onMessage.fn,
      onMemberJoined: spies.onMemberJoined.fn,
      onMemberLeft: spies.onMemberLeft.fn,
      onMembershipChanged: spies.onMembershipChanged.fn,
      onFileReceived: spies.onFileReceived.fn,
      onLinkState: spies.onLinkState.fn,
      onError: spies.onError.fn,
    },
  });
  return { session, identity, repository, spies };
}

/** Cross-wire two group sessions on a fresh loopback link. */
function connectSessions(a: GroupSession, aPeerId: PeerId, b: GroupSession, bPeerId: PeerId): void {
  const { a: ta, b: tb } = linkLoopbackPair();
  a.attachLinkTransport(aPeerId, ta);
  b.attachLinkTransport(bPeerId, tb);
}

/**
 * A raw pairwise group-link orchestrator (no GroupSession around it) — used
 * to stand in for a member whose client only needs to carry frames, e.g.
 * feeding crafted membership payloads into another member's session.
 */
async function makeRawLink(
  identity: IdentityKeyPair,
  gid: GroupId,
): Promise<ConversationOrchestrator> {
  const repository = new InMemoryConversationRepository(generateAtRestKey());
  const orchestrator = new ConversationOrchestrator({
    brokerUrl: "wss://broker.example",
    baseUrl: "https://app.example",
    repository,
    socketFactory: mockSocketFactory(new MockSignalingSocket()),
    identity,
    useInternalSignaling: false,
    groupLinkConversationId: (peerIdentityKey: PublicKey) =>
      derivePairwiseConvId(gid, identity.publicKey, peerIdentityKey),
  });
  orchestrator.beginGroupLinkSession();
  return orchestrator;
}

async function waitFor(
  condition: () => boolean,
  what: string,
  timeoutMs = 5000,
  dump?: () => unknown,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}; dump=${JSON.stringify(dump?.() ?? null)}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function memberKeys(members: readonly GroupMember[]): string[] {
  return members.map((m) => Buffer.from(m.identityPub).toString("hex")).sort();
}

/**
 * Bring up a fully-connected 3-member mesh: author + joiners B and C, with
 * every pairwise link attached (A↔B, A↔C, B↔C). Returns once every session
 * holds the epoch-3 list and all six link ends are Connected.
 */
async function makeThreeMemberGroup(gid: GroupId): Promise<{
  author: MemberKit;
  joinerB: MemberKit;
  joinerC: MemberKit;
}> {
  const author = await makeMember(gid, true);
  const joinerB = await makeMember(gid, false);
  const joinerC = await makeMember(gid, false);
  const dump = (): unknown => ({
    authorStates: [PEER_B, PEER_C].map((p) => author.session.linkState(p)),
    bStates: [PEER_AUTHOR, PEER_C].map((p) => joinerB.session.linkState(p)),
    cStates: [PEER_AUTHOR, PEER_B].map((p) => joinerC.session.linkState(p)),
    authorEpoch: author.session.memberEpoch,
    bEpoch: joinerB.session.memberEpoch,
    cEpoch: joinerC.session.memberEpoch,
    authorErrs: author.spies.onError.calls.map((c) => String(c[0])),
    bErrs: joinerB.spies.onError.calls.map((c) => String(c[0])),
    cErrs: joinerC.spies.onError.calls.map((c) => String(c[0])),
  });

  connectSessions(author.session, PEER_B, joinerB.session, PEER_AUTHOR);
  await waitFor(() => author.session.memberList.length === 2, "author to adopt B", 5000, dump);
  await waitFor(() => joinerB.session.membership?.epoch === 2, "B to adopt epoch 2", 5000, dump);

  connectSessions(author.session, PEER_C, joinerC.session, PEER_AUTHOR);
  await waitFor(() => author.session.memberList.length === 3, "author to adopt C", 5000, dump);
  await waitFor(() => joinerB.session.membership?.epoch === 3, "B to adopt epoch 3", 5000, dump);
  await waitFor(() => joinerC.session.membership?.epoch === 3, "C to adopt epoch 3", 5000, dump);

  connectSessions(joinerB.session, PEER_C, joinerC.session, PEER_B);
  await waitFor(
    () =>
      joinerB.session.linkState(PEER_C) === ConnectionState.Connected &&
      joinerC.session.linkState(PEER_B) === ConnectionState.Connected,
    "B<->C link to connect",
    5000,
    dump,
  );
  return { author, joinerB, joinerC };
}

describe("GroupSession", () => {
  describe("construction", () => {
    it("seeds the author's member list with its own entry at epoch 1", async () => {
      const gid = groupId(1);
      const author = await makeMember(gid, true);
      expect(author.session.memberEpoch).toBe(1);
      expect(author.session.memberList.length).toBe(1);
      expect(author.session.memberList[0]!.isAuthor).toBe(true);
      expect(bytesEqual(author.session.memberList[0]!.identityPub, author.identity.publicKey)).toBe(
        true,
      );
    });

    it("rejects a PAKE group without a 6-digit code", async () => {
      const gid = groupId(2);
      const identity = await generateIdentityKeyPair();
      const repository = new InMemoryConversationRepository(generateAtRestKey());
      expect(
        () =>
          new GroupSession({
            groupId: gid,
            identity,
            authMode: AuthMode.Pake,
            isAuthor: true,
            repository,
          }),
      ).toThrow(GroupError);
    });

    it("rejects a safety-number group that carries a pakeCode", async () => {
      const gid = groupId(3);
      const identity = await generateIdentityKeyPair();
      const repository = new InMemoryConversationRepository(generateAtRestKey());
      expect(
        () =>
          new GroupSession({
            groupId: gid,
            identity,
            authMode: AuthMode.SafetyNumberOnly,
            pakeCode: "123456",
            isAuthor: true,
            repository,
          }),
      ).toThrow(GroupError);
    });
  });

  describe("membership flow", () => {
    it(
      "grows the list on each completed link and gossips it to every member",
      { timeout: 20000 },
      async () => {
        const gid = groupId(4);
        const { author, joinerB, joinerC } = await makeThreeMemberGroup(gid);

        // Every member holds the same epoch-3 list with identical member keys.
        expect(author.session.memberEpoch).toBe(3);
        const expected = memberKeys([
          { identityPub: author.identity.publicKey, isAuthor: true, displayName: "" },
          { identityPub: joinerB.identity.publicKey, isAuthor: false, displayName: "" },
          { identityPub: joinerC.identity.publicKey, isAuthor: false, displayName: "" },
        ]);
        for (const kit of [author, joinerB, joinerC]) {
          expect(memberKeys(kit.session.memberList)).toEqual(expected);
          expect(kit.session.membership?.epoch).toBe(3);
        }
        // Exactly one author-flagged entry on every side.
        for (const kit of [author, joinerB, joinerC]) {
          expect(kit.session.memberList.filter((m) => m.isAuthor).length).toBe(1);
        }
        // onMembershipChanged fired on the joiners at each epoch bump.
        expect(joinerB.spies.onMembershipChanged.calls.map((c) => c[0].epoch)).toEqual([2, 3]);
        expect(joinerC.spies.onMembershipChanged.calls.map((c) => c[0].epoch)).toEqual([3]);
      },
    );

    it("emits onMemberJoined for added entries on both sides", { timeout: 20000 }, async () => {
      const gid = groupId(5);
      const { author, joinerB, joinerC } = await makeThreeMemberGroup(gid);

      const authorJoined = author.spies.onMemberJoined.calls.map((c) => c[0].identityPub);
      expect(authorJoined.length).toBe(2);
      expect(authorJoined.some((p) => bytesEqual(p, joinerB.identity.publicKey))).toBe(true);
      expect(authorJoined.some((p) => bytesEqual(p, joinerC.identity.publicKey))).toBe(true);
      // JoinerB saw the author, itself, and C arrive via list adoption.
      const bJoined = joinerB.spies.onMemberJoined.calls.map((c) => c[0].identityPub);
      expect(bJoined.some((p) => bytesEqual(p, joinerC.identity.publicKey))).toBe(true);
    });

    it("answers a membership_request with the current list", async () => {
      const gid = groupId(6);
      const author = await makeMember(gid, true);
      const joinerB = await makeMember(gid, false);
      connectSessions(author.session, PEER_B, joinerB.session, PEER_AUTHOR);
      await waitFor(() => joinerB.session.membership?.epoch === 2, "B adopts epoch 2");

      // Re-request over the established link: the author (list holder)
      // answers with the same epoch — a repeat delivery, quietly discarded.
      await joinerB.session.requestMembership(PEER_AUTHOR);
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      expect(joinerB.session.memberEpoch).toBe(2);
    });

    it(
      "computes an identical group safety number on every member",
      { timeout: 20000 },
      async () => {
        const gid = groupId(7);
        const { author, joinerB, joinerC } = await makeThreeMemberGroup(gid);
        await waitFor(
          () =>
            author.session.groupSafetyNumber !== null &&
            joinerB.session.groupSafetyNumber !== null &&
            joinerC.session.groupSafetyNumber !== null,
          "group safety numbers",
        );
        expect(author.session.groupSafetyNumber).toBe(joinerB.session.groupSafetyNumber);
        expect(joinerB.session.groupSafetyNumber).toBe(joinerC.session.groupSafetyNumber);
        expect(author.session.groupSafetyNumber).toMatch(/^\d{2} \d{2} \d{2} \d{2} \d{2} \d{2}$/);
      },
    );
  });

  describe("content fan-out", () => {
    it(
      "sendText reaches every connected member with link-identity attribution",
      { timeout: 20000 },
      async () => {
        const gid = groupId(8);
        const { author, joinerB, joinerC } = await makeThreeMemberGroup(gid);

        await joinerB.session.sendText("hello group");
        await waitFor(
          () =>
            author.spies.onMessage.calls.length === 1 && joinerC.spies.onMessage.calls.length === 1,
          "B's text to fan out",
        );
        expect(bytesEqual(author.spies.onMessage.calls[0]![0], joinerB.identity.publicKey)).toBe(
          true,
        );
        expect(author.spies.onMessage.calls[0]![1]).toBe("hello group");
        expect(bytesEqual(joinerC.spies.onMessage.calls[0]![0], joinerB.identity.publicKey)).toBe(
          true,
        );
        expect(joinerC.spies.onMessage.calls[0]![1]).toBe("hello group");

        await author.session.sendText("author here");
        await waitFor(
          () =>
            joinerB.spies.onMessage.calls.length === 1 &&
            joinerC.spies.onMessage.calls.length === 2,
          "author's text to fan out",
        );
        expect(bytesEqual(joinerB.spies.onMessage.calls[0]![0], author.identity.publicKey)).toBe(
          true,
        );
        expect(joinerB.spies.onMessage.calls[0]![1]).toBe("author here");
      },
    );

    it(
      "persists no conversation or message rows for a full mesh with traffic",
      { timeout: 20000 },
      async () => {
        const gid = groupId(22);
        const { author, joinerB, joinerC } = await makeThreeMemberGroup(gid);

        // Fan text over every verified link: B's message reaches A and C,
        // then A's reaches B and C — every link both sends and receives.
        await joinerB.session.sendText("hello mesh");
        await waitFor(
          () =>
            author.spies.onMessage.calls.length === 1 && joinerC.spies.onMessage.calls.length === 1,
          "B's text to fan out",
        );
        await author.session.sendText("author reply");
        await waitFor(
          () =>
            joinerB.spies.onMessage.calls.length === 1 &&
            joinerC.spies.onMessage.calls.length === 2,
          "author's text to fan out",
        );

        // F1 net check: pairwise link orchestrators run on a non-persisting
        // repository decorator and the group transcript is in-memory only, so
        // the real store holds ZERO group-scoped or pairwise rows — nothing
        // can leak into the resumable list or the export bundle.
        for (const kit of [author, joinerB, joinerC]) {
          expect(await kit.repository.listConversations()).toHaveLength(0);
          const state = kit.repository.serialize();
          expect(state.conversations).toHaveLength(0);
          expect(state.messages).toHaveLength(0);
        }
      },
    );

    it(
      "sendFile runs one transfer per link and attributes the sender",
      { timeout: 20000 },
      async () => {
        const gid = groupId(9);
        const { author, joinerB, joinerC } = await makeThreeMemberGroup(gid);
        const data = new TextEncoder().encode("group file body");

        const transferIds = await joinerB.session.sendFile(data, "hello.txt", "text/plain");
        expect(transferIds.size).toBe(2);
        await waitFor(
          () =>
            author.spies.onFileReceived.calls.length === 1 &&
            joinerC.spies.onFileReceived.calls.length === 1,
          "file fan-out",
        );
        for (const kit of [author, joinerC]) {
          const [sender, file] = kit.spies.onFileReceived.calls[0]!;
          expect(bytesEqual(sender, joinerB.identity.publicKey)).toBe(true);
          expect(file.manifest.name).toBe("hello.txt");
          expect(new TextDecoder().decode(file.data)).toBe("group file body");
        }
      },
    );
  });

  describe("kick", () => {
    it(
      "author kick bumps the epoch, gossips, and closes the removed member's links",
      { timeout: 20000 },
      async () => {
        const gid = groupId(10);
        const { author, joinerB, joinerC } = await makeThreeMemberGroup(gid);

        await author.session.kickMember(joinerC.identity.publicKey);

        expect(author.session.memberEpoch).toBe(4);
        expect(author.session.memberList.length).toBe(2);
        await waitFor(() => joinerB.session.membership?.epoch === 4, "B adopts kick epoch");
        expect(joinerB.session.memberList.length).toBe(2);
        // B's link to the removed member is closed (§4.2).
        await waitFor(() => joinerB.session.linkState(PEER_C) === null, "B's link to C closes");
        // The kicked member learned of its removal and left: all its links die.
        await waitFor(() => joinerC.session.linkCount === 0, "C leaves the group");
        // onMemberLeft fired on both remaining sessions.
        const leftA = author.spies.onMemberLeft.calls.map((c) => c[0]);
        const leftB = joinerB.spies.onMemberLeft.calls.map((c) => c[0]);
        expect(leftA.some((p) => bytesEqual(p, joinerC.identity.publicKey))).toBe(true);
        expect(leftB.some((p) => bytesEqual(p, joinerC.identity.publicKey))).toBe(true);
        // The new epoch advanced the group safety number.
        expect(author.session.groupSafetyNumber).not.toBeNull();
        await waitFor(
          () => joinerB.session.groupSafetyNumber === author.session.groupSafetyNumber,
          "post-kick safety number convergence",
        );
      },
    );

    it(
      "rejects kickMember on a non-author session with NotAuthor",
      { timeout: 20000 },
      async () => {
        const gid = groupId(11);
        const { joinerB, joinerC } = await makeThreeMemberGroup(gid);
        await expect(joinerB.session.kickMember(joinerC.identity.publicKey)).rejects.toMatchObject({
          code: GroupErrorCode.NotAuthor,
        });
        // The list is untouched.
        expect(joinerB.session.memberEpoch).toBe(3);
        expect(joinerB.session.memberList.length).toBe(3);
      },
    );
  });

  describe("membership list rules", () => {
    it(
      "flags an unlisted link open, then closes it when a newer list still excludes it (UnknownLinkIdentity)",
      { timeout: 20000 },
      async () => {
        const gid = groupId(12);
        const author = await makeMember(gid, true);
        const joinerB = await makeMember(gid, false);
        const stranger = await makeMember(gid, false);
        connectSessions(author.session, PEER_B, joinerB.session, PEER_AUTHOR);
        await waitFor(() => joinerB.session.membership?.epoch === 2, "B adopts epoch 2");

        // §4.2: the stranger's identity is not in B's adopted {author, B}
        // list — the link is FLAGGED, not closed: it must survive until a
        // newer list still excludes it (or the pending-verify backstop).
        connectSessions(joinerB.session, PEER_X, stranger.session, PEER_D);
        await waitFor(
          () => joinerB.session.linkState(PEER_X) === ConnectionState.Connected,
          "flagged stranger link connects",
        );
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        expect(joinerB.session.linkState(PEER_X)).toBe(ConnectionState.Connected);

        // A newer list (author adds C, epoch 3) still excludes the stranger:
        // B now closes the flagged link.
        const joinerC = await makeMember(gid, false);
        connectSessions(author.session, PEER_C, joinerC.session, PEER_AUTHOR);
        await waitFor(() => joinerB.session.membership?.epoch === 3, "B adopts epoch 3");
        await waitFor(
          () => joinerB.session.linkState(PEER_X) === null,
          "B closes the still-unlisted link on the newer epoch",
        );
        const errors = joinerB.spies.onError.calls.map((c) => c[0]);
        expect(
          errors.some(
            (e) => e instanceof GroupError && e.code === GroupErrorCode.UnknownLinkIdentity,
          ),
        ).toBe(true);
        // B's closeLink emits a leave frame then tears the transport down;
        // on the loopback double the synchronous close wins the race and the
        // stranger's side sees no close notification (PeerTransport carries
        // none) — the stranger's link record lingers in-test exactly as the
        // leave() test documents. The spec'd behavior — B evicts a
        // still-unlisted link on the newer epoch — is what is asserted.
      },
    );

    it(
      "keeps an unlisted link open and graduates it when the covering epoch lands",
      { timeout: 20000 },
      async () => {
        const gid = groupId(17);
        const author = await makeMember(gid, true);
        const joinerB = await makeMember(gid, false);
        const joinerC = await makeMember(gid, false);
        connectSessions(author.session, PEER_B, joinerB.session, PEER_AUTHOR);
        await waitFor(() => joinerB.session.membership?.epoch === 2, "B adopts epoch 2");

        // B<->C connects BEFORE B learns of C's join: B flags the link (§4.2)
        // instead of closing it. C, holding no list yet, requests one and
        // adopts B's stale pre-join {author, B} list — which lacks C, so C
        // must NOT self-eject.
        connectSessions(joinerB.session, PEER_C, joinerC.session, PEER_B);
        await waitFor(() => joinerC.session.membership?.epoch === 2, "C adopts the stale list");
        await waitFor(
          () =>
            joinerB.session.linkState(PEER_C) === ConnectionState.Connected &&
            joinerC.session.linkState(PEER_B) === ConnectionState.Connected,
          "B<->C links stay connected while C is unlisted",
        );
        // B did not evict C: the flagged link survived.
        expect(
          joinerB.spies.onError.calls.some(
            (c) => c[0] instanceof GroupError && c[0].code === GroupErrorCode.UnknownLinkIdentity,
          ),
        ).toBe(false);

        // C's join commits on the author: epoch 3 covers C, is gossiped to
        // both — B's flagged link graduates to verified, C adopts itself.
        connectSessions(author.session, PEER_C, joinerC.session, PEER_AUTHOR);
        await waitFor(() => joinerC.session.membership?.epoch === 3, "C adopts its own epoch");
        await waitFor(() => joinerB.session.membership?.epoch === 3, "B adopts epoch 3");
        expect(joinerC.session.memberList.length).toBe(3);
        await joinerC.session.sendText("i am in");
        await waitFor(
          () => joinerB.spies.onMessage.calls.length === 1,
          "C's text reaches B over the graduated link",
        );
        expect(joinerB.spies.onMessage.calls[0]![1]).toBe("i am in");
      },
    );

    it("discards a list that fails the author signature check", { timeout: 20000 }, async () => {
      const gid = groupId(13);
      const author = await makeMember(gid, true);
      const joinerB = await makeMember(gid, false);
      const forgedBy = await generateIdentityKeyPair();
      connectSessions(author.session, PEER_B, joinerB.session, PEER_AUTHOR);
      await waitFor(() => joinerB.session.membership?.epoch === 2, "B adopts epoch 2");

      // A raw link authenticating as a MEMBER can carry frames B accepts at
      // the transport layer; the forged list inside must still be dropped
      // because its signature does not verify against the author entry.
      const carol = await generateIdentityKeyPair();
      const rawCarolToAuthor = await makeRawLink(carol, gid);
      {
        const { a, b } = linkLoopbackPair();
        author.session.attachLinkTransport(PEER_C, a);
        rawCarolToAuthor.attachTransport(b);
        await waitFor(() => author.session.memberEpoch === 3, "author adopts carol");
        await waitFor(() => joinerB.session.membership?.epoch === 3, "B adopts epoch 3");
      }
      const rawCarolToB = await makeRawLink(carol, gid);
      {
        const { a, b } = linkLoopbackPair();
        joinerB.session.attachLinkTransport(PEER_C, a);
        rawCarolToB.attachTransport(b);
        await waitFor(
          () => rawCarolToB.state === ConnectionState.Connected,
          "raw member link to connect",
        );
        const members = joinerB.session.memberList;
        const body = encodeMembershipBody(gid, 9, [...members]);
        const forged = encodeMembership({
          groupId: gid,
          epoch: 9,
          members: [...members],
          signature: await signMembership(body, forgedBy.privateKey),
        });
        await rawCarolToB.sendControlFrame(ControlSubtype.GroupMembership, forged);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      expect(joinerB.session.memberEpoch).toBe(3);
      const errors = joinerB.spies.onError.calls.map((c) => c[0]);
      expect(
        errors.some((e) => e instanceof GroupError && e.code === GroupErrorCode.MembershipInvalid),
      ).toBe(true);
      rawCarolToAuthor.leave();
      rawCarolToB.leave();
    });

    it(
      "rejects a forged self-authored list at any epoch, and a max-epoch forgery does not brick later honest lists",
      { timeout: 20000 },
      async () => {
        const gid = groupId(18);
        const author = await makeMember(gid, true);
        const joinerB = await makeMember(gid, false);
        connectSessions(author.session, PEER_B, joinerB.session, PEER_AUTHOR);
        await waitFor(() => joinerB.session.membership?.epoch === 2, "B adopts epoch 2");

        // Stand a raw link in for a listed member (carol): the wire channel
        // the forgeries arrive over is a genuine member link.
        const carol = await generateIdentityKeyPair();
        const rawCarolToAuthor = await makeRawLink(carol, gid);
        {
          const { a, b } = linkLoopbackPair();
          author.session.attachLinkTransport(PEER_C, a);
          rawCarolToAuthor.attachTransport(b);
          await waitFor(() => author.session.memberEpoch === 3, "author adopts carol");
          await waitFor(() => joinerB.session.membership?.epoch === 3, "B adopts epoch 3");
        }
        const rawCarolToB = await makeRawLink(carol, gid);
        {
          const { a, b } = linkLoopbackPair();
          joinerB.session.attachLinkTransport(PEER_C, a);
          rawCarolToB.attachTransport(b);
          await waitFor(
            () => rawCarolToB.state === ConnectionState.Connected,
            "raw member link to B connects",
          );
          // A member forges a list flagging ITS OWN key as author. The
          // signature verifies (verifyMembership checks the flagged entry),
          // so only the pinned-author check rejects it.
          const usurper = await generateIdentityKeyPair();
          const forgedMembers: GroupMember[] = [
            { identityPub: usurper.publicKey, isAuthor: true, displayName: "usurper" },
            { identityPub: joinerB.identity.publicKey, isAuthor: false, displayName: "" },
          ];
          const body9 = encodeMembershipBody(gid, 9, forgedMembers);
          await rawCarolToB.sendControlFrame(
            ControlSubtype.GroupMembership,
            encodeMembership({
              groupId: gid,
              epoch: 9,
              members: forgedMembers,
              signature: await signMembership(body9, usurper.privateKey),
            }),
          );
          // The takeover-with-max-epoch variant: if adopted it would brick
          // the epoch gate against every honest list forever.
          const bodyMax = encodeMembershipBody(gid, 0xffffffff, forgedMembers);
          await rawCarolToB.sendControlFrame(
            ControlSubtype.GroupMembership,
            encodeMembership({
              groupId: gid,
              epoch: 0xffffffff,
              members: forgedMembers,
              signature: await signMembership(bodyMax, usurper.privateKey),
            }),
          );
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        // Both forgeries were rejected BEFORE adoption — the epoch never
        // moved, so the max-epoch forgery did not wedge the gate.
        expect(joinerB.session.memberEpoch).toBe(3);
        const errors = joinerB.spies.onError.calls.map((c) => c[0]);
        expect(
          errors.filter(
            (e) => e instanceof GroupError && e.code === GroupErrorCode.MembershipInvalid,
          ).length,
        ).toBeGreaterThanOrEqual(2);

        // An honest author-signed list still lands on the next epoch.
        const joinerD = await makeMember(gid, false);
        const members4: GroupMember[] = [
          ...joinerB.session.memberList,
          { identityPub: joinerD.identity.publicKey, isAuthor: false, displayName: "" },
        ];
        const body4 = encodeMembershipBody(gid, 4, members4);
        await rawCarolToB.sendControlFrame(
          ControlSubtype.GroupMembership,
          encodeMembership({
            groupId: gid,
            epoch: 4,
            members: members4,
            signature: await signMembership(body4, author.identity.privateKey),
          }),
        );
        await waitFor(
          () => joinerB.session.memberEpoch === 4,
          "honest epoch 4 adopted after forgeries",
        );
        rawCarolToAuthor.leave();
        rawCarolToB.leave();
      },
    );

    it("requestMembership on a peerId with no established link throws NoEstablishedLink", async () => {
      const gid = groupId(20);
      const joiner = await makeMember(gid, false);
      await expect(joiner.session.requestMembership(PEER_X)).rejects.toMatchObject({
        code: GroupErrorCode.NoEstablishedLink,
      });
    });

    it(
      "propagates announced display names into the signed member list",
      { timeout: 20000 },
      async () => {
        const gid = groupId(19);
        const author = await makeMember(gid, true, { displayName: "alice" });
        const joinerB = await makeMember(gid, false, { displayName: "bob" });
        connectSessions(author.session, PEER_B, joinerB.session, PEER_AUTHOR);

        // B's identity_announcement reaches the author post-Connected; the
        // author folds it into B's entry — either in the initial add or via
        // a re-signed refresh — and gossip converges every member on it.
        await waitFor(() => {
          const entry = author.session.memberList.find((m) =>
            bytesEqual(m.identityPub, joinerB.identity.publicKey),
          );
          return entry?.displayName === "bob";
        }, "author folds B's announced name into the member list");
        await waitFor(() => {
          const entry = joinerB.session.memberList.find((m) =>
            bytesEqual(m.identityPub, joinerB.identity.publicKey),
          );
          return entry?.displayName === "bob";
        }, "B sees its own name in the gossiped list");
        const authorEntry = joinerB.session.memberList.find((m) => m.isAuthor);
        expect(authorEntry?.displayName).toBe("alice");
      },
    );

    it(
      "adopts a higher-epoch list and discards a regressed one (EpochRegression)",
      { timeout: 20000 },
      async () => {
        const gid = groupId(14);
        const author = await makeMember(gid, true);
        const joinerB = await makeMember(gid, false);
        const joinerC = await makeMember(gid, false);
        connectSessions(author.session, PEER_B, joinerB.session, PEER_AUTHOR);
        await waitFor(() => joinerB.session.membership?.epoch === 2, "B adopts epoch 2");

        // Stand a raw link in for C: the author adopts C's identity, then a
        // SECOND raw link instance (same identity — a link orchestrator can
        // only be attached once) feeds B crafted author-signed lists.
        const rawCtoAuthor = await makeRawLink(joinerC.identity, gid);
        {
          const { a, b } = linkLoopbackPair();
          author.session.attachLinkTransport(PEER_C, a);
          rawCtoAuthor.attachTransport(b);
          await waitFor(() => author.session.memberEpoch === 3, "author adopts C via raw link");
        }
        await waitFor(() => joinerB.session.membership?.epoch === 3, "B adopts epoch 3");

        // A genuine author-signed epoch-4 list carrying a new member is adopted.
        const joinerD = await makeMember(gid, false);
        const members4: GroupMember[] = [
          ...joinerB.session.memberList,
          { identityPub: joinerD.identity.publicKey, isAuthor: false, displayName: "d" },
        ];
        const body4 = encodeMembershipBody(gid, 4, members4);
        const list4 = encodeMembership({
          groupId: gid,
          epoch: 4,
          members: members4,
          signature: await signMembership(body4, author.identity.privateKey),
        });
        const rawCtoB = await makeRawLink(joinerC.identity, gid);
        {
          const { a, b } = linkLoopbackPair();
          joinerB.session.attachLinkTransport(PEER_C, a);
          rawCtoB.attachTransport(b);
          await waitFor(
            () => joinerB.session.linkState(PEER_C) === ConnectionState.Connected,
            "B<->rawC link connects",
          );
          await rawCtoB.sendControlFrame(ControlSubtype.GroupMembership, list4);
        }
        await waitFor(() => joinerB.session.memberEpoch === 4, "B adopts epoch 4");
        expect(joinerB.session.memberList.length).toBe(4);

        // A regressed (strictly lower) genuine list is discarded loudly.
        const staleBody = encodeMembershipBody(gid, 2, [
          { identityPub: author.identity.publicKey, isAuthor: true, displayName: "" },
          { identityPub: joinerB.identity.publicKey, isAuthor: false, displayName: "" },
        ]);
        const stale = encodeMembership({
          groupId: gid,
          epoch: 2,
          members: [
            { identityPub: author.identity.publicKey, isAuthor: true, displayName: "" },
            { identityPub: joinerB.identity.publicKey, isAuthor: false, displayName: "" },
          ],
          signature: await signMembership(staleBody, author.identity.privateKey),
        });
        await rawCtoB.sendControlFrame(ControlSubtype.GroupMembership, stale);
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        expect(joinerB.session.memberEpoch).toBe(4);
        const errors = joinerB.spies.onError.calls.map((c) => c[0]);
        expect(
          errors.some((e) => e instanceof GroupError && e.code === GroupErrorCode.EpochRegression),
        ).toBe(true);
        rawCtoAuthor.leave();
        rawCtoB.leave();
      },
    );

    it(
      "discards a stale list whose signature verify resolves after a newer list adopted (epoch-gate TOCTOU)",
      { timeout: 20000 },
      async () => {
        const gid = groupId(21);
        const author = await makeMember(gid, true);
        const joinerB = await makeMember(gid, false);
        const joinerC = await makeMember(gid, false);
        connectSessions(author.session, PEER_B, joinerB.session, PEER_AUTHOR);
        await waitFor(() => joinerB.session.membership?.epoch === 2, "B adopts epoch 2");

        // Seat C in the list (raw link to the author), then stand a second
        // raw link for C in front of B — the wire channel crafted lists
        // arrive over, same pattern as the forged-list tests.
        const rawCtoAuthor = await makeRawLink(joinerC.identity, gid);
        {
          const { a, b } = linkLoopbackPair();
          author.session.attachLinkTransport(PEER_C, a);
          rawCtoAuthor.attachTransport(b);
          await waitFor(() => author.session.memberEpoch === 3, "author adopts C");
          await waitFor(() => joinerB.session.membership?.epoch === 3, "B adopts epoch 3");
        }
        const rawCtoB = await makeRawLink(joinerC.identity, gid);
        {
          const { a, b } = linkLoopbackPair();
          joinerB.session.attachLinkTransport(PEER_C, a);
          rawCtoB.attachTransport(b);
          await waitFor(
            () => joinerB.session.linkState(PEER_C) === ConnectionState.Connected,
            "B<->rawC link connects",
          );
        }

        // Two genuine author-signed lists: epoch 5 adds member D on top of
        // the epoch-4 roster, so a stale epoch-4 adoption after epoch 5
        // produces a visible reversed diff (D "leaves" again).
        const joinerD = await generateIdentityKeyPair();
        const members4: GroupMember[] = [...joinerB.session.memberList];
        const members5: GroupMember[] = [
          ...members4,
          { identityPub: joinerD.publicKey, isAuthor: false, displayName: "" },
        ];
        const body4 = encodeMembershipBody(gid, 4, members4);
        const list4 = encodeMembership({
          groupId: gid,
          epoch: 4,
          members: members4,
          signature: await signMembership(body4, author.identity.privateKey),
        });
        const body5 = encodeMembershipBody(gid, 5, members5);
        const list5 = encodeMembership({
          groupId: gid,
          epoch: 5,
          members: members5,
          signature: await signMembership(body5, author.identity.privateKey),
        });

        // Hold the epoch-4 list's signature verify open inside the gate,
        // deliver the newer list behind it, then release the stale verify —
        // the interleaving the post-verify epoch re-check must catch.
        let resolveStaleVerify: ((ok: boolean) => void) | undefined;
        membershipVerifyGate.override = (membership) => {
          if (membership.epoch !== 4) return null;
          return new Promise<boolean>((resolve) => {
            resolveStaleVerify = resolve;
          });
        };
        try {
          // The epoch-4 list must be parked inside the verify gate before
          // the newer list goes out — inbound frame decryption is async, so
          // wait for the gate rather than assuming the send has landed.
          await rawCtoB.sendControlFrame(ControlSubtype.GroupMembership, list4);
          await waitFor(
            () => resolveStaleVerify !== undefined,
            "epoch-4 list parked in signature verify",
          );
          await rawCtoB.sendControlFrame(ControlSubtype.GroupMembership, list5);
          await waitFor(() => joinerB.session.memberEpoch === 5, "B adopts epoch 5");
          resolveStaleVerify!(true);
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
        } finally {
          membershipVerifyGate.override = null;
        }

        // The stale epoch-4 list is discarded: the epoch stays at 5, the
        // adopted set still carries D, and no reversed join/leave diff fired.
        expect(joinerB.session.memberEpoch).toBe(5);
        expect(joinerB.session.memberList.length).toBe(4);
        expect(joinerB.spies.onMembershipChanged.calls.map((c) => c[0].epoch)).toEqual([2, 3, 5]);
        const joinedD = joinerB.spies.onMemberJoined.calls.filter((c) =>
          bytesEqual(c[0].identityPub, joinerD.publicKey),
        );
        expect(joinedD.length).toBe(1);
        const leftD = joinerB.spies.onMemberLeft.calls.filter((c) =>
          bytesEqual(c[0], joinerD.publicKey),
        );
        expect(leftD.length).toBe(0);
        const errors = joinerB.spies.onError.calls.map((c) => c[0]);
        expect(
          errors.some((e) => e instanceof GroupError && e.code === GroupErrorCode.EpochRegression),
        ).toBe(true);
        rawCtoAuthor.leave();
        rawCtoB.leave();
      },
    );
  });

  describe("limits", () => {
    it("refuses links beyond maxMembers-1 with MemberLimitReached", async () => {
      const gid = groupId(15);
      const author = await makeMember(gid, true, { maxMembers: 2 });
      const joinerB = await makeMember(gid, false);
      const joinerC = await makeMember(gid, false);
      connectSessions(author.session, PEER_B, joinerB.session, PEER_AUTHOR);
      await waitFor(() => author.session.memberList.length === 2, "author adopts B");

      const { a } = linkLoopbackPair();
      expect(() => author.session.attachLinkTransport(PEER_C, a)).toThrow(GroupError);
      try {
        author.session.attachLinkTransport(PEER_C, a);
      } catch (err) {
        expect(err).toBeInstanceOf(GroupError);
        expect((err as GroupError).code).toBe(GroupErrorCode.MemberLimitReached);
      }
      void joinerC;
    });
  });

  describe("leave", () => {
    it("sends leave on every link and tears the session down", { timeout: 20000 }, async () => {
      const gid = groupId(16);
      const { author, joinerB } = await makeThreeMemberGroup(gid);

      joinerB.session.leave();
      expect(joinerB.session.linkCount).toBe(0);
      // B's own links each reported Disconnected before teardown.
      const disconnected = joinerB.spies.onLinkState.calls.filter(
        (c) => c[1] === ConnectionState.Disconnected,
      );
      expect(disconnected.length).toBeGreaterThanOrEqual(2);
      // The Leave control frame is fire-and-forget: on the loopback double
      // the synchronous transport close wins the race and the remote end has
      // no close notification (PeerTransport carries none — the WebRTC layer
      // observes real channel closes). So the author's link stays half-open
      // here; what matters is the member list is unaffected — a dropped link
      // is not a departure, only the author can remove members.
      expect(author.session.memberList.length).toBe(3);
      // leave() is idempotent.
      joinerB.session.leave();
      expect(joinerB.session.linkCount).toBe(0);
    });
  });
});
