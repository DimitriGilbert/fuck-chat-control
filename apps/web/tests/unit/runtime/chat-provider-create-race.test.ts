// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import * as React from "react";

import { AtRestKeyLockedError } from "@fuck-eu-chat-control/chat-runtime/runtime/at-rest-key-manager";
import type { ChatControllerDeps } from "@fuck-eu-chat-control/chat-runtime/runtime/chat-controller";
import type { ConversationRecord } from "@fuck-eu-chat-control/chat-runtime/store";

import { ChatProvider, useChat } from "@/features/chat/runtime/chat-provider";

/**
 * R6/F1 regression: unmount firing during `await
 * BrowserDbConversationRepository.create(...)` used to leak the OPFS SQLite DB
 * and its dedicated Web Worker. The unmount cleanup locks the at-rest key
 * manager synchronously; the resumed continuation then throws
 * AtRestKeyLockedError from createChatController's FIRST statement
 * (`deps.atRestKeyManager.get()`), and that throw sailed past the cancelled
 * guard into the outer `.catch` without ever closing the repository.
 *
 * Unlike provider-evict.test.ts (which pins the managers' contracts without a
 * render tree), this file DOES render the real ChatProvider: the leak lives in
 * the provider's own effect wiring, so the race is reproduced end-to-end under
 * jsdom with exactly two seams — the OPFS-backed repository swapped for a
 * controllable double whose static create() parks until the test resolves it,
 * and a spy wrapper around the real createChatController that delegates to the
 * original so the genuine AtRestKeyLockedError is thrown, not a
 * re-implementation.
 */

/**
 * Minimal runtime double for `BrowserDbConversationRepository`. On the failure
 * path the provider touches only `close`; on the success path the controller's
 * boot hydrate calls `listConversations` once. Anything else being invoked
 * would be a bug in the scenario under test, so it is simply absent.
 */
interface FakeRepositoryDouble {
  closeCount: number;
  listConversationsCalls: number;
  close(): Promise<void>;
  listConversations(): Promise<ConversationRecord[]>;
}

function fakeRepository(): FakeRepositoryDouble {
  return {
    closeCount: 0,
    listConversationsCalls: 0,
    async close(): Promise<void> {
      this.closeCount += 1;
    },
    async listConversations(): Promise<ConversationRecord[]> {
      this.listConversationsCalls += 1;
      return [];
    },
  };
}

/** State shared with the hoisted vi.mock factories below. */
interface Harness {
  createCalls: number;
  createResolvers: Array<(repo: FakeRepositoryDouble) => void>;
  controllerConstructions: number;
  lastConstructionError: unknown;
}

const harness = vi.hoisted(
  (): Harness => ({
    createCalls: 0,
    createResolvers: [],
    controllerConstructions: 0,
    lastConstructionError: null,
  }),
);

vi.mock("@/features/chat/store/browser-db-repo", () => ({
  BrowserDbConversationRepository: {
    create: (): Promise<FakeRepositoryDouble> =>
      new Promise((resolve) => {
        harness.createCalls += 1;
        harness.createResolvers.push(resolve);
      }),
  },
}));

vi.mock("@fuck-eu-chat-control/chat-runtime/runtime/chat-controller", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@fuck-eu-chat-control/chat-runtime/runtime/chat-controller")
    >();
  return {
    ...actual,
    createChatController: (deps: ChatControllerDeps) => {
      harness.controllerConstructions += 1;
      try {
        return actual.createChatController(deps);
      } catch (err: unknown) {
        harness.lastConstructionError = err;
        throw err;
      }
    },
  };
});

/** Context snapshots recorded by the probe child on every provider render. */
interface ProbeSnapshot {
  readonly hasController: boolean;
  readonly ready: boolean;
  readonly error: string | null;
}

const observed: ProbeSnapshot[] = [];

function Probe(): React.ReactElement {
  const { controller, ready, state } = useChat();
  observed.push({ hasController: controller !== null, ready, error: state.error });
  return React.createElement("div", null, "probe");
}

describe("ChatProvider unmount-during-create race (R6/F1)", () => {
  beforeEach(() => {
    harness.createCalls = 0;
    harness.createResolvers.length = 0;
    harness.controllerConstructions = 0;
    harness.lastConstructionError = null;
    observed.length = 0;
  });

  afterEach(cleanup);

  it("closes the OPFS repository when unmount fires during create", async () => {
    const repo = fakeRepository();
    const { unmount } = render(React.createElement(ChatProvider, null));

    // Progress the effect past both manager loads and the /ice-config fetch
    // (fail-open in jsdom) to the parked `await create(...)`.
    await act(async () => {
      await vi.waitFor(() => {
        expect(harness.createCalls).toBe(1);
      });
    });
    expect(harness.controllerConstructions).toBe(0);

    // Unmount while the create is still pending: the cleanup locks the
    // at-rest key manager synchronously (R9/F8) and `disposedController` is
    // still null — the exact precondition of the race.
    unmount();

    // The create resolves AFTER the cleanup locked the manager.
    await act(async () => {
      harness.createResolvers[0](repo);
      await vi.waitFor(() => {
        expect(repo.closeCount).toBe(1);
      });
    });

    // createChatController was attempted exactly once and threw the finding's
    // AtRestKeyLockedError at the locked manager; the provider closed the
    // repository exactly once. Before the fix, the throw reached the outer
    // .catch directly and the OPFS DB + Worker were never released.
    expect(harness.controllerConstructions).toBe(1);
    expect(harness.lastConstructionError).toBeInstanceOf(AtRestKeyLockedError);
    expect(repo.closeCount).toBe(1);
    // No controller ever existed, so nothing read through the repository.
    expect(repo.listConversationsCalls).toBe(0);
  });

  it("clean mount hands the repository to the controller; unmount closes it exactly once", async () => {
    const repo = fakeRepository();
    const { unmount } = render(React.createElement(ChatProvider, null, React.createElement(Probe)));

    await act(async () => {
      await vi.waitFor(() => {
        expect(harness.createCalls).toBe(1);
      });
    });

    await act(async () => {
      harness.createResolvers[0](repo);
      // Macrotask flush: the resumed continuation (construct -> publish ->
      // subscribe -> setReady) and React's re-render are microtask-chained.
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    const latest = observed[observed.length - 1];
    expect(latest).toEqual({ hasController: true, ready: true, error: null });

    expect(harness.controllerConstructions).toBe(1);
    expect(harness.lastConstructionError).toBeNull();
    // While mounted the repository belongs to the published controller — the
    // provider must not close it directly on the success path (exactly-once
    // ownership: only dispose() releases it).
    expect(repo.closeCount).toBe(0);
    expect(repo.listConversationsCalls).toBeGreaterThanOrEqual(1);

    // Unmount disposes the controller, which releases the repository.
    unmount();
    await act(async () => {
      await vi.waitFor(() => {
        expect(repo.closeCount).toBe(1);
      });
    });
    expect(repo.closeCount).toBe(1);
  });
});
