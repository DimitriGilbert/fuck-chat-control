// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";

import { AuthMode } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import type { ConversationId } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import type {
  ChatController,
  ChatControllerState,
} from "@fuck-eu-chat-control/chat-runtime/runtime/chat-controller";
import type { SessionSummary } from "@fuck-eu-chat-control/chat-runtime/runtime/types";
import { ConnectionState } from "@fuck-eu-chat-control/chat-runtime/signaling/state-machine";
import type { ConversationRecord } from "@fuck-eu-chat-control/chat-runtime/store";

import { EmptyState } from "@/features/chat/ui/empty-state";

/**
 * R7/F3: the "Leave" button on a previous-conversation row must be the
 * NON-destructive teardown (controller.leaveConversation — session closed,
 * record kept), matching the identically-labeled sidebar Leave. It used to
 * call clearConversation, which deleted the record while a live background
 * session stayed connected and invisible. Rows without a live session must
 * not offer Leave at all (there is nothing to leave).
 *
 * Rendered under jsdom with two seams — useChat swapped for a per-test
 * harness and sonner's toast swapped for spies — mirroring the established
 * pattern in tests/unit/runtime/chat-provider-create-race.test.ts.
 */

const CONVERSATION_ID_BYTES = 16;

/** Branded-id fixture; the double cast through unknown is the test convention. */
function idFromNumber(n: number): ConversationId {
  const bytes = new Uint8Array(CONVERSATION_ID_BYTES);
  new DataView(bytes.buffer).setUint32(12, n);
  return bytes as unknown as ConversationId;
}

function makeRecord(id: ConversationId, displayName: string): ConversationRecord {
  return { id, createdAt: 1_000, displayName, peer: null, authFailed: false, authFailedAt: null };
}

function makeLiveSummary(id: ConversationId, label: string): SessionSummary {
  return {
    id,
    label,
    connectionState: ConnectionState.Connected,
    unread: 0,
    lastMessagePreview: null,
    lastMessageAt: null,
    safetyNumberVerified: false,
    authFailed: false,
    authMode: AuthMode.SafetyNumberOnly,
  };
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
 * Controller double covering exactly the methods EmptyState touches. Built
 * structurally then cast through `unknown` (no `any`), per the project's
 * test-fake convention (see auth-mode-surface.test.ts).
 */
function makeController(): {
  readonly controller: ChatController;
  readonly resumeConversation: ReturnType<typeof vi.fn>;
  readonly leaveConversation: ReturnType<typeof vi.fn>;
  readonly clearConversation: ReturnType<typeof vi.fn>;
  readonly startConversation: ReturnType<typeof vi.fn>;
} {
  const resumeConversation = vi.fn().mockResolvedValue(undefined);
  const leaveConversation = vi.fn();
  const clearConversation = vi.fn().mockResolvedValue(undefined);
  const startConversation = vi.fn().mockResolvedValue({ invitation: "#x" });
  const controller = {
    resumeConversation,
    leaveConversation,
    clearConversation,
    startConversation,
  } as unknown as ChatController;
  return {
    controller,
    resumeConversation,
    leaveConversation,
    clearConversation,
    startConversation,
  };
}

describe("EmptyState previous-conversation rows (R7/F3)", () => {
  beforeEach(() => {
    toasts.success.mockClear();
    toasts.error.mockClear();
  });

  afterEach(cleanup);

  it("Leave on a live row tears the session down non-destructively", () => {
    const id = idFromNumber(1);
    const record = makeRecord(id, "Alpha");
    const { controller, leaveConversation, clearConversation } = makeController();
    ctx.controller = controller;
    ctx.state = makeState({ conversations: [record], sessions: [makeLiveSummary(id, "Alpha")] });

    render(React.createElement(EmptyState));
    fireEvent.click(screen.getByRole("button", { name: "Leave" }));

    // The verified-report scenario: Leave must close the live background
    // session WITHOUT deleting the record (clearConversation would leave the
    // session connected and invisible — the orphaned-session bug).
    expect(leaveConversation).toHaveBeenCalledTimes(1);
    expect(leaveConversation).toHaveBeenCalledWith(id);
    expect(clearConversation).not.toHaveBeenCalled();
  });

  it("a persisted-only row offers Resume but no Leave (nothing live to leave)", () => {
    const id = idFromNumber(2);
    const record = makeRecord(id, "Beta");
    const { controller, resumeConversation, leaveConversation } = makeController();
    ctx.controller = controller;
    ctx.state = makeState({ conversations: [record] });

    render(React.createElement(EmptyState));
    expect(screen.queryByRole("button", { name: "Leave" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(resumeConversation).toHaveBeenCalledTimes(1);
    expect(resumeConversation).toHaveBeenCalledWith(id);
    expect(leaveConversation).not.toHaveBeenCalled();
  });

  it("Leave on a live row surfaces no error toast on the synchronous path", () => {
    const id = idFromNumber(3);
    const record = makeRecord(id, "Gamma");
    const { controller } = makeController();
    ctx.controller = controller;
    ctx.state = makeState({ conversations: [record], sessions: [makeLiveSummary(id, "Gamma")] });

    render(React.createElement(EmptyState));
    fireEvent.click(screen.getByRole("button", { name: "Leave" }));
    expect(toasts.error).not.toHaveBeenCalled();
  });
});
