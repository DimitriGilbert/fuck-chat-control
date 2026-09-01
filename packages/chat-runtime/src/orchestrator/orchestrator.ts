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
} from "../crypto";
import { ctEqual } from "../crypto/ct-equal";
import { zeroize } from "../crypto/primitives";
import type { EphemeralKeyPair, IdentityKeyPair, PakeSession } from "../crypto";
import { deriveRole, encodeSessionId, encodeTranscript } from "../protocol/codec";
import { ProtocolError, ProtocolErrorCode } from "../protocol/errors";
import {
  HANDSHAKE_TIMEOUT_MS,
  MAX_CONCURRENT_TRANSFERS,
  MAX_MANIFEST_MIME_BYTES,
  MAX_MANIFEST_NAME_BYTES,
  MAX_TEXT_PLAINTEXT_BYTES,
  PAKE_CONFIRM_MESSAGE_BYTES,
  PAKE_MESSAGE_BYTES,
  PAKE_ROLE_A,
  PAKE_ROLE_B,
  PROTOCOL_VERSION,
} from "../protocol/limits";
import { AuthMode, ControlSubtype, Role } from "../protocol/types";
import type { ConversationId, Signature, Transcript } from "../protocol/types";
import { FrameReceiver } from "../framing";
import { FrameSender } from "../framing";
import type { FrameTransport, ReceivedFile } from "../framing";
import {
  ConnectionState,
  ConnectionStateMachine,
  deriveGlareRole,
} from "../signaling/state-machine";
import { SignalingClient } from "../signaling/signaling-client";
import type { SignalingSocketFactory } from "../signaling/signaling-client";
import type { ConversationMessage, ConversationRepository } from "../store";
import { AuthFailedRetryBlocked, MessageDirection } from "../store";
import { getAuthFailedDurable, markAuthFailedDurable } from "../store/auth-failed-store";

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
  formatCodedInvitation,
  formatInvitation,
  generateConversationId,
  parseInvitation,
} from "./invitation";
import type { PeerTransport } from "../transport/peer-transport";

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
  /**
   * Public base URL used as the PREFIX of every generated invitation link
   * (MEDIUM-E). Distinct from {@link baseUrl} (used for asset fetches and any
   * same-origin relative URL) because the desktop shell's asset origin
   * (`tauri://localhost`) is NOT a URL a responder can open. When unset the
   * orchestrator falls back to {@link baseUrl} so non-desktop callers — which
   * format invitations from the same origin that serves assets — see no
   * behavior change.
   */
  readonly publicBaseUrl?: string;
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
  /**
   * Override the PAKE handshake await timeout (default
   * {@link HANDSHAKE_TIMEOUT_MS}). Test-only seam: production must leave this
   * unset so the canonical 30s constant bounds the awaits. Unit tests inject a
   * small value so the timeout-rejection path is observable without waiting
   * the real 30 seconds and without fighting fake timers against the real
   * async WASM crypto.
   */
  readonly handshakeTimeoutMsOverride?: number;
  /**
   * R8/F1 (Phase 6): master feature gate for PAKE-coded invitations. When
   * `false`, the orchestrator rejects any invitation whose fragment carries a
   * `~<code>` tail at the {@link join} parse boundary — BEFORE any
   * {@link createPakeSession}/{@link loadWasm} call — by throwing
   * {@link OrchestratorErrorCode.PakeDisabled}. UNCoded invitations (no `~code`)
   * are accepted regardless: they negotiate {@link AuthMode.SafetyNumberOnly}
   * and never touch the wasm-gated PAKE path.
   *
   * Defaults to `true` so web/desktop (which ship the SPAKE2 wasm) are
   * unchanged. v1 mobile passes `false` because Metro blockLists the wasm pkg,
   * so a `~code` deep link would otherwise crash at {@link loadWasm} (R8:F1,
   * BLOCKER). The gate is enforced here, in logic, IN ADDITION to the Metro
   * blockList (which stays as a defense — it keeps the wasm out of the bundle).
   */
  readonly enablePake?: boolean;
}

const HELLO_BYTES = 163;
const SIGNATURE_MESSAGE_BYTES = 65;
/**
 * R2/F6 (Phase 7): a PAKE code must be exactly 6 decimal digits (PRD #90) —
 * the same shape the responder's invitation parser enforces
 * (`HEX_WITH_CODE_PATTERN` in invitation.ts, whose loud non-6-digit error this
 * gate mirrors). start(code)/setPakeCode validate against this BEFORE any
 * state mutation so `start("12345")` fails fast instead of minting an
 * invitation every responder rejects.
 */
const PAKE_CODE_PATTERN = /^\d{6}$/;

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
  /**
   * Prefix of every generated invitation link (MEDIUM-E). Defaults to
   * {@link baseUrl} when the caller did not supply a distinct public origin,
   * preserving the legacy behavior for non-desktop callers. Used ONLY as the
   * prefix argument to {@link formatInvitation} / {@link formatCodedInvitation};
   * asset-resolution paths (e.g. `/ice-config`, `/wasm/...`) live outside the
   * orchestrator, in the platform providers, so this field carries the single
   * base the orchestrator itself cares about.
   */
  private readonly publicBaseUrl: string;
  private readonly repository: ConversationRepository;
  private readonly socketFactory: SignalingSocketFactory;
  private readonly identity: IdentityKeyPair;
  private readonly handlers: OrchestratorHandlers;
  private readonly useInternalSignaling: boolean;
  /**
   * Effective PAKE handshake await timeout. Defaults to
   * {@link HANDSHAKE_TIMEOUT_MS}; overridden only via the test-only
   * {@link OrchestratorDeps.handshakeTimeoutMsOverride} seam.
   */
  private readonly handshakeTimeoutMs: number;
  /**
   * R8/F1 (Phase 6): cached from {@link OrchestratorDeps.enablePake} (default
   * `true`). Read at the {@link join} parse boundary to reject `~code`
   * invitations before they reach {@link createPakeSession}/{@link loadWasm}.
   */
  private readonly enablePake: boolean;

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
   * Rejector paired with {@link pakeConfirmResolve}; same role as
   * {@link pakePeerShareReject} for the confirmation-tag await.
   */
  private pakeConfirmReject: ((err: unknown) => void) | null = null;
  /**
   * Timer handle for the {@link awaitPakeFinish} handshake-timeout. Armed when
   * the await begins, cleared on every exit path (share arrives normally,
   * timeout fires, or {@link teardownSession} rejects the parked resolver).
   * Kept as a field so teardown can clear a dangling timer when it rejects the
   * resolver out from under the race — prevents a late timer callback firing
   * into an already-settled promise or after teardown. Null when no await is
   * in flight.
   */
  private pakeShareTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
  /**
   * Timer handle for the {@link runPakeConfirmation} handshake-timeout. Same
   * lifecycle as {@link pakeShareTimeoutHandle}; armed when the confirm await
   * begins, cleared on every exit path.
   */
  private pakeConfirmTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
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
   * CR-15 test-only mirror of the derived traffic send key. Populated in
   * {@link verifyPeerAndComplete} once {@link deriveSessionKeys} resolves, and
   * cleared in {@link teardownSession}. The framing layer owns the authoritative
   * copy (inside the private `FrameSender.config.sessionKeys.sendKey`); this
   * field exists solely so the test seam {@link __getSendKeyForTest} can expose
   * the derived key to integration tests without breaking the FrameSender's
   * encapsulation. NEVER read this in production code — production uses the
   * framing layer's copy.
   */
  private derivedSendKeyForTest: Uint8Array | null = null;
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
   * Per-transfer metadata for in-flight sends, so the framing layer's progress
   * hook (which only carries id + byte counts) can emit a full summary with
   * name/mimeType/size. R2/F4 (Phase 7): each entry is registered SYNCHRONOUSLY
   * at {@link sendFile} entry under the id that call reserved via
   * {@link FrameSender.beginFileTransfer} — per-transfer state can never
   * interleave between concurrent sends the way the old shared
   * currentTransferIdTracker slot (invoked at onTransferStart fire time, i.e.
   * after the sha256 await) did. `cancelEmitted` records whether
   * {@link cancelTransfer} already emitted `onTransferCancelled` for this id so
   * the sendFile catch does not double-emit (R2/F3). Drained in the send's
   * finally, so the entry (and flag) live exactly as long as the send.
   */
  private readonly sendTransferMetadata = new Map<
    number,
    { name: string; mimeType: string; size: number; cancelEmitted: boolean }
  >();

  constructor(deps: OrchestratorDeps) {
    this.brokerUrl = deps.brokerUrl;
    this.publicBaseUrl = deps.publicBaseUrl ?? deps.baseUrl;
    this.repository = deps.repository;
    this.socketFactory = deps.socketFactory;
    this.identity = deps.identity;
    this.handlers = deps.handlers ?? {};
    this.useInternalSignaling = deps.useInternalSignaling ?? true;
    // R8/F1 (Phase 6): default true so web/desktop (which ship the SPAKE2 wasm)
    // are unchanged. Mobile passes false to gate coded invitations off in logic.
    this.enablePake = deps.enablePake ?? true;
    // M6: validate the test-only override — a non-finite or non-positive value
    // (0, negative, NaN) would make the handshake timer fire immediately and
    // falsely fail every handshake. Silently fall back to the production bound
    // rather than throwing (the field is documented test-only). A valid finite
    // positive number is honoured (preserving the test seam).
    const timeoutOverride = deps.handshakeTimeoutMsOverride;
    this.handshakeTimeoutMs =
      typeof timeoutOverride === "number" && Number.isFinite(timeoutOverride) && timeoutOverride > 0
        ? timeoutOverride
        : HANDSHAKE_TIMEOUT_MS;
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
   * CR-15 TEST-ONLY SEAM. Returns the traffic send key derived by
   * {@link deriveSessionKeys} for the current (or just-torn-down) session, or
   * `null` if no handshake has completed key derivation yet.
   *
   * This seam exists solely so integration tests can prove the PAKE shared
   * secret is mixed into the key schedule: a Pake handshake and a
   * SafetyNumberOnly handshake over the SAME two identity keys (identical
   * ECDH + transcript) MUST derive different sendKeys, because the former
   * feeds `pakeSecret` into {@link deriveSessionKeys} while the latter passes
   * `undefined`. That load-bearing assertion (report 14 M2) is unreachable
   * without this seam because the framing layer's `FrameSender` keeps its
   * `sessionKeys` private.
   *
   * The `__` prefix and this docstring mark it as test-only. Production code
   * MUST NOT call this method; production uses the framing layer's own copy.
   * The field is mirrored in {@link verifyPeerAndComplete} and cleared in
   * {@link teardownSession}; no production behavior changes.
   */
  __getSendKeyForTest(): Uint8Array | null {
    return this.derivedSendKeyForTest;
  }

  /**
   * Supply the 6-digit PAKE code for this session, switching the negotiated
   * auth mode to {@link AuthMode.Pake}. This is the seam Phase 8's invitation
   * fragment parser (`~code`) will call; Phase 1's own tests call it directly.
   *
   * R2/F6 (Phase 7): mirrors the {@link join} gate. Throws
   * {@link OrchestratorErrorCode.PakeDisabled} when this orchestrator was
   * constructed with `enablePake === false` (no `~code` path may ever reach
   * `createPakeSession`/`loadWasm` on such builds), and
   * {@link OrchestratorErrorCode.MalformedInvitation} when the code is not
   * exactly 6 decimal digits (the same loud PRD #90 error the responder's
   * invitation parser raises). No PAKE state is written when either fires.
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
    if (!this.enablePake) {
      throw new OrchestratorError(
        OrchestratorErrorCode.PakeDisabled,
        "coded invitations (PAKE) are not supported in this build",
      );
    }
    if (!PAKE_CODE_PATTERN.test(code)) {
      throw new OrchestratorError(
        OrchestratorErrorCode.MalformedInvitation,
        "PAKE code must be exactly 6 decimal digits per PRD #90 (got: '" + code + "')",
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

  /**
   * INITIATOR flow: generate conversation id, persist, format invitation.
   *
   * R7/F6 (Phase 8.3 / Phase 10 demo-amenable): accepts an optional 6-digit
   * PAKE code. When supplied, the negotiated auth mode flips to
   * {@link AuthMode.Pake} BEFORE signaling opens (so the PAKE state is ready
   * when the peer arrives), and the returned invitation link carries the
   * `~<code>` suffix so the responder's `parseInvitation` extracts it. The
   * code rides in the URL fragment (hash), which browsers never send to the
   * server — the broker only sees the bare conversation id.
   *
   * R2/F6 (Phase 7): a supplied code is validated BEFORE any state mutation
   * (before `started` flips, before the conversation is persisted, before an
   * invitation is minted). Throws {@link OrchestratorErrorCode.PakeDisabled}
   * on `enablePake === false` builds (same error shape as the join() gate) and
   * {@link OrchestratorErrorCode.MalformedInvitation} for a non-6-digit code —
   * fail fast instead of parking the initiator on an invitation every
   * responder rejects. The orchestrator remains reusable after either throw.
   *
   * The code is written directly to {@link pakeCode} / {@link authMode} rather
   * than via {@link setPakeCode} because {@link setPakeCode} is the public
   * seam and refuses post-`start` calls (we have already flipped
   * {@link started}). Mirrors the {@link join} path's direct write.
   */
  async start(code?: string): Promise<string> {
    if (this.started) {
      throw new OrchestratorError(
        OrchestratorErrorCode.AlreadyStarted,
        "orchestrator has already been started",
      );
    }
    if (code !== undefined && code.length > 0) {
      if (!this.enablePake) {
        throw new OrchestratorError(
          OrchestratorErrorCode.PakeDisabled,
          "coded invitations (PAKE) are not supported in this build",
        );
      }
      if (!PAKE_CODE_PATTERN.test(code)) {
        throw new OrchestratorError(
          OrchestratorErrorCode.MalformedInvitation,
          "PAKE code must be exactly 6 decimal digits per PRD #90 (got: '" + code + "')",
        );
      }
    }
    this.started = true;
    const id = generateConversationId();
    this.conversation = id;
    await this.repository.createConversation(id, Date.now());
    // R7/F3 + SEC-1 durability: hydrate the in-memory cache from BOTH the
    // in-repo flag and the durable localStorage store. The durable store is the
    // cross-session source of truth (the in-repo flag may be false if the
    // session never reached the inner repo — e.g. the manager was locked at
    // failure time). Either being true means retry() must block.
    this.authFailedCached =
      (await this.repository.getAuthFailed(id)) || (await getAuthFailedDurable(id));
    if (code !== undefined && code.length > 0) {
      this.pakeCode = code;
      this.authMode = AuthMode.Pake;
    }
    const invitation =
      code !== undefined && code.length > 0
        ? formatCodedInvitation(id, this.publicBaseUrl, code)
        : formatInvitation(id, this.publicBaseUrl);
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
    // R7/F3 + SEC-1 durability: hydrate the in-memory cache from BOTH the
    // in-repo flag and the durable localStorage store. join() is the re-entry
    // point for the controller's resumeConversation path (createConversation is
    // idempotent and preserves the existing authFailed flag), so this closes
    // the restart gap: a fresh orchestrator on a previously-auth-failed
    // conversation reads the durable truth and retry() correctly throws
    // AuthFailedRetryBlocked even if the in-repo flag was never landed.
    this.authFailedCached =
      (await this.repository.getAuthFailed(parsed.conversationId)) ||
      (await getAuthFailedDurable(parsed.conversationId));
    // R8/F1 (Phase 6): PAKE feature gate. When this orchestrator was constructed
    // with enablePake === false (v1 mobile — the SPAKE2 wasm is Metro-blocked),
    // reject any invitation whose fragment carried a `~<code>` tail HERE, at the
    // parse boundary, BEFORE we write pakeCode/authMode=Pake and well before any
    // createPakeSession/loadWasm call. Without this gate a `~code` deep link
    // reaches createPakeSession → loadWasm and crashes mid-handshake on mobile
    // (R8:F1, BLOCKER). UNCoded invitations (parsed.code === null) are accepted
    // regardless of the flag: they negotiate SafetyNumberOnly and never touch the
    // wasm-gated path. The error is a distinguishable OrchestratorError(PakeDisabled)
    // so the mobile UI can surface "coded invitations are not supported in this
    // build" rather than a generic handshake failure. Web/desktop default the
    // flag to true and never hit this branch.
    if (parsed.code !== null && !this.enablePake) {
      throw new OrchestratorError(
        OrchestratorErrorCode.PakeDisabled,
        "coded invitations (PAKE) are not supported in this build",
      );
    }
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
    // CR-1: reset so a second failure on a fresh retry path surfaces. Without
    // this, failHandshake's `if (this.handshakeError !== null) return;` guard
    // turns handshakeError into a set-once flag — the FIRST failure silently
    // swallows every subsequent failure, including on a brand-new transport
    // after retry(). Tying the reset to a fresh attachTransport (rather than
    // a separate handshakeErrorGeneration) is sufficient: a new handshake
    // always claims its own transport, so there is no multi-transport race.
    this.handshakeError = null;
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

  /**
   * Send a text message (UTF-8). Persists locally, encrypts, sends.
   *
   * R2/F5 (Phase 7): the plaintext is validated against
   * {@link MAX_TEXT_PLAINTEXT_BYTES} BEFORE the persist. Previously the bound
   * was enforced only deep in `encodeFrameHeader`, so a text above the 16 KiB
   * AEAD cap was durably stored as `Sent` and then rejected at send time with
   * nothing transmitted — history diverged from the peer with no retry path.
   * The bound is derived in limits.ts from the codec's
   * `MAX_TEXT_FRAME_BYTES` minus the GCM tag, so it can never drift from what
   * the codec actually enforces.
   */
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
    const bytes = new TextEncoder().encode(text);
    if (bytes.length > MAX_TEXT_PLAINTEXT_BYTES) {
      throw new ProtocolError(
        ProtocolErrorCode.LimitExceeded,
        `text payload of ${bytes.length} bytes exceeds the Text frame plaintext cap (${MAX_TEXT_PLAINTEXT_BYTES} bytes)`,
      );
    }
    const timestamp = Date.now();
    await this.repository.appendMessage(this.conversation, text, MessageDirection.Sent, timestamp);
    await this.frameSender.sendText(bytes);
  }

  /**
   * Send a binary file to the peer over the established session. Validates
   * Connected + manifest limits, enforces the concurrent-transfer cap, and
   * emits start/progress/complete (or error/cancelled) via the transfer
   * handlers. Returns the new transfer id.
   *
   * R2/F4 + R2/F8 (Phase 7): the transfer id is allocated AND reserved
   * synchronously via {@link FrameSender.beginFileTransfer} at this method's
   * entry — before the sender's sha256 await — so the reservation counts
   * against {@link MAX_CONCURRENT_TRANSFERS} immediately (closing the
   * check-then-act race where N concurrent calls all passed the cap) and every
   * per-call state below (metadata registration, error attribution) is bound
   * to THIS call's own id. The old design installed a shared mutable tracker
   * slot that the sender invoked at onTransferStart fire time (after hashing),
   * which cross-attributed ids/metadata between concurrent sends.
   *
   * The framing layer chunks, hashes, and backpressures internally. This
   * method registers a per-transfer progress hook on the sender so the
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
    // R2/F4 + R2/F8: reserve the id synchronously (counted against the cap from
    // this instant) and bind THIS call's metadata to it — no shared slot.
    const transferId = sender.beginFileTransfer();
    this.sendTransferMetadata.set(transferId, {
      name,
      mimeType,
      size: total,
      cancelEmitted: false,
    });

    try {
      await sender.sendFile(transferId, data, name, mimeType);
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
      if (this.isCancellationError(err)) {
        // R2/F3: cancelTransfer is the single emission point — it already
        // emitted (and flagged the metadata entry) when it actually cancelled
        // this transfer. The skip check keeps this path from double-emitting;
        // the emit below is the belt-and-braces branch for a cancellation
        // rejection that did not route through cancelTransfer.
        const meta = this.sendTransferMetadata.get(transferId);
        if (meta === undefined || !meta.cancelEmitted) {
          this.handlers.onTransferCancelled?.(transferId);
        }
      } else {
        this.handlers.onTransferError?.(transferId, err);
      }
      throw err;
    } finally {
      this.sendTransferMetadata.delete(transferId);
    }
  }

  /**
   * Cancel an in-flight transfer on both sides: the sender stops the chunk
   * loop and the receiver drops any buffered chunks. Either side is safe to
   * call; an unknown id (no active transfer on either side) is a silent no-op.
   *
   * R2/F3 (Phase 7): `onTransferCancelled` is emitted exactly ONCE, from HERE,
   * and only when an active transfer was actually cancelled — the sender and
   * receiver {@link cancelTransfer} implementations report whether they found
   * one. The rejected in-flight `sendFile` coroutine checks the
   * `cancelEmitted` flag on its metadata entry and skips its own emission, so
   * a cancelled send surfaces one event total, and cancelling an id nothing
   * knows surfaces zero.
   */
  cancelTransfer(transferId: number): void {
    let cancelled = false;
    if (this.frameSender !== null) {
      cancelled = this.frameSender.cancelTransfer(transferId) || cancelled;
    }
    if (this.frameReceiver !== null) {
      cancelled = this.frameReceiver.cancelTransfer(transferId) || cancelled;
    }
    if (!cancelled) {
      return;
    }
    const meta = this.sendTransferMetadata.get(transferId);
    if (meta !== undefined) {
      meta.cancelEmitted = true;
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
    // Connect signaling synchronously; the glare role is derived from the
    // local identity key alone (deriveGlareRole — the peer's key is not
    // available at this point), deterministic and stable across reconnects.
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
      // CR-2 phase guard (strict): a PakeShare is only ever valid once the local
      // signature round has begun — i.e. after `verifyPeerAndComplete` has set
      // pakeLocalSideByte synchronously (PAKE mode) or after a PAKE session
      // exists (re-entry/async races within the same handshake). The signal
      // pakeLocalSideByte === null && pakeSession === null is true EXACTLY when
      // no PAKE round has begun: in SafetyNumberOnly mode it is always true
      // (PAKE frames are invalid anyway), and in Pake mode it is true until the
      // synchronous top-of-verifyPeerAndComplete assignment — closing the prior
      // window between Hello receipt (remoteHello set at ~783) and the
      // setState(Verifying) call that previously ran only AFTER verifyTranscript.
      // An attacker-injected PAKE frame landing in that window is now rejected
      // at the gate rather than stashed. The legitimate reorder (share racing
      // ahead of awaitPakeFinish) lands AFTER the synchronous set, so the guard
      // does not fire and the share flows through to handlePakeShare as before.
      if (this.pakeLocalSideByte === null && this.pakeSession === null) {
        throw new OrchestratorError(
          OrchestratorErrorCode.MalformedHandshakeMessage,
          "PAKE frame received before signature verified",
        );
      }
      const msg = decodePakeShare(bytes);
      if (generation !== this.handshakeGeneration) return;
      await this.handlePakeShare(msg.role, msg.share);
      return;
    }
    if (bytes.length === PAKE_CONFIRM_MESSAGE_BYTES) {
      // CR-2 phase guard (strict): same invariant as PakeShare — a PakeConfirm is
      // only valid once the local PAKE round has begun. See the PakeShare branch
      // above for the full rationale on the pakeLocalSideByte/pakeSession signal.
      if (this.pakeLocalSideByte === null && this.pakeSession === null) {
        throw new OrchestratorError(
          OrchestratorErrorCode.MalformedHandshakeMessage,
          "PAKE frame received before signature verified",
        );
      }
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
    // Capture the handshake generation BEFORE the signTranscript await (the
    // same discipline as beginHandshake/handleInbound/verifyPeerAndComplete).
    // A stale sign coroutine parked across a teardown → retry() → re-attach
    // must NOT resume against the fresh handshake: it would send a signature
    // over the OLD transcript on the NEW transport (the honest peer's
    // verifyTranscript then fails and failHandshake kills the fresh session)
    // and latch `localSignatureSent` on the fresh handshake, stalling its own
    // signature round. Bail silently — no send, no flag, no error emission.
    const generation = this.handshakeGeneration;
    const signature = await signTranscript(this.identity.privateKey, transcript);
    if (this.handshakeSuperseded(generation)) {
      return;
    }
    // Idempotence under a duplicate Hello: a second maybeSignAndSend coroutine
    // of the SAME handshake can have completed the send while this one was
    // parked in signTranscript — send at most one signature per handshake.
    if (this.localSignatureSent) return;
    this.transport?.send(encodeSignatureMessage(signature));
    this.localSignatureSent = true;
  }

  private async maybeCompleteHandshake(): Promise<void> {
    // We have the remote hello; we may have also received the remote's
    // signature (handled by verifyPeerAndComplete). Nothing to do here until
    // the signature arrives.
  }

  private async verifyPeerAndComplete(remoteSignature: Signature): Promise<void> {
    // R2/F1: arm the re-entrancy latch as the FIRST synchronous statement,
    // BEFORE any await. attachTransport dispatches every inbound message via
    // `void this.handleInbound(bytes).catch(...)` with no serialization, and
    // an async body runs synchronously up to its first await — so a duplicated
    // SignatureMessage spawns two coroutines that BOTH pass the check below
    // before either reaches an await. With the latch armed only after the
    // verifyTranscript/getPeerIdentity awaits (its old position), both
    // coroutines ran to completion: two FrameSender/FrameReceiver pairs (the
    // first receiver's setInterval sweep leaks forever — teardownSession only
    // tears down the currently-assigned receiver), double
    // onSafetyNumber/storePeerIdentity, and in PAKE mode a duplicate SPAKE2
    // share that aborts the honest peer's session. The latch is reset ONLY by
    // teardownSession; the superseded bail-outs below must NOT reset it —
    // after a teardown a newer handshake may already have re-armed it.
    if (this.handshakeCompleting) return;
    this.handshakeCompleting = true;
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

    // R2/F2: capture the handshake generation at entry, mirroring the
    // beginHandshake/handleInbound discipline. teardownSession bumps NEITHER
    // the generation nor any explicit torn-down flag, and it does NOT reject
    // the non-resolver awaits below (verifyTranscript, getPeerIdentity,
    // createPakeSession, pakeFinish's inner crypto, deriveSessionKeys,
    // computeSafetyNumber, storePeerIdentity) — they resolve normally into a
    // coroutine that must not resume against torn-down state. Every
    // handshakeSuperseded re-check bails out SILENTLY: no state mutation, no
    // failHandshake, no onError. This closes both verified failure modes:
    // (a) resuming into `toFrameTransport(this.transport)` with a nulled
    //     transport — the FrameSender constructor's setDrainListener would
    //     throw a raw TypeError into failHandshake, emitting a spurious
    //     post-leave onError and latching handshakeError so failHandshake's
    //     guard swallows the next genuine error;
    // (b) teardown → retry() → re-attach while parked: this.transport is then
    //     the NEW transport, and without the generation check the stale
    //     coroutine would wire OLD session keys over it, assign the framing
    //     fields, and kill the fresh session when setState(Connected) throws
    //     InvalidTransitionError into failHandshake.
    // The transport/ephemeral null-checks cover a teardown not (yet) followed
    // by a re-attach; the generation check covers the re-attached case where
    // both fields are non-null again but belong to a newer handshake. It also
    // guards the deriveSessionKeys call, which reads this.ephemeral.privateKey
    // — zeroized in place and then nulled by teardownSession while this
    // coroutine is parked.
    const generation = this.handshakeGeneration;

    const remoteIdentityKey = this.remoteHello.identityPublicKey;
    const remoteEphemeralKey = this.remoteHello.ephemeralPublicKey;
    const remoteSessionId = this.remoteHello.sessionId;

    // CR-2 strict: set the local side byte SYNCHRONOUSLY before the first await
    // (verifyTranscript below) so the inbound dispatcher's PAKE phase guard keys
    // on a signal that is true EXACTLY when the signature round has begun —
    // closing the window between Hello receipt (remoteHello set in dispatch at
    // ~783) and signature verification (which setState(Verifying) only marks as
    // having begun AFTER the await below). Without this, an attacker-injected
    // PAKE frame landing in that window would pass the remoteHello !== null guard
    // and be stashed. pakeLocalSideByte is the same value the PAKE block below
    // uses to send our share; computing it here lets us reuse it there.
    let pakeRole: Role | null = null;
    if (this.authMode === AuthMode.Pake) {
      pakeRole = deriveRole(this.identity.publicKey, remoteIdentityKey);
      this.pakeLocalSideByte = pakeRole === Role.Initiator ? PAKE_ROLE_A : PAKE_ROLE_B;
    }

    // Signature verification against the transcript.
    const ok = await verifyTranscript(remoteIdentityKey, remoteSignature, this.transcript);
    // R2/F2 re-check: runs BEFORE the !ok branch so a teardown during the
    // verify await never surfaces a post-leave HandshakeSignatureMismatch
    // onError (and never enters Verifying from a state the teardown already
    // left — Disconnected → Verifying is an illegal transition).
    if (this.handshakeSuperseded(generation)) return;
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
    // R2/F2 re-check: repository awaits are never rejected by teardownSession;
    // without this the coroutine would resume the TOFU comparison and every
    // later stage against a torn-down session.
    if (this.handshakeSuperseded(generation)) return;
    if (existing !== null) {
      const sameKey = ctEqual(existing.publicKey, remoteIdentityKey);
      if (!sameKey) {
        throw new OrchestratorError(
          OrchestratorErrorCode.IdentityChanged,
          "peer identity key changed since last contact",
        );
      }
    }

    // If this session negotiated PAKE, run the SPAKE2 exchange over the data
    // channel before deriving session keys. The shared secret is mixed into the
    // HKDF chain via `deriveSessionKeys`. A PAKE failure is fatal: there is NO
    // silent fallback to safety-number-only.
    let pakeSecret: Uint8Array | null = null;
    if (this.authMode === AuthMode.Pake) {
      const code = this.pakeCode;
      if (code === null) {
        throw new PakeError(PakeErrorCode.Abort, "authMode is Pake but no PAKE code is set");
      }
      // pakeRole/pakeLocalSideByte were computed synchronously at the top of this
      // method (before verifyTranscript). Reuse them: one source of truth for the
      // local role, both for the guard signal and the outbound share byte. The
      // non-null checks are invariants (both are set iff authMode is Pake at the
      // top of this method) and guard against any future reorder.
      if (pakeRole === null || this.pakeLocalSideByte === null) {
        throw new PakeError(PakeErrorCode.Abort, "PAKE role not derived before session creation");
      }
      const role = pakeRole;
      const sideByte = this.pakeLocalSideByte;
      const session = await createPakeSession(code, role);
      // R2/F2 re-check: bail BEFORE assigning this.pakeSession or sending the
      // share — a teardown during the wasm/crypto await must not resurrect
      // handshake state or emit bytes on a dead transport.
      if (this.handshakeSuperseded(generation)) {
        // R1/F3 hygiene: this coroutine owns `session` but never assigned it
        // to this.pakeSession, so teardownSession cannot reach it — dispose of
        // it here instead: wipe the JS-side share copy in place (the
        // teardownSession convention) and free the wasm state via
        // PakeStateHandle.free(), the wrapper's only dispose surface. The
        // share is public material (it was about to cross the wire in
        // cleartext), so this is hygiene, not secrecy.
        if (session.state !== null) {
          session.state.outgoing_share.fill(0);
          session.state.free();
        }
        return;
      }
      this.pakeSession = session;
      // Send the local SPAKE2 share to the peer (cleartext, as with the Hello).
      const localShare = pakeOutgoingShare(session);
      this.transport.send(encodePakeShare(sideByte, localShare));
      // Await the peer's share; handlePakeShare stashes it and completes the
      // exchange when both shares are present.
      pakeSecret = await this.awaitPakeFinish();
      // R2/F2 re-check: awaitPakeFinish REJECTS with PakeError(Cancelled) when
      // teardownSession rejects a parked share resolver (the H1 contract), but
      // when the peer's share was already stashed the coroutine instead parks
      // in pakeFinish's own crypto await, which teardown does NOT reject — this
      // re-check covers that window. Wipe the derived secret on the bail path
      // too: the R1/F3 try/finally below is never reached.
      if (this.handshakeSuperseded(generation)) {
        if (pakeSecret !== null) {
          zeroize(pakeSecret);
        }
        return;
      }
    }

    // Derive session keys. For a Pake session the SPAKE2 shared secret is
    // bound into HKDF; for SafetyNumberOnly it is null (and the transcript
    // authMode is SafetyNumberOnly, so the defensive check in
    // deriveSessionKeys does not trip).
    //
    // R1/F3: wrap the secret's last two consumers (PAKE confirmation + HKDF) in
    // a try/finally so the SPAKE2 shared secret is wiped on BOTH the success
    // path and any mid-consumption throw (PAKE confirmation mismatch, key-
    // derivation failure). The secret is a local (not an orchestrator field),
    // so teardownSession cannot reach it; this finally is its only wipe site.
    let sessionKeys;
    try {
      if (pakeSecret !== null) {
        // Confirmation: SPAKE2 does not itself detect a wrong password (both
        // sides complete `pakeFinish` with divergent secrets). Each side derives
        // a role-bound MAC tag over the transcript hash keyed by the SPAKE2
        // secret, exchanges it, and verifies. A mismatch proves a wrong-code
        // attack and aborts — there is NO path to Connected under divergent
        // traffic keys. pakeRole is guaranteed non-null here: the earlier guard
        // in the Pake block above threw if it was null, and pakeSecret is null
        // entirely for SafetyNumberOnly sessions (this branch is skipped).
        await this.runPakeConfirmation(pakeSecret, pakeRole as Role, generation);
        // R2/F2 re-check: runPakeConfirmation guards its own pre-park crypto
        // awaits internally (see below), but its trailing tag-derivation await
        // (the expectedPeerTag computation) is still not rejected by teardown.
        // The bail must land BEFORE deriveSessionKeys reads
        // this.ephemeral.privateKey, which teardownSession zeroized in place
        // and then nulled. The return still flows through the finally below,
        // preserving the R1/F3 wipe.
        if (this.handshakeSuperseded(generation)) return;
      }
      sessionKeys = await deriveSessionKeys({
        localEcdhPrivateKey: this.ephemeral.privateKey,
        peerEcdhPublicKey: remoteEphemeralKey,
        transcript: this.transcript,
        localIdentityPublicKey: this.identity.publicKey,
        pakeSecret: pakeSecret ?? undefined,
      });
    } finally {
      // R1:F3: the SPAKE2 shared secret has now been consumed by both the
      // confirmation tag exchange (runPakeConfirmation) and the HKDF key
      // schedule (deriveSessionKeys). Wipe it so it does not linger on the heap
      // for the lifetime of the orchestrator. A local copy captured by the
      // GC/runtime is not reached (best-effort), but this bounds the live
      // secret to the handshake path.
      if (pakeSecret !== null) {
        zeroize(pakeSecret);
        pakeSecret = null;
      }
    }
    // R2/F2 re-check: keys derived by a superseded coroutine belong to no
    // session — bail before mirroring the key or mutating any session state.
    if (this.handshakeSuperseded(generation)) return;
    // CR-15: mirror the derived send key for the test-only seam. See the field
    // docstring on `derivedSendKeyForTest` — this is NOT read by any production
    // codepath; it exists so integration tests can assert the PAKE secret was
    // mixed into the key schedule (the load-bearing assertion of report 14 M2).
    this.derivedSendKeyForTest = sessionKeys.sendKey;

    const safetyNumber = await computeSafetyNumber(
      this.conversation,
      this.identity.publicKey,
      remoteIdentityKey,
    );
    // R2/F2 re-check: the last crypto await — bail before publishing the
    // safety number or writing the TOFU identity for a torn-down session.
    if (this.handshakeSuperseded(generation)) return;
    this.safetyNumberValue = safetyNumber;

    // TOFU: persist the peer identity on first contact (fingerprint = safety number).
    if (existing === null) {
      await this.repository.storePeerIdentity(this.conversation, safetyNumber, remoteIdentityKey);
    }
    // R2/F2 re-check (final): the FrameSender construction below calls
    // `toFrameTransport(this.transport)`, whose setDrainListener throws a raw
    // TypeError on a nulled transport — the post-leave spurious-onError path
    // (a). This is the last await before framing is wired, so it is also what
    // stops a stale coroutine from wiring OLD keys over a NEW transport after
    // teardown → retry() → re-attach: the re-attach bumps the generation and
    // this check fires before any framing is constructed (b).
    if (this.handshakeSuperseded(generation)) return;

    // Construct the framing layer and re-wire inbound delivery.
    const sender = new FrameSender({
      sessionKeys,
      localSessionId: this.localHello.sessionId,
      peerSessionId: remoteSessionId,
      transport: toFrameTransport(this.transport),
      onTransferStart: (transferId: number, name: string, mimeType: string, size: number): void => {
        // R2/F4 (Phase 7): no shared tracker slot here anymore — each send's
        // metadata was already registered under its own reserved id at
        // orchestrator.sendFile entry; this hook only surfaces the event.
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
        // R2/F7 (Phase 7): handleReceivedText awaits repository.appendMessage;
        // a storage rejection (locked at-rest manager, OPFS/IndexedDB failure)
        // must surface via onError — with a bare `void` it became an unhandled
        // promise rejection and the decrypted authenticated message was
        // silently dropped. Wrapping matches the failHandshake fire-and-forget
        // repo-write convention (cause preserved for diagnostics).
        void this.handleReceivedText(plaintext).catch((err: unknown) => {
          this.handlers.onError?.(
            new OrchestratorError(
              OrchestratorErrorCode.DurableStoreWriteFailed,
              "failed to persist received message",
              err,
            ),
          );
        });
      },
      onControl: (): void => {
        // Control frames are not part of this slice's surface area.
      },
      onFileComplete: (file: ReceivedFile): void => {
        this.handleReceivedFile(file);
      },
      // CR-5: surface per-transfer inactivity timeouts as transfer errors so
      // the host application can clear UI state for stalled peer transfers.
      // Passed as a plain Error rather than an OrchestratorError code: there
      // is no dedicated timeout code, and onTransferError accepts unknown.
      onTransferTimeout: (transferId: number): void => {
        this.handlers.onTransferError?.(
          transferId,
          new Error(`inbound transfer ${transferId} timed out after inactivity`),
        );
      },
    });
    this.frameSender = sender;
    this.frameReceiver = receiver;

    this.setState(ConnectionState.Connected);
    this.handlers.onSafetyNumber?.(safetyNumber, this.safetyNumberVerified);
  }

  /**
   * R2/F2: true when the {@link verifyPeerAndComplete} coroutine that captured
   * `generation` at entry has been superseded and must bail out silently.
   * Two disjoint conditions, both caused by teardownSession running while the
   * coroutine was parked on one of the awaits that teardown does not reject:
   *
   * 1. `generation !== this.handshakeGeneration` — the teardown was followed
   *    by retry() + a fresh attachTransport (the only generation-bumping call,
   *    reachable only from Waiting/Signaling, i.e. only after a teardown).
   *    this.transport/this.ephemeral are non-null again but belong to the NEW
   *    handshake; resuming would wire stale keys over the new session.
   * 2. `this.transport === null || this.ephemeral === null` — teardown ran
   *    with no re-attach yet; teardownSession nulled both (zeroizing the
   *    ephemeral private key in place first).
   *
   * Callers must `return` without touching state, without throwing, and
   * WITHOUT resetting the handshakeCompleting latch — a newer coroutine may
   * already own it (teardownSession reset it on the teardown path).
   */
  private handshakeSuperseded(generation: number): boolean {
    return (
      generation !== this.handshakeGeneration || this.transport === null || this.ephemeral === null
    );
  }

  /**
   * Resolver for the peer-share promise. Set by {@link awaitPakeFinish} and
   * resolved by {@link handlePakeShare} once the peer's SPAKE2 share lands.
   * Kept as a field (not a local) because the share may arrive before
   * `awaitPakeFinish` is entered. Paired with {@link pakePeerShareReject} so
   * {@link teardownSession} can reject the parked promise (settling the
   * coroutine) without going through the timeout path.
   */
  private pakePeerShareResolve: ((share: Uint8Array) => void) | null = null;
  /**
   * Rejector paired with {@link pakePeerShareResolve}. Captured so
   * {@link teardownSession} can drive a `PakeError(Cancelled)` into the parked
   * promise. Nulled alongside the resolver on every settle path.
   */
  private pakePeerShareReject: ((err: unknown) => void) | null = null;

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
    const expectedLocalByte = this.pakeSession === null ? null : this.pakeSession.sideByte;
    // CR-2: by the time the share arrives, pakeSession may already be nulled
    // (pakeFinish consumed it) OR the share may race ahead of awaitPakeFinish
    // but land after verifyPeerAndComplete recorded our local side byte. Fall
    // back to pakeLocalSideByte so we still validate the peer's role byte in
    // both windows — mirrors handlePakeConfirm's fallback below.
    const localSide = expectedLocalByte ?? this.pakeLocalSideByte;
    if (localSide !== null) {
      const expectedPeerByte = localSide === PAKE_ROLE_A ? PAKE_ROLE_B : PAKE_ROLE_A;
      if (role !== expectedPeerByte) {
        throw new PakeError(
          PakeErrorCode.Abort,
          `peer SPAKE2 side 0x${role.toString(16)} is not complementary to local side 0x${localSide.toString(16)}`,
        );
      }
    }
    if (this.peerPakeShare !== null) {
      throw new PakeError(PakeErrorCode.Abort, "duplicate peer SPAKE2 share");
    }
    this.peerPakeShare = share;
    const resolve = this.pakePeerShareResolve;
    // Clear both the resolver and its paired rejector; the await is settling
    // normally, so any pending timeout/teardown callback must find null and no-op.
    this.pakePeerShareResolve = null;
    this.pakePeerShareReject = null;
    resolve?.(share);
  }

  /**
   * Block until the peer's SPAKE2 share arrives, then run `pakeFinish` to
   * derive the shared secret. Throws a {@link PakeError} on any failure; the
   * caller ({@link verifyPeerAndComplete}) propagates it to `failHandshake`.
   *
   * The await is bounded by {@link HANDSHAKE_TIMEOUT_MS}: a silent peer that
   * never delivers its share cannot park this coroutine (and the session) in
   * `Verifying` forever. On timeout a `PakeError(Timeout)` is thrown via the
   * resolver so the rejection propagates through `verifyPeerAndComplete` →
   * `failHandshake` → `Disconnected`. The timer is cleared on every exit path
   * (normal delivery, timeout, or {@link teardownSession} rejecting the parked
   * resolver) so no dangling callback ever fires into a settled promise.
   */
  private async awaitPakeFinish(): Promise<Uint8Array> {
    const session = this.pakeSession;
    if (session === null) {
      throw new PakeError(PakeErrorCode.Abort, "awaitPakeFinish: no PAKE session");
    }
    let peerShare = this.peerPakeShare;
    if (peerShare === null) {
      peerShare = await this.awaitPakeShareBounded();
    }
    this.peerPakeShare = null;
    const secret = await pakeFinish(session, peerShare);
    this.pakeSession = null;
    return secret;
  }

  /**
   * Race the peer-share promise against {@link HANDSHAKE_TIMEOUT_MS}. Resolves
   * with the peer's share when {@link handlePakeShare} lands it, or rejects
   * with `PakeError(Timeout)` when the timer fires first. The timer is cleared
   * on both paths. Double-settle-safe: {@link handlePakeShare} and
   * {@link teardownSession} both null the resolver before acting, so a late
   * timer callback (cleared but racing the clear) finds `null` and is a no-op.
   */
  private awaitPakeShareBounded(): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      // Capture the reject so the timeout / teardown can drive it. The
      // resolve/reject pair is only ever called once: the first of {share
      // delivery, timeout, teardown} to reach the resolver wins; the resolver
      // AND its paired rejector are nulled by all three paths before acting,
      // so a racing late callback finds null and no-ops.
      this.pakePeerShareResolve = (share: Uint8Array): void => {
        if (this.pakeShareTimeoutHandle !== null) {
          clearTimeout(this.pakeShareTimeoutHandle);
          this.pakeShareTimeoutHandle = null;
        }
        this.pakePeerShareReject = null;
        resolve(share);
      };
      this.pakePeerShareReject = reject;
      this.pakeShareTimeoutHandle = setTimeout(() => {
        this.pakeShareTimeoutHandle = null;
        // Only reject if OUR resolver is still the parked one. If the share
        // arrived first, handlePakeShare already nulled the field and we no-op.
        if (this.pakePeerShareResolve !== null) {
          this.pakePeerShareResolve = null;
          this.pakePeerShareReject = null;
          reject(
            new PakeError(
              PakeErrorCode.Timeout,
              `awaitPakeFinish timed out after ${this.handshakeTimeoutMs}ms with no peer share`,
            ),
          );
        }
      }, this.handshakeTimeoutMs);
    });
  }

  /**
   * Run the PAKE confirmation exchange. Computes the local role-bound
   * confirmation tag over the transcript hash, sends it, awaits the peer's
   * tag, and verifies it equals the locally-computed peer-role tag. A mismatch
   * proves a wrong-code attack (the SPAKE2 secrets diverged) and the handshake
   * aborts with {@link PakeErrorCode.Mismatch} — there is no path to Connected.
   *
   * R2/F2 (generation-guarded): `generation` is the caller's captured handshake
   * generation. The pre-park crypto awaits (the transcript-hash sha256 + the
   * local tag derivation) are NOT rejected by teardownSession, so a leave()
   * landing inside them resumes this coroutine on a torn-down orchestrator.
   * Without the re-checks below it would send the confirm on a dead (or, after
   * a re-attach, FOREIGN) transport and then park in awaitPakeConfirmBounded —
   * installing pakeConfirmResolve/pakeConfirmReject + the handshake-timeout
   * timer on the CURRENT (possibly fresh) session. The timer's Timeout
   * rejection later reaches failHandshake as a spurious onError long after the
   * teardown, can tear down a FRESH re-attached session, and its callback
   * nulls the fresh session's resolver fields. Both re-checks bail SILENTLY
   * (return, no state change), mirroring the share-path guards above.
   */
  private async runPakeConfirmation(
    pakeSecret: Uint8Array,
    localRole: Role,
    generation: number,
  ): Promise<void> {
    // R2/F2 entry bail — before the transcript invariant below: a torn-down
    // session has a null transcript, and throwing Abort there would surface a
    // spurious post-teardown onError instead of the required silent bail.
    if (this.handshakeSuperseded(generation)) return;
    if (this.transcript === null) {
      throw new PakeError(PakeErrorCode.Abort, "runPakeConfirmation: no transcript");
    }
    const transcriptHash = await sha256(encodeTranscript(this.transcript));
    const localTag = await derivePakeConfirmationTag(pakeSecret, transcriptHash, localRole);
    // R2/F2 re-check after the pre-park crypto awaits — LOAD-BEARING position:
    // this must land BEFORE the outbound confirm is sent and BEFORE
    // awaitPakeConfirmBounded installs pakeConfirmResolve/pakeConfirmReject and
    // arms pakeConfirmTimeoutHandle. A stale install is never torn down by the
    // teardown that already ran, so its timer fires into failHandshake later.
    if (this.handshakeSuperseded(generation)) return;
    const localSideByte = localRole === Role.Initiator ? PAKE_ROLE_A : PAKE_ROLE_B;
    this.transport?.send(encodePakeConfirm(localSideByte, localTag));
    // Await the peer's confirmation tag, bounded by HANDSHAKE_TIMEOUT_MS so a
    // silent peer cannot hold the session in Verifying forever after the share
    // exchange completed. Same double-settle-safe pattern as awaitPakeShareBounded.
    let peerTag = this.peerPakeConfirm;
    if (peerTag === null) {
      peerTag = await this.awaitPakeConfirmBounded();
    }
    this.peerPakeConfirm = null;
    const peerRole = localRole === Role.Initiator ? Role.Responder : Role.Initiator;
    const expectedPeerTag = await derivePakeConfirmationTag(pakeSecret, transcriptHash, peerRole);
    if (!ctEqual(peerTag, expectedPeerTag)) {
      throw new PakeError(
        PakeErrorCode.Mismatch,
        "PAKE confirmation tag mismatch (wrong code or tampering); aborting handshake",
      );
    }
  }

  /**
   * Race the peer-confirm-tag promise against {@link HANDSHAKE_TIMEOUT_MS}.
   * Mirrors {@link awaitPakeShareBounded}: resolves when {@link handlePakeConfirm}
   * delivers the tag, rejects with `PakeError(Timeout)` on timeout. Timer
   * cleared on every path; double-settle-safe via the null-before-act guard.
   */
  private awaitPakeConfirmBounded(): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      this.pakeConfirmResolve = (tag: Uint8Array): void => {
        if (this.pakeConfirmTimeoutHandle !== null) {
          clearTimeout(this.pakeConfirmTimeoutHandle);
          this.pakeConfirmTimeoutHandle = null;
        }
        this.pakeConfirmReject = null;
        resolve(tag);
      };
      this.pakeConfirmReject = reject;
      this.pakeConfirmTimeoutHandle = setTimeout(() => {
        this.pakeConfirmTimeoutHandle = null;
        if (this.pakeConfirmResolve !== null) {
          this.pakeConfirmResolve = null;
          this.pakeConfirmReject = null;
          reject(
            new PakeError(
              PakeErrorCode.Timeout,
              `runPakeConfirmation timed out after ${this.handshakeTimeoutMs}ms with no peer confirm`,
            ),
          );
        }
      }, this.handshakeTimeoutMs);
    });
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
    const expectedLocalByte = this.pakeSession === null ? null : this.pakeSession.sideByte;
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
    // Clear both the resolver and its paired rejector; the await is settling
    // normally, so any pending timeout/teardown callback must find null and no-op.
    this.pakeConfirmResolve = null;
    this.pakeConfirmReject = null;
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
        // background; teardown proceeds in parallel. SEC-1: ALSO persist to the
        // durable localStorage store so the flag survives a reload; SEC-2:
        // surface genuine storage failures instead of swallowing them.
        void Promise.all([
          this.repository.markAuthFailed(conversationId),
          markAuthFailedDurable(conversationId),
        ]).catch((writeErr: unknown) => {
          this.handlers.onError?.(
            new OrchestratorError(
              OrchestratorErrorCode.DurableStoreWriteFailed,
              "failed to persist auth-failed flag",
              writeErr,
            ),
          );
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
    // LW-12 (Phase 7b): best-effort zeroize of handshake/transient key material
    // BEFORE nulling the references. JS-array zeroing is best-effort — a copy
    // retained by the GC or by the runtime's own buffer management is not
    // reached — but matching the receivedFiles precedent (Phase 4) bounds the
    // lifetime of the live secret bytes to the teardown path rather than
    // leaving them in the heap until GC. Only PER-SESSION transient material is
    // zeroed: the ephemeral ECDH keypair, the per-handshake session ids, the
    // peer's ephemeral public key, and the PAKE exchange artifacts. The
    // IDENTITY public keys are deliberately NOT zeroed — they are long-lived
    // TOFU identities that persist across handshake rounds (resume) and are
    // shared by reference from `this.identity`; zeroizing them in place would
    // corrupt the identity used by the next handshake on this orchestrator.
    // The framing layer's session keys are zeroed by sender/receiver.teardown.
    if (this.ephemeral !== null) {
      this.ephemeral.privateKey.fill(0);
      this.ephemeral.publicKey.fill(0);
    }
    if (this.pakeSession !== null && this.pakeSession.state !== null) {
      this.pakeSession.state.outgoing_share.fill(0);
    }
    if (this.localHello !== null) {
      this.localHello.ephemeralPublicKey.fill(0);
      this.localHello.sessionId.fill(0);
    }
    if (this.remoteHello !== null) {
      this.remoteHello.ephemeralPublicKey.fill(0);
      this.remoteHello.sessionId.fill(0);
    }
    if (this.peerPakeShare !== null) {
      this.peerPakeShare.fill(0);
    }
    if (this.peerPakeConfirm !== null) {
      this.peerPakeConfirm.fill(0);
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
    // Reject any parked PAKE resolvers BEFORE nulling them so the coroutine
    // parked in `verifyPeerAndComplete` (awaiting `awaitPakeFinish` /
    // `runPakeConfirmation`) actually settles instead of leaking when the
    // session is torn out from under it. The `Cancelled` code distinguishes a
    // teardown-driven rejection from a genuine `Timeout`.
    //
    // Clear the timeout timers FIRST so a pending timer callback cannot race
    // the rejection we're about to raise and double-settle the promise. After
    // clearing, only one path can settle each parked promise: this rejection.
    if (this.pakeShareTimeoutHandle !== null) {
      clearTimeout(this.pakeShareTimeoutHandle);
      this.pakeShareTimeoutHandle = null;
    }
    if (this.pakeConfirmTimeoutHandle !== null) {
      clearTimeout(this.pakeConfirmTimeoutHandle);
      this.pakeConfirmTimeoutHandle = null;
    }
    if (this.pakePeerShareReject !== null) {
      this.pakePeerShareResolve = null;
      const reject = this.pakePeerShareReject;
      this.pakePeerShareReject = null;
      reject(new PakeError(PakeErrorCode.Cancelled, "PAKE await cancelled: session torn down"));
    } else {
      this.pakePeerShareResolve = null;
    }
    if (this.pakeConfirmReject !== null) {
      this.pakeConfirmResolve = null;
      const reject = this.pakeConfirmReject;
      this.pakeConfirmReject = null;
      reject(new PakeError(PakeErrorCode.Cancelled, "PAKE await cancelled: session torn down"));
    } else {
      this.pakeConfirmResolve = null;
    }
    this.pakeLocalSideByte = null;
    // CR-15: clear the test-only send-key mirror so a stale key never leaks
    // across a session boundary. Production code never reads this field.
    this.derivedSendKeyForTest = null;
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
      role: deriveGlareRole(this.identity.publicKey),
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

/**
 * R7/F3: classify a handshake error as a durable auth failure. An
 * {@link OrchestratorErrorCode.IdentityChanged} or a genuine cryptographic
 * {@link PakeError} indicates the peer's identity did not verify (either the
 * TOFU key changed or the PAKE confirmation tag mismatched). Per the PRD TOFU
 * clause, recovery requires a fresh invitation; the orchestrator durably
 * records the flag so retry() can block the caller from re-attempting on the
 * same conversation.
 *
 * H1: `PakeErrorCode.Cancelled` and `PakeErrorCode.Timeout` are NOT auth
 * failures — `Cancelled` is raised when a user-driven `leave()`/teardown
 * rejects a parked PAKE await, and `Timeout` is an operational silent-peer
 * condition. Treating either as durable would brick the conversation: a
 * teardown during a parked await would set the durable flag and subsequent
 * retry() calls would throw `AuthFailedRetryBlocked` across reloads. Only
 * `Mismatch`, `InvalidShare`, and `Abort` are cryptographic auth failures.
 */
function isAuthFailureError(err: unknown): boolean {
  if (err instanceof OrchestratorError && err.code === OrchestratorErrorCode.IdentityChanged) {
    return true;
  }
  if (err instanceof PakeError) {
    return err.code !== PakeErrorCode.Cancelled && err.code !== PakeErrorCode.Timeout;
  }
  return false;
}

function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out);
  return out;
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
