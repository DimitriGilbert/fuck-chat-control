import { defineWebSocketHandler } from "nitro";

import { BrokerConnection } from "../features/chat/broker/connection";
import type { BrokerSocket } from "../features/chat/broker/room-registry";
import { RoomRegistry } from "../features/chat/broker/room-registry";

const registry = new RoomRegistry();
const connections = new Map<string, BrokerConnection>();

function wrapPeer(peer: CrosswsPeer): BrokerSocket {
  return {
    send(data) {
      peer.send(data);
    },
    close(code, reason) {
      peer.close(code, reason);
    },
  };
}

interface CrosswsPeer {
  readonly id: string;
  send(data: unknown): unknown;
  close(code?: number, reason?: string): void;
}

export default defineWebSocketHandler({
  open(peer) {
    const socket = wrapPeer(peer);
    connections.set(peer.id, new BrokerConnection(socket, registry));
  },
  message(peer, message) {
    connections.get(peer.id)?.onMessage(message.text());
  },
  close(peer) {
    cleanup(peer.id);
  },
  error(peer) {
    cleanup(peer.id);
  },
});

function cleanup(id: string): void {
  const connection = connections.get(id);
  if (connection === undefined) {
    return;
  }
  connection.onClose();
  connections.delete(id);
}
