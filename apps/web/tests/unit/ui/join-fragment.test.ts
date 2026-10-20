// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";

import type { ConversationId } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import type { GroupId } from "@fuck-eu-chat-control/chat-runtime/group/types";
import type {
  ChatController,
  ChatControllerState,
} from "@fuck-eu-chat-control/chat-runtime/runtime/chat-controller";
import type {
  ActiveGroupState,
  ActiveSessionState,
} from "@fuck-eu-chat-control/chat-runtime/runtime/types";
import { AuthMode } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import { ConnectionState } from "@fuck-eu-chat-control/chat-runtime/signaling/state-machine";

import { Route } from "@/routes/index";
import { TESTIDS } from "@/features/chat/ui/testids";

/**
 * Phase 7 (protocol-v2 §8) pins: the invitation fragment grammar is identical
 * for pair and group, so a detected `#<hex>(~<code>)?` becomes a PENDING join
 * — the {@link JoinModeDialog} asks "1:1 or group" and the user's pick routes
 * to `joinConversation` vs `joinGroup`. The pre-v2 pins still hold:
 *
 *   - the fragment is consumed AT MOST ONCE per value (consumed-fragment ref,
 *     not a latch), so a failed or dismissed join retries on re-paste;
 *   - the credential-laden fragment is scrubbed from the URL IMMEDIATELY when
 *     consumed — before the user even picks a mode;
 *   - no prompt while a surface (conversation OR group) is active; the link
 *     still prompts after the surface is left.
 *
 * Renders the REAL HomeComponent (via `Route.options.component`) under jsdom
 * with useChat swapped for a reactive harness and AppShell stubbed.
 */

const CONVERSATION_ID_BYTES = 16;

function idFromNumber(n: number): ConversationId {
  const bytes = new Uint8Array(CONVERSATION_ID_BYTES);
  new DataView(bytes.buffer).setUint32(12, n);
  return bytes as unknown as ConversationId;
}

function groupIdFromNumber(n: number): GroupId {
  const bytes = new Uint8Array(CONVERSATION_ID_BYTES);
  new DataView(bytes.buffer).setUint32(12, n);
  return bytes as unknown as GroupId;
}

const ctx = vi.hoisted(() => ({
  controller: null as null | unknown,
  state: null as null | ChatControllerState,
  ready: true,
  listeners: new Set<() => void>(),
}));

function publish(next: ChatControllerState): void {
  ctx.state = next;
  for (const listener of Array.from(ctx.listeners)) listener();
}

vi.mock("@/features/chat/runtime/chat-provider", async () => {
  const React = await import("react");
  return {
    useChat: () => ({
      controller: ctx.controller,
      state: React.useSyncExternalStore(
        (onStoreChange: () => void) => {
          ctx.listeners.add(onStoreChange);
          return () => {
            ctx.listeners.delete(onStoreChange);
          };
        },
        () => ctx.state,
      ),
      ready: ctx.ready,
      iceDegraded: false,
    }),
  };
});

vi.mock("@/features/chat/ui/app-shell", async () => {
  const React = await import("react");
  return {
    AppShell: () => React.createElement("div", { "data-testid": "app-shell" }),
  };
});

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));

const HomeComponent = Route.options.component;
if (HomeComponent === undefined) throw new Error("route component missing");

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

function makeActive(id: ConversationId): ActiveSessionState {
  return {
    id,
    connectionState: ConnectionState.Connected,
    messages: [],
    safetyNumber: null,
    safetyNumberVerified: false,
    invitation: null,
    unread: 0,
    draft: "",
    lastMessagePreview: null,
    lastMessageAt: null,
    transfers: [],
    authFailed: false,
    authMode: AuthMode.SafetyNumberOnly,
  };
}

function makeActiveGroup(groupId: GroupId): ActiveGroupState {
  let groupIdHex = "";
  for (const b of groupId) groupIdHex += b.toString(16).padStart(2, "0");
  return {
    groupId,
    groupIdHex,
    isAuthor: false,
    epoch: 1,
    members: [],
    safetyNumber: null,
    safetyNumberVerified: false,
    authMode: AuthMode.SafetyNumberOnly,
    displayName: null,
    messages: [],
    invitation: null,
    unread: 0,
    draft: "",
    lastMessagePreview: null,
    lastMessageAt: null,
  };
}

const FRAGMENT_A = "a".repeat(32);
const FRAGMENT_B = `${"b".repeat(32)}~654321`;

/** Point jsdom's location at `/#<fragment>` (without dispatching events). */
function setHashFragment(fragment: string): void {
  window.history.replaceState(null, "", `/#${fragment}`);
}

function fireHashChange(): void {
  window.dispatchEvent(new Event("hashchange"));
}

function makeController(): {
  controller: ChatController;
  joinConversation: ReturnType<typeof vi.fn>;
  joinGroup: ReturnType<typeof vi.fn>;
} {
  const joinConversation = vi.fn().mockResolvedValue(undefined);
  const joinGroup = vi.fn().mockResolvedValue(undefined);
  return {
    controller: { joinConversation, joinGroup } as unknown as ChatController,
    joinConversation,
    joinGroup,
  };
}

describe("invitation-fragment join-mode choice (protocol-v2 §8)", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    toasts.error.mockClear();
    ctx.ready = true;
  });

  afterEach(cleanup);

  it("a detected fragment opens the mode dialog and scrubs the hash BEFORE any join runs", () => {
    const { controller, joinConversation, joinGroup } = makeController();
    ctx.controller = controller;
    ctx.state = makeState({});
    setHashFragment(FRAGMENT_A);

    render(React.createElement(HomeComponent));

    // No join fires until the user picks a mode — but the hash is already
    // gone (the credential tail must not sit in the address bar while the
    // decision is pending).
    expect(screen.getByTestId(TESTIDS.joinAsPair)).toBeTruthy();
    expect(screen.getByTestId(TESTIDS.joinAsGroup)).toBeTruthy();
    expect(joinConversation).not.toHaveBeenCalled();
    expect(joinGroup).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("");
  });

  it('"Join as 1:1 conversation" routes to joinConversation with the bare fragment', async () => {
    const { controller, joinConversation, joinGroup } = makeController();
    ctx.controller = controller;
    ctx.state = makeState({});
    setHashFragment(FRAGMENT_B);

    render(React.createElement(HomeComponent));
    await act(async () => {
      fireEvent.click(screen.getByTestId(TESTIDS.joinAsPair));
    });

    expect(joinConversation).toHaveBeenCalledTimes(1);
    expect(joinConversation).toHaveBeenCalledWith(FRAGMENT_B);
    expect(joinGroup).not.toHaveBeenCalled();
    // The dialog closes once the join resolves.
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId(TESTIDS.joinAsPair)).toBeNull();
  });

  it('"Join as group" routes to joinGroup with the same fragment', async () => {
    const { controller, joinConversation, joinGroup } = makeController();
    ctx.controller = controller;
    ctx.state = makeState({});
    setHashFragment(FRAGMENT_A);

    render(React.createElement(HomeComponent));
    await act(async () => {
      fireEvent.click(screen.getByTestId(TESTIDS.joinAsGroup));
    });

    expect(joinGroup).toHaveBeenCalledTimes(1);
    expect(joinGroup).toHaveBeenCalledWith(FRAGMENT_A);
    expect(joinConversation).not.toHaveBeenCalled();
  });

  it("a failed join un-consumes the fragment and keeps the prompt open — re-pasting retries", async () => {
    const joinConversation = vi
      .fn()
      .mockRejectedValueOnce(new Error("dial failed"))
      .mockResolvedValueOnce(undefined);
    const joinGroup = vi.fn().mockResolvedValue(undefined);
    ctx.controller = { joinConversation, joinGroup } as unknown as ChatController;
    ctx.state = makeState({});
    setHashFragment(FRAGMENT_A);

    render(React.createElement(HomeComponent));
    await act(async () => {
      fireEvent.click(screen.getByTestId(TESTIDS.joinAsPair));
    });

    await act(async () => {
      await vi.waitFor(() => {
        expect(toasts.error).toHaveBeenCalledWith(
          "Could not join conversation",
          expect.objectContaining({ description: "dial failed" }),
        );
      });
    });

    // The prompt stays open after a failure so the other mode is one click
    // away; the un-consumed fragment means a re-paste re-prompts too.
    setHashFragment(FRAGMENT_A);
    act(() => {
      fireHashChange();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId(TESTIDS.joinAsPair));
    });
    expect(joinConversation).toHaveBeenCalledTimes(2);
    expect(joinConversation).toHaveBeenLastCalledWith(FRAGMENT_A);
    expect(window.location.hash).toBe("");
  });

  it("does not prompt while a conversation is already active", () => {
    const id = idFromNumber(50);
    const { controller, joinConversation } = makeController();
    ctx.controller = controller;
    ctx.state = makeState({ activeConversationId: id, active: makeActive(id) });
    setHashFragment(FRAGMENT_A);

    render(React.createElement(HomeComponent));
    act(() => {
      fireHashChange();
    });

    expect(screen.queryByTestId(TESTIDS.joinAsPair)).toBeNull();
    expect(joinConversation).not.toHaveBeenCalled();
    // The unconsumed fragment stays in the URL so leaving the active surface
    // can still surface the prompt (same contract as the pre-v2 hook).
    expect(window.location.hash).toBe(`#${FRAGMENT_A}`);
  });

  it("does not prompt while a group is already active", () => {
    const groupId = groupIdFromNumber(60);
    const { controller, joinGroup } = makeController();
    ctx.controller = controller;
    ctx.state = makeState({ activeGroupId: groupId, activeGroup: makeActiveGroup(groupId) });
    setHashFragment(FRAGMENT_A);

    render(React.createElement(HomeComponent));
    act(() => {
      fireHashChange();
    });

    expect(screen.queryByTestId(TESTIDS.joinAsGroup)).toBeNull();
    expect(joinGroup).not.toHaveBeenCalled();
  });

  it("after leaving the joined conversation, re-pasting the SAME link prompts again", async () => {
    const id = idFromNumber(51);
    const { controller, joinConversation } = makeController();
    ctx.controller = controller;
    ctx.state = makeState({});
    setHashFragment(FRAGMENT_A);

    render(React.createElement(HomeComponent));
    await act(async () => {
      fireEvent.click(screen.getByTestId(TESTIDS.joinAsPair));
    });
    expect(joinConversation).toHaveBeenCalledTimes(1);
    await act(async () => {
      await Promise.resolve();
    });

    // The join lands: controller makes the session active...
    act(() => {
      publish(makeState({ activeConversationId: id, active: makeActive(id) }));
    });
    // ...and the user later leaves it (active → none transition un-consumes).
    act(() => {
      publish(makeState({}));
    });

    setHashFragment(FRAGMENT_A);
    act(() => {
      fireHashChange();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId(TESTIDS.joinAsPair));
    });
    expect(joinConversation).toHaveBeenCalledTimes(2);
    expect(joinConversation).toHaveBeenLastCalledWith(FRAGMENT_A);
  });

  it("a different fragment pasted while a prompt is open replaces it", async () => {
    const { controller, joinGroup } = makeController();
    ctx.controller = controller;
    ctx.state = makeState({});
    setHashFragment(FRAGMENT_A);

    render(React.createElement(HomeComponent));
    expect(screen.getByTestId(TESTIDS.joinAsGroup)).toBeTruthy();

    setHashFragment(FRAGMENT_B);
    act(() => {
      fireHashChange();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId(TESTIDS.joinAsGroup));
    });
    expect(joinGroup).toHaveBeenLastCalledWith(FRAGMENT_B);
    expect(window.location.hash).toBe("");
  });

  it("dismissing the prompt un-consumes the fragment so a re-paste re-prompts", async () => {
    const { controller, joinConversation } = makeController();
    ctx.controller = controller;
    ctx.state = makeState({});
    setHashFragment(FRAGMENT_A);

    render(React.createElement(HomeComponent));
    // The dialog's close affordance (X) dismisses without joining.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
    });
    expect(screen.queryByTestId(TESTIDS.joinAsPair)).toBeNull();
    expect(joinConversation).not.toHaveBeenCalled();

    setHashFragment(FRAGMENT_A);
    act(() => {
      fireHashChange();
    });
    expect(screen.getByTestId(TESTIDS.joinAsPair)).toBeTruthy();
  });
});
