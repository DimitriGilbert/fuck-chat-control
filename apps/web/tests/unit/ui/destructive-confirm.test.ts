// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";

import type { ConversationId } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import type {
  ChatController,
  ChatControllerState,
} from "@fuck-eu-chat-control/chat-runtime/runtime/chat-controller";
import { ConnectionState } from "@fuck-eu-chat-control/chat-runtime/signaling/state-machine";

import { DeleteConversationDialog } from "@/features/chat/ui/sidebar";
import { WipeDataAlertDialog } from "@/features/chat/ui/wipe-data-dialog";

/**
 * R7/F2 + R7/F4 destructive-clear semantics, pinned at the confirmation
 * dialogs (the seams every destructive surface routes through):
 *
 *   - the sidebar's "Delete conversation" only runs clearConversation after
 *     an explicit confirm, and its toast states the conversation was DELETED;
 *   - the wipe dialog's "current" mode cannot toast success when nothing is
 *     active (clearConversation is a controller no-op in that state);
 *   - "all" mode still clears everything and reports it.
 *
 * Rendered under jsdom with useChat/sonner swapped for per-test harnesses,
 * mirroring tests/unit/runtime/chat-provider-create-race.test.ts. The
 * dropdown wiring (the item OPENS the dialog rather than clearing) is simple
 * state plumbing verified by review; these tests pin the destructive gate
 * itself.
 */

const CONVERSATION_ID_BYTES = 16;

/** Branded-id fixture; the double cast through unknown is the test convention. */
function idFromNumber(n: number): ConversationId {
  const bytes = new Uint8Array(CONVERSATION_ID_BYTES);
  new DataView(bytes.buffer).setUint32(12, n);
  return bytes as unknown as ConversationId;
}

/** Harness shared with the hoisted useChat mock below. */
const ctx = vi.hoisted(() => ({
  controller: null as null | unknown,
  state: null as null | unknown,
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
 * Controller double covering exactly the methods the two dialogs touch.
 * Built structurally then cast through `unknown` (no `any`), per the
 * project's test-fake convention (see auth-mode-surface.test.ts).
 */
function makeController(): {
  readonly controller: ChatController;
  readonly clearConversation: ReturnType<typeof vi.fn>;
  readonly clearAll: ReturnType<typeof vi.fn>;
} {
  const clearConversation = vi.fn().mockResolvedValue(undefined);
  const clearAll = vi.fn().mockResolvedValue(undefined);
  const controller = { clearConversation, clearAll } as unknown as ChatController;
  return { controller, clearConversation, clearAll };
}

describe("sidebar DeleteConversationDialog (R7/F2)", () => {
  beforeEach(() => {
    toasts.success.mockClear();
    toasts.error.mockClear();
  });

  afterEach(cleanup);

  it("deletes nothing until the user confirms", () => {
    const id = idFromNumber(1);
    const { controller, clearConversation } = makeController();
    ctx.controller = controller;
    ctx.state = makeState({});
    const onOpenChange = vi.fn();

    render(
      React.createElement(DeleteConversationDialog, {
        open: true,
        onOpenChange,
        conversationId: id,
        label: "Alpha",
      }),
    );

    // The dialog is up (the destructive action is gated behind it) but
    // clearConversation has NOT run.
    expect(screen.getByText("Delete conversation?")).not.toBeNull();
    expect(clearConversation).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("confirm deletes the conversation, toasts what happened, and closes", async () => {
    const id = idFromNumber(2);
    const { controller, clearConversation } = makeController();
    ctx.controller = controller;
    ctx.state = makeState({});
    const onOpenChange = vi.fn();

    render(
      React.createElement(DeleteConversationDialog, {
        open: true,
        onOpenChange,
        conversationId: id,
        label: "Alpha",
      }),
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    });

    expect(clearConversation).toHaveBeenCalledTimes(1);
    expect(clearConversation).toHaveBeenCalledWith(id);
    // The toast states what actually happened (the record was deleted, not
    // "history cleared").
    expect(toasts.success).toHaveBeenCalledWith("Conversation deleted");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("cancel leaves the conversation untouched", () => {
    const id = idFromNumber(3);
    const { controller, clearConversation } = makeController();
    ctx.controller = controller;
    ctx.state = makeState({});
    const onOpenChange = vi.fn();

    render(
      React.createElement(DeleteConversationDialog, {
        open: true,
        onOpenChange,
        conversationId: id,
        label: "Alpha",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(clearConversation).not.toHaveBeenCalled();
    expect(toasts.success).not.toHaveBeenCalled();
  });
});

describe("WipeDataAlertDialog (R7/F2 labels, R7/F4 no-op gate)", () => {
  beforeEach(() => {
    toasts.success.mockClear();
    toasts.error.mockClear();
  });

  afterEach(cleanup);

  it("current mode with no active conversation cannot toast success (the no-op clear)", async () => {
    const { controller, clearConversation, clearAll } = makeController();
    ctx.controller = controller;
    ctx.state = makeState({ activeConversationId: null });
    const onOpenChange = vi.fn();
    const onConfirm = vi.fn();

    render(
      React.createElement(WipeDataAlertDialog, {
        open: true,
        mode: "current",
        onOpenChange,
        onConfirm,
      }),
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    });

    // clearConversation() with nothing active is a controller no-op; the
    // confirm must neither run it nor claim success. The dialog closes
    // quietly — nothing was there to delete.
    expect(clearConversation).not.toHaveBeenCalled();
    expect(clearAll).not.toHaveBeenCalled();
    expect(toasts.success).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("current mode with an active conversation clears the ACTIVE target and toasts deletion", async () => {
    const activeId = idFromNumber(4);
    const { controller, clearConversation } = makeController();
    ctx.controller = controller;
    ctx.state = makeState({ activeConversationId: activeId });
    const onOpenChange = vi.fn();
    const onConfirm = vi.fn();

    render(
      React.createElement(WipeDataAlertDialog, {
        open: true,
        mode: "current",
        onOpenChange,
        onConfirm,
      }),
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    });

    // No-arg form: the dialog targets the active conversation.
    expect(clearConversation).toHaveBeenCalledTimes(1);
    expect(clearConversation).toHaveBeenCalledWith();
    expect(toasts.success).toHaveBeenCalledWith("Conversation deleted");
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("all mode wipes everything and reports it", async () => {
    const { controller, clearAll, clearConversation } = makeController();
    ctx.controller = controller;
    ctx.state = makeState({ activeConversationId: null });
    const onOpenChange = vi.fn();
    const onConfirm = vi.fn();

    render(
      React.createElement(WipeDataAlertDialog, {
        open: true,
        mode: "all",
        onOpenChange,
        onConfirm,
      }),
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Wipe all" }));
    });

    expect(clearAll).toHaveBeenCalledTimes(1);
    expect(clearConversation).not.toHaveBeenCalled();
    expect(toasts.success).toHaveBeenCalledWith("All data wiped");
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
