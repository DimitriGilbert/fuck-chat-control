import { formatMessage, parseMessage } from "../broker/protocol";
import type { BrokerMessage } from "../broker/protocol";
import { isValidRoomId } from "../broker/room-registry";
import type { Role } from "../protocol/types";
import { GlareResolver, isPolite } from "./state-machine";

export interface SignalingSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  set onopen(value: (() => void) | null);
  set onmessage(value: ((event: { readonly data: string }) => void) | null);
  set onclose(value: (() => void) | null);
  set onerror(value: (() => void) | null);
}

export type SignalingSocketFactory = (url: string) => SignalingSocket;

const READY_OPEN = 1;
const READY_CLOSED = 3;

export interface SignalingHandlers {
  readonly onPeerJoin?: () => void;
  readonly onPeerLeave?: () => void;
  readonly onOffer?: (sdp: unknown) => void;
  readonly onAnswer?: (sdp: unknown) => void;
  readonly onIce?: (candidate: unknown) => void;
  readonly onClose?: () => void;
  readonly onError?: (error: unknown) => void;
}

export interface SignalingClientOptions {
  readonly brokerUrl: string;
  readonly roomId: string;
  readonly role: Role;
  readonly handlers: SignalingHandlers;
  readonly socketFactory: SignalingSocketFactory;
}

export class SignalingClient {
  private readonly brokerUrl: string;
  private readonly roomId: string;
  private readonly role: Role;
  private readonly handlers: SignalingHandlers;
  private readonly socketFactory: SignalingSocketFactory;
  private readonly glare: GlareResolver;
  private socket: SignalingSocket | null = null;
  private joined = false;
  private peerPresent = false;

  public constructor(options: SignalingClientOptions) {
    if (!isValidRoomId(options.roomId)) {
      throw new Error("Invalid room id");
    }
    this.brokerUrl = options.brokerUrl;
    this.roomId = options.roomId;
    this.role = options.role;
    this.handlers = options.handlers;
    this.socketFactory = options.socketFactory;
    this.glare = new GlareResolver(options.role);
  }

  public connect(): void {
    if (this.socket !== null) {
      throw new Error("Signaling client already connected");
    }
    const socket = this.socketFactory(this.brokerUrl);
    socket.onopen = () => {
      this.handleOpen();
    };
    socket.onmessage = (event) => {
      this.handleMessage(event.data);
    };
    socket.onclose = () => {
      this.handleClose();
    };
    socket.onerror = () => {
      this.handlers.onError?.(new Error("Signaling socket error"));
    };
    this.socket = socket;
    if (socket.readyState === READY_OPEN) {
      this.handleOpen();
    }
  }

  public sendOffer(sdp: unknown): void {
    this.glare.beginOffer();
    this.relay({ kind: "offer", sdp });
  }

  public endOffer(): void {
    this.glare.endOffer();
  }

  public sendAnswer(sdp: unknown): void {
    this.relay({ kind: "answer", sdp });
  }

  public sendIce(candidate: unknown): void {
    this.relay({ kind: "ice", candidate });
  }

  public isPolite(): boolean {
    return isPolite(this.role);
  }

  public resolveRemoteOffer(): "answer" | "ignore" {
    return this.glare.onRemoteOffer();
  }

  public isPeerPresent(): boolean {
    return this.peerPresent;
  }

  public signalP2pOpen(): void {
    if (this.socket !== null && this.joined) {
      this.relay({ kind: "leave", roomId: this.roomId });
    }
    this.teardown();
  }

  public close(): void {
    this.teardown();
  }

  private handleOpen(): void {
    this.joined = true;
    this.relay({ kind: "join", roomId: this.roomId });
  }

  private handleMessage(raw: string): void {
    const message = parseMessage(raw);
    if (message === null) {
      return;
    }
    // The broker forwards a `join` notification to the existing peer when a
    // second peer enters the room. Treat that as peer presence so the WebRTC
    // bridge initiates the offer. (A `join` reflected back to its own sender
    // is ignored: the sender's own socket is never returned by getPeer.)
    if (!this.peerPresent && message.kind === "join") {
      this.peerPresent = true;
      this.handlers.onPeerJoin?.();
      return;
    }
    // The broker forwards a `leave` notification to the remaining peer when
    // the other drops (explicit leave or socket close). Treat that as a
    // peer-drop so the UI surfaces Disconnected + retry without waiting for
    // ICE to time out.
    if (message.kind === "leave") {
      if (this.peerPresent) {
        this.peerPresent = false;
        this.handlers.onPeerLeave?.();
      }
      return;
    }
    // R6/F7: auto-promotion narrows the legacy "any peer-originated frame flips
    // peerPresent" to "only a handshake initiation (offer/answer) flips it".
    // ICE arriving without a prior offer/answer is suspicious — likely a third
    // party injecting noise — so a pure-ICE frame from an unknown peer is
    // ignored rather than promoting the sender to present. The join-reflection
    // promotion above (line 140) still fires first and is unaffected.
    if (!this.peerPresent && isHandshakeInitiation(message)) {
      this.peerPresent = true;
      this.handlers.onPeerJoin?.();
    }
    switch (message.kind) {
      case "offer":
        this.handlers.onOffer?.(message.sdp);
        break;
      case "answer":
        this.handlers.onAnswer?.(message.sdp);
        break;
      case "ice":
        this.handlers.onIce?.(message.candidate);
        break;
      default:
        break;
    }
  }

  private handleClose(): void {
    const wasPeerPresent = this.peerPresent;
    this.joined = false;
    this.peerPresent = false;
    this.socket = null;
    if (wasPeerPresent) {
      this.handlers.onPeerLeave?.();
    }
    this.handlers.onClose?.();
  }

  private teardown(): void {
    const socket = this.socket;
    this.socket = null;
    this.joined = false;
    this.peerPresent = false;
    if (socket !== null && socket.readyState !== READY_CLOSED) {
      socket.close(1000, "client closing");
    }
  }

  private relay(message: BrokerMessage): void {
    const socket = this.socket;
    if (socket === null || socket.readyState !== READY_OPEN) {
      this.handlers.onError?.(new Error("Signaling socket is not open"));
      return;
    }
    socket.send(formatMessage(message));
  }
}

/**
 * A handshake initiation is an offer or answer — the SDP exchange that proves
 * the peer intends to establish a session. ICE candidates may legitimately
 * arrive before the answer completes (trickle ICE), but a *pure-ICE* frame
 * with no prior offer/answer from this peer is treated as suspect (R6/F7) and
 * does NOT auto-promote `peerPresent`. Kept distinct from a generic "peer
 * originated" predicate so future relay-side gating can apply different rules
 * to ICE vs SDP if needed.
 */
function isHandshakeInitiation(message: BrokerMessage): boolean {
  return message.kind === "offer" || message.kind === "answer";
}
