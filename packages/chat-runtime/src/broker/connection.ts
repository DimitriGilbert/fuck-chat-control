import { BROKER_CLOSE_CODES, BROKER_CLOSE_REASONS, BrokerErrorCode } from "./errors";
import { formatMessage, forward, parseMessage } from "./protocol";
import type { AnswerMessage, IceMessage, JoinMessage, OfferMessage } from "./protocol";
import type { BrokerSocket } from "./room-registry";
import { RoomRegistry } from "./room-registry";

/** Relayable (SDP/ICE) messages — the kinds `forward` will deliver. */
type RelayMessage = OfferMessage | AnswerMessage | IceMessage;

/**
 * Build the broker→client frame for a relayed message. The inbound `to` is
 * stripped (the recipient is already addressed by which socket gets the
 * frame) and a client-supplied `from` is discarded — the broker attaches the
 * authenticated seat's peerId itself, so a sender cannot spoof attribution.
 * Passing `from === undefined` yields exactly the legacy pair-mode wire
 * shape (`{t, sdp}` / `{t, candidate}`).
 */
function relayPayload(message: RelayMessage, from: string | undefined): RelayMessage {
  switch (message.kind) {
    case "offer":
      return from === undefined
        ? { kind: "offer", sdp: message.sdp }
        : { kind: "offer", sdp: message.sdp, from };
    case "answer":
      return from === undefined
        ? { kind: "answer", sdp: message.sdp }
        : { kind: "answer", sdp: message.sdp, from };
    case "ice":
      return from === undefined
        ? { kind: "ice", candidate: message.candidate }
        : { kind: "ice", candidate: message.candidate, from };
  }
}

export class BrokerConnection {
  private readonly socket: BrokerSocket;
  private readonly registry: RoomRegistry;
  private roomId: string | null = null;
  /**
   * This connection's seat label in a group room. `null` for pair rooms and
   * unseated connections — pair rooms have no peerIds — so `peerId !== null`
   * is the group-room discriminator on every relay/leave path.
   */
  private peerId: string | null = null;

  public constructor(socket: BrokerSocket, registry: RoomRegistry) {
    this.socket = socket;
    this.registry = registry;
  }

  public onMessage(raw: string): void {
    const message = parseMessage(raw);
    if (message === null) {
      return;
    }
    switch (message.kind) {
      case "join":
        this.handleJoin(message);
        break;
      case "leave":
        this.handleLeave();
        break;
      case "offer":
      case "answer":
      case "ice":
        this.relay(message);
        break;
    }
  }

  public onClose(): void {
    this.notifyPeerLeft();
    // R3/F4: prefer the O(1) `leave(roomId, socket)` over the O(rooms) scan
    // `removeSocket` does. `roomId` is known for any connection that ever
    // joined, so the scan is wasted work on the close path of every seated
    // connection — an attacker can amplify it by opening many short-lived
    // connections. Fall back to the scan only for a connection that never
    // joined (no roomId), which is the path the registry was designed for
    // (defense-in-depth cleanup of a socket the runtime never delivered a
    // leave for).
    if (this.roomId !== null) {
      this.registry.leave(this.roomId, this.socket);
    } else {
      this.registry.removeSocket(this.socket);
    }
    this.roomId = null;
    this.peerId = null;
  }

  private handleJoin(message: JoinMessage): void {
    // R5/F1: reject a second `join` from a socket that is already seated in a
    // room. The legitimate client always opens a fresh socket per join (the
    // bridge's signaling client tears the socket down on `signalP2pOpen` and
    // re-creates it for the next conversation), so a `join` on an already-seated
    // socket is a non-conforming client. The previous behavior silently
    // `registry.leave`-ed the old room and re-joined, which abandoned the prior
    // partner without a `leave` notification — its `peerPresent` would stick
    // `true` until ICE timed out. Rejecting the join (rather than silently
    // abandoning) preserves the partner's `peerPresent`: the offender is hard-
    // closed, the partner keeps its seat, and the only path forward is a fresh
    // socket. We deliberately do NOT `notifyPeerLeft` here — the planned v2
    // `signalP2pOpen → broker-leave` flow relies on the legitimate silent-leave
    // semantics of `handleLeave`/onClose, and emitting a leave here would
    // double-fire when the offender's socket close later runs onClose.
    if (this.roomId !== null) {
      this.socket.close(
        BROKER_CLOSE_CODES[BrokerErrorCode.AlreadySeated],
        BROKER_CLOSE_REASONS[BrokerErrorCode.AlreadySeated],
      );
      return;
    }
    const result = this.registry.join(message.roomId, this.socket, {
      mode: message.mode,
      peerId: message.peerId,
    });
    if (!result.joined) {
      return;
    }
    this.roomId = message.roomId;
    this.peerId = message.peerId ?? null;
    if (result.mode === "group" && this.peerId !== null) {
      // Group room (protocol-v2-group §2.2): notify EVERY already-seated
      // member that a member joined — this is what tells them to offer to
      // the newcomer (only seated members offer, so glare cannot arise).
      // The joiner itself is not notified; it knows it joined.
      const notification = formatMessage({
        kind: "join",
        roomId: message.roomId,
        peerId: this.peerId,
      });
      for (const { socket: peer } of this.registry.listPeers(message.roomId, this.socket)) {
        peer.send(notification);
      }
      return;
    }
    // When this socket is the SECOND peer in the room, notify the first peer
    // that a peer has joined. Without this notification neither side knows to
    // begin the WebRTC offer/answer exchange — the broker only relays SDP/ICE
    // between peers, and the initiator offers in response to peer-join.
    if (result.isSecondPeer) {
      const peer = this.registry.getPeer(message.roomId, this.socket);
      if (peer !== null) {
        // Direct send (not relay): `forward` filters to relayable kinds and
        // would drop a join notification. The recipient's signaling client
        // treats an inbound join as peer presence.
        peer.send(formatMessage({ kind: "join", roomId: message.roomId }));
      }
    }
  }

  private handleLeave(): void {
    if (this.roomId === null) {
      return;
    }
    // In a group room an explicit `leave` is a real departure (group members
    // stay seated for the life of the group, so leaving means leaving):
    // broadcast the departure to every remaining member. The leaver itself
    // is NOT notified — it knows it left — and `listPeers` excludes this
    // socket, so the notification never echoes back.
    if (this.peerId !== null) {
      this.notifyPeerLeft();
    }
    // For pair rooms an explicit `leave` broker message is the path the
    // bridge uses for `signalP2pOpen` (drop the broker from the data path
    // once the p2p channel is carrying bytes). Do NOT notify the remaining
    // peer here — the bridge's signaling client treats an inbound `leave` as
    // a peer-drop, which is the opposite of what signalP2pOpen means. The
    // socket-close path (onClose) handles real drops; the bridge
    // additionally suppresses leave events while its own data channel is
    // still open (see WebRtcBridge.onPeerLeave).
    this.registry.leave(this.roomId, this.socket);
    this.roomId = null;
    this.peerId = null;
  }

  /**
   * Tell the remaining peer(s) that this connection has left the room.
   * Pair room: a `{t:"leave", roomId}` to the single other seat; the
   * signaling client treats an inbound `leave` as a peer-drop so the UI can
   * surface Disconnected + Retry — without it the remaining peer would only
   * learn of the drop when ICE times out (potentially tens of seconds).
   * Group room: a `{t:"leave", roomId, peerId}` to every remaining member so
   * each can tear down the pairwise link to the departed seat.
   */
  private notifyPeerLeft(): void {
    if (this.roomId === null) return;
    if (this.peerId !== null) {
      const notification = formatMessage({
        kind: "leave",
        roomId: this.roomId,
        peerId: this.peerId,
      });
      for (const { socket: peer } of this.registry.listPeers(this.roomId, this.socket)) {
        peer.send(notification);
      }
      return;
    }
    const peer = this.registry.getPeer(this.roomId, this.socket);
    if (peer === null) return;
    peer.send(formatMessage({ kind: "leave", roomId: this.roomId }));
  }

  private relay(message: RelayMessage): void {
    if (this.roomId === null) {
      return;
    }
    if (this.peerId !== null) {
      // Group room: `to`-addressed relay to one member's seat, with the
      // sender's own peerId attached as `from`. An unaddressed message or a
      // `to` that is not seated is dropped silently — the former is a
      // non-conforming group client, the latter raced a leave (§2.1). A
      // sender addressing its own peerId is likewise dropped.
      if (message.to === undefined) {
        return;
      }
      const peer = this.registry.getPeerById(this.roomId, message.to);
      if (peer === null || peer === this.socket) {
        return;
      }
      forward(peer, relayPayload(message, this.peerId));
      return;
    }
    const peer = this.registry.getPeer(this.roomId, this.socket);
    if (peer === null) {
      return;
    }
    // Pair room: unaddressed relay to the single other seat, byte-identical
    // to v1 — a client-supplied `to`/`from` is stripped rather than relayed.
    forward(peer, relayPayload(message, undefined));
  }
}
