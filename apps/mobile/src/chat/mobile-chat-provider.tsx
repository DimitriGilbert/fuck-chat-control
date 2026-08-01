/**
 * React Native composition root for chat-runtime.
 *
 * Mirrors the web provider (apps/web/src/features/chat/runtime/chat-provider.tsx)
 * with three RN substitutions:
 *
 *  1. storage: the MMKV-backed {@link chatStorage} satisfies IdentityStorage,
 *     AtRestStorage, AND DurableStorage (one sync instance registered via
 *     `setDurableStorage` + passed to both managers).
 *  2. peerConnectionFactory: {@link rnPeerConnectionFactory} (react-native-webrtc).
 *  3. socketFactory: {@link rnSocketFactory} (RN built-in WebSocket).
 *
 * SYNC IS LOAD-BEARING: `createChatController` reads `atRestKeyManager.get()`
 * synchronously at construction. The provider MUST
 * `await Promise.all([identity.ensureLoaded(), atRest.ensureLoaded()])`
 * BEFORE constructing the controller, or `get()` throws "called before
 * ensureLoaded()" — exactly mirroring the web provider's gating.
 *
 * The crypto polyfill is NOT imported here — it MUST run at the very top of
 * the app entry (App.tsx) before this module's transitive chat-runtime imports
 * are evaluated. See App.tsx for the ordering proof.
 */
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
import type { ConversationRepository } from "@fuck-eu-chat-control/chat-runtime/store";
import type { AtRestKey } from "@fuck-eu-chat-control/chat-runtime/crypto";
import type { IceServer } from "@fuck-eu-chat-control/chat-runtime/transport/types";

import * as React from "react";

import { chatStorage, ensureStorageReady } from "./mmkv-storage";
import { rnPeerConnectionFactory } from "./rn-peer-connection-factory";
import { rnSocketFactory } from "./rn-socket-factory";
import { fetchIceServers, resolveRuntimeConfig } from "./config";

/**
 * Sentinel thrown when `ensureStorageReady()` rejects — i.e. the OS
 * keychain/keystore is unavailable so the MMKV encryption key cannot be
 * loaded/generated. Module-private: the only consumer is the construction
 * `.catch` below, which uses `instanceof` to surface the specific user-facing
 * message ("secure storage unavailable") instead of the generic "could not
 * start" error. Wrapping the original cause keeps the underlying SecureStore
 * error available for diagnostics without leaking it into state.error.
 */
class SecureStorageUnavailableError extends Error {
  constructor(public readonly cause: unknown) {
    super("Secure storage is unavailable on this device.");
    this.name = "SecureStorageUnavailableError";
  }
}

export interface ChatContextValue {
  readonly controller: ChatController | null;
  readonly state: ChatControllerState;
  /** True once the controller finished constructing and subscribed. */
  readonly ready: boolean;
}

const ChatContext = React.createContext<ChatContextValue | null>(null);

const initialControllerState: ChatControllerState = initialChatControllerState;

/**
 * Constructs the {@link ChatController} after the platform storage is loaded.
 * The controller is created inside `useEffect` (not at module load) so native
 * modules (MMKV, WebSocket, RTCPeerConnection) only run after React mounts.
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
      const { brokerUrl, baseUrl } = resolveRuntimeConfig();
      // Load the OS-keychain-bound MMKV encryption key (generating + persisting
      // it on first launch) and construct the encrypted MMKV instance BEFORE
      // any manager reads from chatStorage. The runtime storage contract is
      // synchronous, so chatStorage throws until ensureStorageReady() resolves;
      // chaining it as the first async step keeps the manager construction
      // (which reads chatStorage synchronously) inside the .then continuation.
      // NOTE: AtRestKeyManager also exposes a passphrase/PIN mode
      // (setPassphrase / unlock) that wraps the auto key under an
      // Argon2id-derived KEK. That passphrase UX is intentionally UNWIRED in
      // the mobile UI by product decision; wiring a user-facing passphrase/PIN
      // boot flow is out of scope for v1. The OS-keychain-bound MMKV
      // encryption key (loaded here) is the v1 at-rest mitigation: the raw
      // AES at-rest key + identity private key are now sealed inside an MMKV
      // file that is itself encrypted with a key held only in the OS
      // keychain/keystore. Passphrase mode remains available for a future boot
      // flow if the threat model shifts.
      void ensureStorageReady()
        .catch((storageErr: unknown) => {
          // H2 fail-closed: ensureStorageReady() rejects when the OS
          // keychain/keystore is unavailable (SecureStore rejected while
          // loading/generating the MMKV encryption key). storageInstance
          // stays null, so the runtime managers can NOT be constructed —
          // constructing them would throw "used before ready" anyway, and
          // more importantly would have no encrypted store to read/write.
          // Wrap in the sentinel so the terminal .catch surfaces the specific
          // user-facing message instead of the generic construction error.
          // Rethrow to keep the chain rejected so the construction .then is
          // skipped (controller is never built on a plaintext store).
          throw new SecureStorageUnavailableError(storageErr);
        })
        .then(() => {
          if (cancelled) return;
          // Register the MMKV-backed store as the runtime's DurableStorage
          // BEFORE constructing any manager that may touch it. One sync
          // instance backs identity, the at-rest key, and the durable flag
          // store.
          setDurableStorage(chatStorage);
          const identityManager = createIdentityManager(chatStorage);
          const atRestKeyManager = createAtRestKeyManager(chatStorage);
          disposedIdentityManager = identityManager;
          disposedAtRestKeyManager = atRestKeyManager;

          // Load persisted identity + at-rest key BEFORE constructing the
          // controller: createChatController reads both synchronously at
          // construction (the at-rest key seeds the repository). Fetch ICE
          // config in parallel — a fetch failure falls back to an empty list
          // so loopback/LAN keep working.
          return Promise.all([
            identityManager.ensureLoaded(),
            atRestKeyManager.ensureLoaded(),
            fetchIceServers(),
          ]).then(([, , iceServers]) => {
            if (cancelled) return;
            // React Native has no OPFS/Web Worker, so the browser SQLite
            // persistence package is not usable here. History is in-memory for
            // now; identity/at-rest/durable flags persist via MMKV. A native
            // SQLite store is a follow-up.
            const repositoryFactory = (atRestKey: AtRestKey): ConversationRepository =>
              new InMemoryConversationRepository(atRestKey);

            const instance = createChatController({
              brokerUrl,
              baseUrl,
              identityManager,
              atRestKeyManager,
              repositoryFactory,
              socketFactory: rnSocketFactory,
              peerConnectionFactory: rnPeerConnectionFactory,
              iceServers: iceServers as readonly IceServer[],
            });
            disposedController = instance;
            setController(instance);
            setState(instance.getState());
            unsubscribe = instance.subscribe((next) => {
              setState(next);
            });
            setReady(true);
          });
        })
        .catch((err: unknown) => {
          // Redact internal detail (broker/base URL, manager / controller
          // construction identifiers) from state.error. The original is kept
          // for diagnostics only. A SecureStorageUnavailableError carries the
          // specific H2 fail-closed message; anything else is a construction
          // failure (manager/controller/ICE) and gets the generic message.
          if (err instanceof SecureStorageUnavailableError) {
            console.warn(
              "ChatProvider: secure storage unavailable, cannot start chat",
              err.cause,
            );
            setState({
              ...initialControllerState,
              error:
                "Secure storage is unavailable on this device. Chat cannot start safely.",
            });
            return;
          }
          console.warn("ChatProvider construction failed", err);
          setState({
            ...initialControllerState,
            error: "Could not start the chat session.",
          });
        });
    } catch (err: unknown) {
      // See .catch above: redact internal detail from state.error.
      console.warn("ChatProvider construction failed", err);
      setState({
        ...initialControllerState,
        error: "Could not start the chat session.",
      });
    }

    return () => {
      cancelled = true;
      unsubscribe();
      if (disposedController !== null) {
        disposedController.dispose();
      }
      // R9/F8: drop the in-memory at-rest key + identity on unmount so secret
      // material does not stay resident after the provider is gone.
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

/** Reads the chat context. Throws if used outside a {@link ChatProvider}. */
export function useChat(): ChatContextValue {
  const ctx = React.useContext(ChatContext);
  if (ctx === null) {
    throw new Error("useChat must be used inside <ChatProvider>");
  }
  return ctx;
}

/**
 * Subscribe to the controller's state snapshot and re-render on every change.
 * Preferred over reading `useChat().state` directly when a screen needs the
 * controller too — avoids a double subscription and keeps the render in sync
 * with `controller.getState()`.
 */
export function useChatState(): ChatControllerState {
  const { state } = useChat();
  return state;
}

/**
 * Convenience for components that only need controller actions. Throws if the
 * controller has not finished constructing (before `ready`).
 */
export function useChatController(): ChatController {
  const { controller, ready } = useChat();
  if (!ready || controller === null) {
    throw new Error("useChatController called before ChatProvider was ready");
  }
  return controller;
}
