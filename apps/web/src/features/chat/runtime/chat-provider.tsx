import { createAtRestKeyManager } from "@fuck-eu-chat-control/chat-runtime/runtime/at-rest-key-manager";
import type { AtRestKeyManager } from "@fuck-eu-chat-control/chat-runtime/runtime/at-rest-key-manager";
import {
  createChatController,
  initialChatControllerState,
} from "@fuck-eu-chat-control/chat-runtime/runtime/chat-controller";
import type { ChatController, ChatControllerState } from "@fuck-eu-chat-control/chat-runtime/runtime/chat-controller";
import { createIdentityManager } from "@fuck-eu-chat-control/chat-runtime/runtime/identity-manager";
import type { IdentityManager } from "@fuck-eu-chat-control/chat-runtime/runtime/identity-manager";
import { InMemoryConversationRepository, setDurableStorage } from "@fuck-eu-chat-control/chat-runtime/store";
import type { ConversationRepository } from "@fuck-eu-chat-control/chat-runtime/store";
import { setSpake2ModuleUrl } from "@fuck-eu-chat-control/chat-runtime/crypto/pake";
import type {
  SignalingSocket,
  SignalingSocketFactory,
} from "@fuck-eu-chat-control/chat-runtime/signaling/signaling-client";
import type { PeerConnectionFactory } from "@fuck-eu-chat-control/chat-runtime/transport/types";
import type { AtRestKey } from "@fuck-eu-chat-control/chat-runtime/crypto";
import { WebRtcAdapter } from "@/features/chat/signaling/webrtc-adapter";
import { getFckConfig } from "@/features/chat/runtime/fck-config";

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
 * Builds the controller deps for the browser. Reads the desktop shell's
 * injected {@link FckRuntimeConfig} (via `window.__FCK_CONFIG__`) FIRST so the
 * Tauri webview can dial a deployed broker; on the web build nothing is
 * injected and it falls back to deriving both from `window.location`.
 *
 * The `baseUrl: "self"` sentinel means "use the page's own origin" (assets
 * ship inside the desktop shell's `frontendDist`, so same-origin is correct)
 * — translated back to `window.location.origin` here so the rest of the
 * runtime never needs to know about the injection.
 *
 * Only called inside a `useEffect` (browser-only) so `window` is guaranteed
 * present.
 */
function resolveBrowserDeps(): {
  brokerUrl: string;
  baseUrl: string;
} {
  const injected = getFckConfig();
  if (injected?.brokerUrl !== undefined) {
    const baseUrl = injected.baseUrl === undefined || injected.baseUrl === "self"
      ? window.location.origin
      : injected.baseUrl;
    return { brokerUrl: injected.brokerUrl, baseUrl };
  }
  const { protocol, host, origin } = window.location;
  const brokerUrl = `${protocol === "https:" ? "wss" : "ws"}://${host}/ws`;
  return { brokerUrl, baseUrl: origin };
}

/**
 * Phase 0: fetch the ICE server list (STUN/TURN/TURNS, with freshly minted
 * TURN credentials) from the same-origin /ice-config route. Returns `[]` on
 * any failure — network error, non-2xx, malformed body, or an empty config —
 * so that loopback/LAN/CI deployments (where the endpoint may be unconfigured
 * or absent) keep working with host-candidate-only WebRTC. A failed fetch
 * MUST NOT break controller construction.
 *
 * Uses a relative URL so it inherits the current origin (http in dev,
 * https in prod); no hard-coded host.
 */
async function fetchIceServers(): Promise<RTCIceServer[]> {
  try {
    const response = await fetch("/ice-config");
    if (!response.ok) return [];
    const body = (await response.json()) as { readonly iceServers?: unknown };
    if (!Array.isArray(body.iceServers)) return [];
    return body.iceServers as RTCIceServer[];
  } catch {
    // Swallow: the controller accepts an empty list and falls back to host
    // candidates. Surfacing this error would block chat in loopback dev/CI,
    // where /ice-config legitimately returns nothing.
    return [];
  }
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
    let disposedIdentityManager: IdentityManager | null = null;
    let disposedAtRestKeyManager: AtRestKeyManager | null = null;
    let cancelled = false;

    try {
      const { brokerUrl, baseUrl } = resolveBrowserDeps();
      // Phase A.6: register the platform's durable KV store (window.localStorage)
      // and the SPAKE2 WASM module URL the runtime imports lazily. These MUST be
      // registered before createChatController so the runtime core (which no
      // longer touches DOM globals directly) reads through the injected handles.
      setDurableStorage(window.localStorage);
      setSpake2ModuleUrl("/wasm/spake2/pkg/fck_spake2.js");
      const identityManager: IdentityManager = createIdentityManager(window.localStorage);
      const atRestKeyManager: AtRestKeyManager = createAtRestKeyManager(window.localStorage);
      disposedIdentityManager = identityManager;
      disposedAtRestKeyManager = atRestKeyManager;

      // Load persisted identity + at-rest key BEFORE constructing the
      // controller: createChatController reads both synchronously at
      // construction (the at-rest key seeds the repository), so they must
      // be resident first. Constructing eagerly led to "get() called before
      // ensureLoaded()" throwing inside the effect, which left `controller`
      // null and `ready` false forever — the start button never enabled.
      //
      // Phase 0: in parallel, fetch /ice-config so we can pass STUN/TURN
      // servers (with freshly minted TURN credentials) into the controller.
      // The fetch is intentionally NOT in the critical path of
      // ensureLoaded — it shares the same Promise.all only for concurrency.
      // A fetch failure MUST fall back to an empty iceServers list so
      // loopback/LAN/CI (where /ice-config may return nothing or the dev
      // server is unconfigured) keep working; the controller's
      // `iceServers?: RTCIceServer[]` accepts undefined and treats it as
      // loopback-only.
      void Promise.all([
        identityManager.ensureLoaded(),
        atRestKeyManager.ensureLoaded(),
        fetchIceServers(),
      ])
        .then(([, , iceServers]) => {
          if (cancelled) return;
          const repositoryFactory = (atRestKey: AtRestKey): ConversationRepository =>
            new InMemoryConversationRepository(atRestKey);

          // Phase A.4: inject the web WebRTC adapter. The runtime core calls
          // this factory instead of `new WebRtcAdapter(...)` so the no-DOM
          // chat-runtime package never references RTCPeerConnection directly.
          const peerConnectionFactory: PeerConnectionFactory = (opts) => new WebRtcAdapter(opts);

          const instance = createChatController({
            brokerUrl,
            baseUrl,
            identityManager,
            atRestKeyManager,
            repositoryFactory,
            socketFactory: createBrowserSocket,
            peerConnectionFactory,
            iceServers,
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
      // R9/F8: on unmount, drop the in-memory at-rest key and the identity
      // reference so neither stays resident after the provider is gone. Both
      // managers rehydrate from storage on the next mount; this is about not
      // keeping secret material live in a discarded closure.
      disposedAtRestKeyManager?.lock();
      disposedIdentityManager?.evict();
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
