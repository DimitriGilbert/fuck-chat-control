import { defineWebSocketHandler } from "nitro";

import { BrokerConnection } from "../features/chat/broker/connection";
import type { BrokerSocket } from "../features/chat/broker/room-registry";
import { RoomRegistry } from "../features/chat/broker/room-registry";
import { startZombieSweep } from "../features/chat/broker/sweep";

// Single shared registry + connection bookkeeping for the lifetime of the
// process. crossws hands us a `Peer` per event with a stable `id`, so we key
// the BrokerConnection by that id; the BrokerSocket wrapper is what the sweep
// inspects, so we keep a parallel id → socket map for the sweep to iterate.
const registry = new RoomRegistry();
const connections = new Map<string, BrokerConnection>();
const sockets = new Map<string, BrokerSocket>();

// R5/F2: defense-in-depth. The runtime's `close`/`error` hooks fire
// asynchronously (and not at all for some half-open conditions), so a socket
// can stick in the registry at readyState CLOSING/CLOSED until the OS reaps
// the TCP connection. The sweep polls every 60s and routes each zombie through
// the same cleanup path as a clean close, so the partner receives a `leave`
// instead of waiting for ICE to time out.
startZombieSweep(
  () => sockets.values(),
  (socket) => {
    // Find the peer.id for this socket, then run the standard cleanup path so
    // the partner gets a `leave` notification via BrokerConnection.onClose.
    for (const [id, registered] of sockets) {
      if (registered === socket) {
        cleanup(id);
        break;
      }
    }
  },
);

/**
 * Structural view of the crossws `Peer` shape this handler consumes.
 *
 * crossws exposes the underlying WebSocket as `peer.websocket: Partial<WebSocket>`,
 * so every property — including `readyState` — is `T | undefined`. The sweep +
 * {@link wrapPeer} guard on `typeof ws.readyState === "number"` before reading
 * it, falling back to OPEN (1) when the proxy is missing; declaring the field
 * as `number | undefined` here mirrors upstream and avoids an `as` cast at the
 * call site. Kept local so the broker module owns its adapter coupling.
 */
interface CrosswsPeer {
  readonly id: string;
  readonly websocket: { readonly readyState?: number } | null;
  send(data: unknown): unknown;
  close(code?: number, reason?: string): void;
}

function wrapPeer(peer: CrosswsPeer): BrokerSocket {
  return {
    get readyState() {
      // crossws exposes the underlying WebSocket as `peer.websocket`. Its
      // readyState follows the standard 0/1/2/3 enum. Falling back to OPEN (1)
      // when the proxy is missing keeps a misconfigured runtime from mass-
      // evicting healthy sockets.
      const ws = peer.websocket;
      if (ws !== null && typeof ws.readyState === "number") {
        return ws.readyState;
      }
      return 1;
    },
    send(data) {
      peer.send(data);
    },
    close(code, reason) {
      peer.close(code, reason);
    },
  };
}

export default defineWebSocketHandler({
  open(peer) {
    const socket = wrapPeer(peer);
    sockets.set(peer.id, socket);
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
  sockets.delete(id);
}
