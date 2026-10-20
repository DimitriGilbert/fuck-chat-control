// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import * as React from "react";

import type { ChatControllerDeps } from "@fuck-eu-chat-control/chat-runtime/runtime/chat-controller";
import type { IceServer } from "@fuck-eu-chat-control/chat-runtime/transport/types";
import type { FckRuntimeConfig } from "@/features/chat/runtime/fck-config";

import { ChatProvider, useChat } from "@/features/chat/runtime/chat-provider";

/**
 * R9F1 / Phase 9.3: BOTH ICE-server sources must drop malformed per-entry
 * `urls` before they reach `new RTCPeerConnection` (where `urls: undefined`,
 * `""`, or a non-string throws and kills every session start):
 *
 *   - the `/ice-config` fetch path forwards each entry through the same
 *     per-entry filter as the injected `__FCK_CONFIG__` path, and the shared
 *     filter now also rejects `urls: ""` (it used to pass the
 *     `typeof === "string"` check);
 *   - a fetched list whose EVERY entry is malformed degrades (fail-open +
 *     console warn) instead of silently pinning an empty list;
 *   - an injected list whose every entry fails validation is treated as
 *     "absent" — the provider falls back to the /ice-config fetch.
 *
 * Renders the REAL ChatProvider end-to-end under jsdom, mirroring
 * tests/unit/runtime/chat-provider-create-race.test.ts: the OPFS repository
 * is swapped for an in-memory double, `createChatController` is spy-wrapped
 * (delegating to the original and capturing deps), and `/ice-config` is
 * stubbed via `globalThis.fetch`.
 */

interface Harness {
  controllerConstructions: number;
  lastDeps: ChatControllerDeps | null;
}

const harness = vi.hoisted((): Harness => ({ controllerConstructions: 0, lastDeps: null }));

vi.mock("@/features/chat/store/browser-db-repo", () => ({
  BrowserDbConversationRepository: {
    // The provider opens the worker in parallel with the other boot loads;
    // resolve the handle immediately and hand back the repo double from the
    // collection-build step.
    openDatabase: (): Promise<{ close(): Promise<void> }> =>
      Promise.resolve({ close: () => Promise.resolve() }),
    createFromDatabase: (): Promise<{
      close(): Promise<void>;
      listConversations(): Promise<never[]>;
    }> =>
      Promise.resolve({
        close: () => Promise.resolve(),
        listConversations: () => Promise.resolve([]),
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
      harness.lastDeps = deps;
      return actual.createChatController(deps);
    },
  };
});

/** Probe: records the provider's published context on every render. */
const observed: Array<{ readonly ready: boolean; readonly iceDegraded: boolean }> = [];

function Probe(): React.ReactElement {
  const { ready, iceDegraded } = useChat();
  observed.push({ ready, iceDegraded });
  return React.createElement("div", null, "probe");
}

const fetchMock = vi.fn();

function stubIceConfigResponse(body: unknown): void {
  fetchMock.mockImplementation(() =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve(body),
    } as unknown as Response),
  );
}

async function renderUntilConstructed(): Promise<void> {
  render(React.createElement(ChatProvider, null, React.createElement(Probe)));
  await act(async () => {
    await vi.waitFor(() => {
      expect(harness.controllerConstructions).toBe(1);
    });
  });
}

function setInjectedConfig(config: FckRuntimeConfig | undefined): void {
  Object.defineProperty(window, "__FCK_CONFIG__", {
    value: config,
    configurable: true,
    writable: true,
  });
}

describe("chat-provider ICE-server entry filtering (R9F1)", () => {
  beforeEach(() => {
    harness.controllerConstructions = 0;
    harness.lastDeps = null;
    observed.length = 0;
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    setInjectedConfig(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    setInjectedConfig(undefined);
  });

  it("drops malformed /ice-config entries and keeps the valid ones", async () => {
    stubIceConfigResponse({
      iceServers: [
        { urls: "stun:stun.example" },
        { urls: "" }, // empty string — used to slip through the typeof check
        { urls: 123 },
        { username: "u", credential: "c" }, // no urls at all
        {
          urls: ["turn:turn.example:3478", "turns:turn.example:5349"],
          username: "u",
          credential: "c",
        },
        { urls: [] }, // empty array
      ],
      publicBaseUrl: "https://chat.example",
    });

    await renderUntilConstructed();

    const servers = harness.lastDeps?.iceServers as readonly IceServer[] | undefined;
    expect(servers).toEqual([
      { urls: "stun:stun.example" },
      {
        urls: ["turn:turn.example:3478", "turns:turn.example:5349"],
        username: "u",
        credential: "c",
      },
    ]);
    // Partial drop is NOT a degradation: the usable list proceeds normally.
    const latest = observed[observed.length - 1];
    expect(latest).toMatchObject({ ready: true, iceDegraded: false });
    // The runtime publicBaseUrl still flows through.
    expect(harness.lastDeps?.publicBaseUrl).toBe("https://chat.example");
  });

  it("plumbs /ice-config's groupMaxMembers into the controller's maxGroupMembers dep", async () => {
    // Phase 7 (protocol-v2): the operator-configured GROUP_MAX_MEMBERS seat
    // cap must reach the client-side group session so it enforces the SAME
    // cap as the broker registry. The field rides the same fetch as the ICE
    // list and publicBaseUrl.
    stubIceConfigResponse({ iceServers: [], groupMaxMembers: 4 });

    await renderUntilConstructed();

    expect(harness.lastDeps?.maxGroupMembers).toBe(4);
    const latest = observed[observed.length - 1];
    expect(latest).toMatchObject({ ready: true, iceDegraded: false });
  });

  it("a malformed groupMaxMembers is treated as unset (runtime default applies)", async () => {
    stubIceConfigResponse({ iceServers: [], groupMaxMembers: "many" });

    await renderUntilConstructed();

    expect(harness.lastDeps?.maxGroupMembers).toBeUndefined();
  });

  it("an out-of-window groupMaxMembers (above the hard ceiling) is dropped", async () => {
    stubIceConfigResponse({ iceServers: [], groupMaxMembers: 99 });

    await renderUntilConstructed();

    expect(harness.lastDeps?.maxGroupMembers).toBeUndefined();
  });

  it("the injected path leaves maxGroupMembers unset (desktop has no /ice-config)", async () => {
    setInjectedConfig({
      brokerUrl: "wss://broker.example/ws",
      iceServers: [{ urls: "stun:injected.example" }],
    });

    await renderUntilConstructed();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(harness.lastDeps?.maxGroupMembers).toBeUndefined();
  });

  it("an all-malformed fetched list degrades (fail-open + warn)", async () => {
    stubIceConfigResponse({
      iceServers: [{ urls: "" }, { urls: 123 }, { credential: "c" }],
    });

    await renderUntilConstructed();

    expect(harness.lastDeps?.iceServers).toEqual([]);
    const latest = observed[observed.length - 1];
    expect(latest).toMatchObject({ ready: true, iceDegraded: true });
  });

  it("an intentionally EMPTY fetched list is not a degradation", async () => {
    stubIceConfigResponse({ iceServers: [] });

    await renderUntilConstructed();

    expect(harness.lastDeps?.iceServers).toEqual([]);
    const latest = observed[observed.length - 1];
    expect(latest).toMatchObject({ ready: true, iceDegraded: false });
  });

  it('the injected path drops urls:"" and skips the fetch when a usable entry remains', async () => {
    setInjectedConfig({
      brokerUrl: "wss://broker.example/ws",
      baseUrl: "self",
      publicBaseUrl: "self",
      iceServers: [{ urls: "" }, { urls: "stun:injected.example", username: "u" }],
    });

    await renderUntilConstructed();

    expect(harness.lastDeps?.iceServers).toEqual([
      { urls: "stun:injected.example", username: "u" },
    ]);
    // A usable injected list must skip the (dead-path) /ice-config fetch.
    expect(fetchMock).not.toHaveBeenCalled();
    const latest = observed[observed.length - 1];
    expect(latest).toMatchObject({ ready: true, iceDegraded: false });
  });

  it("an all-malformed injected list falls back to the /ice-config fetch", async () => {
    setInjectedConfig({
      brokerUrl: "wss://broker.example/ws",
      iceServers: [{ urls: "" }, { credential: "c" } as unknown as IceServer],
    });
    stubIceConfigResponse({ iceServers: [{ urls: "stun:fetched.example" }] });

    await renderUntilConstructed();

    expect(fetchMock).toHaveBeenCalledWith("/ice-config", expect.anything());
    expect(harness.lastDeps?.iceServers).toEqual([{ urls: "stun:fetched.example" }]);
  });
});
