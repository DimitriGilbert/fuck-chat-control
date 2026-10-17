// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import * as React from "react";

import type { ConversationId } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import type {
  ChatController,
  ChatControllerState,
} from "@fuck-eu-chat-control/chat-runtime/runtime/chat-controller";
import type { ActiveSessionState } from "@fuck-eu-chat-control/chat-runtime/runtime/types";
import { AuthMode } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import { ConnectionState } from "@fuck-eu-chat-control/chat-runtime/signaling/state-machine";

import { Route } from "@/routes/index";

/**
 * Phase 9.2 pins (R10F6/R11F1 dedup, R11F2):
 *
 *   - the fragment is consumed AT MOST ONCE per value (a consumed-fragment
 *     ref replaces the old permanent `joinedRef` latch), so a failed join
 *     can be retried by re-pasting and a post-leave paste joins again;
 *   - the credential-laden `#<hex>~<code>` fragment is scrubbed from the URL
 *     IMMEDIATELY after being read — before the async join settles — so a
 *     successful join cannot leave it in the address bar / synced history.
 *
 * Renders the REAL HomeComponent (via `Route.options.component`) under jsdom
 * with useChat swapped for a reactive harness (useSyncExternalStore, so
 * `publish()` re-renders like the controller's emit) and AppShell stubbed.
 */

const CONVERSATION_ID_BYTES = 16;

function idFromNumber(n: number): ConversationId {
  const bytes = new Uint8Array(CONVERSATION_ID_BYTES);
  new DataView(bytes.buffer).setUint32(12, n);
  return bytes as unknown as ConversationId;
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

const FRAGMENT_A = "a".repeat(32);
const FRAGMENT_B = `${"b".repeat(32)}~654321`;

/** Point jsdom's location at `/#<fragment>` (without dispatching events). */
function setHashFragment(fragment: string): void {
  window.history.replaceState(null, "", `/#${fragment}`);
}

function fireHashChange(): void {
  window.dispatchEvent(new Event("hashchange"));
}

describe("invitation-fragment joining (R10F6/R11F1/R11F2)", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    toasts.error.mockClear();
    ctx.ready = true;
  });

  afterEach(cleanup);

  it("joins a well-formed fragment and scrubs the hash BEFORE the join settles", () => {
    let settle: () => void = () => {};
    const joinConversation = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    ctx.controller = { joinConversation } as unknown as ChatController;
    ctx.state = makeState({});
    setHashFragment(FRAGMENT_A);

    render(React.createElement(HomeComponent));

    // The join is in flight (never resolved) — yet the hash is already gone:
    // the scrub must not wait for the async join's outcome.
    expect(joinConversation).toHaveBeenCalledTimes(1);
    expect(joinConversation).toHaveBeenCalledWith(FRAGMENT_A);
    expect(window.location.hash).toBe("");

    return act(async () => {
      settle();
    });
  });

  it("a failed join un-consumes the fragment: re-pasting the same link retries", async () => {
    const joinConversation = vi
      .fn()
      .mockRejectedValueOnce(new Error("dial failed"))
      .mockResolvedValueOnce(undefined);
    ctx.controller = { joinConversation } as unknown as ChatController;
    ctx.state = makeState({});
    setHashFragment(FRAGMENT_A);

    render(React.createElement(HomeComponent));
    expect(joinConversation).toHaveBeenCalledTimes(1);

    // Wait for the rejection path (toast + un-consume).
    await act(async () => {
      await vi.waitFor(() => {
        expect(toasts.error).toHaveBeenCalledWith(
          "Could not join conversation",
          expect.objectContaining({ description: "dial failed" }),
        );
      });
    });

    // Re-pasting the SAME link must retry — the permanent joinedRef latch
    // used to kill this for the page's lifetime.
    setHashFragment(FRAGMENT_A);
    act(() => {
      fireHashChange();
    });

    expect(joinConversation).toHaveBeenCalledTimes(2);
    expect(joinConversation).toHaveBeenLastCalledWith(FRAGMENT_A);
    expect(window.location.hash).toBe("");
  });

  it("does not join while a conversation is already active", () => {
    const id = idFromNumber(50);
    const joinConversation = vi.fn().mockResolvedValue(undefined);
    ctx.controller = { joinConversation } as unknown as ChatController;
    ctx.state = makeState({ activeConversationId: id, active: makeActive(id) });
    setHashFragment(FRAGMENT_A);

    render(React.createElement(HomeComponent));
    act(() => {
      fireHashChange();
    });

    expect(joinConversation).not.toHaveBeenCalled();
  });

  it("after leaving the joined conversation, re-pasting the SAME link joins again", async () => {
    const id = idFromNumber(51);
    const joinConversation = vi.fn().mockResolvedValue(undefined);
    ctx.controller = { joinConversation } as unknown as ChatController;
    ctx.state = makeState({});
    setHashFragment(FRAGMENT_A);

    render(React.createElement(HomeComponent));
    expect(joinConversation).toHaveBeenCalledTimes(1);
    await act(async () => {
      await Promise.resolve();
    });

    // The join lands: controller makes the session active...
    act(() => {
      publish(makeState({ activeConversationId: id, active: makeActive(id) }));
    });
    // ...and the user later leaves it (activeId → null transition un-consumes).
    act(() => {
      publish(makeState({}));
    });

    setHashFragment(FRAGMENT_A);
    act(() => {
      fireHashChange();
    });

    // The old boolean latch skipped this join for the page's whole lifetime.
    expect(joinConversation).toHaveBeenCalledTimes(2);
    expect(joinConversation).toHaveBeenLastCalledWith(FRAGMENT_A);
  });

  it("a different fragment pasted later joins on its own", () => {
    const joinConversation = vi.fn().mockResolvedValue(undefined);
    ctx.controller = { joinConversation } as unknown as ChatController;
    ctx.state = makeState({});
    setHashFragment(FRAGMENT_A);

    render(React.createElement(HomeComponent));
    expect(joinConversation).toHaveBeenCalledWith(FRAGMENT_A);

    // The first join failed to produce an active session (still null): a
    // DIFFERENT fragment is not the "same consumed fragment" and joins.
    setHashFragment(FRAGMENT_B);
    act(() => {
      fireHashChange();
    });

    expect(joinConversation).toHaveBeenCalledTimes(2);
    expect(joinConversation).toHaveBeenLastCalledWith(FRAGMENT_B);
    expect(window.location.hash).toBe("");
  });
});
