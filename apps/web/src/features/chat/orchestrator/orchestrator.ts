import {
  computeSafetyNumber,
  createPakeSession,
  derivePakeConfirmationTag,
  deriveSessionKeys,
  generateEphemeralKeyPair,
  generateIdentityKeyPair,
  pakeFinish,
  pakeOutgoingShare,
  PakeError,
  PakeErrorCode,
  sha256,
  signTranscript,
  verifyTranscript,
} from "@/features/chat/crypto";
import type { EphemeralKeyPair, IdentityKeyPair, PakeSession } from "@/features/chat/crypto";
import { deriveRole, encodeSessionId, encodeTranscript } from "@/features/chat/protocol/codec";
import {
  MAX_CONCURRENT_TRANSFERS,
  MAX_MANIFEST_MIME_BYTES,
  MAX_MANIFEST_NAME_BYTES,
  PAKE_CONFIRM_MESSAGE_BYTES,
  PAKE_MESSAGE_BYTES,
  PAKE_ROLE_A,
  PAKE_ROLE_B,
  PROTOCOL_VERSION,
} from "@/features/chat/protocol/limits";
import { AuthMode, ControlSubtype, Role } from "@/features/chat/protocol/types";
import type { ConversationId, PublicKey, Signature, Transcript } from "@/features/chat/protocol/types";
import { FrameReceiver } from "@/features/chat/framing";
import { FrameSender } from "@/features/chat/framing";
import type { FrameTransport, ReceivedFile } from "@/features/chat/framing";
import { ConnectionState, ConnectionStateMachine } from "@/features/chat/signaling/state-machine";
import { SignalingClient } from "@/features/chat/signaling/signaling-client";
import type { SignalingSocketFactory } from "@/features/chat/signaling/signaling-client";
import type { ConversationMessage, ConversationRepository } from "@/features/chat/store";
import { AuthFailedRetryBlocked, MessageDirection } from "@/features/chat/store";

import { OrchestratorError, OrchestratorErrorCode } from "./errors";
import {
  buildTranscript,
  decodeHello,
  decodePakeConfirm,
  decodePakeShare,
  decodeSignatureMessage,
  encodeHello,
  encodePakeConfirm,
  encodePakeShare,
  encodeSignatureMessage,
  type HelloComponents,
} from "./handshake-codec";
import {
  conversationIdToHex,
  formatInvitation,
  generateConversationId,
  parseInvitation,
} from "./invitation";
import type { PeerTransport } from "./peer-transport";

// Re-export so callers can construct identity keypairs without reaching
// into the crypto barrel (single import surface for the orchestrator).
export { generateIdentityKeyPair };
export type { IdentityKeyPair };

export interface OrchestratorHandlers {
  readonly onStateChange?: (state: ConnectionState) => void;
  readonly onMessage?: (message: ConversationMessage) => void;
  readonly onSafetyNumber?: (safetyNumber: string, verified: boolean) => void;
  readonly onError?: (error: unknown) => void;
  /** Fired when the broker relay delivers a peer's SDP offer. */
  readonly onRemoteOffer?: (sdp: unknown) => void;
  /** Fired when the broker relay delivers a peer's SDP answer. */
  readonly onRemoteAnswer?: (sdp: unknown) => void;
  /** Fired when the broker relay delivers a peer's ICE candidate. */
  readonly onRemoteIce?: (candidate: unknown) => void;
  /** Fired when a transfer starts (sender or receiver side). */
  readonly onTransferStart?: (summary: TransferSummary) => void;
  /** Fired as bytes flow; emitted from the sender's per-chunk loop. */
  readonly onTransferProgress?: (summary: TransferSummary) => void;
  /** Fired when a transfer reaches `complete` (sent or received). */
  readonly onTransferComplete?: (summary: TransferSummary) => void;
  /** Fired when a transfer is cancelled by either side. */
  readonly onTransferCancelled?: (transferId: number) => void;
  /** Fired when a transfer fails (sender rejection, transport error, etc). */
  readonly onTransferError?: (transferId: number, error: unknown) => void;
  /** Fired when a file is fully received and hash-verified. */
  readonly onFileReceived?: (file: ReceivedFile) => void;
}

/**
 * Coarse, UI-facing summary of one transfer. The orchestrator emits these at
 * the framing layer's start/progress/complete seams so the controller + UI
 * can render a card without reaching into framing internals.
 */
export interface TransferSummary {
  readonly transferId: number;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly bytesTransferred: number;
  readonly direction: "sent" | "received";
}

export interface OrchestratorDeps {
  readonly brokerUrl: string;
  readonly baseUrl: string;
  readonly repository: ConversationRepository;
  readonly socketFactory: SignalingSocketFactory;
  readonly identity: IdentityKeyPair;
  readonly handlers?: OrchestratorHandlers;
  /**
   * When false, the orchestrator does NOT open its own signaling socket —
   * the caller (the WebRTC bridge, which already has a signaling client)
   * drives peer-presence via {@link ConversationOrchestrator.notifyPeerJoined}
   * / {@link ConversationOrchestrator.notifyPeerLeft} /
   * {@link ConversationOrchestrator.notifySignalingClosed}. This avoids two
   * sockets per peer overfilling the broker's 2-socket room.
   *
   * Defaults to true so unit tests that cross-wire transports without a
   * bridge still see the Waiting/Signaling transitions.
   */
  readonly useInternalSignaling?: boolean;
}

const HELLO_BYTES = 163;
const SIGNATURE_MESSAGE_BYTES = 65;

/**
 * Application-layer orchestrator: the integration layer that ties together
 * crypto, framing, the store, the peer transport, and the signaling client.
 *
 * Owns the in-band handshake (Hello + Signature), first-contact ECDH, TOFU
 * identity storage, resume-with-fresh-keys, and text send/receive/persist.
 *
 * Signaling (the broker room join/leave and SDP/ICE relay) is wired here: a
 * {@link SignalingClient} is constructed on `start()`/`join()` and drives the
 * Waiting/Signaling/Disconnected transitions through its peer-join/leave
 * handlers. The signaling layer does NOT carry application bytes — only the
 * data channel does (handed in via {@link attachTransport}).
 */
export class ConversationOrchestrator {
  private readonly brokerUrl: string;
  private readonly baseUrl: string;
  private readonly repository: ConversationRepository;
  private readonly socketFactory: SignalingSocketFactory;
  private readonly identity: IdentityKeyPair;
  private readonly handlers: OrchestratorHandlers;
  private readonly useInternalSignaling: boolean;

  /**
   * Authoritative transition validator (R6/F6 + R7/F2). All state changes
   * route through {@link setState} → {@link ConnectionStateMachine.transition},
   * which throws {@link InvalidTransitionError} on illegal edges instead of
   * silently corrupting state. The field stays in lock-step with
   * {@link currentState} so direct state getters remain O(1).
   */
  private readonly stateMachine = new ConnectionStateMachine();
  private currentState: ConnectionState = ConnectionState.Idle;
  private conversation: ConversationId | null = null;
  private invitationLink: string | null = null;
  private started = false;
  private signalingClient: SignalingClient | null = null;

  // Handshake/transient session state.
  private transport: PeerTransport | null = null;
  private localHello: HelloComponents | null = null;
  private ephemeral: EphemeralKeyPair | null = null;
  private remoteHello: HelloComponents | null = null;
  private localSignatureSent = false;
  private transcript: Transcript | null = null;
  private handshakeError: unknown = null;
  private handshakeCompleting = false;
  /**
   * R7/F4 (Phase 8.4): monotonically increasing generation counter bumped on
   * every attachTransport entry. Captured by the beginHandshake/handleInbound
   * closures; on resolution they abort (without touching this.ephemeral) if
   * the generation has advanced underneath them — the sign of a re-entrant
   * attachTransport call (e.g. the bridge reattaching after a data-channel
   * flip). Without this guard the older handshake's promises can resolve
   * AFTER the newer handshake has begun, racing the ephemeral key / hello
   * fields and corrupting state.
   */
  private handshakeGeneration = 0;
  /**
   * Auth mode for this session. Defaults to {@link AuthMode.SafetyNumberOnly}.
   * Becomes {@link AuthMode.Pake} when the parsed invitation carried a `~code`
   * (Phase 8's fragment parser) or the caller sets one via {@link setPakeCode}
   * (the path Phase 1's own tests use). Once a code is present, PAKE is
   * mandatory: a peer offering `SafetyNumberOnly` against a `Pake` invitation
   * aborts at transcript binding, and a PAKE exchange failure NEVER falls back
   * to safety-number-only.
   */
  private authMode: AuthMode = AuthMode.SafetyNumberOnly;
  /**
   * The 6-digit PAKE code, or null when the session is safety-number-only.
   * Never logged, never persisted. Phase 8's invitation fragment parser
   * (`~code`) populates this; Phase 1's tests populate it directly.
   */
  private pakeCode: string | null = null;
  /** In-flight PAKE session during the handshake; nulled after `pakeFinish`. */
  private pakeSession: PakeSession | null = null;
  /** Peer's SPAKE2 share, received during the handshake; nulled after consumption. */
  private peerPakeShare: Uint8Array | null = null;
  /** Peer's PAKE confirmation tag, received after the share exchange; nulled after verification. */
  private peerPakeConfirm: Uint8Array | null = null;
  /** Resolver for the peer-confirm promise; set by `runPakeConfirmation`. */
  private pakeConfirmResolve: ((tag: Uint8Array) => void) | null = null;
  /**
   * The local SPAKE2 side byte ('A'=0x41 / 'B'=0x42). Recorded when the local
   * share is sent so the confirmation handler can validate the peer's role
   * byte even after `pakeSession` has been consumed by `pakeFinish`.
   */
  private pakeLocalSideByte: number | null = null;

  // Connected session state.
  private frameSender: FrameSender | null = null;
  private frameReceiver: FrameReceiver | null = null;
  private safetyNumberValue: string | null = null;
  private safetyNumberVerified = false;
  /**
   * In-memory mirror of the durable {@link ConversationRepository.getAuthFailed}
   * flag (R7/F3). Set on two paths:
   *   1. Hydrated from the durable repo flag at the end of {@link start}/
   *      {@link join} (both async) — this closes the restart gap so a fresh
   *      orchestrator on a previously-auth-failed conversation still gates
   *      {@link retry}.
   *   2. Flipped true synchronously by {@link failHandshake} right before the
   *      repo write so a synchronous {@link retry} that races the async repo
   *      write is still blocked.
   * The repo is the source of truth; this cache only ever reflects the durable
   * flag (or the in-session failure that is about to be persisted).
   */
  private authFailedCached = false;
  /**
   * Tracks the most recently started send transfer's id, so a rejection from
   * the framing layer (which may not carry the id) can be correlated to the
   * right `onTransferError`/`onTransferCancelled` emission. Set per-call by
   * {@link sendFile} via the sender's onTransferStart hook.
   */
  private currentTransferIdTracker: ((transferId: number) => void) | null = null;
  /**
   * Per-transfer metadata for in-flight sends, so the framing layer's progress
   * hook (which only carries id + byte counts) can emit a full summary with
   * name/mimeType/size. Populated by {@link sendFile}, drained on
   * complete/cancel/error.
   */
  private readonly sendTransferMetadata = new Map<
    number,
    { name: string; mimeType: string; size: number }
  >();

  constructor(deps: OrchestratorDeps) {
    this.brokerUrl = deps.brokerUrl;
    this.baseUrl = deps.baseUrl;
    this.repository = deps.repository;
    this.socketFactory = deps.socketFactory;
    this.identity = deps.identity;
    this.handlers = deps.handlers ?? {};
    this.useInternalSignaling = deps.useInternalSignaling ?? true;
  }

  get state(): ConnectionState {
    return this.currentState;
  }

  get safetyNumber(): string | null {
    return this.safetyNumberValue;
  }

  get invitation(): string | null {
    return this.invitationLink;
  }

  get conversationId(): ConversationId | null {
    return this.conversation;
  }

  /**
   * The negotiated auth mode for the current session. Defaults to
   * {@link AuthMode.SafetyNumberOnly}; becomes {@link AuthMode.Pake} once a
   * PAKE code is supplied via {@link setPakeCode} (or, in Phase 8, parsed from
   * the invitation fragment).
   */
  get handshakeAuthMode(): AuthMode {
    return this.authMode;
  }

  /**
   * Supply the 6-digit PAKE code for this session, switching the negotiated
   * auth mode to {@link AuthMode.Pake}. This is the seam Phase 8's invitation
   * fragment parser (`~code`) will call; Phase 1's own tests call it directly.
   *
   * Must be called before {@link attachTransport} (i.e. before the handshake
   * begins). Once set, PAKE is mandatory: a peer offering `SafetyNumberOnly`
   * against this invitation aborts at transcript binding, and a PAKE failure
   * never falls back to safety-number-only.
   */
  setPakeCode(code: string): void {
    if (this.started) {
      throw new OrchestratorError(
        OrchestratorErrorCode.AlreadyStarted,
        "setPakeCode must be called before start()/join()",
      );
    }
    if (code.length === 0) {
      throw new OrchestratorError(
        OrchestratorErrorCode.MalformedHandshakeMessage,
        "PAKE code must be non-empty",
      );
    }
    this.pakeCode = code;
    this.authMode = AuthMode.Pake;
  }

  /**
   * Load previously-persisted text history for the current conversation. Used
   * on resume to show prior context before the peer rejoins. Returns messages
   * in chronological order. Throws if called before start()/join().
   */
  async getHistory(): Promise<ConversationMessage[]> {
    if (this.conversation === null) {
      throw new OrchestratorError(
        OrchestratorErrorCode.HandshakeFailed,
        "getHistory called before start()/join()",
      );
    }
    return await this.repository.getMessages(this.conversation);
  }

  /** INITIATOR flow: generate conversation id, persist, format invitation. */
  async start(): Promise<string> {
    if (this.started) {
      throw new OrchestratorError(
        OrchestratorErrorCode.AlreadyStarted,
        "orchestrator has already been started",
      );
    }
    this.started = true;
    const id = generateConversationId();
    this.conversation = id;
    await this.repository.createConversation(id, Date.now());
    // R7/F3 durability: hydrate the in-memory cache from the durable repo flag
    // so retry() (sync by contract) gates on the persisted truth, not just on
    // in-session failures. start() always creates a fresh record (authFailed=
    // false), but the read is cheap defense-in-depth and keeps start()/join()
    // symmetric.
    this.authFailedCached = await this.repository.getAuthFailed(id);
    const invitation = formatInvitation(id, this.baseUrl);
    this.invitationLink = invitation;
    this.connectSignaling();
    this.setState(ConnectionState.Waiting);
    return invitation;
  }

  /** RESPONDER flow: parse fragment, persist conversation. */
  async join(fragment: string): Promise<void> {
    if (this.started) {
      throw new OrchestratorError(
        OrchestratorErrorCode.AlreadyStarted,
        "orchestrator has already been started",
      );
    }
    this.started = true;
    // R7/F6 (Phase 8.3): accept either a full invitation link
    // (`https://host#<hex>` / `https://host#<hex>~<code>`) or a bare fragment
    // (`#<hex>` / `<hex>` / `#<hex>~<code>` / `<hex>~<code>`). Everything
    // before the last `#` is the URL prefix the initiator wrapped around the
    // conversation id. parseInvitation strips a single leading `#` and
    // extracts the optional `~<code>` tail (PAKE password). The redundant
    // double-`#` normalization from the prior slice is gone — lastIndexOf +
    // slice already produces the bare fragment, and parseInvitation handles
    // the optional leading `#`.
    const hashIndex = fragment.lastIndexOf("#");
    const bare = hashIndex >= 0 ? fragment.slice(hashIndex + 1) : fragment;
    const parsed = parseInvitation(bare);
    this.conversation = parsed.conversationId;
    await this.repository.createConversation(parsed.conversationId, Date.now());
    // R7/F3 durability: hydrate the in-memory cache from the durable repo flag.
    // The controller's resumeConversation path re-enters via join() with an
    // existing conversation id (createConversation is idempotent and preserves
    // the existing authFailed flag), so this closes the restart gap: a fresh
    // orchestrator on a previously-auth-failed conversation reads the durable
    // truth and retry() correctly throws AuthFailedRetryBlocked.
    this.authFailedCached = await this.repository.getAuthFailed(parsed.conversationId);
    // R7/F6 (Phase 8.3): if the invitation carried a PAKE code, switch the
    // negotiated auth mode to Pake before the handshake begins. setPakeCode
    // throws AlreadyStarted here only if join() ran twice (we set this.started
    // above), which is impossible by contract — but we still need to call it
    // BEFORE connectSignaling so the PAKE state is ready when the peer
    // arrives. We bypass the started guard by writing the fields directly
    // (setPakeCode is the public API for external callers; the parser path
    // runs after this.started is flipped so the public API would refuse).
    if (parsed.code !== null) {
      this.pakeCode = parsed.code;
      this.authMode = AuthMode.Pake;
    }
    this.connectSignaling();
    this.setState(ConnectionState.Waiting);
  }

  /**
   * The seam where the caller hands the orchestrator an open data channel
   * (the UI/WebRTC layer does this once the DTLS data channel is open).
   *
   * In unit tests, two orchestrators are connected by attaching a pair of
   * cross-wired loopback transports — the real crypto handshake then runs
   * between them without any WebRTC.
   */
  attachTransport(transport: PeerTransport): void {
    if (
      this.currentState !== ConnectionState.Waiting &&
      this.currentState !== ConnectionState.Signaling
    ) {
      throw new OrchestratorError(
        OrchestratorErrorCode.HandshakeFailed,
        `attachTransport called from state ${this.currentState}; expected Waiting or Signaling`,
      );
    }
    if (this.conversation === null) {
      throw new OrchestratorError(
        OrchestratorErrorCode.HandshakeFailed,
        "attachTransport called before start()/join()",
      );
    }
    // R7/F4 (Phase 8.4): bump the handshake generation on every entry so the
    // beginHandshake/handleInbound closures can detect a re-entrant
    // attachTransport (a newer handshake kicking off while an older one is
    // still awaiting PAKE shares or async crypto). The closures capture the
    // generation at scheduling time and abort (without mutating this.ephemeral
    // or other handshake state) if it has advanced by the time they resolve.
    this.handshakeGeneration += 1;
    this.transport = transport;
    this.setState(ConnectionState.Handshaking);
    // Kick off the local Hello generation and transmission.
    void this.beginHandshake().catch((err: unknown) => {
      this.failHandshake(err);
    });
    // All inbound bytes (handshake messages, then encrypted frames after
    // Connected) are routed through our receiver.
    transport.setOnMessage((bytes: Uint8Array) => {
      this.handleInbound(bytes).catch((err: unknown) => {
        this.failHandshake(err);
      });
    });
  }

  /** Send a text message (UTF-8). Persists locally, encrypts, sends. */
  async sendText(text: string): Promise<void> {
    if (this.currentState !== ConnectionState.Connected || this.frameSender === null) {
      throw new OrchestratorError(
        OrchestratorErrorCode.NotConnected,
        "cannot sendText before the handshake completes",
      );
    }
    if (this.conversation === null) {
      throw new OrchestratorError(
        OrchestratorErrorCode.NotConnected,
        "conversation is not initialized",
      );
    }
    const timestamp = Date.now();
    await this.repository.appendMessage(this.conversation, text, MessageDirection.Sent, timestamp);
    const bytes = new TextEncoder().encode(text);
    await this.frameSender.sendText(bytes);
  }

  /**
   * Send a binary file to the peer over the established session. Validates
   * Connected + manifest limits, enforces the concurrent-transfer cap, and
   * emits start/progress/complete (or error/cancelled) via the transfer
   * handlers. Returns the new transfer id.
   *
   * The framing layer chunks, hashes, and backpressures internally. This
   * method installs a per-call progress hook on the sender so the
   * orchestrator can surface `onTransferStart`/`onTransferProgress` to the
   * UI while the chunk loop runs.
   */
  async sendFile(data: Uint8Array, name: string, mimeType: string): Promise<number> {
    if (this.currentState !== ConnectionState.Connected || this.frameSender === null) {
      throw new OrchestratorError(
        OrchestratorErrorCode.NotConnected,
        "cannot sendFile before the handshake completes",
      );
    }
    const nameBytes = new TextEncoder().encode(name);
    if (nameBytes.length > MAX_MANIFEST_NAME_BYTES) {
      throw new OrchestratorError(
        OrchestratorErrorCode.MalformedHandshakeMessage,
        `name length ${nameBytes.length} exceeds MAX_MANIFEST_NAME_BYTES (${MAX_MANIFEST_NAME_BYTES})`,
      );
    }
    const mimeBytes = new TextEncoder().encode(mimeType);
    if (mimeBytes.length > MAX_MANIFEST_MIME_BYTES) {
      throw new OrchestratorError(
        OrchestratorErrorCode.MalformedHandshakeMessage,
        `mimeType length ${mimeBytes.length} exceeds MAX_MANIFEST_MIME_BYTES (${MAX_MANIFEST_MIME_BYTES})`,
      );
    }
    if (this.frameSender.activeTransferCount >= MAX_CONCURRENT_TRANSFERS) {
      throw new OrchestratorError(
        OrchestratorErrorCode.NotConnected,
        `concurrent transfer limit (${MAX_CONCURRENT_TRANSFERS}) reached`,
      );
    }
    const sender = this.frameSender;
    const total = data.length;

    // The sender is constructed with onTransferStart/onProgress hooks that
    // route every transfer through our handlers (the transferId disambiguates
    // concurrent sends). To associate a rejection with its id when the sender
    // throws before/after allocation, we track the latest started id locally
    // for the duration of this call, and register its metadata so the
    // progress hook can emit a full summary.
    let allocatedId: number | null = null;
    const prevIdTracker = this.currentTransferIdTracker;
    this.currentTransferIdTracker = (transferId: number): void => {
      allocatedId = transferId;
      this.sendTransferMetadata.set(transferId, { name, mimeType, size: total });
      prevIdTracker?.(transferId);
    };

    try {
      const transferId = await sender.sendFile(data, name, mimeType);
      this.handlers.onTransferComplete?.({
        transferId,
        name,
        mimeType,
        size: total,
        bytesTransferred: total,
        direction: "sent",
      });
      return transferId;
    } catch (err: unknown) {
      const id = allocatedId;
      if (id !== null) {
        if (this.isCancellationError(err)) {
          this.handlers.onTransferCancelled?.(id);
        } else {
          this.handlers.onTransferError?.(id, err);
        }
      }
      throw err;
    } finally {
      this.currentTransferIdTracker = prevIdTracker;
      if (allocatedId !== null) {
        this.sendTransferMetadata.delete(allocatedId);
      }
    }
  }

  /**
   * Cancel an in-flight transfer on both sides: the sender stops the chunk
   * loop and the receiver drops any buffered chunks. Either side is safe to
   * call; an unknown id is a no-op. Emits {@link onTransferCancelled} once.
   */
  cancelTransfer(transferId: number): void {
    if (this.frameSender !== null) {
      this.frameSender.cancelTransfer(transferId);
    }
    if (this.frameReceiver !== null) {
      this.frameReceiver.cancelTransfer(transferId);
    }
    this.handlers.onTransferCancelled?.(transferId);
  }

  /** Compare/accept safety number (user marked compared out-of-band). */
  markSafetyNumberVerified(): void {
    if (this.safetyNumberValue === null) return;
    this.safetyNumberVerified = true;
    this.handlers.onSafetyNumber?.(this.safetyNumberValue, true);
  }

  /** Returns true once the user has accepted the safety number. */
  isSafetyNumberVerified(): boolean {
    return this.safetyNumberVerified;
  }

  /** Send encrypted Leave control frame, teardown, clear ephemeral state. */
  leave(): void {
    // Idempotent: a second leave() after Disconnected/Idle is a safe no-op.
    if (
      this.currentState === ConnectionState.Disconnected ||
      this.currentState === ConnectionState.Idle
    ) {
      return;
    }
    if (this.currentState === ConnectionState.Connected && this.frameSender !== null) {
      // Fire-and-forget the encrypted Leave control frame: swallow async errors
      // (the channel may already be closing) so dispose/leave never surfaces an
      // unhandled rejection while tearing down.
      void this.frameSender.sendControl(ControlSubtype.Leave, new Uint8Array(0)).catch(() => {
        // Best-effort; we are tearing down regardless.
      });
    }
    this.teardownSession();
    this.setState(ConnectionState.Disconnected);
  }

  /**
   * Re-enter the signaling flow after a drop or explicit leave. Re-joins the
   * broker room and waits for the peer again. The caller must re-attach a
   * transport via {@link attachTransport} once the data channel reopens.
   * Throws if called from a state where retry is illegal (anything other than
   * Disconnected), or if the conversation has a durable auth-failed flag set
   * (R7/F3 — recovering requires a NEW invitation).
   */
  retry(): void {
    if (this.currentState !== ConnectionState.Disconnected) {
      throw new OrchestratorError(
        OrchestratorErrorCode.HandshakeFailed,
        `retry called from state ${this.currentState}; expected Disconnected`,
      );
    }
    if (this.conversation === null) {
      throw new OrchestratorError(
        OrchestratorErrorCode.HandshakeFailed,
        "retry called before start()/join()",
      );
    }
    // R7/F3: the durable auth-failed flag is set in failHandshake when an
    // IdentityChanged or PakeError occurred. The PRD TOFU clause (fuck-eu-chat-
    // control.md:264) requires that recovering requires a NEW invitation; a
    // retry on the same conversation must not re-attempt the handshake.
    // getAuthFailed is an async repo call, but retry is synchronous by contract
    // (it throws to reject the caller). authFailedCached is hydrated from the
    // durable repo flag at the end of start()/join() (closing the restart gap
    // for a fresh orchestrator on a previously-auth-failed conversation) AND
    // set synchronously by failHandshake before the repo write so a synchronous
    // retry that races the write is still blocked.
    if (this.authFailedCached) {
      throw new AuthFailedRetryBlocked(
        "retry blocked: this conversation previously failed authentication " +
          "(identity change or PAKE failure). Recovering requires creating a " +
          "fresh invitation — start a new conversation to re-handshake.",
      );
    }
    // Connect signaling synchronously; role derivation reads the stored peer
    // identity (already persisted on resume) without awaiting, falling back
    // to Initiator when there is no stored peer yet.
    this.connectSignaling();
    this.setState(ConnectionState.Signaling);
  }

  /**
   * External signaling seam: the bridge observed the peer join the broker room.
   * Mirrors the internal signaling client's onPeerJoin: transitions Waiting to
   * Signaling so the handshake can run once the data channel attaches.
   */
  notifyPeerJoined(): void {
    if (this.currentState === ConnectionState.Waiting) {
      this.setState(ConnectionState.Signaling);
    }
  }

  /**
   * External signaling seam: the bridge observed the peer leave. Tears down the
   * session and surfaces the drop as Disconnected so the UI can offer retry.
   * No-op when already Disconnected or never started (Idle) — the transition
   * validator rejects Idle→Disconnected, and a peer-leave before start is
   * semantically meaningless.
   */
  notifyPeerLeft(): void {
    if (
      this.currentState !== ConnectionState.Disconnected &&
      this.currentState !== ConnectionState.Idle
    ) {
      this.teardownSession();
      this.setState(ConnectionState.Disconnected);
    }
  }

  /**
   * External signaling seam: the bridge's signaling socket closed (peer drop or
   * broker restart). Behaves like notifyPeerLeft.
   */
  notifySignalingClosed(): void {
    if (
      this.currentState !== ConnectionState.Disconnected &&
      this.currentState !== ConnectionState.Idle
    ) {
      this.teardownSession();
      this.setState(ConnectionState.Disconnected);
    }
  }

  // --- internal handshake machinery ---

  private async beginHandshake(): Promise<void> {
    if (this.conversation === null || this.transport === null) {
      throw new OrchestratorError(
        OrchestratorErrorCode.HandshakeFailed,
        "handshake started without conversation/transport",
      );
    }
    // R7/F4 (Phase 8.4): capture the handshake generation at scheduling time.
    // If attachTransport was called again before this async function reaches
    // its mutation phase, the generation has advanced and a NEWER handshake is
    // already running — abort WITHOUT touching this.ephemeral / this.localHello
    // so the newer handshake owns those fields cleanly.
    const generation = this.handshakeGeneration;
    const ephemeral = await generateEphemeralKeyPair();
    if (generation !== this.handshakeGeneration) {
      // A newer attachTransport superseded this handshake while we were
      // generating the ephemeral key. Drop our work silently.
      return;
    }
    const sessionId = encodeSessionId(randomBytes(32));
    const localHello: HelloComponents = {
      protocolVersion: PROTOCOL_VERSION,
      identityPublicKey: this.identity.publicKey,
      ephemeralPublicKey: ephemeral.publicKey,
      sessionId,
    };
    this.ephemeral = ephemeral;
    this.localHello = localHello;
    this.transport.send(encodeHello(localHello));
    // If we already have the peer's hello, advance to the signature round.
    await this.maybeSignAndSend();
  }

  private async handleInbound(bytes: Uint8Array): Promise<void> {
    if (this.currentState === ConnectionState.Connected) {
      // Post-handshake: bytes are encrypted frames.
      const receiver = this.frameReceiver;
      if (receiver === null) return;
      await receiver.ingest(bytes);
      return;
    }
    // PAKE shares/confirmations arrive AFTER the peer's transcript signature
    // verifies, i.e. while we are in the Verifying phase (TOFU + PAKE + key
    // derivation). Accept inbound handshake bytes in both Handshaking and
    // Verifying; anything else is a stray post-teardown delivery and is dropped.
    if (
      this.currentState !== ConnectionState.Handshaking &&
      this.currentState !== ConnectionState.Verifying
    ) {
      return;
    }
    // R7/F4 (Phase 8.4): capture the generation at scheduling time. If a
    // newer attachTransport has bumped the generation while we awaited an
    // async step inside this dispatch, drop the in-flight handling — a newer
    // handshake owns the field set and would be corrupted by our writes.
    const generation = this.handshakeGeneration;
    if (bytes.length === HELLO_BYTES) {
      const hello = decodeHello(bytes);
      if (generation !== this.handshakeGeneration) return;
      this.remoteHello = hello;
      await this.maybeSignAndSend();
      await this.maybeCompleteHandshake();
      return;
    }
    if (bytes.length === SIGNATURE_MESSAGE_BYTES) {
      const signature = decodeSignatureMessage(bytes);
      if (generation !== this.handshakeGeneration) return;
      await this.verifyPeerAndComplete(signature);
      return;
    }
    if (bytes.length === PAKE_MESSAGE_BYTES) {
      const msg = decodePakeShare(bytes);
      if (generation !== this.handshakeGeneration) return;
      await this.handlePakeShare(msg.role, msg.share);
      return;
    }
    if (bytes.length === PAKE_CONFIRM_MESSAGE_BYTES) {
      const msg = decodePakeConfirm(bytes);
      if (generation !== this.handshakeGeneration) return;
      await this.handlePakeConfirm(msg.role, msg.tag);
      return;
    }
    throw new OrchestratorError(
      OrchestratorErrorCode.MalformedHandshakeMessage,
      `inbound handshake message has unexpected length ${bytes.length}`,
    );
  }

  private async maybeSignAndSend(): Promise<void> {
    if (this.localSignatureSent) return;
    if (this.localHello === null || this.remoteHello === null || this.conversation === null) {
      return;
    }
    const transcript = buildTranscript({
      conversationId: this.conversation,
      local: this.localHello,
      remote: this.remoteHello,
      authMode: this.authMode,
    });
    this.transcript = transcript;
    const signature = await signTranscript(this.identity.privateKey, transcript);
    this.transport?.send(encodeSignatureMessage(signature));
    this.localSignatureSent = true;
  }

  private async maybeCompleteHandshake(): Promise<void> {
    // We have the remote hello; we may have also received the remote's
    // signature (handled by verifyPeerAndComplete). Nothing to do here until
    // the signature arrives.
  }

  private async verifyPeerAndComplete(remoteSignature: Signature): Promise<void> {
    if (this.handshakeCompleting) return;
    if (
      this.localHello === null ||
      this.remoteHello === null ||
      this.transcript === null ||
      this.conversation === null ||
      this.ephemeral === null ||
      this.transport === null
    ) {
      throw new OrchestratorError(
        OrchestratorErrorCode.HandshakeFailed,
        "signature arrived before the local hello was generated",
      );
    }

    const remoteIdentityKey = this.remoteHello.identityPublicKey;
    const remoteEphemeralKey = this.remoteHello.ephemeralPublicKey;
    const remoteSessionId = this.remoteHello.sessionId;

    // Signature verification against the transcript.
    const ok = await verifyTranscript(remoteIdentityKey, remoteSignature, this.transcript);
    if (!ok) {
      throw new OrchestratorError(
        OrchestratorErrorCode.HandshakeSignatureMismatch,
        "peer signature does not verify against the canonical transcript",
      );
    }

    // R7/F2: enter Verifying now that the peer's transcript signature verifies.
    // From here through PAKE confirmation + TOFU + key derivation the session
    // is authenticating the peer (Verifying), then transitions to Connected on
    // success or Disconnected via failHandshake on any check failure.
    this.setState(ConnectionState.Verifying);

    // TOFU: first contact stores, resume must match.
    const existing = await this.repository.getPeerIdentity(this.conversation);
    if (existing !== null) {
      const sameKey = bytesEqual(existing.publicKey, remoteIdentityKey);
      if (!sameKey) {
        throw new OrchestratorError(
          OrchestratorErrorCode.IdentityChanged,
          "peer identity key changed since last contact",
        );
      }
    }

    this.handshakeCompleting = true;

    // If this session negotiated PAKE, run the SPAKE2 exchange over the data
    // channel before deriving session keys. The shared secret is mixed into the
    // HKDF chain via `deriveSessionKeys`. A PAKE failure is fatal: there is NO
    // silent fallback to safety-number-only.
    let pakeSecret: Uint8Array | null = null;
    if (this.authMode === AuthMode.Pake) {
      const code = this.pakeCode;
      if (code === null) {
        throw new PakeError(
          PakeErrorCode.Abort,
          "authMode is Pake but no PAKE code is set",
        );
      }
      const role = deriveRole(this.identity.publicKey, remoteIdentityKey);
      const session = await createPakeSession(code, role);
      this.pakeSession = session;
      // Send the local SPAKE2 share to the peer (cleartext, as with the Hello).
      const localShare = pakeOutgoingShare(session);
      const sideByte = role === Role.Initiator ? PAKE_ROLE_A : PAKE_ROLE_B;
      this.pakeLocalSideByte = sideByte;
      this.transport.send(encodePakeShare(sideByte, localShare));
      // Await the peer's share; handlePakeShare stashes it and completes the
      // exchange when both shares are present.
      pakeSecret = await this.awaitPakeFinish();
      // Confirmation: SPAKE2 does not itself detect a wrong password (both
      // sides complete `pakeFinish` with divergent secrets). Each side derives
      // a role-bound MAC tag over the transcript hash keyed by the SPAKE2
      // secret, exchanges it, and verifies. A mismatch proves a wrong-code
      // attack and aborts — there is NO path to Connected under divergent
      // traffic keys.
      await this.runPakeConfirmation(pakeSecret, role);
    }

    // Derive session keys. For a Pake session the SPAKE2 shared secret is
    // bound into HKDF; for SafetyNumberOnly it is null (and the transcript
    // authMode is SafetyNumberOnly, so the defensive check in
    // deriveSessionKeys does not trip).
    const sessionKeys = await deriveSessionKeys({
      localEcdhPrivateKey: this.ephemeral.privateKey,
      peerEcdhPublicKey: remoteEphemeralKey,
      transcript: this.transcript,
      localIdentityPublicKey: this.identity.publicKey,
      pakeSecret: pakeSecret ?? undefined,
    });

    const safetyNumber = await computeSafetyNumber(
      this.conversation,
      this.identity.publicKey,
      remoteIdentityKey,
    );
    this.safetyNumberValue = safetyNumber;

    // TOFU: persist the peer identity on first contact (fingerprint = safety number).
    if (existing === null) {
      await this.repository.storePeerIdentity(this.conversation, safetyNumber, remoteIdentityKey);
    }

    // Construct the framing layer and re-wire inbound delivery.
    const sender = new FrameSender({
      sessionKeys,
      localSessionId: this.localHello.sessionId,
      peerSessionId: remoteSessionId,
      transport: toFrameTransport(this.transport),
      onTransferStart: (transferId: number, name: string, mimeType: string, size: number): void => {
        this.currentTransferIdTracker?.(transferId);
        this.handlers.onTransferStart?.({
          transferId,
          name,
          mimeType,
          size,
          bytesTransferred: 0,
          direction: "sent",
        });
      },
      onProgress: (transferId: number, bytesTransferred: number, size: number): void => {
        const meta = this.sendTransferMetadata.get(transferId);
        this.handlers.onTransferProgress?.({
          transferId,
          name: meta?.name ?? "",
          mimeType: meta?.mimeType ?? "",
          size: meta?.size ?? size,
          bytesTransferred,
          direction: "sent",
        });
      },
    });
    const receiver = new FrameReceiver({
      sessionKeys,
      peerSessionId: remoteSessionId,
      onText: (plaintext: Uint8Array): void => {
        void this.handleReceivedText(plaintext);
      },
      onControl: (): void => {
        // Control frames are not part of this slice's surface area.
      },
      onFileComplete: (file: ReceivedFile): void => {
        this.handleReceivedFile(file);
      },
    });
    this.frameSender = sender;
    this.frameReceiver = receiver;

    this.setState(ConnectionState.Connected);
    this.handlers.onSafetyNumber?.(safetyNumber, this.safetyNumberVerified);
  }

  /**
   * Resolver for the peer-share promise. Set by {@link awaitPakeFinish} and
   * resolved by {@link handlePakeShare} once the peer's SPAKE2 share lands.
   * Kept as a field (not a local) because the share may arrive before
   * `awaitPakeFinish` is entered.
   */
  private pakePeerShareResolve: ((share: Uint8Array) => void) | null = null;

  /**
   * Receive the peer's SPAKE2 share and resolve anyone waiting in
   * {@link awaitPakeFinish}. Validates that the peer's role byte is the
   * COMPLEMENT of the local role — a peer offering the same side indicates a
   * reflected-message attack and aborts the handshake.
   */
  private async handlePakeShare(role: number, share: Uint8Array): Promise<void> {
    if (this.authMode !== AuthMode.Pake) {
      throw new OrchestratorError(
        OrchestratorErrorCode.MalformedHandshakeMessage,
        "received a PakeShare message but the session authMode is not Pake",
      );
    }
    const expectedLocalByte =
      this.pakeSession === null ? null : this.pakeSession.sideByte;
    if (expectedLocalByte !== null) {
      const expectedPeerByte = expectedLocalByte === PAKE_ROLE_A ? PAKE_ROLE_B : PAKE_ROLE_A;
      if (role !== expectedPeerByte) {
        throw new PakeError(
          PakeErrorCode.Abort,
          `peer SPAKE2 side 0x${role.toString(16)} is not complementary to local side 0x${expectedLocalByte.toString(16)}`,
        );
      }
    }
    if (this.peerPakeShare !== null) {
      throw new PakeError(PakeErrorCode.Abort, "duplicate peer SPAKE2 share");
    }
    this.peerPakeShare = share;
    const resolve = this.pakePeerShareResolve;
    this.pakePeerShareResolve = null;
    resolve?.(share);
  }

  /**
   * Block until the peer's SPAKE2 share arrives, then run `pakeFinish` to
   * derive the shared secret. Throws a {@link PakeError} on any failure; the
   * caller ({@link verifyPeerAndComplete}) propagates it to `failHandshake`.
   */
  private async awaitPakeFinish(): Promise<Uint8Array> {
    const session = this.pakeSession;
    if (session === null) {
      throw new PakeError(PakeErrorCode.Abort, "awaitPakeFinish: no PAKE session");
    }
    let peerShare = this.peerPakeShare;
    if (peerShare === null) {
      peerShare = await new Promise<Uint8Array>((resolve) => {
        this.pakePeerShareResolve = resolve;
      });
    }
    this.peerPakeShare = null;
    const secret = await pakeFinish(session, peerShare);
    this.pakeSession = null;
    return secret;
  }

  /**
   * Run the PAKE confirmation exchange. Computes the local role-bound
   * confirmation tag over the transcript hash, sends it, awaits the peer's
   * tag, and verifies it equals the locally-computed peer-role tag. A mismatch
   * proves a wrong-code attack (the SPAKE2 secrets diverged) and the handshake
   * aborts with {@link PakeErrorCode.Mismatch} — there is no path to Connected.
   */
  private async runPakeConfirmation(pakeSecret: Uint8Array, localRole: Role): Promise<void> {
    if (this.transcript === null) {
      throw new PakeError(PakeErrorCode.Abort, "runPakeConfirmation: no transcript");
    }
    const transcriptHash = await sha256(encodeTranscript(this.transcript));
    const localTag = await derivePakeConfirmationTag(pakeSecret, transcriptHash, localRole);
    const localSideByte = localRole === Role.Initiator ? PAKE_ROLE_A : PAKE_ROLE_B;
    this.transport?.send(encodePakeConfirm(localSideByte, localTag));
    // Await the peer's confirmation tag.
    let peerTag = this.peerPakeConfirm;
    if (peerTag === null) {
      peerTag = await new Promise<Uint8Array>((resolve) => {
        this.pakeConfirmResolve = resolve;
      });
    }
    this.peerPakeConfirm = null;
    const peerRole = localRole === Role.Initiator ? Role.Responder : Role.Initiator;
    const expectedPeerTag = await derivePakeConfirmationTag(
      pakeSecret,
      transcriptHash,
      peerRole,
    );
    if (!bytesEqual(peerTag, expectedPeerTag)) {
      throw new PakeError(
        PakeErrorCode.Mismatch,
        "PAKE confirmation tag mismatch (wrong code or tampering); aborting handshake",
      );
    }
  }

  /**
   * Receive the peer's PAKE confirmation tag and resolve anyone waiting in
   * {@link runPakeConfirmation}. Validates the role byte is complementary to
   * the local side; a same-role tag indicates a reflected-message attack.
   */
  private async handlePakeConfirm(role: number, tag: Uint8Array): Promise<void> {
    if (this.authMode !== AuthMode.Pake) {
      throw new OrchestratorError(
        OrchestratorErrorCode.MalformedHandshakeMessage,
        "received a PakeConfirm message but the session authMode is not Pake",
      );
    }
    const expectedLocalByte =
      this.pakeSession === null ? null : this.pakeSession.sideByte;
    // By the time the confirmation arrives, pakeSession may already be nulled
    // (pakeFinish consumed it); fall back to the role we recorded as sender.
    const localSide = expectedLocalByte ?? this.pakeLocalSideByte;
    if (localSide !== null) {
      const expectedPeerByte = localSide === PAKE_ROLE_A ? PAKE_ROLE_B : PAKE_ROLE_A;
      if (role !== expectedPeerByte) {
        throw new PakeError(
          PakeErrorCode.Abort,
          `peer PAKE confirm side 0x${role.toString(16)} is not complementary to local side 0x${localSide.toString(16)}`,
        );
      }
    }
    if (this.peerPakeConfirm !== null) {
      throw new PakeError(PakeErrorCode.Abort, "duplicate peer PAKE confirmation");
    }
    this.peerPakeConfirm = tag;
    const resolve = this.pakeConfirmResolve;
    this.pakeConfirmResolve = null;
    resolve?.(tag);
  }

  private handleReceivedFile(file: ReceivedFile): void {
    const summary: TransferSummary = {
      transferId: file.manifest.transferId,
      name: file.manifest.name,
      mimeType: file.manifest.mimeType,
      size: file.manifest.size,
      bytesTransferred: file.manifest.size,
      direction: "received",
    };
    this.handlers.onTransferStart?.({
      ...summary,
      bytesTransferred: 0,
    });
    this.handlers.onTransferComplete?.(summary);
    this.handlers.onFileReceived?.(file);
  }

  private isCancellationError(err: unknown): boolean {
    if (err instanceof Error) {
      return (
        /cancel/i.test(err.message) || (err.name === "FramingError" && /cancel/i.test(err.message))
      );
    }
    return false;
  }

  private async handleReceivedText(plaintext: Uint8Array): Promise<void> {
    if (this.conversation === null) return;
    const text = new TextDecoder().decode(plaintext);
    const timestamp = Date.now();
    const message = await this.repository.appendMessage(
      this.conversation,
      text,
      MessageDirection.Received,
      timestamp,
    );
    this.handlers.onMessage?.(message);
  }

  private failHandshake(err: unknown): void {
    if (this.handshakeError !== null) return;
    this.handshakeError = err;
    // R7/F3: an IdentityChanged or PAKE failure is a durable auth failure.
    // Per the PRD TOFU clause, recovering requires a NEW invitation — record
    // the flag in the repo BEFORE tearing the session down so retry() can gate
    // on it. The synchronous cache is set first so a synchronous retry() that
    // races the async repo write is still blocked.
    if (isAuthFailureError(err)) {
      this.authFailedCached = true;
      const conversationId = this.conversation;
      if (conversationId !== null) {
        // Fire-and-forget: failHandshake is synchronous by contract (its caller
        // is the .catch on the handshake promise). The repo write runs in the
        // background; teardown proceeds in parallel.
        void this.repository.markAuthFailed(conversationId).catch(() => {
          // best-effort: the cache flag above is the authoritative gate for
          // the synchronous retry() call; a failed repo write only means the
          // flag will not survive a process restart.
        });
      }
    }
    this.handlers.onError?.(err);
    this.teardownSession();
    // Surface the failure as Disconnected so the UI can offer retry. Covers
    // Handshaking (early handshake error), Verifying (post-signature auth
    // failure: TOFU mismatch, PAKE confirmation failure, key derivation), and
    // Connected (a late transport error after the session was established).
    // Any other state is left untouched — teardown already released resources.
    if (
      this.currentState === ConnectionState.Handshaking ||
      this.currentState === ConnectionState.Verifying ||
      this.currentState === ConnectionState.Connected
    ) {
      this.setState(ConnectionState.Disconnected);
    }
  }

  private teardownSession(): void {
    if (this.frameSender !== null) {
      try {
        this.frameSender.teardown();
      } catch {
        // best-effort
      }
    }
    if (this.frameReceiver !== null) {
      this.frameReceiver.teardown();
    }
    if (this.transport !== null) {
      try {
        this.transport.setOnMessage(null);
        this.transport.close();
      } catch {
        // best-effort
      }
    }
    // Tear down the signaling client too: leave the broker room and close the
    // socket. retry() will construct a fresh one. Best-effort — we are tearing
    // down regardless.
    if (this.signalingClient !== null) {
      try {
        this.signalingClient.close();
      } catch {
        // best-effort
      }
      this.signalingClient = null;
    }
    this.frameSender = null;
    this.frameReceiver = null;
    this.transport = null;
    this.localHello = null;
    this.remoteHello = null;
    this.ephemeral = null;
    this.transcript = null;
    this.localSignatureSent = false;
    this.handshakeCompleting = false;
    this.pakeSession = null;
    this.peerPakeShare = null;
    this.peerPakeConfirm = null;
    this.pakePeerShareResolve = null;
    this.pakeConfirmResolve = null;
    this.pakeLocalSideByte = null;
    // safetyNumberValue is kept so callers can still read it after leave().
  }

  private setState(next: ConnectionState): void {
    // Route through the transition validator (R6/F6 + R7/F2). Illegal edges
    // throw InvalidTransitionError instead of silently corrupting state. The
    // side-effect (onStateChange callback) fires only after the transition is
    // validated AND the cached state is updated, preserving the prior
    // observe-then-notify ordering.
    //
    // Self-transitions (next === currentState) are treated as no-ops: teardown
    // paths (leave/notifyPeerLeft/notifySignalingClosed and the internal
    // signaling onClose handler) can fire redundantly when a MockSignalingSocket
    // closes synchronously inside teardownSession — the second call would
    // otherwise throw Disconnected -> Disconnected. Skipping the no-op keeps the
    // strict transition table intact without special-casing each call site.
    if (next === this.currentState) {
      return;
    }
    this.stateMachine.transition(next);
    this.currentState = next;
    this.handlers.onStateChange?.(next);
  }

  /**
   * Construct (or reconstruct) the {@link SignalingClient} and join the broker
   * room for the current conversation. The signaling layer drives the broker
   * join/leave and SDP/ICE relay; it does NOT carry application bytes.
   *
   * R7/F5 (Phase 8.1): the signaling role is derived deterministically from
   * the local identity key (parity of the first byte) instead of being
   * hard-coded to {@link Role.Initiator}. Both internal-signaling peers derive
   * via the same rule, so a peer whose key is even-parity is Initiator and an
   * odd-parity peer is Responder — one of each per pair, with high probability
   * under uniform P-256 public keys. This makes glare resolvable even when
   * the orchestrator drives its own signaling socket (useInternalSignaling=
   * true), instead of both sides defaulting to "impolite" and racing offers
   * without resolution. The derivation is independent of the peer identity
   * (which is unknown at this point) and stable across reconnects for the
   * same local identity.
   */
  private connectSignaling(): void {
    if (this.conversation === null) {
      // Defensive: connectSignaling is only called after conversation is set.
      return;
    }
    // When an external signaling source (the WebRTC bridge) is wired, the
    // orchestrator must NOT open a second broker socket — the room capacity
    // is 2 and a second socket here would overfill it. Peer presence arrives
    // via notifyPeerJoined / notifyPeerLeft / notifySignalingClosed instead.
    if (!this.useInternalSignaling) {
      return;
    }
    // Tear down any prior client (e.g. retry after drop).
    if (this.signalingClient !== null) {
      try {
        this.signalingClient.close();
      } catch {
        // best-effort
      }
      this.signalingClient = null;
    }
    const roomId = conversationIdToHex(this.conversation);
    const client = new SignalingClient({
      brokerUrl: this.brokerUrl,
      roomId,
      role: deriveInternalSignalingRole(this.identity.publicKey),
      socketFactory: this.socketFactory,
      handlers: {
        onPeerJoin: () => {
          // Peer presence detected via the broker relay. We move from Waiting
          // to Signaling; the data channel attach will then drive Handshaking.
          if (this.currentState === ConnectionState.Waiting) {
            this.setState(ConnectionState.Signaling);
          }
        },
        onPeerLeave: () => {
          // The peer left the broker room. Tear down the session and move to
          // Disconnected so the UI can surface the drop and offer retry. Skip
          // when already Disconnected or never started (Idle) — the transition
          // validator rejects Idle→Disconnected, and a leave before start is
          // semantically meaningless.
          if (
            this.currentState !== ConnectionState.Disconnected &&
            this.currentState !== ConnectionState.Idle
          ) {
            this.teardownSession();
            this.setState(ConnectionState.Disconnected);
          }
        },
        onClose: () => {
          // Socket closed without a peer-leave (e.g. broker restart). Surface
          // as a drop unless we already tore down. Same Idle guard as
          // onPeerLeave — a close before start is meaningless.
          if (
            this.currentState !== ConnectionState.Disconnected &&
            this.currentState !== ConnectionState.Idle
          ) {
            this.teardownSession();
            this.setState(ConnectionState.Disconnected);
          }
        },
        onOffer: (sdp: unknown): void => {
          this.handlers.onRemoteOffer?.(sdp);
        },
        onAnswer: (sdp: unknown): void => {
          this.handlers.onRemoteAnswer?.(sdp);
        },
        onIce: (candidate: unknown): void => {
          this.handlers.onRemoteIce?.(candidate);
        },
        onError: (error: unknown): void => {
          this.handlers.onError?.(error);
        },
      },
    });
    this.signalingClient = client;
    client.connect();
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * R7/F3: classify a handshake error as a durable auth failure. An
 * {@link OrchestratorErrorCode.IdentityChanged} or any {@link PakeError}
 * indicates the peer's identity did not verify (either the TOFU key changed
 * or the PAKE confirmation tag mismatched). Per the PRD TOFU clause, recovery
 * requires a fresh invitation; the orchestrator durably records the flag so
 * retry() can block the caller from re-attempting on the same conversation.
 */
function isAuthFailureError(err: unknown): boolean {
  if (err instanceof OrchestratorError && err.code === OrchestratorErrorCode.IdentityChanged) {
    return true;
  }
  if (err instanceof PakeError) {
    return true;
  }
  return false;
}

function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/**
 * R7/F5 (Phase 8.1): derive the internal-signaling role from the local
 * identity key. The rule is deterministic and stable across reconnects for
 * the same identity: an even-parity first byte yields Initiator, an odd-parity
 * first byte yields Responder. Both internal-signaling peers apply the same
 * rule, so a pair of peers with different-parity keys (the common case under
 * uniform P-256 public keys) gets one Initiator and one Responder, making
 * glare resolvable via {@link GlareResolver} instead of both sides impolite.
 *
 * The derivation does NOT take the peer's identity key (which is unknown at
 * connectSignaling time) and so is independent of the authoritative TOFU
 * comparison in {@link verifyPeerAndComplete}; it only affects who keeps
 * their SDP offer when both peers offer simultaneously.
 */
function deriveInternalSignalingRole(localIdentityKey: PublicKey): Role {
  // SEC1 uncompressed public keys always start with 0x04 (the prefix byte);
  // use the first key byte (X coordinate) instead so the parity actually
  // varies across identities.
  const parityByte = localIdentityKey[1] ?? 0;
  return (parityByte & 0x01) === 0 ? Role.Initiator : Role.Responder;
}

/**
 * Adapt a {@link PeerTransport} into a {@link FrameTransport} for the
 * framing layer. `PeerTransport` exposes `setOnDrain` (the orchestrator-facing
 * name) while `FrameTransport` expects `setDrainListener` (the framing-facing
 * name); this thin wrapper maps between them and passes everything else
 * through. The transport instance is shared — both handshake bytes and
 * encrypted frames go over the same wire.
 */
function toFrameTransport(peer: PeerTransport): FrameTransport {
  return {
    send: (bytes: Uint8Array): void => {
      peer.send(bytes);
    },
    get bufferedAmount(): number {
      return peer.bufferedAmount;
    },
    get ready(): boolean {
      return peer.ready;
    },
    setDrainListener: (listener: (() => void) | null): void => {
      peer.setOnDrain(listener);
    },
  };
}
