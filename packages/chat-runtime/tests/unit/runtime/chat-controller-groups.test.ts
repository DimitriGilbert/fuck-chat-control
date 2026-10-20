import { describe, expect, it } from "vitest";

import { GroupError } from "@fuck-eu-chat-control/chat-runtime/group";
import { encodePeerId } from "@fuck-eu-chat-control/chat-runtime/group";
import type { GroupId } from "@fuck-eu-chat-control/chat-runtime/group";
import { CONVERSATION_ID_BYTES } from "@fuck-eu-chat-control/chat-runtime/protocol/limits";
import { AuthMode } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import { createAtRestKeyManager } from "@fuck-eu-chat-control/chat-runtime/runtime/at-rest-key-manager";
import {
  createChatController,
  type ChatController,
} from "@fuck-eu-chat-control/chat-runtime/runtime/chat-controller";
import { createIdentityManager } from "@fuck-eu-chat-control/chat-runtime/runtime/identity-manager";
import type { IdentityManager } from "@fuck-eu-chat-control/chat-runtime/runtime/identity-manager";
import { ConnectionState } from "@fuck-eu-chat-control/chat-runtime/signaling/state-machine";
import { InMemoryConversationRepository } from "@fuck-eu-chat-control/chat-runtime/store";

import { linkLoopbackPair, mockSocketFactory } from "../orchestrator/_helpers";
import { MockSignalingSocket, parse } from "../signaling/_helpers";
import { bytesEqual, fakeStorage, stubPeerConnectionFactory } from "./_helpers";

const BASE_URL = "https://app.example";
const BROKER_URL = "wss://broker.example";

const PEER_A = encodePeerId("00000000000000aa");
const PEER_B = encodePeerId("00000000000000bb");

interface GroupKit {
  readonly controller: ChatController;
  readonly socket: MockSignalingSocket;
  readonly identityManager: IdentityManager;
}

async function makeController(
  options: { readonly maxGroupMembers?: number } = {},
): Promise<GroupKit> {
  const identityManager = createIdentityManager(fakeStorage());
  await identityManager.ensureLoaded();
  const atRestKeyManager = createAtRestKeyManager(fakeStorage());
  await atRestKeyManager.ensureLoaded();
  const socket = new MockSignalingSocket();
  const controller = createChatController({
    brokerUrl: BROKER_URL,
    baseUrl: BASE_URL,
    identityManager,
    atRestKeyManager,
    repositoryFactory: (key) => new InMemoryConversationRepository(key),
    socketFactory: mockSocketFactory(socket),
    peerConnectionFactory: stubPeerConnectionFactory(),
    iceServers: [],
    maxGroupMembers: options.maxGroupMembers,
  });
  return { controller, socket, identityManager };
}

/** GroupId of the (single) live group on a controller. */
function onlyGroupId(controller: ChatController): GroupId {
  const groups = controller.getState().groups;
  expect(groups).toHaveLength(1);
  return groups[0]!.groupId;
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Seat the controllers' mock sockets (serverOpen relays the join) and attach
 * a loopback pairwise link between the two group sessions — the group
 * analogue of the 1:1 `linkControllers` harness.
 */
async function linkGroups(a: GroupKit, b: GroupKit): Promise<{ groupId: GroupId }> {
  const { invitation } = await a.controller.startGroup();
  await b.controller.joinGroup(invitation);
  const groupId = onlyGroupId(a.controller);
  a.socket.serverOpen();
  b.socket.serverOpen();
  const { a: ta, b: tb } = linkLoopbackPair();
  a.controller.__attachGroupLinkForTest(groupId, PEER_B, ta);
  b.controller.__attachGroupLinkForTest(onlyGroupId(b.controller), PEER_A, tb);
  await waitFor(
    () => a.controller.getState().activeGroup?.members.length === 2,
    "author to adopt joiner",
  );
  await waitFor(
    () => b.controller.getState().activeGroup?.members.length === 2,
    "joiner to adopt epoch-2 list",
  );
  return { groupId };
}

describe("chat-controller group API", () => {
  it("startGroup returns a '#<32hex>' invitation and seeds the author state", async () => {
    const { controller } = await makeController();
    const { invitation } = await controller.startGroup({ name: "cell" });
    const frag = invitation.slice(invitation.lastIndexOf("#") + 1);
    expect(frag).toMatch(/^[0-9a-f]{32}$/);

    const state = controller.getState();
    expect(state.groups).toHaveLength(1);
    expect(state.activeGroupId).not.toBeNull();
    const active = state.activeGroup;
    expect(active).not.toBeNull();
    expect(active!.isAuthor).toBe(true);
    expect(active!.displayName).toBe("cell");
    expect(active!.epoch).toBe(1);
    expect(active!.members).toHaveLength(1);
    expect(active!.members[0]!.isAuthor).toBe(true);
    expect(active!.members[0]!.isSelf).toBe(true);
  });

  it("startGroup with a code mints a '#<hex>~NNNNNN' PAKE invitation", async () => {
    const { controller } = await makeController();
    const { invitation } = await controller.startGroup({ code: "123456" });
    const frag = invitation.slice(invitation.lastIndexOf("#") + 1);
    expect(frag).toMatch(/^[0-9a-f]{32}~\d{6}$/);
    expect(frag.endsWith("~123456")).toBe(true);
    expect(controller.getState().activeGroup!.authMode).toBe(AuthMode.Pake);
  });

  it("joinGroup parses the same fragment grammar and builds a joiner session", async () => {
    const { controller } = await makeController();
    const gid = new Uint8Array(CONVERSATION_ID_BYTES).fill(7);
    const hex = Array.from(gid, (b) => b.toString(16).padStart(2, "0")).join("");
    await controller.joinGroup(`${BASE_URL}#${hex}`);
    const state = controller.getState();
    expect(state.groups).toHaveLength(1);
    expect(state.activeGroup!.isAuthor).toBe(false);
  });

  it("a linked pair adopts the shared membership and routes attributed text", async () => {
    const a = await makeController();
    const b = await makeController();
    const { groupId } = await linkGroups(a, b);

    const bView = b.controller.getState().activeGroup!;
    expect(bView.epoch).toBe(2);
    expect(bView.members).toHaveLength(2);
    const authorEntry = bView.members.find((m) => m.isAuthor)!;
    expect(bytesEqual(authorEntry.identityPub, a.identityManager.get().publicKey)).toBe(true);
    // The joiner's link to the author is Connected in the member view.
    expect(authorEntry.linkState).toBe(ConnectionState.Connected);

    await a.controller.sendGroupText(groupId, "hello group");
    await waitFor(
      () => b.controller.getState().activeGroup?.messages.length === 1,
      "joiner to receive group text",
    );
    const received = b.controller.getState().activeGroup!.messages[0]!;
    expect(received.direction).toBe("received");
    expect(received.text).toBe("hello group");
    expect(bytesEqual(received.senderIdentityPub!, a.identityManager.get().publicKey)).toBe(true);

    // The author's live transcript mirrors the sent message.
    const aView = a.controller.getState().activeGroup!;
    expect(aView.messages.some((m) => m.direction === "sent" && m.text === "hello group")).toBe(
      true,
    );
    // And the group's in-memory transcript holds it.
    const history = await a.controller.getGroupHistory(groupId);
    expect(history.some((m) => m.text === "hello group" && m.direction === "sent")).toBe(true);
  });

  it("removeGroupMember self-ejects the member AND tears its manager down (obs-F)", async () => {
    const a = await makeController();
    const b = await makeController();
    const { groupId } = await linkGroups(a, b);

    await a.controller.removeGroupMember(groupId, b.identityManager.get().publicKey);

    // The kicked member's session self-ejects; the host pairing must have
    // driven manager.leave() — observable as the broker `leave` relay plus a
    // closed signaling socket — and evicted the group record.
    await waitFor(() => b.controller.getState().groups.length === 0, "kicked member to be evicted");
    expect(b.socket.sent.some((raw) => parse(raw).t === "leave")).toBe(true);
    expect(b.socket.closed).toBe(true);

    // The author's epoch bumped and the member list shrank.
    const aView = a.controller.getState().activeGroup!;
    expect(aView.epoch).toBe(3);
    expect(aView.members).toHaveLength(1);
  });

  it("removeGroupMember on a non-author surfaces a typed GroupError", async () => {
    const a = await makeController();
    const b = await makeController();
    const { groupId } = await linkGroups(a, b);
    const bGid = onlyGroupId(b.controller);
    await expect(
      b.controller.removeGroupMember(bGid, a.identityManager.get().publicKey),
    ).rejects.toBeInstanceOf(GroupError);
    void groupId;
  });

  it("plumbs the configured member cap into the session", async () => {
    const { controller } = await makeController({ maxGroupMembers: 2 });
    await controller.startGroup();
    const gid = onlyGroupId(controller);
    const { a: ta } = linkLoopbackPair();
    const { a: tb } = linkLoopbackPair();
    controller.__attachGroupLinkForTest(gid, PEER_A, ta);
    // Cap 2 → at most one outbound link; the second attach throws typed.
    expect(() => controller.__attachGroupLinkForTest(gid, PEER_B, tb)).toThrow(GroupError);
  });

  it("leaveGroup evicts the record and sends the broker leave", async () => {
    const { controller, socket } = await makeController();
    await controller.startGroup();
    socket.serverOpen();
    const gid = onlyGroupId(controller);
    controller.leaveGroup(gid);
    expect(controller.getState().groups).toHaveLength(0);
    expect(controller.getState().activeGroup).toBeNull();
    expect(socket.sent.some((raw) => parse(raw).t === "leave")).toBe(true);
  });

  it("leaveAll tears down live groups", async () => {
    const { controller, socket } = await makeController();
    await controller.startGroup();
    socket.serverOpen();
    controller.leaveAll();
    expect(controller.getState().groups).toHaveLength(0);
    expect(socket.sent.some((raw) => parse(raw).t === "leave")).toBe(true);
  });

  it("dispose tears down live groups", async () => {
    const { controller, socket } = await makeController();
    await controller.startGroup();
    socket.serverOpen();
    controller.dispose();
    expect(socket.sent.some((raw) => parse(raw).t === "leave")).toBe(true);
  });

  it("markGroupSafetyVerified / getGroupSafetyNumber mirror the epoch-bound number", async () => {
    const a = await makeController();
    const b = await makeController();
    const { groupId } = await linkGroups(a, b);
    await waitFor(() => a.controller.getGroupSafetyNumber(groupId) !== null, "group safety number");
    const number = a.controller.getGroupSafetyNumber(groupId);
    expect(number).toMatch(/^(\d{2} ){5}\d{2}$/);
    a.controller.markGroupSafetyVerified(groupId);
    expect(a.controller.getState().activeGroup!.safetyNumberVerified).toBe(true);
    // A membership change (kick) resets the flag — the number is epoch-bound.
    await a.controller.removeGroupMember(groupId, b.identityManager.get().publicKey);
    await waitFor(() => a.controller.getState().activeGroup!.epoch === 3, "epoch bump after kick");
    expect(a.controller.getState().activeGroup!.safetyNumberVerified).toBe(false);
  });

  it("setGroupDisplayName propagates through the session (member entry rename)", async () => {
    const a = await makeController();
    const b = await makeController();
    const { groupId } = await linkGroups(a, b);
    a.controller.setGroupDisplayName(groupId, "Author A");
    await waitFor(
      () => a.controller.getState().activeGroup!.members[0]!.displayName === "Author A",
      "author entry rename",
    );
    await waitFor(
      () =>
        b.controller.getState().activeGroup!.members.find((m) => m.isAuthor)!.displayName ===
        "Author A",
      "joiner to adopt renamed author entry",
    );
  });

  it("group-scoped and pairwise-derived ids stay out of the conversation list", async () => {
    const a = await makeController();
    const b = await makeController();
    await linkGroups(a, b);
    // The resumable list must not surface group-scoped or derived pairwise
    // link ids — and this build persists neither, so the list is empty.
    const listed = await a.controller.listConversations();
    const state = a.controller.getState();
    expect(listed.map((c) => c.id)).toEqual(state.conversations.map((c) => c.id));
    expect(listed).toHaveLength(0);
  });
});
