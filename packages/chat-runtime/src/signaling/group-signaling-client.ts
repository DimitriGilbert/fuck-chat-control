import { formatMessage, parseMessage } from "../broker/protocol";
import type { BrokerMessage } from "../broker/protocol";
import { isValidPeerId, isValidRoomId } from "../broker/room-registry";
import type { SignalingSocket, SignalingSocketFactory } from "./signaling-client";

const READY_OPEN = 1;
const READY_CLOSED = 3;

/**
 * Per-peer handler surface for {@link GroupSignalingClient}. Every callback
 * that names a peer carries the `peerId` the broker used to address that
 * member's seat — an ephemeral signaling label (protocol-v2-group §1), never
 * a cryptographic identity.
 */
export interface GroupSignalingHandlers {
  readonly onPeerJoin?: (peerId: string) => void;
  readonly onPeerLeave?: (peerId: string) => void;
  readonly onOffer?: (fromPeerId: string, sdp: unknown) => void;
  readonly onAnswer?: (fromPeerId: string, sdp: unknown) => void;
  readonly onIce?: (fromPeerId: string, candidate: unknown) => void;
  readonly onClose?: () => void;
  readonly onError?: (error: unknown) => void;
}

export interface GroupSignalingClientOptions {
  readonly brokerUrl: string;
  readonly roomId: string;
  readonly handlers: GroupSignalingHandlers;
  readonly socketFactory: SignalingSocketFactory;
}

/**
 * Group-room signaling client (protocol-v2-group §2). One instance per group:
 * it holds ONE seat in the broker room for the life of the group — unlike the
 * 1:1 {@link SignalingClient}, members do NOT vacate the room when their data
 * channels open, so late joiners can be admitted and dropped links can
 * re-signal — and multiplexes per-peer presence over that single socket.
 *
 * There is no glare resolver here on purpose: only already-seated members
 * offer, always to the newcomer (§2.1), so the offer/answer direction is
 * deterministic and simultaneous offers between the same pair cannot occur.
 *
 * Presence is a peerId-keyed set. Seated members learn of newcomers from the
 * broker's `{t:"join", roomId, peerId}` notification; the newcomer learns of
 * seated members only when their addressed offers arrive (the broker never
 * echoes the roster), so a first handshake initiation from an unknown peerId
 * promotes that peer to present — the same auto-promotion rule the 1:1 client
 * applies to `peerPresent`.
 */
export class GroupSignalingClient {
  private readonly brokerUrl: string;
  private readonly roomId: string;
  private readonly handlers: GroupSignalingHandlers;
  private readonly socketFactory: SignalingSocketFactory;
  private socket: SignalingSocket | null = null;
  /** Our own seat label for this connection; set by {@link connect}. */
  private peerId: string | null = null;
  private joined = false;
  private readonly present = new Set<string>();

  public constructor(options: GroupSignalingClientOptions) {
    if (!isValidRoomId(options.roomId)) {
      throw new Error("Invalid room id");
    }
    this.brokerUrl = options.brokerUrl;
    this.roomId = options.roomId;
    this.handlers = options.handlers;
    this.socketFactory = options.socketFactory;
  }

  /**
   * Open the broker socket and, once open, seat this member with
   * `{t:"join", roomId, mode:"group", peerId}`. `peerId` is client-chosen per
   * join (§1) and validated to the wire shape (16 lowercase hex chars).
   */
  public connect(peerId: string): void {
    if (this.socket !== null) {
      throw new Error("Group signaling client already connected");
    }
    if (!isValidPeerId(peerId)) {
      throw new Error("Invalid peer id");
    }
    this.peerId = peerId;
    const socket = this.socketFactory(this.brokerUrl);
    // Every handler is bound to the socket instance it serves (same guard as
    // the 1:1 client): teardown()/handleClose() update `this.socket`
    // synchronously, so a late event from a deliberately replaced socket —
    // the bridge's reconnect path — fires after `this.socket` already points
    // elsewhere and is skipped. Without the identity check a real (async)
    // WebSocket's late close could surface as onClose for the NEW connection.
    const isCurrent = (): boolean => this.socket === socket;
    socket.onopen = () => {
      if (isCurrent()) this.handleOpen();
    };
    socket.onmessage = (event) => {
      if (isCurrent()) this.handleMessage(event.data);
    };
    socket.onclose = () => {
      if (isCurrent()) this.handleClose();
    };
    socket.onerror = () => {
      if (isCurrent()) {
        this.handlers.onError?.(new Error("Signaling socket error"));
      }
    };
    this.socket = socket;
    if (socket.readyState === READY_OPEN) {
      this.handleOpen();
    }
  }

  public sendOffer(toPeerId: string, sdp: unknown): void {
    if (!isValidPeerId(toPeerId)) {
      throw new Error("Invalid peer id");
    }
    this.relay({ kind: "offer", to: toPeerId, sdp });
  }

  public sendAnswer(toPeerId: string, sdp: unknown): void {
    if (!isValidPeerId(toPeerId)) {
      throw new Error("Invalid peer id");
    }
    this.relay({ kind: "answer", to: toPeerId, sdp });
  }

  public sendIce(toPeerId: string, candidate: unknown): void {
    if (!isValidPeerId(toPeerId)) {
      throw new Error("Invalid peer id");
    }
    this.relay({ kind: "ice", to: toPeerId, candidate });
  }

  public isPeerPresent(peerId: string): boolean {
    return this.present.has(peerId);
  }

  /** Snapshot of the currently-present member peerIds. */
  public presentPeers(): string[] {
    return [...this.present];
  }

  /**
   * Relay a `leave` for the room (when seated) and tear the socket down. A
   * group member leaving the room is a real departure — seats persist for
   * the life of the group (§2.2) — so unlike the 1:1 client's post-handshake
   * teardown, the deliberate close fires `onClose` through the normal path.
   */
  public leaveAndClose(): void {
    if (this.socket !== null && this.joined) {
      this.relay({ kind: "leave", roomId: this.roomId });
    }
    this.teardown();
  }

  public close(): void {
    // A group member has no P2P-open teardown path: the only deliberate close
    // is leaving the room, so close() always relays `leave` first.
    this.leaveAndClose();
  }

  private handleOpen(): void {
    this.joined = true;
    // peerId is set by connect() before the socket exists, so it is always
    // present by the time any open event can fire.
    if (this.peerId === null) {
      return;
    }
    this.relay({ kind: "join", roomId: this.roomId, mode: "group", peerId: this.peerId });
  }

  private handleMessage(raw: string): void {
    const message = parseMessage(raw);
    if (message === null) {
      return;
    }
    // Broker→client join notification (§2.1): names the member that just
    // seated. Fires on EVERY arrival — a join for an already-present peerId
    // can only mean seat turnover (a dropped socket re-seated under the same
    // label), the same reasoning as the 1:1 client's fresh-presence edge. The
    // broker never notifies the joiner about itself; an own-peerId echo and
    // legacy pair-mode joins (no peerId) are ignored.
    if (message.kind === "join") {
      const peerId = message.peerId;
      if (peerId === undefined || peerId === this.peerId || message.roomId !== this.roomId) {
        return;
      }
      this.present.add(peerId);
      this.handlers.onPeerJoin?.(peerId);
      return;
    }
    // Broker→client leave notification (§2.1): names the departing member.
    // Same guard semantics as the 1:1 client — fire onPeerLeave only for a
    // peer that was actually present.
    if (message.kind === "leave") {
      const peerId = message.peerId;
      if (peerId === undefined || peerId === this.peerId || message.roomId !== this.roomId) {
        return;
      }
      if (this.present.delete(peerId)) {
        this.handlers.onPeerLeave?.(peerId);
      }
      return;
    }
    // Relayed SDP/ICE: the broker attaches the sender's peerId as `from`
    // (a client-supplied `from` is never relayed, and a malformed one fails
    // parse). Messages without a usable sender — including unaddressed
    // legacy pair-mode frames — are ignored, as is anything claiming to be
    // from our own seat.
    const from = message.from;
    if (from === undefined || from === this.peerId) {
      return;
    }
    // Auto-promotion, narrowed to handshake initiations like the 1:1 client:
    // the newcomer has no roster (the broker only notifies already-seated
    // members), so a first offer/answer from an unknown peerId is how it
    // learns that member exists. A pure-ICE frame from an unknown peer is
    // still dispatched below but does NOT promote — it cannot prove intent
    // to establish a session on its own.
    if (!this.present.has(from) && isHandshakeInitiation(message)) {
      this.present.add(from);
      this.handlers.onPeerJoin?.(from);
    }
    switch (message.kind) {
      case "offer":
        this.handlers.onOffer?.(from, message.sdp);
        break;
      case "answer":
        this.handlers.onAnswer?.(from, message.sdp);
        break;
      case "ice":
        this.handlers.onIce?.(from, message.candidate);
        break;
      default:
        break;
    }
  }

  private handleClose(): void {
    const departed = [...this.present];
    this.joined = false;
    this.present.clear();
    this.socket = null;
    // Every present peer became unreachable with the socket — surface each as
    // a peer leave so per-link teardown runs, mirroring the 1:1 client's
    // onPeerLeave-on-close semantics.
    for (const peerId of departed) {
      this.handlers.onPeerLeave?.(peerId);
    }
    this.handlers.onClose?.();
  }

  private teardown(): void {
    const socket = this.socket;
    if (socket !== null && socket.readyState !== READY_CLOSED) {
      // Close while the socket is still current so its close event runs
      // handleClose() — presence cleanup and onClose stay on the normal
      // close path rather than a bespoke deliberate-teardown path.
      socket.close(1000, "client closing");
    }
    // A real (async) WebSocket delivers its close event later, and an
    // already-closed socket may never deliver one: run handleClose() now if
    // the socket is still current so state is deterministic. The stale-event
    // guard then makes the late event a no-op, so onClose fires exactly once.
    if (socket !== null && this.socket === socket) {
      this.handleClose();
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
 * a peer intends to establish a session. Pure-ICE frames from unknown peers
 * are suspect (same rule as the 1:1 client) and do not promote presence.
 */
function isHandshakeInitiation(message: BrokerMessage): boolean {
  return message.kind === "offer" || message.kind === "answer";
}
