import { createAtRestKeyManager } from "@fuck-eu-chat-control/chat-runtime/runtime/at-rest-key-manager";
import type { AtRestKeyManager } from "@fuck-eu-chat-control/chat-runtime/runtime/at-rest-key-manager";
import {
  createChatController,
  initialChatControllerState,
} from "@fuck-eu-chat-control/chat-runtime/runtime/chat-controller";
import type {
  ChatController,
  ChatControllerState,
} from "@fuck-eu-chat-control/chat-runtime/runtime/chat-controller";
import { createIdentityManager } from "@fuck-eu-chat-control/chat-runtime/runtime/identity-manager";
import type { IdentityManager } from "@fuck-eu-chat-control/chat-runtime/runtime/identity-manager";
import {
  InMemoryConversationRepository,
  setDurableStorage,
} from "@fuck-eu-chat-control/chat-runtime/store";
import type {
  ConversationRepository,
  DurableStorage,
} from "@fuck-eu-chat-control/chat-runtime/store";
import { BrowserDbConversationRepository } from "@/features/chat/store/browser-db-repo";
import { setSpake2ModuleUrl } from "@fuck-eu-chat-control/chat-runtime/crypto/pake";
import type {
  SignalingSocket,
  SignalingSocketFactory,
} from "@fuck-eu-chat-control/chat-runtime/signaling/signaling-client";
import type {
  IceServer,
  PeerConnectionFactory,
} from "@fuck-eu-chat-control/chat-runtime/transport/types";
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
 * MEDIUM-E (Dokploy fix): `publicBaseUrl` is seeded from the SAME `"self"`
 * → origin translation as `baseUrl`, then OVERWRITTEN by the runtime
 * `/ice-config` response's `publicBaseUrl` field when the server carries one
 * (see {@link fetchIceConfig}). This keeps the web app's invitation prefix in
 * sync with the server's `PUBLIC_BASE_URL` env, which Dokploy injects into
 * the web CONTAINER at run time — NOT baked into a build. The injected value
 * here is only the desktop fallback (the web build does not inject
 * `__FCK_CONFIG__`, so the `"self"` → origin branch produces
 * `window.location.origin`, which `/ice-config` later overrides if the
 * operator configured `PUBLIC_BASE_URL`).
 *
 * `iceServers` is threaded through when the desktop shell bakes in an
 * operator-configured STUN/TURN list (via `FCK_ICE_SERVERS`). Inside a
 * `tauri://` webview, `window.location.origin` is the custom-protocol asset
 * handler, not a real HTTP server, so a relative `/ice-config` fetch is a
 * dead path — the provider uses the injected list directly in that case.
 * Returns `undefined` on the web build so the provider falls through to
 * `fetchIceConfig()`.
 *
 * Only called inside a `useEffect` (browser-only) so `window` is guaranteed
 * present.
 */
function resolveBrowserDeps(): {
  brokerUrl: string;
  baseUrl: string;
  publicBaseUrl: string;
  iceServers: readonly IceServer[] | undefined;
} {
  const injected = getFckConfig();
  if (injected?.brokerUrl !== undefined) {
    const baseUrl =
      injected.baseUrl === undefined || injected.baseUrl === "self"
        ? window.location.origin
        : injected.baseUrl;
    // MEDIUM-E: seed publicBaseUrl from the injected config using the same
    // `"self"` → origin translation as `baseUrl`. The desktop shell now
    // ALWAYS injects `"self"` for publicBaseUrl (the compile-time
    // `option_env!("FCK_PUBLIC_BASE_URL")` was removed); the runtime value —
    // when the operator configures `PUBLIC_BASE_URL` on the web server —
    // arrives via the /ice-config fetch below, which overwrites this seed.
    const publicBaseUrl =
      injected.publicBaseUrl === undefined || injected.publicBaseUrl === "self"
        ? window.location.origin
        : injected.publicBaseUrl;
    // Filter out an empty injected array so the provider treats "no servers
    // configured" the same as "field absent" — both fall back to the network
    // fetch on the web build, and to host-candidate-only WebRTC on desktop.
    //
    // M2: per-entry validation at the boundary. The injected list is threaded
    // through from `window.__FCK_CONFIG__` (Rust-built JSON) with a length
    // check only; a malformed entry (e.g. `url:` instead of `urls:`, or a
    // `{ username, credential }`-only entry with no `urls`) would otherwise
    // flow into `new RTCPeerConnection({ iceServers: [{ urls: undefined }] })`
    // and silently break candidate gathering. Mirror the /ice-config fetch
    // path's reshape: project each entry to `{ urls, username?, credential? }`
    // and DROP any whose `urls` is not a string or non-empty array — stricter
    // to drop just the bad entry and keep the rest than to fail the whole list.
    const iceServers =
      injected.iceServers !== undefined && injected.iceServers.length > 0
        ? injected.iceServers
            .map((s): IceServer | null => {
              if (typeof s.urls !== "string" && !isNonEmptyStringArray(s.urls)) return null;
              const base: IceServer = { urls: s.urls };
              return {
                ...base,
                ...(s.username !== undefined ? { username: s.username } : {}),
                ...(s.credential !== undefined ? { credential: s.credential } : {}),
              };
            })
            .filter((s): s is IceServer => s !== null)
        : undefined;
    return { brokerUrl: injected.brokerUrl, baseUrl, publicBaseUrl, iceServers };
  }
  const { protocol, host, origin } = window.location;
  const brokerUrl = `${protocol === "https:" ? "wss" : "ws"}://${host}/ws`;
  return { brokerUrl, baseUrl: origin, publicBaseUrl: origin, iceServers: undefined };
}

/**
 * Phase 0: fetch the ICE server list (STUN/TURN/TURNS, with freshly minted
 * TURN credentials) from the same-origin /ice-config route. Returns `[]` on
 * any failure — network error, non-2xx, malformed body, or an empty config —
 * so that loopback/LAN/CI deployments (where the endpoint may be unconfigured
 * or absent) keep working with host-candidate-only WebRTC. A failed fetch
 * MUST NOT break controller construction.
 *
 * MEDIUM-E (Dokploy fix): the /ice-config response now ALSO carries the
 * server's runtime `publicBaseUrl` (the `PUBLIC_BASE_URL` env var Dokploy
 * injects into the web container). The SPA applies that value as the prefix
 * of every generated invitation link when present, overriding the
 * `resolveBrowserDeps` seed (which is `window.location.origin` on the web
 * build). When absent, the seed stays — preserving the legacy behavior for
 * operators who do not configure `PUBLIC_BASE_URL`. Both fields share the
 * same fetch + timeout + fail-open posture.
 *
 * Uses a relative URL so it inherits the current origin (http in dev,
 * https in prod); no hard-coded host.
 *
 * Mirrors the mobile adapter's `fetchIceServers`
 * (`apps/mobile/src/chat/config.ts`): an `AbortController` + 5-second timeout
 * guarantees an unresponsive `/ice-config` cannot hang controller construction.
 * The two adapters stay intentionally decoupled (no shared helper) — the
 * mobile build cannot import browser-only globals and the web build should
 * not grow a dependency on the Expo config module.
 */
async function fetchIceConfig(): Promise<{
  readonly iceServers: readonly IceServer[];
  readonly publicBaseUrl: string | undefined;
  readonly degraded: boolean;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  // R7/F4: fail-open is correct for dev/loopback, but a REAL prod failure
  // (TURN down, route broken) used to be completely silent — the app came up
  // host-candidate-only and cross-network peers just failed to connect. Log
  // every degraded outcome so operators can see it in the console/Sentry.
  const degraded = (): {
    readonly iceServers: readonly IceServer[];
    readonly publicBaseUrl: string | undefined;
    readonly degraded: boolean;
  } => {
    // eslint-disable-next-line no-console
    console.warn(
      "[chat-provider] /ice-config fetch degraded — continuing with host-candidate-only ICE. " +
        "Cross-network connections may fail in this deployment.",
    );
    return { iceServers: [], publicBaseUrl: undefined, degraded: true };
  };
  try {
    const response = await fetch("/ice-config", { signal: controller.signal });
    if (!response.ok) return degraded();
    const body = (await response.json()) as {
      readonly iceServers?: unknown;
      readonly publicBaseUrl?: unknown;
    };
    if (!Array.isArray(body.iceServers)) return degraded();
    // Map the untyped JSON body into the neutral IceServer shape at the fetch
    // boundary so the DOM RTCIceServer type never threads into the runtime.
    // The /ice-config route only emits { urls, username, credential } so this
    // is a pure contract fix — runtime behavior is unchanged. Extra DOM-only
    // fields (e.g. credentialType, iceProvider) are intentionally dropped.
    const raw = body.iceServers as ReadonlyArray<{
      readonly urls: string | readonly string[];
      readonly username?: string;
      readonly credential?: string;
    }>;
    const iceServers = raw.map((s): IceServer => {
      const base: IceServer = { urls: s.urls };
      // IceServer's fields are readonly, so build the entry with conditional
      // spreads rather than mutating after construction.
      return {
        ...base,
        ...(s.username !== undefined ? { username: s.username } : {}),
        ...(s.credential !== undefined ? { credential: s.credential } : {}),
      };
    });
    // MEDIUM-E: pull the runtime publicBaseUrl from the server. Only accept a
    // non-empty string — the route omits the field entirely when
    // PUBLIC_BASE_URL is unset, but defensive-guard against an empty string
    // so the seed (`window.location.origin`) wins in both absent AND empty
    // cases. Treat anything else as "unset".
    const publicBaseUrl =
      typeof body.publicBaseUrl === "string" && body.publicBaseUrl.length > 0
        ? body.publicBaseUrl
        : undefined;
    return { iceServers, publicBaseUrl, degraded: false };
  } catch {
    // Swallow (covers both network errors and the abort timeout): the
    // controller accepts an empty list and falls back to host candidates.
    // Surfacing this error would block chat in loopback dev/CI, where
    // /ice-config legitimately returns nothing. R7/F4 still logs it via
    // degraded() so prod TURN outages are observable.
    return degraded();
  } finally {
    clearTimeout(timeout);
  }
}

const initialControllerState: ChatControllerState = initialChatControllerState;

/**
 * Probes `window.localStorage` and returns either a throw-swallowing wrapper
 * (when the probe writes cleanly) or `null` (Safari private mode, disabled
 * storage, quota-exceeded even on the probe). Returning `null` engages the
 * runtime's existing null-degradation path: the durable store reads as "no
 * value" and writes no-op, so first-run identity / at-rest key generation
 * proceeds against an in-memory-only backing rather than throwing a
 * `QuotaExceededError` that aborts controller construction permanently.
 *
 * The wrapper re-wraps EVERY `getItem`/`setItem` in try/catch because Safari
 * private mode throws on write even when the read probe succeeds, and a quota
 * exhaustion hit later in the session must not take down the controller. The
 * surface matches {@link DurableStorage} exactly: synchronous
 * `getItem → string | null`, `setItem → void`.
 *
 * `createIdentityManager` and `createAtRestKeyManager` both consume the same
 * `{ getItem, setItem }` shape and share the SAME wrapped instance here so a
 * single probe governs both. When the probe fails the managers receive a
 * no-op store (reads "absent", writes drop) — mirroring the runtime's
 * null-degradation semantics for managers that take a non-nullable storage.
 */
function safeStorage(): DurableStorage | null {
  const probeKey = "__fck_storage_probe__";
  try {
    window.localStorage.setItem(probeKey, "1");
    window.localStorage.removeItem(probeKey);
  } catch {
    return null;
  }
  return {
    getItem(key: string): string | null {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    setItem(key: string, value: string): void {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // Swallow: a throw on write (Safari private mode, quota exhausted
        // mid-session) must not reach the controller. Persistence is
        // best-effort; the runtime already tolerates a null store.
      }
    },
  };
}

/**
 * No-op store handed to the identity / at-rest-key managers when
 * `safeStorage()` returns `null`. Their factory signatures take a non-nullable
 * `{ getItem, setItem }`, but we want the SAME degradation as
 * `setDurableStorage(null)`: reads "absent" (so first-run generation proceeds)
 * and writes drop (ephemeral session). This keeps the managers' contracts
 * intact without forcing a `null`-tolerant signature change in chat-runtime.
 */
const ephemeralStorage: DurableStorage = {
  getItem: (): string | null => null,
  setItem: (): void => {},
};

/**
 * Narrows an unknown value to a non-empty `readonly string[]`. Used by the
 * injected-ICE-server validator to accept the `IceServer.urls` array form
 * without an `any` cast. A non-string element or empty array rejects the
 * entry so it is dropped at the boundary.
 */
function isNonEmptyStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string");
}

export interface ChatContextValue {
  readonly controller: ChatController | null;
  readonly state: ChatControllerState;
  /**
   * True once the controller finished constructing and subscribed. Mirrors
   * `state.ready`; kept on the context value so consumers that read `useChat()`
   * once can gate without destructuring.
   */
  readonly ready: boolean;
  /**
   * R7/F4: true when the /ice-config fetch degraded (network error, non-2xx,
   * or malformed body). The app intentionally fails open — host-candidate ICE
   * still works on loopback/LAN — but a prod TURN outage is now observable
   * instead of silently producing "peers can't connect" reports.
   */
  readonly iceDegraded: boolean;
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
  const [iceDegraded, setIceDegraded] = React.useState(false);

  React.useEffect(() => {
    let unsubscribe = (): void => {};
    let disposedController: ChatController | null = null;
    let disposedIdentityManager: IdentityManager | null = null;
    let disposedAtRestKeyManager: AtRestKeyManager | null = null;
    let cancelled = false;

    try {
      const {
        brokerUrl,
        baseUrl,
        publicBaseUrl,
        iceServers: injectedIceServers,
      } = resolveBrowserDeps();
      // Phase A.6: register the platform's durable KV store (window.localStorage)
      // and the SPAKE2 WASM module URL the runtime imports lazily. These MUST be
      // registered before createChatController so the runtime core (which no
      // longer touches DOM globals directly) reads through the injected handles.
      //
      // H3: wrap localStorage so a throwing store degrades to `null` rather than
      // aborting controller construction. Safari private-mode throws
      // QuotaExceededError on the FIRST write (identity/key gen during
      // first-run), which without this wrapper propagates out of the effect and
      // leaves `controller` null + `ready` false forever. The runtime's
      // null-degradation path reads "no value" / no-ops writes, so first-run
      // generation proceeds against in-memory-only backing. The managers take a
      // non-nullable store so they receive a no-op fallback when the probe
      // failed; both share the SAME storage instance (single probe governs all).
      const storage = safeStorage();
      // Only register when the probe succeeded. `setDurableStorage`'s signature
      // is non-nullable, and leaving the module-level store at its initial
      // `null` IS the runtime's null-degradation path (getDurableStorage()
      // returns null → auth-failed store reads "absent", writes no-op).
      if (storage !== null) {
        setDurableStorage(storage);
      }
      const managerStorage = storage ?? ephemeralStorage;
      setSpake2ModuleUrl("/wasm/spake2/pkg/fck_spake2.js");
      const identityManager: IdentityManager = createIdentityManager(managerStorage);
      const atRestKeyManager: AtRestKeyManager = createAtRestKeyManager(managerStorage);
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
      // `iceServers?: readonly IceServer[]` accepts undefined and treats it as
      // loopback-only.
      //
      // MEDIUM-E (Dokploy fix): the same /ice-config fetch now ALSO carries
      // the server's runtime `publicBaseUrl` (the `PUBLIC_BASE_URL` env var
      // Dokploy injects into the web container). When the server carries one,
      // it OVERRIDES the seed `publicBaseUrl` resolved by
      // `resolveBrowserDeps()` (which is `window.location.origin` on the web
      // build — the legacy default); when absent, the seed stays so operators
      // who do not configure `PUBLIC_BASE_URL` see no behavior change.
      //
      // Phase 6: inside the desktop shell, `/ice-config` is a dead path
      // (tauri:// webview has no HTTP origin), so when the shell injects a
      // non-empty `iceServers` list via `__FCK_CONFIG__` we use it directly
      // and skip the network fetch. In that case the seed publicBaseUrl
      // (`window.location.origin`, translated from the desktop `"self"`
      // injection) is the final value — consistent with the desktop having no
      // reachable server to provide a runtime override.
      const iceConfigPromise =
        injectedIceServers !== undefined
          ? Promise.resolve({
              iceServers: injectedIceServers,
              publicBaseUrl: undefined,
              degraded: false,
            })
          : fetchIceConfig();
      void Promise.all([
        identityManager.ensureLoaded(),
        atRestKeyManager.ensureLoaded(),
        iceConfigPromise,
      ])
        .then(async ([, , iceConfig]) => {
          if (cancelled) return;
          // R7/F4: publish the degraded flag for the UI/observability even
          // though the controller construction below proceeds fail-open.
          setIceDegraded(iceConfig.degraded);
          // Phase A.4: inject the web WebRTC adapter. The runtime core calls
          // this factory instead of `new WebRtcAdapter(...)` so the no-DOM
          // chat-runtime package never references RTCPeerConnection directly.
          const peerConnectionFactory: PeerConnectionFactory = (opts) => new WebRtcAdapter(opts);

          // MEDIUM-E: apply the runtime publicBaseUrl override from /ice-config
          // ONLY when the server carried a non-empty value; otherwise keep the
          // seed (`window.location.origin` on web, or the desktop's injected
          // value). This is the single source of truth for the web app's
          // invitation-link prefix under Dokploy.
          const resolvedPublicBaseUrl =
            iceConfig.publicBaseUrl !== undefined ? iceConfig.publicBaseUrl : publicBaseUrl;

          // Persistence: prefer the OPFS-backed SQLite store so conversations
          // and messages survive reloads. Fall back to the in-memory repo when
          // OPFS is unavailable (private browsing, sandboxed iframes, or any
          // browser that lacks navigator.storage.getDirectory + Worker). The
          // fallback keeps the chat working — just without cross-reload history.
          // The repo is built BEFORE the controller (the OPFS DB open + the
          // collections' first hydration are async); a ready repo is then passed
          // in via `repository` so the controller stays synchronous.
          const atRestKey = atRestKeyManager.get();
          let repository: ConversationRepository;
          try {
            repository = await BrowserDbConversationRepository.create({
              databaseName: "fck-chat-control",
              atRestKey,
            });
          } catch {
            repository = new InMemoryConversationRepository(atRestKey);
          }

          const instance = createChatController({
            brokerUrl,
            baseUrl,
            publicBaseUrl: resolvedPublicBaseUrl,
            identityManager,
            atRestKeyManager,
            repository,
            // Factory is required by the type but unused when `repository` is set.
            repositoryFactory: () => repository,
            socketFactory: createBrowserSocket,
            peerConnectionFactory,
            iceServers: iceConfig.iceServers,
          });
          // M3: re-check `cancelled` AFTER the async repository-create yield
          // and BEFORE publishing the controller. The check at the top of this
          // .then runs synchronously, but the `await BrowserDbConversationRepository.create`
          // above is a real yield — if unmount fired during it, the cleanup
          // already ran with `disposedController === null` (socket/peer/OPFS
          // nothing yet to release) and this resumed continuation would
          // otherwise assign `disposedController = instance`, then call
          // setController/subscribe/setReady on an unmounted component (leaked
          // controller + setState-on-unmounted). Construct-then-dispose here
          // releases the broker socket, peer connections, and OPFS handles the
          // constructor just opened, then bail without touching React state.
          // This race is reachable via ordinary route transitions, not just
          // StrictMode double-mount (StrictMode is not enabled in this app).
          if (cancelled) {
            instance.dispose();
            return;
          }
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
    () => ({ controller, state, ready, iceDegraded }),
    [controller, state, ready, iceDegraded],
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
