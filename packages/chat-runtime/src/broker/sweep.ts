import type { BrokerSocket } from "./room-registry";

/**
 * Zombie-connection eviction callback. Invoked once per evicted socket with the
 * id under which it was registered, so the broker server can run its standard
 * cleanup path (`cleanup(id)`) without an O(n) reverse-lookup over the sockets
 * map. The broker server wires this to the connection's `onClose()` so the
 * partner receives a `leave` notification via
 * {@link BrokerConnection.notifyPeerLeft} exactly as it would for a clean
 * socket close.
 */
export type SweepEvict = (socket: BrokerSocket, id: string) => void;

export interface SweepOptions {
  /** Sweep cadence in milliseconds. Defaults to 60_000 (one minute). */
  readonly intervalMs?: number;
}

/**
 * The WebSocket ready-state threshold at or above which a socket is considered
 * dead: 2 (CLOSING) or 3 (CLOSED). The sweep treats both as zombies because the
 * runtime's `close`/`error` hooks fire asynchronously (or not at all for some
 * half-open conditions), leaving a half-evicted socket in the registry.
 */
const READY_STATE_DEAD_THRESHOLD = 1;

export interface SweepHandle {
  /** Stop the periodic sweep. Safe to call multiple times. */
  stop(): void;
}

/**
 * Run one sweep pass. Exported for unit testing so the deterministic test does
 * not have to wait for the periodic interval. Iterates `[id, socket]` pairs so
 * the {@link SweepEvict} callback receives the registration id directly,
 * removing the previous O(n) reverse-lookup scan at the call site (LW-11).
 */
export function runSweep(
  sockets: Iterable<readonly [string, BrokerSocket]>,
  evict: SweepEvict,
): number {
  let evicted = 0;
  for (const [id, socket] of sockets) {
    if (socket.readyState > READY_STATE_DEAD_THRESHOLD) {
      evict(socket, id);
      evicted++;
    }
  }
  return evicted;
}

/**
 * Install a periodic sweep that evicts any socket stuck in CLOSING/CLOSED but
 * still in the registry. Bounds the worst-case half-open zombie to
 * `intervalMs` instead of the runtime's TCP keepalive default (~2h on Linux).
 *
 * The PRD requires logging to be "configured off" — the sweep therefore emits
 * no console output unconditionally; operators who want eviction telemetry
 * can wire it by instrumenting {@link SweepEvict} at the call site. The
 * interval timer is `.unref()`-ed when supported so it never keeps the Node
 * event loop alive on its own.
 */
export function startZombieSweep(
  sockets: () => Iterable<readonly [string, BrokerSocket]>,
  evict: SweepEvict,
  options: SweepOptions = {},
): SweepHandle {
  const intervalMs = options.intervalMs ?? 60_000;
  const timer = setInterval(() => {
    runSweep(sockets(), evict);
  }, intervalMs);
  // .unref() is a Node-only API; guard for runtimes where it's absent.
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
