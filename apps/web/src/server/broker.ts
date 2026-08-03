import { defineWebSocketHandler } from "nitro";

import { env } from "@fuck-eu-chat-control/env/server";

import { BrokerConnection } from "@fuck-eu-chat-control/chat-runtime/broker/connection";
import type { BrokerSocket } from "@fuck-eu-chat-control/chat-runtime/broker/room-registry";
import { RoomRegistry } from "@fuck-eu-chat-control/chat-runtime/broker/room-registry";
import { startZombieSweep } from "@fuck-eu-chat-control/chat-runtime/broker/sweep";
import { isOriginAllowed } from "./origin-guard";

/**
 * R3/F2: hard cap on the number of concurrently-open WebSocket connections
 * the broker admits. The broker is the only unauthenticated network surface,
 * so without a cap an attacker can open thousands of idle sockets to exhaust
 * per-process memory and file descriptors. This is a per-process cap (the
 * single shared registry/sockets maps below), so a multi-instance deployment
 * must divide this by the instance count or enforce it at the load balancer.
 * Tunable per-deployment; 2048 is a conservative v1 default well below the
 * typical Node fd soft limit (1024 soft / 4096 hard on Linux) once you reserve
 * headroom for the server's own sockets + the runtime.
 */
export const MAX_CONNECTIONS = 2048;

/**
 * R3/F2: pure decision used by the `open` handler to admit or reject a new
 * WebSocket upgrade. Exported so the cap is unit-testable in isolation
 * (spinning up 2048 real WS upgrades via the integration harness is
 * impractical). Returns `true` when the connection must be REJECTED.
 */
export function shouldRejectConnection(current: number, max: number): boolean {
  return current >= max;
}

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
//
// LW-11: the sweep is keyed by id. crossws hands us a stable `peer.id` per
// connection for the connection's lifetime (the same id `open`/`message`/
// `close`/`error` all receive), so iterating `[id, socket]` pairs and calling
// `cleanup(id)` removes the previous O(n) reverse-lookup scan over the sockets
// map. The id-stability invariant is what makes the keying safe: a socket's id
// never changes while it is registered, so the id observed during the sweep is
// the same id used to register it in `open`.
startZombieSweep(
  () => sockets.entries(),
  (_socket, id) => {
    cleanup(id);
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
  // CR-16: crossws exposes the upgrade `Request` so the origin guard can read
  // the `Origin` header without coupling to a specific runtime adapter.
  readonly request: { readonly headers: { get(name: string): string | null } };
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
    // CR-16: reject cross-origin WebSocket upgrades when CORS_ORIGIN is
    // configured. No-op in dev/local (var unset) and for headerless non-browser
    // clients; see server/origin-guard.ts for the v1 trade-off.
    const requestOrigin = peer.request.headers.get("origin");
    if (!isOriginAllowed(env.CORS_ORIGIN, requestOrigin)) {
      peer.close(1008, "origin not allowed");
      return;
    }
    // R3/F2: reject a new connection once the per-process cap is reached. The
    // broker is the only unauthenticated network surface, so without this an
    // attacker can open thousands of idle sockets to exhaust memory + fds. We
    // check `sockets.size` (the authoritative live-connection set) before
    // seating this peer. 1013 (Try Again Later) signals a transient overload
    // condition to a conforming client, matching the existing close-code style
    // (1008 policy/origin) used by the origin guard above.
    if (shouldRejectConnection(sockets.size, MAX_CONNECTIONS)) {
      peer.close(1013, "too many connections");
      return;
    }
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
