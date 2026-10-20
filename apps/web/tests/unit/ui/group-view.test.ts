// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";

import type { GroupId } from "@fuck-eu-chat-control/chat-runtime/group/types";
import type { PublicKey } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import { AuthMode } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import type {
  ChatController,
  ChatControllerState,
} from "@fuck-eu-chat-control/chat-runtime/runtime/chat-controller";
import type {
  ActiveGroupState,
  GroupMemberView,
} from "@fuck-eu-chat-control/chat-runtime/runtime/types";
import { ConnectionState } from "@fuck-eu-chat-control/chat-runtime/signaling/state-machine";

import { GroupView } from "@/features/chat/ui/group-view";

/**
 * Phase 7b (protocol-v2) pins for the group view's new surfaces:
 *
 *   - the header carries the members-sheet trigger (with the member count),
 *     keeps the k/n connected pill, and shows an honest "waiting for
 *     members" hint while zero member links are connected;
 *   - the epoch-bound group safety dialog renders only once a safety number
 *     exists and confirms via `markGroupSafetyVerified`;
 *   - the members sheet lists every member (author badge / "(you)" / link
 *     state), and ONLY the group author sees the confirm-then-remove
 *     affordance, which calls `removeGroupMember` on confirm.
 *
 * Rendered under jsdom with useChat/sonner swapped for harnesses, mirroring
 * tests/unit/ui/chat-view-phase9.test.ts and destructive-confirm.test.ts.
 */

const ID_BYTES = 16;
const PUB_BYTES = 65;

/** Branded-id fixture; the double cast through unknown is the test convention. */
function groupId(n: number): GroupId {
  const bytes = new Uint8Array(ID_BYTES);
  new DataView(bytes.buffer).setUint32(12, n);
  return bytes as unknown as GroupId;
}

function pubKey(fill: number): { pub: PublicKey; hex: string } {
  const bytes = new Uint8Array(PUB_BYTES).fill(fill);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return { pub: bytes as unknown as PublicKey, hex };
}

function member(fill: number, overrides: Partial<GroupMemberView> = {}): GroupMemberView {
  const { pub, hex } = pubKey(fill);
  return {
    identityPub: pub,
    identityPubHex: hex,
    isAuthor: false,
    isSelf: false,
    displayName: "",
    linkState: ConnectionState.Connected,
    ...overrides,
  };
}

function makeGroup(overrides: Partial<ActiveGroupState> = {}): ActiveGroupState {
  const id = groupId(1);
  let groupIdHex = "";
  for (const b of id) groupIdHex += b.toString(16).padStart(2, "0");
  return {
    groupId: id,
    groupIdHex,
    isAuthor: true,
    epoch: 2,
    members: [],
    safetyNumber: "11 22 33 44 55 66",
    safetyNumberVerified: false,
    authMode: AuthMode.SafetyNumberOnly,
    displayName: "test group",
    messages: [],
    invitation: null,
    unread: 0,
    draft: "",
    lastMessagePreview: null,
    lastMessageAt: null,
    ...overrides,
  };
}

/** Harness shared with the hoisted useChat mock below. */
const ctx = vi.hoisted(() => ({
  controller: null as null | unknown,
  state: null as null | ChatControllerState,
}));

vi.mock("@/features/chat/runtime/chat-provider", () => ({
  useChat: () => ({
    controller: ctx.controller,
    state: ctx.state,
    ready: true,
    iceDegraded: false,
  }),
}));

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));

function makeState(overrides: Partial<ChatControllerState>): ChatControllerState {
  return {
    activeConversationId: null,
    sessions: [],
    active: null,
    conversations: [],
    groups: [],
    activeGroupId: null,
    activeGroup: null,
    ready: true,
    error: null,
    connectionState: ConnectionState.Idle,
    conversationId: null,
    invitation: null,
    safetyNumber: null,
    safetyNumberVerified: false,
    messages: [],
    ...overrides,
  };
}

/**
 * Controller double covering exactly the methods GroupView and its children
 * touch. Built structurally then cast through `unknown` (no `any`), per the
 * project's test-fake convention.
 */
function makeController(): {
  readonly controller: ChatController;
  readonly leaveGroup: ReturnType<typeof vi.fn>;
  readonly markGroupSafetyVerified: ReturnType<typeof vi.fn>;
  readonly removeGroupMember: ReturnType<typeof vi.fn>;
  readonly setGroupDraft: ReturnType<typeof vi.fn>;
  readonly setGroupDisplayName: ReturnType<typeof vi.fn>;
  readonly sendGroupText: ReturnType<typeof vi.fn>;
} {
  const leaveGroup = vi.fn();
  const markGroupSafetyVerified = vi.fn();
  const removeGroupMember = vi.fn().mockResolvedValue(undefined);
  const setGroupDraft = vi.fn();
  const setGroupDisplayName = vi.fn();
  const sendGroupText = vi.fn().mockResolvedValue(undefined);
  const controller = {
    leaveGroup,
    markGroupSafetyVerified,
    removeGroupMember,
    setGroupDraft,
    setGroupDisplayName,
    sendGroupText,
    getState: (): ChatControllerState | null => ctx.state,
  } as unknown as ChatController;
  return {
    controller,
    leaveGroup,
    markGroupSafetyVerified,
    removeGroupMember,
    setGroupDraft,
    setGroupDisplayName,
    sendGroupText,
  };
}

/** Three-member group: self (author) + a named connected member + an unnamed connecting one. */
function threeMemberGroup(): ActiveGroupState {
  return makeGroup({
    members: [
      member(0x02, { displayName: "Bob" }),
      member(0x01, { isAuthor: true, isSelf: true, displayName: "Me", linkState: null }),
      member(0x03, { linkState: ConnectionState.Handshaking }),
    ],
  });
}

async function openMembersSheet(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId("group-members"));
  });
}

describe("GroupView header (Phase 7b)", () => {
  beforeEach(() => {
    toasts.success.mockClear();
    toasts.error.mockClear();
  });

  afterEach(cleanup);

  it("renders the members trigger with the member count and the k/n pill", () => {
    const { controller } = makeController();
    ctx.controller = controller;
    ctx.state = makeState({ activeGroup: threeMemberGroup() });

    render(React.createElement(GroupView));

    const trigger = screen.getByTestId("group-members");
    expect(trigger.textContent).toContain("3");
    // One member link Connected, one Handshaking, self has no link: 1/2.
    expect(screen.getByText("1/2 connected")).not.toBeNull();
  });

  it("shows 'waiting for members' while zero member links are connected", () => {
    const { controller } = makeController();
    ctx.controller = controller;
    ctx.state = makeState({
      activeGroup: makeGroup({
        members: [
          member(0x01, { isAuthor: true, isSelf: true, linkState: null }),
          member(0x02, { linkState: ConnectionState.Signaling }),
        ],
      }),
    });

    render(React.createElement(GroupView));

    expect(screen.getByText("waiting for members")).not.toBeNull();
    expect(screen.getByText("0/1 connected")).not.toBeNull();
  });

  it("drops the waiting hint once a member link is connected", () => {
    const { controller } = makeController();
    ctx.controller = controller;
    ctx.state = makeState({ activeGroup: threeMemberGroup() });

    render(React.createElement(GroupView));

    expect(screen.queryByText("waiting for members")).toBeNull();
  });
});

describe("GroupView members sheet", () => {
  beforeEach(() => {
    toasts.success.mockClear();
    toasts.error.mockClear();
  });

  afterEach(cleanup);

  it("lists members author-first with badges, self marker, and link states", async () => {
    const { controller } = makeController();
    ctx.controller = controller;
    ctx.state = makeState({ activeGroup: threeMemberGroup() });

    render(React.createElement(GroupView));
    await openMembersSheet();

    const rows = screen.getAllByTestId("group-member-row");
    expect(rows).toHaveLength(3);
    // Author first regardless of name order; the rest sort by display
    // label — the unnamed "0303…" key prefix precedes "Bob" (digits < letters).
    expect(rows[0]!.textContent).toContain("Me");
    expect(rows[0]!.textContent).toContain("(you)");
    expect(rows[0]!.textContent).toContain("author");
    expect(rows[0]!.textContent).toContain("This device");
    expect(rows[1]!.textContent).toContain("03030303…");
    expect(rows[1]!.textContent).toContain("Connecting");
    expect(rows[2]!.textContent).toContain("Bob");
    expect(rows[2]!.textContent).toContain("Connected");
  });

  it("the author's confirm-then-remove calls removeGroupMember with the member key", async () => {
    const { controller, removeGroupMember } = makeController();
    ctx.controller = controller;
    const group = threeMemberGroup();
    ctx.state = makeState({ activeGroup: group });

    render(React.createElement(GroupView));
    await openMembersSheet();

    // The gate: nothing is removed until the alert dialog confirms.
    fireEvent.click(screen.getByRole("button", { name: "Remove Bob" }));
    expect(removeGroupMember).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByTestId("group-member-remove-confirm"));
    });

    const bob = group.members.find((m) => m.displayName === "Bob")!;
    expect(removeGroupMember).toHaveBeenCalledTimes(1);
    expect(removeGroupMember).toHaveBeenCalledWith(group.groupId, bob.identityPub);
    expect(toasts.success).toHaveBeenCalled();
  });

  it("cancel leaves the member in place", async () => {
    const { controller, removeGroupMember } = makeController();
    ctx.controller = controller;
    ctx.state = makeState({ activeGroup: threeMemberGroup() });

    render(React.createElement(GroupView));
    await openMembersSheet();

    fireEvent.click(screen.getByRole("button", { name: "Remove Bob" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(removeGroupMember).not.toHaveBeenCalled();
  });

  it("a non-author sees a read-only list — no remove affordances", async () => {
    const { controller } = makeController();
    ctx.controller = controller;
    ctx.state = makeState({
      activeGroup: makeGroup({
        isAuthor: false,
        members: [
          member(0x02, { displayName: "Bob" }),
          member(0x01, { isAuthor: true, displayName: "Author" }),
          member(0x03, { isSelf: true, displayName: "Me", linkState: null }),
        ],
      }),
    });

    render(React.createElement(GroupView));
    await openMembersSheet();

    expect(screen.getAllByTestId("group-member-row")).toHaveLength(3);
    expect(screen.queryByTestId("group-member-remove")).toBeNull();
  });
});

describe("GroupView safety dialog", () => {
  beforeEach(() => {
    toasts.success.mockClear();
    toasts.error.mockClear();
  });

  afterEach(cleanup);

  it("renders no verify affordance before a safety number exists", () => {
    const { controller } = makeController();
    ctx.controller = controller;
    ctx.state = makeState({ activeGroup: makeGroup({ safetyNumber: null }) });

    render(React.createElement(GroupView));

    expect(screen.queryByTestId("verify-group")).toBeNull();
  });

  it("shows the epoch-bound number and marks it verified on confirm", async () => {
    const { controller, markGroupSafetyVerified } = makeController();
    ctx.controller = controller;
    const group = makeGroup({ epoch: 7 });
    ctx.state = makeState({ activeGroup: group });

    render(React.createElement(GroupView));

    await act(async () => {
      fireEvent.click(screen.getByTestId("verify-group"));
    });

    const dialog = screen.getByTestId("group-safety-dialog");
    expect(dialog.textContent).toContain("11 22 33 44 55 66");
    expect(dialog.textContent).toContain("epoch 7");
    expect(markGroupSafetyVerified).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByTestId("group-safety-confirm"));
    });

    expect(markGroupSafetyVerified).toHaveBeenCalledTimes(1);
    expect(markGroupSafetyVerified).toHaveBeenCalledWith(group.groupId);
  });
});
