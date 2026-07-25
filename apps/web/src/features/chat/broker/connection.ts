import { formatMessage, forward, parseMessage } from "./protocol";
import type { BrokerMessage } from "./protocol";
import type { BrokerSocket } from "./room-registry";
import { RoomRegistry } from "./room-registry";

export class BrokerConnection {
  private readonly socket: BrokerSocket;
  private readonly registry: RoomRegistry;
  private roomId: string | null = null;

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
        this.handleJoin(message.roomId);
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
    this.registry.removeSocket(this.socket);
    this.roomId = null;
  }

  private handleJoin(roomId: string): void {
    if (this.roomId !== null) {
      this.registry.leave(this.roomId, this.socket);
      this.roomId = null;
    }
    const result = this.registry.join(roomId, this.socket);
    if (!result.joined) {
      return;
    }
    this.roomId = roomId;
    // When this socket is the SECOND peer in the room, notify the first peer
    // that a peer has joined. Without this notification neither side knows to
    // begin the WebRTC offer/answer exchange — the broker only relays SDP/ICE
    // between peers, and the initiator offers in response to peer-join.
    if (result.isSecondPeer) {
      const peer = this.registry.getPeer(roomId, this.socket);
      if (peer !== null) {
        // Direct send (not relay): `forward` filters to relayable kinds and
        // would drop a join notification. The recipient's signaling client
        // treats an inbound join as peer presence.
        peer.send(formatMessage({ kind: "join", roomId }));
      }
    }
  }

  private handleLeave(): void {
    if (this.roomId === null) {
      return;
    }
    // An explicit `leave` broker message is the path the bridge uses for
    // `signalP2pOpen` (drop the broker from the data path once the p2p channel
    // is carrying bytes). Do NOT notify the remaining peer here — the bridge's
    // signaling client treats an inbound `leave` as a peer-drop, which is the
    // opposite of what signalP2pOpen means. The socket-close path (onClose)
    // handles real drops; the bridge additionally suppresses leave events while
    // its own data channel is still open (see WebRtcBridge.onPeerLeave).
    this.registry.leave(this.roomId, this.socket);
    this.roomId = null;
  }

  /**
   * Tell the remaining peer (if any) that this connection has left the room.
   * The signaling client treats an inbound `leave` as a peer-drop so the UI
   * can surface Disconnected + Retry. Without this the remaining peer would
   * only learn of the drop when ICE times out (potentially tens of seconds).
   */
  private notifyPeerLeft(): void {
    if (this.roomId === null) return;
    const peer = this.registry.getPeer(this.roomId, this.socket);
    if (peer === null) return;
    peer.send(formatMessage({ kind: "leave", roomId: this.roomId }));
  }

  private relay(message: BrokerMessage): void {
    if (this.roomId === null) {
      return;
    }
    const peer = this.registry.getPeer(this.roomId, this.socket);
    if (peer === null) {
      return;
    }
    forward(peer, message);
  }
}
