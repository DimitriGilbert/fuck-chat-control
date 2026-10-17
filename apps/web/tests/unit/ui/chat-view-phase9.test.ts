// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";

import { conversationIdToHex } from "@fuck-eu-chat-control/chat-runtime/orchestrator/invitation";
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
 * Phase 9.1 pins (R10F1, R10F2, R10F3, R10F5):
 *
 *   - R10F2: the composer draft is per-SESSION (`state.active.draft` written
 *     through `controller.setDraft`), so switching conversations restores each
 *     conversation's own draft instead of leaking one buffer across sessions;
 *   - R10F1: "Regenerate" hands the FRESH code into applyPakeChoice explicitly
 *     (setCodeDraft cannot be observed inside the same tick), and the PAKE
 *     checkbox is derived from the live invitation so a failed toggle-on can
 *     never leave it checked over an uncoded link;
 *   - R10F3: dragOver preventDefaults unconditionally — otherwise `drop`
 *     navigates to the file and tears down live sessions;
 *   - R10F5: the auth pill's label, styling, data-auth-mode, and aria-label
 *     all key on `authMode` alone (a pending PAKE session reads
 *     "PAKE (pending)", never "Safety number" on PAKE styling).
 *
 * Rendered under jsdom with useChat/sonner swapped for reactive harnesses,
 * mirroring tests/unit/ui/chat-view-recovery.test.ts. The useChat mock uses
 * useSyncExternalStore so `publish()` re-renders exactly like the real
 * controller's emit() — required now that the composer is fully controlled
 * by the snapshot.
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
  state: null as null | ChatControllerState,
  listeners: new Set<() => void>(),
}));

/** Publish a fresh snapshot and notify subscribers (the real emit() twin). */
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
      ready: true,
      iceDegraded: false,
    }),
  };
});

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
 * Emulates the real controller's per-session draft store: `setDraft` writes
 * the session's draft keyed by id and emits a fresh snapshot when the write
 * targets the ACTIVE session. `activate(id)` is the test's stand-in for
 * `selectConversation`: it publishes that session's view — including its
 * STORED draft, which is what proves drafts persist per conversation.
 */
function makeDraftController(): {
  readonly controller: ChatController;
  readonly setDraft: ReturnType<typeof vi.fn>;
  readonly drafts: Map<string, string>;
  readonly activate: (id: ConversationId) => void;
} {
  const drafts = new Map<string, string>();
  const activate = (id: ConversationId): void => {
    publish(
      makeState({
        activeConversationId: id,
        connectionState: ConnectionState.Connected,
        active: makeActive({
          id,
          connectionState: ConnectionState.Connected,
          draft: drafts.get(conversationIdToHex(id)) ?? "",
        }),
      }),
    );
  };
  const setDraft = vi.fn((id: ConversationId, value: string): void => {
    drafts.set(conversationIdToHex(id), value);
    const current = ctx.state;
    if (
      current?.active !== null &&
      current?.active !== undefined &&
      conversationIdToHex(current.active.id) === conversationIdToHex(id)
    ) {
      publish({ ...current, active: { ...current.active, draft: value } });
    }
  });
  const controller = {
    setDraft,
    getState: (): ChatControllerState | null => ctx.state,
  } as unknown as ChatController;
  return { controller, setDraft, drafts, activate };
}

/** Controller double for the InvitationBanner PAKE controls. */
function makePakeController(codes: readonly string[]): {
  readonly controller: ChatController;
  readonly leaveConversation: ReturnType<typeof vi.fn>;
  readonly startConversation: ReturnType<typeof vi.fn>;
  readonly generatePakeCode: ReturnType<typeof vi.fn>;
} {
  const leaveConversation = vi.fn();
  const startConversation = vi.fn().mockResolvedValue({ invitation: "#fresh" });
  let next = 0;
  const generatePakeCode = vi.fn((): string => {
    const code = codes[next] ?? codes[codes.length - 1] ?? "999999";
    next += 1;
    return code;
  });
  const controller = {
    leaveConversation,
    startConversation,
    generatePakeCode,
    getState: (): ChatControllerState | null => ctx.state,
  } as unknown as ChatController;
  return { controller, leaveConversation, startConversation, generatePakeCode };
}

/** InvitationBanner-visible state: an initiator waiting for the peer. */
function waitingState(id: ConversationId, invitation: string): ChatControllerState {
  return makeState({
    activeConversationId: id,
    connectionState: ConnectionState.Waiting,
    invitation,
    active: makeActive({ id, connectionState: ConnectionState.Waiting, invitation }),
  });
}

describe("ChatView per-session composer draft (R10F2)", () => {
  beforeEach(() => {
    toasts.success.mockClear();
    toasts.error.mockClear();
  });

  afterEach(cleanup);

  it("writes keystrokes through to the session and restores each conversation's own draft", () => {
    const idA = idFromNumber(10);
    const idB = idFromNumber(11);
    const { controller, setDraft, activate } = makeDraftController();
    ctx.controller = controller;
    ctx.state = makeState({
      activeConversationId: idA,
      connectionState: ConnectionState.Connected,
      active: makeActive({ id: idA, connectionState: ConnectionState.Connected }),
    });

    render(React.createElement(ChatView));
    const composer = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;

    fireEvent.change(composer, { target: { value: "draft for A" } });
    expect(setDraft).toHaveBeenCalledWith(idA, "draft for A");
    expect(composer.value).toBe("draft for A");

    // Switch to B: the composer shows B's (empty) draft — NOT A's text.
    act(() => activate(idB));
    expect(composer.value).toBe("");

    fireEvent.change(composer, { target: { value: "draft for B" } });
    expect(setDraft).toHaveBeenCalledWith(idB, "draft for B");

    // Switching back restores A's stored draft; B's stays put on B.
    act(() => activate(idA));
    expect(composer.value).toBe("draft for A");
    act(() => activate(idB));
    expect(composer.value).toBe("draft for B");
  });
});

describe("ChatView PAKE controls (R10F1)", () => {
  beforeEach(() => {
    toasts.success.mockClear();
    toasts.error.mockClear();
  });

  afterEach(cleanup);

  it("Regenerate applies the FRESH code, not the stale draft code", async () => {
    const id = idFromNumber(20);
    const { controller, startConversation, generatePakeCode } = makePakeController(["333333"]);
    ctx.controller = controller;
    // Live coded invitation: codeDraft syncs to "111111" via the effect.
    ctx.state = waitingState(id, `https://app.example/#${"a".repeat(32)}~111111`);

    render(React.createElement(ChatView));
    const box = screen.getByRole("checkbox", {
      name: "Protect this conversation with a 6-digit PAKE code",
    }) as HTMLInputElement;
    // The checkbox is derived from the live invitation — coded, so checked.
    expect(box.checked).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Regenerate PAKE code" }));
    });

    // The stale-closure bug applied the OLD codeDraft ("111111"). The fresh
    // generated code must be what reaches startConversation.
    expect(generatePakeCode).toHaveBeenCalledTimes(1);
    expect(startConversation).toHaveBeenCalledTimes(1);
    expect(startConversation).toHaveBeenCalledWith({ code: "333333" });
  });

  it("a failed toggle-on leaves the checkbox unchecked over the uncoded invitation", async () => {
    const id = idFromNumber(21);
    const { controller, startConversation } = makePakeController(["222222"]);
    startConversation.mockRejectedValue(new Error("broker down"));
    ctx.controller = controller;
    ctx.state = waitingState(id, `https://app.example/#${"b".repeat(32)}`);

    render(React.createElement(ChatView));
    const box = screen.getByRole("checkbox", {
      name: "Protect this conversation with a 6-digit PAKE code",
    }) as HTMLInputElement;
    expect(box.checked).toBe(false);

    await act(async () => {
      fireEvent.click(box);
    });

    expect(startConversation).toHaveBeenCalledWith({ code: "222222" });
    expect(toasts.error).toHaveBeenCalledWith(
      "Could not update invitation",
      expect.objectContaining({ description: "broker down" }),
    );
    // Derived from the (still uncoded) invitation: the checkbox cannot lie.
    expect(box.checked).toBe(false);
  });

  it("toggling on an uncoded invitation generates and applies a code", async () => {
    const id = idFromNumber(22);
    const { controller, startConversation, generatePakeCode } = makePakeController(["222222"]);
    ctx.controller = controller;
    ctx.state = waitingState(id, `https://app.example/#${"c".repeat(32)}`);

    render(React.createElement(ChatView));
    const box = screen.getByRole("checkbox", {
      name: "Protect this conversation with a 6-digit PAKE code",
    }) as HTMLInputElement;

    await act(async () => {
      fireEvent.click(box);
    });

    expect(generatePakeCode).toHaveBeenCalledTimes(1);
    expect(startConversation).toHaveBeenCalledWith({ code: "222222" });
  });
});

describe("ChatView drop zone (R10F3)", () => {
  afterEach(cleanup);

  function renderWith(connectionState: ConnectionState): HTMLElement {
    const id = idFromNumber(30);
    ctx.controller = {} as ChatController;
    ctx.state = makeState({
      activeConversationId: id,
      connectionState,
      active: makeActive({ id, connectionState }),
    });
    const { container } = render(React.createElement(ChatView));
    const zone = container.querySelector('[data-drop-zone="chat"]');
    expect(zone).not.toBeNull();
    return zone as HTMLElement;
  }

  it("preventDefaults dragOver while DISCONNECTED so a drop cannot navigate", () => {
    const zone = renderWith(ConnectionState.Disconnected);
    // fireEvent returns false when the handler called preventDefault.
    expect(fireEvent.dragOver(zone)).toBe(false);
  });

  it("still preventDefaults dragOver while connected", () => {
    const zone = renderWith(ConnectionState.Connected);
    expect(fireEvent.dragOver(zone)).toBe(false);
  });
});

describe("ChatView auth pill (R10F5)", () => {
  afterEach(cleanup);

  function pillText(connectionState: ConnectionState, authMode: AuthMode): string | null {
    const id = idFromNumber(40);
    ctx.controller = {} as ChatController;
    ctx.state = makeState({
      activeConversationId: id,
      connectionState,
      active: makeActive({ id, connectionState, authMode }),
    });
    const { container } = render(React.createElement(ChatView));
    const pill = container.querySelector('[data-slot="auth-mode-pill"]');
    expect(pill).not.toBeNull();
    expect(pill?.getAttribute("data-auth-mode")).toBe(
      authMode === AuthMode.Pake ? "pake" : "safety-number",
    );
    const text = pill?.textContent ?? null;
    cleanup();
    return text;
  }

  it("a waiting PAKE session reads PAKE (pending), not 'Safety number'", () => {
    const text = pillText(ConnectionState.Waiting, AuthMode.Pake);
    expect(text).toContain("PAKE");
    expect(text).toContain("pending");
  });

  it("a connected PAKE session reads PAKE", () => {
    const text = pillText(ConnectionState.Connected, AuthMode.Pake);
    expect(text).toContain("PAKE");
    expect(text).not.toContain("pending");
    expect(text).not.toContain("Safety number");
  });

  it("a connected safety-number session reads 'Safety number'", () => {
    const text = pillText(ConnectionState.Connected, AuthMode.SafetyNumberOnly);
    expect(text).toContain("Safety number");
  });
});
