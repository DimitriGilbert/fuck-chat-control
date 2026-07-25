import { Role } from "@/features/chat/protocol/types";
import type { ConversationId } from "@/features/chat/protocol/types";
import { ConversationOrchestrator } from "@/features/chat/orchestrator/orchestrator";
import type { OrchestratorHandlers } from "@/features/chat/orchestrator/orchestrator";
import type { PeerTransport } from "@/features/chat/orchestrator/peer-transport";
import { ConnectionState } from "@/features/chat/signaling/state-machine";
import type { SignalingSocketFactory } from "@/features/chat/signaling/signaling-client";
import { exportBundle, importBundle, ImportMode } from "@/features/chat/store";
import type {
  ConversationMessage,
  ConversationRecord,
  ConversationRepository,
  ImportResult,
} from "@/features/chat/store";

import type { AtRestKeyManager } from "./at-rest-key-manager";
import type { AtRestKey } from "@/features/chat/crypto";
import type { IdentityManager } from "./identity-manager";
import { WebRtcBridge } from "./webrtc-bridge";

export { ImportMode };

/**
 * Immutable state snapshot React consumers read. Mutated only by replacing
 * the reference the controller holds (a new object per change).
 */
export interface ChatControllerState {
  readonly connectionState: ConnectionState;
  readonly conversationId: ConversationId | null;
  readonly invitation: string | null;
  readonly safetyNumber: string | null;
  readonly safetyNumberVerified: boolean;
  readonly messages: readonly ConversationMessage[];
  readonly conversations: readonly ConversationRecord[];
  readonly error: string | null;
}

export interface ChatControllerDeps {
  /** Broker WebSocket URL — the controller passes it to each orchestrator. */
  readonly brokerUrl: string;
  /** Base URL used to format invitation links. */
  readonly baseUrl: string;
  /** Owns the device identity. */
  readonly identityManager: IdentityManager;
  /** Owns the at-rest key used to seal history. */
  readonly atRestKeyManager: AtRestKeyManager;
  /** Factory for the conversation repository, invoked once with the at-rest key. */
  readonly repositoryFactory: (atRestKey: AtRestKey) => ConversationRepository;
  /** Factory for the underlying signaling WebSocket (testability). */
  readonly socketFactory: SignalingSocketFactory;
  /** ICE servers for WebRTC. Empty array = loopback-only. */
  readonly iceServers?: RTCIceServer[];
}

export interface ChatController {
  startConversation(): Promise<{ invitation: string }>;
  joinConversation(fragment: string): Promise<void>;
  resumeConversation(conversationId: ConversationId): Promise<void>;
  sendText(text: string): Promise<void>;
  leave(): void;
  retry(): void;
  markSafetyNumberVerified(): void;
  listConversations(): Promise<ConversationRecord[]>;
  getHistory(): Promise<ConversationMessage[]>;
  setDisplayName(name: string): Promise<void>;
  clearConversation(): Promise<void>;
  clearAll(): Promise<void>;
  exportBundle(passphrase: string): Promise<string>;
  importBundle(passphrase: string, bundle: string, mode: ImportMode): Promise<ImportResult>;
  subscribe(listener: (state: ChatControllerState) => void): () => void;
  getState(): ChatControllerState;
  dispose(): void;
}

const INITIAL_STATE: ChatControllerState = {
  connectionState: ConnectionState.Idle,
  conversationId: null,
  invitation: null,
  safetyNumber: null,
  safetyNumberVerified: false,
  messages: [],
  conversations: [],
  error: null,
};

/**
 * The single object React talks to. Owns identity, the at-rest key, a
 * {@link ConversationRepository}, and a per-active-conversation
 * {@link ConversationOrchestrator} wired to a {@link WebRtcBridge}.
 *
 * Non-React (plain TypeScript) so it is testable without a render tree.
 * React subscribes via {@link ChatController.subscribe} and reads
 * {@link ChatController.getState} to render.
 *
 * v1 ships with the in-memory repository; the bridge drives real WebRTC.
 */
export function createChatController(deps: ChatControllerDeps): ChatController {
  const atRestKey = deps.atRestKeyManager.get();
  const repository = deps.repositoryFactory(atRestKey);
  const listeners = new Set<(state: ChatControllerState) => void>();
  let state: ChatControllerState = { ...INITIAL_STATE, conversations: [] };
  let orchestrator: ConversationOrchestrator | null = null;
  let bridge: WebRtcBridge | null = null;
  let disposed = false;

  function setState(patch: Partial<ChatControllerState>): void {
    state = { ...state, ...patch };
    for (const listener of listeners) {
      listener(state);
    }
  }

  function snapshotConversations(
    records: readonly ConversationRecord[],
  ): readonly ConversationRecord[] {
    return records.slice();
  }

  async function refreshConversations(): Promise<void> {
    const conversations = await repository.listConversations();
    setState({ conversations: snapshotConversations(conversations) });
  }

  function emitError(message: string | null): void {
    setState({ error: message });
  }

  const orchestratorHandlers: OrchestratorHandlers = {
    onStateChange: (next: ConnectionState): void => {
      setState({ connectionState: next });
    },
    onMessage: (message: ConversationMessage): void => {
      // The orchestrator already persisted the message; refresh the snapshot
      // for the current conversation. Avoid copying on every message by
      // appending directly.
      const messages = state.messages.concat(message);
      setState({ messages });
    },
    onSafetyNumber: (safetyNumber: string, verified: boolean): void => {
      setState({ safetyNumber, safetyNumberVerified: verified });
    },
    onError: (error: unknown): void => {
      const message = error instanceof Error ? error.message : String(error);
      emitError(message);
    },
  };

  function attachTransport(transport: PeerTransport): void {
    const orch = orchestrator;
    if (orch === null) return;
    try {
      orch.attachTransport(transport);
    } catch (err) {
      orchestratorHandlers.onError?.(err);
    }
  }

  function buildBridge(conversationId: ConversationId, role: Role): WebRtcBridge {
    const orch = orchestrator;
    return new WebRtcBridge({
      brokerUrl: deps.brokerUrl,
      roomId: conversationId,
      role,
      socketFactory: deps.socketFactory,
      iceServers: deps.iceServers,
      transportReady: (transport): void => {
        attachTransport(transport);
      },
      // The bridge owns the single signaling socket; forward peer-presence to
      // the orchestrator so it can drive Waiting/Signaling/Disconnected without
      // opening a second broker socket (which would overflow the 2-peer room).
      onPeerJoin: (): void => {
        orch?.notifyPeerJoined();
      },
      onPeerLeave: (): void => {
        orch?.notifyPeerLeft();
      },
      onSignalingClosed: (): void => {
        orch?.notifySignalingClosed();
      },
    });
  }

  function disposeActiveBridge(): void {
    if (bridge !== null) {
      try {
        bridge.close();
      } catch {
        // best-effort
      }
      bridge = null;
    }
  }

  return {
    async startConversation(): Promise<{ invitation: string }> {
      if (orchestrator !== null) {
        throw new Error("a conversation is already active; call leave() first");
      }
      const identity = deps.identityManager.get();
      const orch = new ConversationOrchestrator({
        brokerUrl: deps.brokerUrl,
        baseUrl: deps.baseUrl,
        repository,
        socketFactory: deps.socketFactory,
        identity,
        handlers: orchestratorHandlers,
        useInternalSignaling: false,
      });
      orchestrator = orch;
      const invitation = await orch.start();
      const bridgeInstance = buildBridge(orch.conversationId as ConversationId, Role.Initiator);
      bridge = bridgeInstance;
      bridgeInstance.start();
      setState({
        invitation,
        conversationId: orch.conversationId,
        connectionState: orch.state,
      });
      await refreshConversations();
      return { invitation };
    },

    async joinConversation(fragment: string): Promise<void> {
      if (orchestrator !== null) {
        throw new Error("a conversation is already active; call leave() first");
      }
      const identity = deps.identityManager.get();
      const orch = new ConversationOrchestrator({
        brokerUrl: deps.brokerUrl,
        baseUrl: deps.baseUrl,
        repository,
        socketFactory: deps.socketFactory,
        identity,
        handlers: orchestratorHandlers,
        useInternalSignaling: false,
      });
      orchestrator = orch;
      await orch.join(fragment);
      const bridgeInstance = buildBridge(orch.conversationId as ConversationId, Role.Responder);
      bridge = bridgeInstance;
      bridgeInstance.start();
      setState({
        conversationId: orch.conversationId,
        connectionState: orch.state,
        invitation: null,
      });
      await refreshConversations();
    },

    async resumeConversation(conversationId: ConversationId): Promise<void> {
      const record = await repository.getConversation(conversationId);
      if (record === null) {
        throw new Error(`cannot resume unknown conversation ${conversationId}`);
      }
      if (orchestrator !== null) {
        throw new Error("a conversation is already active; call leave() first");
      }
      const identity = deps.identityManager.get();
      const orch = new ConversationOrchestrator({
        brokerUrl: deps.brokerUrl,
        baseUrl: deps.baseUrl,
        repository,
        socketFactory: deps.socketFactory,
        identity,
        handlers: orchestratorHandlers,
        useInternalSignaling: false,
      });
      orchestrator = orch;
      // Re-enter the conversation by joining with the existing conversation id.
      // The orchestrator's `join` re-creates the conversation record (idempotent
      // at the repository level for v1 in-memory store).
      const fragment = `#${hexFromId(conversationId)}`;
      await orch.join(fragment);
      const bridgeInstance = buildBridge(conversationId, Role.Initiator);
      bridge = bridgeInstance;
      bridgeInstance.start();
      const history = await orch.getHistory();
      setState({
        conversationId: orch.conversationId,
        connectionState: orch.state,
        invitation: null,
        messages: history,
      });
    },

    async sendText(text: string): Promise<void> {
      if (orchestrator === null) {
        throw new Error("cannot sendText: no active conversation");
      }
      await orchestrator.sendText(text);
      // The orchestrator already persisted; the snapshot will be updated by
      // onMessage? No — onMessage only fires for *received* messages. For sent
      // messages we refresh the local messages snapshot manually.
      const messages = await orchestrator.getHistory();
      setState({ messages });
    },

    leave(): void {
      if (orchestrator !== null) {
        try {
          orchestrator.leave();
        } catch {
          // best-effort
        }
      }
      disposeActiveBridge();
      orchestrator = null;
      // Clear the active conversation so the route returns to the landing
      // (where the conversation list + Resume affordance live). The
      // conversation record is still persisted; refreshConversations surfaces
      // it in the list.
      setState({
        connectionState: ConnectionState.Idle,
        conversationId: null,
        invitation: null,
        messages: [],
        safetyNumber: null,
        safetyNumberVerified: false,
      });
    },

    retry(): void {
      if (orchestrator === null) {
        return;
      }
      try {
        orchestrator.retry();
      } catch (err) {
        orchestratorHandlers.onError?.(err);
      }
      setState({ connectionState: orchestrator.state });
    },

    markSafetyNumberVerified(): void {
      if (orchestrator === null) return;
      orchestrator.markSafetyNumberVerified();
      setState({ safetyNumberVerified: true });
    },

    async listConversations(): Promise<ConversationRecord[]> {
      return await repository.listConversations();
    },

    async getHistory(): Promise<ConversationMessage[]> {
      if (orchestrator === null) {
        return [];
      }
      return await orchestrator.getHistory();
    },

    async setDisplayName(name: string): Promise<void> {
      const id = state.conversationId;
      if (id === null) {
        throw new Error("cannot set display name: no active conversation");
      }
      await repository.setDisplayName(id, name);
      await refreshConversations();
    },

    async clearConversation(): Promise<void> {
      const id = state.conversationId;
      if (id === null) {
        return;
      }
      await repository.clearConversation(id);
      setState({ messages: [], conversations: snapshotConversations([]) });
      await refreshConversations();
    },

    async clearAll(): Promise<void> {
      await repository.clearAll();
      setState({ messages: [], conversations: snapshotConversations([]) });
      await refreshConversations();
    },

    async exportBundle(passphrase: string): Promise<string> {
      const identity = deps.identityManager.get();
      return await exportBundle(passphrase, repository, identity.privateKey);
    },

    async importBundle(
      passphrase: string,
      bundle: string,
      mode: ImportMode,
    ): Promise<ImportResult> {
      const result = await importBundle(passphrase, bundle, repository, mode);
      await refreshConversations();
      return result;
    },

    subscribe(listener: (state: ChatControllerState) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    getState(): ChatControllerState {
      return state;
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      disposeActiveBridge();
      if (orchestrator !== null) {
        try {
          orchestrator.leave();
        } catch {
          // best-effort
        }
        orchestrator = null;
      }
      listeners.clear();
    },
  };
}

function hexFromId(id: ConversationId): string {
  let hex = "";
  for (let i = 0; i < id.length; i++) {
    hex += id[i].toString(16).padStart(2, "0");
  }
  return hex;
}
