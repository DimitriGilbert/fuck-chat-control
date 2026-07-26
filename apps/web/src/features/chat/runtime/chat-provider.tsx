import { createAtRestKeyManager } from "@/features/chat/runtime/at-rest-key-manager";
import type { AtRestKeyManager } from "@/features/chat/runtime/at-rest-key-manager";
import {
  createChatController,
  initialChatControllerState,
} from "@/features/chat/runtime/chat-controller";
import type { ChatController, ChatControllerState } from "@/features/chat/runtime/chat-controller";
import { createIdentityManager } from "@/features/chat/runtime/identity-manager";
import type { IdentityManager } from "@/features/chat/runtime/identity-manager";
import { InMemoryConversationRepository } from "@/features/chat/store";
import type { ConversationRepository } from "@/features/chat/store";
import type {
  SignalingSocket,
  SignalingSocketFactory,
} from "@/features/chat/signaling/signaling-client";
import type { AtRestKey } from "@/features/chat/crypto";

import * as React from "react";

/**
 * Adapts a browser `WebSocket` to the controller's {@link SignalingSocket}
 * interface. The browser's event-handler properties receive a DOM `Event`;
 * the controller expects nullary callbacks. This wrapper swallows the event
 * argument so both sides see the shape they want.
 */
function adaptBrowserSocket(raw: WebSocket): SignalingSocket {
  return {
    get readyState(): number {
      return raw.readyState;
    },
    send(data: string): void {
      raw.send(data);
    },
    close(code?: number, reason?: string): void {
      raw.close(code, reason);
    },
    set onopen(value: (() => void) | null) {
      raw.onopen = value === null ? null : () => value();
    },
    set onmessage(value: ((event: { readonly data: string }) => void) | null) {
      raw.onmessage = value === null ? null : (event: MessageEvent) => value({ data: event.data });
    },
    set onclose(value: (() => void) | null) {
      raw.onclose = value === null ? null : () => value();
    },
    set onerror(value: (() => void) | null) {
      raw.onerror = value === null ? null : () => value();
    },
  };
}

/**
 * Browser-only socket factory: defers the `WebSocket` reference until the
 * provider runs in the browser (TanStack Start SSRs the shell, and `WebSocket`
 * is not available on the server). The lazy read keeps this module SSR-safe.
 */
const createBrowserSocket: SignalingSocketFactory = (url: string): SignalingSocket =>
  adaptBrowserSocket(new WebSocket(url));

/**
 * Builds the controller deps from the current `window.location`. Only called
 * inside a `useEffect` (browser-only) so `window` is guaranteed present.
 */
function resolveBrowserDeps(): {
  brokerUrl: string;
  baseUrl: string;
} {
  const { protocol, host, origin } = window.location;
  const brokerUrl = `${protocol === "https:" ? "wss" : "ws"}://${host}/ws`;
  return { brokerUrl, baseUrl: origin };
}

const initialControllerState: ChatControllerState = initialChatControllerState;

export interface ChatContextValue {
  readonly controller: ChatController | null;
  readonly state: ChatControllerState;
  /**
   * True once the controller finished constructing and subscribed. Mirrors
   * `state.ready`; kept on the context value so consumers that read `useChat()`
   * once can gate without destructuring.
   */
  readonly ready: boolean;
}

const ChatContext = React.createContext<ChatContextValue | null>(null);

/**
 * Constructs the {@link ChatController} on the client and re-renders on every
 * state snapshot. SSR-safe: the controller is created inside `useEffect`, so
 * identity generation, `localStorage`, `RTCPeerConnection`, and `WebSocket`
 * only ever run in the browser.
 */
export function ChatProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [controller, setController] = React.useState<ChatController | null>(null);
  const [state, setState] = React.useState<ChatControllerState>(initialControllerState);
  const [ready, setReady] = React.useState(false);

  React.useEffect(() => {
    let unsubscribe = (): void => {};
    let disposedController: ChatController | null = null;
    let cancelled = false;

    try {
      const { brokerUrl, baseUrl } = resolveBrowserDeps();
      const identityManager: IdentityManager = createIdentityManager(window.localStorage);
      const atRestKeyManager: AtRestKeyManager = createAtRestKeyManager(window.localStorage);

      // Load persisted identity + at-rest key BEFORE constructing the
      // controller: createChatController reads both synchronously at
      // construction (the at-rest key seeds the repository), so they must
      // be resident first. Constructing eagerly led to "get() called before
      // ensureLoaded()" throwing inside the effect, which left `controller`
      // null and `ready` false forever — the start button never enabled.
      void Promise.all([identityManager.ensureLoaded(), atRestKeyManager.ensureLoaded()])
        .then(() => {
          if (cancelled) return;
          const repositoryFactory = (atRestKey: AtRestKey): ConversationRepository =>
            new InMemoryConversationRepository(atRestKey);

          const instance = createChatController({
            brokerUrl,
            baseUrl,
            identityManager,
            atRestKeyManager,
            repositoryFactory,
            socketFactory: createBrowserSocket,
            iceServers: [],
          });
          disposedController = instance;
          setController(instance);
          setState(instance.getState());
          unsubscribe = instance.subscribe((next) => {
            setState(next);
          });
          setReady(true);
        })
        .catch((err: unknown) => {
          // Surface load failures as controller errors so the UI can render
          // an inline alert rather than a half-mounted provider.
          setState({
            ...initialControllerState,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    } catch (err: unknown) {
      setState({
        ...initialControllerState,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return () => {
      cancelled = true;
      unsubscribe();
      if (disposedController !== null) {
        disposedController.dispose();
      }
    };
  }, []);

  const value = React.useMemo<ChatContextValue>(
    () => ({ controller, state, ready }),
    [controller, state, ready],
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

/**
 * Reads the chat context. Throws if used outside a {@link ChatProvider}.
 */
export function useChat(): ChatContextValue {
  const ctx = React.useContext(ChatContext);
  if (ctx === null) {
    throw new Error("useChat must be used inside <ChatProvider>");
  }
  return ctx;
}

/**
 * Convenience for components that only need to call controller actions. Throws
 * if the controller has not finished constructing (i.e. before `ready`).
 */
export function useChatController(): ChatController {
  const { controller, ready } = useChat();
  if (!ready || controller === null) {
    throw new Error("useChatController called before ChatProvider was ready");
  }
  return controller;
}
