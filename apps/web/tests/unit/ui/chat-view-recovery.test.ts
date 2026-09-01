// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";

import { AuthMode } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import type { ConversationId } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import type {
  ChatController,
  ChatControllerState,
} from "@fuck-eu-chat-control/chat-runtime/runtime/chat-controller";
import type { ActiveSessionState } from "@fuck-eu-chat-control/chat-runtime/runtime/types";
import { ConnectionState } from "@fuck-eu-chat-control/chat-runtime/signaling/state-machine";

import { ChatView } from "@/features/chat/ui/chat-view";

/**
 * R7/F5 + R7/F8 (Phase 12), pinned at ChatView's two recovery handlers:
 *
 *   - a FAILED send may only restore its text into an EMPTY draft — anything
 *     typed during the send round-trip must survive the rejection (R7/F5);
 *   - the "Create a fresh invitation" CTA must LEAVE the auth-failed session
 *     before starting the replacement, so no dead Disconnected sidebar row is
 *     stranded per click (R7/F8).
 *
 * Rendered under jsdom with useChat/sonner swapped for per-test harnesses,
 * mirroring tests/unit/ui/empty-state-leave.test.ts.
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

function makeActive(
  overrides: Partial<ActiveSessionState> & { id: ConversationId },
): ActiveSessionState {
  return {
    connectionState: ConnectionState.Idle,
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
    ...overrides,
  };
}

/**
 * Controller double covering exactly the methods the composer touches. The
 * sendText promise settles only when the test rejects it, modelling the
 * in-flight round-trip during which the user keeps typing.
 */
function makeSendController(): {
  readonly controller: ChatController;
  readonly sendText: ReturnType<typeof vi.fn>;
  readonly rejectSend: (err: Error) => void;
} {
  let pendingReject: (err: Error) => void = () => {};
  const sendText = vi.fn().mockImplementation(
    () =>
      new Promise<void>((_resolve, reject) => {
        pendingReject = reject;
      }),
  );
  const controller = { sendText } as unknown as ChatController;
  return { controller, sendText, rejectSend: (err: Error) => pendingReject(err) };
}

/**
 * Controller double covering exactly the methods the fresh-invitation
 * recovery touches. Built structurally then cast through `unknown` (no
 * `any`), per the project's test-fake convention.
 */
function makeRecoveryController(): {
  readonly controller: ChatController;
  readonly leaveConversation: ReturnType<typeof vi.fn>;
  readonly startConversation: ReturnType<typeof vi.fn>;
} {
  const leaveConversation = vi.fn();
  const startConversation = vi.fn().mockResolvedValue({ invitation: "#fresh" });
  const controller = { leaveConversation, startConversation } as unknown as ChatController;
  return { controller, leaveConversation, startConversation };
}

describe("ChatView composer draft restore (R7/F5)", () => {
  beforeEach(() => {
    toasts.success.mockClear();
    toasts.error.mockClear();
  });

  afterEach(cleanup);

  it("keeps text typed during a failing send instead of clobbering it", async () => {
    const id = idFromNumber(1);
    const { controller, sendText, rejectSend } = makeSendController();
    ctx.controller = controller;
    ctx.state = makeState({
      activeConversationId: id,
      connectionState: ConnectionState.Connected,
      active: makeActive({ id, connectionState: ConnectionState.Connected }),
    });

    render(React.createElement(ChatView));
    const composer = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;

    fireEvent.change(composer, { target: { value: "original draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    // The draft cleared optimistically, then the user typed replacement text
    // while the send was still in flight.
    expect(composer.value).toBe("");
    fireEvent.change(composer, { target: { value: "typed meanwhile" } });

    await act(async () => {
      rejectSend(new Error("data channel closed"));
    });

    // The newer text wins; the failed text may only land in an EMPTY draft.
    expect(composer.value).toBe("typed meanwhile");
    expect(sendText).toHaveBeenCalledWith("original draft");
    expect(toasts.error).toHaveBeenCalledWith(
      "Send failed",
      expect.objectContaining({ description: "data channel closed" }),
    );
  });

  it("restores the failed text when the draft is still empty", async () => {
    const id = idFromNumber(2);
    const { controller, rejectSend } = makeSendController();
    ctx.controller = controller;
    ctx.state = makeState({
      activeConversationId: id,
      connectionState: ConnectionState.Connected,
      active: makeActive({ id, connectionState: ConnectionState.Connected }),
    });

    render(React.createElement(ChatView));
    const composer = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;

    fireEvent.change(composer, { target: { value: "original draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(composer.value).toBe("");

    await act(async () => {
      rejectSend(new Error("data channel closed"));
    });

    // Nothing was typed in between, so the failed text comes back.
    expect(composer.value).toBe("original draft");
    expect(toasts.error).toHaveBeenCalledWith(
      "Send failed",
      expect.objectContaining({ description: "data channel closed" }),
    );
  });
});

describe("ChatView fresh-invitation recovery (R7/F8)", () => {
  beforeEach(() => {
    toasts.success.mockClear();
    toasts.error.mockClear();
  });

  afterEach(cleanup);

  it("leaves the failed session before starting the fresh conversation", async () => {
    const id = idFromNumber(3);
    const { controller, leaveConversation, startConversation } = makeRecoveryController();
    ctx.controller = controller;
    ctx.state = makeState({
      activeConversationId: id,
      connectionState: ConnectionState.Disconnected,
      active: makeActive({ id, connectionState: ConnectionState.Disconnected, authFailed: true }),
    });

    render(React.createElement(ChatView));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create a fresh invitation" }));
    });

    // The auth-failed session is torn down (no dead Disconnected row), and
    // the leave strictly precedes the replacement start.
    expect(leaveConversation).toHaveBeenCalledTimes(1);
    expect(leaveConversation).toHaveBeenCalledWith(id);
    expect(startConversation).toHaveBeenCalledTimes(1);
    expect(startConversation).toHaveBeenCalledWith();
    expect(leaveConversation.mock.invocationCallOrder[0]!).toBeLessThan(
      startConversation.mock.invocationCallOrder[0]!,
    );
  });

  it("surfaces the error and never starts when the leave itself fails", async () => {
    const id = idFromNumber(4);
    const leaveConversation = vi.fn().mockImplementation(() => {
      throw new Error("controller disposed");
    });
    const startConversation = vi.fn().mockResolvedValue({ invitation: "#fresh" });
    const controller = { leaveConversation, startConversation } as unknown as ChatController;
    ctx.controller = controller;
    ctx.state = makeState({
      activeConversationId: id,
      connectionState: ConnectionState.Disconnected,
      active: makeActive({ id, connectionState: ConnectionState.Disconnected, authFailed: true }),
    });

    render(React.createElement(ChatView));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create a fresh invitation" }));
    });

    // The handler's existing convention: one try/catch, one error toast — and
    // no fresh conversation is started on top of a leave that failed.
    expect(toasts.error).toHaveBeenCalledWith(
      "Could not create invitation",
      expect.objectContaining({ description: "controller disposed" }),
    );
    expect(startConversation).not.toHaveBeenCalled();
  });
});
