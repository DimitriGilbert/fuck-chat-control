import {
  computeSafetyNumber,
  deriveSessionKeys,
  generateEphemeralKeyPair,
  generateIdentityKeyPair,
  signTranscript,
  verifyTranscript,
} from "@/features/chat/crypto";
import type { EphemeralKeyPair, IdentityKeyPair } from "@/features/chat/crypto";
import { encodeSessionId } from "@/features/chat/protocol/codec";
import { PROTOCOL_VERSION } from "@/features/chat/protocol/limits";
import { AuthMode, ControlSubtype, Role } from "@/features/chat/protocol/types";
import type { ConversationId, Signature, Transcript } from "@/features/chat/protocol/types";
import { FrameReceiver } from "@/features/chat/framing";
import { FrameSender } from "@/features/chat/framing";
import type { FrameTransport } from "@/features/chat/framing";
import { ConnectionState } from "@/features/chat/signaling/state-machine";
import { SignalingClient } from "@/features/chat/signaling/signaling-client";
import type { SignalingSocketFactory } from "@/features/chat/signaling/signaling-client";
import type { ConversationMessage, ConversationRepository } from "@/features/chat/store";
import { MessageDirection } from "@/features/chat/store";

import { OrchestratorError, OrchestratorErrorCode } from "./errors";
import {
  buildTranscript,
  decodeHello,
  decodeSignatureMessage,
  encodeHello,
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

const HANDSHAKE_AUTH_MODE = AuthMode.SafetyNumberOnly;
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

  // Connected session state.
  private frameSender: FrameSender | null = null;
  private frameReceiver: FrameReceiver | null = null;
  private safetyNumberValue: string | null = null;
  private safetyNumberVerified = false;

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
    // Accept either a full invitation link (`https://host#<hex>`) or a bare
    // fragment (`#<hex>` / `<hex>`). Everything before the last `#` is the
    // URL prefix the initiator wrapped around the conversation id.
    const hashIndex = fragment.lastIndexOf("#");
    const bare = hashIndex >= 0 ? fragment.slice(hashIndex + 1) : fragment;
    const parsed = parseInvitation(bare.startsWith("#") ? bare : `#${bare}`);
    this.conversation = parsed.conversationId;
    await this.repository.createConversation(parsed.conversationId, Date.now());
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
   * Disconnected).
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
   */
  notifyPeerLeft(): void {
    if (this.currentState !== ConnectionState.Disconnected) {
      this.teardownSession();
      this.setState(ConnectionState.Disconnected);
    }
  }

  /**
   * External signaling seam: the bridge's signaling socket closed (peer drop or
   * broker restart). Behaves like notifyPeerLeft.
   */
  notifySignalingClosed(): void {
    if (this.currentState !== ConnectionState.Disconnected) {
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
    const ephemeral = await generateEphemeralKeyPair();
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
    if (this.currentState !== ConnectionState.Handshaking) {
      // Ignore stray bytes after teardown.
      return;
    }
    if (bytes.length === HELLO_BYTES) {
      const hello = decodeHello(bytes);
      this.remoteHello = hello;
      await this.maybeSignAndSend();
      await this.maybeCompleteHandshake();
      return;
    }
    if (bytes.length === SIGNATURE_MESSAGE_BYTES) {
      const signature = decodeSignatureMessage(bytes);
      await this.verifyPeerAndComplete(signature);
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
      authMode: HANDSHAKE_AUTH_MODE,
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
    // Derive session keys.
    const sessionKeys = await deriveSessionKeys({
      localEcdhPrivateKey: this.ephemeral.privateKey,
      peerEcdhPublicKey: remoteEphemeralKey,
      transcript: this.transcript,
      localIdentityPublicKey: this.identity.publicKey,
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
    });
    const receiver = new FrameReceiver({
      sessionKeys,
      peerSessionId: remoteSessionId,
      onText: (plaintext: Uint8Array): void => {
        void this.handleReceivedText(plaintext);
      },
      onControl: (): void => {
        // Control frames are not part of slice 3b's surface area.
      },
      onFileComplete: (): void => {
        // Files are not part of slice 3b's surface area.
      },
    });
    this.frameSender = sender;
    this.frameReceiver = receiver;

    this.setState(ConnectionState.Connected);
    this.handlers.onSafetyNumber?.(safetyNumber, this.safetyNumberVerified);
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
    this.handlers.onError?.(err);
    this.teardownSession();
    // Stay in Handshaking/Disconnected — do NOT reach Connected.
    if (
      this.currentState === ConnectionState.Handshaking ||
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
    // safetyNumberValue is kept so callers can still read it after leave().
  }

  private setState(next: ConnectionState): void {
    this.currentState = next;
    this.handlers.onStateChange?.(next);
  }

  /**
   * Construct (or reconstruct) the {@link SignalingClient} and join the broker
   * room for the current conversation. The signaling layer drives the broker
   * join/leave and SDP/ICE relay; it does NOT carry application bytes.
   *
   * The signaling role affects only glare resolution (which side keeps its
   * SDP offer when both peers offer simultaneously). For first contact the
   * peer identity is unknown at this point, so we cannot call
   * {@link deriveRole}; we default to {@link Role.Initiator}. Glare-correct
   * behavior is established once WebRTC is wired and the peer's identity is
   * known; this slice wires signaling plumbing, not the WebRTC offer/answer
   * flow. The authoritative TOFU comparison in {@link verifyPeerAndComplete}
   * uses the async repo API and is unaffected.
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
      role: Role.Initiator,
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
          // Disconnected so the UI can surface the drop and offer retry.
          if (this.currentState !== ConnectionState.Disconnected) {
            this.teardownSession();
            this.setState(ConnectionState.Disconnected);
          }
        },
        onClose: () => {
          // Socket closed without a peer-leave (e.g. broker restart). Surface
          // as a drop unless we already tore down.
          if (this.currentState !== ConnectionState.Disconnected) {
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
