/**
 * R8/F1 + R8/F2 regression tests for the app shell (App.tsx + screens).
 *
 * The real ChatProvider construction chain runs with the heavyweight
 * chat-runtime modules replaced by mocks (identity/at-rest key managers,
 * repository, createChatController): the real controller needs live
 * WebCrypto, which the quick-crypto mock does not provide. Everything else —
 * ChatProvider's async gate, Router's navigation/auto-route effects,
 * HomeScreen's fail-closed entry gating, ChatScreen's Leave wiring, and the
 * AppErrorBoundary — is the real code under test.
 *
 * R8/F1 pins: the Leave press actually calls controller.leave() (matching the
 * web handleLeave), and the auto-route effect cannot bounce the user back
 * into a chat they left even while a stale state.active snapshot is still
 * rendered.
 *
 * R8/F2 pins: the provider's fail-closed error is rendered, Start/Join are
 * disabled while !ready/errored, the Router refuses to navigate to the
 * useChatController()-rendering screens in that state, and a render-phase
 * throw is caught by the boundary instead of crashing.
 */
import { hexToConversationId } from "@fuck-eu-chat-control/chat-runtime/orchestrator/invitation";
import { AuthMode } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import { ConnectionState } from "@fuck-eu-chat-control/chat-runtime/signaling/state-machine";
import type { ConversationId } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import type { ChatControllerState } from "@fuck-eu-chat-control/chat-runtime/runtime/chat-controller";
import * as SecureStore from "expo-secure-store";
import * as React from "react";
import { act, create } from "react-test-renderer";

import App from "../App";
import { closeStorage } from "../src/chat/mmkv-storage";
import { AppErrorBoundary } from "../src/error-boundary";

type StateListener = (state: ChatControllerState) => void;

interface MockChatController {
  readonly getState: () => ChatControllerState;
  readonly subscribe: (listener: StateListener) => () => void;
  readonly dispose: jest.Mock<void, []>;
  readonly leave: jest.Mock<void, [id?: ConversationId]>;
  readonly leaveConversation: jest.Mock<void, [id?: ConversationId]>;
  readonly startConversation: jest.Mock<Promise<{ invitation: string }>, []>;
  readonly joinConversation: jest.Mock<Promise<void>, [fragment: string]>;
  readonly resumeConversation: jest.Mock<Promise<void>, [id: ConversationId]>;
  readonly selectConversation: jest.Mock<void, [id: ConversationId]>;
  readonly sendText: jest.Mock<Promise<void>, [id: ConversationId, text: string]>;
  readonly sendFile: jest.Mock<Promise<number>, [id: ConversationId, file: unknown]>;
  readonly markSafetyNumberVerified: jest.Mock<void, [id: ConversationId]>;
}

interface MockChatControllerModule {
  readonly createChatController: () => MockChatController;
  readonly initialChatControllerState: ChatControllerState;
  /** Test-only: push a controller state snapshot to every subscriber. */
  readonly __emitState: (next: ChatControllerState) => void;
  /** Test-only: reset the fake state and clear call recordings. */
  readonly __reset: () => void;
}

// The chat-runtime modules below are replaced wholesale: their real
// constructors need live crypto/native state that does not exist under jest.
// The provider's gating, subscription, and teardown logic still runs against
// the fake surface exactly as it would against the real controller.
jest.mock("@fuck-eu-chat-control/chat-runtime/runtime/identity-manager", () => ({
  createIdentityManager: () => ({
    ensureLoaded: async (): Promise<void> => {},
    evict: (): void => {},
  }),
}));

jest.mock("@fuck-eu-chat-control/chat-runtime/runtime/at-rest-key-manager", () => ({
  createAtRestKeyManager: () => ({
    ensureLoaded: async (): Promise<void> => {},
    lock: (): void => {},
  }),
}));

jest.mock("@fuck-eu-chat-control/chat-runtime/store", () => ({
  InMemoryConversationRepository: class InMemoryConversationRepository {},
  setDurableStorage: jest.fn(),
}));

jest.mock("../src/chat/config", () => ({
  resolveRuntimeConfig: () => ({
    brokerUrl: "wss://broker.test/ws",
    baseUrl: "https://base.test",
  }),
  fetchIceServers: async (): Promise<readonly never[]> => [],
}));

jest.mock("expo-document-picker", () => ({
  getDocumentAsync: jest.fn(),
}));

jest.mock("expo-file-system/legacy", () => ({
  getInfoAsync: jest.fn(),
}));

// react-native-webrtc instantiates a NativeEventEmitter at module load, which
// throws in the node jest environment. The factory is passed (unused) to the
// mocked createChatController, so no peer connection is ever constructed
// here — the throw keeps an accidental construction loud.
jest.mock("react-native-webrtc", () => ({
  RTCPeerConnection: function RTCPeerConnection(): void {
    throw new Error("RTCPeerConnection must not be constructed in app-shell tests");
  },
}));

// The fake controller keeps its state in the factory closure and exposes test
// handles on the mocked module object (jest.requireMock below), because the
// factory cannot reference out-of-scope bindings and runs before the test
// body initializes its own state. NOTE: the babel jest-hoist check walks the
// factory before TS types are stripped, so every annotation inside it must be
// a plain type reference (type-space) — inline function-type literals with
// named parameters read as out-of-scope variable accesses there.
jest.mock("@fuck-eu-chat-control/chat-runtime/runtime/chat-controller", () => {
  // Alias the destructured binding so the `typeof ConnectionState` in the
  // generic refers to the outer import, not the local being initialized.
  const { ConnectionState: ActualConnectionState } = jest.requireActual<{
    ConnectionState: typeof ConnectionState;
  }>("@fuck-eu-chat-control/chat-runtime/signaling/state-machine");
  const makeInitialState = () => ({
    activeConversationId: null,
    sessions: [],
    active: null,
    conversations: [],
    ready: true,
    error: null,
    connectionState: ActualConnectionState.Idle,
    conversationId: null,
    invitation: null,
    safetyNumber: null,
    safetyNumberVerified: false,
    messages: [],
  });
  let current: ChatControllerState = makeInitialState();
  const listeners: Set<StateListener> = new Set();
  const controller = {
    getState: (): ChatControllerState => current,
    subscribe: (listener: StateListener): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose: jest.fn(),
    leave: jest.fn(),
    leaveConversation: jest.fn(),
    startConversation: jest.fn(() =>
      Promise.resolve({ invitation: "https://base.test/#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }),
    ),
    joinConversation: jest.fn(() => Promise.resolve()),
    resumeConversation: jest.fn(() => Promise.resolve()),
    selectConversation: jest.fn(),
    sendText: jest.fn(() => Promise.resolve()),
    sendFile: jest.fn(() => Promise.resolve(0)),
    markSafetyNumberVerified: jest.fn(),
  };
  const recorded = [
    controller.dispose,
    controller.leave,
    controller.leaveConversation,
    controller.startConversation,
    controller.joinConversation,
    controller.resumeConversation,
    controller.selectConversation,
    controller.sendText,
    controller.sendFile,
    controller.markSafetyNumberVerified,
  ];
  return {
    createChatController: () => controller,
    initialChatControllerState: makeInitialState(),
    __emitState: (next: ChatControllerState): void => {
      current = next;
      for (const listener of listeners) {
        listener(next);
      }
    },
    __reset: (): void => {
      current = makeInitialState();
      listeners.clear();
      for (const fn of recorded) {
        fn.mockClear();
      }
    },
  };
});

const mockChat = jest.requireMock<MockChatControllerModule>(
  "@fuck-eu-chat-control/chat-runtime/runtime/chat-controller",
);

const ACTIVE_HEX = "ab".repeat(16);

function stateWithActive(id: ConversationId): ChatControllerState {
  return {
    ...mockChat.initialChatControllerState,
    activeConversationId: id,
    conversationId: id,
    connectionState: ConnectionState.Connected,
    active: {
      id,
      connectionState: ConnectionState.Connected,
      messages: [],
      safetyNumber: "111111111111111111111111111111111",
      safetyNumberVerified: false,
      invitation: null,
      unread: 0,
      draft: "",
      lastMessagePreview: null,
      lastMessageAt: null,
      transfers: [],
      authFailed: false,
      authMode: AuthMode.SafetyNumberOnly,
    },
  };
}

function stateWithNoActive(): ChatControllerState {
  return mockChat.initialChatControllerState;
}

type Renderer = ReturnType<typeof create>;

async function renderApp(): Promise<Renderer> {
  let renderer!: Renderer;
  await act(async () => {
    renderer = create(<App />);
    // Let the provider's whole async construction chain (SecureStore mock →
    // managers → controller) resolve before asserting on the ready state.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  });
  return renderer;
}

/**
 * Find rendered text by label. RN components render as a composite + host
 * pair that BOTH carry props.children, so restrict the match to host
 * components (string type) — one node per Text.
 */
function findAllByText(root: Renderer["root"], text: string): ReturnType<typeof root.findAll> {
  return root.findAll((node) => {
    if (typeof node.type !== "string") return false;
    const children: unknown = node.props.children;
    return Array.isArray(children) ? children.includes(text) : children === text;
  });
}

/**
 * Climb from a text node to the nearest pressable ancestor (Pressable wraps
 * its label in Text, and the mock tree may interpose host views).
 */
function findPressableAncestor(node: Renderer["root"]): Renderer["root"] | null {
  let current: Renderer["root"] | null = node;
  while (current !== null) {
    const onPress: unknown = current.props.onPress;
    if (typeof onPress === "function") {
      return current;
    }
    current = current.parent;
  }
  return null;
}

function pressText(root: Renderer["root"], label: string): void {
  const matches = findAllByText(root, label);
  const pressable = matches.length > 0 ? findPressableAncestor(matches[0]!) : null;
  if (pressable === null) {
    throw new Error(`no pressable ancestor found for label: ${label}`);
  }
  const onPress: unknown = pressable.props.onPress;
  act(() => {
    (onPress as () => void)();
  });
}

describe("app shell navigation and leave flow (R8/F1)", () => {
  beforeEach(() => {
    mockChat.__reset();
  });

  it("routes to chat when a session becomes active", async () => {
    const renderer = await renderApp();
    // Boot: home is rendered, entry points enabled.
    expect(findAllByText(renderer.root, "Start a conversation").length).toBeGreaterThan(0);
    const startPressable = findPressableAncestor(
      findAllByText(renderer.root, "Start a conversation")[0]!,
    );
    expect(startPressable?.props.disabled).not.toBe(true);

    // A session turning active (e.g. resumeConversation's emit) forces the
    // chat route.
    act(() => {
      mockChat.__emitState(stateWithActive(hexToConversationId(ACTIVE_HEX)));
    });
    expect(findAllByText(renderer.root, "Leave").length).toBe(1);
    expect(findAllByText(renderer.root, "Start a conversation").length).toBe(0);

    await act(async () => {
      renderer.unmount();
    });
  });

  it("Leave calls controller.leave() and the route stays home (no bounce)", async () => {
    const renderer = await renderApp();
    act(() => {
      mockChat.__emitState(stateWithActive(hexToConversationId(ACTIVE_HEX)));
    });
    expect(findAllByText(renderer.root, "Leave").length).toBe(1);

    pressText(renderer.root, "Leave");

    // R8/F1: the press must reach the controller (the original bug: Leave
    // only changed the route, leaking the live WebSocket/peer connection).
    expect(mockChat.createChatController().leave).toHaveBeenCalledTimes(1);

    // Even while the LAST rendered snapshot still has state.active set (the
    // controller's post-leave emit has not landed yet), the auto-route
    // effect must not force the route back to chat.
    expect(findAllByText(renderer.root, "Start a conversation").length).toBeGreaterThan(0);
    expect(findAllByText(renderer.root, "Leave").length).toBe(0);

    // The controller's post-leave snapshot (active cleared) keeps us home.
    act(() => {
      mockChat.__emitState(stateWithNoActive());
    });
    expect(findAllByText(renderer.root, "Start a conversation").length).toBeGreaterThan(0);
    expect(findAllByText(renderer.root, "Leave").length).toBe(0);

    // Re-entering the SAME conversation is still treated as a new activation
    // (the last-seen guard must not break resume auto-routing).
    act(() => {
      mockChat.__emitState(stateWithActive(hexToConversationId(ACTIVE_HEX)));
    });
    expect(findAllByText(renderer.root, "Leave").length).toBe(1);

    await act(async () => {
      renderer.unmount();
    });
  });

  it("Start flow navigates through the gated route and back", async () => {
    const renderer = await renderApp();
    pressText(renderer.root, "Start a conversation");
    expect(findAllByText(renderer.root, "Generate invitation").length).toBe(1);

    // Back is always navigable (the gate only blocks start/join/chat).
    pressText(renderer.root, "Back");
    expect(findAllByText(renderer.root, "Start a conversation").length).toBeGreaterThan(0);

    pressText(renderer.root, "Start a conversation");
    await act(async () => {
      pressText(renderer.root, "Generate invitation");
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    });
    expect(mockChat.createChatController().startConversation).toHaveBeenCalledTimes(1);
    // onStarted navigated to chat; with no active session yet ChatScreen
    // renders its empty state (no Leave header until a session is active).
    expect(findAllByText(renderer.root, "No active conversation.").length).toBe(1);

    await act(async () => {
      renderer.unmount();
    });
  });
});

describe("provider fail-closed error path (R8/F2)", () => {
  beforeEach(() => {
    mockChat.__reset();
    // Tear down any instance a prior test left behind so this test's
    // ensureStorageReady() actually re-runs the (mocked) keychain read.
    closeStorage();
  });

  it("renders the error, disables Start/Join, and refuses to enter the chat screens", async () => {
    const getItemAsyncMock = SecureStore.getItemAsync as unknown as jest.Mock<
      Promise<string | null>,
      [string]
    >;
    getItemAsyncMock.mockRejectedValueOnce(new Error("keychain unavailable"));

    const renderer = await renderApp();

    // The provider's redacted fail-closed message is rendered (HomeScreen
    // shows it below the disabled entries; the Router banner shows it too).
    expect(
      findAllByText(
        renderer.root,
        "Secure storage is unavailable on this device. Chat cannot start safely.",
      ).length,
    ).toBeGreaterThan(0);

    // Both entry points are disabled.
    for (const label of ["Start a conversation", "Join with invitation"]) {
      const pressable = findPressableAncestor(findAllByText(renderer.root, label)[0]!);
      expect(pressable?.props.disabled).toBe(true);
    }

    // Even invoking the disabled handlers directly, the Router's navigate
    // gate refuses chat/start/join while !ready/errored — the screens that
    // call useChatController() during render stay unreachable.
    for (const label of ["Start a conversation", "Join with invitation"]) {
      const matches = findAllByText(renderer.root, label);
      const pressable = findPressableAncestor(matches[0]!);
      const onPress: unknown = pressable?.props.onPress;
      expect(typeof onPress).toBe("function");
      act(() => {
        (onPress as () => void)();
      });
    }
    expect(findAllByText(renderer.root, "Start a conversation").length).toBeGreaterThan(0);
    expect(findAllByText(renderer.root, "Generate invitation").length).toBe(0);
    expect(findAllByText(renderer.root, "Invitation link").length).toBe(0);

    await act(async () => {
      renderer.unmount();
    });
  });
});

describe("AppErrorBoundary (R8/F2 safety net)", () => {
  it("renders the fallback instead of crashing when a child throws during render", async () => {
    function Thrower(): React.ReactElement {
      throw new Error("boom");
    }
    // Silence the expected diagnostics: the boundary's console.warn AND
    // React's default caught-error logging (console.error).
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    let renderer!: Renderer;
    await act(async () => {
      renderer = create(
        <AppErrorBoundary>
          <Thrower />
        </AppErrorBoundary>,
      );
    });
    expect(findAllByText(renderer.root, "Something went wrong").length).toBe(1);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    await act(async () => {
      renderer.unmount();
    });
  });
});
